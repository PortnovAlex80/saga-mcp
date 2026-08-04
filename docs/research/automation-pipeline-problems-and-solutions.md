# Problems and Solutions in Automating an LLM Development Pipeline

Date: 2026-07-22

Status: living research report

## 1. Honest conclusion

The refactoring journey exposed a basic fact that the architecture repeatedly obscured:

> LLM workers are the productive actors of the pipeline. They create code, tests, requirements, architecture, plans, diagnoses, repair patches, verification procedures, and operational artifacts. Nothing semantic is created merely because a controller, policy, validator, database table, or state transition says that it is required.

A worker creates something only after it receives an executable assignment through a Skill with sufficient context, tools, authority, and a defined completion path.

This is the central practical constraint of the entire automation problem.

The controller can coordinate work. It cannot replace the worker as the producer of work.

## 2. Why the refactoring path missed this

The Saga 3.0 work correctly identified many control failures:

- stage-as-truth;
- overlapping retry authorities;
- human-dependent terminal states;
- stale evidence;
- LM claims treated as facts;
- weak concurrency control;
- non-durable budgets;
- ambiguous effects;
- missing truthful terminal outcomes.

The response was to design stronger control concepts:

- scoped conditions;
- work intents;
- budget ledger;
- resource claims;
- incident authority;
- recovery ladder;
- oracle registry;
- evidence provenance;
- deterministic simulation;
- shadow cutover;
- outcome certificates.

These concepts are necessary. They are not sufficient.

Most of them describe how the system constrains, validates, records, or evaluates work after the required artifact or observation exists. They do not automatically explain who creates that artifact, who builds the missing test, who writes the repair, who constructs the benchmark, who diagnoses the incident, or who creates the adapter needed to collect the fact.

The design accumulated nouns and guards faster than it specified productive transitions.

## 3. Real failure: verification provenance deadlock

### 3.1 What happened

An LM verifier inspected code and reported:

```text
O(1), <50ms, passed
```

The verification handler rejected the record because required provenance fields were absent:

- generation;
- source fingerprint;
- oracle ID and version;
- trust class;
- environment fingerprint.

The worker retried five times. The same guard rejected the same structurally impossible request. `worker_ask_need` was prohibited in v3 mode. No verification record was created and the pipeline deadlocked.

### 3.2 Immediate design error

The handler required the LM worker to supply authoritative control-plane facts that the worker did not own and could not reliably know.

The actual owners were elsewhere:

- episode generation belonged to EpisodeSpec;
- source identity belonged to RepositoryPort;
- oracle identity belonged to the authorized verification contract and OracleRegistry;
- trust classification belonged to policy;
- environment identity required a runtime observer.

The guard therefore delegated controller responsibility back to the LM while claiming to protect authoritative state from LM mutation.

### 3.3 Deeper design error

The deeper failure was not only missing evidence attestation.

The architecture had not specified the productive chain needed to obtain the evidence:

```text
Who receives the verification task?
Which Skill tells the worker what to create or execute?
Who creates the benchmark or test when it does not exist?
Which runtime runs it?
How is the raw result returned?
Which control-plane component attaches authoritative context?
What recovery task is created if any bridge is missing?
```

The architecture had an evidence validator but no complete evidence-producing workflow.

### 3.4 Important distinction

The controller must attach authoritative provenance, but it must not turn an unsupported LM sentence into trusted evidence merely by adding metadata.

`O(1)`, `<50ms`, and `passed` are different claims and require different production and observation paths:

- complexity may require a review procedure or static-analysis artifact;
- latency requires a benchmark created or selected by a worker and executed in an identified environment;
- pass status requires a concrete test or oracle execution with raw output.

Provenance tells us what observation a record refers to. It does not make the observation true.

## 4. The missing productive model

The pipeline must model two directions explicitly.

### 4.1 Controller to worker

When the controller detects a need, it must create an executable assignment:

```text
need or deficit
-> WorkIntent
-> worker role
-> Skill
-> input artifacts
-> allowed tools and scopes
-> expected output
-> completion and failure contract
```

A controller decision such as `repair`, `diagnose`, `verify`, `replan`, `create oracle`, or `rebuild environment` is incomplete until it becomes such a worker assignment.

### 4.2 Worker to controller

When the worker finishes, its output must have a defined ingestion path:

```text
worker artifact, patch, claim, script, or raw result
-> parser and durable receipt
-> controller-side context resolution
-> authorization checks
-> runtime observation where required
-> attestation
-> authoritative state transition
```

Without the first bridge, nothing is created.

Without the second bridge, created work cannot affect the system.

## 5. General failure pattern across all stages

The provenance incident is one instance of a wider class of failures.

### Discovery

A controller may require facts, hypotheses, or scope clarification, but an analyst worker must actually investigate and write them. If no Skill defines the research task and available tools, `DiscoveryRequired` is only a label.

### Requirements

A policy may demand stable obligations and acceptance criteria, but a product or analyst worker must create the text and trace links. A schema cannot author a requirement.

### Architecture

The controller may detect an architectural deficit, but an architect worker must produce the decision, interfaces, invariants, and compatibility analysis. An incident state cannot create an ADR.

### Planning

A dependency graph does not appear because a gate requires one. A planner worker must create the decomposition, scopes, integration order, and verification tasks through an explicit Skill.

### Development

The controller can authorize a code change, but only a worker writes the patch and tests. WorkIntent without an executable developer assignment is inert.

### Verification

A condition may require evidence, but a verifier worker must create or select the check. A runtime must execute it. The control plane must attest the result.

### Recovery

`R4 Diagnose`, `R5 Diversify`, `R6 Replan`, and `R7 Roll back and repair` are not self-executing states. Each needs a worker task, Skill, tools, expected artifact, and ingestion path.

