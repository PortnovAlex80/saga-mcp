# 038. Continue from an accepted stage prefix

- **Status:** Proposed
- **Date:** 2026-08-09
- **Supersedes:** [037. Recover terminal Development integration conflicts in place](037-recover-terminal-development-in-place.md)
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

Factory Run 1 has immutable accepted Discovery and Formalization products, but
its Development attempt failed during Git integration. The first recovery idea
in ADR-037 reopened the same failed lifecycle/stage/process. Deeper analysis
showed that this conflicts with the domain: a `ProcessRun`, `StageRun` and
`LifecycleRun` each have one terminal outcome; `failed -> running` is forbidden.

The operator requires that completed workshops never run again and that
recovery starts from accepted warehouse products, not the original idea. The
exact reusable boundary is the completed Formalization prefix:

- `formalization-solution-contract:1`, hash `ff7a...1de3`;
- `certificate:2`, hash `39ac...acc9`;
- transition handoff hash `de6cf...d1c9`;
- Development input hash `5d1b...d5ef5`.

Checkpoint 26 is not this boundary. It captures the earlier failed
CheckProvider incident, before Formalization completion and before all
Development production. Restore is clone-only and would lose later evidence.

The Git conflict has three deterministic causes:

1. `materializeOne()` admits every fan-out Workplace before dependency checks,
   making the later `idle` dependency gate unreachable.
2. Dependency edges are rebuilt from a transient map of currently queued author
   tasks. Missing predecessors are filtered, then `replaceTaskDependencies()`
   deletes prior edges and persists the reduced set; repeated reconciliation
   eventually produces `[]`.
3. Every author desk reads the original DevelopmentCase
   `expectedBaseCommit=e917a23`; dependent tasks never receive the actual
   post-dependency integration head.

Both task 16 and task 14 conflict against the current `dev=60bebb8` across the
same CSS, HTML and JavaScript files. Their old candidates cannot be integrated
or treated as current acceptance.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Domain purity | 30 | Terminal identities and authority must remain immutable. |
| Preserve accepted upstream production | 25 | Discovery and Formalization must not execute again. |
| Preserve valid partial Development | 15 | Task 15 should become an audited baseline, not be regenerated. |
| Implementation readiness | 10 | Recovery must not be presented as available before its authorities exist. |
| Auditability | 10 | Parent failure, inherited prefix and child outcome must remain visible. |
| Model/time cost | 10 | Repeat only work whose base or authority materially changed. |

## Considered options

### Option A — Reopen the failed ProcessRun

Mutate lifecycle, StageRun and ProcessRun back to a resumable state and repair
task 16 then task 14. This preserves the most partial work but gives terminal
aggregates two effective outcomes and weakens lease/idempotency semantics.

### Option B — Add attempt 2 to the same failed LifecycleRun

Keep failed Development attempt 1 and create StageRun attempt 2. The schema and
projection already support stage attempts, but the LifecycleRun itself is
terminal and cannot lawfully acquire a lease. Un-terminalizing only the parent
still violates single-terminal-outcome semantics.

### Option C — Append-only lifecycle continuation

Create a child continuation in the same business-order lineage. The failed
parent remains terminal. A single-use authorization pins the accepted upstream
prefix, failed incident, package/runtime identities, repository baseline and
adoption evidence. The child executes only Development and Delivery. Inherited
stages are shown as inherited, never as child executions.

Task 15 receives a new baseline-adoption decision after verifying its original
CandidateSets, GateDecision/check receipts, source commit/tree and merge result.
Task 16 and task 14 are historical recovery material only; each produces a
fresh commit, CandidateSet, review and gate on dependency-complete bases.

### Option D — Restore checkpoint 26

Restore a diagnostic clone. This loses accepted Formalization completion, the
fixed artifact forest, all Development history and seven capsules. It cannot
continue production in place and does not restore a Git repository.

### Option E — New full Factory Start

Start Discovery again and rely on capsules. This is operationally available but
violates the minimal accepted boundary and repeats lifecycle/QC work. Changed
Git semantics make Development capsules ineligible.

## MCDA matrix

Scores are 1 (poor) to 5 (strong); totals are score × weight.

| Option | Purity (30) | Upstream (25) | Partial Dev (15) | Ready (10) | Audit (10) | Cost (10) | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Reopen ProcessRun | 2 | 5 | 5 | 3 | 3 | 5 | 370 |
| B. Same-lifecycle attempt | 3 | 5 | 2 | 3 | 4 | 2 | 335 |
| C. Child continuation | 5 | 5 | 3 | 2 | 5 | 3 | 420 |
| D. Checkpoint restore | 4 | 2 | 1 | 3 | 4 | 1 | 265 |
| E. Full new start | 5 | 1 | 1 | 5 | 5 | 1 | 300 |

Option C wins on the two dominant drivers. Its low readiness score is a hard
release gate: no half-continuation or launch is allowed.

