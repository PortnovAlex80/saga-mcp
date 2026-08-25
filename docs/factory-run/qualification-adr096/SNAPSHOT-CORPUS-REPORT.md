# Snapshot Corpus — Provenance and Mutation Report

Phase 2 deliverable of `CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`
(consolidated from the port work: commits `06b04389`/`eb6f8fc1`/`8f9f0a78`
rebased onto the canonical line, final slice `2a73db57`, merged as `90faa5ae`).

## What the corpus is

A zero-token replay/corpus REGRESSION proving the factory reaches
solution-Development from a fresh database by replaying a captured
stage-11 "docking" tape byte-exactly through the REAL
`dist/orchestrate-cli.js`. It is not a semantic product oracle and not a
replacement for a real worker spawn: assertions are byte/trace-exact replay
of the traveled path, never artifact-quality judgements.

## Provenance (pinned in `tests/fixtures/golden-corpus/stage11-docking/manifest.json`)

- **Source**: frozen replay-fitness snapshot of the stage-11 docking run
  (harvest commit `1bf9b751` lineage; the corpus is the ONLY text source —
  corpus access fails closed, `SNAPSHOT_CORPUS_DRIFT` on any byte change).
- **Build SHA**: captured vs replay module refs pinned in the manifest —
  `product-discovery@4.0.0` (relayed from the 3.0.2 capture via the
  documented grammar relay), `solution-formalization@1.0.0`,
  `solution-development@1.4.4`.
- **Schema/version compatibility + expected transition trace**: manifest
  `provenance` block (source run, expected transition trace) and
  `replayDeviations` — the five documented post-capture contract deviations,
  each bridged by a fail-closed authority-derived relay (planner
  acceptanceCriterionIds→Keys derived from the runtime frozen development
  case with a dedicated parsed-content oracle; brief metadata; AC/SRS
  covered-constraint relay incl. §D2 one-line injection; reviewer-verdict
  subject rebound to the CURRENT runtime candidate; verification evidence
  v2 key read from the runtime work item).
- **Supervision fidelity**: the scripted executor records the real child pid
  + OS birth token (production parity) — fixing a harness race where
  `pid=null` let supervision's notAlive arm release live scripted executions.

## Zero-token proof

Set-equality of every `worker_executions` row id against the scenario
invocation ledger's execution ids (fresh DB, no capsule seeding), every
ledger key a tape scenario key, exactly one physical executor (scripted
scenario behind the real `WorkerExecutorFactory` port, `claudePath`
undefined), plus a boot-time ledger guard (`SCENARIO_EXECUTION_ROW_MISSING`)
that converts phantom ledger entries into a loud error.

## Negative cases (`tests/factory-contract/snapshot-corpus-negative.test.mjs`, 5 tests)

NEG-0..4: corrupted capsule/material (typed `SNAPSHOT_CORPUS_DRIFT` naming
the drifted product and both digests); missing package bytes (typed
failure); invalid transition order (Development transition without the
sealed predecessor → rejected); stale authority identity (material ref from
a stale/foreign run → rejected, no decoy adoption).

## Hosting + removal guard

Both corpus suites are hosted in the blocking `factory-contract` matrix
group; `G2s` in `tests/infrastructure/acceptance-matrix-coverage.test.mjs`
derives the run-set from `tools/run-acceptance-matrix.mjs --list-json` and
fails if either file is deleted or de-hosted (quarantine is not an escape).
The tape helper is covered transitively (both hosted suites fail at import
without it).

## Deliberate mutation RED/GREEN (executed 2026-08-25)

One byte mutated in
`products/assess-readiness.factory.discovery-readiness-assessment.v2.1.json`
(last char of `overall_readiness`): the negative suite fails at load with
typed `SNAPSHOT_CORPUS_DRIFT: product … hashes 829ad4cf…, corpus says
7786b9ad…` (0/1) and the tape helper import throws the same typed error
(turning the reach suite red at import). Restored byte-exact → 5/5 green.

## Honest residual

One run in eight (run14) observed two phantom ledger entries (39 vs 37)
after an abnormally slow run; rows are never deleted mid-run and no writer
path explains entries without rows — root cause open, now converted to a
loud typed failure by the ledger guard if it recurs. Zero recurrences in
five subsequent runs.
