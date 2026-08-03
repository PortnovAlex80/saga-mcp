# Phase 0 — Executable Topology and Reachability Map

## Process → Entry Point → Composition Root → Modules → State Stores

### PROC-001: MCP Server (stdio)

```
src/index.ts (299 lines)
  → new Server({ name: 'tracker', version: '1.0.0' })
  → StdioServerTransport
  → 22 tool-handler modules imported (projects, epics, tasks, ... saga3-proposals, saga3-normalization, saga3-readiness)
  → authorizeSagaToolCall({ toolName, db }) — authority gateway, default-deny for saga3 runtime
  → getDb() → SQLite (DB_PATH)
  → Auto-spawns PROC-003 (tracker-view) + PROC-005 (docs-graph) as detached children
```

**Reachability:** E4 (configured via package.json `bin.saga-mcp`), E5 (tested).
**Does NOT construct the lifecycle engine.** It serves MCP tools that other processes call. The 4 Process Modules are NOT loaded here — only their tool surfaces (`saga3-proposals`, `saga3-normalization`, `saga3-readiness`, `process-node-submit`, `delivery-approvals`, etc.) are registered as MCP handlers.

**State stores:** `projects`, `epics`, `tasks`, `subtasks`, `notes`, `artifacts`, `artifact_traces`, `activity_log`, `worker_executions`, `lifecycle_execution_controls`, `saga3_proposals`, `saga3_normalization_proposals`, `saga3_readiness_assessments`, `saga3_settlements`, `saga3_certificates`.

---

### PROC-002: Orchestrate-CLI (Engine Host + Dispatch Loop)

```
src/orchestrate-cli.ts (455 lines)
  → parse args: projectId, epicId, --concurrency, --lifecycle-input, --idempotency-key, --resume
  → loadCompositionOverrides(projectId, epicId)
      → REQUIRES env SAGA_PRODUCT_LIFECYCLE_COMPOSITION (throws if missing)
      → dynamic-import that ESM module → createProductLifecycleComposition
      → installProductionModules(db, repoRoot, [4 package manifests], SAGA_PACKAGE_STORE_DIR)
  → createSaga2Application(process.env, overrides)
      → selectEngine → createProductLifecycleRuntime(options)        ← THE LEGO COMPOSITION ROOT
          → src/app/product-lifecycle-runtime.ts (617 lines)
          → Constructs 14 shared deps + 4 registries
          → registerDiscovery(registries, sharedDeps)                 ← LEGO CALL #1
          → registerFormalization(registries, sharedDeps)             ← LEGO CALL #2
          → registerDevelopment(registries, sharedDeps, devOpts)      ← LEGO CALL #3
          → registerDelivery(registries, sharedDeps, deliveryOpts)    ← LEGO CALL #4
          → Returns { engine, orchestrator, executors.{4}, ... }
  → start workerSupervision (reconcileWorkerExecutions)
  → LOOP: application.runEpisode(...) ↔ distributeQueuedTasks(...) until terminal
```

**Reachability:** E4 (configured via `npm run mock:run` and spawned by tracker-view admin endpoint `startProductLifecycleFromIdea`), E5 (tested via `tests/process-modules/`).

**This is the ONLY process that constructs the LEGO composition root.** The 4 register functions are invoked here, populating `kernelHandlers`, `humanInteractions`, `moduleRegistry`, `installationRegistry`.

**State stores:** all of PROC-001 PLUS `saga3_lifecycle_runs`, `saga3_process_runs`, `saga3_node_runs`, `saga3_process_products`, `saga3_managed_artifact_productions`, `saga3_managed_node_submissions`, `saga3_external_effect_events`, `saga3_external_effect_ledger`, `saga3_recovery_cases`, `package_installations`, `project_repositories`, `repository_checkouts`.

---

### PROC-003: Tracker-View (Web Kanban)

```
tracker-view/tracker-view.mjs (569 lines — was 5605 pre-migration, -90%)
  → createSagaControlApplication(process.env)         ← CONTROL-ONLY composition
      → src/app/composition-root.ts → SagaControlApplication
      → SqliteBoardProjectionReader + LegacyEngineAdministration
      → NO engine, NO workers, NO Delivery providers
  → 8 focused modules (factory-injection pattern):
      shared.mjs, board-runner-adapter.mjs, model-management.mjs,
      admin-endpoints.mjs, lifecycle-endpoints.mjs,
      artifact-render.mjs, board-render.mjs, tracker-view.mjs (core)
  → HTTP server on PORT (4321)
  → Admin endpoint → startProductLifecycleFromIdea → spawns PROC-002 as background process
```

**Reachability:** E4 (configured via `npm run tracker`), E5 (architecture tests assert boundaries).
**Uses the CONTROL-ONLY composition deliberately** — tracker-view must not import Delivery providers.

**State stores:** reads from the SAME SQLite DB (WAL-safe concurrent reads).

---

### PROC-004: Worker Processes (LM-node spawns)

```
spawned by legacy-claude-worker-executor-factory.ts:297 (spawn)
  → Each worker = `claude` (or mock-claude) child process
  → Gets --mcp-config pointing at dist/index.js as the `saga` MCP child
  → Pinned to an immutable package snapshot (PACKAGE_INSTALLATION_REQUIRED if missing)
  → Worker connects BACK to PROC-001 (MCP server) for mcp__saga__* tools
  → Worker writes via MCP tools to the shared DB
  → Worker's workspace = git worktree per task
```

