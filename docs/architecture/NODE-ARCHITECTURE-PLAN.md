# Node Architecture Migration Plan

Status: proposal (not yet accepted)
Audience: saga3 maintainers
Scope: saga3 discovery pipeline only (saga2 is LEGACY and out of scope)
Date: 2026-07-25

This is an engineering plan, not a vision document. It decomposes the current
`saga3-discovery-engine.ts` (one monolithic `run()`) into a **scenario
interpreter** + small **Node** implementations, and lays out a phased
strangler-fig migration that keeps the existing pipeline running and the
existing tests green at every commit.

---

## 0. TL;DR

The concept maps cleanly onto the existing code with three friction points
that must be surfaced honestly (section G). The substrate already exists in
disguise: lock acquisition, WorkIntent lifecycle, executor spawn/claim, the
bounded poll loop, `ensureDiscoveryWorkspace`, restart-resume, terminal
detection — these are all reusable across stages and need to be **extracted,
not rewritten**. The stage-specific logic (D2 normalization, D3 readiness, D4
settlement, D5 diagnosis) is already isolated in four services with the same
shape; wrapping each in a Node adapter is a mechanical refactor.

The plan is **strangler fig, not big-bang**. The old `Saga3DiscoveryEngine`
stays wired in production while a `Saga3NodeRunner` is built behind a flag.
When the runner produces byte-identical results on every existing test, we
flip the composition-root switch and retire the old engine.

---

## A. Inventarisation: substrate vs stage-specific

The full monolith is at `src/engines/saga3-discovery-engine.ts` (1151 lines).
Every line falls into one of two baskets.

### A.1 SUBSTRATE (reusable across all stages)

These concerns are not discovery-specific. They will be needed verbatim by a
hypothetical future `formalization` scenario. They belong in a `ScenarioRunner`
+ shared handles.

| Concern | Lines | Notes |
|---|---|---|
| Engine lock (acquire/release, duplicate-exit) | 218–245, 227 | `host.acquireEngineLock` / `releaseEngineLock` — pure substrate |
| Heartbeat sink | 222–223 | `(event, message) => host.heartbeat(...)` — generic |
| Workspace resolution | 258–261 | `persistence.workspaces.resolve(projectId)` |
| Restart-resume for WorkIntent (re-use open / concluded-with-proposal) | 263–303 | Reusable; the kind/objective/schema are the only stage inputs |
| Idempotent board-task projection (`ensureProjectedTask`) | 305–315 | Fully generic; takes `taskKind`, `skill`, `generationKey` |
| `prepareIntentForExecution` state machine (`ready` / `active` / `blocked` / `done`) | 339–343 | Generic; the port method is already kind-agnostic |
| Worker executor construction | 507–518 | Identical 12-line block is duplicated in normalization (92–104), readiness (121–133), diagnosis (461–473) — copy-paste smell proving this is substrate |
| `executor.start({ concurrency: 1, claimScope: { taskIds: [taskId] } })` | 526 | Generic |
| **Bounded poll loop with terminal detection** | 548–618 | The seven-way terminal classifier (`clean` / `task_blocked` / `executor_failed` / `executor_dead` / `stopped` / `timeout` / `task_unclaimed`) is **identical** in all four services modulo task id. This is the single biggest substrate signal in the codebase. |
| Stop/finally cleanup (`executor.stop` only on hard exit) | 622–624 | Generic |
| Intent CAS conclude-vs-pause | 628–629 | Generic (state transition on terminal) |
| Run-result envelope construction | 938–1042 | Generic shape; stage-specific fields go in a payload slot |
| `acquireEngineLock` PID fencing | 227 | Generic |

**Verdict:** approximately **480 of the 1151 lines** are substrate. The
identical 12-line executor-construction block and the ~70-line terminal
detection loop appear **four times** (engine + 3 services). DRY-ing these is
justified independently of the Node refactor.

### A.2 STAGE-SPECIFIC (discovery-only — moves into Node implementations)

| Concern | Lines | Belongs in |
|---|---|---|
| Discovery WorkIntent creation (`DISCOVERY_INTENT_KIND`, `DISCOVERY_WORK_INTENT_SCHEMA`, `DISCOVERY_ALLOWED_TOOLS`) | 12–121 | `DiscoveryWorkerNode` config |
| `ensureDiscoveryWorkspace` call (templates + tracker) | 331–337 | `DiscoveryWorkerNode` (or a Node-level `beforeRun` hook) |
| D2 normalization invocation (fresh + recovery path) | 355–373, 636–655 | `DiscoveryNormalizationNode` |
| Provisional outcome computation from proposal payload | 659–688 | `DiscoveryOutcomeNode` (or fold into worker node output projection) |
| `scopeCompleted` / `reason` terminal mapping | 698–719 | Terminal-aware post-processing in `DiscoveryWorkerNode` |
| `ensureStageTemplate('readiness', ...)` | 738–741 | `DiscoveryReadinessNode.beforeRun` |
| D3 readiness service call | 742–753 | `DiscoveryReadinessNode` |
| Readiness reconstruction for recovery (`reconstructReadinessShadow`) | 1052–1113 | `DiscoveryReadinessNode` recovery branch |
| D4 settlement eligibility (`eligibleForSettlement`) | 786–818 | `DiscoverySettlementGateNode` + `DiscoverySettlementNode` |
| D5 diagnosis eligibility + invocation (`runDiagnosis`) | 858–911 | `DiscoveryDiagnosisNode` |
| Authoritative outcome override logic in `runResult` | 978–998 | `DiscoverySettlementNode` output projection |
| `EngineSettlementResult` / `EngineDiagnosisResult` shape mappers | 40–82, 920–936 | `DiscoverySettlementNode` / `DiscoveryDiagnosisNode` output types |

**Verdict:** approximately **670 lines** are stage-specific. They decompose
naturally into 5 Node adapters (worker, normalization, readiness, settlement,
diagnosis) plus 2 Gate nodes (settlement-eligibility, diagnosis-eligibility).

### A.3 What does NOT move

The four domain services (`discovery-normalization-service.ts`,
`discovery-readiness-service.ts`, `discovery-settlement-service.ts`,
`discovery-diagnosis-service.ts`) **stay as-is**. They are already the
authoritative implementations of the stage work. The Nodes are thin adapters
that translate between the generic `Node.run(input, ctx)` contract and the
specific `service.normalize/assess/settle/diagnose` signatures.

