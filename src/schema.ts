
/** Reinstalled after any compatibility table rebuild of factory_work_intents. */
export const WORK_INTENT_CONTRACT_IMMUTABILITY_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_factory_work_intents_contract_immutable
BEFORE UPDATE OF epic_id,kind,objective,authority_scope,output_schema,
                 token_budget,retry_budget,created_at
ON factory_work_intents
WHEN OLD.epic_id IS NOT NEW.epic_id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.objective IS NOT NEW.objective
  OR OLD.authority_scope IS NOT NEW.authority_scope
  OR OLD.output_schema IS NOT NEW.output_schema
  OR OLD.token_budget IS NOT NEW.token_budget
  OR OLD.retry_budget IS NOT NEW.retry_budget
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'FACTORY_WORK_INTENT_CONTRACT_IMMUTABLE');
END;
`;

import type Database from 'better-sqlite3';

/**
 * WORKER-NAMES-DESIGN: additive `display_name` column for existing databases.
 *
 * Fresh DBs get the column straight from SCHEMA_SQL below; live v15 factory
 * databases (created before the column existed) get it through this
 * idempotent PRAGMA-guarded ADD COLUMN, applied at DB-open time (db.ts —
 * the single migration point, same pattern as the lazy ensureFactory* calls).
 * Purely additive: no existing column changes, no row reset, therefore NO
 * SCHEMA_VERSION bump (pre-release disposal policy, db.ts) — a live factory
 * DB migrates cleanly with zero data loss.
 */
export function ensureWorkerExecutionsDisplayName(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(worker_executions)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'display_name')) {
    db.exec('ALTER TABLE worker_executions ADD COLUMN display_name TEXT');
  }
}


export const SCHEMA_SQL = `
-- Core hierarchy: projects > epics > tasks > subtasks

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

-- Physical repositories attached to a logical product. A project is the
-- aggregate product board; repositories are task execution scopes.
CREATE TABLE IF NOT EXISTS repositories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  remote_url      TEXT,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_repositories (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id       INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'component',
  local_path          TEXT,
  integration_branch  TEXT NOT NULL DEFAULT 'dev',
  docs_root           TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('planned','active','on_hold','archived')),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, repository_id)
);

CREATE TABLE IF NOT EXISTS repository_checkouts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_repository_id INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  machine_id            TEXT NOT NULL,
  local_path            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','missing','on_hold')),
  metadata              TEXT NOT NULL DEFAULT '{}',
  last_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_repository_id, machine_id)
);

CREATE TABLE IF NOT EXISTS epics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- saga4 Phase 6 prerequisite: stable slug for cross-module/export-import
  -- references that must survive a reset/import. Nullable during the rollout;
  -- populated lazily by the migration + on epic creation.
  slug          TEXT,
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

-- saga4 cutover note: this table is NO LONGER an executable state machine.
-- The stage source of truth is now factory_lifecycle_runs. Engine control-plane
-- metadata lives in lifecycle_execution_controls. This table is kept as a
-- compatibility projection target — some code paths still read/seed it for
-- provenance checks. It will be fully removed once all readers are migrated.
CREATE TABLE IF NOT EXISTS episode_workflows (
  epic_id              INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL DEFAULT 'discovery'
                         CHECK (stage IN ('discovery','formalization','planning','development','verification','integration','completed','cancelled')),
  track                TEXT NOT NULL DEFAULT 'formal'
                         CHECK (track IN ('formal','fast-track')),
  baseline_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  baseline_hash        TEXT,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
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

  -- Every worker-side mutation of a managed task must present this exact id.
  current_execution_id TEXT,
  -- Conveyor v4 binding: the authoritative Workplace aggregate that owns this
  -- task loop state. NULL for tasks not (yet) tracked as a Production Cell
  -- instance. This is a DATA column (the projection identity), NOT an owner
  -- column. Written by WorkplaceProjector when the task is admitted to the
  -- conveyor and never changes thereafter. The owner channel (status /
  -- assigned_to) is the reverse-projection of the v4 kanbanPhase / loopState
  -- (REG-06, CONVEYOR-V4-MIGRATION-PLAN step 5.2).
  workplace_ref TEXT,
  -- Canonical AC owned by a verification.ac task. Evidence for any other AC
  -- is rejected; verified_by is derived output, never the assignment source.
  verification_target_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  estimated_hours REAL,
  actual_hours    REAL,
  due_date        TEXT,
  source_ref      TEXT,
  task_kind       TEXT,
  workflow_stage  TEXT,
  execution_skill TEXT,
  review_skill    TEXT,
  execution_mode  TEXT NOT NULL DEFAULT 'git_change'
                    CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive','artifact_change')),
  project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL,
  -- REQ-009 / CGAD 11 RiskClass. final_risk = max(declared_risk, derived_risk,

  -- label for backward compatibility; new callers should write declared_risk.
  -- derived_risk is computed from the touched surface (security boundary
  -- implies high; data ownership implies critical). policy_minimum is set by
  -- project policy (e.g. all security-tagged tasks have policy_minimum='high').
  -- The agent (Builder) may propose declared_risk but cannot self-lower
  -- final_risk below derived_risk or policy_minimum (CGAD P15).
  declared_risk   TEXT CHECK (declared_risk IN ('low','medium','high','critical') OR declared_risk IS NULL),
  derived_risk    TEXT CHECK (derived_risk IN ('low','medium','high','critical') OR derived_risk IS NULL),
  policy_minimum  TEXT CHECK (policy_minimum IN ('low','medium','high','critical') OR policy_minimum IS NULL),
  final_risk      TEXT CHECK (final_risk IN ('low','medium','high','critical') OR final_risk IS NULL),
  integration_state TEXT NOT NULL DEFAULT 'not_required'
                      CHECK (integration_state IN ('not_required','pending','merged','conflict')),
  integrated_at     TEXT,
  integrated_commit TEXT,
  generated_from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  generation_key  TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Process truth is deliberately separate from task workflow truth. A task may
-- already be in review/done while its single-use CLI process is finishing or
-- integrating. Rows are retained as an execution audit trail.
CREATE TABLE IF NOT EXISTS worker_executions (
  execution_id    TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  project_id      INTEGER NOT NULL,
  epic_id         INTEGER NOT NULL,
  task_id         INTEGER NOT NULL,
  worker_id       TEXT NOT NULL,
  -- WORKER-NAMES-DESIGN: claim-time factory callsign (human visibility ONLY —
  -- the UUID worker_id/execution_id above remain the authority identifiers
  -- everywhere: joins, fences, receipts, journal correlation, file names).
  -- Stamped inside the claim transaction from the workshop name pool
  -- (src/worker-names.ts); unique among LIVE executions of one project; the
  -- name stays on the row for audit after the worker dies. Legacy rows read
  -- as COALESCE(display_name, hashName(worker_id)) — zero migration
  -- (ensureWorkerExecutionsDisplayName applies the column to live DBs; no
  -- SCHEMA_VERSION bump: additive-only, db.ts pre-release disposal policy).
  display_name    TEXT,
  machine_id      TEXT NOT NULL,
  launcher        TEXT NOT NULL DEFAULT 'claude_cli',
  state           TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (state IN ('reserved','running','cancel_requested',
                                     'exited','spawn_failed','lost','terminated')),
  phase           TEXT NOT NULL
                    CHECK (phase IN ('executing','reviewing','finishing','integrating')),
  pid             INTEGER,
  process_birth_token TEXT,
  log_path        TEXT,
  reserved_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  phase_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  exit_code       INTEGER,
  last_error      TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  -- CONVEYOR Wave 5 supervision columns (CONVEYOR-MENTAL-MODEL §"Shift, pass,
  -- lease and heartbeat" + §"Safe automatic recovery"). TWO DISTINCT SIGNALS
  -- (§363-370) that must not be conflated — liveness renewal must NOT reset the
  -- progress-silence clock:
  --   * lease_expires_at — authority deadline. The supervisor renews it; when it
  --     passes, the execution loses the right to mutate (a stale worker cannot
  --     clear a newer fence). Independent of model behaviour.
  --   * heartbeat_at — LIVENESS timestamp: "the supervisor still owns this
  --     execution". The watchman advances it on every sweep. Touching it MUST
  --     NOT advance progress_at or the stuck clocks.
  --   * progress_at — PROGRESS timestamp: "the worker produced observable
  --     activity" (stdout/tool/stream). Drives stuck detection. Independent of
  --     lease renewal — a worker that never calls a tool keeps its lease but its
  --     progress clock keeps aging.
  --   * suspected_stuck_at — when the progress-silence grace first fired and the
  --     execution entered suspected_stuck. Drives the cancel-grace window.
  --   * cancel_requested_at — when cancellation was requested. Drives the
  --     terminate-after-grace window.
  -- An alive-but-silent worker is not released solely because progress_at is
  -- old; the stuck policy first records suspected_stuck, requests cancellation,
  -- waits a grace period, then terminates only a verified process identity.
  lease_expires_at  TEXT,
  heartbeat_at      TEXT,
  progress_at       TEXT,
  suspected_stuck_at TEXT,
  cancel_requested_at TEXT,
  stuck_state       TEXT NOT NULL DEFAULT 'active'
                     CHECK (stuck_state IN ('active','suspected_stuck','cancel_requested')),
  -- Operator SOFT-STOP protocol (schema v13). The void state is AUDIT-ONLY and
  -- additive: instead of widening the state CHECK above with a 'voided'
  -- literal (which would force a table rebuild), a voided execution keeps a
  -- terminal state value ('terminated') and is marked by voided_at IS NOT
  -- NULL. Every fence consumer (tool handlers, adoption, budget counters,
  -- reaper) tests the marker, never the state name.
  --   * voided_at   — when the operator soft-stop fenced this execution. NULL
  --                    means the execution was never recalled.
  --   * stop_fence  — per-execution monotonic stop generation. Bumped exactly
  --                    once inside the fence+rewind transaction so a stale
  --                    in-flight tool call can observe it change.
  stop_fence       INTEGER NOT NULL DEFAULT 0,
  voided_at        TEXT
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

-- Task dependencies (junction table)

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, depends_on_task_id)
);

-- Comments (threaded discussions on tasks)

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task templates

CREATE TABLE IF NOT EXISTS templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  template_data TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified notes (replaces summaries + status_updates + context)

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

-- Automatic activity log

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

-- Requirements & design artifacts (PRD, SRS, use cases, AC, FR, NFR, decisions).
-- Each artifact lives in a project (scope) and an epic (REQ-NNN episode),
-- carries a path to its .md doc, a code for queryability (AC-1, FR-3), and a
-- status mirroring the doc's Status header. parent_artifact_id forms the
-- within-episode hierarchy (AC → UC, FR → PRD, etc.).

CREATE TABLE IF NOT EXISTS artifacts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id             INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  type                TEXT NOT NULL
                        CHECK (type IN ('PRD','SRS','UC','AC','FR','NFR','decision','theme','brief','RULE','OQ','SPEC','hypothesis','business_metric')),
  code                TEXT,
  title               TEXT NOT NULL,
  path                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','in_review','accepted','superseded')),
  parent_artifact_id  INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  project_repository_id INTEGER REFERENCES project_repositories(id) ON DELETE SET NULL,
  content_hash        TEXT,
  accepted_hash       TEXT,
  drift_state         TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (drift_state IN ('unknown','clean','drifted')),
  evidence_status     TEXT CHECK (evidence_status IN ('confirmed','proposed','assumed','open','rejected','superseded') OR evidence_status IS NULL),
  -- Storage policy: where the artifact's authority lives.
  --   file_backed  — a real file at 'path' under project_repository.local_path;
  --                   content_hash is SHA-256 of the file bytes.
  --   db_native    — no physical file; canonical content lives in metadata.content;
  --                   content_hash is SHA-256 of canonicalJson(metadata.content).
  --                   A materialized projection file MAY exist but is not authority.
  --   external_ref — content referenced by an external durable ref (future).
  -- Checkpoint capture is fail-closed on this column: an artifact without a
  -- known storage_kind cannot be captured (CHECKPOINT_ARTIFACT_STORAGE_KIND_MISSING).
  storage_kind        TEXT NOT NULL DEFAULT 'file_backed'
                        CHECK (storage_kind IN ('file_backed','db_native','external_ref')),
  tags                TEXT NOT NULL DEFAULT '[]',
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- REQ-010 — CGAD §7 Phase 7 Semantic Conflict Model.
-- Typed conflict keys per task. Two tasks sharing a (key_type, key_value)
-- pair write-conflict SEMANTICALLY, not just at git-merge line level.
-- CGAD §22 forbidden construct §34: git conflict must not be the only
-- conflict detector. Key types in v1:
--   file_path        — two tasks touching the same file (git would catch this
--                       too, but having it typed lets us detect EARLIER, at
--                       planning time, before any worker starts).
--   schema           — two tasks touching the same DB schema / type definition.
--                       git might miss it (different files, same invariant).
--   public_protocol  — two tasks changing the same public API / RPC / message.
--   integration_branch — two tasks targeting the same integration branch
--                       (write-conflict at merge time).
-- Future v2 (out of scope): capability, invariant, aggregate, data_owner,
-- migration, security_boundary, benchmark_env, runtime_resource.
CREATE TABLE IF NOT EXISTS task_conflict_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key_type    TEXT NOT NULL CHECK (key_type IN (
                'file_path','schema','public_protocol','integration_branch'
              )),
  key_value   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, key_type, key_value)
);

-- REQ-011 — CGAD §4 third truth axis + §17 Runtime Observation Store.
-- Immutable observations of actual runtime/integration behaviour. Distinct
-- from verification_evidence (which is test-runner output against the AC
-- baseline) and from artifacts.accepted_hash (the Declared oracle).
-- CGAD P17: runtime observation CANNOT mutate the acceptance oracle. This
-- table is append-only by convention — there is no UPDATE path in the tools.
-- Linkage to artifacts/tasks is optional: a free-floating observation (e.g.
-- "prod error rate spike 2026-07-17") may have no task yet.
CREATE TABLE IF NOT EXISTS runtime_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id          INTEGER REFERENCES epics(id) ON DELETE CASCADE,
  task_id          INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  artifact_id      INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN (
                       'benchmark','canary','shadow','incident',
                       'runtime_metric','integration_output','other')),
  observed_value   TEXT NOT NULL,
  baseline_value   TEXT,
  observed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  content_hash     TEXT,
  observed_by      TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A planned verification task is not proof. Evidence is an immutable,
-- independently queryable result linked to both the verification task and AC.
-- outcome uses CGAD's 4-valued guard verdict (REQ-008):
--   passed   — Deterministic evidence confirmed the claim.
--   failed   — Deterministic evidence refuted the claim.
--   unknown  — Inputs insufficient; treat as denial (CGAD P14 deny-by-default).
--   error    — Provider or check crashed; denial AND an Incident must be filed.
-- Only 'passed' admits a transition (see assertVerificationPassed in lifecycle.ts).
CREATE TABLE IF NOT EXISTS verification_evidence (
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

-- REQ-012 — Trusted Provider Registry.
-- Catalogues the Trusted Guard Input Providers that are allowed to feed
-- evidence/state/decisions into a project's acceptance oracle. A provider is
-- either global (project_id IS NULL — applies to every project) or scoped to
-- one project. The three categories mirror the CGAD trust tiers:
--   deterministic_evidence — fully deterministic verifiers (tsc, eslint, jest).
--                            determinism='full'. These feed verification_evidence.
--   authoritative_state    — stateful systems of record (CI run status, git
--                            merge result, a release manager). determinism is
--                            'partial' (the result is reproducible only given
--                            the same external state).
--   authorized_decision    — a human-in-the-loop or policy decision (release
--                            approval, security sign-off). determinism='none'.
-- 'layer' is the optional CGAD L0..L4 stack layer the provider belongs to
-- (L0 toolchain, L1 language, L2 framework, L3 app, L4 ops) — lets callers
-- ask "which L0 providers are registered for this project?".
CREATE TABLE IF NOT EXISTS trusted_providers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  category        TEXT NOT NULL CHECK (category IN (
                    'deterministic_evidence','authoritative_state','authorized_decision')),
  name            TEXT NOT NULL,
  trust_basis     TEXT NOT NULL,
  determinism     TEXT NOT NULL CHECK (determinism IN ('full','partial','none')),
  scope           TEXT NOT NULL,
  layer           TEXT CHECK (layer IN ('L0','L1','L2','L3','L4') OR layer IS NULL),
  version         TEXT,
  config_path     TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deprecated')),
  registered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);

