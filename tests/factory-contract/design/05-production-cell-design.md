# 05 — Production Cell Design: Scripting the Universal Author→Reviewer Quality Loop

> This document explains how the Saga Factory's Production Cell works end-to-end
> and how to script every phase without an LLM. Every claim is backed by a code
> reference so a script author can verify the mechanism directly.

## 0. Mental Model

Every workshop node (Discovery, Formalization, Development, Delivery) runs through
the SAME `ProductionCellNodeExecutor`. The executor is a **reconciler**, not a
launcher. It does not spawn workers. It:

1. **Materializes** deterministic `Workplace` desks (one per fan-out item).
2. **Projects** author/reviewer role tasks onto the human kanban (reverse projection).
3. **Reconciles** each Workplace through its bounded control loop:
   `idle → queued → leased → running → verifying → (repair_wait | terminal)`.
4. **Seals** CandidateSets, **drives** GateRuns, and **applies** durable GateDecisions.
5. **Fires** post-acceptance effects (git integration, replay capture) on terminal(accepted).

The actual worker execution (claim, spawn, crash detection) belongs to the global
dispatcher (`worker_next` / `worker_done`) and the `ConveyorRuntime`. The executor
re-runs on every Process Module tick and idempotently drives each Workplace to the
furthest state the real world permits.

**Key files:**
- `src/process-modules/application/node-executors/production-cell-node-executor.ts` — THE executor
- `src/process-modules/domain/workplace/production-cell-reducer.ts` — pure state machine
- `src/process-modules/application/production-cell-coordinator.ts` — applies reducer events via CAS
- `src/process-modules/application/gate-run-driver.ts` — drives GateRuns
- `src/process-modules/domain/workplace/{candidate-set,gate,workplace-state,production-cell-definition}.ts` — domain types

---

## 1. Production Cell Phases (with code references)

### Phase 1: Author task activation (`activateProductionCellRoleTask`, role=author)

The executor's `execute()` method materializes workplaces, then for each workplace
in `idle/queued` state with `nextRole=author`, calls `ensureRoleProjection()`:

```ts
// production-cell-node-executor.ts:217-226
if (state.nextRole === 'author' && (state.loopState === 'idle' || state.loopState === 'queued')) {
  authorTaskIds.set(workplace.itemId,
    this.ensureRoleProjection(ctx, node, cell, workplace, state));
  roleProjectedThisCycle.add(`${workplace.itemId}:author`);
  continue;
}
```

`ensureRoleProjection()` (line 700-825) does three things:

**(a) Ensures an execution plan** via `persistence.ensureExecutionPlan()` — creates a
`factory_work_intents` row (the authority scope, output schema, retry budget) and a
`tasks` row (the kanban card with skill, generation key, metadata).

**(b) Binds process context** via `persistence.bindProjectedTaskProcessContext()` —
links the task to its ProcessRun/Node/Module with a semantic input digest for
cross-run replay identity.

**(c) Activates the role task** via `persistence.activateRoleTask()` which calls
`activateProductionCellRoleTask` in `work-assignment-core.ts:736-775`:

```ts
// work-assignment-core.ts:761-773
db.prepare(`UPDATE tasks SET status='done',... WHERE workplace_ref=? AND id<>?`)
  .run(input.workplaceRef, input.taskId);  // retire prior role cards
db.prepare(`UPDATE tasks SET workplace_ref=?,status=?,... WHERE id=?`)
  .run(
    input.workplaceRef,
    input.role === 'reviewer' ? 'review' : 'todo',  // author → 'todo'
    JSON.stringify(metadata),
    input.taskId,
  );
```

This is **idempotent**: re-projection retires competing cards for the same workplace
and republishes exactly one claimable card.

**Scripting side effect:** A task with `status='todo'`, `assigned_to=NULL`, and
metadata containing `{workplace_ref, role:'author', work_intent_id, process_run_id,
product_source}` appears in the queue. The dispatcher's `findNextClaimable` SQL
(work-assignment-core.ts:412-494) will find it when its workplace is `queued`.

---

### Phase 2: Author runs, produces candidate

The executor does NOT run the author. It returns `pendingOutcome()` when the
workplace is `queued/leased/running` (line 448-462). The global dispatcher leases
the task and spawns the worker:

