# Saga 3 Clean Architecture

Date: 2026-07-22

Status: normative architectural decision

Supersedes every coexistence, compatibility-mode, shadow-controller, legacy fall-through, and dual-authority proposal for the Saga 3 runtime.

## 1. Decision

Saga 3 is a clean target system.

There is no v2 runtime mode inside Saga 3.

There is no `controller_version` switch.

There is no `v3_shadow` production mode.

There is no fallback from Saga 3 selection to a legacy dispatcher.

There are no compatibility guards that selectively weaken or preserve old behavior.

There is no migration of an active old episode into the Saga 3 controller.

The existing implementation is evidence about failure modes and a source of reusable low-level code. It is not a second authority and not a runtime that Saga 3 must continue to support.

The target is one internally coherent system with one control model, one dispatch model, one incident authority, one budget authority, one evidence model, and one terminal-outcome model.

## 2. Why clean replacement is required

The attempted incremental cutover produced mixed semantics:

```text
new rule removes an old constraint
+
new replacement is incomplete
+
old component still performs the operation
=
no component owns the complete invariant
```

The premature verification case demonstrated this directly:

```text
condition-driven selection was expected;
condition bindings were empty;
the new pump fell through;
the old dispatcher ran with its stage constraint disabled;
verification started before implementation existed.
```

A compatibility layer did not reduce risk. It combined incompatible assumptions in one control path.

Saga 3 therefore rejects partial authority handoff as an implementation strategy.

## 3. The three levels of Saga 3

Saga 3 has three conceptual levels. Each level has a distinct responsibility and may not silently perform the work of another level.

### Level 1: Normative intent

This level defines what must be true and what the system is permitted to do.

It contains:

- PlatformPolicy;
- ProductConstitution;
- GovernancePolicy;
- EpisodeSpec;
- stable obligations;
- scoped ConditionContracts;
- ActionContracts;
- degradation profiles;
- oracle requirements;
- budget ceilings;
- terminal predicates.

Level 1 does not dispatch workers, execute effects, or claim that an obligation is satisfied.

Its output is a frozen, validated contract for one episode generation.

### Level 2: Deterministic control

This level owns authoritative state and every admission decision.

It contains:

- observation assembly;
- scoped condition evaluation;
- deficit selection;
- WorkIntent materialization;
- prerequisite and readiness evaluation;
- dependency and invalidation closure;
- scheduler admission;
- budget reservation and accounting;
- leases, fencing, and resource claims;
- incident classification and recovery selection;
- effect authorization and reconciliation;
- evidence attestation;
- outcome selection and certification.

Level 2 decides what work is admissible. It does not create semantic product artifacts itself.

### Level 3: Productive execution and external reality

This level performs authorized work and obtains observations.

It contains:

- LLM workers;
- role Skills;
- worker execution runtime;
- repositories and worktrees;
- test and benchmark runners;
- OraclePort adapters;
- ProcessPort adapters;
- EffectPort adapters;
- external systems and environments.

LLM workers create code, tests, requirements, architecture, plans, diagnoses, repair patches, verification procedures, and other semantic artifacts.

Deterministic adapters execute mechanical operations and collect raw facts.

Level 3 returns artifacts, raw observations, and structured failure reports. It does not assign itself authority, trust, policy generation, or terminal meaning.

## 4. Single causal chain

Every meaningful transition must follow one chain:

```text
mandate or observed deficit
-> Level 1 contract identifies required truth
-> Level 2 proves prerequisites and selects an admissible action
-> Level 2 materializes one WorkIntent
-> Level 2 atomically reserves budget, lease, and resource claims
-> Level 3 worker receives the assignment through a Skill
-> Level 3 creates the artifact or observation procedure
-> authorized runtime executes where required
-> raw output returns through a defined ingestion path
-> Level 2 attaches authoritative context and validates provenance
-> scoped conditions are reevaluated
-> the next deficit becomes ready or a truthful terminal outcome is certified
```

No fallback chain exists.

If Saga 3 cannot complete a link, it creates a typed incident, selects an authorized recovery WorkIntent, degrades under frozen policy, or terminates truthfully.

It never calls an older control path.

## 5. Core invariants

### 5.1 One authority

Exactly one Saga 3 controller owns selection, admission, budgets, incidents, effects, conditions, and outcomes for an episode.

There is no alternate dispatcher or retry authority.

### 5.2 No direct task-table dispatch

Workers are not dispatched merely because a row has `status=todo`.

A task is an execution projection of an authorized WorkIntent.

Every material dispatch requires:

```text
current EpisodeSpec;
current generation;
valid WorkIntent identity;
non-empty target condition bindings;
explicit prerequisite conditions;
current source and environment baseline;
satisfied dependency and integration requirements;
available budget;
acquirable lease and resource claims;
capable Skill and worker runtime.
```

### 5.3 Missing bindings fail closed

For material work:

```text
target_conditions = []
```

is invalid.

It means the work was not compiled into Saga 3. It does not mean the work is unconstrained.

The controller creates `CONDITION_BINDING_MISSING` or `UNCOMPILED_WORK_INTENT` and does not launch a worker.

### 5.4 Stages are projections only

Saga 3 may display labels such as discovery, formalization, development, verification, integration, and release.

These labels are derived summaries for people and reports.

They are not stored dispatch authority and are not used as a fallback admission rule.

Readiness is scoped by obligation, resource, source state, and evidence.

### 5.5 Productive reachability

Whenever the controller requires a new semantic artifact, diagnosis, test, repair, adapter, or procedure, it must create an executable worker assignment through a capable Skill.

A policy, validator, incident state, or database field does not create work.

### 5.6 Causal readiness

A worker receives a task only when all prerequisites required to make the task meaningful are satisfied, unless creating a missing prerequisite is explicitly part of that same assignment.

