# ADR-048: Temporal conformance over the canonical Factory composition

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

A monitored real-model Factory Start exposed a liveness failure after a worker
completed successfully. The exact `WorkerExecution` was durable `exited` with
exit code zero and the Workplace was legally `verifying`, but no CandidateSet,
GateRun or subsequent NodeRun appeared. The orchestrator process remained alive
and consumed CPU.

Local state was not obviously corrupt. Instead, several legal machines stopped
synchronizing:

```text
WorkerExecution = exited
Workplace        = verifying
Task projection  = in_progress
LifecycleRun     = paused
LaunchRequest    = running
Candidate/Gate   = absent
```

The repository already has strong local transition tests, repository tests,
race tests and scripted E2E tests. They prove many safety properties. Their
worker doubles commonly move process-host status and durable execution status
together, however, and therefore remove the real interleaving that failed.

The architectural fork is whether to add an executable composite statechart,
add a causal invariant/reconciliation ledger, or first test temporal progress
through the exact production composition.

Relevant project constraints:

- one production interface and one Factory runtime;
- terminal authority is append-only;
- projections and telemetry never authorize transitions;
- tests must replace expensive production ports without replacing Factory
  physics;
- no new dependency is introduced without the repository's explicit process;
- architectural decisions and real-bug signs are recorded in Git.

Cynefin classification: **complicated with a complex runtime boundary**. Local
transition relations are knowable, but scheduling/interleaving behavior must be
probed in the real composition.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Correct safety and liveness result | 30 | A green suite must reject the exact silent-stall class without weakening authority |
| Universal Conveyor alignment | 20 | The solution cannot introduce a private workshop/test runtime |
| Regression detection | 20 | Composition, package, provider, host and persistence drift must be visible |
| Diagnosability | 10 | A timeout must identify the exact missing owner/transition obligation |
| Delivery cost | 10 | The Factory is being stabilized now; a multi-month substrate rewrite is unsuitable |
| Reversibility | 10 | The first slice should be additive and non-authoritative |

Scores use 1 (poor) through 5 (excellent).

## Considered options

### Option A — Executable compositional statecharts

Model Launch, Lifecycle, Process, Node, Workplace, WorkerExecution, Candidate,
Gate and Effect as small pure statecharts; compose them through typed
synchronization events; perform bounded reachability/interleaving exploration
and differential checks against SQLite adapters. Generate diagrams from the
same specs. Introduce it in shadow mode before any runtime authority transfer.

This makes the transition vocabulary reviewable and can exhaustively find many
illegal composite states. Its central risk is a second executable truth: the
model must assume that an enabled production transition is eventually
scheduled, which can assume away the host-wiring failure observed in the live
run. State-space growth and model/runtime drift are additional costs.

Reversibility: high while shadow-only. Unknowns: fair-scheduler model,
partial-order reduction, and which existing reducers/tables remain canonical.

### Option B — Invariant ledger and causal reconciliation

Keep bounded aggregate reducers and atomically append causal transition/outbox
obligations. Evaluate a versioned invariant DAG over consistent snapshots;
record reconciliation cases and allow only fenced, idempotent repair commands.
Add stateful shrinking trace tests, temporal properties and reconciliation
fixed-point tests.

This gives the strongest long-term causal audit and safe reconciliation model.
It requires broad writer instrumentation, new durable ledgers and careful
fairness semantics. It still needs a production-composition probe to prove that
the host consumes committed obligations.

Reversibility: high in report-only shadow mode, medium after journal atomicity
becomes mandatory. Unknowns: aggregate ownership across legacy projections,
journal volume and coverage of current cross-repository writes.

### Option C — Temporal conformance over the real composition

Retain current local reducers and repository authorities. Add a deterministic
zero-token harness that imports the exact canonical lifecycle composition,
package/provider registry, SQLite repositories, orchestrator, dispatcher,
gates and effects. Replace only the inference worker port and an explicitly
declared deterministic check provider. Record a durable change-only trace and
assert `eventually`, `never` and `stable-until` properties using host-cycle and
transition budgets. Add fault schedules at every durable boundary and a pure,
observation-only liveness explainer.

This tests the operational theorem the current suite missed: after every
durable landmark, the real host must expose a live owner, a runnable command, a
typed wait, a pending transition obligation, or a truthful terminal state.

Reversibility: very high; the harness is test-only and the explainer is
read-only. Unknowns: a small host-cycle hook and the exact deterministic
verification-provider seam.

## MCDA matrix

The initial matrix gave Option A 460, B 450 and C 450. Red Team demonstrated
that A's liveness score assumed real-host fairness and therefore overstated the
exact quality under investigation. The corrected matrix is:

| Option | Correctness (30) | Alignment (20) | Detection (20) | Diagnosis (10) | Cost (10) | Reversibility (10) | Weighted / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Compositional statecharts | 3 | 5 | 4 | 4 | 2 | 5 | 380 |
| B. Invariant/causal ledger | 5 | 5 | 4 | 5 | 1 | 4 | 430 |
| C. Canonical temporal conformance | 4 | 5 | 5 | 5 | 5 | 5 | 470 |

