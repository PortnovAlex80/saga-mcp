# saga-mcp 3.0 — Changelog

## Release: saga-mcp 3.0 — Autonomous Orchestration Engine (2026-07-18)

**32 commits** from `f678d43` to `378ec65`. End-to-end verified on 4D_Las_viewer
(epic 126): idea → discovery → formalization → planning → development → verification,
fully autonomous with self-healing.

---

### 🏗️ Core Engine (saga-mcp 3.0)

- **Autonomous pump loop** (`src/orchestrate.ts`): pump → generateNext → episode_transition
  → pause/resume. Replaces v2 main-context orchestrator. Engine runs as background process,
  drives episodes from idea to integration without human-in-loop.
- **CLI entry point** (`src/orchestrate-cli.js`): `node dist/orchestrate-cli.js <project_id>
  <epic_id> [--concurrency=N]`. Spawned by web form or run manually.
- **ADR-008**: `brief_accepted` transition creates ONE formalization.prd task (not PRD+SRS
  parallel as plan draft said). Parallel SRS would break sibling() lookup in srs_accepted
  (workflow.ts:108) and block reconciliation. MCDA matrix + pre-mortem in ADR.
- **Bug fix**: episode_transition raced ahead when in_flight>0. Gate now requires
  `counts.inFlight === 0` before advancing.
- **Bug fix**: engine calls `reevaluateDownstream` every cycle — closes race between
  any state mutation and saga's downstream-blocking invariant.
- **Bug fix**: 'tasks not completed' gate fail no longer escalates when there are
  claimable or in-flight tasks — it's normal pipeline progress, not an error.

### 🔧 Self-Healing Recovery

- **RECOVERY_TREE** (`src/orchestrate.ts`): lookup table keyed by stage. Each rule:
  match (RegExp on gate error) + diagnosis + action_prompt + max_retries. When
  episode_transition fails, engine spawns a healer worker with inline prompt.
- **Coverage**: formalization (no AC artifacts, AC baseline not accepted, missing
  PRD/SRS/UC), planning (no planning tasks), development (no dev tasks, merge conflicts),
  verification (no passing evidence), integration (no integration tasks).
- **Recovery hold**: episode cannot advance while any recovery.heal task is active
  (todo/in_progress/review/review_in_progress). Prevents stranded review tasks.
- **Merge conflict healer**: development gate 'tasks not completed/integrated' triggers
  healer that reads worktree metadata, resolves mechanical conflicts, escalates semantic.

### 🧟 Zombie Worker Detection

- Every 30s: `statSync(JSONL)` for each active worker. If log (size, mtime) unchanged
  for 90s → kill worker PID + release task back to queue.
- `worker_pid` persisted in `task.metadata.worker_pid` by claude-runner on spawn.
- Cheap: one statSync per active task per scan.

### ⚡ Rate-Limit Aware Concurrency (Natural Rotation)

- `runner.setConcurrency(projectId, N)` — live ceiling change without restart.
- Rate-limit scanner: every 10s, scans JSONL tails for `api_retry/429/rate_limit`.
  On detection: lowers effectiveConcurrency by 1. Workers keep running (claude backoff),
  no replacements spawned until count drops below ceiling.
- Recovery: 60s without 429 → +1 toward target.
- Model change: PATCH settings.json + metadata. Old workers finish on old model,
  new workers spawn on new model. NO engine restart.

### 🖥️ Monitor Panel (Right Sidebar)

- **Pipeline progress bar**: `[✓Discovery 9m]→[✓Formalization 58m]→[●Planning 13m]→[○Dev]`.
  Duration from activity_log. Live duration for current stage.
- **Live workers panel**: clickable rows per active worker. Shows task, age (from
  worker_started_at), tok/s. Click → expands tail of stream-json events (tool_use,
  assistant text, tool_result, api_retry with details). Auto-refresh every 3s.
- **Token speed (tok/s)**: thinking_tokens for smart models (GLM-5.2), assistant output
  chars / 4 for flash models (z.ai proxy returns estimated_tokens=1 for cheap models).
- **Recovery indicator**: 🔧 icon for healer tasks + amber banner. Pulse dot when active.
- **Status dots on kanban cards**: 3-colour (green/yellow/red) by log_mtime_ms freshness.
  Pulse tempo inversely proportional to age (fast/med/slow). Hidden for done/blocked.
  Instant red when worker log goes stale (>30s no growth).

### 📊 Clickable Pipeline Stages

- Completed/in-progress stages are clickable → overlay panel with stage summary.
- Summary generated via **task-spawn**: clicking creates `summary.stage` task (critical
  priority) → worker reads all artifacts for the stage → writes human-readable markdown
  summary → saves as artifact. Subsequent clicks return cached summary.
