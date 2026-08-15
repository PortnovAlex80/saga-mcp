# Saga4 Factory Contract Harness and Durable Production Refactoring Plan

Architecture and implementation blueprint — no source-code changes in this run

| Item | Value |
|---|---|
| Repository | PortnovAlex80/saga-mcp |
| Branch | saga4 |
| Baseline | ded7ebfb17faf5496ff05f0e69e486798371ba4d |
| Baseline change | Bug #4 — node-durable managed-production product reader (CGAD P18) |
| Primary architecture | docs/architecture/CONVEYOR-MENTAL-MODEL.md — Version 4.3 |
| Purpose | Make the Factory state machine executable and exhaustively testable without LLM inference, while reconciling CGAD P18 with Workplace/CandidateSet/Replay semantics. |

This document is intended to be the starting artifact for the next implementation session.

---

## 0. Executive decision

Bug #4 is a valid and necessary repair: the gate must not become blind to durable work merely because the latest WorkerExecution changed. However, the final architectural rule should not be phrased as "all managed production is node-wide". The Conveyor model already defines the durable unit more precisely: the Workplace.

```
WorkerExecution = transient attempt
Workplace       = durable desk / work identity
CandidateSet    = immutable QC snapshot presented from that desk
GateDecision    = current authority over exact CandidateSets
```

Therefore:
- durability across executions: **YES**
- execution-only product visibility: **NO**
- unbounded node-wide mixing across different Workplaces: **NO**

CGAD P18 and Conveyor v4.3 are compatible if P18 is interpreted as: "production survives WorkerExecution replacement within the same durable work identity". The generic runtime should converge on **Workplace-scoped durability**; node-scope is only equivalent for singleton cells.

### 0.1 Highest-priority hidden conflict discovered after Bug #4

The current replay archive still captures products by `sourceExecutionRef`. After a P18 repair, the final accepted execution may legitimately write nothing and simply present an accumulated managed-production snapshot created by earlier executions. The accepted CandidateSet is then correct, but execution-scoped capsule capture can archive an empty/incomplete recipe.

```
Execution A:  writes PRD / FR / NFR / RULE  → dies before worker_done
Execution B:  inherits same Workplace → writes nothing → worker_done
Gate sees accumulated Workplace production → CandidateSet B accepted

CURRENT replay capture:  sourceExecutionRef = B
  SELECT managed production WHERE execution_id = B  => zero artifacts

TARGET replay capture:  sourceCandidateSetRef = CandidateSet B
  resolve exact product snapshot represented by CandidateSet B
  => PRD / FR / NFR / RULE + exact traces
```

### 0.2 Decision about the requested test tool

Build a test-only **Factory Contract Harness**. It must inject a `ScriptedWorkerExecutorFactory` through the existing `WorkerExecutorFactory` port. It must **not** add a simulator executor kind, production flag, mock/hybrid mode, alternate lifecycle, or module-specific factory path.

```
NORMAL Factory runtime
       ↓
normal WorkAssignment + fence
       ↓
WorkerExecutorFactory port
       ↓
TEST ONLY: ScriptedWorkerExecutor
       ↓
real worker tool handlers / normal desk
       ↓
real CandidateSet
       ↓
real GateRun / GateDecision
       ↓
real Workplace + lifecycle transitions
```

---

## 1. Source baseline and evidence reviewed

