# Phase 3 — Delete Legacy Saga2 Episode Execution Engine

**Branch:** `saga4`
**Scope:** READ-ONLY investigation output. This document is the only artifact.
**Goal:** Precise deletion manifest for the legacy Saga2 episode-execution pump, distinguishing "pure legacy" (safe to DELETE entirely) from "shared infra that only the legacy engine uses" (KEEP — rename later) and from inline removals inside shared files.

---

## 0. Executive Summary & Critical Findings

The Saga2 "legacy engine" is **not a clean separable component**. Its boundary types carry the misleading `Saga2*` prefix but are in fact **shared infrastructure consumed by the saga3/lifecycle production path**. Three traps must be respected:

### TRAP 1 — `Saga2HostRuntime` and `Saga2RuntimePersistence` are SHARED, NOT legacy-only
Despite the names, these ports are imported by saga3 production code:
- `src/engines/saga3-discovery-engine.ts:8,9` — uses `host.workerPaths`, `host.heartbeat`, `host.acquireEngineLock`, `host.releaseEngineLock`.
- `src/saga3/application/discovery-normalization-service.ts:1,28,92-102` — uses `host.workerPaths.*`.
- `src/saga3/application/discovery-readiness-service.ts:11,43`
- `src/saga3/application/discovery-diagnosis-service.ts:25,107`
- `src/app/composition-root.ts` — `buildDiscoveryWorkerContext()` (line 493) and `buildDiscoveryGenericEngine()` (line 370) both thread `host` through to saga3 node executors.

**Verdict:** These two port files MUST be KEPT. They are candidate for a **Phase-4 rename** (`Saga2HostRuntime` → `HostRuntime` / `Saga2RuntimePersistence` → `RuntimePersistence`) but must NOT be deleted in Phase 3. See §3.

### TRAP 2 — `episode_workflows` table and the `episode_transition` / `workflow_generate_next` MCP tools are SHARED
- The `episode_workflows` table is the saga3 episode-stage state store (`schema.ts:77`). It is NOT deleted.
- `handleEpisodeTransition` (`lifecycle.ts:273`) backs the `episode_transition` MCP tool, registered globally in `index.ts:100,130`. Used by saga3 (`advanceReadyEpisodes` → `dispatcher.ts:631`, the saga3 claim path).
- `generateNextForCompletedTask` (`workflow.ts:365`) is called by `dispatcher.ts:8` in the saga3 path.
- All `UPDATE episode_workflows` writes in `lifecycle.ts` (lines 331-335, 361-366, 370-379) are inside **shared** functions (`handleEpisodeTransition`, `advanceReadyEpisodes`). **NONE are legacy-only.** Do not remove them.

### TRAP 3 — `LegacyEngineAdministration` is process-control infra, not the pump
`LegacyEngineAdministration` implements the `EngineAdministration` port (`start`/`stop`/`restart`/`status`/`setConcurrency`). It spawns `orchestrate-cli.js` as a detached child and kills its process tree. The `windowsHide` + powershell `Get-Descendants` + `pkill` subprocess machinery is **generic process orchestration** that survives the pump deletion — it is how ANY background engine (including the saga3 lifecycle orchestrator, which still uses `orchestrate-cli.ts` as its entrypoint) is launched and terminated. The class name is misleading; it is **KEEP-and-rename**, not delete. See §7.

---

## 1. Pure-Legacy Files — DELETE Entirely

Each file below was verified to have **no saga3/lifecycle production-path importer**. Importer grep results are shown.

### 1.1 `src/orchestrate.ts` (1208 lines) — DELETE ENTIRELY
The Saga2 autonomous pump loop. Self-contained except for two imports that flow INTO shared tools (not FROM them).

**Importer grep:** `grep -rn "from.*orchestrate['\"]" src/ tests/` → **zero** production importers.
Only consumers:
- `src/engines/saga2-engine.ts:9` — `import { orchestrate }` (this file is itself being deleted, §1.3).
- `tests/e2e-pipeline.test.mjs:47`, `tests/track-pipeline.test.mjs` — characterization tests (deleted in §5).

