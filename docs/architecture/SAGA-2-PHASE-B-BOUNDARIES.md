# Saga 2 Phase B — Replaceable Engine Boundaries

Date: 2026-07-23
Branch: `saga2-refactoring`
Baseline: `saga2` at `6d8c68ad802a800b1519d9794efeff0091a55460`

## Decision

Phase B does not rewrite the proven Saga 2 pump, worker runner, tracker, schema, or artifact subsystem.

It places stable contracts around them so later extraction can happen one vertical slice at a time. The first runtime switch is deliberately small: the CLI now calls an engine-neutral application host, while `Saga2Engine` delegates to the unchanged `orchestrate()` implementation.

## Implemented and active

### Composition root

`src/app/composition-root.ts` is now the concrete assembly point for the CLI host.

It selects:

- validated runtime configuration;
- `Saga2Engine` as the concrete orchestration engine;
- the existing SQLite shutdown function;
- the engine-neutral `SagaApplication` host.

The CLI no longer imports `orchestrate()` or `closeDb()` directly.

### Replaceable engine contract

`src/application/ports/orchestration-engine.ts` defines:

- `RunEpisodeCommand`;
- `OrchestrationRunResult`;
- `OrchestrationEngine`.

`src/engines/saga2-engine.ts` adapts the current proven pump to that interface without changing its options or result semantics.

A future engine can implement the same interface and be selected only in the composition root.

### Runtime configuration seam

`src/runtime/saga-runtime-config.ts` records the existing configuration contract in one typed object. It preserves current environment names and defaults.

Legacy runtime internals still read some environment variables directly. Removing those reads is a later extraction slice and must be performed adapter by adapter, with characterization coverage.

## Contracts prepared for the next extraction slices

### Worker execution port

`src/application/ports/worker-executor.ts` freezes the board-runner behavior required by orchestration and frontend observation:

- start, stop, status, and live concurrency change;
- active workers;
- process identity and log path;
- claimed/completed/failed counters.

`src/infrastructure/workers/claude-board-worker-executor.ts` is a compatibility adapter over the existing Claude board runner.

The existing `orchestrate.ts` still constructs the runner internally. Moving that construction behind this port is intentionally a separate patch because it touches task claiming, fencing, recovery, provider routing, and process bookkeeping in one high-risk block.

### Frontend projection port

`src/application/ports/board-projection.ts` freezes the administrative view consumed by tracker/frontends:

- project counters;
- epic stage and gate state;
- kanban task state;
- worker assignment and integration visibility.

`src/infrastructure/projections/legacy-board-projection.ts` provides a compatibility adapter for the current tracker SQL projection.

The 5,000+ line tracker server is not rewritten in this phase. Exporting and injecting its existing `listProjects` and `loadBoard` functions is the next isolated frontend slice.

## Dependency direction

The new boundary code follows this direction:

```text
orchestrate-cli
    -> app/composition-root
        -> application/saga-application
        -> engines/saga2-engine
            -> legacy orchestrate() pump

application ports
    <- infrastructure compatibility adapters
```

Application modules do not import SQLite, tracker code, child processes, filesystems, Git, Claude, or LM Studio.

## Compatibility rules

The following remain unchanged:

- package entrypoints;
- CLI arguments, output prefix, help text, and exit-code semantics;
- `DB_PATH` requirement;
- `SAGA_CLAUDE_PATH` behavior;
- SQLite schema;
- tracker endpoints and HTML;
- task states and workflow stages;
- worker prompt and MCP tools;
- artifact files, hashes, traces, and frontend tree;
- the implementation of `orchestrate()`.

## Tests

Phase A tests:

- `tests/characterization/saga2-runtime-contracts.test.mjs` protects stable package, engine, runner, frontend, and behavioral-suite anchors.

Phase B tests:

- `tests/architecture/saga2-boundaries.test.mjs` verifies configuration parsing, engine delegation, host neutrality, worker-adapter compatibility, and frontend-projection compatibility.

The existing full `npm test` and `npm run test:e2e` remain the authoritative behavior gates.

## Next safe slices

1. Inject `WorkerExecutor` into the existing pump and move only runner construction/recovery wiring out of `orchestrate.ts`.
2. Export the existing tracker projection queries and consume them through `BoardProjectionReader`, without changing HTTP rendering.
3. Move direct environment reads from worker/tracker adapters to `SagaRuntimeConfig`, one variable group at a time.
4. Extract SQLite repositories only after worker and frontend boundaries are proven.
5. Do not introduce Saga 3 logic until Saga 2 passes the same end-to-end suite through all new boundaries.

## Phase B status

The replaceable-engine host boundary is active in production CLI flow.

Worker and frontend contracts are now explicit and adapter-backed, but their legacy implementations remain in place. This is deliberate: Phase B establishes safe seams first; it does not perform another big-bang internal move.
