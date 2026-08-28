# define-product-intent desk (reviewer) - r2 review record

Round: stray-products-r2 · reviewed candidate of record: PRD-Define-Product-Intent-001
(`sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055`, submission FS-Define-Product-Intent-001 `sha256:91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0`,
trace `sha256:6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **64 recomputations** (`define-product-intent-desk-reviewer-verify.mjs`), rule
  `sha256(canonicalJson)` per `src/workflow-kernel/domain/digest.ts`:
  **63 pass / 1 fails**. Full evidence:
  `define-product-intent-desk-reviewer-verification.json` (VV-Define-Product-Intent-001,
  `sha256:dc422dcfa4eaf963c5016f8973b3bf13a422a12747bfdba5eb84eec0a3ece1fe`).
- All **6 member seals** recompute **and** are sealed by the **real kernel WP03 validator**
  (`contracts/validators/prd-intent-member.mjs`) with the exact accepted id-set universe.
- The candidate transports all **8 reviewer-envelope content addresses** and they match exactly.
- The capsule chain re-verifies from the accepted import artifact (9/9 sub-artifacts +
  factBody self-address); the import-desk authority (artifact `sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5`,
  trace `sha256:2e5bb8ce3f26de726729c107760d43d5c81350b1a412f5c504d95352a0ef8274`, accepted review `sha256:cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b`) recomputes.
- Trace graph: 12/12 relationships resolve; member/terminal/constraint/unknown coverages
  equal the edge sets; both terminals owned exactly once; unknown carried forward (owner
  discovery), never resolved.

## Workspace-law adjudication (closes r1 CRIT-001/ACTION-001)

The reviewer frame projects **"1 accepted upstream revision"** (`sha256:745cadc1...`).
Verdict: **UNRESOLVABLE - author 0 upheld.** K2 scanned 176 workspace files: zero raw-byte
hits, zero canonical-JSON hits; the address occurs only as quoted protocol metadata inside
review documents. The r1 verdict was REJECTED, so no accepted define-product-intent revision
can exist. The r1 formalization was wrong on digest grounds; this r2 author is right.

## Why repair (not accepted)

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | `prd:scope-2` `out_of_scope` cites "the Discovery decision recorded in the capsule" - **no such decision exists** in the accepted capsule (SC-2 `cb291aa7...` is a bare claim; CERT-1 is a subject-level go). Accepted scope material silently removed from the intent surface under a fabricated authority. The WP03 validator cannot see it (refs resolve, closed vocabulary) - this is desk-review territory. |
| MAJ-1 | MAJOR | `governingContractRef` `sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837` **resolves to no content** workspace-wide; six r1 files declare it and all recompute to different digests (r1 CRIT-003 digest-drift family alive in the contract layer; also falsifies the accepted import review's "resolves" positive finding, which was never recomputation-backed). |
| ADV-1..4 | advisory | Undocumented fail-closed anchoring devices; absent protocol pin; partial import authority chain; mid-review in-place candidate replacement (00:48 → 00:50, id sequence 002→001) recorded in the review. |

Required actions RA-1..RA-5 are in the review artifact
(FR-Define-Product-Intent-001, `sha256:6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc`); the headline pair:
**RA-1** reissue `prd:scope-2` as a carried system-boundary (`scenario_required`) or cite a
genuinely recorded Discovery decision address; **RA-2** re-seal the contract layer so the
governing address resolves, then update it across r2.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | `sha256:dc422dcfa4eaf963c5016f8973b3bf13a422a12747bfdba5eb84eec0a3ece1fe` |
| review | formalization-review | `sha256:6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc` |
| trace | reviewer-verdict-trace | `sha256:266bf0025adb024963efd362b4ec5fc91180a02d63b087109e03ac0b0452a4a4` |
| submission | FS-Define-Product-Intent-003 | `sha256:fa8238edef592c01210325b8189b083ec5a78579ff3989ae372564c99a679c1f` |

Pinned timestamp 2026-08-28T00:00:00Z across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.
