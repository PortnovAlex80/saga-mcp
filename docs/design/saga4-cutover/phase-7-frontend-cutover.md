# Phase 7 — Frontend Cutover: Make tracker-view a Pure Projection of the Lifecycle Runtime

**Branch:** `saga4`
**Scope:** READ-ONLY investigation output. This document is the only artifact. No source modified.
**Goal:** Make the tracker-view frontend a pure projection of the new Lifecycle Orchestrator runtime. The Start/Play button must launch **only** the Lifecycle Orchestrator (ProcessRun/StageRun/NodeRun). All legacy engine status, episode-transition, and `episode_workflows`-mutating endpoints must be removed from the HTTP surface.

---

## 0. Executive Summary & Critical Findings

The frontend is a single Node `http` server in `tracker-view/tracker-view.mjs` (~325 KB, ~5800 lines) that serves HTML pages plus a set of JSON endpoints. The HTTP routing is a flat `if/else` chain in `createServer` (`tracker-view.mjs:5554-5738`). Two coexisting pipeline systems are already wired today:

- **LEGACY pipeline** — `GET /api/episode/pipeline` reads `episode_workflows.stage` + `activity_log` (`tracker-view.mjs:4453-4525`). The frontend `refreshPipeline()` (`tracker-view.mjs:1168`) polls it.
- **LIFECYCLE pipeline** — `GET /api/lifecycle/pipeline` reads `LifecycleRun`/`StageRun`/`Transition` via `buildPipelineView` (`lifecycle-pipeline/pipeline-api.mjs`, `src/process-modules/application/lifecycle-pipeline-query.ts`). The frontend `mount.js` (`lifecycle-pipeline/public/mount.js`) is the **single poller** and yields the container to the legacy poller only when `source:'legacy'` is returned.

The lifecycle projection is already built and is the authoritative bar. The cutover's job is to **(a)** remove the legacy fallback and its endpoints, **(b)** repoint the Start/Play button from the legacy `orchestrate-cli.js` pump to the Lifecycle Orchestrator, and **(c)** preserve the shared worker/model/concurrency infra.

### FINDING 1 — The Start/Play button launches the LEGACY engine today
- The Play (▶) toggle (`tracker-view.mjs:1448-1503`) calls `POST /api/engine/start`.
- `handleEngineStart` (`tracker-view.mjs:5051`) → `sagaApplication.startEngine(...)`.
- `createSagaApplication.startEngine` (`src/application/saga-application.ts:138`) → `dependencies.engineAdministration.start(command)`.
- The composition root wires `engineAdministration = new LegacyEngineAdministration(...)` by default (`src/app/composition-root.ts:26,119-123,170-176`).
- `LegacyEngineAdministration.start` (`src/infrastructure/engine/legacy-engine-administration.ts:58-118`) spawns `node orchestrate-cli.js <projectId> <epicId> --concurrency=N` with `SAGA_ORCHESTRATION_MODE` env, then persists `$.engine_running / engine_pid / engine_concurrency` into `episode_workflows.metadata`.

So Start/Play = legacy pump today. The cutover must repoint `handleEngineStart` to a lifecycle-run start (`process_run_start` / `ProductLifecycleRuntime`) and delete the `LegacyEngineAdministration` spawn path. (Note: Phase 3 §7 keeps `LegacyEngineAdministration` as generic process-control infra only because the lifecycle orchestrator still uses `orchestrate-cli.ts` as its entrypoint; Phase 7 must ensure the UI no longer invokes the legacy pump semantics, only the lifecycle launch.)

### FINDING 2 — The pipeline view reads `episode_workflows.stage` for the indicator
- Legacy `GET /api/episode/pipeline` (`tracker-view.mjs:4458`) reads `SELECT stage, metadata, created_at FROM episode_workflows WHERE epic_id=?` and derives `currentIdx` from `ew.stage`.
- The lifecycle projection (`buildPipelineView`) reads **only** `lifecycle_runs` / `lifecycle_stage_runs` (via `SqliteLifecycleRunRepository`). It never touches `episode_workflows`.
- The `mount.js` coexistence contract returns `source:'legacy'` when no `LifecycleRun` exists (`pipeline-api.mjs:62-70`), causing the frontend to fall back to the legacy bar. After cutover this fallback must be removed: every epic that has a board must have a LifecycleRun, and the legacy poller must be deleted.

