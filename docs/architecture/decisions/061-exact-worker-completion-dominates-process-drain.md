# ADR-061: Exact worker completion dominates process drain

Status: Accepted

Date: 2026-08-11

## Context

Run022 exposed a race between the Factory's two loops. A worker had an accepted
`worker_done` command receipt and its Workplace had already advanced, but the OS
process was still closing. The runner inferred success from the mutable task
projection through `tasks.current_execution_id`; that fence had already been
cleared. At the same time supervision treated the legacy `integrating` process
as illegitimate. The process was killed and reported as failed even though its
semantic contribution was durably complete.

The accepted receipt, task projection, and OS process answer different
questions. Only the receipt proves that a particular execution completed its
worker protocol.

## Decision

Close-time classification MUST query the accepted `worker_done` receipt by the
immutable assigned execution ID. It MUST NOT discover that receipt through a
task's current execution fence or infer completion from the current Kanban
phase.

When that exact receipt exists:

- the worker attempt is semantically completed, including outcomes that route
  to repair or blocking;
- a later non-zero exit, supervisor termination, task projection change, or
  integration state cannot turn the attempt into worker failure;
- recovery is not requested;
- a still-live `finishing` or legacy `integrating` process receives only a
  bounded cleanup grace. This grants no domain mutation authority.

This decision does not mean that the CandidateSet, gate, integration, process,
or lifecycle succeeded. Their authorities remain independent.

## Options considered

| Option | Correctness | Stabilization cost | Architectural fit | Operational risk | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Infer completion from task/Kanban projection | 1 | 5 | 1 | 1 | Rejected |
| Exact receipt plus bounded process drain | 5 | 5 | 4 | 4 | Selected |
| Immediate two-axis WorkerExecution schema cutover | 5 | 1 | 5 | 2 | Deferred to the ADR-053 cutover |

The selected option is the smallest release-blocking correction. The full
semantic/process two-axis model remains the target, but mixing its schema
migration into the live E2E stabilization would enlarge the failure surface.

## Pre-mortem and controls

- A receipt from another attempt could launder failure. Control: query by exact
  immutable execution ID.
- Cleanup grace could renew worker authority. Control: it only affects the
  supervisor's physical process decision and is time-bounded.
- A non-zero close could still invoke recovery. Control: runner regression test
  orders receipt, projection advance, non-zero close, and asserts zero recovery.
- Legacy `integrating` could be kept forever. Control: the grace requires the
  exact receipt and fresh phase/progress time; ordinary cleanup applies after
  `FINISH_GRACE_MS`.
- The hotfix could be mistaken for accepted-product authority. Control: retain
  CandidateSet, GateDecision, effect, and WorkplaceProductionRevision as
  separate authority boundaries.

## Consequences

Run022-style close/reaper races become cleanup telemetry rather than semantic
repair. The implementation adds no new business state and remains compatible
with the planned WorkplaceProductionRevision migration. A later cutover should
replace legacy `integrating` worker phase with an explicit durable drain
obligation and orthogonal process state.
