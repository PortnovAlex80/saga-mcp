# Conveyor Mental Model — Saga4 (Version 4)

The architectural metaphor that governs how the Saga conveyor moves work from
idea to release. This document captures the conceptual model so every change to
the conveyor can be checked against it. It is NOT a spec — the formal invariant
is **CGAD P18** (`cgad-v2-spec.md`); this file is the plain-language model
behind it.

**Version 4** supersedes Version 3. It retains the core analogy — **one
machine, one material, one desk** — and defines the reusable unit that makes
the analogy executable: the **Production Cell**. A workshop is now understood
as a declarative arrangement of Production Cells, not as a collection of
module-specific engines, tables and submit tools. The human Kanban state tells
which production stage owns the card, while a separate Workplace loop state
tells what the factory is doing inside that stage. Worker replacement and
kernel rework do not roll a Kanban card back to `todo`.

## The one-machine factory

The Saga conveyor has **one machine**: a language model. It has **one
material**: text. It produces **one kind of product**: text artifacts.

This sounds trivial until you realise what it means for the architecture:

| Workshop | What crosses the production boundary | Physical form |
|---|---|---|
| Discovery | Proposal, readiness assessment, certificate | Text (JSON/Markdown) |
| Formalization | PRD, UC, AC, SRS, FR, NFR | Text (JSON/Markdown) |
| Development | Code, tests, review comments | Text (source files) |
| Delivery | Desired state (optional LM), effect receipt/observation (provider) | Text (JSON) |

A proposal, a PRD and a TypeScript module are **the same physical entity**: a
text artifact with a schema and a content hash. The schema differs
(`saga3.discovery-proposal.v1` vs `saga3.formalization-product-bundle.v1` vs
`text/x-typescript`) — but that is **data polymorphism, not mechanism
polymorphism**.

The worker-facing material is UTF-8 text, canonical JSON, or a content-addressed
set of text documents. A code change is therefore represented as a `TextSet`
or patch manifest with per-document hashes; it is not a special kind of worker
execution. Large repositories are referenced by exact blob/tree refs instead
of being copied into one JSON string. Paths, modes, renames and deletions are
manifest metadata and must never be inferred from concatenated source text.

```
TextSetManifest {
  baseTreeRef?
  entries[] {
    path
    operation        // create | modify | rename | delete
    fromPath?
    mediaType
    mode?
    blobRef?
    digest?
  }
}
```

The TextSet digest is the hash of the canonical manifest. Paths are normalized
and containment-checked; referenced blobs are immutable. Binary assets are
opaque immutable refs, not text invented by the LM.

This axiom does **not** turn every external action into text. Compilation,
tests, Git integration, publishing and deployment are deterministic checks or
external effects performed through kernel/provider ports. Their requests,
receipts, observations and certificates are text products, but the effects
themselves are not disguised as `product_submit` and are never granted directly to
an LM merely because the LM produced their desired state.

The core therefore treats a product as an opaque content-addressed envelope.
`ProductRef` is the single exact identity; fields are not duplicated around it:

```
ProductEnvelope {
  ref: ProductRef        // id + schemaRef + digest
  mediaType
  body: InlineText | CanonicalJson | TextSetManifestRef | ImmutableBlobRef
  lineageRefs[]
  producerAuthority {
    kind                 // worker-execution | gate-run | check-run |
                         // human-decision | effect-attempt
    ref
  }
  workplaceRef?
}
```

Text/JSON/TextSet are standard adapters. The conveyor validates identity,
hashes, lineage and declared contracts without branching on product meaning.

**This is why there is one logical desk, not four.** The conveyor does not have a
"proposal desk", a "PRD desk" and a "code desk". It has **one desk**:
`WorkplaceProduct(workplaceRef, productRef)`. Every worker — regardless of
workshop — places text on the same desk. Every kernel engineer — regardless of
workshop — reads from the same desk. “One” means one schema-agnostic,
runtime-owned Production port; its adapter may use a generic envelope store and
blob store, but never workshop-specific persistence. The physical store indexes
all products by ProductRef and tagged producer scope; the desk is the exact
WorkplaceRef-scoped view. Standalone gate/check/human/effect evidence keeps its
own producer scope and may also reference a subject Workplace.

### The LEGO principle

A workshop (цех) is a **pure declaration** — a package of skills, profiles,
policies and schemas. It contains **zero runtime code** for:

- How workers are hired, dispatched or supervised.
- Where products are stored or read from.
- How review works or recovery triggers.
- Which table receives a submit.

The workshop declares **WHAT** (Flow, execution profiles, schemas, policies).
The factory runtime decides **HOW** (dispatch, desk, review, recovery).

Adding a new workshop means writing a new package (skills + profiles + Flow
declaration). It does NOT mean:
- Adding a new `*_submit` tool.
- Adding a new table.
- Adding a new resolver that reads from that table.
- Adding a `task_kind === 'myModule.*'` switch anywhere.

If any of those steps is required, the LEGO contract is broken.

### One desk, one submit, one read

```
Worker (any workshop)
  │
  ▼
product_submit({ schemaRef, content })   ← ONE universal submit
  │
  ▼
authoritative logical product store      ← ONE desk
  (producerScopeRef, ProductRef, producer authority)
  │
  ▼
product_read({ exactProductRef })         ← ONE universal read
  │
  ▼
Kernel engineer / next node (any workshop)
```

