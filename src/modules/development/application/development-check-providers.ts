import type {
  CheckProvider,
  CheckProviderResult,
} from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  parseRepositoryFilePath,
  parseRepositoryScope,
  repositoryScopeContainsPath,
} from '../../../shared/repository-scope.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  type DevelopmentCase,
} from '../domain/development-schemas.js';
import { isAbsolute } from 'node:path';
import { SOURCE_CHANGE_CANDIDATE_SCHEMA } from '../../../process-modules/domain/source-change-candidate.js';
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
import {
  evaluateSrsModuleManifestCoverage,
  parseSrsModuleManifest,
  type SrsModuleManifest,
} from '../domain/srs-module-manifest.js';
import {
  readDevelopmentCaseSrsContent,
  type DevelopmentSrsContentResult,
} from './development-srs-artifact-content.js';
import { partitionFactoryManagedPaths } from '../domain/factory-managed-repository-paths.js';
import {
  parallelismViolations,
  uncoveredSharedSurfacePaths,
  type ReplanScopeViolation,
} from '../domain/replan-graph-checks.js';

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID =
  'development.task-graph-contract.v1';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION = '1.2.0';

/**
 * RE-PLAN CYCLE (REPLAN-CYCLE-TZ §2) — the cycle-2 gate check. Runs ONLY in
 * the replan continuation module's planner cell, beside the standard
 * task-graph provider (which keeps owning coverage/lineage/DAG semantics):
 * enforces the parallelism anti-pattern rule and the shared-surface
 * extraction rule over the proposal, using the replanContext of the run's
 * OWN input case (the cycle-1 diagnosis travels in the run input).
 */
export const DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_ID =
  'development.replan-graph.v1';
export const DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_VERSION,
  invariant: 'replan-graph-exploits-integrated-cycle1-reality-parallelism-and-shared-surface',
});

export function createDevelopmentReplanGraphCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isInteger(processRunId) || processRunId <= 0) {
          return 'error';
        }
        const run = input.db.prepare(
          `SELECT input_schema,input_snapshot FROM factory_process_runs WHERE id=?`,
        ).get(processRunId) as { input_schema: string; input_snapshot: string } | undefined;
        if (!run || run.input_schema !== DEVELOPMENT_CASE_SCHEMA) return 'error';
        const replanContext = (JSON.parse(run.input_snapshot) as {
          replanContext?: {
            cycle1Diagnosis?: { scopeViolations?: unknown };
          };
        }).replanContext;
        const violations = replanContext?.cycle1Diagnosis?.scopeViolations;
        if (!Array.isArray(violations)) {
          return scopeFailure(subjectCandidateSetRef, 'replan-context-missing',
            'The re-plan gate requires the run input to carry replanContext.cycle1Diagnosis.scopeViolations.');
        }
        const scopeViolations = violations.flatMap((violation): ReplanScopeViolation[] => {
          if (!violation || typeof violation !== 'object') return [];
          const paths = (violation as { paths?: unknown }).paths;
          const scopes = (violation as { scopes?: unknown }).scopes;
          if (!Array.isArray(paths) || !Array.isArray(scopes)) return [];
          return [{
            paths: paths.filter((p): p is string => typeof p === 'string'),
            scopes: scopes.filter((s): s is string => typeof s === 'string'),
          }];
        });
        // Resolve the proposal by the EXACT CandidateSet member submission
        // (same binding discipline as the task-graph provider).
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author' || candidate.members.length === 0) {
          return 'error';
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return 'error';
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        const row = input.db.prepare(
          `SELECT payload_snapshot,content_hash
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=?`,
        ).get(submissionId, processRunId) as
          | { payload_snapshot: string; content_hash: string }
          | undefined;
        if (!row || row.content_hash !== member.productRef.digest) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The re-plan task graph proposal does not match the exact CandidateSet member submission.');
        }
        const decoded = decodeDevelopmentTaskGraphProposal(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) return 'error';
        const items = decoded.value.implementationItems;
        const diagnostics = [
          ...parallelismViolations(items),
          ...uncoveredSharedSurfacePaths(scopeViolations, items),
        ];
        if (diagnostics.length === 0) return 'passed';
        return {
          outcome: 'failed',
          evidenceRefs: diagnostics.map(diagnostic => encodeCheckDiagnostic({
            code: diagnostic.code,
            message: diagnostic.message,
            subjectRef: subjectCandidateSetRef,
          })),
        };
      } catch {
        return 'error';
      }
    },
  };
}

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

