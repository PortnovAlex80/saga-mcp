# define-acceptance-contract desk (reviewer) - r3 review record

Round: stray-products-r3 · reviewed candidate of record: SR-Define-Acceptance-Contract-001
(`sha256:2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0`, submission FS-Define-Acceptance-Contract-001 `sha256:6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe`,
trace `sha256:2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **99 recomputations** (`define-acceptance-contract-desk-reviewer-verify.mjs`), rule
  `sha256(canonicalJson)` per `src/workflow-kernel/domain/digest.ts`:
  **92 pass / 7 fail**. Full evidence:
  `define-acceptance-contract-desk-reviewer-verification-emission-a.json` (VV-Define-Acceptance-Contract-001,
  `sha256:367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb`).
- **Same-provider recheck, zero softening** (`ACCEPTANCE_REVIEWER_ROUTE`): the bundle re-seals
  through the REAL installed cell (`acceptanceUniverseFrom` → `validateAcceptanceBundle` →
  the WP03 `validateAcBinding` seam ×5) to the exact declared product seal
  `sha256:14fda7910eedff5a…`; all 5 verifiable-statement seals recompute.
- Upstream re-verified through the REAL surfaces: 6 PRD member seals + REAL intent fold, 3 UC
  seals + REAL fold, 4 requirement seals, requirements bundle re-sealed against its recomputed
  WP03 universe — every `accepted-*` ref binds the recomputed digest.
- rev-1 duty: every scenario-facing citation pair re-derives from the bound requirement's own
  derivation; zero deferrals/standalone bindings verified lawful under full end-to-end coverage.
- Negative probes all killed: stripped branch citation → `MISSING_LINEAGE`; foreign scenario →
  `FOREIGN_LINEAGE`; foreign requirement → `FOREIGN_LINEAGE`; uncovered requirement →
  `COVERAGE_GAP`; WHAT-side key → `SCOPE_VIOLATION`.
- Trace: 16/16 relationships resolve; all coverage blocks are exact projections of the edge set.

## Workspace-law adjudication

The reviewer frame projects **"1 accepted upstream revision"** of define-acceptance-contract
(`sha256:32892970…`). Verdict: **UNRESOLVABLE — author 0 upheld.**
K2 scanned 254 workspace files under `qualification/`: zero raw-byte, zero
canonical-JSON, zero `.content` hits (the sole textual mention is this reviewer's own verify
script). No accepted revision of this desk exists anywhere: the r1 acceptance records are
**pseudo-addressed** (`sha256:define-acceptance-contract-formalization-2026-08-27` is not a
content address), r2 never ran the desk, and the only r3 revision is the candidate under review.
Stale shell metadata recorded for the shell owner (r2 RA-5 still open).

## Why repair (not accepted)

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | The acceptance surface binds revisions that are **NOT accepted** while asserting they are: intent `a06dbc57…` = verdict **repair ×2 rounds** (FR-…-001, FR-…-002; scope-2 fabricated authority) with **no reissue anywhere**; UC `24f0aff2…` = **never reviewed** (no reviewer artifact exists in the corpus) and authored in violation of its own desk's upstream hold `6cccd162…`; requirements `86b00569…` = verdict **repair** + re-staff confirmation. Only the import chain is genuinely accepted. `revisionPinsMatchAcceptedRevisions=true` is false at the status layer. |
| CRIT-2 | CRITICAL | The candidate restates the `prd:scope-2` `out_of_scope` exclusion **as settled fact** (brief + self-check 10) — but SC-2 `cb291aa7…` is a bare claim, CERT-1 a subject-level go, and the exclusion's authority was established as nonexistent by **three** upstream verdict records. Zero derivation edges are lawful under contest; restating the exclusion as the acceptance contract's premise launders the fabrication a third time. |
| MAJ-1 | MAJOR | `governingContractRef` `sha256:a926df62…` **resolves to no content** workspace-wide (92 mentioning files; r1 contract claimants all recompute otherwise) — the r2 RA-2/RA-4 debt, now inherited by a fourth desk. |
| ADV-1..3 | advisory | Stale envelope projection (phantom accepted revision); byte-identical relabeling round (repair-verdict material re-emitted and relabeled "accepted" with no state change; the UC hold silently overridden); pseudo-addressed legacy r1 acceptance records. |

Required actions RA-1..RA-6 are in the review artifact
(FR-Define-Acceptance-Contract-001, `sha256:83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383`). The headline: **RA-1** this desk
HOLDS until genuinely accepted revisions exist — an acceptance contract over unaccepted lineage
has no referent — then reissues against verdict-backed revisions only; **RA-2** settle the intent
contention and restore `claim:scope-2`; **RA-3** give the UC bundle its never-run reviewer stage.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | `sha256:367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb` |
| review | formalization-review | `sha256:83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383` |
| trace | reviewer-verdict-trace | `sha256:35c551ac922b2d27c1291c351efa50e32e35f4a931c81c7c8ce2c4c16e33a3d5` |
| submission | FS-Define-Acceptance-Contract-002 | `sha256:983ce949d726ce3fbd2bf68a755789c8ca96e6f325b8c41553c1a3d540e73ed6` |

Pinned timestamp 2026-08-28T00:00:00Z across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.
