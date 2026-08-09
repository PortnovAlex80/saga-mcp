# 037. Recover terminal Development integration conflicts in place

- **Status:** Proposed
- **Date:** 2026-08-09
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

Factory Run 1 completed Discovery and Formalization and produced Development
work before terminating with `PRODUCTION_CELL_INTEGRATION_CONFLICT: task 14`.
The database retains 22 artifacts, 22 CandidateSets and 17 certified replay
capsules. Product Git retains task 15 integrated on `dev` at `60bebb8`, task 14
at `4d19cf3`, and task 16 at `f4e1a5a`.

Plain resume is unavailable by design because the lifecycle, current stage and
process are terminal `failed`. The existing recovery commands cover only a
paused submission-preflight incident and a failed provider-plan gate. A new
Factory Start would preserve history and replay compatible upstream production,
but the repository base changed from `e917a23` to `60bebb8`; Development
ReplayKeys include that base. A clean new run should therefore be expected to
repeat roughly 15 Development model executions.

The incident also exposed missing `task_dependencies`: the accepted task graph
declared dependencies but no durable edges were materialized. Any recovery that
does not repair this projection can reproduce the same conflict.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Preserve accepted production | 30 | Two completed stages and accepted Development work must not be manufactured again. |
| Safety and invariant correctness | 25 | Recovery crosses terminal state, Git integration and review authority. |
| Model/time cost | 15 | A new run would repeat substantial paid Development work. |
| Auditability | 15 | Old acceptance, conflict and replacement review must remain distinguishable. |
| Reversibility | 10 | A failed recovery must leave evidence and repository refs recoverable. |
| Operational readiness | 5 | Existing commands are preferred only when they are actually safe. |

## Considered options

### Option A — Plain resume

Invoke the current resume command and rely on durable cursors. This is cheapest
in theory but correctly rejected by `resolveFactoryResumeTarget`, which accepts
only `created`, `running` or `paused`. Broadly reopening terminal rows would
bypass the incident-specific safety proof.

### Option B — New Factory Start with capsules

Create a new lifecycle and let replay reuse compatible production. Discovery
and Formalization provide 12 strong replay candidates. The changed Git base
invalidates the Development planner and downstream implementation semantics, so
the four existing Development capsules must not be assumed reusable. This is
the safest fallback if targeted recovery invariants cannot be proved, but it
duplicates significant production.

### Option C — Guarded same-run Development recovery

Add a single-use recovery authorization for this exact terminal integration
incident. Preserve completed stages, planner evidence and task 15. Reconstruct
the exact dependency graph, continue task 16's existing reviewer repair, and
only then rework task 14 from the dependency-complete integration head. Because
conflict resolution changes its commit/tree, task 14 produces a new CandidateSet
and passes a new review before normal integration. Old products remain immutable
audit evidence.

## MCDA matrix

Scores are 1 (poor) to 5 (strong); totals are score × weight.

| Option | Preservation (30) | Safety (25) | Cost (15) | Audit (15) | Reversible (10) | Ready (5) | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Plain resume | 5 | 1 | 5 | 1 | 2 | 1 | 290 |
| B. New start | 2 | 4 | 2 | 4 | 4 | 5 | 315 |
| C. Guarded recovery | 5 | 5 | 4 | 5 | 4 | 2 | 460 |

The readiness score prevents treating the preferred design as already safe.
Until Option C is implemented and verified, Option B is the safe fallback and
Option A remains prohibited.

## Pre-mortem

Assume guarded recovery shipped and later lost or duplicated production.

1. **Too much lifecycle state reopened** — likelihood M; detect by unchanged
   upstream hashes/certificates; mitigate with exact row CAS and node identity.
2. **Dependency reconstruction is incomplete** — likelihood H; detect by exact
   graph-to-edge comparison; fail closed on missing/extra/unknown/cyclic edges.
3. **Rebased task 14 bypasses review** — likelihood H; detect by source/tree
   binding; require new author and reviewer CandidateSets and GateDecision.
4. **Git succeeds while DB authorization fails, or vice versa** — likelihood M;
   detect through intended-base/commit receipts; make recovery idempotent and
   compensatable at every DB/Git boundary.
5. **Task 16 repair state is reset** — likelihood M; detect by snapshot equality;
   preserve its revision, budget, feedback and next reviewer role exactly.

**Net effect:** Option C survives only with all mitigations as acceptance
criteria; otherwise choose Option B.

## Red Team

**Strongest argument against Option C:** the live state is heterogeneous, not a
single failed card. Task 15 is merged, task 14 is terminal accepted but
integration-conflicted, and task 16 is pending while its Workplace is in
reviewer `repair_wait`. A generic reopen could repeat accepted cells, integrate
an obsolete reviewed SHA, or corrupt task 16. New Start naturally recomputes
Development against the actual repository base and is safer today.

**Response:** incorporated. Recovery is not a status flip. It must use a typed,
single-use authorization; snapshot DB and Git refs; verify exact repository and
evidence hashes; reconstruct dependency edges; preserve task 16; re-enter only
the Development implementation node; and force new task 14 production/review.
If any precondition is unavailable, recovery denies and New Start becomes the
operator fallback.

## Decision

Chose: **Option C — guarded same-run Development recovery**, pending
implementation and tests.

It best preserves accepted production and minimizes model cost while retaining
auditability. Its current readiness is low, so no factory launch is authorized
by this decision alone. Plain Resume and checkpoint rollback are prohibited for
this incident. New Start remains the explicit safe fallback if the recovery
proof cannot be completed.

## Consequences

**Positive:**

- Discovery, Formalization, planner output and task 15 are never rerun.
- Old task 14 acceptance/conflict remains evidence rather than being rewritten.
- Only materially changed conflict repair receives bounded new production and
  review.

**Negative:**

- A new recovery authority, dependency migration and DB/Git crash protocol are
  required before operations may resume.
- The terminal factory remains stopped while those safeguards are implemented.

**Neutral / follow-ups:**

- Add `--recover-integration-conflict` as mutually exclusive with existing
  recovery flags.
- Add exact graph → dependency → desk-base tests with overlapping files.
- Add crash tests at each authorization, desk and integration boundary.
- Record structured conflict evidence instead of only `integration_state`.

## Decision Journal

**Date:** 2026-08-09
**Decision (one line):** Preserve Factory Run 1 and recover only the failed
Development integration path under exact authorization.

**Ex-ante expectations** — IF this decision was right, I expect:

- In 30 days: the recovered run reaches Delivery without a new Discovery,
  Formalization, planner, or task-15 model execution.
- In 90 days: every integration-conflict recovery test proves old CandidateSets,
  certificates and integrated commits unchanged and requires fresh review for a
  changed source tree.

**Check trigger:** the first attempted resume of Factory Run 1 and every later
`PRODUCTION_CELL_INTEGRATION_CONFLICT` incident.
**What would change my mind:** inability to reconstruct exact dependency edges
or prove the repository/evidence lineage without mutation; in that case use a
new Factory Start.

## References

- [ADR-032: Development integrated candidate](032-development-integrated-candidate.md)
- [ADR-033: Durable submission preflight recovery](033-durable-submission-preflight-recovery.md)
- [ADR-035: Replay sealed CandidateSet after provider-plan failure](035-replay-sealed-candidate-after-provider-plan-failure.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- `GUARDRAILS.md`, Signs 002 and 012
