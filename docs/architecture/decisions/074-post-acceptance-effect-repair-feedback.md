# 074. Persist post-acceptance effect repair feedback as exact causal evidence

- **Status:** Accepted
- **Date:** 2026-08-16
- **Extends:** ADR-053 and ADR-073
- **Decision-maker:** autonomous-decision skill

## Context

A Production Cell may pass its final Gate and then receive
`repair_required` from a post-acceptance effect, for example when exact Git
integration detects a conflict. The runtime moved the Workplace back to the
author, but discarded the effect's reason and evidence. Projection could only
construct recovery feedback from a `repair_required` GateDecision, while this
GateDecision must truthfully remain `accepted`.

The missing fact is causal evidence for the effects handoff. It must not become
a second material authority, a fabricated Gate decision, task metadata truth,
or a receipt discovered by recency.

## Decision drivers

| Driver | Weight |
|---|---:|
| Correctness under crash/replay | 30 |
| Isolation from material authority | 25 |
| Implementation cost | 15 |
| Feedback consistency | 15 |
| Testability | 10 |
| Future extensibility | 5 |

## Considered options

1. **Immutable effect-repair issue.** Persist a canonical `RecoveryIssue`
   bound to the exact `AcceptedCandidateAuthority` and exact Workplace
   revision transition. The current Gate head selects it without chronology.
2. **Minimal free-form repair receipt.** Persist the existing reason/evidence
   shape and teach projection to render it.
3. **Universal DeskFeedback ledger.** Replace submission, Gate, and effect
   feedback with one new issue/head protocol in this change.

## MCDA

Scores are 1 through 5; weighted totals are out of 500.

| Option | Correctness | Isolation | Cost | Consistency | Testability | Extensibility | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Immutable effect-repair issue | 5 | 5 | 4 | 5 | 5 | 4 | 480 |
| Minimal free-form receipt | 4 | 5 | 5 | 3 | 4 | 3 | 420 |
| Universal feedback ledger | 5 | 5 | 2 | 5 | 4 | 5 | 440 |

## Pre-mortem

Assume the selected option failed:

1. The issue commits but the Workplace transition does not. Mitigation: write
   issue and CAS transition in one immediate transaction.
2. A crash after transition repeats the external effect. Mitigation: make the
   exact repair receipt a terminal `run-effects` postcondition and check that
   postcondition before invoking the transition handler.
3. Old feedback reappears after a later candidate. Mitigation: resolve only
   from the exact current GateDecision head; never order issue rows by time.
4. Current Workplace state advances before obligation acknowledgement and
   erases proof of the repair transition. Mitigation: bind expected/resulting
   Workplace revisions into the immutable receipt; later revisions preserve
   the postcondition.
5. Loose evidence reaches an agent but is not actionable. Mitigation: normalize
   into the shared, validated `factory.recovery-issue.v1` contract.

## Red Team

The strongest objection was that an issue plus `repair_wait` was insufficient:
the leased `run-effects` obligation could remain in progress across a crash and
repeat the effect, and a later author transition could make current-state proof
disappear. The design was amended to bind the exact obligation source
(GateDecision), accepted authority, and Workplace revision before/after into
the receipt. The reconciler checks this durable postcondition before execution.

A separate mutable feedback head was rejected. The already-existing exact
GateDecision head plus the unique issue for that Gate is a sufficient staleness
pointer: changing the Gate head makes the old issue historical automatically.

## Decision

Choose **immutable effect-repair issue**.

On `repair_required`, the executor builds a validated generic `RecoveryIssue`
whose subjects are the exact CandidateSet, ProductionRevision, accepted
ProductRefs, GateDecision, acceptance digest, and effect identity. In one
transaction the coordinator:

1. writes the content-addressed immutable effect-repair receipt;
2. CAS-transitions the exact Workplace revision from `effect_pending` to
   author `repair_wait`.

The accepted Gate remains unchanged. The receipt is evidence and a transition
postcondition only; it cannot select or accept material. `pending` remains a
retryable effect outcome and `human_required` remains human routing; neither is
converted into product repair.

Projection starts at the current exact GateDecision head. If that decision is
accepted and has one exact repair issue, the next author receives
`factory.acceptance-effect-recovery-feedback.v1` with the stored issue verbatim.
Zero issues means no effect feedback; more than one is an invariant violation.
There is no latest/task/execution lookup.

The `run-effects` obligation is complete when an exact success receipt,
FinalAcceptance, or exact effect-repair receipt with a committed resulting
Workplace revision exists. Redrive checks this before invoking the effect.

## Consequences

**Positive:** effect findings reach the repair worker; accepted Gate history
stays truthful; crash/replay cannot require a second effect call merely to
settle the obligation; later Gates structurally suppress stale feedback.

**Negative:** schema version 11 adds an immutable evidence table; feedback
producers remain three distinct protocols rather than one universal ledger.

**Follow-up boundary:** unify all feedback origins only if their existing
authority models demonstrably drift. Do not broaden this receipt into material
selection or acceptance authority.

## Decision Journal

**Ex-ante 30-day expectation:** no Workplace enters effect-origin author repair
without an exact immutable issue, and no `run-effects` redrive repeats an effect
after that issue/transition committed.

**Ex-ante 90-day expectation:** real canaries expose effect reason/evidence in
the next author's `recovery-feedback.json` without incident-specific prompts.

**Check trigger:** any effect repair observed without feedback, any duplicate
provider invocation after a durable issue, or any proposal to find feedback by
latest execution/task/receipt.

**What would change this decision:** a second effect orchestration model that
requires multiple independent repair outcomes for one exact accepted Gate. In
that case introduce an explicit effect plan and exact per-effect head; do not
use row ordering.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-073](073-finish-adr-053-with-an-exact-presentation-cutover.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
