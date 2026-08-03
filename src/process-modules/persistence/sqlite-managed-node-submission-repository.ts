import type Database from 'better-sqlite3';
import type {
  ManagedNodeSubmissionQuery,
  ManagedNodeSubmissionReader,
  ManagedNodeSubmissionRecord,
} from '../application/managed-node-submission.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import {
  resolveManagedExecutionProvenance,
} from './sqlite-managed-production-ledger.js';
import { ensureSaga3ProcessRunSchema } from './sqlite-process-run-repository.js';

interface SubmissionRow {
  id: number;
  process_run_id: number;
  module_ref: string;
  node_id: string;
  intent_id: number;
  task_id: number;
  execution_id: string;
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  submitted_at: string;
}

interface LiveFenceRow {
  current_execution_id: string | null;
  execution_state: string;
  process_status: string;
}

export interface SubmitManagedNodeProductCommand {
  schema: string;
  payload: unknown;
}

export interface SubmitManagedNodeProductResult {
  record: ManagedNodeSubmissionRecord;
  replayed: boolean;
}

export function ensureManagedNodeSubmissionSchema(
  db: Database.Database,
): void {
  ensureSaga3ProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_managed_node_submissions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id   INTEGER NOT NULL
                         REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      module_ref       TEXT NOT NULL,
      node_id          TEXT NOT NULL,
      intent_id        INTEGER NOT NULL,
      task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      execution_id     TEXT NOT NULL
                         REFERENCES worker_executions(execution_id) ON DELETE RESTRICT,
      schema_version   TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      submitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (process_run_id, node_id, execution_id)
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_managed_node_submission_exact
      ON saga3_managed_node_submissions(
        process_run_id,module_ref,node_id,intent_id,task_id,execution_id
      );

    CREATE TRIGGER IF NOT EXISTS trg_saga3_managed_node_submissions_no_update
    BEFORE UPDATE ON saga3_managed_node_submissions
    BEGIN
      SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_managed_node_submissions_no_delete
    BEFORE DELETE ON saga3_managed_node_submissions
    BEGIN
      SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_DELETE_FORBIDDEN');
    END;
  `);
}

/**
 * SQLite implementation of the module-agnostic LM → kernel submission
 * boundary. One worker execution gets one immutable value. Equal retries are
 * idempotent; a different second value requires a fresh fenced execution.
 */
export class SqliteManagedNodeSubmissionRepository
implements ManagedNodeSubmissionReader {
  constructor(private readonly db: Database.Database) {
    ensureManagedNodeSubmissionSchema(db);
  }

  submitForCurrentExecution(
    command: SubmitManagedNodeProductCommand,
    env: NodeJS.ProcessEnv = process.env,
  ): SubmitManagedNodeProductResult {
    const schema = command.schema.trim();
    if (!schema) {
      throw new Error('MANAGED_NODE_SUBMISSION_SCHEMA_REQUIRED');
    }
    if (command.payload === undefined) {
      throw new Error('MANAGED_NODE_SUBMISSION_PAYLOAD_REQUIRED');
    }
    const payloadSnapshot = canonicalSnapshot(command.payload);
    const contentHash = sha256Hex(command.payload);

    const write = this.db.transaction(() => {
      const provenance = resolveManagedExecutionProvenance(this.db, env);
      if (provenance === null) {
        throw new Error(
          'MANAGED_NODE_SUBMISSION_REQUIRES_MANAGED_EXECUTION',
        );
      }
      this.assertLiveFence(
        provenance.processRunId,
        provenance.taskId,
        provenance.executionId,
      );

      const query: ManagedNodeSubmissionQuery = {
        processRunId: provenance.processRunId,
        moduleRef: provenance.moduleRef,
        nodeId: provenance.nodeId,
        intentId: provenance.intentId,
        taskId: provenance.taskId,
        executionId: provenance.executionId,
      };
      const existing = this.readExactRow(query);
      if (existing) {
        if (
          existing.schema_version !== schema
          || existing.payload_snapshot !== payloadSnapshot
          || existing.content_hash !== contentHash
        ) {
          throw new Error(
            'MANAGED_NODE_SUBMISSION_ALREADY_FINAL: this execution already '
            + 'submitted a different typed payload; start a fresh execution',
          );
        }
        return { record: rowToRecord(existing), replayed: true };
      }

      this.db.prepare(
        `INSERT INTO saga3_managed_node_submissions
          (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
           schema_version,payload_snapshot,content_hash)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        query.processRunId,
        query.moduleRef,
        query.nodeId,
        query.intentId,
        query.taskId,
        query.executionId,
        schema,
        payloadSnapshot,
        contentHash,
      );
      const inserted = this.readExactRow(query);
      if (!inserted) {
        throw new Error('MANAGED_NODE_SUBMISSION_VANISHED_AFTER_INSERT');
      }
      return { record: rowToRecord(inserted), replayed: false };
    });

    return write.immediate();
  }

  readExact(
    query: ManagedNodeSubmissionQuery,
  ): ManagedNodeSubmissionRecord | null {
    const row = this.readExactRow(query);
    return row ? rowToRecord(row) : null;
  }

  readLatestForTask(
    query: Omit<ManagedNodeSubmissionQuery, 'intentId' | 'executionId'>,
  ): ManagedNodeSubmissionRecord | null {
    const row = this.db.prepare(
      `SELECT *
         FROM saga3_managed_node_submissions
        WHERE process_run_id=? AND module_ref=? AND node_id=? AND task_id=?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(
      query.processRunId,
      query.moduleRef,
      query.nodeId,
      query.taskId,
    ) as SubmissionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readLatestForNode(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): ManagedNodeSubmissionRecord | null {
    // CGAD P18 — durable node-scope read: the workplace's product, independent
    // of which worker (task) produced it. This never blinds a gate to a prior
    // worker's submission.
    const row = this.db.prepare(
      `SELECT *
         FROM saga3_managed_node_submissions
        WHERE process_run_id=? AND module_ref=? AND node_id=?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(processRunId, moduleRef, nodeId) as SubmissionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  private readExactRow(
    query: ManagedNodeSubmissionQuery,
  ): SubmissionRow | undefined {
    return this.db.prepare(
      `SELECT *
         FROM saga3_managed_node_submissions
        WHERE process_run_id=? AND module_ref=? AND node_id=?
          AND intent_id=? AND task_id=? AND execution_id=?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(
      query.processRunId,
      query.moduleRef,
      query.nodeId,
      query.intentId,
      query.taskId,
      query.executionId,
    ) as SubmissionRow | undefined;
  }

  private assertLiveFence(
    processRunId: number,
    taskId: number,
    executionId: string,
  ): void {
    const row = this.db.prepare(
      `SELECT t.current_execution_id,
              we.state AS execution_state,
              pr.status AS process_status
         FROM tasks t
         JOIN worker_executions we
           ON we.task_id=t.id AND we.execution_id=?
         JOIN saga3_process_runs pr ON pr.id=?
        WHERE t.id=?`,
    ).get(
      executionId,
      processRunId,
      taskId,
    ) as LiveFenceRow | undefined;
    if (!row) {
      throw new Error('MANAGED_NODE_SUBMISSION_FENCE_INVALID');
    }
    if (row.current_execution_id !== executionId) {
      throw new Error(
        'MANAGED_NODE_SUBMISSION_FENCE_LOST: task is not owned by this execution',
      );
    }
    if (row.execution_state !== 'running') {
      throw new Error(
        `MANAGED_NODE_SUBMISSION_EXECUTION_NOT_RUNNING: ${row.execution_state}`,
      );
    }
    if (row.process_status !== 'running') {
      throw new Error(
        `MANAGED_NODE_SUBMISSION_PROCESS_NOT_RUNNING: ${row.process_status}`,
      );
    }
  }
}

function canonicalSnapshot(payload: unknown): string {
  const snapshot = canonicalJson(payload);
  if (typeof snapshot !== 'string') {
    throw new Error('MANAGED_NODE_SUBMISSION_PAYLOAD_NOT_JSON');
  }
  try {
    JSON.parse(snapshot);
  } catch {
    throw new Error('MANAGED_NODE_SUBMISSION_PAYLOAD_NOT_JSON');
  }
  return snapshot;
}

function rowToRecord(row: SubmissionRow): ManagedNodeSubmissionRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_snapshot);
  } catch {
    throw new Error(
      `MANAGED_NODE_SUBMISSION_CORRUPT: row ${row.id} payload is invalid JSON`,
    );
  }
  if (
    canonicalJson(payload) !== row.payload_snapshot
    || sha256Hex(payload) !== row.content_hash
  ) {
    throw new Error(
      `MANAGED_NODE_SUBMISSION_CORRUPT: row ${row.id} hash mismatch`,
    );
  }
  return {
    submissionId: row.id,
    processRunId: row.process_run_id,
    moduleRef: row.module_ref,
    nodeId: row.node_id,
    intentId: row.intent_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    schema: row.schema_version,
    payload,
    contentHash: row.content_hash,
    artifactRef: `managed-node-submission:${row.id}`,
    submittedAt: row.submitted_at,
  };
}
