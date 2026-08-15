/**
 * SQLite implementation of ProcessRunRepository.
 *
 * Schema lives in factory_process_runs. The idempotency key is scoped to
 * (project_id, module_name, module_version, idempotency_key): one key names
 * exactly one ProcessRun per (project, module). A replay of the same start
 * command returns the existing row (replayed=true). A second start that
 * reuses the same idempotency_key but presents a DIFFERENT input_hash throws
 * IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT — the caller must never silently
 * swap the input under a stable key.
 *
 * Write-once terminal fields (local_outcome, output_*, certificate_*) are
 * enforced by an UPDATE guard: the SET clause only assigns them when the
 * existing value IS NULL. This means a second update on a completed run that
 * tries to change outcome throws (no row affected → caller sees the unchanged
 * record). Combined with assertTransitionAllowed, this implements "terminal
 * rows are immutable on outcome/output/certificate".
 *
 * The persistence layer is intentionally minimal: it does not validate that
 * the module is registered, does not validate input against a schema, does
 * not invoke any executor. Those responsibilities belong to the runtime/
 * application layer (process_run_start handler).
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import {
  processModuleKey,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import {
  assertTransitionAllowed,
  isTerminalStatus,
  type ProcessRunRepository,
} from './process-run-repository.js';
import type {
  ExecutorKind,
  ProcessRunRecord,
  ProcessRunStatus,
  StartProcessModuleCommand,
  UpdateProcessRunInput,
} from './process-run.js';

/**
 * Create the factory_process_runs table + indexes. Idempotent — safe to call on
 * every repository construction and at the top of any handler that touches
 * the table. Mirrors ensureFactorySettlementSchema style.
 */
export function ensureFactoryProcessRunSchema(db: Database.Database): void {
  db.exec(`
    -- Generic envelope around one Process Module execution. Lives ALONGSIDE
    -- module-specific state (WorkIntent/Proposal for discovery, PRD/UC/AC/SRS
    -- for formalization) — never replaces it.
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id                  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id                     INTEGER,                            -- nullable: project-wide run
      module_name                 TEXT NOT NULL,
      module_version              TEXT NOT NULL,
      module_ref_key              TEXT NOT NULL,                      -- '${'<name>@<version>'}'
      idempotency_key             TEXT NOT NULL,                      -- caller-supplied
      executor_kind               TEXT NOT NULL
                                    CHECK (executor_kind IN ('module-adapter','generic-flow','external','human')),
      input_schema                TEXT NOT NULL,                      -- module input contract id
      input_snapshot              TEXT NOT NULL,                      -- canonical JSON of payload
      input_hash                  TEXT NOT NULL,                      -- SHA-256 over input_snapshot
      projected_stage             TEXT,
      status                      TEXT NOT NULL DEFAULT 'created'
                                    CHECK (status IN ('created','preparing','running','paused','settling','completed','failed','cancelled')),
      local_outcome               TEXT,                               -- module-local outcome, terminal-only
      authority                   TEXT,                               -- terminal issuer/policy, write-once
      output_schema               TEXT,
      output_ref                  TEXT,
      output_hash                 TEXT,
      certificate_schema          TEXT,
      certificate_ref             TEXT,
      certificate_hash            TEXT,
      executor_run_ref            TEXT,                               -- internal run ref (e.g. WorkIntent id)
      active_recovery_case_id     INTEGER,
      active_issue_ref            TEXT,
      active_issue_hash           TEXT,
      execution_lease_owner       TEXT,
      execution_lease_expires_at  TEXT,
      error                       TEXT,
      started_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at                TEXT,
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Idempotency: one ProcessRun per (project_id, module_name,
    -- module_version, idempotency_key). The idempotency_key is the stable
    -- caller-chosen name for this run WITHIN (project, module). A replay with
    -- the SAME input_hash returns the existing row; a replay with a DIFFERENT
    -- input_hash is rejected by the application layer (see start() below) with
    -- IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT. The CHECK-free unique index
    -- here only enforces uniqueness; the input-equality rule is a domain
    -- invariant validated in code so the error carries the offending hashes.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_process_runs_idem
      ON factory_process_runs(project_id, module_name, module_version, idempotency_key);

    -- Lookups by project + epic (the dashboard/board view uses this).
    CREATE INDEX IF NOT EXISTS idx_factory_process_runs_project
      ON factory_process_runs(project_id, epic_id, status);

    -- Lookups by status (orchestrator scans running/paused runs to resume).
    CREATE INDEX IF NOT EXISTS idx_factory_process_runs_status
      ON factory_process_runs(status, updated_at);
  `);
  const columns = db.prepare('PRAGMA table_info(factory_process_runs)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'execution_lease_owner')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN execution_lease_owner TEXT');
  }
  if (!columns.some(column => column.name === 'execution_lease_expires_at')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN execution_lease_expires_at TEXT');
  }
  if (!columns.some(column => column.name === 'authority')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN authority TEXT');
  }
  if (!columns.some(column => column.name === 'active_recovery_case_id')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN active_recovery_case_id INTEGER');
  }
  if (!columns.some(column => column.name === 'active_issue_ref')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN active_issue_ref TEXT');
  }
  if (!columns.some(column => column.name === 'active_issue_hash')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN active_issue_hash TEXT');
  }
  // Wave 2 (W2-A2, spec §3.2) — pin ProcessRuns to their installation. Both
  // application code, not schema, until Wave 11 hardens NOT NULL). These two
  // ALTERs mirror the column-add block above; W2-A2 (single SQL owner, plan
  // §0.5.2 / C083) owns them and ALSO places defensive copies in db.ts for the
  // existing-DB upgrade path. See db.ts `tableExists` guard for the dual
  // placement rationale (factory_process_runs is created lazily here, not by
  // SCHEMA_SQL — spec §3.2 assumed otherwise).
  if (!columns.some(column => column.name === 'installation_id')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN installation_id INTEGER');
  }
  if (!columns.some(column => column.name === 'package_digest')) {
    db.exec('ALTER TABLE factory_process_runs ADD COLUMN package_digest TEXT');
  }
}

