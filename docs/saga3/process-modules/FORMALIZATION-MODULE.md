# Solution Formalization Process Module

## Identity

```text
solution-formalization@1.0.0
```

## Goal

Convert an accepted Discovery subject into a frozen, traceable and implementable
solution contract without allowing architecture or implementation choices to
silently rewrite the accepted product intent.

## Input contract

```text
saga3.formalization-case.v1
```

The input must bind:

- authoritative Discovery outcome certificate;
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

- `accepted` — a complete frozen solution contract exists;
- `clarification-required` — product/acceptance information is materially missing;
- `inconsistent` — contract artifacts or trace graph contradict each other;
- `infeasible` — architecture cannot satisfy the accepted constraints;
- `failed` — infrastructure could not produce an authoritative result.

The module does not route `accepted` to Development. A Stage Binding owns that route.

## Flow

```text
1. Define Product Contract [LM: saga-product]
   PRD + FR + NFR + RULE

2. Model Use Cases [LM: saga-analyst]
   UC covers FR

3. Define Acceptance Contract [LM: saga-analyst]
   AC derives from UC + FR/NFR

4. Reconcile WHAT [LM: saga-reconciler]
   repair traces, accept coherent artifacts, expose gaps

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
- execution identity/fencing;
- skill injection;
- external tracker provisioning;
- workspace isolation;
- materialized MCP call copies;
- capability enforcement;
- retries, pause/resume and recovery;
- artifact/event persistence;
- Flow routing mechanics.

## Execution profiles

### formalization-product

- task kind: `formalization.prd`;
- skill: `saga-product`;
- output: PRD/FR/NFR/RULE bundle.

### formalization-use-cases

- task kind: `formalization.uc`;
- skill: `saga-analyst`;
- output: UC bundle.

### formalization-acceptance

- task kind: `formalization.ac`;
- skill: `saga-analyst`;
- output: AC contract bundle.

### formalization-reconciler

- task kind: `formalization.reconciliation`;
- skill: `saga-reconciler`;
- output: reconciliation report.

### formalization-architect

- task kind: `formalization.srs`;
- skill: `saga-architect`;
- output: architecture bundle.

All profiles use the same Runtime mechanics but different task contracts and semantic outputs.

## External execution assets

- `tool-templates/formalization/process-module-stage-tracker.md`;
- `tool-templates/formalization/artifact-create-call-template.json`;
- `tool-templates/formalization/trace-add-call-template.json`;
- `tool-templates/formalization/worker-done-call-template.json`;
- `tool-templates/formalization/formalization-node-checklist.md`.

The Runtime must make execution-scoped copies and machine-fill ids, hashes,
versions and authority. Existing skills must gradually migrate from direct
remembered MCP calls to these materialized calls.

## Implementation state

Completed in this branch:

- versioned module definition;
- Flow, artifacts, policies and invariants;
- execution profiles bound to existing skills;
- tracker, MCP templates and checklist;
- module registry;
- Discovery → Formalization Stage Binding;
- structural and boundary tests.

Still required for full execution through the generic node Runtime:

1. FormalizationCase and SolutionContractCertificate domain schemas;
2. generic artifact-change LM node executor or compatibility adapter around current tasks;
3. kernel baseline-freeze handler exposed through the Process Module node interface;
4. deterministic Formalization settlement service and persistence;
5. process-run/node-run durable tables or adapters;
6. full restart/recovery tests;
7. real LM end-to-end smoke.

Until those land, the module is a validated architecture and execution-profile
package registered for design/composition, not a replacement for the current Saga 2
formalization pipeline.
