# Module and Component Inventory

Artifact ID: ART-PHASE0-MODULE-INVENTORY
Artifact Type: Module and Component Inventory
Phase: Phase Zero
Version: 1.0
Status: evidence-incomplete
Created From: Full codebase context (≈890k tokens, saga4 branch)
Coverage: Production source units (src/, tracker-view/, tools/). Tests inventoried but not deeply inspected.
Confidence: High for production code structure; Medium for runtime behavior (E3-E5, no E6)
Referenced Evidence: file-manifest.jsonl (1544 units)
Unresolved Questions: See Coverage Statement

---

## Runnable Applications (Processes)

### PROC-001: MCP Server (saga-mcp)
- **Entry point:** `src/index.ts:224` → `main()` → `StdioServerTransport`
- **Process type:** stdio MCP server (spawned by ZCode as MCP child)
- **Auto-spawns:** tracker-view (port 4321) + docs-graph (port 4322) as detached children
- **Authority boundary:** `authorizeSagaToolCall` (E2: registered in `CallToolRequestSchema` handler at index.ts:187) intercepts EVERY tool call
- **State stores:** SQLite (`DB_PATH` env var), shared with tracker-view
- **Evidence level:** E3 (reachable from MCP client), E5 (tested via `npm test`)

### PROC-002: Orchestration CLI (orchestrate-cli)
- **Entry point:** `src/orchestrate-cli.ts:202` → `main()` → `application.runEpisode()` loop
- **Process type:** detached background process, spawned by tracker-view or manually
- **Lifecycle loop:** `while(true) { runEpisode → if paused: distributeQueuedTasks → resume }`
- **Auto-spawns:** worker processes via `ClaudeBoardRunner` (claude -p CLI)
- **Supervision:** `startWorkerSupervision` (Wave 5 watchman) runs periodically
- **State stores:** same SQLite DB as MCP server
- **Evidence level:** E3 (reachable from CLI), E4 (enabled by `SAGA_PRODUCT_LIFECYCLE_COMPOSITION`)

### PROC-003: Tracker View (kanban web server)
- **Entry point:** `tracker-view/tracker-view.mjs:1` → `http.createServer`
- **Port:** 4321 (configurable via `TRACKER_PORT`)
- **Process type:** detached child of MCP server, or standalone via `npm run tracker`
- **Spawns:** orchestrate-cli via `POST /api/project/create-from-idea` → `createSpawnCliLifecycleRunStarter`
- **State stores:** same SQLite DB (read-only `withDb`, read-write `withDbWrite`)
- **Evidence level:** E3 (reachable from browser), E4 (auto-started by `index.ts:236`)

### PROC-004: Docs Graph (artifact graph viewer)
- **Entry point:** `tracker-view/docs-graph/server.mjs`
- **Port:** 4322
- **Process type:** detached child of MCP server
- **Evidence level:** E3 (auto-started by `index.ts:269`)

### PROC-005: Worker Process (claude -p)
- **Entry point:** spawned by `ClaudeBoardRunner.launch()` (`tracker-view/claude-runner.mjs:680`)
- **Spawner:** `this.spawn(this.claudePath, args, { cwd, env, stdio: ['pipe','pipe','pipe'] })`
- **Lifecycle:** claim → spawn → poll → close → `markExecutionExited`
- **MCP child:** each worker gets its OWN saga MCP child process via `writeExecutionMcpConfig` (per-execution config with `SAGA_EXECUTION_ID`)
- **Evidence level:** E3 (reachable from dispatch-loop), E5 (tested via `tests/dispatcher-race/*`)

## Composition Roots

### ENTRY-001: `createSaga2Application` (src/app/composition-root.ts:101)
- **Selects:** Product Lifecycle runtime as the ONLY engine (saga4 cutover)
- **Constructs:** SqliteEpisodeRuntimeRepository, SqliteTaskRuntimeRepository, ClaudeBoardRunner factory
- **Throws if:** `overrides.productLifecycle` is missing (no implicit Delivery providers)
- **Evidence:** E2 (called by orchestrate-cli.ts:247)

### ENTRY-002: `createProductLifecycleRuntime` (src/app/product-lifecycle-runtime.ts:325)
- **Constructs:** 4 GenericFlowExecutor instances, ProcessModuleRegistry, KernelHandlerRegistry, HumanInteractionRegistry, LifecycleOrchestrator
- **Registers:** 4 process modules (discovery/formalization/development/delivery) + all kernel handlers + delivery human interactions
- **Evidence:** E2 (called by composition-root.ts:187), E5 (tested)