**Sanity check:** C does not replace exhaustive local safety testing, so it is
not scored 5 for correctness. It wins because the existing L0–L2 tests already
cover local safety and the escaped defect is real-composition liveness. No one
criterion alone determines the result.

## Pre-mortem

Assumption: Option C was implemented and failed six months later.

1. **The test composition drifted from production.** Likelihood: high;
   detectable by a canonical composition fingerprint; mitigation: strict
   overlay allowlist that permits replacement only of inference and declared
   check-provider ports.
2. **Polling missed transient states and produced flaky failures.** Likelihood:
   medium; detectable from repeated seeds; mitigation: assert durable
   change-only traces and host-cycle budgets, not UI polls or arbitrary sleeps.
3. **Temporal thresholds were generous enough to hide deadlocks.** Likelihood:
   medium; detectable from trace budgets; mitigation: every wait declares its
   wake source and bounded escalation, while internal transitions use cycle
   rather than wall-clock budgets.
4. **Scripted workers stayed well-formed while real models violated product
   contracts.** Likelihood: high; detectable by monitored canaries; mitigation:
   retain schema/gate/recovery tests and one optional paid real-model canary,
   never use the canary as the CI oracle.
5. **The explainer became a second repair engine.** Likelihood: low but severe;
   detectable by architecture ratchets; mitigation: make it read-only and
   observation-only. Existing fenced commands remain the only mutation path.

**Net effect:** Option C survives with the overlay fingerprint, durable trace,
cycle-budget and read-only-explainer constraints.

## Red Team

**Strongest argument against the initial leader (A):** an executable
statechart can prove liveness only after assuming that the production host
schedules enabled transitions. The live incident is precisely a legal local
state whose next transition was never invoked. Adapter differential proves
what happens if an adapter is called; it does not prove correct composition
registration, lifecycle selection, provider version, dispatcher wake-up or
ProcessRun routing.

**Source in repo:** pure Production Cell reducer tests deliberately have no
I/O/DB; current scenario composition overrides production policies/providers;
documentation and tests contain both three-stage product-build and older
four-stage Delivery expectations. These can all be locally correct against
different compositions.

**Response:** accepted. The decision changed from A to C. State-machine graphs
remain normative local/synchronization documentation and may later become an
L1/L2 exploration aid, but real-composition temporal conformance is the first
mandatory architecture gate.

## Decision

Choose **Option C: temporal conformance over the canonical Factory
composition**.

The Conveyor Mental Model records each authoritative local machine and every
required synchronization hand-off. These graphs are a protocol/oracle, not a
new global runtime. The missing test layer is L3/L4: temporal composition and
fault-scheduled convergence using real production wiring and deterministic
worker/check ports. A nonterminal run must always have a live owner, runnable
command, typed wait, or committed transition obligation; otherwise it is a
typed stall. Local statechart exploration may be added later only as an
amplifier and must never replace this temporal gate.

## Consequences

**Positive:**

- catches legal-state/no-next-action stalls and canonical-composition drift;
- preserves existing local reducers and one-runtime architecture;
- distinguishes safety, liveness, projection and telemetry theorems;
- produces actionable incident evidence rather than a generic timeout;
- zero-token CI can exercise the same contracts/tools as real-model workers.

**Negative:**

- real process/SQLite/Git composition tests are slower than reducer tests;
- Windows process fault schedules require disciplined cleanup;
- scripted production does not reproduce every malformed model response or
  provider rate-limit pattern;
- a pure statechart model checker and causal ledger are deferred.

**Neutral / follow-ups:**

- add a strict canonical-composition fingerprint and overlay allowlist;
- implement a durable temporal probe and host-cycle test hook;
- add fault schedules before/after worker close, CandidateSet, GateDecision,
  effect receipt, Process settlement and lifecycle routing;
- expose a pure `explainFactoryLiveness` read model without mutation authority;
- preserve minimized failing temporal traces as regression fixtures;
- update testing strategy and quickstart once the harness command exists.

## Decision Journal

**Date:** 2026-08-10  
**Decision (one line):** Make canonical real-composition temporal conformance
the mandatory test layer above local state/repository tests.

**Ex-ante expectations — IF this decision was right, I expect:**

- **In 30 days:** the current `WorkerExecution exited + Workplace verifying +
  no GateRun` trace fails deterministically with an exact `pending-gate` or
  `kernel-transition-not-driven` reason, without a model call.
- **In 90 days:** every installed lifecycle outcome edge has a real-runtime
  temporal trace or explicit unreachable proof, and no canonical E2E locally
  restates lifecycle/gate/effect policies.
- **In 6 months:** new silent stalls first fail a temporal property with exact
  authority refs rather than being discovered from a frozen UI.

**Check trigger:** first full new-project zero-token E2E, any real Factory stall,
or any change to lifecycle composition/dispatcher/process-host completion.

**What would change my mind:** repeated production stalls whose durable traces
pass the canonical temporal suite, or persistent flakiness that cannot be
eliminated with durable transitions and host-cycle budgets. In that case,
promote Option B's causal invariant ledger or Option A's bounded statechart
model as the next architecture step.

## References

- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- [Universal transition diagnostics](../CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [ADR-047](047-workplace-recovery-driver-and-pause-boundary.md)
- [GUARDRAILS](../../../GUARDRAILS.md)
