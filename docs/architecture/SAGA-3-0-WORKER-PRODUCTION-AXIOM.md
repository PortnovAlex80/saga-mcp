# Saga 3.0 Worker Production Axiom

Date: 2026-07-22

Status: normative architecture correction

## 1. Core axiom

Saga is an LLM-worker production system.

The controller, policies, ledgers, guards, registries, state machines, ports, and evidence rules do not create product work. They coordinate, authorize, constrain, observe, record, and verify it.

Only an assigned worker creates the semantic product output:

- code;
- tests;
- requirements;
- architecture text;
- plans;
- analyses;
- remediation patches;
- verification procedures;
- operational instructions;
- evidence-producing scripts and adapters.

No such output appears unless a worker receives an executable work assignment through an applicable Skill and has the tools, context, authority, and completion contract required to perform it.

This is not an implementation detail. It is the productive ontology of Saga.

## 2. Consequence for the controller

The controller may decide that an artifact, observation, adapter, provenance field, test, benchmark, migration, diagnosis, or repair is required. That decision does not create the required thing.

For every controller decision that requires new semantic work, the controller must materialize an executable WorkIntent and route it to a capable worker Skill.

The complete causal chain is:

```text
condition deficit or incident
        -> controller decision
        -> executable WorkIntent
        -> Skill and worker assignment
        -> worker creates an artifact or performs an observation procedure
        -> deterministic ingestion and attestation
        -> authoritative state transition
```

A transition is unreachable when any link is absent.

The architecture must never substitute one of these for worker production:

- a validation rule;
- a database row;
- a retry;
- a stage transition;
- a controller decision;
- a policy declaration;
- a required field in an MCP schema;
- a terminal outcome;
- an assumption that another subsystem will somehow provide the missing artifact.

## 3. Creation, execution, observation, and authority are different responsibilities

Saga must distinguish four roles:

1. **Worker production** — creates or changes semantic artifacts and executable procedures.
2. **Controller authorization** — decides which production or observation action is admissible.
3. **Runtime execution and observation** — runs authorized procedures and obtains raw facts.
4. **Attestation and evaluation** — binds facts to authoritative context and changes conditions.

The rule `LM proposes, controller authorizes, evidence settles` is incomplete unless expanded to:

> The controller must assign every required act of creation to a capable worker, authorize every effect, acquire observations through executable procedures, attest authoritative context, and then let evidence settle the condition.

The controller is not a hidden worker. It must not invent code, requirements, benchmarks, environment descriptions, diagnoses, or missing evidence payloads inside orchestration logic.

At the same time, a worker must not be required to manufacture authoritative controller facts such as policy generation, lease authority, trust class, or server-side provenance.

## 4. The two-sided bridge contract

Every production transition has two bridges.

### 4.1 Downstream bridge: controller to worker

The WorkIntent and Skill assignment must provide:

```text
objective
reason for the work
input artifacts and source baseline
owned and prohibited scopes
required tools and ports
allowed effects
expected output artifact
output schema
acceptance and verification contract
budget and deadline
lease and fencing identity
failure and handoff protocol
```

A worker cannot be blamed for failing to create an output that its Skill does not make reachable.

### 4.2 Upstream bridge: worker to controller

The worker returns only the output it can legitimately produce:

```text
created artifact or patch
raw execution result
claim or proposal
artifact references
execution identity
structured completion or failure report
```

The control plane then supplies and validates its own authoritative context:

```text
episode and generation
source and environment fingerprints
policy binding
oracle registration
trust classification
lease epoch
freshness and invalidation rules
```

The worker must not self-assert these fields as authority.

## 5. Reachability invariant

For every required state transition, Gate 0 and every later architecture gate must answer:

> What exact worker task creates the artifact or procedure needed for this transition, which Skill teaches the worker how to create it, and which tool path returns it to the controller?

A condition, recovery rung, degradation path, verification path, integration path, or terminal predicate is not implemented merely because its state and validator exist.

It is implemented only when its complete production path is reachable:

```text
need detected
-> task materialized
-> worker capability selected
-> inputs available
-> artifact or procedure created
-> output accepted
-> authoritative context attached
-> result observed or verified
-> state reconciled
```