interface ProcessRunRow {
  id: number;
  project_id: number;
  epic_id: number | null;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  idempotency_key: string;
  executor_kind: ExecutorKind;
  input_schema: string;
  input_snapshot: string;
  input_hash: string;
  projected_stage: string | null;
  status: ProcessRunStatus;
  installation_id: number | null;
  package_digest: string | null;
  local_outcome: string | null;
  authority: string | null;
  output_schema: string | null;
  output_ref: string | null;
  output_hash: string | null;
  certificate_schema: string | null;
  certificate_ref: string | null;
  certificate_hash: string | null;
  executor_run_ref: string | null;
  active_recovery_case_id: number | null;
  active_issue_ref: string | null;
  active_issue_hash: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ProcessRunRow): ProcessRunRecord {
  const moduleRef: ProcessModuleReference = {
    name: row.module_name,
    version: row.module_version,
  };
  return {
    id: row.id,
    moduleRef,
    moduleRefKey: row.module_ref_key,
    projectId: row.project_id,
    epicId: row.epic_id,
    idempotencyKey: row.idempotency_key,
    executorKind: row.executor_kind,
    inputSchema: row.input_schema,
    inputSnapshot: row.input_snapshot,
    inputHash: row.input_hash,
    projectedStage: row.projected_stage,
    status: row.status,
    installationId: row.installation_id,
    packageDigest: row.package_digest,
    localOutcome: row.local_outcome,
    authority: row.authority,
    outputSchema: row.output_schema,
    outputRef: row.output_ref,
    outputHash: row.output_hash,
    certificateSchema: row.certificate_schema,
    certificateRef: row.certificate_ref,
    certificateHash: row.certificate_hash,
    executorRunRef: row.executor_run_ref,
    activeIssue: row.active_recovery_case_id === null
      || row.active_issue_ref === null
      || row.active_issue_hash === null
      ? null
      : {
          recoveryCaseId: row.active_recovery_case_id,
          issueRef: row.active_issue_ref,
          issueHash: row.active_issue_hash,
        },
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readRowById(db: Database.Database, id: number): ProcessRunRow | null {
  const row = db.prepare('SELECT * FROM factory_process_runs WHERE id=?')
    .get(id) as ProcessRunRow | undefined;
  return row ?? null;
}

/**
 * Concrete SQLite implementation. Construction is cheap; the schema is created
 * on first use (idempotent IF NOT EXISTS). Production wires one instance in the
 * composition root; tests construct one against an in-memory or temp DB.
 */
export class SqliteProcessRunRepository implements ProcessRunRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryProcessRunSchema(this.db);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  start(command: StartProcessModuleCommand): { record: ProcessRunRecord; replayed: boolean } {
    if (this.db.inTransaction) {
      return this.startReserved(command);
    }
    return this.db.transaction(
      () => this.startReserved(command),
    ).immediate();
  }

  private startReserved(
    command: StartProcessModuleCommand,
  ): { record: ProcessRunRecord; replayed: boolean } {
    const moduleRefKey = processModuleKey(command.moduleRef);
    const inputSnapshot = canonicalJson(command.input.payload);
    const computedInputHash = sha256Hex(command.input.payload);
    const ctx = command.invocationContext;
    if (computedInputHash !== command.input.contentHash) {
      throw new Error(
        `PROCESS_RUN_INPUT_HASH_MISMATCH: supplied input_hash='${command.input.contentHash}' `
        + `does not match canonical payload hash='${computedInputHash}' for ${moduleRefKey}`,
      );
    }
    // Normalize the Wave 2 installation pin so absent (undefined) values — from
    // pre-Wave-3 callers that do not yet know about the two fields — behave
    // replay-equality and INSERT binding byte-stable across the cutover: a row
    // stored with NULL installation_id stays equal to a replay command that
    // omits the field entirely. W3-A3, spec §6.
    const installationId = command.installationId ?? null;
    const packageDigest = command.packageDigest ?? null;

    // Look up any existing run for (project, module, idempotency_key). The
    // idempotency_key names the run; input_hash is the input it was started
    // with. Same key + same input → replay. Same key + different input →
    // domain violation (the caller is trying to swap the input under a stable
    // name). Different key → brand-new run.
    const existing = this.db.prepare(
      `SELECT * FROM factory_process_runs
        WHERE project_id=? AND module_name=? AND module_version=? AND idempotency_key=?`,
    ).get(ctx.projectId, command.moduleRef.name, command.moduleRef.version, ctx.idempotencyKey) as ProcessRunRow | undefined;

    if (existing) {
      const sameInvocation = existing.input_hash === computedInputHash
        && existing.input_schema === command.input.schema
        && existing.module_ref_key === moduleRefKey
        && existing.executor_kind === command.executorKind
        && existing.projected_stage === command.projectedStage
        && existing.epic_id === ctx.epicId
        && existing.installation_id === installationId
        && existing.package_digest === packageDigest;
      if (!sameInvocation) {
        throw new Error(
          `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT: idempotency_key='${ctx.idempotencyKey}' `
          + `is already bound to a different immutable invocation for `
          + `${moduleRefKey} in project ${ctx.projectId}`,
        );
      }
      return { record: rowToRecord(existing), replayed: true };
    }

    const info = this.db.prepare(
      `INSERT INTO factory_process_runs
         (project_id, epic_id, module_name, module_version, module_ref_key,
          idempotency_key, executor_kind, input_schema, input_snapshot,
          input_hash, projected_stage, status, installation_id, package_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'created',?,?)`,
    ).run(
      ctx.projectId,
      ctx.epicId,
      command.moduleRef.name,
      command.moduleRef.version,
      moduleRefKey,
      ctx.idempotencyKey,
      command.executorKind,
      command.input.schema,
      inputSnapshot,
      computedInputHash,
      command.projectedStage,
      installationId,
      packageDigest,
    );
    const row = readRowById(this.db, Number(info.lastInsertRowid));
    if (!row) throw new Error('saga3: process_run vanished after insert');
    return { record: rowToRecord(row), replayed: false };
  }

  read(id: number): ProcessRunRecord | null {
    const row = readRowById(this.db, id);
    return row ? rowToRecord(row) : null;
  }

  readByIdempotencyKey(
    projectId: number,
    moduleRefKey: string,
    idempotencyKey: string,
  ): ProcessRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_process_runs
        WHERE project_id=? AND module_ref_key=? AND idempotency_key=?`,
    ).get(projectId, moduleRefKey, idempotencyKey) as ProcessRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(projectId: number, epicId: number | null): readonly ProcessRunRecord[] {
    const rows = epicId === null
      ? this.db.prepare(
          'SELECT * FROM factory_process_runs WHERE project_id=? ORDER BY id DESC',
        ).all(projectId) as ProcessRunRow[]
      : this.db.prepare(
          'SELECT * FROM factory_process_runs WHERE project_id=? AND epic_id=? ORDER BY id DESC',
        ).all(projectId, epicId) as ProcessRunRow[];
    return rows.map(rowToRecord);
  }

  acquireExecutionLease(
    id: number,
    owner: string,
    nowIso: string,
    expiresAtIso: string,
  ): boolean {
    const info = this.db.prepare(
      `UPDATE factory_process_runs
          SET execution_lease_owner=?,
              execution_lease_expires_at=?,
              updated_at=datetime('now')
        WHERE id=?
          AND status NOT IN ('completed','failed','cancelled')
          AND (
            execution_lease_owner IS NULL
            OR execution_lease_owner=?
            OR execution_lease_expires_at IS NULL
            OR julianday(execution_lease_expires_at)<=julianday(?)
          )`,
    ).run(owner, expiresAtIso, id, owner, nowIso);
    return info.changes === 1;
  }

  renewExecutionLease(id: number, owner: string, expiresAtIso: string): boolean {
    const info = this.db.prepare(
      `UPDATE factory_process_runs
          SET execution_lease_expires_at=?,
              updated_at=datetime('now')
        WHERE id=?
          AND execution_lease_owner=?
          AND execution_lease_expires_at IS NOT NULL
          AND julianday(execution_lease_expires_at)>julianday('now')
          AND status NOT IN ('completed','failed','cancelled')`,
    ).run(expiresAtIso, id, owner);
    return info.changes === 1;
  }

  releaseExecutionLease(id: number, owner: string): void {
    this.db.prepare(
      `UPDATE factory_process_runs
          SET execution_lease_owner=NULL,
              execution_lease_expires_at=NULL,
              updated_at=datetime('now')
        WHERE id=? AND execution_lease_owner=?`,
    ).run(id, owner);
  }

  update(id: number, input: UpdateProcessRunInput): ProcessRunRecord {
    const current = readRowById(this.db, id);
    if (!current) throw new Error(`saga3: process_run ${id} not found`);

    // If a status transition is requested, validate it BEFORE any write.
    if (input.status !== undefined && input.status !== current.status) {
      assertTransitionAllowed(current.status, input.status);
    }

    // Terminal rows are write-once on outcome/output/certificate. The UPDATE
    // uses a guard so that a value already set can only be set again to itself.
    if (isTerminalStatus(current.status)) {
      if (input.localOutcome !== undefined && input.localOutcome !== current.local_outcome) {
        throw new Error(
          `saga3: process_run ${id} is terminal (${current.status}); local_outcome cannot change`,
        );
      }
      if (input.authority !== undefined && input.authority !== current.authority) {
        throw new Error(
          `saga3: process_run ${id} is terminal (${current.status}); authority cannot change`,
        );
      }
      if (input.output !== undefined) {
        const want = input.output;
        const matches = want === null
          ? current.output_schema === null
            && current.output_ref === null
            && current.output_hash === null
          : want.schema === current.output_schema
            && want.artifactRef === current.output_ref
            && want.contentHash === current.output_hash;
        if (!matches) {
          throw new Error(
            `saga3: process_run ${id} is terminal (${current.status}); output cannot change`,
          );
        }
      }
      if (input.certificate !== undefined) {
        const want = input.certificate;
        const matches = want === null
          ? current.certificate_schema === null
            && current.certificate_ref === null
            && current.certificate_hash === null
          : want.schema === current.certificate_schema
            && want.certificateRef === current.certificate_ref
            && want.certificateHash === current.certificate_hash;
        if (!matches) {
          throw new Error(
            `saga3: process_run ${id} is terminal (${current.status}); certificate cannot change`,
          );
        }
      }
      // Status change on a terminal row is forbidden — assertTransitionAllowed
      // already threw above when status differed. Just no-op here.
    }

    // Build the UPDATE. Use COALESCE-style guards so unset fields are ignored
    // and terminal-write-once is enforced by the SQL itself.
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const params: unknown[] = [];
    if (input.status !== undefined) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.localOutcome !== undefined) {
      // Only assign when currently NULL OR same value (write-once guard).
      sets.push('local_outcome = COALESCE(local_outcome, ?)');
      params.push(input.localOutcome);
    }
    if (input.authority !== undefined) {
      sets.push('authority = COALESCE(authority, ?)');
      params.push(input.authority);
    }
    if (input.output !== undefined) {
      if (input.output === null) {
        sets.push('output_schema = NULL', 'output_ref = NULL', 'output_hash = NULL');
      } else {
        // Guard: assign only if output_ref IS NULL (first write wins).
        sets.push('output_schema = COALESCE(output_schema, ?)');
        sets.push('output_ref = COALESCE(output_ref, ?)');
        sets.push('output_hash = COALESCE(output_hash, ?)');
        params.push(input.output.schema, input.output.artifactRef, input.output.contentHash);
      }
    }
    if (input.certificate !== undefined) {
      if (input.certificate === null) {
        sets.push('certificate_schema = NULL', 'certificate_ref = NULL', 'certificate_hash = NULL');
      } else {
        sets.push('certificate_schema = COALESCE(certificate_schema, ?)');
        sets.push('certificate_ref = COALESCE(certificate_ref, ?)');
        sets.push('certificate_hash = COALESCE(certificate_hash, ?)');
        params.push(input.certificate.schema, input.certificate.certificateRef, input.certificate.certificateHash);
      }
    }
    if (input.executorRunRef !== undefined) {
      sets.push('executor_run_ref = ?');
      params.push(input.executorRunRef);
    }
    if (input.activeIssue !== undefined) {
      if (input.activeIssue === null) {
        sets.push(
          'active_recovery_case_id = NULL',
          'active_issue_ref = NULL',
          'active_issue_hash = NULL',
        );
      } else {
        sets.push(
          'active_recovery_case_id = ?',
          'active_issue_ref = ?',
          'active_issue_hash = ?',
        );
        params.push(
          input.activeIssue.recoveryCaseId,
          input.activeIssue.issueRef,
          input.activeIssue.issueHash,
        );
      }
    }
    if (input.error !== undefined) {
      sets.push('error = ?');
      params.push(input.error);
    }
    if (input.completedAt !== undefined) {
      sets.push('completed_at = COALESCE(completed_at, ?)');
      params.push(input.completedAt);
    }
    // completed_at is auto-set when transitioning to a terminal status.
    if (input.status !== undefined && isTerminalStatus(input.status) && !input.completedAt) {
      sets.push('completed_at = COALESCE(completed_at, datetime(\'now\'))');
    }

    params.push(id, current.status);
    const info = this.db.prepare(
      `UPDATE factory_process_runs SET ${sets.join(', ')} WHERE id=? AND status=?`,
    ).run(...params);

    if (info.changes === 0) {
      const concurrent = readRowById(this.db, id);
      if (!concurrent) throw new Error(`saga3: process_run ${id} vanished during update`);
      throw new Error(
        `PROCESS_RUN_CONCURRENT_TRANSITION: process_run ${id} changed from `
        + `'${current.status}' to '${concurrent.status}' before this update committed`,
      );
    }
    const after = readRowById(this.db, id);
    if (!after) throw new Error(`saga3: process_run ${id} vanished during update`);
    return rowToRecord(after);
  }
}