// --- P1 of the desync map: payload contracts for the two implementation
// products. Their shapes were previously enforced NOWHERE (the manifest
// covered only four artifact schemas), so the implementation-scope check and
// the managed materializer read untyped casts and drifted silently from the
// producer (the decorative TS interface even named a field the check never
// read). These contracts pin exactly the fields the CONSUMERS read, as
// observed on live conveyor submissions.
export const DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID =
  'development.implementation-result-payload.v1';
export const DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION = '1.1.0';
export const DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  decoder: 'validateDevelopmentImplementationResultPayload',
  schemaVersion: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  invariant: 'implementation-result-carries-exact-git-snapshot-declared-files-and-readiness-profile',
} as const;
export const DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    contractId: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
    definition: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DEFINITION,
  });
export const developmentImplementationPayloadContract: ProductPayloadContract = {
  schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  contractId: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
  version: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
  definition: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  validate: validateDevelopmentImplementationResultPayload,
};

export const SOURCE_CHANGE_PAYLOAD_CONTRACT_ID =
  'development.source-change-candidate-payload.v1';
export const SOURCE_CHANGE_PAYLOAD_CONTRACT_VERSION = '1.0.0';
export const SOURCE_CHANGE_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  decoder: 'validateSourceChangeCandidatePayload',
  schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
  invariant: 'managed-change-candidate-carries-base-commit-and-text-entries',
} as const;
export const SOURCE_CHANGE_PAYLOAD_CONTRACT_DIGEST = productPayloadContractDigest({
  schemaId: SOURCE_CHANGE_CANDIDATE_SCHEMA,
  contractId: SOURCE_CHANGE_PAYLOAD_CONTRACT_ID,
  version: SOURCE_CHANGE_PAYLOAD_CONTRACT_VERSION,
  definition: SOURCE_CHANGE_PAYLOAD_CONTRACT_DEFINITION,
});
export const sourceChangeCandidatePayloadContract: ProductPayloadContract = {
  schemaId: SOURCE_CHANGE_CANDIDATE_SCHEMA,
  contractId: SOURCE_CHANGE_PAYLOAD_CONTRACT_ID,
  version: SOURCE_CHANGE_PAYLOAD_CONTRACT_VERSION,
  definition: SOURCE_CHANGE_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: SOURCE_CHANGE_PAYLOAD_CONTRACT_DIGEST,
  validate: validateSourceChangeCandidatePayload,
};

const HEX40 = /^[a-f0-9]{40}$/u;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the implementation result against the CONSUMER contract (the
 * implementation-scope check + settlement read exactly these fields). Extra
 * producer fields are allowed — this pins the read surface, not the whole
 * payload, so producers may add fields without a contract version bump.
 */
