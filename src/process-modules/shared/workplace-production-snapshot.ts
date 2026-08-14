import type {
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
} from './managed-production.js';
import { sha256Hex } from '../../shared/canonical-json.js';

export const WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION =
  'factory.workplace-production-snapshot.v2' as const;

export interface WorkplaceProductionArtifactSnapshot {
  readonly artifactId: number;
  readonly artifactType: string;
  readonly artifactStatus: string;
  readonly contentHash: string;
  readonly operation: ManagedArtifactProductionRecord['operation'];
}

export interface WorkplaceProductionTraceSnapshot {
  readonly traceId: number;
  readonly sourceId: number;
  readonly targetType: 'artifact' | 'task';
  readonly targetId: number;
  readonly linkType: string;
  readonly traceHash: string;
}

/**
 * Immutable managed-production material presented by one Workplace.
 *
 * The snapshot contains material only. Execution provenance stays in the
 * contribution/revision audit records and must never affect this ProductRef's
 * digest or CandidateSet authority.
 */
export interface WorkplaceProductionSnapshot {
  readonly schemaVersion: typeof WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION;
  readonly workplaceRef: string;
  readonly expectedSchemaRef: string;
  readonly artifacts: readonly WorkplaceProductionArtifactSnapshot[];
  readonly traces: readonly WorkplaceProductionTraceSnapshot[];
}

export function buildWorkplaceProductionSnapshot(input: {
  workplaceRef: string;
  expectedSchemaRef: string;
  artifacts: readonly ManagedArtifactProductionRecord[];
  traces: readonly ManagedTraceProductionRecord[];
}): WorkplaceProductionSnapshot {
  const artifacts = input.artifacts
    .filter((row): row is ManagedArtifactProductionRecord & { contentHash: string } =>
      row.contentHash !== null)
    .map(row => ({
      artifactId: row.artifactId,
      artifactType: row.artifactType,
      artifactStatus: row.artifactStatus,
      contentHash: row.contentHash,
      operation: row.operation,
    }));
  const traces = input.traces.map(row => ({
    traceId: row.traceId,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    linkType: row.linkType,
    traceHash: row.traceHash,
  }));
  return {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: input.workplaceRef,
    expectedSchemaRef: input.expectedSchemaRef,
    artifacts,
    traces,
  };
}

export function isWorkplaceProductionSnapshot(
  value: unknown,
): value is WorkplaceProductionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION
    && typeof row.workplaceRef === 'string'
    && typeof row.expectedSchemaRef === 'string'
    && Array.isArray(row.artifacts)
    && Array.isArray(row.traces);
}

/**
 * Cross-run-stable semantic digest of a WorkplaceProductionSnapshot.
 * Strips ALL run-specific provenance (artifactIds, traceIds, sourceId,
 * targetId, workplaceRef, execution refs, operations, status). Two runs
 * producing the same artifact content and trace structure yield the same
 * digest, enabling downstream replay identity (CONVEYOR v4.3 §6).
 */
export function workplaceProductionSemanticDigest(
  snapshot: WorkplaceProductionSnapshot,
): string {
  const artifacts = snapshot.artifacts
    .map(a => ({ type: a.artifactType, hash: a.contentHash }))
    .sort((a, b) =>
      a.hash < b.hash ? -1 : a.hash > b.hash ? 1
        : a.type < b.type ? -1 : a.type > b.type ? 1 : 0,
    );
  const traceCounts: Record<string, number> = {};
  for (const t of snapshot.traces) {
    const key = `${t.linkType}:${t.targetType}`;
    traceCounts[key] = (traceCounts[key] ?? 0) + 1;
  }
  const traces = Object.entries(traceCounts)
    .map(([key, count]) => ({ structure: key, count }))
    .sort((a, b) => a.structure < b.structure ? -1 : 1);
  return sha256Hex({
    schema: snapshot.schemaVersion,
    expectedSchemaRef: snapshot.expectedSchemaRef,
    artifacts,
    traces,
  });
}
