# ADR-086: Atomic greenfield authority cutover

- Status: Proposed
- Date: 2026-08-21
- Builds on: ADR-053, ADR-076, ADR-082, ADR-085
- Implementation plan: `docs/plans/PROJECT-STRUCTURAL-CLEANUP-PLAN.md`

## Context

The repository has several instances of the same structural defect:

- `src/db.ts` claims a clean pre-release foundation while runtime code still
  contains compatibility DDL and repository-local schema creation;
- `src/lifecycle/application-service.ts` is documented as a facade that calls
  handlers in `src/tools/dispatcher.ts`, while the dispatcher still owns SQL;
- factory construction is spread across `composition-root.ts`,
  `product-lifecycle-runtime.ts`, `factory-start.ts`, CLI bootstrap and the
  scripted harness;
- mutable `lastFactory*` handles and process-global registries bridge those
  construction paths;
- architecture tests contain path classifiers and sanctioned-writer lists that
  do not cover the actual composition and module infrastructure roots;
- multiple files between 1,000 and 3,124 lines combine coordination, policy,
  persistence and projection responsibilities.

The project has no deployed production environment, persistent production
database, customer data or non-terminal run population. There is no need for a
data migration, compatibility period, dual-read, dual-write, feature flag or
historical executable registry. Test databases are disposable fixtures.

The decision fork is whether to repair each subsystem as a separately complete
stage, cut the connected authority graph in one clean-break train, or redesign
the repository around a new universal bounded-context topology.

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Correctness and single authority | 25 | ADR-053 forbids parallel representations and ambient authority |
| Greenfield simplicity | 20 | There is no deployed state that justifies compatibility code |
| Agent readability | 15 | Ownership and entrypoints must be discoverable without global search |
| Testability | 15 | Every authority transition needs deterministic and temporal proof |
| Implementation and bisectability | 10 | Agents need reviewable work packets even when merge is atomic |
| Boundary alignment | 10 | Domain, application, ports and adapters must have enforceable direction |
| Reversibility | 5 | The repository change must be revertible as one unit |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: Ownership-first staged clean breaks

Purge schema compatibility, then finish lifecycle authority, then consolidate
composition, then split large files. Each stage attempts to delete its old path
before the next stage begins.

Pros:

- reviewable and locally bisectable;
- reuses current directory boundaries;
- limits the number of files changed by each nominal stage.

Cons:

- the stage boundaries do not match the actual dependency cycle;
- schema bootstrap calls registries and repository-local DDL;
- lifecycle, dispatcher, assignment and composition use global side channels;
- a stage cannot reach zero legacy without modifying later stages.

### Option B: Atomic greenfield clean-break train

Freeze behavior, build the complete target schema, command, tool and
composition graph in stacked work packets, then switch every host and delete
all old paths in one merge unit. Split large files mechanically after the
authority graph is stable. No intermediate repository state is declared a
supported architecture.

Pros:

- follows the real authority dependency cycle;
- leaves one runtime path after merge;
- uses the greenfield premise fully;
- prevents temporary facades from becoming permanent.

Cons:

- broad branch with import and fixture churn;
- requires strict file ownership between parallel agents;
- merge is blocked until every authority and test gate is complete;
- careless extraction could hide a semantic change in a structural diff.

### Option C: Repository-wide bounded contexts

Replace the current top-level layout with a universal `contexts/`, `kernel/`,
`adapters/`, `bootstrap/` and `hosts/` architecture. Every context gets a
public surface, installer, schema contribution and tool contribution.

Pros:

- strongest uniformity and long-term agent navigation;
- explicit ownership for tables, tools and handlers;
- clean host and adapter separation.

Cons:

- introduces a new architecture before current authority is consolidated;
- much larger import and naming churn;
- risks generic abstractions that are not supported by a second consumer;
- retains more schema evolution machinery than the current greenfield state
  requires.

## MCDA matrix

| Option | Correctness 25 | Greenfield 20 | Readability 15 | Testability 15 | Bisectability 10 | Boundaries 10 | Reversibility 5 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Staged clean breaks | 5 | 5 | 4 | 5 | 4 | 5 | 4 | 470 |
| B. Atomic clean-break train | 5 | 5 | 5 | 5 | 2 | 5 | 3 | 460 |
| C. Universal bounded contexts | 4 | 3 | 5 | 4 | 2 | 4 | 3 | 370 |