1. **`worker_next`** claims the task: `findNextClaimable` sets `assigned_to`,
   `current_execution_id`, and status → `in_progress`.
2. **`reserveTaskExecution`** (conveyor-runtime-helper.ts:52) calls
   `ConveyorRuntime.reserveWorkplace()` which applies `work-admitted` (todo/idle →
   in_progress/queued) then `worker-leased` + `worker-started` (queued → leased →
   running).
3. The worker (an LLM or a script) runs and either:
   - **Typed submission:** calls `product_submit({schema, content})` which writes to
     `factory_managed_node_submissions`.
   - **Managed production:** calls `artifact_create` / `trace_add` which mutate the
     workplace desk (artifacts + traces).
4. The worker calls **`worker_done`** which:
   - Checks `requireProductionCellSubmission` (dispatcher.ts:1914) — for typed-submission
     cells, verifies a `product_submit` exists for this exact execution.
   - Runs submission validation if declared.
   - Calls `releaseTaskExecution` with `outcome:'completed'` → applies
     `candidate-sealed` event (running → verifying).

**Scripting:** A script worker calls `product_submit` then `worker_done`. See
`tests/factory-contract/scenario-engine.mjs:199-245` for the `actions` helpers.

---

### Phase 3: CandidateSet capture

On the NEXT executor reconcile (after the workplace reaches `verifying`), the
executor reads the active reservation and seals the CandidateSet:

```ts
// production-cell-node-executor.ts:468-471
const actors = this.opts.coordinator.readActiveActors(workplace.ref);
const executionRef = actors?.activeReservationRef;
if (!executionRef) throw new NodeExecutionError(..., 'verifying Workplace has no producer reservation');
```

**Product reading** (line 486-498) — two paths depending on `productSource`:

```ts
const products = carryDirective
  ? carryDirective.products
  : this.opts.productReader.readExecutionProducts({
      processRunId, moduleRef, nodeId: node.id, executionRef,
      expectedSchemaRefs: role === 'reviewer'
        ? [cell.review?.verdictSchemaRef ?? '']
        : cell.productContracts.map(c => c.schemaRef),
      requireTypedSubmission: role === 'reviewer'
        || cell.productContracts.some(c => c.productSource === 'typed-submission'),
    });
```

The `productReader` implementation (`product-lifecycle-runtime.ts:480-552`) resolves:

- **Typed submission:** reads the latest `factory_managed_node_submissions` row for
  `(processRunId, moduleRef, nodeId, executionId)` and returns a single `ProductRef`:
  `{schemaId, ref:'managed-node-submission:<id>', digest:content_hash}`.
- **Managed production:** reads the workplace desk (artifacts + traces), builds a
  `workplaceProductionSnapshot`, and **freezes** it into the universal
  `factory_process_products` store via `workplaceProductPort.submitProduct()`. This
  snapshot is immutable — later desk mutations do not change it.

**Contract assertion** (line 502-503) — `assertProductContract` checks cardinality:
each `ProductContract` declares `cardinality` ('1', '0..1', '1..n') and the products
must match.

**Sealing** (line 507-515, 827-850) — `sealCandidateSet` calls
`candidateSetRepo.seal()`:

```ts
// production-cell-node-executor.ts:834-849
const members: CandidateMember[] = products.map(productRef => ({
  productRef, origin: 'produced', sourceCandidateSetRef: null,
}));
const digest = hash({ workplaceRef, executionRef, role, products });
return this.opts.candidateSetRepo.seal({
  workplaceRef, productionRevisionRef, role,
  subjectCandidateSetRef, members,
  sealReceiptRef: `seal:${executionRef}:${role}`,
  candidateSetDigest: digest,
  sealedAt: now,
}).set;
```

**What is captured:** `ProductRef[]` (schemaId + ref + digest), the producer
execution ref, the role, and (for reviewer) the pinned subject author
CandidateSetRef. NOT commit SHA or tree SHA directly — those are inside the product
payload (e.g. `factory.source-change-candidate.v1` carries `baseCommit`, `headCommit`).

---

### Phase 4: Gate validation (GateDecision)

Immediately after sealing, the executor runs the gate **synchronously** (line 533
for author, 551 for reviewer):

