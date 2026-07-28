# Solution Formalization Process Module

## Identity

```text
solution-formalization@1.0.0
```

## Goal

Convert an accepted Discovery subject into a frozen, traceable and implementable
solution contract without allowing architecture or implementation choices to
silently rewrite the accepted product intent.

> Discovery is an idea-strength gate, not a build gate. Every Discovery outcome
> (including a weak `clarify` / `reject` / `defer` / `inconclusive` / `failed`)
> is forwarded to Formalization. The strength of the idea is carried by the
> Discovery outcome certificate (`decision` + readiness confidence) and does not
> itself block settlement; Formalization reasons about the contract on its own
> merits. The certificate must still be present and structurally valid.
>
> The operator can flip this back to a legacy go/no-go gate per run by setting
> `discoveryGate: 'strict'` in the lifecycle input. Under `strict`, non-`go`
> Discovery outcomes terminate the lifecycle (`clarify` →
> `clarification-required`, `reject` → `rejected`, etc.) instead of forwarding.
> Default is `'permissive'`. Use `strict` for regulated / contractual
> environments where Discovery is a real build gate.

## Input contract

```text
saga3.formalization-case.v1
```

The input must bind:

- authoritative Discovery outcome certificate (any decision; strength is
  recorded, not blocking);
- accepted subject snapshot;
- constraints and non-goals;
- known evidence and unresolved questions;
- authority and policy configuration;
- process/lifecycle/stage binding identifiers.

## Output contract

```text
saga3.solution-contract-certificate.v1
```

The certificate should bind:

- accepted PRD/FR/NFR/RULE/UC/AC artifact ids and hashes;
- immutable acceptance baseline hash;
- SRS id/hash;
- required trace graph digest;
- policy version/hash;
- local decision and reason codes;
- exact Formalization settlement input hash.

## Outcomes

- `formalized` — a complete frozen solution contract exists;
- `clarification-required` — product/acceptance information is materially missing;
- `inconsistent` — contract artifacts or trace graph contradict each other;
- `infeasible` — architecture cannot satisfy the accepted constraints;
- `failed` — infrastructure could not produce an authoritative result.

The module does not route `formalized` to Development. A Stage Binding owns that route.

## Flow

```text
1. Define Product Contract [LM: saga-product]
   PRD + FR + NFR + RULE

2. Model Use Cases [LM: saga-analyst]
   UC covers FR

3. Define Acceptance Contract [LM: saga-analyst]
   AC derives from UC + FR/NFR

4. Reconcile WHAT [LM: saga-reconciler]
   repair permitted traces, verify the kernel-accepted set, expose gaps

5. Freeze Acceptance Baseline [Kernel]
   immutable baseline hash

6. Define Architecture Contract [LM: saga-architect]
   SRS + modules + invariants + ports + DECOMP

7. Settle Formalization [Kernel]
   validate exact graph, issue certificate
```

## Primary invariant

> WHAT is reconciled and the acceptance baseline is frozen before HOW/SRS.

This preserves the current ADR-013 pipeline order and makes it a Process Module
invariant rather than a convention embedded only in role skills.

## Content owned by the module

- formalization schemas;
- PRD/FR/NFR/RULE/UC/AC/SRS semantics;
- trace relation requirements;
- acceptance-baseline semantics;
- reconciliation and settlement policies;
- local outcomes and reason codes;
- execution profiles;
- role skills;
- artifact/MCP templates and checklists.

## Execution physics supplied by Runtime

- WorkIntent creation and lifecycle;
- task projection;
- independent reviewer projection from the module execution profile;
- execution identity/fencing;
- skill injection;
- external tracker provisioning;
- workspace isolation;
- materialized MCP call copies;
- capability enforcement;
- retries, pause/resume and recovery;
- exact, kernel-owned candidate acceptance after producer completion and
  reviewer approval;
- artifact/event persistence;
- Flow routing mechanics.

## Execution profiles

### formalization-product

- task kind: `formalization.prd`;
- skill: `saga-product`;
- reviewer: `saga-requirements-reviewer`;
- output: PRD/FR/NFR/RULE bundle.

### formalization-use-cases

- task kind: `formalization.uc`;
- skill: `saga-analyst`;
- reviewer: `saga-requirements-reviewer`;
- output: UC bundle.

### formalization-acceptance

- task kind: `formalization.ac`;
- skill: `saga-analyst`;
- reviewer: `saga-requirements-reviewer`;
- output: AC contract bundle.

### formalization-reconciler

- task kind: `formalization.reconciliation`;
- skill: `saga-reconciler`;
- reviewer: `saga-requirements-reviewer`;
- output: reconciliation report.

### formalization-architect

- task kind: `formalization.srs`;
- skill: `saga-architect`;
- reviewer: `saga-architecture-reviewer`;
- output: architecture bundle.

All profiles use the same Runtime mechanics but different task contracts and
semantic outputs. Producers and reviewers never self-accept artifacts: the
module resolver validates semantics and emits an exact candidate directive,
then the common kernel gate atomically accepts the reviewed ids and hashes.

## External execution assets

- `tool-templates/formalization/process-module-stage-tracker.md`;
- `tool-templates/formalization/artifact-create-call-template.json`;
- `tool-templates/formalization/trace-add-call-template.json`;
- `tool-templates/formalization/worker-done-call-template.json`;
- `tool-templates/formalization/formalization-node-checklist.md`.

The Runtime makes execution-scoped copies and machine-fills ids, hashes,
versions and authority. Workers re-read these files and their checklists before
consequential MCP calls.

## Implementation state

Implemented:

- versioned module definition;
- Flow, artifacts, policies and invariants;
- execution profiles bound to existing skills;
- tracker, MCP templates and checklist;
- module registry;
- Discovery → Formalization Stage Binding;
- FormalizationCase and SolutionContractCertificate schemas;
- generic LM execution through managed WorkIntents and execution receipts;
- kernel artifact resolution and managed production ledger;
- deterministic acceptance-baseline freeze;
- deterministic settlement and content-addressed persistence;
- ProcessRun/NodeRun restart and recovery;
- connection to Development through the complete Product Delivery Lifecycle;
- structural, behavioral and smoke tests.

The module is the active generic-flow implementation used by
`saga3-lifecycle`; it does not depend on the Saga 2 formalization pump.
