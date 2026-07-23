# Saga 2 Refactoring Status

Date: 2026-07-23  
Branch: `saga2-refactoring`  
Stable baseline: `saga2`  
Base for this block: `38a88ebc2e470767df5d91be333b4591bae5c298`  
Verified implementation commit: `15a5f77cecc7e953704ca58604fb728cc1528e04`

The base commit contains the LM Studio model-selector hard rule. This refactoring block preserves it: the selected model remains authoritative for all four Claude model slots and the persistent LM Studio template.

## Main plan

| # | Work item | Status | Evidence |
|---|---|---|---|
| 1 | Freeze stable `saga2` and create `saga2-refactoring` | Done | `saga2` remains the stable baseline. |
| 2 | Inventory current runtime contracts | Done | `SAGA-2-RUNTIME-CONTRACT-INVENTORY.md`. |
| 3 | Add characterization perimeter | Done | `tests/characterization/saga2-runtime-contracts.test.mjs`. |
| 4 | Introduce composition root | Done | `src/app/composition-root.ts`; CLI uses `SagaApplication`. |
| 5 | Separate worker, frontend and runtime infrastructure | Done | Worker, board projection, engine administration and touched runtime configuration are behind ports/adapters. |
| 6 | Finish a pure replaceable `Saga2Engine` | Remaining | Requires persistence extraction. |
| 7 | Verify full Saga 2 behavior after extraction | Remaining | Full real run to `completed` after items 5-6 below. |
| 8 | Implement `Saga3Engine` behind the same ports | Phase C | Must not start before Phase B exits. |

## Six Phase B items

| # | Item | Status | What changed / what remains |
|---|---|---|---|
| 1 | Connect `WorkerExecutor` to the old engine | Done | `orchestrate.ts` receives `WorkerExecutorFactory`; concrete Claude runner construction and recovery callbacks moved to infrastructure. |
| 2 | Switch tracker board reads to `BoardProjectionReader` | Done | `listProjects()` and `loadBoard()` delegate to `SagaApplication`/`SqliteBoardProjectionReader`; HTML and HTTP routes are unchanged. |
| 3 | Extract `EngineAdministration` | Done | Start, stop, restart, status and concurrency are behind a port and a legacy process adapter. |
| 4 | Remove direct environment reads from touched runtime components | Done for this block | DB/model/provider/port/reload/mode values are loaded once as `SagaRuntimeConfig` and injected into worker, tracker and engine administration. Unrelated bootstrap entrypoints are outside this block. |
| 5 | Extract engine persistence | Remaining | Split stage/metadata, task-runtime, recovery-policy and workspace/brief reads into repository ports without schema changes. |
| 6 | Finish pure `Saga2Engine` | Remaining | After item 5, remove SQL/filesystem/PID/log scanning from the pump and retain orchestration decisions only. |

## Automated validation result

| Gate | Result |
|---|---|
| TypeScript build | Passed |
| Architecture tests | Passed |
| Characterization tests | Passed |
| Mock E2E: verification → integration → completed | Passed |

The guarded migration also asserted that the `38a88eb` LM Studio hard rule remained present before allowing the verified source commit.

## Remaining acceptance

Run one real LM progression to `development` after pulling this block. The final Phase B exit requires a full real run to `completed` after persistence extraction and completion of the pure `Saga2Engine`.