The `schema` field distinguishes the **type of text** (proposal, PRD, code).
The runtime does not switch on schema to decide where to store or read — it
stores and reads uniformly. The kernel engineer validates the schema
declaratively (via the module's declared `outputSchema`), not by branching on
module name.

### Historical record: four parallel desks (the design mistake)

The original implementation was built workshop-by-workshop. Each workshop
received its **own submit tool, its own table and its own resolver** — because
the designers thought the workshops produced *different kinds of entities*:

| Workshop | What designers thought it produced | Actual physical product | Dedicated desk |
|---|---|---|---|
| Discovery | "A proposal" | Text (JSON) | `saga3_proposals` |
| Formalization | "Artifacts (PRD, UC, AC, SRS)" | Text (JSON/Markdown) | `saga3_managed_artifact_productions` |
| Development | "A submission" | Text (JSON task graph) | `saga3_managed_node_submissions` |
| Delivery | "Release records" | Text (JSON) | `saga3_delivery_*` |

The mistake was **domain-driven table design**: each workshop's domain
vocabulary ("proposal", "artifact", "submission") became a separate table,
when the physical reality is that **every product is text with a schema**.
The designers conflated *what the text means* (domain semantics) with *what
the text is* (a workplace product that the conveyor moves between nodes).

Evidence for a common nucleus already exists: the modules share the
`ProcessModule`/Flow model, `GenericFlowExecutor`, node dispatch, kernel handler
registry, ProcessRun lease, attempt journal, contracts and recovery primitives.
But the refactoring has **not** yet made the four workshops behaviorally
equivalent. Product persistence, LM launch, exact acceptance, review and
recovery still take different paths, and parts of Development still depend on
the legacy task-board lifecycle. Desk unification alone is therefore
necessary but insufficient; the Production Cell coordinator, CandidateSet and
GateDecision must also become authoritative.

This historical record is preserved so future architects understand **why**
there are four tables and **why** they should become one — not because the
domains differ, but because the domains were mistaken for different materials
when they are all text.

> **Current status:** Four module-specific stores remain authoritative:
> Discovery (`proposal_submit` → `saga3_proposals`), Formalization
> (`artifact_create` bridge → `saga3_managed_artifact_productions`), Development
> (`process_node_submit` → `saga3_managed_node_submissions`) and Delivery's
> release/effect stores. A fifth shared `saga3_process_products` store and
> `WorkplaceProductPort` prototype exist, but there are no production submit
> callers; they are an additive read/bridge path, not the authoritative desk.
> Historical manual GLM runs demonstrated parts of Discovery → Formalization →
> review → recovery → resume, but there is no automated real-model conformance
> proof covering the full production path.
>
> There is also no authoritative materialized Workplace, Workplace loop-state
> store, CandidateSet or generic GateDecision. Workplace identity is inferred
> from ProcessRun/node/task metadata, and human/machine progress is still
> collapsed into legacy task status. All Production Cell contracts below are
> target contracts unless explicitly marked as current primitives.

## The conveyor

A product initiative moves through **stages** (Discovery → Formalization →
Development → Delivery). Each stage is run by a **module** (a swappable unit
with its own skills/specialty). Inside a module, work flows through a **Flow**
of **nodes**.

## The reusable Production Cell

The universal unit of LM production is not an isolated LM node and not an
isolated kernel resolver. It is one **Production Cell** containing the whole
bounded control loop:

```
exact input ProductRefs
  → fenced author execution
  → immutable ProductRefs
  → sealed author CandidateSet
  → author GateRun + typed GateDecision
      ├─ accepted(final)  → complete cell
      ├─ accepted(author) → fenced reviewer pinned to the author CandidateSet
      │                      → reviewer CandidateSet
      │                      → final GateRun + typed GateDecision
      ├─ repair_required → exact RecoveryIssue; hire target role again
      ├─ human_required  → pause without losing the Workplace
      └─ failed          → explicit terminal failure
```

The final GateDecision has the same closed verdict branches as the author gate.

This protocol is the **universal production kernel**. It is the same for a
proposal, PRD, source patch, test set or desired release state. Product meaning
changes; the production physics does not.

### Production Cell versus Flow node

A Production Cell is a first-class `FlowNode` with
`kind = production-cell`. Author/reviewer `WorkerExecution`s, `CheckRun`s and
`GateRun`s are internal runs of that cell, not additional Flow nodes. The Flow
cursor remains on the cell across repair and review and may leave it only after
a final typed outcome. This keeps cursor, restart and identity exact without a
hidden generated subgraph.

This resolves a contradiction in the earlier model. The current flows often
contain:

```
producer LM node → kernel resolver node → repair producer LM node
```

Those legacy nodes are one Workplace and one desk, not two Workplaces. In the
target model:

- The producer anchors the Production Cell and its durable Workplace.
- Author and reviewer executions are one-shot visitors to that Workplace.
- A candidate-checking operation is an internal `GateRun` with an explicit
  `subjectWorkplaceRef`; it does not get another card or desk.
- A standalone kernel transformation, settlement or external effect that does
  not verify an LM candidate may remain an ordinary control node without a
  worker Workplace.

One definition may materialize several Workplace instances. This is required
for Development: an accepted task graph can fan out one `implement-work-item`
cell template into many independently staffed desks. The stable identity is:

```
WorkplaceRef {
  processRunId
  moduleRef
  productionCellId
  workKey
}
```

Singleton cells use `workKey=default`; fan-out derives a deterministic workKey
from an accepted upstream binding and stable item id, never from array order,
worker or attempt identity. During migration, an adapter may collapse a legacy
producer/resolver node pair into one cell whose `productionCellId` equals the
producer node id. Every GateRun carries the exact `subjectWorkplaceRef`; it must
never infer the subject from adjacency, module name, task kind or a "latest
product" lookup.

### CandidateSet: the sealed handoff to quality control

A worker may leave several drafts and products on a desk. The quality gate
must not inspect a mutable "latest" view. `execution_complete` seals the exact
candidate set owned and sealed by the fenced execution:

```
CandidateSet {
  candidateSetRef
  workplaceRef
  producerExecutionRef
  role                 // author | reviewer
  subjectCandidateSetRef? // required for reviewer
  members[] {
    productRef
    origin             // produced | carried-forward
    sourceCandidateSetRef?
  }
  sealReceiptRef
  candidateSetDigest
  sealedAt
}
```

The seal key `(workplaceRef, producerExecutionRef, role)` is deterministic:
idempotent replay returns the same ref and a different payload is rejected.
Each member was either produced by the active fenced execution or explicitly
carried forward from a named prior CandidateSet under the product/recovery
policy. An upstream input cannot be presented as new output merely because it
appears in lineage. A reviewer execution is pinned to one exact author
CandidateSet, emits only declared verdict products and cannot mutate author
products. Every repair execution sees the rejected set as immutable input and
seals a **new** CandidateSet.

Products remain immutable. Acceptance is an append-only `GateDecision` binding
an exact CandidateSet to versioned evidence; it is not mutation of an artifact
status. A minimum receipt/decision model is:

```
CheckReceipt {
  checkReceiptRef
  checkRunRef
  subjectCandidateSetRef
  assessmentCandidateSetRefs[]
  checkRef
  providerRef
  providerVersion
  providerDigest
  environmentRef?
  outcome              // passed | failed | unknown | error
  evidenceRefs[]
  receiptDigest
}
```

```
GateDecision {
  workplaceRef
  gateRef
  gateRunRef
  gatePhase            // author | final
  transitionRef
  subjectCandidateSetRef       // authored product being accepted or rejected
  assessmentCandidateSetRefs[] // reviewer verdicts, when present
  verdict              // accepted | repair_required | human_required | failed
  repairTargetRole?    // author | reviewer; required for repair_required
  checkPlanRef
  checkPlanDigest
  decisionPolicyRef
  decisionPolicyDigest
  checkReceiptRefs[]
  installationDigest
  decisionKey
  acceptedOutputBindings[] // named binding -> exact ProductRef[]; final only
  recoveryIssueRef?
  decisionDigest
}
```

```
RecoveryIssue {
  recoveryIssueRef
  rejectedGateDecisionRef
  subjectCandidateSetRef
  failingCheckReceiptRefs[]
  repairTargetRole       // author | reviewer
  findings
  requiredAcceptance
}
```

The reviewer CandidateSet is evidence about the author CandidateSet; accepting
review output never substitutes it for the authored product. An author gate
with `verdict=accepted` keeps `acceptedOutputBindings` empty, pins its
`subjectCandidateSetRef` into the reviewer reservation and queues review. Only a
cell-final accepted transition may populate downstream output bindings and
finish the cell. Decision uniqueness covers Workplace, gate phase, exact
subject/assessment sets and policy digest.
`runtime.completed` means only that a worker or gate run stopped normally. It
does not mean that a candidate was accepted. Kanban advances only on a durable
`GateDecision.verdict = accepted`.

Recording a decision and applying its Workplace transition is an idempotent
outbox workflow keyed by `decisionKey` and expected Workplace revision. A crash
between those writes is replayed; a decision for a superseded CandidateSet or
revision is retained as audit but cannot advance the cell.

### The three layers of a universal quality gate

The quality mechanism is universal; product semantics remain declared by the
workshop:

1. **Core integrity gate** — exact refs, hashes, contract/schema identity,
   cardinality, lineage and producer provenance. Product submit and CandidateSet
   seal atomically verify the live worker fence; the later GateRun verifies
   immutable authority receipts proving that the fence was valid at commit
   time, and uses its own gate authority/lease.
2. **Declared CheckPlan** — versioned refs to schema, policy, sandboxed
   lint/build/test and provider-observation checks. A CheckProvider cannot run
   arbitrary candidate-supplied shell or mutate authoritative/external state;
   command/args are pinned by the installed plan. An independent LM review is
   the optional fenced reviewer phase, not a hidden provider call. Human
   approval is a durable HumanInteractionRun whose receipt may feed the gate,
   not a blocking call hidden inside a check.
3. **Decision policy** — a deterministic reducer converts the check receipts
   to one closed verdict (and an explicit repair target when required); the
   common coordinator records acceptance or recovery and applies the state
   transition. `unknown` and `error` fail closed unless the installed policy
   explicitly maps them to a safe non-accepting outcome.

There is no single universal semantic validator for PRD, TypeScript and a
release observation. A standard workshop selects checks from the installed
registry. Truly new deterministic semantics or an external substrate may add a
versioned `CheckProvider` or `EffectProvider` through the common extension
point. Its implementation is a separately versioned and security-reviewed
capability plugin; an ordinary process module only references the installed
provider id. Providers do not dispatch workers or mutate Workplace/Flow state.

### Declarative Production Cell definition

A normal cell is completely described by data similar to:

```
ProductionCellDefinition {
  id
  inputSelectors[]
  materialization {
    sourceBinding?      // absent = singleton
    workKeySelector?
    completionPolicy   // normally all
  }
  author {
    skillRef
    capabilityPreset
  }
  productContracts[] {
    binding
    schemaRef
    mediaType
    cardinality
  }
  quality {
    authorGate {
      checks[]
      decisionPolicy
    }
    review? {
      skillRef
      capabilityPreset
      verdictSchemaRef
    }
    finalGate {
      checks[]
      decisionPolicy
    }
  }
  recovery {
    maxAttempts
    onExhausted
  }
  transitions {
    accepted
    humanRequired
    failed
  }
}
```

Without a reviewer, the author gate is declared `gatePhase=final` (or aliases
the same final plan); the runtime never invents a second review step.

For fan-out, the accepted source binding seals the instance set. The Flow node
completes only when its declared completion policy is satisfied across those
Workplaces; board rows cannot add or remove production instances.

The runtime materializes this declaration into a Workplace and drives the same
loop for every workshop. A standard new workshop supplies only:

- manifest and Flow/Production Cell declarations;
- input, product, verdict and output schemas;
- author/reviewer skills and resources;
- closed, platform-owned capability presets (for example `text-author`,
  `text-reviewer`, `sandbox-code-author`); modules select a preset but cannot
  inject raw tool names or handlers;
- CheckPlan, decision and recovery policies.

It supplies no SQL table, product-specific submit/read tool, MCP handler,
dispatcher, runner or status machine.

### Universal conveyor protocol surface

The platform owns one stable LM-facing conveyor protocol. Repository/search
capabilities are a separate centrally authorized set, not alternative lifecycle
commands:

```
workplace_get()
product_read({ exactProductRef })
product_submit({ schemaRef, content | textSet, lineageRefs })
execution_complete({
  productRefs,
  carryForward?: [{ productRef, sourceCandidateSetRef }],
  summary?
})
```

- Runtime derives Workplace, execution, role and fence from the launch context;
  the model cannot choose or rebind them.
- `workplace_get` returns that immutable context and pinned refs; it exposes no
  queue listing, task selection or transition command.
- `product_read` resolves only an exact ProductRef that is in this execution's
  pinned read set: declared inputs, subject CandidateSet, RecoveryIssue or an
  explicitly permitted prior desk binding. Every read is journaled.
- `product_submit` canonicalizes/hashes content, enforces schema, lineage,
  authority and the live fence, then returns a `ProductRef`. Runtime derives
  mandatory provenance/lineage from the execution context; model-supplied
  lineage is only a constrained additional annotation over its allowed read set.
- `execution_complete` means "the worker has left a sealed candidate on the
  desk". It rejects another execution's refs unless they are explicitly
  authorized carry-forward members. It never accepts the product or advances
  Kanban. `summary` is non-authoritative journal text and is never gate input;
  anything material must be submitted as a product.

Relations, traceability reports, verification records and task graphs are
ordinary products with declared schemas and lineage. They do not justify new
submit tools. A new substrate adds a CheckProvider or EffectProvider, never an
LM-facing tool by default. An exception requires explicit security/architecture
review and falls outside standard Production Cell conformance.

Code authoring uses the same text surface plus an optional platform-owned,
sandboxed repository capability selected by a closed capability preset.

### Checks versus effects

- Schema validation, lint, build, tests and observation in a disposable
  sandbox are **checks**. A CheckProvider is read-only with respect to
  authoritative/external state and runs only plan-pinned commands/arguments
  against an immutable CandidateSet snapshot.
- Commit, merge, tag, push, publish and deploy are **effects**. They run as
  separate Flow control/effect nodes only after a final accepted output binding
  and required durable human authorization.
- Every effect binds an exact desired-state ProductRef/digest, authorization
  digest, deterministic idempotency key and durable EffectAttempt/EffectReceipt;
  retry observes external state before repeating the action.

Delivery desired state, authorization, effect request, receipt and observation
are products; the external effect itself is never disguised as text generation.

### Repackaging the implementation that already exists

The universal core is assembled from existing primitives rather than started
from zero, while distinguishing live mechanisms from currently unused seams:

- Keep `GenericFlowExecutor` graph walking, ProcessRun lease, recovery
  accounting, transition budgets and NodeRun persistence; extract its Workplace
  loop coordinator. Replace latest-completed/frame-derived resume and implicit
  predecessor discovery with an exact persisted cursor and declared input
  selectors; make envelope hashing and boundary decoding part of the live path.
- Keep `ProcessRun`, attempt audit, `ProductRef`, canonical serialization and
  `RecoveryIssue`/`RecoveryCase` concepts.
- Reuse the proven atomic fence, PID-birth, liveness/progress and reconciliation
  algorithms, not their task foreign keys or requeue policy. Task release must
  become a fenced Workplace loop transition that leaves Kanban unchanged.
- Retain the ContractRef/registry/decoder and capability-intersection designs;
  harden schema registration against digest mismatch and wire both into the
  actual launch/product/gate path before calling them enforced.
- Replace/graduate the prototype `WorkplaceProductPort` into the authoritative
  fenced `ProductRepositoryPort`, rather than preserving an additive wrapper
  around legacy desks.
- Harden the adapter: the current prototype trusts a caller-supplied digest and
  does not enforce `executionRef`; the authoritative adapter must canonicalize
  and hash internally, verify lineage/schema/fence, and reject stale writes.
- Retire or rename the existing unused WorkIntent/projection-oriented
  `WorkerExecutionPort`, retaining only its driver-neutral receipt ideas.
  Introduce authoritative ExecutionReservation/WorkerExecution repositories
  over real attempts; the current interface cannot become those ports by field
  removal alone.
- Replace the board-coupled `LmNodeExecutor` with a driver-neutral
  `ProductionCellWorkerExecutor` using Workplace/Execution ports.
- Generalize artifact/task-specific exact acceptance into CandidateSet,
  CheckReceipt and GateDecision contracts.
- Replace task/intent-based execution receipts and `NodeProducts` unions with
  execution refs and exact `ProductRef[]`.
- Remove kernel-node-id/"latest node products" resolution; a GateRun receives
  its exact subject Workplace and CandidateSet from the cell coordinator.
- Keep module semantic checks behind the kernel registry, but invoke them
  through the common CheckPlan/Decision protocol.

The core must not import or branch on Discovery, Formalization, Development or
Delivery. A fifth ordinary text workshop is accepted only when it can install
and run without modifying this list of core components.

### How the four workshops converge on the core

The four workshops are not equally unified today. Their target is one protocol,
not identical business meaning:

| Workshop | What can already be reused | Current fracture | Production Cell target |
|---|---|---|---|
| Discovery | Flow execution, kernel handlers, contracts and ProcessRun audit | proposal-specific tools/tables and bespoke LM persistence; recovery is not uniformly expressed | proposals, assessments and certificates become typed products; readiness/settlement become declared checks and decisions |
| Formalization | strongest use of generic Flow, kernel nodes and exact-candidate acceptance | artifact/task-specific ledger; epic-scoped fallback reads can cross the intended ProcessRun/task boundary; authoring still crosses board-coupled execution | replace the managed artifact ledger with ProductEnvelope/CandidateSet and generalize truly exact acceptance to GateDecision |
| Development | common Flow for task-graph planning/resolution and settlement plus existing lease/fence algorithms | implementation, review, verification and integration remain outside the common Flow and depend on legacy tasks | accepted graph fans out a cell instance/workKey per item; patch/TextSet are products; test/build are checks and integration is an effect |
| Delivery | ProcessRun, kernel/human control and durable release evidence | mostly kernel/human/provider work, so forcing it through an LM executor would be artificial | use a cell only where an LM authors desired state; approval, publish/deploy, observation and certification remain standard control/effect nodes with product receipts |

Thus Delivery proves the boundary: the **production kernel** is universal for
LM work, while the **conveyor runtime** also supports non-LM control and effect
nodes. “Everything is text” describes what crosses boundaries and sits on the
desk; it does not require every Flow node to hire a language model.

### One engine, two channels — not two engines in symbiosis

Human Kanban plus machine loop does not preserve the old task-board engine as
a second source of truth. There is one Production Cell coordinator. `WorkItem`
is its human projection and Workplace loop state is its machine state. During
migration an adapter may temporarily project to the legacy `tasks` table, but
the adapter must be one-way, rebuildable and forbidden from launching workers
or deciding transitions. Its removal condition is explicit: no core read,
write, foreign key, tool or test depends on `tasks`, `worker_next` or
`orchestrate`.

The migration order is:

1. Introduce authoritative Workplace, ProductEnvelope, CandidateSet,
   CheckReceipt and GateDecision stores plus projection rebuilding.
2. Extract the Production Cell coordinator and switch worker launch to the
   universal execution context/tools.
3. Move Formalization, Discovery, Development and then LM-producing Delivery
   cells to the protocol, preserving exact historical product refs.
4. Route repository and delivery effects through versioned providers.
5. Prove restart, recovery, review and real-model conformance. For each cutover,
   first prohibit core reads from legacy state, then switch authoritative writes
   to the new stores while retaining only a one-way rebuildable board projection.
6. Remove legacy projection writes, foreign keys, tools and launchers; then drop
   their bridges, tables and schemas once absence of readers is proven.

The compatibility period is a migration phase, not part of the target
architecture.

### Universal real-model conformance harness

The target core must own a conformance suite that any Production Cell can run
with both a deterministic scripted driver and a real LM driver. Both modes use
the same coordinator, product/evidence stores and tool handlers. The suite
asserts durable protocol facts, not the wording of model output:

- exact declared inputs were read and every submitted product passed its
  schema, digest, lineage, authority and fence checks;
- `execution_complete` sealed one immutable CandidateSet but did not accept it;
- a real CheckPlan ran, emitted receipts and produced one typed GateDecision;
- a repair kept the same Workplace/card/desk, exposed the exact RecoveryIssue,
  fenced the old execution and hired a new execution;
- author failure, invalid reviewer output and a reviewer-proven product defect
  take three distinct transitions;
- crash/lease expiry, stale writes, pause/resume and restart at every durable
  boundary converge without duplicate effects or a Kanban rollback to `todo`;
- downstream nodes receive only products bound by an accepted GateDecision.

Repair, reviewer, crash, stale-fence and check-error branches use deterministic
fault injection in the driver/gate/lease boundary; the suite never waits for a
model to fail by chance. Every run records model/provider/version, prompt,
skill, package and CheckPlan digests plus scenario seed. All product reads are
journaled, legacy board/module-submit tools are denied, and external effects use
fake or isolated providers.

Every workshop adds semantic fixtures for its schemas and CheckPlan, but it
does not copy the lifecycle tests. Pull requests run deterministic conformance;
scheduled and pre-release suites run the same scenarios against configured real
models and real sandboxed checks. A real-model run is green only on bounded
eventual completion with all event/state/evidence invariants satisfied — not
identical wording and not merely a plausible final text.

## Four entities, one primary

The conveyor has four kinds of entity. Getting their roles right is the whole
game.

| Entity | Code | Lifetime | Role |
|---|---|---|---|
| **Workplace** (место) | a materialized Production Cell in a ProcessRun | durable — lives for the whole run | PRIMARY. Owns the card, desk and quality loop. |
| **Worker** (рабочий) | one fenced `WorkerExecution` | one-shot — comes, works, leaves, never returns | GUEST on the workplace. |
| **Card** (карточка) | a rebuildable `WorkItem` read model derived from the Workplace | logical lifetime of that cell instance | Human Kanban projection; never an execution source of truth. |
| **Desk** (стол) | the execution workspace directory | durable — belongs to the workplace | Holds the worker's drafts/tools. |

### Who does what — the hard boundary

- **Worker (модель + skill):** knows ONLY how to do the work described in its
  skill. That is all. It does not hire, does not spawn, does not pick work,
  does not decide how many workers run, does not manage infrastructure. It
  arrives with an already committed Workplace, role, work description, exact
  inputs, desk, execution and fence, does the work, submits exact products, calls
  `execution_complete`, and leaves. The worker has no queue-selection command —
  infrastructure fixes the context before the worker arrives.
- **Infrastructure (конвейер):** hires workers, decides how many to run, picks
  eligible Workplaces from the queue (reviewer role first, then author role),
  commits the exact execution context BEFORE the worker arrives, provides the
  desk and manages fencing/heartbeat/persistence. A module declares WHAT work
  its cells need; infrastructure decides HOW to staff it and WHICH eligible
  Workplace receives the next execution.

A module MUST NOT hire workers itself. Launcher construction, private task
loops and direct `executor.start` calls belong to infrastructure, never to a
module.

### One queue, one concurrency knob, infrastructure leases Workplaces

**Target state.** Today `LmNodeExecutor` directly launches one preassigned task
while the board dispatcher drains other author/reviewer work. These remain two
launch paths and do not share one authoritative Workplace queue or concurrency
budget.

There is exactly **one** queue and **one** concurrency control:
`--concurrency=N`. The **infrastructure** picks eligible Workplaces whose
machine loop is `queued` (review role first, then author role) and assigns each
one to a hired worker. The worker never searches for work — infrastructure
commits its exact context before launch. No module runs its own dispatch loop, no module
has a second concurrency parameter. The queue ordering is:

1. **Reviewer role FIRST** — existing work in review gets priority so it
   reaches acceptance faster. Do not lease new author work while reviewer work
   is waiting at equal or higher policy priority.
2. **Author role** — new or repaired work, in priority then sort order.

Conveyor Runtime atomically changes `queued -> leased` and records an exact
`ExecutionReservation` in the same transaction. Execution Control consumes the
committed reservation, idempotently creates/launches its WorkerExecution through
`WorkerLauncherPort`, and reports lifecycle events back. The worker reads its
exact context, does the work, seals its CandidateSet through
`execution_complete`, and leaves.

**The workplace is the primary entity.** The worker is a one-shot guest on it.
The card's logical identity and the desk are anchored to the **workplace**, not
the worker, and survive a worker change.

### From production order to the first worker

The universal start sequence is:

1. An initiative/epic command starts one pinned `ProcessRun`; the epic is input
   context, not the worker-dispatch engine.
2. Conveyor Runtime resolves the first Flow node. For a Production Cell it
   materializes an exact WorkplaceRef with `kanbanPhase=todo`, `loopState=idle`
   and emits the event from which the board builds its WorkItem.
3. When declared dependencies and exact input bindings are ready, Runtime
   atomically admits the Workplace as `in_progress/queued` with
   `nextRole=author`.
4. The global dispatcher records one ExecutionReservation (`queued -> leased`);
   Execution Control launches the worker from that committed context.
5. A final accepted gate marks this WorkItem/cell done. ProcessRun advances the
   Flow, materializes the next singleton/fan-out Workplaces, and the same
   sequence repeats until the run reaches a typed terminal outcome.

No board scan creates factory work. The board is visible immediately because it
projects Workplace events; worker assignment continues correctly even if that
projection is dropped and rebuilt.

### Review is universal, not module-specific

When an author CandidateSet passes its author gate, the same card routes to
review or completes its cell based on a
**declarative field** (`quality.review` in the Production Cell), not on a
hardcoded module-name check:

- `quality.review` absent → the author gate is final, completes this WorkItem,
  and ProcessRun activates the next Flow node.
- `quality.review` present → Kanban enters `review`, the same Workplace queues the
  reviewer role, and the dispatcher hires a reviewer. After the reviewer
  CandidateSet passes the final gate, the run advances with exact author,
  reviewer and gate receipts.

This is the same mechanism for **every** workshop. There is no
`if (task_kind.startsWith('discovery.'))` switch. The runtime core does not
switch on module names, module kinds or worker skills.

## Two-channel state: human Kanban and machine loop

The conveyor has two orthogonal state channels. They MUST NOT be flattened
into one ever-growing task-status enumeration:

1. **Kanban state** answers the human question: "which production stage owns
   this card?"
2. **Workplace loop state** answers the machine question: "what is the factory
   doing inside that stage?"

The distinction is essential. A worker crash, lease expiry, failed kernel
check or replacement worker does not mean that started work became unstarted.
Therefore those events MUST NOT return a card to `todo`.

### Ownership of both channels

The machine loop state belongs to the **Workplace**, not to a worker and not
authoritatively to the projected Kanban task. In the target write model the
Workplace also owns authoritative `kanbanPhase`; `WorkItem` only projects it.
Human actions address a Conveyor Runtime use case for the Workplace and emit a
domain event — they never mutate a projection row as orchestration truth.

The identity of that state is:

```
WorkplaceRef -> { kanbanPhase, workplaceLoopState, nextRole }
```

This ownership follows lifetime:

- A worker/execution is one-shot. It may be completed, lost, expired or
  superseded while the loop continues.
- A WorkItem/card is a human-facing Work Projection representation. It may
  display both channels, but it is not their source of truth.
- The Workplace survives every worker replacement and owns the continuity of
  the desk, products, defect sheet and quality loop.

The active `WorkerExecution` has its own narrower physical state such as
`reserved`, `assigned`, `running`, `completed`, `lost`, `expired` or
`superseded`. Execution state is evidence about one worker attempt; workplace
loop state is progress of the machine loop across attempts.

A `GateRun` has its own idempotency key, lease and authority. At most one
mutation actor (`WorkerExecution` or `GateRun`) may own a Workplace revision at
once. Entering `verifying` creates/claims the GateRun; another worker cannot be
leased until a terminal gate decision or recovery transition wins the
Workplace revision compare-and-set.

### Kanban state

Kanban state remains small and meaningful to a person:

```
todo -> in_progress -> review -> review_in_progress -> done
                       ^               |
                       |               | reviewer found a product defect
                       +---------------+

* -> blocked            // human interaction required; resumable
* -> failed             // explicit terminal failure
* -> cancelled          // explicit cancellation
```

`in_progress` and `review_in_progress` are active production stages. A
workplace desk exists for the full lifetime of the Workplace, including the
intervals between workers and while a kernel engineer checks the product.
`done` finishes **this** Workplace/WorkItem. The ProcessRun then advances the
Flow and materializes or activates the next Workplace with a new WorkItem; the
card does not travel between Production Cells. "Same card" applies only to
author, reviewer and recovery cycles inside one cell instance.

### Workplace loop state

The minimum common machine states are deliberately role-neutral:

```
idle
queued
leased
running
verifying
repair_wait
paused
terminal
```

These names describe factory mechanics, not workshop semantics. A module may
declare domain outcomes, but it must not create a private dispatch or retry
state machine.

Author/reviewer is a separate `nextRole`, not another loop state:

```
nextRole = author | reviewer
```

Likewise, `terminal` has an explicit reason such as `accepted`, `failed` or
`cancelled`. Keeping role and outcome out of the state name prevents the core
state machine from growing a new status for every workshop and every gate.

Allowed channel combinations are closed, not arbitrary:

| Kanban phase | Allowed loop state |
|---|---|
| `todo` | `idle` |
| `in_progress` | `queued`, `leased`, `running`, `verifying`, `repair_wait` |
| `review` | `queued` with `nextRole=reviewer` |
| `review_in_progress` | `queued`, `leased`, `running`, `verifying`, `repair_wait` |
| `blocked` | `paused` with a durable resume target |
| `done` | `terminal(accepted)` |
| `failed` | `terminal(failed)` |
| `cancelled` | `terminal(cancelled)` |

### Author loop inside `in_progress`

```
Kanban: in_progress

queued -> leased -> running -> verifying
                                  |     |
                       defect ----+     +---- gate accepted
                          |                    |
                          v                    v
                     repair_wait           Kanban: review or done
                          |
                          +-> queued -> leased -> running -> verifying ...
```

The author calls the universal completion command and exits. Completion means
"the worker has stopped and left a candidate product on the desk"; it does
not mean that the product passed the quality gate. The kernel engineer reads
the exact product from the same desk:

- On author-gate acceptance with review, the conveyor advances the same card to
  `review`, sets `nextRole=reviewer`, and queues the same Workplace. Without
  review, that gate is final: the current card becomes `done`, the loop becomes
  `terminal(accepted)`, and ProcessRun activates the next Flow node separately.
- On a repairable result, the kernel places a `RecoveryIssue` on the same desk,
  sets the Workplace loop to `repair_wait`, then the recovery policy queues a
  new author for the same Workplace.
- On pause, terminal failure or cancellation, the corresponding explicit
  Kanban state and terminal reason are recorded. They are never disguised as
  `todo`.

### Reviewer loop inside `review_in_progress`

```
Kanban: review_in_progress

queued -> leased -> running -> verifying
                                  |
                    +-------------+------------------+
                    |             |                  |
             bad review      product defect        accepted
                    |             |                  |
             same reviewer    Kanban returns      current card done;
             stage retries    to in_progress       next cell activates
```

There are two different rejection meanings:

- If the reviewer attempt itself is incomplete or unverifiable, the Kanban
  state remains `review_in_progress`; feedback is placed on the same desk and
  a new reviewer is hired.
- If a valid reviewer verdict proves a defect in the authored product, the
  Kanban state returns to `in_progress`, the same Workplace loop becomes
  `repair_wait` with `nextRole=author`, a `RecoveryIssue` is placed on the same
  desk, and a new author is hired. This is a semantic review transition, not
  technical crash recovery.
- If the final gate accepts the pinned author set with its reviewer evidence,
  the current card becomes `done`, the cell becomes `terminal(accepted)`, and
  ProcessRun activates the next Flow node with a different WorkItem.

Author and reviewer are normally different execution roles visiting the same
Workplace, not two different Workplaces. The card, desk and product history do
not move when the role changes.

### Transition authority

Workers do not set either channel directly. They submit products and report
completion. The conveyor derives transitions from durable events:

| Event | Kanban state | Workplace loop state |
|---|---|---|
| Work admitted | `todo -> in_progress` | `idle -> queued`, `nextRole=author` |
| Worker assigned/started | unchanged | `queued -> leased -> running` |
| Worker completed candidate | unchanged | `running -> verifying` |
| Worker crashed or lease expired | unchanged | `running -> repair_wait`; recovery may queue a replacement |
| Gate requests repair | unchanged | `verifying -> repair_wait`, using explicit `repairTargetRole` |
| Author gate accepts and review is required | `in_progress -> review` | `verifying -> queued`, `nextRole=reviewer` |
| Author gate accepts without review (cell-final) | `in_progress -> done` | `verifying -> terminal(accepted)`; ProcessRun activates next node |
| Reviewer assigned | `review -> review_in_progress` | `queued -> leased -> running` |
| Reviewer attempt is invalid | unchanged | `verifying -> repair_wait`, `nextRole=reviewer` |
| Reviewer proves product defect | `review_in_progress -> in_progress` | `verifying -> repair_wait`, `nextRole=author` |
| Final gate accepts | `review_in_progress -> done` | `verifying -> terminal(accepted)`; ProcessRun activates next node |
| Human intervention required | `* -> blocked` | `* -> paused` |
| Gate/recovery terminates as failed | `* -> failed` | `* -> terminal(failed)` |
| Authorized cancellation | `* -> cancelled` | `* -> terminal(cancelled)` |

Kanban advancement is therefore gated:

> An LM Production Cell cannot advance forward or release output until its
> declared final gate accepts exact products. A reviewer-proven defect may move
> the same card back to author work; failed technical attempts otherwise repeat
> inside the current stage on the same Workplace and desk. Non-LM control/effect
> nodes transition only through their own typed outcomes.

### Projection rule

The board may render both channels on one card, for example:

```
Kanban: In progress
Agent loop: verifying, author, attempt 3
```

This is a projection only. Authoritative Kanban phase and loop state remain on
the Workplace; the authoritative physical attempt state remains on
`WorkerExecution`. A board rebuild must be able to reproduce both values from
durable conveyor state without reading transient process memory.

## The repair mechanic (recovery)

Every workplace has a common mechanic — independent of its specialty — for
sending work back for rework:

> When a verifier (engineer / kernel node) finds a defect, a **new worker** is
> brought to the **SAME workplace**. The new worker takes the **SAME card**
> (with the work already done on it) and continues on the **SAME desk** (with
> the prior drafts). The worker fixes the defect and the verifier re-checks.

The worker never carries the card or the desk away. The next worker always
finds the workplace's card and desk waiting.

The defect sheet (`RecoveryIssue`) is delivered **on the desk** as an immutable,
exactly referenced product, not hidden in mutable task metadata and not only
through prompt regeneration. The new worker reads the issue alongside the
prior CandidateSet and understands what to fix.

## What this rules out (the bug this model replaced)

- ~~Recovery mints a **new card** per attempt~~ → the verifier looks at the new
  empty card, finds "no work", and the loop never converges.
- ~~Recovery gives the worker a **clean desk**~~ → the worker starts from
  scratch every round and cannot converge on a complex artifact.
- ~~A gate reads the card by **worker identity**~~ → it is blinded to the
  workplace's prior work on every repair round.
- ~~Runtime core **switches on module names**~~ → adding a workshop requires
  editing dispatcher/lifecycle code instead of just writing a package.

## Resume must not be coupled to package digest

A run's **work** (WorkItems, products, CandidateSets, decisions, traces and
receipts) lives in durable runtime storage, keyed by ProcessRun and Production
Cell. It does **not** live inside the module package. The package is the
**toolset and instructions** (templates, skills, schemas and policies) workers
use — it is separate from the work they produced.

