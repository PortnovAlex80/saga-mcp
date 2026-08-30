// Saga5 core schema — M0 scaffold (SAGA5-REBUILD-PLAN.md §2.2).
//
// Two halves:
//   KERNEL — event-sourced core. `events` is the only authority; every other
//   kernel table is a header/projection that can be rebuilt from the log.
//   BOARD  — operator surface (upstream spranab/saga-mcp model): projects >
//   epics > tasks > subtasks with dependency auto-block. Projections, never
//   authority for kernel transitions.
//
// Discipline rule: a new table is allowed only if it cannot be expressed as
// an event or a projection of events.

export const SCHEMA_SQL = `
-- ─────────────────────────── KERNEL ───────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  graph_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  root_run_id   TEXT REFERENCES runs(id),
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','running','waiting','success','error','canceled','crashed')),
  wait_till     TEXT,
  next_seq      INTEGER NOT NULL DEFAULT 0,
  writer_token  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The authority. Append-only, enforced by trigger; state is a fold over this log.
CREATE TABLE IF NOT EXISTS events (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, seq)
);

CREATE TRIGGER IF NOT EXISTS events_no_update
  BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(FAIL, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
  BEFORE DELETE ON events
BEGIN
  SELECT RAISE(FAIL, 'events are append-only');
END;

-- Content-addressed material: identity is the digest of (schema_ref, content).
-- Immutable by trigger; execution provenance lives in events, never here.
CREATE TABLE IF NOT EXISTS materials (
  digest     TEXT PRIMARY KEY,
  schema_ref TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS materials_no_update
  BEFORE UPDATE ON materials
BEGIN
  SELECT RAISE(FAIL, 'materials are immutable');
END;

CREATE TRIGGER IF NOT EXISTS materials_no_delete
  BEFORE DELETE ON materials
BEGIN
  SELECT RAISE(FAIL, 'materials are immutable');
END;

-- Activity attempts (LLM calls, scripts). Non-determinism is confined here.
CREATE TABLE IF NOT EXISTS executions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  node_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','running','waiting','success','error','canceled','crashed')),
  worker_kind   TEXT,
  timeouts_json TEXT,
  retry_json    TEXT,
  lease         TEXT,
  started_at    TEXT,
  heartbeat_at  TEXT,
  -- Live tail of what the worker is producing right now. OPERATIONAL only:
  -- it is overwritten on every heartbeat and is never read by a decision.
  -- The log keeps the replayable fact (how many characters had arrived);
  -- the text itself is a window into a non-deterministic process, not
  -- material. Material is what the worker SUBMITS.
  progress      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

-- Authorized external changes with idempotency identity and typed receipts.
CREATE TABLE IF NOT EXISTS effects (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  desired_digest  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','applied','failed','compensated')),
  receipt_json    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at      TEXT
);

-- Deferred wakeups (retries, waitTill). The sweep is a SELECT, not a supervisor.
CREATE TABLE IF NOT EXISTS timers (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  due_at       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  fired_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_status    ON runs(status);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(run_id, type);
CREATE INDEX IF NOT EXISTS idx_executions_st  ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_run ON executions(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_timers_due     ON timers(fired_at, due_at);

-- ─────────────────────────── BOARD ───────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
  tags          TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS epics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  priority      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  branch        TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id         INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo', 'in_progress', 'review', 'review_in_progress',
                                      'done', 'blocked', 'failed', 'cancelled')),
  priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  assigned_to     TEXT,
  estimated_hours REAL,
  actual_hours    REAL,
  due_date        TEXT,
  source_ref      TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo', 'in_progress', 'done')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  template_data TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL,
  content             TEXT NOT NULL,
  note_type           TEXT NOT NULL DEFAULT 'general'
                        CHECK (note_type IN (
                          'general', 'decision', 'context', 'meeting',
                          'technical', 'blocker', 'progress', 'release'
                        )),
  related_entity_type TEXT CHECK (related_entity_type IN ('project', 'epic', 'task') OR related_entity_type IS NULL),
  related_entity_id   INTEGER,
  tags                TEXT NOT NULL DEFAULT '[]',
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  action        TEXT NOT NULL,
  field_name    TEXT,
  old_value     TEXT,
  new_value     TEXT,
  summary       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);
CREATE INDEX IF NOT EXISTS idx_epics_priority ON epics(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_epics_sort ON epics(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(epic_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_subtasks_sort ON subtasks(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(note_type);
CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(related_entity_type, related_entity_id);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
`;
