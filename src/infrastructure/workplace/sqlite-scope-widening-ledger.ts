/**
 * STAGE-13 — the scope-widening ledger and the contention decision
 * (docs/handoff/STAGE-13-AGENT-BRIEF.md TASK 1).
 *
 * Scope insufficiency is a LAWFUL outcome of a cell, not a defect of its
 * worker. Honest work against an estimate discovers the estimate was short;
 * the cure is a widening of the frozen write authority — issued by the same
 * authority discipline that froze it, never by the worker's own discretion.
 *
 * The ONE question this ledger answers is CONTENTION: "is the requested path
 * claimed by another LIVE cell?" That question is decidable in any domain.
 * The question it deliberately never asks is NECESSITY ("does the work
 * really need this path?") — that judgment is not available to the authority
 * before the implementation exists, and pretending otherwise reintroduces
 * the frozen guess this transition exists to remove.
 *
 * Material discipline (append-only, monotonic):
 *   - a request row records the declared need (worker-declared typed
 *     conclusion, or the cell's surviving path-outside-authority trajectory);
 *   - a grant row IS a new scope revision: `granted_scopes` carries the FULL
 *     frozen set at that revision — a superset of the prior authority, so the
 *     effective write authority of a task is its latest grant row, or the
 *     original carve when no grant exists;
 *   - a refusal row names every contending holder; the workplace then
 *     terminates honestly with a reason a human can act on.
 */

import type { SqlDatabasePort } from '../../application/ports/sql-database.js';
import { repositoryScopesOverlap } from '../../shared/repository-scope.js';

export type ScopeWideningSource = 'worker-declared' | 'cell-trajectory';
export type ScopeWideningRole = 'author' | 'reviewer';

export interface ContentionHolder {
  readonly workplaceRef: string;
  readonly taskId: number;
  readonly workKey: string;
  readonly scope: string;
}

export interface ScopeWideningRequestRow {
  readonly id: number;
  readonly event_kind: 'request';
  readonly workplace_ref: string;
  readonly task_id: number;
  readonly role: ScopeWideningRole;
  readonly source: ScopeWideningSource;
  readonly requested_scopes: string;
  readonly surviving_keys: string | null;
  readonly requested_by_execution: string | null;
}

export interface ScopeWideningDecision {
  readonly requestEventId: number;
  readonly granted: boolean;
  readonly holders: readonly ContentionHolder[];
  readonly grantedRevision?: number;
  readonly grantedScopes?: readonly string[];
}

const SCOPE_WIDENING_DDL = `
CREATE TABLE IF NOT EXISTS factory_scope_widening_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('request','grant','refusal')),
  workplace_ref TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  source TEXT NOT NULL CHECK (source IN ('worker-declared','cell-trajectory')),
  requested_scopes TEXT NOT NULL,
  surviving_keys TEXT,
  requested_by_execution TEXT,
  request_event_id INTEGER,
  holders TEXT,
  granted_revision INTEGER CHECK (granted_revision IS NULL OR granted_revision >= 1),
  granted_scopes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_scope_widening_events_task
  ON factory_scope_widening_events(task_id, event_kind, id);
CREATE INDEX IF NOT EXISTS idx_scope_widening_events_workplace
  ON factory_scope_widening_events(workplace_ref, id);

CREATE TRIGGER IF NOT EXISTS trg_scope_widening_events_no_update
BEFORE UPDATE ON factory_scope_widening_events BEGIN
  SELECT RAISE(ABORT, 'factory_scope_widening_events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_scope_widening_events_no_delete
BEFORE DELETE ON factory_scope_widening_events BEGIN
  SELECT RAISE(ABORT, 'factory_scope_widening_events are immutable');
END;
`;

export function ensureScopeWideningSchema(db: { exec(sql: string): unknown }): void {
  db.exec(SCOPE_WIDENING_DDL);
}

