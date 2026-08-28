# Derive System Requirements Desk (author) — r3 Submission Summary

**Desk:** derive-system-requirements
**Role:** author
**Workspace:** `docs/refactoring/event-kernel/qualification/stray-products-r3/`
**Round purpose:** fresh execution of the SAME desk task (identical task projection, identical accepted upstream material carried over verbatim from r2) — a reproducibility probe of the deterministic authoring law
**Status:** authored, self-verified, gate verdict **accepted**, **byte-exact r2 reproduction**
**Date:** 2026-08-28 (pinned timestamp `2026-08-28T00:00:00Z` on all artifacts)

## Reproducibility Result (the r3 headline)

Deterministic authoring (pinned timestamps, no clock reads, no randomness) over
the identical task projection and identical accepted upstream material
reproduced the r2 artifacts **byte-exactly** — every content digest and every
file byte identical to the r2 round:

| Artifact | r3 ref | r2 ref | Match |
|---|---|---|---|
| `…system-requirements.artifact.json` | `sha256:86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df` | `sha256:86b00569…` | **byte-identical** (`cmp` clean) |
| `…system-requirements-trace.json` | `sha256:fd0b0b1f7470cd7825a0c83082b96b503ef3dabdcf70a92369050418a8706e26` | `sha256:fd0b0b1f…` | **byte-identical** (`cmp` clean) |
| `…product-submission.json` | `sha256:05e713efdd1847bf18fc21ed335a981db1963020417e0a2078eef62fe2e824aa` | `sha256:05e713ef…` | **byte-identical** (`cmp` clean) |

Derived values reproduced too: PRD revision fold `a30229a75bed4c5d…`, UC
revision fold `184981e5724c286d…`, WP03 seal `sha256:60083eb4a2ba553d…`.
Digest drift would have been an r3 failure, not a new revision; there was none.

Candidate: kind `formalization.system-requirements.v1`, payload contract
`frf-contracts.requirements-bundle.v1`, WP03 seal
`sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690`.

## Upstream Material (carried verbatim from r2, re-verified here by recomputation)

- The four r2 upstream files (accepted PRD intent bundle, accepted UC scenario
  bundle + trace + submission) were copied verbatim into this workspace; the
  r3 build re-folded BOTH upstream sets through the REAL WP03 validators
  (`validatePrdIntentMember`, `validateUcScenarioMember`) and the REAL cell
  folds — every recomputed seal matched the declared digest.
- Discovery import artifact, capsule, certificate, and the 8 task-projection
  content addresses (4 source claims, 1 constraint, 1 unknown, 2 terminal
  claims) cross-checked byte-exact against this desk task projection.

## Requirements Authored (closed FR/NFR/RULE vocabulary — identical derivation to r2)

| Id | Kind | Derivation | Surfaces |
|---|---|---|---|
| `fr:boundary-1` | FR | `prd:boundary-1` + `uc:boundary-1` + `branch:boundary-1-main` | test |
| `fr:outcome-1` | FR | `prd:outcome-1` + `uc:outcome-1` + both terminal branches (main + deterministic error) | test, monitoring |
| `fr:terminal-1` | FR | `prd:terminal-1` + `uc:terminal-1` + `branch:terminal-1-main` | audit |
| `nfr:determinism-1` | NFR | `prd:constraint-1` + source constraint `constraint:retention-1` (direct cross-cutting lineage) | test, monitoring |

- Coverage law: every accepted UC scenario produces at least one obligation (3/3).
- `prd:scope-2` (out_of_scope at intent freeze) derives no requirement;
  `unknown:browser-matrix-1` stays carried_forward with owner `discovery` and
  zero derivation edges.
- Desk-authored verification-surface set (deskInput): `surface:test-suite-1`,
  `surface:monitoring-1`, `surface:audit-1` — every requirement resolves
  inside it (law L2).

## Mechanical Verification (`derive-system-requirements-desk-author-verify.mjs`, 69/69 pass)

- Every declared digest recomputed (submission, artifact, trace, 4 requirement
  seals) — nothing trusted by declaration.
- REAL WP03 validator `validateRequirementsBundle` seals the bundle against
  the universe derived by the REAL desk protocol `deriveAcceptedUniverse`.
- REAL cell gate `gateSystemRequirementsCandidate` with the REAL declared
  provider (`formalization.requirements-structure.v1`) and the REAL
  fail-closed seam binder (self-test passed) → verdict **accepted**, all six
  CheckPlan rows pass.
- Trace: 13 relationships resolve to recomputed digests; all coverage blocks
  are exact projections of the edge set; 0 edges touch the unknown.
- Negative probes: foreign lineage → `upstream-repair`; stale pin → `repair`;
  coverage gap → `repair`; missing branch lineage → `repair`; no universe →
  never accepted; omitted wp03 row → `GATE_CHECK_MISSING`; forbidden artifact
  family → `terminal-reject`.

## Compliance

- Laws L1 (exact lineage), L2 (verification surfaces), L3 (revision pins)
  hold and are enforced by the real checks, not asserted.
- Fence respected: no scenarios/acceptance/SRS/handoff artifact family
  anywhere in the candidate.
- Deterministic authoring: pinned timestamps, no clock reads, no randomness —
  proven by the byte-exact r2 reproduction above.
- Workspace law: **0 accepted upstream revisions travel by content address**
  (verbatim on all three artifacts).

**Recommended next stage:** reviewer stage of the derive-system-requirements
desk (intake receipt
`evidence:DeskIntakeReceipt#derive-system-requirements:author`, status
`admitted_for_reviewer_stage`).
