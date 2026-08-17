# ADR-081: AuthorityCommit — the proof-backed acceptance command

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** caller-supplied accepted-transition capability on the coordinator
- **Program:** Saga Core Renewal, release K12 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

The gate machinery already persists a complete proof: a GateRun binds the
exact subject CandidateSet, the frozen CheckPlan (`check_plan_ref` +
`check_plan_digest`), the expected workplace revision, and terminates with
immutable CheckReceipts plus an append-only GateDecision (idempotent on
`decision_key`). The production-cell executor then passes the decision KEY
to `coordinator.applyGateDecision`, which performs the accepted CAS
transition and writes the authority head.

The gap: the COMMIT SITE trusts the caller. Nothing between the executor's
assertion and the transition verifies that the referenced decision is
persisted, accepted, final, and about THIS CandidateSet. A forged key, a
decision for another set, or a non-terminal run would sail through the
public capability and write an unverified authority head — precisely the
"caller supplies accepted truth" shape ADR-053 set out to remove.

## Decision

### 1. One acceptance mutation service

`CommitAcceptedCandidate` (application layer) is the ONLY writer of the
accepted transition + authority head. Its command carries REFERENCES ONLY:

```
AuthorityCommitCommand {
  workplaceRef
  gateDecisionKey          // the persisted proof
  acceptedCandidateSetRef  // the claimed subject (verified, not trusted)
  acceptedAuthorTaskId?    // provenance written to the head
  expectedRevision         // CAS fence
}
```

### 2. The proof contract (verified from persisted facts, never caller truth)

Before any mutation, the service LOADS and verifies:

1. **Decision** — `readDecision(gateDecisionKey)` exists; `verdict=accepted`;
   `gate_phase=final`; `decision.subjectCandidateSetRef ===
   acceptedCandidateSetRef` (wrong-candidate proof fails).
2. **Run** — the decision's GateRun exists and `state=terminal` (a decided
   run without terminal receipts is not a proof).
3. **Receipts** — at least one CheckReceipt is recorded for the run, and
   every recorded receipt belongs to that run's check set (the receipts
   address the exact CandidateSet presentation the run bound).
4. **Frozen plan** — the decision carries a non-empty `checkPlanRef` and
   `checkPlanDigest` (the checks ran against the package-frozen plan,
   ADR-077 transitivity).
5. **CAS** — `expectedRevision` equals the workplace's current revision.

Any failure is a typed `AUTHORITY_COMMIT_*` error with ZERO mutation.

### 3. One transaction, idempotent under crash/retry

Verification reads persisted facts OUTSIDE the write; the mutation is ONE
transaction: accepted CAS transition + authority head + applied-decision
head link (the coordinator's existing atomic body, now reachable only via
the service). Crash before the transaction → nothing happened, retry
re-verifies and commits. Crash after → the CAS revision makes the retry a
no-conflict converge (already-applied detection), never a double write.

### 4. The public capability is removed

`coordinator.applyGateDecision` keeps its non-accepted verdicts
(repair/human/failed — no authority head). Its accepted-with-head branch is
DELETED from the public surface; the equivalent `applyVerifiedAcceptance`
entry is callable only by the service (enforced by an architecture ratchet:
one acceptance mutation site in a code search, no executor call supplies
accepted truth directly).

## Consequences

- Forged/mismatched proof negatives become deterministic tests: wrong
  candidate, non-accepted decision, non-terminal run, receiptless run,
  unfrozen plan, stale revision — all fail closed without mutation.
- The executor's acceptance site routes through the service; the C1 head
  pointer and C5-02 task binding semantics are unchanged (same write, now
  proof-gated).
- K13 (accepted head shape + exact settlement identity) builds on this
  single commit site.