## Why Discovery is permissive (the market is the real gate)

A user who enters a hypothesis into the conveyor wants to see it built — **even
if the conveyor's own assessment judges the idea weak**. Discovery is an
idea-strength gate, not a build gate: its job is to record how strong the idea
looks (go / clarify / reject / defer / inconclusive / failed) into the discovery
certificate, **not** to block the conveyor.

So every Discovery outcome forwards to Formalization. The strict-gate variant
(non-go Discovery terminates) survives as a separate declarative scenario
package for regulated/contractual environments.

## Target enforcement required by CGAD P18 and Version 4

These are acceptance requirements, not a description of the current production
path.

- **Stable cell identity:** recovery never changes
  the full `WorkplaceRef`, including `workKey`.
- **Card reuse:** one WorkItem projects that cell throughout author, repair and
  reviewer executions; attempt identity is never part of its key.
- **Desk stability:** the workspace and product ledger are keyed by the
  exact WorkplaceRef, so drafts and immutable products survive worker
  replacement without mixing fan-out instances.
- **Fenced writes:** every product submission is attributed to the active
  WorkerExecution; a stale execution cannot submit or seal candidates.
- **Exact handoff:** a CandidateSet seals exact ProductRefs and each GateRun
  declares its subject Workplace and candidate set.
