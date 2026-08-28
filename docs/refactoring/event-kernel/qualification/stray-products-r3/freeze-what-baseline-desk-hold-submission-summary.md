# freeze-what-baseline desk (author) — UPSTREAM HOLD submission summary

**Emission:** UH-Freeze-What-Baseline-001 (standing hold, re-verified this staffing; bytes unchanged)
**artifact:** `sha256:9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f` (`freeze-what-baseline-desk-upstream-hold.artifact.json`)
**trace:** `sha256:17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202` (`freeze-what-baseline-desk-upstream-hold-trace.json`)
**decision:** `hold-no-authoring` — no whole-WHAT baseline material authored.

## Why this desk holds instead of authoring

The whole-WHAT baseline (`frf-contracts.what-baseline.v1`) is a statement ABOUT accepted material: its payload contract demands `acceptanceRecords` with `minItems 5` — one accepted CandidateSet/CellFinalAcceptance/WorkplaceProductionRevision triple per accepted pre-freeze desk. On this chain **0 of 5** pre-freeze desks are accepted, and the desk's upstream gate — reconcile-what — returned verdict **repair** (FR-Reconcile-What-001 `39a94a29…`, reviewer round of record per CL-Reconcile-What-001 `841194ce…`) with the recomputed explicit prohibition: *"No domain.accepted may fire from this desk toward freeze-what-baseline on this chain"* (CRIT-1: a freeze over unaccepted lineage would *"inherit the fabricated authority permanently"*).

This staffing re-checked the upstream state before re-verifying the hold; nothing moved. Every gate digest recomputes unchanged: author candidate of record FS-Reconcile-What-001 (`0f4e4faf…` / artifact `6400a2dd…` / trace `09e80046…`), reviewer round (review `39a94a29…` / verification `cd7504a6…` / trace `fe108e09…` / submission `9f2f5d07…`), collision record `841194ce…`. The four consumed pre-freeze revisions remain NOT accepted (intent `a06dbc57…` repair ×3; UC `24f0aff2…` never reviewed at its own address; requirements `86b00569…` repair + held reviewer seat; acceptance `2b01353d…` adjudicated repair CTN-001 with the desk on record hold `a53a5e08…`). The only accepted base is the discovery import chain (`b10bb762…`, capsule envelope 8/8 + CERT-1 `03972527…`).

## Verification

`freeze-what-baseline-desk-hold-verify.mjs` — **33/33 recomputations pass** (`freeze-what-baseline-desk-hold-verify-out.json`, digest-pinned): own artifact/trace digests, capsule/envelope re-derivation, all cited record digests + verdict pins, reviewer candidate binding, prohibition recomputed from the verdict records, census 0/5, schema pin `ab1b7f5e…`, governing anchor scan-proofed unresolvable (305 qualification files), no-authoring fence, determinism.

One verifier repair landed this staffing: the C7 trace-resolution digest space now carries the recomputed import artifact digest, so the hold's accepted-base edge (`observes import:discovery-handoff`) resolves like every other edge. The hold artifact and trace bytes are untouched (`9f2d28b9…` / `17c09566…` re-derive byte-stable from `freeze-what-baseline-desk-hold-build.mjs`).

## Resume contract (R1–R4)

R1: genuinely accepted revisions land for define-product-intent, model-use-cases, derive-system-requirements, define-acceptance-contract (each through a completed reviewer stage at its own content address); RA-5 re-runs reconcile-what over the NEW accepted chain. R2: the re-run's reviewer verdict of record discharges the no-accept prohibition — never this desk. R3: on five accepted pre-freeze desks this desk is re-staffed and authors the whole-WHAT baseline strictly against the accepted triples and the payload contract. R4: the hold is not carried as product lineage; the baseline cites only accepted revisions.