### FINDING 3 — Three endpoints MUTATE `episode_workflows` from the UI
1. `POST /api/episode/transition` (`tracker-view.mjs:5594`) → `lifecycleHandlers.episode_transition` (`src/tools/lifecycle.ts:273-379`) — `UPDATE episode_workflows SET stage=...`. Invoked by the `.episode-advance` UI buttons (`tracker-view.mjs:951-957`).
2. `POST /api/episode/resume` (`tracker-view.mjs:5579`, handler `4406-4446`) — `UPDATE episode_workflows SET metadata=json_remove(metadata,'$.needs-human',...)` to clear the pause flag. Invoked by `.episode-resume` UI buttons (`tracker-view.mjs:958-978`, `1637`).
3. `POST /api/engine/start|stop|restart|concurrency` and the engine status read all persist engine state into `episode_workflows.metadata` (`legacy-engine-administration.ts:97-102,123+`; status read joins it at `tracker-view.mjs:5122-5127`).

All three are LEGACY mutation paths that must be removed or repointed to the lifecycle runtime.

### FINDING 4 — The `boardRunner` and worker/model/concurrency endpoints are SHARED INFRA
`tracker-view/claude-runner.mjs` (`createClaudeBoardRunner`) spawns `claude` workers directly and manages concurrency/active-worker set in memory. It is engine-agnostic (used by the Saga3 engine via `claimScope.taskIds`, `claude-runner.mjs:499-504`). The worker-log tail, active-worker list, model selector, and concurrency controls read/write **shared** tables (`worker_executions`, `tasks`, `~/.claude/settings.json`, worker JSONL logs) — none of them are legacy-engine-specific. These MUST be preserved.

### FINDING 5 — A read-only compatibility projection adapter is needed temporarily
`GET /api/lifecycle/pipeline` already implements the correct projection but only renders the bar. The stage-detail / needs-human / gate-error signals that today come from `episode_workflows.metadata` (`/api/episode/pipeline` returns `needs_human`, `last_gate_error`; `/api/episode/stage-summary` reads `ew.stage`) must be repointed to lifecycle-equivalent fields (e.g. `LifecycleRun` `needs-human` projection, StageRun status). Per plan rule 9, a **read-only, clearly-named adapter** (e.g. `lifecycleStatusProjection`) with a deletion TODO may bridge these during cutover so the UI keeps working before the legacy reads are deleted.

---

## A) ENDPOINT TABLE

All routes are defined in the flat dispatcher at `tracker-view/tracker-view.mjs:5554-5738`. Classification legend: **LIFECYCLE** (reads LifecycleRun/StageRun/ProcessRun/NodeRun) · **LEGACY** (reads/mutates `episode_workflows` or invokes the legacy `orchestrate-cli.js` pump / `episode_transition`) · **SHARED** (worker logs, model selection, concurrency, board CRUD — engine-agnostic) · **HTML** (page render).