- **Append-only acceptance:** gates add a GateDecision; they do not infer
  acceptance from worker completion or mutate a "latest" product.

Per-attempt **audit** remains orthogonal: each author, reviewer and gate run has
its own execution/attempt record while the Workplace identity stays fixed.

## Human factory analogy (short form)

- **завод / конвейер** = the Saga runtime (orchestration, execution and persistence)
- **цех** = a process module (discovery / formalization / development / delivery)
- **производственная ячейка** = a reusable Production Cell definition
- **рабочее место** (workplace) = one materialized cell instance in a ProcessRun
- **рабочий** (worker) = one fenced LM WorkerExecution
- **карточка** (card) = the human-facing WorkItem projection
- **рабочий стол** (desk) = the workplace-scoped workspace plus product ledger
- **отдел качества / ОТК** = the universal quality subsystem of a Production Cell
- **инженер ОТК** = one GateRun inspecting an exact CandidateSet
- **проверочный стенд** = a versioned CheckProvider invoked by the GateRun
- **акт ОТК** = the immutable GateDecision
- **брак-лист** = the exact RecoveryIssue returned to the same workplace
- **скилл** = the execution profile / semantic skill of a workplace

## Human–machine glossary (canonical factory vocabulary)

The left-hand terms are the language used with people; the right-hand side is
their exact machine meaning. This vocabulary is normative for architecture
discussions, code reviews, tests and plans. A human term must not map to two
runtime concepts, and a runtime concept must not silently acquire a second
human meaning.

