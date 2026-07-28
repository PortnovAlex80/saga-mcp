# Wave 1 — Pure SPI Frozen Contract Spec

> Frozen by the integrator (serial precondition, plan §0.4.2) on `b0746cd`.
> This document is the SPI contract every Wave 1 lane validates against. Lane
> tasks (`05-subagent-tasks/W01-AY-*.md`) reference it as the source of truth.
> Workers MUST NOT change this spec; if a gap is found, STOP and escalate (§0.1.7).

## 0. Reconnaissance result (what already exists)

Wave 0 reconnaissance (`docs/refactor-management/01-CODEBASE-BASELINE.md` + Wave 1
prep scan) established that most SPI types from plan §4.1 **already exist as
pure serializable data** in `src/process-modules/domain/`:

- `process-module.ts`: `ProcessModuleReference`, `ProcessModuleIdentity`, `SchemaReference`, `OutcomeDefinition`, `ArtifactTypeDefinition`, `PolicyDefinition`, `InvariantDefinition`, `RetryPolicyDefinition`, `RecoveryPolicyDefinition`, `ExecutionProfileDefinition`, `FlowNodeKind` (`'lm'|'kernel'|'human'|'external'|'composite'`), the 5 node defs + `FlowNodeDefinition` discriminated union, `FlowTransitionDefinition`, `FlowRecoveryDefinition`, `FlowDefinition`, `ProcessModuleDefinition`. **All pure** (only `processModuleKey()` is a function helper).
- `lifecycle.ts`: `LifecycleIdentity`, `TransitionTarget`, `LifecycleMappingExpression`, `StageBinding`, `LifecycleDefinition`, `LifecycleRouteResult`. **Pure except `routeResolver?: RouteResolver`** (a function — non-serializable; documented).
- `recovery.ts`: `RecoveryIssue`, `RecoveryFeedback`, `RecoveryFinding`, `RecoverySubjectRef`, schema-id constants. **All pure.**
- `shared/canonical-json.ts` re-exports `canonicalJson`/`sha256Hex` from `src/saga3/shared/discovery-canonical.ts`. `canonicalJson`: object keys sorted lexicographically via `Object.keys().sort()`, no whitespace, `undefined` object values dropped by `JSON.stringify` semantics. `sha256Hex`: SHA-256 over canonicalJson, lowercase hex. **Frozen primitives — do not change.**
- `application/node-executor.ts`: `NodeExecutionResult`, `NodeExecutionReceipt`, `NodeProduction`, `NodeExecutionFrame` are pure; `NodeExecutor` SPI port is behavioral (port).
- `application/process-module-executor.ts`: `ProcessModuleExecutionContext`, `ProcessModuleRunResult` pure; `ProcessModuleExecutor` SPI behavioral.
- `application/exact-candidate-acceptance.ts`: `AcceptExactCandidatesCommand`, `ExactCandidateAcceptanceDecision`, `ExactCandidateAcceptanceReceipt` pure; `ExactCandidateAcceptance` port behavioral.
- `application/process-output-payload-registry.ts`: `ProcessOutputPayloadResolutionContext` pure; registry class behavioral.
- `persistence/process-run.ts`: `ExecutorKind`, `ProcessModuleOutput`, `ProcessModuleCertificateRef` pure.

**Therefore Wave 1 is NOT "create all SPI types".** It is: (a) introduce the
**genuinely new** pure types the plan names that do not yet exist, (b) add
**canonical-serialization validators + negative tests** that enforce plan §3.5
(no functions/Maps/Sets/undefined/non-enumerable in persisted manifests), (c)
add the **ContractRef** with identity+version+digest, (d) add the
**NodeProtocolDefinition** (plan §8.2), (e) add the **ModuleCompletion** /
**ProcessModuleOutputEnvelope** (plan §7.5.6, §13.20), and (f) wrap the legacy
definition behind an adapter so the new SPI is the canonical surface.

## 1. New files (frozen layout) — `src/process-modules/domain/spi/`