| Method | Path | Handler (file:line) | Reads / Writes | Classification |
|---|---|---|---|---|
| POST | `/api/artifact/save` | `handleArtifactSave` | writes `.md` + artifact metadata | SHARED (board CRUD) |
| POST | `/api/project/create` | `handleProjectCreate` | writes `projects` | SHARED |
| POST | `/api/project/archive` | `handleProjectArchive` | writes `projects.status` | SHARED |
| POST | `/api/project/delete` | `handleProjectDelete` | deletes `projects` (cascade) | SHARED |
| POST | `/api/admin/purge-all-projects` | `handleAdminPurgeAllProjects` | deletes all projects | SHARED (admin) |
| POST | `/api/epic/create` | `handleEpicCreate` | writes `epics` (+ `episode_workflows` row, see §C) | SHARED + **LEGACY write** |
| POST | `/api/project/create-from-idea` | `handleProjectCreateFromIdea` (`4273`) | writes project/repo/epic/`episode_workflows`/kickstart task **+ spawns legacy `orchestrate-cli.js`** (`4381`) | **LEGACY** (spawns legacy engine) + SHARED bootstrap |
| POST | `/api/episode/resume` | `handleEpisodeResume` (`4413`) | **writes** `episode_workflows.metadata` (clears `needs-human`) | **LEGACY** (mutates ew) |
| POST | `/api/board-run/start` | `handleBoardRunStart` (`2925`) → `boardRunner.start` | in-memory run; spawns `claude` workers | SHARED (worker pump; no UI button) |
| POST | `/api/board-run/stop` | `handleBoardRunStop` (`2945`) → `boardRunner.stop` | in-memory run | SHARED (no UI button) |
| POST | `/api/repository/register` | `handleSagaOperation('repository_register')` → `repositoryHandlers` | writes `repositories`/`project_repositories` | SHARED |
| POST | `/api/repository/bootstrap` | `handleSagaOperation('repository_bootstrap')` | `git clone` + checkout register | SHARED |
| POST | `/api/episode/transition` | `handleSagaOperation('episode_transition')` → `lifecycleHandlers.episode_transition` (`lifecycle.ts:273`) | **writes** `episode_workflows.stage` (hard-gate transition) | **LEGACY** (mutates ew; UI `.episode-advance`) |
| GET | `/api/board-run/status` | inline (`5597`) → `boardRunner.status` | in-memory run | SHARED |
| GET | `/api/episode/pipeline` | `handleEpisodePipeline` (`4453`) | reads `episode_workflows.stage` + `activity_log` | **LEGACY** (stage indicator source) |
| GET | `/api/lifecycle/pipeline` | `lifecyclePipelineApi.handlePipeline` (`pipeline-api.mjs:54`) | reads `lifecycle_runs`/`lifecycle_stage_runs` | **LIFECYCLE** |
| GET | `/lifecycle-pipeline/<asset>` | `lifecyclePipelineApi.handleStatic` (`pipeline-api.mjs:83`) | static CSS/JS/HTML | LIFECYCLE (client assets) |
| GET | `/api/episode/stage-summary` | `handleStageSummary` (`4544`) | reads `episode_workflows.stage` (epic join) + `artifacts`/`tasks`; spawns `summary.stage` task | **LEGACY read** (ew.stage) + SHARED task spawn |
| GET | `/api/worker/tail` | `handleWorkerTail` (`4726`) | reads worker JSONL logs | SHARED |
| GET | `/api/workers/active` | `handleWorkersActive` (`4868`) | reads `worker_executions` + `tasks` | SHARED |
| POST | `/api/engine/restart` | `handleEngineRestart` (`5145`) → `sagaApplication.restartEngine` → `LegacyEngineAdministration.restart` | **spawns `orchestrate-cli.js`** + writes `episode_workflows.metadata` | **LEGACY** (launches legacy pump) |
| POST | `/api/engine/start` | `handleEngineStart` (`5051`) → `sagaApplication.startEngine` → `LegacyEngineAdministration.start` | **spawns `orchestrate-cli.js`** + writes `episode_workflows.metadata` | **LEGACY** (the Start/Play button; launches legacy pump) |
| POST | `/api/engine/stop` | `handleEngineStop` (`5083`) → `sagaApplication.stopEngine` → `LegacyEngineAdministration.stop` | kills engine tree + writes `episode_workflows.metadata` | **LEGACY** (controls legacy pump) |
| GET | `/api/engine/status` | `handleEngineStatus` (`5117`) → `sagaApplication.getEngineStatus` + reads `episode_workflows.metadata` (`5122`) | reads engine pid/concurrency/model from `episode_workflows.metadata` | **LEGACY** (status of legacy pump; SHARED model/provider read mixed in) |
| POST | `/api/engine/concurrency` | `handleEngineConcurrency` (`5099`) → `sagaApplication.setEngineConcurrency` | writes `episode_workflows.metadata.engine_concurrency` | **LEGACY write** (SHARED concurrency semantics) |
| GET | `/api/models` | `handleModelsList` | static model catalog | SHARED |
| GET | `/api/lmstudio/models` | `handleLmstudioModelsList` | probes LM Studio | SHARED |
| POST | `/api/model/set` | `handleModelSet` (writes `~/.claude/settings.json` + `episode_workflows.metadata` at `5516,5530`) | writes settings + `episode_workflows.metadata.active_model` | SHARED model switch + **LEGACY write** (ew metadata) |
| GET | `/api/heartbeat` | inline (`5648`) | reads `activity_log` | SHARED |
| GET | `/artifact/<id>/edit` | `renderArtifactEdit` | HTML wiki editor | HTML |
| GET | `?artifact=<id>` | `renderArtifactView` | HTML wiki view | HTML |
| GET | `/stage?epic=N&stage=X` | `renderStageDetailPage` | HTML stage detail | HTML |
| GET | `?task=<id>` | `renderTaskView` | HTML task card | HTML |
| GET | `?registry=<TYPE>` | `renderRegistry` | HTML cross-project registry | HTML |
| GET | `/admin` | `renderAdmin` | HTML admin page | HTML |
| GET | `/?project=<id>[&tab=...]` | `renderBoard`/`renderArtifacts`/`renderCoverage`/`renderAcceptance` | HTML board (server-rendered; includes the Play button + pipeline bar markup) | HTML |
| GET | `/` | `renderIndex` | HTML project index | HTML |

