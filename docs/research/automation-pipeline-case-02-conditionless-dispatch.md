# Automation Pipeline Case 02: Conditionless Dispatch and Premature Verification

Date: 2026-07-22

Status: revised after the clean Saga 3 architecture decision

Related documents:

- `docs/architecture/SAGA-3-CLEAN-ARCHITECTURE.md`
- `docs/architecture/SAGA-3-0-WORKER-PRODUCTION-AXIOM.md`
- `docs/research/automation-pipeline-problems-and-solutions.md`

## 1. Honest finding

The previous case established that nothing semantic is produced unless an LLM worker receives an executable assignment through a Skill.

This case reveals the next missing rule:

> It is not enough for a worker assignment to exist. The assignment must be causally ready.

Saga created and dispatched a verification task before the work being verified had been produced.

The worker-production bridge existed. The temporal and causal bridge did not.

## 2. What happened

Runtime state:

```text
Episode display stage: development
Task #90: development task for AC-8, status=todo
Task #91: verification.ac for AC-8
```

Task #90 had not run. The implementation for AC-8 did not exist in its required integrated form.

Nevertheless, task #91 was dispatched and a verifier worker started.

The verifier attempted to verify an output that was not yet available.

## 3. Historical failure chain

The failed implementation contained two partially active control models.

The observed chain was:

```text
1. A new guard removed the old stage-only dispatch restriction.
2. The intended replacement was condition-driven readiness.
3. The task had target_conditions=[].
4. The new pump could not make a complete readiness decision.
5. It fell through to the previous dispatcher.
6. That dispatcher now ran without the safety predicate it had previously relied on.
7. It selected verification task #91 while implementation task #90 remained todo.
```

The important lesson is not that the previous dispatcher should be preserved.

The lesson is that mixed authority made it possible to remove an invariant in one subsystem before another subsystem could enforce it.

Saga 3 therefore adopts a clean replacement. The historical control path is retained only as a regression case.

## 4. Architectural decision after this failure

There is one Saga 3 controller.

There is no older runtime mode, no shadow runtime, no controller switch, and no fall-through dispatcher.

The existing implementation is treated as:

- a source of failure cases;
- a source of historical data;
- a possible source of explicitly adopted low-level utilities.

It is not an execution fallback.

The complete Saga 3 dispatch path must either authorize a WorkIntent itself or fail closed inside Saga 3.

## 5. Empty conditions are not "no restrictions"

For material work:

```text
target_conditions=[]
```

must never mean:

```text
This task has no condition constraints and is freely dispatchable.
```

It means:

```text
The task is not compiled into the Saga 3 control model.
Its semantic target is missing.
Its prerequisite truth is unknown.
Its result cannot be reconciled deterministically.
```

Required behavior:

```text
target_conditions=[]
-> do not dispatch
-> reserve no budget
-> acquire no lease or resource claim
-> create CONDITION_BINDING_MISSING or UNCOMPILED_WORK_INTENT
-> materialize an autonomous binding-remediation WorkIntent where a permitted repair path exists
-> otherwise terminate truthfully
```

Absence of safety metadata fails closed.

## 6. Stage removal does not mean sequence removal

The phrase "stage is not truth" means:

```text
A display stage is not the sole admission rule.
```

It does not mean:

```text
All work is ready simultaneously.
```

The old stage filter was coarse, but it carried a real invariant:

```text
Do not execute downstream work before its required upstream output exists.
```

Saga 3 preserves that invariant through scoped conditions and explicit prerequisites rather than through a global stage equality check.

Stages may remain as derived UI summaries. They do not participate in dispatch authority.

## 7. Scoped readiness for verification

A verification WorkIntent may be admitted only when its own scope is ready.

At minimum:

```text
The target obligation and scope are known.
The required implementation condition for that scope is True.
The required source change is integrated into the candidate baseline.
The candidate source fingerprint is fixed and current.
All required upstream dependencies have accepted dispositions.
The verification procedure or oracle path exists.
The environment required by the verification contract is available.
The verifier satisfies independence rules.
Budget, lease, and resource claims can be reserved atomically.
```

Only then may the verifier worker start.

## 8. Verification may overlap development

The correction is not global stage serialization.

Valid overlap:

```text
AC-1 implementation is complete and integrated.
AC-1 verification starts.
AC-8 implementation continues independently.
```

Invalid overlap:

```text
AC-8 implementation task #90 is todo.
AC-8 verification task #91 starts.
```

The distinction is scoped causal readiness.

## 9. Causal-readiness invariant

The worker-production axiom is complemented by this invariant:

> A worker may receive a task only when every artifact, state, and upstream result required to make that task meaningful already exists, unless creating that missing prerequisite is explicitly part of the same assignment.

For every WorkIntent, Saga 3 must know:

```text
what the worker is expected to create;
what must exist before execution;
which upstream WorkIntent produces each prerequisite;
which scoped conditions prove readiness;
which source and environment baseline the work consumes;
which invalidations revoke readiness;
which evidence or artifact the result may create;
which downstream conditions may change after completion.
```

A productive path without causal readiness causes premature work, false failures, invalid evidence, and wasted recovery budget.

