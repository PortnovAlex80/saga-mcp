# Reconcile WHAT Desk (author) — Submission Summary

**Desk:** reconcile-what
**Role:** author
**Workspace:** `docs/refactoring/event-kernel/qualification/stray-products-r3/`
**Round purpose:** the next desk of the r3 chain (define-product-intent → model-use-cases → derive-system-requirements → define-acceptance-contract → **reconcile-what**), same task-projection envelope, same governing contract, accepted upstream material traveling by content address
**Status:** authored, self-verified (REAL reconciliation surface + REAL upstream re-derivation), deterministic rebuild proven byte-stable
**Date:** 2026-08-28 (pinned timestamp `2026-08-28T00:00:00Z` on all artifacts)

## Candidate

- Kind `formalization.what-reconciliation.v1`, cell check provider `formalization.reconciliation-structure.v1`, effect `formalization.accept-products`.
- The product is the REPORT of the REAL installed reconciliation surface `acceptance.reconcileWhat` over a snapshot recomputed from accepted material only. The verdict is COMPUTED from the typed findings (`verdict === 'gaps'` iff `findings.length > 0`; `consistent` iff `findings.length === 0` — the F-2 fix); the reconciler takes no verdict input at all, so nothing could be hardcoded.
- **Computed verdict: `consistent`, 0 typed findings, 4 claim coverage rows.** Report digest `sha256:3b313f28abb54f9fbb56eda2a2c4b6b0ae12b81b7c3b1cb711b3bd727e467ff1` (internally consistent: recomputed over the canonical report minus the digest field).
- Artifact `sha256:6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191`; trace `sha256:09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0`; submission `sha256:0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba`.
- Deterministic authoring (pinned timestamps, no clock reads, no randomness): a full rebuild reproduced every ref byte-identically.

## Upstream Material (re-verified by recomputation, never trusted by declaration)

- All four upstream artifacts (intent, UC scenarios, requirements, acceptance bindings) plus traces, submissions and the reviewer decision re-digested — every recomputed digest matched the declared value before consumption.
- Revision pins re-folded through the REAL folds: PRD revision `a30229a75bed4c5d…` (`acceptedIntentSetOf`), UC revision `184981e5724c286d…` (scenario-seal fold); intent/UC/requirement/criterion member seals recomputed over canonical members (6 PRD members, 3 UC scenarios, 4 requirements, 5 criteria) — all matched.
- The accepted requirements bundle re-sealed against its recomputed WP03 universe (`sha256:60083eb4a2ba553d…`), and the accepted acceptance bundle re-sealed through the REAL `validateAcceptanceBundle` against the re-derived acceptance universe — re-seal `sha256:14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51`, exactly the published product seal.
- Reviewer gate: the define-acceptance-contract reviewer decision says `accepted` over exactly the published author candidate (submission `6e19d3cb…`, artifact `2b01353d…`, trace `2835aea3…`, product seal `14fda791…`) — the candidate of record is consumed, nothing else.
- The 8 task-projection content addresses (4 source claims, 1 constraint, 1 unknown, 2 terminal claims) cross-checked against this desk task projection and the upstream `verifiedSubArtifacts`.

## The Snapshot (exactly what the kernel dispatch feeds the reconciler)

- `universe`: re-derived by the REAL `acceptanceUniverseFrom` over the accepted requirements bundle, the accepted UC scenario set and the accepted acceptance deskInput (5 verifiable statement ids, 0 standalone evidence bindings).
- `requirements`: the 4 accepted FR/NFR; `acceptance`: the 5 accepted criteria, 0 deferrals, 0 standalone evidence bindings.
- `prd`: the 6 accepted member ids + 3 scenario-required member ids; `useCases`: 3 scenarios with their terminal branch ids.
- `sourceClaims`: the 4 claim ids of this desk task projection; the claim→member row mapping derived from the ACCEPTED members' own `sourceClaimRefs` citations (first member in sorted order wins the row; the full mapping is published alongside as a desk projection).

## Reconciliation Result (report-only; nothing added, deleted or patched)

| Claim row | Intent member (row mapping) | Requirements | Criteria |
|---|---|---|---|
| `claim:scope-1` | `prd:boundary-1` | `fr:boundary-1` | `ac:boundary-1` |
| `claim:scope-2` | `prd:scope-2` (out_of_scope) | — honest empty row | — |
| `claim:constraint-1` | `prd:constraint-1` | `nfr:determinism-1` | `ac:determinism-1` |
| `claim:outcome-1` | `prd:outcome-1` | `fr:outcome-1` | `ac:outcome-1-delivered`, `ac:outcome-1-deterministic-error` |

- Forward direction closed: every scenario-required member (`prd:boundary-1`, `prd:outcome-1`, `prd:terminal-1`) reaches accepted requirements; every accepted scenario produces requirement obligations.
- Reverse direction closed: all 5 criteria re-validated through the REAL WP03 `validateAcBinding` seam against the re-derived universe (0 refusals); the three closure laws re-run clean (AC-to-source, requirements coverage, terminal-result coverage).
- Rows keep the installed `formalization.what-reconciliation.v1` row shape; the full multi-member mapping is preserved in the desk projection (`claim:constraint-1` → also `prd:unknown-1`; `claim:outcome-1` → also `prd:terminal-1`).
- `constraint:retention-1` observed honored through `ac:determinism-1` + `ac:outcome-1-deterministic-error`; `unknown:browser-matrix-1` carried_forward with owner `discovery` and zero derivation edges; terminal claims stay owned upstream (`terminal:audited-1` → `prd:terminal-1` → `fr:terminal-1` → `ac:terminal-1-audited`; `terminal:delivered-1` → `prd:outcome-1` → `fr:outcome-1` → `ac:outcome-1-delivered`).

## Mechanical Verification (`reconcile-what-desk-author-verify.mjs`, 40/40 pass)

- Every published digest recomputed (submission, artifact, trace, report digest) — nothing trusted by declaration.
- The report re-computed over the re-derived snapshot compared byte-for-byte against the published product (`C1.report.byteEquality`); deep-freeze proven on the recomputed report (report-only law, cr-12).
- Computed-verdict law re-proven: 0 findings ⇔ `consistent` (`C3`); the reconciler surface takes no verdict input (`C4` cross-check).
- Trace: 15 relationships (9 `reconciles` + 6 `formalized-as`) resolve at both ends to recomputed digests; the report coverage block is the exact projection of the report edges anchored at the report digest; claim coverage blocks are exact projections of the `formalized-as` edges.
- Evidence set: 28 required evidence refs in the submission payload contract, all resolving against the recomputed digest space (4 accepted bundles, import/capsule/certificate, 8 envelope claims, governing + semantic skill, 4 trace + 4 submission digests + intent trace/submission, reviewer decision + verification, computed report digest).
- Determinism probe: repeated recomputation of the report yields the identical digest.

## Compliance

- Desk contract law holds and is enforced by the real checks, not asserted: the reconciler validates and reports the closed chain Discovery source claim → PRD intent member or explicit disposition → UC or justified direct requirement → FR/NFR/RULE → AC/evidence obligation; it adds, deletes and patches nothing.
- Fence respected: the candidate is exactly the `formalization.what-reconciliation.v1` report — no architecture, module-allocation or file decisions anywhere (WHAT-side fence intact for the next desk).
- Workspace law: **0 accepted upstream revisions travel by content address** (verbatim on all three artifacts).

**Recommended next stage:** reviewer stage of the reconcile-what desk (intake receipt `evidence:DeskIntakeReceipt#reconcile-what:author`, status `admitted_for_reviewer_stage`), then `freeze-what-baseline`.
