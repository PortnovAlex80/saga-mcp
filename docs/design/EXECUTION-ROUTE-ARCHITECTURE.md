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

A deterministic simulator is an executor, not an inference provider or model.
The factory must never encode executor selection through a fake model name.

## Solution: ExecutionRouteResolver + frozen snapshot

```
Production Cell needs Worker
        │
        ▼
ExecutionRouteResolver.resolve({ module, cell, role, executionProfile })
        │
        ▼
WorkerExecutionRoute { executor.kind, provider.id|null, model.id|null,
                       inference.effort, policyRef, policyDigest }
        │
        ▼  (frozen at claim — ONE transaction)
ExecutionContextSnapshot { model_route, executor_kind, route_policy }
        │
        ▼  (persisted in worker_executions.metadata)
spawn ← reads executor_kind → selects binary
gateway ← validates the exact frozen route
provenance ← records the exact frozen route
```

For `claude-cli-simulator`, `model_route.provider`, `model_route.model` and
`model_route.effort` are all `null`. No fake provider is recorded.

### Resolution precedence (most-specific-first)

1. `executionProfile`
2. `module + cell + role`
3. `module + role`
4. `module`
5. factory default

Equal-specificity rules retain declaration order, but duplicate match objects
are rejected as ambiguous.

### Production policy vs test policy

`factory-execution-routes.json` is the production-safe repository policy. It
must never silently switch production workshops to the deterministic simulator.
The checked-in default therefore selects the real `claude-cli` executor only.

Hybrid/mock routing belongs to an explicit test/run override such as
`SAGA_EXECUTION_ROUTES_JSON` or `SAGA_EXECUTION_ROUTES_PATH` pointing at a test
policy. Example:

```json
{
  "version": "1",
  "default": {
    "executor": { "kind": "claude-cli" },
    "provider": "zai"
  },
  "routes": [
    {
      "match": {
        "module": "solution-formalization",
        "cell": "define-architecture-contract",
        "role": "reviewer"
      },
      "route": {
        "executor": { "kind": "claude-cli-simulator" }
      }
    }
  ]
}
```

The simulator route must omit provider/model/effort. The resolver rejects a
policy that mixes simulator execution with inference fields.

`route_policy.digest` is the full SHA-256 of the normalized policy. It is
durable provenance, not a shortened display identifier.

## Single spawn point

The composition root (`src/app/composition-root.ts`) is the sole factory
composition point for the worker executor factory and the work-assignment port.
The lifecycle path and dispatch loop consume the same instances.

The production `WorkerExecutor` boundary is fail-closed: a managed spawn must
carry a frozen `factory.execution.v2` context with a valid `executor_kind` and a
model route compatible with that executor. Legacy fallbacks inside the tracker
runner are not part of the factory execution contract.

## Policy version v2

`ExecutionContextSnapshot.policy_version` is `factory.execution.v2`. The shape
contains `executor_kind`, `model_route`, and `route_policy`. The context hash
covers the exact stored snapshot.

The authority gateway validates executor/model compatibility in addition to the
context hash. A simulator snapshot that claims a real inference provider is
invalid.

## Development-only testing

Do not obtain a Development sandbox by running the whole factory and deleting
later-stage rows from SQLite. That violates Workplace authority, CandidateSet
lineage, and the immutable production journal.

Use checkpoint / fixture adoption instead:

```
DevelopmentCase fixture
  ├── Formalization Certificate
  ├── SolutionContract
  ├── frozen AC baseline
  └── SRS
        │
        ▼
  start Development ProcessRun from the valid immutable input
```

For a full end-to-end test, `scripts/mock-factory-e2e.mjs` supplies an explicit
simulator routing policy through the environment and runs the complete
pipeline. Test routing never becomes the repository production default.

## Files

| file | role |
|------|------|
| `src/application/routing/worker-execution-route.ts` | executor/provider/model/inference route type |
| `src/application/routing/execution-route-resolver.ts` | validated policy loader + matcher |
| `factory-execution-routes.json` | production-safe repository policy |
| `src/shared/authority/execution-context.ts` | immutable execution snapshot |
| `src/shared/authority/build-execution-context.ts` | freezes the route at claim |
| `src/shared/authority/authorize-tool-call.ts` | fail-closed route + authority validation |
| `src/lifecycle/work-assignment-core.ts` | claim-time route freezing |
| `src/infrastructure/work/sqlite-work-assignment-adapter.ts` | atomic assignment seam |
| `src/infrastructure/workers/claude-board-worker-executor.ts` | production pre-spawn fail-closed boundary |
| `src/app/composition-root.ts` | shared factory composition |
| `tracker-view/claude-runner.mjs` | host adapter selecting the binary from frozen executor_kind |
