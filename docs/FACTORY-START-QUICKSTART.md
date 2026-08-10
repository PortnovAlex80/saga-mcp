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

Under the current `product-build@1.0.0` lifecycle, the factory terminates at:

| Stage | Success outcome | Lifecycle terminal status |
|-------|----------------|--------------------------|
| Discovery | `go` | (transitions to Formalization) |
| Formalization | `formalized` | (transitions to Development) |
| Development | `verified` | **`verified-local`** |

The factory reaches `lifecycle_run.status=completed`, `terminal_status=verified-local`.

**Delivery is a separate DevOps request**, not part of `product-build@1.0.0`.
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