```ts
// production-cell-node-executor.ts:879-905
private runGate(ctx, workplaceRef, gate, subjectCandidateSetRef, assessmentCandidateSetRefs = []) {
  return driveGateRun(this.opts.gateRepo, this.opts.checkProviders, {
    workplaceRef, subjectCandidateSetRef, assessmentCandidateSetRefs,
    checkPlan: gate.checkPlan,
    gatePhase: gate.gatePhase,
    expectedWorkplaceRevision: this.requireState(workplaceRef).revision,
    gateLeaseRef: `gate-lease:${sha256Hex({...})}`,
    installationDigest: this.opts.resolveInstallationDigest(ctx.module.identity.name),
    checkParameters: { processRunId, moduleRef },
    environmentRef: null,
  }).decision;
}
```

`driveGateRun` (gate-run-driver.ts:56-180):
1. Creates a `factory_gate_runs` row (idempotent on `gateRunRef`).
2. For each `CheckPlanEntry`, resolves the `CheckProvider` from the registry and runs
   it synchronously (async providers are rejected — line 111).
3. Records each `CheckReceipt` (immutable, append-only).
4. **Reduces receipts** to one verdict via `reduceReceipts` (line 182-225):
   - `failed` receipt → `repair_required` with `repairTargetRoleOnFailure` (default 'author').
   - `unknown`/`error` under `fail-closed` policy → `repair_required` or `human_required`.
   - Two checks disagreeing on target → `human_required`.
   - All pass → `accepted`.
5. Records the `GateDecision` (idempotent on `decisionKey`).

**The standard CheckPlan** always includes `factory.product-contract.v1` (a no-op
that returns 'passed') plus any module-specific checks. For reviewed cells, the
final gate includes `factory.review-verdict.v1` which reads the reviewer's verdict
product and returns 'passed' for `approved`, 'failed' for `changes_requested`.

---

### Phase 5: Reviewer task activation (role=reviewer)

When the author gate returns `accepted` AND the cell declares a `review` section,
the executor applies `gate-author-accepted-with-review`:

```ts
// production-cell-node-executor.ts:536-539
this.opts.coordinator.applyGateDecision(workplace.ref, {
  verdict: 'accepted', isFinal: !cell.review,
  effectRequired: !cell.review && Boolean(cell.postAcceptanceEffect),
});
```

The reducer (production-cell-reducer.ts:216-226) transitions:
`in_progress/verifying → review/queued, nextRole=reviewer`.

On the next reconcile, `ensureRoleProjection` runs again with `role=reviewer`:
- Creates a reviewer WorkIntent with `outputSchema = cell.review.verdictSchemaRef`.
- `activateProductionCellRoleTask` sets the task to `status='review'`.
- The task metadata gets `product_source='typed-submission'` (reviewer output is
  ALWAYS typed — work-assignment-core.ts:702).

The reviewer worker claims the task via `worker_next` (which sees `status='review'`
and transitions to `review_in_progress`), reads the author candidate via
`candidate_read`, and produces a verdict.

---

### Phase 6: Reviewer verdict (approved / changes_requested)

The reviewer submits a typed product matching `cell.review.verdictSchemaRef`
(e.g. `factory.review-verdict.v1`) containing:

```json
{
  "subject_candidate_set_ref": "<the pinned author set>",
  "verdict": "approved" | "changes_requested",
  "findings": ["..."]
}
```

Then calls `worker_done`. The executor seals the reviewer CandidateSet (pinned to
the author set via `subjectCandidateSetRef`), then runs the **final gate**:

```ts
// production-cell-node-executor.ts:548-566
const decision = this.runGate(ctx, workplace.ref,
  cell.review.finalGate,
  subjectAuthorSet.candidateSetRef,     // subject = author's set
  [candidate.candidateSetRef],          // assessment = reviewer's set
);
if (decision.verdict === 'accepted') {
  postAcceptanceCandidate = subjectAuthorSet;
}
this.opts.coordinator.applyReviewerVerdict(workplace.ref, {
  verdict: decision.verdict,
  repairTargetRole: decision.repairTargetRole ?? undefined,
  effectRequired: decision.verdict === 'accepted' && Boolean(cell.postAcceptanceEffect),
});
```

