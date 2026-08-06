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
  findContractGap,
} from './formalization-installation.js';
import type { FormalizationArtifactSnapshot, FormalizationCanonicalGraphPort } from '../domain/formalization-kernel-ports.js';
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
  },
): NodeSubmissionValidator {
  return {
    validatorId,
    validatorVersion: '1.0.0',
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      const graph = graphPortFromDb(db);
      const artifacts = readContractArtifacts(db, input.processRunId);
      if (artifacts.length === 0) {
        // No artifacts produced — resolver will catch. Accept (not a
        // structural gap the validator can describe).
        return acceptWithReceipt(input, [], []);
      }
      const snapshot = buildContractSnapshot(graph, artifacts);
      const gap = findContractGap(snapshot, required);
      if (gap) {
        return {
          accepted: false,
          code: 'FORMALIZATION_CONTRACT_INCOMPLETE',
          gaps: parseGaps(gap),
        };
      }
      const traceIds = snapshot.traces.map(t => t.id);
      return acceptWithReceipt(input, artifacts, traceIds);
    },
  };
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
    validatorId: 'formalization.contract.v1',
    validatorVersion: '1.0.0',
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
