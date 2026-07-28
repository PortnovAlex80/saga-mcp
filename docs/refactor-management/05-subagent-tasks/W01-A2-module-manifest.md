# W1-A2 — ProcessModuleManifest + ResourceIndex

**Wave:** 1 · **Lane:** A2 · **Spec:** §1 rows 4,5 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a2` · **Worktree:** `.worktrees/w1-a2`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. `src/process-modules/domain/process-module.ts` (`ProcessModuleDefinition` — your manifest WRAPS it, does not replace it).
3. `tests/fixtures/synthetic-modules/lm-marketing/definition.mjs` + `manifest.json` (your manifest must accommodate this shape).

## Own (only you)
- `src/process-modules/domain/spi/resource-index.ts`
- `src/process-modules/domain/spi/module-manifest.ts`
- `tests/spi/module-manifest.test.mjs`

## What to build (per spec §1 rows 4,5)
- `resource-index.ts`: `ResourceKind = 'skill'|'instruction'|'reviewer-skill'|'template'|'mcp-call-template'|'checklist'|'schema'|'error-hint'|'description'|'test'`. `ResourceIndexEntry { logicalId: string; path: string; kind: ResourceKind; digest: string }`. Pure readonly. `digest` is `sha256Hex` of the resource bytes (Wave 1 callers without real bytes may use placeholder `'pending@wave-2'`, documented).
- `module-manifest.ts`: `ProcessModuleManifest` — pure envelope. Fields: `manifestFormatVersion: string`, `definition: ProcessModuleDefinition` (reuse from `../process-module.js`), `resourceIndex: readonly ResourceIndexEntry[]`, `handlerRefs: readonly HandlerRef[]` where `HandlerRef { logicalId: string; version: string; digest: string }`, `inputContractRef: ContractRef` (import from `../spi/contract-ref.js` — W1-A5), `outputContractRef: ContractRef`, `runtimeCompatibilityRange: string`, `toolContributions?: readonly ModuleToolContribution[]` (import from W1-A6), `assistance?: readonly AgentAssistanceDefinition[]` (W1-A6), `guards?: readonly GuardBinding[]` (W1-A6), `capabilityRequirements?: readonly CapabilityRequirement[]` (W1-A6). **No executor, no factories, no functions.**
- `validateProcessModuleManifest(m): ValidationResult` — calls `assertCanonicalSerializable` (W1-A1) then structural checks: required fields present, `resourceIndex` entries have unique `logicalId`, `handlerRefs` unique `logicalId`, `manifestFormatVersion` non-empty, `definition` is itself a valid `ProcessModuleDefinition` (reuse existing validation if present, else structural check).

## Tests
- Positive: construct a `ProcessModuleManifest` wrapping the W0-A7 `lm-marketing` fixture's `ProcessModuleDefinition` (import from `tests/fixtures/synthetic-modules/lm-marketing/definition.mjs`) with a minimal resourceIndex/handlerRefs. `validateProcessModuleManifest` returns `{ ok: true }`. Round-trips through canonical JSON.
- Negative: rejects function/Map/Set/undefined-in-array/class-instance in any field; rejects duplicate `logicalId` in resourceIndex; rejects duplicate `logicalId` in handlerRefs; rejects empty `manifestFormatVersion`; rejects missing required fields.

## Cross-lane imports
- `ContractRef`, `computeContractRefDigest` from `../spi/contract-ref.js` (W1-A5 — import the path; resolves at integration).
- `ModuleToolContribution`, `AgentAssistanceDefinition`, `GuardBinding`, `CapabilityRequirement` from `../spi/tool-contribution.js` / `../spi/agent-assistance.js` (W1-A6 — type-only imports).
- `assertCanonicalSerializable` from `../spi/canonical-serialization.js` (W1-A1).
- `ProcessModuleDefinition` from `../process-module.js` (existing).

## Anti-scope
- Do NOT modify `domain/process-module.ts`. Do NOT touch other lanes' files.

## Verify
```
cd .worktrees/w1-a2 && npm run build && node --test tests/spi/module-manifest.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A2 ProcessModuleManifest + ResourceIndex + validator`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. Exported symbols (`ProcessModuleManifest`, `ResourceIndexEntry`, `ResourceKind`, `HandlerRef`, `validateProcessModuleManifest`) — A7 legacy-adapter imports these. 5. Confirmation. Escalate ambiguities.