### ENTRY-003: `installProductionModules` (src/process-modules/installation/production-install.ts:121)
- **Installs:** 4 module packages into content-addressed store (`.saga/package-store/`)
- **Called by:** orchestrate-cli.ts:430, BEFORE runtime construction
- **Idempotency:** same DB + unchanged bytes → reuse active records
- **Evidence:** E2 (called by orchestrate-cli)

## Process Modules (Workshops)

### BLOCK-001: Discovery (`product-discovery@1.0.0`)
- **Definition:** `src/process-modules/modules/discovery/discovery-process-module.ts`
- **Flow:** 10 nodes (6 LM/kernel + 6 terminal outcome-emitters)
- **Entry node:** `produce-proposal` (LM)
- **Terminal nodes:** `complete-go`, `complete-clarify`, `complete-reject`, `complete-defer`, `complete-inconclusive`, `complete-failed`
- **Kernel handlers:** 6 (resolve-proposal, prepare-normalization, resolve-normalized, prepare-readiness, resolve-readiness, settlement-policy)
- **Installation:** `src/process-modules/modules/discovery/discovery-installation.ts`
- **Product desk:** `saga3_proposals` table (submit via `proposal_submit` MCP tool)
- **Settlement policy:** `discoverySettlementPolicyV1` (pure, `src/saga3/domain/discovery-settlement-policy.ts`)
- **Certificate:** `saga3.discovery-outcome-certificate.v1`
- **Evidence:** E2 (registered in product-lifecycle-runtime.ts:586), E5 (tested in tests/saga3/)

### BLOCK-002: Formalization (`solution-formalization@1.0.0`)
- **Definition:** `src/process-modules/modules/formalization/formalization-process-module.ts`
- **Flow:** 11 nodes (5 LM + 5 kernel resolvers + baseline-freezer + settlement + 5 terminal)
- **Recovery:** 5 recovery routes (repair-product/UC/AC/reconciliation/architecture)
- **Kernel handlers:** 7 (resolve-product, resolve-UC, resolve-AC, resolve-reconciliation, freeze-baseline, resolve-architecture, settlement)
- **Installation:** `src/process-modules/modules/formalization/formalization-installation.ts` (2043 lines — largest handler file)
- **Product desk:** `saga3_managed_artifact_productions` (via `artifact_create` MCP tool → managed-production-ledger)
- **Settlement policy:** `ReferenceFormalizationSettlementPolicy` (pure)
- **Certificate:** `saga3.solution-contract-certificate.v1`
- **Evidence:** E2 (registered), E5 (tested in tests/process-modules/)

### BLOCK-003: Development (`solution-development@1.0.0`)
- **Definition:** `src/process-modules/modules/development/development-process-module.ts`
- **Flow:** 3 nodes (plan-task-graph LM + resolve-task-graph kernel + settle-development kernel + 5 terminal)
- **Recovery:** 1 (repair-development-task-graph)
- **Kernel handlers:** 2 (resolve-task-graph, settle)
- **Product desk:** `saga3_managed_node_submissions` (via `process_node_submit` MCP tool)
- **Settlement policy:** `ReferenceDevelopmentSettlementPolicy` (pure, `development-settlement-policy.ts`)
- **Special:** settlement returns `runtimeEvent: 'paused'` when projected tasks not terminal → conveyor drains worker queue → resume
- **Certificate:** `saga3.development-certificate.v1`
- **Evidence:** E2 (registered), E5 (tested)

### BLOCK-004: Delivery (`product-delivery@1.0.0`)
- **Definition:** `src/process-modules/modules/delivery/delivery-process-module.ts`
- **Flow:** 5 nodes (preflight kernel + approve human + publish-deploy kernel + observe kernel + settle kernel + 4 terminal)
- **Kernel handlers:** 4 (preflight, publish-deploy, observe-release, settlement)
- **Human interactions:** 1 (approve-release)
- **Product desk:** kernel-only (no LM worker submit; publication/observation through injected provider ports)
- **Settlement policy:** `ReferenceDeliverySettlementPolicy` (pure)
- **Certificate:** `saga3.delivery-certificate.v1`
- **Evidence:** E2 (registered), E4 (requires `SAGA_PRODUCT_LIFECYCLE_COMPOSITION`)