function validateDevelopmentImplementationResultPayload(payload: unknown): string[] {
  if (!isRecordValue(payload)) return ['payload must be an object'];
  const errors: string[] = [];
  const snapshot = payload.snapshot;
  const repository = payload.repository;
  if (typeof payload.workItemKey !== 'string' || payload.workItemKey.trim() === '') {
    errors.push('workItemKey must be a non-empty string');
  }
  if (!isRecordValue(repository) || typeof repository.baseCommit !== 'string'
      || !HEX40.test(repository.baseCommit)) {
    errors.push('repository.baseCommit must be a 40-hex commit');
  }
  if (!isRecordValue(snapshot)) {
    errors.push('snapshot must be an object');
  } else {
    if (typeof snapshot.commitSha !== 'string' || !HEX40.test(snapshot.commitSha)) {
      errors.push('snapshot.commitSha must be a 40-hex commit');
    }
    const files = snapshot.changedFiles;
    if (!Array.isArray(files) || files.length === 0
        || !files.every(entry => typeof entry === 'string'
          || (isRecordValue(entry) && typeof entry.path === 'string' && entry.path !== ''))) {
      errors.push('snapshot.changedFiles must be a non-empty array of paths or {path} entries');
    }
  }
  // ADR-070: readiness on a scoped implementation result is item-local
  // evidence only. Candidate-wide authority is produced after integration by
  // the dedicated readiness-certification Cell.
  if (payload.readiness !== undefined) errors.push(...validateReadinessProfile(payload.readiness));
  return errors;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function declaresHardcodedServePort(command: string): boolean {
  return /(?:--port(?:=|\s+)|\bport\s*=\s*)[0-9]{2,5}\b/iu.test(command);
}

/**
 * LR-04 submission firewall. Every standard implementation presentation must
 * state the same explicit final-product run contract. This is deliberately
 * checked before INSERT so a worker can repair the payload in the same
 * execution; the verification fan-out must never discover that the frozen
 * candidate was structurally unverifiable.
 */
function validateReadinessProfile(value: unknown): string[] {
  if (!isRecordValue(value)) {
    return ['readiness must be an object with kind, commands, and (for served) serve'];
  }
  const errors: string[] = [];
  if (value.kind !== 'static' && value.kind !== 'served') {
    errors.push('readiness.kind must be "static" or "served"');
  }
  if (!isRecordValue(value.commands)) {
    errors.push('readiness.commands must be an object');
  } else {
    const install = value.commands.installCommand;
    if (install !== null && !nonEmptyString(install)) {
      errors.push('readiness.commands.installCommand must be null or a non-empty string');
    }
    if (!nonEmptyString(value.commands.testCommand)) {
      errors.push('readiness.commands.testCommand must be a non-empty string');
    }
  }
  if (value.kind === 'served') {
    if (!isRecordValue(value.serve) || !nonEmptyString(value.serve.startCommand)) {
      errors.push('readiness.serve.startCommand must be a non-empty string for served products');
    }
  }
  if (value.environment !== undefined) {
    if (!isRecordValue(value.environment) || !nonEmptyString(value.environment.image)) {
      errors.push('readiness.environment.image must be a non-empty string when environment is present');
    }
  }
  if (value.compose !== undefined) {
    if (!isRecordValue(value.compose) || !nonEmptyString(value.compose.file)) {
      errors.push('readiness.compose.file must be a non-empty relative path when compose is present');
    } else if (isAbsolute(value.compose.file)
      || value.compose.file.split(/[\\/]/u).includes('..')) {
      errors.push('readiness.compose.file must be a relative path inside the sealed tree (no absolute paths or .. segments)');
    }
    if (isRecordValue(value.compose)
      && value.compose.projectName !== undefined
      && !nonEmptyString(value.compose.projectName)) {
      errors.push('readiness.compose.projectName must be a non-empty string when present');
    }
  }
  return errors;
}

function sameStringSet(left: readonly unknown[], right: readonly string[]): boolean {
  const leftIds = left.filter((id): id is string => typeof id === 'string');
  return leftIds.length === left.length
    && leftIds.length === right.length
    && leftIds.every(id => right.includes(id));
}

export const DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID =
  'development.readiness-manifest-payload.v1';
export const DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION = '1.1.0';
export const DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  decoder: 'validateDevelopmentReadinessManifest',
  schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  invariant: 'one-primary-target-bound-to-exact-integrated-source-product-and-dynamic-port-contract',
} as const;
export const DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    contractId: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
    definition: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DEFINITION,
  });

export const developmentReadinessManifestPayloadContract: ProductPayloadContract = {
  schemaId: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  contractId: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
  version: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
  definition: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST,
  validate: validateDevelopmentReadinessManifest,
};

