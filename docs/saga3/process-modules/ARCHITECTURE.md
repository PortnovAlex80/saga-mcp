# Saga 3 Process Module Architecture

## Status

This document defines the implemented Process Module separation.

The branch provides:

- a generic Process Module contract;
- deterministic module validation;
- a versioned module registry;
- Stage Binding and Lifecycle routing contracts;
- one generic Flow Runtime for LM, Kernel, Human and External nodes;
- Product Discovery represented as `product-discovery@3.0.0`;
- Solution Formalization represented as `solution-formalization@1.0.0`;
- Solution Development represented as `solution-development@1.0.0`;
- Delivery/Release represented as `delivery-release@1.0.0`;
- the complete durable Product Delivery Lifecycle;
- execution-scoped workspaces, trackers, templates and hook reminders;
- durable ProcessRun, NodeRun, LifecycleRun, StageRun and transition records;
- explicit Delivery providers, effect ledger and human approval inbox;
- static and behavioral architecture tests.

The legacy `saga3-discovery` mode remains available behind its feature flag.
`saga3-discovery-generic` and `saga3-lifecycle` execute Discovery as data through
the generic Runtime; the complete Lifecycle does not route through the legacy
Discovery or Formalization engines.

---

## 1. Core separation

> **Process Module defines the content of work. Runtime defines the physics of execution.**

A Process Module answers:

- What domain goal is being pursued?
- What typed input is accepted?
- What typed result or certificate is produced?
- Which local outcomes exist?
- Which artifacts, policies and invariants define correctness?
- Which Flow and LM execution profiles implement the process?

The Runtime answers:

- How is a WorkIntent created and persisted?
- How is work projected to a task?
- How is a worker bound, spawned and fenced?
- How are skill, tracker and templates delivered?
- How are MCP capabilities enforced?
- How are retries, pause/resume and restart handled?
- How are artifacts, validation results and lineage persisted?
- How is the Flow advanced after a node result?

The Lifecycle answers:

- Where is a module mounted?
- How is Lifecycle state mapped into module input?
- Where does each local module outcome route next?
- When is the whole Lifecycle complete?

---

## 2. Main abstractions

```text
LifecycleDefinition
    contains StageBindings

StageBinding
    references ProcessModuleDefinition
    maps input/output
    routes local outcomes

ProcessModuleDefinition
    defines contracts, outcomes, Flow
    defines artifacts, policies, invariants
    defines LM execution profiles

FlowDefinition
    contains LM / Kernel / Human / External / Composite nodes

LM Node Run
    creates WorkIntent
    projects Task
    launches Execution Attempt
    uses tracker + skill + materialized MCP calls

Kernel Node
    validates, settles, certifies or routes deterministically
```

Canonical responsibility split:

```text
Process Module:
    content and local truth

Universal Runtime:
    execution physics

Lifecycle Engine:
    composition and inter-module routing

Stage Binding:
    adapter between a module and one lifecycle position
```

---

## 3. Process Module contract

Implemented in:

- `src/process-modules/domain/process-module.ts`
- `src/process-modules/application/validate-process-module.ts`
- `src/process-modules/application/process-module-registry.ts`

A module is a versioned declarative package:

```ts
interface ProcessModuleDefinition {
  identity: ProcessModuleIdentity;
  inputContract: SchemaReference;
  outputContract: SchemaReference;
  outcomes: OutcomeDefinition[];
  flow: FlowDefinition;
  artifacts: ArtifactTypeDefinition[];
  policies: PolicyDefinition[];
  invariants: InvariantDefinition[];
  executionProfiles: ExecutionProfileDefinition[];
}
```

The definition does not execute itself and does not choose a downstream process.

The validator rejects, among other errors:

- duplicate module elements;
- invalid identity/version;
- missing entry or terminal nodes;
- missing transition endpoints;
- outgoing transitions from terminal nodes;
- unreachable nodes;
- undeclared terminal outcomes;
- LM nodes without execution profiles;
- incomplete execution profiles.

The registry accepts only valid versioned definitions.

---

## 4. Flow node kinds

### LM node

