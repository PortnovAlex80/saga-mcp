import type {
  CheckProvider,
  CheckProviderResult,
} from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
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
import type { GitPort } from '../domain/development-kernel-ports.js';
import { encodeCheckDiagnostic } from '../../../process-modules/domain/workplace/check-diagnostic.js';

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID =
  'development.task-graph-contract.v1';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION = '1.1.0';

export const DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_ID =
  'development.task-graph-proposal-payload.v1';
export const DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_VERSION = '1.0.0';
export const DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  decoder: 'decodeDevelopmentTaskGraphProposal',
  schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  invariant: 'intrinsic-task-graph-shape-is-rejected-before-durable-submission',
} as const;
export const DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    contractId: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_VERSION,
    definition: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DEFINITION,
  });

export const developmentTaskGraphPayloadContract: ProductPayloadContract = {
  schemaId: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  contractId: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_ID,
  version: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_VERSION,
  definition: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST,
  validate(payload) {
    const decoded = decodeDevelopmentTaskGraphProposal(payload);
    return decoded.ok ? [] : decoded.errors;
  },
};

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  payloadContractDigest: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST,
  invariant: 'development-task-graph-validates-before-cell-acceptance',
});

export const DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID =
  'development.implementation-scope.v1';
export const DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
  invariant: 'actual-git-diff-equals-submitted-files-and-stays-within-frozen-change-scopes',
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
    providerDigest: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isInteger(processRunId) || processRunId <= 0) {
          return 'error';
        }
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author' || candidate.members.length === 0) {
          return 'error';
        }
        // ADR-053 cutover: resolve the submission by EXACT CandidateSet member
        // productRef, NOT by execution_id. The member's productRef.ref encodes
        // the submission id; the digest IS the content authority.
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return 'error';
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) return 'error';
        const row = input.db.prepare(
          `SELECT id,schema_version,payload_snapshot,content_hash
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=?`,
        ).get(submissionId, processRunId) as SubmissionRow | undefined;
        if (!row || row.schema_version !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
            || row.content_hash !== member.productRef.digest) {
          return 'failed';
        }
        const decoded = decodeDevelopmentTaskGraphProposal(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) {
          return {
            outcome: 'failed',
            evidenceRefs: decoded.errors.map(message => encodeCheckDiagnostic({
              code: 'task-graph-decode-invalid',
              message,
              subjectRef: subjectCandidateSetRef,
            })),
          };
        }
        const processRun = input.db.prepare(
          `SELECT input_schema,input_snapshot FROM factory_process_runs WHERE id=?`,
        ).get(processRunId) as { input_schema: string; input_snapshot: string } | undefined;
        if (!processRun || processRun.input_schema !== DEVELOPMENT_CASE_SCHEMA) {
          return 'error';
        }
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
        const validation = policy.validate(developmentCase, graph);
        if (validation.valid) {
          return 'passed';
        }
        return {
          outcome: 'failed',
          evidenceRefs: validation.errors.map((message, index) => encodeCheckDiagnostic({
            code: validation.reasonCodes[index] ?? validation.reasonCodes[0] ?? 'task-graph-invalid',
            message,
            subjectRef: subjectCandidateSetRef,
          })),
        };
      } catch (err) {
        return 'error';
      }
    },
  };
}

export function createDevelopmentImplementationScopeCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
  git: GitPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1) return 'error';
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author'
            || candidate.workplaceRef.processRunId !== processRunId
            || candidate.members.length !== 1) {
          return scopeFailure(subjectCandidateSetRef, 'candidate-binding-invalid',
            'The implementation CandidateSet is not the exact single author product for this ProcessRun.');
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return scopeFailure(subjectCandidateSetRef, 'product-binding-invalid',
            'The implementation CandidateSet member is not an exact managed implementation result.');
        }
        const submissionId = Number(member.productRef.ref.slice('managed-node-submission:'.length));
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The implementation submission reference is malformed.');
        }
        // ADR-053 cutover: s.id + s.process_run_id already pin one row; the
        // content_hash===digest check (line below) is the authority binding.
        // execution_id is redundant forbidden authority — removed.
        const row = input.db.prepare(
          `SELECT s.payload_snapshot,s.content_hash,t.metadata,pr.local_path,
                  r.effective_base_commit
             FROM factory_managed_node_submissions s
             JOIN tasks t ON t.id=s.task_id
             JOIN project_repositories pr ON pr.id=t.project_repository_id
             JOIN factory_effective_desk_base_receipts r
               ON r.execution_ref=s.execution_id AND r.task_id=s.task_id
            WHERE s.id=? AND s.process_run_id=?`,
        ).get(submissionId, processRunId) as {
          payload_snapshot: string;
          content_hash: string;
          metadata: string;
          local_path: string;
          effective_base_commit: string;
        } | undefined;
        if (!row || row.content_hash !== member.productRef.digest) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The implementation submission does not match the exact CandidateSet member and desk receipt.');
        }
        const payload = JSON.parse(row.payload_snapshot) as {
          repository?: { baseCommit?: unknown };
          snapshot?: { commitSha?: unknown; changedFiles?: unknown };
        };
        const metadata = JSON.parse(row.metadata) as {
          cell_input_item?: { changeScopes?: unknown };
        };
        const scopes = metadata.cell_input_item?.changeScopes;
        const submitted = payload.snapshot?.changedFiles;
        const base = payload.repository?.baseCommit;
        const commit = payload.snapshot?.commitSha;
        if (!Array.isArray(scopes) || scopes.length === 0
            || !scopes.every(value => typeof value === 'string')
            || !Array.isArray(submitted)
            || typeof base !== 'string' || base !== row.effective_base_commit
            || typeof commit !== 'string' || !commit) {
          return scopeFailure(subjectCandidateSetRef, 'scope-input-invalid',
            'Implementation scope evidence is incomplete or its submitted base differs from the frozen effective desk base.');
        }
        const diff = input.git.read(row.local_path, [
          'diff', '--name-only', '--diff-filter=ACDMRTUXB',
          `${row.effective_base_commit}..${commit}`,
        ]);
        if (diff === null) return 'error';
        const actual = diff.split(/\r?\n/).filter(Boolean).map(normalizeRepoPath).sort();
        const claimed = submitted.map(readSubmittedChangedPath).map(normalizeRepoPath).sort();
        if (new Set(actual).size !== actual.length
            || new Set(claimed).size !== claimed.length
            || JSON.stringify(actual) !== JSON.stringify(claimed)) {
          return scopeFailure(subjectCandidateSetRef, 'changed-files-mismatch',
            `Submitted changedFiles [${claimed.join(', ')}] do not match the authoritative Git diff [${actual.join(', ')}].`);
        }
        const normalizedScopes = scopes.map(normalizeRepoPath);
        const offending = actual.filter(path =>
          !normalizedScopes.some(scope => pathMatchesScope(path, scope)));
        return offending.length === 0
          ? 'passed'
          : scopeFailure(subjectCandidateSetRef, 'path-outside-authority',
              `Git paths [${offending.join(', ')}] are outside frozen changeScopes [${normalizedScopes.join(', ')}].`);
      } catch {
        return 'error';
      }
    },
  };
}

function scopeFailure(
  subjectRef: string,
  code: string,
  message: string,
): CheckProviderResult {
  return {
    outcome: 'failed',
    evidenceRefs: [encodeCheckDiagnostic({ code, message, subjectRef })],
  };
}

function readSubmittedChangedPath(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const path = (value as { path?: unknown }).path;
    if (typeof path === 'string') return path;
  }
  throw new Error('DEVELOPMENT_CHANGED_FILE_PATH_INVALID');
}

function normalizeRepoPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized
      || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized)
      || segments.includes('..')
      || segments.includes('.git')) {
    throw new Error('DEVELOPMENT_CHANGE_SCOPE_PATH_INVALID');
  }
  return normalized;
}

function pathMatchesScope(path: string, scope: string): boolean {
  const normalizedScope = scope.replace(/\/+$/, '');
  return path === normalizedScope || path.startsWith(`${normalizedScope}/`);
}

export function createDevelopmentVerificationCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
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
        // ADR-053 cutover: s.id + s.process_run_id pin one row; digest check
        // below is the authority binding. execution_id removed.
        const row = input.db.prepare(
          `SELECT s.payload_snapshot,s.content_hash,t.verification_target_artifact_id,
                  t.metadata,a.accepted_hash
             FROM factory_managed_node_submissions s
             JOIN tasks t ON t.id=s.task_id
             LEFT JOIN artifacts a ON a.id=t.verification_target_artifact_id
            WHERE s.id=? AND s.process_run_id=?`,
        ).get(submissionId, processRunId) as {
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
        // This provider proves only assessment shape and exact lineage. It does
        // not trust the LM-authored outcome. The independent local-runnability
        // provider in the same plan owns executable Product Build evidence.
        return 'passed';
      } catch {
        return 'error';
      }
    },
  };
}
