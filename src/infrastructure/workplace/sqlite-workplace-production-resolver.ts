import type Database from 'better-sqlite3';
import type { WorkplaceProductionResolver } from '../../process-modules/application/workplace-production-resolver.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import type {
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
} from '../../process-modules/shared/managed-production.js';

interface ArtifactLedgerRow {
  id: number;
  process_run_id: number;
  module_ref: string;
  node_id: string;
  intent_id: number;
  task_id: number;
  execution_id: string;
  artifact_id: number;
  artifact_type: string;
  artifact_status: string;
  content_hash: string | null;
  operation: 'create' | 'upsert' | 'update';
  recorded_at: string;
}

interface TraceLedgerRow {
  id: number;
  process_run_id: number;
  module_ref: string;
  node_id: string;
  intent_id: number;
  task_id: number;
  execution_id: string;
  trace_id: number;
  source_id: number;
  target_type: 'artifact' | 'task';
  target_id: number;
  link_type: string;
  trace_hash: string;
  recorded_at: string;
}

function artifactRecord(row: ArtifactLedgerRow): ManagedArtifactProductionRecord {
  return {
    ledgerId: row.id,
    processRunId: row.process_run_id,
    moduleRef: row.module_ref,
    nodeId: row.node_id,
    intentId: row.intent_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    artifactId: row.artifact_id,
    artifactType: row.artifact_type,
    artifactStatus: row.artifact_status,
    contentHash: row.content_hash,
    operation: row.operation,
    recordedAt: row.recorded_at,
  };
}

function traceRecord(row: TraceLedgerRow): ManagedTraceProductionRecord {
  return {
    ledgerId: row.id,
    processRunId: row.process_run_id,
    moduleRef: row.module_ref,
    nodeId: row.node_id,
    intentId: row.intent_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    traceId: row.trace_id,
    sourceId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    linkType: row.link_type,
    traceHash: row.trace_hash,
    recordedAt: row.recorded_at,
  };
}

function latestBy<T>(
  rows: readonly T[],
  key: (row: T) => number,
  ledgerId: (row: T) => number,
): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) {
    const id = key(row);
    const current = latest.get(id);
    if (!current || ledgerId(row) > ledgerId(current)) latest.set(id, row);
  }
  return [...latest.values()].sort((a, b) => ledgerId(a) - ledgerId(b));
}

/**
 * SQLite implementation of the durable Workplace desk read.
 *
 * The ledger itself records physical task/execution provenance. Ownership is
 * resolved by joining those rows to the server-authored tasks.workplace_ref.
 * This is the critical fan-out boundary: sibling Workplaces under the same
 * ProcessRun/module/node have different workplace_ref values and therefore
 * cannot leak products into each other.
 */
export class SqliteWorkplaceProductionResolver implements WorkplaceProductionResolver {
  constructor(private readonly db: Database.Database) {}

  read(workplaceRef: WorkplaceRef) {
    const serialized = serializeWorkplaceRef(workplaceRef);
    const artifactRows = this.db.prepare(
      `SELECT mp.*
         FROM factory_managed_artifact_productions mp
         JOIN tasks t ON t.id=mp.task_id
        WHERE t.workplace_ref=?
          AND mp.process_run_id=?
          AND mp.module_ref=?
        ORDER BY mp.id`,
    ).all(
      serialized,
      workplaceRef.processRunId,
      workplaceRef.moduleRef,
    ) as ArtifactLedgerRow[];
    const traceRows = this.db.prepare(
      `SELECT mp.*
         FROM factory_managed_trace_productions mp
         JOIN tasks t ON t.id=mp.task_id
        WHERE t.workplace_ref=?
          AND mp.process_run_id=?
          AND mp.module_ref=?
        ORDER BY mp.id`,
    ).all(
      serialized,
      workplaceRef.processRunId,
      workplaceRef.moduleRef,
    ) as TraceLedgerRow[];

    return {
      artifacts: latestBy(
        artifactRows.map(artifactRecord),
        row => row.artifactId,
        row => row.ledgerId,
      ),
      traces: latestBy(
        traceRows.map(traceRecord),
        row => row.traceId,
        row => row.ledgerId,
      ),
    };
  }
}
