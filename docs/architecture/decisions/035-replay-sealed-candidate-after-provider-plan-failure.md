# ADR-035: Replay a sealed CandidateSet after provider-plan failure

- Status: accepted
- Date: 2026-08-09
- Decision owner: factory architecture

## Context

The architecture author completed successfully and sealed an immutable
CandidateSet. GateRun `gate-run:2a166673...` recorded the product-contract
check as passed, then failed before the SRS check because the legacy check plan
pinned provider `1.0.0` while the canonical runtime provider was `1.1.0`.
Generic lifecycle error handling terminalized LifecycleRun, StageRun and
ProcessRun even though no product verdict had been made.

The user explicitly rejected retaining or aliasing provider `1.0.0`. Recovery
must preserve the accepted author output, remove the legacy version seam, and
remain auditable.

## Options

1. Guarded in-place gate replay: retain the CandidateSet and failed GateRun,
   authorize the canonical replacement CheckPlan, reopen only runtime
   envelopes, and let normal reconciliation derive a new GateRun identity.
2. Requeue the author: discard the verifying state and ask another model to
   reproduce already accepted output under the new plan.
3. Restore a checkpoint into a new database: rerun from the pre-gate snapshot
   and move monitoring to the clone.
4. Register a `1.0.0` compatibility alias: let the legacy plan resolve to the
   `1.1.0` implementation.

## Decision matrix

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | In-place replay | Requeue author | Restore clone | Legacy alias |
|---|---:|---:|---:|---:|---:|
| Product/Candidate integrity | 30 | 5 | 2 | 4 | 3 |
| Removes legacy identity | 25 | 5 | 5 | 5 | 1 |
| Auditability | 20 | 5 | 3 | 4 | 2 |
| Recovery speed / no LLM cost | 15 | 5 | 1 | 2 | 5 |
| Implementation risk | 10 | 3 | 4 | 2 | 4 |
| Weighted result | 100 | 455 | 315 | 370 | 260 |

Choose option 1.

## Decision

- Provider `1.1.0` is canonical. The architecture check ref imports its version
  directly from the provider declaration. No `1.0.0` registration or alias is
  retained.
- The failed GateRun and its passed prefix receipt remain unchanged evidence.
  Recovery never updates or deletes them.
- An immutable authorization pins the failed lifecycle/stage/process/node,
  Workplace revision and producer fence, CandidateSet ref/digest/products,
  accepted submission receipt and artifact hashes, abandoned plan/ref/digest,
  and complete replacement CheckPlan snapshot/digest.
- Recovery is allowed only for the exact provider-version-mismatch incident,
  with one exited-successful author, one accepted `worker_done`, one accepted
  submission receipt, no live workers, no GateDecision, and an unchanged
  CandidateSet plus file-backed artifact bytes.
- Already-passed receipts must be a compatible prefix of the replacement plan.
  The replacement plan must have a different digest and contain the runtime
  version reported by the failure.
- Only the LifecycleRun, StageRun and ProcessRun execution envelopes reopen to
  `paused`. Product rows, task, Workplace, producer reservation, CandidateSet,
  failed NodeRun and failed GateRun remain unchanged.
- Normal resume re-enters `verifying`. Candidate sealing is idempotent and the
  new plan digest derives a new GateRun identity; normal provider execution and
  Conveyor transitions decide the product.

## Pre-mortem and red-team constraints

Likely failures are replaying changed SRS bytes, losing CandidateSet identity,
running two gates concurrently, treating a partially failed check as passed,
or quietly mutating the old GateRun. The implementation therefore verifies
disk and database hashes inside `BEGIN IMMEDIATE`, rejects live leases/workers,
requires every old receipt to be `passed` and byte-compatible with the new
plan, leaves the old run untouched, and records a single-use immutable
authorization/consumption pair before reopening envelopes.

## Consequences

The factory can recover a post-seal infrastructure failure without spending
another model call or weakening product checks. A visible abandoned GateRun is
expected audit evidence; operational projections should use the recovery
authorization to distinguish it from an active inspection.

The generic error classifier still terminalizes provider-registry failures.
This ADR supplies a safe operator recovery, not an automatic retry policy.
Automatic classification requires a separate typed infrastructure-error
contract so arbitrary check failures cannot be reopened as configuration
incidents.

## Decision journal

- 2026-08-09: classified as complicated. Candidate, accepted submission,
  partial CheckReceipt, failed NodeRun and terminal envelopes were inspected.
- Live-data clone preflight exposed that CandidateSet sealing uses a historical
  `JSON.stringify` digest while the first recovery verifier used canonical JSON.
  The verifier now reproduces the owner's byte algorithm exactly; extracting a
  single shared domain digest function is recorded as required follow-up.
- Compatibility aliasing was rejected because it preserves the exact legacy
  identity that caused the outage and makes audit statements ambiguous.
- Author requeue was rejected because it mutates business output to repair a
  control-plane wiring defect.
- In-place replay won the weighted matrix and passed the pre-mortem only with
  immutable authorization plus full lineage/hash checks.
