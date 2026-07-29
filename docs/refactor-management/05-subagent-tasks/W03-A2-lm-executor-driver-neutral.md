# W3-A2 — LM executor driver-neutrality (SERIAL 2nd, after A1)

**Wave:** 3 · **Lane:** A2 · **Spec:** §5 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a2` · **Worktree:** `.worktrees/w3-a2`

## SERIAL: builds on W3-A1's new SPI. The integrator cherry-picks A1 before you.

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §5.
2. `src/process-modules/application/node-executors/lm-node-executor.ts` (FULL — esp. `processBinding` :271-292, receipt emission :519-523).
3. W3-A1 task (the v2 SPI you consume).
4. Wave 1 SPI: `DriverNeutralExecutionReceipt` from `domain/spi/index.ts`.

## Own
- EDIT `src/process-modules/application/node-executors/lm-node-executor.ts`.
- NEW `src/process-modules/application/node-executors/saga-board-adapter-data-builder.ts`.

## Build (spec §5)
- Emit `DriverNeutralExecutionReceipt` (board/task/WorkIntent → `adapterData`). Keep legacy `NodeExecutionReceipt` emission for dual-write.
- Move `processBinding` lineage bag (:271-292) behind `SagaBoardAdapterDataBuilder` (NEW file) — isolates snake_case driver vocab.
- Consume A1's v2 context envelope (if present); fall back to legacy frame for old runs.
- Preserve `LmNodeExecutionPersistence` port shape (Wave 5 migrates fully).

## Verify
`npm run build && node --test tests/process-modules/lm-node-executor.test.mjs 2>/dev/null; node --test tests/architecture/dependency-direction.test.mjs`
A1's v2 types may be absent locally — guard with feature detection, note in return.

## Commit
`feat(execution): W3-A2 LM executor driver-neutral receipt + SagaBoardAdapterDataBuilder`

## Return
Branch+sha, diff --stat, test result+ratchet, confirmation.
