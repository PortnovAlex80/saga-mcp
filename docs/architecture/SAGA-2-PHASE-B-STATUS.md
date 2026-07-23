# Saga 2 Refactoring Status

Date: 2026-07-23  
Branch: `saga2-refactoring`  
Stable baseline: `saga2`  
Infrastructure block commit: `15a5f77cecc7e953704ca58604fb728cc1528e04`  
Model-routing fix base: `92a2e9d5133c59464c5b95dbec7f0823721b2199`  
Persistence extraction merge: `f625a32e3bf6799b54299d512b50139bc3476bda`  
Pure-engine merge: `fad9868bb1d5c113e865f475b9804187431e9873`

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
| 6 | Finish a pure replaceable `Saga2Engine` | Done | Host mechanics are behind `Saga2HostRuntime`; `Saga2Engine` directly owns the pump through injected ports. |
| 7 | Verify full Saga 2 behavior after extraction | Acceptance pending | One full real run to `completed` on the final Phase B code. |
| 8 | Implement `Saga3Engine` behind the same ports | Phase C | Starts after the final Phase B runtime acceptance. |

## Six Phase B items

| # | Item | Status | What changed |
|---|---|---|---|
| 1 | Connect `WorkerExecutor` to the old engine | Done | `orchestrate.ts` receives `WorkerExecutorFactory`; concrete Claude runner construction is infrastructure-owned. |
| 2 | Switch tracker board reads to `BoardProjectionReader` | Done | `listProjects()` and `loadBoard()` delegate to `SagaApplication`/`SqliteBoardProjectionReader`; HTML and HTTP routes are unchanged. |
| 3 | Extract `EngineAdministration` | Done | Start, stop, restart, status and concurrency are behind a port and a legacy process adapter. |
| 4 | Remove direct environment reads from touched runtime components | Done | DB/model/provider/port/reload/mode values are loaded as `SagaRuntimeConfig` and injected into the touched runtime components. |
| 5 | Extract engine persistence | Done | Episode, task, execution and workspace data are behind `Saga2RuntimePersistence`; `orchestrate.ts` contains no direct SQL or workspace lookup. |
| 6 | Finish pure `Saga2Engine` | Done | PID lock, heartbeat, filesystem paths, clock/sleep and JSONL rate-limit telemetry are behind `Saga2HostRuntime`; per-run counters no longer use module-global state; `LegacySaga2Runner` was removed. |

## Extracted boundaries

| Boundary | Concrete implementation |
|---|---|
| `EpisodeRuntimeRepository` | SQLite workflow stage, metadata, pause/resume, brief decision, concurrency/model route and recovery bookkeeping. |
| `TaskRuntimeRepository` | Stage counts, generation candidates, recovery tasks, stranded-task sweep, terminal drain, dependency reconciliation and rate-limit task projections. |
| `ExecutionRuntimeRepository` | Durable worker execution reconciliation. |
| `WorkspaceResolver` | Registered project checkout resolution. |
| `WorkerModelRouteReader` | Typed `{ model, provider, effort }` route supplied to `ClaudeBoardRunner`. |
| Lifecycle recovery writer | `src/lifecycle/legacy-assignment-recovery.ts`; worker infrastructure performs no direct task lifecycle update. |
| `Saga2HostRuntime` | PID ownership, heartbeat output, worker runtime paths, clock/sleep and rate-limit telemetry. |
| `NodeSaga2HostRuntime` | Node/filesystem implementation preserving atomic `wx` lock, owner-aware release and existing JSONL/heartbeat formats. |

## Automated validation result

| Gate | Result |
|---|---|
| Persistence extraction base guard (`f625a32` ancestor) | Passed |
| Model-routing base guard (`92a2e9d` ancestor) | Passed |
| TypeScript build | Passed |
| Architecture tests | Passed |
| Characterization tests | Passed |
| Mock E2E: verification → integration → completed | Passed |
| Full `npm test` suite | Passed |

Both guarded migrations refused to commit transformed runtime files until every gate passed. Temporary migration workflows, scripts and diagnostics were removed from the final implementation commits.

## Runtime acceptance

The item 5 code was exercised with real workers after persistence extraction: workers started, tasks were created, the frontend remained operational and the pipeline continued through its stages.

All six Phase B implementation items are now complete. The only remaining Phase B exit condition is one full real progression on the final code to `completed`, including verification and integration. After that result is recorded, Phase C may start with `Saga3Engine` behind the existing ports.
