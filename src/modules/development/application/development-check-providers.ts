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
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
  resolveDevelopmentConstraintRegisterCoverage,
  type DevelopmentCase,
} from '../domain/development-schemas.js';
import {
  isTestFilePath,
  normalizeTestPath,
  resolveDeclaredTestSurface,
} from '../domain/readiness-test-surface.js';
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
// v1.2.0 — STAGE-18 R2: snapshot.droppedFiles joined the CONSUMER read
// surface (the claim-surface monotonicity provider reads it as the lawful
// disposition channel). The contract pins its shape: an array of
// {path, reason} entries; a missing/empty reason is not a disposition.
// v1.3.0 — STAGE-18 R3: snapshot.treeSha and source joined the CONSUMER read
// surface (the git integration effect reads them). Pinned when present:
// treeSha is a 40-hex TREE sha and never the commit sha (the stage-15
// stamping defect passed shape-only validation and produced an
// unattributable repair loop at integration); source.commitSha matches
// snapshot.commitSha.
export const DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION = '1.3.0';
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
    // STAGE-18 R2: the disposition channel of the claim-surface monotonicity
    // ratchet. Present-but-malformed is a contract violation (fail closed);
    // absent is legal (nothing was dropped).
    if (snapshot.droppedFiles !== undefined) {
      const drops = snapshot.droppedFiles;
      if (!Array.isArray(drops)
          || !drops.every(entry => isRecordValue(entry)
            && typeof entry.path === 'string' && entry.path !== ''
            && typeof entry.reason === 'string' && entry.reason.trim() !== '')) {
        errors.push(
          'snapshot.droppedFiles must be an array of {path, reason} entries with non-empty strings'
          + ' — an entry without a reason is not a disposition',
        );
      }
    }
    // STAGE-18 R3: the git integration effect reads snapshot.treeSha (the
    // tree the reviewed commit must hold) and source.{commitSha,branch}. Pin
    // them when present — a commit sha stamped as treeSha passed shape-only
    // validation in stage 15 and the defect surfaced only at integration as
    // an unattributable mismatch. Absent fields stay legal (pre-R3
    // producers); present ones must be truthful.
    if (snapshot.treeSha !== undefined) {
      if (typeof snapshot.treeSha !== 'string' || !HEX40.test(snapshot.treeSha)) {
        errors.push('snapshot.treeSha must be a 40-hex tree sha (from `git rev-parse <commit>^{tree}`)');
      } else if (typeof snapshot.commitSha === 'string' && snapshot.treeSha === snapshot.commitSha) {
        errors.push('snapshot.treeSha must be the commit\'s TREE sha, not the commit sha '
          + '— a commit sha stamped as treeSha fails integration (STAGE-18 R3)');
      }
    }
    if (payload.source !== undefined) {
      const source = payload.source;
      if (!isRecordValue(source)
          || typeof source.commitSha !== 'string' || !HEX40.test(source.commitSha)
          || typeof source.branch !== 'string' || source.branch.trim() === '') {
        errors.push('source must carry a 40-hex commitSha and a non-empty branch');
      } else if (typeof snapshot.commitSha === 'string' && snapshot.commitSha !== source.commitSha) {
        errors.push('snapshot.commitSha must equal source.commitSha — the snapshot describes the reviewed source commit');
      }
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
  // the exact typed shape (digest-pinned register + dispositions) AND carry
  // the COMPLETE certificate/case cross-bind (ADR-090 focused repair, m7
  // consumer boundary): both discoveryCertificateHash and
  // formalizationCaseDigest as 64-hex strings. A partial cross-bind (one
  // identity stripped) is a typed submission error — never silently accepted.
  // Absent warrantRef remains legal until the warrant phases land
  // (retro-compat).
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
      || typeof warrant.discoveryCertificateHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(warrant.discoveryCertificateHash)
      || typeof warrant.formalizationCaseDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(warrant.formalizationCaseDigest)
    ) {
      errors.push(
        'warrantRef must carry constraintRegisterRef (constraint-register:<64-hex digest>), '
        + 'constraintRegisterDigest (64-hex), dispositionsDigest (64-hex), a dispositions object, '
        + 'and BOTH cross-bind identities discoveryCertificateHash + formalizationCaseDigest (64-hex)',
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
    'schemaVersion', 'verificationItemKey', 'acceptanceCriterionKey',
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
        // ADR-088 (CC-GAP-6): the manifest assessor consults the register
        // before any skip. Sole grandfather condition = registerless corpus
        // (null resolution): skips stay typed notes, gates stay green. Under
        // a non-empty register, an unavailable SRS, an absent §2.2 section
        // or a file-less manifest is a typed RED, never a skip.
        const constraintRegisterCoverage
          = resolveDevelopmentConstraintRegisterCoverage(developmentCase);
        // SRS §2.2 module-manifest coverage: nothing previously compared the
        // accepted plan back to the SRS's declared modules, so a planner
        // under rejection pressure could drop whole SRS modules (todo lost
        // renderer/events/index.html) while passing every id-coverage gate.
        // Registerless legacy SRS keeps the typed skip; a register-bearing
        // corpus must produce the manifest (or a typed waiver).
        const manifestAssessment = assessSrsModuleManifestCoverage(
          subjectCandidateSetRef,
          () => readSrsContent(input.db, developmentCase.srs),
          graph.implementationItems.map(item => ({ changeScopes: item.changeScopes })),
          constraintRegisterCoverage !== null,
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
  /**
   * STAGE-13 — the current write authority of a task (original carve union
   * its granted widening revisions), or the original scopes when no grant
   * exists. Injected by the composition root; absent degrades to the
   * original carve (no widening has ever happened).
   */
  readEffectiveChangeScopes?: (taskId: number, originalScopes: readonly string[]) => readonly string[];
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
          `SELECT s.payload_snapshot,s.content_hash,t.metadata,t.id AS task_id,pr.local_path,
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
          task_id: number;
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
        // STAGE-13 — the fence reads the CURRENT write authority: the task's
        // latest granted scope revision (append-only widening ledger), or the
        // original carve when no grant exists. The fence's question is
        // containment against the frozen authority — widened lawfully or not
        // at all — never "does the work need this path".
        const effectiveScopes = input.readEffectiveChangeScopes
          ? input.readEffectiveChangeScopes(row.task_id, scopes)
          : scopes;
        const normalizedScopes = effectiveScopes.map(parseRepositoryScope);
        const offending = actual.filter(path =>
          !normalizedScopes.some(scope => repositoryScopeContainsPath(scope, path)));
        if (offending.length > 0) {
          return scopeFailure(subjectCandidateSetRef, 'path-outside-authority',
            `Git paths [${offending.join(', ')}] are outside frozen changeScopes [${effectiveScopes.join(', ')}]. `
            + `If the acceptance criteria genuinely require these paths, conclude the attempt with `
            + `worker_done({ outcome: 'scope-insufficient', requested_scopes: [paths] }) instead of `
            + `writing them undeclared.`);
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
 * (fail open, registerless legacy SRS), or neither (enforced and covered).
 *
 * ADR-088 (CC-GAP-6) — register-conditional: when a non-empty constraint
 * register exists, an unavailable SRS artifact, an absent §2.2 section, or a
 * file-less manifest is a typed RED (`srs-module-manifest-missing`), never a
 * skip — a register-bearing corpus cannot dodge the coverage exit criterion
 * by omitting a document section. The typed legacy skip survives ONLY for
 * the registerless corpus (the sole grandfather condition).
 */
function assessSrsModuleManifestCoverage(
  subjectRef: string,
  readContent: () => DevelopmentSrsContentResult,
  implementationItems: readonly { changeScopes: readonly string[] }[],
  registerActive: boolean,
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
    if (registerActive) {
      return {
        failure: encodeCheckDiagnostic({
          code: 'srs-module-manifest-missing',
          message: `The SRS artifact is unavailable (${srs.reason}) while a non-empty constraint register exists: `
            + 'the §2.2 module manifest is required synthesis-ownership evidence and cannot be skipped. '
            + 'Restore the exact accepted SRS artifact or waive the uncovered constraints in the brief with reasons.',
          subjectRef,
        }),
        note: null,
      };
    }
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
    if (registerActive) {
      return {
        failure: encodeCheckDiagnostic({
          code: 'srs-module-manifest-missing',
          message: manifest.status === 'absent'
            ? 'The SRS has no §2.2 Module Manifest section while a non-empty constraint register exists: '
              + 'the manifest is required synthesis-ownership evidence and cannot be skipped. '
              + 'Add the §2.2 Module Manifest declaring the product\'s module files, or waive the uncovered '
              + 'constraints in the brief with reasons.'
            : 'The §2.2 Module Manifest declares no machine-readable files while a non-empty constraint '
              + 'register exists: a file-less manifest is missing synthesis-ownership evidence, not a skip. '
              + 'Declare the module files in §2.2, or waive the uncovered constraints in the brief with reasons.',
          subjectRef,
        }),
        note: null,
      };
    }
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
            acceptanceCriterionKeys?: unknown;
            coveredConstraintIds?: unknown;
          };
          process_node_input?: {
            upstream?: { bindings?: { candidate?: { candidateHash?: unknown } } };
          };
          trusted_provider_bindings?: unknown;
        };
        const item = metadata.cell_input_item;
        const criterionKeys = item?.acceptanceCriterionKeys;
        const frozenHash = metadata.process_node_input?.upstream?.bindings
          ?.candidate?.candidateHash;
        // AC-drift relay: when the verification card pins
        // coveredConstraintIds, the evidence must echo the exact same set —
        // lineage pins the constraint IDs together with the criterion key.
        // Cards without coverage (legacy / no register) keep the previous check.
        const cardConstraintIds = item?.coveredConstraintIds;
        const constraintLineageOk = !Array.isArray(cardConstraintIds)
          || (Array.isArray(decoded.value.coveredConstraintIds)
            && sameStringSet(cardConstraintIds, decoded.value.coveredConstraintIds));
        // The key's provenance segment must still match the task's
        // verification_target_artifact_id (the DB artifact row).
        const keyProvenanceArtifactId = Number(
          String(decoded.value.acceptanceCriterionKey).split(':')[0]);
        if (
          decoded.value.verificationItemKey !== item?.key
          || !Array.isArray(criterionKeys)
          || criterionKeys.length !== 1
          || decoded.value.acceptanceCriterionKey !== criterionKeys[0]
          || keyProvenanceArtifactId !== row.verification_target_artifact_id
          || decoded.value.acceptedCriterionHash !== row.accepted_hash
          || decoded.value.candidateHash !== frozenHash
          || !constraintLineageOk
        ) {
          return scopeFailure(subjectCandidateSetRef, 'verification-lineage-mismatch',
            'The verification evidence does not match its frozen lineage: verificationItemKey must equal the work item key,'
            + ' acceptanceCriterionKey must equal the single cell-input criterion key and its provenance artifact id,'
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

// ---------------------------------------------------------------------------
// CERTIFICATION-GAMING-REMEDY step 2 — M1-a monotonicity ratchet + D2
// declaration-diff escalation (readiness certification cell).
//
// The stage-11 gaming: rounds 1-3 declared opaque `npm test`; round 4 declared
// the 7-of-9 enumeration (excluding exactly the two red test files) with ZERO
// code change, and the gate ran the narrowed declaration silently. The
// declared verification surface of a readiness manifest may never shrink
// relative to a prior readiness manifest of the SAME sourceCandidate, and any
// readiness.commands.* change on the same sourceCandidate is an ESCALATION —
// a human_required verdict (the cell's complete-blocked transition), never a
// silent retry and never a plain gate failure (the worker submitted nothing
// malformed).
//
// Comparison scope is deliberate: same process run + identical
// sourceCandidate.hash. Narrowing across a candidate change may be legitimate
// (the bytes changed); only the derived-canonical core (rollout step 4, the
// architect's act) closes that. Opaque `npm test`-style priors resolve through
// the SEALED package.json of the exact source candidate (git show by object
// id — read-only, never a ref), so `npm test` -> 7-of-9 is caught
// mechanically; when the substrate is unreadable the declaration-diff (D2)
// still catches any command change deterministically.
// ---------------------------------------------------------------------------

export const DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID =
  'development.readiness-profile-monotonicity.v1';
export const DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_VERSION,
  invariant:
    'declared-verification-surface-never-shrinks-or-silently-changes-between-readiness-manifests-of-the-same-source-candidate',
  escalationPolicy:
    'narrowing-or-command-change-is-human-required-escalation-never-silent-retry-never-plain-failure',
  comparisonScope:
    'prior-managed-readiness-manifest-submissions-of-the-same-process-run-with-identical-source-candidate-hash',
  opaqueResolution:
    'npm-test-style-commands-resolve-through-the-sealed-package-json-of-the-exact-source-candidate-by-git-object-id',
});

/** The ratchet-relevant projection of one readiness manifest. */
interface ReadinessManifestCommands {
  readonly sourceHash: string;
  readonly installCommand: string | null;
  readonly testCommand: string;
}

function parseManifestCommands(payload: unknown): ReadinessManifestCommands | null {
  if (!isRecordValue(payload)) return null;
  const source = payload.sourceCandidate;
  if (!isRecordValue(source)
      || typeof source.hash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(source.hash)) {
    return null;
  }
  const targets = payload.targets;
  if (!Array.isArray(targets) || targets.length < 1) return null;
  const target = targets[0];
  if (!isRecordValue(target) || !isRecordValue(target.readiness)) return null;
  const commands = (target.readiness as { commands?: unknown }).commands;
  if (!isRecordValue(commands)) return null;
  const { installCommand, testCommand } = commands as {
    installCommand?: unknown; testCommand?: unknown;
  };
  if (typeof testCommand !== 'string' || testCommand.trim() === '') return null;
  if (installCommand !== null
      && (typeof installCommand !== 'string' || installCommand.trim() === '')) {
    return null;
  }
  return {
    sourceHash: source.hash,
    installCommand: installCommand === null ? null : installCommand,
    testCommand,
  };
}

/** The sealed test material of one exact source candidate (read-only git). */
interface SealedTestMaterial {
  readonly packageJsonTestScript: string | null;
  readonly testsTreeFiles: readonly string[] | null;
}

function readSealedTestMaterial(
  input: { db: SqlDatabasePort; git: GitPort },
  processRunId: number,
  sourceHash: string,
): SealedTestMaterial | null {
  try {
    const product = input.db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE process_run_id=? AND schema_id=? AND product_hash=?`,
    ).get(processRunId, INTEGRATED_SOURCE_CANDIDATE_SCHEMA, sourceHash) as
      { payload_snapshot: string } | undefined;
    if (!product) return null;
    const payload = JSON.parse(product.payload_snapshot) as {
      repositories?: Array<{ projectRepositoryId?: unknown; commitSha?: unknown }>;
    };
    const repository = Array.isArray(payload.repositories)
      ? payload.repositories[0]
      : undefined;
    if (!repository
        || !Number.isSafeInteger(repository.projectRepositoryId)
        || typeof repository.commitSha !== 'string') {
      return null;
    }
    const binding = input.db.prepare(
      'SELECT local_path FROM project_repositories WHERE id=?',
    ).get(repository.projectRepositoryId) as { local_path: string | null } | undefined;
    if (!binding?.local_path) return null;
    let packageJsonTestScript: string | null = null;
    const pkgRaw = input.git.read(binding.local_path, [
      'show', `${repository.commitSha}:package.json`,
    ]);
    if (pkgRaw !== null) {
      try {
        const test = (JSON.parse(pkgRaw) as { scripts?: { test?: unknown } }).scripts?.test;
        if (typeof test === 'string' && test.trim() !== '') packageJsonTestScript = test;
      } catch { /* unreadable package.json: resolution unavailable */ }
    }
    const lsRaw = input.git.read(binding.local_path, [
      'ls-tree', '-r', '--name-only', repository.commitSha,
    ]);
    const testsTreeFiles = lsRaw === null ? null
      : lsRaw.split(/\r?\n/u)
        .map(line => normalizeTestPath(line))
        .filter(file => file.startsWith('tests/') && isTestFilePath(file))
        .sort();
    return { packageJsonTestScript, testsTreeFiles };
  } catch {
    return null;
  }
}

