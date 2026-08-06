# ADR-030: Production Cell execution is reconciled by Flow and dispatched only by the global Workplace queue

Status: accepted

Date: 2026-08-06

Refines ADR-029.

## Context

The first Production Cell executor materialized a Workplace and then created a
`tasks` row, called `WorkAssignmentPort.assignTask`, launched a
`WorkerExecutor`, and polled it from inside `GenericFlowExecutor`. It then moved
the Workplace in a second call. This created a second dispatcher, bypassed the
global concurrency budget, and reopened a crash window between task assignment
and Workplace reservation.

The target model already requires one global dispatcher, one
`concurrency=N`, and Workplace as the production authority. A Flow executor is
not allowed to hire or supervise workers.

## Decision drivers

- one mutation authority and one global concurrency budget;
- atomic reservation/fence before process launch;
- exact crash/resume without regenerating accepted products;
- module-independent runtime mechanics;
- worker-tool and UI projections remain rebuildable and non-authoritative;
- observable and testable transitions.

## Considered options

1. Keep the hybrid executor and harden its transactions.
2. Let each Production Cell own a private dispatcher behind a common interface.
3. Make the Production Cell executor a reconciler and route every worker
   through the global Workplace dispatcher.

| Criterion | Weight | Hybrid | Private dispatcher | Reconciler + global dispatcher |
|---|---:|---:|---:|---:|
| Authority correctness | 3 | 1 | 2 | 5 |
| Global concurrency | 3 | 1 | 1 | 5 |
| Resume determinism | 3 | 2 | 2 | 5 |
| Module isolation | 2 | 3 | 2 | 5 |
| Reversibility | 2 | 4 | 3 | 4 |
| Implementation cost | 1 | 4 | 3 | 2 |
| Testability/observability | 2 | 3 | 2 | 5 |
| **Weighted total** | | **35** | **32** | **78** |

## Decision

Choose option 3.

`ProductionCellNodeExecutor` performs only deterministic reconciliation:

1. resolve accepted upstream inputs;
2. materialize deterministic Workplaces and rebuildable task/desk projections;
3. inspect completed executions, seal CandidateSets and run gates;
4. apply review/repair/final decisions;
5. return `paused` while any Workplace needs a worker or gate retry;
6. return the complete accepted-output manifest when the completion policy is
   satisfied.

It never calls a worker factory, assignment port, process status API, sleep, or
poll loop.

The application-wide dispatcher selects eligible Workplace projections,
creates one durable reservation, atomically binds the Workplace revision and
projection fence, then launches through the normal process host. The task row
is a rebuildable worker-tool/UI projection; it cannot accept a
product or advance the Flow. GateDecision remains the only acceptance authority.

Development publishes schema-typed implementation, integration and
verification products. Its settlement policy remains unchanged; only its
input adapter changes from tracker tables to exact accepted output bindings.

## Pre-mortem

Assume this decision failed after six months:

1. A task projection becomes selectable without an eligible Workplace.
   Mitigation: assignment query requires queued Workplace and atomically CASes
   its reservation before returning work.
2. A worker completes after its reservation was replaced. Mitigation: product
   submission and completion both verify the exact active reservation.
3. Flow resumes before all fan-out gates settle. Mitigation: completion joins
   only terminal Workplaces and is covered for all/any/quorum.
4. Compatibility task writes regain authority. Mitigation: architecture tests
   require Production Cell progress to be derivable after rebuilding task
   projections.
5. Check providers are missing in production. Mitigation: installation fails
   when a declared CheckPlan provider cannot be resolved; no empty registry.

## Adversarial review

The strongest argument for the hybrid path is that the existing worker tools
require task ids. This does not require task authority: a task can be a durable
projection carrying the tool context while reservation, loop state, candidate
identity and acceptance remain Workplace-owned. Keeping the hybrid dispatcher
would solve compatibility by violating the controlling invariant, so it is
rejected.

## Decision journal

- Expected immediately: no Production Cell code imports `WorkerExecutorFactory`
  or `WorkAssignmentPort`; global concurrency tests cover cell workers.
- Expected after Development cutover: settlement reads no projected task status
  or integration state.
- Check trigger: full clean mock plus crash-after-submit/resume mock.