**Contents removed:** the entire module, including:
- `orchestrate()` export (the pump loop, lines 793-1208)
- `tryAdvanceStage` (line 462)
- `Saga2PumpState` interface (line 72)
- `RECOVERY_TREE` const (lines 99-311) + `RecoveryRule` interface
- `attemptHeal` (line 541), `spawnGenericRecoveryTask` (line 596), `spawnPostTransitionRecovery` (line 651)
- `detectAndKillZombies`, `detectRateLimits`, `computeEffectiveConcurrency`
- `generateNextIfReady` (the inline caller of `generateNextForCompletedTask`)
- `pauseAndAlert`, `waitForResume`, `resetHealRetriesForEpic`
- All episode/recovery helpers (`currentStage`, `countActiveTasks`, etc.)

The shared functions `generateNextForCompletedTask` and `handleEpisodeTransition` live in OTHER files and are NOT removed (see §2).

### 1.2 `src/engines/saga2-engine.ts` (47 lines) — DELETE ENTIRELY
Thin wrapper: `Saga2Engine.run()` → `orchestrate(...)`. This is the only `OrchestrationEngine` implementor that is pure Saga2.

**Importer grep:** only `src/app/composition-root.ts:18` imports `Saga2Engine`. The composition root's fallback branch (`selectEngine`, line 352) is the single construction site — removed in §4.1.
Tests: `tests/architecture/saga2-boundaries.test.mjs:11` (deleted in §5).

**Contents removed:** the entire class + `Saga2EngineDependencies` interface.

### 1.3 `src/process-modules/application/legacy-engine-executor-adapter.ts` (117 lines) — DELETE ENTIRELY
The "thin shim" bridging an `OrchestrationEngine` onto the `ProcessModuleExecutor` SPI. **Dead code:** no saga3 path imports it.

**Importer grep (value imports):**
```
grep -rn "LegacyEngineExecutorAdapter|certificateOnlyResult|outputOnlyResult" src/
```
→ **ZERO value importers.** Only references are:
- `src/process-modules/application/legacy-run-inventory.ts:47,111,114` — documentation comments naming the file path as a string literal (`LEGACY_ENGINE_EXECUTOR: 'legacy-engine-executor-adapter'`), not an import.
- Tests: `tests/process-modules/process-module-installation.test.mjs:29`, `tests/process-modules/legacy-run-inventory.test.mjs:574` (deleted in §5).

The saga3 path uses `GenericFlowEngineAdapter` + `GenericFlowExecutor` instead (composition-root.ts:450, 427). The `ExistingOrchestrationEngineAdapter` (a DIFFERENT class in `process-module-runtime-engine.ts`) is the one saga3 actually uses for the legacy `saga3-discovery` mode — do NOT confuse the two.

**Contents removed:** `LegacyEngineExecutorAdapter` class, `LegacyOutcomeProjector` / `LegacyCommandTranslator` types, `certificateOnlyResult` / `outputOnlyResult` helpers.

---

## 2. Shared Files — INLINE removals ONLY (do not delete the files)

### 2.1 `src/app/composition-root.ts`
**Remove the Saga2 fallback branch in `selectEngine()`.**

| Location | What | Action |
|---|---|---|
| `composition-root.ts:18` | `import { Saga2Engine } from '../engines/saga2-engine.js';` | DELETE line |
| `composition-root.ts:349-357` | `// Every other recognised mode (v2 / v3 / saga2) selects Saga2Engine.` block + `return new Saga2Engine({...})` | DELETE the fallback `return`. Replace with an explicit throw: `throw new Error('SAGA2_MODE_REMOVED: v2/v3/saga2 orchestration modes are no longer supported. Use saga3-discovery-generic, saga3-formalization, or saga3-lifecycle.')` |
| `composition-root.ts:193` (comment in `selectEngine` docstring) | `SAGA_ORCHESTRATION_MODE=v2|v3|saga2 -> Saga2Engine` | DELETE the doc line |

**KEEP:** everything else — `NodeSaga2HostRuntime` wiring (line 153), `SqliteEpisodeRuntimeRepository`/`SqliteTaskRuntimeRepository`/`SqliteExecutionRuntimeRepository` wiring (lines 139-144), `LegacyEngineAdministration` (lines 120, 171), `buildDiscoveryWorkerContext`, `buildDiscoveryGenericEngine`. These feed the saga3 engines.

### 2.2 `src/orchestrate-cli.ts` — KEEP (with one comment edit)
This is the **entrypoint for ALL background engines**, including saga3-lifecycle. The CLI parses args, loads composition overrides, calls `createSaga2Application().runEpisode()`. Under saga3 modes the application returns a saga3 engine from `selectEngine()`.

