# ADR-029: Complete the universal Production Cell runtime before repairing Development

Status: accepted

Date: 2026-08-06

## Context

Development currently turns an accepted task graph into rows in the shared
`tasks` queue. Those rows point back to the kernel resolver node, do not form
independent author/reviewer Workplaces, and therefore cannot obtain a valid LM
workspace projection. The dispatcher repeatedly leases and loses them. The
failure is at the lifecycle-orchestration boundary, not in Development's code
generation skill or settlement policy.

The target domain already defines `ProductionCellDefinition`, deterministic
fan-out Workplaces, CandidateSets, GateDecisions and a
`ProductionCellCoordinator`, but the generic Flow runtime does not yet execute
nodes whose kind is `production-cell`.

## Decision

Repair Development by completing the universal `production-cell` execution
path and declaring Development work as Production Cells. Do not add a
Development dispatcher, Development workspace builder, synthetic LM node, or
task-status acceptance shortcut.

The universal path owns:

1. selection of an accepted upstream binding;
2. deterministic materialization of one Workplace per stable `workKey`;
3. fenced author and optional reviewer executions from declared profiles;
4. immutable CandidateSet sealing;
5. declared checks and typed GateDecision;
6. bounded repair on the same Workplace;
7. completion-policy join and typed Flow transition.

Development supplies only declarations: task-graph selectors, work-key
selector, coding and verification profiles, product schemas, capability
presets, gates and recovery policy. Source code is an LM-produced text product;
file writes, tests and Git operations are tool effects recorded as evidence.

## Cynefin classification

Complicated: the target invariant is known, but persistence, fencing, fan-out
and crash recovery must align across several existing subsystems.

## Options and MCDA

Scores are 1 (worst) to 5 (best); totals use the shown weights.

| Criterion | Weight | A: patch projected tasks | B: fake LM nodes | C: complete Production Cell |
|---|---:|---:|---:|---:|
| One mechanism for 1–1000 workshops | 4 | 1 | 2 | 5 |
| Provenance and resume correctness | 4 | 2 | 2 | 5 |
| Immediate implementation cost | 2 | 5 | 4 | 2 |
| Conceptual clarity | 3 | 1 | 2 | 5 |
| Testability | 3 | 2 | 3 | 5 |
| **Weighted total** | | **31** | **37** | **74** |

Option C wins. Options A and B preserve the dual runtime that caused the bug.

## Delivery slices

1. Register and exercise a generic `production-cell` node executor.
2. Implement deterministic singleton/fan-out materialization and completion
   join over accepted upstream bindings.
3. Bind role profiles to the normal workspace/worker launcher and gate path.
4. Replace Development's projected-task bridge with declarations.
5. Run a clean full mock order and prove resume does not regenerate accepted
   products.

Each slice must leave no product-specific branch in the engine.

## Pre-mortem and controls

| Failure | Early signal | Control |
|---|---|---|
| Coordinator is registered but bypasses CandidateSet/Gate | worker marks a cell done | acceptance test requires durable final GateDecision |
| Fan-out identity changes on retry | duplicate Workplace for one graph item | stable-id/workKey idempotency test |
| Development knowledge leaks into runtime | engine matches task kind or schema name | architecture ratchet forbids module vocabulary in generic runtime |
| Mock passes only because scripts seed state | missing worker/tool trace | clean-database mock asserts full provenance chain |
| Crash repeats accepted work | second worker execution for accepted workKey | resume test compares execution counts and product digests |

## Red Team result

The tempting small fix—point projected tasks at an LM profile—would make the
mock advance while retaining two authorities (`tasks` and Workplace) and no
CandidateSet gate. It is rejected because it repairs the symptom by creating a
second runtime contract. A mock is considered successful only when the same
Production Cell path that supports arbitrary workshops reaches its final gate.

## Consequences

- Development loses its custom task projection and settlement polling path.
- The common runtime gains the only missing first-class Flow-node adapter.
- Existing skills and simulator scenarios remain reusable as role-profile
  fixtures; they are not evidence unless the normal gate records accept them.
- Until all delivery slices pass, the factory is incomplete rather than
  “Development-specific but working.”
