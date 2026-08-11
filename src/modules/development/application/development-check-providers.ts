import type { CheckProvider } from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  type DevelopmentCase,
} from '../domain/development-schemas.js';
import { decodeDevelopmentVerificationProduct } from '../domain/development-verification-product.js';
import {
  productPayloadContractDigest,
  type ProductPayloadContract,
} from '../../../process-modules/application/product-payload-contract.js';
import {
  buildCanonicalDevelopmentTaskGraph,
  decodeDevelopmentTaskGraphProposal,
} from '../domain/development-task-graph.js';
import {
  ReferenceDevelopmentTaskGraphPolicy,
  type DevelopmentTaskGraphPolicyPort,
} from '../domain/development-settlement-policy.js';

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID =
  'development.task-graph-contract.v1';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  invariant: 'development-task-graph-validates-before-cell-acceptance',
});

export const DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID =
  'development.verification-product-contract.v2';
export const DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION = '2.0.0';
export const DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  invariant: 'verification-product-shape-and-frozen-lineage-before-acceptance',
});

export const DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID =
  'development.verification-evidence-payload.v2';
export const DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION = '2.0.0';
export const DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'verificationItemKey', 'acceptanceCriterionId',
    'acceptedCriterionHash', 'candidateHash', 'outcome', 'evidence',
  ],
  outcome: ['passed', 'failed', 'unknown', 'error'],
  evidenceRequired: ['summary', 'observations', 'limitations'],
  hashFormat: 'lowercase-sha256',
} as const;
export const DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
    contractId: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
    definition: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DEFINITION,
  });

export const developmentVerificationPayloadContract: ProductPayloadContract = {
  schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  contractId: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
  version: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
  definition: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
  validate(payload) {
    const decoded = decodeDevelopmentVerificationProduct(payload);
    return decoded.ok ? [] : decoded.errors;
  },
};

export const DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID =
  'development.review-verdict-payload.v1';
export const DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION = '1.1.0';
export const DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  required: ['subject_candidate_set_ref', 'verdict', 'findings'],
  verdict: ['approved', 'changes_requested'],
  subjectCandidateSetRef: 'candidate-set-ref',
  findings: 'array-of-strings',
} as const;
export const DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
    contractId: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
    definition: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  });

export const developmentReviewVerdictPayloadContract: ProductPayloadContract = {
  schemaId: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
  contractId: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  version: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
  definition: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
  validate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return ['payload must be an object'];
    }
    const value = payload as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof value.subject_candidate_set_ref !== 'string'
        || !value.subject_candidate_set_ref.startsWith('candidate-set/')) {
      errors.push('subject_candidate_set_ref must be an exact candidate-set/ reference');
    }
    if (value.verdict !== 'approved' && value.verdict !== 'changes_requested') {
      errors.push('verdict must be approved or changes_requested');
    }
    if (!Array.isArray(value.findings)
        || !value.findings.every(item => typeof item === 'string')) {
      errors.push('findings must be an array of strings');
    }
    return errors;
  },
};

interface SubmissionRow {
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  id: number;
}

export function createDevelopmentTaskGraphCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
  taskGraphPolicy?: DevelopmentTaskGraphPolicyPort;
}): CheckProvider {
  const policy = input.taskGraphPolicy ?? new ReferenceDevelopmentTaskGraphPolicy();
  return {
    providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isInteger(processRunId) || processRunId <= 0) return 'error';
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author') return 'error';
        const row = input.db.prepare(
          `SELECT id,schema_version,payload_snapshot,content_hash
             FROM factory_managed_node_submissions
            WHERE process_run_id=? AND execution_id=?
            ORDER BY id DESC LIMIT 1`,
        ).get(processRunId, candidate.producerExecutionRef) as SubmissionRow | undefined;
        if (!row || row.schema_version !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA) {
          return 'failed';
        }
        const decoded = decodeDevelopmentTaskGraphProposal(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) return 'failed';
        const processRun = input.db.prepare(
          `SELECT input_schema,input_snapshot FROM factory_process_runs WHERE id=?`,
        ).get(processRunId) as { input_schema: string; input_snapshot: string } | undefined;
        if (!processRun || processRun.input_schema !== DEVELOPMENT_CASE_SCHEMA) return 'error';
        const developmentCase = JSON.parse(processRun.input_snapshot) as DevelopmentCase;
        const graph = buildCanonicalDevelopmentTaskGraph(
          developmentCase,
          decoded.value,
          {
            schema: row.schema_version,
            ref: `managed-node-submission:${row.id}`,
            hash: row.content_hash,
          },
        );
        return policy.validate(developmentCase, graph).valid ? 'passed' : 'failed';
      } catch {
        return 'error';
      }
    },
  };
}

export function createDevelopmentVerificationCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1) return 'error';
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author'
            || candidate.workplaceRef.processRunId !== processRunId
            || candidate.members.length !== 1) return 'failed';
        const member = candidate.members[0]!;
        if (member.productRef.schemaId
            !== DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return 'failed';
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) return 'failed';
        const row = input.db.prepare(
          `SELECT s.payload_snapshot,s.content_hash,t.verification_target_artifact_id,
                  t.metadata,a.accepted_hash
             FROM factory_managed_node_submissions s
             JOIN tasks t ON t.id=s.task_id
             LEFT JOIN artifacts a ON a.id=t.verification_target_artifact_id
            WHERE s.id=? AND s.process_run_id=? AND s.execution_id=?`,
        ).get(submissionId, processRunId, candidate.producerExecutionRef) as {
          payload_snapshot: string;
          content_hash: string;
          verification_target_artifact_id: number | null;
          metadata: string;
          accepted_hash: string | null;
        } | undefined;
        if (!row || row.content_hash !== member.productRef.digest) return 'failed';
        const decoded = decodeDevelopmentVerificationProduct(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) return 'failed';
        const metadata = JSON.parse(row.metadata) as {
          cell_input_item?: { key?: unknown; acceptanceCriterionIds?: unknown };
          process_node_input?: {
            upstream?: { bindings?: { candidate?: { candidateHash?: unknown } } };
          };
          trusted_provider_bindings?: unknown;
        };
        const item = metadata.cell_input_item;
        const criterionIds = item?.acceptanceCriterionIds;
        const frozenHash = metadata.process_node_input?.upstream?.bindings
          ?.candidate?.candidateHash;
        if (
          decoded.value.verificationItemKey !== item?.key
          || !Array.isArray(criterionIds)
          || criterionIds.length !== 1
          || decoded.value.acceptanceCriterionId !== criterionIds[0]
          || decoded.value.acceptanceCriterionId
            !== row.verification_target_artifact_id
          || decoded.value.acceptedCriterionHash !== row.accepted_hash
          || decoded.value.candidateHash !== frozenHash
        ) return 'failed';
        // This provider validates the LM assessment contract and lineage. It
        // is deliberately not an executable criterion oracle: an LM-authored
        // `passed` cannot become Factory acceptance. Until an independent
        // candidate-check receipt is present, every well-formed assessment is
        // indeterminate and the plan stops the line without blaming the LM.
        return 'unknown';
      } catch {
        return 'error';
      }
    },
  };
}
