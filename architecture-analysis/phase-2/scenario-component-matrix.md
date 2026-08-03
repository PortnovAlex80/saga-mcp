# Scenario-to-Component Matrix

Artifact ID: ART-PHASE2-SCENARIO-MATRIX
Artifact Type: Scenario-to-Component Matrix
Phase: Phase Two
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE1-OPERATIONAL-PURPOSE, ART-PHASE0-EXECUTABLE-TOPOLOGY, full codebase context
Coverage: 8 scenarios traced from trigger to side effects. Production evidence from Autism-Buttons epic where available.
Confidence: High for traced paths (E3-E5); Medium for scenario completeness (more scenarios may exist in edge cases)
Referenced Evidence: EVID-001 through EVID-026
Unresolved Questions: QUESTION-001 (runtime desk usage), QUESTION-009 (zombie reaper behavior)
Known Contradictions: CONTRADICTION-001 (four desks vs one-desk target)
Downstream Dependencies: Phase 3 (Real Core), Phase 4 (Seam Map)

---

## SCN-001: Full lifecycle — idea to working code

**Trigger:** Human operator submits idea via tracker-view `POST /api/project/create-from-idea`
**Entry point:** `startProductLifecycleFromIdea` (src/app/start-product-lifecycle-from-idea.ts:257)

| Step | Component | File:Line | State read | State written | Rule enforced | External effect |
|---|---|---|---|---|---|---|
| 1 | resolveActiveRepositoryWithHead | start-product-lifecycle-from-idea.ts:81 | project_repositories, repositories | — | PROJECT_REPOSITORY_NOT_BOUND | `git rev-parse HEAD` |
| 2 | assembleProductLifecycleInput | start-product-lifecycle-from-idea.ts:144 | — | — | assertProductDeliveryLifecycleInput (fail-closed) | — |
| 3 | createSpawnCliLifecycleRunStarter | product-lifecycle-run-starter.ts:80 | — | — | — | spawn orchestrate-cli (detached) |
| 4 | installProductionModules | production-install.ts:121 | — | saga3_module_installations, .saga/package-store/ | digest integrity | filesystem write |
| 5 | createSaga2Application | composition-root.ts:101 | — | — | PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED | — |
| 6 | createProductLifecycleRuntime | product-lifecycle-runtime.ts:325 | — | — | assertCompositionDependencies | — |
| 7 | runEpisode → LifecycleOrchestrator.run | lifecycle-orchestrator.ts:174 | saga3_lifecycle_runs | saga3_lifecycle_runs, saga3_stage_runs | transition budget (maxTransitions) | — |
| 8 | Discovery: produce-proposal (LM) | lm-node-executor.ts:273 | saga3_work_intents, tasks | saga3_work_intents, tasks, worker_executions | authority_scope (frozen) | spawn claude -p |
| 9 | Discovery: worker calls proposal_submit | saga3-proposals.ts:53 | saga3_work_intents, worker_executions | saga3_raw_submissions, saga3_proposals | execution fence + authority hash | — |
| 10 | Discovery: worker calls worker_done | dispatcher.ts:412 | tasks, worker_executions | tasks (status→review/done), comments, command_receipts | idempotency (checkReceipt) | — |
| 11 | Discovery: settlement kernel | discovery-installation.ts:792 | saga3_proposals, saga3_readiness_assessments | saga3_discovery_settlements, saga3_discovery_outcome_certificates | discoverySettlementPolicyV1 (pure) | — |
| 12 | routeProcessOutcome → Formalization | lifecycle-router.ts:23 | — | — | declarative outcomeRoutes | — |
| 13 | Formalization: PRD/UC/AC/SRS (LM nodes) | formalization-installation.ts:363+ | tasks, saga3_managed_artifact_productions | artifacts, artifact_traces, saga3_managed_artifact_productions, saga3_managed_trace_productions | exact-candidate-acceptance (kernel gate) | — |
| 14 | Formalization: settlement → certificate | formalization-installation.ts:843 | artifacts, artifact_traces, saga3_formalization_baselines | saga3_process_outcome_certificates, saga3_formalization_solution_contracts | findFirstTraceabilityGap | — |
| 15 | Development: plan-task-graph (LM) | development-installation.ts:176 | tasks, artifacts, artifact_traces | saga3_managed_node_submissions | — | spawn claude -p |
| 16 | Development: resolve-task-graph (kernel) | development-installation.ts:176 | saga3_managed_node_submissions | tasks (projected dev/verify tasks), saga3_process_products | taskGraphPolicy.validate (DAG, coverage, acyclic) | — |
| 17 | Development: settle → paused | development-installation.ts:339 | tasks (projected) | — | areProjectedTasksTerminal → false → runtimeEvent:'paused' | — |
| 18 | orchestrate-cli: distributeQueuedTasks | dispatch-loop.ts:62 | tasks (todo/review) | tasks, worker_executions | concurrency budget, conflict-key gate | spawn claude -p ×N |
| 19 | Workers: claim → code → review → merge | dispatcher.ts:496+ | tasks, worker_executions | tasks, verification_evidence, git refs | review-first, merge-lock, build-gate | git worktree/merge/commit |
| 20 | Development: settle → verified | development-installation.ts:339 | tasks, verification_evidence, integration_intents | saga3_process_outcome_certificates | settlementPolicy.settle (frozen candidate + trusted evidence) | — |
| 21 | Delivery: preflight → approve → publish → observe → settle | delivery-installation.ts:145+ | delivery runtime state | saga3_external_effect_events, saga3_process_outcome_certificates | deliveryPreflightPolicy, human approval | external deploy (fail-closed: throws) |

