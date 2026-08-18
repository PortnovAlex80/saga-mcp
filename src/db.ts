import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { ensureFactoryModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';
import { ensureFactoryScenarioInstallationSchema } from './process-modules/installation/persistence/sqlite-scenario-installation-repository.js';
import { ensureFactoryProtocolRunSchema } from './process-modules/persistence/sqlite-protocol-run-repository.js';
import { ensureFactoryNodeRunSchema } from './process-modules/persistence/sqlite-node-run-repository.js';
import { ensureFactoryCallInstanceSchema } from './process-modules/persistence/sqlite-call-instance-repository.js';
import { ensureFactoryProcessRunSchema } from './process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedNodeSubmissionSchema } from './process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { initSubmissionRegistries } from './process-modules/application/submission-registries.js';

let db: Database.Database | null = null;

/**
 * Open (or return the cached) saga SQLite database.
 *
 * The schema is defined entirely in {@link SCHEMA_SQL} (schema.ts) and the
 * lazy `ensureFactory*Schema` calls below. This function is clean-foundation:
 * all migration sediment (ALTER TABLE try/catch blocks, table-rebuild
 * databases to migrate — the product has not shipped to clients.
 *
 * **DB compatibility policy:** disposable pre-release. `user_version` is
 * stamped on every fresh DB. If a DB with a mismatched version is opened,
 * the call warns but does NOT delete or block — saga is a governance
 * platform, the database IS the product (artifacts, traces, tasks,
 * evidence). When the schema changes, versioned migrations must handle the
 * upgrade.
 *
 * **SCHEMA_VERSION history:**
 *   1 = saga4 clean foundation.
 *   2 = Conveyor v4 additive layer (CONVEYOR-V4-MIGRATION-PLAN step 6):
 *       the 7 `factory_*` authoritative Workplace/CandidateSet/Gate tables plus
 *       4 immutability triggers are now a required part of the schema, and
 *       tables are retained as projections through the cutover window.
 *   3 = Replay-first cardinality (CONVEYOR v4.3 §7): drop lifetime UNIQUE on
 *       factory_orders.project_id/epic_id so one Project may own many
 *       historical Factory Runs. source_digest becomes provenance (non-unique).
 *       Applied via table rebuild for existing DBs.
 *   4 = append-only continuation, sealed Workplace DAG, managed source/effect
 *       receipts, and the effect_pending Workplace state.
 *   5 = factory_launch_requests.state accepts 'paused' as a terminal-for-this-
 *       launch state (lifecycle suspended without converging). Applied via
 *       table rebuild for existing DBs; relaxed CHECK + freed one-active slot.
 *   6 = ADR-053 C5 — the accepted-authority head persists the identity of the
 *       workplace task whose material it accepted (nullable
 *       `accepted_author_task_id` on factory_accepted_authority_head). Additive
 *       ADD COLUMN for existing DBs; no row reset. This is the carry-forward-
 *       safe task binding (commit 3c5decc): neither submission.task_id (origin
 *       process's task) nor ORDER BY t.id DESC (recency) is authority — the HEAD is.
 *   7 = ADR-053 C7-02 — the monotonic lease fence gets its own DURABLE, DISTINCT
 *       storage (nullable `lease_fence` on factory_transition_obligations),
 *       separate from the causal source revision on `fence`. Additive ADD COLUMN
 *       for existing DBs; no row reset. `lease` now writes the fence here
 *       monotonically (never decreasing) instead of overwriting the causal
 *       `fence` column. Storage + read/write only; atomic fence allocation is
 *       C7-03.
 *   8 = ADR-053 B-6 — explicit monotonic Workplace GateDecision head. The
 *       immutable decision rows remain unchanged; current repair authority is
 *       resolved by the head key instead of decided_at/rowid recency.
 *
 *   9 = ADR-053 executable-composition binding receipts. Each process role
 *       persists exact manifest and resolved implementation digests before work.
 *  10 = Gate presentation attempts freeze replay key/capsule/hash so later
 *       WorkerExecution metadata changes cannot rewrite Gate authority.
 *  11 = immutable post-acceptance effect repair issues bind exact accepted
 *       authority to feedback projected onto the replacement author desk.
 *  12 = ADR-075 (no-human quality loop): append-only
 *       factory_workplace_recovery_epochs table for recovery.onExhausted=
 *       'requeue' cells — each budget rollover snapshots the attempt-counter
 *       baselines; attempt counters themselves stay all-time and immutable.
 *  13 = Operator SOFT-STOP protocol: factory_worker_stops (per-execution typed
 *       stop audit with phase progression) + factory_operator_holds (unpark
 *       surface blocking re-hire until released) + additive worker_executions
 *       columns stop_fence/voided_at. The void state is audit-only
 *       (voided_at IS NOT NULL on a terminal state value); no existing CHECK
 *       constraint is widened.
 *  14 = Antifreeze layer C (engine supervisor): additive
 *       factory_launch_requests columns engine_log_path/engine_pid/
 *       engine_spawned_at (durable binding of the spawned engine host to its
 *       launch — the heartbeat/log markers become findable), the append-only
 *       factory_engine_watchdog_events audit table, the additive
 *       lifecycle_execution_controls.last_error (the WHY next to the state),
 *       and the ONE widened CHECK: lifecycle_execution_controls.engine_state
 *       accepts 'failed_watchdog' (restart-budget exhaustion must be visible,
 *       never silent). Applied via ADD COLUMN / table-rebuild for existing
 *       DBs; no row reset.
 *
 * Pragmas: WAL (concurrent reader + writer), foreign_keys ON, busy_timeout
 * 5s (SQLite serializes all writes under a single writer), synchronous
 * NORMAL (safe under WAL).
 */

/** Increment when the schema changes incompatibly. */
const SCHEMA_VERSION = 14;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error(
      'DB_PATH environment variable is required. Set it to the path of your .tracker.db file, e.g., DB_PATH=/path/to/project/.tracker.db'
    );
  }

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  // DB version stamp. user_version is set on fresh DBs and checked on reopen.
  // If the version differs, the system warns but does NOT delete or block —
  // saga is a governance platform, the database IS the product (artifacts,
  // traces, tasks, evidence). Deleting it is never the right answer.
  // When the schema changes, versioned migrations must handle the upgrade.
  // TASK C (legacy purge): the migration ladder is gone. A database is either
  // fresh (user_version 0, schema applied below) or exactly current. Anything
  // else fails closed with an actionable message — the operator opens the old
  // DB once with pre-purge code to migrate it to current, or starts a new DB.
  const existingVersion = db.pragma('user_version', { simple: true }) as number;
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    db.close();
    db = null;
    throw new Error(
      `FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: ${existingVersion}->${SCHEMA_VERSION}. `
        + 'The legacy migration ladder was removed (pre-production purge). '
        + 'Open this database once with a pre-purge build to migrate it, or '
        + 'point DB_PATH at a fresh database.',
    );
  }

  // Core schema — all tables, columns, indexes, CHECK constraints.
  db.exec(SCHEMA_SQL);

  // Mandatory node submission validation: register policy declarations +
  // validators for every LM-node. worker_done reads these to enforce the
  // domain contract at the submission boundary (shift-left), not post-hoc.
  initSubmissionRegistries(db);

  // Lazy schema for factory_* process-module tables. These are created here
  // (eagerly at DB-open time) AND in their respective repository constructors
  // (lazily). Both paths are idempotent (CREATE TABLE IF NOT EXISTS).
  ensureFactoryModuleInstallationSchema(db);
  ensureFactoryScenarioInstallationSchema(db);
  // Assignment admission joins the owning ProcessRun to prevent terminal
  // ancestor cards from being claimed. The table is therefore core runtime
  // schema, not merely a lazy orchestrator detail.
  ensureFactoryProcessRunSchema(db);
  // TB-1: factory_protocol_runs (created above by ensureFactoryProtocolRunSchema)
  // carries `node_run_id REFERENCES factory_node_runs(id)`, but this table was
  // only created lazily by the SqliteNodeRunRepository constructor. A DB opened
  // without the runtime constructed (testbed cleanup, operator scripts) had no
  // factory_node_runs, and SQLite resolves the FK parent when compiling the
  // DELETE cascade program — so even `DELETE FROM projects WHERE id=-999` threw
  // 'no such table: main.factory_node_runs'. Creating it eagerly is idempotent
  // (CREATE TABLE IF NOT EXISTS) and a no-op for existing DBs.
  ensureFactoryNodeRunSchema(db);
  // worker_done enforces the exact frozen WorkIntent against this immutable
  // ledger even before the composition root is constructed.
  ensureManagedNodeSubmissionSchema(db);
  // ProtocolRun + CallInstance tables reference factory_process_runs, which is
  // created lazily by SqliteProcessRunRepository. On a fresh DB the table may
  // not exist yet — ensureFactory* guard internally on table existence.
  ensureFactoryProtocolRunSchema(db);
  ensureFactoryCallInstanceSchema(db);

  // A fresh database (user_version 0 before exec) is stamped current. Any
  // other value was either already current (accepted above) or rejected.
  const migratedVersion = db.pragma('user_version', { simple: true }) as number;
  if (migratedVersion === 0) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (migratedVersion !== SCHEMA_VERSION) {
    throw new Error(
      `FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: ${migratedVersion}->${SCHEMA_VERSION}`,
    );
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
