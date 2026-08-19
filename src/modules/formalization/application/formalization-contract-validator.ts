/**
 * Generic formalization contract submission validator.
 *
 * Reuses findContractGap (the SAME function the resolvers use) to validate
 * the structural traceability of the formalization contract at worker_done
 * time, BEFORE the task transitions. Each formalization LM-node declares
 * which contract dimensions it requires (product, useCases, acceptance,
 * architecture), and this validator runs findContractGap with those flags.
 *
 * This eliminates the split between "what the resolver checks" and "what the
 * worker can submit" for ALL formalization nodes, not just AC.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';

/**
 * Driver-neutral database handle alias. See srs-contract-validator.ts for
 * rationale (Wave 7 architecture test: no-sqlite-in-modules).
 */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}
import {
  buildContractSnapshot,
  constraintCoverageGapIdList,
  findContractGap,
} from './formalization-contract-analysis.js';
import {
  constraintCoverageSubmissionGaps,
  readConstraintCoverageRequirement,
} from './constraint-coverage.js';
import type { FormalizationArtifactSnapshot, FormalizationCanonicalGraphPort } from '../domain/formalization-kernel-ports.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  resolveFormalizationCaseConstraintRegister,
  type FormalizationCase,
} from '../domain/formalization-schemas.js';
import type {
  NodeSubmissionValidationInput,
  NodeSubmissionValidationResult,
  NodeSubmissionValidator,
  SubmissionGap,
  SubmissionValidationReceipt,
} from '../../../process-modules/application/node-submission-policy.js';

/**
 * Create a formalization contract validator for a specific node + contract
 * dimension set. The validatorId is per-node so the registry can resolve it.
 *
 * `constraintDispositions: true` enables the AC-drift reaction gate: every
 * constraint-register ID carried by the FormalizationCase must be disposed in
 * the brief artifact's metadata (accepted | waived+reason). The check is a
 * deterministic typed-ID diff — no string matching, no LM oracle.
 */
export function createFormalizationContractValidator(
  db: DbHandle,
  validatorId: string,
  _nodeId: string,
  required: {
    product?: boolean;
    useCases?: boolean;
    acceptance?: boolean;
    architecture?: boolean;
    constraintDispositions?: boolean;
    /** AC-drift structure network: enforce the coverage ratchet. */
    coverage?: boolean;
  },
): NodeSubmissionValidator {
  const validatorVersion = '1.1.0';
  return {
    validatorId,
    validatorVersion,
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      // AC-drift reaction network first: an author who has not reacted to the
      // order's constraints must be told THAT before any structural detail —
      // the forensic verdict named "no obligation to react" as the defect.
      if (required.constraintDispositions) {
        const dispositionGaps = checkConstraintDispositions(db, input);
        if (dispositionGaps !== null) {
          return {
            accepted: false,
            code: 'FORMALIZATION_CONSTRAINT_UNDISPOSED',
            gaps: dispositionGaps,
          };
        }
      }
      const graph = graphPortFromDb(db);
      const artifacts = readContractArtifacts(db, input.processRunId);
      if (artifacts.length === 0) {
        // No artifacts produced — resolver will catch. Accept (not a
        // structural gap the validator can describe).
        return acceptWithReceipt(input, [], [], validatorId, validatorVersion);
      }
      const snapshot = buildContractSnapshot(graph, artifacts);
      // AC-drift structure network: the coverage ratchet uses the shared
      // typed-ID reverse diff (constraintCoverageGapIdList) — never string
      // matching over gap prose. The structural dimensions stay separate so
      // both defect classes are reported in one round.
      const { coverage: _coverageFlag, constraintDispositions: _dispositionsFlag, ...dimensions } = required;
      const coverage = required.coverage
        ? readConstraintCoverageRequirement(db, input.taskId, input.processRunId)
        : null;
      if (coverage) {
        const uncovered = constraintCoverageGapIdList(snapshot, coverage);
        if (uncovered.length > 0) {
          const structuralGap = findContractGap(snapshot, dimensions);
          return {
            accepted: false,
            code: 'FORMALIZATION_CONSTRAINT_UNCOVERED',
            gaps: [
              ...constraintCoverageSubmissionGaps(uncovered, coverage.registerTexts),
              ...(structuralGap ? parseGaps(structuralGap) : []),
            ],
          };
        }
      }
      const gap = findContractGap(snapshot, dimensions);
      if (gap) {
        return {
          accepted: false,
          code: 'FORMALIZATION_CONTRACT_INCOMPLETE',
          gaps: parseGaps(gap),
        };
      }
      const traceIds = snapshot.traces.map(t => t.id);
      return acceptWithReceipt(input, artifacts, traceIds, validatorId, validatorVersion);
    },
  };
}

