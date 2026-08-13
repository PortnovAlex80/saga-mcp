# Saga4 Factory — canonical launch quickstart

This is the short operator instruction for a real Saga4 Factory run. The
author/reviewer workers use the configured real Claude/GLM route. This is not a
mock or hybrid run.

---

## 0. LLM-free development loop (primary TDD)

Before touching a real LLM, use the deterministic Factory Contract tests. These
run the **real factory** (orchestrate-cli, dispatcher, gates, CandidateSets,
lifecycle routing) with scripted workers replacing only the LLM inference layer.
No Claude, no GLM, no network — purely deterministic, ~25 seconds per full
lifecycle.

```bash
# Build TypeScript first
npm run build

# Run all 75 Factory Contract tests (72 unit + 3 E2E, ~45 seconds total)
npm run test:factory-contract

# Run just the transition conformance E2E (reject→repair→accept, ~25 seconds)
SAGA_SCENARIOS="./tests/factory-contract/transition-conformance-scenarios.mjs" \
  node --test tests/factory-contract/golden-path.test.mjs

# Run just the parallel git-desk E2E (concurrency=2, ~22 seconds)
SAGA_SCENARIOS="./tests/factory-contract/golden-path-scenarios.mjs" \
  node --test tests/factory-contract/parallel-git-desk.test.mjs
```

This is the **primary TDD loop** for Factory development. If a production change
breaks the Factory Contract tests, fix it before touching an LLM.

Design documents for every workshop, gate, and mechanism are in
`tests/factory-contract/design/` (10 files, 10,626 lines of code-quoted
architecture analysis).

### 0a. Temporal conformance (ADR-048, L5)

Above the Factory Contract tests sits the **temporal conformance** layer.
It uses the same real production composition but adds fault schedules at
every durable boundary (product submission, CandidateSet seal, GateDecision,
EffectReceipt, ProcessRun settlement, lifecycle routing) and a read-only
liveness explainer that classifies every snapshot as `progressing`,
`waiting_expected`, `stalled`, `inconsistent_state`, or `terminal`.

```bash
# Run all temporal conformance tests (scripted workers, 0 LLM tokens)
npm run test:factory-temporal

# Run just the foundation full-lifecycle test (~25 seconds)
node --test --test-name-pattern="full product-build lifecycle" \
  tests/factory-temporal/foundation.test.mjs

# Run just the fast fingerprint/liveness/allowlist tests (<1 second)
node --test --test-name-pattern="fingerprint|liveness|allowlist" \
  tests/factory-temporal/foundation.test.mjs
```

The temporal layer catches the class of bugs the contract tests cannot:
**legal local states that stop making composed Factory progress** (Sign 015).
Every nonterminal scope must have a live owner, runnable command, typed wait,
or pending transition obligation — otherwise it is a typed stall.

A canonical composition fingerprint detects production/test drift, and a
strict overlay allowlist rejects test compositions that replace lifecycle
routing, settlement, gates, effects, or repositories.

---

## 1. Build

```bash
npm run build
```

## 1a. Preflight: the saga MCP server must boot (npm install is not optional)

Every worker spawns `node dist/index.js` as its private stdio MCP child
(`--mcp-config` + `--strict-mcp-config`). If that server cannot boot, the
worker silently loses ALL saga tools: it sees only Bash/Read/Edit, then burns
its whole budget reverse-engineering how to call `product_submit` and dies
without a submission. The client's MCP panel shows the same failure as
`MCP error -32000: Connection closed` / `0 tools`.

`node_modules` is NOT updated by `git pull` — a newly added dependency kills
every server boot with `ERR_MODULE_NOT_FOUND: Cannot find package
'@modelcontextprotocol/sdk'` (exactly this happened on 2026-08-13: three
workers died to it while the tracker and the engine kept running fine, because
only `dist/index.js` imports the SDK). Client-installed skills drift the same
way — `git pull` does not touch `~/.zcode/skills/`.

```bash
npm install && npm run build
cp -r skills/* ~/.zcode/skills/     # sync operator skills (restart the client session after)

# smoke: must print the banner and stay alive (Ctrl+C to stop), no ERR_MODULE_NOT_FOUND
DB_PATH=<db> TRACKER_AUTOSTART=0 DOCS_GRAPH_AUTOSTART=0 node dist/index.js
```

