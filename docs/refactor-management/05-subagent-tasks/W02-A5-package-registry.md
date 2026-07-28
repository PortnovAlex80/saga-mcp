# W2-A5 — PackageRegistry port + InstallationBasedPackageRegistry adapter

**Wave:** 2 · **Lane:** A5 · **Spec:** §1 row 9 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a5` · **Worktree:** `.worktrees/w2-a5`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 row 9, §0 reconnaissance note about the in-memory catalog it replaces).
2. Wave 1 barrel: `ModuleSelector` (from `scenario-manifest.js`), `ContractRef`.
3. W2-A2 task: `ModuleInstallationRecord`, `ModuleInstallationRepository` port.

## Own (only you)
- `src/process-modules/installation/domain/package-registry.ts`
- `tests/installation/package-registry.test.mjs`

## What to build (spec §1 row 9, plan §14.4.1, §14.4.5)
Replace built-in catalog lookups with an injected registry. NO module-name switching (plan §3.6, C011).
- `PackageRegistry` PORT: `select(selector: ModuleSelector): ModuleInstallationRecord` (throws `PACKAGE_NOT_INSTALLED` if no active installation matches), `registerInstallation(record: ModuleInstallationRecord): void`, `listSelectors(): readonly ModuleSelector[]`, `has(selector): boolean`.
- `InstallationBasedPackageRegistry implements PackageRegistry` — backed by a `ModuleInstallationRepository` (injected). `select(selector)` queries `repo.getActiveByNameVersion(selector.name, ...)` resolving `versionRange` (semver range) to the active installation. Keep range resolution SIMPLE in Wave 2: support exact `version` match + `*` wildcard + `^x.y.z`/`~x.y.z` (use a tiny semver matcher or `semver`-like minimal impl — do NOT add a dependency; inline a ~30-line matcher). If multiple active installations match a range, pick the highest version (deterministic). NO prefix matching, NO first-match (plan §14.4.5).
- The registry is RUNTIME state (behavioral) — that's correct; it's not persisted (the repo is persisted, the registry is a cache/view).

## Tests
- Use an in-memory fake `ModuleInstallationRepository` (array-backed) OR the real sqlite one (mkdtemp). If siblings absent, fake + note.
- Positive: register 2 installations (different versions of same name); `select({name, versionRange:'^1.0.0'})` returns the higher; `select({name, version:'1.0.0'})` exact match; `has`/`listSelectors`.
- Negative: `select` unknown name → `PACKAGE_NOT_INSTALLED`. `select` version range matching nothing → `PACKAGE_NOT_INSTALLED`.
- Negative: two active installations with SAME (name, version) cannot coexist (the repo enforces UNIQUE; the registry trusts the repo).
- Determinism: same query always returns same record (no random/order-dependent selection).

## Anti-scope
- Do NOT edit `modules/catalog.ts` or `modules/installations.ts` (Wave 13 removes them; Wave 2 only adds the alternative).
- Do NOT wire the registry into the composition root (integrator does at checkpoint).
- Do NOT edit `execution-profile-resolver.ts` (Wave 3 removes the catalog import).

## Verify
```
cd .worktrees/w2-a5 && npm run build && node --test tests/installation/package-registry.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN.

## Commit
`feat(installation): W2-A5 PackageRegistry port + InstallationBasedPackageRegistry (semver range, no name-switching)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result. 4. Exported symbols. 5. The exact semver-range syntaxes you support (exact, *, ^, ~). 6. Confirmation.