interface BriefRow {
  id: number;
  metadata: string;
}

/**
 * The A1 enforcement heart: deterministic diff of register IDs (resolved from
 * the FormalizationCase that already rides the task's process_node_input)
 * minus valid dispositions in the brief artifact's
 * metadata.constraint_dispositions. Returns the per-ID gaps, or null when
 * every ID is disposed / no register exists (retro-compat empty diff).
 */
function checkConstraintDispositions(
  db: DbHandle,
  input: NodeSubmissionValidationInput,
): SubmissionGap[] | null {
  const taskRow = db.prepare(
    'SELECT metadata FROM tasks WHERE id=?',
  ).get(input.taskId) as { metadata: string | null } | undefined;
  if (!taskRow || typeof taskRow.metadata !== 'string') return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(taskRow.metadata);
  } catch {
    return null;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const caseCandidate = (metadata as Record<string, unknown>).process_node_input;
  if (
    typeof caseCandidate !== 'object'
    || caseCandidate === null
    || Array.isArray(caseCandidate)
    || (caseCandidate as Record<string, unknown>).schemaVersion !== FORMALIZATION_CASE_SCHEMA
  ) {
    return null;
  }
  const formalizationCase = caseCandidate as unknown as FormalizationCase;
  const binding = resolveFormalizationCaseConstraintRegister(formalizationCase);
  if (!binding) return null;

  const briefRow = db.prepare(
    `SELECT a.id, a.metadata
       FROM artifacts a
       JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
      WHERE p.process_run_id=? AND a.type='brief'
      ORDER BY a.id DESC LIMIT 1`,
  ).get(input.processRunId) as BriefRow | undefined;
  let dispositions: Record<string, unknown> = {};
  if (briefRow) {
    try {
      const parsed = JSON.parse(briefRow.metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const carried = (parsed as Record<string, unknown>).constraint_dispositions;
        if (typeof carried === 'object' && carried !== null && !Array.isArray(carried)) {
          dispositions = carried as Record<string, unknown>;
        }
      }
    } catch {
      dispositions = {};
    }
  }

  const gaps: SubmissionGap[] = [];
  for (const entry of binding.constraintRegister.constraints) {
    const disposition = dispositions[entry.id];
    const accepted = isValidRecord(disposition)
      && disposition.disposition === 'accepted';
    const waivedWithReason = isValidRecord(disposition)
      && disposition.disposition === 'waived'
      && typeof disposition.reason === 'string'
      && disposition.reason.trim().length > 0;
    if (accepted || waivedWithReason) continue;
    const reason = isValidRecord(disposition) && disposition.disposition === 'waived'
      ? ` (waived requires a non-empty reason)`
      : '';
    gaps.push({
      artifactId: briefRow?.id ?? -1,
      artifactCode: entry.id,
      artifactType: 'brief',
      existingTargets: [],
      missing: {
        relation: 'covers_constraint',
        requiredTargetTypes: [`${entry.id}: accepted | waived+reason`],
        minimum: 1,
      },
      message: `Constraint ${entry.id} (${entry.class}) "${entry.text}" is not disposed`
        + ` in the brief artifact metadata constraint_dispositions${reason}.`
        + ` React per ID: {"${entry.id}": {"disposition": "accepted"}} or`
        + ` {"disposition": "waived", "reason": "<why>"}.`,
    });
  }
  return gaps.length > 0 ? gaps : null;
}