**Reachability:** E3 (constructed by dispatch-loop via `distributeQueuedTasks`), E5 (tested with mock-claude).
**These are NOT saga entry points** — they are external LLM processes that consume saga as an MCP tool server.

---

### PROC-005: Docs-Graph (Web, secondary)

```
tracker-view/docs-graph/server.mjs
  → HTTP server on port 4322
  → Visualizes the architecture dependency graph
  → Auto-spawned by PROC-001 (src/index.ts main())
```

**Reachability:** E4 (configured), E5 (smoke-tested). Low architectural significance.

---

## LEGO Composition Root — Detailed Wiring

### `src/app/product-lifecycle-runtime.ts` (617 lines)

The migration replaced a 915-line God Object with 4 register calls. The shared-deps construction is still substantial (lines 222-425) because it constructs adapters that all 4 modules share, but the PER-MODULE wiring is now encapsulated.

**Shared deps constructed (lines 222-327):**
- `processRunRepo` — `SqliteProcessRunRepository`
- `nodeRunRepo` — `SqliteNodeRunRepository`
- `certificateRepo` — `SqliteCertificateRepository`
- `recoveryCaseRepo` — `SqliteRecoveryCaseRepository`
- `lifecycleRunRepo` — `SqliteLifecycleRunRepository`
- `processProductRepo` (v1) — `SqliteProcessProductRepository`
- `processProductRepoV2` — `SqliteProcessProductRepositoryV2`
- `workplaceProductPort` — `SqliteWorkplaceProductAdapter(db, processProductRepoV2)` ← T8 additive
- `assemblerProductRepo` — inline structural type with NodeRun + recovery-feedback fallbacks
- `runtimePersistence` — Discovery persistence bundle
- `managedNodeSubmissions` — `SqliteManagedNodeSubmissionRepository`
- `exactCandidateAcceptance` — `SqliteExactCandidateAcceptance` (1456 lines, the universal convergence gate)
- `centralLedger` + `resolveNodeProducts`

**Registries constructed (lines 372-384):**
- `kernelHandlers` — Map, starts with 1 cross-module handler (`processOutcomeEmitter`)
- `humanInteractions` — Map, starts empty
- `moduleRegistry` — Map
- `installationRegistry` — Map

**The 4 LEGO calls (lines 436-439):**
```
registerDiscovery(registries, sharedDeps);
registerFormalization(registries, sharedDeps);
registerDevelopment(registries, sharedDeps, options.development ?? {});
registerDelivery(registries, sharedDeps, options.delivery);
```

Each register function:
1. Reads shared deps
2. Constructs module-specific adapters
3. Registers kernel handlers into `registries.kernelHandlers`
4. Builds a `GenericFlowExecutor` pinned to its module identity
5. Registers module definition + installation into `moduleRegistry` + `installationRegistry`

**Post-registration state:**
- `kernelHandlers`: 1 cross-module + 4 module-specific handler bundles
- `humanInteractions`: ONLY Delivery (delivery-approval interaction)
- `moduleRegistry`: 4 Process Module definitions
- `installationRegistry`: 4 `{ definition, executor }` entries

---

## Reachability Distinctions (per protocol §10.4)

| Symbol Category | Declared (E0) | Referenced (E1) | Instantiated (E2) | Reachable from entry (E3) | Configured (E4) | Tested (E5) | Runtime-observed (E6) |
|---|---|---|---|---|---|---|---|
| 4 register functions | ✅ | ✅ | ✅ (product-lifecycle-runtime.ts:436-439) | ✅ (via orchestrate-cli) | ✅ (SAGA_PRODUCT_LIFECYCLE_COMPOSITION) | ✅ (tests/process-modules/) | ❌ unavailable |
| WorkplaceProductPort | ✅ | ✅ | ✅ (product-lifecycle-runtime.ts:235) | ⚠️ constructed but no caller | ✅ | ⚠️ adapter tested, port unconsumed | ❌ unavailable |
| saga3-*-engine.ts | ✅ | ✅ | ❌ (not from selectEngine) | ⚠️ only via direct test construction | ❌ (cutover removed branches) | ✅ (direct test imports) | ❌ |
| MCP tool handlers | ✅ | ✅ | ✅ (src/index.ts) | ✅ | ✅ | ✅ | ❌ |

## Dead Code / Migration Leftovers

1. **`src/engines/saga3-discovery-engine.ts` (1098 lines)** + **`src/engines/saga3-formalization-engine.ts`** — retired by saga4 cutover (selectEngine branches removed). Still reachable by direct test construction. Fossil candidate.

2. **`src/process-modules/composition/product-lifecycle-runtime.ts` (70 lines)** — shim re-export. The body moved to `src/app/`. Consumed by `composition-root.ts` + 2 test files for back-compat.

3. **`tests/saga3/` (24 files)** — test folder retains old name. No live `saga3/` path imports remain. Rename/relocation pending.

4. **`saga3` identifier in 8 filenames** — `saga3-discovery-engine.ts`, `saga3-formalization-engine.ts`, 6 discovery infrastructure files. Naming legacy, not blocking.

5. **`canonical-json.ts` dual location** — `src/shared/` (canonical) + `src/process-modules/shared/` (re-export). Intentional dependency-inversion boundary or unnecessary indirection — to be resolved in Phase 4.
