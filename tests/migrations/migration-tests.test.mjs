// Migration tests — verifies the non-trivial migration paths in src/db.ts that
// are NOT exercised on a fresh DB (where tables don't exist yet and SCHEMA_SQL
// creates them correctly).
//
// Strategy (per task: option (b) — test the actual migration path): for each
// test we (1) open a raw better-sqlite3 connection and CREATE the OLD schema,
// (2) seed legacy rows, (3) close that connection, (4) point DB_PATH at the
// file and call getDb() — which runs SCHEMA_SQL (no-ops via IF NOT EXISTS) and
// then the migration functions against the OLD tables, rebuilding / ALTERing
// them in place. We then assert the post-migration schema + data.
//
// getDb() holds a module-level singleton, so each test sets its OWN DB_PATH
// and calls closeDb() before re-entering getDb() on a different file.
//
// ISOLATION: the migrations run as a chain inside getDb()
//   migrateArtifactTypes → migrateVerificationOutcome → migrateRiskClass
//     → migrateReviewInProgress
// and migrateReviewInProgress hard-codes its rebuild DDL (it does NOT include
// the REQ-009 risk columns) and does not disable FKs during DROP TABLE tasks.
// To test ONE migration's contract cleanly, each seed puts the OTHER tables in
// their ALREADY-MIGRATED shape so the rest of the chain short-circuits:
//   - Test 1 (verification_evidence): tasks already have the new status CHECK
//     AND the risk columns; artifacts CHECK already includes 'brief'. Only
//     verification_evidence is in its old (2-valued, no-provider) form.
//   - Test 2 (risk class): tasks already have the new status CHECK but lack
//     the four risk columns. migrateReviewInProgress skips; migrateRiskClass
//     adds + backfills.
//   - Test 3 (review_in_progress): tasks have the OLD status CHECK but already
//     carry the risk columns. migrateRiskClass skips; migrateReviewInProgress
//     rebuilds. (Its rebuild DDL omits risk columns — see KNOWN-LIMITATION
//     below; Test 3 does not assert on them.)
//
// Covers:
//   Test 1 — migrateVerificationOutcome (REQ-008): old CHECK lacks 'unknown'/
//           'error', no `provider` column → table rebuilt, rows preserved.
//   Test 2 — migrateRiskClass (REQ-009): tasks table has no risk columns →
//           ALTER TABLE adds them, declared_risk backfilled from priority.
//   Test 3 — migrateReviewInProgress: old status CHECK lacks
//           'review_in_progress' → table rebuilt, review+assigned_to rows
//           become 'review_in_progress'.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-migrations-'));

