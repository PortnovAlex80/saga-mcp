# W1-A7 — LegacyProcessModuleAdapter

**Wave:** 1 · **Lane:** A7 · **Spec:** §1 row 15 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a7` · **Worktree:** `.worktrees/w1-a7`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. `src/process-modules/domain/process-module.ts` (`ProcessModuleDefinition` — the legacy shape).
3. `src/process-modules/modules/catalog.ts` + `modules/installations.ts` (the 4 production modules you will wrap).

## Own (only you)
- `src/process-modules/domain/spi/legacy-adapter.ts`
- `tests/spi/legacy-adapter.test.mjs`

## What to build (spec §1 row 15, plan §14.2.4)
`adaptLegacyProcessModule(definition: ProcessModuleDefinition, opts?: { manifestFormatVersion?: string }): ProcessModuleManifest`:
- A pure function (no class). Wraps an existing `ProcessModuleDefinition` into a `ProcessModuleManifest` (import from W1-A2 `module-manifest.js`) with:
  - `manifestFormatVersion: opts?.manifestFormatVersion ?? 'legacy-0'`.
  - `definition` = the input.
  - `resourceIndex: []` (legacy has no declared resources — documented gap, Wave 8/9 fills).
  - `handlerRefs: []` (legacy binds handlers at composition time, not in manifest — documented gap).
  - `inputContractRef` / `outputContractRef`: derive from `definition.inputContract`/`outputContract` (`SchemaReference { id }`) into `ContractRef { schemaId: id; version: 'legacy'; digest: 'pending@wave-2' }`.
  - `runtimeCompatibilityRange: '>=2.0.0 <3.0.0'`.
  - tool/assistance/guards/capabilities omitted (optional fields).
- Export `LEGACY_MANIFEST_FORMAT_VERSION = 'legacy-0'` constant.
- The result MUST pass `validateProcessModuleManifest` (import from W1-A2). Add `legacy: true` is NOT a field (keep manifest pure + uniform); instead the `manifestFormatVersion: 'legacy-0'` signals legacy.

## Tests
- Positive: wrap each of the 4 production module definitions (import from `modules/catalog.ts` via `createBuiltInProcessModuleRegistry()` — iterate the 4). Each result passes `validateProcessModuleManifest` and round-trips through canonical JSON.
- Positive: wrap the W0-A7 synthetic `lm-marketing` fixture definition (it's already a `ProcessModuleDefinition`); validate + round-trip.
- Negative: the wrapped manifest must still reject injected non-serializable values (e.g. if someone passes a `ProcessModuleDefinition` carrying a function in an extension field, `validateProcessModuleManifest` rejects it).

## Cross-lane imports
- `ProcessModuleManifest`, `validateProcessModuleManifest` from `../spi/module-manifest.js` (W1-A2).
- `ContractRef` from `../spi/contract-ref.js` (W1-A5).
- `ProcessModuleDefinition` from `../process-module.js` (existing).

## Anti-scope
- Do NOT modify any production source. Do NOT touch other lanes' files.
- Do NOT add real resources/handlers (Wave 8/9 do that for migrated modules).

## Verify
```
cd .worktrees/w1-a7 && npm run build && node --test tests/spi/legacy-adapter.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A7 LegacyProcessModuleAdapter (wraps existing ProcessModuleDefinition)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. Exported symbols (`adaptLegacyProcessModule`, `LEGACY_MANIFEST_FORMAT_VERSION`). 5. Confirmation. Escalate ambiguities.
