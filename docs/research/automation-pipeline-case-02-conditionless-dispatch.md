# Automation Pipeline Case 02: Conditionless Dispatch and Premature Verification

Date: 2026-07-22

Status: confirmed architectural failure from a real v3 run

Related documents:

- `docs/architecture/SAGA-3-0-WORKER-PRODUCTION-AXIOM.md`
- `docs/research/automation-pipeline-problems-and-solutions.md`
- `docs/architecture/SAGA-3-0-MANDATE.md`

## 1. Honest finding

The previous case established that nothing semantic is produced unless an LLM worker receives an executable assignment through a Skill.

This case reveals the next missing rule:

> It is not enough for a worker assignment to exist. The assignment must be causally ready.

Saga successfully created and dispatched a verification task, but dispatched it before the work being verified had been produced.

The worker-production bridge existed. The temporal and causal bridge did not.

## 2. What happened

Runtime state:

```text
Episode stage: development
Task #90: development task for AC-8, status=todo
Task #91: verification.ac, workflow_stage=verification
```

Task #90 had not run. Development for the relevant acceptance criterion was not complete.

Nevertheless, task #91 was dispatched and a verifier worker started while the episode still remained in development.

The verifier therefore attempted to verify an output that did not yet exist in its required final form.

## 3. Failure chain

The observed control path was:

```text
1. v3 removed stage-only dispatch filtering.
2. This was directionally correct: stages must become derived views, not the source of truth.
3. The tasks had no compiled condition bindings: target_conditions = [].
4. The v3 pump could not make a condition-driven decision and returned fall_through.
5. Fall-through invoked the legacy v2 dispatcher.
6. A v3 guard disabled the legacy stage predicate inside that dispatcher.
7. The legacy dispatcher therefore saw tasks from every workflow stage.
8. verification.ac task #91 was selected while development task #90 remained todo.
```

The result was not v2 behavior and not v3 behavior.

It was a hybrid authority:

```text
v3 removes the old safety rule
+
v3 lacks the new condition model
+
v2 performs the actual task selection
=
no effective sequencing authority
```

## 4. The architectural error

The plan correctly said:

```text
Stages are derived views.
Conditions govern readiness.
Stage-only dispatch must be removed from v3.
```

But removal was performed before replacement was operational.

The old stage filter was a coarse mechanism, but it still encoded a real safety property:

```text
Do not execute downstream work before its required upstream work is ready.
```

Removing the representation of that property did not remove the property itself.

The replacement was supposed to be scoped conditions, work-intent dependencies, integrated source identity, and current evidence. Because those bindings were empty, no replacement authority existed.

This is a cutover failure, not merely a dispatcher bug.

## 5. Empty conditions are not "no restrictions"

`target_conditions: []` must not be interpreted as:

```text
This task has no condition constraints and is therefore freely dispatchable.
```

It means one of the following:

```text
The task was not compiled into the v3 control model.
The semantic target is missing.
The planner or migration failed to bind the task.
The task is legacy data and has no v3 authority.
```

Therefore an empty condition set for a non-bookkeeping v3 task is invalid or unknown, not vacuously ready.

Required behavior:

```text
target_conditions = []
-> do not dispatch
-> create CONDITION_BINDING_MISSING or UNCOMPILED_WORK_INTENT incident
-> repair the binding through a planner/compiler worker assignment where semantic work is required
-> or terminate truthfully if no permitted binding path exists
```

Absence of safety metadata must fail closed.

## 6. Stage removal does not mean sequence removal

The phrase "stage is not truth" was interpreted too aggressively.

The correct meaning is:

```text
The display stage must not be the only reason a task is eligible or ineligible.
```

It does not mean:

```text
All tasks from all stages are simultaneously eligible.
```

The replacement sequencing model must be more precise than the old stage model.

For a verification task, eligibility should be derived from its own scope and obligation, for example:

```text
Target obligation is known.
Required implementation condition for that obligation is True.
Required source change is integrated into the candidate baseline.
The source fingerprint to verify is fixed and current.
Required upstream dependencies have accepted dispositions.
The verification procedure or oracle path exists.
The verifier is independent where policy requires independence.
Budget, lease, and resource claims can be reserved.
```

Only after those predicates are satisfied may the verification task be dispatched.

## 7. Important nuance: verification may overlap development

The correct fix is not necessarily to restore a global rule saying:

```text
No verification may start until every development task in the episode is complete.
```

That would recreate stage-as-truth and unnecessarily serialize the pipeline.

Condition-driven execution may legitimately verify one scoped obligation while unrelated development continues, but only when the verified scope is ready.

Example of valid overlap:

```text
AC-1 implementation is complete and integrated.
AC-1 verification starts.
AC-8 development continues independently.
```

Example of invalid overlap:

```text
AC-8 implementation task #90 is todo.
AC-8 verification task #91 starts.
```

Therefore the required rule is scoped causal readiness, not global stage equality.

## 8. The second missing architectural invariant

The worker-production axiom must be complemented by a causal-readiness invariant:

> A worker may receive a task only when every artifact, state, and upstream result required to make that task meaningful already exists or is explicitly part of that worker's assignment to create.

For every WorkIntent, Saga must know:

```text
what the worker is expected to create;
what must already exist before the worker starts;
which upstream work produces those prerequisites;
which source and environment baseline the work consumes;
which conditions prove readiness;
which invalidations revoke readiness;
which later result the work is allowed to authorize.
```

A productive path without causal readiness creates premature work, false failures, wasted retries, and invalid evidence.

## 9. Three authorities were accidentally split

The implementation treated dispatch as one operation, but it contains at least three authorities:

### 9.1 Selection authority

Chooses which deficit should be addressed next.

### 9.2 Admission authority

