# Task Rotation — Structured Multi-Phase Execution

**Operator directive:** 2026-08-25. Instead of one worker per task, execute
a hidden rotation: plan → (implement || test-plan) → verify. For the factory,
this is still one task, one work_done, one CandidateSet.

## The rotation

```
Phase 1 (sequential): PLANNER
  - Gathers context, reads the task
  - Creates: work plan + TODO checklist
  - Checks: plan consistency, plan covers task goal
  - Output: plan document on the desk
  - EXITS (does not call work_done)

Phase 2 (parallel): IMPLEMENTER + TEST-PLANNER
  IMPLEMENTER:
  - Reads the plan from the desk
  - Works through the TODO checklist
  - Writes code/configuration/whatever the plan calls for
  - Stays active until implementation is complete

  TEST-PLANNER (parallel with implementer):
  - Reads the plan from the desk
  - Creates: test plan covering each TODO item
  - Output: test plan on the desk
  - EXITS

Phase 3 (after implementation): VERIFIER
  - Reads: plan + code + test plan (all on the desk)
  - Checks:
    a) Does the code implement the plan?
    b) Does the plan achieve the task goal?
    c) Does the task serve the overall objective?
    d) Does the test plan cover the code?
  - Output: verification verdict
  - CALLS work_done ✓
```

## Why rotation, not conversation

- No communication infrastructure needed
- Each worker has a clear brief and exit condition
- Workers see each other's work through the shared desk (Workplace material)
- The "team" is an illusion created by sequencing, not real-time chat
- Deterministic and testable

## Mapping to factory concepts

| Rotation phase | Existing concept | New |
|---|---|---|
| Planner | (similar to plan-task-graph cell, but per-task) | Sub-brief: "plan this task" |
| Implementer | development-implementation cell | Sub-brief: "execute the plan" |
| Test-Planner | (new) | Sub-brief: "write test plan from the plan" |
| Verifier | (similar to reviewer, but richer) | Sub-brief: "verify plan compliance" |

The rotation is a POLICY within the Workplace, not a new architectural
entity. The Workplace aggregate, Contribution model, Revision sealing,
CandidateSet and Gate remain unchanged.

## Implementation notes

1. **Sub-briefs**: Each WorkerExecution gets a brief that includes
   the rotation phase and the expected output format.
2. **Desk material**: Each worker's output is a Contribution to the
   Workplace revision. The next worker finds it on the desk.
3. **Exit conditions**: Planner and Test-Planner exit by submitting
   their contribution and signalling "phase complete" (not work_done).
4. **work_done**: Only the Verifier calls work_done, after checking
   all prior contributions exist and are consistent.
5. **Parallelism**: Phase 2 requires rate limit >= 2. If rate limit
   is 1, Test-Planner runs sequentially after Implementer.
6. **Gate**: Receives one CandidateSet containing: plan + code +
   test plan + verification. Reviews the complete package.

## Where in EK

- **EK-5** (WP-08): First implementation in the Development vertical
- **EK-6** (WP-09): Extend to planning cells (epic-level rotation)
- **EK-8** (WP-11*): All workshops can adopt the pattern
- **EK-9** (WP-13B): Test scenarios exercise the rotation

## Universal applicability

The rotation works for ANY task in ANY workshop:
- Discovery: plan research → do research || plan analysis → verify findings
- Formalization: plan document structure → write doc || plan validation → verify
- Development: plan implementation → code || plan tests → verify
- Delivery: plan release steps → execute || plan rollback → verify

Each workshop can customize the sub-briefs but the rotation pattern
(plan → execute+test → verify) is universal.
