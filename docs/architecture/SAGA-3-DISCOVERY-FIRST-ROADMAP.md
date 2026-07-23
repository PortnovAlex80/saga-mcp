# Saga 3 Discovery-First Delivery Roadmap

Status: execution roadmap  
Date: 2026-07-23  
Baseline: final `saga2-refactoring` runtime  
First target branch: `saga3-discovery`

## 1. Purpose

Saga 3 must not begin as a rewrite of the complete product lifecycle.

The first implementation will clone the final working Saga 2 refactoring branch and replace only the orchestration decision model. All proven infrastructure remains in use:

- tracker and HTTP frontend;
- SQLite schema and repositories;
- worker runtime and model routing;
- engine administration;
- host runtime, PID ownership, heartbeat and rate-limit telemetry;
- artifacts, traces and verification records;
- task board and worker protocol.

The first runnable Saga 3 product will contain one product stage only:

```text
input problem or idea
    -> discovery
    -> DiscoveryOutcome
    -> run terminates
```

It will not yet implement formalization, planning, development, verification or integration.

The purpose of this slice is to prove the new control model under real LM execution before the product pipeline is expanded.

## 2. Core idea to preserve

Saga 3 combines three different execution modes.

### 2.1 Deterministic kernel

The kernel owns authoritative state and all irreversible decisions:

- state transitions;
- authority and tool scopes;
- budgets and retry limits;
- locks and idempotency;
- provenance capture;
- validation of typed contracts;
- terminal outcomes;
- authoritative commit.

The kernel must remain deterministic and explainable.

### 2.2 Product worker plane

Product workers perform the actual project work:

- understand the user's problem;
- investigate context;
- produce discovery artifacts;
- identify assumptions and uncertainty;
- propose a discovery conclusion.

Workers are powerful but non-authoritative. Their output is a proposal, not a committed fact.

### 2.3 Cognitive control plane

The cognitive control plane uses LM execution to assist the kernel with its own control work:

- normalize semantically malformed worker output;
- classify a failure or unusual state;
- assess whether discovery is substantively complete;
- diagnose anomalies and deadlocks;
- propose recovery options;
- critique a worker proposal;
- identify missing evidence.

The cognitive control plane may use the same underlying model and worker runtime as product workers, but it must have a separate logical identity, intent type, authority scope and tool allowlist.

The central rule is:

```text
LM supplies interpretation, hypotheses and proposals.
The deterministic kernel supplies authority, validation and commit.
```

## 3. What Saga 3 is not

Saga 3 is not:

- a replacement tracker;
- a replacement worker runner;
- a second task board;
- a larger hard-coded recovery tree;
- an LM manager with unrestricted access;
- a prompt-only architecture;
- a complete lifecycle implemented in one release.

The first implementation must reuse the isolated infrastructure produced by the Saga 2 refactoring.

## 4. Delivery principle: executable vertical slices

Every roadmap item must leave a runnable system.

A step is not complete merely because its interfaces or tables exist. It is complete only when the current pipeline can be started, can execute its available stage, and can reach an honest terminal result.

Each slice must provide:

1. an explicit entry condition;
2. an executable engine path;
3. observable activity in the existing frontend;
4. bounded failure and recovery behaviour;
5. a typed terminal outcome;
6. automated tests;
7. one real LM smoke run when the slice changes runtime semantics.

No slice may require a later stage to make the current stage usable.

## 5. Branch and compatibility strategy

### 5.1 Stable lines

- `saga2` remains the historical stable Saga 2 baseline.
- `saga2-refactoring` remains the final replaceable Saga 2 implementation and fallback engine.
- `saga3-discovery` is created from the final accepted `saga2-refactoring` head.

A Git branch is the full clone of the working system. Saga 3 must not copy the repository into a parallel directory or duplicate infrastructure modules.

### 5.2 Engine selection

The composition root selects one implementation behind the existing `OrchestrationEngine` port:

```text
SAGA_ORCHESTRATION_MODE=saga2
    -> Saga2Engine

SAGA_ORCHESTRATION_MODE=saga3-discovery
    -> Saga3DiscoveryEngine
```

The tracker, repositories, worker runtime and engine administration must not branch on Saga 3 internals.

### 5.3 Partial-pipeline completion semantics

A discovery-only pipeline must not claim that the complete product has been delivered.