This is a deliberate non-refactor: the services have been hardened across D2–D5
with P0/P1 fixes (exact-id binding, lineage verification, snapshot re-derivation,
I1/I2/I5 invariants). Touching them would re-open settled bugs.

---

## B. Node interface

The interface below is the contract every Node — worker, deterministic,
review, gate — satisfies. It is intentionally generic on `I` and `O` so a
scenario declares the data shape per-node, while the runner treats every node
opaquely.

```typescript
// src/saga3/scenario/node-contract.ts

/**
 * Discriminated union of the four Node mechanics. The runner uses `kind` to
 * route to the right handler (spawn-worker, call-service, poll-review,
 * evaluate-condition). Nodes that share a kind share a handler; the
 * per-instance behaviour is in `spec`.
 */
export type NodeKind =
  | 'worker_node'        // spawns an LM worker via WorkerExecutor, waits for submit
  | 'deterministic_node' // kernel computes synchronously, no LM
  | 'review_node'        // spawns an LM reviewer, waits for approve/changes_requested
  | 'gate_node';         // pure boolean condition, produces no artifact

/**
 * The handle every Node receives. Holds only substrate concerns; stage state
 * lives in `state` (per-scenario scratchpad) and `inputs` (named upstream
 * outputs). Built once per scenario run by the runner.
 */
export interface NodeContext {
  projectId: number;
  epicId: number;
  workspaceRoot: string;
  /** Substrate handles (already wired by composition root). */
  executorFactory: WorkerExecutorFactory;
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
  host: Saga2HostRuntime;
  config: SagaRuntimeConfig;
  /** Heartbeat sink bound to (projectId, epicId). */
  heartbeat: (event: string, message: string) => void;
  /** Wall clock + sleep injected for testability (mirrors existing services). */
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  maxRunMs: number;
  pollMs: number;
  /** Named outputs of completed upstream nodes (read-only view). */
  inputs: Readonly<ScenarioInputs>;
  /** Per-scenario mutable scratchpad, persisted between runs (see E.3). */
  state: ScenarioState;
}

/**
 * Per-Node declaration. `spec` is a free-form bag the handler interprets
 * (skill name for worker_node, service name for deterministic_node, predicate
 * source for gate_node). Typed via the registry (section D).
 */
export interface NodeSpec {
  id: string;          // unique within scenario, used in edges + inputs
  kind: NodeKind;
  produces?: string;   // name under which output lands in ctx.inputs
  spec: unknown;       // kind-specific configuration (typed at registration)
}

export type NodeStatus =
  | 'completed'   // produced its artifact, downstream may run
  | 'skipped'     // edge condition was false; produces nothing
  | 'paused'      // interrupted; restart resumes this node
  | 'failed'      // terminal failure; scenario aborts unless on-failure edge
  | 'waiting';    // produced nothing yet but is resumable (e.g. blocked task)

export interface NodeResult<O = unknown> {
  status: NodeStatus;
  output?: O;
  /** Cycles consumed (worker poll ticks). Summed into OrchestrationRunResult.cycles. */
  cycles?: number;
  error?: string;
  /** Optional metadata for heartbeat/observability, never authoritative. */
  meta?: Record<string, unknown>;
}

/**
 * A Node implementation. Stateless beyond injected deps; all state lives in
 * ctx.state and the persistence port. The runner calls run() once per node
 * per scenario execution.
 */
export interface Node<I = unknown, O = unknown> {
  readonly kind: NodeKind;
  run(input: I, ctx: NodeContext): Promise<NodeResult<O>>;
}
```

### B.1 Why one generic interface, not four

The four kinds differ in `spec` shape and in what they wait for, but the
runner's contract with every node is the same: take inputs + ctx, return a
result with one of five statuses. Keeping one interface means:
- The runner has one traversal algorithm, not four.
- Recovery is uniform: a paused node is re-entered, reads its scratch state,
  resumes.
- A future `interactive_node` (for `worker_ask_need`) drops in without changing
  the runner.

### B.2 What goes in Context (and what does NOT)

IN: substrate handles that any Node could need (executor, persistence, host,
config), run-scoped values (projectId, epicId, workspaceRoot), and the two
state bags (inputs, state).

NOT in Context: stage-specific service instances. Those are injected at Node
construction time (section D), not threaded through Context. This keeps
Context stable when a new Node kind is added.

---

## C. Scenario format

**Decision: TypeScript objects, not YAML.**

### C.1 Rationale

- **No new runtime dependency.** `package.json` has no `yaml`/`js-yaml`
  dependency today. Adding one for a feature used only at scenario-definition
  time is poor ROI; the discovery scenario is a single file.
