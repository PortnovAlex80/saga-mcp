import type {
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
} from './managed-production.js';

export const WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION =
  'factory.workplace-production-snapshot.v1' as const;

export interface WorkplaceProductionArtifactSnapshot {
  readonly artifactId: number;
  readonly artifactType: string;
  readonly artifactStatus: string;
  readonly contentHash: string;
  readonly operation: ManagedArtifactProductionRecord['operation'];
  readonly lastProducerExecutionRef: string;
}

export interface WorkplaceProductionTraceSnapshot {
  readonly traceId: number;
  readonly sourceId: number;
  readonly targetType: 'artifact' | 'task';
  readonly targetId: number;
  readonly linkType: string;
  readonly traceHash: string;
  readonly lastProducerExecutionRef: string;
}

/**
 * Immutable managed-production material presented by one Workplace.
 *
 * The snapshot deliberately separates the execution that presents/seals a
 * CandidateSet from the executions that physically contributed its members.
 * The persisted ProductRef of this value is the exact QC material identity.
 */
export interface WorkplaceProductionSnapshot {
  readonly schemaVersion: typeof WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION;
  readonly workplaceRef: string;
  readonly expectedSchemaRef: string;
  readonly presenterExecutionRef: string;
  readonly contributingExecutionRefs: readonly string[];
  readonly artifacts: readonly WorkplaceProductionArtifactSnapshot[];
  readonly traces: readonly WorkplaceProductionTraceSnapshot[];
}

export function buildWorkplaceProductionSnapshot(input: {
  workplaceRef: string;
  expectedSchemaRef: string;
  presenterExecutionRef: string;
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
      lastProducerExecutionRef: row.executionId,
    }));
  const traces = input.traces.map(row => ({
    traceId: row.traceId,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    linkType: row.linkType,
    traceHash: row.traceHash,
    lastProducerExecutionRef: row.executionId,
  }));
  const contributors = new Set<string>([input.presenterExecutionRef]);
  for (const row of artifacts) contributors.add(row.lastProducerExecutionRef);
  for (const row of traces) contributors.add(row.lastProducerExecutionRef);

  return {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: input.workplaceRef,
    expectedSchemaRef: input.expectedSchemaRef,
    presenterExecutionRef: input.presenterExecutionRef,
    contributingExecutionRefs: [...contributors].sort(),
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
    && typeof row.presenterExecutionRef === 'string'
    && Array.isArray(row.contributingExecutionRefs)
    && Array.isArray(row.artifacts)
    && Array.isArray(row.traces);
}