| Human factory term | Machine contract / meaning | Owner |
|---|---|---|
| **Factory / conveyor** (завод / конвейер) | Saga Runtime: orchestration, executors, dispatch and persistence | infrastructure |
| **Production order** (заказ) | `ProcessRun` | Conveyor Runtime domain |
| **Workshop** (цех) | a Process Module package | module package |
| **Production Cell** (производственная ячейка) | declarative author/check/review/gate loop | Module Contracts |
| **Workplace** (рабочее место) | one materialized Production Cell instance identified by exact `WorkplaceRef` | Conveyor Runtime |
| **Machine loop state** (состояние лупа) | durable progress of staffing, execution and quality checking inside one workplace | `Workplace` |
| **Card** (карточка) | human-facing `WorkItem` read model derived from WorkplaceRef/events | Work Projection context |
| **Work desk** (рабочий стол) | WorkplaceRef-scoped workspace and immutable product-ledger view | workplace |
| **Worker** (рабочий) | one LM execution | infrastructure |
| **Shift / worker attempt** (смена) | one `WorkerExecution` | Execution Control |
| **Candidate batch** (партия на проверку) | one sealed immutable `CandidateSet` | Production/Evidence |
| **Quality department / QC** (отдел качества / ОТК) | universal Production Cell quality subsystem coordinating GateRun, checks, evidence and decision application | Conveyor Runtime + Production/Evidence |
| **Quality plan** (план контроля) | versioned `CheckPlan` declared by the workshop | Module Contracts |
| **Quality engineer / inspector** (инженер ОТК) | one authorized `GateRun` over an exact subject CandidateSet | Production/Evidence audit |
| **Test bench** (проверочный стенд) | installed versioned `CheckProvider` executed through `CheckRunnerPort` | capability infrastructure |
| **Test receipt** (протокол проверки) | immutable `CheckReceipt` binding provider/version, subject, outcome and evidence | Production/Evidence |
| **QC act** (акт ОТК) | immutable `GateDecision` binding exact candidates, receipts, policy and verdict | Production/Evidence |
| **Control-node run** | one `NodeRun` for an ordinary non-cell Flow node | Conveyor Runtime audit |
| **Specialty** (специальность) | execution profile and semantic skill | module declaration |
| **Dispatcher** (диспетчер) | application service leasing eligible workplaces to executions | infrastructure |
| **Queue** (очередь) | claimable Workplaces whose loop state is `queued` | Conveyor Runtime |
| **Pass / badge** (пропуск) | execution fence and lease token | worker execution |
| **Timesheet** (табель) | execution status, heartbeat and timestamps | infrastructure |
| **Foreman / supervisor** (мастер) | parent runner supervising one worker process | infrastructure |
| **Watchman / reaper** (вахтёр) | periodic reconciliation of active executions | infrastructure |
| **Alive signal** (отметка «жив») | structured lease heartbeat | worker execution |
| **Progress signal** (отметка «работаю») | structured output/tool/progress observation | execution journal |
| **Tools** (инструменты) | allowed capabilities exposed to a worker | execution authority |
| **Tooling** (оснастка) | installed package, resources, templates and schemas | Module Catalog context |
| **Product** (изделие) | immutable `ProductEnvelope` placed on the work desk | Production context; attributed to its producer/workplace |
| **Defect sheet** (брак-лист) | exact `RecoveryIssue` bound to the rejected decision, candidate and failed receipts | quality subsystem output |
| **Repair case** (ремонтный случай) | `RecoveryCase` | Conveyor Runtime domain |
| **Control point** (контрольная точка) | pre/post hooks and policy enforcement | infrastructure |
| **Production journal** (журнал) | events, traces, receipts and provenance | runtime persistence |

The **quality department is not a fifth workshop and not another worker**. The
workshop declares what quality means through contracts and CheckPlan; the
factory-owned QC mechanism executes that plan identically for every workshop.
An inspector/GateRun cannot rewrite the product, a test bench/CheckProvider
cannot move the card, and a worker cannot issue its own QC act. Only application
of an immutable GateDecision may change the Production Cell after inspection.

