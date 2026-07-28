# W1-A4 — NodeProtocolDefinition + ExecutionContextEnvelope + Flow hardening

**Wave:** 1 · **Lane:** A4 · **Spec:** §1 rows 7,8 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a4` · **Worktree:** `.worktrees/w1-a4`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. `src/process-modules/domain/process-module.ts` (`FlowDefinition`, `FlowNodeKind`, `FlowTransitionDefinition` with `condition?`).
3. Plan §8 (Node Protocol), §7.4.3 (ignored conditions), §8.2.11 (unsupported retry).

## Own (only you)
- `src/process-modules/domain/spi/node-protocol.ts`
- `src/process-modules/domain/spi/execution-envelope.ts`
- `tests/spi/node-protocol.test.mjs`
- `tests/spi/execution-envelope.test.mjs`

## What to build
### `node-protocol.ts` (spec §1 row 7, plan §8.2)
- `RetrySemanticsKind = 'runtime-implemented-linear'|'runtime-implemented-backoff'|'unsupported'`. (Plan §8.2.11: retry semantics must be fully implemented by Runtime or rejected at install. Wave 1 declares the kinds; `unsupported` is the reject target.)
- `EvidenceRequirement { category: 'tool-receipt'|'artifact-reference'|'trace-reference'|'human-receipt'|'external-receipt'|'module-verifier-receipt'; contractRef: ContractRef; required: boolean }` (import `ContractRef` from W1-A5).
- `ProtocolStep { id: string; instructions: string; resources: readonly string[]; allowedTools: readonly string[]; evidenceRequirements: readonly EvidenceRequirement[]; assistance?: AgentAssistanceDefinition; guards?: readonly GuardBinding[] }` (import assistance/guards from W1-A6 — type-only).
- `ProtocolStepTransition { from: string; to: string; kind: 'linear'|'branch'|'repeat'; condition?: string }`.
- `NodeProtocolDefinition { id: string; version: string; owningFlowNodeId: string; entryStep: string; steps: readonly ProtocolStep[]; transitions: readonly ProtocolStepTransition[]; nodeCompletionEvidence: readonly EvidenceRequirement[]; recoveryEntrySteps: readonly string[]; retrySemantics: RetrySemanticsKind }`.
- `validateNodeProtocolDefinition(d): ValidationResult` — `assertCanonicalSerializable` + structural checks (entry step exists in steps, every transition targets an existing step, step ids unique, retrySemantics in the enum). **Reject `retrySemantics: 'unsupported'`** (plan §8.2.11 / C065).

### `execution-envelope.ts` (spec §1 row 8, plan §7.7)
- `ExecutionContextEnvelope { processRunId: number; nodeRunId: number; attempt: number; executionId: string; packageRef: PackageRef; nodeRef: NodeRef; frozenAuthority: Readonly<Record<string, unknown>>; immutableRunInput: unknown; upstreamProducts: readonly ProductRef[]; recoveryFeedback?: RecoveryFeedback; scenarioId?: string; stageId?: string }`.
- `PackageRef { name: string; version: string; digest: string }`, `NodeRef { nodeId: string; flowId: string; flowVersion: string }`.
- `ProductRef` — re-export from W1-A6 `production-envelope.js` (do not redefine).
- Import `RecoveryFeedback` from `../recovery.js` (existing).
- **Board/task/WorkIntent IDs are NOT base fields** (plan §7.7.1-7.7.6, §13.16, C061) — the envelope is driver-neutral. If a test tries to add `taskId`, it must fail canonical serialization or be excluded by type.

### Flow hardening (spec §3, plan §7.4.3 / C065)
In `tests/spi/node-protocol.test.mjs`, add a characterization/contract test that documents the rule: a `FlowTransitionDefinition.condition` that is NOT a supported deterministic policy reference or predicate must be REJECTED at install. Since Wave 1 does NOT modify the existing `FlowDefinition`/validator (anti-scope), implement this as a NEW pure function `isSupportedFlowCondition(condition: string | undefined): boolean` in `node-protocol.ts` that returns true for `undefined` (no condition) and false for any opaque string (Wave 1's conservative stance: only `undefined` is supported; declarative predicates arrive in Wave 7). Test asserts: `undefined` → true; `'some opaque string'` → false. This is the C065 ratchet seed.

## Tests
- Positive: valid `NodeProtocolDefinition` with linear steps + `retrySemantics: 'runtime-implemented-linear'` passes + round-trips. Valid `ExecutionContextEnvelope` round-trips.
- Negative: rejects function/Map/Set/etc. in any field; rejects `retrySemantics: 'unsupported'`; rejects transition targeting nonexistent step; rejects duplicate step ids; rejects envelope carrying a function in `frozenAuthority`.
- C065: `isSupportedFlowCondition('opaque')` === false.

## Anti-scope
- Do NOT modify `domain/process-module.ts` (existing FlowDefinition stays). Do NOT touch other lanes' files.

## Verify
```
cd .worktrees/w1-a4 && npm run build && node --test tests/spi/node-protocol.test.mjs tests/spi/execution-envelope.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A4 NodeProtocolDefinition + ExecutionContextEnvelope + flow-condition ratchet`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. Exported symbols. 5. Confirmation. Escalate ambiguities.