The `review-verdict` check provider (review-verdict-check-provider.ts) reads the
reviewer's verdict product and returns 'passed' for approved, 'failed' for
changes_requested.

**Verdict mapping** (production-cell-coordinator.ts:193-231):
- `accepted` → `reviewer-verdict(accepted)` → `terminal(accepted)` or `effect_pending`.
- `repair_required` + `repairTargetRole=author` → `reviewer-verdict(defect-proven)` →
  `in_progress/repair_wait` (semantic backward transition, REG-28-AC-04).
- `repair_required` + `repairTargetRole=reviewer` → `reviewer-verdict(invalid-output)` →
  `review_in_progress/repair_wait` (retry reviewer).
- `failed` → `reviewer-verdict(invalid-output)` → retry reviewer.

---

### Phase 7: Accept or repair loop

**Accept path:** When the gate accepts (and no effect is declared), the workplace
goes `terminal(accepted)`. The executor records final acceptance and fires replay
capture (line 583-598):

```ts
if (state.loopState === 'terminal') {
  if (postAcceptanceCandidate) {
    this.recordFinalAcceptanceAndCapture(ctx, cell, workplace.ref, postAcceptanceCandidate, []);
  }
  return this.terminalOutcome(workplace.ref, state);
}
```

`recordFinalAcceptanceAndCapture` (line 667-698) writes to
`factory_cell_final_acceptances` and runs the universal `replay-capture` effect
(best-effort — failure never revokes the GateDecision).

If a `postAcceptanceEffect` is declared (e.g. git integration), the workplace enters
`effect_pending` and `settleAcceptanceEffect` (line 607-665) runs the effect, records
the receipt, then completes.

**Repair path:** When the gate returns `repair_required`, the workplace enters
`repair_wait`. On the NEXT reconcile (line 405-426):

```ts
if (state.loopState === 'repair_wait') {
  const attempts = this.attemptCount(workplace.ref, state.nextRole);
  if (attempts >= cell.recovery.maxAttempts) {
    if (cell.recovery.onExhausted === 'pause') {
      this.opts.coordinator.applyGateDecision(workplace.ref, {verdict:'human_required', isFinal:true});
    } else {
      this.opts.coordinator.applyGateDecision(workplace.ref, {verdict:'failed', isFinal:true});
    }
    // ... terminal or paused outcome
  } else {
    this.opts.coordinator.requeue(workplace.ref, state.nextRole);
    this.opts.persistence.projectWorkplace(workplace.ref);
    // ... re-projects the role task, returns to queued
  }
}
```

---

## 2. productSource Determination: 'managed-production' vs 'typed-submission'

**Declaration:** The `ProductContract` in the cell definition may declare
`productSource: 'typed-submission' | 'managed-production'` (production-cell-definition.ts:30).
The `singletonProductionCell` builder forwards it (standard-production-cell.ts:44).

**Forwarding:** During role projection, the executor resolves the productSource
from the contract matching the node's output schema (line 822):

```ts
productSource: cell.productContracts.find(c => c.schemaRef === node.outputSchema?.id)?.productSource,
```

**Activation stamping:** `activateProductionCellRoleTask` (work-assignment-core.ts:691-733)
calls `resolveRoleProductSource` with this priority:

1. **Reviewer → always 'typed-submission'** (line 702). Reviewer output is a typed verdict.
2. **Cell declaration wins** if forwarded (line 706).
3. **Existing metadata** `product_source` is preserved (line 713-715) — migration defence.
4. **Fallback: inspect the WorkIntent capability set** (line 717-732): if
   `authority_scope.allowed_tools` includes `product_submit` → `typed-submission`;
   otherwise → `managed-production`.

**How the executor decides at read time** (line 495-497):
```ts
requireTypedSubmission: role === 'reviewer'
  || cell.productContracts.some(contract => contract.productSource === 'typed-submission'),
```

**Dispatcher enforcement** (`requireProductionCellSubmission`, dispatcher.ts:1914-1985):
For typed-submission cells, `worker_done` is REJECTED with
`PRODUCTION_CELL_PRODUCT_REQUIRED` unless a `product_submit` row exists for the exact
execution. For managed-production cells (detected via `metadata.product_source`), the
guard returns early — no typed product required.

