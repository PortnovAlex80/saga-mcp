import { createHash } from 'node:crypto';

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
  -- Fencing token for managed CLI executions. NULL means legacy/manual claim.
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
  -- policy_minimum). The legacy priority column is kept as the declared risk
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
                     CHECK (stuck_state IN ('active','suspected_stuck','cancel_requested'))
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
                         CHECK (engine_state IN ('running','stopped','unknown')),
  engine_pid           INTEGER,
  concurrency          INTEGER,
  started_at           TEXT,
  stopped_at           TEXT,
  concurrency_changed_at TEXT,
  model_provider       TEXT,
  model_name           TEXT,
  model_effort         TEXT,
  model_concurrency_limit INTEGER,
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
-- Purely ADDITIVE (CREATE TABLE IF NOT EXISTS). The legacy tasks/worker_executions
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
                        CHECK (loop_state IN ('idle','queued','leased','running','verifying','repair_wait','paused','terminal')),
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

-- CandidateSet — sealed immutable handoff to OTK (REG-12).
-- Seal key (workplace_ref, producer_execution_ref, role) is UNIQUE: a replay
-- of the same execution's completion returns the same row (REG-12-AC-01); a
-- different payload under the same key is rejected by the repository.
CREATE TABLE IF NOT EXISTS factory_candidate_sets (
  candidate_set_ref       TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  producer_execution_ref  TEXT NOT NULL,
  role                    TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  -- REQUIRED non-null when role=reviewer; enforced by the domain validator
  -- (assertValidCandidateSet) and by the repository write path.
  subject_candidate_set_ref TEXT,
  candidate_set_digest    TEXT NOT NULL,
  seal_receipt_ref        TEXT NOT NULL,
  sealed_at               TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref, producer_execution_ref, role),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);

CREATE INDEX IF NOT EXISTS idx_factory_candidate_sets_workplace ON factory_candidate_sets(workplace_ref);
CREATE INDEX IF NOT EXISTS idx_factory_candidate_sets_subject ON factory_candidate_sets(subject_candidate_set_ref);

-- CandidateSet members (REG-12-AC-02/03). Each member is either produced by
-- the active execution or explicitly carried-forward from a named prior set.
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

-- CheckReceipt — immutable evidence of one check run (REG-17).
-- BEFORE UPDATE/DELETE triggers make receipts append-only (same pattern as
-- factory_exact_candidate_acceptance_decisions).
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
-- BEFORE UPDATE/DELETE triggers make decisions append-only, mirroring the
-- existing factory_exact_candidate_acceptance_decisions (which step 3.A.3
-- generalizes into this universal contract).
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

-- One durable factory order is the public identity behind a project.  A
-- caller never supplies epic/run/input coordinates: the start gateway resolves
-- them from this record.  Source bytes are frozen before provisioning so a
-- retry cannot observe a different "idea on a napkin".
CREATE TABLE IF NOT EXISTS factory_orders (
  order_ref            TEXT PRIMARY KEY,
  project_id           INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  epic_id              INTEGER NOT NULL UNIQUE REFERENCES epics(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_orders_source_digest
  ON factory_orders(source_digest) WHERE source_digest IS NOT NULL;

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
  state                TEXT NOT NULL CHECK (state IN ('requested','claimed','running','completed','failed')),
  claim_token          TEXT,
  claimed_at           TEXT,
  error                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_one_pending_launch
  ON factory_launch_requests(order_ref) WHERE state='requested';
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_one_active_launch
  ON factory_launch_requests(order_ref)
  WHERE state IN ('requested','claimed','running');

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
  validated_set_digest TEXT NOT NULL,
  validated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_task
  ON factory_submission_validation_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_submission_receipts_run_node
  ON factory_submission_validation_receipts(process_run_id, node_id);
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

/**
 * Additive migration: add the `storage_kind` column to a pre-existing
 * `artifacts` table that was created before the column existed.
 *
 * Fresh databases get the column from `SCHEMA_SQL`'s CREATE TABLE. Existing
 * databases created before this migration land here with no `storage_kind`
 * column; this function adds it with the safe default `'file_backed'` (every
 * legacy artifact is file-backed — the synthetic brief case is repaired
 * separately by the provisioning layer and the checkpoint migration).
 *
 * SQLite ALTER TABLE ADD COLUMN supports a CHECK constraint, but the
 * expression must not reference other columns. NOT NULL requires a DEFAULT,
 * which we provide ('file_backed'). Idempotent via a PRAGMA table_info probe.
 */
export function ensureArtifactStorageKindColumn(db: {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): Array<{ name: string }> };
}): void {
  const columns = db.prepare('PRAGMA table_info(artifacts)').all();
  if (columns.some((c) => c.name === 'storage_kind')) return;
  db.exec(
    `ALTER TABLE artifacts ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'file_backed'
       CHECK (storage_kind IN ('file_backed','db_native','external_ref'))`,
  );
}

/**
 * One-shot repair: migrate synthetic auto-provisioned brief artifacts to
 * `storage_kind='db_native'` with their canonical content stamped into
 * `metadata.content`.
 *
 * Pre-storage_kind databases (and databases where the brief was created by
 * the pre-db_native provisioning code) hold the synthetic brief as a
 * `file_backed` row with `path='docs/discovery/brief-auto-provisioned.md'`
 * and an empty `metadata='{}'`. The brief has NO physical file — it was a
 * pure DB row whose `content_hash` was computed from a canonical JSON payload
 * that was never persisted. Checkpoint capture cannot verify such a row.
 *
 * This migration reconstructs the payload from the authoritative discovery
 * records (`factory_proposals`), recomputes the SHA-256, and — only if the
 * recomputed hash matches the stored `content_hash` — promotes the row to
 * `db_native` with the canonical content persisted in `metadata.content`.
 *
 * If the hash does NOT match (payload reconstruction failed or the brief was
 * authored by a recipe the migration does not know), the row is left as
 * `file_backed` — checkpoint capture will then fail loudly on that artifact
 * rather than silently masking an integrity gap. The migration never guesses.
 *
 * Idempotent: rows already at `db_native` are skipped.
 */
