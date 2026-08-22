import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type { TransitionTarget } from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  CompleteLifecycleStageResult,
  LifecycleRunRepository,
  RunTerminalEventClaim,
} from './lifecycle-run-repository.js';
import type {
  CompleteLifecycleStageCommand,
  EnsureLifecycleStageRunCommand,
  LifecycleExecutionLease,
  LifecycleRunRecord,
  LifecycleRunStatus,
  LifecycleStageRunRecord,
  LifecycleStageRunStatus,
  LifecycleTransitionRecord,
  StartLifecycleCommand,
} from './lifecycle-run.js';
import { lifecycleRefKey } from './lifecycle-run.js';
import { ensureFactoryProcessRunSchema } from './sqlite-process-run-repository.js';
import { classifyLifecycleDefinitionCompatibility } from '../application/lifecycle-definition-compatibility.js';

/**
 * ADR-090 (CC-IC-1): the pinned per-run lifecycle definition read. The
 * lifecycle-classification reaches Discovery settlement ONLY through this
 * typed port — `ctx.processRunId` → join `factory_stage_runs.process_run_id`
 * → `lifecycle_run_id` → the pinned `factory_lifecycle_runs`
 * `definition_snapshot` + `definition_hash`. A missing row or a definition
 * hash mismatch fails closed with a typed error — never an ambient or
 * default `lifecycleDefinition` binding.
 */
export interface PinnedLifecycleDefinitionRead {
  readonly lifecycleRunId: number;
  readonly lifecycleRefKey: string;
  /** The pinned definition snapshot (parsed JSON of the persisted canonical text). */
  readonly definition: Readonly<Record<string, unknown>>;
  /** sha256 over the canonical definition snapshot, as persisted at start(). */
  readonly definitionHash: string;
}

