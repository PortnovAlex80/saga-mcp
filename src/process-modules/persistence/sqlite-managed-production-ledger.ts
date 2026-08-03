/**
 * Machine-owned provenance for products created by managed worker executions.
 *
 * Workers keep using the ordinary artifact/trace tools. The server, however,
 * stamps every mutation made by a Process Module task with the immutable
 * ProcessRun/node/task/execution lineage. Module resolvers can therefore turn
 * an LM receipt into exact domain products without trusting worker-supplied
 * ids and without querying "latest artifact in epic".
 */

import type Database from 'better-sqlite3';
import type { Artifact, ArtifactTrace } from '../../types.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  ManagedArtifactProductionRecord,
  ManagedProductionLedger,
  ManagedTraceProductionRecord,
} from '../../modules/development/domain/development-kernel-ports.js';

// Wave 7 type-leak fix: the managed-production ledger INTERFACES now live as
// the canonical source of truth inside each module's *-kernel-ports.ts (the
// file above). This concrete SQLite adapter imports them and `implements` —
// infrastructure depends inward (dependency inversion), which is allowed by
// the dependency-direction rules. Re-exported here so existing imports of
// these types from the persistence path keep compiling.
export type {
  ManagedArtifactProductionRecord,
  ManagedExecutionProductQuery,
  ManagedProductionLedger,
  ManagedTraceProductionRecord,
} from '../../modules/development/domain/development-kernel-ports.js';

export interface ManagedExecutionProvenance {
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  processInputHash: string;
  intentId: number;
  taskId: number;
  executionId: string;
  projectId: number;
  epicId: number | null;
  artifactAcceptanceAuthority: 'worker' | 'kernel-gate';
}

interface ExecutionTaskRow {
  task_id: number;
  execution_project_id: number;
  execution_epic_id: number;
  execution_worker_id: string;
  execution_state: string;
  task_status: string;
  task_assigned_to: string | null;
  task_current_execution_id: string | null;
  task_metadata: string;
}

interface ProcessRunIdentityRow {
  project_id: number;
  epic_id: number | null;
  module_ref_key: string;
  input_hash: string;
}

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

export function ensureManagedProductionLedgerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_managed_artifact_productions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id  INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      module_ref      TEXT NOT NULL,
      node_id         TEXT NOT NULL,
      intent_id       INTEGER NOT NULL,
      task_id         INTEGER NOT NULL,
      execution_id    TEXT NOT NULL,
      artifact_id     INTEGER NOT NULL,
      artifact_type   TEXT NOT NULL,
      artifact_status TEXT NOT NULL,
      content_hash    TEXT,
      operation       TEXT NOT NULL CHECK (operation IN ('create','upsert','update')),
      recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_managed_artifact_product_exact
      ON saga3_managed_artifact_productions(
        process_run_id, node_id, execution_id, artifact_id, operation,
        artifact_status, COALESCE(content_hash, '')
      );

    CREATE INDEX IF NOT EXISTS idx_saga3_managed_artifact_product_execution
      ON saga3_managed_artifact_productions(
        process_run_id, module_ref, node_id, intent_id, task_id, execution_id
      );

    CREATE TABLE IF NOT EXISTS saga3_managed_trace_productions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id  INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      module_ref      TEXT NOT NULL,
      node_id         TEXT NOT NULL,
      intent_id       INTEGER NOT NULL,
      task_id         INTEGER NOT NULL,
      execution_id    TEXT NOT NULL,
      trace_id        INTEGER NOT NULL,
      source_id       INTEGER NOT NULL,
      target_type     TEXT NOT NULL CHECK (target_type IN ('artifact','task')),
      target_id       INTEGER NOT NULL,
      link_type       TEXT NOT NULL,
      trace_hash      TEXT NOT NULL,
      recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (process_run_id, node_id, execution_id, trace_id)
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_managed_trace_product_execution
      ON saga3_managed_trace_productions(
        process_run_id, module_ref, node_id, intent_id, task_id, execution_id
      );
  `);
}

function parseMetadata(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: ${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: ${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredInteger(
  metadata: Record<string, unknown>,
  key: string,
): number {
  const value = metadata[key];
  if (!Number.isInteger(value)) {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: task metadata.${key} must be an integer`);
  }
  return value as number;
}

