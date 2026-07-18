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

-- Executable state machine for one REQ/product episode. Kept separate from
-- epics.status so legacy boards retain their coarse lifecycle unchanged.
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
                    CHECK (status IN ('todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked')),
  priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  assigned_to     TEXT,
  -- Fencing token for managed CLI executions. NULL means legacy/manual claim.
  -- Every worker-side mutation of a managed task must present this exact id.
  current_execution_id TEXT,
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
                    CHECK (execution_mode IN ('git_change','tracker_only','read_only_evidence','interactive')),
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
  metadata        TEXT NOT NULL DEFAULT '{}'
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

