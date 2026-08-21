# New Workshop Design and Authoring Guide

- Status: execution guide / architecture contract
- Date: 2026-08-21
- Applies to: new built-in Saga Process Modules and future admitted workshops
- Governing decisions: ADR-053, ADR-082, ADR-083, ADR-084, ADR-085
- Companion guides:
  - `docs/testing/WORKSHOP-CONFORMANCE-PACK-AUTHORING-GUIDE.md`
  - `docs/testing/WORKSHOP-CONFORMANCE-COVERAGE-AGENT-GUIDE.md`
  - `docs/architecture/PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE.md`

## 1. Purpose

This guide defines how to design and add a new Saga workshop without creating a product-specific mini-runtime inside the Factory.

The target is not “a folder that passes the module validator”. The target is a workshop that is:

- understandable from one ownership boundary;
- expressed almost entirely as declarative blueprint;
- executed by the same universal Factory physics as every other workshop;
- explicit about the few things it owns: products, roles, checks, effects, human/external ports, and local outcomes;
- independently testable through the shared conformance kernel;
- impossible to execute through an undeclared side path.

The key rule is:

> A workshop owns the blueprint. The Factory owns the physics.

A workshop may describe WHAT work exists, WHAT products are acceptable, WHO may produce/review them, WHAT external capability is needed, and WHICH local outcome is emitted.

A workshop must not implement its own dispatcher, queue, worker lifecycle, Gate engine, retry engine, accepted-material authority, lifecycle router, or persistence state machine.

## 2. What a workshop is

A Process Module is a versioned local production graph inside a larger Lifecycle.

Conceptually:

```text
Upstream immutable handoff
        |
        v
ProcessModuleDefinition
        |
        +--> Production Cell(s)
        |      author/reviewer cognition
        |      Gate(s)
        |      repair/recovery
        |      optional accepted-material effect
        |
        +--> Kernel node(s)
        |      deterministic policy / transformation / settlement
        |
        +--> Human node(s)
        |      typed authorized decision
        |
        +--> Composite node(s), when truly needed
        |
        v
local Process outcome + exact product/certificate
        |
        v
Lifecycle owns the next route
```

A workshop is NOT synonymous with an LLM pipeline.

The current built-ins already prove four different execution styles:

- Discovery: simple cognitive Production Cells plus deterministic settlement;
- Formalization: reviewed cognitive Cells plus deterministic freeze/settlement;
- Development: planner + fan-out/fan-in + review + Git effect + verification + continuations;
- Delivery: kernel + human + external providers + authoritative observation, with no LM execution profile at all.

Therefore a new workshop must be designed around production mechanisms, not around “agents”.

## 3. First decision: do you actually need a new workshop?

Before creating a Process Module, classify the requested change.

### 3.1 Add a new Production Cell to an existing workshop when

- the new work belongs to the same local input/output contract;
- it contributes to the same settlement authority;
- it is another station in the same bounded product transformation;
- downstream Lifecycle routing does not need a new stable local outcome boundary.

Example:

```text
Formalization
  existing WHAT cells
  + new deterministic compliance Cell
  -> same Solution Contract settlement
```

This is probably not a new workshop.

### 3.2 Add a workshop variant when

- the semantic process is the same family;
- it reuses most topology/contracts;
- the difference is a controlled mode such as continuation, verification-only suffix, or re-plan cycle;
- it should still be understandable as the same bounded context.

Do not implement variants by copy/pasting the whole module and editing arrays blindly. Compose them from stable family fragments; see the refactoring guide.

### 3.3 Add a new workshop when

At least one of these is true:

- there is a new durable input contract and a new durable output contract;
- there is a new local settlement authority;
- there is a new Lifecycle decision boundary;
- a different owner/bounded context controls its product semantics;
- external effects/human authority form a materially different local process;
- its conformance universe cannot be expressed as an extension of an existing workshop without workshop-name branching.

### 3.4 Do NOT add a new workshop merely because

- a new LLM role is needed;
- another prompt/skill is needed;
- a new check is needed;
- a new external provider is needed;
- a flow became long;
- a file became large.

Those may justify a new Cell, profile, capability, or source-file decomposition, not a new Process Module.