There are two different meanings of ownership here:

- **Semantic ownership:** the workplace owns the continuity of its card, desk
  and products. Replacing the worker must not replace any of them.
- **Persistence ownership:** Conveyor Runtime owns Workplace transitions, Work
  Projection rebuilds the human WorkItem, the Workspace adapter owns filesystem
  materialization, and Production/Evidence owns immutable products and gate
  records. The `ProcessRun` aggregate holds stable references; it does not
  reach into another aggregate's tables.

This distinction keeps the metaphor true without creating one distributed
aggregate spanning SQLite rows, directories and external workers.

## Normative domain acceptance appendix

The strict human-process → domain concept → code contract → behavior →
acceptance-ID registry lives in
[Factory Domain Acceptance Registry](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md).
It is deliberately separate so this document remains the readable mental model
while the registry can serve as a hard review/test contract.

Every domain or lifecycle change MUST cite the applicable `REG-*`, `PROC-*` and
`E2E-*` identifiers from that registry. A class name is not evidence of domain
conformance: identity, lifetime, authority, prohibited behavior, restart and
observable acceptance facts are.

## Condensed technical conformance checklist

These criteria define the target architecture. A criterion is not considered
implemented merely because a comment, skill or type uses the right words. It
must be enforced by a contract and covered by an executable test. This section
is a quick technical view; the linked registry is the canonical detailed
acceptance contract.

### Factory / conveyor

- Only infrastructure starts, stops and replaces workers.
- Only infrastructure owns dispatch, concurrency, leases, fencing and
  heartbeat.
- A module never imports `WorkerExecutorFactory`, calls `executor.start`, or
  runs a private dispatch loop.
- Runtime core does not switch on module names, module kinds or worker skills.
- One global `concurrency=N` limit applies to every worker-launch path.
- Restarting the runtime preserves orders, workplaces, cards, desks and
  accepted products.

### One machine, one material, one desk

- Every LM worker — in every workshop — places text artifacts through **one
  logical desk**: a runtime-owned ProductRepository indexed by ProductRef,
  producer scope and the full WorkplaceRef when applicable.
- There is **one universal submit tool** (`product_submit`) and one exact read
  tool (`product_read`) for every LM worker. Schema distinguishes the payload
  type; the mechanism is identical.
- The runtime, gates and downstream selectors consume `ProductRef` and accepted
  output bindings through one Production/Evidence port.
- The runtime does not branch on `task_kind`, `schema` or `module name` to
  decide where to store or read a product.
- A workshop declares its product contracts and CheckPlan; core mechanics
  validate identity while registered checks validate semantics.
- Code is a TextSet/patch/tree reference; test, Git and deployment effects are
  authorized checks/providers whose requests and receipts are products.

> **Status:** This is the target. The current implementation has four separate
> desks plus board-coupled execution and uneven gate/recovery paths (see the
> current-status and workshop matrix above). They must converge together.

### Production Cell and quality gate

- A standard workshop defines cells, schemas, skills, capability presets,
  checks, decision policy, recovery policy and transitions without runtime code.
- A Production Cell is one first-class Flow node; WorkerExecution, CheckRun and
  GateRun are its internal attempts, not hidden Flow nodes.
- One fenced execution can submit many drafts, but `execution_complete` seals
  one exact, immutable CandidateSet.
- Worker completion never means product acceptance and never advances Kanban.
- Every GateRun names its subject Workplace and CandidateSet explicitly.
- Reviewer execution/context/output is pinned to one exact author CandidateSet.
- Core integrity checks run for every workshop; semantic checks come from the
  declared CheckPlan, not module-name branches.
- Submit/seal proves a live worker fence at commit time; GateRun uses separate
  authority and exact versioned CheckReceipts.
- A GateDecision is append-only and has one closed verdict: `accepted`,
  `repair_required`, `human_required` or `failed`.
- `repair_required` always names `repairTargetRole=author|reviewer`; the
  coordinator never guesses the role from prose in the finding.
- Author-gate acceptance keeps output bindings empty and pins its exact subject
  into review; final-gate acceptance may bind downstream output.
- Only a cell-final accepted GateDecision can bind downstream output and move an
  LM Production Cell forward; ordinary control/effect nodes use typed outcomes.
- Installing a fifth ordinary text workshop changes no dispatcher, executor,
  product table, tool handler or state enumeration.
- The deterministic and real-model conformance suites exercise the same state,
  recovery, review, restart, fence and exact-handoff assertions.

### Production order (`ProcessRun`)

- A run has one durable identity and immutable original input.
- Every workplace and attempt is attributable to exactly one run.
- Resume continues the same run rather than creating a replacement run.
- Run state can be reconstructed from durable persistence after a crash.
- A terminal run cannot silently return to `running`.
- Package drift cannot erase work; any incompatibility is explicit and
  auditable.

### Workshop (Process Module)

- A module declares WHAT work is required: Flow, Production Cells/control
  nodes, execution profiles, contracts, policies and outcomes.
- A module does not decide HOW many workers exist or HOW they are launched.
- A module does not import another module's implementation.
- Module domain and application code do not import SQLite, MCP, a model driver,
  filesystem adapters, global `getDb`, or shared concrete repositories.
- Every external operation required by a module is expressed through a port.
- A module can be tested with in-memory/fake ports and no running infrastructure.

### Workplace (materialized Production Cell)

- Workplace identity is the stable full `WorkplaceRef` including `workKey`.
- Fan-out creates one Workplace per stable accepted item key; reorder/replay does
  not mint duplicates and attempt identity never enters `workKey`.
- Workplace owns authoritative Kanban phase and machine loop state across all
  worker/gate attempts.
- Loop transitions caused by crash, retry, replacement or kernel repair do not
  reset the card's Kanban state to `todo`.
- A projected card may display the loop state but cannot be its authoritative
  store.
- Recovery attempt, worker ID and package digest are not part of workplace
  identity.
- At most one active mutation actor (`WorkerExecution` or `GateRun`) may own a
  Workplace revision at a time.
- WorkItem identity, desk reference and accepted product references survive a
  worker change.
- Verifiers read a sealed CandidateSet by exact product references, never a
  mutable "latest" view or transient worker identity.
- A repeated execution creates a new attempt record, not a new workplace.

### Card (`WorkItem` projection)

- Conveyor Runtime atomically leases the eligible Workplace and creates its
  exact ExecutionReservation before launch; Execution Control consumes that
  reservation idempotently.
- Eligibility validates Flow dependencies, Kanban/loop state, run scope, role
  and authority.
- The launch context contains a Workplace-derived WorkItem snapshot plus exact
  Workplace, role, execution and fence refs; it exposes no queue-selection
  capability and does not depend on a projection row.
- Reviewer-role Workplaces are leased before author-role Workplaces.
- Two dispatchers cannot give one Workplace two live mutating executions.
- WorkItem projection and restart are idempotent and do not mint duplicates.
- Recovery reuses the same WorkItem and accumulated work; technical failure
  does not return its Kanban state to `todo`.

### Desk (workspace)

- The workspace path is derived from the full durable WorkplaceRef, not worker
  or attempt identity.
- Infrastructure materializes the desk before the worker starts.
- A replacement worker sees prior drafts, tools and recovery feedback.
- A worker cannot read or write the desk of another run or workplace.
- Worker completion does not delete the desk.
- Cleanup happens only through an explicit retention policy.
- Materialization is idempotent and validates path containment.

### Worker

- One launch receives exactly one immutable execution context for one Workplace.
- The worker knows its Workplace-derived work description, role, desk, exact
  inputs, execution ID and fence at start.
- It performs only the declared semantic specialty.
- It cannot create workers, choose concurrency, dispatch cards or manage
  infrastructure.
- It receives the minimum required tools and no queue-selection capability.
- It submits through `product_submit`, seals through `execution_complete`, and
  stops immediately afterwards.
- It cannot complete or mutate another execution's Workplace or products.
- A recovery worker is a new execution identity at the same workplace.

### Shift, pass, lease and heartbeat

- Every attempt has a unique execution ID and fence token.
- Workplace lease, loop-state transition and ExecutionReservation commit
  atomically; WorkerExecution creation is an idempotent consumer step before
  process launch.
- Every mutating worker call validates Workplace, execution and fence.
- An expired or superseded worker cannot write or complete work.
- Launch failure releases the lease or lets it expire by a deterministic rule.
- Heartbeat belongs to an execution, not to the durable workplace.
- Missing heartbeat expires the execution but does not delete its WorkItem or desk.
- Duplicate completion is idempotent.
- The journal records `created`, `assigned`, `started`, `heartbeat`, `done`,
  `failed`, `expired` and `superseded` transitions.

### Foreman, watchman and escaped/tired workers

The factory distinguishes failures that look similar from the queue but require
different evidence and actions:

| Factory condition | Technical evidence | Required action |
|---|---|---|
| Worker left normally | supervised child `close` callback | terminalize execution; evaluate a sealed candidate or recover an unsealed attempt |
| Worker died / escaped | local PID is absent or PID birth token changed | mark `lost`; atomically revoke fence and move the Workplace to repair |
| Foreman died | execution lease is expired and no trusted supervisor owns it | reaper performs fenced recovery; a new foreman may launch replacement |
| Worker is alive but silent | PID/lease alive, no progress events | observe and alert; do not immediately reassign |
| Worker is stuck / exhausted | progress silence exceeds policy and cancellation grace or wall-clock deadline | request cancellation, then verified termination and fenced recovery |
| Worker is remote | local PID cannot be verified | decide from durable lease heartbeat; never kill or release from PID guess |

The supervisor and reaper have separate responsibilities:

- The **foreman** owns the child-process callback. It records start, periodically
  renews the execution lease, observes output/tool activity, and handles normal
  `close`/`error` events.
- The **watchman** runs independently at startup and periodically while the
  conveyor is alive. It scans durable active executions and reconciles crashed
  foremen, dead workers, expired reservations and cancellation timeouts.
- Reconciliation is idempotent and uses the same atomic release primitive as
  the child `close` callback. A close/reaper race must have one effective
  winner.

There are two different signals:

- **Liveness heartbeat:** "the supervisor still owns this execution". This is
  a structured lease renewal persisted in the database. It must not depend on
  the language model remembering to call a tool.
- **Progress heartbeat:** "the worker produced observable activity". It may be
  updated from stdout, model stream events, tool hooks and accepted tool calls.
  It is useful for stuck detection but is not, by itself, authority to mutate.

A text `worker-heartbeat.log` is observability only. It may drive a dashboard,
but cannot be the source of truth for lease ownership or automatic release:
log writes can be buffered, paths can differ, and the whole host can disappear.

Safe automatic recovery requires all of the following:

- `worker_executions` stores `lease_expires_at`, `heartbeat_at`,
  `progress_at`, PID, machine ID and process birth token.
- A local dead-process decision compares PID **and** process birth token so PID
  reuse cannot kill an unrelated process.
- An alive-but-silent process is not released solely because `progress_at` is
  old. The policy first records `suspected_stuck`, requests cancellation, waits
  a grace period, then terminates only a verified process identity.
- The hard wall-clock deadline is explicit per execution profile. Legitimate
  long model inference is not confused with death.
- Execution Control atomically terminalizes the execution, revokes its fence
  and emits an outbox lifecycle event. Conveyor Runtime idempotently applies
  `leased/running -> repair_wait` against the expected reservation/workplace
  revision; until it does, the revoked/expired reservation prevents a new
  mutation actor. Technical recovery leaves Kanban unchanged.
- A stale execution can never clear a newer execution's fence.
- Automatic recovery emits a system command/event such as
  `ObserveProcessExited`, `ObserveLeaseExpired` or `WorkerExecutionReaped`, plus
  `WorkplaceExecutionReleased`. `AdminOverrideLifecycle` is reserved for an
  authenticated human override with a reason; automation must not impersonate
  an admin.
- Repeated scans are no-ops after the first successful terminal transition.

### Specialty, tools and authority

- A module declares a semantic skill and requested capabilities.
- Infrastructure resolves requested capabilities to installed tools.
- An ordinary module selects a closed platform capability preset; raw tool
  handlers require a separately reviewed capability plugin.
- Allowed tools are bound to the assigned execution and fence.
- Pre-tool authorization rejects operations outside the pinned Workplace,
  execution read/write set or product scope.
- Skills explain domain work, not dispatch or infrastructure mechanics.
- Tool availability is versioned and visible in the execution receipt.

### Engineer, verification and repair

- A verifier evaluates durable products; it does not redo the producer's work.
- GateDecision is replayable/verifiable from immutable exact inputs, versioned
  CheckReceipts and policy. Re-running a nondeterministic LM/human/provider
  assessment need not reproduce its wording or outcome.
- A defect produces a structured `RecoveryIssue` with findings, subject refs,
  rejected decision, failing receipt refs, repair target, acceptance criteria,
  allowed changes and required capabilities.
- A defect opens or advances one `RecoveryCase` for the same workplace and gate.
- Repair brings a new worker to the same card and desk.
- Successful verification resolves the active repair case.
- Exhausted recovery produces an explicit `failed` or `paused` outcome.

### Checks, human interaction and effects

- CheckPlan references only installed, versioned CheckProviders; checks run on
  an immutable CandidateSet snapshot and cannot mutate authoritative/external
  state.
- CheckProviders do not secretly launch an LM or wait for a human. LM review is
  a fenced reviewer WorkerExecution; human approval is a durable
  HumanInteractionRun.
- Irreversible effects run only in separate control/effect nodes after final
  accepted bindings and required authorization.
- Every effect uses exact desired-state/authorization digests, an idempotency
  key, durable attempts/receipts and observe-before-retry.

### Products and production journal

- Every product has a schema, durable reference and content digest.
- Every artifact, submission, trace and receipt has exact tagged producer
  authority/scope and, where applicable, subject Workplace/Candidate provenance.
- Accepted products cannot be silently overwritten.
- Consumers read by exact reference/hash or an accepted output binding, never
  by "latest worker" heuristics.
- Hash and schema are checked at trust boundaries.
- `WorkerExecution` and `GateRun` preserve cell-attempt audit; `NodeRun`
  remains the audit record for ordinary Flow control nodes.
- The journal is append-only or provides equivalent tamper-evident history.

### Tooling and package digest

- A package contains instructions and tools, not the work produced with them.
- Installation bytes and resource indexes have verifiable digests.
- A run records which installation it used for every attempt.
- Package drift is recorded as an audit event.
- Drift does not replace cards, desks or accepted products.
- Resume reinstalls a compatible toolset or reports explicit incompatibility;
  raw digest inequality alone is not loss of work.

### Hooks / control points

- A pre-launch hook runs after a committed ExecutionReservation and before
  process launch.
- Hooks receive an immutable execution context and cannot secretly select a
  different Workplace or WorkItem.
- Workspace hooks validate existence, ownership and containment of the desk.
- Authority hooks bind allowed tools to Workplace, execution and fence.
- Pre-tool hooks fail closed for unauthorized mutations.
- Post-tool hooks persist receipt and provenance without changing domain truth.
- Completion hooks validate authority and candidate structure before accepting
  `execution_complete`; quality acceptance remains a separate gate decision.
- Hook retry is idempotent and its fail-open/fail-closed policy is explicit.
- Modules may declare hook policy; infrastructure executes lifecycle hooks.

### Mandatory end-to-end scenarios

1. Two dispatchers racing for one queued Workplace produce one committed
   ExecutionReservation and at most one live WorkerExecution.
2. With `concurrency=3`, no more than three workers run and at least two run
   concurrently when two Workplaces are eligible.
3. A worker starts from a committed reservation with exact Workplace, role,
   read set, execution and fence refs and exposes no queue-selection tool.
4. `execution_complete` seals exact ProductRefs but leaves Kanban unchanged
   until a GateDecision is applied.
5. Worker crash preserves WorkItem, desk and already persisted products; the
   loop enters repair without returning Kanban to `todo`.
6. Recovery gives a new execution the same Workplace/WorkItem/workspace and the
   exact rejected CandidateSet/RecoveryIssue as immutable inputs; it must seal a
   distinct new CandidateSet.
7. A superseded worker cannot submit or seal after recovery begins.
8. A reviewer execution and reviewer CandidateSet are pinned to the exact
   author CandidateSet; a gate never reads a mutable latest product.
9. Author-gate acceptance leaves output bindings empty and pins its subject for
   review; only final-gate acceptance binds downstream outputs and completes the
   current WorkItem.
10. GateRun-versus-worker claim races have one mutation-authority winner.
11. A stale GateDecision for a superseded CandidateSet cannot advance the cell.
12. A crash after decision persistence but before Workplace transition converges
    idempotently without a second decision or lost output binding.
13. Package digest drift does not block a compatible resume.
14. Runtime restart at every durable boundary does not duplicate WorkItems,
    reservations, leases, candidates, decisions or external effects.
15. Reviewer work drains before new author work begins.
16. Invalid reviewer output retries reviewer role, while a valid product-defect
    verdict returns to author role; these transitions cannot be conflated.
17. A module test runs without SQLite, MCP, filesystem or a real LM.
18. The shared real-model conformance suite runs at least one repair cycle and
    one review cycle for every LM-producing workshop using real checks.
19. Architecture tests reject outward domain dependencies, module-name/task-kind
    switches and implementation-to-implementation module imports.
20. Killing a worker without a `close` callback marks its execution lost,
    revokes its fence and queues recovery without changing Kanban stage.
21. Killing the parent runner causes lease expiry and recovery by a new runtime
    instance.
22. A live worker with no tool activity is not reassigned before cancellation
    grace or its wall-clock deadline.
23. A reused PID with a different birth token is never treated as the original
    worker and is never killed.
24. Child-close and reaper racing on the same execution produce one terminal
    transition and one effective `WorkplaceExecutionReleased` event.
25. Any workshop writes through the universal ProductRepository; a gate or
    downstream cell reads the accepted exact ref without a module adapter.
26. A fifth ordinary text workshop installs and passes lifecycle conformance
    without adding a product table, submit tool, executor or status.
27. Kernel, human and effect evidence has its real producer authority and never
    fabricates a WorkerExecution provenance.
28. WorkItem projection rebuild reproduces both channels; an authorized human
    command addresses Workplace and remains effective after another rebuild.
29. Every check runs against the immutable CandidateSet snapshot, even if later
    desk drafts change.
30. Effect retry uses the same desired-state digest/idempotency key, observes
    first and produces one effective external change with durable attempts.

## DDD interpretation

The factory metaphor supplies a ubiquitous language and several invariants. It
does not, by itself, define transaction boundaries or justify one large
"Factory" aggregate. Strategic and tactical DDD boundaries are defined below.

### Bounded contexts

#### 1. Conveyor Runtime

Owns `ProcessRun`, materialized Workplaces, loop progression, Flow transitions,
recovery policy and recovery cases. It decides which Workplace/role is eligible
and atomically records `queued -> leased` plus an `ExecutionReservation`; it
also applies GateDecision-driven transitions.

#### 2. Execution Control

Consumes committed ExecutionReservations and owns `WorkerExecution`, process
launch, fences, liveness, supervision, cancellation and reconciliation. It
reports idempotent lifecycle events to Conveyor Runtime; it does not mutate a
Workplace directly or read a task board to invent work.

