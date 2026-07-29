# Wave 3 — Durable Execution Primitives Frozen Contract Spec

> Frozen by the integrator (serial precondition, plan §0.6.2) on `a415939` (Wave 2 checkpoint).
> Workers MUST NOT change this spec; escalate ambiguities (§0.1.7).

## 0. Reconnaissance result (HEAD `a415939`)

Wave 3 is the **first wave that modifies production executor hot files**. Reconnaissance established:

### Current execution layer (the "before")
- **`node-executor.ts`** (SPI port): `NodeExecutionContext` carries `projectId`/`epicId` (board vocab, §13.16) + mutable `NodeExecutionFrame` bag (§13.7). `NodeExecutionReceipt` bakes `intentId`/`taskId` into base fields (§13.16/C061).
- **`generic-flow-executor.ts`** (950 lines): reconstructs mutable `NodeExecutionFrame` from NodeRun rows every step (`restoreFrame` :833-861), mutates in-place (:535-536), extracts certificate envelope from `production.bindings.certificatePayload` (:213-216) — the §13.6 magic bindings.
- **`lm-node-executor.ts`** (590+ lines): `LmNodeExecutionPersistence` port takes `epicId`/`projectId`/`taskKind`/`workflowStage` as first-class (:47-106); stamps snake_case driver-vocab lineage bag (:271-292).
- **`node-run.ts` NodeRunRecord**: has output (ref/schema/hash/bindings), receipt, recoveryIssue, acceptanceReceipt — but NO input-envelope hash, NO protocol identity (NodeRef/PackageRef), NO predecessor NodeRun refs, NO definition digest, NO NodeProductionEnvelope wrapper (§9.6/§9.14 gaps).
- **`sqlite-managed-production-ledger.ts`**: `listArtifactsForNodeInEpic` is the imprecise "latest in epic" fallback (§9.11) Wave 3 retires in favor of exact predecessor refs.
- **Wave 2 unfinished thread**: `installation_id`/`package_digest` columns exist in DB but are NOT surfaced on `ProcessRunRecord`/`StartProcessModuleCommand`/`rowToRecord()`. Wave 3 wires them through (or defers to a focused fix).

### Wave 1 SPI targets available
`ExecutionContextEnvelope` (driver-neutral, `findForbiddenDriverNeutralKeys` guard), `DriverNeutralExecutionReceipt` (adapterData for board/task), `NodeProductionEnvelope` (NodeProduction mirror + productRef + lineage), `ProcessModuleOutputEnvelope`, `ModuleCompletion` (explicit terminal, replaces magic bindings), `PackageRef`/`NodeRef`/`ProductRef`/`LineageRef`.

### Ratchet constraints for Wave 3
- `application/` MAY import `persistence/` ports (`*-repository.ts`) and `installation/` — no rule forbids it.
- `application/node-executor.ts` and `application/generic-flow-executor.ts` are **Rule-4a core files**: NO module-name string literals (`'discovery'`/`'formalization'`/etc.) in stripped code. Adding imports is fine; adding literals fails.
- Editing existing hot-file lines WITHOUT changing imports adds no ratchet edges. Adding a new `import` to a forbidden target fails.
- `domain/spi/` files stay pure (Rule 5).

## 1. Serial constraint (plan §0.6.11) — CRITICAL

The executor changes are **serial by design**:
1. **W3-A1 (core owner)** edits `node-executor.ts` + `generic-flow-executor.ts` together (the SPI port + walker are co-evolved).
2. **W3-A2 (second owner)** then edits `lm-node-executor.ts` against A1's new SPI.
3. **W3-A3 (third owner)** then activates exact `AgentLaunchSpec` resolution (Wave 2 installation → executor pinning).

**A1, A2, A3 run sequentially, NOT in parallel.** The integrator cherry-picks A1 → builds → cherry-picks A2 → builds → cherry-picks A3. The other 5 lanes (A4–A8) are parallel-safe and integrate alongside.

## 2. Ownership lanes (8)