function isValidRecord(value: unknown): value is { disposition?: unknown; reason?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graphPortFromDb(db: DbHandle): FormalizationCanonicalGraphPort {
  return {
    readArtifactsByIds(ids: readonly number[]): readonly FormalizationArtifactSnapshot[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, project_id AS "projectId", epic_id AS "epicId", type, code,
                status, content_hash AS "contentHash",
                accepted_hash AS "acceptedHash",
                drift_state AS "driftState", tags, metadata
           FROM artifacts WHERE id IN (${placeholders})`,
      ).all(...ids) as FormalizationArtifactSnapshot[];
    },
    readTracesByIds(ids: readonly number[]): readonly FormalizationTraceSnapshot[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, source_id AS "sourceArtifactId", target_type AS "targetType",
                target_id AS "targetId", link_type AS "linkType"
           FROM artifact_traces WHERE id IN (${placeholders})`,
      ).all(...ids) as FormalizationTraceSnapshot[];
    },
    readOutgoingArtifactTraces(
      sourceArtifactIds: readonly number[],
    ): readonly FormalizationTraceSnapshot[] {
      if (sourceArtifactIds.length === 0) return [];
      const placeholders = sourceArtifactIds.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, source_id AS "sourceArtifactId", target_type AS "targetType",
                target_id AS "targetId", link_type AS "linkType"
           FROM artifact_traces
          WHERE source_id IN (${placeholders}) AND target_type='artifact'`,
      ).all(...sourceArtifactIds) as FormalizationTraceSnapshot[];
    },
  };
}

function readContractArtifacts(
  db: DbHandle,
  processRunId: number,
): readonly FormalizationArtifactSnapshot[] {
  return db.prepare(
    `SELECT DISTINCT a.id, a.project_id AS "projectId", a.epic_id AS "epicId",
            a.type, a.code, a.status, a.content_hash AS "contentHash",
            a.accepted_hash AS "acceptedHash", a.drift_state AS "driftState",
            a.tags, a.metadata
       FROM artifacts a
       JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
      WHERE p.process_run_id=?`,
  ).all(processRunId) as FormalizationArtifactSnapshot[];
}

function parseGaps(gapString: string): SubmissionGap[] {
  // Map the aggregated gap string to structured gaps. The string format is
  // "AC <id> has no derived_from → exact FR/NFR trace; UC <id> has no ..."
  const gaps: SubmissionGap[] = [];
  const parts = gapString.split('; ');
  for (const part of parts) {
    const artifactMatch = part.match(/(\w+)\s+(\d+)\s+has no\s+(.+?)(?:\s+trace)?$/);
    if (artifactMatch) {
      const [, type, idStr, desc] = artifactMatch;
      const artifactId = Number(idStr);
      const requiredTypes = desc.includes('FR/NFR')
        ? ['FR', 'NFR']
        : desc.includes('PRD')
          ? ['PRD']
          : desc.includes('UC')
            ? ['UC']
            : desc.includes('brief')
              ? ['brief']
              : ['?'];
      gaps.push({
        artifactId,
        artifactCode: null,
        artifactType: type ?? '?',
        existingTargets: [],
        missing: {
          relation: 'derived_from',
          requiredTargetTypes: requiredTypes,
          minimum: 1,
        },
      });
    } else {
      // Cardinality failure (e.g. "contract must contain exactly one PRD")
      gaps.push({
        artifactId: -1,
        artifactCode: null,
        artifactType: 'CONTRACT',
        existingTargets: [],
        missing: {
          relation: 'cardinality',
          requiredTargetTypes: [part],
          minimum: 1,
        },
      });
    }
  }
  return gaps;
}

function acceptWithReceipt(
  input: NodeSubmissionValidationInput,
  artifacts: readonly { id: number; contentHash: string | null }[],
  traceIds: number[],
  validatorId: string,
  validatorVersion: string,
): NodeSubmissionValidationResult {
  const artifactIds = artifacts.map(a => a.id);
  const artifactHashes: Record<string, string> = {};
  for (const a of artifacts) {
    if (a.contentHash) artifactHashes[String(a.id)] = a.contentHash;
  }
  const sortedTraceIds = [...traceIds].sort((a, b) => a - b);
  const traceDigest = sha256Hex(sortedTraceIds);
  const validatedSetDigest = sha256Hex({
    artifactIds: [...artifactIds].sort((a, b) => a - b),
    artifactHashes,
    traceIds: sortedTraceIds,
  });
  const receipt: SubmissionValidationReceipt = {
    validatorId,
    validatorVersion,
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    nodeId: input.nodeId,
    executionId: input.executionId,
    taskId: input.taskId,
    inputSnapshotHash: validatedSetDigest,
    artifactIds,
    traceIds,
    artifactHashes,
    traceDigest,
    validatedSetDigest,
    contractRef: input.contractRef,
    validatedAt: new Date().toISOString(),
  };
  return { accepted: true, receipt };
}

// Re-export FormalizationTraceSnapshot type for the graph port above.
import type { FormalizationTraceSnapshot } from '../domain/formalization-kernel-ports.js';