#### 3. Work Projection

Owns human-facing `WorkItem`/Kanban projections and translates authorized human
actions into Conveyor Runtime commands addressed by WorkplaceRef. Its rows are
rebuildable from durable conveyor events and cannot launch workers or decide
machine-loop transitions.

#### 4. Module Contracts

Owns process-module definitions, Flow/Production Cell declarations, execution
profiles, input/output contracts, CheckPlans and module outcomes. Module
packages are plugins of this context, not infrastructure services.

#### 5. Production and Evidence

Owns immutable ProductEnvelopes, CandidateSets, CheckReceipts, GateDecisions,
traces and provenance. It exposes exact-ref and accepted-output-binding reads.

#### 6. Module Catalog and Installation

Owns manifests, resources, package digests, dependency locks, installation
activation and drift audit. It does not own ProcessRun work.

#### 7. Lifecycle Composition

Owns stage bindings and routing between module outcomes. It references module
contracts and installed identities, never concrete module implementations.

### Aggregates and invariants

| Aggregate root | Internal state / references | Transactional invariants |
|---|---|---|
| `ProcessRun` | Flow cursor, sealed active-cell instance set, Workplace refs, outcome | valid node/join transition; terminal is final |
| `Workplace` | Production Cell ref, authoritative Kanban/loop state, next role, active reservation/gate/recovery refs | one active mutation actor; valid paired-state transition; final gate acceptance is the only forward cell advance |
| `ExecutionReservation` | workplace revision, role, pinned context, fence/idempotency key, expiry | created atomically with `queued -> leased`; consumed once or expired/recovered once |
| `WorkerExecution` | reservation/workplace/role, fence, lease, heartbeat, terminal status | unique fence; only live execution submits/seals; terminal transition once |
| `GateRun` | workplace revision, phase, subject/assessment sets, plan digest, gate lease | idempotent run key; mutually exclusive with a worker mutation actor |
| `RecoveryCase` | workplace/gate, issues, attempts, resolution/exhaustion | bounded attempts; one active case per workplace and gate |
| `Product` | schema, ref, digest, lineage, tagged producer authority/scope | immutable identity; verified digest; exact provenance without fabricated worker ids |
| `CandidateSet` | workplace, role, subject set, produced/carried-forward members | sealed once; produced members belong to the execution; carry-forward names an allowed prior set |
| `GateDecision` | gate phase/run, exact sets, plan/policy/check refs, verdict/bindings | append-only; deterministic decision key; author acceptance cannot publish final output |
| `HumanInteractionRun` | exact request, subject refs, authority, response/expiry | durable pause/resume; one effective authorized decision |
| `EffectAttempt` | desired-state ref/digest, authorization, idempotency key, observations/receipt | observe-before-retry; one effective external change; append-only attempts |
| `ModuleInstallation` | manifest, resources, digest, active/retired state | digest integrity; one active compatible slot; drift audited |

`WorkItem` is a projection rather than a second orchestration aggregate; its id
is derived from WorkplaceRef and the core never depends on the projection row.
`Workplace` stores desk/evidence references changed through their owning
contexts. Cross-context consistency uses
application-level orchestration, idempotency keys and an outbox/event journal,
not a database transaction spanning filesystem and model processes.

### Domain services and policies

- `FlowTransitionPolicy` validates run and Workplace transitions.
- `DispatchPriorityPolicy` orders reviewer role before author role.
- `RecoveryPolicy` decides repair, pause or fail from a structured issue.
- `LeaseExpiryPolicy` determines when an execution loses authority.
- `ResumeCompatibilityPolicy` evaluates package/contract compatibility.
- `ProductIntegrityPolicy` validates exact refs, schema, digest, lineage and
  provenance.
- `GateDecisionPolicy` reduces declared check receipts to a closed verdict.

These policies must be pure. Reading SQLite, inspecting directories, launching
a model and publishing MCP tools belong to adapters.

## Hexagonal architecture

Dependency direction is always inward:

```text
CLI / MCP / scheduler / tests                 inbound adapters
                 |
                 v
StartRun / ReserveWorkplace / LaunchExecution application use cases
SubmitProduct / SealCandidate / EvaluateGate
RecoverWorkplace / ResumeProcessRun / ProjectWorkItem
                 |
                 v
ProcessRun / Workplace / WorkerExecution      domain model and policies
Product / CandidateSet / GateDecision / RecoveryCase
                 ^
                 |
repositories / launcher / workspace ports     outbound ports
                 ^
                 |
SQLite / LM driver / filesystem / package     outbound adapters
```

### Required inbound use cases

- `StartProcessRun`
- `AdvanceProcessRun`
- `ReserveEligibleWorkplace`
- `LaunchWorkerExecution`
- `GetWorkplaceContext`
- `ReadExactProduct`
- `SubmitProduct`
- `SealCandidateSet`
- `RecordHeartbeat`
- `StartGateRun`
- `RunDeclaredChecks`
- `ApplyGateDecision`
- `RequestHumanInteraction`
- `RecordHumanDecision`
- `AuthorizeEffect`
- `ExecuteEffect`
- `ObserveEffect`
- `RecoverWorkplace`
- `ResumeProcessRun`
- `ExpireWorkerExecution`
- `RenewWorkerLease`
- `ObserveWorkerProgress`
- `ReconcileWorkerExecutions`
- `RebuildWorkItemProjection`
- `HandleHumanWorkCommand`

MCP handlers, CLI commands and schedulers call these use cases. They do not
contain SQL or domain transition logic.

### Required outbound ports

| Responsibility | Canonical declaration |
| --- | --- |
| Load/CAS Workplace state and eligibility | `WorkplaceRepository` |
| Persist/consume exact launch reservations | `ExecutionReservationRepository` |
| Persist, renew, complete and expire real attempts | `WorkerExecutionRepository` |
| Launch / stop a model worker | `WorkerLauncherPort` |
| Supervise lease, progress, exit and reconciliation | `WorkerSupervisionPort` |
| Materialize and contain the cell desk | `WorkplaceWorkspacePort` |
| Append/read immutable product envelopes | authoritative `ProductRepositoryPort` (replacement for prototype `WorkplaceProductPort`) |
| Append/read CandidateSets, receipts, decisions and output bindings | `QualityEvidenceRepositoryPort` |
| Run installed deterministic/policy/sandbox/observation checks | `CheckRunnerPort` |
| Request/resume durable human interaction | `HumanInteractionPort` |
| Execute/observe idempotent authorized external effects | `EffectExecutorPort` |
| Resolve module selectors and resources | `ModulePackageRegistry` |
| Append durable commands/events/outbox records | `EventJournalPort` |
| Inspect OS process liveness (read-only) | `ProcessProbe` |
| Generate ids and provide deterministic local time | `IdGeneratorPort` / context-local `SupervisionClock` |

Provider registries are composition-root details behind the runner/executor
ports, not service locators used by domain code. These names describe target
responsibilities. Existing board/Claude/SQLite
adapters may implement them during migration, but their vocabulary and schema
must not leak back into the core contracts.

### Adapter rules

- SQLite adapters implement repositories, Workplace reservation transactions
  and outbox writes.
- A model runner implements the worker-launch surface only.
- Filesystem code implements workspace materialization only.
- MCP is an inbound adapter plus tool adapters; it is not the domain API.
- Composition root is the only place allowed to construct concrete adapters.
- Domain and application tests use fakes implementing the same ports.

## Architecture review questions

For every class, function, table and tool, ask:

1. Is this describing workshop work, workplace state, or factory physics?
2. Who owns its state and transaction boundary?
3. Does it depend only inward, through a declared port?
4. Is identity durable workplace identity or transient execution identity?
5. Are Workplace, role, execution and fence committed before the worker starts?
6. Can a replacement worker see the same card, desk and products?
7. Can a stale worker still mutate anything?
8. Are hooks enforcing policy or secretly making domain decisions?
9. Is tracking an audit record, or is code incorrectly treating it as domain
   truth?
10. Who detects a dead worker when its parent runner also died?
11. Is the evidence liveness, progress, or merely an observability log?
12. Which executable test proves the claimed invariant?
13. **Is this a module-specific desk/submit/read, or the universal one?** If
    module-specific — why does this workshop need its own desk when every
    product is text?
14. **Does runtime code switch on `task_kind` or module name?** If yes — the
    LEGO contract is broken; the decision should come from a declared profile.
15. Did completion only seal a CandidateSet, or did some path incorrectly treat
    it as acceptance?
16. Does the gate name exact candidate/evidence refs and emit a typed decision?
17. Is an external action modeled as an authorized idempotent effect with a
    receipt, or has text generation been confused with execution authority?

If one component selects a Workplace, starts a worker, writes SQL, manipulates the
workspace and makes a domain decision, the boundaries are broken even if the
component is named "service" or "executor".

## Operational appendices

- [Universal transition diagnostics and logging](CONVEYOR-TRANSITION-DIAGNOSTICS.md)
  defines the target causal journal and deterministic current-state answer to
  “why did it not advance?” for any number of workshops.
- [Transition acceptance and incident checklist](CONVEYOR-TRANSITION-CHECKLIST.md)
  is the operator/developer checklist for factory, workshop, node, Workplace,
  worker, quality gate and inter-workshop transitions.

The current four workshops are configuration instances of this protocol. They
are not four lifecycle engines. Adding a fifth or a thousandth workshop may add
module declarations, products and checks, but must not add another dispatcher,
desk lifecycle, acceptance state machine or diagnostic algorithm.
Domain decisions may emit diagnostic envelopes, but those envelopes are never
read to authorize, replay or repair a transition.