## Core Runtime Components

### COMP-001: GenericFlowExecutor (`src/process-modules/application/generic-flow-executor.ts`)
- **Role:** Universal ProcessModuleRuntime — walks Flow nodes, dispatches by node.kind
- **Node executors consumed:** Map<'lm'|'kernel'|'human', NodeExecutor>
- **Key behaviors:** lease renewal, crash-resume via durable NodeRun, recovery checkpoint, Wave 4.5 completion propagation
- **Evidence:** E2 (instantiated for all 4 modules), E5 (characterization tests)

### COMP-002: LifecycleOrchestrator (`src/process-modules/application/lifecycle-orchestrator.ts`)
- **Role:** Drives stages of a LifecycleDefinition, maps inputs/outputs between stages
- **Key behaviors:** declarative routing via `outcomeRoutes`, transition budget (maxTransitions), lease watchdog
- **Evidence:** E2 (instantiated in product-lifecycle-runtime.ts:624), E5 (tested)

### COMP-003: LmNodeExecutor (`src/process-modules/application/node-executors/lm-node-executor.ts`)
- **Role:** Executes one LM node: ensureExecutionPlan → assignTask → spawn worker → poll
- **Key contract:** generates fence token BEFORE assignTask (Slice 1 Zones 1-4)
- **Evidence:** E2 (registered in product-lifecycle-runtime.ts:482), E5 (dispatcher-race tests)

### COMP-004: KernelNodeExecutor (`src/process-modules/application/node-executors/kernel-node-executor.ts`)
- **Role:** Dispatches to registered KernelHandler by node.handler id, applies exactCandidateAcceptance
- **Evidence:** E2 (registered in product-lifecycle-runtime.ts:481)

### COMP-005: findNextClaimable (`src/lifecycle/work-assignment-core.ts:252`)
- **Role:** Atomic card selection + status flip + fence creation in ONE BEGIN IMMEDIATE transaction
- **Single-writer invariant:** one of only 3 modules that may write `tasks.{status, assigned_to, current_execution_id}`
- **Selection logic:** review-first, priority order, conflict-key gate, dependency gate, human-request gate
- **Evidence:** E2 (called by SqliteWorkAssignmentAdapter + worker_next handler), E5 (dispatcher-race suite)

### COMP-006: releaseExecutionAtomically (`src/lifecycle/atomic-release.ts:138`)
- **Role:** Terminalize execution + release task in ONE transaction with fence CAS
- **Single-writer invariant:** one of only 3 modules
- **Evidence:** E2 (called by worker-executions reaper + worker_ask_need + claude-runner close), E5

### COMP-007: decideStuckAction (`src/lifecycle/stuck-policy.ts:184`)
- **Role:** PURE policy function — 6-step decision tree for reaper
- **Zero I/O:** no SQLite, no probe, no clock read
- **Evidence:** E5 (table-driven tests in tests/lifecycle/stuck-policy.test.mjs)

### COMP-008: authorizeSagaToolCall (`src/saga3/authority/authorize-saga-tool-call.ts:236`)
- **Role:** MCP gateway — validates frozen execution_context against every tool call
- **Fail-closed:** unlisted tool → AUTHORITY_DENIED; malformed context → AUTHORITY_CONTEXT_INVALID
- **Evidence:** E2 (called in index.ts:187 CallToolRequestSchema handler), E5

### COMP-009: ClaudeBoardRunner (`tracker-view/claude-runner.mjs:325`)
- **Role:** Worker process spawner — builds prompt, writes per-execution MCP config, spawns claude -p, polls, recovers
- **Key behaviors:** stdin-piped prompt (Windows 32767-char limit fix), frozen authority → allowedTools whitelist, package-pinned skills
- **Evidence:** E2 (instantiated in tracker-view.mjs:331), E5 (board-runner tests)

### COMP-010: SqliteManagedProductionLedger (`src/process-modules/persistence/sqlite-managed-production-ledger.ts:428`)
- **Role:** Machine-owned provenance ledger for worker products (artifacts + traces)
- **Wave 6 cutover:** execution-scoped methods REMOVED; only node-scoped reads survive
- **Evidence:** E2 (instantiated in product-lifecycle-runtime.ts:348), E5

## Persistence Mechanisms