function validateDevelopmentReadinessManifest(payload: unknown): string[] {
  if (!isRecordValue(payload)) return ['payload must be an object'];
  const errors: string[] = [];
  if (payload.schemaVersion !== DEVELOPMENT_READINESS_MANIFEST_SCHEMA) {
    errors.push(`schemaVersion must be ${DEVELOPMENT_READINESS_MANIFEST_SCHEMA}`);
  }
  const source = payload.sourceCandidate;
  if (!isRecordValue(source)
      || source.schema !== 'factory.integrated-source-candidate.v1'
      || !nonEmptyString(source.ref)
      || typeof source.hash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(source.hash)) {
    errors.push('sourceCandidate must be the exact integrated-source ProductRef');
  }
  if (!Array.isArray(payload.targets) || payload.targets.length !== 1) {
    errors.push('targets must contain exactly one primary target');
  } else {
    const target = payload.targets[0];
    if (!isRecordValue(target) || target.key !== 'primary') {
      errors.push('targets[0].key must be "primary"');
    } else {
      errors.push(...validateReadinessProfile(target.readiness)
        .map(error => `targets[0].${error}`));
      const readiness = target.readiness;
      if (isRecordValue(readiness) && readiness.kind === 'served'
          && isRecordValue(readiness.serve)
          && nonEmptyString(readiness.serve.startCommand)
          && declaresHardcodedServePort(readiness.serve.startCommand)) {
        errors.push(
          'targets[0].readiness.serve.startCommand must not hardcode a numeric port; '
          + 'the service must bind the Factory-provided PORT environment variable',
        );
      }
    }
  }
  // AC-drift network 3 seam: optional warrantRef — when present it must be
  // the exact typed shape (digest-pinned register + dispositions). Absent is
  // legal until the warrant phases land (retro-compat).
  const warrant = payload.warrantRef;
  if (warrant !== undefined) {
    if (
      !isRecordValue(warrant)
      || !nonEmptyString(warrant.constraintRegisterRef)
      || !nonEmptyString(warrant.constraintRegisterDigest)
      || !/^[a-f0-9]{64}$/u.test(warrant.constraintRegisterDigest)
      || !nonEmptyString(warrant.dispositionsDigest)
      || !/^[a-f0-9]{64}$/u.test(warrant.dispositionsDigest)
      || warrant.constraintRegisterRef
        !== `constraint-register:${warrant.constraintRegisterDigest}`
      || !isRecordValue(warrant.dispositions)
    ) {
      errors.push(
        'warrantRef must carry constraintRegisterRef (constraint-register:<64-hex digest>), '
        + 'constraintRegisterDigest (64-hex), dispositionsDigest (64-hex) and a dispositions object',
      );
    }
  }
  return errors;
}

/**
 * Validate the managed SourceChangeCandidate against the MATERIALIZER
 * contract (validateEntries re-checks scope containment later; this pins the
 * submission shape so a malformed manifest fails at submission with a
 * decodable code instead of a downstream crash).
 */
function validateSourceChangeCandidatePayload(payload: unknown): string[] {
  if (!isRecordValue(payload)) return ['payload must be an object'];
  const errors: string[] = [];
  const repository = payload.repository;
  const snapshot = payload.snapshot;
  const textSet = payload.textSet;
  if (typeof payload.workItemKey !== 'string' || payload.workItemKey.trim() === '') {
    errors.push('workItemKey must be a non-empty string');
  }
  if (!isRecordValue(repository) || typeof repository.baseCommit !== 'string'
      || !HEX40.test(repository.baseCommit)) {
    errors.push('repository.baseCommit must be a 40-hex commit');
  }
  if (!isRecordValue(snapshot) || typeof snapshot.commitSha !== 'string'
      || !HEX40.test(snapshot.commitSha) || !Array.isArray(snapshot.files)) {
    errors.push('snapshot must carry commitSha (40-hex) and files[]');
  }
  if (!isRecordValue(textSet) || !Array.isArray(textSet.entries)) {
    errors.push('textSet.entries must be an array of change entries');
  }
  return errors;
}

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  payloadContractDigest: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST,
  invariant: 'development-task-graph-validates-before-cell-acceptance',
});

export const DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID =
  'development.implementation-scope.v1';