| Source | Observed architectural fact |
|---|---|
| ded7ebf | Bug #4 removes executionRef filtering from managed-production reads; latest-write-wins dedupe; node-durable synthetic ProductRef. |
| CONVEYOR-MENTAL-MODEL.md v4.3 | Workplace is durable; WorkerExecution is an attempt; CandidateSet is QC handoff; replay substitutes only worker production. |
| workplace-state.ts / production-cell-reducer.ts | Closed two-channel state machine and typed transition events. |
| production-cell-node-executor.ts | One Flow node may materialize many Workplaces; ProductReader currently receives processRun/module/node/execution but not WorkplaceRef. |
| managed-production.ts | Ledger preserves process/node/task/execution provenance; comments contain inconsistent task-scope vs node-scope guidance. |
| product-lifecycle-runtime.ts | Bug #4 product reader now resolves managed artifacts/traces at node-scope. |
| products.ts | candidate_read still reports artifact/trace production by CandidateSet.producerExecutionRef; product_read does not explicitly resolve node-product-set synthetic refs. |
| replay-capture-effect.ts | Certification correctly starts from final accepted GateDecision CandidateSets. |
| sqlite-replay-capsule-repository.ts | Actual capsule materialization still selects typed/artifact/trace data by execution_id. |
| replay-capsule-completeness.ts | Completeness proof is also execution-scoped. |
| composition-root.ts | workerExecutorFactory already has a supported dependency-injection seam for a test-only executor. |
| product-delivery-lifecycle.ts | Lifecycle routing is declarative and therefore suitable for route-edge coverage generation. |
| Discovery/Formalization/Development/Delivery module definitions | Module flow graphs are declarative; Production Cell definitions expose retry/review/human/failure paths. |

---

## 2. CGAD P18 vs Conveyor v4.3

### 2.1 Where they agree

- A WorkerExecution is disposable. A crash or replacement must not erase useful work already present on the durable desk.
- Technical retry must not roll the Kanban card back to the semantic beginning of the stage.
- The next attempt must be able to inspect and repair the prior attempt's durable production.
- Exact acceptance still requires a new/current CandidateSet and current GateDecision; inherited bytes do not inherit acceptance authority.
- Execution identity remains provenance and fencing authority, not product-semantic identity.

### 2.2 Where the current code is ambiguous

| Area | Current behavior / text | Problem |
|---|---|---|
| Managed ledger API | Has task-scoped and node-scoped readers. Comments simultaneously call node-scope the live product path and call node-wide reads audit-only. | The contract itself is internally inconsistent. |
| ProductReader | `readExecutionProducts(...)` but managed-production branch ignores executionRef and reads node-wide. | Name/signature express the wrong ownership boundary. |
| Conveyor identity | WorkplaceRef includes productionCellId + workKey. | A Flow node may contain many Workplaces; node-wide is broader than the durable desk. |
| Bug #4 synthetic ref | `node-product-set:${processRunId}:${moduleRef}:${nodeId}:${schemaId}` | No workKey/workplace identity; unsafe if managed-production is ever used in fan-out. |
| CandidateSet | producerExecutionRef points to the execution that presents the candidate. | Underlying artifact writes may belong to earlier executions; physical provenance and presentation provenance must not be conflated. |
| candidate_read | Reads artifacts/traces by producerExecutionRef. | Can report zero artifacts for an accepted accumulated product. |
| Replay capture | Archives rows by sourceExecutionRef. | Can produce incomplete capsules after cross-fence inheritance. |

### 2.3 Target interpretation of P18

P18 target wording:
> A durable work product belongs to the Workplace/desk, not to one WorkerExecution.
> Replacement executions of the SAME Workplace may observe and repair prior durable production.
> The generic product resolver MUST NOT narrow the product to the current execution.
> The generic product resolver MUST NOT widen the product beyond the Workplace.
> Node-scope is allowed only where node ↔ Workplace cardinality is proven 1:1.

This interpretation preserves the intent of ded7ebf while making it compatible with the Conveyor's fan-out model.

---

## 3. Current architectural gaps to close before making the harness authoritative

**G1** — Product scope is too broad in the generic abstraction. Bug #4 uses node-scope. This is safe for current singleton Formalization cells but the generic ProductionCell executor can materialize multiple Workplaces per node. Target scope must become Workplace-durable.

**G2** — ProductReader contract is named and keyed by execution. `readExecutionProducts` carries executionRef as the conceptual anchor. Managed-production already violates that mental model. Rename/reframe the port around candidate/workplace snapshot resolution.

**G3** — Synthetic managed-production ProductRef is not a first-class readable product. The node-product-set ref is synthesized from artifact/trace hashes. `product_read` handles managed-node-submission or persistent process products. The managed bundle should become a persisted exact product snapshot.

**G4** — CandidateSet presentation provenance is confused with underlying write provenance. `producerExecutionRef` is useful as the execution that sealed/presented the candidate, but it must not be used to infer that every underlying artifact/trace was written by that execution.