**Composition root:** The productReader is wired in
`product-lifecycle-runtime.ts:479-553`. The same file wires the executor with all its
dependencies (coordinator, repos, check providers, effects).

---

## 3. CandidateSet Structure

**Domain type** (`candidate-set.ts:108-130`):

```ts
interface CandidateSet {
  candidateSetRef: string;           // deterministic seal key
  workplaceRef: WorkplaceRef;
  productionRevisionRef: string;      // immutable Workplace material authority
  role: 'author' | 'reviewer';
  subjectCandidateSetRef: string | null;  // REQUIRED for reviewer, NULL for author
  members: readonly CandidateMember[];
  sealReceiptRef: string;
  candidateSetDigest: string;         // SHA-256 over canonical form
  sealedAt: string;                   // ISO timestamp
}

interface CandidateMember {
  productRef: ProductRef;             // {schemaId, ref, digest}
  origin: 'produced' | 'carried-forward';
  sourceCandidateSetRef: string | null;  // required for carried-forward
}
```

**Seal key** (candidate-set.ts:146-160) — deterministic over
`(workplaceRef, productionRevisionRef, role, subjectCandidateSetRef)`:
```
candidate-set/<processRunId>/<moduleRef>/<productionCellId>/<workKey>/<executionRef>/<role>
```

**Storage** — two tables:
- `factory_candidate_sets` — the set row (ref, workplace, execution, role, subject, digest, seal_receipt, sealed_at).
- `factory_candidate_set_members` — one row per member (ordinal, product_schema, product_ref, product_digest, origin, source_candidate_set_ref).

**Idempotency** (sqlite-candidate-set-repository.ts:52-121): sealing with the same
key + same digest returns `replayed=true`; same key + different digest throws
`CANDIDATE_SET_REPLAY_MISMATCH`.

**Cross-field validation** (`assertValidCandidateSet`, candidate-set.ts:177-230):
- Members non-empty.
- `role=reviewer` requires non-null `subjectCandidateSetRef`; `role=author` requires null.
- `origin=produced` requires null `sourceCandidateSetRef`; `carried-forward` requires non-null.

---

## 4. GateDecision Structure

**Domain type** (`gate.ts:330-363`):

```ts
interface GateDecision {
  workplaceRef: WorkplaceRef;
  gateRef: string;
  gateRunRef: string;
  gatePhase: 'author' | 'final';
  transitionRef: string;
  subjectCandidateSetRef: string;
  assessmentCandidateSetRefs: readonly string[];  // reviewer sets for final gate
  verdict: 'accepted' | 'repair_required' | 'human_required' | 'failed';
  repairTargetRole: 'author' | 'reviewer' | null;  // REQUIRED for repair_required
  checkPlanRef: string;
  checkPlanDigest: string;
  decisionPolicyRef: string;
  decisionPolicyDigest: string;
  checkReceiptRefs: readonly string[];   // exact receipts reduced
  installationDigest: string;            // module package digest at decision time
  decisionKey: string;                   // deterministic identity
  acceptedOutputBindings: readonly AcceptedOutputBinding[];  // empty unless final accepted
  recoveryIssueRef: string | null;       // non-null for repair_required
  decisionDigest: string;                // SHA-256 over canonical body
}
```

**Storage:** `factory_gate_decisions` table (append-only, `decision_key` is primary key).
Related: `factory_gate_runs` (the inspection lifecycle) and `factory_check_receipts`
(immutable per-check evidence).

**Verdict semantics:**
- `accepted` — subject CandidateSet passed. Author-gate: pins for review. Final-gate: cell complete.
- `repair_required` — repairable defect. MUST name `repairTargetRole`.
- `human_required` — stop the line. Produces `blocked/paused`.
- `failed` — terminal failure. Not retryable.

**Decision policy** (`reduceReceipts`, gate-run-driver.ts:182-225): deterministic
reducer. Default `unknownErrorPolicy='fail-closed'`. Two checks disagreeing on
repair target → `human_required`.

---

## 5. maxAttempts: The Repair Budget

**Declaration:** `cell.recovery.maxAttempts` (positive integer) and
`cell.recovery.onExhausted: 'fail' | 'pause'` (production-cell-definition.ts:56-59).