## 4. Allowed node kinds for new design

For new work, prefer the current universal vocabulary.

### 4.1 `production-cell`

Use when nondeterministic authored material is produced by a model or other worker-like cognition source.

The Cell owns a bounded control loop:

```text
WorkIntent
  -> fenced WorkerExecution
  -> typed product submission
  -> WorkplaceProductionRevision
  -> CandidateSet
  -> author Gate
  -> optional reviewer
  -> final Gate
  -> repair / human / fail / accepted
  -> optional post-acceptance effect
```

Do not model author, reviewer and repair as separate Flow nodes. They are internal roles of one Production Cell.

### 4.2 `kernel`

Use for deterministic work:

- canonicalization;
- freeze/seal;
- deterministic policy;
- exact aggregation;
- settlement;
- certificate issuance;
- provider-mediated external action/observation where the provider is an injected port.

A kernel node may call an injected external port. It must not hire a worker.

### 4.3 `human`

Use for a durable typed human decision.

The human adapter is the replaceable source of nondeterminism. The node’s transition and persistence authority still belong to the Factory.

### 4.4 `composite`

Use only when a true sub-process deserves independent Process Module identity and versioning.

Do not use composite nodes to hide an oversized function or evade a clear Production Cell/kernel decomposition.

### 4.5 Legacy `lm` node

`FlowNodeKind` still contains the historical `lm` shape, but new built-in work should not create direct LM nodes when the work is production-cell semantics.

The Production Cell is the canonical unit for LM production because it includes material authority, Gate, review and repair in one reusable mechanism.

Treat a new direct `lm` node as an architecture exception requiring explicit justification.

### 4.6 No `external` node

There is intentionally no `external` Flow node kind.

External actions are explicit injected ports called by deterministic kernel/effect code. This prevents an opaque adapter from becoming a hidden worker/execution engine.

If tooling or documentation still offers an `external-node` scaffold, treat that as legacy drift, not as permission to reintroduce the node kind.

## 5. Target ownership layout

ADR-085 defines the intended ownership boundary. New workshop design should target it even while the repository is still in the pre-cutover layout.

```text
src/modules/<workshop>/
  WORKSHOP.md
  index.ts
  manifest.ts
  definition.ts
  runtime-bindings.ts

  domain/
    schemas.ts
    policies.ts
    pure-model.ts
    ...

  application/
    check-providers.ts
    kernel-handlers.ts
    effects.ts
    output-resolver.ts
    ...

  ports/
    external-provider.ts
    repository-port.ts
    ...

  package/
    protocols/
    capabilities/
    resources/
      skills/
      templates/
      checklists/
      schemas/

  conformance/
    fixtures.ts
    scenarios.ts
    obligations.ts   # if/when obligations become module-owned inputs to the independent registry
```

Concrete host adapters belong outside:

```text
src/infrastructure/process-modules/<workshop>/
```

Examples:

- SQLite repository implementation;
- filesystem adapter;
- Git adapter;
- cloud/provider client.

The workshop owns the port and semantics. Infrastructure owns the substrate.

## 6. Public surface

A future built-in workshop should expose one public TypeScript surface through `index.ts`.

Target shape:

```ts
export interface BuiltInWorkshop {
  readonly manifest: ProcessModuleManifest;
  readonly definition: ProcessModuleDefinition;
  createBindings(context: WorkshopBindingContext): WorkshopRuntimeBindings;
}
```

The exact interface may evolve under accepted ADRs, but the architectural property must remain:

```text
one workshop
  -> one public descriptor
  -> one declaration-to-binding closure
  -> one closed built-in catalog entry
```

Do not require external callers to import:

- internal validator files;
- resource paths;
- profile builders;
- package-private schemas;
- registration functions.

## 7. Design the workshop from the outside inward

Do not start with prompts or worker profiles.

Use this order.

### Step 1 — define the input authority

Write down:

- schema ID;
- source workshop/lifecycle stage;
- exact refs/hashes required;
- cardinality;
- which fields are authored data versus Factory-derived identity;
- what makes the input stale or foreign;
- what must fail closed.

Example:

```text
Formalization input
  discoveryCertificateRef/hash
  discoveryOutcome
  discoveryProposalRef/hash/payload
  initiativeSubject
```

The input contract must be content-addressable wherever later correctness depends on identity.

Never make “latest artifact for epic” the semantic input.

### Step 2 — define the output authority

Specify:

- output schema;
- exact product/certificate identity;
- who may issue it;
- downstream consumer;
- which accepted upstream refs/hashes it freezes;
- replay/idempotency identity.

A workshop output should answer:

> What exact immutable fact has become true that was not true before this workshop ran?

If that answer is unclear, the workshop boundary is unclear.

### Step 3 — define local outcomes

Outcomes are local facts, not lifecycle routes.

Example:

```text
Formalization:
  formalized
  inconsistent
  failed

Development:
  verified
  blocked
  failed

Delivery:
  released
  approval-required
  blocked
  failed
```

The Process Module emits a local outcome.

The Lifecycle decides what that outcome means globally.

Never let a module decide “go to Development” or “stop product lifecycle” directly.

### Step 4 — draw the control graph before implementing nodes

Create a table:

| Node | Kind | Input | Output | Authority | Success event | Other events |
|---|---|---|---|---|---|---|

Then draw every transition.

Every node must have an answer for:

- what starts it;
- what durable material it consumes;
- what durable fact it creates;
- who owns acceptance;
- what happens on malformed output;
- what happens on an infrastructure failure;
- whether a human-required outcome is possible;
- what happens after restart.

A node with an unclear durable before/after boundary is probably not a real node.

## 8. Production Cell design

### 8.1 Start with `singletonProductionCell` only for true singleton work

The helper exists for one logical work item.

Review its defaults rather than accepting them blindly.

A new design must explicitly consider:

- output cardinality;
- review/no-review;
- recovery policy;
- total attempt policy;
- human-required transition;
- post-acceptance effect.

Do not rely on a helper default when the value is semantically important.

### 8.2 Use explicit `ProductionCellDefinition` for fan-out

When work is derived from a collection, declare:

```text
inputSelectors
sourceBinding
workKeySelector
dependencySelector
completionPolicy
quorum if applicable
taskProvenance
```

The `workKey` is a durable semantic coordinate. It must be deterministic from the input item and stable across attempts/restarts.

Do not use generated DB IDs as `workKey` semantics.

### 8.3 Author profile

Declare:

- skillRef;
- capability preset;
- typed output schema;
- allowed tools;
- execution mode;
- protocol skill;
- semantic skill;
- payload contract if untrusted product bytes cross the boundary.

The worker owns authored semantic content.

The worker does not own:

- content hashes the Factory can derive;
- accepted state;
- Gate verdict;
- CandidateSet identity;
- lifecycle route;
- integration/publish authority unless the architecture explicitly gives a bounded effect port, which normally belongs to Factory effects.

### 8.4 Author Gate

Every material protection belongs in a declared CheckPlan.

Classify each check:

```text
shape
lineage
scope
authority binding
derived evidence
cross-field relation
external deterministic observation
semantic adjudication
```

A Gate must inspect an exact CandidateSet subject.

Do not re-query “latest product” inside a CheckProvider when the CandidateSet already gives exact authority.

### 8.5 Review

Use a reviewer only when independent semantic or policy judgment adds value.

Reviewer contract:

```text
exact accepted author CandidateSet
        -> reviewer WorkIntent
        -> immutable review verdict product
        -> final Gate
```

The reviewer must not silently re-author the author’s product.

A review verdict should bind exact subject identity.

### 8.6 Recovery

Recovery must remain on the same Workplace for repair of the same logical work.

A new WorkerExecution is a new attempt, not a new logical job.

Define:

- max attempts per epoch;
- total attempt/circuit breaker where applicable;
- fail/pause/requeue semantics;
- repair role;
- what exact feedback is delivered;
- whether accepted prefix can be reused.

Do not write a workshop-specific retry loop.

### 8.7 Post-acceptance effects

Use an effect only after accepted material exists.

Effects consume `AcceptedCandidateAuthority` or an equivalent exact accepted-material coordinate.

Good examples:

- formalization accepted-artifact projection;
- Git integration;
- replay capsule capture.

Effects must be:

- idempotent or safely observable before retry;
- receipt-producing;
- crash-recoverable;
- bound to the exact accepted CandidateSet/product revision.

Do not let an LM worker directly perform a side effect merely because it has shell access.

## 9. Kernel node design

A kernel node is deterministic business/process policy.

A kernel handler should normally be a thin application function over injected ports.

It may:

- validate exact input identity;
- compute canonical representation;
- freeze immutable snapshots;
- aggregate accepted products;
- issue certificates;
- call deterministic external ports;
- settle a local outcome.

It should not:

- call `worker_next`;
- contain module-name switches;
- reconstruct accepted material by recency;
- duplicate a Production Cell Gate;
- carry hidden fallback semantics.

For every kernel node, define:

```text
input product identity
pure decision/transformation
persistence owner
output product identity
possible events
idempotency key
restart behavior
```

## 10. Human node design

A human node should contain no hidden product semantics.

It declares:

```text
interaction contract
input schema
output schema
possible domain events
```

The adapter may be replaced in tests.

The human decision must bind the exact subject it authorizes.

For externally visible effects, bind at least:

- candidate hash;
- policy hash;
- relevant preflight/decision hash.

A human approval must not float to a later candidate revision.

## 11. External-system design

There is no generic “external node”.

Use ports.

Example:

```ts
interface PublicationPort {
  publish(input: ExactAuthorizedRelease): Promise<PublicationResult>;
}

interface ObservationPort {
  observe(input: ExactPublication): Promise<ObservedState>;
}
```

The workshop defines the port contract.

The composition root supplies the implementation.

Tests supply deterministic provider fixtures.

The Factory/kernel still owns:

- action key;
- receipt persistence;
- retry policy;
- observation-before-redrive rule;
- settlement.

## 12. Contracts and schemas

### 12.1 Every untrusted payload gets a runtime decoder

A TypeScript interface is not a runtime contract.

If a worker, human adapter, provider, file, or external system can supply bytes, define a runtime decoder/validator.

### 12.2 Pin consumer read surface

The payload contract should protect the fields downstream consumers actually rely on.

Avoid two bad extremes:

- no runtime contract at all;
- over-freezing every optional producer field and making harmless extensions impossible.

### 12.3 Version semantics, not filenames

Bump a contract version when the protected read semantics change.

Keep schema ID, contract ID, version and digest distinct.

### 12.4 Derived identity belongs to the observer

If the Factory can derive a digest from authoritative bytes, the worker should not be the authority for that digest.

General rule from ADR-084:

```text
derivedEvidence = F(authoritativeSource)
owner(derivedEvidence) = component that authoritatively observes authoritativeSource
```

## 13. Execution profile design

Execution profiles are physical/semantic worker configuration, not process state machines.

A profile should answer:

- what role is this worker;
- what tools may it use;
- what execution mode applies;
- what workspace resources are visible;
- what output schema is required;
- what protocol/semantic skills apply.

Do not embed orchestration policy in skill text.

### 13.1 Tool principle

Grant the minimum capability set.

For document production, prefer structured artifact/trace/product tools over a general shell.

For code production, shell/Git access must still respect Factory-owned integration authority.

### 13.2 Retry/recovery naming caution

Today the code contains both profile-level retry/recovery settings and Production Cell recovery settings.

Treat them as different layers only when the distinction is explicit:

- physical execution/profile retry policy;
- logical Production Cell recovery policy.

Do not create contradictory budgets.

If a new workshop requires an agent to guess which policy wins, stop and resolve the architecture before adding the workshop.

## 14. Invariants

Write invariants as architectural claims, not comments.

Good invariants:

```text
all cognitive products are accepted only by durable GateDecision
baseline freezes before architecture work starts
candidate freezes before verification
verification evidence pins exact candidate hash
release requires authoritative observed state
module emits local outcome only; lifecycle owns routing
```

Classify enforcement honestly:

```text
static
runtime
policy
test
```

If enforcement is `test`, the conformance pack must contain the corresponding obligation/coverage item.

## 15. Package resources