### Integration

A deterministic integration executor can apply a prepared candidate, but workers may still be required to resolve semantic conflicts, update migrations, or repair failed post-merge verification.

### Release and operations

Policies can authorize release and compensation, but executable release procedures, adapters, manifests, rollback scripts, and diagnostics must first be created by workers when they do not already exist.

### Outcome certification

The certificate may be generated deterministically from state, but any explanatory analysis, missing diagnosis, or remediation recommendation is still semantic work and requires an assigned producer.

## 6. Why removing the human path caused deadlocks

The migration treated autonomy partly as deletion:

```text
remove needs-human
remove waiting_human
reject worker_ask_need
remove operator intervention
```

But the human had often been performing productive work:

- supplying missing context;
- deciding what artifact was needed;
- writing a fix;
- entering evidence;
- selecting a test;
- interpreting an ambiguous result;
- repairing a broken task contract;
- reconnecting two stages of the pipeline.

Removing the state did not remove the need for that work.

A human fallback is eliminated only when every productive act previously performed by the human has a replacement:

```text
worker role
+ Skill
+ task materialization rule
+ tools
+ authoritative ingestion
+ recovery path
```

Otherwise the pipeline becomes stricter but less capable.

## 7. Corrected design principle

The corrected operational law is:

> The LM worker creates semantic work. The controller decides what work is admissible, turns every unmet need into an executable worker assignment, supplies authoritative context, authorizes effects, observes results, and reconciles state. Evidence settles claims only after a real production and observation path has run.

Expanded flow:

```text
mandate or deficit
-> deterministic selection
-> executable worker assignment through a Skill
-> worker creates artifact or observation procedure
-> authorized execution
-> raw observation
-> controller-side provenance and trust binding
-> validation
-> condition update
-> next assignment or truthful termination
```

## 8. Required engineering artifacts

### 8.1 Production Reachability Matrix

For every required transition, record:

```text
required output
trigger
creating worker role
Skill
WorkIntent kind
inputs
required tools
owned scopes
expected artifact
return tool or port
authoritative enrichment
verification path
failure class
recovery assignment
terminal outcome if unreachable
```

A row without a worker, Skill, or ingestion path is an architectural defect.

### 8.2 Skill Capability Registry

The scheduler must know not only model capability but productive capability:

```text
which artifact kinds a Skill can create
which tools it can use
which scopes it may change
which raw observations it can produce
which failures it can diagnose
which handoff schemas it supports
```

### 8.3 Worker Assignment Contract

Every non-trivial WorkIntent must resolve to:

```text
objective
why it exists
inputs
source baseline
owned and prohibited files or resources
allowed tools and effects
expected output
acceptance criteria
completion payload
failure payload
budget
lease
handoff target
```

### 8.4 Output Ingestion Contract

Every worker-produced artifact type must define:

```text
parser
identity
storage boundary
controller-enriched fields
validation authority
verification authority
invalidation rule
consumers
recovery path
```

## 9. Required changes to simulation

A deterministic simulator must not begin with artifacts magically present in the database.

Every scenario must exercise actual productive transitions:

1. controller detects a deficit;
2. controller materializes a WorkIntent;
3. scheduler selects a worker Skill;
4. scripted worker creates an artifact or procedure;
5. output crosses the real parser and ingestion boundary;
6. controller supplies authoritative context;
7. runtime or oracle observes where required;
8. condition changes or a typed incident is created.

Required negative scenarios include:

- no Skill can create the required artifact;
- Skill exists but required input is absent;
- worker has no tool capable of the requested operation;
- worker creates an artifact but no ingestion handler exists;
- handler requires authoritative fields from the worker;
- controller attaches provenance to an unsupported claim;
- recovery selects a rung but creates no worker assignment;
- human path is removed without a productive replacement;
- repeated worker retries occur although the task contract itself is impossible.

## 10. Correct classification of the provenance incident

The first rejection should have produced a typed control-plane incident such as:

```text
PRODUCTION_INGESTION_CONTRACT_MISMATCH
```

or more specifically:

```text
VERIFICATION_ATTESTATION_PATH_MISSING
```

It should not have been treated as a worker reasoning failure or a transient verification failure.

Correct recovery sequence:

1. stop identical worker retries;
2. identify which fields are worker-produced and which are controller-produced;
3. create an infrastructure remediation WorkIntent for the missing bridge;
4. assign it to a capable implementation worker through a Skill;
5. add the runtime observer or context resolver;
6. rerun verification through the corrected path;
7. terminate truthfully if no permitted production path can be built within budget.

## 11. What the long refactoring journey actually taught

The refactoring was not wasted. It identified the control structures needed for autonomy. But the practical lesson is sharper than the theoretical plan:

- autonomy is not the absence of a human state;
- orchestration is not production;
- validation is not creation;
- a policy is not an executable task;
- a recovery rung is not a repair;
- an oracle declaration is not a test;
- provenance is not evidence production;
- a required database field is not a source for that field;
- a controller decision has no physical effect until a worker or adapter executes an authorized assignment;
- a worker cannot complete work that its Skill and tool surface make unreachable.

The main problem of pipeline automation is therefore not only control correctness. It is the construction of a complete causal chain from need to worker production and from worker output back to authoritative state.

## 12. Final statement

The honest assessment is:

> Saga was designed as though stronger control structures would cause the missing work to appear. In reality, every new artifact, diagnosis, test, repair, and procedure must be created by an LLM worker that receives a concrete task through a Skill. The controller's central duty is not to create those things itself, but to make every required act of creation reachable, authorized, and ingestible.

This principle must govern every further stage of Saga 3.0 refactoring and every future analysis of pipeline automation problems and solutions.