**Attempt counting** (`attemptCount`, production-cell-node-executor.ts:971-997):

```ts
private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
  // Primary: count sealed CandidateSets for this role.
  const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)
    .filter(set => set.role === role).length;
  // Crash recovery: if NO sealed sets but workplace is in repair_wait,
  // count terminal (failed/lost) worker executions for the task.
  const state = this.opts.coordinator.readState(ref);
  if (state && sealedAttempts === 0 && state.loopState === 'repair_wait') {
    const taskRow = this.opts.persistence.readTaskForWorkplace?.(ref);
    if (taskRow) {
      const failedExecs = this.opts.persistence.countTerminalExecutionsForTask?.(taskRow.taskId) ?? 0;
      return Math.max(sealedAttempts, failedExecs);
    }
  }
  return sealedAttempts;
}
```

This prevents infinite crash loops where a worker dies before sealing a CandidateSet
(attemptCount would stay 0 forever without the execution-count fallback).

**Exhaustion handling** (line 405-426):
- `onExhausted='pause'` → applies `human_required` (isFinal) → workplace goes
  `blocked/paused`. A human must intervene.
- `onExhausted='fail'` → applies `failed` (isFinal) → workplace goes `failed/terminal`.

**Reviewer budget:** The reviewer role has its own attempt counter (filtered by
`role='reviewer'`). A reviewer that keeps producing invalid output exhausts its own
budget independently of the author.

**Managed review budget (dispatcher-level):** For non-Production-Cell review,
`worker_done` tracks `metadata.managed_review_budget` and historical
`changes_requested` receipts (dispatcher.ts:651-689). When exhausted, the task goes
to `blocked`.

---

## 6. Scripting Strategy: Per-Phase MCP Calls

### Phase 1 — Activate author task
**Script does nothing.** The Process Module lifecycle orchestrator calls the
executor, which projects the task. The script only needs the ProcessRun to be
alive (`status IN ('running','paused')`).

**Required state:** `factory_process_runs.status` is running/paused, the module is
installed, the cell definition is valid.

### Phase 2 — Author produces candidate
The script worker (claimed via `worker_next`) must:

1. **Read context** (optional): `task_get`, `product_read`, `artifact_list`,
   `candidate_read`.
2. **Produce output** — ONE of:
   - **Typed:** `product_submit({schema: '<declared schema>', content: {...}})`.
   - **Managed:** `artifact_create` / `artifact_update` / `trace_add` (mutates the desk).
3. **Complete:** `worker_done({task_id, worker_id, result, execution_id})`.

**Critical:** `worker_done` will throw `PRODUCTION_CELL_PRODUCT_REQUIRED` if a
typed-submission cell has no `product_submit` for the exact execution. The script
MUST call `product_submit` BEFORE `worker_done`.

**Side effects:** Workplace transitions `running → verifying`. The execution is
released but the reservation is retained through verifying.

### Phase 3 — CandidateSet seal
**Script does nothing.** The executor seals on the next reconcile. No MCP call
triggers this — it happens automatically when the workplace is `verifying`.

### Phase 4 — Gate run
**Script does nothing.** The executor runs the gate synchronously during reconcile.
The CheckProviders are deterministic functions registered in the composition root.

**To influence the verdict,** a script can only affect what the CheckProviders read:
- For the product-contract check: ensure the right number of products exist.
- For the review-verdict check: submit a verdict product with the desired
  `verdict` field.

### Phase 5 — Reviewer task activation
**Script does nothing.** The executor projects the reviewer task when the author
gate accepts with review declared.

### Phase 6 — Reviewer verdict
The script worker (claimed via `worker_next` from the `review` queue) must:

1. **Read the author candidate:** `candidate_read({workplace_ref, role:'author'})` —
   returns `candidate_set_ref`.
2. **Submit verdict:** `product_submit({schema:'factory.review-verdict.v1', content:{subject_candidate_set_ref, verdict:'approved'|'changes_requested', findings:[]}})`.
3. **Complete:** `worker_done({task_id, worker_id, result, execution_id})`.

**Side effects:** Workplace transitions `verifying → terminal(accepted)` or
`repair_wait` (defect-proven → author, invalid-output → reviewer).

