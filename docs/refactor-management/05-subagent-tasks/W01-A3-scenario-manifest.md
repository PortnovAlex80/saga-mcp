# W1-A3 — LifecycleScenarioManifest (the one genuinely new aggregate)

**Wave:** 1 · **Lane:** A3 · **Spec:** §1 row 6 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a3` · **Worktree:** `.worktrees/w1-a3`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full — esp. §0 reconnaissance note about reusing existing lifecycle types).
2. `src/process-modules/domain/lifecycle.ts` (`LifecycleIdentity`, `StageBinding`, `LifecycleMappingExpression`, `TransitionTarget` — REUSE these; do NOT redefine).
3. `tests/fixtures/synthetic-scenarios/campaign/definition.mjs` (W0-A7 — your manifest must accommodate this shape; note it adds `manifestFormatVersion`, `source`, `terminalStatuses` beyond `LifecycleDefinition`).
4. Plan §6.2 (manifest fields), §6.4 (no routeResolver).

## Own (only you)
- `src/process-modules/domain/spi/scenario-manifest.ts`
- `tests/spi/scenario-manifest.test.mjs`

## What to build (spec §1 row 6, plan §6.2)
`LifecycleScenarioManifest` — pure readonly:
- `manifestFormatVersion: string`
- `identity: LifecycleIdentity` (import from `../lifecycle.js`)
- `inputContractRef: ContractRef` / `outputContractRef: ContractRef` (import from `../spi/contract-ref.js` W1-A5)
- `entryStageId: string`
- `stageBindings: readonly ScenarioStageBinding[]` where `ScenarioStageBinding` reuses `StageBinding` (import) — OR if you need the extra `moduleSelector` field per plan §6.3.2, define `ScenarioStageBinding extends StageBinding { moduleSelector: ModuleSelector }`. Prefer extending to avoid breaking existing `StageBinding`.
- `ModuleSelector { name: string; versionRange: string }` (semver range string; resolved to exact install in Wave 7)
- `outcomeRoutes: Readonly<Record<string, TransitionTarget>>` (deterministic; reuse `TransitionTarget`)
- `inputMappings` / `outputMappings: Readonly<Record<string, LifecycleMappingExpression>>` (reuse)
- `terminalStatuses: readonly string[]`
- `scenarioRetryPolicy` / `pausePolicy` / `cancellationPolicy` / `escalationPolicy`: each a pure `{ kind: string; params?: Readonly<Record<string, unknown>> }` shape (Wave 1 declares the field; Wave 7 implements). Keep these as a single `ScenarioPolicies { retry; pause; cancellation; escalation }` sub-object.
- `requiredModuleSelectors: readonly ModuleSelector[]`
- `capabilityRequirements?: readonly CapabilityRequirement[]` (import from W1-A6)
- `transitionBudgets: TransitionBudgets { maxTransitions: number; perStage?: Readonly<Record<string, number>> }`
- `reentryBudgets: ReentryBudgets { maxReentries: number; perStage?: Readonly<Record<string, number>> }`
- **NO `routeResolver` field.** The type structurally must not allow it (plan §6.4). A test asserts that constructing a manifest object literal with a `routeResolver` key fails TypeScript OR fails `validateLifecycleScenarioManifest`.

`validateLifecycleScenarioManifest(m): ValidationResult`:
- `assertCanonicalSerializable` (W1-A1).
- entry stage exists in `stageBindings`.
- every `outcomeRoutes` target is an existing stage or a declared `terminalStatus`.
- `terminalStatuses` non-empty.
- mapping paths are safe own-property paths (reject `__proto__`/`prototype`/`constructor` — reuse the rule from existing `lifecycle-mapper.ts` conceptually, but implement a pure `isSafeMappingPath(p): boolean` here).
- `transitionBudgets.maxTransitions` > 0; `reentryBudgets.maxReentries` >= 0.
- **Reject if a `routeResolver` key is present** (plan §6.4 — structural absence).

## Tests
- Positive: construct `LifecycleScenarioManifest` from the W0-A7 `campaign` fixture (import `campaignScenario` from `tests/fixtures/synthetic-scenarios/campaign/definition.mjs`, map its fields into the manifest shape). Validate passes. Round-trips through canonical JSON.
- Negative: rejects routeResolver key present; rejects entry stage missing; rejects outcome route to nonexistent stage; rejects empty terminalStatuses; rejects unsafe mapping path (`__proto__`); rejects function/Map/Set in any field; rejects `maxTransitions <= 0`.

## Anti-scope
- Do NOT modify `domain/lifecycle.ts` (reuse via import). Do NOT touch other lanes' files.
- Do NOT implement scenario runtime (Wave 7). Wave 1 only defines + validates the manifest.

## Verify
```
cd .worktrees/w1-a3 && npm run build && node --test tests/spi/scenario-manifest.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A3 LifecycleScenarioManifest + validator (no routeResolver, §6.4)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. Exported symbols (`LifecycleScenarioManifest`, `ScenarioStageBinding`, `ModuleSelector`, `ScenarioPolicies`, `TransitionBudgets`, `ReentryBudgets`, `validateLifecycleScenarioManifest`). 5. Confirmation. Escalate ambiguities.