function parseStringArray(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Validate a worker-/trajectory-supplied scope string (fail closed). */
export function assertValidRequestedScope(scope: string): void {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new Error(`SCOPE_WIDENING_SCOPE_INVALID: ${JSON.stringify(scope)}`);
  }
  // Canonical repository-scope grammar: a trailing '/' is a directory scope.
  const normalized = scope.replace(/\\/g, '/').replace(/^\.\//, '');
  const directory = normalized.endsWith('/');
  const body = directory ? normalized.slice(0, -1) : normalized;
  if (!body || body.startsWith('/') || /^[A-Za-z]:\//.test(body)
    || body.includes('\0') || body.split('/').some(s => !s || s === '.' || s === '..')
    || body.toLocaleLowerCase('en-US') === '.git'
    || body.toLocaleLowerCase('en-US').startsWith('.git/')) {
    throw new Error(`SCOPE_WIDENING_SCOPE_INVALID: ${scope}`);
  }
}

export interface RecordRequestInput {
  readonly workplaceRef: string;
  readonly taskId: number;
  readonly role: ScopeWideningRole;
  readonly source: ScopeWideningSource;
  readonly requestedScopes: readonly string[];
  readonly survivingKeys?: readonly string[];
  readonly requestedByExecution?: string | null;
}

export class SqliteScopeWideningLedger {
  private schemaEnsured = false;

  constructor(private readonly db: SqlDatabasePort) {}

  /**
   * Lazy ensure: the table is created by SCHEMA_SQL on fresh DBs and by
   * db.ts on open; this guard covers exotic read-only surfaces and the
   * first write on a legacy DB. Reads are table-tolerant (a missing table
   * means "no widening has ever happened" — the truthful default).
   */
  private ensureSchemaOnce(): void {
    if (this.schemaEnsured) return;
    ensureScopeWideningSchema(this.db as unknown as { exec(sql: string): unknown });
    this.schemaEnsured = true;
  }

  /** Run a read, degrading to `fallback` when the ledger table is absent. */
  private readTolerant<T>(sql: string, params: readonly unknown[], fallback: T): T {
    try {
      return this.db.prepare(sql).get(...params) as T;
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return fallback;
      throw error;
    }
  }

  /** Append the request row. Returns its id. */
  recordRequest(input: RecordRequestInput): number {
    if (input.requestedScopes.length === 0) {
      throw new Error('SCOPE_WIDENING_REQUEST_EMPTY: requestedScopes must name at least one scope');
    }
    for (const scope of input.requestedScopes) assertValidRequestedScope(scope);
    this.ensureSchemaOnce();
    const info = this.db.prepare(
      `INSERT INTO factory_scope_widening_events
         (event_kind, workplace_ref, task_id, role, source, requested_scopes,
          surviving_keys, requested_by_execution)
       VALUES ('request', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workplaceRef,
      input.taskId,
      input.role,
      input.source,
      JSON.stringify([...new Set(input.requestedScopes)]),
      input.survivingKeys ? JSON.stringify(input.survivingKeys) : null,
      input.requestedByExecution ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  /** The latest request of this workplace that has no decision yet. */
  readPendingRequest(workplaceRef: string): ScopeWideningRequestRow | null {
    const row = this.readTolerant<ScopeWideningRequestRow | undefined>(
      `SELECT r.id, r.workplace_ref, r.task_id, r.role, r.source,
              r.requested_scopes, r.surviving_keys, r.requested_by_execution
         FROM factory_scope_widening_events r
        WHERE r.event_kind='request' AND r.workplace_ref=?
          AND NOT EXISTS (
            SELECT 1 FROM factory_scope_widening_events d
             WHERE d.event_kind IN ('grant','refusal') AND d.request_event_id=r.id
          )
        ORDER BY r.id DESC LIMIT 1`,
      [workplaceRef],
      undefined,
    );
    return row ?? null;
  }

  /**
   * CONTENTION — the only decision the carve authority makes. A requested
   * scope is refused iff another LIVE cell's frozen write authority (its
   * original carve union its own grants) overlaps it. "Live" = a nonterminal
   * workplace whose card is not cancelled/superseded. The requester itself
   * is excluded. Necessity is never evaluated.
   */
  findLiveContentionHolders(input: {
    readonly requesterWorkplaceRef: string;
    readonly requestedScopes: readonly string[];
  }): readonly ContentionHolder[] {
    const rows = this.db.prepare(
      `SELECT w.workplace_ref AS workplaceRef, w.work_key AS workKey,
              w.loop_state AS loopState, t.id AS taskId, t.status AS taskStatus,
              t.metadata AS metadata
         FROM factory_workplaces w
         JOIN tasks t ON t.workplace_ref = w.workplace_ref
        WHERE w.loop_state <> 'terminal'
          AND t.status <> 'cancelled'
          AND w.workplace_ref <> ?`,
    ).all(input.requesterWorkplaceRef) as Array<{
      workplaceRef: string;
      workKey: string;
      loopState: string;
      taskId: number;
      taskStatus: string;
      metadata: string;
    }>;
    const holders = new Map<string, ContentionHolder>();
    for (const row of rows) {
      const frozen = this.readFrozenScopesForTask(row.taskId, row.metadata);
      for (const held of frozen) {
        for (const requested of input.requestedScopes) {
          if (repositoryScopesOverlap(held, requested)) {
            const key = `${row.workplaceRef}:${held}`;
            if (!holders.has(key)) {
              holders.set(key, {
                workplaceRef: row.workplaceRef,
                taskId: row.taskId,
                workKey: row.workKey,
                scope: held,
              });
            }
          }
        }
      }
    }
    return [...holders.values()].sort((a, b) => a.workplaceRef.localeCompare(b.workplaceRef));
  }

  /**
   * Decide and append the decision row (grant or refusal) for a request.
   * The grant's full frozen set = the task's current effective scopes union
   * the requested scopes (monotonic superset by construction).
   */
  decide(input: {
    readonly request: Pick<ScopeWideningRequestRow,
      'id' | 'workplace_ref' | 'task_id' | 'role' | 'source' | 'requested_scopes'>;
  }): ScopeWideningDecision {
    const requested = parseStringArray(input.request.requested_scopes);
    const holders = this.findLiveContentionHolders({
      requesterWorkplaceRef: input.request.workplace_ref,
      requestedScopes: requested,
    });
    if (holders.length > 0) {
      this.db.prepare(
        `INSERT INTO factory_scope_widening_events
           (event_kind, workplace_ref, task_id, role, source, requested_scopes,
            request_event_id, holders)
         VALUES ('refusal', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.request.workplace_ref,
        input.request.task_id,
        input.request.role,
        input.request.source,
        input.request.requested_scopes,
        input.request.id,
        JSON.stringify(holders),
      );
      return { requestEventId: input.request.id, granted: false, holders };
    }
    const effective = this.readEffectiveChangeScopes(
      input.request.task_id,
      this.readOriginalScopes(input.request.task_id),
    );
    const grantedScopes = [...new Set([...effective, ...requested])].sort();
    const priorRevision = this.readTolerant<{ n: number }>(
      `SELECT COALESCE(MAX(granted_revision), 0) AS n
         FROM factory_scope_widening_events
        WHERE task_id=? AND event_kind='grant'`,
      [input.request.task_id],
      { n: 0 },
    );
    const revision = priorRevision.n + 1;
    this.ensureSchemaOnce();
    this.db.prepare(
      `INSERT INTO factory_scope_widening_events
         (event_kind, workplace_ref, task_id, role, source, requested_scopes,
          request_event_id, granted_revision, granted_scopes)
       VALUES ('grant', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.request.workplace_ref,
      input.request.task_id,
      input.request.role,
      input.request.source,
      input.request.requested_scopes,
      input.request.id,
      revision,
      JSON.stringify(grantedScopes),
    );
    return {
      requestEventId: input.request.id,
      granted: true,
      holders: [],
      grantedRevision: revision,
      grantedScopes,
    };
  }

  /** The task's original frozen scopes from its carve (tasks.metadata). */
  readOriginalScopes(taskId: number): readonly string[] {
    const row = this.db.prepare(
      'SELECT metadata FROM tasks WHERE id=?',
    ).get(taskId) as { metadata: string } | undefined;
    if (!row) return [];
    return this.parseOriginalScopes(row.metadata);
  }

  private parseOriginalScopes(metadata: string): readonly string[] {
    try {
      const item = (JSON.parse(metadata) as { cell_input_item?: unknown }).cell_input_item;
      if (!item || typeof item !== 'object') return [];
      const scopes = (item as { changeScopes?: unknown }).changeScopes;
      return Array.isArray(scopes)
        ? scopes.filter((s): s is string => typeof s === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * A task's CURRENT held authority (original carve union its own grants) —
   * what a live holder owns for contention purposes.
   */
  private readFrozenScopesForTask(taskId: number, metadata: string): readonly string[] {
    return this.readEffectiveChangeScopes(taskId, this.parseOriginalScopes(metadata));
  }

  /**
   * The task's CURRENT write authority: the latest grant's full frozen set,
   * or the original carve when no grant exists. This is what every scope
   * fence must consult — never the bare metadata carve.
   */
  readEffectiveChangeScopes(
    taskId: number,
    originalScopes: readonly string[],
  ): readonly string[] {
    const grant = this.readTolerant<{ granted_scopes: string } | undefined>(
      `SELECT granted_scopes FROM factory_scope_widening_events
        WHERE task_id=? AND event_kind='grant'
        ORDER BY granted_revision DESC LIMIT 1`,
      [taskId],
      undefined,
    );
    if (!grant) return [...originalScopes];
    const scopes = parseStringArray(grant.granted_scopes);
    // Defence in depth: a grant must never NARROW the original authority.
    return scopes.length > 0 ? scopes : [...originalScopes];
  }
}
