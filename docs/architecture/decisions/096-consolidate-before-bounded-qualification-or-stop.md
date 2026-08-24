# ADR-096: Consolidate before bounded qualification or stop

- **Status:** Accepted
- **Date:** 2026-08-24
- **Decision-maker:** primary architect after independent feasibility,
  impossibility, and change-forensics audits

## Context

Repeated real-model Development runs found a new failure class after each
repair. No externally truthful full product run has completed. The latest
repair line also diverged from `saga4`, hot-swapped source and `dist` during one
accumulated database lineage, and weakened several tests while keeping them
green. This makes both success and failure scientifically unattributable.

This evidence does not prove that the finite Workplace/Candidate/Gate/Effect
kernel is unrealizable. W9-02 completes the canonical lifecycle twice with a
scripted actor, which is a constructive operational witness, although it proves
neither physical spawning nor arbitrary product semantics. Conversely, a
promise that every natural-language order and arbitrary model must succeed is
impossible: requirements can be inconsistent, providers can fail, and general
semantic correctness is not decidable. The lawful product promise is bounded
progress to success, typed wait, human-required, or honest terminal failure.

## Decision drivers

- exact authority and deterministic failure semantics;
- independently falsifiable qualification rather than a self-derived universe;
- preservation of already valid work;
- reversibility if the project fails a bounded gate;
- operational cost and time to the next decisive result.

## Considered options

1. Terminate the project immediately.
2. Continue incident-by-incident live patching.
3. Consolidate one immutable code line, close the declared qualification
   universe, then apply a predeclared kill gate.
4. Immediately reduce scope to a deterministic workflow engine and abandon
   autonomous product manufacture.

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | Terminate now | Live patching | Consolidate + gate | Reduce scope now |
| --- | ---: | ---: | ---: | ---: | ---: |
| Correctness/evidence quality | 30 | 2 | 2 | 5 | 4 |
| Falsifiability | 20 | 5 | 1 | 5 | 4 |
| Cost to decisive result | 15 | 5 | 3 | 3 | 2 |
| Reversibility | 15 | 1 | 2 | 4 | 3 |
| Operational viability | 20 | 4 | 2 | 4 | 5 |
| Weighted score / 5 | 100 | 3.25 | 1.90 | 4.40 | 3.85 |

## Decision

Choose option 3. Stop treating live model runs as an architecture-discovery
loop. First create one canonical branch containing the current `saga4`
BM-5/ADR-095 work and the independently reviewed Elite repairs. Never qualify
with a hot-swapped build or an accumulated mutable database.

Then freeze, before qualification, an obligation universe and kill criterion:

1. Development obligations are 100% demonstrated, including production-sized
   task-graph satisfiability and no fallback SRS scopes.
2. K4 crash/fault edges and a non-zero mutation kill floor are blocking.
3. Three fresh Development runs and three fresh whole-factory runs use one
   immutable build, different deterministic perturbation seeds, and no source,
   package, capsule, DB, or `dist` mutation between runs.
4. One non-game synthetic workshop completes without a core runtime name
   branch or new dispatcher.
5. Two real-model canaries complete without intervention; model deviations use
   already declared transitions.
6. No run reveals a genuinely new invariant class.

If this frozen gate reveals a new architectural invariant class, terminate the
autonomous factory effort or reduce it to the deterministic workflow engine.
Infrastructure flakiness or an already declared scenario instance does not by
itself trigger termination.

## Consequences

- The current Elite run is evidence and a bug corpus, not qualification.
- Directly merging its tree is forbidden; repairs are merged onto current
  `saga4` with conflicts and normative drift reviewed explicitly.
- Real-model runs pause until the canonical line and test universe are coherent.
- Honest typed failure remains a valid factory outcome, but it does not count as
  successful autonomous manufacture.

## Pre-mortem

Assume this decision failed six months later:

1. The obligation universe was still self-derived and moved after every run.
   Mitigation: freeze the denominator in a versioned external manifest.
2. Consolidation silently retained both old and new authority paths.
   Mitigation: removal ratchets and exact-reference architecture tests.
3. Scripted actors remained unrealistically compliant.
   Mitigation: malformed and history-dependent actors plus physical spawn tests.
4. Three green runs reused contaminated state.
   Mitigation: fresh DB/repository/package-store and immutable build receipt per
   run.
5. The gate consumed another long cycle without convergence.
   Mitigation: the first genuinely new invariant class triggers the recorded
   stop/reduction decision.

## Devil's-advocate result

The strongest objection is that the specification itself grows after every
incident and therefore may be unbounded. Thousands of green tests have not
produced a falling real-run defect rate. This objection is accepted as the
reason for the finite kill gate; it does not establish mathematical
non-realizability before that gate is attempted on one immutable composition.

## Decision journal

- **Date:** 2026-08-24
- **Decision:** consolidate once, qualify against a frozen independent gate,
  then stop or reduce scope if a new invariant class appears.
- **30-day expectation:** one canonical branch; no live repair branch contains
  unique production fixes; Development denominator is external and fixed.
- **90-day expectation:** either the frozen qualification passes, or the
  autonomous factory is formally terminated/reduced without another expanding
  incident-patch cycle.
- **Check trigger:** canonical merge completion, first immutable-build
  qualification failure, or any proposal to add a new invariant during that
  qualification.