function requiredString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: task metadata.${key} must be a string`);
  }
  return value;
}

/**
 * Resolve server-authored process provenance for the current managed child.
 * Legacy tasks have none of the process_* keys and deliberately return null.
 * A partial or inconsistent binding fails closed.
 */
export function resolveManagedExecutionProvenance(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
  options: { requireLiveProducer?: boolean } = {},
): ManagedExecutionProvenance | null {
  const marker = env.SAGA_MANAGED_EXECUTION;
  if (marker === undefined || marker === '0') return null;
  if (marker !== '1') {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: invalid SAGA_MANAGED_EXECUTION='${marker}'`);
  }
  const executionId = env.SAGA_EXECUTION_ID;
  if (!executionId) {
    throw new Error('MANAGED_PRODUCTION_CONTEXT_INVALID: SAGA_EXECUTION_ID is missing');
  }

  const execution = db.prepare(
    `SELECT we.task_id,
            we.project_id AS execution_project_id,
            we.epic_id AS execution_epic_id,
            we.worker_id AS execution_worker_id,
            we.state AS execution_state,
            t.status AS task_status,
            t.assigned_to AS task_assigned_to,
            t.current_execution_id AS task_current_execution_id,
            t.metadata AS task_metadata
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
      WHERE we.execution_id=?`,
  ).get(executionId) as ExecutionTaskRow | undefined;
  if (!execution) {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: execution '${executionId}' was not found`);
  }
  if (env.SAGA_TASK_ID !== undefined && String(execution.task_id) !== env.SAGA_TASK_ID) {
    throw new Error('MANAGED_PRODUCTION_CONTEXT_INVALID: execution/task environment mismatch');
  }
  if (options.requireLiveProducer && (
    execution.execution_state !== 'running'
    || execution.task_status !== 'in_progress'
    || execution.task_assigned_to !== execution.execution_worker_id
    || execution.task_current_execution_id !== executionId
  )) {
    throw new Error(
      'MANAGED_PRODUCTION_FENCE_VIOLATION: only the live producer execution '
      + 'owning an in_progress task may mutate managed products',
    );
  }

  const metadata = parseMetadata(execution.task_metadata, 'task metadata');
  const processKeys = [
    'process_run_id',
    'process_node_id',
    'process_module_ref',
    'process_input_hash',
  ] as const;
  const present = processKeys.filter((key) => metadata[key] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== processKeys.length) {
    throw new Error('MANAGED_PRODUCTION_CONTEXT_INVALID: process provenance binding is incomplete');
  }

  const processRunId = requiredInteger(metadata, 'process_run_id');
  const nodeId = requiredString(metadata, 'process_node_id');
  const moduleRef = requiredString(metadata, 'process_module_ref');
  const processInputHash = requiredString(metadata, 'process_input_hash');
  const intentId = requiredInteger(metadata, 'work_intent_id');
  const artifactAcceptanceAuthority =
    metadata.artifact_acceptance_authority ?? 'worker';
  if (
    artifactAcceptanceAuthority !== 'worker'
    && artifactAcceptanceAuthority !== 'kernel-gate'
  ) {
    throw new Error(
      'MANAGED_PRODUCTION_CONTEXT_INVALID: unsupported '
        + 'artifact_acceptance_authority',
    );
  }

  const run = db.prepare(
    `SELECT project_id, epic_id, module_ref_key, input_hash
       FROM saga3_process_runs
      WHERE id=?`,
  ).get(processRunId) as ProcessRunIdentityRow | undefined;
  if (!run) {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: ProcessRun ${processRunId} was not found`);
  }
  if (
    run.project_id !== execution.execution_project_id
    || run.epic_id !== execution.execution_epic_id
    || run.module_ref_key !== moduleRef
    || run.input_hash !== processInputHash
  ) {
    throw new Error('MANAGED_PRODUCTION_CONTEXT_INVALID: task provenance does not match ProcessRun');
  }

  return {
    processRunId,
    moduleRef,
    nodeId,
    processInputHash,
    intentId,
    taskId: execution.task_id,
    executionId,
    projectId: run.project_id,
    epicId: run.epic_id,
    artifactAcceptanceAuthority,
  };
}

export function assertManagedProductScope(
  provenance: ManagedExecutionProvenance,
  projectId: number,
  epicId: number,
): void {
  if (provenance.projectId !== projectId || provenance.epicId !== epicId) {
    throw new Error(
      `MANAGED_PRODUCTION_SCOPE_VIOLATION: product (${projectId},${epicId}) `
      + `does not belong to ProcessRun ${provenance.processRunId}`,
    );
  }
}

export function recordManagedArtifactProduction(
  db: Database.Database,
  artifact: Artifact,
  operation: ManagedArtifactProductionRecord['operation'],
): void {
  const provenance = resolveManagedExecutionProvenance(
    db,
    process.env,
    { requireLiveProducer: true },
  );
  if (!provenance) return;
  assertManagedProductScope(provenance, artifact.project_id, artifact.epic_id);
  ensureManagedProductionLedgerSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO saga3_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    provenance.processRunId,
    provenance.moduleRef,
    provenance.nodeId,
    provenance.intentId,
    provenance.taskId,
    provenance.executionId,
    artifact.id,
    artifact.type,
    artifact.status,
    artifact.content_hash,
    operation,
  );
}

