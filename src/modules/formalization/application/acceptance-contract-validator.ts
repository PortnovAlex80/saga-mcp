/**
 * Formalization acceptance-contract submission validator.
 *
 * Shifts the AC traceability gate (every AC → exact FR/NFR + UC) from the
 * post-hoc resolver to the worker_done boundary. Before this validator, the
 * LM could call worker_done with an incomplete acceptance bundle (AC-10
 * linked only to RULE, missing the mandatory FR/NFR edge), and the gap was
 * discovered only by resolve-acceptance-contract — AFTER the expensive worker
 * execution had already ended. Now the worker is told the gaps BEFORE it
 * leaves, so it can fix and retry without burning a recovery epoch.
 *
 * The validation logic is the SAME `findContractGap({ acceptance: true })`
 * the resolver uses — extracted and reused, not duplicated. This guarantees
 * the pre-submit gate and the post-hoc resolver never disagree on what a
 * valid acceptance contract looks like.
 */

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  buildContractSnapshot,
  findContractGap,
} from './formalization-installation.js';
import type { FormalizationArtifactSnapshot, FormalizationCanonicalGraphPort, FormalizationTraceSnapshot } from '../domain/formalization-kernel-ports.js';
import type {
  NodeSubmissionValidationInput,
  NodeSubmissionValidationResult,
  NodeSubmissionValidator,
  SubmissionGap,
  SubmissionValidationReceipt,
} from '../../../process-modules/application/node-submission-policy.js';

export const ACCEPTANCE_CONTRACT_VALIDATOR_ID = 'formalization.acceptance-contract.v1';

/**
 * Build a FormalizationCanonicalGraphPort over a raw DB handle. Reads
 * artifacts + artifact_traces directly — the same tables buildContractSnapshot
 * reads through the port in the resolver path.
 */
function graphPortFromDb(db: Database.Database): FormalizationCanonicalGraphPort {
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
          WHERE source_id IN (${placeholders}
            ) AND target_type='artifact'`,
      ).all(...sourceArtifactIds) as FormalizationTraceSnapshot[];
    },
  };
}

/**
 * Read ALL formalization contract artifacts for the process run. The
 * acceptance validator needs the full contract (PRD, FR, NFR, RULE, UC, AC)
 * because it checks edges between AC and FR/NFR/UC — those target artifacts
 * were created by earlier nodes (define-product-contract, model-use-cases),
 * not by define-acceptance-contract itself. Reading only AC-managed artifacts
 * would make every AC appear to have no FR/NFR edge (the targets wouldn't be
 * in the snapshot).
 */
function readContractArtifacts(
  db: Database.Database,
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

/**
 * Map the aggregated gap string from findContractGap into structured
 * SubmissionGap objects. The resolver uses the string form; the validator
 * returns the structured form so the worker sees exactly which artifacts are
 * missing which edges.
 *
 * The gap string format is: "AC <id> has no derived_from → exact FR/NFR trace"
 * or "FR-derived AC <id> has no derived_from → exact UC trace".
 */
function parseGaps(
  gapString: string,
  snapshot: ReturnType<typeof buildContractSnapshot>,
): SubmissionGap[] {
  const gaps: SubmissionGap[] = [];
  const parts = gapString.split('; ');
  for (const part of parts) {
    const acMatch = part.match(/AC (\d+) has no (derived_from) → exact (FR\/NFR|UC) trace/);
    if (acMatch) {
      const artifactId = Number(acMatch[1]);
      const artifact = snapshot.artifacts.find(a => a.id === artifactId);
      const requiredTypes = acMatch[3] === 'FR/NFR' ? ['FR', 'NFR'] : ['UC'];
      const existingTargets = snapshot.traces
        .filter(t => t.sourceArtifactId === artifactId)
        .map(t => {
          const target = snapshot.targetArtifacts.find(a => a.id === t.targetId)
            ?? snapshot.artifacts.find(a => a.id === t.targetId);
          return { type: target?.type ?? '?', id: t.targetId };
        });
      gaps.push({
        artifactId,
        artifactCode: artifact?.code ?? null,
        artifactType: 'AC',
        existingTargets,
        missing: {
          relation: 'derived_from',
          requiredTargetTypes: requiredTypes,
          minimum: 1,
        },
      });
    }
  }
  return gaps;
}

/**
 * Create the acceptance-contract validator. The DB handle is injected so the
 * validator reads fresh state at validation time (not a stale snapshot).
 */
export function createAcceptanceContractValidator(
  db: Database.Database,
): NodeSubmissionValidator {
  return {
    validatorId: ACCEPTANCE_CONTRACT_VALIDATOR_ID,
    validatorVersion: '1.0.0',
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      const graph = graphPortFromDb(db);
      const artifacts = readContractArtifacts(db, input.processRunId);
      // If the worker created no AC artifacts, the resolver will catch it
      // (cardinality check). Accept here — the gap is "no ACs at all", not
      // "ACs with missing edges".
      if (!artifacts.some(a => a.type === 'AC')) {
        return acceptWithReceipt(db, input, artifacts, []);
      }
      const snapshot = buildContractSnapshot(graph, artifacts);
      const gap = findContractGap(snapshot, {
        product: true,
        useCases: true,
        acceptance: true,
      });
      if (gap) {
        const structuredGaps = parseGaps(gap, snapshot);
        return {
          accepted: false,
          code: 'FORMALIZATION_ACCEPTANCE_INCOMPLETE',
          gaps: structuredGaps,
        };
      }
      const traceIds = snapshot.traces.map(t => t.id);
      return acceptWithReceipt(db, input, artifacts, traceIds);
    },
  };
}

function acceptWithReceipt(
  _db: Database.Database,
  input: NodeSubmissionValidationInput,
  artifacts: readonly FormalizationArtifactSnapshot[],
  traceIds: readonly number[],
): NodeSubmissionValidationResult {
  const artifactIds = artifacts.map(a => a.id);
  const validatedSetDigest = sha256Hex({
    artifactIds: [...artifactIds].sort((a, b) => a - b),
    traceIds: [...traceIds].sort((a, b) => a - b),
  });
  const receipt: SubmissionValidationReceipt = {
    validatorId: ACCEPTANCE_CONTRACT_VALIDATOR_ID,
    validatorVersion: '1.0.0',
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    nodeId: input.nodeId,
    executionId: input.executionId,
    taskId: input.taskId,
    inputSnapshotHash: validatedSetDigest,
    artifactIds,
    traceIds,
    validatedSetDigest,
    validatedAt: new Date().toISOString(),
  };
  return { accepted: true, receipt };
}