Wave 1 creates a **new `spi/` subdir** under `domain/`. This keeps new pure types
disjoint from existing files (which other code imports today). Ownership:

| File | Owner | Contents |
|---|---|---|
| `domain/spi/canonical-serialization.ts` | W1-A1 | `isCanonicalSerializable(value)`, `assertCanonicalSerializable(value)`, `canonicalJsonOrThrow(value)`. Rejects functions, `Map`, `Set`, `undefined` (in arrays — object-key `undefined` is dropped by canonicalJson intentionally), class instances, non-finite numbers, `Symbol`s. Re-uses `canonicalJson` from `shared/canonical-json.ts`. |
| `domain/spi/contract-ref.ts` | W1-A5 | `ContractRef { schemaId: string; version: string; digest: string }`. Pure. `digest` = `sha256Hex` of the canonical schema document (Wave 1 uses a placeholder/stub digest registry; real codecs in W1-A5). |
| `domain/spi/contract-schema-registry.ts` | W1-A5 | `ContractSchemaRegistry` PORT (interface) + `InMemoryContractSchemaRegistry` adapter. `register(ref, codec)`, `decode(ref, bytes)`, `encode(ref, value)`, `has(ref)`, `validateOrThrow(ref, value)`. |
| `domain/spi/module-manifest.ts` | W1-A2 | `ProcessModuleManifest` — pure envelope that wraps a `ProcessModuleDefinition` PLUS the new pure fields: `manifestFormatVersion: string`, `resourceIndex: readonly ResourceIndexEntry[]`, `handlerRefs: readonly HandlerRef[]`, `toolContributions` (typed by W1-A6), `assistance` + `guards` (typed by W1-A6), `capabilityRequirements` (W1-A6), `inputContractRef`/`outputContractRef: ContractRef`, `runtimeCompatibilityRange: string`. **No executor, no factories, no functions.** |
| `domain/spi/resource-index.ts` | W1-A2 | `ResourceIndexEntry { logicalId: string; path: string; kind: ResourceKind; digest: string }`, `ResourceKind = 'skill'|'instruction'|'reviewer-skill'|'template'|'mcp-call-template'|'checklist'|'schema'|'error-hint'|'description'|'test'`. Pure. |
| `domain/spi/scenario-manifest.ts` | W1-A3 | `LifecycleScenarioManifest` — **the one genuinely new domain aggregate.** Fields per plan §6.2: `manifestFormatVersion`, `identity: LifecycleIdentity`, `inputContractRef`/`outputContractRef: ContractRef`, `entryStageId`, `stageBindings: readonly ScenarioStageBinding[]`, `outcomeRoutes` (deterministic), `inputMappings`/`outputMappings` (safe own-property paths), `terminalStatuses: readonly string[]`, `scenarioRetryPolicy`/`pausePolicy`/`cancellationPolicy`/`escalationPolicy`, `requiredModuleSelectors: readonly ModuleSelector[]`, `capabilityRequirements`, `transitionBudgets: TransitionBudgets`, `reentryBudgets: ReentryBudgets`. **Reuses `LifecycleIdentity`, `StageBinding`, `LifecycleMappingExpression`, `TransitionTarget` from `domain/lifecycle.ts` verbatim.** **NO `routeResolver` field (plan §6.4).** |
| `domain/spi/node-protocol.ts` | W1-A4 | `NodeProtocolDefinition` per plan §8.2: `id`, `version`, `owningFlowNodeId`, `entryStep`, `steps: readonly ProtocolStep[]`, `transitions: readonly ProtocolStepTransition[]`, `nodeCompletionEvidence: readonly EvidenceRequirement[]`, `recoveryEntrySteps: readonly string[]`, `retrySemantics: RetrySemanticsKind`. `ProtocolStep { id; instructions; resources; allowedTools; evidenceRequirements; assistance; guards }`. All pure. |
| `domain/spi/execution-envelope.ts` | W1-A4 | `ExecutionContextEnvelope` per plan §7.7: `processRunId`, `nodeRunId`, `attempt`, `executionId`, `packageRef`, `nodeRef`, `frozenAuthority`, `immutableRunInput`, `upstreamProducts: readonly ProductRef[]`, `recoveryFeedback?`, `scenarioId?`, `stageId?`. Pure. **Board/task/WorkIntent IDs are NOT base fields — they live in adapter data.** |
| `domain/spi/execution-receipt.ts` | (extends existing) | `NodeExecutionReceipt` already exists and is pure. Wave 1 adds a **driver-neutral receipt** variant `DriverNeutralExecutionReceipt` with `schemaVersion`, `nodeRunId`, `attempt`, `runtimeEvent`, `driverKind`, `adapterData?: Record<string, unknown>` (board/task/WorkIntent go here). Pure. |
| `domain/spi/production-envelope.ts` | W1-A6 | `NodeProductionEnvelope` per plan §7.6 (extends `NodeProduction`): `+ schemaId: string; productRef: ProductRef; lineage: readonly LineageRef[]; bindings?`. `ProductRef { schemaId; ref; digest }`. `ProcessModuleOutputEnvelope` per plan §13.20: the complete immutable module output that crosses the module boundary — `{ outcome; productions: readonly NodeProductionEnvelope[]; certificateRef?; completion: ModuleCompletion }`. Pure. |
| `domain/spi/module-completion.ts` | W1-A6 | `ModuleCompletion` per plan §7.5.6 — **explicit terminal envelope** replacing magic certificate bindings: `{ outcome: string; outputEnvelope: ProcessModuleOutputEnvelope; terminal: boolean }`. Pure. |
| `domain/spi/recovery-definitions.ts` | W1-A6 | Re-exports `RecoveryIssue`/`RecoveryFeedback` from `domain/recovery.ts` and adds pure definition types the plan names: `RecoveryAction = 'retry-current-node'|'return-to-producer'|'enter-recovery-node'|'request-human'|'pause-external'|'escalate'|'terminate'` (plan §8.10), `RecoveryPolicyBinding { nodeId; actionMap: Record<string, RecoveryAction> }`. Pure. |
| `domain/spi/tool-contribution.ts` | W1-A6 | `ModuleToolContribution` per plan §11.4: `logicalId (namespaced); version; inputContractRef; outputContractRef; handlerRef; callTemplateRef?; checklistRef?; errorHintRef?; guardBindings; idempotency: 'none'|'idempotent'; sideEffect: 'none'|'read'|'write'|'external'`. `CapabilityRequirement { ref; version; optional? }`. `GuardBinding { ref; scope }`. Pure. |
| `domain/spi/agent-assistance.ts` | W1-A6 | `AgentAssistanceDefinition { nodeId; mode: 'compact'|'guided'|'intensive'; events: readonly AssistanceEvent[]; budgets: AssistanceBudgets }`. `AssistanceEvent { event: 'step-enter'|'post-tool-success'|'post-tool-error'|'before-submit'|'recovery-enter'|'resume'; blocks: readonly AssistanceBlock[] }`. `AssistanceBlock { kind: 'goal'|'current-step'|'next-action'|'resource-path'|'allowed-tools'|'completion-criteria'|'last-error'|'repair-fields'|'retry-instruction'; content }`. Pure. |
| `domain/spi/legacy-adapter.ts` | W1-A7 | `LegacyProcessModuleAdapter` — wraps an existing `ProcessModuleDefinition` (which already lacks the new manifest fields) into a `ProcessModuleManifest` with empty/optional new fields + a `legacy: true` marker. Pure adapter (no behavior). |

