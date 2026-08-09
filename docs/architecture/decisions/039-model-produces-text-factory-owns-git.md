# ADR-039: Model produces text; Factory owns canonical Git

- **Status:** Proposed
- **Date:** 2026-08-09
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The live Development incident forced a review of three mechanisms that first
appear together in `solution-development`: Production Cell fan-out,
`dependsOnKeys`, and `executionMode='git_change'`. Every LM product is textual,
so the question is whether an LM should also own Git branches, integration and
canonical repository mutation.

The current implementation does not enforce the authority boundary it claims:

- the worker profile grants `Bash`, `Write`, `Edit` and the legacy
  `worker_merge_acquire` / `worker_merge_release` tools;
- the runner uses `bypassPermissions` and `--dangerously-skip-permissions`;
- RepositoryDesk is a linked Git worktree whose refs and object store are shared
  with the canonical repository;
- one tracker still instructs the worker to merge, while the current worker
  skill says only the runtime provider may merge;
- the live task graph has implementation width one and heavy scope overlap, yet
  it created three author/review/integration cycles over three files. The root
  worker already implemented material assigned to downstream items.

ADR-032 remains correct that admission, integration, freezing and acceptance
are provider/kernel authority. This ADR makes that boundary structural and
qualifies when fan-out is economically and semantically justified.

Cynefin classification: **Complicated**. The alternatives are knowable from
the repository and incident evidence, but the authority, productivity and
recovery trade-offs require expert analysis.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority safety and correctness | 25 | An LM claim or shell command must not mutate Factory truth. |
| Model productivity and feedback | 20 | Code production needs efficient multi-file editing and checks. |
| Topology adaptability and scale | 15 | Small coupled work and large independent work need different cardinality. |
| Audit, replay and recovery | 15 | Exact textual production must survive retries without replaying effects. |
| Implementation readiness and cost | 10 | The current factory must be repairable without another private runtime. |
| Testability and observability | 10 | Scripted workers must exercise the real apply/integration path. |
| Reversibility | 5 | The policy must ship through versioned contracts and remain rollback-safe. |

Scores are 1 (poor) to 5 (strong).

## Considered options

### Option A — LM Git inside a hardened isolated staging desk

The LM edits, tests and commits using normal Git inside a separate staging
repository. Factory chooses the exact base, seals the DAG, binds review and is
the sole canonical integration provider. This preserves familiar coding-agent
ergonomics, but it is truthful only with a real OS/process boundary, no shared
refs, no canonical repository mount, no credentials/remotes and no unrestricted
escape through `Bash`. The present linked worktree is not such a boundary.

### Option B — Managed TextSet workspace and Factory-owned Git

The LM never receives canonical Git authority. It reads and edits an exact
repository snapshot through path-scoped managed content tools and submits a
content-addressed `SourceChangeCandidate` / `TextSetManifest`. A managed
`candidate_check` capability provides bounded test feedback. Factory validates
paths, blobs, modes, scopes and base digest, materializes the candidate, creates
the source commit, binds review to the resulting exact tree and performs the
canonical integration through a durable CAS effect.

The capability is generic textual-content production, not a Development-only
engine. Unsupported binary, submodule, symlink, LFS or case-collision material
fails closed until its contract is explicitly added.

### Option C — One coarse LM-owned staging assembly per repository

One LM receives the whole topological checklist and composes it in a private Git
repository, with kernel-owned checkpoints and one final reviewed promotion.
This fits the live three-file product and removes inter-worker merges, but loses
parallel implementation, increases context/blast radius and still requires the
hard OS isolation missing from the current runner.

### Option D — LM owns canonical Git and merge

The LM chooses branches/bases and merges directly into the integration branch,
possibly using the existing merge-lock tools. It is operationally cheap but
makes fallible model behavior the authority for shared external state, weakens
idempotent recovery and contradicts the one-desk/effect model.

## MCDA matrix

| Option | Authority (25) | Productivity (20) | Adaptability (15) | Audit/recovery (15) | Readiness (10) | Testability (10) | Reversibility (5) | Weighted total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Hardened staging Git | 4 | 5 | 5 | 5 | 1 | 4 | 4 | 420 |
| B. Managed TextSet | 5 | 3 | 5 | 5 | 2 | 5 | 4 | **425** |
| C. Singleton staging assembly | 3 | 5 | 2 | 4 | 3 | 4 | 5 | 360 |
| D. LM-owned canonical Git | 1 | 5 | 3 | 2 | 5 | 2 | 2 | 280 |