**Observations:**
- This scenario crosses 7 architectural layers and touches 15+ table groups
- The product changes physical form 4 times: universal input → proposal (desk 1) → artifact (desk 2) → submission (desk 3) → release record (desk 4)
- Each desk transition requires a module-specific adapter (FINDING-001 from Phase 1 confirmed)
- Steps 8-20 are the core loop: spawn LM → submit product → kernel gate → route

**Scattered responsibility:** The lifecycle progression logic is split between `LifecycleOrchestrator` (stage routing), `GenericFlowExecutor` (node walking), module kernel handlers (product resolution + gate), and `orchestrate-cli` (pause/drain/resume loop). No single component owns "the lifecycle is progressing correctly."

---

## SCN-002: Worker claim → work → done → merge

**Trigger:** `findNextClaimable` selects a todo/review task
**Entry point:** `SqliteWorkAssignmentAdapter.assignTask` or `worker_next` MCP handler

| Step | Component | File:Line | State written | Rule enforced | Transaction boundary |
|---|---|---|---|---|---|
| 1 | findNextClaimable | work-assignment-core.ts:252 | tasks (status flip + assigned_to + current_execution_id), worker_executions (INSERT) | review-first, priority, conflict-key gate, dependency gate, human-request gate | BEGIN IMMEDIATE (atomic claim+fence) |
| 2 | buildAssignedWorkFromClaim | work-assignment-core.ts:372 | — (read-only: repository binding, execution_context) | — | post-commit |
| 3 | ClaudeBoardRunner.launch | claude-runner.mjs:680 | — | frozen authority → allowedTools | — |
| 4 | spawn claude -p | claude-runner.mjs:906 | worker_executions (state=running, pid, birth_token) | — | openRuntimeDb (separate connection) |
| 5 | Worker reads task_get | tasks.ts:661 | — (read) | — | — |
| 6 | Worker does work | (external: claude -p) | (external: code/docs) | authority gateway on every tool call | — |
| 7 | Worker calls worker_done | dispatcher.ts:412 | tasks (status→review/done), comments, command_receipts | idempotency check, fence check, T-013 review-loop escape | BEGIN IMMEDIATE |
| 8 | [if git_change] worker_merge_acquire | dispatcher.ts:1108 | project_repositories.metadata.merge_lock | stale-safe (10min + isProcessAlive) | BEGIN IMMEDIATE |
| 9 | [if git_change] git merge | (external) | git refs (dev branch) | — | OS process |
| 10 | [if git_change] worker_merge_release | dispatcher.ts:1206 | tasks (integration_state=merged/conflict), project_repositories.metadata.merge_lock=null | only holder may release | BEGIN IMMEDIATE |
| 11 | markExecutionExited | worker-executions.ts:190 | worker_executions (state=exited), tasks (current_execution_id=null) | — | db.transaction (not IMMEDIATE) |

**Observations:**
- Steps 1, 7, 8, 10 each take BEGIN IMMEDIATE — 4 separate write locks for one task lifecycle
- Step 11 uses `db.transaction` (DEFERRED, not IMMEDIATE) — different isolation level
- The merge-lock is in `project_repositories.metadata` (JSON column) — not a first-class entity
- The single-writer invariant is maintained: only work-assignment-core + atomic-release + markExecutionExited write owner columns

---

