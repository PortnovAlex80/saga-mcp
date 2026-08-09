# 041. Carry exact author production across terminal continuations

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The first append-only Development continuation preserved the accepted upstream
prefix and task-15 baseline, then produced one managed textual source candidate.
Its author CandidateSet and author GateDecision are exact and accepted. The run
failed later because the reviewer submitted `factory.review-verdict.v1` while
its frozen WorkIntent required `factory.development-review-verdict.v1`.

The candidate was never integrated and never received a reviewer CandidateSet,
final GateDecision, CellFinalAcceptance or ReplayCapsule. Reopening the failed
run is forbidden. Starting a third child and calling the author model again is
lawful but repeats production solely because downstream transport validation
failed. Reusing the old CandidateSet as current authority is also forbidden.

Cynefin classification: **Complex**. This adds a cross-terminal authority path
and must be constrained by an incident-shaped probe, immutable evidence and
current-run gates.

## Decision drivers

| Driver | Weight |
|---|---:|
| Authority correctness | 30 |
| Preserve completed production | 25 |
| Time to safe recovery | 15 |
| Universal architecture fit | 15 |
| Testability | 10 |
| Reversibility | 5 |

Scores use 1 (poor) through 5 (strong).

## Options and MCDA

| Option | Authority | Preservation | Time | Fit | Tests | Reversible | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Run one fresh managed author | 5 | 3 | 4 | 4 | 5 | 5 | 420 |
| B. Bounded author carry-forward | 4 | 5 | 3 | 4 | 4 | 5 | **430** |
| C. Full WorkIntent/carry framework first | 5 | 5 | 1 | 5 | 3 | 4 | 420 |

### A — fresh managed author

Create another suffix continuation and run one author again from the unchanged
base, then a fresh reviewer and current effects. This has the smallest new
authority surface but repeats already accepted author production.

### B — bounded carry-forward

Create one immutable authorization for the exact failure class. The child
seals a new author CandidateSet whose member origin is `carried-forward` and
names the source set. It runs the child package's current author gate, a fresh
reviewer, current final gate, Factory Git effect and final acceptance. No old
decision is copied.

### C — full generic WorkIntent contract framework

First persist complete WorkIntent schema snapshots, cardinality contracts and
generic partial-production adoption policies, then recover through that broad
facility. This is the strategic target but delays recovery and expands the
first deployment beyond the proven incident.

## Red Team

The strongest objection to B is authority laundering: the source has no final
acceptance or ReplayCapsule, and an accepted author gate alone must not convert
arbitrary failed-run bytes into current production.

Accepted mitigations:

- eligibility is exactly post-author/pre-final reviewer-schema mismatch;
- the source author CandidateSet, member ProductRef/digest, author gate digest,
  WorkIntent output schema, semantic item, base commit, source commit/tree/ref
  and unchanged canonical head are reverified;
- any reviewer CandidateSet, final decision or CellFinalAcceptance makes the
  bounded rule inapplicable;
- the child creates a new set and runs current gates; old decisions remain
  evidence only;
- a fresh reviewer is bound to the new current CandidateSet;
- integration consumes the exact CandidateSet member, not a task-local latest
  submission, so cross-process provenance is explicit;
- authorization and consumption records are immutable and single-use.

If any check fails, the system falls back to A; it never weakens the predicate.

## Pre-mortem

Assume B failed six months later:

1. **Wrong historical product was presented.** Likelihood M. Detection:
   CandidateSet/ProductRef digest mismatch. Mitigation: re-resolve every exact
   member and Git object at authorization and consumption.
2. **A changed continuation item accepted stale production.** Likelihood M.
   Detection: item/output-contract mismatch. Mitigation: exact item snapshot
   hash, schema and base comparison; new current gate.
3. **The old reviewer verdict was silently reused.** Likelihood L. Detection:
   target has no fresh reviewer execution/set. Mitigation: carry author members
   only; final gate requires a new reviewer CandidateSet.
4. **Integration looked up the old task instead of the current candidate.**
   Likelihood H before this decision. Detection: current task has no local
   submission. Mitigation: CandidateSet-member-bound integration and reviewer
   desk provisioning.
5. **Crash produced two target sets.** Likelihood L. Detection: duplicate
   presenter/consumption. Mitigation: deterministic presenter identity,
   CandidateSet seal idempotency and unique immutable consumption.

## Decision

Choose **B: bounded author carry-forward**.

This is a generic Production Cell capability keyed by exact contracts and
failure evidence; core code does not branch on Development module names. It is
not ReplayCapsule certification and does not reinterpret the parent. The
bounded predicate is intentionally narrow; the wider WorkIntent contract work
remains a follow-up after the conveyor completes.

## Consequences

Positive:

- Discovery, Formalization, task-15 baseline and the managed author production
  are not repeated;
- terminal parent/child runs remain immutable and visible;
- current-run quality and effect authority are preserved;
- the same mechanism can serve another workshop with an identical declared
  product/failure boundary.

Negative:

- another immutable authorization type and reconciliation path exist;
- source Git objects and product refs must remain resolvable until consumption;
- legacy sources without exact WorkIntent/product evidence fail closed;
- replay capture for a synthetic presenter needs a later provenance-aware
  enhancement; carry-forward itself is not a ReplayCapsule.

## Decision Journal

**Decision:** carry exact author material into a new child CandidateSet; never
copy its old state or decisions.

**Expected evidence:** the next child creates no Discovery/Formalization or
implementation-author worker, creates exactly one fresh reviewer, integrates
only the exact carried product after current final acceptance, and preserves
the canonical head until that effect.

**Check trigger:** first target CandidateSet seal, first reviewer claim, first
Git effect, and any attempt to widen the eligible failure predicate.

**What would change the decision:** inability to prove exact source product,
item, base and failure facts. In that case use a fresh managed author.

## References

- [ADR-038](038-continue-from-accepted-stage-prefix.md)
- [ADR-039](039-model-produces-text-factory-owns-git.md)
- [ADR-040](040-ship-recovery-as-one-authority-complete-vertical.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
