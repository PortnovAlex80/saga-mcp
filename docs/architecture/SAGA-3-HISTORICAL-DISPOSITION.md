# Saga 3 — Historical Code Disposition

Plan §15: classify every old component into one of:
- EXTRACT_PURE_UTILITY — keep, extract as a saga3 utility
- REIMPLEMENT_FOR_SAGA3 — rewrite in saga3 namespace
- CONVERT_TO_REGRESSION_SCENARIO — keep as test fixture
- ARCHIVE_DOCUMENTATION — move to docs/archive
- DELETE_FROM_ACTIVE_RUNTIME — remove

## Classification

| Component | Location | Disposition | Reason |
|---|---|---|---|
| **orchestrate.ts** | src/ | DELETE | Replaced by saga3/app/engine.ts. Old pump, recovery tree, auto-merge, pauseAndAlert — all gone. |
| **orchestrate-cli.js** | src/ | DELETE | Old entrypoint. saga3/app/cli.ts replaces. |
| **dispatcher.ts** | src/tools/ | DELETE | Replaced by saga3/scheduler + saga3/executions. Stage-filter dispatch gone. |
| **lifecycle.ts** | src/tools/ | DELETE | Stage-transition authority gone. Replaced by condition-driven controller. |
| **workflow.ts** | src/tools/ | DELETE | workflow_generate_next replaced by WorkIntent materialization. |
| **tasks.ts** | src/tools/ | DELETE | Task CRUD replaced by saga3 work-intents + assignments. |
| **atomic-release.ts** | src/lifecycle/ | EXTRACT | Pure atomic terminalization — useful pattern for saga3 effects. |
| **integration-executor.ts** | src/lifecycle/ | EXTRACT | CAS merge logic — reuse in saga3/effects. |
| **idempotency.ts** | src/lifecycle/ | EXTRACT | Receipt pattern — reuse in saga3 store. |
| **payload-hash.ts** | src/lifecycle/ | EXTRACT | Canonical JSON hash — reuse in saga3. |
| **domain/ (evolve, commands, events, state)** | src/lifecycle/domain/ | ARCHIVE | Task lifecycle kernel — NOT reused. saga3 has its own domain. Keep as reference for transition logic. |
| **worker-executions.ts** | src/ | DELETE | Replaced by saga3/executions + saga3 ports. |
| **loop-detector.mjs** | tracker-view/ | DELETE | Replaced by saga3 incident authority. |
| **claude-runner.mjs** | tracker-view/ | REIMPLEMENT | Worker spawn logic reimplemented in saga3 ProcessPort + CliModelPort. |
| **tracker-view.mjs** | tracker-view/ | REIMPLEMENT | Web UI will be rebuilt around saga3 conditions (not stages). |
| **schema.ts (old tables)** | src/ | ARCHIVE | Old tables (tasks, episode_workflows, worker_executions, etc.) become historical. saga3 uses fresh schema. |
| **db.ts (old migrations)** | src/ | DELETE | saga3 has its own store (SqliteStore). |
| **projects.ts, epics.ts, artifacts.ts** | src/tools/ | REIMPLEMENT | MCP tools rebuilt around saga3 entities. |
| **conflicts.ts** | src/tools/ | DELETE | Replaced by saga3/resources/resource-claim.ts. |
| **cutover.ts** | src/control/ | DELETE | No cutover — saga3 IS the runtime. |
| **control/* (v3 attempts)** | src/control/ | DELETE | All v3 incremental attempts removed. saga3/ is clean. |
| **skills/** | skills/ | KEEP | Skills are product assets. saga3 uses them via SkillCapability registry. |
| **mock-claude.mjs** | tests/ | KEEP | Useful for subprocess-level regression. |
| **old tests/** | tests/lifecycle/, tests/v3/ | CONVERT | Become regression fixtures + scenario definitions. |

## Deletion order

Plan §15: "Deletion occurs after equivalent Saga 3 functionality is present."

1. ✅ saga3 domain kernel (Gate A) — supersedes lifecycle/domain
2. ✅ saga3 controller (Gate H) — supersedes orchestrate.ts pump
3. ✅ saga3 scheduler — supersedes dispatcher.ts
4. ✅ saga3 evidence — supersedes lifecycle verification
5. ✅ saga3 effects — supersede integration-executor standalone
6. ✅ saga3 simulator — supersedes mock-claude as primary test
7. ⬜ saga3 app/cli.ts — supersedes orchestrate-cli.js
8. ⬜ saga3 app/server.ts — supersedes tracker-view.mjs
9. ⬜ saga3 MCP tools — supersede old tools/*
10. ⬜ DELETE old code (after all equivalents verified)

## Extracted utilities

These pure functions are extracted into saga3 without modification:

| Utility | From | To |
|---|---|---|
| canonicalJson + hashPayload | src/lifecycle/payload-hash.ts | src/saga3/domain/hashing.ts |
| releaseExecutionAtomically pattern | src/lifecycle/atomic-release.ts | src/saga3/effects/atomic-release.ts |
| computeIntentKey pattern | src/lifecycle/integration-executor.ts | already in saga3/work-intents |
| git merge-tree CAS | src/lifecycle/integration-executor.ts | already in saga3/effects via GitEffectPort |
