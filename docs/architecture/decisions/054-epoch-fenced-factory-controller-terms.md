# 054. Epoch-fenced Factory controller terms

- **Status:** Accepted
- **Date:** 2026-08-11
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

A killed orchestration host can leave `factory_launch_requests` active and one or
more WorkerExecutions durable as `running`. A later resume cannot create a new
launch because the one-active-launch invariant correctly rejects it. The only
component that can establish the durable `lost` worker fact is supervision, but
supervision previously started only after a new host had claimed a launch. This
is a circular admission dependency.

The legacy orphan-launch recovery also requires exactly one lost execution. At
the production concurrency limit of two, a single controller crash can leave a
cohort of two workers, so selecting a "latest" execution would confuse worker
provenance with launch-level controller authority. ADR-053 requires durable,
fenced transition obligations and forbids such latest-execution authority.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority correctness | 3 | Controller ownership must not be inferred from one worker row. |
| Autonomous liveness | 2 | Plain resume must break the bootstrap cycle without DB edits. |
| Existing architecture alignment | 2 | Worker supervision remains worker-liveness authority; Launch remains controller scope. |
| Reversibility | 1 | The incident fix must be safely disableable without rewriting products. |
| Delivery cost | 1 | The real E2E is blocked now. |
| Crash-window coverage | 1 | Zero-, one-, and multi-worker crashes must converge. |

## Considered options

### Option A — one-shot supervision before resume admission

Run the existing supervisor once, consume the existing orphan recovery receipt,
then create a fresh resume launch. This is small and reversible, but the existing
receipt and recovery predicate are singular and fail deterministically for a
two-worker crash cohort.

### Option B — engine-administration bootstrap recovery

Place the same one-shot preflight in `EngineProcessAdministration.start` and
derive a fresh launch idempotency key. This covers the UI entry point but retains
the same singular recovery authority and risks divergence from the CLI entry
point.

### Option C — renewable epoch-fenced controller terms

Keep the active LaunchRequest and append a controller term for each host attempt.
A mutable CAS lease names the current epoch/token. After expiry, exactly one new
host adopts the same launch at epoch N+1. Worker supervision then reconciles the
entire durable cohort independently.

## MCDA matrix

Scores are 1 (poor) through 5 (excellent).

| Option | correctness (3) | liveness (2) | alignment (2) | reversibility (1) | cost (1) | crash coverage (1) | Σ |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. one-shot preflight | 5 | 4 | 5 | 5 | 4 | 3 | 45 |
| B. engine bootstrap | 5 | 4 | 4 | 5 | 4 | 3 | 43 |
| C. controller terms | 5 | 5 | 4 | 3 | 1 | 5 | 43 |

**Sanity check:** A's numerical lead depended on treating singular recovery as
adequate. The live concurrency-two counterexample is a release veto, not a
tradeable score; after debiasing, C is the only valid option.

## Pre-mortem

Assumption: controller terms were implemented and failed six months later.

1. **A healthy host loses its lease during a long worker call and is taken over** — likelihood: M; detectable through overlapping term audit; mitigation: independent heartbeat plus fence checks before every controller action.
2. **Only one resume entry point adopts terms** — likelihood: M; detectable by entry-point conformance tests; mitigation: one repository primitive shared by CLI and EngineAdministration.
3. **A stale host continues writing after takeover** — likelihood: M; detectable by stale-token crash tests; mitigation: epoch/token CAS on launch settlement and controller-cycle boundaries, with deeper command fencing as the follow-up.
4. **Legacy launches have no term and become permanently stuck** — likelihood: H during migration; detectable at admission; mitigation: absence of a lease on an active legacy launch is explicitly takeover-available and creates epoch 1.

**Net effect:** option C survives with mandatory heartbeat, shared admission, and
stale-token tests.

## Red Team

**Strongest argument against the leading option:** Option A uses one
WorkerExecution fact to dispose of aggregate controller authority. With
concurrency two, supervision can correctly reap two workers and the legacy
`rows.length === 1` recovery then rejects the truthful state.

**Source in repo:** `recoverOrphanedFactoryLaunch()` in
`src/app/factory-start.ts` requires exactly one lost row; ADR-053 assigns
accepted material to Workplace Production Revisions and requires explicit
durable transition obligations.

**Response:** accepted. The decision switches from A to C. Worker facts remain
supervision evidence; controller ownership moves to a launch-scoped term.

## Decision

Chose: **renewable epoch-fenced Factory controller terms**.

Resume adopts the same nonterminal LaunchRequest only when its controller lease
is absent or expired. The adopter obtains a new epoch and opaque token; the old
token loses controller authority. Supervision starts immediately under the new
host and reconciles any-size worker cohorts. New launches are created only when
there is no active launch for the order.

## Consequences

**Positive:**
- Removes the resume/supervision bootstrap cycle.
- Correctly separates controller liveness from worker liveness and product authority.
- Handles crashes before workers, with multiple workers, and after durable worker output.
- Preserves the LaunchRequest and all prior evidence append-only.

**Negative:**
- Adds lease/heartbeat policy and controller fencing to a critical path.
- Full fencing inside every long-running lifecycle command is a follow-up; the first vertical fences host cycle boundaries and launch settlement.
- Legacy orphan-recovery receipts remain as compatibility evidence.

**Neutral / follow-ups:**
- Add model-based crash schedules for controller GC pauses and competing adopters.
- Fold controller terms into the transition-obligation registry introduced by ADR-053.

## Decision Journal

**Date:** 2026-08-11
**Decision (one line):** Adopt active FactoryLaunch rows through renewable epoch-fenced controller terms.

**Ex-ante expectations — IF this decision was right, I expect:**
- In 30 days: killing a host at any tested boundary followed by plain resume creates no duplicate launch or worker and needs no DB mutation.
- In 90 days: every active launch is explainable as either controlled by an unexpired term or takeover-available.
- In 6 months: orphan recovery no longer depends on a singular lost WorkerExecution.

**Check trigger:** any `FACTORY_LAUNCH_ACTIVE_REQUEST_MISMATCH` during a normal resume, duplicate controller, or stale-token write.
**What would change my mind:** inability to fence controller mutations without propagating epochs through most domain commands; in that case controller ownership must move into the general transition-obligation/outbox substrate.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [Conveyor mental model](../CONVEYOR-MENTAL-MODEL.md)
- [Conveyor transition diagnostics](../CONVEYOR-TRANSITION-DIAGNOSTICS.md)
