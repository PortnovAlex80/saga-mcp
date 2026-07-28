# W2-A7 — 3rd synthetic module fixture + describe + security fixtures

**Wave:** 2 · **Lane:** A7 · **Spec:** §1 rows 13,14 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a7` · **Worktree:`.worktrees/w2-a7`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 rows 13,14, §6 exit gate items 3,5).
2. `tests/fixtures/synthetic-modules/` (W0-A7 — the 4 existing synthetic modules). Your 3rd module is a 5th, proving no-catalog-edit install (plan §14.4.7).
3. W0-A7 fixture README + `tests/fixtures/synthetic-modules/lm-marketing/definition.mjs` (the shape to mirror).
4. W2-A1/A2/A3 tasks (you exercise their store/installer/repo).

## Own (only you)
- `tests/installation/fixtures/3rd-synthetic-module/` — NEW fixture dir (definition.mjs + manifest.json + a couple resource files).
- `tests/installation/fixtures/malformed/` — security fixtures: path-traversal resource, hash-mismatch resource, version-collision pair.
- `src/process-modules/installation/domain/describe.ts`
- `tests/installation/describe.test.mjs`

## What to build (spec §1 rows 13,14)
### 3rd synthetic module fixture (`tests/installation/fixtures/3rd-synthetic-module/`)
- A 5th synthetic module distinct from W0-A7's 4 — e.g. `synthetic-compliance-check` (a Kernel-node module that "checks compliance"). identity `name: 'synthetic-compliance-check'`, `version: '0.1.0'`, `kind: 'compliance'`. One Kernel node, one outcome. Definition.mjs exports the `ProcessModuleDefinition`-shaped object (mirror W0-A7 lm-marketing pattern). Include 1-2 resource files (a checklist .md) so the resourceIndex is non-empty — this proves resource resolution.
- This fixture is the **§14.4.7 exit-gate proof**: installing it requires NO edit to `modules/catalog.ts`, NO edit to Runtime, NO edit to another module. It installs purely via the W2-A3 installer + W2-A1 store + W2-A2 repo.

### `describe.ts` (pure projection, plan §12.1)
- `InstallationDescription { name; version; packageDigest; flowSummary: { nodeCount; nodeKinds: readonly string[]; outcomes: readonly string[] }; resourceCount; handlerCount; toolCount; capabilityCount; inputContractRef; outputContractRef }`.
- `describeInstallation(record: ModuleInstallationRecord): InstallationDescription` — pure projection from the persisted record (no I/O). Counts resources/handlers/tools from `record.resourceIndex`/`handlerRefs`/`record.manifestSnapshot.toolContributions`.

### Security fixtures (`tests/installation/fixtures/malformed/`)
- `path-traversal-resource.json` — a ResourceBlob with `logicalId: '../escape'` (for W2-A1 negative test, but you OWN the fixture file).
- `hash-mismatch.json` — a stored-package meta where a resource digest doesn't match bytes (for W2-A1/A3 corrupt detection).
- `version-collision/` — two manifests with same (name, version) but different content (for W2-A2/A3 collision test).

## Tests (`tests/installation/describe.test.mjs`)
- Construct a `ModuleInstallationRecord` (from the 3rd synthetic fixture wrapped via `adaptLegacyProcessModule` + a fake resourceIndex) → `describeInstallation` returns correct counts/summary.
- Pure projection: same record → same description (deterministic).

NOTE: you do NOT write the installer/store/repo tests (those are W2-A1/A2/A3). You provide the FIXTURES they (and W2-A8 conformance) consume. Coordinate via the spec'd fixture paths.

## Anti-scope
- Do NOT install the 3rd module yourself in a test (W2-A8 conformance does the full install-replay proof using your fixture).
- Do NOT edit `modules/catalog.ts` (the whole point is no-catalog-edit).
- Do NOT touch W0-A7 fixtures.

## Verify
```
cd .worktrees/w2-a7 && npm run build && node --test tests/installation/describe.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN. `describe.ts` imports `ModuleInstallationRecord` from W2-A2 (type-only) — resolves at integration.

## Commit
`test(installation): W2-A7 3rd synthetic module fixture + describe + security fixtures (no-catalog-edit proof)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result. 4. The 3rd module's identity + the fixture paths (W2-A8 conformance consumes them). 5. Confirmation.
