# Saga 3 Clean Implementation Plan

Date: 2026-07-22

Status: target implementation plan

Normative architecture: `docs/architecture/SAGA-3-CLEAN-ARCHITECTURE.md`

## 1. Objective

Build Saga 3 as one clean autonomous LLM-worker production system.

The implementation does not wrap, switch to, fall through to, shadow, or preserve an older runtime.

The existing repository is used for:

- failure evidence;
- regression scenarios;
- extraction of explicitly accepted low-level utilities;
- understanding current data and tool surfaces.

It is not used as a second execution path.

## 2. Three implementation levels

### Level 1: Normative intent

Build and freeze:

- PlatformPolicy;
- ProductConstitution;
- GovernancePolicy;
- EpisodeSpec;
- obligation catalog;
- scoped ConditionContracts;
- ActionContracts;
- degradation profiles;
- terminal truth table.

### Level 2: Deterministic control

Build:

- observation assembly;
- condition evaluation and invalidation;
- deficit selection;
- WorkIntent materialization;
- causal-readiness evaluation;
- admission and scheduling;
- budget ledger;
- leases and resource claims;
- incident and recovery authority;
- evidence attestation;
- effect reconciliation;
- outcome certification.

### Level 3: Productive execution

Build:

- worker assignment protocol;
- Skill capability registry;
- LLM worker runtime;
- repository/process/oracle/effect adapters;
- output ingestion;
- independent verification execution;
- deterministic integration execution.

## 3. Repository strategy

Create a dedicated Saga 3 namespace and composition root:

```text
src/saga3/
  domain/
  policy/
  conditions/
  work-intents/
  readiness/
  scheduler/
  executions/
  resources/
  budgets/
  incidents/
  recovery/
  evidence/
  effects/
  outcomes/
  ports/
  adapters/
  app/
```

Recommended entrypoints:

```text
src/saga3/app/server.ts
src/saga3/app/engine.ts
src/saga3/app/cli.ts
```

The Saga 3 entrypoint imports only:

- Saga 3 modules;
- explicitly extracted pure utilities;
- approved external libraries.

It must not import the old orchestrator, dispatcher, recovery tree, human workflow, or stage transition authority.

No environment variable chooses between engines.

## 4. Fresh authoritative schema

Use a Saga 3 database or a clearly isolated Saga 3 schema created from the target domain.

Do not make old task, workflow, human-request, retry-counter, or stage rows authoritative inputs.

Minimum entities for the walking skeleton:

```text
platform_policies
product_constitutions
governance_policies
episode_specs
obligations
condition_contracts
episode_conditions
condition_dependencies
work_intents
work_intent_prerequisites
worker_assignments
execution_leases
resource_claims
budget_ledger
lm_proposals
control_decisions
artifacts
observations
evidence_records
control_incidents
recovery_attempts
outcome_certificates
control_events
```

Historical artifacts may be copied into a separate input area with explicit `historical_untrusted` provenance. They do not become current evidence automatically.

## 5. First vertical walking skeleton

Do not begin by implementing all stages.

Implement one complete obligation from mandate to terminal certificate.

### Scenario

```text
Mandate requires one text artifact with one verifiable property.
```

### Full path

```text
1. Store mandate input.
2. A worker through a commissioning Skill produces one obligation proposal.
3. The controller validates and freezes one ConditionContract.
4. The initial scoped condition is False or Unknown.
5. Reconciliation selects the deficit.
6. One WorkIntent is materialized.
7. Readiness proves all prerequisites.
8. Budget, lease, and resource claim are reserved atomically.
9. A worker receives the assignment through the selected Skill.
10. The worker creates the artifact.
11. The output is ingested through the real parser.
12. A verification WorkIntent is created only after implementation and source prerequisites are true.
13. An authorized oracle executes the check.
14. The controller attaches provenance and persists evidence.
15. The condition becomes True.
16. An immutable SUCCEEDED OutcomeCertificate is issued.
```

This skeleton is not complete until restart recovery works at every durable boundary.

## 6. Gate A: Domain and authority kernel

Deliver:

- immutable IDs and versions;
- PlatformPolicy;
- EpisodeSpec;
- obligation and condition contracts;
- authoritative condition projection;
- append-only control events;
- CAS/versioned state transitions;
- terminal truth table.

Required proof:

```text
Only the controller changes authoritative conditions.
A terminal certificate is absorbing.
The same history reconstructs the same state.
```

## 7. Gate B: Productive assignment bridge

Deliver:

- Skill Capability Registry;
- WorkIntent schema;
- worker assignment contract;
- worker output contract;
- artifact ingestion;
- execution identity and lease fencing.

Required proof:

```text
A controller decision requiring semantic work always resolves to a capable Skill or a typed incident.
No semantic artifact appears without a worker assignment.
A stale worker cannot submit an artifact.
```

## 8. Gate C: Causal readiness and scheduler

Deliver:

- explicit prerequisite conditions;
- dependency graph validation;
- source and environment prerequisites;
- WorkIntent uniqueness;
- deterministic candidate ordering;
- atomic admission;
- resource claims;
- budget reservation.

Required proof:

```text
Material work with target_conditions=[] is rejected.
A verification WorkIntent cannot run before its scoped implementation is integrated.
Independent scopes may run concurrently.
Two controllers cannot dispatch the same WorkIntent.
```

Mandatory regression: task #90/#91 premature verification.

## 9. Gate D: Evidence production and attestation

Deliver:

- OracleRegistry;
- verification WorkIntent types;
- executable check creation or selection;
- OraclePort;
- environment fingerprinting;
- repository/source fingerprinting;
- evidence attestation;
- freshness and invalidation.

Required proof:

```text
An LM claim is never evidence by itself.
The worker is not required to invent authoritative provenance.
Provenance is attached only to a real observation.
Stale evidence cannot satisfy a blocker.
```

Mandatory regression: provenance deadlock after `O(1), <50ms, passed`.

## 10. Gate E: Incident and recovery authority

Deliver:

- typed incident taxonomy;
- causal fingerprints;
- durable recovery attempts;
- R0-R9 applicability rules;
- recovery WorkIntent materialization;
- no-unchanged-retry rule;
- budget integration.

Required proof:

```text
Every selected semantic recovery action creates a worker assignment.
The same non-transient failure is not retried without a causal change.
There is one retry authority.
No human request path exists.
```

## 11. Gate F: Effects and integration

Deliver:

- durable effect intents;
- idempotency keys;
- observer strategies;
- ambiguous-effect handling;
- deterministic integration ownership;
- expected-head compare-and-swap;
- post-integration verification prerequisites.

Required proof:

```text
No effect runs without durable authorization.
Crash after external execution does not duplicate the effect.
Unknown material state produces EXTERNAL_STATE_UNKNOWN.
Only integrated candidate state may be certified.
```

## 12. Gate G: Parallel execution

Deliver:

- read/write/external-effect resource scopes;
- lease epochs and fencing;
- fan-out and fan-in;
- descendant invalidation;
- deterministic integration order;
- WIP pools and fairness.

Required proof:

```text
Concurrency one and concurrency N have equivalent terminal semantics.
Overlapping writers serialize.
Disjoint ready work may run concurrently.
Late stale results are rejected.
Mandatory work cannot starve behind optional work.
```

## 13. Gate H: Complete commissioning and delivery paths

Expand the walking skeleton to cover:

- discovery;
- formalization;
- feasibility;
- architecture;
- planning;
- development;
- verification;
- integration;
- runtime validation;
- release;
- observation;
- degradation;
- truthful negative outcomes.

Each path must have:

```text
producer worker or deterministic adapter;
Skill or port;
input contract;
WorkIntent;
prerequisites;
output contract;
ingestion;
evidence or artifact identity;
recovery route;
terminal disposition.
```

## 14. Deterministic simulator

Build the simulator around the Saga 3 composition root.

Required adapters:

```text
scripted worker/model
virtual clock
deterministic IDs
seeded scheduler
fake repository
fake process runtime
fake oracles
fake effects
fault-injecting store
trace recorder
independent reference model
```

The simulator must not populate completed artifacts magically.

It must exercise the real chain:

```text
deficit
-> WorkIntent
-> assignment
-> worker output
-> ingestion
-> observation
-> attestation
-> condition transition
```

## 15. Historical code disposition

Perform a source audit and classify every old component:

```text
EXTRACT_PURE_UTILITY
REIMPLEMENT_FOR_SAGA3
CONVERT_TO_REGRESSION_SCENARIO
ARCHIVE_DOCUMENTATION
DELETE_FROM_ACTIVE_RUNTIME
```

Components expected to be deleted from active runtime include:

- mode switches;
- old orchestration pump;
- old stage dispatcher;
- stage-transition authority;
- human pause/resume;
- worker ask-need path;
- independent watchdog recovery;
- independent runner retry authority;
- legacy recovery counters;
- fall-through selection;
- compatibility readers and writers;
- active migration of old episodes.

Deletion occurs after equivalent Saga 3 functionality is present in the walking skeleton, but the old component is never a production fallback during construction.

## 16. Development workflow while Saga 3 is incomplete

Saga 3 development is performed through ordinary repository development and deterministic tests.

The incomplete Saga 3 engine is not used to run real autonomous production episodes until the vertical skeleton and its negative paths pass.

This is not shadow operation. It is standard software construction before release.

Historical episodes become fixtures and scenario definitions.

## 17. Required CI scopes

### Pull request

```text
build and typecheck
fixed-seed unit and state-machine tests
affected deterministic scenarios
critical crash boundaries
resource and lease leak detection
```

### Nightly

```text
complete generated state-machine exploration
broad deterministic interleavings
full crash matrix
real process kill/restart
real Git integration conflicts
mutation tests for authority boundaries
```

### Release

```text
every productive transition
every causal-readiness case
every terminal truth-table case
full end-to-end obligations
real adapters in controlled environments
no forbidden legacy imports or mode flags
```

## 18. Forbidden implementation shortcuts

Do not:

- dispatch directly from `tasks.status`;
- treat empty conditions as ready;
- preserve a hidden old dispatcher;
- add a temporary mode flag;
- route unknown cases to an older engine;
- create authoritative provenance from worker payload fields;
- let the controller silently author semantic artifacts;
- remove a human path without a worker or deterministic replacement;
- call a recovery state change a repair when no worker assignment exists;
- use stage labels as an emergency admission rule;
- accept tests that sleep on wall-clock time;
- mark a mixed-authority scenario as transitional and therefore acceptable.

## 19. Completion criteria

The implementation is complete when:

```text
one entrypoint starts one Saga 3 system;
one controller owns all authoritative decisions;
every material execution derives from a WorkIntent;
every WorkIntent has target conditions and prerequisites;
every semantic output has a worker and Skill producer;
every output has an ingestion path;
every evidence record comes from an authorized observation;
every missing binding fails closed;
every recovery requiring creation creates a worker task;
every external effect has durable intent and observation;
every terminal episode has an immutable truthful certificate;
no old process, runtime mode, compatibility flag, or fall-through authority remains.
```

## 20. Final implementation principle

> Build the complete causal chain vertically before expanding it horizontally. Saga 3 begins when one obligation can travel from mandate through worker production, causal readiness, verification, and truthful certification under one authority. Everything else is added only by extending that same chain.