export function migrateSyntheticBriefsToDbNative(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
}): { inspected: number; migrated: number; skipped: number } {
  // Guard: the migration reads factory_proposals, which is a module-owned
  // table created lazily by the discovery module's schema ensure. On a fresh
  // DB (or one where discovery has not run yet) the table or its
  // payload_snapshot column may not exist yet. Skip the migration entirely
  // in that case — there are no synthetic briefs to repair on a fresh DB, and
  // on an existing DB the table will exist once discovery has produced a
  // proposal. Re-running getDb later (e.g. after factory start) will find the
  // table and perform the migration then.
  const proposalTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='factory_proposals'",
  ).get();
  if (!proposalTable) return { inspected: 0, migrated: 0, skipped: 0 };
  const proposalCols = db.prepare('PRAGMA table_info(factory_proposals)').all() as Array<{ name: string }>;
  if (!proposalCols.some((c) => c.name === 'payload')) {
    return { inspected: 0, migrated: 0, skipped: 0 };
  }

  // SHA-256 over canonical JSON. Uses the crypto module directly to keep
  // schema.ts dependency-free (the shared helper would create a cycle).
  const sha256Hex = (value: unknown): string => {
    const canonical = JSON.stringify(sortKeys(value));
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  };
  // Recursive key-sorting so the digest is byte-stable regardless of key order.
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {});
    }
    return value;
  };

  // Find synthetic briefs still marked file_backed with the auto-provisioned
  // path and empty metadata (the shape emitted by pre-db_native provisioning).
  const synthetic = db.prepare(
    `SELECT id, epic_id, content_hash FROM artifacts
      WHERE type='brief' AND storage_kind='file_backed'
        AND path='docs/discovery/brief-auto-provisioned.md'
        AND (metadata IS NULL OR metadata='{}')`,
  ).all() as Array<{ id: number; epic_id: number; content_hash: string | null }>;

  let migrated = 0;
  let skipped = 0;
  for (const row of synthetic) {
    if (!row.content_hash) { skipped += 1; continue; }
    // The synthetic brief was created by the discovery resolver, which calls
    // ensureDiscoveryBrief with proposalPayload that may be null (the call
    // site at discovery-installation.ts passes null when it cannot read the
    // proposal payload). The formalization fallback uses a different recipe
    // (with process_run_id). We try BOTH recipes against the stored hash;
    // whichever matches is the canonical content we persist. If neither
    // matches, the row is left file_backed (checkpoint fails loudly).
    const candidates: Array<Record<string, unknown>> = [
      // Recipe A: discovery resolver with null proposalPayload (the common
      // case — the call site passes null).
      {
        schema: 'factory.discovery-brief.v1',
        epic_id: row.epic_id,
        problem_statement: null,
        candidate_scope: null,
        recommended_outcome: null,
        note: 'Auto-provisioned by discovery proposal resolver',
      },
    ];
    // Recipe B: discovery resolver with real proposal payload (if available).
    const proposal = db.prepare(
      `SELECT p.payload FROM factory_proposals p
        JOIN factory_work_intents wi ON wi.id = p.intent_id
        WHERE wi.epic_id=? AND p.status='submitted'
        ORDER BY p.id DESC LIMIT 1`,
    ).get(row.epic_id) as { payload: string } | undefined;
    if (proposal) {
      try {
        const parsed = JSON.parse(proposal.payload) as Record<string, unknown>;
        candidates.push({
          schema: 'factory.discovery-brief.v1',
          epic_id: row.epic_id,
          problem_statement: parsed.problem_statement ?? null,
          candidate_scope: parsed.candidate_scope ?? null,
          recommended_outcome: parsed.recommended_outcome ?? null,
          note: 'Auto-provisioned by discovery proposal resolver',
        });
      } catch { /* payload unreadable — skip recipe B */ }
    }
    // Recipe C: formalization fallback (uses process_run_id, no proposal).
    const formalizationRun = db.prepare(
      'SELECT id FROM factory_process_runs WHERE project_id=(SELECT project_id FROM epics WHERE id=?) ORDER BY id DESC LIMIT 1',
    ).get(row.epic_id) as { id: number } | undefined;
    if (formalizationRun) {
      candidates.push({
        schema: 'factory.discovery-brief.v1',
        epic_id: row.epic_id,
        process_run_id: formalizationRun.id,
        note: 'Auto-provisioned by formalization resolver',
      });
    }
    let payload: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      if (sha256Hex(candidate) === row.content_hash) {
        payload = candidate;
        break;
      }
    }
    if (!payload) {
      // No recipe matched — the stored content_hash was computed from a shape
      // this migration cannot reconstruct. Leave file_backed; checkpoint will
      // fail loudly rather than mask the gap.
      skipped += 1;
      continue;
    }
    const metadata = JSON.stringify({
      storage_kind: 'db_native',
      content_schema: 'factory.discovery-brief.v1',
      content: payload,
    });
    const info = db.prepare(
      `UPDATE artifacts SET storage_kind='db_native', metadata=?, updated_at=datetime('now')
        WHERE id=? AND storage_kind='file_backed'`,
    ).run(metadata, row.id);
    if (info.changes === 1) migrated += 1; else skipped += 1;
  }
  return { inspected: synthetic.length, migrated, skipped };
}