| Lane | Owns | Serial? | Spec section |
|---|---|---|---|
| **W3-A1** | EDITS `node-executor.ts` + `generic-flow-executor.ts` (hot files). Adds driver-neutral envelope consumption, separates receipt/production, replaces magic certificate bindings with explicit `ModuleCompletion`. | **SERIAL first** | §3, §4 |
| **W3-A2** | EDITS `lm-node-executor.ts` against A1's new SPI. Moves board/task vocab into `adapterData`, emits `DriverNeutralExecutionReceipt`. | **SERIAL second** (after A1) | §5 |
| **W3-A3** | Activates exact `AgentLaunchSpec` resolution: wires Wave 2 `installation_id`/`package_digest` onto `ProcessRunRecord` + `StartProcessModuleCommand` + `rowToRecord()`; the executor resolves package-pinned resources (not catalog). | **SERIAL third** (after A2) | §6 |
| **W3-A4** | `ProcessProductRepository` port + adapter: exact-by-`ProductRef` queries (replaces the `listArtifactsForNodeInEpic` fallback, §9.11). NEW files only. | parallel | §7 |
| **W3-A5** | `ExecutionContextAssembler` (NEW): loads exact upstream `NodeProductionEnvelope`s by predecessor refs from the NodeRun row (replaces `restoreFrame` mutable reconstruction, §13.7). NEW file. | parallel | §8 |
| **W3-A6** | `NodeRun v2` persistence: ALTER `saga3_node_runs` to add `input_envelope_hash`, `node_ref` (JSON), `package_ref` (JSON), `predecessor_node_run_ids` (JSON), `definition_digest`, `transition_cursor`. **Single SQL writer** (coordinates with W3-A4 if it needs schema). NEW persistence file + ALTER. | parallel (SQL owner) | §9 |
| **W3-A7** | `WorkerExecutionPort` generalization + `ContractBoundaryDecoder` (NEW): decode/validate module/node/handoff payloads via `ContractSchemaRegistry` at boundaries (§7.4.2). NEW files. | parallel | §10 |
| **W3-A8** | Conformance tests: crash-resume proof (§0.6.12 exit gate), exact-product-query proof, no-fallback-reconstruction proof. NEW test files + barrel if needed. | parallel (test-only) | §11 |

## 3. W3-A1 — Core executor envelope refactor (HOT FILES)

### `node-executor.ts` changes (additive + signature evolution)
- **ADD** `NodeExecutionContextV2` (or evolve `NodeExecutionContext`): replace `frame: NodeExecutionFrame` with `envelope: ExecutionContextEnvelope` (Wave 1 type). Move `projectId`/`epicId` into `envelope.adapterScope` (a new optional field) OR keep them as deprecated aliases that read from adapterData. **Preserve backward compat**: the legacy `frame` field stays as a computed view (assembled from `envelope.upstreamProducts`) so existing node executors don't break until Wave 5 migrates them.
- **ADD** `NodeExecutionResultV2` that uses `NodeProductionEnvelope` (Wave 1) instead of flat `NodeProduction`, and `DriverNeutralExecutionReceipt` instead of board-coupled `NodeExecutionReceipt`. **Preserve** the existing `NodeExecutionResult` as a legacy shape; provide an adapter `toV2Result(legacy): NodeExecutionResultV2`.
- **DO NOT remove** `NodeExecutionFrame`/`NodeProduction`/`NodeExecutionReceipt` legacy types yet (Wave 5/9 migrate consumers). Wave 3 ADDS the v2 shapes and makes the generic-flow-executor CONSUME them.

### `generic-flow-executor.ts` changes
- **REPLACE** `restoreFrame()` (:833-861) mutable reconstruction with a call to W3-A5's `ExecutionContextAssembler` (loaded by exact predecessor refs, not "list all node runs"). Keep `restoreFrame()` as a legacy fallback ONLY for pre-Wave-3 NodeRuns (detected by absence of `input_envelope_hash`).
- **REPLACE** magic certificate binding extraction (:213-216 `production.bindings.certificatePayload`) with explicit `ModuleCompletion` detection: if the terminal node's result carries a `ModuleCompletion` (Wave 1 type), use its `outputEnvelope`/`certificateRef` directly. **Preserve** the legacy `certificatePayload` path as a fallback for nodes that haven't migrated (Wave 8/9).
- **PERSIST** `NodeProductionEnvelope` (with lineage) to NodeRun via W3-A6's new columns, alongside the legacy flat `output*` columns (dual-write during migration).
- **DO NOT** change the lease/checkpoint/recovery-loop mechanics (§13.26-13.30 preserve) — only change what lineage/receipt data is pinned.

### Anti-scope for A1
- Do NOT migrate `lm-node-executor.ts` (A2 owns).
- Do NOT add `AgentLaunchSpec` wiring (A3 owns).
- Do NOT remove legacy types/paths — additive + dual-write only (plan §16.9: each phase leaves the previous path runnable).

