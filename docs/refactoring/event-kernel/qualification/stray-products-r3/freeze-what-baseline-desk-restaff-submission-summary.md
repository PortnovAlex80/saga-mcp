# freeze-what-baseline desk (author) — RE-STAFF CONFIRMATION submission summary

**Emission:** AS-Freeze-What-Baseline-001 (author re-staff confirmation, staffing #3)
**confirmation:** `sha256:c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06` (`freeze-what-baseline-desk-restaff-confirmation.json`)
**trace:** `sha256:fc4aae420a87ea19f6d970815824be0b2d168c8f8c05628c5d300d062777ba80` (`freeze-what-baseline-desk-restaff-trace.json`, 25 edges)
**decision:** the standing upstream hold **UH-Freeze-What-Baseline-001** (`sha256:9f2d28b9…`) is **STANDING** — re-verified, not re-emitted; **no product authored**.

## What this staffing found

The desk task envelope is **byte-identical** to the standing staffing's: all 8 task-projection content addresses (recomputed 8/8 from the accepted r2 capsule, 9/9 with CERT-1 `03972527…`), skill pins `a926df62`/`95fafc84` recorded verbatim as unratified envelope provenance, workspace summary `0 accepted upstream revisions travel by content address`, write authority `artifact-create,trace-add,fs:read,fs:write`. Desk law on re-staffing with an identical envelope: the outcome is idempotent by content address — this staffing mints a confirmation, never a second hold, never product.

## Upstream state recheck — nothing moved

- **Gate:** FR-Reconcile-What-001 (`39a94a29…`, reviewer round of record per CL-Reconcile-What-001 `841194ce…`, emission A) recomputes **repair**, with the prohibition *"No domain.accepted may fire from this desk toward freeze-what-baseline on this chain"* recomputed from the verdict record itself (CRIT-1 permanence warning intact).
- **Census:** **0 of 5** pre-freeze desks accepted (the freeze contract `frf-contracts.what-baseline.v1`, schema raw `ab1b7f5e…`, demands `acceptanceRecords` minItems 5): intent `a06dbc57…` repair ×3; UC `24f0aff2…` still never reviewed at its own address; requirements `86b00569…` repair + held reviewer seat; acceptance `2b01353d…` with its single accepted emission still superseded by the CTN adjudication (emission C repair `7e76176c…`); reconcile-what `6400a2dd…` repair.
- **Movement scan (workspace-wide, r1+r2+r3+testbed, 268 JSON files, 17 verdict records):** zero accepted records landed at any pre-freeze desk's own content address since the hold. The only accepted records anywhere pin exactly three known candidates: the stale shell `745cadc1…`, the genuinely accepted UC product `c6120e86…` (a different candidate), and the accepted import artifact `b10bb762…` (the only accepted chain).
- **Governing anchor:** resolution scan recomputed — **0** content blocks hash to `a926df62…` workspace-wide; textual mentions are provenance only. Not ratified.

## Verification

`freeze-what-baseline-desk-restaff-verify.mjs` — **56/56 recomputations pass** (`freeze-what-baseline-desk-restaff-verify-out.json`, digest-pinned): own digests, envelope 8/8 + capsule, standing package byte-stability (`9f2d28b9…`/`17c09566…` + receipt semantics 33/33), gate digests + prohibition + candidate binding, census + supersession, movement-scan re-run vs the published blocks, schema pin, no-authoring fence, trace-edge resolution against the recomputed digest space, anchor resolution scan, determinism + restaff-namespacing.

**Determinism repair landed this staffing:** the first build embedded tree-size counters (`filesScanned`) in the published content, which broke byte-stable re-derivation as the emission's own files joined the scan. The published movement/scan blocks are now content-derived only (`counterPolicy` recorded in the confirmation); counters live in the regenerable receipt. Confirmation + trace rebuild byte-identical (verified by checksum across rebuilds); zero existing files modified or deleted.

## Resume contract (R1–R4 of the standing hold — unfulfilled)

R1: genuinely accepted revisions must land for the four consumed pre-freeze desks (each through a completed reviewer stage at its own content address); RA-5 re-runs reconcile-what over the NEW accepted chain. R2: the re-run's reviewer verdict of record discharges the no-accept prohibition — never this desk. R3: on five accepted pre-freeze desks this desk authors the whole-WHAT baseline against the accepted triples and the payload contract. R4: holds carry no product lineage; the baseline cites only accepted revisions.