## SCN-003: Recovery — verifier finds defect, repair round

**Trigger:** Kernel handler emits `domain.repair-required` event
**Entry point:** `GenericFlowExecutor.reconcileRecoveryCheckpoint` (generic-flow-executor.ts:891)

| Step | Component | File:Line | State written | Rule enforced |
|---|---|---|---|---|
| 1 | Kernel handler returns recoveryIssue | formalization-installation.ts (recoverySpec) | — | RecoveryIssue schema validation |
| 2 | reconcileRecoveryCheckpoint | generic-flow-executor.ts:891 | saga3_recovery_cases, saga3_recovery_attempts | policy.maxAttempts, onExhausted |
| 3 | recoveryFeedbackProduction | generic-flow-executor.ts:1120 | — | feedback hash = sha256(issue + attempt) |
| 4 | GenericFlowExecutor walks to repairNodeId | generic-flow-executor.ts:819 | saga3_node_runs (new attempt) | node-durable identity (same generationKey) |
| 5 | LmNodeExecutor: reuse same task | lm-node-executor.ts:406 | — (same generationKey → same task row) | P18: no :recovery: suffix |
| 6 | buildSagaBoardLineageBag: strip recoveryFeedback | saga-board-adapter-data-builder.ts:153 | task.metadata (recovery_feedback in own field) | stable process_node_input_hash |
| 7 | New worker sees: same card + same desk + defect sheet | claude-runner.mjs (prompt) | — | — |
| 8 | New worker fixes, submits, worker_done | (same as SCN-002 steps 5-7) | — | — |
| 9 | Kernel verifier re-checks | (same handler) | — | if resolved: saga3_recovery_cases resolved |

**Observations:**
- Recovery is elegant: the workplace (node) is primary, worker is guest. Card and desk survive.
- The P18 invariant (stable node-input hash excluding recovery feedback) is the linchpin — without it, the reused card's metadata would fail "cannot be rebound"
- Recovery budget is bounded (maxAttempts in FlowRecoveryDefinition) and exhaustion produces explicit paused/failed outcome
- **The repair mechanic is the same for every module** — it lives in GenericFlowExecutor, not in module code. This is an emergent success (Phase 8 will note it).

---

## SCN-004: Authority enforcement — worker calls unauthorized tool

**Trigger:** Worker process calls MCP tool not in frozen `allowed_saga_tools`
**Entry point:** `authorizeSagaToolCall` (src/saga3/authority/authorize-saga-tool-call.ts:236)

| Step | Component | File:Line | State read | Decision |
|---|---|---|---|---|
| 1 | MCP CallToolRequestSchema handler | index.ts:173 | — | route to authorizeSagaToolCall |
| 2 | authorizeSagaToolCall | authorize-saga-tool-call.ts:236 | worker_executions.metadata (execution_context) | parse frozen snapshot |
| 3 | readExecutionContextStrict | authorize-saga-tool-call.ts:156 | worker_executions + tasks (JOIN) | validate hash, policy_version, authority_hash |
| 4 | Check: toolName in authority.allowed_saga_tools? | authorize-saga-tool-call.ts:283 | — | if NO → AUTHORITY_DENIED |
| 5 | Return error (isError: true) | index.ts:191 | — | tool handler NEVER runs |

**Observations:**
- Authority is checked BEFORE the handler runs — the handler is never called for unauthorized tools
- The frozen execution_context is the SINGLE source of truth (captured at claim time, immutable)
- `visibleSagaToolNames` (index.ts:147) ALSO filters the tool LIST — so unauthorized tools are invisible to the worker's MCP client. This is defense-in-depth (list filter + call gate).
- Advisory mode (`enforcement: 'advisory'`) logs but does NOT block — transitional state for backward compatibility

---

## SCN-005: Crash recovery — worker process dies

**Trigger:** Worker process exits without calling worker_done
**Entry point:** `reconcileWorkerExecutions` (worker-executions.ts:334) — periodic reaper

