/**
 * W5-A2 (SQL OWNER) — SQLite implementation of CallInstanceRepository.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md §2.
 * Task: docs/refactor-management/05-subagent-tasks/W05-a2.md.
 *
 * W5-A2 is the SINGLE SQL owner this wave for the new
 * `factory_call_instances` table. The schema DDL below is SPEC §2 VERBATIM
 * (additive, idempotent `CREATE TABLE IF NOT EXISTS`). The dual-placement
 * lives in `src/db.ts` (upgrade path for pre-existing DBs, guarded on
 * `tableExists('factory_process_runs')`) AND here in
 * `ensureFactoryCallInstanceSchema` (the path that reliably runs when the table
 * springs into existence via the constructor) — mirroring the Wave 2/3/4
 * pattern (spec §2 "Dual-placement in db.ts").
 *
 * Invariants enforced in SQL and respected by the adapter:
 *   - one row per (process_run, step, tool_contract, attempt);
 *   - status transitions respect the SQL CHECK enum
 *     (materialized/edited/validated/submitted/succeeded/failed/sealed/abandoned);
 *   - every status mutation is a guarded `UPDATE ... WHERE id=? AND status IN
 *     (...)` so a racy/concurrent write is a clean no-op (changes==0) reported
 *     as a state-machine violation, never a silent overwrite;
 *   - `sealCall` requires a non-empty `successful_receipt_ref` (C030 — seal
 *     attaches the EXACT receipt, no empty ref);
 *   - failed drafts keep their `draft_content_hash` (C029 — preserved for
 *     progressive correction; `retryCall` re-opens the SAME row to 'edited').
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type {
  CallInstanceRecord,
  CallInstanceRepository,
  CallInstanceStatus,
  CreateCallInstanceInput,
  FailCallInput,
  UpdateDraftInput,
} from './call-instance.js';
import { CALL_INSTANCE_TRANSITIONS } from './call-instance.js';

// ---------------------------------------------------------------------------
// Schema (spec §2 verbatim). W5-A2 is the single SQL owner.
// ---------------------------------------------------------------------------

/**
 * Create the Wave 5 `factory_call_instances` table if it does not yet exist.
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
 * Safe to call from the adapter constructor (fresh-DB path) and from
 * `src/db.ts` (upgrade path) — the second call is a no-op.
 */
export function ensureFactoryCallInstanceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_call_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE CASCADE,
      protocol_run_id INTEGER REFERENCES factory_protocol_runs(id) ON DELETE CASCADE,
      step_id TEXT,
      tool_contract_ref TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      workspace_path TEXT,
      draft_content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'materialized' CHECK (status IN ('materialized','edited','validated','submitted','succeeded','failed','sealed','abandoned')),
      last_error_json TEXT,
      successful_receipt_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sealed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_factory_call_instances_step
      ON factory_call_instances(process_run_id, step_id, tool_contract_ref, attempt, id);
  `);
}

// ---------------------------------------------------------------------------
// Row shape (snake_case ↔ camelCase mapping).
// ---------------------------------------------------------------------------

interface CallInstanceRow {
  id: number;
  process_run_id: number;
  protocol_run_id: number | null;
  step_id: string | null;
  tool_contract_ref: string;
  attempt: number;
  workspace_path: string | null;
  draft_content_hash: string | null;
  status: CallInstanceStatus;
  last_error_json: string | null;
  successful_receipt_ref: string | null;
  created_at: string;
  updated_at: string;
  sealed_at: string | null;
}

function rowToCallInstance(row: CallInstanceRow): CallInstanceRecord {
  return {
    id: row.id,
    processRunId: row.process_run_id,
    protocolRunId: row.protocol_run_id,
    stepId: row.step_id,
    toolContractRef: row.tool_contract_ref,
    attempt: row.attempt,
    workspacePath: row.workspace_path,
    draftContentHash: row.draft_content_hash,
    status: row.status,
    lastErrorJson: row.last_error_json,
    successfulReceiptRef: row.successful_receipt_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at,
  };
}

function readCallInstanceRow(
  db: Database.Database,
  id: number,
): CallInstanceRow | null {
  const row = db.prepare(
    'SELECT * FROM factory_call_instances WHERE id=?',
  ).get(id) as CallInstanceRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

function assertPositiveInt(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `CALL_${field.toUpperCase()}_INVALID: ${field} must be a positive integer`,
    );
  }
}

function assertNonEmptyTrimmedString(value: unknown, field: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || (value as string).trim() !== value
  ) {
    throw new Error(
      `CALL_${field.toUpperCase()}_INVALID: ${field} must be a non-empty trimmed string`,
    );
  }
}

function assertCreateInput(input: CreateCallInstanceInput): void {
  assertPositiveInt(input.processRunId, 'processRunId');
  assertNonEmptyTrimmedString(input.toolContractRef, 'toolContractRef');
  if (input.protocolRunId !== null && input.protocolRunId !== undefined) {
    assertPositiveInt(input.protocolRunId, 'protocolRunId');
  }
  if (input.stepId !== null && input.stepId !== undefined) {
    assertNonEmptyTrimmedString(input.stepId, 'stepId');
  }
  if (input.attempt !== undefined) {
    assertPositiveInt(input.attempt, 'attempt');
  }
  if (
    input.draftContentHash !== null
    && input.draftContentHash !== undefined
  ) {
    assertNonEmptyTrimmedString(input.draftContentHash, 'draftContentHash');
  }
}

function assertUpdateDraftInput(input: UpdateDraftInput): void {
  assertPositiveInt(input.callInstanceId, 'callInstanceId');
  assertNonEmptyTrimmedString(input.draftContentHash, 'draftContentHash');
}

function assertFailInput(input: FailCallInput): void {
  assertPositiveInt(input.callInstanceId, 'callInstanceId');
  // last_error_json must be a non-empty string so a no-op failure is
  // impossible (the runtime MUST record a structured reason).
  if (typeof input.lastErrorJson !== 'string' || input.lastErrorJson.length === 0) {
    throw new Error(
      'CALL_LAST_ERROR_REQUIRED: failCall requires a non-empty lastErrorJson blob',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared: guarded status transition.
// ---------------------------------------------------------------------------

/**
 * Run a guarded `UPDATE ... SET <setClause> WHERE id=? AND status IN (...)`
 * transition. If the row is missing → CALL_INSTANCE_MISSING. If the row exists
 * but is not in the legal FROM-set → CALL_INSTANCE_INVALID_TRANSITION naming
 * the current status. Otherwise returns the updated row.
 *
 * The caller supplies the SET clause (column updates; `updated_at` is touched
 * here) and the bind params for the placeholders INSIDE the SET clause. The
 * bind order is: SET binds first, then id, then the status whitelist.
 */
function guardedTransition(
  db: Database.Database,
  mutator: keyof typeof CALL_INSTANCE_TRANSITIONS,
  callInstanceId: number,
  setClause: string,
  binds: readonly unknown[],
): CallInstanceRow {
  const allowedFrom = CALL_INSTANCE_TRANSITIONS[mutator];
  const placeholders = allowedFrom.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE factory_call_instances
        SET ${setClause}, updated_at=datetime('now')
      WHERE id=? AND status IN (${placeholders})`,
  ).run(...binds, callInstanceId, ...allowedFrom);
  if (info.changes !== 1) {
    const existing = db.prepare(
      'SELECT status FROM factory_call_instances WHERE id=?',
    ).get(callInstanceId) as { status: CallInstanceStatus } | undefined;
    if (!existing) {
      throw new Error(
        `CALL_INSTANCE_MISSING: no call instance with id ${callInstanceId}`,
      );
    }
    throw new Error(
      `CALL_INSTANCE_INVALID_TRANSITION: ${mutator} requires status in [${allowedFrom.join(',')}], got '${existing.status}' for call ${callInstanceId}`,
    );
  }
  const row = readCallInstanceRow(db, callInstanceId);
  if (!row) {
    throw new Error(
      `CALL_INSTANCE_MISSING: call ${callInstanceId} vanished after ${mutator}`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class SqliteCallInstanceRepository implements CallInstanceRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryCallInstanceSchema(this.db);
  }

  createCallInstance(input: CreateCallInstanceInput): CallInstanceRecord {
    assertCreateInput(input);
    const run = (): CallInstanceRecord => {
      const attempt = input.attempt ?? 1;
      const info = this.db.prepare(
        `INSERT INTO factory_call_instances
           (process_run_id, protocol_run_id, step_id, tool_contract_ref,
            attempt, workspace_path, draft_content_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'materialized')`,
      ).run(
        input.processRunId,
        input.protocolRunId ?? null,
        input.stepId ?? null,
        input.toolContractRef,
        attempt,
        input.workspacePath ?? null,
        input.draftContentHash ?? null,
      );
      const row = readCallInstanceRow(this.db, Number(info.lastInsertRowid));
      if (!row) {
        throw new Error(
          'CALL_INSTANCE_CREATE_FAILED: row vanished after insert',
        );
      }
      return rowToCallInstance(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  updateDraft(input: UpdateDraftInput): CallInstanceRecord {
    assertUpdateDraftInput(input);
    const run = (): CallInstanceRecord => {
      const row = guardedTransition(
        this.db,
        'updateDraft',
        input.callInstanceId,
        'draft_content_hash=?, status=\'edited\'',
        [input.draftContentHash],
      );
      return rowToCallInstance(row);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  validateCall(callInstanceId: number): CallInstanceRecord {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    const run = (): CallInstanceRecord => {
      // validateCall requires a draft to have been attached (draft_content_hash
      // set via updateDraft); an empty draft cannot be validated.
      const row = readCallInstanceRow(this.db, callInstanceId);
      if (row && row.draft_content_hash === null) {
        throw new Error(
          `CALL_DRAFT_REQUIRED: validateCall requires a draft (draft_content_hash); call ${callInstanceId} has none`,
        );
      }
      const updated = guardedTransition(
        this.db,
        'validateCall',
        callInstanceId,
        "status='validated'",
        [],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  submitCall(callInstanceId: number): CallInstanceRecord {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    const run = (): CallInstanceRecord => {
      const updated = guardedTransition(
        this.db,
        'submitCall',
        callInstanceId,
        "status='submitted'",
        [],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  sealCall(callInstanceId: number, successfulReceiptRef: string): CallInstanceRecord {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    // C030 — seal attaches the EXACT receipt; an empty ref is rejected so a
    // no-op seal is impossible (the runtime MUST record the real receipt).
    if (
      typeof successfulReceiptRef !== 'string'
      || successfulReceiptRef.length === 0
      || successfulReceiptRef.trim() !== successfulReceiptRef
    ) {
      throw new Error(
        'CALL_RECEIPT_REQUIRED: sealCall requires a non-empty trimmed successfulReceiptRef (C030)',
      );
    }
    const run = (): CallInstanceRecord => {
      const updated = guardedTransition(
        this.db,
        'sealCall',
        callInstanceId,
        "status='sealed', successful_receipt_ref=?, sealed_at=datetime('now')",
        [successfulReceiptRef],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  failCall(input: FailCallInput): CallInstanceRecord {
    assertFailInput(input);
    const run = (): CallInstanceRecord => {
      // failCall preserves draft_content_hash (C029) — only status, error, and
      // updated_at change. A previously-set successful_receipt_ref is cleared so
      // a succeeded→failed transition does not leave a stale receipt attached.
      const updated = guardedTransition(
        this.db,
        'failCall',
        input.callInstanceId,
        "status='failed', last_error_json=?, successful_receipt_ref=NULL",
        [input.lastErrorJson],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  retryCall(callInstanceId: number): CallInstanceRecord {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    const run = (): CallInstanceRecord => {
      // retryCall re-opens the SAME failed row to 'edited' (C029 — progressive
      // correction over the preserved draft). draft_content_hash and
      // last_error_json are LEFT IN PLACE so the runtime can see both the
      // prior draft and the prior failure; only status flips.
      const updated = guardedTransition(
        this.db,
        'retryCall',
        callInstanceId,
        "status='edited'",
        [],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  abandonCall(callInstanceId: number): CallInstanceRecord {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    const run = (): CallInstanceRecord => {
      const updated = guardedTransition(
        this.db,
        'abandonCall',
        callInstanceId,
        "status='abandoned'",
        [],
      );
      return rowToCallInstance(updated);
    };
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  readCallInstance(callInstanceId: number): CallInstanceRecord | null {
    assertPositiveInt(callInstanceId, 'callInstanceId');
    const row = readCallInstanceRow(this.db, callInstanceId);
    return row ? rowToCallInstance(row) : null;
  }

  listForStep(
    processRunId: number,
    stepId: string,
    toolContractRef: string,
  ): readonly CallInstanceRecord[] {
    assertPositiveInt(processRunId, 'processRunId');
    assertNonEmptyTrimmedString(stepId, 'stepId');
    assertNonEmptyTrimmedString(toolContractRef, 'toolContractRef');
    const rows = this.db.prepare(
      `SELECT * FROM factory_call_instances
        WHERE process_run_id=? AND step_id=? AND tool_contract_ref=?
        ORDER BY attempt ASC, id ASC`,
    ).all(processRunId, stepId, toolContractRef) as CallInstanceRow[];
    return rows.map(rowToCallInstance);
  }
}