export function recordManagedTraceProduction(
  db: Database.Database,
  trace: ArtifactTrace,
): void {
  const provenance = resolveManagedExecutionProvenance(
    db,
    process.env,
    { requireLiveProducer: true },
  );
  if (!provenance) return;
  const source = db.prepare(
    'SELECT project_id, epic_id FROM artifacts WHERE id=?',
  ).get(trace.source_id) as { project_id: number; epic_id: number } | undefined;
  if (!source) {
    throw new Error(`MANAGED_PRODUCTION_CONTEXT_INVALID: trace source ${trace.source_id} was not found`);
  }
  assertManagedProductScope(provenance, source.project_id, source.epic_id);
  ensureManagedProductionLedgerSchema(db);
  const traceHash = sha256Hex({
    sourceId: trace.source_id,
    targetType: trace.target_type,
    targetId: trace.target_id,
    linkType: trace.link_type,
  });
  db.prepare(
    `INSERT OR IGNORE INTO saga3_managed_trace_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        trace_id, source_id, target_type, target_id, link_type, trace_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    provenance.processRunId,
    provenance.moduleRef,
    provenance.nodeId,
    provenance.intentId,
    provenance.taskId,
    provenance.executionId,
    trace.id,
    trace.source_id,
    trace.target_type,
    trace.target_id,
    trace.link_type,
    traceHash,
  );
}

function artifactRowToRecord(row: ArtifactLedgerRow): ManagedArtifactProductionRecord {
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

function traceRowToRecord(row: TraceLedgerRow): ManagedTraceProductionRecord {
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

export class SqliteManagedProductionLedger implements ManagedProductionLedger {
  constructor(private readonly db: Database.Database) {
    ensureManagedProductionLedgerSchema(db);
  }

  // WAVE 6 CUTOVER: listArtifactsForExecution / listTracesForExecution were
  // REMOVED. They were the execution-scoped (intentId/taskId/executionId)
  // product-resolution fallback the exact-ProductRef cutover retires
  // (execution-context-assembler §9.11). The live product-resolution path is
  // listArtifactsForNodeInProcessRun / listTracesForNodeInProcessRun (durable
  // node-scope, CGAD P18) and ProcessProductRepository.getByProductRef. Re-
  // introducing an execution-scoped lookup is forbidden by
  // tests/architecture/no-execution-scoped-lookup.test.mjs. Out-of-zone tests
  // that still call these (managed-production-ledger.test.mjs,
  // characterization/package-identity-collision-replay.test.mjs) and the
  // infrastructure formalization adapter that delegates to them are tracked
  // cross-file breakage to be migrated by their owning lanes.

  listArtifactsForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedArtifactProductionRecord[] {
    const rows = this.db.prepare(
      `SELECT mp.*
         FROM saga3_managed_artifact_productions mp
        WHERE mp.process_run_id=? AND mp.module_ref=? AND mp.node_id=?
          AND mp.task_id=?
        ORDER BY mp.id`,
    ).all(processRunId, moduleRef, nodeId, taskId) as ArtifactLedgerRow[];
    return rows.map(artifactRowToRecord);
  }

  listTracesForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedTraceProductionRecord[] {
    const rows = this.db.prepare(
      `SELECT mp.*
         FROM saga3_managed_trace_productions mp
        WHERE mp.process_run_id=? AND mp.module_ref=? AND mp.node_id=?
          AND mp.task_id=?
        ORDER BY mp.id`,
    ).all(processRunId, moduleRef, nodeId, taskId) as TraceLedgerRow[];
    return rows.map(traceRowToRecord);
  }

  // W13-A4: listArtifactsForNodeInEpic / listTracesForNodeInEpic removed
  // (epic-scope "latest of kind" fallback, §9.11). No production callers; the
  // ExecutionContextAssembler resolves upstream products by exact ProductRef.

  listArtifactsForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedArtifactProductionRecord[] {
    const rows = this.db.prepare(
      `SELECT mp.*
         FROM saga3_managed_artifact_productions mp
        WHERE mp.process_run_id=? AND mp.module_ref=? AND mp.node_id=?
        ORDER BY mp.id`,
    ).all(processRunId, moduleRef, nodeId) as ArtifactLedgerRow[];
    return rows.map(artifactRowToRecord);
  }

  listTracesForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedTraceProductionRecord[] {
    const rows = this.db.prepare(
      `SELECT mp.*
         FROM saga3_managed_trace_productions mp
        WHERE mp.process_run_id=? AND mp.module_ref=? AND mp.node_id=?
        ORDER BY mp.id`,
    ).all(processRunId, moduleRef, nodeId) as TraceLedgerRow[];
    return rows.map(traceRowToRecord);
  }
}
