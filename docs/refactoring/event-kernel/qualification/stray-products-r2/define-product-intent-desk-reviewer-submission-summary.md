# define-product-intent desk (reviewer) - r2 review record

Round: stray-products-r2 · reviewed candidate of record: PRD-Define-Product-Intent-001
(`sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055`, submission FS-Define-Product-Intent-001 `sha256:91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0`,
trace `sha256:6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **64 recomputations** (`define-product-intent-desk-reviewer-verify.mjs`), rule
  `sha256(canonicalJson)` per `src/workflow-kernel/domain/digest.ts`:
  **63 pass / 1 fails**. Full evidence:
  `define-product-intent-desk-reviewer-verification.json` (VV-Define-Product-Intent-001,
  `sha256:c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a`).
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
(FR-Define-Product-Intent-001, `sha256:e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4`); the headline pair:
**RA-1** reissue `prd:scope-2` as a carried system-boundary (`scenario_required`) or cite a
genuinely recorded Discovery decision address; **RA-2** re-seal the contract layer so the
governing address resolves, then update it across r2.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | `sha256:c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a` |
| review | formalization-review | `sha256:e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4` |
| trace | reviewer-verdict-trace | `sha256:1bf917cf4c125a2d8bbf7af90869bcc6e2612495334f0f33a5f6733fc93fcb5d` |
| submission | FS-Define-Product-Intent-003 | `sha256:3473cdb7ef7d594db5ddaaa35bb9654b6ba4d19ea0c3bdbf98cb0accaf4afb0e` |

Pinned timestamp 2026-08-28T00:00:00Z across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.

## Provenance addendum (2026-08-28, collision history and restoration record)

This record supersedes the earlier provenance addendum (whose text was lost when the
desk builder rewrote this file during restoration; that addendum's claim that the four
reviewer artifacts were "NOT displaced" was falsified by the second collision below).

**First collision (~01:04).** The canonical reviewer tooling filenames were overwritten
by a concurrent writer. The evidence generator was preserved collision-free as
`define-product-intent-desk-reviewer-verify-fr001.mjs`; the concurrent writer's
`define-product-intent-desk-reviewer-verify.mjs` (01:04) was left in place.

**Second collision (found at desk-session start, 01:07 state).** Three of the four
reviewer artifacts under the canonical filenames carried a CONCURRENT reviewer package:

| artifact | displaced content | package |
|----------|-------------------|---------|
| verification | `sha256:9ddc6ca4c293446ea36706c1e72e2cf43ed97a9763424e7a9d0b3df0d15ca446` (90 checks, 89/1, governing-contract failure classified NON-blocking residue) | concurrent |
| trace | `sha256:b2221fd32ecd21b086a5d9df8e169e588a84346609a0515a01f5fd72076bc2df` | concurrent |
| submission | FS-Define-Product-Intent-002 `sha256:f9ead68a8e309580782d0effa888a6df2f940c1b9432b9811970816967d16343`, verdict **accepted** | concurrent |
| review (ref) | `sha256:bff4aca147aaee18c7224b6b05d4d533190bd42ee15e967b321dffbe24990f08` — **no content at this address exists on disk** | concurrent |

`review.json` (the FR-001 repair review of record) and this summary survived intact.

**Adjudication.** The concurrent package's ACCEPTED verdict is REJECTED as the desk
record, on re-confirmed substance:

- CRIT-1 re-confirmed from the accepted capsule material: SC-2 (`cb291aa7...`) is
  `{claimId, statement}` — a bare claim; CERT-1 (`03972527...`) is a subject-level `go`;
  yet `prd:scope-2` disposes accepted scope material `out_of_scope` "by the Discovery
  decision recorded in the capsule". No such decision exists. Acceptance would have
  silently removed `claim:scope-2` from the intent surface under fabricated authority
  (D10/TC-2 violation).
- MAJ-1 re-confirmed: `I4.governingContract.resolves` fails on rerun (64/63/1); six r1
  claimant files declare `a926df62...` and recompute otherwise.

**Restoration (deterministic, nothing hand-authored in sealed artifacts).**

1. Evidence regenerated by the collision-free generator:
   `node define-product-intent-desk-reviewer-verify-fr001.mjs` → `verify-out.json`
   (64 recomputations, 63 pass, 1 fail = I4.governingContract.resolves).
2. The four artifacts rebuilt by the desk builder
   (`define-product-intent-desk-reviewer-build.mjs`). Builder precision fix: the VV
   workspaceLaw prose now interpolates the LIVE K2 scan count from the evidence run
   (190 files) instead of a hardcoded stale 176.
3. Equivalence proof: the rebuilt FR content, re-bound to the lost VV digest
   `f7d1e5ad4cbfaeb50e5b63b00ff436825c4f097d812dd827ba7953795dcbcccc`, reproduces the
   of-record review `sha256:b9710b1cd44dcab32f0077c059785097f7f6930b94341c4e21b47b2022b07765`
   byte-exact under sha256(canonical JSON) — i.e. the SAME review, re-sealed against the
   regenerated verification artifact.

**Address ledger (all superseded addresses recorded per ADV-5/RA-5; distinct reviewers
must not share filenames — anchor tooling to the review semantic code).**

| package | VV | FR (review) | RT (trace) | FS (submission) | status |
|---------|----|-------------|------------|-----------------|--------|
| first repair package | `f7d1e5ad...` | `b9710b1c...` | `ef2dfcae...` | FS-003 `a38624d4...` | lost to collisions |
| concurrent package | `9ddc6ca4...` | `bff4aca1...` (unresolvable) | `b2221fd3...` | FS-002 `f9ead68a...` | REJECTED (accepted verdict) |
| interim rebuild | `dc422dcf...` | `6c9c8324...` | `266bf002...` | FS-003 `fa8238ed...` | superseded (scan-count precision) |
| **package of record** | `c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a` | `e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4` | `1bf917cf4c125a2d8bbf7af90869bcc6e2612495334f0f33a5f6733fc93fcb5d` | FS-003 `3473cdb7ef7d594db5ddaaa35bb9654b6ba4d19ea0c3bdbf98cb0accaf4afb0e` | **current** |

Final-state rerun receipt: `verify-rerun-fr001.json` (verifier re-executed against the
restored tree; the candidate of record is unchanged since 00:50).

## Provenance addendum 2 (2026-08-28, emission-B supersession, concurrent confirmation, desk closure)

Correction to addendum 1: its final rerun receipt line named `verify-rerun-fr001.json`,
but the collision-free generator was renamed to the canonical
`define-product-intent-desk-reviewer-verify.mjs` (ex `-fr001` copy) before that run;
the real final-state receipt is `verify-rerun.json`
(64 recomputations, 63 pass, 1 fail = I4.governingContract.resolves, unchanged).

**Concurrent emission-B supersession (content-addressed).** A second reviewer writer
emitted into the same canonical filenames during restoration. The collision is recorded
in `define-product-intent-desk-reviewer-collision-record.json`
(CR-Define-Product-Intent-001, `sha256:b54c5ba7a8f0f6996595db4a2fca6ae419781f3c167666f1f7a25af55e116a08`,
self-digest recomputes): **emission-A (repair) is the verdict of record; emission-B
(accepted) is superseded.** The emission-B author independently re-verified CRIT-1
before superseding (SC-2 `cb291aa7...` bare claim; CERT-1 `03972527...` subject-level
go; no Discovery exclusion decision exists) and conceded: "The accepted verdict of
emission-B is WRONG; repair is correct."

**Concurrent independent confirmation.** A third writer produced a namespaced package
(`define-product-intent-desk-reviewer2-*`, own filenames per ADV-5) whose review is
verdict **repair** with the same CRIT-1 + MAJ-1; all four reviewer2 artifacts recompute.
The desk therefore holds three independent repair verdicts (restoration emission-A,
reviewer2, and the emission-B concession) plus the collision record.

**Preserved-file correction.** The `-emission-b` filenames actually preserve the
INTERIM repair rebuild of addendum 1 (VV `dc422dcf...`, FR `6c9c8324...`,
RT `266bf002...`, FS-003 `fa8238ed...` — all self-digests recompute). The collision
record's emissionB address set (`6dc35484...` / `77e9a931...` / `2bff9245...` /
`8881558b...`) resolves to no on-disk content — recorded here as stale for the record
owner (same unresolvable-ref class this round penalizes; the record's semantic outcome
is unaffected).

**Final state (all digest-verified at closure).**

| role | artifact | address | recomputes |
|------|----------|---------|------------|
| verdict of record | review FR-Define-Product-Intent-001 | `sha256:e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4` | yes |
| evidence | verification VV-Define-Product-Intent-001 | `sha256:c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a` | yes |
| trace | reviewer-verdict-trace | `sha256:1bf917cf4c125a2d8bbf7af90869bcc6e2612495334f0f33a5f6733fc93fcb5d` | yes |
| submission | FS-Define-Product-Intent-003 (verdict repair) | `sha256:3473cdb7ef7d594db5ddaaa35bb9654b6ba4d19ea0c3bdbf98cb0accaf4afb0e` | yes |
| collision record | CR-Define-Product-Intent-001 | `sha256:b54c5ba7a8f0f6996595db4a2fca6ae419781f3c167666f1f7a25af55e116a08` | yes |
| final rerun receipt | verifier output | `verify-rerun.json` (64/63/1, I4) | n/a |

Desk outcome: **repair** returned to the define-product-intent author (RA-1 critical:
reissue `prd:scope-2` as carried boundary material or cite a genuinely recorded
Discovery decision address; RA-2 major: re-seal the contract layer so governing anchor
`a926df62...` resolves). The desk does not settle the intent set while accepted scope
material is dispositioned under authority that does not exist.