**Sanity check:** A and B are within 10%, so the numerical margin is not the
decision. Both preserve Factory-owned integration. B wins on the critical
authority boundary because it does not depend on an unavailable OS sandbox or
pretend that a linked worktree is isolation.

## Fan-out and integration policy

Fan-out is an optional topology, not a goal.

1. A planner may propose multiple implementation items only when each is a
   coherent, independently reviewable/recoverable increment.
2. A deterministic granularity policy rejects or requests repair for a small,
   same-repository, width-one graph with heavy scope overlap unless the proposal
   supplies a contract-valid reason for preserving separate acceptance units.
3. True dependency edges block **author admission**. A dependent author receives
   the exact post-dependency integrated snapshot; merge ordering alone is not a
   substitute.
4. Independent DAG roots with enforced disjoint scopes may author and review in
   parallel from the same base.
5. Accepted independent candidates enter one repository/branch-scoped,
   fenced, CAS integration queue. Canonical mutations are sequential.
6. Dependency wait is an orthogonal readiness projection: the Workplace remains
   non-admitted/idle and the board shows `Waiting for dependency`. It must not
   overload Kanban `blocked`, which is reserved for human/recovery obstruction.
   A healthy accepted candidate waiting for merge is `effect_pending` /
   `awaiting_integration`, never generic `blocked`.
7. A conflict or transformation that changes the candidate tree creates a new
   CandidateSet and review authority. Old review is not relabelled.

For the live graph, `foundation -> persistence -> accessibility` has width one,
all items touch `js/app.js`, and the root already implemented downstream
concerns. The continuation should coalesce the remaining tightly coupled work
unless a repaired plan proves separate acceptance value. Parallel authoring is
not justified for this graph.

## Planning authority and swarm topology

Strengthening the planner prompt/skill is necessary but not sufficient. The
planner owns semantic judgement; it is not the acceptance authority for its own
topology.

The planning Cell must use three layers:

1. **Planner skill:** inspect the exact repository snapshot and propose coherent
   product increments. Every split declares `splitRationale`, expected scopes,
   independent review/test value, required predecessor outputs and whether it
   is safe to author from the same base. It must explicitly answer “why is this
   not one item?” and must not create fan-out merely to consume concurrency.
2. **Deterministic graph-fitness provider:** validate exact coverage and DAG
   closure, compute repository-local width, transitive dependencies, scope
   overlap and number of integration boundaries, and reject known-dangerous
   patterns. In particular, a small width-one graph with high overlap is a
   coalescing candidate; independent parallel items must be an antichain with
   enforced disjoint scopes.
3. **Adversarial planning reviewer:** review semantic cohesion and scope realism
   against the repository and accepted SRS. Its checklist must challenge
   fictional independence, impossible narrow scopes, duplicated implementation
   responsibility and a foundation that absorbs downstream concerns.

After production begins, actual changed paths are compared with declared scope.
An earlier item satisfying downstream semantics does not silently erase later
work: it requires a new explicit graph/adoption decision or fresh candidate
verification. The accepted graph remains immutable evidence.

Complexity is therefore contained in typed local decisions. The operator does
not need to mentally simulate the whole swarm: the topology product, graph
fitness report, readiness reasons, effect queue and receipts explain why each
agent may or may not move.

## Pre-mortem

Assumption: Option B was implemented and failed six months later.

1. **Coding productivity collapsed without shell/Git ergonomics** — likelihood:
   medium; detectable through retries, tokens and elapsed time; mitigation:
   path-scoped virtual edit tools plus a trusted `candidate_check` capability,
   not raw `Bash`.
2. **TextSet could not represent real repository material** — likelihood:
   medium; detectable through unsupported-entry denials; mitigation: ship a
   deliberately text-only v1, with explicit mode/rename/delete/encoding rules,
   and fail closed for binary/LFS/submodule/symlink cases.
3. **Materialization changed newline, mode or path semantics** — likelihood:
   medium; detectable by result-tree digest tests; mitigation: canonical blob
   digests, exact mode metadata, case-collision rules and cross-platform fixtures.
4. **Parallel textual changes integrated cleanly but were semantically
   incompatible** — likelihood: medium; detectable at candidate-wide checks;
   mitigation: DAG/scope admission, serialized effects and full integrated
   candidate verification.