- **Type safety.** A TS scenario gets compile-time checking on node ids, edge
  references, and `spec` shapes (via the registry's typed factory). YAML would
  need a separate schema validator.
- **IDE jump-to-definition, refactoring, breakpoints.** Free with TS.
- **The "declarative feel" of YAML is cosmetic.** A TS object literal with
  `as const` reads almost identically; what we lose is the ability for a
  non-coder to author scenarios. That is not a current use case — every
  scenario author will be a saga maintainer reading this document.

YAML becomes worth it only when (a) scenarios are user-supplied at runtime or
(b) there are >5 scenarios. Neither is true today or planned in scope.

### C.2 Full discovery scenario

This is the complete graph for the current `saga3-discovery-engine.run()`. It
covers linear (worker → readiness), conditional (settlement eligibility,
diagnosis eligibility), recovery (reuse concluded intent), and the loopback
edge that would carry a future retry on readiness rejection (section C.3).

```typescript
// src/saga3/scenario/discovery.scenario.ts

import { defineScenario } from './scenario-builder.js';

export const discoveryScenario = defineScenario({
  name: 'discovery',
  version: 'saga3.discovery.scenario.v1',

  // Lock + intent + workspace are setup handled by the runner BEFORE the first
  // node (they are substrate, section A.1). They appear here only as inputs
  // the first node consumes.
  inputs: {
    intent:    'WorkIntent',          // open/concluded-with-proposal, after restart-resume
    taskId:    'number',              // projected discovery.work task
    workspace: 'workspace descriptor',
  },

  nodes: [
    {
      id: 'worker',
      kind: 'worker_node',
      produces: 'proposal',
      spec: {
        skill: 'saga-discovery-worker',
        taskKind: 'discovery.work',
        allowedTools: [/* DISCOVERY_ALLOWED_TOOLS */],
        ensureWorkspace: true,        // run ensureDiscoveryWorkspace before spawn
        // Outcome projection: derive provisional outcome + scopeCompleted
        // from the worker's terminal state + submitted proposal.
      },
    },
    {
      id: 'normalization',
      kind: 'worker_node',
      produces: 'normalizedProposal',
      spec: {
        skill: 'saga-discovery-normalizer',
        serviceName: 'normalizationService',  // -> Saga3DiscoveryNormalizationService
        // Invoked only when raw.status === 'normalization_required' AND no
        // canonical proposal exists yet. The handler reads ctx.inputs.proposal
        // to decide eligibility.
      },
    },
    {
      id: 'readiness',
      kind: 'worker_node',
      produces: 'readinessShadow',
      spec: {
        skill: 'saga-discovery-readiness-advisor',
        serviceName: 'readinessService',
        ensureStageTemplate: { stage: 'readiness', fillFrom: 'proposal' },
      },
    },
    {
      id: 'settlement',
      kind: 'deterministic_node',
      produces: 'certificate',
      spec: {
        serviceName: 'settlementService',    // -> Saga3DiscoverySettlementService
        // Deterministic: policy.run(snapshot). No LM.
      },
    },
    {
      id: 'diagnosis',
      kind: 'worker_node',
      produces: 'diagnosisReport',
      spec: {
        skill: 'saga-discovery-diagnosis-advisor',
        serviceName: 'diagnosisService',
        ensureStageTemplate: { stage: 'diagnosis', fillFrom: 'certificate' },
      },
    },
    {
      id: 'settlementEligibility',
      kind: 'gate_node',
      spec: {
        // True iff worker reached 'completed' + scopeCompleted + clean terminal
        // + valid proposal. Mirrors lines 786-790 of the current engine.
        predicate: 'worker.scopeCompleted && worker.terminal === "clean" && proposal.valid',
      },
    },
    {
      id: 'diagnosisEligibility',
      kind: 'gate_node',
      spec: {
        // True iff settlement issued a certificate authoritatively.
        predicate: 'certificate.status === "issued" && certificate.id !== null',
      },
    },
  ],

  edges: [
    // Worker closure may trigger normalization if the raw submission needs it.
    { from: 'worker', to: 'normalization',
      when: 'worker.terminal === "clean" && raw.status === "normalization_required" && !proposal.canonical' },
    // Worker or normalization produces the canonical proposal.
    { from: 'worker',    to: 'settlementEligibility', when: 'true' },
    { from: 'normalization', to: 'settlementEligibility', when: 'true' },

    // Settlement eligibility gate -> readiness (always run readiness when
    // eligible, even on a failed/paused readiness — settlement fail-closes).
    { from: 'settlementEligibility', to: 'readiness',
      when: 'settlementEligibility.passed' },
    { from: 'readiness', to: 'settlement', when: 'true' },

    // Diagnosis only on an authoritative certificate.
    { from: 'settlement', to: 'diagnosisEligibility', when: 'true' },
    { from: 'diagnosisEligibility', to: 'diagnosis',
      when: 'diagnosisEligibility.passed' },
  ],

  terminal: {
    // Scenario completes when the diagnosis node has a verdict (completed,
    // failed, paused, not_run) OR settlement never issued and diagnosis was
    // skipped. The terminal projection maps node outputs to the existing
    // OrchestrationRunResult envelope (section E.4).
    when: 'diagnosis.status in ("completed","failed","paused","not_run") || settlement.status !== "issued"',
    project: 'discoveryTerminalProjection',  // function reference, section E.4
  },

  // Retry / loopback. Today readiness runs once; on a failed readiness the
  // settlement fail-closes to 'clarify' (current behaviour). This edge is
  // declared but UNUSED until a future iteration adds an explicit retry policy.
  retryEdges: [
    // { from: 'readiness', to: 'readiness', when: 'readinessShadow.status === "failed"',
    //   maxRetries: 1, onlyIf: 'policy.allowsReadinessRetry' },
  ],
});
```

### C.3 Note on the "loopback" the concept asks for

The concept spec mentions `readiness rejected → retry`. The current engine
does NOT retry readiness: a failed readiness shadow is fed to settlement,
which fail-closes to `clarify`. That is the authoritative D4 decision and is
correct (re-running an advisor that already failed would risk loops). The
plan therefore **declares** the retry edge as future-only (`retryEdges`,
commented) and does NOT implement it. Trying to add it now would contradict
the I1/I5 invariants (D3 shadow is ADVISORY; the kernel cannot retry its way
out of a clarify verdict without a fresh Proposal).

This is friction point #1 (section G): the concept's "loopback" feature is
not currently exercised by discovery, and wiring it would require an as-yet-
unwritten retry policy. We do not pretend the runner supports it.

---

## D. Node registry

**Decision: typed factory map, populated explicitly in composition root. No
decorators, no plugin auto-discovery.**

### D.1 Mechanism

```typescript
// src/saga3/scenario/node-registry.ts

export interface NodeFactory<TSpec> {
  (spec: TSpec, services: ScenarioServices): Node;
}

export class NodeRegistry {
  private readonly factories = new Map<string, NodeFactory<any>>();

  register<TSpec>(nodeType: string, factory: NodeFactory<TSpec>): void {
    if (this.factories.has(nodeType)) {
      throw new Error(`node type '${nodeType}' already registered`);
    }
    this.factories.set(nodeType, factory);
  }

  /**
   * Resolve a NodeSpec into a runnable Node. `nodeType` is conventionally
   * `${kind}:${spec.serviceName ?? spec.skill ?? kind}` — e.g.
   * 'worker_node:saga-discovery-readiness-advisor'.
   */
  resolve(spec: NodeSpec, services: ScenarioServices): Node {
    const nodeType = `${spec.kind}:${(spec.spec as any).serviceName ?? (spec.spec as any).skill ?? spec.kind}`;
    const factory = this.factories.get(nodeType);
    if (!factory) throw new Error(`no node registered for '${nodeType}'`);
    return factory(spec.spec, services);
  }
}

export interface ScenarioServices {
  normalizationService: DiscoveryNormalizationService;
  readinessService: DiscoveryReadinessService;
  settlementService: DiscoverySettlementService;
  diagnosisService: DiscoveryDiagnosisService;
}
```

### D.2 Why this shape

- **Explicit registration in composition root** mirrors how the current
  services are wired (`composition-root.ts:101-138`). The architecture test
  at `tests/architecture/saga2-boundaries.test.mjs:540` already asserts
  single-construction-site discipline; we extend that test to cover the
  registry.
- **No decorators / no auto-discovery.** Auto-discovery (filesystem scan,
  `import.meta.glob`) is a footgun in a codebase with strict Phase B
  boundaries: it would let any file silently register a Node and bypass the
  single-composition-root invariant.
- **`ScenarioServices` is a closed bag.** Adding a new service requires
  editing the bag + composition root + the relevant Node — three deliberate
  touches, no magic. This is the right amount of friction for a governance-
  oriented codebase.

### D.3 Built-in node-type registrations

The runner ships with four universal node types mapped to handlers:

| `kind` | Handler responsibility |
|---|---|
| `worker_node` | Calls `ensureControl` (if service has it), `prepareIntentForExecution`, restart-resume early-exit, executor spawn, bounded poll loop (the shared substrate from A.1), CAS conclude/pause, returns `{status, output, cycles}` |
| `deterministic_node` | Calls `service.method(input)` synchronously, wraps thrown errors into `status: 'failed'` |
| `review_node` | Same as worker_node but waits for `worker_done` with `verdict: 'approved' \| 'changes_requested'` (used by future requirements/architecture review; NOT exercised in discovery scope) |
| `gate_node` | Evaluates a predicate (sandboxed expression evaluator over `ctx.inputs`), returns `{status: 'completed', output: {passed: boolean}}` |

The per-skill / per-service differentiation is in the **factory**, which
binds the right service method + output projection. There is exactly one
worker_node handler in the runner; `DiscoveryWorkerNode`,
`DiscoveryReadinessNode`, `DiscoveryDiagnosisNode`, `DiscoveryNormalizationNode`
are thin factory products that inject their service.

---

## E. Scenario runner

### E.1 Traversal algorithm

Topological order with condition evaluation. NOT event-driven. Rationale: the
current engine is already imperative top-to-bottom; event-driven would be a
paradigm shift with no benefit on a 5-node DAG and significant restart-
recovery complexity (where do we replay events from?).

```
function runScenario(scenario, ctx):
  1. Load persisted scenario state (ctx.state) from episode_workflows.metadata
     (see E.3). State includes per-node {status, output, cycles}.

  2. Compute the set of "ready" nodes: nodes whose every incoming edge's
     `when` predicate evaluates true against ctx.inputs (populated from
     upstream node outputs) AND whose own status is not 'completed'.

  3. While ready set is non-empty:
     a. Pick the ready node with the lowest declared order (scenarios
        declare nodes in execution order; edges are a consistency check).
     b. If node.status === 'paused' or 'waiting', RESUME (re-call run();
        the node reads its scratch state and decides whether to spawn or
        to return the durable persisted output — exactly the pattern the
        existing services follow).
     c. Resolve Node via registry, call run(input, ctx).
     d. Persist node.status + output to ctx.state immediately (atomic write
        to episode_workflows.metadata — see E.3).
     e. If status === 'completed' && produces, publish output to ctx.inputs
        under that name.
     f. If status === 'failed' and no `on-failure` edge exists, abort the
        scenario with the existing top-level failure projection.

  4. Evaluate terminal condition. If met, project terminal result. If not
     (e.g. some node is paused and waiting for restart), return reason=
     'paused_timeout' / 'stopped' so the host re-enters later.
```

### E.2 Conditions, loops, retry, failure

- **Conditions**: edges carry a `when` string. Evaluated by a minimal
  expression evaluator (a 30-line Pratt parser over `&&`, `||`, `===`, `!==`,
  `in`, member access, literals). This is deliberately NOT `eval()` and NOT
  `Function()` — those are security holes in a governance system. The
  evaluator returns a boolean; on parse error the edge is treated as
  unsatisfiable (fail-safe).

- **Loops**: the algorithm has no inherent loop. The DAG as declared is
  acyclic. A retry edge (section C.3 `retryEdges`) is special-cased: after a
  node produces a result, the runner checks retry edges and may re-queue the
  same node id with `attempt: N+1` in scratch state, up to `maxRetries`.
  Discovery ships with zero retry edges.

- **Failure**: a failed node with no `on-failure` edge aborts the scenario.
  The terminal projection maps this to the existing `OrchestrationRunResult`
  with `reason='failed'`, mirroring today's `terminal !== 'clean'` mapping.
  A failed node WITH an `on-failure` edge (declared but unused in discovery)
  routes to the fallback node — this is the hook for the future
  `autonomous-recovery` integration.

### E.3 State storage between nodes (and between runs)

**Decision: store scenario state in `episode_workflows.metadata` as a JSON
blob under a `scenario` key. No new table.**

The `episode_workflows` table already has a `metadata` JSON column (used by
`sqlite-saga2-runtime-repositories.ts:145` via `json_set`). It is keyed by
`epic_id`, which is exactly the scenario scope. Schema:

```json
{
  "scenario": {
    "name": "discovery",
    "version": "saga3.discovery.scenario.v1",
    "startedAt": "2026-07-25T...",
    "nodes": {
      "worker":     { "status": "completed", "output": { /* proposal ref */ }, "cycles": 4, "attempt": 1 },
      "readiness":  { "status": "paused",    "output": null, "cycles": 0, "attempt": 1 },
      "settlement": { "status": "pending" }
    },
    "terminalReason": null
  }
}
```

**Why not a new `scenario_state` table:**
- The current engine persists its progress implicitly through the WorkIntent
  / ControlIntent / Proposal / Settlement rows. Those rows ARE the recovery
  state. Adding a parallel state table risks drift (the two sources of truth
  disagreeing). The `metadata.scenario` blob is a **cache of the DAG
  position**, derivable from the existing rows; if it is lost, the runner
  rebuilds it on restart by probing the existing rows (does an accepted
  proposal exist? a settlement? a certificate?) — exactly the recovery logic
  the current engine already has at lines 264-303 and 348-502.
- A new table means a new migration (`src/db.ts`), new port methods, new
  architecture-boundary test. For a cache, that is over-engineering.

**Atomicity:** each node status update is a single `json_set` statement
inside the existing `UPDATE episode_workflows` path used by
`updateWorkflowMetadata`. No new transaction concerns.

### E.4 Terminal projection

A scenario declares a `terminal.project` field naming a function. For
discovery this is `discoveryTerminalProjection`, which takes the final
`ctx.inputs` and `ctx.state` and produces the existing
`OrchestrationRunResult` envelope — including the `provisional`,
`readiness`, `settlement`, `diagnosis` sub-objects. The projection function
is the **only** place where the new top-level `OrchestrationRunResult` shape
is constructed; it is a direct transcription of the existing
`runResult` method (lines 938-1042), so byte-identical output is achievable
and testable.

---

## F. Migration strategy (phased strangler fig)

Every phase is one or more commits. Every commit leaves the test suite green.
Production stays on the old engine until Phase 5.

### Phase 0 — Pre-flight (no behaviour change)

**Commit 0a**: Extract the duplicated bounded poll loop.

The 70-line terminal-detection loop is copy-pasted across
`saga3-discovery-engine.ts:548-618`,
`discovery-normalization-service.ts:125-137`,
`discovery-readiness-service.ts:155-167`,
`discovery-diagnosis-service.ts:489-500`. Extract to a shared helper
`runBoundedWorker(executor, rt, taskId, { now, sleep, maxRunMs, pollMs }): Promise<{terminal, cycles}>`
in `src/saga3/application/worker-lifecycle.ts`. All four callers delegate.
- Tests: existing d1–d5 stay green (refactor only).
- Risk: low. The extracted helper is the loop verbatim.

**Commit 0b**: Extract the duplicated executor-construction block.

The 12-line `workerExecutorFactory({ ... })` block appears 4 times. Extract
to `buildExecutor(factory, host, config, ctx)` in the same shared module.
- Tests: green.

**Why before the Node work:** these extractions are pure DRY wins, justified
independently. They also make the eventual Node handlers trivial — each
calls `runBoundedWorker` instead of inlining the loop. If the Node refactor
is delayed or cancelled, Phase 0 still ships value.

### Phase 1 — Node contract + runner skeleton (not wired)

**Commit 1a**: Add `src/saga3/scenario/node-contract.ts` with the interfaces
from section B. No implementations yet.
- Tests: a type-only test asserting the discriminated union exhaustiveness.

**Commit 1b**: Add `src/saga3/scenario/node-registry.ts` (section D).
- Tests: unit test — register a fake factory, resolve a spec, assert the
  Node is returned; assert duplicate registration throws; assert unknown
  node type throws.

**Commit 1c**: Add `src/saga3/scenario/scenario-runner.ts` with the
algorithm from E.1. Initially only the `worker_node` and `gate_node` kinds
are implemented; `deterministic_node` and `review_node` return a stub.
- Tests: scenario-runner.test.mjs with a 3-node fake scenario
  (gate → worker → gate) using in-memory fakes modeled on the existing
  `makeFakeRuntime` / `makeFakeExecutor` from `tests/saga3/d1-engine.test.mjs`.

**Commit 1d**: Add `src/saga3/scenario/scenario-state.ts` — read/write the
`episode_workflows.metadata.scenario` blob with the rebuild-from-existing-
rows fallback described in E.3.
- Tests: state-persistence.test.mjs — write a blob, read it back, simulate
  blob loss and assert rebuild recovers node positions from faked
  WorkIntent/Proposal/Settlement rows.

Nothing in Phase 1 is reachable from production. The composition root still
returns `Saga3DiscoveryEngine`.

### Phase 2 — Discovery Node adapters (mechanical wraps)

Each adapter is one commit so a regression bisects cleanly.

**Commit 2a**: `DiscoveryWorkerNode` — wraps the engine's lines 263–688
(intent + projection + workspace + executor spawn + poll + outcome). Output:
`{ proposal, terminal, scopeCompleted, cycles }`. Uses `runBoundedWorker`.

**Commit 2b**: `DiscoveryNormalizationNode` — wraps
`normalizationService.normalize`. Output: `{ proposal, cycles, error }`.

**Commit 2c**: `DiscoveryReadinessNode` — wraps `readinessService.assess` +
`ensureStageTemplate('readiness')`. Output: `{ shadow, cycles }`. Includes
the recovery reconstruction (`reconstructReadinessShadow`, lines 1052-1113)
as the node's resume branch.

**Commit 2d**: `DiscoverySettlementNode` — wraps `settlementService.settle`.
Output: `{ settlement: EngineSettlementResult }`. Note: the authoritative
override logic from `runResult` lines 978-998 lives here, not in the runner.

**Commit 2e**: `DiscoveryDiagnosisNode` — wraps `diagnosisService.diagnose` +
`ensureStageTemplate('diagnosis')`. Output: `{ diagnosis: EngineDiagnosisResult }`.

**Commit 2f**: The two gate nodes (`settlementEligibility`,
`diagnosisEligibility`) and the `discoveryTerminalProjection` function.

Each adapter has its own unit test that calls `node.run(input, ctx)` with a
fake `NodeContext` and asserts the output matches what the corresponding
service produces today. These tests are written BEFORE the adapter by
capturing today's outputs as fixtures.

### Phase 3 — Discovery scenario + parallel wiring

**Commit 3a**: Add `src/saga3/scenario/discovery.scenario.ts` (section C.2).
Register all adapters in a new `buildDiscoveryRegistry(services)` function.

**Commit 3b**: Add `Saga3NodeRunnerEngine implements OrchestrationEngine`.
Its `run(command)` constructs a `NodeContext`, loads scenario state, invokes
`scenarioRunner.run(discoveryScenario, ctx)`, applies
`discoveryTerminalProjection`, returns the `OrchestrationRunResult`.

**Commit 3c (wiring, behind a flag)**: In `composition-root.ts`, branch on a
new env var `SAGA3_NODE_RUNNER=1`. When set, return `Saga3NodeRunnerEngine`
instead of `Saga3DiscoveryEngine`. Default: unset (old engine stays in
production).
- Architecture test updated: `new Saga3DiscoveryEngine` count stays 1;
  `new Saga3NodeRunnerEngine` count is at most 1; both selected only via
  `isSaga3DiscoveryMode` + the new flag.

### Phase 4 — Parity testing (the long pole)

**Commit 4a**: Add a parity test harness `tests/saga3/node-runner-parity.test.mjs`
that runs BOTH engines against every fixture from `d1-engine.test.mjs` and
asserts the resulting `OrchestrationRunResult` objects are deep-equal modulo
`endedAt`. This is the single most important test of the migration.

**Commit 4b–4e**: One commit per d-slice parity fix. Friction points (section
G) surface here. Each fix is small and pinned to a specific fixture.

**Commit 4f**: Run the parity harness against the d2/d3/d4/d5 engine-level
tests (normalization-lifecycle, readiness-lifecycle, settlement-engine,
diagnosis-engine). Where the existing tests instantiate
`Saga3DiscoveryEngine` directly, add a parallel suite that instantiates
`Saga3NodeRunnerEngine` with the same fakes. The two suites must agree.

Phase 4 is complete when: every existing saga3 engine test has a node-runner
twin, and both pass.

### Phase 5 — Cutover

**Commit 5a**: Flip the composition-root default — `SAGA3_NODE_RUNNER`
defaults to `1`, the old engine is reached only with `SAGA3_NODE_RUNNER=0`.
Run a live epic end-to-end through the node runner first.

**Commit 5b (after a soak period)**: Delete `Saga3DiscoveryEngine` and its
direct tests. The architecture test's single-construction-site assertion is
updated to `Saga3NodeRunnerEngine`. The four domain services, the shared
worker-lifecycle module, and the scenario infrastructure remain.

**Commit 5c**: Remove the `SAGA3_NODE_RUNNER` flag (no longer needed).

### Why strangler fig, not big-bang

- The discovery pipeline is in active use (recent commits 9666c69, 6498d87,
  34fd152 are bug fixes from real epic runs). A big-bang replace would
  freeze those fixes for the duration of the refactor.
- The restart-recovery logic (lines 264-303, 348-502, 1052-1113) is the
  hardest part of the engine and the part most likely to regress. The
  strangler approach lets us keep the hardened recovery in production while
  building the parallel path; the parity harness is the proof.
- Every commit is independently revertible. If Phase 4 reveals an
  irreconcilable friction point, Phase 5 simply never happens and we ship
  Phase 0's DRY wins + Phase 1's scenario infrastructure as dormant code.

---

## G. Risks and friction points (honest)

### G.1 Friction: the concept's "loopback / retry" is not present in discovery

The concept spec shows `readiness rejected → retry`. The current engine
intentionally does NOT do this (section C.3): D3 is advisory, D4 fail-closes
on a failed readiness, retrying the advisor would risk loops and contradict
the I1/I5 invariants. The scenario therefore declares the edge as
`retryEdges` and leaves it commented. **The runner supports the
mechanism but discovery does not use it.** If a future iteration needs
readiness retry, the retry policy must be written first (a domain decision,
not a runner decision).

### G.2 Friction: the terminal detection loop has subtle ordering

The seven-way terminal classifier checks `runFailed` BEFORE `clean` (lines
585-588) so a substrate failure is not masked as a clean closure. The
extracted `runBoundedWorker` must preserve this exact ordering. The parity
test at `d1-engine.test.mjs:422-455` (task done + run.status=failed →
reason=failed) is the canary. Risk: medium. Mitigation: the helper is the
loop verbatim, plus the parity test.

### G.3 Friction: recovery reconstruction is duplicated knowledge

`reconstructReadinessShadow` (lines 1052-1113) and the readiness service's
`shadowFrom` (readiness-service.ts:241-312) encode the same projection
(accepted→completed, rejected→failed, etc.) in two places. The Node adapter
must NOT introduce a third copy. Risk: medium. Mitigation: the
`DiscoveryReadinessNode` resume branch calls the service's
`shadowFrom`-equivalent (extracted to a shared `projectReadinessShadow`
helper as part of Phase 0c if Phase 0 grows).

### G.4 Risk: MCP tools and the authority gateway

The discovery worker's allowed-tools list (`DISCOVERY_ALLOWED_TOOLS`, lines
105-121) is enforced at the MCP gateway (`authorizeSagaToolCall`), not in the
engine. The Node adapter must thread the same `authority_scope` into the
WorkIntent it creates. Risk: low — the adapter reuses `createIntent`
verbatim. But this is an invariant that no test in `tests/saga3/` directly
exercises on the engine path; the `d1-1-authority.test.mjs` suite tests the
gateway, not the engine. Mitigation: the parity test must include at least
one scenario that asserts the created WorkIntent's `authority_scope.allowed_tools`
matches between the two engines.