## 4. Exit-gate mapping for A1
- `generic-flow-executor.ts` consumes `ExecutionContextEnvelope` (assembled from exact predecessor products, not mutable frame).
- Terminal settlement reads `ModuleCompletion` explicitly (magic-bindings path is fallback-only, documented).
- `NodeProductionEnvelope` with lineage is persisted to NodeRun (dual-write with legacy `output*`).
- Existing characterization tests (`tests/characterization/lifecycle-routing-mapping-lock.test.mjs`, `tests/process-modules/*`) still PASS (no behavior change for legacy-shaped runs).

## 5. W3-A2 — LM executor driver-neutrality (after A1)

- Edit `lm-node-executor.ts`: emit `DriverNeutralExecutionReceipt` (board/task/WorkIntent go into `adapterData`), consume the A1 v2 context envelope.
- Move `processBinding` lineage bag (:271-292) construction behind an explicit `SagaBoardAdapterDataBuilder` (NEW small file under `application/node-executors/`) so the LM executor calls a driver-neutral port and the board-specific snake_case stamping is isolated.
- **Preserve** `LmNodeExecutionPersistence` port shape (Wave 5 migrates it fully) — Wave 3 only changes what the executor EMITS (driver-neutral receipt) and what it READS (envelope instead of frame).

## 6. W3-A3 — AgentLaunchSpec activation (after A2)

- Surface `installationId`/`packageDigest` on `ProcessRunRecord` + `StartProcessModuleCommand` + `rowToRecord()` + `ProcessRunRow` (the Wave 2 unfinished thread).
- The executor (generic-flow) reads `processRun.installationId` → resolves pinned package resources via Wave 2 `PackageRegistry`/`describeInstallation` (NOT the built-in catalog). If `installationId` is null (legacy run), fall back to the existing catalog path (compatibility, plan §14.3.7).
- **No NOT NULL enforcement** yet (Wave 11). New runs started via the installation path set both fields; legacy runs stay null.

## 7. W3-A4 — ProcessProductRepository (exact-by-ProductRef)