Workshop-owned resources belong under its package root and are hash-pinned.

Examples:

- role skills;
- trackers;
- call templates;
- checklists;
- schema files;
- protocol resources.

Rules:

- package-relative paths only;
- no escaping package root;
- every referenced byte appears in resource digest closure;
- editing a resource changes package digest;
- platform-owned shared resources are dependencies, not copied private forks.

## 16. Capability declaration and binding

The current code still has a factory-wide capability manifest and process-global registrations. ADR-085 targets co-located workshop binding declarations.

For new design, think in this target form:

```text
Workshop descriptor
  declares
    payload contracts
    check providers
    effects
    handlers
    human adapters
    tools
  + exact logical ID/version/digest

createBindings(context)
  resolves executable implementations

installation closure
  requires declaration set == binding set
```

A declared capability without a binding is invalid.

An extra binding without a declaration is invalid.

A version/digest mismatch is invalid.

Do not add another global hand-list.

## 17. Lifecycle connection

A workshop is not fully connected until the Lifecycle maps it.

The Lifecycle owns:

- stage identity;
- moduleRef;
- input mapping;
- output mapping;
- outcome routes;
- entry/exit conditions.

The handoff should use exact product/certificate refs and hashes.

Do not pass only opaque prose when downstream correctness depends on immutable identity.

For every route, test:

```text
upstream mapped_output_snapshot
        ==
transition handoff
        ==
downstream input_snapshot
```

at the authority-bearing fields.

## 18. Closed admission before C12

Creating a package is not the same as admitting executable code.

Before C12, adding a built-in remains deliberate.

The new workshop must update the accepted admission surfaces defined by ADR-082/ADR-085, including the closed built-in composition set and associated capability/payload/lifecycle projections.

Do not turn directory discovery or installed package manifests into implicit executable admission.

A test package that validates structurally is not automatically part of the production Factory.

## 19. Conformance is part of workshop authoring, not a later QA task

Before a new built-in is considered complete, create its conformance pack using the shared kernel.

The pack must define a finite workshop coverage universe covering applicable families:

```text
local obligations
gate outcomes
positive transitions
negative transitions
exact bindings
review subject binding
fan-out/fan-in
effects
recovery
feedback counterfactuals
stale fence
duplicate/late tool calls
restart/idempotency
kernel outcomes
inter-workshop handoff
```

Only PASS `ScenarioEvidenceBundle`s contribute demonstrated coverage.

A workshop with green happy-path E2E but no explicit negative/recovery universe is not closed.

## 20. Mutation requirement

Every P0 deterministic obligation should have a mutant family.

Examples:

```text
ref       -> missing / stale / foreign
digestOf  -> wrong digest
subset    -> out-of-scope member
unique    -> duplicate
cardinality -> zero / extra
grammar   -> near-miss word
projection -> missing field
lineage   -> broken edge
ordering  -> illegal sequence
version   -> incompatible version
crossField -> individually valid but inconsistent pair
```

A new check provider should not be accepted merely because one handwritten example passes.

The assigned mutation family must be killed.

## 21. Required `WORKSHOP.md`

The workshop entrypoint should contain or generate:

1. purpose and non-goals;
2. module identity/version;
3. input/output contracts;
4. local outcomes;
5. flow diagram;
6. every Production Cell and workKey rule;
7. author/reviewer profiles;
8. CheckPlans;
9. recovery policies;
10. effects;
11. kernel handlers;
12. human/external ports;
13. artifacts/resources;
14. capability declaration/binding inventory;
15. lifecycle routes;
16. conformance universe and commands;
17. variants/continuations;
18. known platform-owned fault edges.

An agent should be able to understand the workshop without global repository archaeology.

## 22. Architecture review checklist before implementation

### Boundary

- [ ] Input and output immutable authority is explicit.
- [ ] Local settlement responsibility is coherent.
- [ ] The module does not own lifecycle routing.
- [ ] No direct cross-workshop implementation dependency exists.

### Flow

- [ ] Every node has a durable before/after meaning.
- [ ] Every transition has a typed event.
- [ ] Every terminal node emits exactly one declared local outcome.
- [ ] Every failure/human path is explicit.