5. **The managed content provider became a private Development runtime** —
   likelihood: low; detectable by architecture fitness tests; mitigation: keep
   ProductRef, TextSet, CandidateSet and Effect ports module-neutral and forbid
   module-name branches.

**Net effect:** Option B survives with managed edit/check capabilities and an
explicitly bounded text-only first contract.

## Red Team

**Strongest argument against the original leader (Option A):** the current
worktree plus unrestricted `Bash` and permission bypass is a prompt convention,
not a hard authority boundary. A model can update shared refs or escape to the
canonical checkout. Receipts would audit an unauthorized mutation after it
happened. The live graph also proves that retaining every proposed fan-out item
can preserve semantically fictional decomposition.

**Source in repository:** `tracker-view/claude-runner.mjs`,
`development-process-module.ts`, `implementation-task-tracker.md`,
`repository-desk-provisioner.ts`, GUARDRAILS Sign 014 and the live BUG-018
evidence.

**Response:** accepted. The decision switched from Option A to Option B. A may
be reconsidered only after an adversarial test proves an OS-enforced staging
boundary. The user's sequential-merge proposal is incorporated as the
Factory-owned integration queue for independent antichain work; it does not
replace dependency-aware author admission.

## Decision

Choose **Option B: managed TextSet workspace with Factory-owned Git**, combined
with adaptive fan-out and a repository-scoped sequential integration queue.

The LM remains responsible for semantic code production and may use managed
editing/checking capabilities, but it cannot select the authoritative base,
write Git refs, merge, push or manufacture an integration receipt. Factory turns
the accepted textual candidate into Git state through an exact, idempotent,
observable effect. This preserves the conveyor's one material/one desk model,
supports parallel independent work, and makes the authority claim true by
construction rather than instruction.

## Consequences

**Positive:**

- wrong-branch, shared-ref and model-owned merge failures disappear from the LM
  authority surface;
- textual production is portable across Git providers and replayable without
  replaying external effects;
- independent work may still be produced in parallel and integrated
  sequentially;
- tightly coupled small graphs no longer pay mandatory fan-out cost;
- review, materialization, integration and final verification bind exact trees.

**Negative:**

- the existing commit-centric implementation product requires a new version;
- managed multi-file editing, blob storage/resolution and candidate checks must
  be implemented;
- text-only v1 cannot silently support every Git entry type;
- models lose arbitrary shell freedom and may require more repair iterations;
- application of Git effects still needs crash-safe intent/observe/receipt
  reconciliation.

**Follow-ups:**

- remove `worker_merge_*` from LM profiles and delete contradictory merge steps
  from pinned workspace resources in the new package version;
- make `tasks.integration_state` a projection of durable effect receipts;
- add exact Workplace dependency persistence and adaptive granularity checks;
- strengthen planner and reviewer skills, but keep topology acceptance in the
  deterministic graph-fitness provider;
- add `effect_pending` / `awaiting_integration` projections;
- exercise real TextSet materialization and real Git effects with scripted LM
  production;
- keep old package snapshots readable for historical runs; do not reinterpret
  their commit-based products.

## Decision Journal

**Date:** 2026-08-09

**Decision:** models produce managed textual source candidates; Factory alone
creates and integrates canonical Git state.

**Ex-ante expectations — IF this decision is right:**

- In 30 days: no new Development execution profile grants LM merge tools; a
  temporary-repository test proves canonical refs do not change before an exact
  Factory effect.
- In 90 days: at least one full Product Delivery run completes through
  TextSet materialization, sequential integration, candidate freeze,
  verification and Delivery without a model-owned merge.
- In 90 days: a width-one overlapping graph is coalesced or rejected for repair,
  while a disjoint-root fixture demonstrates parallel author production.

**Check trigger:** the first complete real Product Delivery traversal and any
proposal to restore raw `Bash`, shared Git worktrees or LM merge tools.

**What would change my mind:** managed TextSet production proves materially less
reliable or more expensive than a truly OS-isolated Git staging environment in
repeatable, adversarial, end-to-end measurements.

## References

- [ADR-032: Development verifies one integrated candidate](032-development-integrated-candidate.md)
- [ADR-038: Continue from an accepted stage prefix](038-continue-from-accepted-stage-prefix.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- `GUARDRAILS.md`, Signs 002 and 014