The engine run may technically terminate, but the authoritative business outcome is:

```text
DiscoveryOutcome =
    go
    clarify
    reject
    defer
    inconclusive
    failed
```

The run record must also contain:

```text
pipeline_scope = discovery_only
scope_completed = true | false
```

`scope_completed=true` means that the configured discovery-only pipeline completed. It does not mean that development or delivery completed.

## 6. Saga 3 Discovery Edition: target behaviour

### 6.1 Input

The first version accepts:

- project and episode identity;
- an initial problem, idea or request;
- registered repositories or other available context;
- model route and execution budget;
- optional human constraints.

### 6.2 Product work

A discovery product worker must produce a typed proposal containing at least:

```text
DiscoveryProposal
- problem_statement
- observed_context
- stakeholders_or_actors
- assumptions
- unknowns
- risks
- candidate_scope
- evidence_refs
- recommended_outcome
- rationale
```

### 6.3 Control work

The cognitive control plane may perform the following service intents in the first release:

```text
NormalizeDiscoveryProposal
AssessDiscoveryReadiness
ClassifyDiscoveryFailure
DiagnoseDiscoveryAnomaly
```

Only `AssessDiscoveryReadiness` is required for the first complete discovery slice. The other intents are added incrementally as described below.

### 6.4 Settlement

The kernel combines:

- the product worker proposal;
- automatically captured provenance;
- deterministic schema and authority checks;
- available evidence;
- the advisor assessment, when requested;
- budget and retry state.

It then commits one `DiscoveryOutcome`.

### 6.5 Terminal artifact

Every successful or honest unsuccessful run produces a `DiscoveryOutcomeCertificate`:

```text
DiscoveryOutcomeCertificate
- episode_id
- discovery_intent_id
- pipeline_scope
- outcome
- proposal_ref
- assessment_ref
- evidence_refs
- provenance_ref
- unresolved_unknowns
- limitations
- committed_at
- policy_version
```

## 7. Minimal protocol between deterministic and LM worlds

The initial protocol must remain smaller than the complete theoretical Saga 3 model.

### 7.1 WorkIntent

Created by the kernel for product work.

```text
WorkIntent
- id
- kind
- subject
- objective
- authoritative_snapshot_ref
- authority_scope
- allowed_tools
- output_schema
- token_budget
- retry_budget
```

### 7.2 ControlIntent

Created by the kernel for cognitive control work.

```text
ControlIntent
- id
- kind
- subject
- question
- authoritative_snapshot_ref
- read_scope
- allowed_tools
- output_schema
- token_budget
- deliberation_depth
```

The first control intents are read-only.

### 7.3 Proposal

Produced by an LM execution.

```text
Proposal
- intent_id
- payload
- assumptions
- evidence_refs
- missing_information
- alternatives
- confidence_basis
```

### 7.4 Runtime provenance

The worker does not manually invent runtime provenance. The infrastructure records:

- intent identity;
- model, provider and effort;
- worker and execution identity;
- prompt and snapshot hashes;
- tool calls;
- artifact hashes;
- timestamps;
- terminal execution status.

### 7.5 DecisionRecord

Produced only by the deterministic kernel.

```text
DecisionRecord
- subject
- proposal_refs
- policy_checks
- decision
- reasons
- missing_requirements
- committed_mutations
```

## 8. Discovery implementation ladder

Each item below is independently runnable and must preserve the previous item's behaviour.

### D0. Create the Saga 3 discovery branch and engine shell

Goal: prove that the isolated infrastructure can host a second engine without altering Saga 2.

Implementation:

- create `saga3-discovery` from the final accepted `saga2-refactoring` head;
- add `Saga3DiscoveryEngine` behind `OrchestrationEngine`;
- add composition-root selection;
- reuse all existing ports and concrete adapters;
- define `pipeline_scope=discovery_only`;
- return an explicit `not_implemented` discovery result without spawning a worker.

Runnable result:

- tracker starts;
- engine start/stop/status works;
- Saga 2 remains selectable;
- Saga 3 discovery mode starts and terminates honestly;
- no product state is falsely marked complete.

Exit gates:

- build passes;
- architecture tests prove no Saga 3 infrastructure duplication;
- Saga 2 characterization remains green;
- Saga 3 shell smoke run terminates with a typed result.

### D1. Execute one discovery WorkIntent