The first two options are within ten percent. Reversibility initially favors
Option A, but only if its stage boundaries are real. Red Team evidence showed
that they are not.

## Pre-mortem on Option A

Assumption: Option A was implemented and failed six months later.

1. The schema phase could not delete repository DDL because construction still
   depended on it. Likelihood: high. Detection: legacy grep never reaches zero.
2. Lifecycle commands moved, but dispatcher and global route hooks remained.
   Likelihood: high. Detection: two mutation entrypoints remain reachable.
3. Temporary compatibility exports became permanent. Likelihood: medium.
   Detection: architecture exceptions stop shrinking.
4. Mechanical file splits introduced circular dependencies. Likelihood:
   medium. Detection: lazy imports or new shared dumping grounds appear.
5. The plan stalled after locally green tests that did not exercise canonical
   composition. Likelihood: high. Detection: the scripted harness constructs a
   different graph from the CLI/runtime hosts.

Net effect: Option A is replaced. Its useful review decomposition is retained
inside Option B, but its intermediate states are not supported merge targets.

## Red Team

The strongest objection was that schema bootstrap, lifecycle commands, tool
completion, worker assignment and composition form one strongly connected
authority graph.

Repository evidence:

- `src/db.ts` imports application registration and calls schema functions owned
  by several process-module repositories;
- `src/app/composition-root.ts` configures routes in `tools/dispatcher.ts` and
  publishes mutable `lastFactory*` handles;
- `src/lifecycle/application-service.ts` lazy-loads dispatcher handlers because
  the two modules already form a cycle;
- the same transition spans `dispatcher.ts`, `factory-start.ts`,
  `production-cell-node-executor.ts`, `generic-flow-executor.ts` and
  `product-lifecycle-runtime.ts`.

Response: accepted. The decision switches from A to B. Work remains organized
as bounded packets, but schema, lifecycle, tool gateway and composition are
merged only as one complete clean-break authority graph.

## Decision

Choose Option B: one atomic greenfield clean-break train.

The train has reviewable internal packets and explicit ownership, but no packet
may establish a second runtime, compatibility facade or supported partial
topology. The merge gate switches every host to one immutable composition,
creates only the fresh target schema, routes lifecycle mutations through typed
application commands and repository ports, and deletes all old paths. Large
files are then split by responsibility using extraction-only changes and the
same canonical composition tests.

## Consequences

Positive:

- one authority graph, one schema bootstrap and one composition object;
- no migration code for state that does not exist;
- lifecycle tools become adapters rather than business logic owners;
- architecture tests check the real topology rather than historical paths;
- large files are split along named ownership seams.

Negative:

- the branch is broad and must be protected from unrelated edits;
- agents cannot merge partial authority packets independently;
- baseline, differential and mutation tooling must exist before the cutover;
- package and fixture digests will be regenerated.

Neutral follow-ups:

- if persistent deployment begins later, schema evolution requires a new ADR;
- ADR-082 remains closed: built-in catalogs are explicit and source-controlled;
- workshop details remain governed by ADR-085 and its implementation plan.

## Decision Journal

Date: 2026-08-21

Decision: replace the connected schema/lifecycle/tool/composition authority
graph in one greenfield clean-break train, then split large files mechanically.

Ex-ante expectations:

- At merge, runtime source contains zero `ALTER TABLE`, repository-local schema
  creation, dispatcher-owned lifecycle SQL, mutable `lastFactory*` handles and
  competing composition constructors.
- At merge, CLI, MCP, worker and scripted tests receive the same composition
  fingerprint.
- Within 30 days, no architecture allowlist grows and no new file exceeds the
  size budgets without an explicit expiring exception.
- Within 90 days, an agent can locate every table, command, tool and runtime
  binding owner from generated topology documentation.

Check trigger: completion of the clean-break merge or any proposal to add the
first persistent deployment.

What would change this decision: evidence that a real persistent environment or
external consumer must survive the refactor, or proof that the authority graph
can be split into independently closed components without compatibility paths.

## References

- `AGENTS.md`
- `GUARDRAILS.md`
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/076-implementation-closure-protocol-and-legacy-zero-certification.md`
- `docs/architecture/decisions/082-kernel-admission-boundary.md`
- `docs/architecture/decisions/085-co-locate-workshops-before-opening-admission.md`
- `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`