Log symptom chain for diagnosing a running incident: worker JSONL contains
zero `mcp__saga__*` tool_use entries plus thinking like "in my current
toolset, I only have Bash, Read, Edit". Fix deps, then requeue the workplace —
do not let the worker exhaust its attempts against a dead MCP child.

## 2. Single entry point

**One command, one gateway.** `scripts/factory.mjs` is the only public CLI:

```bash
node scripts/factory.mjs start  <db-path> <idea-text> [--model <name>] [--sandbox <dir>]
node scripts/factory.mjs resume <db-path> [--requeue-paused|--recover-failed-gate]
node scripts/factory.mjs continue <db-path> --from-lifecycle <id> [options]
```

No manual launch rows, no SQL, no HTTP. `factory.mjs` owns the launch state
machine: `requested → claimed → running → completed|failed`.

## 3. Composition and runtime controls

`factory.mjs` uses the canonical production composition at
`tracker-view/product-delivery-composition.mjs`. The composition wires
infrastructure providers; it does not replace the LLM worker. Set
`SAGA_PRODUCT_LIFECYCLE_COMPOSITION` only to intentionally override it.

```bash
# Optional runtime controls
export SAGA_FACTORY_CONCURRENCY=2       # parallel development workers
export SAGA_FACTORY_CHECKPOINT_LOGS=1   # checkpoint logging
export SAGA_CLAUDE_PATH=/path/to/claude # worker CLI binary
```

The tracker composition is a safe local-dry-run Delivery profile. Discovery,
Formalization and Development use real LLM workers. Delivery never fabricates a
publication or release receipt; it fails closed or requests approval.

## 4. Start a new isolated Factory

Use a fresh sandbox path. `factory.mjs` provisions the Git repository, project,
epic, Factory Order and durable launch request.

```bash
node scripts/factory.mjs start .factory-sandboxes/my-run/factory.sqlite \
  'Build an accessible single-page counter with keyboard support and local persistence.' \
  --model glm-4.7 \
  --sandbox .factory-sandboxes/my-run
```

For a new run on an existing Project, omit `--sandbox` and point at its DB. Do
not write launch rows manually and do not reset production tables.

**Keep the DB outside the `--sandbox` root.** `factory.mjs start --sandbox`
wipes the sandbox directory (`rmSync`) before provisioning. If the SQLite file
— or any open handle to it, e.g. a running tracker-view — lives inside that
root, provisioning fails (EBUSY on Windows). Use a sibling directory:

```text
.factory-sandboxes/<run>-db/factory.sqlite   ← DB + checkpoints (never wiped)
.factory-sandboxes/<run>/                    ← sandbox root (wiped each start)
```

A tracker-view bound to the DB may keep running across provisioning; WAL
allows the concurrent access.

## 4a. Resume from a checkpoint (skip completed stages, save LLM tokens)

When the same project was already partially run (e.g. Discovery + Formalization
completed, Development crashed), you can restore from a golden snapshot and
**only re-run the failed stage**. This saves 100% of LLM tokens for the
completed stages — no re-generation of PRD, SRS, UC, AC, or architecture.

### Create a golden snapshot (one-time, after a successful or partial run)

```bash
# Checkpoint the DB (merge WAL into a single file)
node -e "
  const db = new (require('better-sqlite3'))('.factory-sandboxes/my-run/factory.sqlite');
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
"

# Copy DB + product repo to golden directory
mkdir -p tests/golden-runs/my-run-$(date +%Y%m%d)
cp .factory-sandboxes/my-run/factory.sqlite tests/golden-runs/my-run-$(date +%Y%m%d)/golden.sqlite
cp -r .factory-sandboxes/my-run/product tests/golden-runs/my-run-$(date +%Y%m%d)/product-repo
```

### Restore from checkpoint and resume only the failed stage

```bash
# 1. Restore: copy golden DB, fix stuck state, reset failed ProcessRuns
node scripts/restore-from-checkpoint.mjs \
  tests/golden-runs/my-run-20260812/golden.sqlite \
  .factory-sandboxes/dev-run-002/factory.sqlite \
  --fix-stuck

# 2. Copy the product repo (code + git history + docs)
cp -r tests/golden-runs/my-run-20260812/product-repo .factory-sandboxes/dev-run-002/product

# 3. Resume — factory continues at the paused stage, skips completed stages
node scripts/factory.mjs resume .factory-sandboxes/dev-run-002/factory.sqlite
```

