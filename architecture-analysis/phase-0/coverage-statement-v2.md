# Phase 0 Coverage Statement (v2 — supersedes v1)

Artifact ID: ART-PHASE0-COVERAGE
Artifact Type: Coverage and Unresolved Regions Statement
Phase: Phase Zero
Version: 2
Status: evidence-complete
Created From: Live verification against saga4 branch
Supersedes: coverage-statement.md (v1)

## What was covered

1. **File inventory:** Complete. 1566 tracked files classified.
2. **Module inventory:** Complete for production code. All 5 processes, 4 modules, LEGO contract verified.
3. **Executable topology:** High. All 5 processes traced entry→composition→state→effects.
4. **Reachable-path:** High. All architecturally significant components at E2/E3.
5. **Fossil identification:** Two saga3/ remnants investigated — both load-bearing (not fossils).

## What was only inventoried

- Tests (291 files): by path/count. Per-test coverage not verified.
- Skills (28 files): prompt templates, not code.
- Package store (198 files): content-addressed blobs.
- docs/ (407 files): not verified against current code.
- tracker-view.mjs (5605 lines): endpoints mapped, internals not inspected.

## What was inferred

- Legacy engine (saga3-discovery-engine.ts) is OFF production path (no composition root import). Confidence: Medium.
- assign-one-card.ts: imported by discovery services ON production path AND by legacy engine OFF path.

## Unresolved questions

- QUESTION-V2-002: tracker-view.mjs internal structure.
- QUESTION-V2-003: Why do src/modules/ and src/process-modules/modules/ coexist? Intentional separation or incomplete migration?
- QUESTION-V2-006: Does assign-one-card.ts execute at runtime through discovery services, or is it a type-only import?

## Evidence levels

| Level | Status |
|---|---|
| E0-E4 | Verified for key components |
| E5 | Assumed (291 test files exist) |
| E6 | Not available (no runtime telemetry) |

## Key discovery: split type ownership

`src/modules/discovery/domain/discovery-readiness-records.ts` imports `ProposalProvenance` from `../../../saga3/domain/proposal.js` — a cross-tree type dependency from the new module tree back into the old saga3 remnant. This is a load-bearing seam for Phase 4.