**G5** — `candidate_read` contradicts P18. `candidate_read` loads produced_artifacts and produced_traces using `producerExecutionRef`. Under inherited managed production this can disagree with the CandidateSet's ProductRef.

**G6** — Replay capsule capture contradicts P18. `captureAcceptedExecution` selects typed submissions, artifacts and traces by `execution_id`. Final accepted accumulated products can therefore be lost from the archive.

**G7** — Replay completeness proves the wrong thing. `assertReplayCapsuleComplete` compares capsule contents against rows written by one execution, not against the exact accepted CandidateSet/product snapshot.

**G8** — Node-durable comments and CGAD fitness rules can codify the emergency patch too strongly. The new regression test is useful, but the final invariant should forbid execution narrowing while also preventing cross-Workplace widening.

**G9** — Long-chain tests still bypass the Factory internals. Existing product-delivery lifecycle E2E replaces whole ProcessModule executors with deterministic external executors. It proves lifecycle handoffs, not Production Cell/Workplace/Gate/repair mechanics.

**G10** — Real LLM runs are currently acting as an expensive state-machine debugger. Random worker behavior masks deterministic runtime defects such as no-worker_done recovery, paused resume, durable product visibility and replay capture.

---

## 4. Target model: Workplace Production Snapshot

Do not introduce another persistent aggregate unless evidence requires it. Introduce a typed application-level value/resolver first: a canonical snapshot of the exact production currently presented from one Workplace.

```text
WorkplaceProductionSnapshot {
  workplaceRef
  role
  schemaRef
  productRef              // exact, readable, persisted ProductRef
  semanticDigest
  typedProducts[]         // exact immutable typed products
  artifacts[] {           // canonical latest state
    artifactId
    artifactType
    contentHash
    lastProducerExecutionRef
  }
  traces[] {
    traceId
    traceHash
    lastProducerExecutionRef
  }
  presenterExecutionRef   // current execution sealing CandidateSet
  contributingExecutionRefs[]
}
```

The structure above is conceptual. Field names may be adjusted to existing domain types. The key separation is load-bearing: **presenter execution is not assumed to be the physical producer of every accumulated member**.

### 4.1 Product-source semantics

| Product source | Resolution scope | Candidate semantics |
|---|---|---|
| typed-submission | Exact current execution submission. | Current execution submitted one immutable typed product. |
| managed-production | Exact current Workplace durable desk snapshot. | Current execution presents/seals the accumulated canonical desk state; writes may originate from several executions. |
| review verdict | Exact reviewer execution typed submission. | Reviewer CandidateSet is pinned to exact author CandidateSet. |
| replay | Exact capsule content reconstruction. | Replay produces the same typed products/artifacts/traces as the certified capsule. |

---

## 5–6. (Extraction target and harness shape — see full docx for tables)

---

## 7. Coverage matrix

### 7.1 Production Cell transition coverage

| ID | Setup | Assertion |
|---|---|---|
| T-01 | author gate accepted(final) | Workplace → done/terminal(accepted) |
| T-02 | author gate accepted(author) → reviewer | Workplace → review/queued → reviewer |
| T-03 | reviewer accepted | Workplace → done/terminal(accepted) |
| T-04 | author gate repair_required | Workplace → repair_wait; Kanban unchanged |
| T-05 | reviewer defect-proven | Workplace → in_progress/repair_wait (semantic backward) |
| T-06 | reviewer invalid-output | Workplace → repair_wait, reviewer role |
| T-07 | repair budget exhausted | onExhausted → pause or fail |
| T-08 | human_required | Workplace → blocked/paused |
| T-09 | failed | Workplace → failed/terminal(failed) |
| T-10 | worker crash | Workplace → repair_wait; Kanban unchanged |
| T-11 | worker lost | Workplace → repair_wait; Kanban unchanged |
| T-12 | repair-requeue | repair_wait → queued (new execution) |

### 7.7 Lifecycle outcome routing

