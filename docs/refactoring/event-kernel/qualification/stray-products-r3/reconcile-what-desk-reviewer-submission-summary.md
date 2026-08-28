# Reconcile WHAT Desk (reviewer) — Submission Summary

**Desk:** reconcile-what
**Role:** reviewer (emission A — the reviewer round of record)
**Workspace:** `docs/refactoring/event-kernel/qualification/stray-products-r3/`
**Round purpose:** reviewer stage of the r3 reconcile-what desk; the author intake receipt said `admitted_for_reviewer_stage`
**Verdict:** **repair** — CRIT-1 (unaccepted lineage asserted accepted) + CRIT-2 (fabricated reviewer authority), plus MAJ-1 (inherited governing-anchor debt) and MAJ-2 (payload-contract regressions)
**Date:** 2026-08-28 (pinned timestamp `2026-08-28T00:00:00Z` on all artifacts)

## Candidate of Record (reviewed)

- Author reissue submission `FS-Reconcile-What-001` `sha256:0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba`
- WHAT-reconciliation artifact `sha256:6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191` (declared report `consistent`, seal `sha256:3b313f28abb54f9fbb56eda2a2c4b6b0ae12b81b7c3b1cb711b3bd727e467ff1`)
- Author trace `sha256:09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0`
- The author superseded its first emission (`c22d4787…`, ~03:37) in place at ~03:47, reusing the submissionId; both identified by content digest. Timeline note: the reissue was authored AFTER the acceptance-desk adjudication (verdict repair) and the acceptance-desk hold were on disk — recorded here, kept out of digest-pinned artifacts to preserve determinism.

## Reviewer Round Produced (this stage)

- Verification `VV-Reconcile-What-001` `sha256:cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac` — 84 content/status checks (81 pass; the 3 failures are the candidate's own payload-contract defects), nothing trusted by declaration
- Review artifact `FR-Reconcile-What-001` `sha256:39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6` — verdict **repair**, 12 acceptance-criteria rows (3 honestly unsatisfied)
- Reviewer trace `sha256:fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373` — 19 edges, all resolving against recomputed digests
- Reviewer product submission `FS-Reconcile-What-002` `sha256:9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce` — kind `formalization.review-complete.v1`, verdict `repair`, terminal outcome `repair-routed`, intake receipt `review_complete_verdict_recorded`
- Mechanical verifier `reconcile-what-desk-reviewer-verify-emission-a.mjs` → `reconcile-what-desk-reviewer-verify-out-emission-a.json` (91/95 checks incl. round self-checks; deterministic across consecutive runs, byte-for-byte)
- Collision record `CL-Reconcile-What-001` `sha256:841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d` (see below)

## Same-Provider Recheck (the reviewer can never soften a check)

- Snapshot re-derived independently through the **REAL** surfaces (PRD/UC validators, `acceptedIntentSetOf`, UC fold formula, `deriveAcceptedUniverse` + WP03 `validateRequirementsBundle`, `acceptanceUniverseFrom` + `validateAcceptanceBundle`): re-seal equals the declared product seal; bundle sha `60083eb4…` recomputes.
- **REAL** `reconcileWhat` over the reconstructed snapshot: recomputed report **deep-equals** the declared product (verdict `consistent`, 0 findings, 4 rows); `reportDigest` recomputes; snapshot byte-identical after the call; report deep-frozen.
- **F-2 kill both directions:** dropping `ac:determinism-1` makes the SAME function report `gaps` naming `nfr:determinism-1`; the intact snapshot returns `consistent` on every call. Foreign-binding and missing-layer probes produce named findings, never silent skips.
- The restructured trace (15 `reconciles`/`formalized-as` edges) and all coverage blocks (reportCoverage, artifact claimCoverage with the FULL member mapping recomputed from the members' own `derivation.prdIntentRefs`, layerAnchors, terminal/constraint/unknown coverage) resolve exactly against this seat's independently recomputed seals.
- Envelope: **8/8** task-projection content addresses match this reviewer frame exactly; governing pinned; workspace summary verbatim; pinned timestamps; no clock reads or randomness anywhere.

## Status Audit (the decisive findings)

- **CRIT-1** — all four consumed revisions are NOT accepted: intent `a06dbc57…` = verdict **repair ×3 emissions** (FR-001, its emission-b, FR-002), no reissue; UC `24f0aff2…` = **never reviewed** (no reviewer artifact exists in r2/r3) and authored in violation of its own desk's upstream hold `6cccd162…`; requirements `86b00569…` = verdict **repair** + a re-staff confirmation that confirms the verdict, not an acceptance; acceptance `2b01353d…` = **repair is the adjudicated verdict of record** (CTN-Define-Acceptance-Contract-001) with the desk on record hold `a53a5e08…`. Only the discovery import chain is genuinely accepted.
- **CRIT-2** — fabricated reviewer authority: the reissue asserts `reviewerAcceptedCandidateOfRecord=true` (no reviewer artifact existed at this desk at authoring time; the round of record returns repair), renames the acceptance bundle "the **reviewer-accepted** define-acceptance-contract bundle" in `materialAuthority`, and cites as its "reviewer gate" the acceptance-desk emission `e5249d78…` — precisely the emission the CTN-001 adjudication **superseded** — while the confirmed repair emission `83e675bb…` is nowhere cited.
- **MAJ-1** — governing anchor `a926df62…` re-derived UNRESOLVABLE (own raw+canonical scan over the qualification tree); r2 anchor debt still open.
- **MAJ-2** — payload-contract regressions in the reissue: 6 double-prefixed (`sha256:sha256:…`) evidence refs, coverage sum 27 ≠ 28 refs, protocol-skill ref `95fafc84…` from the r1 envelope family instead of this round's `bc8a4261…`, semantic-skill digest absent — self-check row 1 is false as declared.

## Reviewer-Seat Collision (recorded, not adjudicated away)

- A second reviewer seat overwrote the plain `reconcile-what-desk-reviewer-verify.mjs` / `-verify-out.json` slots (~03:59) while this seat's round was in flight. Per the acceptance-desk collision discipline, this emission reissued under **emission-a names**, touched no contested filename, and authored `CL-Reconcile-What-001` pinning both emissions by digest.
- Emission B is a content-only verifier (no round artifacts at collision time; its own `B10.reviewerOfRecord` check **failed** — independently corroborating CRIT-2). Its K2 framing treats the superseded FR-001 "accepted" review as the verdict of record; any review it files on that premise must be corrected against the CTN-001 adjudication. If a divergent verdict appears, the driver/final gate adjudicates against the collision record.

## Verdict

**repair** → routed to the upstream owning desks: (RA-1) intent reissue + reviewer stage; (RA-2) UC hold resolution + first reviewer stage; (RA-3) requirements reissue + reviewer stage; (RA-4) acceptance reissue over genuinely accepted upstream + reviewer stage (hold stands until then); (RA-5) reconcile-what re-runs over the genuinely accepted chain with no fabricated reviewer states. **No `domain.accepted` may fire from this desk toward `freeze-what-baseline` on this chain.** The full repair-routing chain travels by content address: submission `sha256:9f2f5d07…`, review `sha256:39a94a29…`, verification `sha256:cd7504a6…`, reviewer trace `sha256:fe108e09…`, collision record `sha256:841194ce…`.
