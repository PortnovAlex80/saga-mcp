# Wave 3 — Durable Execution Primitives

> Plan mapping: §0.6 (Phase 4). **Status:** 🟡 STAGING — serial precondition satisfied (`09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md`), dispatching lanes.

## Objective (§0.6.12 serial gate)

Crash after worker completion resumes from exact receipt + product, with NO latest-execution, process-scope, task-metadata, or magic-binding reconstruction. Wave 3 is the **first wave to modify production executor hot files** — additive + dual-write only (legacy paths stay runnable, plan §16.9).

## Serial constraint (§0.6.11) — CRITICAL
**A1 → A2 → A3 are SEQUENTIAL** (core executor → LM executor → AgentLaunchSpec). The integrator cherry-picks A1, builds, cherry-picks A2, builds, cherry-picks A3, builds. A4–A8 are parallel-safe.

## Frozen input commit
- **HEAD:** `a415939` (Wave 2 checkpoint). Wave 3 branches off this.
- **Spec:** `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md`
- **Wave 1 SPI barrel:** `domain/spi/index.ts` (ExecutionContextEnvelope, DriverNeutralExecutionReceipt, NodeProductionEnvelope, ModuleCompletion, etc.)
- **Wave 2 installation barrel:** `installation/index.ts` (PackageRegistry, describeInstallation)

## Ownership lanes (8)

| Lane | Owns | Serial? |
|---|---|---|
| **W3-A1** | EDITS `node-executor.ts` + `generic-flow-executor.ts` (hot files) | **SERIAL 1st** |
| **W3-A2** | EDITS `lm-node-executor.ts` + NEW `saga-board-adapter-data-builder.ts` | **SERIAL 2nd** (after A1) |
| **W3-A3** | Surface `installationId`/`packageDigest` on ProcessRunRecord + wire AgentLaunchSpec | **SERIAL 3rd** (after A2) |
| **W3-A4** | NEW `process-product-repository-v2.ts` + sqlite adapter (exact-by-ProductRef) | parallel |
| **W3-A5** | NEW `execution-context-assembler.ts` (exact upstream products, no fallback) | parallel |
| **W3-A6** (SQL OWNER) | NodeRun v2 columns (ALTER saga3_node_runs) + v2 record types/methods | parallel (SQL owner) |
| **W3-A7** | NEW `worker-execution-port.ts` + `contract-boundary-decoder.ts` | parallel |
| **W3-A8** | NEW conformance tests (crash-resume, exact-product, no-fallback) | parallel (test-only) |

## Single SQL owner (C083)
**W3-A6** owns ALL `saga3_node_runs` ALTERs + any `saga3_process_products` index this wave. W3-A4 coordinates through A6.

## Exit gate (§0.6.12 / spec §12)
1. Build green. 2. Generic-flow consumes ExecutionContextEnvelope. 3. ModuleCompletion explicit (magic-bindings fallback). 4. LM emits DriverNeutralExecutionReceipt. 5. ProcessRunRecord carries installationId/packageDigest. 6. NodeRun v2 columns. 7. **Crash-resume exact** (§0.6.12). 8. Exact-product query. 9. Ratchet green. 10. Wave 0/1/2 regression green.

## Integration order (integrator, serial)
A6 → A4 → A7 → A5 → **A1** → **A2** → **A3** → A8. Build after each of A1/A2/A3. Gate after each pick. Checkpoint `refactor(wave-3): durable execution checkpoint`.

## Schema changes
ADDITIVE: 7 nullable columns on `saga3_node_runs` (W3-A6). Possible index on `saga3_process_products` (A4↔A6 coordinate). No NOT NULL (Wave 11).
