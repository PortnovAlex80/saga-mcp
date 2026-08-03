# Executable Topology and Reachability Map

Artifact ID: ART-PHASE0-EXECUTABLE-TOPOLOGY
Artifact Type: Executable Topology and Reachability Map
Phase: Phase Zero
Version: 1.0
Status: evidence-incomplete
Created From: Full codebase context (≈890k tokens, saga4 branch)
Coverage: Production execution paths from entry points to side effects. Tests referenced but not treated as production evidence.
Confidence: High for declared+reachable paths (E3); Medium for configured (E4); Low for runtime-observed (E5/E6 unavailable)
Referenced Evidence: EVID-001 through EVID-026
Unresolved Questions: See Coverage Statement (QUESTION-001 through QUESTION-007)

---

## Process 1: MCP Server

```
ZCode MCP client (stdio)
  → src/index.ts:main() [EVID-001, E3]
    → StdioServerTransport.connect()
    → ListToolsRequestSchema handler
      → visibleSagaToolNames(db) — filters tool list by frozen execution_context
    → CallToolRequestSchema handler [EVID-002, E5]
      → authorizeSagaToolCall({toolName, db}) [EVID-003, E5]
        → if !decision.allow → return isError (AUTHORITY_DENIED)
      → ALL_HANDLERS[name](args)
        → handler writes to SQLite (shared DB_PATH)
      → spawn tracker-view (detached, port 4321) [EVID-001]
      → spawn docs-graph (detached, port 4322)
```

**Reachable state stores:** SQLite (all tables in DB_PATH)
**External side effects:** stdio output (MCP protocol), tracker-view/docs-graph child processes
**Dead code risk:** saga3-diagnosis handlers (EVID: E2 registered, E3 reachable, but diagnosis flow node REMOVED from discovery-process-module.ts:144 — "Д2: D5 Diagnosis REMOVED from outcome-critical flow")

## Process 2: Orchestration CLI

```
tracker-view POST /api/project/create-from-idea [E4]
  OR manual: node dist/orchestrate-cli.js <project_id> <epic_id>
  → src/orchestrate-cli.ts:main() [EVID-021, E4]
    → loadCompositionOverrides()
      → installProductionModules(db, repoRoot, 4 manifests) [EVID-026, E4]
        → FilesystemModulePackageStore.write() — filesystem blobs
        → SqliteModuleInstallationRepository — saga3_module_installations
    → createSaga2Application(env, overrides) [EVID-008, E2]
      → createProductLifecycleRuntime(options) [EVID-009, E2]
        → 4 × GenericFlowExecutor [EVID-010, E5]
        → ProcessModuleRegistry (4 modules) [E2]
        → KernelHandlerRegistry (all handlers from 4 installations) [E2]
        → LifecycleOrchestrator [E2]
        → LifecycleOrchestrationEngineAdapter [E2]
    → startWorkerSupervision() — periodic reaper [EVID-007, E5]
    → while(true):
        → application.runEpisode({projectId, epicId, lifecycleInput})
          → LifecycleOrchestrator.run(definition, command) [E2]
            → for each stage in productDeliveryLifecycle:
              → mapLifecycleValues(stage.inputMapping, durableFrame)
              → processRunRepo.start({moduleRef, input, installationId})
              → installation.executor.execute(module, context)
                → GenericFlowExecutor.execute(module, context) [EVID-010, E5]
                  → acquireExecutionLease (CAS on ProcessRun row)
                  → walk(module, context, nodeRunRepo, nodeExecutors) [EVID-010]
                    → for each node:
                      → nodeExecutors.get(node.kind).execute(ctx)
                        → [lm] LmNodeExecutor.execute(ctx) [EVID-011, E5]
                          → ensureExecutionPlan (WorkIntent + projected task)
                          → workAssignment.assignTask() [EVID-004, E5]
                            → findNextClaimable() — BEGIN IMMEDIATE [EVID-004]
                            → INSERT worker_executions (frozen execution_context)
                          → workerExecutor.start({assignment})
                            → ClaudeBoardRunner.launch() [EVID-012, E4]
                              → spawn claude -p (child process) [E4]
                              → per-execution MCP config (SAGA_EXECUTION_ID)
                              → poll loop: status → terminal?
                              → child.close → markExecutionExited
                          → poll: executor.status → terminal verdict
                          → return receipt
                        → [kernel] KernelNodeExecutor.execute(ctx) [E2]
                          → handler = kernelHandlers.get(node.handler)
                          → result = handler(ctx) — MODULE CONTENT
                          → exactCandidateAcceptance.accept(command) [EVID-017, E5]
                          → return production + completion
                        → [human] HumanNodeExecutor.execute(ctx) [E2]
                          → humanInteractions.get(node.interactionContract)
                          → adapter(ctx) — e.g. Delivery approval
                          → return production
                      → completeV2/start (dual-write NodeRun) [E5]
                      → reconcileRecoveryCheckpoint (recovery cases)
                      → if terminal: settle → certificate → ProcessRun completed
                    → return outcome + result
              → routeProcessOutcome(stage, outcome) — declarative routing [E2]
              → completeStage (handoff frame → next stage input)
            → return LifecycleExecutionResult
          → result.reason === 'paused'?
            → YES: distributeQueuedTasks() [EVID-020, E4]
              → workAssignment.assignTask → ClaudeBoardRunner.start [E4]
              → waitForAssignedWorker (poll)
              → loop until queue exhausted
            → NO: break (terminal: completed/failed)
```

