# 073. Finish ADR-053 with an exact-presentation clean cutover

- **Status:** Accepted
- **Date:** 2026-08-16
- **Supersedes:** compatibility recovery introduced by `7fb53ea6`
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

ADR-053 requires WorkerExecution to remain provenance and forbids consumers from
recovering accepted material through `latest`, task, execution, or presenter
chronology. Commit `7fb53ea6` restored a production fallback that selects the
latest completion row and then the latest sealed revision when a verifying
Workplace has lost its exact reservation. The architecture ratchets correctly
reject this path.

The same stabilization wave also made replay choose the newest capsule for a
semantic replay key and made tracker startup mutate Factory state. These fixes
improve short-term liveness but reintroduce alternative authority paths.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Material correctness | 3 | A wrong recovery choice can pass gates and effects irreversibly. |
| ADR-053 boundary isolation | 3 | The refactor ends only when execution/latest fallbacks are deleted. |
| Crash liveness | 2 | Exact committed work must still redrive after process loss. |
| Implementation cost | 1 | The cutover must be bounded, but cost cannot buy false authority. |
| Testability | 1 | Mutation and temporal tests must prove the boundary. |
| Reversibility | 1 | Code rollback is useful; accepted wrong material is not reversible. |

## Considered options

### Option A — exact presentation plus legacy recovery authorization

Use one immutable presentation commitment for typed and managed material and
bind it exactly to the Workplace. Damaged legacy rows could be repaired by a
separate append-only operator authorization naming exact historic products.

### Option B — clean exact-presentation cutover

Require fresh runtime states to retain an exact presentation/reservation until
the immutable revision is sealed. Remove all recency reconstruction. Missing or
ambiguous legacy authority fails closed and remains audit-readable; validation
and canaries use a fresh database. Replay deduplicates equal payloads and rejects
conflicting payloads for one semantic key. Recovery runs in the controller, not
the tracker.

### Option C — keep active reservation as long-term material authority

Delete only the newest-row SQL and continue treating
`active_reservation_ref`/WorkerExecution as the canonical verifying material
coordinate.

## MCDA matrix

Scores use 1 (poor) through 5 (excellent).

| Option | Correctness (3) | Isolation (3) | Liveness (2) | Cost (1) | Testability (1) | Reversibility (1) | Weighted total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 5 | 5 | 5 | 3 | 5 | 4 | 52 |
| B | 5 | 5 | 3 | 4 | 5 | 4 | 49 |
| C | 3 | 2 | 3 | 5 | 4 | 5 | 35 |

The top two are close. Option A initially leads through legacy liveness, but
that advantage depends on safely re-deciding missing historic authority.

## Pre-mortem

Assumption: Option A was implemented and failed six months later.

1. **Legacy recovery became a permanent second authority protocol** —
   likelihood high; detected by new recovery-specific branches; mitigation:
   remove the protocol and fail closed.
2. **An operator authorization laundered incomplete material** — likelihood
   medium; detectable only after a downstream mismatch; mitigation: do not
   authorize an authority fact that was never durably recorded.
3. **Typed and managed commitment writers drifted** — likelihood medium;
   detectable by cross-source invariance tests; mitigation: one exact ingress
   contract and no compatibility reader.
4. **Migration work extended the refactor indefinitely** — likelihood high;
   detected by legacy tables remaining in production composition; mitigation:
   fresh-DB cutover and a deletion ratchet.

**Net effect:** Option A is demoted; choose Option B.

## Red Team

**Strongest argument against Option A:** a missing exact authority pointer
cannot be reconstructed without making a new semantic decision. If immutable
facts determine it uniquely, a one-time migration should write the normal
pointer; if they do not, an operator authorization merely turns a guess into
authority.

**Source in repo:** ADR-053 requires old execution-scoped lookups to be removed,
and ADR-072 already refuses to reinterpret unpinned legacy typed cells.

**Response:** accepted. The cutover does not add a legacy authorization path.

## Decision

Choose **Option B — clean exact-presentation cutover**.

Fresh executions must preserve the exact presentation coordinate through
revision sealing. Runtime never reconstructs it by recency. Old rows missing
that fact fail with a typed invariant and are not resumable through canonical
production. Replay selection is semantic: one key may have repeated aliases
only when their payload hashes agree; conflicting hashes fail closed. Tracker
startup is observational only. Transition-obligation consumers handle every
state exhaustively.

The runtime handoff list is deliberately limited to transitions that genuinely
cross an asynchronous ownership boundary:

1. final presentation commitment -> close the exact presentation;
2. sealed CandidateSet -> run its exact Gate;
3. accepted final Gate -> run post-acceptance effects;
4. completed effects -> record the exact Cell FinalAcceptance;
5. terminal ProcessRun settlement -> route the enclosing lifecycle.

An author Gate preceding a reviewer does not emit an effects obligation. A Cell
FinalAcceptance does not settle its ProcessRun: only `GenericFlowExecutor`, after
the terminal flow node is complete, owns that factual transition and records the
`process-settled` routing obligation in the same boundary. Consequently there is
no `settle-process` compatibility handoff and no deferred handler waiting for a
future obligation to perform the transition it claims to represent.

A successful immutable CheckReceipt is itself validation evidence. Auxiliary
`evidenceRefs` are allowed to be empty when the pinned provider has no separate
evidence artifacts; settlement must not reject such a receipt merely because
its auxiliary list is empty.

## Consequences

**Positive:**

- removes the last known post-seal recency fallback;
- gives replay one deterministic semantic outcome;
- restores observer/controller separation;
- defines a finite, mechanically checked end to ADR-053.

**Negative:**

- damaged historical databases may be audit-only and require a fresh run;
- no automatic salvage is attempted when the exact presentation fact is absent;
- tests and operational scripts must be reconciled with the clean boundary.

**Neutral / follow-ups:**

- run scripted L3/L4 E2E and real canaries only on fresh databases;
- retain old DBs as incident evidence;
- do not weaken ratchets or quarantine active architecture tests.

## Implementation evidence

The clean cutover was exercised against a fresh scripted Factory database after
the transition ownership changes. All nine production-faithful scenarios
passed: happy path, deterministic replay, cross-execution crash/recovery,
reviewer rejection/repair, and carry-forward authority (including determinism
variants). The completed Development run reached a verified settlement and
local-readiness pass with no active WorkerExecution and no pending transition
obligation.

## Decision Journal

**Date:** 2026-08-16

**Decision:** finish ADR-053 by deleting compatibility inference rather than
adding another recovery authority.

**Ex-ante expectations:**

- In 30 days: zero production material queries use execution/task/latest after
  seal, and architecture plus acceptance matrices are green without raising a
  baseline.
- In 90 days: crash tests and three language canaries require no
  incident-specific material-authority fallback.

**Check trigger:** any proposal to recover material from `latest`, presenter,
task, execution, or mutable tracker state.

**What would change my mind:** a real material source that cannot be represented
as an exact immutable ProductRef/presentation before Gate despite a canonical
Factory-owned transaction.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-072](072-durable-final-presentation-commitment.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