| Module | Outcome | Route |
|---|---|---|
| Discovery | go/clarify/reject/defer/inconclusive/failed | All continue to Formalization in current standard lifecycle. |
| Formalization | formalized | Continue to Development. |
| Formalization | clarification-required / inconsistent / infeasible / failed | Terminal with declared mapped status. |
| Development | verified | Continue to Delivery. |
| Development | rework-required / clarification-required / blocked / failed | Terminal with declared mapped status. |
| Delivery | released / approval-required / blocked / failed | Terminal with declared mapped status. |

### 7.8 Replay coverage

| ID | Setup | Assertion |
|---|---|---|
| R-01 | Run A no capsules | scripted worker invoked; current gate accepts; capsule certified |
| R-02 | Run B same semantic inputs | scripted worker NOT invoked on hits; NEW CandidateSets/Gates/Workplaces |
| R-03 | Changed semantic input | affected cell miss; unrelated earlier compatible cells may hit |
| R-04 | Changed package/check contract | miss |
| R-05 | Reviewer semantic identity | same author product digests across runs → reviewer hit |
| R-06 | Current gate rejects replay | same capsule ineligible for recovery execution |
| R-07 | Corrupt capsule | fail closed; new recovery execution; no silent inference inside same execution |
| R-08 | P18 accepted repair | capsule contains exact accepted Workplace snapshot, not only last execution writes |
| R-09 | Git base mismatch | miss or fail-closed exact-base assertion; never apply on wrong desk |
| R-10 | Delete all capsules theorem | Factory still works via scripted inference source |

---

## 8. Harness architecture constraints — to prevent another simulator runtime

1. All harness implementation lives under `tests/` or tools used only by tests; production `src/` must not import it.
2. **No new executor_kind literal.**
3. **No SAGA_SIM_* / mock / hybrid / scripted production environment switches.**
4. No direct inserts/updates into factory_workplaces, GateDecision, LifecycleRun or task fence tables from scenario scripts.
5. The scenario script receives only an already-assigned card. It cannot call worker_next or select work.
6. Worker actions use normal worker-facing product/artifact/trace/completion boundaries.
7. Gate/check providers, CandidateSet sealing, lifecycle routing, effects and replay remain the real current implementations.
8. Fixture data may be deterministic; authority may not be fabricated.
9. **A test may inject delivery providers and WorkerExecutorFactory because those are explicit ports in current composition.**
10. The harness must be able to assert 'scripted worker invocation count = 0' during replay hits.

---

## 9. Recommended implementation sequence / commits

| Commit | Scope | Exit criterion |
|---|---|---|
| 1 | Clarify P18 / Workplace durability in docs + fix contradictory comments. | No ambiguous node-vs-task-vs-workplace rule remains. |
| 2 | Introduce Workplace production snapshot resolver and migrate ProductReader contract. | Bug #4 still passes; fan-out isolation test exists. |
| 3 | Persist managed-production bundle as exact ProductRef; align candidate_read. | Every CandidateSet member is product_read-resolvable. |
| 4 | Refactor Replay capture/completeness to CandidateSet snapshot. | P18 repair capsule archives prior-execution artifacts correctly. |
| 5 | Extract shared worker process termination outcome handling. | exit-without-worker_done produces normal repair path; spawn failure remains distinct. |
| 6 | Add ScriptedWorkerExecutor + child + scenario registry. | One simple Production Cell runs without LLM through real gates. |
| 7 | Add fixture corpus + Discovery/Formalization golden path. | Idea→Formalization can run deterministic real state machine. |
| 8 | Add Development/Delivery fixtures/providers. | Full Idea→released deterministic path. |
| 9 | Add branch matrices: repair/reviewer/crash/pause/resume/fanout/effects. | Every declared Production Cell transition class covered. |
| 10 | Add lifecycle route + replay two-run suites + npm script. | Factory Contract Harness becomes stable CI architectural gate. |

### 9.1 Do not combine these commits prematurely

The production-snapshot/replay refactor and the harness are related but should remain separable in review. The harness should first expose defects, not quietly carry production fixes inside test code.

---

## 10. Definition of Done

