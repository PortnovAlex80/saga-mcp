# W1-A6 — Production envelope, ModuleCompletion, recovery/tool/assistance definitions, driver-neutral receipt

**Wave:** 1 · **Lane:** A6 · **Spec:** §1 rows 9–14 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a6` · **Worktree:** `.worktrees/w1-a6`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. `src/process-modules/application/node-executor.ts` (`NodeProduction` — you extend it).
3. `src/process-modules/domain/recovery.ts` (`RecoveryIssue`/`RecoveryFeedback` — you re-export + add definitions).
4. `docs/refactor-management/01-CODEBASE-BASELINE.md` §"node-executor.ts" / §"exact-candidate-acceptance.ts".

## Own (only you)
- `src/process-modules/domain/spi/production-envelope.ts`
- `src/process-modules/domain/spi/module-completion.ts`
- `src/process-modules/domain/spi/recovery-definitions.ts`
- `src/process-modules/domain/spi/tool-contribution.ts`
- `src/process-modules/domain/spi/agent-assistance.ts`
- `src/process-modules/domain/spi/execution-receipt.ts`
- `tests/spi/production-envelope.test.mjs`
- `tests/spi/module-completion.test.mjs`
- `tests/spi/tool-contribution.test.mjs`
- `tests/spi/agent-assistance.test.mjs`

## What to build (per spec §1 rows 9–14 — read the spec for exact fields)
- `production-envelope.ts`: `ProductRef { schemaId; ref; digest }`, `LineageRef { kind: 'node-run'|'production'|'receipt'; ref: string }`, `NodeProductionEnvelope` (extends shape of existing `NodeProduction` from `application/node-executor.ts` — import `NodeProduction` and add fields: `schemaId: string; productRef: ProductRef; lineage: readonly LineageRef[]`), `ProcessModuleOutputEnvelope { outcome: string; productions: readonly NodeProductionEnvelope[]; certificateRef?: ProductRef; completion: ModuleCompletion }`. (Import `ModuleCompletion` from your own `module-completion.ts`.)
- `module-completion.ts`: `ModuleCompletion { outcome: string; outputEnvelope: ProcessModuleOutputEnvelope; terminal: boolean }`. NOTE: `outputEnvelope` references `ProcessModuleOutputEnvelope` from `production-envelope.ts` and vice versa — this is a circular type reference, resolved via TypeScript `import type`. Both are pure data; the cycle is type-only, not runtime.
- `recovery-definitions.ts`: re-export `RecoveryIssue`, `RecoveryFeedback`, `RecoveryFinding`, `RecoverySubjectRef` from `../recovery.js`. Add `RecoveryAction` union (plan §8.10: `'retry-current-node'|'return-to-producer'|'enter-recovery-node'|'request-human'|'pause-external'|'escalate'|'terminate'`), `RecoveryPolicyBinding { nodeId: string; actionMap: Readonly<Record<string, RecoveryAction>> }`.
- `tool-contribution.ts`: `ModuleToolContribution`, `CapabilityRequirement`, `GuardBinding` per spec §1 row 12 (fields listed there).
- `agent-assistance.ts`: `AgentAssistanceDefinition`, `AssistanceEvent`, `AssistanceBlock`, `AssistanceBudgets` per spec §1 row 13.
- `execution-receipt.ts`: `DriverNeutralExecutionReceipt { schemaVersion: string; nodeRunId: number; attempt: number; runtimeEvent: 'completed'|'failed'|'paused'; driverKind: FlowNodeKind; adapterData?: Readonly<Record<string, unknown>> }` — board/task/WorkIntent IDs go into `adapterData`, NOT base fields (plan §10.14, §13.16, C061). Import `FlowNodeKind` from `../process-module.js`.

## Validators (spec §2)
For each manifest-like type, export a `validateX(value): ValidationResult` that calls `assertCanonicalSerializable` (import from W1-A1 `canonical-serialization.ts`) then checks structural completeness (required fields present, enum values valid). `ValidationResult = { ok: boolean; errors: readonly ValidationError[] }`, `ValidationError = { code; path; message }`.

## Tests
For each type: positive (valid instance passes + round-trips via canonical JSON) AND negative (rejects function/Map/Set/undefined-in-array/class-instance/Symbol/non-finite in any field, plus invalid enum value). For `ModuleToolContribution` also assert `idempotency`/`sideEffect` enum enforcement. For `AgentAssistanceDefinition` assert `mode` and `event` enum enforcement.

## Anti-scope
- Do NOT modify `application/node-executor.ts` (import `NodeProduction` type-only).
- Do NOT modify `domain/recovery.ts` (re-export from it).
- Do NOT touch other lanes' files.

## Verify
```
cd .worktrees/w1-a6 && npm run build && node --test tests/spi/production-envelope.test.mjs tests/spi/module-completion.test.mjs tests/spi/tool-contribution.test.mjs tests/spi/agent-assistance.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A6 production/completion/recovery/tool/assistance definitions + driver-neutral receipt`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. Exported symbol list (A2 manifest imports these). 5. Confirmation. Escalate ambiguities.