- Poll loop: shows "Резюме в очереди (task #N)" until worker finishes, then renders markdown.
- Minimal markdown renderer (headings, lists, bold, code) — all regex via `new RegExp()`
  to survive inside template literal.

### 🤖 Model Management

- **Model dropdown** in header: 8 models with concurrency limits (glm-5.2 ×10, glm-4.5
  ×10, glm-4-plus ×20, glm-4.5-air ×5, glm-4.5-flash ×2, etc.).
- **`POST /api/model/set`**: patches `~/.claude/settings.json`, writes `active_model`
  + `active_model_limit` to episode metadata. NO engine restart.
- **Model display** (`🧠 glm-4.5-flash`): resolves real model under claude alias via
  `ANTHROPIC_DEFAULT_*_MODEL` env vars.
- **Auto-concurrency**: effective = min(opts.concurrency, model_limit). Smaller model
  limits the queue.

### 🔄 Hot-Reload

- Watcher on `tracker-view.mjs` + `claude-runner.mjs`: on change → kill tracker-view →
  spawn fresh. Engine and workers NOT touched.

### 📡 Stream-JSON

- `claude -p --output-format stream-json --verbose --forward-subagent-text`.
- JSONL log grows in real time (was 192 bytes per run, now 1-5 MB).
- Every tool_use, assistant text, tool_result, system/api_retry visible.
- Worker tail endpoint: deep-scans up to 2MB skipping thinking_tokens noise.

### 🌐 Web UI Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/project/create-from-idea` | One-shot bootstrap: project + repo + epic + kickstart task + spawn engine |
| `POST /api/episode/resume` | Clear needs-human flag |
| `GET /api/episode/pipeline` | Per-stage status + timestamps + duration |
| `GET /api/episode/stage-summary` | Stage summary (ready/generating/queued) |
| `GET /api/workers/active` | DB-sourced active workers with log_path, mtime, tok/s, is_stale |
| `GET /api/worker/tail` | Safe tail of worker JSONL (path-traversal guarded) |
| `POST /api/engine/restart` | Restart engine with new concurrency (recursive kill) |
| `GET /api/models` | Catalog of 8 models with limits |
| `POST /api/model/set` | Change model (patch settings + metadata, no restart) |

### 🐛 Bug Fixes

- **TZ-bug (180m ago)**: SQLite `datetime('now')` = UTC, but code treated as local.
  `parseTs` normalizes to ISO Z.
- **Worker age (190m)**: `started_at` from `metadata.worker_started_at`, not `updated_at`.
- **"нет активных воркеров" + worker simultaneously**: `.worker-empty` placeholder not
  removed before rows.
- **Pipeline duration null**: initial stage fallback to `episode_workflows.created_at`.
- **Resume button not auto-rendering**: `refreshBoard` now updates `.episode-progress-bar`.
- **BRIEF orphan in coverage**: UI accounts for target-side traces.
- **Worker tail empty**: deep scan up to 2MB, skipping thinking_tokens.
- **`require()` in ESM**: `createRequire(import.meta.url)` bridge.
- **Regex in template literal**: `\r\n` in regex inside backtick string → actual CR/LF.
  Fixed via `new RegExp()`.
- **2 engine after restart**: recursive CIM process tree kill (`/T` misses detached).
- **Restart sync pause no-op**: `setTimeout` → `spawnSync('timeout /T 1')`.
- **Concurrency selector default**: reads `engine_concurrency` from episode metadata.
- **agent-run-status clipped**: removed `max-width:150px`.

### 📁 Files Changed

- `src/orchestrate.ts` — engine, recovery tree, rate-limit, zombie detection (~800 lines)
- `src/orchestrate-cli.ts` — CLI entry point (~100 lines)
- `src/tools/workflow.ts` — brief_accepted transition + ADR-008
- `tracker-view/tracker-view.mjs` — all UI + endpoints (~1000 lines added)
- `tracker-view/claude-runner.mjs` — stream-json, setConcurrency, worker_pid persist
- `tracker-view/claude-runner.d.mts` — type shim
- `tests/product-workflow.test.mjs` — 3 new tests for ADR-008
- `docs/architecture/decisions/008-brief-accepted-prd-only.md` — ADR

### 🧪 Testing

- `tests/product-workflow.test.mjs`: 63/63 pass (was 60, +3 for ADR-008)
- `tests/claude-runner.test.mjs`: 4/4 pass
- End-to-end: 4D_Las_viewer (epic 126) — discovery → formalization → planning →
  development → verification, autonomous with self-healing