### Phase 7 — Post-acceptance effects
**Script does nothing.** The executor fires `postAcceptanceEffect` (e.g.
`git-integration`) and the universal `replay-capture` effect automatically.

For git_change tasks, the merge protocol is SEPARATE from the Production Cell:
`worker_merge_acquire` → `git merge` → `worker_merge_release`.

---

## 7. How to Bypass / Control the Gate in Tests

### Option A: Use the standard product-contract-only CheckPlan (automatic accept)

`buildProductContractCheckPlan` (standard-check-providers.ts:131-133) creates a plan
with ONLY the `factory.product-contract.v1` check, which unconditionally returns
`'passed'`. Any cell using the default CheckPlan will accept any well-formed
CandidateSet. This is the default when no `checkPlan` is passed to
`singletonProductionCell`.

### Option B: Register a custom CheckProvider that returns a fixed outcome

```ts
import { registerFactoryCheckProvider } from 'dist/process-modules/application/standard-check-providers.js';

registerFactoryCheckProvider({
  providerId: 'my-test-check',
  version: '1.0.0',
  run: () => 'passed',  // or 'failed' to force repair
});
```

Then reference it in the cell's CheckPlan. The provider is resolved by id from the
`FactoryCheckProviderRegistry` (a process-wide singleton).

### Option C: Pre-seed GateDecisions via the repository

GateDecisions are idempotent on `decision_key`, which is deterministic over
`(gatePhase, subjectCandidateSetRef, assessmentCandidateSetRefs, checkPlanDigest)`.
You cannot easily pre-seed because you need the CandidateSet to exist first, and
the executor will re-run the gate if the workplace is still `verifying`. This is
NOT a practical bypass.

### Option D: Replay capsules (the production replay path)

`tests/factory-contract/scenario-scripted-executor.mjs:46-93` shows the replay path:
when an assignment carries `executionContext.replay.capsule_ref`, the scripted
executor replays the capsule instead of spawning a worker. The capsule contains
frozen `product_submit` / `artifact_create` / `trace_add` / `worker_done` calls
that are replayed through the REAL MCP handlers. This is the SAME path production
uses for deterministic replay.

```js
// scenario-scripted-executor.mjs:229-250
if (hasFrozenCapsule(assignment)) {
  runCapsuleReplay(context.dbPath, assignment, context.workspaceRoot);
  // ... no scripted worker spawned
}
```

The capsule executor (`infrastructure/replay/capsule-replay-executor.ts`) calls the
real `product_submit` handler for each frozen product, then calls `worker_done`.
This means the gate runs for real, the CandidateSet is sealed for real, and the
Production Cell transitions for real — just without an LLM.

### Option E: Scripted scenario workers (the test harness)

`tests/factory-contract/scenario-engine.mjs` provides a deterministic worker
substitute. Scenario handlers are keyed by `${module}/${node}/${role}/${workKey}`
and executed through the real MCP boundary:

```js
// scenario-engine.mjs:199-245
export const actions = {
  async submitProduct(client, schema, content) {
    return client.callJson('product_submit', { schema, content });
  },
  async done(client, taskId, workerId, executionId, result) {
    return client.callJson('worker_done', {task_id:taskId, worker_id:workerId, result, execution_id:executionId});
  },
  exitWithoutDone() { /* simulate crash */ },
  exitWithFailure() { throw new Error('SCENARIO_INTENTIONAL_FAILURE'); },
};
```

The scenario dispatcher (`scenario-dispatcher.mjs`) is spawned as a child process
with `--mcp-config` pointing at the real saga MCP server. It reads the prompt,
selects a scenario by key, and executes it. The production finalizer
(`finalizeManagedWorkerProcess`) interprets the exit — OS exit alone never fabricates
semantic completion.

**To script a repair loop,** register two scenarios for the same key with different
attempt numbers:
```js
const scenarios = {
  'solution-formalization@1.0.0/define-product-contract/author/singleton': {
    // attempt 1: submit a product that fails a check
    // attempt 2: submit a correct product
  },
};
```
The engine tracks invocations by key (scenario-engine.mjs:162) and passes `attempt`
to the handler, so the handler can branch on repair cycles.

### Option F: Crash simulation (no worker_done)