### 5.7 Evidence is produced, not declared

A worker may propose a claim, create a test, or return a raw result.

Authoritative evidence is created only after an authorized observation path runs and Level 2 binds generation, source, environment, oracle, trust, execution, and freshness context.

### 5.8 No human escape hatch

There is no `needs-human`, `waiting_human`, `worker_ask_need`, operator repair, or manual evidence path in the Saga 3 execution model.

A missing productive capability becomes a typed incident and an autonomous remediation WorkIntent. If no permitted path exists, Saga terminates truthfully.

## 6. Correct scoped concurrency

Saga 3 does not serialize work by global stages.

It may run development and verification concurrently when they concern independent scopes and each WorkIntent is causally ready.

Valid example:

```text
AC-1 implementation is integrated and current.
AC-1 verification runs.
AC-8 implementation continues independently.
```

Invalid example:

```text
AC-8 implementation is todo.
AC-8 verification runs.
```

The admission rule is scoped prerequisites, not stage equality and not unrestricted cross-stage execution.

## 7. Clean data model

Saga 3 starts from a Saga 3 schema.

Active authoritative entities are designed for the target model:

- PlatformPolicy;
- ProductConstitution;
- GovernancePolicy;
- EpisodeSpec;
- EpisodeCondition;
- ConditionDependency;
- WorkIntent;
- TaskConditionLink;
- ResourceClaim;
- BudgetLedgerEntry;
- ControlIncident;
- RecoveryAttempt;
- LMProposal;
- ControlDecision;
- EffectIntent;
- EvidenceRecord;
- ExecutionLease;
- OutcomeCertificate;
- append-only control events and authoritative projections.

Old task rows, stage states, retry counters, human requests, and legacy evidence are not imported as active authority.

Historical documents may be imported only as mandate input or research evidence with explicit provenance and no execution rights.

## 8. Reuse policy

Clean architecture does not require rewriting every utility.

Existing code may be reused only after it is adopted into the Saga 3 contract.

Potentially reusable:

- pure Git helpers;
- SQLite transaction utilities;
- hashing and ID helpers;
- process-launch primitives;
- worktree operations;
- parsers with valid target semantics;
- low-level lifecycle transition code where its authority boundary matches Saga 3.

Not reusable as active control behavior:

- stage-based dispatch;
- legacy pump sequencing;
- independent watchdog retry;
- independent runner retry;
- human pause and resume;
- legacy terminal states;
- fall-through dispatch;
- mixed task and controller authority;
- LM-direct evidence or completion;
- mutable JSON retry budgets.

Reuse is by explicit extraction into the new architecture, not by running the old subsystem behind a flag.

## 9. Implementation strategy

Saga 3 is built as a vertical walking skeleton, not as a wrapper around the old engine.

### Step 1: New composition root

Create a Saga 3 entrypoint that imports only Saga 3 modules and explicitly adopted low-level utilities.

The old orchestration entrypoint is not selected by environment flags.

### Step 2: Minimal end-to-end path

Implement one complete path:

```text
mandate
-> frozen obligation
-> one scoped condition=False
-> one WorkIntent
-> one worker assignment through a Skill
-> one created artifact
-> one authorized verification observation
-> evidence attestation
-> condition=True
-> OutcomeCertificate
```

This path must use the real parser, store, scheduler, worker bridge, ingestion boundary, and condition evaluator.

### Step 3: Failure path before breadth

Add:

- missing Skill;
- missing condition binding;
- stale source;
- worker crash;
- invalid output;
- unavailable oracle;
- budget exhaustion;
- ambiguous effect;
- truthful terminal outcome.

### Step 4: Scoped graph and concurrency

Add dependencies, resource claims, fan-out, fan-in, invalidation, deterministic integration, and concurrent independent scopes.

### Step 5: Expand obligation and effect types

Add the remaining discovery, requirements, architecture, development, verification, integration, release, observation, recovery, and certification paths only when each has productive reachability and causal readiness.

## 10. Testing strategy without shadow runtime

Saga 3 correctness is established by deterministic simulation, model-based tests, crash injection, concurrency schedules, replay, and real-adapter acceptance tests.

There is no production shadow controller comparing itself to the old engine.

Useful historical episodes are converted into deterministic regression scenarios:

- provenance deadlock;
- premature verification #90/#91;
- duplicate retry authorities;
- stale evidence;
- merge ambiguity;
- worker fencing failures;
- budget races;
- human fallback dead ends.

The old behavior is a source of counterexamples, not an oracle of correctness.

## 11. Repository consequences

The target repository state must not contain active runtime concepts for:

```text
v2 mode
v3 shadow mode
controller version switching
legacy fall-through
stage-filter compatibility guards
human pause/resume
legacy retry ownership
migration of active old episodes
```

References may remain in historical reports and postmortems only when clearly marked as descriptions of the failed previous implementation.

## 12. Definition of done

Saga 3 is complete when:

- one composition root starts one control system;
- every active task derives from an authorized WorkIntent;
- every material WorkIntent has target conditions and prerequisites;
- every semantic output has a worker and Skill production path;
- every worker output has an ingestion and attestation path;
- every dispatch decision is made by the Saga 3 controller;
- stages are projections only;
- missing control data fails closed;
- retries, incidents, budgets, effects, and outcomes have one authority;
- no old runtime mode or compatibility flag exists;
- no active path waits for a human;
- deterministic scenarios cover every required transition and failure class;
- each terminal episode has a truthful immutable OutcomeCertificate.

## 13. Final law

> Saga 3 is not a new controller layered over an old pipeline. It is one clean system in which normative intent defines required truth, deterministic control proves readiness and authorizes work, and LLM workers plus external adapters create artifacts and observations. No old process remains available as a fallback.