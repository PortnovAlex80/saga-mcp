# W3-A7 — WorkerExecutionPort + ContractBoundaryDecoder

**Wave:** 3 · **Lane:** A7 · **Spec:** §10 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a7` · **Worktree:** `.worktrees/w3-a7`

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §10.
2. `src/process-modules/application/node-executors/lm-node-executor.ts` (`LmNodeExecutionPersistence` port — the board-coupled shape to generalize).
3. Wave 1 SPI: `ContractSchemaRegistry`, `ContractRef`, `ValidationResult` from `domain/spi/index.ts`.

## Own
- `src/process-modules/application/worker-execution-port.ts` (NEW: driver-neutral port).
- `src/process-modules/application/contract-boundary-decoder.ts` (NEW).
- `tests/installation/contract-boundary-decoder.test.mjs` (NEW).

## Build (spec §10)
- `WorkerExecutionPort` — driver-neutral generalization of `LmNodeExecutionPersistence`. Board/task/WorkIntent vocab moves to `adapterData: Record<string, unknown>`. Methods: `prepareExecution(plan)`, `readOutcome(executionId)`, `sealReceipt(...)`. Wave 3 DEFINES the port; Wave 5 fully adopts it.
- `ContractBoundaryDecoder`: `decodeAtBoundary(ref: ContractRef, value: unknown, registry: ContractSchemaRegistry): unknown` + `validateAtBoundary(ref, value, registry): ValidationResult`. Uses Wave 1 `ContractSchemaRegistry`. Validates module input, node input, node output, module completion, scenario handoff (§7.4.2).

## Verify
`npm run build && node --test tests/installation/contract-boundary-decoder.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`

## Commit
`feat(execution): W3-A7 WorkerExecutionPort + ContractBoundaryDecoder (driver-neutral, boundary validation)`

## Return
Branch+sha, diff --stat, test tail+ratchet, exported symbols (A1/A2 consume), confirmation.
