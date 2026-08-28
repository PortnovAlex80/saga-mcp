# Derive System Requirements Desk (author) — r2 Submission Summary

**Desk:** derive-system-requirements
**Role:** author
**Workspace:** `docs/refactoring/event-kernel/qualification/stray-products-r2/`
**Status:** authored, self-verified, gate verdict **accepted**
**Date:** 2026-08-28 (pinned timestamp `2026-08-28T00:00:00Z` on all artifacts)

## Artifacts Submitted (all content-addressed)

| Artifact | Ref (sha256 over canonical JSON of content) |
|---|---|
| `derive-system-requirements-desk-system-requirements.artifact.json` | `sha256:86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df` |
| `derive-system-requirements-desk-system-requirements-trace.json` | `sha256:fd0b0b1f7470cd7825a0c83082b96b503ef3dabdcf70a92369050418a8706e26` |
| `derive-system-requirements-desk-product-submission.json` | `sha256:05e713efdd1847bf18fc21ed335a981db1963020417e0a2078eef62fe2e824aa` |

Candidate: kind `formalization.system-requirements.v1`, payload contract `frf-contracts.requirements-bundle.v1`, WP03 seal `sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690`.

## Upstream Material (traveling by content address, never declared)

- Accepted PRD intent bundle (define-product-intent, r2): `sha256:a06dbc57…`, re-folded revision `a30229a75bed4c5d…` via the REAL `acceptedIntentSetOf` fold over seals recomputed through the REAL `validatePrdIntentMember`.
- Accepted UC scenario bundle (model-use-cases, r2): `sha256:24f0aff2…`, re-folded revision `184981e5724c286d…` over the sorted scenario seals (`{memberDigests:[…]}` canonical fold).
- Discovery import artifact, capsule, certificate, and the 8 task-projection content addresses (4 source claims, 1 constraint, 1 unknown, 2 terminal claims) all cross-checked against this desk task projection.

## Requirements Authored (closed FR/NFR/RULE vocabulary)

| Id | Kind | Derivation | Surfaces |
|---|---|---|---|
| `fr:boundary-1` | FR | `prd:boundary-1` + `uc:boundary-1` + `branch:boundary-1-main` | test |
| `fr:outcome-1` | FR | `prd:outcome-1` + `uc:outcome-1` + both terminal branches (main + deterministic error) | test, monitoring |
| `fr:terminal-1` | FR | `prd:terminal-1` + `uc:terminal-1` + `branch:terminal-1-main` | audit |
| `nfr:determinism-1` | NFR | `prd:constraint-1` + source constraint `constraint:retention-1` (direct cross-cutting lineage) | test, monitoring |

- Coverage law: every accepted UC scenario produces at least one obligation (3/3).
- `prd:scope-2` (out_of_scope at intent freeze) derives no requirement; `unknown:browser-matrix-1` stays carried_forward with owner `discovery` and zero derivation edges.
- Desk-authored verification-surface set (deskInput): `surface:test-suite-1`, `surface:monitoring-1`, `surface:audit-1` — every requirement resolves inside it (law L2).

## Mechanical Verification (`derive-system-requirements-desk-author-verify.mjs`, 69/69 pass)

- Every declared digest recomputed (submission, artifact, trace, 4 requirement seals) — nothing trusted by declaration.
- REAL WP03 validator `validateRequirementsBundle` seals the bundle against the universe derived by the REAL desk protocol `deriveAcceptedUniverse`.
- REAL cell gate `gateSystemRequirementsCandidate` with the REAL declared provider (`formalization.requirements-structure.v1`) and the REAL fail-closed seam binder (self-test passed) → verdict **accepted**, all six CheckPlan rows pass.
- Trace: 13 relationships resolve to recomputed digests; all coverage blocks are exact projections of the edge set; 0 edges touch the unknown.
- Negative probes: foreign lineage → `upstream-repair`; stale pin → `repair`; coverage gap → `repair`; missing branch lineage → `repair`; no universe → never accepted; omitted wp03 row → `GATE_CHECK_MISSING`; forbidden artifact family → `terminal-reject`.

## Compliance

- Laws L1 (exact lineage), L2 (verification surfaces), L3 (revision pins) hold and are enforced by the real checks, not asserted.
- Fence respected: no scenarios/acceptance/SRS/handoff artifact family anywhere in the candidate.
- Deterministic authoring: pinned timestamps, no clock reads, no randomness.
- Workspace law: **0 accepted upstream revisions travel by content address** (verbatim on all three artifacts).

**Recommended next stage:** reviewer stage of the derive-system-requirements desk (intake receipt `evidence:DeskIntakeReceipt#derive-system-requirements:author`, status `admitted_for_reviewer_stage`).
