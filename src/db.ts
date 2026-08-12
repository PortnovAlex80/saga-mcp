import Database from 'better-sqlite3';
import { SCHEMA_SQL, ensureArtifactStorageKindColumn, ensureAcceptedAuthorityHeadTaskIdColumn, migrateSyntheticBriefsToDbNative, rebuildFactoryOrdersWithoutColumnUniques, rebuildLaunchIdempotencyIndex, migrateFactorySchemaV3ToV4, relaxFactoryLaunchStateForPaused } from './schema.js';
import { ensureFactoryModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';
import { ensureFactoryScenarioInstallationSchema } from './process-modules/installation/persistence/sqlite-scenario-installation-repository.js';
import { ensureFactoryProtocolRunSchema } from './process-modules/persistence/sqlite-protocol-run-repository.js';
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
 *
 * Pragmas: WAL (concurrent reader + writer), foreign_keys ON, busy_timeout
 * 5s (SQLite serializes all writes under a single writer), synchronous
 * NORMAL (safe under WAL).
 */

/** Increment when the schema changes incompatibly. */
const SCHEMA_VERSION = 6;

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
  const existingVersion = db.pragma('user_version', { simple: true }) as number;
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    console.warn(
      `[saga] DB at ${dbPath} has user_version=${existingVersion}, ` +
        `current schema is ${SCHEMA_VERSION}. ` +
        'The database will be opened as-is. If errors occur, a versioned ' +
        'migration is needed — do NOT delete the database.',
    );
  }

  // Core schema — all tables, columns, indexes, CHECK constraints.
  db.exec(SCHEMA_SQL);
  migrateFactorySchemaV3ToV4(db);
  // Replay-first cardinality (v3): rebuild factory_orders without the legacy
  // lifetime-UNIQUE on project_id/epic_id so one Project may own many
  // historical Factory Runs. No-op on fresh DBs (SCHEMA_SQL already correct).
  rebuildFactoryOrdersWithoutColumnUniques(db);
  // CONVEYOR v4.3 PART 8: durable start-command idempotency. Rebuild the
  // launch_requests idempotency index from partial-UNIQUE (active states only)
  // to full-UNIQUE (all states). No-op on fresh DBs.
  rebuildLaunchIdempotencyIndex(db);
  // Relax factory_launch_requests.state to accept 'paused' as a terminal-for-
  // this-launch state (the lifecycle suspended without converging — a typed
  // wait or genuine stall). Table-rebuild idiom; no-op on fresh DBs.
  relaxFactoryLaunchStateForPaused(db);
  // Additive migration: artifacts.storage_kind (file_backed | db_native |
  // external_ref). Fresh DBs get the column from CREATE TABLE; pre-existing
  // DBs created before this column get it added here with the safe default
  // 'file_backed'. The synthetic brief is repaired to db_native separately.
  ensureArtifactStorageKindColumn(db);
  // Additive migration (ADR-053 C5): factory_accepted_authority_head gains the
  // nullable accepted_author_task_id column carrying the workplace task whose
  // material the head accepted. Fresh DBs get it from CREATE TABLE; pre-v6 DBs
  // get it added here as NULL. No row reset.
  ensureAcceptedAuthorityHeadTaskIdColumn(db);
  // One-shot repair: promote synthetic auto-provisioned briefs (no physical
  // file, hash from canonical JSON) to db_native with content persisted in
  // metadata. Verified against the stored content_hash — never guesses.
  const briefMigration = migrateSyntheticBriefsToDbNative(db);
  if (briefMigration.migrated > 0) {
    console.warn(
      `[factory] migrated ${briefMigration.migrated} synthetic brief(s) to db_native `
        + `(inspected ${briefMigration.inspected}, skipped ${briefMigration.skipped})`,
    );
  }

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
  // worker_done enforces the exact frozen WorkIntent against this immutable
  // ledger even before the composition root is constructed.
  ensureManagedNodeSubmissionSchema(db);
  // ProtocolRun + CallInstance tables reference factory_process_runs, which is
  // created lazily by SqliteProcessRunRepository. On a fresh DB the table may
  // not exist yet — ensureFactory* guard internally on table existence.
  ensureFactoryProtocolRunSchema(db);
  ensureFactoryCallInstanceSchema(db);

  // Stamp only a fresh database or the exact predecessor produced/accepted by
  // the migrations above. Never stamp an unknown/future version as current:
  // doing so would launder an unexecuted migration into apparent success.
  const migratedVersion = db.pragma('user_version', { simple: true }) as number;
  if (migratedVersion === 0 || migratedVersion === 4 || migratedVersion === 5) {
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
