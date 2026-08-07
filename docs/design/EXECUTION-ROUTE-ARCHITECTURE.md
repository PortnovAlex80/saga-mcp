# Worker Execution Routing — architecture

## Problem this solves

The factory hires a worker process for every node execution. Hiring requires
choosing **four independent dimensions**:

| dimension     | examples                                   |
|---------------|--------------------------------------------|
| executor      | `claude-cli`, `claude-cli-simulator`       |
| provider      | `zai`, `anthropic`, `lmstudio`             |
| model         | `glm-5.2`, `claude-opus-4.6`, ...          |
| inference     | `effort`, (future: timeout, concurrency)   |

An earlier prototype collapsed all four into a single `model` string and
encoded the executor as `model === "mock"`. That made a deterministic simulator
masquerade as an LLM model name, and it made the production journal unable to
explain **why** a given WorkIntent ran on a given backend after a config edit.

## Solution: ExecutionRouteResolver + frozen snapshot

```
Production Cell needs Worker
        │
        ▼
ExecutionRouteResolver.resolve({ module, cell, role, executionProfile })
        │
        ▼
WorkerExecutionRoute { executor.kind, provider.id, model.id, inference.effort,
                       policyRef, policyDigest }
        │
        ▼  (frozen at claim — ONE transaction)
ExecutionContextSnapshot { model_route, executor_kind, route_policy }
        │
        ▼  (persisted in worker_executions.metadata)
spawn ← reads executor_kind → selects binary
gateway ← reads model_route → authorizes
provenance ← reads model_route → records
```

### Resolution precedence (most-specific-first)

1. `executionProfile` — one profile (e.g. `define-architecture-contract.author`)
2. `module + cell + role` — e.g. formalization / SRS / reviewer
3. `module + role`
4. `module`
5. factory default

Rules are auto-ranked by specificity, so policy authors do not need to order
rules for correctness — only for tie-breaking among equally specific rules.

### Policy file

`factory-execution-routes.json` at the repo root, or inline via
`SAGA_EXECUTION_ROUTES_JSON`:

```json
{
  "version": "1",
  "default": { "executor": { "kind": "claude-cli" }, "provider": "zai" },
  "routes": [
    { "match": { "module": "product-discovery" },
      "route": { "executor": { "kind": "claude-cli-simulator" } } },
    { "match": { "module": "solution-development" },
      "route": { "executor": { "kind": "claude-cli" },
                 "provider": "zai", "model": "glm-5.2", "effort": "medium" } }
  ]
}
```

A simulator route carries `executor.kind` and omits `provider`/`model` — the
simulator is **not** a model.

## Single spawn point

The composition root (`src/app/composition-root.ts`) is the SOLE place the
worker executor factory and the work-assignment port are created. Both the
lifecycle-node path and the dispatch-loop path consume the exact same instances
via `getLastFactoryWorkAssignment()` / `getLastFactoryWorkerExecutorFactory()`.

There is no second `claudePath`, no second adapter, no second factory. The
binary is selected by the runner (`tracker-view/claude-runner.mjs`) from the
FROZEN `executor_kind` in each assignment's `execution_context`.

## Policy version v2

`ExecutionContextSnapshot.policy_version` is now `factory.execution.v2`. The v2
shape adds `executor_kind` and `route_policy`. The gateway still accepts v1
snapshots for in-flight executions started before the cutover; the structural
hash is computed over the exact stored shape, so v1 snapshots validate.

## Development-only testing (replaces prep-dev-sandbox.mjs)

The deleted `scripts/prep-dev-sandbox.mjs` tried to obtain a Development
sandbox by running the whole factory then DELETE'ing half the history via SQL
and rewinding the lifecycle. That violated Workplace authority, CandidateSet
lineage, and the immutable production journal — it corrupted cross-table
invariants.

The correct mechanism is **checkpoint / fixture adoption**:

```
DevelopmentCase fixture
  ├── Formalization Certificate (frozen AC baseline)
  ├── SolutionContract
  ├── frozen AC baseline
  └── SRS
        │
        ▼
  start Development ProcessRun from the valid immutable input
```

A Development-only integration test does NOT run Discovery and Formalization
first. It starts from a valid immutable `DevelopmentCase` fixture (the same
shape the factory checkpoint service produces) and runs only the Development
`ProcessRun`. This is modularity: each module is testable from its declared
input contract.

For a full end-to-end test, `scripts/mock-factory-e2e.mjs` runs every stage on
the deterministic simulator (via the simulator route) — that is the complete
pipeline test. The per-module fixtures complement it, they do not replace it.

## Files

| file | role |
|------|------|
| `src/application/routing/worker-execution-route.ts` | the four-dimension route type |
| `src/application/routing/execution-route-resolver.ts` | policy loader + matcher |
| `factory-execution-routes.json` | the policy (repo root) |
| `src/shared/authority/execution-context.ts` | snapshot type (v2: executor_kind, route_policy) |
| `src/shared/authority/build-execution-context.ts` | freezes the route at claim |
| `src/lifecycle/work-assignment-core.ts` | wires the resolver into the claim transaction |
| `src/infrastructure/work/sqlite-work-assignment-adapter.ts` | carries the resolver |
| `src/tools/dispatcher.ts` | `setWorkerRouteResolver` for the MCP worker_next path |
| `src/app/composition-root.ts` | the SINGLE spawn point (factory + port + resolver) |
| `tracker-view/claude-runner.mjs` | selects the binary from the frozen executor_kind |
