# saga-mcp 3.0 — Changelog

## [Unreleased]

### Fixed — `worker_next` now dispatches ALL priorities (was: medium+ only) — 2026-07-21

**Root cause.** `findNextClaimable` in `src/tools/dispatcher.ts` and
`countActiveTasks` in `src/orchestrate.ts` both filtered candidate tasks by
`priority IN ('critical','high','medium')`. Any `low`-priority task was
invisible to the dispatcher and to the engine pump-loop.

`saga-planner` legitimately assigns `priority=low` to extension / edge-case
ACs (e.g. "Interactive Examples", "Duplicate Name Handling", "Empty-State
Message"). These tasks had their dependencies satisfied and were ready to
run, but `worker_next` refused to hand them out.

**Cascade failure observed (Sollar episode, 2026-07-21):** 5 dev tasks
(#21/#22/#23/#24/#28) stuck in `todo`/`blocked` because planner marked them
`low`. Engine's gate refused to advance to verification
("tasks not completed/integrated"). Engine then spawned 8 `recovery.heal`
tasks (#33–#40) trying to "fix" the situation; the recovery skill
hallucinated that the code was already written and tried to advance task
status via the API, which `worker_done` rejects for `todo` tasks. After
3 failed recoveries the engine paused the episode with `needs-human=1`.

**Fix.** Removed the `priority IN (...)` filter from both SQL queries.
The `ORDER BY PRIORITY_ORDER` clause is preserved, so critical tasks are
still handed out before low — but low is no longer a hard block.

| File | Change |
|---|---|
| `src/tools/dispatcher.ts` | `findNextClaimable`: dropped `AND t.priority IN ('critical','high','medium')`. Updated `worker_next` description (was misleading models into manually bumping priority). |
| `src/orchestrate.ts` | `countActiveTasks`: dropped the same filter. Engine pump-loop now sees `low`-priority tasks as `claimable > 0` and dispatches workers. |

**Semantic change.** `priority=low` previously meant *"waits for manual
decision — raise to medium+ to make claimable"*. It now means *"dispatched
last, after all higher priorities are exhausted"*. If a task must never be
auto-dispatched, use `status=blocked` (without `depends_on`) or a dedicated
`deferred` tag — `priority=low` is no longer a deferral mechanism.

**Verification.** Sollar episode resumed immediately after the engine
rebuild + restart (PID 3144 → 3992): `claimable=1` for the previously-stuck
`low` task, 2 workers running in parallel, 0 new recovery tasks spawned.
The previously-stuck chain (#21 → #22 → #23 → #24 → #28) progressed to
completion through the normal pipeline.

See `docs/research/testing-2026-07-21-sollar-new-pipeline.md` (case T-006)
for the full incident timeline and root-cause analysis.

---

### Changed — Pipeline reorder: SRS after AC + Complexity Gate + DECOMP (ADR-014)

- **Architecture step moved.** SRS is now written AFTER AC (was: parallel with UC).
  Pipeline: `BRIEF → PRD(+FR/NFR/RULE) → UC → AC → Reconcile → SRS(+DECOMP) → Planning → Dev → Verify → Integrate`.
- **Complexity Gate linked to architect.** saga-architect MUST read brief complexity
  and choose architecture by mandatory table (XS=KISS, M-sequence=Modular Monolith, etc.).
- **DECOMP §D.** New SRS section: per-AC YAML map (files, functions, types,
  conflict_keys, ac_kind). Planner becomes dumb copier.
- **FR/NFR/RULE moved to PRD.** saga-product creates them as separate artifacts with
  derived_from → PRD.
- **11 skills updated**, **12 docs updated**, ADR-014 added, ADR-008 addendum.

See `docs/plans/PIPELINE-REORDER-SRS-AC.md` for full plan and rationale.

---

## Hotfix: saga-mcp 3.0.1 — Worker Execution Fencing + Markdown + Russian UX (2026-07-18)

**11 commits** from `f865570` to `3ee4e66`. End-to-end verified by completing the
4D_Las_viewer pipeline (epic 126): after these fixes the integration stage advanced
to `completed`, while a board without them was stuck in verification for 3+ hours
with 12+ orphan `claude.exe` workers and 6 spurious `verified_by` traces.

---

### 🔒 ADR-009: Durable Worker Executions + Canonical Verification Targets

The 3.0 liveness model (log-silence ≈ death, `tasks.status` ≈ process truth)
broke on `verification.ac`: cargo/vitest runs are silent for 3–7 minutes, so the
zombie watcher killed live workers mid-build, leaving orphans. Two related
defects in verification compounded the deadlock.

**`docs/architecture/decisions/009-worker-execution-fencing.md`** — full ADR
with MCDA (option B: durable registry + fence scored 455/500) and 6 pre-mortems.

#### P1 — Canonical verification target

- `tasks.verification_target_artifact_id` stores the single AC each
  `verification.ac` task owns.
- `verification_record` rejects cross-AC evidence (`artifactId !== target` throws).
- Gate checks passing evidence only for the canonical AC revision.
- **Migration** (`migrateVerificationTargets`): backfills the canonical target
  from `depends_on` provenance, falls back to one unambiguous AC-code match in
  the title, then deletes mismatched legacy `verified_by` edges while keeping
  evidence rows immutable for audit.
- In production: cleaned 6 spurious traces on epic 126 (AC-1→#741, AC-3→#743,
  AC-4→#742, AC-6/AC-7/AC-8→#744) that had kept `worker_done(approved)` failing
  in a ~25-cycle zombie loop for ~3 hours.

#### P2 — Per-execution evidence retry

- `verification_evidence.execution_id` column added. New UNIQUE index
  `idx_verification_evidence_attempt` over `(task_id, artifact_id, content_hash, execution_id)`.
- A later holder can append its own evidence without overwriting the prior
  attempt's history.
- Operator one-shot in production: deduped 4 legacy duplicate evidence rows so
  the migration could install the new UNIQUE index.

#### P3 — Worker execution registry + fence

- New `worker_executions` table — durable per-attempt record of host, PID,
  process-birth token, log path, phase, state.
- `worker_next` reserves an execution ID atomically with the task claim.
- Spawned process moves its row `reserved → running` and records process-birth
  identity (Windows: CIM `CreationDate`; Linux: `/proc/<pid>/stat` field 22).
- **All managed worker mutations are fenced** by `tasks.current_execution_id`:
  `worker_done`, `verification_record`, `worker_ask_*`, `worker_merge_*` all
  enforce the fence via `assertExecutionFence`. A late response from a
  superseded process is rejected.
- **Liveness = OS PID, not log mtime.** `reconcileWorkerExecutions` walks
  active executions every cycle: a live PID that still owns an allowed phase
  (executing / reviewing / finishing / integrating) is **kept**, even if its
  JSONL log has been silent for minutes. Long cargo/vitest runs no longer die.
- **Termination requires matching PID + birth token.** PID reuse cannot kill
  an unrelated process; mismatched birth identity falls back to "kept" instead
  of "terminated".
- **Legacy compatibility:** assignments created before ADR-009 (no
  `execution_id`) are observed. A live legacy PID is preserved; a dead legacy
  PID releases the task back to the queue via exact compare-and-swap.
- **Frontend truth source** switched from `tasks.status` to `worker_executions`.
  `/api/workers/active` returns rows with `execution_id`, `pid`, `process_phase`,
  `is_stale`, `is_quiet`, `tokens_per_sec`. Bug "frontend shows `workers: []`
  while 3 `claude.exe` are running" fixed.

#### Operator recovery playbook (proven on epic 126)

1. `npm run build` — the new `dist/worker-executions.js` must exist or every
   `claude.exe` spawn dies on `markExecutionRunning` with `ERR_MODULE_NOT_FOUND`.
2. Clear stale `engine-<pid>-<eid>.pid` lock, kill orphan engines and orphan
   claude children, then `POST /api/engine/restart`.
3. If `node orchestrate-cli.js` fails with `UNIQUE constraint failed:
   idx_verification_evidence_attempt`, the live DB has pre-ADR-009 duplicates —
   dedupe with `DELETE … WHERE id NOT IN (SELECT MAX(id) … GROUP BY …)`.
4. Migration runs on the next saga-MCP start; no manual trace cleanup needed.

#### Files touched by ADR-009

- `src/worker-executions.ts` (+398 lines) — registry, fence, reconciliation, birth token
- `src/db.ts` (+163) — `verification_target_artifact_id`, migrations
- `src/tools/dispatcher.ts` (+201) — claim reserves execution, target enforcement
- `src/tools/lifecycle.ts` (+55) — `verification_record` cross-AC rejection + fence
- `src/tools/artifacts.ts` (+40) — `depends_on` backfill for canonical target
- `src/tools/tasks.ts` (+43) — `assertExecutionFence` integration
- `src/orchestrate.ts` — `reconcileWorkerExecutions` replaces log-mtime zombie scan
- `src/schema.ts` — `worker_executions` table + indexes
- `tracker-view/claude-runner.mjs` — reservation, `markExecutionRunning`, fenced close
- `tracker-view/tracker-view.mjs` — `/api/workers/active` reads registry, not `tasks.status`
- `tests/product-workflow.test.mjs` (+206) — fence race, target rejection, retry evidence

---

### 🔒 PID-lock singleton guard (one engine per epic)

- `~/.zcode/cli/engine-<projectId>-<epicId>.pid` written at engine startup.
- A second engine for the same (project, epic) exits immediately with
  `DUPLICATE_EXIT` if the recorded PID is still alive.
- Mitigates (does not yet eliminate) the duplicate-engine storm: when
  `POST /api/engine/restart` or `POST /api/project/create-from-idea` spawns
  multiple engines in quick succession, only the first survives.
- **Known gap** (not yet closed): spawn sites in `tracker-view.mjs` do not check
  the lock *before* spawning — they rely on the CLI's exit-on-duplicate. A
  short overlap window (~1s) can still produce two engines.

### 📝 Markdown renderer (stage detail page)

Five-iteration fix. The renderer lives inside a JS template literal; regex
literals with `\n`, `\r`, `\s`, `**` collapse to literal control characters and
either silently mis-render or throw `Invalid regular expression: Nothing to
repeat`.

- **`4e4ba1d`** — All control chars built via `String.fromCharCode(N)`.
  `var NL = String.fromCharCode(10)` instead of `\n` in the regex source.
- **`91767b4`** — Per-line heading/`---` hr parsing: any line within a block,
  not only single-line blocks.
- **`f2c8e81`** — Asterisk escape. `String.fromCharCode(42)` is the `*`
  quantifier; `new RegExp('**...')` throws. Use `String.fromCharCode(92, 42)`
  to emit `\*`.
- **`ddcca66`** — Per-line `###` and `---` detection inside multi-line blocks.
- **`0065d1e`** — Initial markdown rendering on stage detail page.

### 🇷🇺 Russian UX

- **`0dd1e83`** — Summary task prompt rewritten in clean Russian without
  anglicisms. English terms (PRD, SRS, baseline, reconciliation, scaffold) are
  explained parenthetically, e.g. «baseline (зафиксированная базовая версия
  требований)».
- **`59a9fc7`** — Russian stage descriptions on the pipeline detail page.

### 🧹 Gate and API hygiene

- **`d571940`** — `type:'summary'` added to the artifact catalog so
  `summary.stage` workers can persist their output as an artifact.
  `summary.stage` and `recovery.heal` tasks are excluded from the transition
  gate (`assertTasksReady`) so bookkeeping tasks cannot block episode advance.
- **`dc9a98a`** — Stage detail moved from overlay to a dedicated page.

---

### 🧪 Testing after 3.0.1

- `npm test`: **169/169 pass** (was 137 at 3.0 release; +32 for ADR-009).
- Claim race: PASS.
- Fenced verdict race, 8 parallel processes: PASS — exactly one winner.
- Worktree/review/merge lifecycle: 35/35 PASS.
- `tsc --noEmit`: clean. `npm run lint` shows only pre-existing `eqeqeq`
  violations in legacy modules; new execution/orchestration modules are clean.
- End-to-end: 4D_Las_viewer epic 126 advanced from stuck verification to
  integration within ~10 minutes after the hotfix landed.

---

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