-- Traceability graph. Polymorphic target: another artifact OR a task in any
-- project. link_type names the relationship (covers / implements / derived_from
-- / depends_on / verified_by). This is the bridge between the requirements
-- project and the builders' kanban: an AC artifact (source) is 'implemented by'
-- a dev task (target_type='task').

CREATE TABLE IF NOT EXISTS artifact_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('artifact','task')),
  target_id     INTEGER NOT NULL,
  link_type     TEXT NOT NULL
                  CHECK (link_type IN ('covers','implements','derived_from','depends_on','verified_by','superseded_by','implements_spec')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, target_type, target_id, link_type)
);

-- Indexes

CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);
CREATE INDEX IF NOT EXISTS idx_episode_workflows_stage ON episode_workflows(stage);
CREATE INDEX IF NOT EXISTS idx_repository_checkouts_machine ON repository_checkouts(machine_id,status);
CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workplace_ref ON tasks(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);

CREATE INDEX IF NOT EXISTS idx_epics_priority ON epics(priority);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_epic ON artifacts(epic_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(parent_artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_code ON artifacts(code);

-- The artifact catalogue is a forest, not a general graph. Traceability edges
-- belong in artifact_traces; parent_artifact_id must stay acyclic and inside
-- one project/episode. SQLite permits a freshly inserted row to reference its
-- own generated id, so the foreign key alone does not enforce this invariant.
CREATE TRIGGER IF NOT EXISTS trg_artifacts_parent_insert_guard
  BEFORE INSERT ON artifacts
  WHEN NEW.parent_artifact_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM artifacts p
       WHERE p.id=NEW.parent_artifact_id
         AND p.project_id=NEW.project_id
         AND p.epic_id=NEW.epic_id
    ) THEN RAISE(ABORT, 'artifact parent must be an existing artifact in the same project and epic') END;
  END;

CREATE TRIGGER IF NOT EXISTS trg_artifacts_parent_update_guard
  BEFORE UPDATE OF parent_artifact_id, project_id, epic_id ON artifacts
  WHEN NEW.parent_artifact_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NEW.parent_artifact_id=NEW.id THEN
      RAISE(ABORT, 'artifact cannot be its own parent') END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM artifacts p
       WHERE p.id=NEW.parent_artifact_id
         AND p.project_id=NEW.project_id
         AND p.epic_id=NEW.epic_id
    ) THEN RAISE(ABORT, 'artifact parent must be in the same project and epic') END;
    SELECT CASE WHEN EXISTS (
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_artifact_id
        UNION
        SELECT a.parent_artifact_id
          FROM artifacts a JOIN ancestors x ON a.id=x.id
         WHERE a.parent_artifact_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE id=NEW.id
    ) THEN RAISE(ABORT, 'artifact parent would create a cycle') END;
  END;

CREATE INDEX IF NOT EXISTS idx_verification_evidence_artifact ON verification_evidence(artifact_id, outcome);
CREATE INDEX IF NOT EXISTS idx_runtime_observations_epic ON runtime_observations(epic_id);
CREATE INDEX IF NOT EXISTS idx_runtime_observations_task ON runtime_observations(task_id);
CREATE INDEX IF NOT EXISTS idx_runtime_observations_artifact ON runtime_observations(artifact_id);
CREATE INDEX IF NOT EXISTS idx_runtime_observations_type ON runtime_observations(observation_type);
CREATE INDEX IF NOT EXISTS idx_task_conflict_keys_task ON task_conflict_keys(task_id);
CREATE INDEX IF NOT EXISTS idx_task_conflict_keys_kv ON task_conflict_keys(key_type, key_value);
CREATE INDEX IF NOT EXISTS idx_traces_source ON artifact_traces(source_id);
CREATE INDEX IF NOT EXISTS idx_traces_target ON artifact_traces(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_traces_link ON artifact_traces(link_type);
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
CREATE INDEX IF NOT EXISTS idx_worker_executions_project_state
  ON worker_executions(project_id, state);
CREATE INDEX IF NOT EXISTS idx_worker_executions_epic_state
  ON worker_executions(epic_id, state);
CREATE INDEX IF NOT EXISTS idx_worker_executions_task
  ON worker_executions(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_executions_one_active_task
  ON worker_executions(task_id)
  WHERE state IN ('reserved','running','cancel_requested');
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_executions_one_active_worker
  ON worker_executions(worker_id)
  WHERE state IN ('reserved','running','cancel_requested');

CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);

CREATE INDEX IF NOT EXISTS idx_trusted_providers_project ON trusted_providers(project_id, status);

-- ---------------------------------------------------------------------------
-- Lifecycle command kernel (ADR-010/ADR-011, blueprint §10).
-- Added in Slice 1 (terminal execution kernel). Purely additive: existing
-- rows are untouched; the new tables start empty and are written only by the
-- command bus (src/lifecycle/command-bus.ts).
-- ---------------------------------------------------------------------------

-- Idempotent receipts. One row per submitted command, whether accepted or
-- deterministically rejected (blueprint §10:477-478). A retry with the same
-- command_id AND the same payload_hash replays the stored reply without
-- re-running effects; a retry with the same command_id but a different
-- payload_hash is rejected as IDEMPOTENCY_KEY_REUSED.
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id      TEXT PRIMARY KEY,
  command_kind    TEXT NOT NULL,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('controller','managed_execution','integration_executor','human','admin')),
  actor_id        TEXT,          -- controller/admin/human id; NULL for managed_execution (use execution_id below)
  execution_id    TEXT,          -- set when actor_kind='managed_execution' or 'integration_executor'
  task_id         INTEGER,       -- target task, if any
  payload_hash    TEXT NOT NULL, -- SHA-256 of canonical command payload
  accepted        INTEGER NOT NULL CHECK (accepted IN (0,1)),
  rejection_code  TEXT,          -- DomainRejectionCode when accepted=0
  result_json     TEXT,          -- decision.result when accepted=1
  accepted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reply_json      TEXT NOT NULL  -- the byte-equivalent reply to return on replay
);

