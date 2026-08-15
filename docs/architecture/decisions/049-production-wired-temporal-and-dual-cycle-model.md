# ADR-049: Production-wired temporal conformance with a shadow dual-cycle model

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

ADR-048 added temporal conformance over the canonical Factory composition after
a legal local state stopped progressing. The first implementation now passes
31 temporal tests, but two proof gaps remain:

- scripted tests replace the complete `WorkerExecutorFactory`, not inference
  alone, so production runner/workspace/MCP/finalization parity is incomplete;
- the Development scenario emitted no dependency edges, making dependency
  admission untested by a real non-empty graph.

The next requirement is broader: prove workshop-to-workshop movement and the
two synchronized cycles—Kanban semantic phase and engine/Workplace execution
state—before a clean GLM-4.7 run with concurrency two.

Cynefin classification: **complicated with complex scheduling behaviour**.
Local transition rules are knowable; composed schedules require production
traces and generated fault schedules.

## Decision drivers

| Driver | Weight | Why it matters |
|---|---:|---|
| Correct safety and liveness result | 30 | Green tests must reject silent stalls and illegal cross-cycle combinations |
| Production fidelity | 25 | Tests may replace inference, never Factory physics |
| Diagnosis and minimal counterexamples | 15 | Failures must identify the missing synchronization boundary |
| Delivery within the current stabilization run | 15 | A clean real E2E is required after the deterministic gates |
| Reversibility | 15 | Test architecture must not become a second runtime authority |

## Considered options

### Option A — Production-wired temporal campaign only

Extend ADR-048 with one cold Product Build campaign. Inject a scripted process
at the production runner's existing spawn seam; observe exact stage handoffs,
Workplace/task projection convergence, dependency admission, effects and the
`verified-local` terminal. This is the smallest production-faithful option,
but explores only hand-authored schedules.

### Option B — Temporal campaign plus shadow three-machine differential model

Use Option A as the mandatory L3/L4 gate and add three small non-authoritative
reference machines: Workshop/Workplace, Engine/WorkerExecution, and
Pipeline/Lifecycle. Generate valid and adversarial traces, shrink failures,
compare them with pure reducers/SQLite, then replay selected traces through the
canonical temporal driver. The model amplifies the real-composition gate and
never authorizes production transitions.

### Option C — Causal invariant/obligation ledger now

Atomically append a durable obligation at every cross-machine transition,
claim it with a fence, record immutable completion receipts, and reconcile
overdue obligations. This most directly prevents “enabled but never invoked”
stalls, but requires a broad production authority/schema migration before the
current clean E2E can be trusted.

## MCDA matrix

Scores are 1 (poor) through 5 (excellent).

| Option | Correctness (30) | Fidelity (25) | Diagnosis (15) | Delivery (15) | Reversibility (15) | Weighted / 500 |
|---|---:|---:|---:|---:|---:|---:|
| A. Temporal only | 4 | 5 | 4 | 5 | 5 | 455 |
| B. Temporal + shadow model | 5 | 5 | 5 | 3 | 5 | 470 |
| C. Obligation ledger now | 5 | 5 | 5 | 1 | 2 | 395 |

**Sanity check:** B wins narrowly because it preserves A's production fidelity
while covering schedules that hand-authored tests omit. C is the strategic
escalation, not a safe incidental patch during this stabilization run.

## Pre-mortem

Assumption: Option B failed six months later.

1. **The shadow model became a second truth.** Likelihood: medium; detectable
   by differential failures; mitigation: canonical temporal replay remains the
   mandatory oracle and model code has no production imports or authority.
2. **Scripted workers stayed unrealistically perfect.** Likelihood: high;
   detectable by real-model canaries; mitigation: negative protocol traces and
   one monitored GLM-4.7 E2E after deterministic gates.
3. **Generated liveness failures assumed an unfair scheduler.** Likelihood:
   medium; detectable from shrunk traces; mitigation: arbitrary fault prefix
   followed by a declared fair-drain suffix.
4. **The non-empty DAG fixture still failed to prove admission order.**
   Likelihood: medium; mitigation: require at least one durable edge and record
   claim/start timestamps or transition sequence, never return green on zero.
5. **Production still lost a cross-machine wake-up.** Likelihood: medium and
   severe; mitigation: if such a trace passes both deterministic layers,
   promote Option C's obligation ledger in a new ADR.

**Net effect:** Option B survives with mandatory differential replay,
non-vacuity guards and the ledger escalation trigger.

## Red Team

**Strongest argument:** test observers cannot prevent production from losing a
transition. Only a durable obligation written atomically with the source
transition makes the next action owned, replayable and reconcilable.

**Source in repo:** the escaped state was
`WorkerExecution=exited, Workplace=verifying, Candidate/Gate=absent`; the host
was alive but never invoked the next legal command.

**Response:** accepted as the strongest long-term design. It does not replace
the immediate need to establish production-faithful deterministic evidence.
Adding a new authority ledger before that evidence would widen the blast radius
and still require the same temporal gate. Option C becomes mandatory if a
future real stall passes both Option B layers.

## Decision

Choose **Option B**. First complete the production-wired temporal campaign and
inference-only scripted runner, then add a small shadow dual-cycle model with
generated/shrunk traces and canonical replay. Only after these gates pass may
the clean GLM-4.7 Product Build run. Delivery/DevOps and human approval are not
part of that lifecycle; human acceptance begins after local startup.

## Consequences

**Positive:**

- exercises real Factory wiring while replacing only inference;
- makes cross-workshop handoffs and dual-cycle synchronization observable;
- finds schedule-dependent counterexamples without creating a second runtime;
- keeps the real-model run a canary rather than the correctness oracle.

**Negative:**

- increases deterministic suite duration;
- requires a trace generator/shrinker and strict model/runtime differential;
- does not itself repair lost transition obligations in production.

**Follow-ups:**

- make the Development scripted graph non-empty and non-vacuous;
- inject scripting through the production spawn seam;
- add workshop handoff and live dual-cycle conformance assertions;
- update the Conveyor Mental Model and Testing Strategy;
- preserve minimized traces under `tests/factory-model/regressions/`.

## Decision Journal

**Date:** 2026-08-10  
**Decision:** Use production-wired temporal conformance as the mandatory gate,
amplified by a shadow three-machine differential model.

**Ex-ante expectations:**

- In 30 days, every Product Build workshop edge and every legal dual-cycle
  synchronization has a deterministic real-composition trace.
- In 90 days, schedule regressions produce minimized trace fixtures instead of
  frozen UI incidents.
- The next clean GLM-4.7 project reaches `verified-local` without DB mutation,
  manual kicks, human approval, or Delivery/DevOps.

**Check trigger:** any real Factory stall or any change to runner, dispatcher,
Workplace reducer, lifecycle routing, or product-build composition.

**What would change my mind:** a real stall whose normalized trace passes both
the canonical temporal campaign and the differential model. That promotes the
durable obligation ledger from follow-up to required architecture.

## References

- [ADR-048](048-temporal-conformance-over-canonical-composition.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- [Testing Strategy](../../design/TESTING-STRATEGY.md)
- [GUARDRAILS](../../../GUARDRAILS.md)
