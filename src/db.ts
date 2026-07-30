import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { backfillWorkItemShadow } from './lifecycle/backfill-migration.js';
import { ensureSaga3ModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';
import { ensureSaga3ScenarioInstallationSchema } from './process-modules/installation/persistence/sqlite-scenario-installation-repository.js';
import { ensureSaga3ProtocolRunSchema } from './process-modules/persistence/sqlite-protocol-run-repository.js';
import { ensureSaga3CallInstanceSchema } from './process-modules/persistence/sqlite-call-instance-repository.js';

let db: Database.Database | null = null;

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

  db.exec(SCHEMA_SQL);

  // Migrations for existing databases
  try { db.exec('ALTER TABLE tasks ADD COLUMN source_ref TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE epics ADD COLUMN branch TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN task_kind TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN workflow_stage TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN execution_skill TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN review_skill TEXT'); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'git_change' CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive'))"); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL'); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN integration_state TEXT NOT NULL DEFAULT 'not_required' CHECK (integration_state IN ('not_required','pending','merged','conflict'))"); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN integrated_at TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN integrated_commit TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN generated_from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN generation_key TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN current_execution_id TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN verification_target_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE artifacts ADD COLUMN project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE artifacts ADD COLUMN content_hash TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE artifacts ADD COLUMN accepted_hash TEXT'); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE artifacts ADD COLUMN drift_state TEXT NOT NULL DEFAULT 'unknown' CHECK (drift_state IN ('unknown','clean','drifted'))"); } catch { /* column already exists */ }
  migrateArtifactTypes(db);
  try { db.exec("ALTER TABLE artifacts ADD COLUMN evidence_status TEXT CHECK (evidence_status IN ('confirmed','proposed','assumed','open','rejected','superseded') OR evidence_status IS NULL)"); } catch { /* column already exists */ }
  migrateTracesLinkType(db);
  migrateVerificationOutcome(db);
  migrateVerificationExecution(db);
  migrateRiskClass(db);
  migrateEpisodeTrack(db);
  migrateEpicSlug(db);
  // Slice 2 (ADR-011): populate work-item shadow tables for existing tasks.
  // Idempotent — skips tasks that already have shadow rows. Tables themselves
  // are created by SCHEMA_SQL (CREATE IF NOT EXISTS).
  backfillWorkItemShadow(db);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch { /* index already exists */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON project_repositories(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_repositories_repo ON project_repositories(repository_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_repository_status ON tasks(project_repository_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(workflow_stage);
    CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(task_kind);
    CREATE INDEX IF NOT EXISTS idx_tasks_generated_from ON tasks(generated_from_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_current_execution ON tasks(current_execution_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_verification_target ON tasks(verification_target_artifact_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_drift ON artifacts(epic_id, drift_state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_generation_key
      ON tasks(epic_id, generation_key) WHERE generation_key IS NOT NULL;
  `);

  // Migration: add 'review_in_progress' status. SQLite CHECK constraints cannot
  // be altered in-place, so we detect the old schema (status lacks the new value)
  // and rebuild the tasks table with the updated CHECK. Concurrent-safe under the
  // single-writer assumption at startup. Existing rows with status='review' AND
  // assigned_to NOT NULL (reviewer was working) become 'review_in_progress'.
  migrateReviewInProgress(db);
  migrateVerificationTargets(db);

  // P6c: extend the execution_mode CHECK to include 'artifact_change'
  // (declared by Formalization execution profiles). Required before the generic
  // flow executor can project Formalization tasks.
  migrateExecutionModeArtifactChange(db);

  // Wave 2 (W2-A2, spec §3) — immutable Process Module installations.
  // W2-A2 is the SINGLE SQL owner this wave (plan §0.5.2, C083). Creates the
  // saga3_module_installations table + the partial UNIQUE index that enforces
  // version immutability (at most one active row per (name, version)). NO
  // ON DELETE SET NULL (plan §5.5.9). Idempotent (CREATE IF NOT EXISTS).
  ensureSaga3ModuleInstallationSchema(db);

  // Wave 7 (W7-A1, spec WAVE7-SCENARIO-SPEC.md Lanes row W7-A1) — immutable
  // Lifecycle Scenario installations + per-stage scenario module locks. W7-A1
  // is the SINGLE SQL owner for these two tables this wave (C083). Creates
  // saga3_scenario_installations + saga3_scenario_module_locks. The scenario
  // installations table carries the partial UNIQUE active index (scenario
  // version immutability, mirrors W2-A2 §4); the module locks table UNIQUE-
  // indexes (scenario_installation_id, stage_id) so the lock is one durable
  // pin per stage (plan §6.6-6.7). DUAL-PLACEMENT mirrors the Wave 2/3/4/5
  // pattern: the tables are created LAZILY by ensureSaga3ScenarioInstallationSchema
  // (called from the SqliteScenarioInstallationRepository constructor) AND here
  // (the upgrade path for pre-existing DBs). The call is placed AFTER
  // ensureSaga3ModuleInstallationSchema because saga3_scenario_module_locks
  // REFERENCES saga3_module_installations(id); on any DB where the parent
  // already exists (it does — the line above just ran), the FK target is
  // present. CREATE TABLE IF NOT EXISTS makes the second placement a no-op, so
  // both paths are idempotent. NO ON DELETE SET NULL on the installation
  // (plan §5.5.9); the module-locks table uses ON DELETE CASCADE
  // (defence-in-depth, never triggered — there is no installation delete path).
  ensureSaga3ScenarioInstallationSchema(db);

  // Wave 2 (W2-A2, spec §3.2) — pin ProcessRuns to their installation.
  // Both columns nullable: legacy pre-Wave-2 runs leave them NULL and route
  // through the legacy adapter (W2-A4). New Wave-2+ runs MUST set both
  // (enforced in application code, not schema, until Wave 11 hardens NOT NULL).
  //
  // NOTE: saga3_process_runs is created LAZILY by ensureSaga3ProcessRunSchema
  // (in persistence/sqlite-process-run-repository.ts), NOT by SCHEMA_SQL. On a
  // fresh DB the table does not exist yet at this point, so these ALTERs are
  // guarded on table existence (clean no-op on fresh DB). The columns are ALSO
  // added inside ensureSaga3ProcessRunSchema via its existing column-add block —
  // that is the place that reliably runs when the table springs into existence,
  // and the established pattern for this table's columns. This dual placement is
  // the resolution to a spec ambiguity (spec §3.2 assumed the table is in
  // SCHEMA_SQL; it is not) and is documented for the integrator.
  if (tableExists(db, 'saga3_process_runs')) {
    try { db.exec('ALTER TABLE saga3_process_runs ADD COLUMN installation_id INTEGER'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_process_runs ADD COLUMN package_digest TEXT'); } catch { /* column already exists */ }
  }

  // Wave 3 (W3-A6, spec §9) — NodeRun v2 additive columns. W3-A6 is the SINGLE
  // SQL owner for saga3_node_runs this wave (C083). Seven nullable columns +
  // one resume index, all ADDITIVE (no NOT NULL — Wave 11 hardens; no legacy
  // column removed). DUAL-PLACEMENT mirrors the saga3_process_runs pattern
  // above (spec §3.2): saga3_node_runs is created LAZILY by
  // ensureSaga3NodeRunSchema (in persistence/sqlite-node-run-repository.ts),
  // NOT by SCHEMA_SQL, so on a fresh DB the table does not exist yet here and
  // these ALTERs are guarded on table existence (clean no-op on fresh DB).
  // The columns are ALSO added inside ensureSaga3NodeRunSchema — that is the
  // place that reliably runs when the table springs into existence. Both
  // placements are idempotent (PRAGMA table_info check / try-catch), so the
  // second one to run is a no-op. The index is created in both places too
  // (CREATE UNIQUE INDEX IF NOT EXISTS).
  if (tableExists(db, 'saga3_node_runs')) {
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN input_envelope_hash TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN node_ref TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN package_ref TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN predecessor_node_run_ids TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN definition_digest TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN transition_cursor TEXT'); } catch { /* column already exists */ }
    try { db.exec('ALTER TABLE saga3_node_runs ADD COLUMN production_envelope TEXT'); } catch { /* column already exists */ }
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_node_runs_exact_cursor
          ON saga3_node_runs(process_run_id, node_id, attempt);
      `);
    } catch { /* index already exists */ }
  }

  // Wave 4 (W4-A1, spec §2) — ProtocolRun + ProtocolStepRun tables. W4-A1 is
  // the SINGLE SQL owner this wave (C083). Two ADDITIVE tables
  // (saga3_protocol_runs + saga3_protocol_step_runs) with the partial UNIQUE
  // active-run index + the step-ledger UNIQUE(protocol_run_id, step_id,
  // attempt). DUAL-PLACEMENT mirrors the Wave 2/3 pattern (spec §2: "Dual-
  // placement in db.ts (guarded tableExists) + ensureSaga3ProtocolRunSchema"):
  // the tables are created LAZILY by ensureSaga3ProtocolRunSchema (called from
  // the SqliteProtocolRunRepository constructor) AND here (the upgrade path for
  // pre-existing DBs). The call is guarded on saga3_process_runs existing
  // because saga3_protocol_runs REFERENCES it; on a fresh DB where the parent
  // table does not yet exist, the FK target is absent and we defer creation to
  // the lazy constructor path. CREATE TABLE IF NOT EXISTS makes the second
  // placement a no-op, so both paths are idempotent.
  if (tableExists(db, 'saga3_process_runs')) {
    ensureSaga3ProtocolRunSchema(db);
  }

  // Wave 5 (W5-A2, spec §2) — CallInstance table. W5-A2 is the SINGLE SQL
  // owner this wave (C083). One ADDITIVE table (saga3_call_instances) with the
  // status CHECK enum (materialized/edited/validated/submitted/succeeded/
  // failed/sealed/abandoned) and the step-ledger index. DUAL-PLACEMENT mirrors
  // the Wave 2/3/4 pattern (spec §2 "Dual-placement in db.ts"): the table is
  // created LAZILY by ensureSaga3CallInstanceSchema (called from the
  // SqliteCallInstanceRepository constructor) AND here (the upgrade path for
  // pre-existing DBs). The call is guarded on saga3_process_runs existing
  // because saga3_call_instances REFERENCES it; on a fresh DB where the parent
  // table does not yet exist, the FK target is absent and we defer creation to
  // the lazy constructor path. CREATE TABLE IF NOT EXISTS makes the second
  // placement a no-op, so both paths are idempotent.
  if (tableExists(db, 'saga3_process_runs')) {
    ensureSaga3CallInstanceSchema(db);
  }

  return db;
}

/** True iff a base table named `name` exists in sqlite_master. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  return row !== undefined;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Detect whether the tasks table already accepts the 'review_in_progress' status.
 * If the CHECK constraint is the old one (lacks this value), rebuild the table
 * with the updated CHECK and migrate rows in 'review' that have an assigned_to
 * (reviewer was actively working) to 'review_in_progress'.
 *
 * Detection: try to validate by inspecting sqlite_schema — the new CHECK string
 * contains 'review_in_progress'. Cheaper than a trial INSERT that could leave
 * side effects. Falls back gracefully if anything is unexpected.
 */
function migrateReviewInProgress(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return; // table doesn't exist yet (fresh DB) — SCHEMA_SQL will create it correctly

  // Already migrated?
  if (row.sql.includes('review_in_progress')) return;

  // Old schema detected. Rebuild tasks with updated CHECK.
  // NOTE: SQLite table rebuild — preserve all columns, indexes are recreated by SCHEMA_SQL IF NOT EXISTS.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    // Snapshot original DDL columns by reading pragma table_info — we rebuild
    // with explicit columns matching the current schema.ts definition.
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked')),
        priority TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high', 'critical')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT,
        current_execution_id TEXT,
        verification_target_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
        estimated_hours REAL,
        actual_hours REAL,
        due_date TEXT,
        source_ref TEXT,
        task_kind TEXT,
        workflow_stage TEXT,
        execution_skill TEXT,
        review_skill TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'git_change'
              CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive','artifact_change')),
        project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL,
        integration_state TEXT NOT NULL DEFAULT 'not_required'
              CHECK (integration_state IN ('not_required','pending','merged','conflict')),
        integrated_at TEXT,
        integrated_commit TEXT,
        generated_from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        generation_key TEXT,
        declared_risk TEXT CHECK (declared_risk IN ('low','medium','high','critical') OR declared_risk IS NULL),
        derived_risk TEXT CHECK (derived_risk IN ('low','medium','high','critical') OR derived_risk IS NULL),
        policy_minimum TEXT CHECK (policy_minimum IN ('low','medium','high','critical') OR policy_minimum IS NULL),
        final_risk TEXT CHECK (final_risk IN ('low','medium','high','critical') OR final_risk IS NULL),
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Copy rows; flip review+assigned_to -> review_in_progress.
    db.exec(`
      INSERT INTO tasks_new (id, epic_id, title, description, status, priority, sort_order,
                             assigned_to, current_execution_id, verification_target_artifact_id,
                             estimated_hours, actual_hours, due_date, source_ref,
                             task_kind, workflow_stage, execution_skill, review_skill,
                             execution_mode, project_repository_id, generated_from_task_id,
                             integration_state, integrated_at, integrated_commit,
                             generation_key, declared_risk, derived_risk, policy_minimum, final_risk,
                             tags, metadata, created_at, updated_at)
      SELECT id, epic_id, title, description,
             CASE WHEN status='review' AND assigned_to IS NOT NULL AND assigned_to != ''
                  THEN 'review_in_progress' ELSE status END,
             priority, sort_order, assigned_to, current_execution_id, verification_target_artifact_id,
             estimated_hours, actual_hours, due_date, source_ref,
             task_kind, workflow_stage, execution_skill, review_skill, execution_mode,
             project_repository_id, generated_from_task_id,
             integration_state, integrated_at, integrated_commit, generation_key,
             declared_risk, derived_risk, policy_minimum, final_risk,
             tags, metadata, created_at, updated_at
      FROM tasks
    `);
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    // Recreate indexes (CREATE IF NOT EXISTS in SCHEMA_SQL handles this on next getDb,
    // but we run them now to be safe within this migration).
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_current_execution ON tasks(current_execution_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_verification_target ON tasks(verification_target_artifact_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(epic_id, sort_order)');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* tx not active */ }
    // Re-throw: failing to migrate is a hard stop — better than silent corruption.
    throw new Error(`Migration 'review_in_progress' failed: ${(err as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error(`Migration 'review_in_progress' produced foreign key violations`);
}

/**
 * P6c: extend the tasks.execution_mode CHECK to include 'artifact_change'.
 *
 * Discovery historically used 'tracker_only'; Formalization execution profiles
 * declare executionMode: 'artifact_change', which the generic flow executor
 * projects onto the task. Without this migration, projecting a Formalization
 * task would violate the CHECK at INSERT.
 *
 * Detection: inspect the live DDL — if the CHECK already contains
 * 'artifact_change', the migration is a no-op (fresh DBs get the extended
 * constraint directly via schema.ts; older DBs migrated through
 * migrateReviewInProgress get it via that rebuild's DDL too). Only DBs that
 * predate both paths need the rebuild.
 *
 * Rebuild shape mirrors migrateReviewInProgress: copy all columns, drop,
 * rename, recreate indexes.
 */
function migrateExecutionModeArtifactChange(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return; // nothing to migrate (table not created yet)
  if (row.sql.includes("'artifact_change'")) return; // already migrated

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked')),
        priority TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high', 'critical')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT,
        current_execution_id TEXT,
        verification_target_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
        estimated_hours REAL,
        actual_hours REAL,
        due_date TEXT,
        source_ref TEXT,
        task_kind TEXT,
        workflow_stage TEXT,
        execution_skill TEXT,
        review_skill TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'git_change'
              CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive','artifact_change')),
        project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL,
        integration_state TEXT NOT NULL DEFAULT 'not_required'
              CHECK (integration_state IN ('not_required','pending','merged','conflict')),
        integrated_at TEXT,
        integrated_commit TEXT,
        generated_from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        generation_key TEXT,
        declared_risk TEXT CHECK (declared_risk IN ('low','medium','high','critical') OR declared_risk IS NULL),
        derived_risk TEXT CHECK (derived_risk IN ('low','medium','high','critical') OR derived_risk IS NULL),
        policy_minimum TEXT CHECK (policy_minimum IN ('low','medium','high','critical') OR policy_minimum IS NULL),
        final_risk TEXT CHECK (final_risk IN ('low','medium','high','critical') OR final_risk IS NULL),
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO tasks_new (id, epic_id, title, description, status, priority, sort_order,
                             assigned_to, current_execution_id, verification_target_artifact_id,
                             estimated_hours, actual_hours, due_date, source_ref,
                             task_kind, workflow_stage, execution_skill, review_skill,
                             execution_mode, project_repository_id, generated_from_task_id,
                             integration_state, integrated_at, integrated_commit,
                             generation_key, declared_risk, derived_risk, policy_minimum, final_risk,
                             tags, metadata, created_at, updated_at)
      SELECT id, epic_id, title, description, status, priority, sort_order,
             assigned_to, current_execution_id, verification_target_artifact_id,
             estimated_hours, actual_hours, due_date, source_ref,
             task_kind, workflow_stage, execution_skill, review_skill,
             execution_mode, project_repository_id, generated_from_task_id,
             integration_state, integrated_at, integrated_commit,
             generation_key, declared_risk, derived_risk, policy_minimum, final_risk,
             tags, metadata, created_at, updated_at
      FROM tasks
    `);
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_current_execution ON tasks(current_execution_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_verification_target ON tasks(verification_target_artifact_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(epic_id, sort_order)');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* tx not active */ }
    throw new Error(`Migration 'execution_mode_artifact_change' failed: ${(err as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error(`Migration 'execution_mode_artifact_change' produced foreign key violations`);
}

function migrateArtifactTypes(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='artifacts'",
  ).get() as { sql: string } | undefined;
  // Detection predicate: the newest artifact type is 'business_metric'. If the
  // live DDL already includes it, the catalog is up-to-date and the migration is
  // a no-op. Older DBs (CHECK ends at 'SPEC', 'OQ', or earlier) need the rebuild.
  if (!row?.sql || row.sql.includes("'business_metric'")) return;

  // The rebuild must preserve every optional column the source table has. With
  // 'SPEC' detection the migration can now fire on DBs at any prior schema
  // version (pre-evidence_status, pre-project_repository_id, etc.). We read
  // PRAGMA table_info to detect which optional columns exist and branch the DDL
  // accordingly so values are never lost. project_repository_id and
  // evidence_status are the two columns the historical migrations added out of
  // band via ALTER TABLE; both may or may not be present.
  const sourceCols = db.prepare("PRAGMA table_info('artifacts')").all() as Array<{ name: string }>;
  const sourceColSet = new Set(sourceCols.map(c => c.name));
  const hasProjRepo = sourceColSet.has('project_repository_id');
  const hasEvidenceStatus = sourceColSet.has('evidence_status');

  const projRepoCol = hasProjRepo
    ? `project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL,`
    : '';
  const projRepoIns = hasProjRepo ? `project_repository_id,` : '';
  const projRepoSel = hasProjRepo ? `project_repository_id,` : '';
  const evidenceStatusCol = hasEvidenceStatus
    ? `evidence_status TEXT CHECK (evidence_status IN ('confirmed','proposed','assumed','open','rejected','superseded') OR evidence_status IS NULL),`
    : '';
  const evidenceStatusIns = hasEvidenceStatus ? `evidence_status,` : '';
  const evidenceStatusSel = hasEvidenceStatus ? `evidence_status,` : '';

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE artifacts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('PRD','SRS','UC','AC','FR','NFR','decision','theme','brief','RULE','OQ','SPEC','hypothesis','business_metric')),
        code TEXT,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft','in_review','accepted','superseded')),
        parent_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
        ${projRepoCol}
        content_hash TEXT,
        accepted_hash TEXT,
        drift_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK (drift_state IN ('unknown','clean','drifted')),
        ${evidenceStatusCol}
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO artifacts_new
        (id,project_id,epic_id,type,code,title,path,status,parent_artifact_id,
         ${projRepoIns}content_hash,accepted_hash,drift_state,${evidenceStatusIns}tags,metadata,
         created_at,updated_at)
      SELECT id,project_id,epic_id,type,code,title,path,status,parent_artifact_id,
             ${projRepoSel}content_hash,accepted_hash,drift_state,${evidenceStatusSel}tags,metadata,
             created_at,updated_at
      FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_new RENAME TO artifacts;
      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_epic ON artifacts(epic_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
      CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(parent_artifact_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_code ON artifacts(code);
      CREATE INDEX IF NOT EXISTS idx_artifacts_drift ON artifacts(epic_id,drift_state);
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw new Error(`Migration artifact types failed: ${(error as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error(`Migration artifact types produced foreign key violations`);
}

// Widen artifact_traces.link_type CHECK to include 'implements_spec' (FR/RULE
// implemented by a SPEC design contract). SQLite cannot ALTER a column's CHECK
// in place, so we rebuild the table when the existing CHECK lacks
// 'implements_spec'. Existing rows are preserved verbatim — every existing
// link_type is a subset of the widened enum. Idempotent: if the new CHECK is
// already in place, returns immediately.
function migrateTracesLinkType(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='artifact_traces'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return; // table doesn't exist yet — SCHEMA_SQL will create it correctly.
  if (row.sql.includes("'implements_spec'")) return; // already migrated.

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE artifact_traces_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id     INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        target_type   TEXT NOT NULL CHECK (target_type IN ('artifact','task')),
        target_id     INTEGER NOT NULL,
        link_type     TEXT NOT NULL
                        CHECK (link_type IN ('covers','implements','derived_from','depends_on','verified_by','superseded_by','implements_spec')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_id, target_type, target_id, link_type)
      )
    `);
    db.exec(`
      INSERT INTO artifact_traces_new
        (id, source_id, target_type, target_id, link_type, created_at)
      SELECT id, source_id, target_type, target_id, link_type, created_at
      FROM artifact_traces
    `);
    db.exec('DROP TABLE artifact_traces');
    db.exec('ALTER TABLE artifact_traces_new RENAME TO artifact_traces');
    // Recreate indexes (IF NOT EXISTS — they were dropped with the table).
    db.exec('CREATE INDEX IF NOT EXISTS idx_traces_source ON artifact_traces(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_traces_target ON artifact_traces(target_type, target_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_traces_link ON artifact_traces(link_type)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw new Error(`Migration artifact_traces link_type widen failed: ${(error as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error(`Migration artifact_traces link_type produced foreign key violations`);
}

// REQ-008 — widen verification_evidence.outcome CHECK to CGAD's 4-valued guard
// verdict (passed/failed/unknown/error) and add a nullable `provider` column.
// SQLite cannot ALTER a column's CHECK in place, so we rebuild the table when
// the existing CHECK lacks 'unknown'. Existing rows are preserved verbatim
// (their outcome is already in {passed, failed} which is a subset of the new
// enum). Idempotent: if the new CHECK is already in place, returns immediately.
function migrateVerificationOutcome(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='verification_evidence'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return; // table doesn't exist yet — SCHEMA_SQL will create it correctly.
  if (row.sql.includes("'unknown'")) return; // already migrated.

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE verification_evidence_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        artifact_id    INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        outcome        TEXT NOT NULL CHECK (outcome IN ('passed','failed','unknown','error')),
        evidence       TEXT NOT NULL,
        content_hash   TEXT,
        recorded_by    TEXT,
        provider       TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (task_id, artifact_id, content_hash)
      )
    `);
    // Preserve every existing row; existing outcomes are {passed, failed} ⊂ new enum.
    // provider is NULL for legacy rows — REQ-008 leaves backfill to callers.
    db.exec(`
      INSERT INTO verification_evidence_new
        (id, task_id, artifact_id, outcome, evidence, content_hash, recorded_by, created_at)
      SELECT id, task_id, artifact_id, outcome, evidence, content_hash, recorded_by, created_at
      FROM verification_evidence
    `);
    db.exec('DROP TABLE verification_evidence');
    db.exec('ALTER TABLE verification_evidence_new RENAME TO verification_evidence');
    // Recreate indexes (IF NOT EXISTS — they were dropped with the table).
    db.exec('CREATE INDEX IF NOT EXISTS idx_verification_evidence_artifact ON verification_evidence(artifact_id, outcome)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw new Error(`Migration verification_evidence outcome widen failed: ${(error as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error(`Migration verification_evidence produced foreign key violations`);
}

/**
 * Evidence is immutable per execution attempt, not forever per task/AC/hash.
 * A dead verifier may have recorded failed/unknown evidence; a later fenced
 * execution must be able to append its own result without overwriting history.
 */
function migrateVerificationExecution(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('verification_evidence')").all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'execution_id')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_attempt
        ON verification_evidence(
          task_id, artifact_id, COALESCE(content_hash,''),
          COALESCE(execution_id,'')
        )
    `);
    return;
  }
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE verification_evidence_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        artifact_id    INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        outcome        TEXT NOT NULL CHECK (outcome IN ('passed','failed','unknown','error')),
        evidence       TEXT NOT NULL,
        content_hash   TEXT,
        recorded_by    TEXT,
        provider       TEXT,
        execution_id   TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (task_id, artifact_id, content_hash, execution_id)
      );
      INSERT INTO verification_evidence_new
        (id,task_id,artifact_id,outcome,evidence,content_hash,recorded_by,provider,created_at)
      SELECT id,task_id,artifact_id,outcome,evidence,content_hash,recorded_by,provider,created_at
      FROM verification_evidence;
      DROP TABLE verification_evidence;
      ALTER TABLE verification_evidence_new RENAME TO verification_evidence;
      CREATE INDEX IF NOT EXISTS idx_verification_evidence_artifact
        ON verification_evidence(artifact_id,outcome);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_attempt
        ON verification_evidence(
          task_id, artifact_id, COALESCE(content_hash,''),
          COALESCE(execution_id,'')
        );
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw new Error(`Migration verification execution identity failed: ${(error as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error('Migration verification execution identity produced foreign key violations');
}

/**
 * Restore canonical verification ownership from planning provenance. A
 * verified_by edge is derived output, so it must not define which AC a task
 * owns. Mismatched legacy edges are safe to remove; evidence stays immutable.
 */
function migrateVerificationTargets(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      UPDATE tasks
         SET verification_target_artifact_id = (
           SELECT MIN(tr.source_id)
             FROM artifact_traces tr
             JOIN artifacts a ON a.id=tr.source_id
            WHERE tr.target_type='task'
              AND tr.target_id=tasks.id
              AND tr.link_type='depends_on'
              AND a.type='AC'
              AND a.status='accepted'
         )
       WHERE task_kind='verification.ac'
         AND verification_target_artifact_id IS NULL
         AND 1 = (
           SELECT COUNT(DISTINCT tr.source_id)
             FROM artifact_traces tr
             JOIN artifacts a ON a.id=tr.source_id
            WHERE tr.target_type='task'
              AND tr.target_id=tasks.id
              AND tr.link_type='depends_on'
              AND a.type='AC'
              AND a.status='accepted'
         );

    `);

    const unresolved = db.prepare(
      `SELECT id,epic_id,title FROM tasks
        WHERE task_kind='verification.ac'
          AND verification_target_artifact_id IS NULL`,
    ).all() as Array<{ id: number; epic_id: number; title: string }>;
    const acceptedAcs = db.prepare(
      `SELECT id,code FROM artifacts
        WHERE epic_id=? AND type='AC' AND status='accepted' AND code IS NOT NULL`,
    );
    const setTarget = db.prepare(
      `UPDATE tasks SET verification_target_artifact_id=?
        WHERE id=? AND verification_target_artifact_id IS NULL`,
    );
    for (const task of unresolved) {
      const matches = (acceptedAcs.all(task.epic_id) as Array<{ id: number; code: string }>)
        .filter(artifact => {
          const escaped = artifact.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, 'i')
            .test(task.title);
        });
      if (matches.length === 1) setTarget.run(matches[0]!.id, task.id);
    }

    db.exec(`
      DELETE FROM artifact_traces
       WHERE link_type='verified_by'
         AND target_type='task'
         AND EXISTS (
           SELECT 1
             FROM tasks t
            WHERE t.id=artifact_traces.target_id
              AND t.task_kind='verification.ac'
              AND t.verification_target_artifact_id IS NOT NULL
              AND t.verification_target_artifact_id != artifact_traces.source_id
         );
    `);
  })();
}

// REQ-009 — CGAD §11 RiskClass. Adds four nullable risk columns to tasks.
// Idempotent: ALTER TABLE ADD COLUMN wrapped in try/catch. No data migration:
// legacy tasks keep NULL risk columns; the existing `priority` column remains
// the source of truth for declared risk on those rows (back-compat alias).
// New tasks SHOULD write declared_risk/derived_risk/policy_minimum explicitly;
// task_create / task_update computes final_risk = max(declared, derived, policy)
// in TS (see tasks.ts) to keep the rule testable and explicit.
// Exported for targeted migration tests (backfill behaviour on legacy rows).
export function migrateRiskClass(db: Database.Database): void {
  for (const col of ['declared_risk', 'derived_risk', 'policy_minimum', 'final_risk']) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT CHECK (${col} IN ('low','medium','high','critical') OR ${col} IS NULL)`);
    } catch { /* column already exists */ }
  }
  // Back-compat: backfill declared_risk from legacy priority for rows that
  // have priority set but declared_risk NULL. One-shot UPDATE, idempotent.
  try {
    db.exec(`UPDATE tasks SET declared_risk = priority WHERE declared_risk IS NULL AND priority IS NOT NULL`);
  } catch { /* priority column missing — pre-migration DB, skip */ }
  // CGAD P15 backfill: legacy rows that just got declared_risk stamped must
  // also get final_risk so lint R2b and risk queries see them.
  try {
    db.exec(`UPDATE tasks SET final_risk = declared_risk WHERE final_risk IS NULL AND declared_risk IS NOT NULL`);
  } catch { /* columns missing — pre-migration DB, skip */ }
  // Index for "find tasks by risk class" queries.
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_final_risk ON tasks(final_risk)');
}

/**
 * ADR-012 — Multi-track pipeline. Adds an explicit `track` column to
 * episode_workflows so the engine can route episodes by their discovery
 * decision: 'formal' (decision='go') walks the full pipeline; 'fast-track'
 * (decision='fast-track') skips formalization+planning. The 'clarify' and
 * 'reject' decisions are terminal-pause/cancel states, not tracks.
 *
 * Backfill: episodes whose metadata carries `fast_track:1` (written by
 * routeFastTrack at src/planner/fast-track.ts:206-212 before this column
 * existed) get track='fast-track'. Everything else defaults to 'formal'.
 */
export function migrateEpisodeTrack(db: Database.Database): void {
  try {
    db.exec(
      "ALTER TABLE episode_workflows ADD COLUMN track TEXT NOT NULL DEFAULT 'formal' CHECK (track IN ('formal','fast-track'))",
    );
  } catch { /* column already exists */ }
  // Backfill from the legacy metadata flag. Idempotent.
  try {
    db.exec(
      `UPDATE episode_workflows SET track='fast-track'
       WHERE track='formal' AND json_extract(metadata,'$.fast_track')=1`,
    );
  } catch { /* metadata column missing — pre-migration DB, skip */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_episode_workflows_track ON episode_workflows(track)');
}

/**
 * saga4 Phase 6 prerequisite: add a stable `slug` column to epics.
 *
 * Numeric epic ids are not portable across reset/import. A slug (derived from
 * the epic name) gives durable cross-module/export references a stable key.
 * Nullable during rollout; populated lazily here from the name for existing
 * rows, and on creation going forward.
 */
export function migrateEpicSlug(db: Database.Database): void {
  try {
    db.exec('ALTER TABLE epics ADD COLUMN slug TEXT');
  } catch { /* column already exists */ }
  // Backfill slug from name for existing rows that lack one. Slug = lowercased
  // name with non-alphanumerics collapsed to hyphens. Idempotent.
  db.exec(
    `UPDATE epics SET slug = lower(
       trim(replace(replace(replace(replace(replace(name,
         ' ', '-'), '/', '-'), '\\', '-'), '.', '-'), '_', '-'))
     )
     WHERE slug IS NULL AND name IS NOT NULL`,
  );
  // Uniqueness is NOT enforced yet (two epics with the same name produce the
  // same slug); a unique constraint requires full migration of all references.
  // The Phase 6 full rollout will add UNIQUE(project_id, slug).
}