| Step | Component | File:Line | State read | State written | Decision |
|---|---|---|---|---|---|
| 1 | reconcileWorkerExecutions scans active executions | worker-executions.ts:362 | worker_executions (state IN active), tasks (JOIN) | — | SELECT all active for project/epic |
| 2 | Precompute IO booleans | worker-executions.ts:372-398 | worker_executions (timestamps), OS (isAlive, birthToken) | — | isAlive, birthTokenMatches, ownsActiveTask, legitimateIntegration/Finishing |
| 3 | decideStuckAction (PURE) | stuck-policy.ts:184 | — (input struct) | — (returns Action) | 6-step decision tree → KEEP/MARK_SUSPECTED/REQUEST_CANCEL/TERMINATE/RELEASE |
| 4 | [if TERMINATE] probe.killVerified | worker-executions.ts:455 | — | OS (SIGKILL/taskkill) | PID + birth token must match |
| 5 | [if TERMINATE succeeds] releaseExecutionAtomically | atomic-release.ts:138 | worker_executions, tasks | worker_executions (state=terminated), tasks (status=todo/review, assigned_to=null, fence cleared) | fence CAS |
| 6 | [if RELEASE] releaseExecutionAtomically | atomic-release.ts:138 | same | same (state=lost/spawn_failed) | fence CAS |
| 7 | recoverLegacyAssignments | worker-executions.ts:582 | tasks (current_execution_id IS NULL) | tasks (status=todo/review) | pre-ADR-009 tasks (no fence) |

**Observations:**
- The pure policy (step 3) has ZERO I/O — fully testable without mocks. This is Clean Architecture done right.
- PID reuse is handled: birth token (Windows CIM CreationDate, Linux /proc stat field 22) must match. Scenario 16 test proves this.
- Reserved executions (no PID yet) have 60s boot timeout — RESERVED_BOOT_TIMEOUT_MS
- **The reaper runs independently of the engine** — even if orchestrate-cli is stopped, the reaper (started by `startWorkerSupervision`) continues

---

## SCN-006: Cross-module handoff — Discovery certificate → Formalization input

**Trigger:** Discovery ProcessRun reaches terminal outcome (e.g., `go`)
**Entry point:** `LifecycleOrchestrator.completeStage` (lifecycle-orchestrator.ts:408)

| Step | Component | File:Line | What happens | Contract boundary |
|---|---|---|---|---|
| 1 | routeProcessOutcome | lifecycle-router.ts:23 | outcome 'go' → outcomeRoutes['go'] → {type:'stage', stageId:'solution-formalization'} | declarative routing table |
| 2 | completeStage | lifecycle-orchestrator.ts:408 | write saga3_stage_runs (completed), build handoffFrame | — |
| 3 | buildNextStageCommand | lifecycle-orchestrator.ts:532 | mapLifecycleValues(formalization.inputMapping, handoffFrame) | JSON-path reads ($.stages.initial-discovery.certificate.ref) |
| 4 | Formalization stage starts | lifecycle-orchestrator.ts:285 | processRunRepo.start({moduleRef: formalization, input: mappedInput}) | ProcessRun pinned to installationId |
| 5 | Formalization reads certificate | formalization-installation.ts (settlement) | reads saga3_discovery_outcome_certificates by ref | content-addressed read |

**Observations:**
- The handoff is MEDIATED by the LifecycleOrchestrator — modules never talk directly
- The contract is DECLARATIVE (inputMapping/outputMapping in StageBinding) — JSON path expressions, no code
- **The certificate reference crosses desk boundaries**: Discovery writes saga3_discovery_outcome_certificates; Formalization reads it by ref. This is a cross-desk read that works ONLY because the certificate is a durable row, not a managed-production-ledger entry.
- **If the desks were unified**, the handoff would be: read `workplace_products WHERE processRunId=<discovery-run> AND nodeId='settle'` — same mechanism, no module-specific certificate table

---

## SCN-007: Worker asks human (ASK protocol)

**Trigger:** Worker calls `worker_ask_need`
**Entry point:** `handleWorkerAskNeed` (dispatcher.ts:826)

| Step | Component | State written | Rule |
|---|---|---|---|
| 1 | worker_ask_need handler | human_requests (INSERT, state='open'), comments (ASK: reason) | assertExecutionFence |
| 2 | releaseExecutionAtomically | worker_executions (terminalized), tasks (assigned_to=null) | Slice 3: ASK is TERMINAL |
| 3 | Add needs-human tag | tasks.tags (JSON array append) | kanban visual (red pulse) |
| 4 | Response: stop:true | — | worker process exits cleanly |
| 5 | [later] worker_ask_done | human_requests (state='answered', answer recorded) | CAS UPDATE (only one caller wins) |
| 6 | Clear needs-human tag | tasks.tags (remove) | task becomes claimable again |
| 7 | Fresh worker claims task | (same as SCN-002 step 1) | reads question + answer from human_requests |