Used for irreducibly semantic work. It references one execution profile.
The LM produces a proposal, assessment, implementation or explanation. It does
not silently acquire authority merely because it wrote an output.

### Kernel node

Used for deterministic parsing, validation, hashing, policy evaluation,
settlement, certificate issuance and outcome emission.

### Human node

Used when an explicitly authorized human decision or information response is
part of the process contract.

### External node

Used to call an external system through an adapter.

### Composite node

Used to invoke another Process Module while preserving a local subflow boundary.

---

## 5. LM Execution Profile

An execution profile connects module content to Runtime physics:

```text
workIntentKind
workIntentSchema
    ↓
taskKind
executionSkill
allowedTools
    ↓
trackerTemplate
workspaceTemplates
callTemplates
checklists
    ↓
outputSchema
retryPolicy
recoveryPolicy
```

The Process Module supplies these declarations. The Runtime materializes and
enforces them.

Every LM node must become a bounded LM Execution Cell:

```text
WorkIntent
+ execution identity
+ frozen authority
+ inline skill
+ external tracker
+ isolated workspace
+ materialized MCP calls
+ checklist
+ typed output
+ validation ladder
+ durable recovery
```

---

## 6. Machine-filled binding

The kernel must fill values already known to the system:

- Process Run and Lifecycle Run ids;
- Stage Binding and Node Run ids;
- WorkIntent, task, execution and worker ids;
- project, epic and repository ids;
- schema versions;
- immutable artifact ids and hashes;
- authority scope and allowed tools;
- source snapshot refs and policy versions.

> **Machine-known data must be machine-filled. LLM produces only irreducibly semantic data.**

This is not a convenience rule. It prevents provenance gaps, wrong ids,
invalid MCP payloads and recovery deadlocks observed in real weak-model runs.

---

## 7. Hooks and external memory

The tracker is an external execution frame, not a human note.

It contains:

- machine binding;
- current program step;
- completed steps;
- attempt and budget;
- artifacts and trace refs;
- materialized MCP calls;
- errors and resume checkpoint.

Required hook points:

1. startup — inject identity, hard rules and full skill;
2. before action — re-read tracker;
3. after step — update tracker;
4. before MCP submit — re-read tracker and checklist;
5. after error — record error and resume step;
6. after restart — reuse tracker, WorkIntent and accepted output.

The prompt tells the model to obey. The Runtime gateway enforces capability and
execution identity. Both layers are required.

---

## 8. Materialized MCP calls

Consequential MCP writes are materialized as JSON files before invocation:

```text
semantic reasoning
    ↓
artifact/document
    ↓
execution-scoped call JSON
    ↓
pre-submit checklist
    ↓
schema + provenance + authority validation
    ↓
MCP invocation
```

The kernel fills binding and immutable values. The LM fills semantic payload.
The file is read back before the call. `FILL_` placeholders are forbidden at submit.

Formalization templates introduced by this branch:

- `artifact-create-call-template.json`;
- `trace-add-call-template.json`;
- `worker-done-call-template.json`;
- `formalization-node-checklist.md`;
- `process-module-stage-tracker.md`.

---

## 9. Stage Binding and Lifecycle

Implemented in:

- `src/process-modules/domain/lifecycle.ts`
- `src/process-modules/application/lifecycle-router.ts`
- `src/process-modules/lifecycles/product-delivery-lifecycle.ts`

A module emits only a local outcome:

```json
{
  "outcome": "go",
  "certificate_ref": "certificate:481"
}
```

A Stage Binding decides the route:

```text
Discovery go              → Formalization
Discovery clarify/reject  → terminal
Formalization formalized  → Development
Development verified      → Delivery/Release
Delivery released         → terminal released
```

The same module may be mounted in another lifecycle or another stage with a
different input mapping, policy configuration and outcome routing.

---

## 10. Discovery migration

Definition:

- `src/process-modules/modules/discovery/discovery-process-module.ts`

Identity:

```text
product-discovery@3.0.0
```

Flow represented by the module:

```text
Produce Proposal [LM]
    ↓
Deterministic Normalization [Kernel]
    ├── accepted ───────────────┐
    └── semantic ambiguity      │
            ↓                   │
       Semantic Normalizer [LM] │
            └───────────────────┘
                    ↓
          Readiness Advisor [LM]
                    ↓
          Settlement Policy [Kernel]
                    ↓
          Outcome Certificate
                    ↓
          Diagnosis Advisor [LM]
                    ↓
          Local process outcome
```

In the complete Lifecycle, Discovery runs through `GenericFlowExecutor`.
Preparatory and resolver kernel nodes create and recover exact durable lineage;
LM nodes receive execution-scoped trackers/templates and return execution
receipts; settlement re-reads canonical products by their exact bindings.

---

## 11. Formalization module

Definition:

- `src/process-modules/modules/formalization/formalization-process-module.ts`

Identity:

```text
solution-formalization@1.0.0
```

Flow:

```text
Product Contract [saga-product]
    ↓
Use Cases [saga-analyst]
    ↓
Acceptance Contract [saga-analyst]
    ↓
WHAT Reconciliation [saga-reconciler]
    ↓
Acceptance Baseline Freeze [Kernel]
    ↓
Architecture Contract [saga-architect]
    ↓
Formalization Settlement [Kernel]
    ↓
Solution Contract Certificate
```

The module formalizes the already-existing reordered rule:

> WHAT is reconciled and the acceptance baseline is frozen before HOW/SRS.

The module contract, Flow, execution profiles, workspace assets, artifact graph,
managed production ledger, baseline freeze, deterministic settlement and
content-addressed Solution Contract persistence are implemented and registered
in the complete Lifecycle.

---

## 12. Development and Delivery modules

Development absorbs planning, implementation/review, integration/freeze and
candidate-bound verification into one locally-settled module. The standard
SQLite runtime projects the kernel-authorized task graph to exact tasks and
dependencies, runs only that task scope, freezes Git/build observations and
admits a verified bundle only for the unchanged candidate.

Delivery models external effects explicitly:

- deterministic preflight evidence;
- candidate/preflight/policy-bound approval;
- desired-state actions with cross-run idempotency keys;
- observe-before-retry and post-action authoritative observation;
- deterministic settlement and Release Record.

The mechanics, ledger and approval inbox are standard. Actual external
preflight/publication/observation providers are composition inputs and are never
fabricated by the Runtime.

---

## 13. Automated architecture enforcement

Tests introduced under `tests/process-modules/` verify:

- all four built-in modules validate;
- every LM node has tracker, call templates, checklist and recovery;
- every terminal outcome is emitted;
- registry contains versioned Discovery, Formalization, Development and Delivery;
- the complete Lifecycle freezes every cross-module handoff;
- unknown outcomes fail closed;
- Runtime core does not import module semantics;
- Discovery and Formalization do not import/start each other;
- every referenced asset exists;
- reusable checklist and designer skill contain the required controls.

The tests convert the architecture from guidance into an executable rule.

---

## 14. Adding the next Process Module

Use:

- skill: `saga-process-module-designer`;
- checklist: `PROCESS-MODULE-CHECKLIST.md`;
- contracts: `src/process-modules/domain/process-module.ts`;
- validator: `validateProcessModuleDefinition`;
- Discovery and Formalization definitions as reference implementations.

The minimum delivery set is:

1. versioned definition;
2. input/output schemas and outcomes;
3. valid Flow;
4. artifact/policy/invariant bundle;
5. execution profile for every LM node;
6. tracker, skills, call templates and checklists;
7. Stage Binding example;
8. boundary, validation and routing tests;
9. execution adapter or generic node handlers;
10. real LM smoke evidence.

---

## 15. Extensible architecture

```text
Universal Runtime
    ├── Product Discovery module
    ├── Solution Formalization module
    ├── Development module
    ├── Verification module
    ├── Integration module
    ├── Release module
    └── Observation module

Lifecycle Engine
    ├── Product Delivery lifecycle
    ├── Incident Response lifecycle
    ├── Research lifecycle
    └── Compliance lifecycle
```

The Runtime does not grow a new hard-coded engine method for every process.
New capabilities arrive as validated Process Module packages and Stage Bindings.
