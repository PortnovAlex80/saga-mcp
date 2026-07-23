# Saga 2 Phase B — Slice 2

Date: 2026-07-23
Branch: `saga2-refactoring`
Baseline: the real pipeline was observed locally through the development stage after Slice 1.

## Goal

Increase separation without rewriting the proven Saga 2 pump, worker protocol, tracker HTTP surface, SQLite schema, MCP tools, artifact model, or workflow rules.

## Implemented

### Concrete pump moved behind an infrastructure adapter

`Saga2Engine` no longer imports `src/orchestrate.ts` or its concrete option/result types.

The dependency path is now:

```text
Saga2Engine
  -> LegacySaga2Runner port
  -> infrastructure/runtime/legacy-saga2-runner
  -> proven orchestrate()
```

The composition root is the only place that selects the concrete legacy runner.

### Board projection SQL extracted

The tracker project list and project-board SQL now also exist in:

`src/infrastructure/projections/sqlite-board-projection-reader.ts`

The adapter preserves:

- project ordering and colors;
- task counters;
- episode stage and gate metadata;
- accepted-artifact drift count;
- passing-evidence count;
- repository name projection;
- dependency blocked reason;
- empty-board result shape;
- `epicById` lookup used by the tracker rendering code.

The current tracker remains unchanged. This is deliberate: the adapter is first verified independently, then tracker-view can switch from embedded SQL to the adapter in a separate small patch.

### Application host expanded

`SagaApplication` now exposes:

- `runEpisode`;
- `listProjects`;
- `loadProjectBoard`;
- `close`.

It depends only on `OrchestrationEngine` and `BoardProjectionReader` ports.

### Tests expanded

Architecture tests now cover:

- legacy pump invocation through the runtime port;
- engine-neutral application coordination;
- board-port delegation;
- worker adapter compatibility;
- the actual SQLite tracker projection against a minimal database fixture.

## Deliberately unchanged

- `src/orchestrate.ts` pump and recovery behavior;
- `tracker-view/claude-runner.mjs`;
- worker prompts, MCP config, provider routing, logs, heartbeat, and fencing;
- `tracker-view/tracker-view.mjs` HTTP and HTML behavior;
- database schema;
- lifecycle, dispatcher, workflow generation, gates, and artifacts.

## Next safe slice

The next patch should move the existing `createClaudeBoardRunner({...})` construction from `orchestrate.ts` into the already defined `WorkerExecutor` infrastructure boundary. It must copy no behavior and must retain every callback, environment value, recovery path, provider lookup, log path, and test injection exactly.

After that patch, repeat the same real run to the development stage. Only then switch tracker-view's `listProjects` and `loadBoard` functions to the tested SQLite projection reader.