## Pre-mortem

Assume continuation shipped and later laundered invalid production.

1. **Inherited prefix is stale or incomplete** — likelihood M; detect by
   re-resolving every ref/hash; mitigate with a signed prefix certificate and
   double-check at authorization and consumption.
2. **Task 15 partial acceptance becomes a fake Development certificate** —
   likelihood H; detect via adoption proof; mitigate with a new baseline
   adoption gate and fresh integrated-candidate/AC verification.
3. **Planner duplicates or removes the adopted foundation node** — likelihood
   H; detect via graph validation; mitigate with first-class
   `adopted/preintegrated` graph nodes which satisfy dependencies but project no
   author task.
4. **Parent failure disappears from the UI/order state** — likelihood M;
   detect through lineage projection tests; mitigate with an OrderRunChain and
   one active leaf, never silent FK repointing.
5. **Old task 14/16 authority leaks into the child** — likelihood H; detect by
   provenance fence; mark old candidates `historical_only` and require fresh
   candidates/reviews/gates.
6. **Git and DB diverge during baseline adoption/integration** — likelihood M;
   detect through durable intent/receipt; use CAS on the branch head and
   idempotent effect recovery.

**Net effect:** Option C survives only as a complete platform feature. Any
missing mitigation blocks continuation and leaves the factory stopped.

## Red Team

**Strongest argument against Option C:** it introduces an aggregate that does
not exist. `FactoryOrder -> LifecycleRun` is currently one-to-one, `buildFrame()`
only sees completed StageRuns in its own lifecycle, and cell-level task 15
acceptance is not stage-level authority. A side-table shortcut could hide the
parent failure, orphan order settlement or promote partial work created under a
broken scheduler.

**Response:** accepted and incorporated. The continuation requires a first-class
`OrderRunChain/Continuation` aggregate, a typed two-stage continuation scenario
or verified prefix injection, composite order settlement, an explicit task-15
adoption decision and visible lineage. We reject a flag, raw FK repoint, forged
completed StageRuns or copied GateDecisions. If the full aggregate is not built,
Option C is not implemented.

## Decision

Chose: **Option C — append-only lifecycle continuation from an accepted prefix**.

This is the only option that simultaneously preserves upstream production and
terminal aggregate purity. It costs more implementation than the incident
overlay, but the user explicitly prioritizes architecture over a shortcut. The
parent failed run remains immutable; the continuation starts at Development
from exact accepted Formalization products and an audited task-15 baseline.

## Consequences

**Positive:**

- Discovery and Formalization do not execute again.
- No terminal row is reopened or rewritten.
- Valid partial code is adopted through authority rather than copied or
  regenerated.
- Recovery becomes a reusable stage-boundary mechanism instead of a
  Development-name exception.

**Negative:**

- Requires a new order-run lineage aggregate and composite settlement.
- Requires continuation-specific prefix and baseline-adoption gates.
- Task 16 and task 14 need fresh production/review on corrected bases.
- The factory remains stopped until the complete feature and E2E tests exist.

**Neutral / follow-ups:**

- Materialize the full fan-out DAG before admitting roots; never delete edges on
  reconciliation.
- Persist a CAS-fenced effective desk-base receipt after dependencies integrate;
  include it in execution context and Git ReplayKey.
- Add adopted/preintegrated graph nodes for task 15.
- Add a real-SQLite multi-turn overlapping-files regression.
- Remove or quarantine the obsolete destructive `tools/saga-reset-stage.mjs`.

## Decision Journal

**Date:** 2026-08-09
**Decision (one line):** Continue the business order through a new append-only
Development/Delivery run linked to the exact accepted upstream prefix.

**Ex-ante expectations** — IF this decision was right, I expect:

- In 30 days: the live continuation invokes no Discovery/Formalization workers,
  keeps all parent terminal hashes unchanged, and reaches fresh Development
  verification from `dev=60bebb8`.
- In 90 days: every terminal stage recovery creates one visible lineage edge,
  no production code contains `failed -> running`, and dependency/desk-base E2E
  tests remain green.

**Check trigger:** first continuation authorization and every request to retry a
terminal stage.

**What would change my mind:** inability to model one canonical business-order
state across the parent/child chain without forged stages or ambiguous
settlement. In that case, retain the stopped parent and use a full new Factory
Start rather than mutate terminal authority.

## References

- [ADR-032: Development integrated candidate](032-development-integrated-candidate.md)
- [ADR-033: Durable submission preflight recovery](033-durable-submission-preflight-recovery.md)
- [ADR-035: Replay sealed CandidateSet after provider-plan failure](035-replay-sealed-candidate-after-provider-plan-failure.md)
- [ADR-037: superseded in-place recovery proposal](037-recover-terminal-development-in-place.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- `GUARDRAILS.md`, Signs 002, 012 and 013
