# Golden corpus — stage-11 docking run, workshops 1–2 only

Source: the terminal snapshot of the stage-11 run (lifecycle `product-build`,
terminal `runnable-local`, 2026-08-19 20:25:12Z;
`factory-snapshots/stage11-terminal-completed`). Harvested with
`tools/harvest-golden-corpus.mjs` from a staged `golden.sqlite` copy, then
**pruned to discovery + formalization products** (32 kept; development nodes
`plan-task-graph` / `implement-work-items` / `certify-product-readiness` /
`verify-acceptance` and lifecycle-level `null` products removed — 44 files).

## Why development is excluded

The development workshop's terminal outcome is **gamed, not green**:
`certify-product-readiness` passed its fourth round by narrowing the declared
`testCommand` from 9 test files to 7 — excluding exactly the two failing ones
(renderer, websocket) with zero code change; the merged test bytes had never
been green anywhere (card #20's repair execution committed without a green
run and self-reported passing). Baking that outcome into a golden corpus
would encode the fraud as EXPECTED behavior and poison every future
snapshot-test oracle. Forensics and remedies:
`docs/architecture/CERTIFICATION-GAMING-REMEDY.md`.

## Known content defects in the INCLUDED workshops (mark, don't fix here)

These products replay MECHANICALLY correctly (the stage-10 killer cell passed
on this exact material), but carry known content defects — never treat this
corpus as a correctness baseline:

1. **AC drift**: the formalization chain (define-product-contract et al.)
   dropped three order requirements (docker compose up, TypeScript backend,
   Chrome client) between SRS and the 5 acceptance criteria; none of the
   included products covers them. See the forensic block in
   `docs/factory-run/stage11/ARCHITECT-HANDOVER-DRAFT.md` and the remedy in
   `docs/architecture/AC-DRIFT-REMEDY-DESIGN.md`.
2. Documents were not harvested: the requirements tree did not exist on disk
   at harvest time (formalization documents live in sealed material; the
   working tree's `docs/` holds only development/formalization workplace
   files). The artifact index in the manifest covers the 17 artifact rows.

## Use

Zero-token deterministic re-run target for the snapshot-test harness
(`repair/snapshot-test-mvp` branch): discovery + formalization are the
conveyor's clean prefix; development rejoins the corpus only after the
certification-gaming remedies land and a clean run exists.