### G.5 Risk: LM worker spawn — the substrate is identical but timing is not

Both engines call the same `workerExecutorFactory` and the same
`executor.start`, so the spawn mechanism is shared. But the Node runner adds
one extra layer of indirection (registry → factory → handler → service). If
that layer swallows a thrown error that the old engine surfaced, restart-
recovery diverges. Risk: medium. Mitigation: the Node contract requires
`NodeResult.status === 'failed'` with the error message on any thrown
exception; the parity harness includes a "spawn throws" fixture.

### G.6 Risk: tests

The d1–d5 test suites instantiate `Saga3DiscoveryEngine` directly in many
places (see `tests/saga3/d1-engine.test.mjs:190,213,232,...`). These tests
will continue to pass on the old engine throughout Phases 1–4. The risk is
that they are NOT migrated to the new engine and silently rot. Mitigation:
Phase 4 creates parallel `*-node-runner.test.mjs` twins for every test that
exercises the engine directly. Phase 5 deletes the old tests with the old
engine. There must be no moment where a behaviour is covered only on the
retiring engine.

### G.7 Risk: `ensureDiscoveryWorkspace` regression

The DO-NOT-DELETE guard in `ensure-discovery-workspace.ts:1-46` documents a
real regression: deleting the workspace-seeding call broke epic 33. The
`DiscoveryWorkerNode` adapter MUST preserve the call. Risk: low if the
adapter construction is a verbatim transcription; high if a future "clean-
up" removes it. Mitigation: the existing
`tests/saga3/d1-workspace-creation.test.mjs` stays in place and a new
`tests/saga3/node-runner-workspace-creation.test.mjs` asserts the node path
also calls `ensureDiscoveryWorkspace`.