### Production Cells

- [ ] All worker-authored material goes through Production Cell authority.
- [ ] Author product has runtime payload contract where needed.
- [ ] CandidateSet is the exact Gate subject.
- [ ] Review binds exact author CandidateSet.
- [ ] Repair remains on same Workplace.
- [ ] Recovery is bounded.

### Kernel

- [ ] Kernel handlers are deterministic relative to injected ports/state.
- [ ] No worker hiring from kernel code.
- [ ] No recency-based accepted material lookup.
- [ ] Persisted output has an idempotency identity.

### External/human

- [ ] External dependencies are ports.
- [ ] Human decision binds exact subject.
- [ ] External side effects have observation/receipt semantics.
- [ ] Retry does not blindly duplicate a possibly completed external effect.

### Package

- [ ] All resources hash-close.
- [ ] Capability declarations have exact bindings.
- [ ] No process-global private registration path is required by the design.

### Testing

- [ ] Workshop coverage universe defined before claiming completion.
- [ ] Generic Factory resilience dimensions assigned.
- [ ] P0 mutation families killed.
- [ ] Exact lifecycle handoff proven.
- [ ] No `ANONYMOUS-STALL` or stranded execution.

## 23. Smells that mean “stop and redesign before coding”

Stop if the proposed workshop requires any of these:

- `if (moduleName === ...)` in universal Factory runtime;
- direct writes to `factory_workplaces`, CandidateSets, GateDecisions or authority heads from workshop code;
- a workshop-specific worker dispatcher;
- a workshop-specific retry scheduler;
- “latest accepted artifact” lookup instead of exact refs;
- a reviewer that is actually a second author;
- an LM with direct release/integration authority because it is convenient;
- a new `external` node;
- a custom test runner because `ScenarioRunner` cannot understand the workshop;
- duplicated lifecycle routing inside the module;
- invisible capability registration outside package/binding closure;
- copy/pasted whole-module variant with edits to arrays by index;
- a semantic hash authored by the worker when the Factory can observe source bytes;
- a terminal outcome that has no deterministic observable meaning.

## 24. Minimal authoring sequence for an implementation agent

Use this exact order.

### Phase A — architecture card

Produce a short design artifact containing:

```text
module identity
purpose/non-goals
input authority
output authority
local outcomes
node topology
cell inventory
kernel inventory
human/external ports
invariants
lifecycle routes
```

No code yet.

### Phase B — contracts

Implement:

- input/output schemas;
- worker/human/provider payload contracts;
- pure domain policies;
- exact identity/hash rules.

### Phase C — definition

Build the declarative Process Module:

- nodes;
- Production Cells;
- transitions;
- profiles;
- artifacts;
- policies;
- invariants.

Validate topology before binding executables.

### Phase D — capabilities

Implement:

- CheckProviders;
- kernel handlers;
- effects;
- ports;
- human adapters.

Each gets logical ID/version/digest where applicable.

### Phase E — package/resources

Add resources and close package digest.

### Phase F — runtime bindings

Bind through the canonical workshop binding mechanism; do not add a private registration path.

### Phase G — lifecycle

Add exact input/output mapping and outcome routes.

### Phase H — conformance

Build:

- positive spine;
- one negative representative per independent protection;
- feedback causality;
- generic resilience assignment;
- restart/idempotency;
- exact handoff;
- mutation coverage;
- coverage report.

### Phase I — admission

Only after deterministic conformance is green, update the closed built-in admission surfaces required by current ADRs.

## 25. Finish condition

A new workshop is complete only when all are true:

```text
one ownership boundary
+ one public descriptor
+ one package identity
+ declaration/binding exact closure
+ no private runtime physics
+ exact lifecycle handoff
+ 100% planned workshop conformance universe
+ 100% required demonstrated workshop coverage
+ P0 mutation closure
+ no unexplained progress/authority defects
```

A module-authoring validator being green is necessary but not sufficient.

The strongest proof that the architecture remains universal is this:

> Adding the workshop requires new workshop declarations, fixtures, bindings and obligations, but no new branch in the universal Factory runtime or test kernel.

If that statement is false, investigate the architecture before declaring the workshop finished.
