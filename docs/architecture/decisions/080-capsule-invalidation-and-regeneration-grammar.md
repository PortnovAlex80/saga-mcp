# ADR-080: Capsule invalidation and regeneration grammar

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** throwing on replay mismatch as the terminal handling
- **Program:** Saga Core Renewal, release K9 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

K8 (ADR-079) made replay selection exact-semantic: zero capsules is a typed
miss, one is a hit, divergent payloads under one key fail closed with
`REPLAY_KEY_PAYLOAD_CONFLICT`. What happens AFTER a mismatch is still
"throw and hope": the conflict escapes as a per-card error, the evidence of
WHY the mismatch happened lives only in the error string, and nothing
records that a previously-accepted capsule stopped being usable. Related
mismatches already exist as separate mechanisms:

- K5 resume-compatibility: a changed handler implementation under a pinned
  ProcessRun yields `restart-required` naming the pinned runs — but a
  CAPSULE sealed by the old implementation is not covered by that verdict.
- A capsule's sealing acceptance can later be superseded in a repair cycle;
  the capsule row itself stays "valid" by virtue of existing.
- The ineligibility derivation (K8) ignores a capsule per
  (workplace, rejection) but leaves the capsule globally usable.

None of these is an invalidation: there is no append-only record binding
the mismatch to the exact capsule, package, baseline, and lifecycle that
observed it, and no defined path from "invalid" back to production.

## Decision

### 1. Invalidity is evidence, not a flag

An invalidated capsule is not a mutated row. `factory_replay_capsules`
stays append-only and immutable. Invalidity is a DERIVED fact backed by
append-only evidence rows in `factory_replay_capsule_invalidations`:

```
InvalidationEvidence {
  capsule_ref            // the exact capsule
  reason                 // typed reason (below)
  observed_digest        // what the current authority observes
  expected_digest        // what the capsule was sealed against
  lifecycle_run_id       // the lifecycle that observed the mismatch
  authority_ref          // decision/install/acceptance that observed it
  recorded_at
  UNIQUE (capsule_ref, reason, authority_ref)   // idempotent re-record
}
```

A capsule is ineligible for replay when evidence exists for its ref. As
with K8 ineligibility, this DERIVES from durable rows — no blacklist
aggregate, no status column to drift.

### 2. Typed reasons — closed set

| reason | observed vs expected | raised by |
|---|---|---|
| `payload-conflict` | divergent payload hashes under one replay key | the K8 conflict path (replaces the bare throw with evidence + typed error) |
| `package-changed` | currently-installed package digest vs the capsule's sealing `packageDigest` | claim binding when the module's installed fingerprint moved |
| `acceptance-superseded` | the gate decision lineage that sealed the capsule was superseded by a later non-accept outcome in the repair cycle | settlement/recovery |
| `restart-required` | the pinned ProcessRun's handler-implementation digest changed (K5 verdict) while a capsule for that run exists | production resume |

Adding a reason requires an ADR. Reasons carry the digests they compared,
so evidence is auditable without replaying the decision.

### 3. State grammar and transitions

```
                ┌──────────────────────────────────────────┐
                ▼                                          │
valid ──evidence──▶ invalidated ──dispatch──▶ regenerating ─┘ (normal
                       │                        │           production:
                       │                        │           new CandidateSet,
                       ▔──refuse──▶ refused     │           new gate run,
                            (operator            │           new acceptance,
                             decision,           │           new capsule)
                             terminal)           ▼
                                          regenerated(new capsule_ref)
```

- `invalidated` → `regenerating` is a DISPATCH decision, not a data
  mutation: the next claim for the same work simply resolves a miss (the
  evidence suppresses the old capsule) and takes the normal selected
  route.
- `regenerated` is reached when the normal production path seals a NEW
  capsule for the work; the evidence row gains `successor_capsule_ref`.
  The old capsule and its acceptance history are NEVER edited.
- `refused` is an explicit operator terminal decision (bounded recovery
  exhausted) recorded as evidence with reason `refused`; it must not be
  reachable silently.
- No state may loop forever: `regenerating` either converges to
  `regenerated`, transitions to `refused` via the typed recovery budget,
  or the lifecycle terminates with its own terminal outcome.

### 4. Regeneration goes through the normal production path

There is no "patch the capsule" lane. Regeneration = the workplace
produces a new CandidateSet, the current gates run, a new acceptance
seals a new capsule via the existing capture path. Inheritance of the
old acceptance is structurally impossible: acceptance authority flows
from gate decisions, and a new candidate set has new decisions.

### 5. No anonymous park

A replay mismatch must resolve to a typed outcome:
`repair_required` (RecoveryIssue routed to the repair node),
`regenerate` (normal production), `refuse` (operator terminal), or the
lifecycle's own terminal outcome. Parking a card with an anonymous
escalation reason — mismatch information living only in a log string —
is forbidden and ratcheted (K9 commit 6).

## Consequences

- The third-lifecycle theorem becomes statable: lifecycles N, N+1, N+2
  over one epic/workplace family converge exactly-once under crash
  injection at bind / invalidate / regenerate / seal, from clean AND
  upgraded databases, with no recency selector and no manual repair.
- `REPLAY_KEY_PAYLOAD_CONFLICT` remains a fail-closed invariant violation
  at selection time, but now also PERSISTS evidence first — the throw is
  the alarm, the evidence row is the audit trail.
- The K5 restart-required verdict and the capsule world share one
  vocabulary (`restart-required`), unifying run-level and capsule-level
  mismatch handling.