### G.8 Risk: restart-recovery parity

The hardest parity test. The current engine has three recovery entry points
(intents reuse at 264-303, task-done-with-existing-proposal at 348-502,
readiness-control-resume at 405-445). The Node runner's recovery must
produce the same decisions from the same persisted rows. Risk: high.
Mitigation: Phase 4 includes a dedicated `node-runner-recovery-parity.test.mjs`
that exercises the three entry points and asserts identical node-state
outcomes. This is the test most likely to surface a real bug.

---

## H. Out of scope

- **Saga2 / `Saga2Engine` / `src/orchestrate.ts`.** Untouched. The
  `OrchestrationEngine` port stays as the common boundary; only the saga3
  side gets a new implementation.
- **Formalization / development / verification scenarios.** Mentioned in
  section C as proof the architecture generalises (the same runner, the same
  four node kinds, would host a formalization scenario with
  `requirements_reviewer` review nodes). NOT implemented or designed in
  detail. Designing them now would violate scope discipline — they raise
  questions (multi-repository scenarios, review loops, verification
  evidence) that have no answer in the discovery codebase.
- **The four domain services** (`discovery-{normalization,readiness,
  settlement,diagnosis}-service.ts`). They stay as-is. Nodes are adapters.
- **`review_node` exercise.** Registered, handler stubbed, not used by
  discovery. Real review nodes belong to formalization scope.