**Barrel file** `domain/spi/index.ts` (W1-A8 owns) re-exports all of the above for clean imports.

## 2. Validators (frozen behavior)

Each lane that owns a manifest type also owns its validator:
- `validateProcessModuleManifest(m): ValidationResult`
- `validateLifecycleScenarioManifest(m): ValidationResult`
- `validateNodeProtocolDefinition(d): ValidationResult`
- `validateFlowDefinition` (existing — W1-A4 hardens it to reject ignored `condition` strings per plan §7.4.3 / C065)
- `validateModuleToolContribution`, `validateAgentAssistanceDefinition`, `validateGuardBinding`, `validateCapabilityRequirement` (W1-A6)
- `validateContractRef` (W1-A5)

`ValidationResult = { ok: boolean; errors: readonly ValidationError[] }`. `ValidationError = { code: string; path: string; message: string }`. Pure.

**Every validator MUST call `assertCanonicalSerializable` on its input first** (plan §3.5) and reject any function/Map/Set/undefined-in-array/class-instance/Symbol/non-finite-number.

## 3. Negative test contract (plan §0.4.11 serial gate)

For each manifest type, Wave 1 must prove REJECTION of:
- a function value in any field,
- a `Map` or `Set` in any field,
- `undefined` inside an array,
- a class instance (not plain object),
- a non-finite number (`NaN`, `Infinity`),
- a `Symbol`,
- (Flow) an ignored/unsupported `condition` string (plan §7.4.3 / C065),
- (Flow/NodeProtocol) an unsupported `retrySemantics` declaration (plan §8.2.11 / C065),
- (Scenario) a `routeResolver` field present (plan §6.4 — must be structurally absent).

