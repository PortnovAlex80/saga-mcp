# W3-A8 — Conformance + crash-resume proof (test-only)

**Wave:** 3 · **Lane:** A8 · **Spec:** §11 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a8` · **Worktree:`.worktrees/w3-a8`

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §11, §12 (exit gate).
2. All sibling W3 task files (export surface).

## Own
- `tests/execution/crash-resume-exact-receipt.test.mjs` (NEW) — THE §0.6.12 exit gate.
- `tests/execution/exact-product-query.test.mjs` (NEW).
- `tests/execution/no-fallback-reconstruction.test.mjs` (NEW).

## Build (spec §11)
1. **crash-resume-exact-receipt**: simulate crash after worker completion but before kernel verification; resume MUST load exact receipt + production from NodeRun v2 (not latest-execution/process-scope/task-metadata/magic-binding). Assert resumed envelope content-hash matches pre-crash.
2. **exact-product-query**: W3-A4 `getByProductRef` returns exact product; no epic-scope fallback.
3. **no-fallback-reconstruction**: `ExecutionContextAssembler` throws `UPSTREAM_PRODUCT_NOT_FOUND` when predecessor missing.

## Verify
**EXPECTED**: fails locally with unresolved imports (siblings absent). Integrator runs full gate after A6→A4→A7→A5→A1→A2→A3→A8. State pass OR unresolved-import in return.

## Commit
`test(execution): W3-A8 crash-resume + exact-product + no-fallback conformance (Wave 3 exit gate)`

## Return
Branch+sha, diff --stat, test result (pass OR unresolved-import), sibling symbol list, confirmation.