**Reachable state stores:** SQLite (all tables), filesystem (.saga/package-store, .worktrees/), child processes (claude -p)
**External side effects:** git operations (worktree, merge, commit), claude CLI process spawns, MCP tool calls via per-execution MCP child

## Process 3: Tracker View

```
Browser → http://localhost:4321/ [E3]
  → tracker-view.mjs: http.createServer
    → withDb(db => ...) — read-only SQLite queries
    → withDbWrite(db => ...) — WAL write (artifact save, recovery)
    → boardRunner (ClaudeBoardRunner) [EVID-012]
      → recoverAssignment → releaseExecutionAtomically [EVID-005]
    → POST /api/project/create-from-idea → startProductLifecycleFromIdea [E4]
      → assembleProductLifecycleInput → assertProductDeliveryLifecycleInput
      → createSpawnCliLifecycleRunStarter → spawn orchestrate-cli [E4]
    → POST /api/engine/restart → kill + spawn orchestrate-cli
    → POST /api/model/set → patch ~/.claude/settings.json + lifecycle_execution_controls
    → GET /api/workers/active → worker_executions table
    → GET /api/worker/tail → JSONL log file (path-traversal guarded)
```

**Reachable state stores:** SQLite (read + limited write), ~/.claude/settings.json, worker JSONL logs
**External side effects:** orchestrate-cli process spawn, claude settings.json modification

## Dead Code / Disabled Paths

### DEAD-001: Discovery Diagnosis flow nodes
- **Location:** `discovery-process-module.ts:139-153`
- **Evidence:** Comment "Д2: D5 Diagnosis REMOVED from the outcome-critical flow"
- **Status:** `saga3-discovery-diagnosis-advisor` execution profile still DECLARED (lines 297-313) but no flow node references it
- **Handlers:** `saga3_diagnosis_*` MCP tools still registered in `src/index.ts:51,109`
- **Reachability:** E2 (registered), E3 (MCP tools reachable), but no Process Module flow activates them
- **Classification:** Fossil candidate (Phase 8 will assess)

### DEAD-002: Legacy saga2 engine branches
- **Location:** `composition-root.ts:169-194` (selectEngine)
- **Evidence:** "the discovery / discovery-generic / formalization / saga2 branches were removed"
- **Status:** Only Product Lifecycle runtime remains. `isSaga3LifecycleMode` retained but trivially true.
- **Classification:** Fossil (comment-only; code already removed)

### DEAD-003: episode_status / episode_transition MCP tools
- **Location:** `src/tools/lifecycle.ts:7-19`
- **Evidence:** "saga4 cutover: the legacy episode stage-machine MCP tools were REMOVED"
- **Status:** Only `verification_record` tool survives in this file
- **Classification:** Fossil (code removed; file repurposed)

### DEAD-004: v1 legacy NodeRun path in GenericFlowExecutor
- **Location:** `generic-flow-executor.ts:651-659` (legacy `nodeRunRepo.start`)
- **Evidence:** "When v2 is inactive, the legacy `start` + `frame`-only context is used byte-identically"
- **Status:** Production always activates v2 (wiring in product-lifecycle-runtime.ts). Legacy path is fallback for in-memory test fakes.
- **Classification:** Load-bearing for test compatibility (Phase 8 will assess)

### DEAD-005: `restoreFrame` symbol
- **Location:** REMOVED from generic-flow-executor.ts (Wave 6)
- **Evidence:** `no-execution-scoped-lookup.test.mjs` forbids re-introduction
- **Status:** Replaced by `assembleFrameFromDurableNodeRuns` boundary adapter
- **Classification:** Removed (forbidden-fallback ratchet enforced)

### UNKNOWN-001: Runtime reachability of 4 desks
- **Question:** Are all 4 product desks (saga3_proposals, saga3_managed_artifact_productions, saga3_managed_node_submissions, saga3_external_effect_events) actively written to in production runs?
- **Evidence:** E2 (tables exist), E3 (handlers reach them), E4 (composition wires them), E5 (tests write to them)
- **Missing:** E6 (no runtime logs/telemetry confirming production writes)
- **Classification:** Coverage gap — requires runtime observation

## Dynamic Registration Points

### REG-001: KernelHandlerRegistry.registerAll()
- **Location:** product-lifecycle-runtime.ts:448-475
- **Pattern:** `kernelHandlers.registerAll(create*KernelHandlers(deps))`
- **Modules registered:** discovery (6 handlers), formalization (7 handlers), development (2 handlers), delivery (4 handlers), process-outcome-emitter (1 generic)
- **Risk:** handler id strings must match Flow node.handler declarations — no compile-time check

### REG-002: ProcessModuleInstallationRegistry.register()
- **Location:** product-lifecycle-runtime.ts:595-602
- **Pattern:** `installationRegistry.register({definition, executor})`
- **Note:** Uses `as any` cast — bypasses type safety

### REG-003: ProcessModuleRegistry.register()
- **Location:** product-lifecycle-runtime.ts:585-589
- **Pattern:** `moduleRegistry.register(discoveryProcessModule)` etc.
- **Validation:** `validateProcessModuleDefinition` runs at registration time

### REG-004: Module package installation
- **Location:** orchestrate-cli.ts:430-440
- **Pattern:** `installProductionModules(db, repoRoot, [4 manifests])`
- **Dynamic:** reads resource files from disk, computes content digests, persists to package store
