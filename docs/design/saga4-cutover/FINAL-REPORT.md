# saga4 Cutover — Final Report

**Branch:** `saga4` (from `50e065c`)
**Date:** 2026-07-30

## 1. Deleted legacy entrypoints and files

| File | Lines | Phase | Reason |
|---|---|---|---|
| `src/orchestrate.ts` | 1208 | 3 | Saga2 autonomous pump loop (RECOVERY_TREE, tryAdvanceStage, spawnGenericRecovery, generateNextIfReady). Zero production importers. |
| `src/engines/saga2-engine.ts` | 47 | 3 | Saga2Engine wrapper; only importer was composition-root fallback (removed Phase 2). |
| `src/process-modules/application/legacy-engine-executor-adapter.ts` | 117 | 3 | Dead SPI shim, zero value importers; saga3 uses GenericFlowEngineAdapter. |
| `tests/e2e-pipeline.test.mjs` | — | 3 | Drove `orchestrate({...})` directly; saga3 e2e coverage in tests/execution/*. |
| `tests/track-pipeline.test.mjs` | — | 3 | Same shape; drove the pump end-to-end. |
| tracker-view legacy UI (234 lines) | 234 | 7 | `.episode-advance`/`.episode-resume` buttons + handlers, 3 HTTP routes (`/api/episode/{transition,resume,pipeline}`), orphaned handlers, `refreshPipeline()`. |

**Total deleted:** ~1606 lines of executable legacy engine + pump tests + legacy UI.

## 2. Preserved shared infrastructure

| Component | Why kept |
|---|---|
| `Saga2HostRuntime` / `Saga2RuntimePersistence` (ports) | saga3 production imports them (workerPaths, heartbeat, locks). Misnomer prefix; KEPT (rename is cosmetic). |
| `SqliteSaga2*RuntimeRepositories`, `NodeSaga2HostRuntime` | saga3 state store + host impl. |
| `LegacyEngineAdministration` | Generic process spawner (spawn/tree-kill/windowsHide). Launches orchestrate-cli.js = lifecycle runtime after Phase 2. |
| `episode_workflows` table | `.metadata` = shared control plane (engine_pid/active_model). `.stage`/`.track` = lifecycle-projection mirror (Phase 8 documented). |
| `generateNextForCompletedTask` (workflow.ts) | Module-owned MCP tool `workflow_generate_next` (Phase 4 removed only the worker-tool callers). |
| `episode_transition` MCP tool (lifecycle.ts) | Orchestrator/operator-owned primitive (Phase 7 removed only the UI HTTP route). |
| Worker launcher (`claude-runner.mjs`), MCP transport, task/artifact persistence, repo/worktree, execution fencing, module installation, snapshots, warm-start | Engine-agnostic shared platform infra. |
| Frontend: Play button, `/api/engine/*`, `/api/lifecycle/pipeline`, `/api/worker/*`, `/api/model/*`, board CRUD, docs-graph | Shared infra, preserved. |

## 3. New sole authority chain

```
LifecycleRun → StageRun → ProcessRun → Process Module Flow → NodeRun
            → typed module outcome → Lifecycle Orchestrator routing
```

- **Phase 2** (`7c545ba`): `selectEngine` returns ONLY `createProductLifecycleRuntime`. `v2`/`v3`/`saga2` removed from union (throw at parse). Default = `saga3-lifecycle`.
- **Phase 3** (`9c2f157`): Saga2 pump + engine deleted. No production importer.
- **Phase 4** (`1ce4514`): Tasks = work-items. Claim requires `metadata.process_run_id IS NOT NULL`. `worker_done`/`worker_merge_release` no longer auto-generate downstream. `worker_next` no longer advances stages.
- **Phase 5** (`087ae1d`): Platform recovery (`RECOVERY_TREE`) gone with pump. `advanceReadyEpisodes` removed. Canonical recovery = `flow.recovery[]` (module-owned).
- **Phase 7** (`b657d07`): Frontend = pure projection. Legacy UI controls removed. Pipeline renders only lifecycle.

## 4. Database migration performed

- **Phase 6** (`9a69c8a`): `epics.slug` column added (additive). `migrateEpicSlug()` backfills slug from name. Prerequisite for stable references.
- **Phase 8** (`88c4539`): `episode_workflows` schema comment updated — documented as lifecycle-projection mirror (`.stage`/`.track`) + shared control plane (`.metadata`), no longer executable state machine.
- `episode_workflows` table NOT dropped — board-projection-reader still reads `.stage`. Dropping requires repointing board reader to `lifecycle_stage_runs` (tracked follow-up).

## 5. Remaining compatibility reads

- `episode_workflows.stage` — read by `sqlite-board-projection-reader.ts:63` for the coarse lifecycle bar. Sourced from saga3 `projected_stage` (lifecycle writes it). Not legacy; it's a projection mirror.
- Dead SPI `UniversalRecoveryEngine`/`*_RECOVERY_POLICY_BINDINGS` — marked `@deprecated`, zero production consumers. Retained because removal touches 7 test files; tracked cleanup task.
- `Saga2*` type/class names — shared infra misnomer. Cosmetic rename deferred.

## 6. Search results proving no executable legacy flow remains

| Marker | src/ | Classification |
|---|---|---|
| `tryAdvanceStage` | 0 | ✅ gone |
| `RECOVERY_TREE` | 0 | ✅ gone |
| `spawnGenericRecoveryTask` | 0 | ✅ gone |
| `spawnPostTransitionRecovery` | 0 | ✅ gone |
| `legacy orchestrate` | 0 | ✅ gone |
| `engine=v2` | 0 | ✅ gone |
| `generateNextForCompletedTask` | 2 | comment + module-owned MCP tool (KEPT; worker-tool callers removed) |
| `NEXT_STAGE` | 2 | false positive (lifecycle error-codes) |
| `episode_workflows` | 16 | shared control-plane + lifecycle-projection mirror |
| `saga2` | 16 | shared infra misnomer (ports/repositories/engine-classes retained for tests) |
| `episode_transition` | 4 | orchestrator-owned MCP primitive (UI route removed) |

**No production execution path remains for the legacy Saga2 pump.**

## 7. Tests executed and results

| Suite | Result |
|---|---|
| tsc --noEmit | **clean** |
| dependency-direction | 4/0 ✅ |
| saga2-boundaries | 17/1 (1 pre-existing fail from `aab4bc4` user fix to isEngineAlive, unrelated) |
| formalization-mechanics | 9/0 ✅ |
| recovery-engine | 19/0 ✅ |
| claim-dependency | 5/0 ✅ |
| lifecycle-orchestrator | 5/0 ✅ |
| ask-protocol | 11/0 ✅ |
| worker-outcomes | 11/0 ✅ |
| product-workflow | 66/0 ✅ |
| concurrency-transition | 6/0 ✅ |
| cutover-architecture-checks | 2/4 (4 pre-existing fails: legacy-scenario-adapter imports, Phase 8 territory) |

## 8. Exact command for one clean lifecycle smoke run

```bash
# Requires: DB_PATH, SAGA_PRODUCT_LIFECYCLE_COMPOSITION (ESM module with Delivery providers)
SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./tracker-view/product-delivery-composition.mjs \
DB_PATH=./saga.db \
node dist/orchestrate-cli.js <project_id> <epic_id> \
  --lifecycle-input=<path-to-input.json> \
  --concurrency=4
```

## 9. Known blockers / incomplete work

1. **Board-projection-reader still reads `episode_workflows.stage`** (`sqlite-board-projection-reader.ts:63`). Repointing to `lifecycle_stage_runs` is a follow-up that would allow dropping the `.stage`/`.track` columns.
2. **Phase 6 full rollout not done.** `epic_slug` prerequisite shipped, but the full migration of durable surrogate IDs (projectRepositoryId, artifactId, taskId, epicId in module payloads / snapshots / export-import) to content-addressed references is a large separate task. Pattern proven in `50e065c`.
3. **Dead SPI `UniversalRecoveryEngine`/`recovery-policies.ts`** marked `@deprecated`, not deleted (7 test files depend on it).
4. **`saga2-boundaries` 1 fail** (`aab4bc4` user fix rewrote `isEngineAlive`, test asserts old behavior). Shared infra, not cutover scope.
5. **`cutover-architecture-checks` 4 fails** (`legacy-scenario-adapter` imports in scenario-package). Phase 8 territory.
6. **`Saga2*` renames** (Saga2HostRuntime → HostRuntime etc.) deferred — cosmetic, touches many test imports.

## Commit log (saga4 branch)

```
9a69c8a refactor(identity): add epic_slug prerequisite for stable references   [Phase 6]
88c4539 docs(db): document episode_workflows as lifecycle projection target    [Phase 8]
b657d07 refactor(frontend): project lifecycle runtime without legacy control…  [Phase 7]
087ae1d refactor(recovery): make recovery module-owned and typed               [Phase 5]
1ce4514 refactor(workers): bind work execution exclusively to process node…    [Phase 4]
185a7b5 fix(engine): stop PowerShell flashing on 2s status poll                [user]
9c2f157 chore(saga2): cutover — remove legacy saga2 engine, orchestrator…      [Phase 3]
7c545ba refactor(lifecycle): establish lifecycle orchestrator as sole…         [Phase 2]
50e065c fix(lifecycle): bind portable repository references at runtime         [base]
```