| Location | What | Action |
|---|---|---|
| `orchestrate-cli.ts:7-10` (header comment) | `The composition root currently selects Saga2Engine, which wraps the proven orchestrate pump without changing its behavior.` | UPDATE comment — `createSaga2Application` is now a misnomer; it returns whichever saga3 engine the selected mode requires. No code change. |
| `orchestrate-cli.ts:78-80` (`--help` text) | Reference to `SAGA_ORCHESTRATION_MODE=saga3-lifecycle` | KEEP — accurate. |

No code deletion in this file. The function `createSaga2Application` retains its name (rename is a Phase-4 cosmetic concern; renaming now breaks `tests/execution/product-delivery-integration.test.mjs` and others that import it).

### 2.3 `src/tools/workflow.ts` — KEEP entirely
`generateNextForCompletedTask` (line 365) is **shared** — called by:
- `src/tools/dispatcher.ts:8,631` (the saga3 claim path, inside `worker_next`).
- `src/orchestrate.ts:28` (the deleted pump — this import disappears with §1.1).

**Do NOT remove** `generateNextForCompletedTask`, `handleWorkflowGenerateNext`, the `workflow_generate_next` tool definition (line 393), or its handler registration (line 410). The MCP tool `workflow_generate_next` is registered globally in `index.ts:99,129` and is a saga3 tool.

### 2.4 `src/tools/lifecycle.ts` — KEEP entirely
All episode-transition logic is shared saga3 infra.

| Location | What | Verdict |
|---|---|---|
| `lifecycle.ts:331-335` (`UPDATE episode_workflows SET stage=...`) | Inside `handleEpisodeTransition` (line 273) — backs the `episode_transition` MCP tool | **KEEP** |
| `lifecycle.ts:361-366` (`UPDATE ... json_remove $.last_gate_error`) | Inside `advanceReadyEpisodes` (line 341) | **KEEP** — called by `dispatcher.ts:631` |
| `lifecycle.ts:370-379` (`UPDATE ... json_set $.last_gate_error`) | Inside `advanceReadyEpisodes` | **KEEP** |
| `lifecycle.ts:485-531` (`episode_transition` + `episode_status` + `verification_record` tool definitions) | MCP tool registry entries | **KEEP** — registered in `index.ts:100,130` |
| `lifecycle.ts:533-537` (`handlers` map) | MCP handler registry | **KEEP** |

The brief-decision / fast-track logic (`NEXT_FAST_TRACK`, `nextStageForTrack`, lines 35-44) is read by `handleEpisodeTransition` — KEEP.

### 2.5 `src/runtime/orchestration-mode.ts` — INLINE edit
The mode enum still lists `v2`, `v3`, `saga2` as valid values. After Phase 3 these modes are unreachable (no engine selects them), but `parseOrchestrationMode` still accepts them and `DEFAULT_ORCHESTRATION_MODE` is still `'v2'`.

| Location | What | Action |
|---|---|---|
| `orchestration-mode.ts:50-57` | `OrchestrationMode` union includes `'v2' \| 'v3' \| 'saga2'` | DECISION POINT — see §8. Either (a) remove the three modes + change default, or (b) keep them accepted but make `selectEngine` throw (already done in §2.1). Recommend (b) for Phase 3 to avoid breaking existing operator env/config; (a) is a Phase-4 cleanup. |
| `orchestration-mode.ts:65` | `DEFAULT_ORCHESTRATION_MODE = 'v2'` | Leave for Phase 3; revisit in Phase 4. |

### 2.6 `src/index.ts` — NO change
The MCP tool registry (`ALL_TOOLS`, `ALL_HANDLERS`, lines 84-142) imports `workflowDefs`/`workflowHandlers` (line 28) and `lifecycleDefs`/`lifecycleHandlers` (line 29). **No tool needs unregistering** — both `episode_transition` and `workflow_generate_next` are saga3 tools and stay registered.

---

## 3. Port files — KEEP (Phase-4 rename candidates)

### 3.1 `src/application/ports/saga2-host-runtime.ts` (42 lines) — KEEP
Defines `Saga2HostRuntime`, `Saga2HostContext`, `Saga2WorkerRuntimePaths`, `EngineLockAcquisition`. Used by saga3 (§0 TRAP 1). The only methods NOT used by saga3 are `scanRateLimitSignals` and `acquireEngineLock`/`releaseEngineLock` is used by saga3-discovery-engine. Actually all of `workerPaths`, `now`, `sleep`, `heartbeat`, `acquireEngineLock`, `releaseEngineLock` are used by `saga3-discovery-engine.ts`. Only `scanRateLimitSignals` is saga2-pump-only.