/**
 * The resolved test-file surface one declaration executes, or null when it
 * cannot be resolved (opaque runner, unreadable substrate). Directory-shaped
 * declarations (`node --test tests/`, or a sealed scripts.test that names the
 * directory) execute the whole sealed tests tree.
 */
function declaredTestSurface(
  manifest: ReadinessManifestCommands,
  material: SealedTestMaterial | null,
): readonly string[] | null {
  const declared = resolveDeclaredTestSurface({
    testCommand: manifest.testCommand,
    sealedPackageJsonTestScript: material?.packageJsonTestScript ?? null,
  });
  if (declared.files !== null && declared.files.length > 0) return declared.files;
  if (declared.status === 'whole-tests-directory'
      || declared.status === 'resolved-via-sealed-package-json') {
    return material?.testsTreeFiles ?? null;
  }
  return null;
}

function truncateCommand(value: string | null, max = 120): string {
  const text = value === null ? 'null' : value;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function monotonicityError(
  subjectRef: string,
  code: string,
  message: string,
): CheckProviderResult {
  return {
    outcome: 'error',
    evidenceRefs: [encodeCheckDiagnostic({ code, message, subjectRef })],
  };
}

export function createDevelopmentReadinessMonotonicityCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
  git: GitPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_CONTEXT_INVALID',
            'The readiness monotonicity check requires the process run id of the certification cell.');
        }
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author' || candidate.members.length !== 1) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_SUBJECT_INVALID',
            'The readiness monotonicity check requires the exact single author candidate set of the readiness-certification cell.');
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DEVELOPMENT_READINESS_MANIFEST_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_SUBJECT_INVALID',
            `The readiness monotonicity subject must be a ${DEVELOPMENT_READINESS_MANIFEST_SCHEMA} managed-node-submission,`
            + ` got ${member.productRef.schemaId}:${member.productRef.ref}.`);
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_SUBJECT_INVALID',
            `The readiness manifest submission ref '${member.productRef.ref}' does not carry a numeric managed-node-submission id.`);
        }
        const row = input.db.prepare(
          `SELECT payload_snapshot, content_hash
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=? AND schema_version=?`,
        ).get(submissionId, processRunId, DEVELOPMENT_READINESS_MANIFEST_SCHEMA) as
          | { payload_snapshot: string; content_hash: string }
          | undefined;
        if (!row || row.content_hash !== member.productRef.digest) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_SUBMISSION_UNBOUND',
            'The readiness manifest does not match the exact CandidateSet member submission digest.');
        }
        const current = parseManifestCommands(JSON.parse(row.payload_snapshot));
        if (current === null) {
          return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_MANIFEST_INVALID',
            'The readiness manifest payload does not state a valid sourceCandidate and primary readiness.commands.');
        }
        // Every prior readiness manifest of this process run, oldest first.
        let priors: Array<{ id: number; payload_snapshot: string }>;
        try {
          priors = input.db.prepare(
            `SELECT id, payload_snapshot
               FROM factory_managed_node_submissions
              WHERE process_run_id=? AND schema_version=?
              ORDER BY id ASC`,
          ).all(processRunId, DEVELOPMENT_READINESS_MANIFEST_SCHEMA) as Array<{
            id: number; payload_snapshot: string;
          }>;
        } catch {
          // No submission history substrate (pre-table store): the ratchet is
          // inert by design — nothing to compare, not an error.
          return 'passed';
        }
        const material = readSealedTestMaterial(input, processRunId, current.sourceHash);
        const currentSurface = declaredTestSurface(current, material);
        for (const prior of priors) {
          if (prior.id === submissionId) continue;
          let priorCommands: ReadinessManifestCommands | null = null;
          try {
            priorCommands = parseManifestCommands(JSON.parse(prior.payload_snapshot));
          } catch {
            continue;
          }
          // Only manifests of the SAME sourceCandidate compare: the bytes the
          // declaration will run against are identical, so a surface change
          // is a change of WHAT is verified, not of what is verified against.
          if (priorCommands === null || priorCommands.sourceHash !== current.sourceHash) {
            continue;
          }
          const identical = priorCommands.installCommand === current.installCommand
            && priorCommands.testCommand === current.testCommand;
          if (identical) continue;
          const priorSurface = declaredTestSurface(priorCommands, material);
          const dropped = priorSurface !== null && currentSurface !== null
            ? priorSurface.filter(file => !currentSurface.includes(file))
            : [];
          if (dropped.length > 0) {
            return {
              outcome: 'unknown',
              evidenceRefs: [encodeCheckDiagnostic({
                code: 'READINESS_PROFILE_NARROWED',
                subjectRef: subjectCandidateSetRef,
                message:
                  'The declared verification surface NARROWED against prior readiness manifest submission '
                  + `${prior.id} for the same sourceCandidate ${current.sourceHash.slice(0, 12)}…: `
                  + `the prior declaration ran [${dropped.join(', ')}] which the current declaration no `
                  + `longer executes (prior testCommand: ${truncateCommand(priorCommands.testCommand)}; `
                  + `current testCommand: ${truncateCommand(current.testCommand)}). A candidate may not `
                  + 'shrink its declared verification surface without changing its bytes — human review '
                  + 'required (READINESS_PROFILE_NARROWED).',
              })],
            };
          }
          return {
            outcome: 'unknown',
            evidenceRefs: [encodeCheckDiagnostic({
              code: 'READINESS_DECLARATION_CHANGED',
              subjectRef: subjectCandidateSetRef,
              message:
                `readiness.commands CHANGED against prior readiness manifest submission ${prior.id} for `
                + `the same sourceCandidate ${current.sourceHash.slice(0, 12)}… (zero code change): `
                + `installCommand '${truncateCommand(priorCommands.installCommand, 40)}' -> `
                + `'${truncateCommand(current.installCommand, 40)}'; testCommand `
                + `'${truncateCommand(priorCommands.testCommand)}' -> '${truncateCommand(current.testCommand)}'. `
                + 'A declaration change on unchanged bytes is never a silent retry — human review '
                + 'required (READINESS_DECLARATION_CHANGED).',
            })],
          };
        }
        return 'passed';
      } catch (err) {
        return monotonicityError(subjectCandidateSetRef, 'READINESS_MONOTONICITY_CHECK_ERROR',
          `The readiness monotonicity check could not complete deterministically: ${
            err instanceof Error ? err.message.slice(0, 600) : String(err).slice(0, 600)
          }`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// STAGE-18 R2 — implementation claim-surface monotonicity (live finding
// E-F5 / matrix E8). The stage-15 run proved the hole submit by submit:
// card 1 claimed root.config on sub 14, dropped it on sub 15 and was
// ACCEPTED terminal-forever with the hole; card 2 claimed root.config on
// subs 17/18/19, dropped it (and one more) on sub 20 and passed the author
// gate — only that card's reviewer happened to run a build. The scope
// check compares the CURRENT claim against the git diff and the frozen
// scopes, never against the card's own PRIOR claims, so a silent narrowing
// is invisible to it. The rule (copied from the readiness monotonicity
// form, second object): a card may not silently narrow its claimed file
// surface between submissions — a dropped file is either an explicit
// snapshot.droppedFiles disposition (with a reason) or a regression.
// ---------------------------------------------------------------------------

export const DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_ID =
  'development.implementation-claim-monotonicity.v1';
export const DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_VERSION,
  invariant:
    'claimed-file-surface-never-silently-narrows-between-implementation-submissions-of-the-same-task',
  lawfulExit:
    'a-drop-is-legal-only-with-an-explicit-snapshot-droppedFiles-entry-carrying-a-non-empty-reason',
  comparisonScope:
    'union-of-all-prior-implementation-result-submissions-of-the-same-task-pure-durable-state',
});

