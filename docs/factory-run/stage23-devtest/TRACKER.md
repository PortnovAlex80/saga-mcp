# Stage-23 — DEVTEST: Development-only production run from the frozen capsule

**Operator directive (2026-08-24):** the factory must ALWAYS start straight at
the Development workshop from the frozen workshops-1+2 capsules. No time is to
be spent re-running Discovery/Formalization. The entry point is prepared
separately (runbook below). Launched with the incident fixes riding
(commit `a9a3f289`).

## Status: STOPPED AGAIN (operator directive, 2026-08-24 ~12:25 local)

Second full stop, same clean protocol: engine 29992 braked, 2 executions fenced
(both with workplace rewind), 0 workers running, controls `stopped`, checkpoint
`latest-1-all` refreshed, watchdog killed. State at stop: tasks 34+ → 9 done,
2 in review, 3 todo (the graph grew to 14 cards across the resume — third wave
review cards included). Resume protocol unchanged (unpark → resume → watchdog).

## (historical) RESUMED (operator directive, 2026-08-24 10:50 UTC / 13:50 local)

Resume executed per protocol: unpark released 1 operator hold (0 parked workplaces
needed requeue), engine restarted as pid 29992 adopting the SAME launch
`cdc27a79` (correct — the launch stayed active across the stop), controls
running/concurrency 8, watchdog restarted (12h). The two stop-fenced tasks were
immediately re-dispatched with FRESH executions (task 29 → `6717f79f…` pid 29044,
task 30 → `e54525a6…` pid 49160, both running/executing within 6s of engine start).

## (historical) STOPPED (operator directive, 2026-08-24 ~11:50 local) — resume protocol below

**Stop evidence:** `factory.mjs stop --all --reason "operator directive: full stop,
continue later"` — engine epic=1 pid 26996 braked (2 stale engine pids already dead),
2 worker executions fenced (1 with workplace rewind), 0 workers running after,
lifecycle 2 `paused` @ solution-development, controls `engine_state='stopped'`,
checkpoint captured to `.factory-sandboxes/devtest-db/.factory-checkpoints/latest-1-all`.
Watchdog (12h sampler) killed by the operator session.

**Desk state at stop:** 4 done/terminal, 4 in_progress/queued, 1 in_progress/repair_wait
(kernel-owned — the engine drives it on resume), 1 todo/idle. Tasks 34–45: 10 done
(shared-core-foundation merged as `db3fe758`), 2 stopped mid-flight (task 29, 30).
Product `dev`: 8 commits above the formalization base `9355b06a`.

**Resume protocol (from here, per the runbook):**

```bash
cd D:/Development/saga-mcp-ELITE9
node scripts/factory.mjs unpark .factory-sandboxes/devtest-db/factory.sqlite --project 1
SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp-ELITE9/tools/agent-proxy/claude-shim.mjs" \
SAGA_CLAUDE_PATH="node D:/Development/saga-mcp-ELITE9/tools/agent-proxy/claude-shim.mjs" \
SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1 SAGA_FACTORY_CONCURRENCY=8 \
node scripts/factory.mjs resume .factory-sandboxes/devtest-db/factory.sqlite
# then watchdog (step 7 of the runbook)
```

## (historical) Launch status — RUNNING (observation only)

| Field | Value |
|---|---|
| Engine | pid 26996, launch `launch-cdc27a79-94bf-4931-b4fd-f5f0b64d8303`, log `Temp/saga-engine-1-2026-08-24T06-24-46.229Z.log` |
| DB | `.factory-sandboxes/devtest-db/factory.sqlite` (child lifecycle 2) |
| Product tree | `.factory-sandboxes/devtest/product` (branch `dev` @ `9355b06a` = capsule base) |
| Capsule | `c4f9f7ace610…284` (factory.development-case.v1, 16 ACs, conservation machinery satisfied) |
| Controls | engine running, concurrency 8, model zai/glm-4.6, model_concurrency_limit 2 |
| First card | task 34 `shared-core-foundation` — dispatched 06:24:52Z, worker executing via opencode shim |
| Watchdog | live, 60s samples → `.factory-sandboxes/devtest-logs/watchdog.jsonl`, stagnation 45m, max 12h |