- **A `scenario_state` table.** Rejected in favour of
  `episode_workflows.metadata` (E.3).
- **YAML scenarios.** Rejected in favour of TS (C.1).
- **Auto-discovery of Nodes.** Rejected in favour of explicit composition-
  root registration (D.2).
- **Readiness retry / loopback.** Declared but inactive (C.3, G.1).
- **Engine administration UI / tracker-view changes.** Out of scope; the
  `OrchestrationRunResult` envelope is unchanged so existing viewers keep
  working.

---

## I. Tracing back to the codebase

| Plan element | Source file:line |
|---|---|
| Substrate boundary | `src/engines/saga3-discovery-engine.ts:218-245, 258-303, 507-618` |
| Stage-specific logic | `src/engines/saga3-discovery-engine.ts:331-337, 659-719, 786-911, 938-1042` |
| Bounded poll loop (×4 copies) | engine 548-618; normalization 125-137; readiness 155-167; diagnosis 489-500 |
| Executor construction (×4 copies) | engine 507-518; normalization 92-104; readiness 121-133; diagnosis 461-473 |
| Recovery entry points | engine 264-303, 348-502, 1052-1113 |
| DO-NOT-DELETE workspace guard | `src/saga3/application/ensure-discovery-workspace.ts:1-46` |
| Composition root single switch | `src/app/composition-root.ts:95-149` |
| Architecture boundary test | `tests/architecture/saga2-boundaries.test.mjs:526-617` |
| Engine lock / PID fencing | `src/application/ports/saga2-host-runtime.ts:15-42` |
| `OrchestrationRunResult` envelope | `src/application/ports/orchestration-engine.ts:24-147` |
| `episode_workflows.metadata` | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:145` |
| d1–d5 test surface | `tests/saga3/d1-engine.test.mjs` + d2/d3/d4/d5 siblings |

---

## J. Stage Package Contract — терминология и привязка артефактов

Этот раздел закрепляет терминологию и контракт привязки, выработанные в
диалоге (после того, как план A-I был написан). Цель — чтобы команда и
будующие авторы stage'ей говорили на одном языке и знали, **куда что
положить** при добавлении новой стадии ЖЦ.

### J.1 Терминология (фиксированная)

| Термин | Определение | Пример |
|---|---|---|
| **Stage** (стадия) | Крупный блок ЖЦ продукта. На верхнем уровне оркестрации episode loop проходит именно по стадиям. | discovery, formalization, planning, development, verification, integration |
| **Node** (узел) | Атомарная работа **одного типа** внутри Stage, производящая **один артефакт**. Граница Node = готовность её артефакта. | discovery-worker (→proposal), settlement (→certificate), readiness (→assessment) |
| **Skill** | Инструкция для LM **внутри одной Node**. Один skill = одна Node; skill не переиспользуется между Node'ами. | saga-discovery-worker, saga-discovery-readiness-advisor |
| **Scenario** | DAG из Node с edge-conditions, описывающий всю Stage. | discovery.scenario.ts |
| **Episode orchestrator** | Внешний слой: проходит по Stage'ам ЖЦ (discovery → formalization → …). Не лезет внутрь Stage. | (будет) episode loop |
| **Scenario runner** | Внутренний слой: проходит по Node'ам внутри одной Stage по DAG. | ScenarioRunner |

**Принцип границы Node:** Node заканчивается, когда её артефакт готов
(proposal submitted / assessment accepted / certificate issued / report
submitted). Это объективный критерий, заменяющий расплывчатое "логически
завершённый сценарий".

### J.2 Пять этапов Discovery = пять Node

Discovery разбивается на 5 Node (а не на 3, как кажется из tracker —
tracker показывает только LM-этапы, опуская settlement/certificate):

| # | Node | kind | Артефакт | Кто |
|---|---|---|---|---|
| 1 | discovery worker | worker_node | Proposal | LM |
| 2 | readiness advisor | worker_node | Assessment (shadow) | LM |
| 3 | settlement | deterministic_node | Decision + Settlement row | ядро |
| 4 | certificate | deterministic_node | Certificate (immutable) | ядро |
| 5 | diagnosis advisor | worker_node | Diagnosis report (shadow) | LM |

(Plus опциональный normalization worker_node между 1 и 2, если raw proposal
невалиден.)

**Цель Discovery** = выдать Certificate с авторитетным decision
(go/clarify/reject). Diagnosis — advisory добивка, не блокирует verdict.

### J.3 Привязка артефактов (главная таблица)

Это ответ на вопрос "куда привязывать skill/template/hook/MCP".

| Артефакт | Привязан к | Где живёт | Создаётся |
|---|---|---|---|
| **Skill** (SKILL.md) | **Node** (`spec.skill`) | `skills/<skill-name>/SKILL.md` | один раз при создании Node |
| **Tool template** (*-call-template.json) | **Node** | `tool-templates/<stage>/` | один раз; копируется движком в `docs/<stage>/tools/` (ensureDiscoveryWorkspace) |
| **Checklist** (*-checklist.md) | **Node** | рядом с template | один раз |
| **Stage tracker** (stage-tracker.md) | **Stage** | `tool-templates/<stage>/stage-tracker.md` | один раз; копируется в `docs/<stage>/project-N-<stage>-stage.md` с подставленными ID |
| **Discovery doc skeleton** | **Node** | `tool-templates/<stage>/discovery-doc-template.md` | один раз |
| **PostToolUse hook** | **глобальный** (один на весь движок) | `tracker-reminder.mjs` | один раз; логика внутри зависит от stage (через SAGA_TASK_KIND env) |
| **MCP substrate tools** | **движку** (переиспользуются всеми Stage) | `src/tools/tasks.ts`, `dispatcher.ts`, … | один раз |
| **MCP stage-specific tools** | **Stage** | `src/tools/saga3-*.ts` | **да, новые под каждую Stage** |

### J.4 Stage = самодостаточный пакет

Каждая Stage декларирует свой "пакет" (skills + templates + MCP tools +
nodes + scenario). Движок грузит нужный Stage по имени и активирует пакет.

```typescript
// Гипотетическая декларация (data, не код движка)
const discoveryStage = {
  name: 'discovery',
  scenario: discoveryScenario,                    // DAG из 5 Node
  skills: ['saga-discovery-worker',
           'saga-discovery-readiness-advisor',
           'saga-discovery-diagnosis-advisor',
           'saga-discovery-normalizer'],
  templates: ['proposal-call-template.json',
              'readiness-call-template.json',
              'diagnosis-call-template.json',
              'normalization-call-template.json',
              'discovery-doc-template.md'],
  mcpTools: ['proposal_submit',
             'readiness_get', 'readiness_submit',
             'diagnosis_get', 'diagnosis_submit',
             'normalization_get', 'normalization_submit'],
  tracker: 'stage-tracker.md',
}