- CGAD P18 has one unambiguous Workplace-durable interpretation compatible with fan-out.
- No generic product resolver narrows durable managed production to current execution.
- No generic product resolver widens one Workplace to sibling Workplaces under the same node.
- Every CandidateSet member is an exact resolvable ProductRef.
- candidate_read reports the exact snapshot the Gate evaluated.
- Replay capture is driven by accepted CandidateSet/ProductRefs, not by 'everything written by sourceExecutionRef'.
- Replay completeness is CandidateSet-completeness.
- Bug #4 cross-fence scenario passes without direct DB hacks.
- exit(0) without worker_done follows deterministic recovery policy.
- paused Workplace resume is covered by a deterministic test.
- A full Product Delivery golden path runs without any LLM/network dependency.
- Every ProcessModule transition edge and Lifecycle outcomeRoute has deterministic coverage.
- Replay Run B proves zero scripted-worker calls on compatible hits while current Gates/transitions rerun.
- Effect retry/observation idempotency is covered.
- No supported simulator/mock/hybrid Factory runtime reappears.

---

## 11. Risks and decisions to keep explicit

| Risk | Required decision |
|---|---|
| Node scope accidentally becomes permanent generic scope | Migrate to Workplace scope before enabling managed-production on fan-out cells. |
| CandidateSet provenance confusion | Document presenter vs contributing execution; never infer physical authorship from producerExecutionRef alone. |
| Snapshot changes after CandidateSet seal | Persist exact canonical bundle payload at seal/read time; do not recompute 'latest' later as authority. |
| Test harness drifts into second factory | Keep it behind WorkerExecutorFactory DI only; architecture ratchet forbids runtime flags/executor kinds. |
| Fixtures duplicate business validation logic | Use minimal fixtures and real CheckProviders; never reimplement Gate rules in the scenario engine. |
| Tool handlers rely on process.env | Use one child process per scripted execution; do not mutate shared parent env during concurrent tests. |
| Development Git test becomes synthetic | Use a real temporary Git repository and the real RepositoryDesk/effect boundary. |
| Delivery effect tests cause real side effects | Inject deterministic test providers through existing provider ports; assert exact desired-state/idempotency contracts. |

---

## 12. Key source references

- docs/architecture/CONVEYOR-MENTAL-MODEL.md (Version 4.3)
- commit ded7ebfb17faf5496ff05f0e69e486798371ba4d — Bug #4
- src/app/product-lifecycle-runtime.ts
- src/process-modules/application/node-executors/production-cell-node-executor.ts
- src/process-modules/application/production-cell-coordinator.ts
- src/process-modules/domain/workplace/workplace-state.ts
- src/process-modules/domain/workplace/production-cell-reducer.ts
- src/process-modules/shared/managed-production.ts
- src/process-modules/persistence/sqlite-managed-production-ledger.ts
- src/tools/products.ts
- src/infrastructure/replay/replay-capture-effect.ts
- src/infrastructure/replay/sqlite-replay-capsule-repository.ts
- src/infrastructure/replay/replay-capsule-completeness.ts
- src/application/ports/worker-executor.ts
- src/app/composition-root.ts
- src/process-modules/lifecycles/product-delivery-lifecycle.ts
- src/process-modules/modules/discovery/discovery-process-module.ts
- src/process-modules/modules/formalization/formalization-process-module.ts
- src/process-modules/modules/development/development-process-module.ts
- src/process-modules/modules/delivery/delivery-process-module.ts
- tests/factory/managed-production-node-scoped-reader.test.mjs
- tests/process-modules/product-delivery-lifecycle-e2e.test.mjs
- package.json

---

## 13. First instruction for the new implementation session

Start from saga4 HEAD ded7ebf (or verify the newer HEAD before modifying anything). Read this plan and CONVEYOR-MENTAL-MODEL.md first. Do not build the ScriptedWorker harness directly on the current execution-scoped replay/candidate assumptions. Implement T0–T6 first, with the Bug #4 scenario preserved as a regression, then build T9–T13.

**Primary invariant for the next session:**
> WorkerExecution may disappear.
> Workplace production must survive.
> CandidateSet must freeze the exact current Workplace snapshot.
> Replay must reproduce that CandidateSet snapshot.
> The test harness may replace only the physical worker, never Factory authority.

---

END OF PLAN