**Separate sub-app — `tracker-view/docs-graph/server.mjs`** (own `http.createServer`, line 433). Reads the docs/artifact/git graph; not lifecycle-related. Endpoints: `GET /api/projects`, `GET /api/graph?project=<id>`, `POST /api/doc/{save,merge,branch/create,branch/discard}`, `GET /api/doc/{read,diff,branch/list}`. Classification: **SHARED** (docs tooling). Out of scope for this cutover; preserved as-is.

---

## B) DELETE LIST — endpoints / files / labels to remove

### B.1 HTTP endpoints to delete (remove the `if`-branch in `tracker-view.mjs:5554-5738`)
| Line | Endpoint | Reason |
|---|---|---|
| `5579` | `POST /api/episode/resume` | mutates `episode_workflows.metadata` to clear legacy `needs-human`; needs-human becomes a lifecycle projection |
| `5594` | `POST /api/episode/transition` | invokes `episode_transition` → mutates `episode_workflows.stage`; stage transitions are owned by the Lifecycle Orchestrator (`episode_transition` MCP tool itself is kept per Phase 3 §TRAP 2, but **not exposed from the UI**) |
| `5601` | `GET /api/episode/pipeline` | reads `episode_workflows.stage`; replaced by `/api/lifecycle/pipeline` |
| `5623-5636` | `POST /api/engine/restart|start|stop`, `POST /api/engine/concurrency` | launch/control the legacy `orchestrate-cli.js` pump and write `episode_workflows.metadata`. Repoint Start/Play to lifecycle launch (§C.1); delete the legacy pump-control surface |
| `5632` | `GET /api/engine/status` | reads legacy pump status from `episode_workflows.metadata`; replaced by lifecycle run status (§C.2) |

> Note: `handleSagaOperation`'s `episode_transition` branch (`tracker-view.mjs:2970-2974`) and the `lifecycleHandlers.episode_transition` MCP handler in `src/tools/lifecycle.ts` are **NOT deleted** (Phase 3 §TRAP 2: the MCP tool is shared and used by the orchestrator). Only the **UI HTTP route** `/api/episode/transition` is removed.

