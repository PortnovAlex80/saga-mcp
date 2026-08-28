# freeze-what-baseline desk (reviewer) — REFUSAL submission summary

**Emission:** FR-Freeze-What-Baseline-Reviewer-002 (stray-products-r4, reviewer seat)
**review:** `sha256:d52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190` (`freeze-what-baseline-desk-reviewer-review.json`)
**verification:** `sha256:8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21` (`freeze-what-baseline-desk-reviewer-verification.json`)
**trace:** `sha256:8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252` (`freeze-what-baseline-desk-reviewer-trace.json`)
**product submission:** `sha256:6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac` (`freeze-what-baseline-desk-reviewer-product-submission.json`)
**decision:** `hold-upheld` — freeze ratification REFUSED; no WHAT-baseline material authored; no freeze effect fired.

## What this staffing adjudicated

This round's desk task frame, for the first time since r3, carries an envelope-layer authority claim: `upstream-accepted[0] sha256:e210334e…` :: *"accepted revision of freeze-what-baseline"*, with the workspace summary *"1 accepted upstream revisions travel by content address"*. This seat adjudicated the claim at the **content layer** (textual citation proves nothing — the address is only decidable by hashing):

- **The address RESOLVES.** A workspace-wide three-body scan (raw bytes, whole-JSON canonical, `.content` canonical; 2,756 files) hash-resolves it to exactly one content: `docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json` — the contract suite's **green-path payload-contract fixture** (`frf-contracts.what-baseline.v1` test example, consumed by the what-freeze cell tests and corpus tooling).
- **The fixture is not acceptance authority.** It is not a WorkplaceProductionRevision of this chain: no submission, no desk, no reviewer stage exists for it; its 5 `acceptanceRecords` are placeholder triples (all 15 digests hash-resolve to zero contents); its `caseIdentity` refs are placeholders (`case:form-1`, `cert:disc-1`). It is cited in the corpus only by the r3 RC-001 adjudication set, which refuses it. **Adjudication: REFUSED as acceptance authority (fixture-misdeclared-as-accepted-revision; CRIT-1 family).**
- **Self-referential upstream (CRIT-2).** The resolved content is itself a what-baseline — this desk's own product kind — so it cannot constitute this desk's upstream revision; the desk's only lawful upstream gate is reconcile-what.
- **The prohibition stands undischarged (CRIT-3).** FR-Reconcile-What-001 (`39a94a29…`, repair) and emission B FR-Reconcile-What-002 (`702fc967…`, recomputed repair) recompute; no re-run round exists; per R2 only a future reconcile-what reviewer verdict of record can discharge it.
- **Census and contract unmoved.** 0 of 5 pre-freeze desks accepted (every verdict-of-record row recomputes); `frf-contracts.what-baseline.v1` (schema raw `ab1b7f5e…`, `acceptanceRecords` minItems 5) remains unsatisfiable.

## Reviewer-sequence context

- **RC-Freeze-What-Baseline-001** (`c19344fd…`, the desk's first reviewer-stage record) adjudicated this same frame delta **UNRESOLVABLE** under its qualification-tree-scoped scan (317 files). This seat's **workspace-wide** scan sharpens that finding: the address **does resolve — to the fixture**. Disposition unchanged: both reviewer records refuse the claim; the resolution fact is superseded here by content address.
- **AS-Freeze-What-Baseline-001** (`c2a08f04…`, author re-staff) independently confirms the standing hold with 0 new accepted lineage (workspace-wide movement scan).
- Frame skill pins (`bc8a4261…` protocol, `2cbcf850…` semantic) hash-resolve to zero contents — recorded as provenance, not ratified (MAJ-1); the r2-era governing anchor `a926df6284…` also remains unresolvable and is NOT pinned by this round's frame.

## Verification

`freeze-what-baseline-desk-reviewer-verify.mjs` — 50/50 checks green (`freeze-what-baseline-desk-reviewer-verify-out.json`, digest-pinned): the four records self-address and cross-bind acyclically (V1–V2, with an explicit self-reference-paradox guard), FR internal consistency and honest false rows (V3), frame identity verbatim (V4), the full basis re-verified fresh including the workspace-wide resolution scan (V5), 30-edge trace resolution over recomputed digests (V6), determinism probes + file-family discipline (V7), verify-out self-digest (V8).

Two emission-repairs landed this staffing and are recorded here (kept out of the digest-pinned records): the builder's evidence list initially derived the gate emission-B ref from the wrong object (`sha256:undefined`) and was rebuilt; the verifier's covers-expectation initially demanded a record contain its own address (self-reference paradox) and was repaired to a paradox guard.

## Resume contract (R1–R4 of the standing hold, unchanged)

R1: genuinely accepted revisions land for the four upstream desks through completed reviewer stages at their own content addresses; RA-5 re-runs reconcile-what over the NEW accepted chain. R2: the re-run reviewer verdict of record alone discharges the no-accept prohibition — never this desk, never a frame assertion. R3: on five accepted pre-freeze desks this desk re-staffs and authors the whole-WHAT baseline strictly against the accepted triples and `frf-contracts.what-baseline.v1`. R4: the hold and this refusal are not carried as product lineage; the baseline cites only accepted revisions.