**Phase-3 action:** KEEP the file. Optionally remove `scanRateLimitSignals` from the interface (only implementor is `NodeSaga2HostRuntime` which is also KEPT) — but this is cosmetic; recommend deferring to Phase 4 rename to avoid churn.

### 3.2 `src/application/ports/saga2-runtime-persistence.ts` (97 lines) — KEEP
Defines `Saga2RuntimePersistence`, `EpisodeRuntimeRepository`, `TaskRuntimeRepository`, `ExecutionRuntimeRepository`, `WorkspaceResolver`, plus shared types (`BriefDecision`, `StageTaskCounts`, `RateLimitTaskProjection`, etc.).

**Phase-3 action:** KEEP. Used by saga3-discovery-engine, composition-root, sqlite-workspace-resolver. The `WorkspaceResolver` and `RateLimitTaskProjection` types are consumed outside the pump.

---

## 4. Infrastructure files — KEEP (with rationale)

### 4.1 `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` (306 lines) — KEEP
Three repository classes (`SqliteEpisodeRuntimeRepository`, `SqliteTaskRuntimeRepository`, `SqliteExecutionRuntimeRepository`). Constructed in `composition-root.ts:139-144` and injected into **both** the deleted Saga2Engine AND the kept saga3 engines (`buildDiscoveryGenericEngine` reads `persistence.workspaces`; `buildDiscoveryWorkerContext` calls `persistence.workspaces.resolve`).

**Phase-3 action:** KEEP. The `episode_workflows` reads/writes here are the saga3 lifecycle state store. Class name is a Phase-4 rename candidate.

### 4.2 `src/infrastructure/runtime/node-saga2-host-runtime.ts` (210 lines) — KEEP
`NodeSaga2HostRuntime` — the filesystem/PID/clock implementation of `Saga2HostRuntime`. Constructed in `composition-root.ts:153` and injected into saga3 engines.

**Phase-3 action:** KEEP. Note: `scanRateLimitSignals` (lines 144-173) and the `RATE_LIMIT_*` constants (lines 25-26) become dead code once the pump is gone (only `orchestrate.ts` called `scanRateLimitSignals`). Optional Phase-3 inline removal: delete `scanRateLimitSignals` method + `RATE_LIMIT_LOG_TAIL_BYTES`/`RATE_LIMIT_PATTERN` + `resolveWorkerLogPath` helper. Low risk — but recommend Phase-4 to keep the diff focused.

### 4.3 `src/orchestrate-cli-scenario-adapter.ts` — KEEP (NOT legacy)
This is the **Wave 11 cutover adapter** — the NEW saga3 scenario-selection path. It imports only ports (`SagaApplication`, `OrchestrationEngine`, `ScenarioRunner`) and `legacyProductDeliveryScenarioFor`. It does NOT import `Saga2Engine` or `orchestrate.ts`. Do not delete.

### 4.4 `src/process-modules/application/legacy-run-inventory.ts` — KEEP (audit doc)
References `'legacy-engine-executor-adapter'` only as a string literal in documentation/inventory output (lines 47, 111, 114). After §1.3 deletes the adapter, this string becomes a historical reference. UPDATE the inventory doc to mark the adapter as retired, or leave as historical record. No code deletion.

---

## 5. Characterization Tests to DELETE / ADAPT

These test files exercise the deleted pump behavior. They must be deleted or rewritten in the same Phase-3 commit, or the build breaks.

