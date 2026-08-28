# define-acceptance-contract desk (reviewer) — emission C (adjudicating) — Submission Summary

**Desk:** define-acceptance-contract · **Role:** reviewer · **Round:** stray-products-r3
**Verdict of record:** **repair** · **Pinned timestamp:** 2026-08-28T00:00:00Z on all artifacts

## What this emission is

A fresh reviewer dispatch arrived with the same task-projection envelope as the two
earlier reviewer emissions and found the seat in contention
(`CL-Define-Acceptance-Contract-001`, `CTN-Define-Acceptance-Contract-001`):
emission A said **repair** (99 recomputations, 92 pass / 7 fail, status-layer audit),
emission B said **accepted** (50 digest/gate-level checks, no status-layer audit) and
had overwritten emission A's canonical files in place. This emission adjudicates the
contention on independently re-derived evidence and writes **only its own
`-emission-c` files** — no contested filename is touched, nothing is erased.

## Independent verification performed (nothing trusted by declaration)

- **Chain mechanics (confirmed clean):** candidate/upstream artifact digests recomputed
  (canonical JSON) — candidate `2b01353d…`, intent `a06dbc57…`, UC `24f0aff2…`,
  requirements `86b00569…`; the bundle re-seals through the **REAL** acceptance cell
  (`acceptanceUniverseFrom` → `validateAcceptanceBundle`, WP03 `validateAcBinding` ×5)
  to the exact declared product seal `14fda791…`.
- **Status layer (defects re-derived from primary records):** intent verdicts
  `FR-Define-Product-Intent-001/-002` read directly — both **repair** against the exact
  consumed revision, no reissue; requirements verdict `FR-Derive-System-Requirements-001`
  read directly — **repair** + re-staff confirmation; UC reviewer stage — corpus-wide scan
  found **zero** reviewer artifacts (and the r2 upstream hold `6cccd162…` on record);
  capsule **SC-2 is a bare claim** and **CERT-1 a subject-level go** — no scope-2
  exclusion authority exists; governing contract `a926df62…` — **0 content hits across
  261 files** (97 textual mentions); envelope projection `32892970…` — **phantom**
  (0/261; stale shell metadata, r2 RA-5 open).
- **Contention evidence:** emission A's mechanical verifier re-run by this emission
  reproduces **99/92/7 with zero per-check verdict differences** (2 scan-count detail
  diffs: corpus grew 254 → 261 files with the collision artifacts — expected);
  emission B's verification surface enumerated — 50 checks in 10 groups, **no
  counterpart** of I4/L2/M2-M5/N1; collision record `CL-001` self-digest recomputes.

## Adjudication

**Verdict of record: repair.** Emission A **confirmed**; emission B **superseded**
(preserved, never erased). Grounds: the seven status-layer failures re-derive from
primary records independent of emission A's script; the candidate is digest-clean, so
the defects live at the workflow-status layer — precisely what the digest/gate surface
cannot see and what the desk review seat exists to adjudicate. An `accepted` verdict
whose verification surface lacks the status audit is not evidence-backed against
recomputable failures still on disk — exactly what CL-001 resolution demand 1 forbids
the final gate to consume. The r2 precedent (`CL-Define-Product-Intent-001`) resolved
the identical defect class the same way.

## Findings (verdict repair)

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | The acceptance surface binds revisions that are **NOT accepted** while asserting they are: intent `a06dbc57…` repair ×2 (no reissue), UC `24f0aff2…` never reviewed + authored in violation of its desk's upstream hold, requirements `86b00569…` repair + re-staffed. Only the import chain is genuinely accepted. |
| CRIT-2 | CRITICAL | The candidate restates the `prd:scope-2` out_of_scope exclusion **as settled fact** (brief + self-check 10); SC-2 is a bare claim, CERT-1 a subject-level go — three upstream verdict records established the cited authority nonexistent. |
| MAJ-1 | MAJOR | `governingContractRef` `sha256:a926df62…` resolves to **no content** workspace-wide (this emission: 0/261 files) — the unremediated r2 RA-2/RA-4 debt, now inherited by a fourth desk. |
| ADV-1..3 | advisory | Stale envelope projection (phantom accepted revision); the reviewer-seat collision itself (r2 ADV-4 defect class repeated, canonical namespace left MIXED); the byte-identical relabeling round that silently overrode the UC hold. |

**Required actions RA-1..RA-7** in `define-acceptance-contract-desk-reviewer-review-emission-c.json`.
Headline: **RA-1** this desk HOLDS until genuinely accepted revisions exist, then
reissues against verdict-backed revisions only; **RA-2** settle the intent contention
and restore `claim:scope-2`; **RA-3** give the UC bundle its never-run reviewer stage;
**RA-6** single-seat discipline for desk review stages (one seat, one emission;
supersede by content address, never overwrite in place).

## Emission C artifact index (all content-addressed, deterministic)

| artifact | semantic code | address |
|----------|---------------|---------|
| verification | VV-Define-Acceptance-Contract-002 | `sha256:61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5` |
| review (verdict of record) | FR-Define-Acceptance-Contract-002 | `sha256:7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e` |
| trace | RT-Define-Acceptance-Contract-002 | `sha256:9304f5f1fb799878a87843e20cf97ec1ba492af544cc035d861b438636197f15` |
| product submission | FS-Define-Acceptance-Contract-003 | `sha256:bdd577ae01eccfdcf1334239271fae5478351294a4523607f832603a95ae33ac` |
| builder (evidence generator) | — | `define-acceptance-contract-desk-reviewer-build-emission-c.mjs` |

Product submission: kind `formalization.review-complete.v1`, payload contract
`effectId formalization.accept-products`, verdict `repair`, intake status
`review_complete_verdict_recorded`, next stage `final-gate`.

## Verdict

**repair** → the final gate consumes this adjudicated verdict (CL-001 demand 1);
the desk holds (RA-1) until genuinely accepted revisions exist, then reissues against
them. The chain may not reach reconcile-what on relabeled lineage.