First-card verification evidence (worker log
`board-runs/board-1-26996-*/task-34-*.jsonl`):
`[runner] spawn: claudePath="node …/tools/agent-proxy/claude-shim.mjs"` →
`[agent-proxy] opencode backend, model=zai-coding-plan/glm-4.6` — OPENCODE ONLY
honored. Prompt 71443 bytes (taskProjection 46850 — the G1.9 budget shape holds).

## Why task 34 is `shared-core-foundation` again

The parent (Elite-9 run 1) died on this exact card
(IMPLEMENTATION_CLAIM_NARROWED 3/3 → workplace terminal-failed, 8 dependents
invisible → empty-queue streak exit). The child consumed the frozen capsule,
replay-certified the inherited prefix (14 already-certified candidate sets:
discovery + formalization), rebuilt the development task graph, and re-runs the
same first card from the capsule base `9355b06a`. This run is therefore a
direct A/B probe of the parent's failure under the fixed engine
(`wait-nonterminal-work` streak guard, commit `a9a3f289`).

## Entry-point runbook (the standing recipe)

One-time golden freeze (DONE — source of truth):
`.factory-sandboxes/elite9-db/` is FROZEN. Contains the capsule
(`c4f9f7ace610…`), `package-store/` (content-addressed module bytes), and the
product tree pointer. Never run against it; copy from it.

Per run (C2 — capsule-hash-pinned redevelop):

```bash
cd D:/Development/saga-mcp-ELITE9

# 1. Copy the golden DB (awaited backup, never a mid-write file copy)
node -e "(async()=>{const D=require('better-sqlite3');const s=new D('.factory-sandboxes/elite9-db/factory.sqlite');const t=new D('.factory-sandboxes/<run>-db/factory.sqlite');await t.backup(s);t.close();s.close();})()"

# 2. Copy the package-store — MANDATORY. The engine derives
#    SAGA_PACKAGE_STORE_DIR from <db-dir>/package-store; a missing store
#    makes every active installation verify as CORRUPT at startup
#    (learned the hard way, see Pitfalls).
cp -r .factory-sandboxes/elite9-db/package-store .factory-sandboxes/<run>-db/package-store

# 3. Copy the product tree (with .git) and retarget the repo pointer.
#    Use FORWARD slashes in the UPDATE — see Pitfalls (MSYS).
cp -r .factory-sandboxes/elite9/product .factory-sandboxes/<run>/product
node -e "…UPDATE project_repositories SET local_path='D:/Development/saga-mcp-ELITE9/.factory-sandboxes/<run>/product' WHERE id=1…"

# 4. Shape the parent terminal (abandon keeps current_stage_id — accepted
#    by both guard branches) and verify the capsule WITHOUT touching the DB:
node scripts/factory.mjs abandon .factory-sandboxes/<run>-db/factory.sqlite 1 --reason "devtest: shape paused parent for capsule redevelop"
node scripts/factory.mjs redevelop .factory-sandboxes/<run>-db/factory.sqlite --from-lifecycle 1 --check

# 5. Launch (env INLINE on the spawning command — the detached engine
#    inherits process.env; env from a previous shell call does NOT persist):
SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp-ELITE9/tools/agent-proxy/claude-shim.mjs" \
SAGA_CLAUDE_PATH="node D:/Development/saga-mcp-ELITE9/tools/agent-proxy/claude-shim.mjs" \
SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1 SAGA_FACTORY_CONCURRENCY=8 \
node scripts/factory.mjs redevelop .factory-sandboxes/<run>-db/factory.sqlite --from-lifecycle 1

# 6. If the engine dies and the DB is fine: same env + `factory.mjs resume`
#    (reuses/requests the launch and re-stamps concurrency).
# 7. Watchdog:
node tools/run-watchdog.mjs --db .factory-sandboxes/<run>-db/factory.sqlite \
  --out .factory-sandboxes/<run>-logs --journal .factory-sandboxes/<run>-db/factory-run-journal.jsonl \
  --interval-seconds 60 --stagnation-minutes 45 \
  --settings-sha 2d6176e8d1382fe1a05791892840aa3a4f023ab87157ecaa13d1bc3a5545c6d0 --max-hours 12
```

