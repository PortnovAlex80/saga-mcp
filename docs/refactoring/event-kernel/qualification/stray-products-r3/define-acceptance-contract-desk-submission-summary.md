# Define Acceptance Contract Desk (author) — Submission Summary

**Desk:** define-acceptance-contract
**Role:** author
**Workspace:** `docs/refactoring/event-kernel/qualification/stray-products-r3/`
**Round purpose:** the next desk of the r3 chain (define-product-intent → model-use-cases → derive-system-requirements → **define-acceptance-contract**), same task-projection envelope, same governing contract, accepted upstream material traveling by content address
**Status:** authored, self-verified (REAL cell validator + REAL WP03 seam), deterministic rebuild proven byte-stable
**Date:** 2026-08-28 (pinned timestamp `2026-08-28T00:00:00Z` on all artifacts)

## Candidate

- Kind `formalization.acceptance-bindings.v1`, payload contract `frf-contracts.ac-binding.v1`, cell check provider `frf.acceptance-closure.v1`.
- Bundle SEALED by the REAL installed cell validator `validateAcceptanceBundle` against the universe derived by the REAL desk protocol `acceptanceUniverseFrom` — seal `sha256:14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51`.
- Artifact `sha256:2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0`; trace `sha256:2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1`; submission `sha256:6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe`.
- Deterministic authoring (pinned timestamps, no clock reads, no randomness): a full rebuild reproduced every ref byte-identically.

## Upstream Material (re-verified by recomputation, never trusted by declaration)

- All three upstream artifacts (intent, UC scenarios, requirements) re-digested; member seals recomputed over canonical members (6 PRD members, 3 UC scenarios, 4 requirements) — every recomputed seal matched the declared digest.
- Revision pins re-folded through the REAL folds: PRD revision `a30229a75bed4c5d…` (`acceptedIntentSetOf`), UC revision `184981e5724c286d…` (scenario-seal fold) — both match the accepted requirements bundle's pins.
- The accepted requirements bundle was re-sealed against its recomputed WP03 universe (`deriveAcceptedUniverse` + real `validateRequirementsBundle`) BEFORE consumption: seal `sha256:60083eb4a2ba553d…`.
- Discovery import artifact, capsule, certificate, and the 8 task-projection content addresses (4 source claims, 1 constraint, 1 unknown, 2 terminal claims) cross-checked against this desk task projection.

## Acceptance Contract Authored (five atomic criteria, no deferrals, no standalone evidence bindings)

| Criterion | Verifies | UC citation (BOTH shapes) | Evidence | Observable terminal result |
|---|---|---|---|---|
| `ac:boundary-1` | `fr:boundary-1` | `uc:boundary-1` + `branch:boundary-1-main` | test | deterministic response received inside the accepted boundary |
| `ac:outcome-1-delivered` | `fr:outcome-1` | `uc:outcome-1` + `branch:outcome-1-main` | test | accepted Discovery outcome delivered (`terminal:delivered-1`) |
| `ac:outcome-1-deterministic-error` | `fr:outcome-1` | `uc:outcome-1` + `branch:outcome-1-deterministic-error` | monitoring | deterministic error response, no nondeterministic content |
| `ac:terminal-1-audited` | `fr:terminal-1` | `uc:terminal-1` + `branch:terminal-1-main` | audit | go triage with recorded strengths (`terminal:audited-1`) |
| `ac:determinism-1` | `nfr:determinism-1` | none — the NFR is not scenario-derived | test | every response deterministic, no invented content |

- Coverage closure: 4/4 accepted FR/NFR covered by ≥1 criterion; 4/4 required UC terminal branches covered by end-to-end criteria (cr-05).
- Every criterion cites its accepted verifiable statement (desk-authored given/when/then set, 5 statements, seals recomputed).
- `prd:scope-2` (out_of_scope) derives no criterion; `unknown:browser-matrix-1` stays carried_forward with owner `discovery` and zero derivation edges; `constraint:retention-1` honored (verified through `ac:determinism-1` and the deterministic-error criterion).

## Mechanical Verification (`define-acceptance-contract-desk-author-verify.mjs`, 100/100 pass)

- Every declared digest recomputed (submission, artifact, trace, 5 criterion seals, 5 statement seals) — nothing trusted by declaration.
- REAL cell surface: `acceptanceUniverseFrom` (fail-closed) → `validateAcceptanceBundle` (which drives the WP03 `validateAcBinding` seam once per criterion) — re-seal matches the declared product seal.
- Three closure laws re-run directly: requirements coverage, AC-to-source, terminal-result coverage — 0 issues.
- Negative probes (all killed): stripped terminal-branch citation → `MISSING_LINEAGE`; foreign scenario substitution → `FOREIGN_LINEAGE`; foreign requirement ref → `FOREIGN_LINEAGE`; uncovered requirement → `COVERAGE_GAP`; WHAT-side key injection → `SCOPE_VIOLATION`.
- Trace: 16 relationships resolve at both ends to recomputed digests; every coverage block is an exact projection of the edge set; branch refs resolve to their owning frozen scenario member's seal.
- Evidence set: 21 unique content addresses (3 accepted bundles, import/capsule/certificate, 8 envelope claims, governing contract, 3 trace + 3 submission digests + intent trace/submission), coverage map sums exactly.

## Compliance

- Desk skill laws ac-1…ac-7 hold and are enforced by the real checks, not asserted (exact FR/NFR lineage, BOTH citation shapes, closed evidence vocabulary with observable terminal results, WHAT-side fence, full coverage, unique criterion ids).
- Fence respected: the candidate is exactly the `formalization.acceptance-bindings.v1` bundle — no architecture, module-allocation or file decisions anywhere.
- Workspace law: **0 accepted upstream revisions travel by content address** (verbatim on all three artifacts).

**Recommended next stage:** reviewer stage of the define-acceptance-contract desk (intake receipt `evidence:DeskIntakeReceipt#define-acceptance-contract:author`, status `admitted_for_reviewer_stage`), then `reconcile-what`.