Goal: run real product work through the existing worker infrastructure.

Implementation:

- create one discovery `WorkIntent`;
- create or project one visible discovery task on the existing board;
- dispatch it through `WorkerExecutorFactory`;
- require a typed `DiscoveryProposal` artifact;
- capture runtime provenance automatically;
- terminate with `inconclusive` when the proposal is missing or invalid.

Runnable result:

```text
problem input
    -> discovery task
    -> LM product worker
    -> DiscoveryProposal
    -> provisional DiscoveryOutcome
    -> run terminates
```

No advisor is required yet.

Exit gates:

- real worker starts;
- task and artifact are visible in the current frontend;
- valid proposal reaches a provisional outcome;
- malformed or missing proposal produces an honest non-success outcome;
- retries are bounded.

### D2. Add deterministic normalization before LM normalization

Goal: distinguish mechanical formatting defects from semantic ambiguity.

Implementation order:

1. strict JSON parsing;
2. deterministic markdown-fence removal;
3. deterministic schema coercion for explicitly supported aliases;
4. typed validation;
5. only then create `NormalizeDiscoveryProposal` when semantic repair is required.

The normalization advisor:

- is read-only;
- cannot invent missing evidence;
- must preserve the original payload;
- returns a normalized proposal plus a list of inferred transformations;
- cannot directly commit the normalized result.

Runnable result:

- valid output follows the D1 path;
- mechanically repairable output is normalized without LM;
- semantically malformed output may receive one bounded advisor call;
- unrecoverable output terminates as `inconclusive` or `failed`.

Exit gates:

- deterministic parser fixtures pass;
- advisor invocation is observable;
- original and normalized hashes are retained;
- no normalization path can silently turn missing evidence into present evidence.

### D3. Add discovery readiness advisor in shadow mode

Goal: prove the cognitive control layer without giving it authority.

Implementation:

- create `AssessDiscoveryReadiness` after a valid product proposal;
- provide an authoritative read-only snapshot;
- request classification:
  - ready;
  - ready_with_risks;
  - needs_clarification;
  - unsupported;
  - conflicting_information;
  - inconclusive;
- record the advisor proposal and provenance;
- do not let the advisor block or commit the outcome yet;
- compare the deterministic provisional decision with the advisor assessment.

Runnable result:

- the discovery pipeline still completes using the D1/D2 policy;
- the frontend or decision trace exposes the shadow advisor result;
- advisor failure does not deadlock discovery.

Exit gates:

- same input can be run with advisor enabled or disabled;
- the product outcome remains deterministic under shadow mode;
- disagreements are recorded explicitly;
- advisor recursion depth is limited to one.

### D4. Add deterministic settlement and DiscoveryOutcomeCertificate

Goal: make the discovery outcome authoritative and explainable.

Implementation:

- add a versioned `DiscoverySettlementPolicy`;
- validate proposal, provenance, evidence and optional advisor assessment;
- commit one typed `DiscoveryOutcome`;
- issue `DiscoveryOutcomeCertificate`;
- prohibit product workers and advisors from writing the outcome directly.

Initial conservative policy:

- deterministic contract failure -> `failed`;
- missing required information -> `clarify` or `inconclusive`;
- explicit unsupported request -> `reject`;
- sufficient proposal and no hard conflict -> `go`;
- advisor disagreement is recorded but does not block unless a deterministic conflict can be confirmed.

Runnable result:

```text
WorkIntent
    -> product proposal
    -> normalization
    -> optional readiness assessment
    -> settlement policy
    -> DiscoveryOutcomeCertificate
    -> discovery-only run terminates
```

Exit gates:

- certificates are reproducible from the same stored inputs and policy version;
- no outcome exists without its intent and provenance;
- re-running settlement is idempotent;
- Saga 2 remains unaffected.

### D5. Add discovery anomaly diagnosis

Goal: use LM reasoning to assist the orchestrator when the normal discovery path cannot explain a failure.

Trigger examples:

- repeated invalid proposals;
- contradictory discovery artifacts;
- worker execution finished but no proposal exists;
- provenance is incomplete;
- advisor and product proposal refer to different snapshot hashes;
- retry budget approaches exhaustion.

Implementation:

- deterministic detector creates `DiagnoseDiscoveryAnomaly`;
- diagnostic advisor receives read-only tools and a bounded snapshot;
- advisor returns hypotheses, supporting facts, missing data and safe recovery options;
- kernel validates the report;
- first release may create only:
  - a new evidence request;
  - one bounded re-discovery intent;
  - a human escalation proposal;
- no autonomous mutation repair is allowed yet.

Runnable result:

- normal discovery remains unchanged;
- anomalous discovery produces a visible `DiagnosticReport`;
- failure of the diagnostic advisor terminates honestly rather than looping.

Exit gates:

- maximum control depth is enforced;
- maximum advisor calls and token budget are enforced;
- diagnostic output cannot commit state;
- at least one injected anomaly is correctly diagnosed in a real or controlled LM run.

### D6. Discovery Edition acceptance

Goal: declare the one-stage Saga 3 product operational.

Required scenario set:

1. clear idea -> `go`;
2. insufficient information -> `clarify`;
3. unsupported or explicitly rejected idea -> `reject`;
4. malformed worker output -> deterministic or LM normalization;
5. worker failure -> bounded retry and honest outcome;
6. conflicting information -> advisor assessment and non-false completion;
7. injected runtime anomaly -> diagnostic report;
8. advisor unavailable -> pipeline still terminates;
9. duplicate engine start -> existing host guard remains correct;
10. model switch and concurrency control remain operational.

Acceptance evidence:

- full automated suite;
- Saga 2 regression suite;
- mock Saga 3 discovery E2E;
- real LM runs for the scenario set;
- frontend evidence for tasks, artifacts, control operations and terminal outcome;
- recorded limitations and known false-positive/false-negative cases.

After D6, `saga3-discovery` is a complete, usable one-stage Saga 3 implementation.

## 9. Expansion of the product pipeline

The remaining product lifecycle is added only after Discovery Edition acceptance.

Each stage extension must remain a complete runnable pipeline ending at the newly added stage.

| Slice | Runnable pipeline | New terminal scope outcome |
|---|---|---|
| F1 | discovery -> formalization | `formalization_completed` |
| P1 | discovery -> formalization -> planning | `planning_completed` |
| DEV1 | discovery -> formalization -> planning -> development | `development_completed` |
| V1 | ... -> verification | `verification_completed` |
| I1 | ... -> integration | `integration_completed` |
| C1 | full pipeline -> completed | `product_pipeline_completed` |

For every new stage:

1. define the product `WorkIntent`;
2. define the product proposal schema;
3. define required deterministic evidence;
4. add only the control intents needed by that stage;
5. define settlement policy and terminal certificate;
6. add stage-specific recovery and diagnostics;
7. run the complete pipeline from discovery to the current stage.

Do not pre-build all future stage trees in Discovery Edition.

## 10. Control-operation visibility

Product work remains visible on the existing task board.

Short control calls should not pollute the product kanban. They require a separate durable projection:

```text
Control Operations
- intent kind
- subject
- status
- model route
- budget used
- proposal or report reference
- decision reference
```

Long recovery work that changes project state may later be promoted to a visible repair task, but only after explicit kernel authorization.

## 11. Safety and bounded cognition

The first Saga 3 release must enforce:

- `max_deliberation_depth = 1` for normal control operations;
- bounded control-call count per discovery run;
- separate token budgets for product and control work;
- read-only control advisor tools;
- no advisor-created advisor calls;
- no direct stage or outcome mutation by LM executions;
- no evidence invention during normalization;
- deterministic fallback when an advisor is unavailable;
- explicit `inconclusive` instead of fabricated certainty.

## 12. Immediate next action

The next implementation action after the final Saga 2 runtime acceptance is **D0 only**:

```text
create saga3-discovery branch
    -> add Saga3DiscoveryEngine shell
    -> select it in composition root
    -> reuse all existing infrastructure
    -> run and terminate with an honest discovery-only result
```

Do not implement D1-D6 in the same patch.

D0 proves that the engine isolation achieved in Phase B is real. Only after D0 is green should D1 start real discovery worker execution.

## 13. Definition of success

Saga 3 Discovery Edition succeeds when it can take an unstructured idea, execute real LM discovery work, use bounded LM assistance for control reasoning, and produce an authoritative, evidence-linked discovery outcome without confusing that outcome with delivery of the complete product.

The system must demonstrate both properties at once:

```text
flexibility from LM reasoning
+
authority and safety from deterministic control
```
