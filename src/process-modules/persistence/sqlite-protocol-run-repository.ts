/**
 * W4-A1 (SQL OWNER) — SQLite implementation of ProtocolRunRepository.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md §2.
 * Task: docs/refactor-management/05-subagent-tasks/W04-a1.md.
 *
 * W4-A1 is the SINGLE SQL owner this wave for the two new tables
 * (`factory_protocol_runs` + `factory_protocol_step_runs`). The schema DDL below is
 * SPEC §2 VERBATIM (additive, idempotent `CREATE TABLE IF NOT EXISTS`). The
 * dual-placement lives in `src/db.ts` (upgrade path for pre-existing DBs,
 * guarded on `tableExists('factory_process_runs')`) AND here in
 * `ensureFactoryProtocolRunSchema` (the path that reliably runs when the tables
 * spring into existence via the constructor) — mirroring the Wave 2/3 pattern
 * (spec §2 "Dual-placement in db.ts (guarded tableExists) +
 * ensureFactoryProtocolRunSchema(db)").
 *
 * Invariants enforced in SQL and respected by the adapter:
 *   - at most one ACTIVE protocol per (process_run_id, node_protocol_id)
 *     (partial UNIQUE index `idx_factory_protocol_runs_active`);
 *   - one immutable step row per (protocol_run_id, step_id, attempt)
 *     (UNIQUE constraint on `factory_protocol_step_runs`);
 *   - status transitions respect the SQL CHECK enums;
 *   - completing a step requires a non-empty evidence blob (the runtime must
 *     have verified required evidence first — spec §8.4 / C026).
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type {
  AdvanceStepInput,
  CompleteStepInput,
  ProtocolRunRecord,
  ProtocolRunRepository,
  ProtocolRunStatus,
  ProtocolStepRunRecord,
  ProtocolStepRunStatus,
  StartProtocolInput,
} from './protocol-run.js';

// ---------------------------------------------------------------------------
// Schema (spec §2 verbatim). W4-A1 is the single SQL owner.
// ---------------------------------------------------------------------------

/**
 * Create the two Wave 4 tables if they do not yet exist. Idempotent
 * (`CREATE TABLE IF NOT EXISTS` + `CREATE ... INDEX IF NOT EXISTS`). Safe to
 * call from the adapter constructor (fresh-DB path) and from `src/db.ts`
 * (upgrade path) — the second call is a no-op.
 */
export function ensureFactoryProtocolRunSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_protocol_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE CASCADE,
      node_run_id INTEGER REFERENCES factory_node_runs(id) ON DELETE CASCADE,
      node_protocol_id TEXT NOT NULL,
      node_protocol_version TEXT NOT NULL,
      entry_step TEXT NOT NULL,
      current_step TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','failed','abandoned')),
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_protocol_runs_active
      ON factory_protocol_runs(process_run_id, node_protocol_id) WHERE status='active';

    CREATE TABLE IF NOT EXISTS factory_protocol_step_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol_run_id INTEGER NOT NULL REFERENCES factory_protocol_runs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','skipped','failed')),
      evidence_json TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(protocol_run_id, step_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_factory_protocol_step_runs_protocol
      ON factory_protocol_step_runs(protocol_run_id, attempt, id);
  `);
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case ↔ camelCase mapping).
// ---------------------------------------------------------------------------

interface ProtocolRunRow {
  id: number;
  process_run_id: number;
  node_run_id: number | null;
  node_protocol_id: string;
  node_protocol_version: string;
  entry_step: string;
  current_step: string | null;
  status: ProtocolRunStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ProtocolStepRunRow {
  id: number;
  protocol_run_id: number;
  step_id: string;
  attempt: number;
  status: ProtocolStepRunStatus;
  evidence_json: string | null;
  completed_at: string | null;
  created_at: string;
}

function rowToProtocolRun(row: ProtocolRunRow): ProtocolRunRecord {
  return {
    id: row.id,
    processRunId: row.process_run_id,
    nodeRunId: row.node_run_id,
    nodeProtocolId: row.node_protocol_id,
    nodeProtocolVersion: row.node_protocol_version,
    entryStep: row.entry_step,
    currentStep: row.current_step,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * ADR-079 — the (process_run, node_protocol, status) reader. 'active' is
 * uniqueness-enforced by the partial unique index, but 'paused' is NOT; a
 * duplicate row under either predicate is an invariant violation and must
 * fail closed — never silently resolve to the newest row.
 */
function readSingleProtocolRun(
  db: Database.Database,
  processRunId: number,
  nodeProtocolId: string,
  status: 'active' | 'paused',
): ProtocolRunRow | null {
  const rows = db.prepare(
    `SELECT * FROM factory_protocol_runs
      WHERE process_run_id=? AND node_protocol_id=? AND status=?`,
  ).all(processRunId, nodeProtocolId, status) as ProtocolRunRow[];
  if (rows.length > 1) {
    throw new Error(
      `PROTOCOL_RUN_PREDICATE_NOT_UNIQUE: ${processRunId}/${nodeProtocolId}/${status} has ${rows.length} rows`,
    );
  }
  return rows[0] ?? null;
}

function rowToStepRun(row: ProtocolStepRunRow): ProtocolStepRunRecord {
  return {
    id: row.id,
    protocolRunId: row.protocol_run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    status: row.status,
    evidenceJson: row.evidence_json,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function readProtocolRunRow(
  db: Database.Database,
  id: number,
): ProtocolRunRow | null {
  const row = db.prepare(
    'SELECT * FROM factory_protocol_runs WHERE id=?',
  ).get(id) as ProtocolRunRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

function assertPositiveInt(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `PROTOCOL_${field.toUpperCase()}_INVALID: ${field} must be a positive integer`,
    );
  }
}

function assertNonEmptyTrimmedString(
  value: unknown,
  field: string,
): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || (value as string).trim() !== value
  ) {
    throw new Error(
      `PROTOCOL_${field.toUpperCase()}_INVALID: ${field} must be a non-empty trimmed string`,
    );
  }
}

function assertStartInput(input: StartProtocolInput): void {
  assertPositiveInt(input.processRunId, 'processRunId');
  assertNonEmptyTrimmedString(input.nodeProtocolId, 'nodeProtocolId');
  assertNonEmptyTrimmedString(input.nodeProtocolVersion, 'nodeProtocolVersion');
  assertNonEmptyTrimmedString(input.entryStep, 'entryStep');
  if (input.nodeRunId !== null && input.nodeRunId !== undefined) {
    assertPositiveInt(input.nodeRunId, 'nodeRunId');
  }
  if (input.currentStep !== undefined) {
    assertNonEmptyTrimmedString(input.currentStep, 'currentStep');
  }
  if (input.attempt !== undefined) {
    assertPositiveInt(input.attempt, 'attempt');
  }
}

function assertAdvanceInput(input: AdvanceStepInput): void {
  assertPositiveInt(input.protocolRunId, 'protocolRunId');
  assertNonEmptyTrimmedString(input.stepId, 'stepId');
  if (input.attempt !== undefined) {
    assertPositiveInt(input.attempt, 'attempt');
  }
}

function assertCompleteInput(input: CompleteStepInput): void {
  assertPositiveInt(input.protocolRunId, 'protocolRunId');
  assertNonEmptyTrimmedString(input.stepId, 'stepId');
  if (input.attempt !== undefined) {
    assertPositiveInt(input.attempt, 'attempt');
  }
  // Completing a step REQUIRES verified evidence (spec §8.4 / C026 — required
  // evidence cannot be skipped). The runtime is responsible for verifying it;
  // the repository rejects an empty blob so a no-op completion is impossible.
  if (typeof input.evidenceJson !== 'string' || input.evidenceJson.length === 0) {
    throw new Error(
      'PROTOCOL_EVIDENCE_REQUIRED: completeStep requires a non-empty evidenceJson blob (spec §8.4 / C026)',
    );
  }
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class SqliteProtocolRunRepository implements ProtocolRunRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryProtocolRunSchema(this.db);
  }

  startProtocol(input: StartProtocolInput): ProtocolRunRecord {
    assertStartInput(input);
    const run = (): ProtocolRunRecord => {
      const currentStep = input.currentStep ?? input.entryStep;
      const attempt = input.attempt ?? 1;
      const info = this.db.prepare(
        `INSERT INTO factory_protocol_runs
           (process_run_id, node_run_id, node_protocol_id, node_protocol_version,
            entry_step, current_step, status, attempt)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        input.processRunId,
        input.nodeRunId ?? null,
        input.nodeProtocolId,
        input.nodeProtocolVersion,
        input.entryStep,
        currentStep,
        attempt,
      );
      const row = readProtocolRunRow(this.db, Number(info.lastInsertRowid));
      if (!row) {
        throw new Error(
          'PROTOCOL_RUN_CREATE_FAILED: row vanished after insert',
        );
      }
      return rowToProtocolRun(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  advanceStep(input: AdvanceStepInput): ProtocolRunRecord {
    assertAdvanceInput(input);
    const run = (): ProtocolRunRecord => {
      const protocol = this.db.prepare(
        `SELECT * FROM factory_protocol_runs WHERE id=?`,
      ).get(input.protocolRunId) as ProtocolRunRow | undefined;
      if (!protocol) {
        throw new Error(
          `PROTOCOL_RUN_MISSING: no protocol run with id ${input.protocolRunId}`,
        );
      }
      if (protocol.status !== 'active' && protocol.status !== 'paused') {
        throw new Error(
          `PROTOCOL_RUN_NOT_ADVANCEABLE: protocol ${input.protocolRunId} status is '${protocol.status}' (only active/paused may advance)`,
        );
      }

      // Resolve the attempt: explicit, else reuse the open (pending/in_progress)
      // attempt if one exists, else start a fresh attempt (max + 1, or 1 when no
      // prior rows). A completed/skipped/failed attempt must NOT be reused — the
      // caller re-opens a closed step by passing a higher attempt (repeat/retry).
      let attempt = input.attempt;
      if (attempt === undefined) {
        const maxRow = this.db.prepare(
          `SELECT MAX(attempt) AS max_attempt
             FROM factory_protocol_step_runs
            WHERE protocol_run_id=? AND step_id=?`,
        ).get(input.protocolRunId, input.stepId) as
          | { max_attempt: number | null }
          | undefined;
        const maxAttempt = maxRow?.max_attempt ?? 0;
        let reuseAttempt = maxAttempt;
        if (maxAttempt > 0) {
          const lastStep = this.db.prepare(
            `SELECT status FROM factory_protocol_step_runs
              WHERE protocol_run_id=? AND step_id=? AND attempt=?`,
          ).get(input.protocolRunId, input.stepId, maxAttempt) as
            | { status: ProtocolStepRunStatus }
            | undefined;
          if (
            !lastStep
            || (lastStep.status !== 'pending'
              && lastStep.status !== 'in_progress')
          ) {
            reuseAttempt = maxAttempt + 1;
          }
        } else {
          // No prior rows for this step — start at attempt 1.
          reuseAttempt = 1;
        }
        attempt = reuseAttempt;
      }

      // Upsert the step row to in_progress. INSERT ... ON CONFLICT handles the
      // (protocol_run_id, step_id, attempt) UNIQUE: a pending row flips to
      // in_progress; an in_progress row stays; a completed row cannot be
      // re-advanced at the same attempt (caller must pass a higher attempt).
      const stepInfo = this.db.prepare(
        `INSERT INTO factory_protocol_step_runs
           (protocol_run_id, step_id, attempt, status)
         VALUES (?, ?, ?, 'in_progress')
         ON CONFLICT(protocol_run_id, step_id, attempt) DO UPDATE SET
           status = CASE WHEN factory_protocol_step_runs.status IN ('pending','in_progress')
                        THEN 'in_progress'
                        ELSE factory_protocol_step_runs.status END`,
      ).run(input.protocolRunId, input.stepId, attempt);

      // If the upsert hit a terminal (completed/skipped/failed) row, it did not
      // flip it (CASE above keeps the old status). Detect that and throw — the
      // caller must use a fresh attempt to re-open a closed step.
      const stepRow = this.db.prepare(
        `SELECT status FROM factory_protocol_step_runs WHERE id=?`,
      ).get(Number(stepInfo.lastInsertRowid)) as
        | { status: ProtocolStepRunStatus }
        | undefined;
      if (stepRow && stepRow.status !== 'in_progress') {
        throw new Error(
          `PROTOCOL_STEP_ALREADY_CLOSED: step '${input.stepId}' attempt ${attempt} is '${stepRow.status}'; pass a higher attempt to re-open`,
        );
      }

      // Move the protocol cursor + touch updated_at. A paused protocol resumes
      // to active as it advances.
      const upd = this.db.prepare(
        `UPDATE factory_protocol_runs
            SET current_step=?, status='active', updated_at=datetime('now')
          WHERE id=?`,
      ).run(input.stepId, input.protocolRunId);
      if (upd.changes !== 1) {
        throw new Error(
          `PROTOCOL_RUN_CONCURRENT_TRANSITION: protocol ${input.protocolRunId} could not be advanced`,
        );
      }
      const row = readProtocolRunRow(this.db, input.protocolRunId);
      if (!row) {
        throw new Error(
          `PROTOCOL_RUN_MISSING: protocol ${input.protocolRunId} vanished after advance`,
        );
      }
      return rowToProtocolRun(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  completeStep(input: CompleteStepInput): ProtocolStepRunRecord {
    assertCompleteInput(input);
    const run = (): ProtocolStepRunRecord => {
      // Resolve attempt: explicit, else the latest in_progress/pending attempt.
      let attempt = input.attempt;
      if (attempt === undefined) {
        const row = this.db.prepare(
          `SELECT attempt FROM factory_protocol_step_runs
            WHERE protocol_run_id=? AND step_id=?
              AND status IN ('pending','in_progress')
            ORDER BY attempt DESC LIMIT 1`,
        ).get(input.protocolRunId, input.stepId) as
          | { attempt: number }
          | undefined;
        if (!row) {
          throw new Error(
            `PROTOCOL_STEP_NOT_OPEN: no pending/in_progress step '${input.stepId}' for protocol ${input.protocolRunId} to complete`,
          );
        }
        attempt = row.attempt;
      }

      const info = this.db.prepare(
        `UPDATE factory_protocol_step_runs
            SET status='completed',
                evidence_json=?,
                completed_at=datetime('now')
          WHERE protocol_run_id=? AND step_id=? AND attempt=?
            AND status IN ('pending','in_progress')`,
      ).run(
        input.evidenceJson,
        input.protocolRunId,
        input.stepId,
        attempt,
      );
      if (info.changes !== 1) {
        // Either the row does not exist, or it is already terminal.
        const existing = this.db.prepare(
          `SELECT status FROM factory_protocol_step_runs
            WHERE protocol_run_id=? AND step_id=? AND attempt=?`,
        ).get(input.protocolRunId, input.stepId, attempt) as
          | { status: ProtocolStepRunStatus }
          | undefined;
        if (!existing) {
          throw new Error(
            `PROTOCOL_STEP_MISSING: no step '${input.stepId}' attempt ${attempt} for protocol ${input.protocolRunId}`,
          );
        }
        throw new Error(
          `PROTOCOL_STEP_ALREADY_CLOSED: step '${input.stepId}' attempt ${attempt} is '${existing.status}'; cannot complete`,
        );
      }
      const stepRow = this.db.prepare(
        `SELECT * FROM factory_protocol_step_runs
          WHERE protocol_run_id=? AND step_id=? AND attempt=?`,
      ).get(input.protocolRunId, input.stepId, attempt) as ProtocolStepRunRow;
      return rowToStepRun(stepRow);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  readActiveProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null {
    assertPositiveInt(processRunId, 'processRunId');
    assertNonEmptyTrimmedString(nodeProtocolId, 'nodeProtocolId');
    const row = readSingleProtocolRun(this.db, processRunId, nodeProtocolId, 'active');
    return row ? rowToProtocolRun(row) : null;
  }

  readByExactStep(
    protocolRunId: number,
    stepId: string,
    attempt: number,
  ): ProtocolStepRunRecord | null {
    assertPositiveInt(protocolRunId, 'protocolRunId');
    assertNonEmptyTrimmedString(stepId, 'stepId');
    assertPositiveInt(attempt, 'attempt');
    const row = this.db.prepare(
      `SELECT * FROM factory_protocol_step_runs
        WHERE protocol_run_id=? AND step_id=? AND attempt=?
        LIMIT 1`,
    ).get(protocolRunId, stepId, attempt) as ProtocolStepRunRow | undefined;
    return row ? rowToStepRun(row) : null;
  }

  pauseProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null {
    assertPositiveInt(processRunId, 'processRunId');
    assertNonEmptyTrimmedString(nodeProtocolId, 'nodeProtocolId');
    const run = (): ProtocolRunRecord | null => {
      const active = readSingleProtocolRun(this.db, processRunId, nodeProtocolId, 'active');
      if (!active) return null;
      const info = this.db.prepare(
        `UPDATE factory_protocol_runs
            SET status='paused', updated_at=datetime('now')
          WHERE id=? AND status='active'`,
      ).run(active.id);
      if (info.changes !== 1) {
        throw new Error(
          `PROTOCOL_RUN_CONCURRENT_TRANSITION: protocol ${active.id} is no longer pausable`,
        );
      }
      const row = readProtocolRunRow(this.db, active.id);
      if (!row) {
        throw new Error(
          `PROTOCOL_RUN_MISSING: protocol ${active.id} vanished after pause`,
        );
      }
      return rowToProtocolRun(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  resumeProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null {
    assertPositiveInt(processRunId, 'processRunId');
    assertNonEmptyTrimmedString(nodeProtocolId, 'nodeProtocolId');
    const run = (): ProtocolRunRecord | null => {
      const paused = readSingleProtocolRun(this.db, processRunId, nodeProtocolId, 'paused');
      if (!paused) return null;
      const info = this.db.prepare(
        `UPDATE factory_protocol_runs
            SET status='active', updated_at=datetime('now')
          WHERE id=? AND status='paused'`,
      ).run(paused.id);
      if (info.changes !== 1) {
        throw new Error(
          `PROTOCOL_RUN_CONCURRENT_TRANSITION: protocol ${paused.id} is no longer resumable`,
        );
      }
      const row = readProtocolRunRow(this.db, paused.id);
      if (!row) {
        throw new Error(
          `PROTOCOL_RUN_MISSING: protocol ${paused.id} vanished after resume`,
        );
      }
      return rowToProtocolRun(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  listSteps(protocolRunId: number): readonly ProtocolStepRunRecord[] {
    assertPositiveInt(protocolRunId, 'protocolRunId');
    const rows = this.db.prepare(
      `SELECT * FROM factory_protocol_step_runs
        WHERE protocol_run_id=?
        ORDER BY attempt ASC, id ASC`,
    ).all(protocolRunId) as ProtocolStepRunRow[];
    return rows.map(rowToStepRun);
  }
}