Capsule pins for this golden: build `d4a19d51`, module `solution-development@1.4.4`,
base commit `9355b06a`. Capsule staleness risk: `resume` re-runs the stage with the
CURRENT dist against the frozen capsule; only `redevelop` re-checks the schema id.
Pin the golden to its build sha; `redevelop --check` re-verifies cheaply.

## Pitfalls found while building this entry (all cost real minutes today)

1. **package-store is per-DB by design.** `factory-engine-spawn.mjs`:
   `SAGA_PACKAGE_STORE_DIR ?? <db-dir>/package-store`. The first engine start
   on a copied DB without the store died with
   `MODULE_INSTALLATION_CORRUPT` (installation 1 marked corrupt, fail-fast)
   BEFORE any stage work. The store is content-addressed, so copying it is
   safe and sufficient. The dying engine's markCorrupt self-heals: the next
   start re-installs cleanly.
2. **MSYS eats backslashes in `node -e` strings.** A retarget UPDATE written
   with `'D:\\Development\\…'` through bash landed as
   `D:Developmentsaga…` (no separators) in the DB → `spawnSync git ENOENT`
   inside redevelop's base-commit probe. Write paths with FORWARD slashes in
   SQL/JS strings — node and git accept them on Windows.
3. **`concurrency=2` in the engine startup line is NOT the worker limit.**
   It mirrors `model_concurrency_limit`; the true worker concurrency is the
   controls row (here 8). Verified against the healthy Elite-9 engine log
   which printed the same `concurrency=2` at controls 8/8.

## Fixes riding this run (commit a9a3f289, build verified in dist)

- **ADR-047 Decision 5 enforced** (`orchestrate-cli.ts`): while
  non-terminal stage workplaces exist that are merely not claimable this
  cycle (`otherNonTerminalCount > 0`), the empty-queue streak is reset and
  the engine waits (`wait-nonterminal-work`). The parent died precisely
  because this invariant was computed but never read.
- **Redevelop parent guard accepts the post-GAP-2 failed shape**:
  `status='completed' + terminal_status='failed'` with the failing stage in
  the last `factory_stage_runs` row, in addition to the legacy
  `status='failed' + current_stage_id` shape.

## Open observations (no action unless they fire)

- `priorDeaths=23` appeared in task 34's prompt-budget line though the task is
  brand new — likely inherited death-count noise from the copied DB; watch
  whether it leaks into prompts (`currentFeedback=0` — clean so far).
- Engine restart after the corrupt-package death requested a NEW launch
  (`launch-cdc27a79`); the old launch `7f290bd7` was already terminal — no
  orphaned-launch recovery was needed.

## Timeline (UTC)

- 06:20:34 first engine start (redevelop spawn, pid 25380) — died in ~1s:
  package-store missing at `<db-dir>` (Pitfall 1), installation 1 marked corrupt.
- 06:21–06:23 package-store copied; verify reproduced manually; root cause
  pinned in `factory-engine-spawn.mjs` env assembly.
- 06:24:46 engine restarted via `resume` (pid 26996, launch `cdc27a79`).
- 06:24:50 task 34 `shared-core-foundation` created; 06:24:52 worker dispatched
  (execution `0ea8b9a8…`, pid 28832, opencode shim confirmed in worker log).
- 06:28:28 watchdog live.