### B.2 Frontend JS/HTML to delete (inside `tracker-view.mjs`)
- The `.episode-advance` UI buttons and their click handler (`tracker-view.mjs:951-957`) — they POST to `/api/episode/transition`.
- The `.episode-resume` UI buttons and handler (`tracker-view.mjs:958-978` and the duplicate at `1637`) — they POST to `/api/episode/resume`.
- The legacy `refreshPipeline()` function (`tracker-view.mjs:1168-1211`) and its polling loop — replaced by the lifecycle `mount.js` exclusively.
- The coexistence fallback in `lifecycle-pipeline/public/mount.js`: after cutover `source:'legacy'` is no longer a valid response; remove `releaseOwnership()`/`legacyRefresh()` wiring (`mount.js:11-15,47-91`) and the `.catch()` legacy fallback in the poll loop (`mount.js:56-62`). `mount.js` becomes the only pipeline renderer.
- The legacy fallback in `pipeline-api.mjs:62-70` (returning `source:'legacy'` when no LifecycleRun exists) — after cutover a board with no LifecycleRun is an error/empty state, not a legacy render.
- The Play-button confirm dialog text referencing `orchestrate-cli` and `episode_workflows` comments (`tracker-view.mjs:1448-1453`, `971`).

### B.3 Labels / concept names to delete from the UI
- "движок" engine-control framing tied to the legacy pump (status strings at `tracker-view.mjs:1380-1404`, `979-995`).
- `SAGA_ORCHESTRATION_MODE` v2/v3/saga2 branch text in the admin create-from-idea hint (`tracker-view.mjs:3898-3903`, `3922-3932`) — after cutover there is one launch path (lifecycle).

### B.4 Files NOT deleted (despite legacy flavor) — preserved
- `tracker-view/claude-runner.mjs` — SHARED worker pump (spawns `claude`, not the legacy engine). Keep.
- `tracker-view/lifecycle-pipeline/*` — LIFECYCLE. Keep (after fallback removal).
- `tracker-view/docs-graph/*` — SHARED docs tool. Keep.
- `src/infrastructure/engine/legacy-engine-administration.ts` — generic process-control infra (Phase 3 §7 / §TRAP 3: KEEP-and-rename). The UI simply must not invoke its legacy pump semantics; the lifecycle launch path reuses the process-control machinery.

---

## C) ADAPT LIST — repoint from `episode_workflows` to lifecycle projections

### C.1 Start/Play button → launch the Lifecycle Orchestrator
**Today:** `▶` → `POST /api/engine/start` → `LegacyEngineAdministration.start` → `node orchestrate-cli.js ...` (legacy pump).
**After:** `▶` → `POST /api/lifecycle/run/start` (NEW route) → `process_run_start` (or the `ProductLifecycleRuntime` start seam in `src/app/product-lifecycle-runtime.ts`, which wires the `LifecycleOrchestrator` over `process_runs`/`lifecycle_runs`/`node_runs`). The button must launch **only** the Lifecycle Orchestrator.

Implementation notes:
- Add a new handler (e.g. `handleLifecycleRunStart`) that calls the lifecycle run-start path with `project_id` + `epic_id` + `idempotency_key` + optional `lifecycle_input_path`. Reuse the existing `lifecycleInputPath` / `idempotencyKey` plumbing already accepted by `handleEngineStart` (`tracker-view.mjs:5058-5068`) — those fields are already lifecycle-shaped.
- Stop/Restart: repoint to lifecycle run cancel (`process_run_cancel`) / replay semantics, not the legacy kill-tree.
- Remove the `sagaApplication.startEngine` → `LegacyEngineAdministration` call from the UI path.

### C.2 Engine status → lifecycle run status
**Today:** `GET /api/engine/status` reads `$.engine_running/engine_pid/engine_concurrency/active_model` from `episode_workflows.metadata` (`tracker-view.mjs:5122-5127`, written by `legacy-engine-administration.ts:97-102`).
**After:** read the current `ProcessRun`/`LifecycleRun` status (`process_run_get` / `lifecycle_run_get`) for the epic: `status` (running/paused/settling/completed/failed), `executor_run_ref` (pid), and the StageRun the run is on. The model/provider read can stay (it lives in `~/.claude/settings.json` + a non-ew projection; see §D).

