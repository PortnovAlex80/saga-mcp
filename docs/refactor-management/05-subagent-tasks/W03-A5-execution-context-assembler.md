# W3-A5 — ExecutionContextAssembler

**Wave:** 3 · **Lane:** A5 · **Spec:** §8 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a5` · **Worktree:** `.worktrees/w3-a5`

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §8.
2. `src/process-modules/application/generic-flow-executor.ts` `restoreFrame()` (:833-861) — the mutable reconstruction this replaces.
3. Wave 1 SPI: `ExecutionContextEnvelope`, `ProductRef` from `domain/spi/index.ts`.
4. W3-A4 task (ProcessProductRepository port you consume).

## Own
- `src/process-modules/application/execution-context-assembler.ts` (NEW).
- `tests/installation/execution-context-assembler.test.mjs` (NEW).

## Build (spec §8)
- `assembleExecutionContext(processRunId, nodeId, attempt, upstreamProductRefs: readonly ProductRef[], deps: { productRepo: ProcessProductRepository; processRunRepo; nodeRunRepo }): Promise<ExecutionContextEnvelope>`.
- Load each upstream product via `productRepo.getByProductRef(ref)` (EXACT). Throw `UPSTREAM_PRODUCT_NOT_FOUND` if missing — **NO fallback to epic-scope search** (§9.11).
- Construct `ExecutionContextEnvelope`: `upstreamProducts` populated, `frozenAuthority` from ProcessRun, `packageRef`/`nodeRef` from run's installation + flow.
- This is the replacement for `restoreFrame()`. A1's refactored generic-flow-executor calls it.

## Verify
`npm run build && node --test tests/installation/execution-context-assembler.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`
W3-A4 port may be absent locally — use a fake matching the port, note in return.

## Commit
`feat(execution): W3-A5 ExecutionContextAssembler (exact upstream products, no epic-scope fallback)`

## Return
Branch+sha, diff --stat, test result (pass or unresolved-import), exported symbols (A1 consumes), confirmation.