-- Lifecycle event log. Audit trail + projection input. NOT the source of
-- truth (blueprint §1 non-goals; ADR-011 keeps tasks/worker_executions
-- authoritative during the Slice 1-7 rollout). Append-only.
CREATE TABLE IF NOT EXISTS lifecycle_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id      TEXT NOT NULL REFERENCES command_receipts(command_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,        -- position within this command's events (0,1,2,…)
  event_kind      TEXT NOT NULL,
  task_id         INTEGER,
  payload_json    TEXT NOT NULL,           -- full DomainEvent object
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (command_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_command_receipts_task ON command_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_command_receipts_execution ON command_receipts(execution_id);
CREATE INDEX IF NOT EXISTS idx_command_receipts_kind_accepted ON command_receipts(command_kind, accepted);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_task ON lifecycle_events(task_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_kind ON lifecycle_events(event_kind);

-- ---------------------------------------------------------------------------
-- saga4 cutover: task_work_items + work_attempts tables REMOVED. The
-- "work-item shadow model" (Slice 2) was never finished — its repository,
-- compatibility projector, and backfill migration had zero production
-- importers and were deleted. The tables existed only to serve that dead code.

-- ---------------------------------------------------------------------------
-- Human requests (ADR-011, blueprint §12.3 line 565-578, §16 Slice 3 line 871-883).
-- Added in Slice 3. Purely additive. ASK is terminal: when a worker calls
-- worker_ask_need, the execution is released and an open human_request row
-- is inserted. worker_next excludes tasks with an open request. A fresh
-- worker later claims the task and receives the persisted question/answer
-- context. This kills the ASK dead-assignment trap the audit identified.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS human_requests (
  request_id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The execution that asked the question. Terminalized when the request
  -- was opened; recorded here so a replay or duplicate answer cannot
  -- resurrect it.
  requesting_execution_id TEXT,
  -- 'implementation' | 'review' | 'integration' — the phase a fresh worker
  -- must resume in once the human answers.
  resume_phase TEXT NOT NULL
    CHECK (resume_phase IN ('implementation','review','integration')),
  -- The question the worker asked, verbatim. Fresh workers read this to
  -- know what to ask the human.
  question TEXT NOT NULL,
  -- Free-form context the worker saved (file:line references, checkpoint,
  -- source/worktree SHAs). Blueprint §12.3 step 1.
  context_json TEXT NOT NULL DEFAULT '{}',
  -- The human's answer, recorded by worker_ask_done. NULL while open.
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','answered','cancelled')),
  -- The execution that processed the answer (the fresh worker). NULL until
  -- a worker claims the answered task.
  resuming_execution_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_human_requests_task_state ON human_requests(task_id, state);
CREATE INDEX IF NOT EXISTS idx_human_requests_open ON human_requests(state) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_human_requests_requesting_exec ON human_requests(requesting_execution_id);

-- ---------------------------------------------------------------------------
-- Integration intents (ADR-011, blueprint §13.1 line 584-611, §16 Slice 5
-- line 900-912). Added in Slice 5. Purely additive.
--
-- An integration intent is a durable record that "review approved merging
-- <source-sha> into <target>". The deterministic Git executor consults it
-- before merging and updates it after observing the result. The intent
-- survives process death — a crashed executor is recovered by observing
-- repository ancestry, not by LLM-guessing.
--
-- Crash recovery (blueprint §13 line 669-676):
--   - before update-ref: the temp merge commit/worktree may be discarded;
--   - after update-ref, before DB ack: ancestry observation recovers success;
--   - after DB ack, before outbox completion: same command_id replays stored
--     response.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_intents (
  integration_id          TEXT PRIMARY KEY,
  -- Idempotency key per blueprint §13.1:607-611. One intent per
  -- (repo, task, review-cycle, reviewed-source-sha, target-branch) — a
  -- replay with the same values returns the existing intent.
  intent_key              TEXT NOT NULL UNIQUE,
  originating_command_id  TEXT,
  task_id                 INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_repository_id   INTEGER,
  source_branch           TEXT NOT NULL,
  -- The exact commit review approved. If source_branch has advanced since,
  -- the executor emits SOURCE_ADVANCED_AFTER_REVIEW (blueprint §13.3:625).
  reviewed_source_sha     TEXT NOT NULL,
  target_branch           TEXT NOT NULL,
  -- The target head observed at intent-creation. The executor's update-ref
  -- uses this as the CAS expected-old value (blueprint §13.3:648-654).
  expected_target_sha     TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','running','merged','conflict',
                                             'base_advanced','retryable','dead')),
  executor_execution_id   TEXT,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  available_at            TEXT NOT NULL DEFAULT (datetime('now')),
  result_commit           TEXT,
  conflict_files          TEXT,   -- JSON array of paths
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_intents_task ON integration_intents(task_id);
CREATE INDEX IF NOT EXISTS idx_integration_intents_repo_state ON integration_intents(project_repository_id, state);
CREATE INDEX IF NOT EXISTS idx_integration_intents_state ON integration_intents(state);

-- ---------------------------------------------------------------------------
-- Saga 3 protocol entities (Discovery Edition, roadmap §7).
-- WorkIntent and Proposal are the deterministic-kernel ↔ product-worker
-- contract. They are deliberately NOT artifacts: artifacts are requirements &
-- design documents (PRD/SRS/UC/AC…), not inter-plane protocol messages. These
-- tables are shared by every Saga 3 stage (discovery today; formalization /
-- planning / development later) — kind + schema_version discriminate the
-- payload shape. Purely additive.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS factory_work_intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id         INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,             -- 'discovery', later 'formalization', etc.
  objective       TEXT NOT NULL,
  authority_scope TEXT NOT NULL,             -- JSON AuthorityScope
  output_schema   TEXT NOT NULL,             -- schema version the worker must emit
  token_budget    INTEGER NOT NULL DEFAULT 0,
  retry_budget    INTEGER NOT NULL DEFAULT 0,
  projected_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','executing','paused','concluded','cancelled')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WorkIntent freezes capability and product-contract authority before claim.
-- Only projected_task_id, status, and updated_at are mutable lifecycle fields.
${WORK_INTENT_CONTRACT_IMMUTABILITY_SQL}

-- Exact managed material frozen atomically with accepted worker_done. The
-- Production Cell seal reads this immutable ProductRef instead of the live
-- Workplace desk, closing the post-completion mutation race.
CREATE TABLE IF NOT EXISTS factory_execution_completion_products (
  execution_id TEXT NOT NULL REFERENCES worker_executions(execution_id),
  work_intent_id INTEGER NOT NULL REFERENCES factory_work_intents(id),
  workplace_ref TEXT NOT NULL REFERENCES factory_workplaces(workplace_ref),
  schema_id TEXT NOT NULL,
  product_ref TEXT NOT NULL,
  product_digest TEXT NOT NULL,
  worker_done_command_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_id, schema_id)
);

CREATE TRIGGER IF NOT EXISTS trg_factory_execution_completion_products_immutable_update
BEFORE UPDATE ON factory_execution_completion_products BEGIN
  SELECT RAISE(ABORT, 'FACTORY_COMPLETION_PRODUCT_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_execution_completion_products_immutable_delete
BEFORE DELETE ON factory_execution_completion_products BEGIN
  SELECT RAISE(ABORT, 'FACTORY_COMPLETION_PRODUCT_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS factory_raw_submissions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id             INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  task_id               INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id          TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  raw_payload           TEXT NOT NULL,
  raw_hash              TEXT NOT NULL,
  parsed_payload        TEXT,
  status                TEXT NOT NULL
                          CHECK (status IN ('accepted_deterministically','normalization_required','rejected_syntax','normalized')),
  normalization_trace   TEXT NOT NULL DEFAULT '[]',
  validation_errors     TEXT NOT NULL DEFAULT '[]',
  alias_conflicts       TEXT NOT NULL DEFAULT '[]',
  allowed_evidence_refs TEXT NOT NULL DEFAULT '[]',
  provenance            TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_control_intents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id               INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  question              TEXT NOT NULL,
  source_submission_id  INTEGER NOT NULL UNIQUE REFERENCES factory_raw_submissions(id) ON DELETE CASCADE,
  authority_intent_id   INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  projected_task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','executing','paused','concluded','cancelled')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_normalization_proposals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  control_intent_id     INTEGER NOT NULL REFERENCES factory_control_intents(id) ON DELETE CASCADE,
  source_submission_id  INTEGER NOT NULL REFERENCES factory_raw_submissions(id) ON DELETE CASCADE,
  task_id               INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id          TEXT NOT NULL,
  payload               TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
  provenance            TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_raw_submission_idempotency
  ON factory_raw_submissions(intent_id, execution_id, raw_hash);
CREATE INDEX IF NOT EXISTS idx_factory_raw_submission_intent
  ON factory_raw_submissions(intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_normalization_idempotency
  ON factory_normalization_proposals(control_intent_id, execution_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_factory_control_epic
  ON factory_control_intents(epic_id, status);

-- D3: shadow readiness advisor. A readiness ControlIntent is keyed by the
-- IMMUTABLE Proposal version (proposal_id + proposal_content_hash), not by a
-- raw submission: a changed content hash is a new assessment target. This is
-- a separate table from factory_control_intents (whose UNIQUE is on
-- source_submission_id) so the two control kinds never collide.
CREATE TABLE IF NOT EXISTS factory_readiness_control_intents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id               INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,                        -- 'AssessDiscoveryReadiness'
  proposal_id           INTEGER NOT NULL REFERENCES factory_proposals(id) ON DELETE CASCADE,
  proposal_content_hash TEXT NOT NULL,                        -- binds to one immutable Proposal version
  source_intent_id      INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  authority_intent_id   INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  projected_task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','executing','paused','concluded','cancelled')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_readiness_assessments (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  control_intent_id        INTEGER NOT NULL REFERENCES factory_readiness_control_intents(id) ON DELETE CASCADE,
  proposal_id              INTEGER NOT NULL REFERENCES factory_proposals(id) ON DELETE CASCADE,
  proposal_content_hash    TEXT NOT NULL,
  task_id                  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id             TEXT NOT NULL,
  payload                  TEXT NOT NULL,
  content_hash             TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'submitted'
                             CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
  overall_readiness        TEXT,                              -- denormalized for shadow visibility
  recommended_next_action  TEXT,
  validation_errors        TEXT NOT NULL DEFAULT '[]',        -- durable rejection reasons (P0: rejected assessments must survive)
  provenance               TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One readiness ControlIntent per immutable Proposal version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_readiness_control_target
  ON factory_readiness_control_intents(proposal_id, proposal_content_hash);
-- Idempotent submission keyed by immutable assessment target + submitted
-- content, INDEPENDENT of execution_id (P1-3): a restart with a new execution
-- must reuse the same assessment row, not create a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_readiness_assessment_idempotency
  ON factory_readiness_assessments(control_intent_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_factory_readiness_control_epic
  ON factory_readiness_control_intents(epic_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_readiness_assessment_control
  ON factory_readiness_assessments(control_intent_id);

-- D4: authoritative discovery settlement. A settlement binds the immutable
-- settlement INPUT (proposal hash + readiness hash + policy version/hash) to a
-- deterministic kernel decision. Kernel-only: no LM WorkIntent, no worker task.
-- Provisional Proposal lineage is separate and never mutated here.
CREATE TABLE IF NOT EXISTS factory_discovery_settlements (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  proposal_id                 INTEGER NOT NULL REFERENCES factory_proposals(id) ON DELETE CASCADE,
  proposal_content_hash       TEXT NOT NULL,
  readiness_assessment_id     INTEGER,                           -- nullable: no accepted assessment
  readiness_assessment_hash   TEXT NOT NULL,                     -- sentinel 'none' when null assessment
  policy_version              TEXT NOT NULL,
  policy_hash                 TEXT NOT NULL,
  input_snapshot              TEXT NOT NULL,                     -- canonical JSON of the input snapshot
  input_hash                  TEXT NOT NULL,                     -- SHA-256 over input_snapshot
  decision                    TEXT NOT NULL
                                CHECK (decision IN ('go','clarify','reject')),
  reason_codes                TEXT NOT NULL DEFAULT '[]',        -- JSON array of stable codes
  rationale                   TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'computed'
                                CHECK (status IN ('computed','certificate_issued','failed')),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- D4: the immutable outcome certificate. 1:1 with a settlement. There is no
-- UPDATE path for this table in code — certificates are write-once.
CREATE TABLE IF NOT EXISTS factory_discovery_outcome_certificates (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id               INTEGER NOT NULL UNIQUE REFERENCES factory_discovery_settlements(id) ON DELETE CASCADE,
  epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  proposal_id                 INTEGER NOT NULL REFERENCES factory_proposals(id) ON DELETE CASCADE,
  proposal_content_hash       TEXT NOT NULL,
  readiness_assessment_id     INTEGER,
  readiness_assessment_hash   TEXT NOT NULL,
  policy_version              TEXT NOT NULL,
  policy_hash                 TEXT NOT NULL,
  decision                    TEXT NOT NULL
                                CHECK (decision IN ('go','clarify','reject')),
  reason_codes                TEXT NOT NULL DEFAULT '[]',
  input_hash                  TEXT NOT NULL,
  certificate_payload         TEXT NOT NULL,                     -- canonical JSON of the certificate payload
  certificate_hash            TEXT NOT NULL UNIQUE,              -- integrity check, write-once
  issued_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One settlement per immutable INPUT target. A changed proposal hash, a
-- changed readiness hash, or a new policy version is a NEW target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_settlement_input
  ON factory_discovery_settlements(
    proposal_id, proposal_content_hash, readiness_assessment_hash,
    policy_version, policy_hash);
CREATE INDEX IF NOT EXISTS idx_factory_settlement_epic
  ON factory_discovery_settlements(epic_id, status);

-- D5: advisory diagnosis. A diagnosis control binds an immutable certificate
-- TARGET (certificate_id + certificate_hash + diagnosis contract version) to a
-- bounded diagnosis worker task. A report row retains the worker's typed
-- payload, content hash, status, separate provenance. The diagnosis is ADVISORY
-- — it never mutates the D4 settlement/certificate, the product Proposal, or
-- the readiness assessment.
CREATE TABLE IF NOT EXISTS factory_discovery_diagnosis_control_intents (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  kind                        TEXT NOT NULL DEFAULT 'DiagnoseDiscoveryOutcome',
  certificate_id              INTEGER NOT NULL REFERENCES factory_discovery_outcome_certificates(id) ON DELETE CASCADE,
  certificate_hash            TEXT NOT NULL,
  settlement_input_hash       TEXT NOT NULL,
  diagnosis_case              TEXT NOT NULL,         -- canonical JSON of the immutable DiagnosisCase
  diagnosis_case_hash         TEXT NOT NULL,         -- SHA-256 over the case (captured_at excluded)
  diagnosis_contract_version  TEXT NOT NULL,
  authority_intent_id         INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  projected_task_id           INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  status                      TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','executing','paused','concluded','cancelled')),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_discovery_diagnosis_reports (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  control_intent_id           INTEGER NOT NULL REFERENCES factory_discovery_diagnosis_control_intents(id) ON DELETE CASCADE,
  certificate_id              INTEGER NOT NULL,
  certificate_hash            TEXT NOT NULL,
  task_id                     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id                TEXT NOT NULL,
  schema_version              TEXT NOT NULL,
  payload                     TEXT NOT NULL,         -- canonical JSON of the report payload
  content_hash                TEXT NOT NULL,         -- hashDiagnosisReport(payload)
  status                      TEXT NOT NULL DEFAULT 'submitted'
                                CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
  validation_errors           TEXT NOT NULL DEFAULT '[]',  -- JSON array; durable rejection reasons
  provenance                  TEXT NOT NULL DEFAULT '{}',
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One control per immutable certificate target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_diagnosis_control_target
  ON factory_discovery_diagnosis_control_intents(certificate_id, certificate_hash, diagnosis_contract_version);
CREATE INDEX IF NOT EXISTS idx_factory_diagnosis_control_epic
  ON factory_discovery_diagnosis_control_intents(epic_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_diagnosis_reports_control
  ON factory_discovery_diagnosis_reports(control_intent_id);
-- Idempotency: replaying the same report (same control + content hash) under a
-- new execution returns the existing row. execution_id is NOT in the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_diagnosis_reports_idempotency
  ON factory_discovery_diagnosis_reports(control_intent_id, content_hash);
-- P0-2: at-most-one accepted report per control (structural second line of
-- defence; the runtime check lives inside BEGIN IMMEDIATE in the repo function).
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_diagnosis_reports_one_accepted
  ON factory_discovery_diagnosis_reports(control_intent_id) WHERE status='accepted_by_kernel';

CREATE TABLE IF NOT EXISTS factory_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id       INTEGER NOT NULL REFERENCES factory_work_intents(id) ON DELETE CASCADE,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id    TEXT NOT NULL,             -- worker_executions fence (not FK: row may be pruned)
  kind            TEXT NOT NULL,             -- mirrors WorkIntent.kind ('discovery', …)
  schema_version  TEXT NOT NULL,             -- contract version, owned by the kernel
  payload         TEXT NOT NULL,             -- raw worker JSON (canonical, for hash reproducibility)
  content_hash    TEXT NOT NULL,             -- SHA-256 of canonical payload
  status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','superseded','rejected_by_kernel')),
  provenance      TEXT NOT NULL DEFAULT '{}',-- auto-captured model/provider/effort/worker/exec/time
  source_submission_id INTEGER REFERENCES factory_raw_submissions(id) ON DELETE SET NULL,
  normalization_proposal_id INTEGER REFERENCES factory_normalization_proposals(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_factory_work_intents_epic ON factory_work_intents(epic_id);
CREATE INDEX IF NOT EXISTS idx_factory_work_intents_kind_status ON factory_work_intents(kind, status);
CREATE INDEX IF NOT EXISTS idx_factory_proposals_intent ON factory_proposals(intent_id);
CREATE INDEX IF NOT EXISTS idx_factory_proposals_task ON factory_proposals(task_id);
CREATE INDEX IF NOT EXISTS idx_factory_proposals_kind ON factory_proposals(kind);
-- Idempotency: replaying the same submission (same intent + execution +
-- content hash) must return the existing proposal, not create a duplicate.
-- The worker's skill allows "fix the payload and submit once more" — without
-- this UNIQUE, a second submission of the corrected payload would shadow the
-- first on readLatestProposalForIntent (ORDER BY id DESC). With it, an exact
-- replay is a no-op; a corrected payload has a different content_hash and
-- inserts normally (the engine reads the latest by id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_proposals_idempotency
  ON factory_proposals(intent_id, execution_id, content_hash);
-- saga4: factory_lifecycle_runs is now read by production code (project_delete
-- safety guard), so it must exist in the base schema, not just as a lazy
-- CREATE in the lifecycle-run-repository constructor.
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
  ON factory_lifecycle_runs(project_id, lifecycle_ref_key, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_factory_lifecycle_runs_status
  ON factory_lifecycle_runs(project_id, status);

-- saga4: lifecycle_execution_controls — per-epic engine state + model route,
-- the new home for fields being migrated out of episode_workflows.metadata.
-- See docs/design/saga4-cutover/EXECUTION-PLAN.md blocks A.1 + A.2.
CREATE TABLE IF NOT EXISTS lifecycle_execution_controls (
  epic_id              INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
  engine_state         TEXT NOT NULL DEFAULT 'stopped'
                         CHECK (engine_state IN ('running','stopped','unknown','failed_watchdog')),
  engine_pid           INTEGER,
  concurrency          INTEGER,
  started_at           TEXT,
  stopped_at           TEXT,
  concurrency_changed_at TEXT,
  model_provider       TEXT,
  model_name           TEXT,
  model_effort         TEXT,
  model_concurrency_limit INTEGER,
  -- Antifreeze layer C (schema v14): the human-readable WHY for a
  -- non-'running' engine_state. Written by the panel engine supervisor when
  -- the restart budget is exhausted (engine_state='failed_watchdog'), cleared
  -- on the next successful operator/manual start.
  last_error           TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_execution_controls_state
  ON lifecycle_execution_controls(engine_state);

-- ---------------------------------------------------------------------------
-- Cross-process supervision advisory lease (Wave 5 re-check 2026-08-02).
-- The in-process single-flight guard (a module-scoped Set of
-- "<projectId>:<epicId>" keys in worker-supervision-service.ts) only prevents
-- two sweeps within ONE Node process. Two separate orchestrate-cli processes on
-- the same DB can still reconcile the same (projectId, epicId) scope
-- simultaneously. SQLite has no native advisory-lock primitive, so this table
-- implements a compare-and-swap advisory lease:
--   - scope_key   — the supervised scope, "<projectId>:<epicId>".
--   - holder_id   — a unique per-process id (os.hostname()+pid+random) so the
--                   row owner can be identified and re-enter its own lease.
--   - expires_at  — lease deadline. A row past expires_at is stale and may be
--                   claimed by another process; the holder renews on every sweep.
-- Acquire: INSERT a row only if no UNEXPIRED row exists for scope_key, OR the
-- unexpired row is already mine (WHERE holder_id = me). On conflict the CAS
-- fails and the sweep is skipped (another process owns the scope).
-- Release: DELETE WHERE holder_id = me (sweep exit, finally).
-- Purely additive; starts empty. The atomic-release fenced-CAS idempotency of
-- releaseExecutionAtomically remains the ultimate convergence guarantee, so a
-- lease bug can cause double bookkeeping but never a double release of one card.
CREATE TABLE IF NOT EXISTS supervision_locks (
  scope_key    TEXT PRIMARY KEY,
  holder_id    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supervision_locks_holder ON supervision_locks(holder_id);
CREATE INDEX IF NOT EXISTS idx_supervision_locks_expires ON supervision_locks(expires_at);

-- ---------------------------------------------------------------------------
-- Conveyor v4 — Workplace authoritative aggregate stores (step 1.2).
--
-- Target contracts: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05 (Workplace),
-- REG-09 (ExecutionReservation), REG-12 (CandidateSet), REG-15 (GateRun),
-- REG-17 (CheckReceipt), REG-18 (GateDecision).
--

-- tables remain the runtime authority until step 5 of the migration; these
-- tables are written in parallel (step 1.3 projection) and read by NOTHING
-- on the runtime path yet. The SCHEMA_VERSION is NOT bumped — pre-release
-- disposal policy applies (db.ts).
--
-- Identity convention: every Workplace-scoped row keys on the deterministic
-- serialized WorkplaceRef (see domain/workplace/workplace-ref.ts), NOT on the
-- transient tasks.id. This keeps the workplace stable across worker/reviewer/
-- repair attempts (REG-05-AC-01).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS factory_workplaces (
  -- Deterministic 'workplace/<processRunId>/<moduleRef>/<productionCellId>/<workKey>'.
  workplace_ref       TEXT PRIMARY KEY,
  process_run_id      INTEGER NOT NULL,
  module_ref          TEXT NOT NULL,
  production_cell_id  TEXT NOT NULL,
  work_key            TEXT NOT NULL,
  -- Two-channel state (REG-28).
  kanban_phase        TEXT NOT NULL
                        CHECK (kanban_phase IN ('todo','in_progress','review','review_in_progress','blocked','done','failed','cancelled')),
  loop_state          TEXT NOT NULL
                        CHECK (loop_state IN ('idle','queued','leased','running','verifying','effect_pending','repair_wait','paused','terminal')),
  next_role           TEXT NOT NULL CHECK (next_role IN ('author','reviewer')),
  terminal_reason     TEXT CHECK (terminal_reason IN ('accepted','failed','cancelled') OR terminal_reason IS NULL),
  -- Monotonic CAS token (REG-05-AC-06).
  revision            INTEGER NOT NULL DEFAULT 0,
  -- Active actor refs (at most one mutation actor may own a revision — REG-05-AC-02).
  active_reservation_ref TEXT,
  active_gate_ref         TEXT,
  active_recovery_case_ref TEXT,
  -- Immutable product/desk refs changed through their owning contexts.
  desk_ref                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_factory_workplaces_process_run ON factory_workplaces(process_run_id);
CREATE INDEX IF NOT EXISTS idx_factory_workplaces_loop_state ON factory_workplaces(loop_state);
CREATE INDEX IF NOT EXISTS idx_factory_workplaces_kanban_phase ON factory_workplaces(kanban_phase);

-- Fix-1 (worker feedback loop map): a human park (blocked/paused) must always
-- carry its reason. Append-only audit — one row per park event; the workplace
-- points at the park via active_recovery_case_ref. Rows are never updated or
-- deleted; a resume simply leaves them as history.
CREATE TABLE IF NOT EXISTS factory_workplace_park_reasons (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workplace_ref  TEXT NOT NULL REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  reason_code    TEXT NOT NULL,
  message        TEXT NOT NULL,
  evidence_refs  TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_factory_workplace_park_reasons_ref
  ON factory_workplace_park_reasons(workplace_ref);

-- ---------------------------------------------------------------------------
-- Operator SOFT-STOP protocol (schema v13).
--
-- Stopping a worker is a TYPED DURABLE protocol, never an inference from
-- process exit codes: (1) brake the engine, (2) fence + rewind the hire in one
-- transaction, (3) runner stop hook + guarded tree-kill, (4) checkpoint. The
-- two tables below are the durable audit trail of that protocol.
--
-- factory_worker_stops: one row per stopped worker execution (the hire being
-- recalled). The phase column is the protocol's progress marker; the boot
-- reaper uses it to converge crash windows (a stop row not yet killed/reaped
-- with a live persisted PID is completed on next boot).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS factory_worker_stops (
  stop_ref             TEXT PRIMARY KEY,
  worker_execution_ref TEXT NOT NULL REFERENCES worker_executions(execution_id) ON DELETE RESTRICT,
  workplace_ref        TEXT,
  project_id           INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  phase                TEXT NOT NULL
                         CHECK (phase IN ('planned','engine_braked','fenced','detached',
                                          'hook_sent','killed','reaped','checkpointed','abandoned')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worker_stops_execution
  ON factory_worker_stops(worker_execution_ref);
CREATE INDEX IF NOT EXISTS idx_factory_worker_stops_project
  ON factory_worker_stops(project_id);
CREATE INDEX IF NOT EXISTS idx_factory_worker_stops_phase
  ON factory_worker_stops(phase);

-- factory_operator_holds: the unpark surface. Every fence+rewind inserts one
-- hold for the rewound workplace (and the stop may insert one project-scope
-- hold). While a hold is active (released_at IS NULL) the claim SQL refuses to
-- hire that workplace/project — the operator, not the queue, owns the next
-- move. The unpark verb stamps released_at; hiring resumes.
CREATE TABLE IF NOT EXISTS factory_operator_holds (
  hold_ref     TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('workplace','project')),
  subject_ref  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  released_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_factory_operator_holds_subject
  ON factory_operator_holds(subject_kind, subject_ref, released_at);

-- A fan-out Production Cell is one immutable dependency graph, not a set of
-- task-status observations. task_dependencies is a rebuildable projection.
CREATE TABLE IF NOT EXISTS factory_workplace_graphs (
  graph_ref            TEXT PRIMARY KEY,
  process_run_id       INTEGER NOT NULL,
  module_ref           TEXT NOT NULL,
  production_cell_id   TEXT NOT NULL,
  graph_digest         TEXT NOT NULL,
  item_count           INTEGER NOT NULL CHECK (item_count > 0),
  edge_count           INTEGER NOT NULL CHECK (edge_count >= 0),
  sealed_at            TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (process_run_id, module_ref, production_cell_id)
);

CREATE TABLE IF NOT EXISTS factory_workplace_graph_items (
  graph_ref            TEXT NOT NULL,
  ordinal              INTEGER NOT NULL,
  item_id              TEXT NOT NULL,
  workplace_ref        TEXT NOT NULL,
  task_id              INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (graph_ref, item_id),
  UNIQUE (graph_ref, ordinal),
  UNIQUE (graph_ref, workplace_ref),
  UNIQUE (graph_ref, task_id),
  FOREIGN KEY (graph_ref) REFERENCES factory_workplace_graphs(graph_ref) ON DELETE RESTRICT,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS factory_workplace_dependencies (
  graph_ref                 TEXT NOT NULL,
  workplace_ref             TEXT NOT NULL,
  depends_on_workplace_ref  TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (graph_ref, workplace_ref, depends_on_workplace_ref),
  CHECK (workplace_ref <> depends_on_workplace_ref),
  FOREIGN KEY (graph_ref) REFERENCES factory_workplace_graphs(graph_ref) ON DELETE RESTRICT,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (depends_on_workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_factory_workplace_dependencies_dependent
  ON factory_workplace_dependencies(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_workplace_dependencies_prerequisite
  ON factory_workplace_dependencies(depends_on_workplace_ref);

CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_graphs_no_update
BEFORE UPDATE ON factory_workplace_graphs BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_graphs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_graphs_no_delete
BEFORE DELETE ON factory_workplace_graphs BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_graphs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_graph_items_no_update
BEFORE UPDATE ON factory_workplace_graph_items BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_graph_items are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_graph_items_no_delete
BEFORE DELETE ON factory_workplace_graph_items BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_graph_items are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_dependencies_no_update
BEFORE UPDATE ON factory_workplace_dependencies BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_dependencies are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_dependencies_no_delete
BEFORE DELETE ON factory_workplace_dependencies BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_dependencies are immutable');
END;

-- ADR-075 (no-human quality loop): durable recovery-epoch rollover for
-- production cells with recovery.onExhausted='requeue'. The three attempt
-- counters (rejected CandidateSets, terminal worker executions, failed
-- acceptance-effect repairs) are all-time and immutable, so a budget reset
-- can never be a deletion. Instead, each rollover appends one row snapshotting
-- the counter baselines at exhaustion; attempts-in-epoch = counter - baseline.
-- The table is append-only audit: one row per (workplace, role, epoch).
CREATE TABLE IF NOT EXISTS factory_workplace_recovery_epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workplace_ref              TEXT NOT NULL,
  role                       TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  epoch                      INTEGER NOT NULL,
  baseline_rejected_sets     INTEGER NOT NULL CHECK (baseline_rejected_sets >= 0),
  baseline_terminal_executions INTEGER NOT NULL CHECK (baseline_terminal_executions >= 0),
  baseline_effect_repairs    INTEGER NOT NULL CHECK (baseline_effect_repairs >= 0),
  exhausted_attempts         INTEGER NOT NULL CHECK (exhausted_attempts >= 0),
  max_attempts               INTEGER NOT NULL CHECK (max_attempts >= 1),
  total_attempts_cap         INTEGER NOT NULL CHECK (total_attempts_cap >= 1),
  last_diagnosis             TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref, role, epoch),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_workplace_recovery_epochs_workplace
  ON factory_workplace_recovery_epochs(workplace_ref, role, epoch DESC);

CREATE TRIGGER IF NOT EXISTS trg_workplace_recovery_epochs_no_update
BEFORE UPDATE ON factory_workplace_recovery_epochs BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_recovery_epochs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_workplace_recovery_epochs_no_delete
BEFORE DELETE ON factory_workplace_recovery_epochs BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_recovery_epochs are immutable');
END;

-- The stage input's expectedBaseCommit is a lineage anchor, not the base for
-- every fan-out author. Before an author is spawned the Factory freezes the
-- effective repository base for that exact execution. A root item may use
-- the lineage anchor; a dependent item uses the observed integration head
-- after all of its repository prerequisites have settled.
CREATE TABLE IF NOT EXISTS factory_effective_desk_base_receipts (
  receipt_ref                    TEXT PRIMARY KEY,
  execution_ref                  TEXT NOT NULL UNIQUE,
  task_id                        INTEGER NOT NULL,
  workplace_ref                  TEXT NOT NULL,
  process_run_id                 INTEGER NOT NULL,
  project_repository_id          INTEGER NOT NULL,
  integration_branch             TEXT NOT NULL,
  lineage_anchor_commit          TEXT NOT NULL,
  effective_base_commit          TEXT NOT NULL,
  observed_integration_head      TEXT NOT NULL,
  dependency_task_ids            TEXT NOT NULL DEFAULT '[]',
  dependency_integrated_commits  TEXT NOT NULL DEFAULT '[]',
  receipt_digest                 TEXT NOT NULL UNIQUE,
  created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (project_repository_id) REFERENCES project_repositories(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_factory_effective_desk_base_task
  ON factory_effective_desk_base_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_factory_effective_desk_base_workplace
  ON factory_effective_desk_base_receipts(workplace_ref);

CREATE TRIGGER IF NOT EXISTS trg_factory_effective_desk_base_no_update
BEFORE UPDATE ON factory_effective_desk_base_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_effective_desk_base_receipts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_effective_desk_base_no_delete
BEFORE DELETE ON factory_effective_desk_base_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_effective_desk_base_receipts are immutable');
END;

-- CONVEYOR §20 — the durable EffectAttempt.
--
-- An EffectReceipt records only that an authorized external change SUCCEEDED:
-- it has no outcome column, so "a receipt exists" IS the success. That makes
-- every NON-successful effect invisible. Before this table, an effect that
-- returned 'pending' left no durable trace at all: the Workplace stayed in
-- effect_pending, the run-effects obligation could complete on an unrelated
-- postcondition branch, and the node re-entered forever with nothing owning
-- the next mutation (observed live: 9004 consecutive runtime.paused NodeRuns
-- on one implement-work-items node, zero pending obligations).
--
-- Every invocation of a post-acceptance effect therefore appends one immutable
-- attempt carrying the model's four-valued outcome. idempotency_key is the
-- exact desired-state identity (the acceptance digest), so attempts for one
-- accepted material are countable and a never-settling effect is detectable
-- and boundable instead of silent.
CREATE TABLE IF NOT EXISTS factory_effect_attempts (
  attempt_ref              TEXT PRIMARY KEY,
  workplace_ref            TEXT NOT NULL,
  effect_id                TEXT NOT NULL,
  effect_version           TEXT NOT NULL,
  effect_digest            TEXT NOT NULL,
  candidate_set_ref        TEXT NOT NULL,
  gate_decision_key        TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  attempt_no               INTEGER NOT NULL,
  outcome                  TEXT NOT NULL
    CHECK (outcome IN ('succeeded','pending','repair_required','human_required','policy_terminal')),
  reason                   TEXT,
  provider_receipt_ref     TEXT,
  evidence_snapshot        TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref,effect_id,idempotency_key,attempt_no),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_set_ref) REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_factory_effect_attempts_subject
  ON factory_effect_attempts(workplace_ref,effect_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_factory_effect_attempts_outcome
  ON factory_effect_attempts(outcome,workplace_ref);

CREATE TRIGGER IF NOT EXISTS trg_factory_effect_attempts_no_update
BEFORE UPDATE ON factory_effect_attempts BEGIN
  SELECT RAISE(ABORT, 'factory_effect_attempts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_effect_attempts_no_delete
BEFORE DELETE ON factory_effect_attempts BEGIN
  SELECT RAISE(ABORT, 'factory_effect_attempts are immutable');
END;

CREATE TABLE IF NOT EXISTS factory_cell_effect_receipts (
  effect_receipt_ref       TEXT PRIMARY KEY,
  workplace_ref            TEXT NOT NULL,
  effect_id                TEXT NOT NULL,
  candidate_set_ref        TEXT NOT NULL,
  gate_decision_key        TEXT NOT NULL,
  provider_receipt_ref     TEXT NOT NULL,
  provider_receipt_digest  TEXT NOT NULL,
  evidence_snapshot        TEXT NOT NULL DEFAULT '{}',
  receipt_digest           TEXT NOT NULL UNIQUE,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref,effect_id,candidate_set_ref),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_set_ref) REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  FOREIGN KEY (gate_decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT
);

-- A post-acceptance effect may prove that accepted material still requires a
-- product repair. The Gate remains accepted; this immutable issue is the
-- causal repair evidence and terminal postcondition of that RunEffects handoff.
CREATE TABLE IF NOT EXISTS factory_cell_effect_repair_issues (
  effect_repair_ref        TEXT PRIMARY KEY,
  workplace_ref            TEXT NOT NULL,
  effect_id                TEXT NOT NULL,
  effect_version           TEXT NOT NULL,
  effect_digest            TEXT NOT NULL,
  candidate_set_ref        TEXT NOT NULL,
  production_revision_ref  TEXT NOT NULL,
  gate_decision_key        TEXT NOT NULL,
  gate_decision_digest     TEXT NOT NULL,
  acceptance_digest        TEXT NOT NULL,
  expected_workplace_revision INTEGER NOT NULL,
  resulting_workplace_revision INTEGER NOT NULL,
  issue_snapshot           TEXT NOT NULL,
  issue_digest             TEXT NOT NULL,
  receipt_digest           TEXT NOT NULL UNIQUE,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref,effect_id,gate_decision_key),
  CHECK (resulting_workplace_revision=expected_workplace_revision+1),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_set_ref) REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  FOREIGN KEY (production_revision_ref) REFERENCES factory_workplace_production_revisions(revision_ref) ON DELETE RESTRICT,
  FOREIGN KEY (gate_decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS factory_cell_final_acceptances (
  final_acceptance_ref     TEXT PRIMARY KEY,
  workplace_ref            TEXT NOT NULL UNIQUE,
  candidate_set_ref        TEXT NOT NULL,
  gate_decision_key        TEXT NOT NULL,
  effect_receipt_refs      TEXT NOT NULL DEFAULT '[]',
  acceptance_digest        TEXT NOT NULL UNIQUE,
  -- BLINDSIGHT C2 — the cross-plan rejection history bound into the
  -- digest-covered acceptance body (plan-swap laundering must stay visible).
  rejection_history        TEXT NOT NULL DEFAULT '[]',
  accepted_at              TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_set_ref) REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  FOREIGN KEY (gate_decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT
);

-- ADR-053 C1 — durable CURRENT accepted-author authority pointer. Exactly one
-- row per workplace (PK). Written atomically with the author-gate-accept CAS
-- transition, so the accepted author CandidateSet is an explicit durable fact,
-- never reconstructed by candidate_set_ref hash order or sealed_at/decided_at
-- recency. The reviewer subject pin, reviewer projection and crash recovery all
-- read this exact pointer (see SqliteAcceptedAuthorityHeadRepository +
-- ProductionCellCoordinator.applyAcceptanceEvent).
--
-- ADR-053 C5 (commit 3c5decc) — the head ALSO persists the identity of the
-- workplace task whose material it accepted ('accepted_author_task_id'). This
-- is the carry-forward-safe task binding: neither submission.task_id (the
-- ORIGIN process's task, wrong after carry-forward) nor ORDER BY t.id DESC
-- (recency, wrong in repair cycles) is authority. The HEAD is the authority
-- carrying task identity, so downstream integration (C5-03) selects the
-- task from this exact pointer. Nullable: pre-C5-02 heads and heads recorded before
-- the coordinator wires the task id have NULL (additive column, no row reset).
--
-- K13 (M3, card commit 2 — one schema migration family) — the head carries
-- the BYTE-IDENTICAL accepted identity, superseding the minimal-pointer
-- audit decision of 09687df7 (the release card is the specification):
--   acceptance_id              content address over the full identity body;
--   check_plan_digest          the accepting decision's frozen check plan;
--   package_fingerprint        the accepting decision's installation digest;
--   production_revision_ref    the accepted CandidateSet's revision;
--   product_refs               the CandidateSet members, ordinal order (JSON);
--   baseline_workplace_revision  the CAS revision the commit was fenced on.
-- Same accepted revision ⇒ byte-identical identity is now enforced ON the
-- head row (AUTHORITY_HEAD_IDENTITY_CONFLICT names the drifted dimension).
-- The columns are NULLable ONLY for rows written before this extension (the
-- idempotent repository ensure upgrades a pre-K13 table in place, preserving
-- rows); every K13-era record populates all of them.
CREATE TABLE IF NOT EXISTS factory_accepted_authority_head (
  workplace_ref                        TEXT PRIMARY KEY,
  accepted_author_candidate_set_ref    TEXT NOT NULL,
  accepted_author_gate_decision_key    TEXT NOT NULL,
  revision                             INTEGER NOT NULL,
  recorded_at                          TEXT NOT NULL,
  accepted_author_task_id              TEXT,
  acceptance_id                        TEXT,
  check_plan_digest                    TEXT,
  package_fingerprint                  TEXT,
  production_revision_ref              TEXT,
  product_refs                         TEXT,
  baseline_workplace_revision          INTEGER,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS trg_factory_cell_effect_receipts_no_update
BEFORE UPDATE ON factory_cell_effect_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_cell_effect_receipts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_cell_effect_receipts_no_delete
BEFORE DELETE ON factory_cell_effect_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_cell_effect_receipts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_cell_effect_repair_issues_no_update
BEFORE UPDATE ON factory_cell_effect_repair_issues BEGIN
  SELECT RAISE(ABORT, 'factory_cell_effect_repair_issues are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_cell_effect_repair_issues_no_delete
BEFORE DELETE ON factory_cell_effect_repair_issues BEGIN
  SELECT RAISE(ABORT, 'factory_cell_effect_repair_issues are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_cell_final_acceptances_no_update
BEFORE UPDATE ON factory_cell_final_acceptances BEGIN
  SELECT RAISE(ABORT, 'factory_cell_final_acceptances are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_cell_final_acceptances_no_delete
BEFORE DELETE ON factory_cell_final_acceptances BEGIN
  SELECT RAISE(ABORT, 'factory_cell_final_acceptances are immutable');
END;

-- ADR-053 Phase 2 — Durable transition obligations.
--
-- Every cross-aggregate transition (CandidateSetSealed -> RunGate,
-- GateAccepted -> RunEffects, EffectsSettled -> RecordFinalAcceptance, and
-- ProcessSettled -> RouteLifecycle)
-- is recorded as a durable obligation AT THE SAME TRANSACTION as its source
-- fact. The obligation has one owner capability, one monotonic fence, one
-- deterministic key (so the same source fact never creates two obligations),
-- and converges to exactly one completion receipt after crash / recovery.
--
-- This table is the SUBSTRATE; Phase 8 wires production handoffs onto it.
-- Phase 2 only creates the table, the repository and the fenced reconciler.
--
-- ADR-053 C7-01/C7-02 — storage split of the two concerns previously conflated
-- on a single fence column:
--   * fence               — CAUSAL SOURCE REVISION (provenance identifier of
--                           the source fact that caused the obligation). SET
--                           once at append; never overwritten by a lease.
--   * lease_fence         — MONOTONIC LEASE FENCE (ordering token carried by a
--                           lease). DISTINCT durable storage from the causal
--                           revision. NULL until the obligation is first leased;
--                           written only by the lease path and never allowed to
--                           decrease on overwrite (storage-level guarantee:
--                           lease_fence = MAX(COALESCE(lease_fence, 0), :new)).
--                           A stale lease holder thus cannot complete newer work.
--                           (Atomic allocation / callers can't choose a future
--                           fence is C7-03; this column only stores and reads
--                           monotonically.)
-- ADR-072: immutable final typed presentation, source fact for the pre-seal
-- close-presentation durable handoff.
CREATE TABLE IF NOT EXISTS factory_final_presentation_commitments (
  commitment_ref       TEXT PRIMARY KEY,
  workplace_ref        TEXT NOT NULL
                         REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  work_intent_id        INTEGER NOT NULL
                         REFERENCES factory_work_intents(id) ON DELETE RESTRICT,
  task_id               INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  execution_id          TEXT NOT NULL
                         REFERENCES worker_executions(execution_id) ON DELETE RESTRICT,
  role                  TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  product_schema        TEXT NOT NULL,
  product_ref           TEXT NOT NULL,
  product_digest        TEXT NOT NULL,
  contract_digest       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (execution_id),
  UNIQUE (workplace_ref, role, product_ref, product_digest)
);
CREATE INDEX IF NOT EXISTS idx_final_presentation_commitments_workplace
  ON factory_final_presentation_commitments(workplace_ref, role);
CREATE TRIGGER IF NOT EXISTS trg_final_presentation_commitments_no_update
BEFORE UPDATE ON factory_final_presentation_commitments BEGIN
  SELECT RAISE(ABORT, 'factory_final_presentation_commitments are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_final_presentation_commitments_no_delete
BEFORE DELETE ON factory_final_presentation_commitments BEGIN
  SELECT RAISE(ABORT, 'factory_final_presentation_commitments are immutable');
END;

CREATE TABLE IF NOT EXISTS factory_transition_obligations (
  obligation_key      TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL,
  source_ref          TEXT NOT NULL,
  source_digest       TEXT NOT NULL,
  subject_ref         TEXT NOT NULL,
  handoff_kind        TEXT NOT NULL,
  owner_capability    TEXT NOT NULL,
  fence               INTEGER NOT NULL,
  lease_fence         INTEGER,
  state               TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','in_progress','completed','failed')),
  attempt             INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  completion_receipt  TEXT,
  result_digest       TEXT,
  last_error          TEXT,
  -- B-004/O-D6 (CONVEYOR §15): per-obligation reason-identity valve state.
  -- last_reason_key is the TYPED reason identity of the last defer/fail
  -- (defer: the postcondition reason string; fail: the typed error CODE
  -- prefix before the colon). reason_repeat_count counts CONSECUTIVE
  -- repetitions of that key — a new key resets it to 1. Existing DBs get the
  -- columns via the PRAGMA-guarded ADD COLUMN in the owning ledger module.
  last_reason_key     TEXT,
  reason_repeat_count INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  UNIQUE (source_kind, source_ref, handoff_kind)
);
CREATE INDEX IF NOT EXISTS idx_transition_obligations_ready
  ON factory_transition_obligations (state, lease_expires_at);

CREATE TABLE IF NOT EXISTS factory_workshop_binding_receipts (
  receipt_ref        TEXT PRIMARY KEY,
  workshop_id       TEXT NOT NULL,
  epoch             TEXT NOT NULL,
  process_role      TEXT NOT NULL CHECK (
                      process_role IN ('orchestrator','worker-mcp','scripted-worker')
                    ),
  process_identity  TEXT NOT NULL,
  manifest_digest   TEXT NOT NULL,
  declared_snapshot TEXT NOT NULL,
  resolved_snapshot TEXT NOT NULL,
  binding_digest    TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(process_identity, process_role, manifest_digest)
);
CREATE INDEX IF NOT EXISTS idx_workshop_binding_receipts_role
  ON factory_workshop_binding_receipts(process_role, manifest_digest);
CREATE TRIGGER IF NOT EXISTS trg_workshop_binding_receipts_no_update
BEFORE UPDATE ON factory_workshop_binding_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_workshop_binding_receipts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_workshop_binding_receipts_no_delete
BEFORE DELETE ON factory_workshop_binding_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_workshop_binding_receipts are immutable');
END;

-- ADR-053 Phase 3 — immutable Workplace production material model.
--
-- factory_workplace_contributions: one execution's material delta (ordered
-- member operations). Append-only.
-- factory_workplace_production_revisions: sealed immutable material state of
-- a Workplace. Content-addressed revision_ref; partition-invariant
-- semantic_digest (same material through different execution partitions yields
-- the same semantic digest). Append-only.
CREATE TABLE IF NOT EXISTS factory_workplace_contributions (
  contribution_ref           TEXT PRIMARY KEY,
  workplace_ref              TEXT NOT NULL,
  contributor_execution_ref  TEXT NOT NULL,
  source_adapter             TEXT NOT NULL,
  operations                 TEXT NOT NULL,
  content_digest             TEXT NOT NULL,
  parent_contribution_ref    TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_workplace_contributions_workplace
  ON factory_workplace_contributions (workplace_ref, created_at);

CREATE TABLE IF NOT EXISTS factory_workplace_production_revisions (
  revision_ref               TEXT PRIMARY KEY,
  workplace_ref              TEXT NOT NULL,
  parent_revision_ref        TEXT,
  members                    TEXT NOT NULL,
  contributing_execution_refs TEXT NOT NULL,
  presenter_ref              TEXT NOT NULL,
  material_digest            TEXT NOT NULL,
  semantic_digest            TEXT NOT NULL,
  sealed_at                  TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_workplace_revisions_workplace
  ON factory_workplace_production_revisions (workplace_ref, sealed_at);
-- Within one Workplace, only the exact material digest (including validation
-- proof) may converge to one revision row. semantic_digest is a cross-run
-- comparison projection and is intentionally non-unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workplace_revisions_material
  ON factory_workplace_production_revisions (workplace_ref, material_digest);
DROP INDEX IF EXISTS idx_workplace_revisions_semantic;
CREATE INDEX IF NOT EXISTS idx_workplace_revisions_semantic
  ON factory_workplace_production_revisions (workplace_ref, semantic_digest);

CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_contributions_no_update
BEFORE UPDATE ON factory_workplace_contributions BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_contributions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_contributions_no_delete
BEFORE DELETE ON factory_workplace_contributions BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_contributions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_production_revisions_no_update
BEFORE UPDATE ON factory_workplace_production_revisions BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_production_revisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_workplace_production_revisions_no_delete
BEFORE DELETE ON factory_workplace_production_revisions BEGIN
  SELECT RAISE(ABORT, 'factory_workplace_production_revisions are immutable');
END;

-- CandidateSet — sealed immutable handoff to OTK (REG-12).
-- ADR-053 clean-break: production_revision_ref IS the material authority and
-- is REQUIRED. The seal key is (workplace_ref, production_revision_ref, role).
-- ADR-053 B-3: presenter_ref column DELETED. Execution provenance
-- lives on the immutable revision (presenterRef), NOT on the CandidateSet.
-- ADR-053 B-5: canonical product payloads are frozen before CandidateSet seal.
-- Post-seal consumers read this store instead of execution-scoped ingress rows.
CREATE TABLE IF NOT EXISTS factory_sealed_product_materials (
  schema_id        TEXT NOT NULL,
  content_digest   TEXT NOT NULL,
  payload_snapshot TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (schema_id, content_digest)
);
CREATE TABLE IF NOT EXISTS factory_sealed_product_aliases (
  product_ref      TEXT NOT NULL,
  schema_id        TEXT NOT NULL,
  content_digest   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_ref, schema_id, content_digest),
  FOREIGN KEY (schema_id, content_digest)
    REFERENCES factory_sealed_product_materials(schema_id, content_digest)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_sealed_product_alias_identity
  ON factory_sealed_product_aliases(product_ref, schema_id);
CREATE TRIGGER IF NOT EXISTS trg_factory_sealed_product_materials_no_update
BEFORE UPDATE ON factory_sealed_product_materials BEGIN
  SELECT RAISE(ABORT, 'factory_sealed_product_materials are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_sealed_product_materials_no_delete
BEFORE DELETE ON factory_sealed_product_materials BEGIN
  SELECT RAISE(ABORT, 'factory_sealed_product_materials are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_sealed_product_aliases_no_update
BEFORE UPDATE ON factory_sealed_product_aliases BEGIN
  SELECT RAISE(ABORT, 'factory_sealed_product_aliases are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_sealed_product_aliases_no_delete
BEFORE DELETE ON factory_sealed_product_aliases BEGIN
  SELECT RAISE(ABORT, 'factory_sealed_product_aliases are immutable');
END;

CREATE TABLE IF NOT EXISTS factory_candidate_sets (
  candidate_set_ref       TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  production_revision_ref TEXT NOT NULL,
  role                    TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  subject_candidate_set_ref TEXT,
  candidate_set_digest    TEXT NOT NULL,
  seal_receipt_ref        TEXT NOT NULL,
  sealed_at               TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  -- ADR-053 C2: uniqueness is role-specific (see partial unique indexes after
  -- the table). The old combined UNIQUE(workplace,revision,role) is removed
  -- because a reviewer's identity now includes its subject — two reviewer
  -- verdicts over different author subjects must coexist under the same
  -- (workplace, revision).
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref),
  -- ADR-053 B-1: a CandidateSet may never reference a revision that was not
  -- persisted. foreign_keys=ON is set globally in db.ts, so this is enforced.
  FOREIGN KEY (production_revision_ref) REFERENCES factory_workplace_production_revisions(revision_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_candidate_sets_workplace ON factory_candidate_sets(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_candidate_sets_subject ON factory_candidate_sets(subject_candidate_set_ref);
-- ADR-053 C2 — role-specific uniqueness. One author set per (workplace,
-- revision); one reviewer set per (workplace, revision, subject).
-- subject_candidate_set_ref is NOT NULL for reviewer (assertValidCandidateSet).
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_candidate_sets_author
  ON factory_candidate_sets(workplace_ref, production_revision_ref) WHERE role='author';
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_candidate_sets_reviewer
  ON factory_candidate_sets(workplace_ref, production_revision_ref, subject_candidate_set_ref) WHERE role='reviewer';

-- CandidateSet members (REG-12-AC-02/03). They present the complete product
-- material of the named WorkplaceProductionRevision. Origin is presentation
-- provenance only and never material authority.
CREATE TABLE IF NOT EXISTS factory_candidate_set_members (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_set_ref       TEXT NOT NULL,
  ordinal                 INTEGER NOT NULL,
  -- ProductRef triple.
  product_schema          TEXT NOT NULL,
  product_ref             TEXT NOT NULL,
  product_digest          TEXT NOT NULL,
  origin                  TEXT NOT NULL CHECK (origin IN ('produced','carried-forward')),
  -- REQUIRED non-null when origin=carried-forward; null when produced.
  source_candidate_set_ref TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (candidate_set_ref, ordinal),
  FOREIGN KEY (candidate_set_ref) REFERENCES factory_candidate_sets(candidate_set_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_candidate_members_set ON factory_candidate_set_members(candidate_set_ref);

-- ExecutionReservation — durable launch authority (REG-09).
-- Deterministic ref over (workplace_ref, role, workplace_revision); two
-- dispatchers racing produce one effective reservation (REG-09-AC-01).
CREATE TABLE IF NOT EXISTS factory_execution_reservations (
  reservation_ref         TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  expected_workplace_revision INTEGER NOT NULL,
  role                    TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  idempotency_key         TEXT NOT NULL,
  fence_token             TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','consumed','expired','cancelled')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_reservations_workplace ON factory_execution_reservations(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_reservations_state ON factory_execution_reservations(state);

-- GateRun — one authorized inspection of one CandidateSet (REG-15).
CREATE TABLE IF NOT EXISTS factory_gate_runs (
  gate_run_ref            TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  gate_phase              TEXT NOT NULL CHECK (gate_phase IN ('author','final')),
  subject_candidate_set_ref TEXT NOT NULL,
  -- JSON array of assessment CandidateSet refs (reviewer verdicts, when present).
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  check_plan_ref          TEXT NOT NULL,
  check_plan_digest       TEXT NOT NULL,
  expected_workplace_revision INTEGER NOT NULL,
  gate_lease_ref          TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'claimed'
                            CHECK (state IN ('claimed','checking','decided','terminal')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_gate_runs_workplace ON factory_gate_runs(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_gate_runs_subject ON factory_gate_runs(subject_candidate_set_ref);

-- Audit-only binding from a material GateRun to every presentation that drove
-- or replayed it. Presentation identity never enters Gate decision identity.
CREATE TABLE IF NOT EXISTS factory_gate_presentation_attempts (
  gate_run_ref            TEXT NOT NULL,
  presentation_ref        TEXT NOT NULL,
  replay_key              TEXT,
  replay_key_material     TEXT,
  replay_capsule_ref      TEXT,
  replay_capsule_payload_hash TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (gate_run_ref, presentation_ref),
  FOREIGN KEY (gate_run_ref) REFERENCES factory_gate_runs(gate_run_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_gate_presentations_ref
  ON factory_gate_presentation_attempts(presentation_ref);
CREATE TRIGGER IF NOT EXISTS trg_factory_gate_presentation_attempts_no_update
BEFORE UPDATE ON factory_gate_presentation_attempts BEGIN
  SELECT RAISE(ABORT, 'factory_gate_presentation_attempts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_gate_presentation_attempts_no_delete
BEFORE DELETE ON factory_gate_presentation_attempts BEGIN
  SELECT RAISE(ABORT, 'factory_gate_presentation_attempts are immutable');
END;

-- CheckReceipt — immutable evidence of one check run (REG-17).
-- BEFORE UPDATE/DELETE triggers make receipts append-only.
CREATE TABLE IF NOT EXISTS factory_check_receipts (
  check_receipt_ref       TEXT PRIMARY KEY,
  check_run_ref           TEXT NOT NULL,
  subject_candidate_set_ref TEXT NOT NULL,
  -- JSON array of assessment CandidateSet refs.
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  -- CheckRef triple.
  provider_id             TEXT NOT NULL,
  provider_version        TEXT NOT NULL,
  provider_digest         TEXT NOT NULL,
  environment_ref         TEXT,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN ('passed','failed','unknown','error')),
  -- JSON array of evidence refs.
  evidence_refs           TEXT NOT NULL DEFAULT '[]',
  receipt_digest          TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_factory_check_receipts_run ON factory_check_receipts(check_run_ref);
CREATE INDEX IF NOT EXISTS idx_factory_check_receipts_subject ON factory_check_receipts(subject_candidate_set_ref);

CREATE TRIGGER IF NOT EXISTS trg_factory_check_receipts_no_update
  BEFORE UPDATE ON factory_check_receipts
  BEGIN
    SELECT RAISE(ABORT, 'v4 check receipts are immutable (REG-17)');
  END;

CREATE TRIGGER IF NOT EXISTS trg_factory_check_receipts_no_delete
  BEFORE DELETE ON factory_check_receipts
  BEGIN
    SELECT RAISE(ABORT, 'v4 check receipts are immutable (REG-17)');
  END;

-- GateDecision — immutable domain decision (REG-18). The act of OTK.
-- BEFORE UPDATE/DELETE triggers make decisions append-only under the
-- universal GateDecision contract.
CREATE TABLE IF NOT EXISTS factory_gate_decisions (
  decision_key            TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  gate_ref                TEXT NOT NULL,
  gate_run_ref            TEXT NOT NULL,
  gate_phase              TEXT NOT NULL CHECK (gate_phase IN ('author','final')),
  transition_ref          TEXT NOT NULL,
  subject_candidate_set_ref TEXT NOT NULL,
  -- JSON array of assessment CandidateSet refs.
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  verdict                 TEXT NOT NULL
                            CHECK (verdict IN ('accepted','repair_required','human_required','failed')),
  repair_target_role      TEXT CHECK (repair_target_role IN ('author','reviewer') OR repair_target_role IS NULL),
  check_plan_ref          TEXT NOT NULL,
  check_plan_digest       TEXT NOT NULL,
  decision_policy_ref     TEXT NOT NULL,
  decision_policy_digest  TEXT NOT NULL,
  -- JSON array of exact CheckReceipt refs the policy reduced.
  check_receipt_refs      TEXT NOT NULL DEFAULT '[]',
  installation_digest     TEXT NOT NULL,
  -- JSON array of AcceptedOutputBinding (only non-empty on final-gate accepted).
  accepted_output_bindings TEXT NOT NULL DEFAULT '[]',
  recovery_issue_ref      TEXT,
  decision_digest         TEXT NOT NULL,
  decided_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_gate_decisions_digest
  ON factory_gate_decisions(decision_digest);

-- ADR-053 B-6 — explicit current GateDecision pointer for a Workplace.
-- Decisions remain immutable; this monotonic projection is updated in the
-- same transaction as recordDecision. Consumers resolve the current repair
-- authority by key, never by decided_at/rowid recency.
CREATE TABLE IF NOT EXISTS factory_workplace_gate_decision_heads (
  workplace_ref               TEXT PRIMARY KEY,
  decision_key                TEXT NOT NULL UNIQUE,
  expected_workplace_revision INTEGER NOT NULL CHECK (expected_workplace_revision >= 0),
  recorded_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  FOREIGN KEY (decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_factory_gate_decisions_workplace ON factory_gate_decisions(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_gate_decisions_subject ON factory_gate_decisions(subject_candidate_set_ref);
CREATE INDEX IF NOT EXISTS idx_factory_gate_decisions_verdict ON factory_gate_decisions(verdict);

CREATE TRIGGER IF NOT EXISTS trg_factory_gate_decisions_no_update
  BEFORE UPDATE ON factory_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'v4 gate decisions are immutable (REG-18)');
  END;

CREATE TRIGGER IF NOT EXISTS trg_factory_gate_decisions_no_delete
  BEFORE DELETE ON factory_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'v4 gate decisions are immutable (REG-18)');
  END;

-- FINDING-TRAJECTORY BUDGET (CONVEYOR §15 "budget must count spin, not work"):
-- the append-only finding-set chain of repair_required gate decisions. One row
-- per rejection, written in the SAME transaction as the GateDecision, holding
-- the comparable finding-set identity (digest / count / keys / fatal keys)
-- derived from the decision's check receipts via the ONE shared decoder
-- (decodeFindingsForDecision). The chain is scoped by (workplace, gate,
-- repair-target role) AND check_plan_digest: a plan change starts a fresh
-- chain (old findings are not comparable evidence under a new plan). The
-- executor's repair budget compares consecutive rows of one scope to waive
-- CONVERGING attempts (strict key-subset, fatal non-growing) from the
-- epoch budget. Append-only; replay is idempotent by the UNIQUE decision key.
CREATE TABLE IF NOT EXISTS factory_gate_finding_set_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workplace_ref           TEXT NOT NULL,
  gate_ref                TEXT NOT NULL,
  repair_target_role      TEXT NOT NULL CHECK (repair_target_role IN ('author','reviewer')),
  check_plan_digest       TEXT NOT NULL,
  gate_decision_key       TEXT NOT NULL UNIQUE,
  finding_set_digest      TEXT NOT NULL,
  finding_count           INTEGER NOT NULL CHECK (finding_count >= 0),
  fatal_finding_count     INTEGER NOT NULL CHECK (fatal_finding_count >= 0),
  -- JSON arrays of canonically ordered finding keys (and the fatal subset).
  finding_keys            TEXT NOT NULL,
  fatal_finding_keys      TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (gate_decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_gate_finding_set_chain_scope
  ON factory_gate_finding_set_chain(workplace_ref, repair_target_role, gate_ref, check_plan_digest, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_gate_finding_set_chain_no_update
  BEFORE UPDATE ON factory_gate_finding_set_chain
  BEGIN
    SELECT RAISE(ABORT, 'factory_gate_finding_set_chain is immutable (append-only)');
  END;

CREATE TRIGGER IF NOT EXISTS trg_gate_finding_set_chain_no_delete
  BEFORE DELETE ON factory_gate_finding_set_chain
  BEGIN
    SELECT RAISE(ABORT, 'factory_gate_finding_set_chain is immutable (append-only)');
  END;

-- ---------------------------------------------------------------------------
-- Factory checkpoints — immutable recovery metadata over an online SQLite
-- backup plus content-addressed external files. The filesystem manifest is
-- published last; these rows are the trusted local registry and audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS factory_database_identity (
  singleton_id         INTEGER PRIMARY KEY CHECK (singleton_id=1),
  namespace_id         TEXT NOT NULL UNIQUE,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A factory order is one intentional Factory Start. A Project may own MANY
-- historical orders (CONVEYOR v4.3 §7): Run A, Run B, Run C... each with its
-- own order_ref, lifecycle_run_id, workplaces and worker executions, while
-- retaining the same project_id/epic_id and the project's accumulated
-- certified ReplayCapsules. Resume continues one existing order/run; a new
-- Factory Start creates a new order for the same project.
--
-- Therefore project_id and epic_id are NOT globally unique: one project/epic
-- may participate in multiple sequential orders. lifecycle_run_id remains
-- UNIQUE because one order still owns at most one LifecycleRun.
-- source_digest is provenance ("these were the captured source bytes"), not
-- a lifetime identity — a later intentional start with the same source bytes
-- is legal and must create a new order. Start-command idempotency lives on
-- factory_launch_requests.idempotency_key, not on raw source bytes.
CREATE TABLE IF NOT EXISTS factory_orders (
  order_ref            TEXT PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  epic_id              INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
  lifecycle_run_id     INTEGER UNIQUE REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('idea_url','existing_project')),
  source_url           TEXT,
  source_final_url     TEXT,
  source_media_type    TEXT,
  source_digest        TEXT,
  source_body          BLOB,
  state                TEXT NOT NULL CHECK (
                         state IN ('provisioned','starting','running',
                                   'paused','completed','start_failed')
                       ),
  last_error           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Non-unique: source_digest is provenance, not a lifetime idempotency key.
-- Multiple intentional starts may share the same source bytes.
CREATE INDEX IF NOT EXISTS idx_factory_orders_source_digest
  ON factory_orders(source_digest) WHERE source_digest IS NOT NULL;

-- Append-only lifecycle lineage. factory_orders.lifecycle_run_id remains the
-- immutable root pointer; the active/completed leaf is projected from this
-- chain instead of rewriting the failed parent into a fictitious success.
CREATE TABLE IF NOT EXISTS factory_order_runs (
  order_ref            TEXT NOT NULL REFERENCES factory_orders(order_ref) ON DELETE RESTRICT,
  lifecycle_run_id     INTEGER NOT NULL UNIQUE REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  ordinal              INTEGER NOT NULL,
  parent_lifecycle_run_id INTEGER REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  kind                 TEXT NOT NULL CHECK (kind IN ('root','continuation')),
  continuation_ref     TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (order_ref, ordinal),
  UNIQUE (order_ref, parent_lifecycle_run_id),
  CHECK (
    (kind='root' AND ordinal=0 AND parent_lifecycle_run_id IS NULL AND continuation_ref IS NULL)
    OR
    (kind='continuation' AND ordinal>0 AND parent_lifecycle_run_id IS NOT NULL AND continuation_ref IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS factory_continuation_authorizations (
  authorization_ref    TEXT PRIMARY KEY,
  schema_id             TEXT NOT NULL,
  order_ref             TEXT NOT NULL REFERENCES factory_orders(order_ref) ON DELETE RESTRICT,
  parent_lifecycle_run_id INTEGER NOT NULL UNIQUE REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  child_lifecycle_run_id INTEGER UNIQUE REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  resume_stage_id       TEXT NOT NULL,
  expected_parent_version INTEGER NOT NULL,
  expected_parent_error TEXT NOT NULL,
  parent_definition_hash TEXT NOT NULL,
  parent_input_hash     TEXT NOT NULL,
  prefix_snapshot       TEXT NOT NULL,
  prefix_hash           TEXT NOT NULL,
  child_definition_snapshot TEXT NOT NULL,
  child_definition_hash TEXT NOT NULL,
  child_idempotency_key TEXT NOT NULL UNIQUE,
  external_baseline_snapshot TEXT NOT NULL,
  external_baseline_hash TEXT NOT NULL,
  actor_id              TEXT NOT NULL,
  reason                TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('authorized','consumed')),
  authorized_at         TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at           TEXT
);

CREATE TABLE IF NOT EXISTS factory_continuation_prefix_stages (
  authorization_ref    TEXT NOT NULL REFERENCES factory_continuation_authorizations(authorization_ref) ON DELETE RESTRICT,
  ordinal              INTEGER NOT NULL,
  stage_id             TEXT NOT NULL,
  stage_snapshot       TEXT NOT NULL,
  stage_snapshot_hash  TEXT NOT NULL,
  PRIMARY KEY (authorization_ref, ordinal),
  UNIQUE (authorization_ref, stage_id)
);

-- A prior cell can cross into a child run only through a new adoption
-- decision. Historical CandidateSets/GateDecisions remain evidence; they are
-- never copied or relabelled as child production.
CREATE TABLE IF NOT EXISTS factory_production_adoption_decisions (
  adoption_ref          TEXT PRIMARY KEY,
  continuation_ref      TEXT NOT NULL REFERENCES factory_continuation_authorizations(authorization_ref) ON DELETE RESTRICT,
  source_task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  source_workplace_ref  TEXT NOT NULL REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  source_process_run_id INTEGER NOT NULL,
  project_repository_id INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE RESTRICT,
  integration_branch    TEXT NOT NULL,
  source_commit         TEXT NOT NULL,
  source_tree           TEXT NOT NULL,
  integrated_commit     TEXT NOT NULL,
  integrated_tree       TEXT NOT NULL,
  author_candidate_set_ref TEXT NOT NULL REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  author_candidate_set_digest TEXT NOT NULL,
  reviewer_candidate_set_ref TEXT NOT NULL REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  reviewer_candidate_set_digest TEXT NOT NULL,
  final_gate_run_ref    TEXT NOT NULL REFERENCES factory_gate_runs(gate_run_ref) ON DELETE RESTRICT,
  final_decision_digest TEXT NOT NULL,
  covered_acceptance_criteria TEXT NOT NULL,
  evidence_snapshot     TEXT NOT NULL,
  evidence_digest       TEXT NOT NULL,
  adopted_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (continuation_ref, source_task_id)
);

-- An integrated Development candidate may cross a terminal boundary only as
-- an immutable verification subject.  This adoption conveys no verification
-- verdict and deliberately excludes historical verifier products/gates.
CREATE TABLE IF NOT EXISTS factory_development_verification_adoptions (
  adoption_ref             TEXT PRIMARY KEY,
  continuation_ref         TEXT NOT NULL UNIQUE REFERENCES factory_continuation_authorizations(authorization_ref) ON DELETE RESTRICT,
  source_lifecycle_run_id  INTEGER NOT NULL REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  source_stage_run_id      INTEGER NOT NULL REFERENCES factory_stage_runs(id) ON DELETE RESTRICT,
  source_process_run_id    INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
  task_graph_ref           TEXT NOT NULL,
  task_graph_hash          TEXT NOT NULL,
  implementation_workset_hash TEXT NOT NULL,
  integrated_candidate_ref TEXT NOT NULL,
  integrated_candidate_hash TEXT NOT NULL,
  repository_snapshot      TEXT NOT NULL,
  acceptance_snapshot      TEXT NOT NULL,
  verification_method_plan_hash TEXT NOT NULL,
  evidence_snapshot        TEXT NOT NULL,
  evidence_digest          TEXT NOT NULL,
  adopted_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_authorized_verification_observations (
  observation_ref       TEXT PRIMARY KEY,
  candidate_hash        TEXT NOT NULL,
  method_plan_hash      TEXT NOT NULL,
  criterion_code        TEXT NOT NULL,
  observer_id           TEXT NOT NULL,
  verdict               TEXT NOT NULL CHECK (verdict IN ('passed','failed','unknown')),
  evidence_snapshot     TEXT NOT NULL,
  evidence_digest       TEXT NOT NULL,
  observed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (candidate_hash,method_plan_hash,criterion_code,observer_id)
);

-- A terminal child may have completed an author production before a later
-- reviewer/transport failure.  Reusing those bytes in another append-only
-- continuation is never implicit replay: one immutable authorization pins the
-- exact source set, current contract identity, failure boundary and Git facts.
-- The target run still creates a NEW CandidateSet and runs its CURRENT gates.
CREATE TABLE IF NOT EXISTS factory_author_candidate_carry_forward_authorizations (
  authorization_ref       TEXT PRIMARY KEY,
  continuation_ref        TEXT NOT NULL UNIQUE REFERENCES factory_continuation_authorizations(authorization_ref) ON DELETE RESTRICT,
  source_lifecycle_run_id INTEGER NOT NULL REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  source_process_run_id   INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
  source_workplace_ref    TEXT NOT NULL REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  source_candidate_set_ref TEXT NOT NULL REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  source_candidate_set_digest TEXT NOT NULL,
  source_gate_decision_key TEXT NOT NULL REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT,
  source_gate_decision_digest TEXT NOT NULL,
  source_product_schema   TEXT NOT NULL,
  source_product_ref      TEXT NOT NULL,
  source_product_digest   TEXT NOT NULL,
  semantic_input_digest   TEXT NOT NULL,
  item_snapshot_hash      TEXT NOT NULL,
  project_repository_id  INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE RESTRICT,
  integration_branch     TEXT NOT NULL,
  base_commit             TEXT NOT NULL,
  source_commit           TEXT NOT NULL,
  source_tree             TEXT NOT NULL,
  eligible_failure_code  TEXT NOT NULL,
  evidence_snapshot      TEXT NOT NULL,
  evidence_digest        TEXT NOT NULL,
  authorized_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_author_candidate_carry_forward_consumptions (
  authorization_ref       TEXT PRIMARY KEY REFERENCES factory_author_candidate_carry_forward_authorizations(authorization_ref) ON DELETE RESTRICT,
  target_process_run_id   INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
  target_workplace_ref    TEXT NOT NULL UNIQUE REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT,
  target_candidate_set_ref TEXT NOT NULL UNIQUE REFERENCES factory_candidate_sets(candidate_set_ref) ON DELETE RESTRICT,
  presenter_ref           TEXT NOT NULL UNIQUE,
  consumed_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- X-6 (stage-11 preventive hunt): a sibling desk's successful integration can
-- legitimately advance the shared integration branch between an authorization
-- and its retry (the documented NORM for parallel desks). The base
-- authorization above is immutable and UNIQUE per continuation, so the
-- re-observed head is recorded as an append-only SUPERSEDING authorization
-- referencing its predecessor. Purely additive (CREATE TABLE IF NOT EXISTS
-- applies it to existing DBs on open; no column of any existing table
-- changes, therefore no SCHEMA_VERSION bump is required).
CREATE TABLE IF NOT EXISTS factory_author_candidate_carry_forward_reauthorizations (
  authorization_ref       TEXT PRIMARY KEY,
  continuation_ref        TEXT NOT NULL REFERENCES factory_continuation_authorizations(authorization_ref) ON DELETE RESTRICT,
  predecessor_authorization_ref TEXT NOT NULL,
  supersede_ordinal       INTEGER NOT NULL,
  source_lifecycle_run_id INTEGER NOT NULL REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  source_process_run_id   INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
  source_workplace_ref    TEXT NOT NULL,
  source_candidate_set_ref TEXT NOT NULL,
  source_candidate_set_digest TEXT NOT NULL,
  source_gate_decision_key TEXT NOT NULL,
  source_gate_decision_digest TEXT NOT NULL,
  source_product_schema   TEXT NOT NULL,
  source_product_ref      TEXT NOT NULL,
  source_product_digest   TEXT NOT NULL,
  semantic_input_digest   TEXT NOT NULL,
  item_snapshot_hash      TEXT NOT NULL,
  project_repository_id   INTEGER NOT NULL REFERENCES project_repositories(id) ON DELETE RESTRICT,
  integration_branch      TEXT NOT NULL,
  base_commit             TEXT NOT NULL,
  source_commit           TEXT NOT NULL,
  source_tree             TEXT NOT NULL,
  eligible_failure_code   TEXT NOT NULL,
  evidence_snapshot       TEXT NOT NULL,
  evidence_digest         TEXT NOT NULL,
  authorized_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (continuation_ref, supersede_ordinal)
);

CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_reauthorization_immutable_update
BEFORE UPDATE ON factory_author_candidate_carry_forward_reauthorizations BEGIN
  SELECT RAISE(ABORT, 'author carry-forward reauthorizations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_reauthorization_immutable_delete
BEFORE DELETE ON factory_author_candidate_carry_forward_reauthorizations BEGIN
  SELECT RAISE(ABORT, 'author carry-forward reauthorizations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_factory_order_runs_immutable_update
BEFORE UPDATE ON factory_order_runs BEGIN
  SELECT RAISE(ABORT, 'factory_order_runs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_order_runs_immutable_delete
BEFORE DELETE ON factory_order_runs BEGIN
  SELECT RAISE(ABORT, 'factory_order_runs are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_continuation_prefix_immutable_update
BEFORE UPDATE ON factory_continuation_prefix_stages BEGIN
  SELECT RAISE(ABORT, 'continuation prefix evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_continuation_prefix_immutable_delete
BEFORE DELETE ON factory_continuation_prefix_stages BEGIN
  SELECT RAISE(ABORT, 'continuation prefix evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_production_adoption_immutable_update
BEFORE UPDATE ON factory_production_adoption_decisions BEGIN
  SELECT RAISE(ABORT, 'production adoption decisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_production_adoption_immutable_delete
BEFORE DELETE ON factory_production_adoption_decisions BEGIN
  SELECT RAISE(ABORT, 'production adoption decisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_development_verification_adoption_immutable_update
BEFORE UPDATE ON factory_development_verification_adoptions BEGIN
  SELECT RAISE(ABORT, 'development verification adoptions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_development_verification_adoption_immutable_delete
BEFORE DELETE ON factory_development_verification_adoptions BEGIN
  SELECT RAISE(ABORT, 'development verification adoptions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_authorized_verification_observation_immutable_update
BEFORE UPDATE ON factory_authorized_verification_observations BEGIN
  SELECT RAISE(ABORT, 'authorized verification observations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_authorized_verification_observation_immutable_delete
BEFORE DELETE ON factory_authorized_verification_observations BEGIN
  SELECT RAISE(ABORT, 'authorized verification observations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_forward_immutable_update
BEFORE UPDATE ON factory_author_candidate_carry_forward_authorizations BEGIN
  SELECT RAISE(ABORT, 'author carry-forward authorizations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_forward_immutable_delete
BEFORE DELETE ON factory_author_candidate_carry_forward_authorizations BEGIN
  SELECT RAISE(ABORT, 'author carry-forward authorizations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_consumption_immutable_update
BEFORE UPDATE ON factory_author_candidate_carry_forward_consumptions BEGIN
  SELECT RAISE(ABORT, 'author carry-forward consumptions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_author_carry_consumption_immutable_delete
BEFORE DELETE ON factory_author_candidate_carry_forward_consumptions BEGIN
  SELECT RAISE(ABORT, 'author carry-forward consumptions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_continuation_authorization_no_delete
BEFORE DELETE ON factory_continuation_authorizations BEGIN
  SELECT RAISE(ABORT, 'continuation authorizations are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_continuation_authorization_guard_update
BEFORE UPDATE ON factory_continuation_authorizations
WHEN NOT (
  OLD.state='authorized' AND NEW.state='consumed'
  AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
  AND OLD.child_lifecycle_run_id IS NULL AND NEW.child_lifecycle_run_id IS NOT NULL
  AND OLD.authorization_ref=NEW.authorization_ref
  AND OLD.schema_id=NEW.schema_id
  AND OLD.order_ref=NEW.order_ref
  AND OLD.parent_lifecycle_run_id=NEW.parent_lifecycle_run_id
  AND OLD.resume_stage_id=NEW.resume_stage_id
  AND OLD.expected_parent_version=NEW.expected_parent_version
  AND OLD.expected_parent_error=NEW.expected_parent_error
  AND OLD.parent_definition_hash=NEW.parent_definition_hash
  AND OLD.parent_input_hash=NEW.parent_input_hash
  AND OLD.prefix_snapshot=NEW.prefix_snapshot
  AND OLD.prefix_hash=NEW.prefix_hash
  AND OLD.child_definition_snapshot=NEW.child_definition_snapshot
  AND OLD.child_definition_hash=NEW.child_definition_hash
  AND OLD.child_idempotency_key=NEW.child_idempotency_key
  AND OLD.external_baseline_snapshot=NEW.external_baseline_snapshot
  AND OLD.external_baseline_hash=NEW.external_baseline_hash
  AND OLD.actor_id=NEW.actor_id
  AND OLD.reason=NEW.reason
  AND OLD.authorized_at=NEW.authorized_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid continuation authorization mutation');
END;

CREATE TABLE IF NOT EXISTS factory_launch_requests (
  launch_ref           TEXT PRIMARY KEY,
  order_ref            TEXT NOT NULL REFERENCES factory_orders(order_ref) ON DELETE RESTRICT,
  mode                 TEXT NOT NULL CHECK (mode IN ('new','resume')),
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  epic_id              INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
  lifecycle_run_id     INTEGER REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  lifecycle_input_json TEXT,
  lifecycle_input_schema TEXT,
  initiated_by         TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  concurrency          INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 10),
  state                TEXT NOT NULL CHECK (state IN ('requested','claimed','running','paused','completed','failed')),
  claim_token          TEXT,
  claimed_at           TEXT,
  error                TEXT,
  -- Antifreeze layer C (schema v14): durable binding of the OS engine host to
  -- this launch. The spawner computes $SAGA_ENGINE_LOG before spawn and records
  -- it here together with the child pid, so the panel-side engine supervisor can
  -- watch the heartbeat/log markers for THIS launch without guessing paths or
  -- pids (the path previously existed only inside the child's environment).
  engine_log_path      TEXT,
  engine_pid           INTEGER,
  engine_spawned_at    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_one_pending_launch
  ON factory_launch_requests(order_ref) WHERE state='requested';
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_one_active_launch
  ON factory_launch_requests(order_ref)
  WHERE state IN ('requested','claimed','running');
-- Start-command idempotency (CONVEYOR v4.3 §3, PART 8): the SAME idempotency
-- key always identifies the SAME Start command, DURABLY — including after the
-- launch settles in a terminal-for-this-launch state (completed/failed/paused).
-- A retry with the same key resolves to the same FactoryOrder/launch; it never
-- creates a new one. A new intentional Start MUST use a different idempotency
-- key (source_digest on factory_orders is non-unique provenance, not a lifetime
-- identity). 'paused' is treated as terminal for THIS LaunchRequest: it sets
-- completed_at and frees the one-active-launch slot so a resume can create a
-- fresh launch under the same order. A later resume MUST use a NEW
-- idempotency key (the prior paused launch remains immutable evidence).
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_launch_idempotency
  ON factory_launch_requests(idempotency_key);

-- A LaunchRequest is the durable controller command; OS hosts are renewable,
-- epoch-fenced attempts to execute that command.  The current lease is a CAS
-- projection, while every acquired term remains immutable audit evidence.
CREATE TABLE IF NOT EXISTS factory_launch_controller_terms (
  term_ref             TEXT PRIMARY KEY,
  launch_ref           TEXT NOT NULL REFERENCES factory_launch_requests(launch_ref),
  epoch                INTEGER NOT NULL CHECK (epoch >= 1),
  predecessor_term_ref TEXT REFERENCES factory_launch_controller_terms(term_ref),
  holder_id            TEXT NOT NULL,
  machine_id           TEXT NOT NULL,
  process_id           INTEGER NOT NULL,
  token_digest         TEXT NOT NULL,
  takeover_reason      TEXT NOT NULL,
  acquired_at          TEXT NOT NULL,
  UNIQUE (launch_ref, epoch)
);
CREATE TRIGGER IF NOT EXISTS trg_factory_controller_term_no_update
  BEFORE UPDATE ON factory_launch_controller_terms
  BEGIN SELECT RAISE(ABORT, 'factory controller terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_factory_controller_term_no_delete
  BEFORE DELETE ON factory_launch_controller_terms
  BEGIN SELECT RAISE(ABORT, 'factory controller terms are immutable'); END;

CREATE TABLE IF NOT EXISTS factory_launch_controller_leases (
  launch_ref           TEXT PRIMARY KEY REFERENCES factory_launch_requests(launch_ref),
  current_term_ref     TEXT NOT NULL REFERENCES factory_launch_controller_terms(term_ref),
  epoch                INTEGER NOT NULL CHECK (epoch >= 1),
  token_digest         TEXT NOT NULL,
  heartbeat_at         TEXT NOT NULL,
  expires_at           TEXT NOT NULL
);

-- Antifreeze layer C (schema v14): panel-side engine-supervisor audit trail —
-- the receipt table for watchdog verdicts and treatments (by the
-- factory_worker_stops receipt idiom). Every freeze detection, guarded engine
-- brake, watchdog restart and budget exhaustion is one append-only row; the
-- backoff policy (restart cadence + budget) is derived from THIS table, so
-- the policy survives panel restarts.
CREATE TABLE IF NOT EXISTS factory_engine_watchdog_events (
  event_ref            TEXT PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  epic_id              INTEGER,
  launch_ref           TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'freeze_detected','engine_dead','brake_failed',
                         'restart_attempted','restart_succeeded','restart_failed',
                         'attempts_exhausted','sweep_killed_frozen','sweep_blocked_live')),
  reason               TEXT NOT NULL,
  engine_pid           INTEGER,
  heartbeat_age_ms     INTEGER,
  log_age_ms           INTEGER,
  detail               TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_factory_engine_watchdog_events_project
  ON factory_engine_watchdog_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_engine_watchdog_events_launch
  ON factory_engine_watchdog_events(launch_ref);

CREATE TABLE IF NOT EXISTS factory_checkpoints (
  checkpoint_ref       TEXT PRIMARY KEY,
  manifest_digest      TEXT NOT NULL UNIQUE,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  epic_id              INTEGER REFERENCES epics(id) ON DELETE RESTRICT,
  lifecycle_run_id     INTEGER,
  lifecycle_input_hash TEXT,
  parent_checkpoint_ref TEXT REFERENCES factory_checkpoints(checkpoint_ref),
  sequence_no          INTEGER NOT NULL,
  storage_root         TEXT NOT NULL,
  manifest_json        TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('complete','superseded')),
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, epic_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_factory_checkpoints_scope
  ON factory_checkpoints(project_id, epic_id, sequence_no DESC);

CREATE TABLE IF NOT EXISTS factory_adoptions (
  adoption_ref         TEXT PRIMARY KEY,
  checkpoint_ref       TEXT NOT NULL,
  manifest_digest      TEXT NOT NULL,
  target_project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_epic_id       INTEGER REFERENCES epics(id) ON DELETE RESTRICT,
  target_process_run_id INTEGER NOT NULL,
  target_node_id       TEXT NOT NULL,
  source_node_run_id   INTEGER NOT NULL,
  target_input_hash    TEXT NOT NULL,
  authority_kind       TEXT NOT NULL CHECK (authority_kind='checkpoint_import'),
  verification_profile TEXT NOT NULL DEFAULT 'full'
                         CHECK (verification_profile IN ('full','test_replay')),
  actor                TEXT NOT NULL,
  reason               TEXT NOT NULL,
  receipt_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (checkpoint_ref, target_process_run_id, target_node_id, source_node_run_id)
);

-- A directive is not a gate decision. It supplies one already-produced LM
-- result to the exact target node; the normal downstream verifier/gate still
-- owns acceptance. The executor marks it consumed only after completing the
-- durable NodeRun, so a crash before that point safely retries the directive.
CREATE TABLE IF NOT EXISTS factory_resume_directives (
  directive_ref        TEXT PRIMARY KEY,
  adoption_ref         TEXT NOT NULL REFERENCES factory_adoptions(adoption_ref) ON DELETE RESTRICT,
  process_run_id       INTEGER NOT NULL,
  node_id              TEXT NOT NULL,
  process_input_hash   TEXT NOT NULL,
  package_digest       TEXT,
  result_json          TEXT NOT NULL,
  result_digest        TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','consumed','cancelled')),
  consumed_node_run_id INTEGER,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_factory_resume_directives_ready
  ON factory_resume_directives(process_run_id, node_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_one_ready_directive
  ON factory_resume_directives(process_run_id, node_id) WHERE state='ready';

-- Present only in restored diagnostic clones. Production databases have no
-- row. Test-only replay is refused unless this marker exists.
CREATE TABLE IF NOT EXISTS factory_runtime_mode (
  singleton_id         INTEGER PRIMARY KEY CHECK (singleton_id=1),
  mode                 TEXT NOT NULL CHECK (mode='diagnostic_clone'),
  source_checkpoint_ref TEXT NOT NULL,
  source_manifest_digest TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_definition_compatibility_receipts (
  receipt_ref          TEXT PRIMARY KEY,
  lifecycle_run_id     INTEGER NOT NULL REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
  previous_definition_hash TEXT NOT NULL,
  candidate_definition_hash TEXT NOT NULL,
  current_stage_id     TEXT,
  classification       TEXT NOT NULL CHECK (classification IN ('exact','metadata_only','incompatible')),
  reason_json          TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_factory_adoptions_no_update
  BEFORE UPDATE ON factory_adoptions BEGIN
    SELECT RAISE(ABORT, 'factory adoptions are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_factory_adoptions_no_delete
  BEFORE DELETE ON factory_adoptions BEGIN
    SELECT RAISE(ABORT, 'factory adoptions are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_factory_compat_no_update
  BEFORE UPDATE ON factory_definition_compatibility_receipts BEGIN
    SELECT RAISE(ABORT, 'factory compatibility receipts are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_factory_compat_no_delete
  BEFORE DELETE ON factory_definition_compatibility_receipts BEGIN
    SELECT RAISE(ABORT, 'factory compatibility receipts are immutable');
  END;

-- Node submission validation receipts.
-- Persisted when a 'required' submission validator accepts a worker's
-- submission, in the same transaction as the task transition. Proves that
-- the validator ran and what exact artifact+trace set it examined.
--
-- T1.8: artifact_hashes + trace_digest capture the CONTENT at validation
-- time (not just IDs), so a post-hoc mutation is detectable by recomputing
-- the digest against current state. contract_ref records which contract
-- version the validator ran under (provenance for replay).
CREATE TABLE IF NOT EXISTS factory_submission_validation_receipts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  validator_id        TEXT NOT NULL,
  validator_version   TEXT NOT NULL,
  process_run_id      INTEGER NOT NULL,
  module_ref          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  execution_id        TEXT NOT NULL,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  input_snapshot_hash TEXT NOT NULL,
  artifact_ids        TEXT NOT NULL,
  trace_ids           TEXT NOT NULL,
  artifact_hashes     TEXT NOT NULL DEFAULT '{}',
  trace_digest        TEXT NOT NULL DEFAULT '',
  contract_ref        TEXT,
  validated_set_digest TEXT NOT NULL,
  validated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_task
  ON factory_submission_validation_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_run_node
  ON factory_submission_validation_receipts(process_run_id, node_id);
CREATE TRIGGER IF NOT EXISTS trg_factory_submission_validation_receipts_no_update
BEFORE UPDATE ON factory_submission_validation_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_submission_validation_receipts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_factory_submission_validation_receipts_no_delete
BEFORE DELETE ON factory_submission_validation_receipts BEGIN
  SELECT RAISE(ABORT, 'factory_submission_validation_receipts are immutable');
END;

-- Durable preflight rejections. Unlike terminal command_receipts, these are
-- append-only observations: the same execution may repair the artifact and
-- call worker_done again. The observed-set digest prevents an exact replay
-- from duplicating a row while changed bytes create a new rejection snapshot.
CREATE TABLE IF NOT EXISTS factory_submission_validation_rejections (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rejection_ref         TEXT NOT NULL UNIQUE,
  rejection_digest      TEXT NOT NULL,
  validator_id          TEXT NOT NULL,
  validator_version     TEXT NOT NULL,
  process_run_id        INTEGER NOT NULL,
  module_ref            TEXT NOT NULL,
  node_id               TEXT NOT NULL,
  execution_id          TEXT NOT NULL,
  task_id               INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workplace_ref         TEXT,
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('managed_execution','admin')),
  rejection_code        TEXT NOT NULL,
  gaps_json             TEXT NOT NULL,
  details_json          TEXT NOT NULL DEFAULT '{}',
  contract_ref          TEXT,
  input_snapshot_hash   TEXT NOT NULL,
  observed_artifacts    TEXT NOT NULL,
  observed_set_digest   TEXT NOT NULL,
  feedback_json         TEXT NOT NULL,
  rejected_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (execution_id, rejection_digest)
);
CREATE INDEX IF NOT EXISTS idx_submission_rejections_task
  ON factory_submission_validation_rejections(task_id, id);
CREATE INDEX IF NOT EXISTS idx_submission_rejections_execution
  ON factory_submission_validation_rejections(execution_id, id);
CREATE TRIGGER IF NOT EXISTS trg_submission_rejections_no_update
  BEFORE UPDATE ON factory_submission_validation_rejections
  BEGIN
    SELECT RAISE(ABORT, 'submission validation rejections are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_submission_rejections_no_delete
  BEFORE DELETE ON factory_submission_validation_rejections
  BEGIN
    SELECT RAISE(ABORT, 'submission validation rejections are immutable');
  END;

-- Explicit, audited bypass of an exhausted Production Cell attempt budget.
-- Authorization and consumption are separate immutable facts so one operator
-- directive can produce at most one additional execution opportunity.
CREATE TABLE IF NOT EXISTS factory_operator_recovery_authorizations (
  authorization_ref      TEXT PRIMARY KEY,
  lifecycle_run_id       INTEGER NOT NULL,
  stage_run_id           INTEGER NOT NULL,
  process_run_id         INTEGER NOT NULL,
  workplace_ref          TEXT NOT NULL,
  expected_revision      INTEGER NOT NULL,
  task_id                INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repair_role            TEXT NOT NULL CHECK (repair_role IN ('author','reviewer')),
  rejection_ref          TEXT NOT NULL REFERENCES factory_submission_validation_rejections(rejection_ref),
  rejection_digest       TEXT NOT NULL,
  actor_id                TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  authorized_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS factory_operator_recovery_consumptions (
  authorization_ref      TEXT PRIMARY KEY
                           REFERENCES factory_operator_recovery_authorizations(authorization_ref),
  resulting_revision     INTEGER NOT NULL,
  consumed_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS trg_operator_recovery_auth_no_update
  BEFORE UPDATE ON factory_operator_recovery_authorizations
  BEGIN SELECT RAISE(ABORT, 'operator recovery authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_operator_recovery_auth_no_delete
  BEFORE DELETE ON factory_operator_recovery_authorizations
  BEGIN SELECT RAISE(ABORT, 'operator recovery authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_operator_recovery_consumption_no_update
  BEFORE UPDATE ON factory_operator_recovery_consumptions
  BEGIN SELECT RAISE(ABORT, 'operator recovery consumptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_operator_recovery_consumption_no_delete
  BEFORE DELETE ON factory_operator_recovery_consumptions
  BEGIN SELECT RAISE(ABORT, 'operator recovery consumptions are immutable'); END;

-- Worker-loss resume: the operator answer to a repair-budget pause caused by
-- supervised worker process loss (host restart, orchestrator kill). Unlike
-- the submission-preflight class, no semantic rejection exists to key on —
-- the authorization binds the LOST execution identity instead.
CREATE TABLE IF NOT EXISTS factory_worker_loss_resume_authorizations (
  authorization_ref       TEXT PRIMARY KEY,
  lifecycle_run_id        INTEGER NOT NULL,
  stage_run_id            INTEGER NOT NULL,
  process_run_id          INTEGER NOT NULL,
  workplace_ref           TEXT NOT NULL,
  expected_revision       INTEGER NOT NULL,
  task_id                 INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repair_role             TEXT NOT NULL CHECK (repair_role IN ('author','reviewer')),
  lost_execution_ref      TEXT NOT NULL,
  observed_candidate_sets INTEGER NOT NULL DEFAULT 0,
  observed_gate_decisions INTEGER NOT NULL DEFAULT 0,
  actor_id                TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  authorized_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS factory_worker_loss_resume_consumptions (
  authorization_ref       TEXT PRIMARY KEY
                            REFERENCES factory_worker_loss_resume_authorizations(authorization_ref),
  resulting_revision      INTEGER NOT NULL,
  consumed_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS trg_worker_loss_resume_auth_no_update
  BEFORE UPDATE ON factory_worker_loss_resume_authorizations
  BEGIN SELECT RAISE(ABORT, 'worker loss resume authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_worker_loss_resume_auth_no_delete
  BEFORE DELETE ON factory_worker_loss_resume_authorizations
  BEGIN SELECT RAISE(ABORT, 'worker loss resume authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_worker_loss_resume_consumption_no_update
  BEFORE UPDATE ON factory_worker_loss_resume_consumptions
  BEGIN SELECT RAISE(ABORT, 'worker loss resume consumptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_worker_loss_resume_consumption_no_delete
  BEFORE DELETE ON factory_worker_loss_resume_consumptions
  BEGIN SELECT RAISE(ABORT, 'worker loss resume consumptions are immutable'); END;

-- A crashed/stopped runtime host may leave its launch row active after the
-- worker watchman has already proved the exact child process dead and released
-- its card. Closing that controller fence is a separate, immutable operator
-- observation; it never rewrites the WorkerExecution or Workplace evidence.
CREATE TABLE IF NOT EXISTS factory_orphaned_launch_recovery_receipts (
  recovery_ref           TEXT PRIMARY KEY,
  launch_ref             TEXT NOT NULL UNIQUE
                           REFERENCES factory_launch_requests(launch_ref),
  lifecycle_run_id       INTEGER NOT NULL,
  process_run_id         INTEGER NOT NULL,
  workplace_ref          TEXT NOT NULL,
  workplace_revision     INTEGER NOT NULL,
  task_id                 INTEGER NOT NULL REFERENCES tasks(id),
  execution_id            TEXT NOT NULL REFERENCES worker_executions(execution_id),
  observed_execution_state TEXT NOT NULL CHECK (observed_execution_state='lost'),
  actor_id                TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  recovered_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS trg_orphaned_launch_recovery_no_update
  BEFORE UPDATE ON factory_orphaned_launch_recovery_receipts
  BEGIN SELECT RAISE(ABORT, 'orphaned launch recovery receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_orphaned_launch_recovery_no_delete
  BEFORE DELETE ON factory_orphaned_launch_recovery_receipts
  BEGIN SELECT RAISE(ABORT, 'orphaned launch recovery receipts are immutable'); END;

-- Controller-bootstrap recovery for a pre-spawn Factory provisioning failure
-- whose implementation has since been superseded by an explicit policy.
-- The failed WorkerExecution remains terminal evidence; this receipt only
-- authorizes one fresh Workplace attempt through the normal reducer.
CREATE TABLE IF NOT EXISTS factory_automatic_spawn_recovery_receipts (
  recovery_ref            TEXT PRIMARY KEY,
  execution_id            TEXT NOT NULL UNIQUE REFERENCES worker_executions(execution_id),
  lifecycle_run_id        INTEGER NOT NULL,
  process_run_id          INTEGER NOT NULL,
  workplace_ref           TEXT NOT NULL,
  expected_revision       INTEGER NOT NULL,
  resulting_revision      INTEGER NOT NULL,
  task_id                 INTEGER NOT NULL REFERENCES tasks(id),
  failure_code            TEXT NOT NULL,
  failure_digest          TEXT NOT NULL,
  recovery_policy_ref     TEXT NOT NULL,
  recovery_policy_digest  TEXT NOT NULL,
  recovered_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS trg_automatic_spawn_recovery_no_update
  BEFORE UPDATE ON factory_automatic_spawn_recovery_receipts
  BEGIN SELECT RAISE(ABORT, 'automatic spawn recovery receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_automatic_spawn_recovery_no_delete
  BEFORE DELETE ON factory_automatic_spawn_recovery_receipts
  BEGIN SELECT RAISE(ABORT, 'automatic spawn recovery receipts are immutable'); END;

-- Explicit recovery for an infrastructure-only GateRun failure after the
-- CandidateSet was sealed. The failed GateRun remains immutable evidence; the
-- authorization pins the replacement CheckPlan that may inspect the same set.
CREATE TABLE IF NOT EXISTS factory_failed_gate_recovery_authorizations (
  authorization_ref        TEXT PRIMARY KEY,
  lifecycle_run_id         INTEGER NOT NULL,
  stage_run_id             INTEGER NOT NULL,
  process_run_id           INTEGER NOT NULL,
  failed_node_run_id       INTEGER NOT NULL,
  workplace_ref            TEXT NOT NULL,
  expected_workplace_revision INTEGER NOT NULL,
  task_id                  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  candidate_set_ref        TEXT NOT NULL,
  candidate_set_digest     TEXT NOT NULL,
  abandoned_gate_run_ref   TEXT NOT NULL,
  abandoned_check_plan_ref TEXT NOT NULL,
  abandoned_check_plan_digest TEXT NOT NULL,
  replacement_check_plan_ref TEXT NOT NULL,
  replacement_check_plan_digest TEXT NOT NULL,
  replacement_check_plan_snapshot TEXT NOT NULL,
  failure_code             TEXT NOT NULL,
  actor_id                 TEXT NOT NULL,
  reason                   TEXT NOT NULL,
  authorized_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS factory_failed_gate_recovery_consumptions (
  authorization_ref        TEXT PRIMARY KEY
                             REFERENCES factory_failed_gate_recovery_authorizations(authorization_ref),
  resulting_lifecycle_version INTEGER NOT NULL,
  consumed_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS trg_failed_gate_recovery_auth_no_update
  BEFORE UPDATE ON factory_failed_gate_recovery_authorizations
  BEGIN SELECT RAISE(ABORT, 'failed gate recovery authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_failed_gate_recovery_auth_no_delete
  BEFORE DELETE ON factory_failed_gate_recovery_authorizations
  BEGIN SELECT RAISE(ABORT, 'failed gate recovery authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_failed_gate_recovery_consumption_no_update
  BEFORE UPDATE ON factory_failed_gate_recovery_consumptions
  BEGIN SELECT RAISE(ABORT, 'failed gate recovery consumptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_failed_gate_recovery_consumption_no_delete
  BEFORE DELETE ON factory_failed_gate_recovery_consumptions
  BEGIN SELECT RAISE(ABORT, 'failed gate recovery consumptions are immutable'); END;
`;

// ----------------------------------------------------------------------------
// Runtime validation schemas (Zod).
//
// SRS-004 §2b.1 — ArtifactTypeSchema is the canonical, machine-checked list of
// artifact `type` literals. It MUST stay in lock-step with:
//   - the `ArtifactType` union in src/types.ts
//   - the `type ... CHECK (type IN (...))` clause in SCHEMA_SQL above
// Extension point (SRS §2b.1): to add a new artifact type, append the literal
// in ALL THREE places (this z.enum, the TS union, and the SQL CHECK).
// Additive only — never rename/remove existing literals (SRS §5 compatibility).
// ----------------------------------------------------------------------------
import { z } from 'zod';

export const ArtifactTypeSchema = z.enum([
  'PRD', 'SRS', 'UC', 'AC', 'FR', 'NFR', 'decision',
  'theme',   // NEW — top-level business board
  'brief',   // NEW — discovery-phase output
  'RULE',    // NEW — business rule / policy artifact
  'OQ',      // NEW — open question / unresolved issue
  'hypothesis',      // NEW — product discovery hypothesis (BR→HYP→metric)
  'business_metric', // NEW — metric definition referenced by a hypothesis
  'SPEC',    // NEW — technical specification / design contract referenced by FRs
]);