### C.3 Pipeline bar → lifecycle-only
**Today:** `mount.js` polls `/api/lifecycle/pipeline`; on `source:'legacy'` it yields to `refreshPipeline()` (which reads `episode_workflows`).
**After:** delete the legacy poller; `mount.js` always renders from `/api/lifecycle/pipeline`. If the projection returns null (no run), render an explicit "no lifecycle run" empty state with a Start button.

### C.4 needs-human / gate-error signals → lifecycle projections
**Today:** `/api/episode/pipeline` returns `needs_human` and `last_gate_error` parsed from `episode_workflows.metadata` (`tracker-view.mjs:4469-4470,4519-4520`); `.episode-resume` clears `$.needs-human` (`4434-4438`).
**After:** derive needs-human / gate-blocked from the lifecycle runtime (e.g. a StageRun/NodeRun `blocked`/`needs-human` projection, or a `human_requests` row). The "Resume" action becomes "answer/clear the lifecycle human-request" (`worker_ask_done`), not an `episode_workflows` metadata write.

### C.5 Stage indicator / stage-summary → lifecycle stage
**Today:** `/api/episode/stage-summary` reads `ew.stage` via `epics ⋈ episode_workflows` (`tracker-view.mjs:4556-4560`).
**After:** read the current stage from the active `LifecycleRun`/`StageRun`. The `summary.stage` task-spawn mechanism itself is SHARED (creates a `tasks` row) and can stay; only the `ew.stage` lookup is repointed.

### C.6 create-from-idea → lifecycle bootstrap
**Today:** `handleProjectCreateFromIdea` (`4273`) inserts an `episode_workflows` row (`4326`) and spawns `orchestrate-cli.js` via `sagaApplication.startEngine` (`4381`) when `requiresBackgroundEngine(mode)`.
**After:** the bootstrap creates the project/repo/epic (SHARED) and launches the Lifecycle Orchestrator for the new epic instead. The `episode_workflows` INSERT becomes unnecessary (lifecycle runs own stage state). The `discovery.kickstart` task projection stays for the discovery flow.

---

## D) PRESERVE LIST — shared-infra endpoints (worker logs, model, concurrency)

These are engine-agnostic and MUST survive the cutover unchanged:

| Endpoint | Handler | What it does (keep) |
|---|---|---|
| `GET /api/worker/tail?log_path=...` | `handleWorkerTail` (`4726`) | Tails worker JSONL logs (filtered, path-traversal-guarded via `canonicalAllowedWorkerLogPath`). Used by the live-worker streaming view. |
| `GET /api/workers/active?project_id=N` | `handleWorkersActive` (`4868`) | Lists running workers from `worker_executions` (+ legacy `tasks` union). Drives the worker monitor panel (`renderWorkersList`). |
| `GET /api/models` | `handleModelsList` | Static model catalog (GLM-5.2 / 5-Turbo / 4.7 + concurrency limits). |
| `GET /api/lmstudio/models` | `handleLmstudioModelsList` | Probes the local LM Studio endpoint; powers the "↻ обновить список" sentinel. |
| `POST /api/model/set` | `handleModelSet` | Switches the worker model by patching `~/.claude/settings.json` (atomic + fsync). **Adapt:** the secondary write into `episode_workflows.metadata.active_model` (`tracker-view.mjs:5516,5530`) must be repointed to a non-ew projection (e.g. a `project_metadata`/lifecycle-run field, or dropped in favor of settings.json alone). The settings.json write itself is preserved. |
| `POST /api/board-run/start|stop`, `GET /api/board-run/status` | `boardRunner.*` (`claude-runner.mjs`) | In-process worker pump (spawns `claude` directly, supports `claimScope.taskIds` for the Saga3/lifecycle engine). No UI button today; preserved as an alternate/manual worker-launch path. |
| `GET /api/heartbeat` | inline (`5648`) | Activity-log freshness probe for the heartbeat dot. |
| `POST /api/repository/register|bootstrap` | `repositoryHandlers` | Repo registration / git clone. SHARED. |
| `POST /api/artifact/save`, `/api/project/*`, `/api/epic/create`, `/api/admin/purge-all-projects` | board CRUD | SHARED board management. |

