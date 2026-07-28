# ADR-018: ExecutionContextEnvelope — receipt and production are separate durable units

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.9, §3.10, §7.5, §7.6, §7.7, §9.6, §9.11, §14.5 (Phase 4)

## Context

Today's generic flow executor reconstructs execution state from a mutable
in-memory `NodeExecutionFrame` (productions/receipts maps rebuilt each step) and
threads board/task/WorkIntent identifiers through receipt fields
(`generic-flow-executor.ts`, 950 lines; `lm-node-executor.ts`'s
`LmNodeExecutionPersistence` is "a parameterized clone of the saga3 discovery
projection" — baseline §"Application layer"). Consequences:

1. **Receipt and production are overloaded into one object.** A `NodeExecutionResult`
   carries runtime event, receipt, production, recovery issue, and diagnostics in
   one bundle, and terminal module completion is extracted from magic production
   binding keys (`proposalId`, `workIntentId`) rather than an explicit envelope
   (plan §7.5.6, §13.23; baseline §"node-executor.ts").

2. **No durable input envelope.** The next node receives a mutable in-memory frame,
   not an assembled envelope. `NodeRun` rows do not persist an input envelope hash
   (plan §9.6) — so a crash after worker completion but before kernel verification
   cannot resume with the same receipt and exact production without searching by
   "latest execution" (plan §14.5.11 exit gate).

3. **Execution-scoped and process-scoped fallback searches.** When a downstream
   node needs an upstream product, the executor searches the in-memory frame or
   the process scope, rather than querying an exact product reference (plan
   §14.5.7, §14.5.11; baseline §"process-output-payload-registry.ts reopens
   module-specific storage after completion" — plan §13.12).

4. **Task metadata is treated as authoritative state.** The workspace tracker
   Markdown and `tasks.metadata` are read as execution lineage by module code,
   inverting the authority direction (plan §3.9; baseline §"process-execution-workspace.ts").

Plan §3.10 separates receipt from production; §7.7 mandates the next node receive
an `ExecutionContextEnvelope` assembled from durable state; §9.6 requires
persisting `NodeRun` input envelope hash, execution receipt, production envelope,
recovery issue, and protocol identity separately.

## Decision

The **`ExecutionContextEnvelope`** is the durable unit threaded between nodes.
Receipt and production are distinct durable objects. No latest-execution or
process-scope fallback search is permitted on the new execution path.

1. **`NodeExecutionResult` is split into separate fields** (plan §7.5):
   - `runtimeEvent`
   - `executionReceipt` (the fact that the node ran)
   - `production` (optional; the domain value it produced)
   - `recoveryIssue` (optional)
   - `diagnostics` (optional, non-authoritative)
   - Terminal module completion is an explicit `ModuleCompletion` envelope, not
     extracted from magic production binding keys (plan §7.5.6, §14.5.9).

2. **`NodeExecutionReceipt` and `NodeProductionEnvelope` are separate durable
   records** (plan §3.10). Receipt = "an action happened". Production = "a domain
   value was produced". They are never overloaded into one object.

3. **`NodeProductionEnvelope` carries** (plan §7.6): schema identifier; stable
   product reference; content hash; canonical opaque payload OR content-addressed
   payload reference; typed lineage references; module-owned opaque bindings
   ONLY when declared by schema.

4. **`ExecutionContextEnvelope` is assembled from durable state for every node
   execution** (plan §7.7), containing: package/process/node/attempt/execution
   identities; frozen authority; immutable `ProcessRun` input; exact declared
   upstream products (NOT a mutable frame); recovery feedback when applicable;
   scenario and stage identities when applicable. The next node never receives a
   mutable in-memory frame.

5. **`NodeRun` persists the input envelope hash, execution receipt, production
   envelope, recovery issue, and protocol identity SEPARATELY** (plan §9.6).
   Receipt and production are independent columns/rows, not one blob.

6. **Exact product references replace fallback searches** (plan §14.5.6,
   §14.5.7). A downstream node references the exact upstream production by stable
   product reference + content hash. Execution-scoped and process-scoped "find
   latest" queries are forbidden on the new path; `process-output-payload-registry.ts`
   no longer reopens module-specific storage after completion (plan §13.12).

7. **Task metadata is a one-way projection** (plan §3.9, §7.8, §14.5.5). The
   workspace tracker and `tasks.metadata` mirror selected envelope fields for the
   worker's convenience; Runtime and module validators never read them as
   authoritative state.

## Consequences

**Positive:**

- Crash-after-completion resumability becomes provable: the §14.5.11 exit gate
  ("crash after worker completion but before kernel verification resumes with the
  same receipt and exact production without searching by latest execution") is
  reachable.
- Terminal completion is explicit (`ModuleCompletion`), removing the magic-binding
  extraction that today couples the generic executor to discovery semantics
  (plan §13.23).
- Production lineage is durable and hashable, enabling content-addressed product
  references (ADR-015).
- Worker workspace and task metadata stop being load-bearing for correctness;
  Markdown tracker drift can no longer corrupt execution state.

**Negative:**

- `NodeExecutor` SPI shape changes (plan §0.2.3 — serial by design; §14.5.2).
  `node-executor.ts` board/task/WorkIntent vocab (`NodeProduction.bindings` keys,
  `NodeExecutionReceipt` `intentId`/`taskId`/`executionId`) must move behind
  `WorkerExecutionPort` and a `SagaBoardClaudeDriver` adapter (plan §14.5.8,
  §14.4.6).
- `LmNodeExecutionPersistence` is currently a parameterized clone of the saga3
  discovery projection — Wave 4 generalizes it into `WorkerExecutionPort` and
  removes Discovery-specific construction from the generic LM executor (plan
  §14.5.8; baseline §"node-executors/lm-node-executor.ts").

## Current state (frozen-commit `fd26fd1`)

- Mutable `NodeExecutionFrame` in `generic-flow-executor.ts`; `NodeExecutionResult`
  bundle; magic terminal certificate/output bindings (baseline §"Application layer").
- `NodeRun` persistence exists (`saga3_node_runs`) but does not yet persist a
  separate input envelope hash + production envelope + recovery issue as
  independent durable fields (plan §9.6).
- `sqlite-managed-production-ledger.ts` and `sqlite-managed-node-submission-repository.ts`
  are the closest existing prototypes of "durable production with content hash" —
  they seed but do not satisfy the contract.

## References

- Plan §3.9 (task metadata is a projection), §3.10 (receipt ≠ production)
- Plan §7.5 (NodeExecutionResult split), §7.6 (NodeProductionEnvelope), §7.7 (ExecutionContextEnvelope)
- Plan §9.6 (NodeRun durable fields), §9.11 (no latest-execution fallback)
- Plan §13.12 (no storage reopening after completion), §13.23 (no artifact physics in generic kernel)
- Plan §14.5 (Phase 4: durable execution envelope and products)
- Baseline §"Application layer", §"Persistence — `persistence/`"
- Related: ADR-015 (package identity), ADR-019 (protocol state), ADR-021 (compatibility)
