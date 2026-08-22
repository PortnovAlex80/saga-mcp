# ADR-091: Readiness substrate TOCTOU re-probe — mid-check executor/compose failures are classified by mechanical observation, never by stderr guessing

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** ADR-089 (bounded in-check substrate retry, then typed
  unknown `warrant-blocked-environment` and human_required
  blocked/resumable), ADR-083 §6 (environment identity vs availability vs
  receipt-binding)
- **Closes:** the CC-GAP-9 RESIDUAL in `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (CC-00C) and
  `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- **Implementation plan:** `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (CC-00C / CC-GAP-9 residual package; blocking mutations wired into
  CC-10B and CC-80; serialized BEFORE any production run and BEFORE
  CC-GAP-7 warrant execution)

## Context

`src/infrastructure/verification/docker-readiness-executor.ts` probes the
docker daemon once per process (`checkDockerAvailable`, backed by the
module-level `dockerAvailabilityCache`, documented as "reset only by
process restart") and then runs long substrate operations — image pull,
prepared-image build, `docker run -d`, loopback observation, compose
`config`/`up`/`down`. The unintegrated CC-GAP-9 landing
(`736621af` + the post-REJECT repair `d3026cbe` on
`cc/CC-GAP-9-substrate-typed-unknown`) adds start-of-check cache
invalidation, so each check re-observes the daemon at its start. A
time-of-check-to-time-of-use window remains: the daemon can die (or the
runtime flip) between the probe and the failing executor/compose step.

That window is the CC-GAP-9 residual. A mid-check `docker build`/`run`
or `docker compose up` failure is ambiguous between two truths:

1. the substrate vanished after the probe (a machine fault — ADR-089:
   never a product verdict); or
2. the product or its declaration is bad (a nonexistent image/tag, an
   invalid compose file, a failing install/test/serve command — a honest
   product `failed`).

Two wrong implementations are available today. The flattening one maps
every `ReadinessExecutionError` from the executor/compose steps to
`'failed'` — the exact CC-GAP-9 defect ADR-089 forbids, now reachable
mid-check. The guessing one parses the failed command's stderr for
daemon-shaped text ("Cannot connect to the Docker daemon",
"error during connect") and classifies on the string — brittle,
locale/CLI-version dependent, and unprovable.

ADR-089 governs what happens AFTER classification (bounded retry, typed
unknown, human_required blocked/resumable). This decision governs HOW a
mid-check failure is classified. Per the ADR-083 §6 split, the re-probe
decides AVAILABILITY only; it never defines, authorizes, or substitutes
environment identity.

The decision fork: classify mid-check executor/compose failures by
flatten, by stderr heuristic, or by mechanical re-observation.

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Truthful classification | 25 | A daemon death mid-check is never a product verdict; a bad image/tag/config/product is never routed to unknown |
| Mechanical provability | 20 | The class is decided by an observed probe result, not by text that varies with CLI version/locale |
| Determinism and testability | 15 | Re-probe mechanics are hermetically testable with the injectable runner seams; blocking mutations kill each wrong class |
| Reuse of ADR-089 machinery | 15 | No new outcome class, no new retry policy — the observed unavailable/not-linux result rides the frozen ADR-089 routing |
| Resumability | 10 | A substrate death mid-check preserves all accepted work and resumes after recovery |
| Agent readability | 5 | One rule: on failure, re-probe; the observation decides |
| Implementation scope | 10 | One probe invalidation hook plus typed classification at the existing executor/compose failure sites |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: Keep the flatten — every mid-check executor/compose failure is product `failed` (status quo)

Pros:

- no new probe mechanics; the current `ReadinessExecutionError` →
  `'failed'` mapping already covers the path;
- one terminal class for all substrate step failures.

Cons:

- records a product verdict for a machine fault that struck AFTER the
  availability probe passed — the CC-GAP-9 defect reborn inside the
  check, exactly what ADR-089 prohibits;
- destroys resumability for a recoverable daemon outage;
- the start-of-check invalidation (already landed on the GAP-9 branch)
  narrows but cannot close the TOCTOU window.

### Option B: On executor/compose failure, invalidate the cached probe and mechanically re-probe; the observation routes (selected)

When an executor step (image pull, prepared-image build, run, observe) or
a compose step (`config`, `up`) fails, the provider does NOT classify
from the failure's text: it invalidates the process-level availability
cache and mechanically re-probes the daemon (`docker info` with the
bounded timeout, exactly the existing probe). Only the re-probe's
OBSERVED result routes:

- observed **unavailable** (daemon unreachable/CLI error) or
  **not-linux** (`OSType` observed ≠ linux): the failure is
  substrate-unavailable and rides the EXISTING ADR-089 machinery —
  bounded deterministic in-check substrate retry, then exactly one typed
  unknown `warrant-blocked-environment` outcome and one human_required
  blocked/resumable continuation; never product-failed;
- observed **available + linux**: the substrate was healthy at the
  moment of failure — the failure is the product's or its declaration's
  (bad image/tag, invalid compose config, failing install/test/serve
  command) and REMAINS product `failed`; it is never re-routed to
  unknown, never retried as substrate.

Pros:

- classification is a mechanical observation, hermetically provable
  through the injectable executor/compose seams — no stderr parsing;
- both directions of the residual defect become blocking mutations:
  daemon-death-mid-check routed to `failed` is red, and
  bad-image-mid-check routed to unknown is red;
- reuses ADR-089's frozen routing and ADR-083's identity fence with no
  new outcome class and no new retry policy.

Cons:

- one more probe execution per failed check (bounded, and only on
  failure);
- a daemon that dies AND restarts linux-healthy between failure and
  re-probe classifies as product `failed` — accepted: the observation is
  the contract, and a genuinely failing product step fails again on the
  deterministic retry the product path already owns.

### Option C: Classify by stderr text heuristics

Match daemon-shaped strings in the failed command's stderr
("Cannot connect", "error during connect", "is the docker daemon
running") and route matches to the substrate class.

Pros:

- no second process spawn; classification is immediate.

Cons:

- the deciding evidence is CLI-version- and locale-dependent text —
  unprovable, untyped, and silently wrong when the strings drift (the
  watchdog CLI-drift class of defect, CC-GAP-5, all over again);
- a product-failing command whose stderr happens to contain daemon-shaped
  text is misrouted to unknown; a daemon outage with unexpected text is
  misrouted to product `failed`;
- no mechanical blocking mutation can pin the truth — the heuristic is
  guesswork by construction.

## MCDA matrix

| Option | Truth 25 | Mechanical 20 | Determinism 15 | Reuse 15 | Resumability 10 | Readability 5 | Scope 10 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Flatten to product failed | 1 | 4 | 4 | 5 | 1 | 4 | 4 | 305 |
| B. Mechanical re-probe on failure | 5 | 5 | 5 | 5 | 4 | 4 | 4 | 470 |
| C. Stderr text heuristics | 2 | 1 | 1 | 4 | 2 | 3 | 4 | 205 |

Option B leads the nearest alternative by more than ten percent. Option
A's reuse/scope advantage is the advantage of not building the residual
fix; Option C loses on every provability driver — its classification
evidence is not an observation.

## Pre-mortem on Option B

Assumption: Option B was implemented and failed six months later.

1. A daemon died mid-`docker run` and the re-probe raced the daemon's
   restart, observing available+linux: the check recorded product
   `failed` for a machine fault. Likelihood: low. Detection: the
   failed-step evidence records BOTH the step failure and the re-probe
   observation with timestamps; a deterministic re-run of the check (the
   product path's own retry) fails or passes on product truth, and the
   receipt trail exposes the race. Response: the observation contract is
   the honest boundary — the re-probe records what was observed, never
   what was inferred; a repeated class of such races is a substrate
   reliability signal for the operator, not a classification change.
2. The re-probe was implemented as another silent `docker info` whose
   failure crashed the provider. Likelihood: low. Detection: the
   re-probe rides the existing bounded-timeout probe helper and its
   failure observes `unavailable` — routing into the ADR-089 bounded
   retry, never an exception path. Response: the blocking mutation that
   kills "re-probe error → product failed" keeps the fail-closed
   direction red.
3. Someone reintroduced a stderr shortcut "just for the obvious cases".
   Likelihood: medium. Detection: the blocking mutation feeds the
   classifier daemon-shaped stderr while the mechanical re-probe
   observes available+linux — the outcome must stay product `failed`;
   any stderr-sensitive routing turns red. Response: the proof pins the
   only admissible decider to the observed probe result.
4. The compose `down` cleanup failure reclassified an already-passed
   verification. Likelihood: low. Detection: `down` is best-effort and
   never emits an outcome; a passed `up` stays passed regardless of
   `down`; a failed `down` after a failed `up` never masks the up
   result. Response: pinned by the compose exit tests below.
5. The provider version bump (1.12.0) was shipped without the trust
   migration, fencing the factory's own provider out. Likelihood:
   medium. Detection: the `trusted_providers` migration extends the
   recorded trustworthy baseline with the digest fence intact
   (`built-in:<provider digest>` trust basis); the version/digest exit
   test fails closed on a missing or mismatched row. Response: the
   migration is part of the same landing, never a follow-up.

Net effect: every failure mode is an observed, typed, receipt-recorded
state; no silent-green or silent-terminal failure mode remains.

## Red Team

1. **"The re-probe is just a fancier guess."** No. A guess classifies
   from ambiguous evidence (text that resembles a cause); the re-probe
   CLASSIFIES FROM A FRESH OBSERVATION of the exact precondition
   (daemon reachable, OSType linux) that the substrate class is defined
   over. The observation may race reality — every measurement may — but
   it is typed, bounded, recorded, and mechanically provable.
2. **"This adds a retry policy beside ADR-089."** It does not. The
   re-probe is one observation, not a wait loop; after classification,
   every retry, bound, unknown, and continuation is ADR-089's frozen
   machinery, unchanged.
3. **"Observed available+linux after a daemon blip still writes product
   `failed` — that is the flatten again."** It is a verdict the product
   path owns discharging: the check exercised (or attempted) a product
   step against an observed-healthy substrate. The product's own
   deterministic re-execution re-proves it; routing it to unknown would
   spend the substrate budget on a product defect — the mirror image of
   the Elite-6 defect.
4. **"Stderr is right there; refusing to read it is dogma."** Stderr is
   evidence for humans, not a classification oracle: it varies with CLI
   version, locale, and daemon flavor, and no blocking mutation can pin
   its semantics. The mechanical probe is the only decider whose truth
   the proof kernel can kill mutants against.
5. **"The re-probe makes an identity decision."** It does not: reachable
   + OSType linux is AVAILABILITY, exactly the ADR-083 §6 split. The
   re-probe never derives, blesses, or substitutes an
   `environmentDigest` or any identity; CC-GAP-7 keeps consuming and
   receipt-binding identity it never authorizes.

All five objections are answered inside Option B; objections 3 and 4
shaped the exit tests, 5 the ADR-083 boundary wording.

## Decision

Choose Option B. The CC-GAP-9 residual contract is normatively:

1. **On executor/compose failure: invalidate and re-probe.** When any
   executor step or compose step fails, the provider invalidates the
   process-level docker availability cache and mechanically re-probes
   the daemon with the existing bounded probe. Classification happens
   only on that observation.
2. **Only OBSERVED unavailable/not-linux routes into ADR-089.** A
   re-probe observing the daemon unreachable (probe failure observes
   `unavailable`) or the runtime not-linux routes the failure as
   substrate-unavailable into the EXISTING bounded in-check substrate
   retry and, on exhaustion, the typed unknown
   `warrant-blocked-environment` outcome and the human_required
   blocked/resumable continuation — never product-failed.
3. **Bad image/tag/config/product remains product `failed`.** A
   re-probe observing the daemon available + linux means the substrate
   was healthy at classification time: a nonexistent image or tag
   (`LOCAL_RUNNABILITY_DOCKER_PULL_FAILED`), an invalid compose
   declaration (`compose-config` failed), or a failing product
   install/test/serve command stays product `failed` — never re-routed
   to unknown, never retried as substrate, never waived by the engine.
4. **No stderr text guessing.** No implementation may classify (in
   whole or in part) by matching, regexing, or otherwise interpreting
   the failed command's stderr text. Stderr is recorded as human-facing
   failure detail only; the sole classifier input is the observed
   re-probe result.
5. **Compose `down` vs invalid config stay distinct.** `down` is
   best-effort cleanup with no outcome: a failed `down` after a passed
   verification never turns it red, and a failed `down` after a failed
   `up` never masks the up failure or its classification. An invalid
   compose config (non-zero `compose config --quiet` with the CLI
   present) is a product defect — product `failed`; a missing compose
   CLI (ENOENT) remains the typed substrate code
   `LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE`.
6. **Collapse guard.** The re-probe path introduces no outcome
   collapsing: product-failed, oracle-insufficient, and
   substrate-unavailable remain distinct typed classes on every surface
   and route (ADR-089 §1); an implementation routing every executor
   failure to unknown, or every failure to `failed`, is red.
7. **Provider pin 1.12.0 with digest fence and trust migration.** The
   local-runnability check provider version pins `1.12.0` (this branch
   pins `1.10.0`; the unintegrated CC-GAP-9 landing pins `1.11.0`; this
   ADR lands on top as `1.12.0`). The `trusted_providers` row migrates
   with the recorded trustworthy baseline extended (`1.11.0` before
   `1.12.0`), the trust basis stays `built-in:<provider digest>`, and
   the digest fence stands: receipts key on provider id + provider
   digest, so a swapped implementation is fenced out and never silently
   re-trusted. The obligation contract `factory.local-runnability`
   compiles at version `1.12.0` (protection
   `factory.local-runnability.v1` @ `1.12.0`) — the obligation compiler
   pin is `1.12.0`.
8. **Sequencing: before any production run and before CC-GAP-7.** The
   residual closes before any production run is released on the
   conformance-closure path and BEFORE CC-GAP-7 warrant execution:
   warrant phases must never meet a mid-check substrate failure without
   the observed-classification routing, exactly as ADR-089 serialized
   CC-GAP-9 before CC-GAP-7.

### Explicit exclusions

- No new outcome class; the four-valued check outcome and the three
  distinct classes are untouched.
- No change to the ADR-089 frozen retry bound or schedule; the re-probe
  is one observation, not a retry.
- No stderr parsing of any kind in classification (recording stderr as
  failure detail remains).
- No environment identity decision: the re-probe decides availability
  only (ADR-083 §6); it never produces, verifies, or substitutes an
  `environmentDigest`, image digest, or toolchain identity.
- No deterministic repair round, no CandidateSet, no repair budget
  consumption, no worker re-hire for substrate conditions (ADR-089).
- No rewrite of frozen Elite-6 evidence; legacy records are grandfathered
  and never reclassified.
- No compose mode change: `config`/`up` modes and their timeouts stand.

### Exit tests (blocking mutations)

- (a) Daemon dies mid-check after a passed start-of-check probe; the
  failing executor/compose step plus a re-probe observing `unavailable`
  yields the ADR-089 path (bounded retry, then exactly one typed unknown
  `warrant-blocked-environment` + one human_required blocked/resumable
  continuation) — routing it to product `failed` is red.
- (b) The same failing step with a re-probe observing available + linux
  (bad image/tag, invalid config, failing product command) stays product
  `failed` — routing it to unknown/substrate is red.
- (c) No stderr guessing: daemon-shaped stderr text paired with an
  observed available+linux re-probe must classify product `failed`, and
  clean stderr paired with an observed unavailable re-probe must
  classify substrate — any stderr-sensitive routing is red.
- (d) Collapse guard: routing every executor/compose failure to unknown
  (or all to `failed`) fails classification.
- (e) Compose truth: invalid `compose config` with the CLI present and
  daemon observed healthy is product `failed`; a failed `down` after a
  passed `up` leaves the pass green; a failed `down` after a failed `up`
  never masks the up failure or its class; ENOENT CLI-missing stays
  `LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE`.
- (f) Version/digest fence: the provider presents `1.12.0`; the
  `trusted_providers` row migrated with `built-in:<digest>` trust basis;
  a receipt from a foreign provider digest (or an unmigrated trust row)
  is rejected — the obligation compiler pins
  `factory.local-runnability.v1` @ `1.12.0`.

## Consequences

Positive:

- the TOCTOU window between the availability probe and the substrate
  steps can no longer write a product verdict for a machine fault, and
  can no longer spend substrate retry on a product defect;
- classification truth is a recorded observation — hermetically provable
  through the injectable executor/compose seams, immune to CLI text
  drift;
- ADR-089's routing, bound, accounting, and no-poison rules are reused
  unchanged; the ADR-083 identity fence is untouched;
- the provider bump rides the existing trust machinery (digest fence,
  trustworthy-baseline migration), not a new trust surface.

Negative:

- one extra bounded probe execution per failed check;
- a daemon restart racing the re-probe can still classify product
  `failed` for one attempt — honest, recorded, and dischargeable by the
  product path's own re-execution;
- six more blocking mutations owed in the CC-00C set and wired into
  CC-10B/CC-80 before any production run.

Neutral:

- failure stderr remains in the evidence as human-facing detail;
- the sequencing gate (before any production run, before CC-GAP-7) is
  enforced by the plan's serialization, not by new runtime state.

## Decision Journal

Date: 2026-08-22.

Decision: mid-check readiness executor/compose failures are classified
by invalidating the cached availability probe and mechanically
re-probing the daemon; only an observed unavailable/not-linux re-probe
routes into the existing ADR-089 bounded in-check substrate retry and
typed unknown `warrant-blocked-environment` outcome with human_required
blocked/resumable continuation; an observed available+linux re-probe
leaves the failure product `failed` (bad image/tag/config/product);
classification never reads stderr text; compose `down` stays best-effort
and distinct from invalid config; the three outcome classes never
collapse; the provider pins `1.12.0` with the digest fence and trust
migration intact and the obligation compiler pins
`factory.local-runnability.v1` @ `1.12.0`; the residual closes before
any production run and before CC-GAP-7 warrant execution.

Ex-ante expectations:

- At landing, mutation (a) proves a daemon death mid-check cannot write
  product `failed`; mutation (b) proves a bad image/tag/config/product
  cannot reach unknown/substrate; (c) proves no stderr-sensitive
  classifier survives; (d) proves no collapse; (e) proves the compose
  down/config truths; (f) proves the 1.12.0 version/digest fence.
- The six mutations are wired into the CC-10B blocking group and CC-80
  qualification command; with the residual open, they stay RED and no
  production run is released on this path.
- Frozen Elite-6 records are untouched.

Check trigger: CC-GAP-9 residual exit, or any later proposal to classify
substrate conditions from stderr text, to collapse the three outcome
classes, or to skip the re-probe on mid-check failure.

What would change this decision: evidence that a bounded mechanical
re-probe cannot observe the daemon state deterministically on the
readiness seam, or an operator directive that mid-check classification
is an operator-managed externality.

## References

- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` — sections 3.2, CC-00C
  (CC-GAP-9 residual package), CC-10B, CC-80, 13
- `docs/architecture/decisions/089-bounded-in-check-substrate-retry-then-typed-unknown.md`
- `docs/architecture/decisions/083-readiness-toolchain-package-identity-contract.md`
  — §6 boundary note (identity vs availability vs receipt-binding)
- `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- `src/infrastructure/verification/docker-readiness-executor.ts` — the
  process-level availability cache and bounded `docker info` probe
- `src/infrastructure/verification/compose-readiness.ts` — the typed
  compose steps (`config`/`up`/`down`) and
  `LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE`
- `src/infrastructure/verification/local-runnability-check-provider.ts`
  — the trusted-provider digest fence and trust migration
- `src/modules/development/application/candidate-check-contracts.ts` —
  the provider version/digest pin (this branch `1.10.0`; the GAP-9
  landing `1.11.0`; this ADR `1.12.0`)
- `tests/factory-proof/obligation-contracts.mjs` — the
  `factory.local-runnability` obligation compiled at `1.12.0`