**Observations:**
- ASK is terminal — the worker process DIES. It does not wait inline. This matches the "managed worker is passive" model from ADR-010.
- The question and answer persist in `human_requests` — a fresh worker reads them via task metadata linkage
- The CAS UPDATE on `human_requests.state` ensures only one caller records an answer (worker_ask_done is idempotent via CAS)
- **No workflow stall**: other tasks continue while one is parked for human input

---

## SCN-008: Independent verification (AC property test)

**Trigger:** Verification task claimed by worker (saga-verifier skill)
**Entry point:** Worker reads AC artifact, generates L3 property tests

| Step | Component | State read | State written | Rule |
|---|---|---|---|---|
| 1 | Verifier reads AC artifact | artifacts (type='AC', accepted_hash) | — | frozen contract |
| 2 | Verifier generates property tests | (external: claude -p writes tests/) | filesystem | anti-self-certification: NOT from Builder's tests |
| 3 | Verifier runs tests | (external: Bash) | — | — |
| 4 | verification_record | lifecycle.ts:21 | verification_evidence | 4-valued: passed/failed/unknown/error |
| 5 | Gate check (settlement) | verification_evidence (outcome='passed', content_hash=accepted_hash) | — | only passed admits transition |
| 6 | [if failed ≥2 times] review-loop escape | dispatcher.ts:537 | tasks (status=done, metadata.verification_outcome=failed) | T-013: verifier found bugs, retrying is pointless |

**Observations:**
- Verification is structurally independent: different skill (saga-verifier), different test directory (tests/verifier/), different test layer (L3 property vs L2 example)
- The canonical target (`verification_target_artifact_id`) ensures cross-AC evidence is rejected — a verifier cannot "borrow" passing evidence from a neighboring AC
- The T-013 review-loop escape is a pragmatic compromise: after 2 failed attempts, the pipeline acknowledges the product has bugs and moves on (separate dev task needed)

---

## Cross-scenario observations

### Components that appear in EVERY scenario
- **SQLite** — every scenario reads and writes. No scenario works without it.
- **tasks table** — the central state. Every scenario touches it.
- **worker_executions table** — every scenario that involves a worker (all except pure routing).

### Components that appear in only ONE scenario
- **saga3_discovery_outcome_certificates** — only Discovery settlement
- **saga3_managed_node_submissions** — only Development planning
- **saga3_external_effect_events** — only Delivery

### Hidden orchestration (logic not visible from any single file)
- **Lifecycle progression** is split: LifecycleOrchestrator (stage routing) + GenericFlowExecutor (node walking) + orchestrate-cli (pause/drain/resume). No single component owns "the lifecycle is correct."
- **Product desk translation** is implicit: each module's installation file knows how to read its own desk, but there is no universal "read last product from previous module" function.
- **Authority propagation**: frozen at claim (work-assignment-core) → stored in worker_executions.metadata → read by MCP gateway (authorizeSagaToolCall) → enforced before handler. This chain spans 4 files in 3 layers.

### FINDING-004: Composition root is a God Object
- Classification: observed
- Evidence: `product-lifecycle-runtime.ts` (780 lines) constructs ALL concrete adapters for ALL 4 modules. Every module change requires editing this file. Every new module requires adding wiring here.
- This is the single largest obstacle to the LEGO principle: adding a module should NOT require editing composition root.
- Affected scenarios: SCN-001 (step 6), SCN-002 (indirectly — executor wiring), SCN-003 (recovery repos)

### FINDING-005: Four desks break cross-module data flow
- Classification: observed
- Evidence: SCN-006 shows a cross-module handoff that works ONLY because certificates are in a separate table (not in any of the 4 desks). If Formalization needed to read a Discovery PROPOSAL (not just the certificate), it would need to know about saga3_proposals table — a Discovery-specific desk.
- The "one desk" abstraction (saga3_process_products) exists but only Development uses it. Discovery, Formalization, and Delivery each have their own desk.
- Affected scenarios: SCN-001 (steps 9→13→15→21), SCN-006 (certificate handoff)

### FINDING-006: Worker lifecycle ownership is clean
- Classification: observed
- Evidence: The single-writer invariant for tasks.{status, assigned_to, current_execution_id} is enforced by source-level lint (tasks-writer-invariant.test.mjs) and proven by 8-way dispatcher race tests. Only 3 modules + 1 documented exception write owner columns.
- This is an emergent success: the ownership model was designed incrementally (ADR-009 + ADR-010 + Slice 1-5) but converged on a clean invariant.
- Affected scenarios: SCN-002, SCN-005, SCN-007