### 5.1 DELETE entirely (exercise only deleted code)
| Test file | Why delete |
|---|---|
| `tests/architecture/saga2-boundaries.test.mjs` | Imports `Saga2Engine`, `NodeSaga2HostRuntime`, `LegacyEngineAdministration` and asserts the Saga2 pump consumes only injected ports (line 78). The `Saga2Engine` class is deleted. The test's *purpose* (legacy boundary) ceases to exist. |
| `tests/characterization/saga2-runtime-contracts.test.mjs` | Characterizes the saga2 port/repository contract shapes. Still largely valid (the ports are kept), but several assertions read `src/engines/saga2-engine.ts` and `src/infrastructure/engine/legacy-engine-administration.ts` source (lines 91-121). ADAPT: remove the assertions targeting deleted files; keep the port-shape assertions, OR delete and rely on the kept infra's own tests. Recommend DELETE — the kept infra has dedicated tests. |
| `tests/e2e-pipeline.test.mjs` | Drives `orchestrate({...})` directly (line 149) with mock-claude to assert the pump reaches `completed`. The `orchestrate` export is deleted. DELETE. |
| `tests/track-pipeline.test.mjs` | Same shape as e2e-pipeline — drives the orchestrate pump end-to-end. DELETE. |
| `tests/process-modules/process-module-installation.test.mjs` | Imports `legacy-engine-executor-adapter.js` (line 29) to test the SPI shim. The shim is deleted. DELETE (or ADAPT if it also covers generic-flow installation — check before deleting). |
| `tests/process-modules/legacy-run-inventory.test.mjs:574` | Asserts the inventory lists `'legacy-engine-executor-adapter'`. After §1.3 + §4.4 the adapter is retired. ADAPT the expected inventory output (remove the entry) rather than delete the whole test. |

### 5.2 ADAPT (mixed coverage)
| Test file | Change |
|---|---|
| `tests/architecture/cutover-architecture-checks.test.mjs` | Locks file-path allowlists. No saga2-engine/orchestrate entries to remove (it locks the scenario adapters). Verify no assertion references deleted files; likely NO change. |
| `tests/execution/product-delivery-integration.test.mjs` | Uses `createSaga2Application` + `orchestrate-cli-scenario-adapter`. Should still pass (application returns saga3 engine). Verify it does not construct `Saga2Engine` directly. |
| `tests/execution/w11-a4-scenario-selection-adapters.test.mjs` | Tests the scenario adapter (kept). Likely NO change. |
| `tests/lifecycle/engine-control.test.mjs`, `tests/lifecycle/concurrency-transition.test.mjs` | Exercise `LegacyEngineAdministration` (kept). Should still pass. |
| `tests/product-workflow.test.mjs` | Verify whether it drives `orchestrate()` or only the workflow/lifecycle tools. If the former, ADAPT; if the latter, NO change. |
| `tests/lifecycle/architecture.test.mjs` | Check for saga2-engine references. |

### 5.3 Coverage gap to backfill BEFORE deletion
Before deleting `tests/e2e-pipeline.test.mjs` and `tests/track-pipeline.test.mjs`, confirm an equivalent saga3 end-to-end test exists (e.g. `tests/execution/product-delivery-integration.test.mjs`). The deleted tests were the only characterization of the full discover→formalize→plan→develop→verify→integrate pump. If no saga3 equivalent covers that breadth, flag a gap for Phase 3.5 rather than lose the coverage silently.

---

## 6. MCP Tool Registry — NO unregistering required

Grep of `src/tools/` for tool registration confirms:
- `episode_transition` and `episode_status` and `verification_record` are registered in `lifecycle.ts:485-537`, aggregated in `index.ts:100,130`. These are **saga3 tools** (the saga3 dispatcher calls `advanceReadyEpisodes` which calls `handleEpisodeTransition`). KEEP.
- `workflow_generate_next` is registered in `workflow.ts:393-412`, aggregated in `index.ts:99,129`. **saga3 tool.** KEEP.

No MCP tool is registered solely for the legacy pump. The pump called these handlers *as functions* (via `lifecycleHandlers.episode_transition({...})` at `orchestrate.ts:485,1079` and `generateNextForCompletedTask` at `orchestrate.ts:28`) — those call-sites disappear with §1.1, but the tool registrations remain valid.

---

## 7. `LegacyEngineAdministration` — KEEP-and-rename (NOT delete)

`src/infrastructure/engine/legacy-engine-administration.ts` (330 lines). Implements `EngineAdministration` (the `start`/`stop`/`restart`/`setConcurrency`/`status` port used by `SagaApplication` and `SagaControlApplication`).

**Why KEEP:**
- The `EngineAdministration` port (`src/application/ports/engine-administration.ts`) is the control-plane surface used by tracker-view / HTTP to launch and stop a background engine. This is engine-agnostic — it spawns `orchestrate-cli.js` (which under saga3 modes runs the saga3 engine).
- The subprocess machinery — `spawn('node', [orchestrateCliPath, ...])` detached (line 82), `killEngineTree` (powershell `Get-Descendants` + `taskkill` on win32, `pkill` elsewhere, lines 243-282), `isEngineAlive` (`pgrep`/`Get-CimInstance`, lines 284-306) — is **generic process orchestration**, not pump-specific. Every background engine needs it.
- Constructed in `composition-root.ts:120,171` as the default `engineAdministration` for both `createSagaControlApplication` and `createSaga2Application`.

