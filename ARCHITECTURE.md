# Saga Factory architecture

This repository contains one factory runtime. A product order enters through
the factory gateway, advances through an installed lifecycle, and is processed
by declarative workshops made from universal Production Cells.

The normative conceptual document is
[`docs/architecture/CONVEYOR-MENTAL-MODEL.md`](docs/architecture/CONVEYOR-MENTAL-MODEL.md).
Acceptance invariants are registered in
[`docs/architecture/FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md`](docs/architecture/FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md).

## One start path

Every execution begins with a durable `factory_launch_request` created by the
factory gateway. The request selects exactly one mode:

- new order from a product idea;
- resume an existing project from its last durable boundary;
- adopt an inspected checkpoint;
- deterministic test production using supplied products;
- LM test production with the declared reduced test policy.

The process host accepts a `launch_ref`. It does not create projects, choose an
epic, reconstruct lifecycle input from environment variables, or start an
independent board runner.

## Runtime ownership

The application runtime owns:

- lifecycle and StageRun progression;
- ProcessRun and NodeRun reconciliation;
- the global dispatch concurrency budget;
- Workplace state and execution reservations;
- product persistence and exact reads;
- CandidateSet sealing;
- GateRun, CheckReceipt and GateDecision persistence;
- recovery, checkpoint, resume and adoption;
- transition journal and diagnostics.

A workshop package owns only declarations:

- Flow and Production Cell definitions;
- execution profiles, skills and instructions;
- input and output schemas;
- capability presets;
- CheckPlans, decision policies and recovery policies.

The core never switches on workshop names or product meanings.

## Universal production loop

For every materialized Production Cell:

1. The runtime creates one deterministic `WorkplaceRef`.
2. The global dispatcher reserves one eligible Workplace and launches one
   fenced worker execution.
3. The worker reads exact pinned inputs and submits schema-typed products.
4. The runtime seals those exact products into a CandidateSet.
5. Declared checks produce immutable receipts.
6. A GateDecision accepts, requests repair, requests a human decision, or
   terminates the Workplace.
7. Only an accepted final GateDecision releases outputs to the next Flow node.

Author and reviewer are roles in the same loop. Fan-out changes only the number
of deterministic Workplace instances.

## Authority model

| Concern | Authority |
|---|---|
| Factory order and start mode | `factory_orders`, `factory_launch_requests` |
| Lifecycle position | LifecycleRun, StageRun, ProcessTransition |
| Flow position | ProcessRun, NodeRun |
| Card and machine-loop state | Workplace |
| Worker mutation right | active reservation and execution fence |
| Produced material | content-addressed ProductRef |
| Candidate identity | CandidateSet |
| Quality result | CheckReceipt and GateDecision |
| External action | EffectAttempt and immutable receipt |
| Human choice | HumanInteractionRun and receipt |

Task rows and board views are rebuildable projections. They cannot accept a
product, decide quality, or advance a Flow.

## Persistence boundaries

All durable identities are immutable or CAS-guarded. A restart reuses accepted
products and resumes from the last incomplete boundary. Checkpoint adoption
copies exact products, lineage, receipts and installation pins; it never
fabricates provenance.

SQLite transactions protect local atomic boundaries. The outbox and journal
make cross-process transitions replayable. Content hashes cover canonical
payloads, installed package resources, node inputs and decisions.

## Code layout

- `src/app/` — composition and application orchestration.
- `src/process-modules/application/` — universal Flow and Production Cell use
  cases.
- `src/process-modules/domain/` — closed domain contracts and reducers.
- `src/process-modules/installation/` — package installation and digest pins.
- `src/process-modules/persistence/` — runtime persistence adapters.
- `src/modules/` — workshop declarations and semantic kernels.
- `src/infrastructure/` — SQLite, process host, workspace and provider adapters.
- `src/lifecycle/` — assignment, reservation and lifecycle transition rules.
- `src/tools/` — authorized inbound tool adapters.
- `tests/` — domain, architecture, integration and full-factory acceptance.

## Required verification

Every change to factory mechanics must pass:

1. TypeScript build.
2. Architecture and process-module tests.
3. Complete repository test suite.
4. Deterministic full-factory mock from order through all workshops.
5. Crash/resume checks when reservation, product, gate or transition semantics
   change.

Architecture tests must reject any additional start path, private dispatcher,
module-specific submit store, task-state authority, unfenced product write,
nullable installation pin, or quality bypass.
