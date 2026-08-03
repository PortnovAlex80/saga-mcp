# Workload and Algorithm Profile

Artifact ID: ART-PHASE5-WORKLOAD-PROFILE
Artifact Type: Workload and Algorithm Profile
Phase: Phase Five
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE3-CORE-MODEL, ART-PHASE4-SEAM-MAP, full codebase context
Coverage: All identified algorithms, data structures, queries, and traversal patterns profiled from code evidence (E3-E5). No runtime profiling data (E6) available.
Confidence: High for algorithm identification; Low for workload characterization (no runtime metrics)
Referenced Evidence: EVID-001 through EVID-026; RULE-001 through RULE-018; SEAM-001 through SEAM-016
Unresolved Questions: QUESTION-001 (runtime desk usage), QUESTION-007 (glass ceiling quantification)
Known Contradictions: None new
Downstream Dependencies: Phase 5.5 (Cross-Cutting Constraints), Phase 6 (Pattern Evaluation and Target Architecture)

---

## Execution Model Determination

### Evidence for classification

The system exhibits behaviors from multiple execution models. The dominant model must be identified from where complexity and runtime time are actually spent.

| Execution model candidate | Evidence FOR | Evidence AGAINST | Weight |
|---|---|---|---|
| **Workflow engine** | LifecycleOrchestrator drives stages; GenericFlowExecutor walks Flow graphs; declarative transitions; pause/resume | Fixed 4-stage lifecycle (not arbitrary graphs); modules are NOT user-defined workflows; Flow is a declaration, not a runtime graph | MEDIUM |
| **State machine engine** | Task status transitions (6 states, CHECK constrained); artifact status (4 states); execution state (7 states); settlement decisions as terminal states; gate-enforced transitions | States are simple enums, not rich state machines; no state machine library; transitions are SQL UPDATEs, not event-sourced | HIGH |
| **Task graph / DAG executor** | Development task graph IS a DAG; depends_on creates a dependency graph; parallel workers claim independent tasks | The DAG is ONE module's internal concern (Development); the top-level lifecycle is sequential, not a DAG; no general-purpose DAG scheduler | LOW |
| **Plugin host / microkernel** | Modules register handlers via registry; GenericFlowExecutor dispatches by node.kind; modules declare content, runtime provides physics | Modules are NOT plugins (they don't extend runtime); there is a FIXED set of 4 modules; adding a module requires editing composition root (SEAM-016) | LOW |
| **Pipeline processor** | Linear flow: Discovery → Formalization → Development → Delivery; each stage transforms input to output | The pipeline has branches (go/clarify/reject); stages pause and resume (not pure forward flow); workers are external processes, not pipeline stages | MEDIUM |
| **Policy engine** | 18 pure decision functions govern transitions; deny-by-default; content-addressed rules; settlement policies are deterministic | The system also manages workers, spawns processes, handles git — these are NOT policy functions; policy is the core but not the entire system | HIGH (for the CORE) |
| **Integration router** | LifecycleOrchestrator routes outcomes between modules; declarative stage bindings; handoff via JSON-path mappings | Routing is 4 hard-coded stages, not general-purpose; no dynamic routing based on content | LOW |

### Verdict: the system is a HYBRID

The system cannot be classified as a single execution model. It is a **hybrid**:

**Core layer: policy engine.** The value-producing logic is 18 pure decision functions that gate transitions. This is the system's intellectual center and its primary tested surface.

**Shell layer: workflow runtime.** Around the policy core sits a workflow runtime that: walks Flow graphs (GenericFlowExecutor), drives a stage lifecycle (LifecycleOrchestrator), spawns external workers (LmNodeExecutor + ClaudeBoardRunner), and manages worktrees/merges (worker protocol). This shell is infrastructure, not core value.

**Integration layer: MCP gateway + SQLite persistence.** The outermost layer handles protocol (MCP stdio), transport (HTTP for tracker-view), and persistence (SQLite + filesystem + git).

This hybrid nature is CRITICAL for Phase 6 (Target Architecture): different layers need different architectural patterns. Forcing one pattern (e.g., "everything hexagonal") would misfit the shell layer.

---

## Algorithm Inventory

### ALG-001: Atomic card selection (findNextClaimable)
- **Location:** work-assignment-core.ts:252-365
- **Algorithm:** SQL SELECT with 5 correlated subquery gates (NOT EXISTS), then conditional UPDATE with CAS (WHERE status='todo' AND assigned_to IS NULL). Retry up to MAX_CLAIM_ATTEMPTS (10).
- **Data structure:** SQLite B-tree indexes on tasks(status), tasks(assigned_to), task_conflict_keys(key_type,key_value), task_dependencies, worker_executions(task_id,state), human_requests(task_id,state)
- **Complexity:** O(log N) for index lookups per gate × 5 gates + O(1) for UPDATE. Effectively O(1) for typical N (<1000 tasks per epic).
- **Workload profile:** Called once per worker dispatch. Under contention (N parallel callers), BEGIN IMMEDIATE serializes — worst case O(N) retries where N = concurrent claimers.
- **Hot path:** YES — every worker launch starts here.
- **Data access pattern:** Read-heavy (5 subquery probes) followed by single-row UPDATE.
- **Concurrency:** Serialized by BEGIN IMMEDIATE. No parallel claims possible.
- **I/O profile:** SQLite only (no filesystem, no network).
- **Evidence:** E5 (8-way dispatcher race tests prove exactly one winner)

### ALG-002: Stuck-policy decision tree (decideStuckAction)
- **Location:** stuck-policy.ts:184-338
- **Algorithm:** 6-step decision tree: remote? → dead/reserved-expired/lease-expired? → stuck-stage-1+2 (progress silence)? → stuck-stage-3 (cancel grace + birth token)? → legitimate phase? → alive-illegitimate → terminate.
- **Data structure:** Input struct (StuckPolicyInput) with 16 precomputed fields. Output: discriminated union (StuckAction).
- **Complexity:** O(1) — fixed-depth decision tree, no loops, no data structure traversal.
- **Workload profile:** Called once per active execution per reaper sweep (every ~30s). O(M) where M = active executions (typically 1-5).
- **Hot path:** NO — background reaper, not on the critical worker path.
- **Concurrency:** NONE — pure function, zero I/O.
- **Evidence:** E5 (table-driven tests in stuck-policy.test.mjs)

### ALG-003: GenericFlowExecutor walk
- **Location:** generic-flow-executor.ts:399-832
- **Algorithm:** Iterative Flow graph walk. At each node: dispatch to NodeExecutor, persist NodeRun, check for terminal/recovery/pause, advance via transition match. Max steps bounded by `maxSteps = flow.nodes.length * 4 + totalRepairBudget * (flow.nodes.length + 2) + 10`.
- **Data structure:** Flow definition (immutable array of nodes + transitions). Frame (productions + receipts map). Chain input (accumulated production).
- **Complexity:** O(K) where K = nodes in flow (typically 5-11). Recovery can revisit: O(K + R*(K+2)) where R = total recovery budget across all policies (typically 5-10). In practice: 10-30 iterations per ProcessRun.
- **Workload profile:** Called once per ProcessRun (4 ProcessRuns per lifecycle = 4 stages). Each walk takes minutes to hours (dominated by external LM execution time, NOT algorithmic time).
- **Hot path:** YES — but the wall-clock time is 99%+ external (claude -p inference). The walk algorithm itself is microseconds per iteration.
- **Data access pattern:** Read + write per node: read nodeRunRepo (checkpoint), write nodeRunRepo (complete). Read processRunRepo (lease renewal every iteration).
- **Concurrency:** Single-driver per ProcessRun (lease-based). No parallel walks on the same run.
- **I/O profile:** SQLite (NodeRun persistence) + external process spawn (dominant).
- **Evidence:** E5 (characterization tests)

### ALG-004: Discovery settlement policy evaluation
- **Location:** discovery-settlement-policy.ts:306-527
- **Algorithm:** Short-circuit decision tree: worker_outcome=clarify? → CLARIFY. readiness missing/failed/paused? → CLARIFY. Then branch on worker_outcome=reject or go. Each branch evaluates 6-7 boolean conditions. Emits deterministic trace (per-condition: evaluation, role, contributed, reason_codes).
- **Data structure:** Input snapshot (immutable). Output: discriminated union decision + trace array.
- **Complexity:** O(1) — fixed conditions, no data traversal.
- **Workload profile:** Called once per Discovery ProcessRun (at settlement node). Microseconds.
- **Hot path:** NO — called once per stage, not per worker.
- **Concurrency:** NONE — pure function.
- **Evidence:** E5 (policy manifest hash tests, trace causality tests)

### ALG-005: Formalization traceability gap detection
- **Location:** findContractGap (formalization-installation.ts:1237) + findFirstTraceabilityGap (sqlite-formalization-kernel.ts:168)
- **Algorithm:** For each artifact in scope (PRD, UCs, ACs, SRS), check outgoing traces against expected edge types and target types. Uses Map lookups (targetById) and Array.some() over traces array.
- **Data structure:** ContractSnapshot (artifacts array + traces array + targetArtifacts array). Map<id, artifact> for type lookup.
- **Complexity:** O(A × T) where A = artifacts in scope (typically 10-30), T = traces per artifact (typically 2-5). In practice: O(100) operations.
- **Workload profile:** Called at formalization settlement. Sub-millisecond.
- **Hot path:** NO.
- **Concurrency:** NONE (in-memory). The SQL version (findFirstTraceabilityGap) does JOIN queries — O(A) SQL queries each touching artifact_traces index.
- **SEAM:** SEAM-010 — two implementations.
- **Evidence:** E5

### ALG-006: Development task graph validation
- **Location:** ReferenceDevelopmentTaskGraphPolicy.validate (development-settlement-policy.ts:159-380)
- **Algorithm:** Sequential validation checks: schema version, hash match, lineage binding, item key uniqueness, dependency closure (Map lookup), acyclicity check (DFS with visiting/visited sets), implementation coverage (Set operations), verification coverage (Set equality), repository binding, integration target completeness.
- **Data structure:** Sets for key/criterion collections. Map for key→item lookup. DFS for cycle detection.
- **Complexity:** O(V+E) for cycle detection (V = items, E = dependency edges, typically V=5-15, E=5-10). O(V×A) for coverage checks (A = ACs, typically 10-20). Overall: O(V × (V + A)).
- **Workload profile:** Called once per Development planning node. Sub-millisecond.
- **Hot path:** NO.
- **Concurrency:** NONE — pure function.
- **Evidence:** E5

### ALG-007: Content-addressing (canonicalJson + sha256Hex)
- **Location:** saga3/shared/discovery-canonical.ts:28-43
- **Algorithm:** Recursive key-sorted JSON serialization (no whitespace), then SHA-256 hash.
- **Data structure:** Recursive object traversal. Stack-based key sorting per level.
- **Complexity:** O(N log K) per level where N = values, K = keys at that level. Overall: O(size of JSON). For typical payloads (1-50KB): microseconds.
- **Workload profile:** Called for EVERY product submission, EVERY certificate, EVERY hash computation. The single most frequently called algorithm in the system.
- **Hot path:** YES — every proposal_submit, artifact_create, process_node_submit, settlement, and certificate issuance calls this.
- **Data access pattern:** CPU-only (no I/O).
- **Evidence:** E5

### ALG-008: Authority gateway validation (readExecutionContextStrict)
- **Location:** authorize-saga-tool-call.ts:156-221
- **Algorithm:** Parse JSON metadata, validate hex64 hash, validate policy version, parse model route, parse authority (including authority_hash recomputation), recompute execution_context_hash, compare. 15+ field validations.
- **Data structure:** Object parsing + string regex (isHex64).
- **Complexity:** O(1) per validation. O(size of execution_context JSON) for parsing + hash recomputation.
- **Workload profile:** Called on EVERY MCP tool call. The most critical hot path for latency — adds latency to every worker action.
- **Hot path:** YES — absolute hottest path. Every `task_get`, `artifact_create`, `worker_done`, etc. passes through this.
- **Data access pattern:** SQLite read (worker_executions JOIN tasks) + CPU (hash recompute).
- **Concurrency:** Read-only (SQLite WAL allows concurrent readers).
- **Evidence:** E5

### ALG-009: Worker poll loop (ClaudeBoardRunner.waitForAssignedWorker)
- **Location:** dispatch-loop.ts:154-175 + claude-runner.mjs (child close handler)
- **Algorithm:** Poll loop: sleep(pollMs) → check executor.status → check terminal states → repeat until terminal or timeout.
- **Data structure:** Set<Promise<number>> for active workers.
- **Complexity:** O(1) per poll. O(T/pollMs) total where T = wall-clock execution time.
- **Workload profile:** Runs for the DURATION of each worker execution (minutes to hours). polls every 1000ms (dispatch-loop) or 2000ms (LM executor).
- **Hot path:** YES — but it's mostly sleeping. The actual work is in the external claude process.
- **I/O profile:** executor.status() reads from ClaudeBoardRunner's in-memory Map (O(1)). markExecutionProgress writes to SQLite (throttled 30s).
- **Evidence:** E4 (tested with mocks; real poll behavior untested at E5)

### ALG-010: Reaper sweep (reconcileWorkerExecutions)
- **Location:** worker-executions.ts:334-507
- **Algorithm:** SELECT all active worker_executions for project/epic. For each: precompute 6 IO-dependent booleans (isAlive, birthTokenMatches, etc.). Call decideStuckAction (pure). Dispatch on Action: KEEP/MARK_SUSPECTED/REQUEST_CANCEL/TERMINATE/RELEASE. Then recoverLegacyAssignments (separate scan).
- **Data structure:** Array of worker_execution rows. Probe interface (isAlive, readBirthToken, killVerified).
- **Complexity:** O(M) where M = active executions (typically 1-5). Each probe is O(1) (process.kill(0) on Linux, CIM query on Windows). Windows CIM query is SLOW (~500ms per call).
- **Workload profile:** Periodic background sweep (every ~30s). Not on the critical worker path.
- **Hot path:** NO — background.
- **I/O profile:** SQLite SELECT + OS process probes (process.kill/CIM) + optional process kill (SIGKILL/taskkill).
- **Platform sensitivity:** Windows CIM query for birth token is significantly slower than Linux /proc/stat read. This affects reaper latency on Windows.
- **Evidence:** E5 (worker-supervision-reaper tests)

### ALG-011: Lifecycle mapping (mapLifecycleValues)
- **Location:** lifecycle-mapper.ts (referenced from lifecycle-orchestrator.ts)
- **Algorithm:** Evaluate JSON-path expressions ($.stages.<id>.<path>) against a durable frame object. Literal expressions ({literal: value}) and runtime expressions ({runtime: 'projectId'}) are also supported.
- **Data structure:** Nested object traversal (JSON-path resolution).
- **Complexity:** O(depth × key lookup) per mapping. Depth typically 2-4. O(M) total where M = mappings per stage (typically 5-10).
- **Workload profile:** Called once per stage transition (4 per lifecycle).
- **Hot path:** NO.
- **Evidence:** E5

---

## Data Structure Inventory

| Structure | Location | Purpose | Performance characteristics |
|---|---|---|---|
| SQLite B-tree indexes | All tables | Query acceleration | O(log N) lookups; fine for N < 100K |
| Map<nodeId, NodeProduction> | generic-flow-executor.ts (frame.productions) | Chain-of-productions forwarding | O(1) lookup; rebuilt from NodeRun rows on each walk |
| Map<handlerId, KernelHandler> | kernel-handler-registry.ts | Handler dispatch | O(1) lookup |
| Set<Promise> | dispatch-loop.ts | Active worker tracking | O(1) add/delete; Promise.race for completion |
| Map<execution_id, WorkerExecution> | worker_executions table | Execution state | SQLite-backed; queried by project+epic+state |
| ProcessProductRepository | saga3_process_products table | Content-addressed product store | Keyed by (processRunId, productKind); O(1) read |
| FilesystemModulePackageStore | .saga/package-store/ | Content-addressed package blobs | SHA-256 keyed directory tree; O(1) read |
| Flow definition (immutable array) | process-module.ts | Node + transition declarations | O(K) scan for node lookup; O(T) scan for transition match |
| RecoveryCase (append-only) | saga3_recovery_cases | Repair attempt history | O(1) append; O(A) read where A = attempts |

---

## Workload Characterization

### Where evidence allows

**Workload shape: bursty, latency-dominated by external process.**
- The system's wall-clock time is 99%+ external: claude -p inference takes 30s-10min per worker call
- SQLite operations are microseconds to low milliseconds
- The system is NOT throughput-bound — it is latency-bound by the external LLM
- Concurrency is low: 1-10 workers per epic (concurrency=N, default 3-4)

**Data volume: small.**
- Typical epic: 10-30 tasks, 10-30 artifacts, 5-15 verification evidence rows
- Typical DB size: 1-5 MB (the repo's .tracker.db is 1.1 MB)
- Product payloads: 1-50 KB JSON/Markdown per artifact
- Package store: 10-50 MB (skills + templates + schemas)
- No big data, no streaming, no high-throughput requirements

**Input distribution: human-authored + LM-generated.**
- Human input: one phrase (idea) + occasional AskUser answers
- LM input: skill prompts (2-40 KB) + task descriptions (1-5 KB) + recovery feedback (1-2 KB)
- LM output: JSON payloads (1-50 KB) + code (1-500 KB) + markdown artifacts (5-50 KB)

**Hot paths:**
1. **Authority gateway** (ALG-008) — every MCP tool call. Latency-critical because it adds to every worker action. Currently O(1) SQLite read + hash recompute.
2. **Content-addressing** (ALG-007) — every product + certificate. CPU-only, microseconds.
3. **Card selection** (ALG-001) — every worker dispatch. SQLite BEGIN IMMEDIATE, serialized.
4. **Worker poll loop** (ALG-009) — runs for duration of each worker. Mostly sleeping.

**Cold paths:**
1. Settlement policies (ALG-004, ALG-005, ALG-006) — once per stage. Microseconds.
2. Reaper sweep (ALG-010) — every 30s. O(M) where M is small.
3. Lifecycle mapping (ALG-011) — once per stage transition. Microseconds.

**Memory behavior:** minimal. No large in-memory caches. The largest in-memory structure is the Flow definition (immutable array of 5-11 nodes). No GC pressure from the saga runtime itself.

**I/O profile:**
- SQLite: 90% of I/O. Read-heavy (queries dominate writes). WAL mode enables concurrent readers.
- Filesystem: package store reads (rare), artifact .md reads (on hash refresh), JSONL worker logs (append-only, high frequency during worker execution)
- Network: NONE in core system (LM Studio is optional local HTTP; claude CLI is stdio)
- Git: worktree add (once per task), merge (once per approved task), rev-parse (once per lifecycle start)

**Parallelism:** embarrassingly parallel at the worker level (each worker is independent in its own worktree). Serialized at the claim level (BEGIN IMMEDIATE). The parallelism bottleneck is the LLM rate limit, not the saga runtime.

### Where evidence does NOT allow

**Missing runtime data (required benchmarks):**
1. **BENCHMARK-001:** Authority gateway latency per tool call. Is the hash recompute + SQLite read under 1ms? Under 10ms? At what DB size does it degrade?
2. **BENCHMARK-002:** SQLite BEGIN IMMEDIATE contention under N=10 concurrent workers. How much queueing?
3. **BENCHMARK-003:** Reaper sweep latency on Windows (CIM query for birth token). Is 500ms per probe acceptable when M=5?
4. **BENCHMARK-004:** Content-addressing (canonicalJson) latency for 50KB payloads. Microsecond or millisecond?
5. **METRIC-001:** Actual number of SQLite queries per worker execution (from claim to release). Estimated 20-50; needs runtime tracing.
6. **METRIC-002:** Actual DB size after a full lifecycle run (4 stages, 20 tasks). Currently 1.1 MB for Autism-Buttons partial run.
7. **METRIC-003:** Worker spawn-to-first-tool-call latency. How much of the 30s+ worker lifetime is saga overhead vs claude CLI startup?

---

## System Classification: Structural Distance

| Model | Distance | Why |
|---|---|---|
| Request-driven modular application | FAR | No HTTP request handling in core; workers are not request handlers |
| Computation pipeline | MEDIUM | Stages DO transform data sequentially, but each stage spawns external processes and gates transitions |
| Dataflow system | FAR | No continuous data flow; batch-style stage transitions |
| Batch processor | MEDIUM | Each lifecycle run IS a batch (idea → release), but with interactive (AskUser) and async (worker poll) elements |
| Streaming processor | FAR | No streaming |
| Workflow engine | MEDIUM-HIGH | Flow graph walk + stage routing + pause/resume. But the workflow is FIXED (4 stages), not user-defined |
| State machine engine | HIGH | Multiple state machines (task, artifact, execution, stage) with gate-enforced transitions. This is the closest single classification for the CORE |
| Event-driven process | LOW-MEDIUM | command_receipts and lifecycle_events exist, but the system is NOT event-sourced; events are audit trail |
| Actor system | LOW | Workers are processes, not actors; no message passing between saga components |
| Task graph | MEDIUM for Development; LOW overall | Development module has a DAG, but the top-level lifecycle is sequential |
| Microkernel / plugin host | LOW | Modules register handlers but don't extend runtime; fixed set |
| Integration router | LOW | 4 hard-coded stages, not dynamic routing |

### Closest classification

**State machine engine with policy-gated transitions, wrapped in a workflow runtime that orchestrates external LLM workers.**

The CORE (Phase 3 finding) is a policy engine. The SHELL is a workflow runtime. The system as a whole is closest to a **state machine engine** because:
- Every entity (task, artifact, execution, stage) has a finite state machine
- Transitions are gated by pure policies (deny-by-default)
- Terminal states are final (write-once)
- Recovery returns to a pre-terminal state (not a new entity)

The workflow wrapping (GenericFlowExecutor, LifecycleOrchestrator) is the EXECUTION MECHANISM for the state machine — it drives the transitions by spawning workers and collecting their outputs. But the DECISION LOGIC is entirely in the policies, not in the workflow engine.

---

## Implications for Target Architecture (Phase 6 preview)

1. **The core (policies) should be pure and isolated.** This is already largely true (12/18 rules are pure). The remaining work is consolidating RULE-012 (duplicated traceability) and extracting SQL-embedded rules into testable functions where beneficial.

2. **The shell (workflow runtime) should be thin and generic.** GenericFlowExecutor is already generic (no module-name literals). The thinness is compromised by Wave debt (1500 lines with ~40% comments) and dual-write paths. Cleanup reduces it to ~600 lines.

3. **The four desks are the primary structural problem.** They do not affect the core policies (which already work) but they prevent module autonomy and inflate cognitive load. Unification is an architectural decision, not an algorithmic one — the workload is so small (10-30 items per epic) that performance is irrelevant.

4. **Performance is NOT a driver.** The system is latency-bound by external LLM inference (30s-10min per call). Saga runtime overhead is microseconds per operation. No algorithmic improvement would produce measurable user-visible speedup. This means Phase 9 (Algorithmic Improvement) will have little to recommend — the algorithms are already appropriate for the workload.

5. **The SQLite ceiling (SEAM-011) is theoretical.** With concurrency=3-4 and DB size <5MB, SQLite is vastly overprovisioned. The ceiling (~10 concurrent workers) is relevant only if saga scales to fleet orchestration, which is not evidenced.