const formalizationStage = {
  name: 'formalization',
  scenario: formalizationScenario,                // (будущее)
  skills: ['saga-product', 'saga-analyst', 'saga-architect',
           'saga-reconciler', 'saga-requirements-reviewer',
           'saga-architecture-reviewer'],
  templates: ['prd-template.md', 'uc-template.md', 'ac-template.md',
              'srs-template.md'],
  mcpTools: ['artifact_create', 'trace_add', 'baseline_stamp'],
  tracker: 'formalization-tracker.md',
}
```

### J.5 Два класса MCP tools

Это важный архитектурный шов, отвечающий на вопрос "нужно ли создавать
новые MCP под каждый цикл жизни":

**Корзина 1 — Substrate tools (переиспользуются ВСЕМИ Stage):**

| Tool | Зачем |
|---|---|
| `task_get`, `task_create`, `task_update`, `task_list` | задачи |
| `worker_next`, `worker_done`, `worker_ask_need` | worker claim/release |
| `worker_merge_acquire`, `worker_merge_release` | merge lock (для dev) |
| `repository_checkout_list`, `repository_register` | workspace |
| `artifact_list`, `note_list`, `note_save` | observability |
| `episode_transition` | переход Stage ЖЦ |
| `verification_record` | evidence |

Эти MCP tools создаются **один раз**. Formalization/development будут их
использовать без изменений.

**Корзина 2 — Stage-specific tools (свои для каждой Stage):**

| Stage | Stage-specific MCP tools |
|---|---|
| Discovery | `proposal_submit`, `readiness_get/submit`, `diagnosis_get/submit`, `normalization_get/submit` |
| Formalization (будущее) | `artifact_create` (PRD/UC/AC/SRS), `trace_add`, `baseline_stamp` |
| Development (будущее) | `merge_request`, `integration_state_update` |

Stage-specific tools **привязаны к домену стадии**. `proposal_submit` не
имеет смысла в formalization (там нет proposal, там PRD). Поэтому для каждой
новой Stage — **своя корзина stage-specific MCP handlers**.

**Trade-off explicit vs generic:** можно было бы сделать один
`stage_submit({ stage, artifact_type, payload })` вместо N явных submit'ов.
Текущий выбор saga3 — explicit (своя валидация, свой persistence, свой
schema_version на каждый submit). Formalization уже идёт generic
(`artifact_create` принимает type). Development — снова explicit
(merge-специфика). Решение остаётся за автором каждой Stage.

### J.6 Стратегия "отточить один Stage, потом универсализировать"

Подтверждённая в диалоге стратегия (strangler fig, фазы 1-5 из раздела F):

1. **Сейчас (фазы 1-4):** добиваем Discovery Stage на текущем монолите
   `saga3-discovery-engine.run()`. Доказываем, что Stage проходит end-to-end
   (epic 35 — последний рубеж, diagnosis после фикса валидатора 8449555).
2. **Потом (фаза 5):** выносим `run()` в `DiscoveryScenario` (DAG из 5 Node),
   движок становится универсальным интерпретатором сценариев.
3. **Дальше (будущее):** добавляем FormalizationScenario, DevelopmentScenario
   — **новые scenario-файлы + новые skill/template/MCP-пакеты**. Код
   движка не трогаем.

**Главный принцип:** Stage = data (scenario + skills + templates +
MCP bindings). Substrate = code (executor + worker_* + task_* + recovery +
worktree). Когда добавляешь Stage — пишешь data-пакет + регистрируешь
stage-specific MCP handlers. Движок остаётся прежним.

### J.7 Что НЕ меняется при добавлении новой Stage

- WorkerExecutor (spawn + poll + recovery)
- Typed tasks + provenance
- worker_next / worker_done / worker_ask_need
- Idempotency, restart recovery, stale execution cleanup
- Worktree + merge lock
- Skill/template/tracker инфраструктура (ensureDiscoveryWorkspace обобщается
  до `ensureStageWorkspace(workspaceRoot, stageName, epicId, ...)`)
- PostToolUse hook mechanism (меняется только логика внутри hook)

### J.8 Что ДА, создаётся новое под каждую Stage

- Skill'ы (по одному на каждую worker/review Node)
- Tool templates + checklists (по паре на каждую Node со stage-specific submit)
- Stage tracker (один на Stage)
- Stage-specific MCP tool handlers (корзина 2 из J.5)
- Scenario-файл (DAG из Node)

**Большая часть — data.** Кода нового — только MCP handlers для
stage-specific tools.

