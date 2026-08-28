# define-product-intent desk (reviewer, DISSENT re-issue) - r2 review record

Verdict: **repair** · FR-Define-Product-Intent-002 `sha256:0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc`
· candidate of record: PRD-Define-Product-Intent-001 `sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055` (unchanged since 00:50)

**CONTENTION OPEN.** A concurrent writer issued FR-Define-Product-Intent-001
(`sha256:bff4aca147aaee18c7224b6b05d4d533190bd42ee15e967b321dffbe24990f08`, verdict **accepted**) at 01:07 in the same namespace,
displacing this reviewer's FR-001 (also repair, `b9710b1c...`). Nothing was overwritten:
both records travel by content address. Per fail-closed doctrine the desk **must not settle**
until the driver/human adjudicates.

## The two disputed points

| id | contending FR-001 (accepted) | this FR-002 (repair) |
|----|------------------------------|----------------------|
| DIS-1 scope-2 | coverage evidence checks FORM only: "out_of_scope (owner product-owner + reason)" | SUBSTANCE check S1/S2: the cited "Discovery decision recorded in the capsule" **does not exist** - SC-2 (`cb291aa7...`, recomputed) is a bare claim; CERT-1 is subject-level go. Accepted scope material silently removed under fabricated authority. BLOCKING. |
| DIS-2 governing anchor | found, classified "cross-round provenance residue, non-blocking" | found too (`a926df62...` unresolvable; r1 rendering recomputes `b880d0b7...`); a `requiredEvidenceRefs` member must resolve at acceptance time. BLOCKING. |

Everything else is agreed: candidate digests recompute (REAL kernel WP03 validator seals all
6 members), trace resolves, capsule chain verifies, unknown carried, terminals owned,
workspace law 0 upheld (envelope projection `745cadc1...` unresolvable - r1 CRIT-001 closed).

## Reviewer2 artifact index (content-addressed, deterministic, collision-free)

| artifact | kind | address |
|----------|------|---------|
| verification | VV-Define-Product-Intent-002 | `sha256:e1390d6e539d4ab2721c6a6f4f54c2bf7ea2557bfca047760c2cabb6af043eec` |
| review | FR-Define-Product-Intent-002 | `sha256:0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc` |
| trace | RT-Define-Product-Intent-002 | `sha256:84324a50809fab818b9064a1d8a5bd0d6e752f8d446e05fab1c0615ac768ade4` |
| submission | FS-Define-Product-Intent-004 | `sha256:a0bc5e4d50ac176fcc8c0f0697b626e2c4f8a07cdd0c81721ca1cef43827c63d` |

Required actions RA-1..RA-5 in the review artifact. Pinned 2026-08-28T00:00:00Z; sha256 over
canonical JSON everywhere. Evidence generator: `define-product-intent-desk-reviewer-verify-fr001.mjs`
(64 checks; this build re-ran the checks inline - 58 checks,
56 pass, 2 fail: S1.scope2.authorityExists, I4.governingContract.resolves).