| Store | Table(s) | Owner | Transaction model |
|---|---|---|---|
| Core tracker | projects, epics, tasks, subtasks, comments, notes, activity_log | schema.ts SCHEMA_SQL | SQLite WAL, foreign_keys ON |
| Work executions | worker_executions | db.ts (Wave 5 columns) | BEGIN IMMEDIATE for claim/release |
| Work items | task_work_items, work_attempts | schema.ts (Slice 2) | db.transaction for backfill |
| Human requests | human_requests | schema.ts (Slice 3) | CAS UPDATE for answer |
| Integration intents | integration_intents | schema.ts (Slice 5) | durable intent + ancestry observation |
| Command receipts | command_receipts, lifecycle_events | schema.ts (Slice 1) | idempotency via command_id |
| Supervision locks | supervision_locks | schema.ts (Wave 5 re-check) | CAS advisory lease |
| Lifecycle runs | saga3_lifecycle_runs, saga3_stage_runs | schema.ts + sqlite-lifecycle-run-repository | execution lease + version |
| Process runs | saga3_process_runs | sqlite-process-run-repository | installation_id pinning (Wave 2) |
| Node runs | saga3_node_runs | sqlite-node-run-repository | Wave 3 v2 columns + completion |
| Discovery products | saga3_proposals, saga3_raw_submissions, saga3_control_intents, saga3_normalization_proposals, saga3_readiness_*, saga3_discovery_settlements, saga3_discovery_outcome_certificates, saga3_discovery_diagnosis_* | schema.ts | immutable, content-addressed |
| Formalization products | saga3_managed_artifact_productions, saga3_managed_trace_productions | sqlite-managed-production-ledger | node-scoped provenance |
| Development products | saga3_managed_node_submissions | sqlite-managed-node-submission-repository | node-scoped provenance |
| Delivery products | saga3_external_effect_actions, saga3_external_effect_events | sqlite-delivery-runtime | kernel-only writes |
| Process products | saga3_process_products | sqlite-process-product-repository | content-addressed (Wave 3) |
| Outcome certificates | saga3_process_outcome_certificates | sqlite-process-outcome-certificate-repository | write-once (hash-unique) |
| Exact acceptance | saga3_exact_candidate_acceptance_decisions, saga3_exact_candidate_acceptance_items | sqlite-exact-candidate-acceptance | idempotent (command_id) |
| Recovery cases | saga3_recovery_cases, saga3_recovery_attempts | sqlite-recovery-case-repository | append-only attempts |
| Module installations | saga3_module_installations | sqlite-process-module-installation-repository | version-immutable (partial UNIQUE active) |
| Scenario installations | saga3_scenario_installations, saga3_scenario_module_locks | sqlite-scenario-installation-repository | version-immutable |
| Package store | `.saga/package-store/` (filesystem) | FilesystemModulePackageStore | content-addressed blobs |
| Trusted providers | trusted_providers | schema.ts | project-scoped or global |
| Conflict keys | task_conflict_keys | schema.ts | UNIQUE(task_id, key_type, key_value) |
| Verification evidence | verification_evidence | schema.ts | 4-valued outcome, execution-scoped |
| Runtime observations | runtime_observations | schema.ts | append-only |
| Lifecycle controls | lifecycle_execution_controls | schema.ts | per-epic engine state + model route |

## Configuration and Feature Flags

| Flag | Location | Effect |
|---|---|---|
| `DB_PATH` | process.env | Required: SQLite database path |
| `TRACKER_AUTOSTART=0` | index.ts:235 | Disable tracker-view auto-spawn |
| `DOCS_GRAPH_AUTOSTART=0` | index.ts:268 | Disable docs-graph auto-spawn |
| `SAGA_MANAGED_EXECUTION=1` | index.ts:61 | Enable authority gateway enforcement |
| `SAGA_EXECUTION_ID` | index.ts:62 | Frozen execution identity for MCP child |
| `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` | orchestrate-cli.ts:387 | REQUIRED: ESM module supplying Delivery providers |
| `SAGA_PRODUCT_LIFECYCLE_INPUT_JSON` | orchestrate-cli.ts:234 | Inline lifecycle input (no file on disk) |
| `SAGA_ALLOW_MANUAL_STATUS=1` | tasks.ts:795 | Escape hatch for manual status writes (recovery/admin) |
| `SAGA_PACKAGE_STORE_DIR` | orchestrate-cli.ts:440 | Override package store directory |
| `SAGA_CLAUDE_PATH` | claude-runner.mjs:334 | Override claude CLI binary path |