Calling `actions.exitWithoutDone()` (scenario-engine.mjs:253-257) makes the worker
exit(0) without calling `worker_done`. The production finalizer detects the missing
receipt and treats it as a crash → `worker-crashed` event → `repair_wait`. This
consumes an attempt without sealing a CandidateSet, exercising the crash-recovery
path.

---

## Appendix A: The Reconcile Loop (full flow)

```
execute(ctx)
  ├── materialize workplaces (fan-out or singleton)
  ├── for each workplace in idle/queued + nextRole=author:
  │     ensureRoleProjection(role=author)  → projects task
  ├── sealWorkplaceGraph (if dependencies declared)
  └── for each workplace: reconcile()
        ├── terminal → return terminal outcome
        ├── paused → return paused
        ├── effect_pending → settleAcceptanceEffect()
        ├── idle → check dependencies → admitWork() or pending
        ├── repair_wait → check maxAttempts → requeue() or terminal(failed/paused)
        ├── queued → presentCarriedForward() if authorized; ensureRoleProjection()
        ├── leased/running → pending
        └── verifying:
              ├── read executionRef from activeReservationRef
              ├── read products (typed submission OR managed production desk)
              ├── assertProductContract (cardinality)
              ├── sealCandidateSet → CandidateSet persisted
              ├── if author:
              │     runGate(authorGate) → GateDecision
              │     applyGateDecision(accepted → review/queued OR terminal)
              │     └── if terminal(accepted): recordFinalAcceptance + replay-capture
              └── if reviewer:
                    runGate(finalGate, subject=authorSet, assessment=[reviewerSet])
                    applyReviewerVerdict(accepted → terminal OR defect-proven → repair_wait)
```

## Appendix B: Key Tables

| Table | Purpose | Append-only? |
|-------|---------|-------------|
| `factory_workplaces` | Workplace state (kanban_phase, loop_state, next_role, revision) | No (CAS updates) |
| `factory_work_intents` | Authority scope + output schema per role task | No |
| `factory_candidate_sets` | Sealed CandidateSet headers | Yes (idempotent insert) |
| `factory_candidate_set_members` | Products within each CandidateSet | Yes |
| `factory_gate_runs` | Gate inspection lifecycle (claimed→checking→decided→terminal) | No (state updates) |
| `factory_check_receipts` | Immutable per-check evidence | Yes (triggers enforce) |
| `factory_gate_decisions` | Immutable GateDecisions | Yes (idempotent insert) |
| `factory_managed_node_submissions` | Typed product_submit records | Yes |
| `factory_cell_effect_receipts` | Post-acceptance effect receipts | Yes |
| `factory_cell_final_acceptances` | Final acceptance records | Yes |
| `factory_process_products` | Universal immutable product store (managed-production snapshots) | Yes |
| `worker_executions` | Worker execution lifecycle (reserved→running→exited/lost) | No |

## Appendix C: Workplace State Transition Table (from production-cell-reducer.ts)

| Event | From | To |
|-------|------|-----|
| `work-admitted` | todo/idle | in_progress/queued, author |
| `worker-leased` | queued (in_progress) | leased |
| `worker-leased` | queued (review) | review_in_progress/leased |
| `worker-started` | leased | running |
| `candidate-sealed` | running | verifying |
| `candidate-carried-forward` | in_progress/queued | verifying |
| `worker-crashed`/`worker-lost` | running | repair_wait |
| `gate-repair-required` | verifying | repair_wait (role-specific) |
| `gate-author-accepted-with-review` | in_progress/verifying | review/queued, reviewer |
| `gate-author-accepted-final` | in_progress/verifying | terminal(accepted) or effect_pending |
| `reviewer-verdict(accepted)` | review_in_progress/verifying | terminal(accepted) or effect_pending |
| `reviewer-verdict(defect-proven)` | review_in_progress/verifying | in_progress/repair_wait, author |
| `reviewer-verdict(invalid-output)` | review_in_progress/verifying | repair_wait, reviewer |
| `acceptance-effect-succeeded` | effect_pending | terminal(accepted) |
| `acceptance-effect-repair-required` | effect_pending | in_progress/repair_wait, author |
| `human-required` | any | blocked/paused |
| `gate-failed` | any | terminal(failed) |
| `repair-requeued` | repair_wait/paused | queued (role-specific) |