/** The claimed file paths of one submission payload (both changedFiles
 *  shapes: plain path strings and {path,…} entries). Null when the payload
 *  states no readable claim at all. */
function claimedFilePaths(payload: unknown): readonly string[] | null {
  if (!isRecordValue(payload)) return null;
  const snapshot = payload.snapshot;
  if (!isRecordValue(snapshot) || !Array.isArray(snapshot.changedFiles)) return null;
  const paths: string[] = [];
  for (const entry of snapshot.changedFiles) {
    if (typeof entry === 'string') {
      if (entry !== '') paths.push(entry);
    } else if (isRecordValue(entry) && typeof entry.path === 'string' && entry.path !== '') {
      paths.push(entry.path);
    }
  }
  return paths;
}

/** The explicitly dispositioned drops of the CURRENT payload. A
 *  droppedFiles entry without a non-empty reason is NOT a disposition —
 *  the field's existence must not launder a silent drop. */
function dispositionedDropPaths(payload: unknown): readonly string[] {
  if (!isRecordValue(payload)) return [];
  const snapshot = payload.snapshot;
  if (!isRecordValue(snapshot) || !Array.isArray(snapshot.droppedFiles)) return [];
  const paths: string[] = [];
  for (const entry of snapshot.droppedFiles) {
    if (isRecordValue(entry)
        && typeof entry.path === 'string' && entry.path !== ''
        && typeof entry.reason === 'string' && entry.reason.trim() !== '') {
      paths.push(entry.path);
    }
  }
  return paths;
}

export function createImplementationClaimMonotonicityCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_CONTEXT_INVALID',
            'The claim-surface monotonicity check requires the process run id of the implementation cell.');
        }
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author' || candidate.members.length !== 1) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_SUBJECT_INVALID',
            'The claim-surface monotonicity check requires the exact single author candidate set of the implementation cell.');
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_SUBJECT_INVALID',
            `The claim-surface monotonicity subject must be a ${DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA} managed-node-submission,`
            + ` got ${member.productRef.schemaId}:${member.productRef.ref}.`);
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_SUBJECT_INVALID',
            `The implementation submission ref '${member.productRef.ref}' does not carry a numeric managed-node-submission id.`);
        }
        const row = input.db.prepare(
          `SELECT payload_snapshot, content_hash, task_id
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=? AND schema_version=?`,
        ).get(submissionId, processRunId, DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA) as
          | { payload_snapshot: string; content_hash: string; task_id: number }
          | undefined;
        if (!row || row.content_hash !== member.productRef.digest) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_SUBMISSION_UNBOUND',
            'The implementation submission does not match the exact CandidateSet member submission digest.');
        }
        let currentPayload: unknown;
        try {
          currentPayload = JSON.parse(row.payload_snapshot);
        } catch {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_PAYLOAD_INVALID',
            'The implementation submission payload is not parsable JSON.');
        }
        const currentPaths = claimedFilePaths(currentPayload);
        if (currentPaths === null) {
          return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_PAYLOAD_INVALID',
            'The implementation submission payload does not state a readable snapshot.changedFiles claim.');
        }
        const dispositioned = new Set(dispositionedDropPaths(currentPayload));
        // The card's OWN prior claims (same task), oldest first. The surface
        // is the UNION of every prior claim — a file claimed by ANY prior
        // submission counts, not just the latest one.
        let priors: Array<{ id: number; payload_snapshot: string }>;
        try {
          priors = input.db.prepare(
            `SELECT id, payload_snapshot
               FROM factory_managed_node_submissions
              WHERE task_id=? AND schema_version=?
              ORDER BY id ASC`,
          ).all(row.task_id, DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA) as Array<{
            id: number; payload_snapshot: string;
          }>;
        } catch {
          // No submission history substrate (pre-table store): the ratchet is
          // inert by design — nothing to compare, not an error.
          return 'passed';
        }
        const priorSurface = new Set<string>();
        for (const prior of priors) {
          if (prior.id === submissionId) continue;
          let priorPayload: unknown;
          try {
            priorPayload = JSON.parse(prior.payload_snapshot);
          } catch {
            continue;
          }
          const priorPaths = claimedFilePaths(priorPayload);
          if (priorPaths === null) continue;
          for (const path of priorPaths) priorSurface.add(path);
        }
        const dropped = [...priorSurface]
          .filter(path => !currentPaths.includes(path) && !dispositioned.has(path));
        if (dropped.length > 0) {
          return {
            outcome: 'failed',
            evidenceRefs: [encodeCheckDiagnostic({
              code: 'IMPLEMENTATION_CLAIM_NARROWED',
              subjectRef: subjectCandidateSetRef,
              message:
                `The claimed file surface NARROWED: [${dropped.join(', ')}] was claimed by a `
                + 'prior submission of this card and is absent from the current claim without a '
                + 'disposition. Either deliver the dropped file(s) again, or dispose of the drop '
                + 'explicitly in snapshot.droppedFiles (one {path, reason} entry per file — an '
                + 'empty reason is not a disposition). A silent drop is a regression of the '
                + "card's own claim (IMPLEMENTATION_CLAIM_NARROWED).",
            })],
          };
        }
        return 'passed';
      } catch (err) {
        return monotonicityError(subjectCandidateSetRef, 'CLAIM_MONOTONICITY_CHECK_ERROR',
          `The claim-surface monotonicity check could not complete deterministically: ${
            err instanceof Error ? err.message.slice(0, 600) : String(err).slice(0, 600)
          }`);
      }
    },
  };
}