export function ensureFactoryLifecycleRunSchema(db: Database.Database): void {
  ensureFactoryProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_lifecycle_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      lifecycle_name        TEXT NOT NULL,
      lifecycle_version     TEXT NOT NULL,
      lifecycle_ref_key     TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      description           TEXT NOT NULL,
      definition_snapshot   TEXT NOT NULL,
      definition_hash       TEXT NOT NULL,
      project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id               INTEGER REFERENCES epics(id) ON DELETE CASCADE,
      initiated_by          TEXT NOT NULL,
      idempotency_key       TEXT NOT NULL,
      input_schema          TEXT NOT NULL,
      input_snapshot        TEXT NOT NULL,
      input_hash            TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'created'
                              CHECK (status IN ('created','running','paused','completed','failed','cancelled')),
      entry_stage_id        TEXT NOT NULL,
      current_stage_id      TEXT,
      current_stage_run_id  INTEGER,
      terminal_status       TEXT,
      version               INTEGER NOT NULL DEFAULT 0,
      execution_lease_owner TEXT,
      execution_lease_fence INTEGER NOT NULL DEFAULT 0,
      execution_lease_expires_at TEXT,
      error                 TEXT,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_lifecycle_runs_idem
      ON factory_lifecycle_runs(
        project_id, lifecycle_name, lifecycle_version, idempotency_key
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_lifecycle_runs_active_scope
      ON factory_lifecycle_runs(project_id, COALESCE(epic_id,-1), lifecycle_name)
      WHERE status IN ('created','running','paused');
    CREATE INDEX IF NOT EXISTS idx_factory_lifecycle_runs_active
      ON factory_lifecycle_runs(project_id, epic_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS factory_stage_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      lifecycle_run_id      INTEGER NOT NULL
                                REFERENCES factory_lifecycle_runs(id) ON DELETE CASCADE,
      ordinal               INTEGER NOT NULL,
      stage_id              TEXT NOT NULL,
      attempt               INTEGER NOT NULL,
      module_name           TEXT NOT NULL,
      module_version        TEXT NOT NULL,
      module_ref_key        TEXT NOT NULL,
      binding_snapshot      TEXT NOT NULL,
      binding_hash          TEXT NOT NULL,
      input_schema          TEXT NOT NULL,
      input_snapshot        TEXT NOT NULL,
      input_hash            TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'created'
                              CHECK (status IN ('created','running','paused','completed','failed','cancelled')),
      process_run_id        INTEGER UNIQUE
                                REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      local_outcome         TEXT,
      authority             TEXT,
      output_schema         TEXT,
      output_ref            TEXT,
      output_hash           TEXT,
      certificate_schema    TEXT,
      certificate_ref       TEXT,
      certificate_hash      TEXT,
      mapped_output_snapshot TEXT,
      result_snapshot       TEXT,
      error                 TEXT,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lifecycle_run_id, ordinal),
      UNIQUE(lifecycle_run_id, stage_id, attempt)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_stage_runs_lifecycle
      ON factory_stage_runs(lifecycle_run_id, ordinal);

    CREATE TABLE IF NOT EXISTS factory_process_transitions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      lifecycle_run_id      INTEGER NOT NULL
                                REFERENCES factory_lifecycle_runs(id) ON DELETE CASCADE,
      from_stage_run_id     INTEGER NOT NULL UNIQUE
                                REFERENCES factory_stage_runs(id) ON DELETE RESTRICT,
      transition_key        TEXT NOT NULL UNIQUE,
      outcome               TEXT NOT NULL,
      target_type           TEXT NOT NULL CHECK (target_type IN ('stage','terminal')),
      target_stage_id       TEXT,
      terminal_status       TEXT,
      to_stage_run_id       INTEGER
                                REFERENCES factory_stage_runs(id) ON DELETE RESTRICT,
      handoff_snapshot      TEXT NOT NULL,
      handoff_hash          TEXT NOT NULL,
      decision_hash         TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (target_type='stage' AND target_stage_id IS NOT NULL
          AND terminal_status IS NULL AND to_stage_run_id IS NOT NULL)
        OR
        (target_type='terminal' AND target_stage_id IS NULL
          AND terminal_status IS NOT NULL AND to_stage_run_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_factory_process_transitions_lifecycle
      ON factory_process_transitions(lifecycle_run_id, id);

    CREATE TABLE IF NOT EXISTS factory_definition_compatibility_receipts (
      receipt_ref TEXT PRIMARY KEY,
      lifecycle_run_id INTEGER NOT NULL REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
      previous_definition_hash TEXT NOT NULL,
      candidate_definition_hash TEXT NOT NULL,
      current_stage_id TEXT,
      classification TEXT NOT NULL CHECK (classification IN ('exact','metadata_only','incompatible')),
      reason_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- CC-GAP-4 — the durable exactly-once gate for the run.terminal
    -- journal boundary. One row per terminalized lifecycle run: the FIRST
    -- claim wins and every later replay/re-drive of the same terminal fact
    -- (dispatch loop, obligation re-drive, resume relaunch, a second engine
    -- process) reads the row and stays silent. Purely additive — historical
    -- runs (Elite-6 evidence included) simply have no row until and unless
    -- a future replay claims them; nothing existing is rewritten.
    CREATE TABLE IF NOT EXISTS factory_run_terminal_event_receipts (
      lifecycle_run_id INTEGER PRIMARY KEY
        REFERENCES factory_lifecycle_runs(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      terminal_status TEXT,
      claimed_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const lifecycleColumns = db.prepare(
    'PRAGMA table_info(factory_lifecycle_runs)',
  ).all() as Array<{ name: string }>;
  if (!lifecycleColumns.some(column => column.name === 'entry_stage_id')) {
    db.exec('ALTER TABLE factory_lifecycle_runs ADD COLUMN entry_stage_id TEXT');
    db.exec(
      `UPDATE factory_lifecycle_runs
          SET entry_stage_id=COALESCE(current_stage_id,'unknown')
        WHERE entry_stage_id IS NULL`,
    );
  }
  const transitionColumns = db.prepare(
    'PRAGMA table_info(factory_process_transitions)',
  ).all() as Array<{ name: string }>;
  if (!transitionColumns.some(column => column.name === 'to_stage_run_id')) {
    db.exec(
      'ALTER TABLE factory_process_transitions ADD COLUMN to_stage_run_id INTEGER REFERENCES factory_stage_runs(id)',
    );
  }
}

interface LifecycleRunRow {
  id: number;
  lifecycle_name: string;
  lifecycle_version: string;
  lifecycle_ref_key: string;
  display_name: string;
  description: string;
  definition_snapshot: string;
  definition_hash: string;
  project_id: number;
  epic_id: number | null;
  initiated_by: string;
  idempotency_key: string;
  input_schema: string;
  input_snapshot: string;
  input_hash: string;
  status: LifecycleRunStatus;
  entry_stage_id: string;
  current_stage_id: string | null;
  current_stage_run_id: number | null;
  terminal_status: string | null;
  version: number;
  execution_lease_fence: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StageRunRow {
  id: number;
  lifecycle_run_id: number;
  ordinal: number;
  stage_id: string;
  attempt: number;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  binding_snapshot: string;
  binding_hash: string;
  input_schema: string;
  input_snapshot: string;
  input_hash: string;
  status: LifecycleStageRunStatus;
  process_run_id: number | null;
  local_outcome: string | null;
  authority: string | null;
  output_schema: string | null;
  output_ref: string | null;
  output_hash: string | null;
  certificate_schema: string | null;
  certificate_ref: string | null;
  certificate_hash: string | null;
  mapped_output_snapshot: string | null;
  result_snapshot: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TransitionRow {
  id: number;
  lifecycle_run_id: number;
  from_stage_run_id: number;
  transition_key: string;
  outcome: string;
  target_type: 'stage' | 'terminal';
  target_stage_id: string | null;
  terminal_status: string | null;
  to_stage_run_id: number | null;
  handoff_snapshot: string;
  handoff_hash: string;
  decision_hash: string;
  created_at: string;
}

function parseRecord(value: string | null, field: string): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`saga3: ${field} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function runRowToRecord(row: LifecycleRunRow): LifecycleRunRecord {
  return {
    id: row.id,
    lifecycle: {
      name: row.lifecycle_name,
      version: row.lifecycle_version,
      displayName: row.display_name,
      description: row.description,
    },
    lifecycleRefKey: row.lifecycle_ref_key,
    definitionSnapshot: row.definition_snapshot,
    definitionHash: row.definition_hash,
    projectId: row.project_id,
    epicId: row.epic_id,
    initiatedBy: row.initiated_by,
    idempotencyKey: row.idempotency_key,
    inputSchema: row.input_schema,
    inputSnapshot: row.input_snapshot,
    inputHash: row.input_hash,
    status: row.status,
    entryStageId: row.entry_stage_id,
    currentStageId: row.current_stage_id,
    currentStageRunId: row.current_stage_run_id,
    terminalStatus: row.terminal_status,
    version: row.version,
    leaseFence: row.execution_lease_fence,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stageRowToRecord(row: StageRunRow): LifecycleStageRunRecord {
  return {
    id: row.id,
    lifecycleRunId: row.lifecycle_run_id,
    ordinal: row.ordinal,
    stageId: row.stage_id,
    attempt: row.attempt,
    moduleRef: { name: row.module_name, version: row.module_version },
    bindingSnapshot: row.binding_snapshot,
    bindingHash: row.binding_hash,
    inputSchema: row.input_schema,
    inputSnapshot: row.input_snapshot,
    inputHash: row.input_hash,
    status: row.status,
    processRunId: row.process_run_id,
    localOutcome: row.local_outcome,
    authority: row.authority,
    output: row.output_ref === null
      ? null
      : {
          schema: row.output_schema ?? '',
          artifactRef: row.output_ref,
          contentHash: row.output_hash ?? '',
        },
    certificate: row.certificate_ref === null
      ? null
      : {
          schema: row.certificate_schema ?? '',
          certificateRef: row.certificate_ref,
          certificateHash: row.certificate_hash ?? '',
        },
    mappedOutput: parseRecord(row.mapped_output_snapshot, 'mapped_output_snapshot'),
    resultSnapshot: parseRecord(row.result_snapshot, 'result_snapshot'),
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transitionRowToRecord(row: TransitionRow): LifecycleTransitionRecord {
  const target: TransitionTarget = row.target_type === 'stage'
    ? { type: 'stage', stageId: row.target_stage_id ?? '' }
    : { type: 'terminal', status: row.terminal_status ?? '' };
  return {
    id: row.id,
    lifecycleRunId: row.lifecycle_run_id,
    fromStageRunId: row.from_stage_run_id,
    transitionKey: row.transition_key,
    outcome: row.outcome,
    target,
    toStageRunId: row.to_stage_run_id,
    handoffSnapshot: parseRecord(row.handoff_snapshot, 'handoff_snapshot') ?? {},
    handoffHash: row.handoff_hash,
    decisionHash: row.decision_hash,
    createdAt: row.created_at,
  };
}

function sameRef(
  row: { module_name: string; module_version: string },
  reference: ProcessModuleReference,
): boolean {
  return row.module_name === reference.name && row.module_version === reference.version;
}

function nullableEqual(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

export class SqliteLifecycleRunRepository implements LifecycleRunRepository {
  constructor(private readonly db: Database.Database = getDb()) {
    ensureFactoryLifecycleRunSchema(db);
  }

  start(command: StartLifecycleCommand): {
    record: LifecycleRunRecord;
    replayed: boolean;
  } {
    const expectedDefinitionHash = sha256Hex(JSON.parse(command.definitionSnapshot));
    if (expectedDefinitionHash !== command.definitionHash) {
      throw new Error('LIFECYCLE_DEFINITION_HASH_MISMATCH');
    }
    const inputSnapshot = canonicalJson(command.input.payload);
    if (sha256Hex(command.input.payload) !== command.input.contentHash) {
      throw new Error('LIFECYCLE_INPUT_HASH_MISMATCH');
    }
    const ctx = command.invocationContext;
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM factory_lifecycle_runs
          WHERE project_id=? AND lifecycle_name=? AND lifecycle_version=?
            AND idempotency_key=?`,
      ).get(
        ctx.projectId,
        command.lifecycle.name,
        command.lifecycle.version,
        ctx.idempotencyKey,
      ) as LifecycleRunRow | undefined;
      if (existing) {
        if (existing.input_hash !== command.input.contentHash) {
          throw new Error(
            `LIFECYCLE_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT: `
            + `'${ctx.idempotencyKey}' is already bound to ${existing.input_hash}`,
          );
        }
        if (existing.definition_hash !== command.definitionHash) {
          const compatibility = classifyLifecycleDefinitionCompatibility(
            existing.definition_snapshot,
            command.definitionSnapshot,
          );
          const receiptRef = sha256Hex({
            kind: 'lifecycle-definition-compatibility',
            lifecycleRunId: existing.id,
            previous: existing.definition_hash,
            candidate: command.definitionHash,
            classification: compatibility.classification,
          });
          this.db.prepare(
            `INSERT OR IGNORE INTO factory_definition_compatibility_receipts
              (receipt_ref, lifecycle_run_id, previous_definition_hash,
               candidate_definition_hash, current_stage_id, classification, reason_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            receiptRef, existing.id, existing.definition_hash,
            command.definitionHash, existing.current_stage_id,
            compatibility.classification, canonicalJson(compatibility.reasons),
          );
          if (compatibility.classification === 'incompatible') {
            throw new Error(
              `LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY: `
              + `${existing.lifecycle_ref_key} is pinned to ${existing.definition_hash}`,
            );
          }
        }
        if (
          !nullableEqual(existing.epic_id, ctx.epicId)
          || existing.input_schema !== command.input.schema
          || existing.entry_stage_id !== command.entryStageId
          || existing.initiated_by !== ctx.initiatedBy
        ) {
          throw new Error('LIFECYCLE_REPLAY_CONTEXT_MISMATCH');
        }
        return { record: runRowToRecord(existing), replayed: true };
      }

      const active = this.db.prepare(
        `SELECT id FROM factory_lifecycle_runs
          WHERE project_id=? AND COALESCE(epic_id,-1)=COALESCE(?,-1)
            AND lifecycle_name=? AND status IN ('created','running','paused')
          LIMIT 1`,
      ).get(ctx.projectId, ctx.epicId, command.lifecycle.name) as { id: number } | undefined;
      if (active) {
        throw new Error(
          `LIFECYCLE_SCOPE_ALREADY_ACTIVE: lifecycle_run ${active.id} already owns this scope`,
        );
      }

      const info = this.db.prepare(
        `INSERT INTO factory_lifecycle_runs
          (lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
           definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
           idempotency_key,input_schema,input_snapshot,input_hash,status,
           entry_stage_id,current_stage_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'created',?,?)`,
      ).run(
        command.lifecycle.name,
        command.lifecycle.version,
        lifecycleRefKey(command.lifecycle),
        command.lifecycle.displayName,
        command.lifecycle.description,
        command.definitionSnapshot,
        command.definitionHash,
        ctx.projectId,
        ctx.epicId,
        ctx.initiatedBy,
        ctx.idempotencyKey,
        command.input.schema,
        inputSnapshot,
        command.input.contentHash,
        command.entryStageId,
        command.entryStageId,
      );
      return {
        record: runRowToRecord(this.readRunRow(Number(info.lastInsertRowid))),
        replayed: false,
      };
    });
  }

  read(id: number): LifecycleRunRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM factory_lifecycle_runs WHERE id=?',
    ).get(id) as LifecycleRunRow | undefined;
    return row ? runRowToRecord(row) : null;
  }

  /**
   * ADR-090 (CC-IC-1): the typed pinned-definition read consumed (read-only)
   * by Discovery settlement through composition-root wiring — the ONLY
   * normative path the lifecycle classification takes into settlement.
   * Fail-closed: a process run bound to no stage run / no lifecycle run is a
   * typed error, and the persisted definition hash is re-derived and
   * compared before the definition is returned (a mismatch is tampering or
   * corruption — never a silent substitute).
   */
  readDefinitionByProcessRun(processRunId: number): PinnedLifecycleDefinitionRead {
    if (!Number.isSafeInteger(processRunId) || processRunId < 1) {
      throw new Error(`LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_MISSING: invalid process run ${processRunId}`);
    }
    const row = this.db.prepare(
      `SELECT lr.id AS lifecycle_run_id,
              lr.lifecycle_ref_key AS lifecycle_ref_key,
              lr.definition_snapshot AS definition_snapshot,
              lr.definition_hash AS definition_hash
         FROM factory_stage_runs sr
         JOIN factory_lifecycle_runs lr ON lr.id=sr.lifecycle_run_id
        WHERE sr.process_run_id=?`,
    ).get(processRunId) as {
      lifecycle_run_id: number;
      lifecycle_ref_key: string;
      definition_snapshot: string;
      definition_hash: string;
    } | undefined;
    if (!row) {
      throw new Error(
        `LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_MISSING: process run ${processRunId} is bound to no lifecycle run`,
      );
    }
    let definition: unknown;
    try {
      definition = JSON.parse(row.definition_snapshot);
    } catch {
      throw new Error(
        `LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_INVALID: lifecycle run ${row.lifecycle_run_id} carries an unparseable definition snapshot`,
      );
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(
        `LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_INVALID: lifecycle run ${row.lifecycle_run_id} carries a non-object definition snapshot`,
      );
    }
    const derivedHash = sha256Hex(definition);
    if (derivedHash !== row.definition_hash) {
      throw new Error(
        `LIFECYCLE_DEFINITION_HASH_MISMATCH: lifecycle run ${row.lifecycle_run_id} pins ${row.definition_hash}, snapshot hashes ${derivedHash}`,
      );
    }
    return {
      lifecycleRunId: row.lifecycle_run_id,
      lifecycleRefKey: row.lifecycle_ref_key,
      definition: definition as Readonly<Record<string, unknown>>,
      definitionHash: row.definition_hash,
    };
  }

  readByIdempotencyKey(
    projectId: number,
    refKey: string,
    idempotencyKey: string,
  ): LifecycleRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_lifecycle_runs
        WHERE project_id=? AND lifecycle_ref_key=? AND idempotency_key=?`,
    ).get(projectId, refKey, idempotencyKey) as LifecycleRunRow | undefined;
    return row ? runRowToRecord(row) : null;
  }

  list(
    projectId: number,
    epicId?: number,
  ): readonly LifecycleRunRecord[] {
    const rows = epicId === undefined
      ? this.db.prepare(
          `SELECT * FROM factory_lifecycle_runs
            WHERE project_id=?
            ORDER BY id DESC`,
        ).all(projectId)
      : this.db.prepare(
          `SELECT * FROM factory_lifecycle_runs
            WHERE project_id=? AND epic_id=?
            ORDER BY id DESC`,
        ).all(projectId, epicId);
    return (rows as LifecycleRunRow[]).map(runRowToRecord);
  }

  listStageRuns(lifecycleRunId: number): readonly LifecycleStageRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_stage_runs
        WHERE lifecycle_run_id=? ORDER BY ordinal`,
    ).all(lifecycleRunId) as StageRunRow[];
    return rows.map(stageRowToRecord);
  }

  listTransitions(
    lifecycleRunId: number,
  ): readonly LifecycleTransitionRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_process_transitions
        WHERE lifecycle_run_id=? ORDER BY id`,
    ).all(lifecycleRunId) as TransitionRow[];
    return rows.map(transitionRowToRecord);
  }

  readCurrentStageRun(lifecycleRunId: number): LifecycleStageRunRecord | null {
    const row = this.db.prepare(
      `SELECT sr.* FROM factory_lifecycle_runs lr
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
        WHERE lr.id=?`,
    ).get(lifecycleRunId) as StageRunRow | undefined;
    return row ? stageRowToRecord(row) : null;
  }

  ensureStageRun(
    command: EnsureLifecycleStageRunCommand,
    lease: LifecycleExecutionLease,
  ): { record: LifecycleStageRunRecord; replayed: boolean } {
    this.verifyStageCommand(command);
    return this.transaction(() => {
      const lifecycle = this.requireLease(command.lifecycleRunId, lease);
      if (lifecycle.current_stage_id !== command.stageId) {
        throw new Error(
          `LIFECYCLE_STAGE_MISMATCH: expected '${lifecycle.current_stage_id}', `
          + `received '${command.stageId}'`,
        );
      }
      if (lifecycle.current_stage_run_id !== null) {
        const existing = this.readStageRow(lifecycle.current_stage_run_id);
        this.assertStageReplay(existing, command);
        return { record: stageRowToRecord(existing), replayed: true };
      }

      const inserted = this.insertStageRun(command);
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET current_stage_run_id=?, status='running', version=version+1,
                error=NULL, updated_at=datetime('now')
          WHERE id=? AND current_stage_run_id IS NULL
            AND execution_lease_owner=? AND execution_lease_fence=?`,
      ).run(inserted.id, command.lifecycleRunId, lease.owner, lease.fence);
      if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      return { record: stageRowToRecord(inserted), replayed: false };
    });
  }

  bindProcessRun(
    lifecycleRunId: number,
    stageRunId: number,
    processRunId: number,
    lease: LifecycleExecutionLease,
  ): LifecycleStageRunRecord {
    return this.transaction(() => {
      const lifecycle = this.requireLease(lifecycleRunId, lease);
      if (lifecycle.current_stage_run_id !== stageRunId) {
        throw new Error('LIFECYCLE_STAGE_RUN_IS_NOT_CURRENT');
      }
      const stage = this.readStageRow(stageRunId);
      if (stage.process_run_id !== null) {
        if (stage.process_run_id !== processRunId) {
          throw new Error('LIFECYCLE_STAGE_ALREADY_BOUND_TO_ANOTHER_PROCESS_RUN');
        }
        return stageRowToRecord(stage);
      }
      const process = this.db.prepare(
        `SELECT project_id,epic_id,module_name,module_version,input_hash
           FROM factory_process_runs WHERE id=?`,
      ).get(processRunId) as {
        project_id: number;
        epic_id: number | null;
        module_name: string;
        module_version: string;
        input_hash: string;
      } | undefined;
      if (
        !process
        || process.project_id !== lifecycle.project_id
        || !nullableEqual(process.epic_id, lifecycle.epic_id)
        || !sameRef(process, {
          name: stage.module_name,
          version: stage.module_version,
        })
        || process.input_hash !== stage.input_hash
      ) {
        throw new Error('LIFECYCLE_PROCESS_RUN_BINDING_MISMATCH');
      }
      const changed = this.db.prepare(
        `UPDATE factory_stage_runs SET process_run_id=?, updated_at=datetime('now')
          WHERE id=? AND lifecycle_run_id=? AND process_run_id IS NULL
            AND EXISTS (
              SELECT 1 FROM factory_lifecycle_runs
               WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
            )`,
      ).run(
        processRunId,
        stageRunId,
        lifecycleRunId,
        lifecycleRunId,
        lease.owner,
        lease.fence,
      );
      if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      return stageRowToRecord(this.readStageRow(stageRunId));
    });
  }

  markStageRunning(
    lifecycleRunId: number,
    stageRunId: number,
    lease: LifecycleExecutionLease,
  ): LifecycleStageRunRecord {
    return this.transaction(() => {
      const lifecycle = this.requireLease(lifecycleRunId, lease);
      if (lifecycle.current_stage_run_id !== stageRunId) {
        throw new Error('LIFECYCLE_STAGE_RUN_IS_NOT_CURRENT');
      }
      const stage = this.readStageRow(stageRunId);
      if (stage.status === 'completed' || stage.status === 'failed' || stage.status === 'cancelled') {
        return stageRowToRecord(stage);
      }
      const changed = this.db.prepare(
        `UPDATE factory_stage_runs SET status='running', error=NULL, updated_at=datetime('now')
          WHERE id=? AND lifecycle_run_id=?
            AND EXISTS (
              SELECT 1 FROM factory_lifecycle_runs
               WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
            )`,
      ).run(
        stageRunId,
        lifecycleRunId,
        lifecycleRunId,
        lease.owner,
        lease.fence,
      );
      if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET status='running', error=NULL, version=version+1, updated_at=datetime('now')
          WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?`,
      ).run(lifecycleRunId, lease.owner, lease.fence);
      return stageRowToRecord(this.readStageRow(stageRunId));
    });
  }

  pauseStage(
    lifecycleRunId: number,
    stageRunId: number,
    error: string,
    lease: LifecycleExecutionLease,
  ): LifecycleRunRecord {
    return this.transaction(() => {
      const lifecycle = this.requireLease(lifecycleRunId, lease);
      if (lifecycle.current_stage_run_id !== stageRunId) {
        throw new Error('LIFECYCLE_STAGE_RUN_IS_NOT_CURRENT');
      }
      this.db.prepare(
        `UPDATE factory_stage_runs
            SET status='paused', error=?, updated_at=datetime('now')
          WHERE id=? AND lifecycle_run_id=? AND status NOT IN ('completed','failed','cancelled')`,
      ).run(error, stageRunId, lifecycleRunId);
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET status='paused', error=?, version=version+1, updated_at=datetime('now')
          WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
            AND status NOT IN ('completed','failed','cancelled')`,
      ).run(error, lifecycleRunId, lease.owner, lease.fence);
      if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      return runRowToRecord(this.readRunRow(lifecycleRunId));
    });
  }

  fail(
    lifecycleRunId: number,
    stageRunId: number | null,
    error: string,
    lease: LifecycleExecutionLease,
  ): LifecycleRunRecord {
    return this.transaction(() => {
      this.requireLease(lifecycleRunId, lease);
      if (stageRunId !== null) {
        this.db.prepare(
          `UPDATE factory_stage_runs
              SET status='failed', error=?, completed_at=COALESCE(completed_at,datetime('now')),
                  updated_at=datetime('now')
            WHERE id=? AND lifecycle_run_id=? AND status NOT IN ('completed','cancelled')`,
        ).run(error, stageRunId, lifecycleRunId);
      }
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET status='failed', terminal_status='failed', error=?,
                completed_at=COALESCE(completed_at,datetime('now')),
                version=version+1, updated_at=datetime('now')
          WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
            AND status NOT IN ('completed','cancelled')`,
      ).run(error, lifecycleRunId, lease.owner, lease.fence);
      if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      return runRowToRecord(this.readRunRow(lifecycleRunId));
    });
  }

  resume(lifecycleRunId: number, expectedVersion: number): LifecycleRunRecord {
    return this.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET status='running', error=NULL, version=version+1,
                execution_lease_owner=NULL, execution_lease_expires_at=NULL,
                updated_at=datetime('now')
          WHERE id=? AND version=? AND status='paused'`,
      ).run(lifecycleRunId, expectedVersion);
      if (changed.changes !== 1) {
        const current = this.readRunRow(lifecycleRunId);
        throw new Error(
          `LIFECYCLE_RESUME_CONFLICT: expected paused version ${expectedVersion}, `
          + `found ${current.status} version ${current.version}`,
        );
      }
      return runRowToRecord(this.readRunRow(lifecycleRunId));
    });
  }

  cancel(
    lifecycleRunId: number,
    expectedVersion: number,
    reason: string,
  ): LifecycleRunRecord {
    return this.transaction(() => {
      const current = this.readRunRow(lifecycleRunId);
      if (current.status === 'cancelled') return runRowToRecord(current);
      if (current.status === 'completed' || current.status === 'failed') {
        throw new Error(`LIFECYCLE_CANCEL_TERMINAL: run is ${current.status}`);
      }
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET status='cancelled', terminal_status='cancelled', error=?,
                completed_at=COALESCE(completed_at,datetime('now')),
                execution_lease_owner=NULL, execution_lease_expires_at=NULL,
                version=version+1, updated_at=datetime('now')
          WHERE id=? AND version=? AND status IN ('created','running','paused')`,
      ).run(reason, lifecycleRunId, expectedVersion);
      if (changed.changes !== 1) {
        throw new Error('LIFECYCLE_CANCEL_CONFLICT');
      }
      if (current.current_stage_run_id !== null) {
        // Cancellation is one durable authority decision. Fence the exact
        // ProcessRun bound to the current StageRun in the same SQLite
        // transaction; otherwise a stale lifecycle worker could keep driving
        // provider mutations after the parent run had already been cancelled.
        this.db.prepare(
          `UPDATE factory_process_runs
              SET status='cancelled', error=?,
                  completed_at=COALESCE(completed_at,datetime('now')),
                  execution_lease_owner=NULL,
                  execution_lease_expires_at=NULL,
                  updated_at=datetime('now')
            WHERE id=(
              SELECT process_run_id
                FROM factory_stage_runs
               WHERE id=? AND lifecycle_run_id=?
            )
              AND status IN ('created','preparing','running','paused','settling')`,
        ).run(reason, current.current_stage_run_id, lifecycleRunId);
        this.db.prepare(
          `UPDATE factory_stage_runs
              SET status='cancelled', error=?,
                  completed_at=COALESCE(completed_at,datetime('now')),
                  updated_at=datetime('now')
            WHERE id=? AND status IN ('created','running','paused')`,
        ).run(reason, current.current_stage_run_id);
      }
      return runRowToRecord(this.readRunRow(lifecycleRunId));
    });
  }

  listRecoverable(expiredBeforeIso: string): readonly LifecycleRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_lifecycle_runs
        WHERE status IN ('created','running')
          AND (
            execution_lease_owner IS NULL
            OR execution_lease_expires_at IS NULL
            OR execution_lease_expires_at<=?
          )
        ORDER BY updated_at,id`,
    ).all(expiredBeforeIso) as LifecycleRunRow[];
    return rows.map(runRowToRecord);
  }

  completeStage(
    command: CompleteLifecycleStageCommand,
    lease: LifecycleExecutionLease,
  ): CompleteLifecycleStageResult {
    if (sha256Hex(command.handoffSnapshot) !== command.handoffHash) {
      throw new Error('LIFECYCLE_HANDOFF_HASH_MISMATCH');
    }
    const expectedDecisionHash = sha256Hex({
      lifecycleRunId: command.lifecycleRunId,
      stageRunId: command.stageRunId,
      outcome: command.outcome,
      target: command.target,
      handoffHash: command.handoffHash,
    });
    if (expectedDecisionHash !== command.decisionHash) {
      throw new Error('LIFECYCLE_DECISION_HASH_MISMATCH');
    }
    if (command.nextStage) {
      this.verifyStageCommand({
        lifecycleRunId: command.lifecycleRunId,
        ...command.nextStage,
      });
    }
    return this.transaction(() => {
      const prior = this.db.prepare(
        'SELECT * FROM factory_process_transitions WHERE transition_key=?',
      ).get(command.transitionKey) as TransitionRow | undefined;
      if (prior) {
        const sameTarget = command.target.type === prior.target_type
          && (
            command.target.type === 'stage'
              ? prior.target_stage_id === command.target.stageId
              : prior.terminal_status === command.target.status
          );
        if (
          prior.lifecycle_run_id !== command.lifecycleRunId
          || prior.from_stage_run_id !== command.stageRunId
          || prior.decision_hash !== command.decisionHash
          || prior.outcome !== command.outcome
          || prior.handoff_hash !== command.handoffHash
          || !sameTarget
        ) {
          throw new Error('LIFECYCLE_TRANSITION_KEY_REUSED_WITH_DIFFERENT_DECISION');
        }
        return {
          lifecycleRun: runRowToRecord(this.readRunRow(command.lifecycleRunId)),
          stageRun: stageRowToRecord(this.readStageRow(command.stageRunId)),
          transition: transitionRowToRecord(prior),
          replayed: true,
        };
      }

      const lifecycle = this.requireLease(command.lifecycleRunId, lease);
      if (
        lifecycle.current_stage_id !== command.expectedStageId
        || lifecycle.current_stage_run_id !== command.stageRunId
      ) {
        throw new Error('LIFECYCLE_STAGE_RUN_IS_NOT_CURRENT');
      }
      const stage = this.readStageRow(command.stageRunId);
      if (stage.stage_id !== command.expectedStageId || stage.process_run_id === null) {
        throw new Error('LIFECYCLE_STAGE_PROCESS_RUN_IS_NOT_BOUND');
      }
      const process = this.db.prepare(
        `SELECT status,local_outcome,authority,output_schema,output_ref,output_hash,
                certificate_schema,certificate_ref,certificate_hash
           FROM factory_process_runs WHERE id=?`,
      ).get(stage.process_run_id) as {
        status: string;
        local_outcome: string | null;
        authority: string | null;
        output_schema: string | null;
        output_ref: string | null;
        output_hash: string | null;
        certificate_schema: string | null;
        certificate_ref: string | null;
        certificate_hash: string | null;
      } | undefined;
      if (
        !process
        || process.status !== 'completed'
        || process.local_outcome !== command.outcome
        || !nullableEqual(process.authority, command.authority)
        || !nullableEqual(process.output_ref, command.output?.artifactRef)
        || !nullableEqual(process.output_hash, command.output?.contentHash)
        || !nullableEqual(process.output_schema, command.output?.schema)
        || !nullableEqual(process.certificate_ref, command.certificate?.certificateRef)
        || !nullableEqual(process.certificate_hash, command.certificate?.certificateHash)
        || !nullableEqual(process.certificate_schema, command.certificate?.schema)
      ) {
        throw new Error('LIFECYCLE_PROCESS_RESULT_MISMATCH');
      }
      const expectedResultSnapshot = {
        code: process.local_outcome,
        outcome: process.local_outcome,
        authority: process.authority,
        output: process.output_ref === null
          ? null
          : {
              schema: process.output_schema ?? '',
              artifactRef: process.output_ref,
              contentHash: process.output_hash ?? '',
            },
        certificate: process.certificate_ref === null
          ? null
          : {
              schema: process.certificate_schema ?? '',
              certificateRef: process.certificate_ref,
              certificateHash: process.certificate_hash ?? '',
            },
        outputRef: process.output_ref ?? process.certificate_ref,
        outputHash: process.output_hash ?? process.certificate_hash,
        outputSchema: process.output_schema ?? process.certificate_schema,
        certificateRef: process.certificate_ref,
        certificateHash: process.certificate_hash,
        certificateSchema: process.certificate_schema,
      };
      if (sha256Hex(command.resultSnapshot) !== sha256Hex(expectedResultSnapshot)) {
        throw new Error('LIFECYCLE_RESULT_SNAPSHOT_MISMATCH');
      }
      if (command.target.type === 'stage') {
        if (!command.nextStage || command.nextStage.stageId !== command.target.stageId) {
          throw new Error('LIFECYCLE_NEXT_STAGE_COMMAND_MISMATCH');
        }
      } else if (command.nextStage !== null) {
        throw new Error('LIFECYCLE_TERMINAL_TRANSITION_CANNOT_CREATE_STAGE');
      }

      const mappedOutputSnapshot = canonicalJson(command.mappedOutput);
      const resultSnapshot = canonicalJson(expectedResultSnapshot);
      const stageChanged = this.db.prepare(
        `UPDATE factory_stage_runs
            SET status='completed', local_outcome=?, authority=?,
                output_schema=?, output_ref=?, output_hash=?,
                certificate_schema=?, certificate_ref=?, certificate_hash=?,
                mapped_output_snapshot=?, result_snapshot=?, error=NULL,
                completed_at=COALESCE(completed_at,datetime('now')),
                updated_at=datetime('now')
          WHERE id=? AND lifecycle_run_id=? AND status NOT IN ('completed','failed','cancelled')`,
      ).run(
        command.outcome,
        command.authority,
        command.output?.schema ?? null,
        command.output?.artifactRef ?? null,
        command.output?.contentHash ?? null,
        command.certificate?.schema ?? null,
        command.certificate?.certificateRef ?? null,
        command.certificate?.certificateHash ?? null,
        mappedOutputSnapshot,
        resultSnapshot,
        command.stageRunId,
        command.lifecycleRunId,
      );
      if (stageChanged.changes !== 1) {
        throw new Error('LIFECYCLE_STAGE_ALREADY_TERMINAL');
      }

      const targetStageId = command.target.type === 'stage'
        ? command.target.stageId
        : null;
      const terminalStatus = command.target.type === 'terminal'
        ? command.target.status
        : null;
      const nextStageRow = command.nextStage
        ? this.insertStageRun({
            lifecycleRunId: command.lifecycleRunId,
            ...command.nextStage,
          })
        : null;
      const transitionInfo = this.db.prepare(
        `INSERT INTO factory_process_transitions
          (lifecycle_run_id,from_stage_run_id,transition_key,outcome,target_type,
           target_stage_id,terminal_status,to_stage_run_id,handoff_snapshot,
           handoff_hash,decision_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        command.lifecycleRunId,
        command.stageRunId,
        command.transitionKey,
        command.outcome,
        command.target.type,
        targetStageId,
        terminalStatus,
        nextStageRow?.id ?? null,
        canonicalJson(command.handoffSnapshot),
        command.handoffHash,
        command.decisionHash,
      );

      if (command.nextStage && nextStageRow) {
        const changed = this.db.prepare(
          `UPDATE factory_lifecycle_runs
              SET status='running', current_stage_id=?, current_stage_run_id=?,
                  terminal_status=NULL, error=NULL, version=version+1,
                  updated_at=datetime('now')
            WHERE id=? AND current_stage_run_id=?
              AND execution_lease_owner=? AND execution_lease_fence=?`,
        ).run(
          command.nextStage.stageId,
          nextStageRow.id,
          command.lifecycleRunId,
          command.stageRunId,
          lease.owner,
          lease.fence,
        );
        if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      } else {
        const changed = this.db.prepare(
          `UPDATE factory_lifecycle_runs
              SET status='completed', current_stage_id=NULL, current_stage_run_id=NULL,
                  terminal_status=?, error=NULL,
                  completed_at=COALESCE(completed_at,datetime('now')),
                  version=version+1, updated_at=datetime('now')
            WHERE id=? AND current_stage_run_id=?
              AND execution_lease_owner=? AND execution_lease_fence=?`,
        ).run(
          terminalStatus,
          command.lifecycleRunId,
          command.stageRunId,
          lease.owner,
          lease.fence,
        );
        if (changed.changes !== 1) throw new Error('LIFECYCLE_LEASE_LOST');
      }

      const transition = this.db.prepare(
        'SELECT * FROM factory_process_transitions WHERE id=?',
      ).get(Number(transitionInfo.lastInsertRowid)) as TransitionRow;
      return {
        lifecycleRun: runRowToRecord(this.readRunRow(command.lifecycleRunId)),
        stageRun: stageRowToRecord(this.readStageRow(command.stageRunId)),
        transition: transitionRowToRecord(transition),
        replayed: false,
      };
    });
  }

  acquireExecutionLease(
    lifecycleRunId: number,
    owner: string,
    nowIso: string,
    expiresAtIso: string,
  ): LifecycleExecutionLease | null {
    return this.transaction(() => {
      const row = this.readRunRow(lifecycleRunId);
      if (
        row.status === 'paused'
        || row.status === 'completed'
        || row.status === 'failed'
        || row.status === 'cancelled'
      ) {
        return null;
      }
      const leaseRow = this.db.prepare(
        `SELECT execution_lease_owner AS owner,
                execution_lease_expires_at AS expires_at,
                execution_lease_fence AS fence
           FROM factory_lifecycle_runs WHERE id=?`,
      ).get(lifecycleRunId) as {
        owner: string | null;
        expires_at: string | null;
        fence: number;
      };
      if (
        leaseRow.owner !== null
        && leaseRow.owner !== owner
        && leaseRow.expires_at !== null
        && leaseRow.expires_at > nowIso
      ) {
        return null;
      }
      const fence = leaseRow.fence + 1;
      const changed = this.db.prepare(
        `UPDATE factory_lifecycle_runs
            SET execution_lease_owner=?, execution_lease_fence=?,
                execution_lease_expires_at=?,
                status=CASE WHEN status='created' THEN 'running' ELSE status END,
                version=version+1, updated_at=datetime('now')
          WHERE id=? AND execution_lease_fence=?`,
      ).run(owner, fence, expiresAtIso, lifecycleRunId, leaseRow.fence);
      return changed.changes === 1 ? { owner, fence } : null;
    });
  }

  renewExecutionLease(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
    expiresAtIso: string,
  ): boolean {
    const changed = this.db.prepare(
      `UPDATE factory_lifecycle_runs
          SET execution_lease_expires_at=?, updated_at=datetime('now')
        WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
          AND julianday(execution_lease_expires_at)>julianday('now')
          AND status NOT IN ('completed','failed','cancelled')`,
    ).run(expiresAtIso, lifecycleRunId, lease.owner, lease.fence);
    return changed.changes === 1;
  }

  releaseExecutionLease(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
  ): void {
    this.db.prepare(
      `UPDATE factory_lifecycle_runs
          SET execution_lease_owner=NULL, execution_lease_expires_at=NULL,
              updated_at=datetime('now')
        WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?`,
    ).run(lifecycleRunId, lease.owner, lease.fence);
  }

  claimRunTerminalEvent(lifecycleRunId: number): RunTerminalEventClaim | null {
    return this.transaction(() => {
      // The authority check comes first and is fail-closed: a missing or
      // non-terminal row claims NOTHING. A premature probe (e.g. a reader
      // racing the terminalizing commit) must never burn the one claim the
      // real terminalization needs.
      const row = this.db.prepare(
        `SELECT status, terminal_status FROM factory_lifecycle_runs WHERE id=?`,
      ).get(lifecycleRunId) as
        | { status: LifecycleRunStatus; terminal_status: string | null }
        | undefined;
      if (
        !row
        || (
          row.status !== 'completed'
          && row.status !== 'failed'
          && row.status !== 'cancelled'
        )
      ) {
        return null;
      }
      // INSERT OR IGNORE on the run-id primary key is the atomic claim.
      // SQLite serializes writers, so across processes, restarts, and any
      // interleaving of the competing terminal paths exactly one caller
      // observes changes=1 — deterministically the same single winner
      // outcome, whoever it happens to be.
      const claimed = this.db.prepare(
        `INSERT OR IGNORE INTO factory_run_terminal_event_receipts
            (lifecycle_run_id, status, terminal_status)
          VALUES (?, ?, ?)`,
      ).run(lifecycleRunId, row.status, row.terminal_status);
      return {
        claimed: claimed.changes === 1,
        status: row.status,
        terminalStatus: row.terminal_status,
      };
    });
  }

  private verifyStageCommand(command: EnsureLifecycleStageRunCommand): void {
    if (sha256Hex(command.inputPayload) !== command.inputHash) {
      throw new Error('LIFECYCLE_STAGE_INPUT_HASH_MISMATCH');
    }
    if (sha256Hex(JSON.parse(command.bindingSnapshot)) !== command.bindingHash) {
      throw new Error('LIFECYCLE_STAGE_BINDING_HASH_MISMATCH');
    }
  }

  private assertStageReplay(
    stage: StageRunRow,
    command: EnsureLifecycleStageRunCommand,
  ): void {
    if (
      stage.stage_id !== command.stageId
      || !sameRef(stage, command.moduleRef)
      || stage.binding_hash !== command.bindingHash
      || stage.input_schema !== command.inputSchema
      || stage.input_hash !== command.inputHash
    ) {
      throw new Error('LIFECYCLE_STAGE_REPLAY_BINDING_MISMATCH');
    }
  }

  private insertStageRun(command: EnsureLifecycleStageRunCommand): StageRunRow {
    const counters = this.db.prepare(
      `SELECT COALESCE(MAX(ordinal),0) AS max_ordinal,
              COALESCE(MAX(CASE WHEN stage_id=? THEN attempt ELSE 0 END),0) AS max_attempt
         FROM factory_stage_runs WHERE lifecycle_run_id=?`,
    ).get(command.stageId, command.lifecycleRunId) as {
      max_ordinal: number;
      max_attempt: number;
    };
    const info = this.db.prepare(
      `INSERT INTO factory_stage_runs
        (lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
         module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
         input_hash,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'created')`,
    ).run(
      command.lifecycleRunId,
      counters.max_ordinal + 1,
      command.stageId,
      counters.max_attempt + 1,
      command.moduleRef.name,
      command.moduleRef.version,
      `${command.moduleRef.name}@${command.moduleRef.version}`,
      command.bindingSnapshot,
      command.bindingHash,
      command.inputSchema,
      canonicalJson(command.inputPayload),
      command.inputHash,
    );
    return this.readStageRow(Number(info.lastInsertRowid));
  }

  private requireLease(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
  ): LifecycleRunRow {
    const row = this.db.prepare(
      `SELECT * FROM factory_lifecycle_runs
        WHERE id=? AND execution_lease_owner=? AND execution_lease_fence=?
          AND julianday(execution_lease_expires_at)>julianday('now')
          AND status NOT IN ('completed','failed','cancelled')`,
    ).get(lifecycleRunId, lease.owner, lease.fence) as LifecycleRunRow | undefined;
    if (!row) throw new Error('LIFECYCLE_LEASE_LOST');
    return row;
  }

  private readRunRow(id: number): LifecycleRunRow {
    const row = this.db.prepare(
      'SELECT * FROM factory_lifecycle_runs WHERE id=?',
    ).get(id) as LifecycleRunRow | undefined;
    if (!row) throw new Error(`saga3: lifecycle_run ${id} not found`);
    return row;
  }

  private readStageRow(id: number): StageRunRow {
    const row = this.db.prepare(
      'SELECT * FROM factory_stage_runs WHERE id=?',
    ).get(id) as StageRunRow | undefined;
    if (!row) throw new Error(`saga3: stage_run ${id} not found`);
    return row;
  }

  private transaction<T>(work: () => T): T {
    const ownsTransaction = !this.db.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      }
      throw error;
    }
  }
}
