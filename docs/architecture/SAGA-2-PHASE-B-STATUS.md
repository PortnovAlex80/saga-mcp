# Saga 2 Refactoring Status

Date: 2026-07-23  
Branch: `saga2-refactoring`  
Stable baseline: `saga2`  
Infrastructure block commit: `15a5f77cecc7e953704ca58604fb728cc1528e04`  
Model-routing fix base: `92a2e9d5133c59464c5b95dbec7f0823721b2199`  
Persistence extraction merge: `f625a32e3bf6799b54299d512b50139bc3476bda`

The stable LM Studio contracts remain authoritative:

- the selected model is written to all four Claude model slots and the persistent LM Studio template;
- worker model routing is the typed `{ model, provider, effort }` contract;
- LM Studio receives no `--effort` flag;
- z.ai receives model-configured effort with `high` fallback;
- hardcoded `xhigh` is forbidden.

## Main plan

| # | Work item | Status | Evidence |
|---|---|---|---|
| 1 | Freeze stable `saga2` and create `saga2-refactoring` | Done | `saga2` remains the stable baseline. |
| 2 | Inventory current runtime contracts | Done | `SAGA-2-RUNTIME-CONTRACT-INVENTORY.md`. |
| 3 | Add characterization perimeter | Done | `tests/characterization/saga2-runtime-contracts.test.mjs`. |
| 4 | Introduce composition root | Done | `src/app/composition-root.ts`; CLI uses `SagaApplication`. |
| 5 | Separate worker, frontend and runtime infrastructure | Done | Worker, board projection, engine administration, runtime configuration and engine persistence are behind ports/adapters. |
| 6 | Finish a pure replaceable `Saga2Engine` | Next | Remove PID/filesystem/log-scanning mechanics from the pump while preserving its decisions and policies. |
| 7 | Verify full Saga 2 behavior after extraction | Remaining | Full real run to `completed` after item 6. |
| 8 | Implement `Saga3Engine` behind the same ports | Phase C | Must not start before Phase B exits. |

## Six Phase B items

| # | Item | Status | What changed / what remains |
|---|---|---|---|
| 1 | Connect `WorkerExecutor` to the old engine | Done | `orchestrate.ts` receives `WorkerExecutorFactory`; concrete Claude runner construction is infrastructure-owned. |
| 2 | Switch tracker board reads to `BoardProjectionReader` | Done | `listProjects()` and `loadBoard()` delegate to `SagaApplication`/`SqliteBoardProjectionReader`; HTML and HTTP routes are unchanged. |
| 3 | Extract `EngineAdministration` | Done | Start, stop, restart, status and concurrency are behind a port and a legacy process adapter. |
| 4 | Remove direct environment reads from touched runtime components | Done | DB/model/provider/port/reload/mode values are loaded as `SagaRuntimeConfig` and injected into the touched runtime components. |
| 5 | Extract engine persistence | Done | Episode, task, execution and workspace data are behind `Saga2RuntimePersistence`; `orchestrate.ts` contains no direct `getDb()`, `.prepare()`, execution-reconciler call or workspace SQL. Worker model route is read through episode persistence and injected through the worker port. |
| 6 | Finish pure `Saga2Engine` | Next | Extract PID lock, heartbeat/file writes, JSONL/rate-limit scanning and remaining host mechanics; retain stage decisions, recovery policy, concurrency policy and terminal outcomes. |

## Item 5 boundaries

| Boundary | Concrete implementation |
|---|---|
| `EpisodeRuntimeRepository` | SQLite workflow stage, metadata, pause/resume, brief decision, concurrency/model route and recovery bookkeeping. |
| `TaskRuntimeRepository` | Stage counts, generation candidates, recovery tasks, stranded-task sweep, terminal drain, dependency reconciliation and rate-limit task projections. |
| `ExecutionRuntimeRepository` | Durable worker execution reconciliation. |
| `WorkspaceResolver` | Registered project checkout resolution. |
| `WorkerModelRouteReader` | Typed `{ model, provider, effort }` route supplied to `ClaudeBoardRunner`. |
| Lifecycle recovery writer | `src/lifecycle/legacy-assignment-recovery.ts`; worker infrastructure no longer performs direct task lifecycle updates. |

## Automated validation result

| Gate | Result |
|---|---|
| Model-routing base guard (`92a2e9d` ancestor) | Passed |
| TypeScript build | Passed |
| Architecture tests | Passed |
| Characterization tests | Passed |
| Mock E2E: verification → integration → completed | Passed |
| Full `npm test` suite | Passed |

The guarded migration refused to commit transformed runtime files until every gate passed. Temporary migration workflows, scripts and diagnostics were removed from the final implementation commit.

## Runtime acceptance

The infrastructure block was exercised with real workers: workers started, tasks and artifacts were created, the frontend remained operational and the pipeline progressed through its stages. This run predates the item 5 persistence extraction, so item 5 is currently accepted by automated gates. The final Phase B acceptance remains one full real run to `completed` after item 6.
