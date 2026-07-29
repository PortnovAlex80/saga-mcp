# W3-A1 — Core executor envelope refactor (HOT FILES — SERIAL 1st)

**Wave:** 3 · **Lane:** A1 · **Spec:** §3, §4 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a1` · **Worktree:** `.worktrees/w3-a1`

## CRITICAL: You are the FIRST serial executor lane. A2 + A3 build on your SPI. Additive + dual-write only (plan §16.9). Preserve all legacy paths.

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §3, §4 (FULL).
2. `src/process-modules/application/node-executor.ts` (SPI port — FULL).
3. `src/process-modules/application/generic-flow-executor.ts` (walker — esp. `restoreFrame` :833-861, settlement :210-320, magic bindings :213-216).
4. Wave 1 SPI: `ExecutionContextEnvelope`, `NodeProductionEnvelope`, `ModuleCompletion`, `DriverNeutralExecutionReceipt` from `domain/spi/index.ts`.
5. W3-A5 task (ExecutionContextAssembler — you call it), W3-A6 task (NodeRun v2 — you write to it), W3-A7 task (ContractBoundaryDecoder — you use it).

## Own (EDIT existing hot files)
- EDIT `src/process-modules/application/node-executor.ts` — ADD v2 context/result types (spec §3).
- EDIT `src/process-modules/application/generic-flow-executor.ts` — consume envelope, explicit ModuleCompletion, dual-write NodeProductionEnvelope (spec §4).

## Build (spec §3, §4)
### node-executor.ts
- ADD `NodeExecutionContextV2` with `envelope: ExecutionContextEnvelope` (replaces `frame`). Keep legacy `NodeExecutionContext` + compute `frame` from `envelope.upstreamProducts` for backward compat.
- ADD `NodeExecutionResultV2` using `NodeProductionEnvelope` + `DriverNeutralExecutionReceipt`. Keep legacy `NodeExecutionResult`; provide `toV2Result(legacy)`.
- DO NOT remove legacy types.

### generic-flow-executor.ts
- REPLACE `restoreFrame()` call with `assembleExecutionContext(...)` (W3-A5) for runs that have v2 NodeRun columns (`input_envelope_hash` present). Keep `restoreFrame()` as LEGACY fallback for old NodeRuns.
- REPLACE magic certificate binding extraction (:213-216) with: if result has `ModuleCompletion`, use its `outputEnvelope`/`certificateRef` explicitly. Keep `certificatePayload` path as fallback.
- DUAL-WRITE: `nodeRunRepo.completeV2(...)` writes `production_envelope` + legacy `output*`.
- Preserve lease/checkpoint/recovery mechanics (§13.26-13.30).

## Anti-scope
- Do NOT edit `lm-node-executor.ts` (A2).
- Do NOT wire AgentLaunchSpec (A3).
- Do NOT remove legacy types/paths.
- Do NOT add module-name literals (Rule 4a).

## Verify
`npm run build && node --test tests/characterization/lifecycle-routing-mapping-lock.test.mjs && node --test tests/process-modules/generic-flow-feedback-recovery.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`
ALL must PASS (no behavior change for legacy runs). W3-A5/A6/A7 ports may be absent locally — guard with feature-detection (presence of v2 columns / assembler) and fall back to legacy path.

## Commit
`feat(execution): W3-A1 core executor envelope refactor (v2 context/result, ModuleCompletion explicit, dual-write)`

## Return
Branch+sha, diff --stat, test tails+ratchet, the exact v2 type names + method signatures (A2 consumes), confirmation.
