# W2-A3 — PackageInstaller + DependencyLock

**Wave:** 2 · **Lane:** A3 · **Spec:** §1 rows 5,6 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a3` · **Worktree:** `.worktrees/w2-a3`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 rows 5,6, §4 digest/identity rules, §5 anti-scope).
2. Wave 1 barrel (`domain/spi/index.ts`): `ProcessModuleManifest`, `ResourceIndexEntry`, `HandlerRef`, `ContractRef`, `validateProcessModuleManifest`, `assertCanonicalSerializable`.
3. W2-A1 task (`05-subagent-tasks/W02-A1-filesystem-package-store.md`) — the `ModulePackageStore` port + `packageDigest` formula you consume.
4. W2-A2 task — the `ModuleInstallationRepository` port + `ModuleInstallationRecord` you persist.

## Own (only you)
- `src/process-modules/installation/domain/dependency-lock.ts`
- `src/process-modules/installation/domain/installer.ts`
- `tests/installation/installer.test.mjs`

## What to build (spec §1 rows 5,6)
### `dependency-lock.ts` (pure)
- `DependencyLockEntry { refKind: 'contract'|'handler'|'resource'; logicalId: string; version?: string; digest: string }`.
- `DependencyLock { entries: readonly DependencyLockEntry[]; lockDigest: string }` — `lockDigest = sha256Hex(canonicalJson(entries))`.
- `computeDependencyLock(manifest, opts?): DependencyLock` — iterate `manifest.inputContractRef`/`outputContractRef` (ContractRef → 'contract' entries), `manifest.handlerRefs` (HandlerRef → 'handler' entries), `manifest.resourceIndex` (ResourceIndexEntry → 'resource' entries). Each entry's `digest` comes from the manifest field (ContractRef.digest, HandlerRef.digest, ResourceIndexEntry.digest). Wave 2 does NOT resolve against a live `ContractSchemaRegistry` (placeholder digests `'pending@wave-2'` are accepted and flagged); real resolution is Wave 3+.

### `installer.ts` (pure orchestration — depends on W2-A1 store port + W2-A2 repo port via TYPE-ONLY imports)
- `PackageInstaller` — class or function `installPackage(manifest, resources, deps: { store: ModulePackageStore; repo: ModuleInstallationRepository }, opts?): Promise<ModuleInstallationRecord>`.
- Steps (spec §1 row 5):
  1. `validateProcessModuleManifest(manifest)` — reject if invalid.
  2. `assertCanonicalSerializable(manifest)` — belt-and-suspenders.
  3. Resolve resources: every `ResourceBlob.logicalId` must be in `manifest.resourceIndex`; reject undeclared.
  4. `computeDependencyLock(manifest)` → lock.
  5. `store.store(manifest, resources)` → `StoredModulePackage` (gets `packageDigest`).
  6. `repo.insert({ name, version, packageDigest, manifestSnapshot: manifest, storeLocation: stored.storeAt, resourceIndex, handlerRefs, dependencyLock: lock, status: 'staged', installedAt })` → record. Catch `MODULE_INSTALLATION_VERSION_COLLISION` → rethrow (caller decides).
  7. `store.verify(packageDigest)` — if false, `repo.markCorrupt(id)` + throw `MODULE_INSTALLATION_CORRUPT`.
  8. `repo.activate(id)` → return the active record.
- The installer is PURE orchestration: it takes `store` + `repo` as deps (dependency injection). It does NOT import the sqlite/filesystem adapters directly (Rule 5 for `domain/`).

## Tests (`tests/installation/installer.test.mjs`)
- Construct in-memory fakes OR use the real W2-A1 `FilesystemModulePackageStore` (mkdtemp) + W2-A2 `SqliteModuleInstallationRepository` (mkdtemp DB). If siblings not present in your worktree, write minimal fakes matching the ports + note in return.
- Positive: install a synthetic manifest (use W0-A7 `lm-marketing` wrapped via `adaptLegacyProcessModule` + a couple of ResourceBlob) → returns active `ModuleInstallationRecord`; record persisted; store has the package.
- Positive: `packageDigest` of the record matches `store.read(digest).packageDigest`.
- Negative: install SAME (name,version) with DIFFERENT resources → second call throws `MODULE_INSTALLATION_VERSION_COLLISION` (the repo enforces; installer propagates).
- Negative: install with undeclared resource → rejected before store.
- Negative: install with invalid manifest (function in a field) → rejected at validate step.
- **The §0.5.12 replay test**: install; mutate the input manifest/resources in memory; re-install with SAME (name,version) → collision (because digest would differ → can't replace active); the ORIGINAL record still reads from store with original bytes. Document this.

## Cross-lane imports (type-only / port-only)
- `ModulePackageStore`, `StoredModulePackage`, `ResourceBlob` from `installation/domain/package-store.js` (W2-A1).
- `ModuleInstallationRepository`, `ModuleInstallationRecord` from `installation/domain/installation.js` (W2-A2).
- `ProcessModuleManifest`, `validateProcessModuleManifest`, `assertCanonicalSerializable`, `ResourceIndexEntry`, `HandlerRef`, `ContractRef` from `domain/spi/index.js` (Wave 1).
- `canonicalJson`, `sha256Hex` from `shared/canonical-json.js`.

## Anti-scope
- Do NOT call `ContractSchemaRegistry` for real digest resolution (Wave 3+). Accept placeholder digests.
- Do NOT edit `db.ts` (W2-A2 owns).
- Do NOT touch composition root.

## Verify
```
cd .worktrees/w2-a3 && npm run build && node --test tests/installation/installer.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN. Sibling ports (W2-A1/A2) may not be present locally — use fakes, note in return.

## Commit
`feat(installation): W2-A3 PackageInstaller + DependencyLock (orchestrates store+repo, version-collision, corruption detection)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result (pass with fakes OR unresolved-import). 4. Exported symbols. 5. Confirmation. Escalate ambiguities.