// v2.0.0 — workshop fixes: (a) factory-managed path carve-out
// (docs/**/executions/** and .saga-bootstrap.md) from BOTH sides of the
// equality; (b) ancestry + task-branch discipline checks; (c) repair recipe
// on changed-files-mismatch.
// v2.1.0 — mis-keyed product root fix: payload.workItemKey must equal the
// kernel-authoritative cell_input_item.key of the accepted author task. A
// re-hired worker stamping the workplace work_key (24-hex) passed the
// "non-empty string" payload contract, dropped out of the settlement
// workset matcher and killed the run downstream (units epic-8 cert#37,
// tips epic-5 cert#40). Fail closed with a repair recipe.
export const DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION = '2.1.0';
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
  /**
   * Optional override for reading the case's SRS artifact content. Defaults
   * to the exact-artifact reader (db + product repository checkout). Exists
   * so tests can pin manifest content without materializing artifacts.
   */
  readSrsContent?: (
    db: SqlDatabasePort,
    srs: { schema: string; ref: string; hash: string },
  ) => DevelopmentSrsContentResult;
}): CheckProvider {
  const policy = input.taskGraphPolicy ?? new ReferenceDevelopmentTaskGraphPolicy();
  const readSrsContent = input.readSrsContent ?? readDevelopmentCaseSrsContent;
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
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The task graph proposal does not match the exact CandidateSet member submission and its desk receipt.');
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
        // SRS §2.2 module-manifest coverage: nothing previously compared the
        // accepted plan back to the SRS's declared modules, so a planner
        // under rejection pressure could drop whole SRS modules (todo lost
        // renderer/events/index.html) while passing every id-coverage gate.
        // Fail-open ONLY for an absent/unreadable manifest (legacy SRS);
        // enforced when the manifest declares files.
        const manifestAssessment = assessSrsModuleManifestCoverage(
          subjectCandidateSetRef,
          () => readSrsContent(input.db, developmentCase.srs),
          graph.implementationItems.map(item => ({ changeScopes: item.changeScopes })),
        );
        if (validation.valid && manifestAssessment.failure === null) {
          return manifestAssessment.note === null
            ? 'passed'
            : {
              outcome: 'passed',
              evidenceRefs: [manifestAssessment.note],
            };
        }
        const evidenceRefs = validation.errors.map((message, index) => encodeCheckDiagnostic({
          code: validation.reasonCodes[index] ?? validation.reasonCodes[0] ?? 'task-graph-invalid',
          message,
          subjectRef: subjectCandidateSetRef,
        }));
        if (manifestAssessment.failure !== null) evidenceRefs.push(manifestAssessment.failure);
        return { outcome: 'failed', evidenceRefs };
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
          workItemKey?: unknown;
          repository?: { baseCommit?: unknown };
          snapshot?: { commitSha?: unknown; changedFiles?: unknown };
          source?: { branch?: unknown };
        };
        const metadata = JSON.parse(row.metadata) as {
          cell_input_item?: { key?: unknown; changeScopes?: unknown };
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
        // v2.1.0 mis-keyed product root fix (units epic-8 cert#37, tips epic-5
        // cert#40): workItemKey is LM-authored and previously only had to be a
        // non-empty string, so a re-hired worker stamping the 24-hex workplace
        // work_key passed here and died at settlement workset matching. The
        // kernel-authoritative key is the cell_input_item the Factory projected
        // into this author task's metadata — fail closed on any divergence.
        const itemKey = metadata.cell_input_item?.key;
        if (payload.workItemKey !== itemKey) {
          return scopeFailure(subjectCandidateSetRef, 'work-item-key-mismatch',
            `Submitted workItemKey '${String(payload.workItemKey)}' does not equal the kernel-authoritative `
            + `item key '${String(itemKey)}'. workItemKey must equal cell_input_item.key — the task-graph `
            + 'item key of this work item, NOT the workplace work_key: resubmit the implementation '
            + 'result with the exact cell_input_item.key value.');
        }
        // Ancestry discipline: the submitted commit MUST descend from the
        // frozen effective base. Without this, a worker that reset its branch
        // onto unrelated history passed silently and rejected commits could
        // leak onto the integration branch and be frozen as the next base.
        // merge-base(base, commit) === base ⟺ base is an ancestor of commit;
        // an unreadable result (null) is an indeterminate ancestry check and
        // fails closed with the same typed error, never skips.
        const mergeBase = input.git.read(row.local_path, [
          'merge-base', row.effective_base_commit, commit,
        ]);
        if (mergeBase !== row.effective_base_commit) {
          return scopeFailure(subjectCandidateSetRef, 'commit-not-descended-from-base',
            mergeBase === null
              ? `Ancestry of commit ${commit} relative to the frozen effective base `
              + `${row.effective_base_commit} could not be determined (git merge-base failed); failing closed.`
              : `Commit ${commit} does not descend from the frozen effective base `
              + `${row.effective_base_commit} (merge-base ${mergeBase}). Rebuild the work on the `
              + `provisioned base (git rebase ${row.effective_base_commit} or reset onto it and re-apply) and resubmit.`);
        }
        // Branch discipline: when the worker declared its provisioned task
        // branch, the commit must also be reachable from that branch head
        // (merge-base(commit, branch) === commit). Absent declaration stays
        // unchecked (older payloads) — ancestry above is the hard floor.
        const declaredBranch = payload.source?.branch;
        if (typeof declaredBranch === 'string' && declaredBranch.trim() !== '') {
          const branchMergeBase = input.git.read(row.local_path, [
            'merge-base', commit, declaredBranch,
          ]);
          if (branchMergeBase !== commit) {
            return scopeFailure(subjectCandidateSetRef, 'commit-not-on-task-branch',
              `Commit ${commit} is not reachable from the declared task branch `
              + `'${declaredBranch}' (merge-base ${branchMergeBase ?? 'undetermined'}). `
              + 'Commit the work on the provisioned task branch and resubmit.');
          }
        }
        const diff = input.git.read(row.local_path, [
          'diff', '--name-only', '--diff-filter=ACDMRTUXB',
          `${row.effective_base_commit}..${commit}`,
        ]);
        if (diff === null) return 'error';
        // Factory-managed carve-out: the Factory itself writes desk/execution
        // docs (docs/<...>/executions/**) and .saga-bootstrap.md into the
        // product repo. Both sides of the equality are filtered through the
        // SAME predicate so committing or declaring them no longer breaks
        // the exact-set check (killed projects 9 and 6).
        const actualPartition = partitionFactoryManagedPaths(
          diff.split(/\r?\n/).filter(Boolean).map(normalizeRepoPath));
        const claimedPartition = partitionFactoryManagedPaths(
          submitted.map(readSubmittedChangedPath).map(normalizeRepoPath));
        const actual = actualPartition.productPaths.sort();
        const claimed = claimedPartition.productPaths.sort();
        const filteredNote = [...new Set([
          ...actualPartition.factoryManagedPaths,
          ...claimedPartition.factoryManagedPaths,
        ])].sort();
        const filteredSuffix = filteredNote.length === 0
          ? ''
          : ` Factory-managed paths excluded from this comparison: [${filteredNote.join(', ')}].`;
        if (new Set(actual).size !== actual.length
            || new Set(claimed).size !== claimed.length
            || JSON.stringify(actual) !== JSON.stringify(claimed)) {
          return scopeFailure(subjectCandidateSetRef, 'changed-files-mismatch',
            `Submitted changedFiles [${claimed.join(', ')}] do not match the authoritative Git diff [${actual.join(', ')}].`
            + ` Repair: recompute with \`git diff --name-only ${row.effective_base_commit}..${commit}\``
            + ' and declare exactly that set (factory-managed docs/**/executions/**'
            + ' and .saga-bootstrap.md are excluded automatically).'
            + filteredSuffix);
        }
        const normalizedScopes = scopes.map(parseRepositoryScope);
        const offending = actual.filter(path =>
          !normalizedScopes.some(scope => repositoryScopeContainsPath(scope, path)));
        if (offending.length > 0) {
          return scopeFailure(subjectCandidateSetRef, 'path-outside-authority',
            `Git paths [${offending.join(', ')}] are outside frozen changeScopes [${scopes.join(', ')}].`);
        }
        // Non-fatal operator note when factory-managed paths were filtered:
        // the pass stays a pass, but the exclusion stays visible.
        return filteredSuffix === ''
          ? 'passed'
          : {
            outcome: 'passed',
            evidenceRefs: [encodeCheckDiagnostic({
              code: 'factory-managed-paths-excluded',
              message: `Implementation scope passed after excluding factory-managed paths:${filteredSuffix}`,
              subjectRef: subjectCandidateSetRef,
            })],
          };
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

/**
 * Assess the SRS §2.2 module-manifest coverage for one task-graph gate run.
 * Returns a typed failure diagnostic (fail closed), an informational note
 * (fail open, legacy SRS), or neither (enforced and covered).
 */
function assessSrsModuleManifestCoverage(
  subjectRef: string,
  readContent: () => DevelopmentSrsContentResult,
  implementationItems: readonly { changeScopes: readonly string[] }[],
): { failure: string | null; note: string | null } {
  const srs = readContent();
  if (srs.status === 'drifted') {
    return {
      failure: encodeCheckDiagnostic({
        code: 'srs-artifact-drifted',
        message: `The SRS artifact file ${srs.path} no longer matches its registered content hash `
          + `${srs.expectedHash}; the module manifest cannot be trusted for coverage decisions.`,
        subjectRef,
      }),
      note: null,
    };
  }
  if (srs.status === 'unavailable') {
    return {
      failure: null,
      note: encodeCheckDiagnostic({
        code: 'srs-module-manifest-skip',
        message: `SRS module-manifest coverage check skipped: ${srs.reason}.`,
        subjectRef,
      }),
    };
  }
  const manifest: SrsModuleManifest = parseSrsModuleManifest(srs.content);
  if (manifest.status !== 'present') {
    return {
      failure: null,
      note: encodeCheckDiagnostic({
        code: 'srs-module-manifest-skip',
        message: manifest.status === 'absent'
          ? 'SRS module-manifest coverage check skipped: the SRS has no §2.2 Module Manifest section (legacy SRS tolerance).'
          : 'SRS module-manifest coverage check skipped: the §2.2 Module Manifest declares no machine-readable files (legacy SRS tolerance).',
        subjectRef,
      }),
    };
  }
  const coverage = evaluateSrsModuleManifestCoverage(manifest, implementationItems);
  if (coverage.outcome === 'covered') {
    return { failure: null, note: null };
  }
  const declaredScopes = [...new Set(
    implementationItems.flatMap(item => item.changeScopes),
  )].sort();
  return {
    failure: encodeCheckDiagnostic({
      code: 'srs-module-uncovered',
      message: coverage.gaps.map(gap =>
        `SRS §2.2 module '${gap.module}' declares file(s) [${gap.files.join(', ')}]`
        + ' that no implementation item\'s changeScopes cover').join('; ')
        + `; declared changeScopes [${declaredScopes.join(', ')}]`
        + '. Every SRS §2.2 module file must lie inside at least one implementation item\'s changeScopes.',
      subjectRef,
    }),
    note: null,
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
  try {
    return parseRepositoryFilePath(value);
  } catch {
    throw new Error('DEVELOPMENT_CHANGE_SCOPE_PATH_INVALID');
  }
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
            || candidate.members.length !== 1) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The verification evidence must be bound to exactly one author CandidateSet member of this workplace.');
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId
            !== DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            `The verification submission must be a ${DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA} managed-node-submission,`
            + ` got ${member.productRef.schemaId}:${member.productRef.ref}.`);
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            `The verification submission ref '${member.productRef.ref}' does not carry a numeric managed-node-submission id.`);
        }
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
        if (!row || row.content_hash !== member.productRef.digest) {
          return scopeFailure(subjectCandidateSetRef, 'submission-binding-invalid',
            'The verification submission does not match the exact CandidateSet member digest and its desk receipt.');
        }
        const decoded = decodeDevelopmentVerificationProduct(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) {
          return scopeFailure(subjectCandidateSetRef, 'verification-product-invalid',
            `The verification evidence payload is invalid: ${decoded.errors.join('; ')}`);
        }
        const metadata = JSON.parse(row.metadata) as {
          cell_input_item?: {
            key?: unknown;
            acceptanceCriterionIds?: unknown;
            coveredConstraintIds?: unknown;
          };
          process_node_input?: {
            upstream?: { bindings?: { candidate?: { candidateHash?: unknown } } };
          };
          trusted_provider_bindings?: unknown;
        };
        const item = metadata.cell_input_item;
        const criterionIds = item?.acceptanceCriterionIds;
        const frozenHash = metadata.process_node_input?.upstream?.bindings
          ?.candidate?.candidateHash;
        // AC-drift relay: when the verification card pins
        // coveredConstraintIds, the evidence must echo the exact same set —
        // lineage pins the constraint IDs together with criterionId. Cards
        // without coverage (legacy / no register) keep the previous check.
        const cardConstraintIds = item?.coveredConstraintIds;
        const constraintLineageOk = !Array.isArray(cardConstraintIds)
          || (Array.isArray(decoded.value.coveredConstraintIds)
            && sameStringSet(cardConstraintIds, decoded.value.coveredConstraintIds));
        if (
          decoded.value.verificationItemKey !== item?.key
          || !Array.isArray(criterionIds)
          || criterionIds.length !== 1
          || decoded.value.acceptanceCriterionId !== criterionIds[0]
          || decoded.value.acceptanceCriterionId
            !== row.verification_target_artifact_id
          || decoded.value.acceptedCriterionHash !== row.accepted_hash
          || decoded.value.candidateHash !== frozenHash
          || !constraintLineageOk
        ) {
          return scopeFailure(subjectCandidateSetRef, 'verification-lineage-mismatch',
            'The verification evidence does not match its frozen lineage: verificationItemKey must equal the work item key,'
            + ' acceptanceCriterionId must equal the single cell-input criterion id and the AC artifact id,'
            + ' acceptedCriterionHash must equal the accepted artifact hash, candidateHash must equal the frozen upstream candidate hash,'
            + ' and coveredConstraintIds must equal the card-pinned constraint set when the card pins one.');
        }
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