### What gets restored vs what gets re-run

| Stage | Status after restore | LLM tokens |
|-------|---------------------|------------|
| Discovery | `completed` (from snapshot) | **0** — artifacts in DB |
| Formalization | `completed` (from snapshot) | **0** — artifacts in DB |
| Development | `paused` → resumed with real GLM-4.7 | only for remaining tasks |

### Options for `restore-from-checkpoint.mjs`

```bash
# Fix only stuck workplaces (keep all completed work):
node scripts/restore-from-checkpoint.mjs golden.sqlite target.sqlite --fix-stuck

# Reset an entire stage (re-run ALL tasks in that stage from scratch):
node scripts/restore-from-checkpoint.mjs golden.sqlite target.sqlite --reset-stage solution-development
```

### When to use checkpoint restore

- **Factory crashed mid-stage** — restore + fix-stuck + resume (1 command)
- **Code fix shipped, need to re-test** — restore + reset-stage + resume
- **Regression test material** — golden snapshot + product code = reproducible fixtures
- **Same project, different model** — restore formalization, re-run development with new model

## 4b. Run on a local model (LM Studio)

The factory spawns Claude Code CLI workers; a local model must speak the
Anthropic protocol (`/v1/messages`). LM Studio does; raw Ollama/llama.cpp do
not (they would need a translation proxy). `--model` on `factory.mjs` only
accepts the checked-in cloud catalog (`glm-4.7`, `glm-5-turbo`, `glm-5.2`) —
local models are selected at runtime via the board's model selector.

**Prerequisite: the model must accept mid-conversation system messages.**
Claude Code sends system messages after tool results; several local models'
Jinja chat templates raise `System message must be at the beginning.` on that.
The failure is silent in the LM Studio GUI (server-side render error before
inference) — the worker JSONL log shows 10× `api_retry error_status 500` and
then exit code 1. For Qwen 3.6 the patch procedure (and why patching hub
`model.yaml` is not enough for some quants — the template is GGUF-embedded)
is in [`CLAUDE.md`](../CLAUDE.md) → "LM Studio: Qwen 3.6 chat template patch".
Verify before starting a run:

```bash
curl -s http://localhost:1234/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"<id>","max_tokens":16,"messages":[{"role":"user","content":"hi"},{"role":"system","content":"mid"},{"role":"user","content":"reply ok"}]}'
# must return 200 with text, not a 500 Jinja exception
```

Also check the loaded context length (`lms ps`): a factory worker session can
easily consume 100K+ input tokens; a model loaded with a small context will
fail late and slowly.

Verified sequence for a NEW sandbox run on a local model:

```bash
# 1. LM Studio: load the model, Developer → Start Server (:1234).

# 2. Start tracker-view FIRST (DB outside the sandbox root), warm the probe:
DB_PATH=$PWD/.factory-sandboxes/<run>-db/factory.sqlite PORT=4321 \
SAGA_PRODUCT_LIFECYCLE_COMPOSITION=$PWD/tracker-view/product-delivery-composition.mjs \
SAGA_FACTORY_CHECKPOINT_STORE=$PWD/.factory-sandboxes/<run>-db/checkpoints \
SAGA_FACTORY_CHECKPOINT_LOGS=1 \
node tracker-view/tracker-view.mjs
curl -s http://localhost:4321/api/lmstudio/models   # must list your model

# 3. Start the factory (writes the CLOUD profile — see the race below):
node scripts/factory.mjs start .factory-sandboxes/<run>-db/factory.sqlite \
  '<idea text>' --model glm-4.7 --sandbox .factory-sandboxes/<run>

# 4. Flip to the local model ASAP (epic_id=1 in a fresh sandbox):
curl -X POST http://localhost:4321/api/model/set \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen/qwen3.6-35b-a3b","epic_id":1}'

# 5. Verify: the worker process must be
#    claude -p --bare --model qwen/qwen3.6-35b-a3b   (no --effort)
```

**The first-claim race.** The engine spawns immediately after `start` and may
freeze the first worker's model route on the cloud profile before step 4
lands. If it does, do NOT reach for recovery flags:

```bash
# 1. Kill the cloud worker (claude ... --bare) and the orchestrate-cli node.
# 2. Plain resume — no flags. It adopts the active launch, supervision reaps
#    the lost worker (REAPED ... action=lost), and the same task re-claims
#    on the local model:
node scripts/factory.mjs resume <db>
```

`--recover-orphaned-launch` is NOT the tool here: it requires the worker to be
already detected `lost` with the workplace in `repair_wait` — a plain resume
is what drives the state there. Resume runs have no race at all: the controls
row is already local.

**If the workplace lands in human-pause** (`blocked` + `loop_state=paused`
after repeated lost workers; the engine logs `N workplace(s) require explicit
resume` and plain resume just stops): `--requeue-paused` only fits nodes with
a required submission validator, `--recover-orphaned-launch` only fits an
already-detected `lost` worker. The platform primitive both of them wrap is
`ConveyorRuntime.resumeFromHuman({workplaceRef, taskId, role})` (see
`src/application/conveyor-runtime.ts`); it requeues the same workplace with
revision+1 inside one transaction. Used as the documented last resort in the
2026-08-13 mars-ballistic incident (`ЖУРНАЛ-ЗАПУСКОВ.md`) after the root
cause (broken local-model endpoint) was fixed. Fix the cause first — resuming
into a broken endpoint just burns another worker attempt.

Side effect of step 4: `~/.claude/settings.json` is switched to the LM Studio
template, so ALL claude usage on the machine routes locally until you pick a
"Z.ai (облако)" model in the same selector (cloud token is frozen in
`settings.cloud.json`). Concurrency for local models defaults to 4
(`LMSTUDIO_DEFAULT_LIMIT`); effective concurrency stays
`min(SAGA_FACTORY_CONCURRENCY, limit)`.

## 5. Observe the correct database

`factory.mjs` starts the engine, not the tracker UI. Start a tracker against the
same DB on a free port:

```bash
export DB_PATH=$(realpath .factory-sandboxes/my-run/factory.sqlite)
export PORT=4331
node tracker-view/tracker-view.mjs
```

Open: `http://localhost:4331/?project=1`

Never assume that `localhost:4321` points at the current run. Verify the page
title/DB identity and the database path.

## 6. Terminal states (ADR-045)

Under the current `product-build@1.1.0` lifecycle, the factory terminates at:

| Stage | Success outcome | Lifecycle terminal status |
|-------|----------------|--------------------------|
| Discovery | `go` | (transitions to Formalization) |
| Formalization | `formalized` | (transitions to Development) |
| Development | `verified` | **`runnable-local`** |

The factory reaches `lifecycle_run.status=completed`, `terminal_status=runnable-local`.

**Delivery is a separate DevOps request**, not part of `product-build@1.1.0`.
To run Delivery after Development succeeds, use the `continue` command with
`--local-release` or a release-specific composition.

## 7. What healthy progress looks like

Between worker cycles, `LifecycleRun.status=paused` can mean a durable wait, not
a stopped factory. Check all of these together:

- active WorkerExecution has a fresh heartbeat and progress timestamp;
- its lease is valid and `stuck_state=active`;
- the current Workplace is `in_progress/running` or `review_in_progress/running`;
- author completion creates a CandidateSet, then a GateDecision is evaluated;
- reviewer work is a separate fenced execution;
- only final acceptance creates a ReplayCapsule.

## 7a. Monitor every minute (polling cadence + report format)

While the factory runs, **poll once per 60 seconds**. Do not sleep 3–5 minutes
between checks — a worker can finish, a gate can crash, or a cell can stall in
the gap, and you want to catch the transition at the minute it happens.

Each poll reads two things:

1. the last ~15 lines of the orchestrate-cli log (cycle/stage/dispatch events);
2. the task + artifact status from the live DB.