## 4. Round-trip contract (plan §0.4.11)

Every manifest type must satisfy:
```
assertDeepEqual(parse(canonicalJson(m)), m)
```
where `parse` is `JSON.parse`. AND `sha256Hex(m)` is stable across runs (canonicalJson determinism).

The W0-A7 synthetic fixtures (`tests/fixtures/synthetic-modules/*`, `tests/fixtures/synthetic-scenarios/campaign/*`) are the round-trip proof targets. W1-A8 wraps them into the new manifest types and asserts round-trip + cross-contract conformance.

## 5. What Wave 1 does NOT do (anti-scope, deferred to later waves)

- No `ModulePackageStore`, no content-addressed filesystem (Wave 2).
- No installation persistence / `saga3_process_module_installations` table (Wave 2).
- No `ExecutionContextEnvelope` *consumption* by executors (Wave 3 — Wave 1 only defines the type).
- No `ProtocolRun` state machine (Wave 4 — Wave 1 only defines `NodeProtocolDefinition`).
- No `CallInstance` (Wave 5).
- No MCP tool contribution *installation* (Wave 6 — Wave 1 only defines the type).
- No scenario *runtime* (Wave 7 — Wave 1 only defines the manifest).
- No production module migration (Waves 8/9).
- **No edits to existing `domain/process-module.ts`, `domain/lifecycle.ts`, `domain/recovery.ts`, `application/*` production files.** Wave 1 only ADDS new files under `domain/spi/`. Existing types are reused via import, not modified.

## 6. Exit gate (plan §0.4.11)

Wave 1 closes when ALL hold:
1. All new `domain/spi/*.ts` files compile (`npm run build` green).
2. `assertCanonicalSerializable` rejects every forbidden value kind (negative tests pass).
3. Every manifest validator rejects its negative cases (negative tests pass).
4. `ProcessModuleManifest` + `LifecycleScenarioManifest` round-trip through canonical JSON (round-trip tests pass).
5. The W0-A7 synthetic fixtures wrap into the new manifest types and round-trip (W1-A8 conformance tests pass).
6. **No existing production source file is modified** (commits are new `domain/spi/*.ts` + new test files only).
7. Two unrelated synthetic packages validate using the same SPI without Runtime changes (plan §14.2.6 — the W0-A7 lm-marketing + external-seo fixtures prove this).

## 7. Test command (the wave gate)

```bash
npm run build
node --test tests/spi/**/*.test.mjs
node --test tests/architecture/dependency-direction.test.mjs   # ratchet still green (no new violations)
```

The dependency-direction ratchet (W0-A1) MUST stay green: new `domain/spi/` files import only from `domain/` (pure) and `shared/canonical-json.ts` (pure) — no module-impl, no persistence-adapter, no lifecycle-scenario-impl imports. If a lane's new file would create a new violation, STOP and escalate.