NEW files: `persistence/process-product-repository-v2.ts` (port) + `sqlite-process-product-repository-v2.ts` (adapter).
- Port: `getByProductRef(ref: ProductRef): ProcessProductRecord | null` (exact query by `(schemaId, ref, digest)`), `getByArtifactRef(artifactRef: string)`, `recordProduct(envelope: NodeProductionEnvelope, processRunId, nodeId)`.
- Replaces the `listArtifactsForNodeInEpic` fallback usage — callers query by exact `ProductRef` from the execution envelope's `upstreamProducts`.
- **Single SQL owner coordination**: if W3-A4 needs a new table/index, it coordinates with W3-A6 (the wave's SQL owner). Prefer reusing `saga3_process_products` (additive index on `(schema_id, ref, digest)`).

## 8. W3-A5 — ExecutionContextAssembler

NEW file: `application/execution-context-assembler.ts`.
- `assembleExecutionContext(processRunId, nodeId, attempt, upstreamProductRefs: readonly ProductRef[], repos): Promise<ExecutionContextEnvelope>`.
- Loads each upstream product via W3-A4's `ProcessProductRepository.getByProductRef` (exact). Throws `UPSTREAM_PRODUCT_NOT_FOUND` if a predecessor product is missing (NO fallback to epic-scope search — §9.11).
- Constructs the Wave 1 `ExecutionContextEnvelope` with `upstreamProducts` populated, `frozenAuthority` from the ProcessRun, `packageRef`/`nodeRef` from the run's installation + flow.
- This is the replacement for `restoreFrame()` — called by A1's refactored generic-flow-executor.

## 9. W3-A6 — NodeRun v2 persistence (SQL owner)

NEW file: `persistence/node-run-v2.ts` (record types) + extend `sqlite-node-run-repository.ts` with v2 columns (OR new `sqlite-node-run-repository-v2.ts` — prefer extending to avoid split).
- ALTER `saga3_node_runs` (additive, idempotent `try/catch`): `input_envelope_hash TEXT`, `node_ref TEXT` (JSON NodeRef), `package_ref TEXT` (JSON PackageRef), `predecessor_node_run_ids TEXT` (JSON array), `definition_digest TEXT`, `transition_cursor TEXT`, `production_envelope TEXT` (JSON NodeProductionEnvelope).
- Port methods: `startV2(...)`, `completeV2(...)` that write the new columns alongside legacy `output*` (dual-write).
- `readByExactCursor(processRunId, nodeId, attempt)` — the resume query that replaces `readLastCompleted` + frame reconstruction.
- **Single SQL writer**: W3-A6 owns ALL `saga3_node_runs` ALTERs this wave. W3-A4 coordinates through A6 for any `saga3_process_products` index.

## 10. W3-A7 — WorkerExecutionPort + ContractBoundaryDecoder

NEW files: `application/worker-execution-port.ts` + `application/contract-boundary-decoder.ts`.
- `WorkerExecutionPort` — generalize `LmNodeExecutionPersistence` into a driver-neutral port (board/task vocab moves to `adapterData`). This is the TYPE Wave 5 fully adopts; Wave 3 defines it and the LM executor (A2) produces driver-neutral receipts against it.
- `ContractBoundaryDecoder` — `decodeAtBoundary(ref: ContractRef, value: unknown, registry: ContractSchemaRegistry): unknown` + `validateAtBoundary(ref, value, registry): ValidationResult`. Validates module input, node input, node output, module completion, scenario handoff at their boundaries (§7.4.2). Uses Wave 1 `ContractSchemaRegistry`.

## 11. W3-A8 — Conformance + crash-resume proof (test-only)

NEW test files under `tests/installation/` or `tests/execution/`:
- `crash-resume-exact-receipt.test.mjs` — the §0.6.12 exit gate: simulate crash after worker completion but before kernel verification; resume MUST load the exact receipt + production from NodeRun (not latest-execution/process-scope/task-metadata/magic-binding reconstruction). Assert the resumed envelope matches the pre-crash one byte-for-byte (content hash).
- `exact-product-query.test.mjs` — prove W3-A4 `getByProductRef` returns the exact product (no epic-scope fallback).
- `no-fallback-reconstruction.test.mjs` — assert `ExecutionContextAssembler` throws `UPSTREAM_PRODUCT_NOT_FOUND` when a predecessor product is missing (no silent fallback).
- Regression: existing characterization + process-module tests still pass.

## 12. Exit gate (plan §0.6.12)

Wave 3 closes when ALL hold:
1. `npm run build` green.
2. `generic-flow-executor.ts` consumes `ExecutionContextEnvelope` (assembled from exact predecessor products).
3. Terminal settlement reads `ModuleCompletion` explicitly (magic-bindings is fallback).
4. LM executor emits `DriverNeutralExecutionReceipt` (board/task in adapterData).
5. `ProcessRunRecord` carries `installationId`/`packageDigest` (Wave 2 thread closed).
6. NodeRun v2 columns persist input-envelope hash, protocol identity, predecessor refs, definition digest, production envelope.
7. **Crash-resume proof**: crash after worker completion resumes from exact receipt + product (§0.6.12) — NO latest-execution/process-scope/task-metadata/magic-binding reconstruction.
8. Exact-product query works (no epic-scope fallback).
9. Ratchet stays GREEN (no new module-name literals in core files; no forbidden imports).
10. Wave 0/1/2 regression suites GREEN.

## 13. Integration order (integrator, serial)

1. W3-A6 (SQL owner — NodeRun v2 columns must exist).
2. W3-A4 (ProcessProductRepository — A5 depends on it).
3. W3-A7 (WorkerExecutionPort + ContractBoundaryDecoder — A1/A2 consume).
4. W3-A5 (ExecutionContextAssembler — A1 consumes).
5. **W3-A1** (core executor refactor — consumes A4/A5/A6/A7).
6. **W3-A2** (LM executor — consumes A1's new SPI).
7. **W3-A3** (AgentLaunchSpec — consumes A2 + Wave 2).
8. W3-A8 (conformance tests — consumes all).
Gate after each pick. The A1→A2→A3 chain is built incrementally (build after A1, after A2, after A3).

## 14. Schema changes (single SQL owner = W3-A6)

ADDITIVE only. ALTER `saga3_node_runs` with 7 nullable columns (§9). Possible new index on `saga3_process_products (schema_id, ref, digest)` (coordinate A4↔A6). No NOT NULL (Wave 11). No removal of legacy columns.

## 15. Anti-scope (Wave 3 does NOT do)
- No ProtocolRun state machine (Wave 4).
- No CallInstance (Wave 5).
- No tracker/hook changes (Wave 5).
- No full LM persistence port migration (Wave 5) — Wave 3 only changes receipts/emissions.
- No removal of legacy `NodeExecutionFrame`/`NodeProduction`/`NodeExecutionReceipt` (Wave 5/9).
- No module migration (Wave 8/9).
- **No behavior change for existing legacy-shaped runs** (dual-write + fallback paths, plan §16.9).