A one-shot poll script (uses the run's DB path):

```bash
node -e '
  const D = require("better-sqlite3");
  const db = new D(process.argv[1], {readonly:true});
  for (const t of db.prepare("SELECT id,status,workflow_stage,title FROM tasks ORDER BY id").all())
    console.log(`  #${t.id} [${t.status.padEnd(12)}] ${t.workflow_stage.padEnd(12)} ${t.title.slice(0,48)}`);
  const ac = db.prepare("SELECT status,count(*) n FROM artifacts GROUP BY status").all();
  console.log("  artifacts:", ac.map(a=>`${a.status}=x${a.n}`).join(" "));
  db.close();
' .factory-sandboxes/<run>/factory.sqlite
```

### Report format — the pipeline chain

Report status to the operator in this exact pipeline-chain form so the whole
chain is visible at a glance. Use the four glyphs `✅ done · 🔄 running · ⬚ idle · ✖ failed`,
and annotate each stage with the active node:

```
Discovery      ✅
Formalization  🔄  product-contract ✅ | use-cases 🔄
Planning       ⬚
Development    ⬚
Verification   ⬚
Delivery       ⬚
```

Rules:

- A stage is `✅` only when its terminal ProcessModule outcome is sealed (all its
  tasks `done`, its artifacts `accepted`). A stage with one `done` node and one
  `in_progress` node is still `🔄`, not `✅`.
- Name the active formalization/development node next to the spinner so the
  operator sees which sub-cell is running (e.g. `use-cases 🔄`).
- On any `failed`/`repair_required`/crash line in the log, flip the stage to `✖`
  and quote the exact error code (`FORMALIZATION_ACCEPTANCE_PRODUCT_REF_INVALID`,
  `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH`, …) — do not paraphrase.
- Keep the report short. The chain is the headline; one or two lines of detail
  underneath, no prose essays.

## 8. Inter-stage validation checklist

After Discovery, verify the next ProcessRun input contains the exact certificate
ref and hash. After Formalization, verify the exact Solution Contract and frozen
acceptance baseline. Before Development, verify the repository base commit and
package installation pin.

Products are content-addressed. Consumers must use exact ProductRefs, not
`latest` task output.

## 9. Replay capsules

Capsules are created only from a final accepted CellFinalAcceptance. A worker
exit or a raw `accepted` check is insufficient. Reviewed cells should produce
separate author and reviewer capsules. Replay creates new current CandidateSets
and gates; it never restores old Workplace state or external-effect receipts.

## 10. Resume

For an interrupted run, use the canonical resume command against the same DB:

```bash
node scripts/factory.mjs resume $db
```

Resume continues the same LifecycleRun. An intentional new start creates new
run identities and may reuse semantically compatible replay capsules.

Set `SAGA_FACTORY_CONCURRENCY` before both `start` and `resume`. The runtime
uses the durable operator value capped by the canonical model profile and
counts all durable active executions before each new assignment.

If incident triage proves that the current Workplace is `blocked/paused`
because submission-preflight rejections exhausted the worker-attempt budget,
use the explicit one-attempt recovery directive:

```bash
node scripts/factory.mjs resume $db --requeue-paused
```

If a run failed after CandidateSet sealing only because the pinned check plan
and runtime provider versions differ, use:

```bash
node scripts/factory.mjs resume $db --recover-failed-gate
```

The two recovery flags are mutually exclusive. Both are narrow, evidence-based,
and refuse already-completed/gated work.

### Continue after a terminal failure

```bash
# Verify first (no live authorization)
node scripts/factory.mjs continue $db --from-lifecycle 1 \
  --adopt-task 15 --scope index.html --scope js/app.js --scope css/styles.css \
  --check

# Verification-only continuation (after candidate freeze)
node scripts/factory.mjs continue $db \
  --from-lifecycle <latest-terminal-leaf> --verification-only --check
```

`--check` uses a SQLite backup and consumes no live authorization. The real
command is identical without `--check`.

## 11. Evidence files

For an observed run, keep a stage report and bug list beside its isolated DB:

- `FACTORY-RUN-REPORT.md` — stage outcomes and exact handoffs;
- `FACTORY-BUGS.md` — runtime, UI and documentation defects.

Do not silently edit worker instructions or reset the DB while a run is active.

## 12. If the factory appears stopped

Treat it as an incident when all of the following are true:

- LifecycleRun is `paused` at the same node;
- the Workplace is `blocked/paused` or `repair_wait`;
- no WorkerExecution has a live lease;
- the projected task has no `current_execution_id`;
- no new CandidateSet/GateDecision appears across several host cycles.

Preserve the DB, worker JSONL logs, execution workspaces, and latest checkpoint.
Do not immediately resume: first identify the last rejected MCP call and check
whether a durable RecoveryIssue/RecoveryCase and feedback file were created.
If the only durable error is "exited without terminal worker_done", inspect the
worker log for an earlier rejected `worker_done`; otherwise a domain validation
failure may have been collapsed into a generic lost-worker state.