**Phase-3 action:** KEEP the file and class. The `windowsHide` flags and powershell tree-kill logic must NOT be removed. Class name is a Phase-4 rename candidate (`LegacyEngineAdministration` → `BackgroundEngineAdministration` or `ProcessEngineAdministration`).

Importer grep confirms it is the sole `EngineAdministration` implementor and is wired into the application boundary — deleting it would remove the ability to start/stop any background engine.

---

## 8. Open Decision Points (require integrator sign-off before commit)

1. **`v2` / `v3` / `saga2` orchestration modes (§2.5).** After §2.1, selecting these throws at composition time. Options:
   - **(a)** Keep the modes accepted in `parseOrchestrationMode` (operator env keeps working, error surfaces only at engine-select). RECOMMENDED for Phase 3.
   - **(b)** Remove the three modes from the union + change `DEFAULT_ORCHESTRATION_MODE`. Breaking for any operator with `SAGA_ORCHESTRATION_MODE=v3` in env. Defer to Phase 4.
2. **`createSaga2Application` naming.** The function name is now a misnomer (it returns saga3 engines). Renaming touches many test imports. Defer to Phase 4.
3. **`Saga2*` type/class renames** (`Saga2HostRuntime`, `Saga2RuntimePersistence`, `NodeSaga2HostRuntime`, `Sqlite*Saga2*Repository`, `LegacyEngineAdministration`). Pure cosmetic; defer to Phase 4 to keep the Phase-3 diff reviewable.
4. **Coverage gap** from deleting e2e/track-pipeline tests (§5.3). Confirm saga3 e2e coverage exists or file a follow-up.

---

## DELETE-LIST (full files)

```
src/orchestrate.ts                                                          (1208 lines — the Saga2 pump)
src/engines/saga2-engine.ts                                                 (47 lines   — Saga2Engine wrapper)
src/process-modules/application/legacy-engine-executor-adapter.ts           (117 lines  — dead SPI shim)

tests/architecture/saga2-boundaries.test.mjs
tests/characterization/saga2-runtime-contracts.test.mjs
tests/e2e-pipeline.test.mjs
tests/track-pipeline.test.mjs
tests/process-modules/process-module-installation.test.mjs                  (verify no generic-flow coverage first)
```

## INLINE-REMOVE-LIST (file:line ranges within shared files)

```
src/app/composition-root.ts
  :18         DELETE  import { Saga2Engine } from '../engines/saga2-engine.js';
  :193        DELETE  doc line "SAGA_ORCHESTRATION_MODE=v2|v3|saga2 -> Saga2Engine"
  :349-357    DELETE  the Saga2 fallback comment + `return new Saga2Engine({...})`;
              REPLACE with: throw new Error('SAGA2_MODE_REMOVED: v2/v3/saga2 modes are no longer supported. Use saga3-discovery-generic | saga3-formalization | saga3-lifecycle.')

src/orchestrate-cli.ts
  :7-10       UPDATE  header comment (no code change) — createSaga2Application now returns saga3 engines
```

### Explicitly NOT removed (verified shared / saga3)
- `src/application/ports/saga2-host-runtime.ts` — saga3 uses `host.workerPaths`/`heartbeat`/locks
- `src/application/ports/saga2-runtime-persistence.ts` — saga3 uses `workspaces`/`tasks`/types
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` — saga3 state store
- `src/infrastructure/runtime/node-saga2-host-runtime.ts` — saga3 host impl
- `src/infrastructure/engine/legacy-engine-administration.ts` — generic process control (spawn/tree-kill)
- `src/orchestrate-cli-scenario-adapter.ts` — Wave 11 saga3 scenario path
- `src/tools/workflow.ts` — `generateNextForCompletedTask` called by saga3 dispatcher
- `src/tools/lifecycle.ts` — `handleEpisodeTransition`/`advanceReadyEpisodes` are saga3; all `episode_workflows` writes KEPT
- `src/runtime/orchestration-mode.ts` — modes kept accepted (Phase-4 cleanup)
- `src/index.ts` — no MCP tool unregistering needed
- `episode_workflows` table (`schema.ts:77`) — saga3 lifecycle state store, NOT dropped
