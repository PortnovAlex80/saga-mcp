# 08 — Existing Scripted Harness Gap Analysis

> **Historical pre-ADR-067 terminology:** source-mode branches documented below
> are retired. ADR-067's single frozen execution→WorkIntent ProductRef ingress is
> the normative implementation and test boundary.

Complete audit of the existing `tests/factory-contract/` scripted harness: what
exists, how it works, what passes, what fails, what is not faithfully reproduced
vs the production Factory runtime, and what must change.

All file paths are absolute under `D:/Development/saga-mcp/`. Findings are backed
by reading every file in the directory and running every test.

---

## 1. Architecture Overview

### 1.1 Component graph

```
┌─────────────────────────────────────────────────────────────────────┐
│ TEST FILE (*.test.mjs)                                              │
│  setupFreshDb() → requestFactoryLaunch() → runOrchestrateCli()     │
│  asserts on the resulting DB state                                  │
└───────────────┬─────────────────────────────────────────────────────┘
                │ spawns: node dist/orchestrate-cli.js --launch-ref=…
                │ env: SAGA_PRODUCT_LIFECYCLE_COMPOSITION, SAGA_SCENARIOS,
                │      SAGA_INVOCATION_LOG, DB_PATH, SAGA_BUTTON_REPO_PATH
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ orchestrate-cli.js (PRODUCTION — unchanged)                         │
│  loadCompositionOverrides() ──► scenario-composition.mjs            │
│  createFactoryApplication()                                         │
│  main loop: runEpisode() → distributeQueuedTasks() → repeat         │
└───────────────┬─────────────────────────────────────────────────────┘
                │ WorkerExecutorFactory replaced by composition override
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ scenario-composition.mjs                                            │
│  createProductLifecycleComposition() returns:                       │
│    workerExecutorFactory: createScriptedWorkerExecutorFactory()     │
│    resolveWorkerContext(ctx)                                        │
│    development: { ReferenceSettlementPolicy, ReferenceTaskGraph… }  │
│    delivery: { preflight, actionProviders.deployment, observe… }    │
│  AUTHORITY (gates, CandidateSets, lifecycle routing) = PRODUCTION   │
└───────────────┬─────────────────────────────────────────────────────┘
                │ per task assignment
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ scenario-scripted-executor.mjs                                      │
│  createScriptedWorkerExecutorFactory()(context) → executor object   │
│  start(command):                                                    │
│    1. hasFrozenCapsule? → runCapsuleReplay() in-process, return     │
│    2. provisionScriptedDesk() — per-task git worktree (PRODUCTION   │
│       RepositoryDeskProvisioner)                                    │
│    3. write MCP config (stdio saga server)                          │
│    4. spawn node scenario-dispatcher.mjs -p --bare --mcp-config …   │
│    5. markExecutionRunning()                                        │
│    6. on child close → finalizeManagedWorkerProcess() (PRODUCTION   │
│       finalizer — same as claude executor)                          │
└───────────────┬─────────────────────────────────────────────────────┘
                │ spawn
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ scenario-dispatcher.mjs                                             │
│  reads SAGA_SCENARIOS → dynamic import scenarios module             │
│  reads stdin prompt (project_id, task_id, worker_id, execution_id)  │
│  reads SAGA_DESK_* env → builds desk + repoPath                     │
│  calls runScenarioWorker()                                          │
└───────────────┬─────────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ scenario-engine.mjs                                                 │
│  McpClient (real JSON-RPC stdio to saga server)                     │
│  scenarioKey(task) → module/node/role/workKey/taskKind              │
│  scenarioKeyString → lookup handler in scenarios map                │
│  handler({ client, task, key, prompt, attempt, repoPath, desk, … }) │
│  actions.* helpers (submitProduct, createArtifact, done, …)         │
└───────────────┬─────────────────────────────────────────────────────┘
                │ MCP JSON-RPC (tools/call)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ dist/index.js (PRODUCTION saga MCP server — unchanged)              │
│  product_submit, artifact_create, trace_add, worker_done,           │
│  candidate_read, product_read, task_get, artifact_list, …           │
│  All authority: ConveyorRuntime, GateRun, CandidateSet sealing,     │
│  lifecycle routing — PRODUCTION implementations                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Key design principle

The harness replaces ONLY the worker inference layer. Everything else — Factory
authority, Gates, CandidateSets, lifecycle routing, the orchestrate-cli main
loop, the worker-process finalizer, the dispatch loop — is the **production code
path**. The scripted executor even imports and calls the same
`finalizeManagedWorkerProcess`, `markExecutionRunning`, `RepositoryDeskProvisioner`,
`executeCapsuleReplay`, and MCP handler containers that the real claude executor
uses. This is the harness's central strength: it tests the real Factory physics
with deterministic worker scripts.

### 1.3 File inventory (20 files)

| File | Role | Lines |
|---|---|---|
| `scenario-engine.mjs` | Core: McpClient, scenarioKey, runScenarioWorker, actions helpers | 280 |
| `scenario-scripted-executor.mjs` | WorkerExecutorFactory substitute (spawns dispatcher, provisions desk, finalizes) | 431 |
| `scenario-dispatcher.mjs` | Child process: loads scenarios, parses prompt, runs one scenario worker | 134 |
| `scenario-composition.mjs` | Composition override: wires scripted executor + delivery providers | 138 |
| `golden-path-scenarios.mjs` | Handler map for the full Discovery→Delivery golden path | 421 |
| `crash-scenarios.mjs` | Handler map for crash-recovery (spreads golden-path, overrides discovery-proposal) | 96 |
| `golden-path.test.mjs` | E2E: cold idea → released, then replay → released (2 runs) | 309 |
| `parallel-git-desk.test.mjs` | E2E: concurrency=2, two impl items, worktree isolation | 255 |
| `crash-recovery.test.mjs` | E2E: worker exits without worker_done, factory requeues | 155 |
| `srs-d2-parser.test.mjs` | Unit: SRS §D2 stanza parser + §12 decision log checker | 157 |
| `candidate-set-gate-invariants.test.mjs` | Unit: CandidateSet idempotent seal, replay mismatch, CAS, append-only gate | 199 |
| `lifecycle-outcome-routes.test.mjs` | Unit: lifecycle outcome routing matrix | 142 |
| `production-cell-transitions.test.mjs` | Unit: production-cell state machine reducer (T01–T12) | 162 |
| `stale-fencing.test.mjs` | Unit: terminal execution states rejected by authority gateway | 45 |
| `gate-repair-target.test.mjs` | Unit: gate repair target routing (author vs reviewer) | 146 |
| `p18-cross-execution-durability.test.mjs` | Unit: P18 workplace-scoped durable production | 220 |
| `production-cell-recovery-feedback.test.mjs` | Unit: recovery-feedback projection | 234 |
| `orchestration-recovery-boundary.test.mjs` | Unit: supervision idle-state classification | 115 |
| `production-source-and-tracker-hook.test.mjs` | Unit: product_source activation + tracker hook | 127 |
| `recovery-replay-continuity.test.mjs` | Static-regex: recovery/replay structural invariants | 94 |

---

## 2. Scenario Format

### 2.1 Scenario map

A scenario module exports a plain object keyed by **scenario key string**:

```js
export const goldenPathScenarios = {
  [`${MODULE}/${NODE}/${ROLE}/${WORKKEY}`]: handlerFn,
  // wildcard on workKey:
  [`${DEV}/implement-work-items/author/*`]: developmentImplement,
  // global fallback:
  ['*']: someDefaultHandler,
};
```

The dispatcher loads whichever module path `SAGA_SCENARIOS` points to, and
falls back through `mod.scenarios || mod.goldenPathScenarios || mod.default`.

### 2.2 Scenario key derivation

`scenarioKey(task)` in `scenario-engine.mjs:113-125` derives the key from
**task metadata** (not from the task_kind or node_id directly):

```
module  = metadata.process_module_ref   (e.g. 'solution-development@1.1.0')
node    = metadata.process_node_id       (e.g. 'implement-work-items')
cell    = metadata.production_cell_id    (e.g. 'development-implementation')
role    = metadata.role                  ('author' | 'reviewer')
workKey = metadata.work_key || metadata.cell_input_item?.key || 'singleton'
```

`scenarioKeyString` formats this as `${module}/${node}/${role}/${workKey}`.

Handler lookup order (`scenario-engine.mjs:168-170`):
1. Exact: `${module}/${node}/${role}/${workKey}`
2. Wildcard workKey: `${module}/${node}/${role}/*`
3. Global: `*`

### 2.3 Handler interface

Every handler is `async ({ client, task, key, prompt, attempt, repoPath, desk, taskId, executionId, workerId })`:

| Field | Type | Source | Purpose |
|---|---|---|---|
| `client` | `McpClient` | scenario-engine | JSON-RPC client connected to the real saga MCP server (same stdio protocol a real worker uses) |
| `task` | object | `task_get` result | Full task row including `metadata` (string or object), `project_id`, `epic_id`, `task_kind`, `project_repository_id`, `verification_target_artifact_id` |
| `key` | object | `scenarioKey(task)` | `{ module, node, cell, role, workKey, taskKind }` |
| `prompt` | object | parsed stdin k=v | `{ project_id, task_id, worker_id, execution_id, role }` |
| `attempt` | number | invocation-log count + 1 | 1 on first invocation, 2+ on repair/retry — lets scenarios behave differently on re-attempts (used by crash-scenarios) |
| `repoPath` | string | `SAGA_DESK_EXECUTION_PATH \|\| SAGA_BUTTON_REPO_PATH \|\| '.'` | The working directory for file writes / git operations. When a desk is provisioned, this is the per-task worktree path. |
| `desk` | object \| null | `SAGA_DESK_*` env | `{ executionPath, branch, baseCommit, headCommit, integrationBranch, repositoryRoot, detached }` — null when no desk provisioned (non-git tasks) |
| `taskId` | number | `prompt.task_id` | Convenience: numeric task ID |
| `executionId` | string | `prompt.execution_id` | The fencing token — required for `worker_done` |
| `workerId` | string | `prompt.worker_id` | Worker identity |

### 2.4 What a handler can do

Via `actions.*` helpers (`scenario-engine.mjs:199-279`) or direct `client.callJson`:

- `actions.submitProduct(client, schema, content)` → `product_submit` (typed products)
- `actions.createArtifact(client, { … })` → `artifact_create` (+ optional file write for managed-production)
- `actions.addTrace(client, sourceId, targetId, linkType)` → `trace_add`
- `actions.findAcceptedArtifacts(client, epicId, type)` → `artifact_list` read
- `actions.readAuthorCandidate(client, workplaceRef)` → `candidate_read`
- `actions.done(client, taskId, workerId, executionId, result)` → `worker_done`
- `actions.writeFile(repoPath, filePath, content)` — raw file write
- `actions.exitWithoutDone()` — return without worker_done (crash simulation)
- `actions.exitWithFailure()` — throw (causes exit code 1)
- Direct `client.callJson('product_read', { schema_id, ref, digest })` — read frozen products
- Direct `client.callJson('artifact_get', { id })` — read artifact details
- Direct `git(repoPath, [...])` — shell out to git (used by `developmentImplement`)

### 2.5 What a handler CANNOT do (by design)

- Select its own work (no `worker_next` — the dispatch loop owns assignment)
- Directly mutate Factory authority tables (no DB writes)
- Call lifecycle/dispatcher internals
- Choose its own branch or worktree (the desk is pre-provisioned)

---

## 3. What WORKS (tests that PASS)

Ran the full suite. Results:

### 3.1 All 64 domain-level unit tests PASS

| Test file | Tests | Status |
|---|---|---|
| `srs-d2-parser.test.mjs` | 8 | PASS |
| `candidate-set-gate-invariants.test.mjs` | 4 | PASS |
| `lifecycle-outcome-routes.test.mjs` | 9 | PASS |
| `production-cell-transitions.test.mjs` | 15 | PASS |
| `stale-fencing.test.mjs` | 2 | PASS |
| `gate-repair-target.test.mjs` | 5 | PASS |
| `orchestration-recovery-boundary.test.mjs` | 4 | PASS |
| `production-source-and-tracker-hook.test.mjs` | 6 | PASS |
| `production-cell-recovery-feedback.test.mjs` | 4 | PASS |
| `p18-cross-execution-durability.test.mjs` | 4 | PASS |
| `recovery-replay-continuity.test.mjs` | 7 | PASS |

These tests exercise pure domain logic (reducers, repositories, parsers,
lifecycle definitions) directly — no orchestrate-cli, no scripted workers. They
are fast (sub-second total) and reliable.

### 3.2 Crash recovery E2E test PASSES

| Test | Status | Duration |
|---|---|---|
| `crash-recovery.test.mjs` — AC-28/T10 | PASS | ~4.7s |

This test proves the Factory's crash recovery works: a worker that submits a
product then exits without `worker_done` is detected, the execution is marked
`lost`, the Workplace transitions through `repair_wait`, and no executions are
left stranded. The crash scenario targets Discovery (typed-submission), which
correctly handles the re-attempt on the second invocation.

### 3.3 Scenario mechanics that work correctly

- **Scenario key derivation** — metadata-based keying is stable across runs
- **Handler dispatch** — exact, wildcard, and fallback resolution all work
- **McpClient** — JSON-RPC stdio protocol faithfully mirrors a real worker
- **product_submit** — typed products flow through the real product pipeline
- **artifact_create / trace_add** — managed-production artifacts persist durably (P18)
- **worker_done** — completes the worker protocol, triggers gate evaluation
- **Invocation logging** — `SAGA_INVOCATION_LOG` captures every scripted call for replay-zero assertions
- **Capsule replay** — `hasFrozenCapsule` → `runCapsuleReplay` replays captured capsules in-process with zero scripted calls (this path works; the golden-path Run B failure is downstream of the verification gate, not the replay mechanism itself)
- **Production finalizer** — `finalizeManagedWorkerProcess` correctly interprets exit codes and drives repair
- **GateDecision / CandidateSet sealing** — real authority runs correctly (proven by the unit tests)

---

## 4. What's BROKEN (tests that FAIL)

### 4.1 Golden-path test FAILS

```
✖ Golden Path: cold Idea -> released, then replay -> released with zero scripted calls
  AssertionError: solution-development status
    actual: 'paused'
    expected: 'completed'
```

**Run A** (cold inference) reaches `solution-development` but the ProcessRun
pauses at the `verify-acceptance` node instead of completing. The lifecycle
never reaches `released`. Run B (replay) is never reached because Run A fails
first.

### 4.2 Parallel-git-desk test FAILS

```
✖ Parallel git_change Production Cells: concurrency=2 worktree isolation
  AssertionError: Lifecycle did not reach released.
    error=ProcessRun 3 paused at node 'verify-acceptance' and can be resumed
    actual: 'paused/null'
    expected: 'completed/released'
```

Same root cause: the lifecycle pauses at `verify-acceptance`.

### 4.3 Root cause: the verification gate is unsatisfiable by the scripted harness

Both E2E tests fail at the **same node**: `verify-acceptance` in
`solution-development@1.1.0`. This is NOT a harness bug — it is a fundamental
design gap.

The verification check provider
(`dist/modules/development/application/development-check-providers.js:91-151`)
has this logic:

```js
// lines 139-144 (createDevelopmentVerificationCheckProvider):
// This provider validates the LM assessment contract and lineage. It
// is deliberately not an executable criterion oracle: an LM-authored
// `passed` cannot become Factory acceptance. Until an independent
// candidate-check receipt is present, every well-formed assessment is
// indeterminate and the plan stops the line without blaming the LM.
return 'unknown';
```

The provider ALWAYS returns `'unknown'` for any well-formed assessment — even
one with `outcome: 'passed'`. This is by design: an LM-authored "passed" cannot
become Factory acceptance without an **independent candidate-check receipt**
from a CGAD Trusted Provider.

The verification gate plan
(`development-process-module.js:42-47`) sets:
```js
const VERIFICATION_FINAL_PLAN = buildCheckPlan('development.verification.final.v2', [{
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
    indeterminateDisposition: 'human-required',   // ← KEY
}]);
```

So: check returns `unknown` → gate verdict = `repair_required` with
`indeterminateDisposition: 'human-required'` → Workplace pauses → after
`maxAttempts: 2` retries, `onExhausted: 'pause'` → ProcessRun pauses.

The scripted `developmentVerify` handler submits a valid evidence product with
`outcome: 'passed'`, but the gate rejects it because there is no independent
candidate-check receipt. The harness has no mechanism to inject one.

**This is THE critical gap.** Until it is resolved, no E2E test can reach
`released`.

---

## 5. Gaps — What's NOT Faithfully Reproduced

### 5.1 Independent candidate-check receipts (CRITICAL)

**Production path**: A real verifier (saga-verifier skill) generates L3 property
tests from the frozen AC contract, runs them against the integrated candidate,
and records evidence via `verification_record` — which creates a
`factory_check_receipts` row from a trusted provider. The verification gate's
check provider looks for this receipt; without it, the assessment is
indeterminate.

**Scripted path**: The `developmentVerify` handler calls `product_submit` with
`outcome: 'passed'` but NEVER creates a check receipt. The gate has no
independent evidence to consult.

**What's missing**: The harness needs either:
1. A scripted trusted provider that records a passing check receipt before the
   gate runs (via `verification_record` MCP tool or direct check-receipt
   insertion), OR
2. A test-only verification check provider in `scenario-composition.mjs` that
   accepts the LM assessment as sufficient (bypassing the independent-receipt
   requirement) — but this weakens the test's fidelity.

### 5.2 Git desk provisioning — PARTIALLY reproduced (works, but with caveats)

**Status**: The scripted executor DOES provision per-task git worktrees using
the **production `RepositoryDeskProvisioner`** (`scenario-scripted-executor.mjs:106-196`).
This was added in commit `2bf6213` ("scripted-harness git desk parity").

**What works**:
- `provisionScriptedDesk()` calls the same `RepositoryDeskProvisioner.provisionAuthorDesk()` / `provisionReviewerDesk()` as production
- Author desk: worktree on `task/<id>` at the frozen base commit
- Reviewer desk: detached worktree at the accepted source commit
- The desk info is passed via `SAGA_DESK_*` env vars to the dispatcher
- The `developmentImplement` handler commits inside the worktree (no `checkout -B` race)

**Gaps vs production**:
- **No `effectiveBaseReceiptRef` / `effectiveBaseReceiptDigest`**: Production resolves the base commit via `resolveEffectiveDeskBase()` which freezes a receipt. The scripted path reads `expectedBaseCommit` from the DevelopmentCase `input_snapshot` directly (`scenario-scripted-executor.mjs:163-178`), bypassing the effective-desk-base receipt mechanism.
- **No `expectedIntegrationHead` assertion**: Production asserts the integration branch HEAD hasn't drifted. The scripted provisioner doesn't pass this.
- **No `artifact_change` desk**: Production handles `artifact_change` tasks via `effective_desk_base_receipts`. The scripted executor returns `null` for non-`git_change` tasks.
- **No desk persistence in task metadata**: Production writes `metadata.process_workspace.repository_desk` into the task row and `worker_executions.metadata.repository_desk`. The scripted executor only passes desk info via env vars — it does NOT persist the desk binding into the DB. This means settlement/verification cannot verify the worker operated within the prepared desk.

### 5.3 CandidateSet capture — reproduced for typed-submission, NOT for managed-production

**Typed-submission cells** (Discovery, Development planner/implementation/review/verification):
The handler calls `product_submit`, which seals a CandidateSet via the real
product pipeline. This works.

**Managed-production cells** (Formalization product-contract, use-cases, acceptance, architecture):
The handler calls `artifact_create` + `trace_add`. The CandidateSet is sealed by
the production-cell presenter after `worker_done`, which reads the managed
artifact productions via `SqliteWorkplaceProductionResolver`. This works (proven
by P18 unit tests and the formalization stages completing in the E2E tests).

**Gap**: The `formalizationArchitecture` handler writes the SRS file to disk
and creates an SRS artifact, but the SRS D2 parser validation that the real
gate runs may not be exercised end-to-end (the `srs-d2-parser.test.mjs` unit
test covers the parser in isolation, but the formalization gate's
submission-preflight that calls the parser is not verified to accept the
scripted SRS content in the E2E flow).

### 5.4 Gate validation — reproduced (real gates run), but the verification gate is unsatisfiable

**Status**: The gates ARE the real production gates. The composition override
does NOT replace gate logic — it only replaces the worker executor and delivery
providers. So every `GateDecision`, check receipt, and verdict runs through the
real `driveGateRun`.

**Gap**: As detailed in §4.3, the verification gate's check provider returns
`'unknown'` for any LM-authored assessment. The harness cannot satisfy this
gate. All other gates (Discovery, Formalization, Development planner/
implementation/review) are satisfiable and do pass.

### 5.5 Reviewer phase — reproduced

The author→reviewer transition IS faithfully reproduced:
- `approvedReview` handler (golden-path-scenarios.mjs:214-223) reads the author CandidateSet via `candidate_read`, submits a `factory.review-verdict.v1` product with `verdict: 'approved'`, and calls `worker_done`.
- The `developmentReview` handler (lines 335-359) similarly reads the implementation result from the CandidateSet and submits a `factory.development-review-verdict.v1`.
- The production-cell reducer transitions `review_in_progress → done/terminal(accepted)` on reviewer acceptance.
- The scripted executor provisions a reviewer desk (detached worktree at the source commit) when `assignment.status === 'review_in_progress'`.

**No gap here.** The reviewer phase works for both Formalization and Development.

### 5.6 Managed-production — reproduced

The `product_source` is correctly resolved by `activateProductionCellRoleTask` (covered by `production-source-and-tracker-hook.test.mjs`). The composition does NOT override `productSource` — production authority resolves it from the cell definition:
- Formalization cells: `managed-production` (artifacts via `artifact_create`)
- Development cells: `typed-submission` (products via `product_submit`)

The handlers respect this: Formalization handlers call `artifact_create`, Development handlers call `product_submit`.

**No gap here.**

### 5.7 product_submit — reproduced

`product_submit` IS called by every typed-submission handler:
- `discoveryProposal`, `discoveryReadiness` — Discovery products
- `formalizationReconcile` — reconciliation report
- `developmentPlan` — task-graph proposal
- `developmentImplement` — implementation result
- `developmentReview` — review verdict
- `developmentVerify` — verification evidence

The in-process capsule replay also calls `product_submit` via the real handlers.

**No gap here** (the mechanism works; the verification gate rejection is a
separate issue).

### 5.8 Concurrency — reproduced but test fails downstream

The parallel-git-desk test runs at `concurrency=2` with two implementation
items. The worktree isolation fix (commit `2bf6213`) correctly eliminates the
`PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH` race — the test log shows both
implementation workers running concurrently without source corruption.

However, the test still fails at `verify-acceptance` (same root cause as §4.3).
The concurrency mechanics themselves work; the failure is downstream.

### 5.9 Replay (capsule) path — reproduced

The in-process capsule replay (`runCapsuleReplay` in
`scenario-scripted-executor.mjs:53-93`) uses the SAME `executeCapsuleReplay`
and SAME MCP handler containers as the production claude executor. When a
frozen `capsule_ref` is present on the assignment, the scripted executor replays
it instead of spawning a scripted worker.

**Gap**: The golden-path Run B (replay with zero scripted calls) cannot be
verified because Run A fails before producing capsules. The replay mechanism
itself is correctly wired.

---

## 6. RepositoryDeskProvisioner Integration

### 6.1 Current state

The scripted executor DOES integrate `RepositoryDeskProvisioner`
(`scenario-scripted-executor.mjs:22-25, 106-196`):

```js
const deskProvisionerMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/repository-desk-provisioner.js')).href
);
const RepositoryDeskProvisioner = deskProvisionerMod.RepositoryDeskProvisioner;
```

`provisionScriptedDesk(dbPath, assignment)`:
1. Reads the task row to get `execution_mode`, `project_repository_id`, `metadata`
2. Returns `null` if not `git_change`
3. For reviewer: reads `factory_managed_node_submissions.payload_snapshot` to get `source.commitSha`, calls `provisionReviewerDesk()`
4. For author: reads `expectedBaseCommit` from `factory_process_runs.input_snapshot`, calls `provisionAuthorDesk()`
5. Returns `{ executionPath, branch, baseCommit, headCommit, integrationBranch, repositoryRoot, detached }`

The desk info is passed to the dispatcher via `SAGA_DESK_*` env vars, and the
dispatcher constructs the `desk` object passed to the handler
(`scenario-dispatcher.mjs:79-90`).

### 6.2 What needs to change for full parity

| Aspect | Current | Production | Fix |
|---|---|---|---|
| Base commit resolution | Reads `expectedBaseCommit` from `input_snapshot` directly | `resolveEffectiveDeskBase()` freezes a receipt with ref/digest | Use `resolveEffectiveDeskBase` or accept the simplification (works for single-repo tests) |
| Desk persistence in DB | NOT persisted — env vars only | `metadata.process_workspace.repository_desk` + `worker_executions.metadata.repository_desk` | Write the desk binding into task metadata so settlement can verify it |
| `expectedIntegrationHead` | Not passed | Asserted before provisioning | Pass through for multi-repo tests |
| `artifact_change` tasks | Returns `null` | Reads `factory_effective_desk_base_receipts` | Add if artifact_change tests are needed |
| Desk disposal | Not called | `disposeDesk()` after merge | Optional cleanup; not load-bearing for test correctness |

### 6.3 The worktree cleanup problem

The golden-path test has elaborate worktree cleanup logic between Run A and
Run B (lines 256-277): it lists worktrees, force-removes each one, prunes
metadata, deletes the `.worktrees` directory, resets `dev` to `baseCommit`, and
deletes all non-`dev` branches. This is necessary because Run A's per-task
worktrees leave branches checked out in linked worktrees, which would conflict
with Run B's capsule replay (which does `git checkout -B task/<id>` in the
shared root).

This cleanup is fragile and Windows-sensitive (`git worktree remove --force`
can fail if files are locked). It should be replaced by having the scripted
executor call `disposeDesk()` after each worker completes.

---

## 7. Comparison: Production vs Scripted Path

| Step | Production (`claude-worker-executor-factory.ts`) | Scripted (`scenario-scripted-executor.mjs`) | Match? |
|---|---|---|---|
| **Composition loading** | `loadCompositionOverrides()` → production composition | Same function → `scenario-composition.mjs` | YES (same mechanism) |
| **Worker executor factory** | `createPinnedClaudeWorkerExecutorFactory()` | `createScriptedWorkerExecutorFactory()` | Intentionally different (script replaces LLM) |
| **Assignment resolution** | `SqliteWorkAssignmentAdapter` (production) | Same (not overridden) | YES |
| **Execution fencing** | `worker_executions` row, `markExecutionRunning` | Same function called | YES |
| **Workspace preparation** | `materializePinnedWorkspace()` — pins skills, templates, trackers | NOT done | NO — scripted workers don't need skills/templates, but workspace files (trackers, call templates) are not materialized |
| **Repository desk provisioning** | `provisionRepositoryDesk()` → `resolveEffectiveDeskBase()` → `RepositoryDeskProvisioner` | `provisionScriptedDesk()` → `RepositoryDeskProvisioner` (same provisioner) | PARTIAL — same provisioner, but base-commit resolution and DB persistence differ |
| **Desk binding in task metadata** | `metadata.process_workspace.repository_desk` persisted | NOT persisted (env vars only) | NO |
| **Desk binding in worker_executions** | `json_set(metadata, '$.repository_desk', …)` | NOT persisted | NO |
| **Process spawning** | `spawn(claude, [...])` via `createClaudeBoardRunner` | `spawn(node, [scenario-dispatcher.mjs, ...])` | Intentionally different |
| **MCP config** | Claude's built-in MCP client | Temp JSON file with stdio saga server | Different mechanism, same protocol |
| **Worker prompt** | Rich prompt with workspace context, skill refs, task details | Minimal `key=value` prompt (project_id, task_id, worker_id, execution_id, role) | NO — scripted workers don't receive workspace/skill/task-detail context (they read it via `task_get`) |
| **Worker execution** | LLM inference via claude CLI | Handler function via `runScenarioWorker()` | Intentionally different |
| **Product submission** | LLM calls `product_submit` / `artifact_create` / `trace_add` | Handler calls same MCP tools | YES (same MCP boundary) |
| **worker_done** | LLM calls `worker_done` | Handler calls `actions.done()` → same MCP tool | YES |
| **Process termination** | OS exit → `finalizeManagedWorkerProcess()` | Same function called | YES |
| **Crash recovery** | `recoverAssignment()` → `releaseExecutionAtomically()` + `ConveyorRuntime.releaseExecution()` | Same (production code path in finalizer) | YES |
| **Capsule replay** | `createInProcessReplayRunner()` → `executeCapsuleReplay()` | Same function called | YES |
| **Supervision** | `startWorkerSupervision()` — reconcile + renewLeases | Same (not overridden) | YES |
| **Gate evaluation** | `driveGateRun()` with real check providers | Same (not overridden) | YES |
| **CandidateSet sealing** | Production presenter after `worker_done` | Same | YES |
| **Lifecycle routing** | Production lifecycle definition | Same | YES |
| **Independent check receipts** | Real verifier records evidence via `verification_record` | NOT provided | NO — this is the critical gap |

---

## 8. Recommendations

### 8.1 CRITICAL: Make the verification gate satisfiable

**Problem**: The verification check provider always returns `'unknown'` for
LM-authored assessments. No E2E test can reach `released`.

**Option A (recommended): Script a trusted verifier provider**

Add a test-only check provider to `scenario-composition.mjs` that registers as
a `deterministic_evidence` trusted provider and records a passing check receipt
for the verification CandidateSet. The scripted `developmentVerify` handler (or
a new step in the executor) would call `verification_record` with
`outcome: 'passed'` before the gate runs, creating the receipt the check
provider looks for.

This requires understanding how the verification gate consumes check receipts —
specifically, whether the `DEVELOPMENT_VERIFICATION_CHECK_PROVIDER` consults
`factory_check_receipts` or only validates the product contract. From the code
(lines 139-144), the provider currently ALWAYS returns `'unknown'` regardless of
receipts. So Option A requires either:

  - **A1**: Modifying the check provider to look for an independent receipt and
    return `'passed'` when one exists (production change — correct long-term
    fix), OR
  - **A2**: Overriding the check provider in the test composition to accept
    the LM assessment when a test-only receipt is present.

**Option B: Override the verification gate plan in test composition**

Replace `VERIFICATION_FINAL_PLAN` with a plan whose check provider always
returns `'passed'`. This is the lowest-effort fix but sacrifices fidelity — it
doesn't test the real verification gate.

**Option C: Use the Verification Continuation module**

The factory ships `solution-development-verification-continuation@1.0.0`
(dist/process-modules/modules/development/development-verification-continuation-process-module.js)
which uses `ACCESSIBLE_COUNTER_CHECK_PROVIDER` and `AUTHORIZED_OBSERVER_CHECK_PROVIDER`
from `candidate-check-contracts.js`. If the test lifecycle can be configured to
use this continuation module, the verification gate may be satisfiable with
scripted counter-check providers. This requires investigation.

### 8.2 Persist the desk binding in task metadata

`provisionScriptedDesk()` should write `metadata.process_workspace.repository_desk`
and `worker_executions.metadata.repository_desk`, matching production. This
ensures settlement and verification can verify the worker operated within the
prepared desk. Without this, the desk parity is incomplete.

### 8.3 Add desk disposal after worker completion

The scripted executor should call `RepositoryDeskProvisioner.disposeDesk()`
after the finalizer runs, to clean up per-task worktrees. This eliminates the
fragile worktree-cleanup logic in `golden-path.test.mjs:256-277` and prevents
worktree accumulation across test runs.

### 8.4 Enrich the worker prompt

The scripted dispatcher receives a minimal prompt
(`project_id=…, task_id=…, worker_id=…, execution_id=…, role=author`). Production
workers receive workspace context, skill references, tracker paths, and task
details. While scripted handlers don't need skills, they currently re-fetch task
details via `task_get` — enriching the prompt would reduce MCP round-trips and
make the harness closer to production.

### 8.5 Add effective-desk-base receipt freezing

For full parity with multi-repo and dependency-ordered scenarios, the scripted
executor should call `resolveEffectiveDeskBase()` (from
`dist/infrastructure/workers/effective-desk-base.js`) instead of reading
`expectedBaseCommit` from the input snapshot directly. This freezes a receipt
that settlement can verify.

### 8.6 Add artifact_change desk support

The scripted executor returns `null` for `artifact_change` tasks. If the harness
needs to test artifact_change scenarios (where the worker modifies an existing
artifact rather than creating a new branch), add the
`factory_effective_desk_base_receipts` path.

### 8.7 Separate "infrastructure" tests from "contract" tests

The 64 passing unit tests are really infrastructure/domain tests — they test
pure logic, not the Factory contract. The 3 E2E tests are the actual contract
tests. Consider splitting them into separate directories or npm scripts to make
the pass/fail signal clearer.

### 8.8 Add a "verification-only" E2E test

Once the verification gate is satisfiable (§8.1), add a test that runs ONLY the
Development stage (skipping Discovery/Formalization) to isolate verification
behavior. This would catch verification regressions without the full lifecycle
runtime cost.

---

## 9. Summary

The existing harness is architecturally sound: it replaces only the worker
inference layer, runs all Factory authority through production code, and
correctly uses the production `RepositoryDeskProvisioner`, `finalizeManagedWorkerProcess`,
and `executeCapsuleReplay`. The 64 domain-level unit tests all pass, and the
crash-recovery E2E test passes.

The harness has ONE critical blocking gap: the verification gate's check
provider is designed to ALWAYS return `'unknown'` for LM-authored assessments,
requiring an independent candidate-check receipt that the harness does not
provide. This blocks both E2E golden-path and parallel-git-desk tests at the
`verify-acceptance` node. Until this gap is resolved (§8.1), no E2E test can
reach `released`.

Secondary gaps (desk-binding persistence, effective-desk-base receipts, desk
disposal) reduce fidelity but are not blocking. The worktree isolation fix
(commit `2bf6213`) correctly eliminated the concurrency race; the
parallel-git-desk test's failure is downstream of the verification gate, not a
concurrency regression.