## 6. Mandatory Production Reachability Matrix

Saga 3.0 must maintain a Production Reachability Matrix for every non-trivial transition.

Each row contains:

```text
required output or change
triggering condition or incident
creating worker role
Skill
WorkIntent kind
required inputs
required tools and ports
owned scopes
durable output boundary
controller-side enrichment
verifier or oracle
failure classification
recovery route
terminal disposition if unreachable
```

Any row with no creating worker, no Skill, no executable input path, or no ingestion path is an architectural blocker.

The same matrix must cover all stages, not only development:

- discovery facts and hypotheses;
- product requirements and acceptance criteria;
- architecture and decomposition;
- code and tests;
- benchmark and verification procedures;
- migration and integration repairs;
- oracle adapters;
- incident diagnoses;
- recovery patches;
- environment recreation instructions;
- release and compensation procedures;
- outcome explanations and certificates where semantic text must be produced.

## 7. Implications for recovery

A recovery decision such as `diagnose`, `repair`, `replan`, `create an oracle`, `rebuild the environment`, or `fix the product` must create a new typed worker assignment.

It is not enough to change an incident state or increment a recovery position.

Repeatedly sending the same worker an impossible call contract is not recovery. It is control-plane repetition.

When the controller detects that the required artifact cannot be produced because the Skill, tool, input, or ingestion bridge is missing, it must classify a production-reachability incident. The permitted responses are:

1. materialize an infrastructure or Skill remediation WorkIntent;
2. select another frozen production path;
3. activate an authorized degradation path;
4. terminate truthfully when no permitted path exists.

## 8. Implications for verification provenance

A verifier worker may create a test, benchmark, analysis, or raw verdict. It does not create server authority.

The controller must not demand authoritative provenance fields from the worker. It must also not launder an unsupported LM claim into trusted evidence merely by attaching metadata.

The correct path is:

```text
controller assigns verification work
-> verifier creates or selects an executable check
-> controller authorizes the check
-> registered runtime executes it
-> raw observation is collected
-> control plane attaches provenance
-> evidence policy validates it
-> condition changes
```

When the check itself does not exist, creating that check is worker production and requires its own WorkIntent and Skill.

## 9. Migration rule

Removal of a human fallback is incomplete until its productive replacement is identified.

For every removed `needs-human`, `waiting_human`, operator instruction, manual database edit, manual evidence entry, or manual repair path, the migration audit must name:

```text
what the human used to create or decide
which worker now creates it
which Skill and tools make it executable
which controller rule authorizes it
how its result is ingested and verified
what happens if the worker cannot produce it
```

Deleting the human state without this replacement creates a dead end, not autonomy.

## 10. Gate additions

Every Saga 3.0 implementation gate must include production-reachability evidence.

At minimum:

- Gate 0 maps every existing productive act, including manual acts, to its current producer.
- Gate 1 proves the controller can materialize and execute one real worker assignment through a Skill seam.
- Gate 3 validates that every compiled ConditionContract and ActionContract has a reachable producer where new semantic work is required.
- Gate 4 shadow reconciliation must show not only candidate actions but the concrete WorkIntent and capable Skill that would execute each action.
- Gate 6 recovery scenarios must prove that each selected recovery strategy produces an executable worker task rather than only a state transition.
- Gate 8 verification scenarios must prove creation and execution of the verification procedure, not only evidence validation.
- Gate 9 end-to-end journeys must trace every created artifact to a worker execution and every authoritative field to a control-plane producer.
- Gate 10 must prove that each removed human path has an autonomous productive replacement.

## 11. Definition of done correction

Saga 3.0 is not complete when all policies, validators, ledgers, conditions, incidents, and outcomes exist.

It is complete only when every required semantic output and every required repair can be produced through a reachable worker assignment, and every resulting artifact can cross back into authoritative state through a defined ingestion and verification path.

The concise law is:

> Controllers do not create the work. Workers create the work. Therefore every controller decision that needs something new must become an executable worker assignment through a Skill, and every worker result must have a defined bridge back into authoritative state.