Determines whether a concrete task is safe and permitted to start now.

### 9.3 Sequencing and readiness authority

Determines whether required upstream conditions, source state, integration state, and dependencies are satisfied.

In the failed path:

```text
v3 attempted selection;
v3 had no conditions and fell through;
v2 selected the task;
a v3 SQL guard weakened admission;
no component owned complete readiness.
```

This violated the mandate's rule that exactly one controller version owns an episode generation.

A single call crossed authority modes.

## 10. Correct mode semantics

The dispatch contract must be mutually exclusive.

### v2

```text
Legacy dispatcher is authoritative.
Legacy stage and dependency rules remain intact.
No v3 guard weakens the v2 query.
```

### v3_shadow

```text
V2 remains the only dispatcher.
V3 evaluates conditions and records the decision it would make.
V3 cannot modify SQL predicates, reserve budget, claim tasks, or execute effects.
```

### v3

```text
V3 is the only selection and admission authority.
Every material task requires a compiled WorkIntent and condition bindings.
The v2 dispatcher is not used as fall-through authority.
Missing v3 data creates an incident or quiescent state, never legacy dispatch with weakened guards.
```

There must be no mode equivalent to:

```text
v3 eligibility unavailable -> use v2 selection under v3 exceptions
```

## 11. Required dispatcher contract

A safe dispatch decision should resemble:

```text
read immutable controller_version

if v2:
    apply complete legacy admission semantics
    dispatch through v2

if v3_shadow:
    apply complete legacy admission semantics
    dispatch through v2
    separately record v3 proposed decision

if v3:
    require current EpisodeSpec and generation
    require compiled WorkIntent
    require non-empty target condition bindings for material work
    evaluate scoped prerequisite conditions
    validate dependency and integration readiness
    reserve budget, lease, and resource claims atomically
    dispatch through v3 scheduler

otherwise:
    reject invalid mode
```

A v3 decision must not call a v2 dispatcher after partially changing its semantics.

## 12. Who repairs missing condition bindings

This case also returns to the worker-production axiom.

If `target_conditions` are missing, the controller cannot simply wish them into existence.

The producer depends on the nature of the mapping:

- deterministic structural bindings may be compiled by trusted controller code;
- semantic mappings from requirements to work may need a planner or architect worker;
- legacy tasks may require a migration worker to inspect artifacts and propose bindings;
- the controller validates, persists, versions, and freezes the accepted mapping.

The recovery chain must be explicit:

```text
CONDITION_BINDING_MISSING
-> materialize binding-remediation WorkIntent
-> assign planner/compiler Skill
-> worker proposes semantic mapping where needed
-> deterministic validator checks obligation IDs and scopes
-> controller persists binding under current generation
-> task readiness is reevaluated
```

The fallback must not be "dispatch without conditions."

## 13. Required migration gate

The old stage predicate may be removed for a class of tasks only after all of the following are proved:

```text
Every task in that class has a current WorkIntent.
Every material WorkIntent has non-empty target conditions.
Every target has explicit prerequisite conditions.
Condition aggregation and invalidation are operational.
The v3 scheduler can make a complete admit/reject decision.
Shadow comparison shows equivalent or intentionally improved safety.
No v3 decision falls through to v2 authority.
Regression scenarios pass for unbound, stale, and partially migrated tasks.
```

Until then, v3 must remain shadow-only for that class.

This is an authority handoff gate.

## 14. Required regression scenarios

### Scenario A: the observed #90/#91 failure

```text
Episode is in development.
Task #90 implements AC-8 and is todo.
Task #91 verifies AC-8 and is todo.
Task #91 has workflow_stage=verification.
```

Expected:

```text
#91 is not dispatchable.
The reason is scoped implementation/integration prerequisites, not merely display stage.
#90 is selected first.
After #90 is completed, integrated, and its source baseline is current, #91 becomes eligible.
```

### Scenario B: empty target conditions

```text
A material v3 task has target_conditions=[].
```

Expected:

```text
No worker is launched.
No budget is reserved.
A typed condition-binding incident is created.
No v2 fall-through occurs.
```

### Scenario C: valid scoped overlap

```text
AC-1 is implemented and integrated.
AC-8 remains in development.
Verification for AC-1 is ready.
```

Expected:

```text
AC-1 verification may run concurrently with AC-8 development when resource claims do not conflict.
```

### Scenario D: shadow isolation

```text
controller_version=v3_shadow
```

Expected:

```text
V2 dispatch behavior is byte-for-byte unaffected by v3 evaluation.
V3 records proposals only.
```

### Scenario E: no mixed authority

Inject a missing condition binding during v3 dispatch.

Expected:

```text
The decision terminates as reject/wait/incident inside v3.
No legacy dispatcher is called.
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

A complete automated pipeline therefore needs both:

```text
productive reachability
+
causal readiness
```

The full chain is:

```text
need detected
-> correct output identified
-> prerequisite state proved
-> executable WorkIntent created
-> capable Skill and worker selected
-> task admitted under one controller authority
-> worker creates the output
-> output is ingested and attested
-> scoped conditions change
-> downstream work becomes causally ready
```

Any missing link creates either deadlock or premature execution.

## 16. Final statement

The stage filter was not the architecture we wanted, but it was still carrying a safety invariant. Saga removed that mechanism before the condition system was capable of carrying the invariant itself.

The failure was caused by partial replacement:

> V3 removed the old sequencing authority, had no compiled conditions to provide the new authority, and then fell through to a legacy dispatcher whose safety predicate had already been disabled.

The correction is not to return permanently to stage-driven execution. The correction is to make condition-driven admission complete, fail closed on missing bindings, preserve strict mode isolation, and dispatch verification only when its scoped implementation and integrated source are actually ready.