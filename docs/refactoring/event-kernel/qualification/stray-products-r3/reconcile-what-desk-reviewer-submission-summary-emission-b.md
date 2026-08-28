# reconcile-what desk (reviewer) - emission B (corrected) - r3 review record

Round: stray-products-r3 · reviewed candidate of record: SR-Reconcile-What-001
(`sha256:6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191`, submission FS-Reconcile-What-001 `sha256:0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba`,
trace `sha256:09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0`, computed report `sha256:3b313f28abb54f9fbb56eda2a2c4b6b0ae12b81b7c3b1cb711b3bd727e467ff1`) · verdict: **repair**
(concurring with the round of record — emission A, bound by
CL-Reconcile-What-001 `sha256:841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d` — by independent three-layer
re-derivation; filed under emission-b names per the collision discipline)

## Why this emission exists (self-correction on the record)

This seat's first pass (B-1) was content-only: 54 digest-layer recomputations, all passing, and
an **accepted** review grounded in the acceptance-desk accepted emission `e5249d78…` as its
reviewer gate. That premise was false: the CTN-Define-Acceptance-Contract-001 adjudication
**superseded** that emission — the verdict of record over the consumed acceptance bundle is
**repair**. B-1 (review `sha256:sha256:e86a6e27c7a93a0ea25bde6f455dc36469f70f38333256d6a0b6f1666844a951` and companions) is **withdrawn by
content address**; it committed, in mirror image, the same defect the round exists to catch in
the candidate: fabricated reviewer authority.

## The three layers (nothing trusted by declaration)

- **Content — 53/53:** every
  digest recomputes; the report re-computed through the REAL `acceptance.reconcileWhat` over an
  independently re-derived snapshot is **byte-equal**; the computed-verdict law (the F-2 fix)
  holds and G1 kills the hardcode; report-only law proven (G5 purity + deep-freeze); all seven
  adversarial probes killed, zero softening. The mechanics are sound.
- **Status — 14/14:** the
  verdict-record audit over primary records proves the premise false: intent = r2 **repair ×2**
  emissions, no reissue, r3 copy byte-identical; UC = **never reviewed** + its desk's upstream
  hold `6cccd162…` standing; requirements = **repair** + re-staff confirmation; acceptance =
  adjudicated **repair** with the desk on record hold `a53a5e08…`. The candidate's reviewer gate
  cites exactly the superseded emission (CRIT-2). `revisionPinsMatchAcceptedRevisions=true` is
  false at the status layer.
- **Payload — 3/3:** 6 evidence
  refs carry a double `sha256:` prefix; kind coverage sums to 27 over 28 refs; the evidence set
  pins the r1-era protocol skill while this frame's protocol and semantic skills are absent.

## Findings

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | The reconciliation asserts a closed WHAT chain over **accepted** material; **no such material exists** — all four consumed revisions are repair-verdict, never-reviewed, or adjudicated repair. An accept effect would freeze a WHAT baseline whose entire lineage is unaccepted. |
| CRIT-2 | CRITICAL | **Fabricated reviewer authority**: the gate cites the superseded accepted emission; the confirmed repair emission `83e675bb…` is nowhere cited. |
| MAJ-1 | MAJOR | Governing anchor `a926df62…` resolves to **no content** (re-derived scan; r2 RA-2/RA-4 debt). |
| MAJ-2 | MAJOR | Payload regressions: 6 malformed refs, coverage 27/28, wrong-envelope skill pins. |

## Required actions

**RA-1** no accept effect; freeze-what-baseline blocked · **RA-2** intent desk reissue + real
reviewer stage · **RA-3** UC hold reconciliation + first-ever UC reviewer stage · **RA-4**
requirements reissue; acceptance hold stands · **RA-5** reconcile-what re-runs over the NEW
accepted chain with a rebuilt payload contract; the governing anchor must materialize or be
re-pinned before any freeze cites it.

## Reviewer artifact index (all content-addressed, deterministic, emission-b names)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification (VV-Reconcile-What-002) | `sha256:10325cc9abfcc1ee9acb2f02226c2581fd56f3fe103c825d41c1ea3c7afe4975` |
| review | formalization-review (FR-Reconcile-What-002) | `sha256:702fc96755b828eb427a2287ea661d1f685336c2646d08a7328030ab6923e1ba` |
| trace | reviewer-verdict-trace (RT-Reconcile-What-002) | `sha256:2b1a039264fbdfff6b028cd9519668cba7710eb1f6630b89b2a8ed416c37ff44` |
| submission | FS-Reconcile-What-003 | `sha256:7253aa5f50ceaa6b97d12b6eb8acfbce46ef1314963be7048c2046607a2087c7` |

Pinned timestamp 2026-08-28T00:00:00Z across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere. Contested plain slots untouched.