**Preserved infrastructure modules:**
- `tracker-view/claude-runner.mjs` — worker spawn, concurrency rotation, rate-limit backoff, LM-Studio env routing. Keep.
- `tracker-view/artifact-presentation.mjs`, `tracker-view/structured-context-hook.mjs` — SHARED presentation. Keep.
- `tracker-view/docs-graph/*` — SHARED docs/git-graph tool. Keep.
- `WORKER_LOG_ROOTS` / `canonicalAllowedWorkerLogPath` (`tracker-view.mjs:43-66`) — shared worker-log path policy. Keep.
- Concurrency selector (`runnerConcurrency`) semantics — keep; only the persistence target changes from `episode_workflows.metadata` to a lifecycle/shared projection.

---

## E) Read-only compatibility projection adapter (plan rule 9)

During cutover, a **read-only, clearly-named adapter** bridges the UI signals that still expect `episode_workflows`-derived fields to the lifecycle runtime, so the frontend keeps working before the legacy reads are physically deleted. Proposed:

- **Name:** `lifecycleStatusProjection` (or `lifecycleUiProjection`) — read-only, suffix makes intent obvious.
- **Location:** `tracker-view/lifecycle-pipeline/lifecycle-status-projection.mjs` (sibling of `pipeline-api.mjs`).
- **Surface:** a single function `buildStatusView(projectId, epicId, lifecycleRepo, workerExecRepo)` returning `{ stage, needs_human, last_gate_error, running, pid, concurrency, active_model }` — the exact shape today's UI consumes — but sourced from `lifecycle_runs`/`lifecycle_stage_runs`/`process_runs`/`worker_executions` (+ `~/.claude/settings.json` for the model). No writes.
- **Deletion TODO:** every file and every consumer carries `// DELETION TODO(Phase-7-finalize): remove once /api/engine/* and /api/episode/pipeline are deleted and the UI consumes lifecycle fields directly.` Once the UI is rewritten to read lifecycle fields natively (§C.2–C.5), this adapter and its consumers are deleted.

This adapter is the temporary projection required by rule 9: read-only, clearly named, with an explicit deletion TODO. It does NOT mutate `episode_workflows` and does NOT invoke the legacy pump.

---

## F) Cutover sequence (suggested order)

1. **Build the lifecycle launch + status handlers** (§C.1, C.2) behind new routes `/api/lifecycle/run/start|stop|status`, sourced purely from the lifecycle runtime. Add the read-only `lifecycleStatusProjection` adapter (§E).
2. **Repoint the Play button** (`tracker-view.mjs:1487`) and `fetchEngineStatus` (`1380`) to the new lifecycle routes. Keep the old `/api/engine/*` routes live temporarily.
3. **Repoint needs-human / stage-summary / pipeline** (§C.3–C.5) to lifecycle projections via the adapter. Remove the legacy `refreshPipeline` poller and `mount.js` fallback.
4. **Remove the UI `.episode-advance` / `.episode-resume` buttons** (§B.2); stage transitions and resume become orchestrator-driven.
5. **Delete the legacy HTTP routes** (§B.1): `/api/episode/{resume,transition,pipeline}`, `/api/engine/{start,stop,restart,concurrency,status}`.
6. **Repoint `create-from-idea`** to the lifecycle bootstrap (§C.6); drop the `episode_workflows` INSERT and the `orchestrate-cli` spawn.
7. **Repoint the model-set secondary write** (§D) off `episode_workflows.metadata`.
8. **Delete the read-only adapter** (§E) once the UI reads lifecycle fields natively.

After step 8, tracker-view is a pure projection of the lifecycle runtime: Start/Play launches only the Lifecycle Orchestrator, no endpoint mutates `episode_workflows`, and no endpoint reads the legacy pump.
