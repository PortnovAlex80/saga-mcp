---
name: saga-planner
description: "Propose an architecture-neutral Development work DAG from one immutable DevelopmentCase; the kernel validates and materializes it."
---

# Development task-graph planner

The planner proposes; the kernel authorizes. Never create tasks, mutate Git,
run workers, or change frozen ids.

## Authoritative input

1. Read the assigned task with `task_get`.
2. Use only `task.metadata.process_node_input` as the immutable DevelopmentCase.
3. Use the exact tracker, call-file and checklist paths from
   `task.metadata.process_workspace`.
4. Treat the machine-filled call file as lineage scaffolding, not as a valid
   implementation plan. Empty implementation arrays and target source arrays
   must be completed semantically.

## Universal planning principles

- Plan product construction, not one task per acceptance criterion. Acceptance
  criteria are coverage obligations; several criteria may belong to one
  coherent work item and one criterion may require ordered work items.
- Establish shared foundations before dependent work. Encode that order in
  `dependsOnKeys`; do not rely on prose or worker timing.
- A work item must leave the repository in a coherent, testable state and must
  be reviewable as one change.
- Parallel work is allowed only when workers can start from the same frozen
  base and integrate independently without semantic or file ownership races.
- Declare conservative repository-local `changeScopes`. If two items may touch
  the same scope, order them with a dependency. Never invent narrow scopes only
  to obtain parallelism.
- Bind every implementation item to exactly one frozen repository. Partition
  required implementation keys exactly once across matching integration
  targets.
- Verification is candidate-wide. Keep exactly one required verification item
  per accepted criterion; it runs only after the kernel freezes the integrated
  candidate. Bind it to the exact frozen repository it must inspect; a
  verification item without a repository is not executable work.
- Use only skills and tools present in the frozen execution profile. The graph
  describes intent, dependencies, ownership and lineage, not a technology.

## Required proposal

Submit exactly `factory.development-task-graph-proposal.v1` through
`process_node_submit`.

Implementation items:

- `kind=implementation`, `executionMode=git_change`;
- stable unique key, one frozen repository, non-empty AC coverage;
- non-empty conservative `changeScopes`;
- dependencies name implementation items only and form an acyclic graph.

Verification items:

- exactly one required item per accepted AC;
- `kind=verification`, `taskKind=verification.ac`,
  `executionMode=read_only_evidence`;
- exactly one AC id, exactly one frozen repository id and an empty
  `changeScopes` array.

Integration targets:

- exactly one per frozen repository;
- branch and expected base copied verbatim;
- source keys are an exact, non-overlapping partition of required
  implementation items assigned to that repository.

## Completion protocol

Read the saved JSON back, ensure it parses and contains no placeholder, then
call `process_node_submit` once. After success call `worker_done` once and stop.
If submission is rejected, preserve the exact rejection for the next fenced
repair execution; do not submit a different payload from the same execution.
