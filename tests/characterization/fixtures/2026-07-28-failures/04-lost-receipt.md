---
id: lost-receipt
symptom: |
  A NodeRun whose execution receipt is not durable as the authoritative
  execution-lineage channel. The executor reconstructs the in-memory
  NodeExecutionFrame (productions/receipts maps) from nodeRunRepo.list(...) on
  every walk(), so resume correctness depends entirely on a JSON blob column
  that is nullable, added by ALTER TABLE migration, and re-parsed each step.
root_cause_class: lost-receipt
evidence: |
  - src/process-modules/application/generic-flow-executor.ts:364 calls
    `restoreFrame(context.inputPayload, allRuns)` at the top of every walk().
  - restoreFrame (generic-flow-executor.ts:833-861) rebuilds a fresh
    NodeExecutionFrame { runInput, productions:{}, receipts:{} } by iterating
    nodeRunRepo rows and re-parsing each row.executionReceipt JSON.
  - The receipt column is nullable TEXT, added by ALTER TABLE in
    src/process-modules/persistence/sqlite-node-run-repository.ts:35,53-63,79
    (execution_receipt TEXT; ALTER TABLE factory_node_runs ADD COLUMN
    execution_receipt TEXT). A NULL or unparseable blob silently drops the
    receipt from the reconstructed frame.
  - Plan §0.6.12 Wave 3 gate (verbatim): "a crash after worker completion
    resumes from the exact receipt and product, with no latest-execution,
    process-scope, task-metadata, or magic-binding reconstruction." The current
    code is exactly the magic-binding reconstruction that gate forbids.
  - Baseline §01 lists `generic-flow-executor.ts (950) | Mutable in-memory
    NodeExecutionFrame (productions/receipts maps) reconstructed each step`.
reproduction: |
  Static: `grep -n "restoreFrame\|NodeExecutionFrame" src/process-modules/application/generic-flow-executor.ts`
  Dynamic: persist a factory_node_runs row with execution_receipt=NULL or
  execution_receipt='{not json' and call walk() — restoreFrame silently omits
  the receipt (frame.receipts gets no entry) instead of failing closed.
  Command: `grep -n "execution_receipt TEXT" src/process-modules/persistence/sqlite-node-run-repository.ts`
expected_after_fix: |
  Receipts are durable, typed, immutable envelopes persisted as first-class
  state (NodeExecutionReceipt, plan §0.6.2/§0.6.6). Resume loads the exact
  receipt by identity; no JSON re-parse, no nullable blob, no full-frame
  reconstruction. A NULL/missing receipt is a hard error, not a silent skip.
fixing_waves:
  - "3"
---

# Fixture: lost-receipt

Captured from the 2026-07-28 failure taxonomy (plan §2.2).

## Boundary that is unstable

The receipt is not an authoritative durable contract; it is a nullable JSON
blob re-parsed into a mutable in-memory map on every executor step. Crash
durability rests entirely on this reconstruction.

## Why this is a fixture, not a fix

Wave 3 (plan §0.6) introduces the durable receipt/product contract and the
Wave 3 serial gate (§0.6.12) forbids the very reconstruction this fixture
documents. This fixture pins the reconstruction so the gate can prove it is
gone.