## 10. One dispatch authority

Dispatch contains several decisions, but one Saga 3 control plane owns all of them:

### Selection

Which current deficit should be addressed next?

### Readiness

Are the required upstream conditions, artifacts, source state, environment, and dependencies current?

### Admission

Is the action permitted now under policy, budget, resource, lease, capability, and independence rules?

### Materialization

Which exact worker assignment and Skill will produce the required output?

These decisions may be implemented in separate modules, but they are one authority and one atomic control protocol.

No module may call an alternate dispatcher when one of these decisions is incomplete.

## 11. Required Saga 3 dispatch contract

A material dispatch must follow this structure:

```text
load current EpisodeSpec and generation
-> observe authoritative state
-> evaluate scoped conditions
-> choose one deficit deterministically
-> materialize or load its unique WorkIntent
-> require non-empty target condition bindings
-> evaluate explicit prerequisite conditions
-> validate source, environment, dependency, and integration readiness
-> select a capable Skill and worker class
-> atomically reserve budget, execution lease, and resource claims
-> persist ControlDecision and assignment
-> launch the worker
```

If any required input is missing:

```text
reject or wait inside Saga 3
-> create a typed incident when the absence is abnormal
-> materialize an authorized remediation WorkIntent when possible
-> never dispatch through another control path
```

A row in a task table is not sufficient authority to launch work.

## 12. Who creates missing condition bindings

The controller cannot invent semantic mappings merely because they are required.

The producer depends on the mapping:

- deterministic structural bindings may be compiled by trusted Saga 3 code;
- semantic obligation-to-work mappings may require a planner or architect worker;
- missing verification scope may require a verifier-planning worker;
- the controller validates, versions, persists, and freezes the accepted result.

The repair chain is:

```text
CONDITION_BINDING_MISSING
-> create binding-remediation WorkIntent
-> assign the correct planner/compiler Skill
-> worker proposes semantic mappings where needed
-> deterministic validator checks obligation IDs, scopes, and prerequisite graph
-> controller persists the bindings under the current EpisodeSpec
-> readiness is reevaluated
```

The fallback is never "dispatch without conditions."

## 13. Clean implementation gate

Saga 3 dispatch is enabled only after the following are true for the vertical walking skeleton:

```text
Every material task is derived from a WorkIntent.
Every material WorkIntent has target conditions.
Every target has explicit prerequisite conditions.
The prerequisite graph is acyclic and validated.
Condition aggregation and invalidation are operational.
The scheduler can make a complete admit/reject decision.
Missing bindings fail closed.
Worker assignment through a Skill is operational.
Output ingestion and condition reconciliation are operational.
No alternate dispatcher or fallback exists in the composition root.
```

This is not a migration handoff gate. It is the minimum completeness gate for the only Saga 3 runtime.

## 14. Required regression scenarios

### Scenario A: observed #90/#91 failure

```text
Task #90 implements AC-8 and is todo.
Task #91 verifies AC-8.
```

Expected:

```text
#91 is not dispatchable.
#90 is selected first.
After implementation is completed, integrated, and bound to the current source fingerprint, #91 becomes eligible.
```

### Scenario B: empty target conditions

```text
A material WorkIntent has target_conditions=[].
```

Expected:

```text
No worker is launched.
No budget is reserved.
No task execution state is created.
A typed binding incident is persisted.
```

### Scenario C: valid scoped overlap

```text
AC-1 is implemented and integrated.
AC-8 remains under development.
AC-1 verification prerequisites are satisfied.
```

Expected:

```text
AC-1 verification may run concurrently with AC-8 development if resource claims do not conflict.
```

### Scenario D: stale integration baseline

```text
Implementation completed, but the candidate source fingerprint changed before verification dispatch.
```

Expected:

```text
Verification is not admitted against the stale baseline.
Affected conditions return to Unknown or False according to policy.
A new integration or verification WorkIntent is selected.
```

### Scenario E: no alternate authority

Inject a missing prerequisite during dispatch.

Expected:

```text
The Saga 3 decision ends as wait, reject, incident, recovery, or terminal disposition.
No other dispatcher is callable.
```

## 15. Broader lesson for pipeline automation

The first real case showed:

```text
A controller requirement does not create the work.
```

The second real case shows:

```text
Creating a worker task does not make the task ready.
```

A complete automated pipeline needs both:

```text
productive reachability
+
causal readiness
```

The full chain is:

```text
need detected
-> required output identified
-> prerequisite state proved
-> unique WorkIntent created
-> capable Skill and worker selected
-> one Saga 3 controller admits the task
-> worker creates the output
-> output is ingested and attested
-> scoped conditions change
-> downstream work becomes causally ready
```

Any missing link creates deadlock, premature execution, or false authority.

## 16. Final statement

The previous implementation removed a coarse sequencing mechanism before the replacement readiness model was complete, then allowed another dispatcher to continue execution.

Saga 3 removes the possibility of that class of failure structurally:

> There is one control system. It dispatches only compiled WorkIntents with explicit scoped prerequisites. Missing conditions fail closed. Stages are projections. No older process, compatibility mode, shadow runtime, or fall-through authority exists.