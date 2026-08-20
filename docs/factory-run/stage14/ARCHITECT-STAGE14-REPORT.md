# ARCHITECT STAGE-14 REPORT — 2026-08-20

Report per `docs/handoff/STAGE-14-AGENT-BRIEF.md`. Headline: **both halves of
break 2 are closed (the candidate no longer declares what it is judged by —
neither its check set nor its environment), the satisfiability rung exists,
the branch cleanup is recorded, and the stage-12 run's question is answered
plainly: it never terminated.** One HEAD, all suites green.

## Task 1 — K19: commits 2–3 CORE landed; stopped at a named boundary

**Landed** (`feat(environment): K19 commits 2-3 core — the derived execution
environment`): `environment-derivation.ts` + provider integration (1.10.0).
The environment is DERIVED from the exact sealed artefact — a
bare-specifier import scan vs the sealed package.json manifests vs the
declared install's package tokens — and the declaration is additive: an
undeclared import AUGMENTS the install (same runner, gap appended) or, when
there is no install to augment, fails closed typed BEFORE ANY SPAWN.
`environmentDigest` rides every outcome as a decodable diagnostic: one
immutable identity for preparation and certification.

**The domain-free negative test, verbatim** (the property that decides
success; `tests/infrastructure/environment-derivation.test.mjs`, 3/3):

> K19 negative (domain-free GDesign): no install command + an undeclared
> import → caught BY DERIVATION before any spawn, typed and named —
> the sealed artefact imports package(s) `orbital-mechanics` that no sealed
> manifest declares and the readiness profile states NO install command to
> augment — the derived environment cannot be prepared. Declared by
> derivation from the sealed tree, before any execution.

Invented package world (`orbital-mechanics`); no Python, no `pyyaml`,
nothing from the real run. The augment-path twin proves the additive
semantics: `npm install chart-renderer` becomes
`npm install chart-renderer orbital-mechanics`, whose honest registry
failure IS the outcome.

**Where I stopped (the boundary, also recorded inside ADR-083 §4/§5):** the
OCI image/dependency-digest persistence per pinned package; the ADR-077
fingerprint `toolchainDigests` extension; **commits 4–6** (post-integration
readiness as a Production Cell; environment-drift invalidation tests; ADR
cohort closure) — not started, not claimed.

## Task 2 — anti-gaming step 4: the RED fixture, before and after

**Before** (pinned deliberately by two suites as the designed boundary): a
manifest enumerating 7 of 9 test files, excluding exactly the two failing
ones, zero code change — **PASSED** (report-only; the M2-2 coverage note
named the gap and changed nothing).

**After** (`feat(readiness): M1-b step 4`, provider 1.9.0): the executed
check set is DERIVED from the sealed tree; the declaration is additive
only. The gate performs token surgery on the declaration's OWN runner —
program and flags verbatim, file tokens replaced by canonical ∪ declared —
so the excluded canonical files RUN. **The same gaming manifest now FAILS
on the two excluded files' real output**, with both files named in the
decodable evidence. The hole one level deeper is closed too: an opaque
`npm test` whose SEALED package.json script enumerates 7 of 9 is derived
over the sealed script. Opaque non-npm declarations keep the report-only
boundary (honest, unchanged). Both pinning suites were updated in the same
commit with the reasons, per the brief. Negative suite
`local-runnability-derived-canonical.test.mjs` 3/3 (gaming fails; full
enumeration honored verbatim; sealed-script smuggling derived).

## Task 3 — the satisfiability rung: the DECIDABLE form, stated as such

The §23 ladder gained its **S rung** (CONVEYOR-MENTAL-MODEL, named by KIND
OF QUESTION, not scope of execution): *does a state exist satisfying ALL
simultaneously enforced constraints?* Two concrete instances
(`gate-conjunction-satisfiability.test.mjs`, 3/3):

1. **Classification ratchet** — every check provider installed in the
   development lifecycle's plans is classified: decidable with its named
   procedure/lawful exit (task-graph DAG; implementation-scope containment
   WITH the stage-13 widening as the exit; monotonicity set-comparison;
   local-runnability derivation-union; product contracts schema/cardinality),
   or honestly OPEN (`factory.review-verdict.v1`: semantic, human-role —
   marked open, never hidden as decidable). A new gate cannot silently add
   an unclassified conjunction obligation.
2. **The decidable containment instance** — with the REAL widening ledger:
   uncontended need → GRANT (SAT — the wider frozen revision IS the
   satisfying assignment); contended need → REFUSAL naming the live holder
   (UNSAT WITH WITNESS). Decided at the decision point, not by autopsy.

**Delivered: the decidable form.** The general satisfiability problem is
undecidable; the rung ships the decidable instances plus the honest
open-class marking — a weaker property that holds beats a stronger one
that guesses.

## Task 4 — the branch cleanup: done and recorded

`docs/architecture/BRANCH-CLEANUP-2026-08-20.md` (landed before this
stage's work resumed): 20 branches deleted, each with an individual merge
proof (`origin/saga4..<branch>` empty) and an `archive/*` tag pushed BEFORE
deletion; `-d` everywhere; 21 worktrees released; verdicts for
blindsight-reconciliation (merged as stage-13 TASK 5, then deleted),
snapshot-test-mvp (KEPT — the three answers delivered with a merge
recommendation), wip/documentation-workshop (KEPT + ESCALATED — one unique
commit, a complete documentation workshop). `saga4` + three kept-with-verdict
branches remain. **The junction hazard fired once despite the pre-check
(false negatives from `cmd dir` under Git Bash path mangling): the main
tree's `node_modules/.bin` was stripped; blast radius verified (git status
clean; every run DB/log/snapshot intact); `npm install` restored it; the
baseline re-ran identical. The record documents the incident and the
fail-closed lesson.**

## Task 5 — the stage-12 run: the terminal never came

Measured at stop time: lifecycle run 1 `paused`, `terminal_status=null`,
after **>24 hours**; 8 workplaces accepted / 6 idle (the un-adopted
re-carve) / 1 queued; 7 recovery epochs; zero parks; the engine's log went
silent at 09:42 local with no process remaining — **the factory did not
self-terminate, and F6 did not fire.** The engine died in pause rather
than reaching an honest terminal. That is the answer, recorded as such —
not quietly extinguished: final snapshot
`factory-snapshots/stage14-final-verdict-no-self-terminal` (6.8 MB,
integrity ok), engine stop confirmed via the incident tool (it found no
live process — the engine had already exited silently).

## Verification baseline (final tree, built first)

architecture **411/411** (408 + 3 rung), lifecycle **136/136**,
process-modules **1220/1220**, infrastructure **407 pass / 0 fail / 12
skip** (401 + 3 derived-canonical + 3 environment-derivation), w9 e2e
**20/20**, golden-path **1/1**. One timing flake observed once in pm during
step 4 (not reproduced on two full clean reruns — the stage-12 flake
class; recorded). Every suite asserting the old declaration semantics was
updated in the same commit with its reason — none weakened to pass.

## What was not finished

- **K19 commits 4–6** and the OCI digest-persistence + `toolchainDigests`
  surfaces of commit 3 — named above, not started.
- **`repair/snapshot-test-mvp`** — kept, answers + merge recommendation
  delivered; the merge itself is a separate change.
- **The general satisfiability form** — undecidable; the decidable instance
  + open-class marking is the deliverable.
- **wip/documentation-workshop** — awaiting your verdict on the unique
  documentation-workshop commit.