// Lazy-imported per test so DB_PATH is read at call time.
const { closeDb, getDb } = await import('../../dist/db.js');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// tasks DDL with the NEW status CHECK (includes 'review_in_progress') and WITH
// the REQ-009 risk columns. Used to isolate migrations that target OTHER
// tables: migrateRiskClass sees the risk columns and skips; migrateReviewInProgress
// sees 'review_in_progress' in the DDL and skips.
const TASKS_NEW_STATUS_WITH_RISK = `
  CREATE TABLE tasks (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id                   INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    title                     TEXT NOT NULL,
    description               TEXT,
    status                    TEXT NOT NULL DEFAULT 'todo'
                                CHECK (status IN ('todo','in_progress','review','review_in_progress','done','blocked')),
    priority                  TEXT NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('low','medium','high','critical')),
    sort_order                INTEGER NOT NULL DEFAULT 0,
    assigned_to               TEXT,
    estimated_hours           REAL,
    actual_hours              REAL,
    due_date                  TEXT,
    source_ref                TEXT,
    task_kind                 TEXT,
    workflow_stage            TEXT,
    execution_skill           TEXT,
    review_skill              TEXT,
    execution_mode            TEXT NOT NULL DEFAULT 'git_change'
                                CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive')),
    project_repository_id     INTEGER,
    integration_state         TEXT NOT NULL DEFAULT 'not_required'
                                CHECK (integration_state IN ('not_required','pending','merged','conflict')),
    integrated_at             TEXT,
    integrated_commit         TEXT,
    generated_from_task_id    INTEGER,
    generation_key            TEXT,
    declared_risk             TEXT CHECK (declared_risk IN ('low','medium','high','critical') OR declared_risk IS NULL),
    derived_risk              TEXT CHECK (derived_risk IN ('low','medium','high','critical') OR derived_risk IS NULL),
    policy_minimum            TEXT CHECK (policy_minimum IN ('low','medium','high','critical') OR policy_minimum IS NULL),
    final_risk                TEXT CHECK (final_risk IN ('low','medium','high','critical') OR final_risk IS NULL),
    tags                      TEXT NOT NULL DEFAULT '[]',
    metadata                  TEXT NOT NULL DEFAULT '{}',
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// tasks DDL with the NEW status CHECK but WITHOUT the risk columns. Used by
// Test 2 to isolate migrateRiskClass: migrateReviewInProgress skips (status
// CHECK already modern); migrateRiskClass adds the four columns + backfills.
const TASKS_NEW_STATUS_NO_RISK = `
  CREATE TABLE tasks (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id                   INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    title                     TEXT NOT NULL,
    description               TEXT,
    status                    TEXT NOT NULL DEFAULT 'todo'
                                CHECK (status IN ('todo','in_progress','review','review_in_progress','done','blocked')),
    priority                  TEXT NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('low','medium','high','critical')),
    sort_order                INTEGER NOT NULL DEFAULT 0,
    assigned_to               TEXT,
    estimated_hours           REAL,
    actual_hours              REAL,
    due_date                  TEXT,
    source_ref                TEXT,
    task_kind                 TEXT,
    workflow_stage            TEXT,
    execution_skill           TEXT,
    review_skill              TEXT,
    execution_mode            TEXT NOT NULL DEFAULT 'git_change'
                                CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive')),
    project_repository_id     INTEGER,
    integration_state         TEXT NOT NULL DEFAULT 'not_required'
                                CHECK (integration_state IN ('not_required','pending','merged','conflict')),
    integrated_at             TEXT,
    integrated_commit         TEXT,
    generated_from_task_id    INTEGER,
    generation_key            TEXT,
    tags                      TEXT NOT NULL DEFAULT '[]',
    metadata                  TEXT NOT NULL DEFAULT '{}',
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// tasks DDL with the OLD status CHECK (no 'review_in_progress') but WITH the
// risk columns. Used by Test 3 to isolate migrateReviewInProgress:
// migrateRiskClass skips (risk columns already present); migrateReviewInProgress
// detects the old CHECK and rebuilds.
const TASKS_OLD_STATUS_WITH_RISK = `
  CREATE TABLE tasks (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id                   INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    title                     TEXT NOT NULL,
    description               TEXT,
    status                    TEXT NOT NULL DEFAULT 'todo'
                                CHECK (status IN ('todo','in_progress','review','done','blocked')),
    priority                  TEXT NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('low','medium','high','critical')),
    sort_order                INTEGER NOT NULL DEFAULT 0,
    assigned_to               TEXT,
    estimated_hours           REAL,
    actual_hours              REAL,
    due_date                  TEXT,
    source_ref                TEXT,
    task_kind                 TEXT,
    workflow_stage            TEXT,
    execution_skill           TEXT,
    review_skill              TEXT,
    execution_mode            TEXT NOT NULL DEFAULT 'git_change'
                                CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive')),
    project_repository_id     INTEGER,
    integration_state         TEXT NOT NULL DEFAULT 'not_required'
                                CHECK (integration_state IN ('not_required','pending','merged','conflict')),
    integrated_at             TEXT,
    integrated_commit         TEXT,
    generated_from_task_id    INTEGER,
    generation_key            TEXT,
    declared_risk             TEXT CHECK (declared_risk IN ('low','medium','high','critical') OR declared_risk IS NULL),
    derived_risk              TEXT CHECK (derived_risk IN ('low','medium','high','critical') OR derived_risk IS NULL),
    policy_minimum            TEXT CHECK (policy_minimum IN ('low','medium','high','critical') OR policy_minimum IS NULL),
    final_risk                TEXT CHECK (final_risk IN ('low','medium','high','critical') OR final_risk IS NULL),
    tags                      TEXT NOT NULL DEFAULT '[]',
    metadata                  TEXT NOT NULL DEFAULT '{}',
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function seedSkeleton(db) {
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'medium',
      sort_order INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
  db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'REQ-1')").run();
}

// ----------------------------------------------------------------------------
// Test 1 — migrateVerificationOutcome on old-schema DB (REQ-008)
// ----------------------------------------------------------------------------
test('migrateVerificationOutcome rebuilds table with widened outcome CHECK, adds provider column, preserves rows', () => {
  const dbPath = path.join(temp, 'verify-old.db');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');
  seedSkeleton(seed);
  seed.exec(TASKS_NEW_STATUS_WITH_RISK);
  // Artifacts at ALREADY-MIGRATED state so migrateArtifactTypes skips.
  seed.exec(`
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('PRD','SRS','UC','AC','FR','NFR','decision','theme','brief')),
      code TEXT,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      parent_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- OLD verification_evidence: CHECK only allows passed/failed, no provider.
    CREATE TABLE verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed')),
      evidence TEXT NOT NULL,
      content_hash TEXT,
      recorded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (task_id, artifact_id, content_hash)
    );
  `);
  seed.prepare("INSERT INTO tasks (epic_id, title) VALUES (1, 't1')").run();
  seed.prepare("INSERT INTO tasks (epic_id, title) VALUES (1, 't2')").run();
  seed.prepare(
    `INSERT INTO artifacts (project_id, epic_id, type, title, path) VALUES
       (1, 1, 'AC', 'a1', 'docs/a1.md'),
       (1, 1, 'AC', 'a2', 'docs/a2.md')`
  ).run();
  const ins = seed.prepare(
    `INSERT INTO verification_evidence (task_id, artifact_id, outcome, evidence, content_hash, recorded_by)
     VALUES (?,?,?,?,?,?)`
  );
  ins.run(1, 1, 'passed', 'e1', 'h1', 'tester');
  ins.run(1, 2, 'passed', 'e2', 'h2', 'tester');
  ins.run(2, 1, 'failed', 'e3', 'h3', 'tester');
  seed.close();

  // Trigger migration via the real code path.
  closeDb();
  process.env.DB_PATH = dbPath;
  const db = getDb();

  // Schema assertions.
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='verification_evidence'"
  ).get().sql;
  assert.ok(tableSql.includes("'unknown'"), 'new CHECK must include unknown');
  assert.ok(tableSql.includes("'error'"), 'new CHECK must include error');
  const cols = db.prepare("PRAGMA table_info('verification_evidence')").all()
    .map(c => c.name);
  assert.ok(cols.includes('provider'), 'provider column must exist after migration');

  // Data assertions: all 3 rows preserved verbatim.
  const rows = db.prepare(
    'SELECT id, task_id, artifact_id, outcome, evidence, content_hash, recorded_by FROM verification_evidence ORDER BY id'
  ).all();
  assert.equal(rows.length, 3, 'all 3 evidence rows must be preserved');
  assert.deepEqual(
    rows.map(r => ({ task_id: r.task_id, artifact_id: r.artifact_id, outcome: r.outcome })),
    [
      { task_id: 1, artifact_id: 1, outcome: 'passed' },
      { task_id: 1, artifact_id: 2, outcome: 'passed' },
      { task_id: 2, artifact_id: 1, outcome: 'failed' },
    ],
    'row data must be preserved verbatim through the rebuild'
  );

  // New outcomes must now be insertable (proves the widened CHECK is in effect).
  db.prepare(
    `INSERT INTO verification_evidence (task_id, artifact_id, outcome, evidence, content_hash, provider)
     VALUES (1, 1, 'unknown', 'insufficient', 'h-u', 'cgad-spec-lint')`
  ).run();

  // FK integrity.
  const fkViolation = db.prepare('PRAGMA foreign_key_check').get();
  assert.equal(fkViolation, undefined, 'no foreign-key violations after migration');

  // Idempotency: re-running getDb() path must not re-migrate / not drop rows.
  closeDb();
  const db2 = getDb();
  const afterReenter = db2.prepare('SELECT COUNT(*) AS n FROM verification_evidence').get().n;
  assert.equal(afterReenter, 4, 'idempotent re-entry must not duplicate or lose rows');
});

// ----------------------------------------------------------------------------
// Test 2 — migrateRiskClass on old-schema DB (REQ-009)
// ----------------------------------------------------------------------------
test('migrateRiskClass adds risk columns and backfills declared_risk from priority', () => {
  const dbPath = path.join(temp, 'risk-old.db');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');
  seedSkeleton(seed);
  seed.exec(TASKS_NEW_STATUS_NO_RISK);
  const addTask = seed.prepare("INSERT INTO tasks (epic_id, title, priority) VALUES (1, ?, ?)");
  addTask.run('low-task', 'low');
  addTask.run('medium-task', 'medium');
  addTask.run('high-task', 'high');
  seed.close();

  closeDb();
  process.env.DB_PATH = dbPath;
  const db = getDb();

  // Columns must exist post-migration.
  const cols = db.prepare("PRAGMA table_info('tasks')").all().map(c => c.name);
  for (const c of ['declared_risk', 'derived_risk', 'policy_minimum', 'final_risk']) {
    assert.ok(cols.includes(c), `${c} column must exist after migrateRiskClass`);
  }

  // declared_risk backfilled from priority (the group-A backfill fix).
  const rows = db.prepare("SELECT title, priority, declared_risk, final_risk FROM tasks ORDER BY id").all();
  assert.equal(rows.length, 3);
  const byTitle = Object.fromEntries(rows.map(r => [r.title, r]));
  assert.equal(byTitle['low-task'].declared_risk, 'low', 'declared_risk backfilled from priority=low');
  assert.equal(byTitle['medium-task'].declared_risk, 'medium', 'declared_risk backfilled from priority=medium');
  assert.equal(byTitle['high-task'].declared_risk, 'high', 'declared_risk backfilled from priority=high');

  // final_risk is intentionally NOT backfilled by migrateRiskClass: the
  // migration only adds the columns + backfills declared_risk. final_risk is
  // computed in TS (task_create/task_update) via final_risk =
  // max(declared, derived, policy). So legacy rows keep final_risk = NULL until
  // a subsequent update recomputes it. This is the documented contract; we
  // assert it explicitly so a future change to backfill final_risk here does
  // not silently alter the migration semantics.
  for (const r of rows) {
    assert.equal(r.final_risk, null, 'final_risk must remain NULL after migration (computed on next write)');
  }

  // Idempotency: re-entering getDb must not clobber the backfill.
  closeDb();
  const db2 = getDb();
  const stillLow = db2.prepare("SELECT declared_risk FROM tasks WHERE title='low-task'").get().declared_risk;
  assert.equal(stillLow, 'low', 're-running migration must not clobber declared_risk');
});

// ----------------------------------------------------------------------------
// Test 3 — migrateReviewInProgress on old-schema DB
// ----------------------------------------------------------------------------
// KNOWN-LIMITATION: migrateReviewInProgress's rebuild DDL (db.ts lines 102-135)
// is hard-coded and does NOT include the REQ-009 risk columns
// (declared_risk/derived_risk/policy_minimum/final_risk). On a DB where
// migrateRiskClass has already run, a subsequent migrateReviewInProgress rebuild
// would DROP those columns. This is masked in production because on a fresh DB
// the table is created by SCHEMA_SQL (modern, with risk columns) and
// migrateReviewInProgress's `row.sql.includes('review_in_progress')` check
// short-circuits. We isolate this test by seeding tasks WITH risk columns but
// OLD status CHECK, then assert ONLY the status/CHECK contract. The risk-column
// interaction between the two migrations is out of scope for this test and
// noted here for whoever hardens the migration chain next.
test('migrateReviewInProgress rebuilds tasks with widened status CHECK and flips review+assigned rows', () => {
  const dbPath = path.join(temp, 'review-old.db');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');
  seedSkeleton(seed);
  seed.exec(TASKS_OLD_STATUS_WITH_RISK);
  const addTask = seed.prepare("INSERT INTO tasks (epic_id, title, status, assigned_to) VALUES (1, ?, ?, ?)");
  // Row 1: review + assigned_to → should flip to review_in_progress.
  addTask.run('review-with-reviewer', 'review', 'reviewer-1');
  // Row 2: review but unassigned → should STAY review (no reviewer was active).
  addTask.run('review-no-reviewer', 'review', null);
  // Row 3: review with empty-string assigned_to → should STAY review.
  addTask.run('review-empty-reviewer', 'review', '');
  // Row 4: in_progress → untouched.
  addTask.run('in-progress-task', 'in_progress', 'worker-9');
  seed.close();

  closeDb();
  process.env.DB_PATH = dbPath;
  const db = getDb();

  // Widened CHECK now in place.
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'"
  ).get().sql;
  assert.ok(tableSql.includes('review_in_progress'), 'new status CHECK must include review_in_progress');

  // Row transitions.
  const rows = db.prepare("SELECT title, status, assigned_to FROM tasks ORDER BY id").all();
  const byTitle = Object.fromEntries(rows.map(r => [r.title, r]));
  assert.equal(byTitle['review-with-reviewer'].status, 'review_in_progress',
    'review row with a non-empty assigned_to must become review_in_progress');
  assert.equal(byTitle['review-no-reviewer'].status, 'review',
    'review row with NULL assigned_to must stay review (no active reviewer)');
  assert.equal(byTitle['review-empty-reviewer'].status, 'review',
    'review row with empty-string assigned_to must stay review');
  assert.equal(byTitle['in-progress-task'].status, 'in_progress',
    'non-review rows must be untouched');
  // assigned_to preserved through the rebuild.
  assert.equal(byTitle['review-with-reviewer'].assigned_to, 'reviewer-1');

  // The new value must be insertable post-migration.
  db.prepare("INSERT INTO tasks (epic_id, title, status) VALUES (1, 'new-rip', 'review_in_progress')").run();

  // FK integrity.
  const fkViolation = db.prepare('PRAGMA foreign_key_check').get();
  assert.equal(fkViolation, undefined, 'no foreign-key violations after rebuild');

  // Idempotency: re-entering getDb must not re-flip or duplicate.
  closeDb();
  const db2 = getDb();
  const ripCount = db2.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='review_in_progress'").get().n;
  assert.equal(ripCount, 2, 'one seeded flip + one direct insert = 2; re-migration must not duplicate');
});
