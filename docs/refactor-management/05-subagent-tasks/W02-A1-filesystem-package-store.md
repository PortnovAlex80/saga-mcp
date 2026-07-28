# W2-A1 — ModulePackageStore port + FilesystemModulePackageStore adapter

**Wave:** 2 · **Lane:** A1 · **Spec:** §1 rows 1,2 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a1` · **Worktree:** `.worktrees/w2-a1`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 rows 1,2, §4 digest rules, §2 ports/adapters).
2. `src/process-modules/domain/spi/index.ts` (Wave 1 barrel — `ProcessModuleManifest`, `ResourceIndexEntry`, `ResourceKind`, `HandlerRef`).
3. `src/process-modules/shared/canonical-json.ts` (`canonicalJson`, `sha256Hex` — frozen primitives).

## Own (only you)
- `src/process-modules/installation/domain/package-store.ts` — port + pure value types.
- `src/process-modules/installation/adapters/filesystem-package-store.ts` — content-addressed filesystem adapter.
- `tests/installation/filesystem-package-store.test.mjs`.

## What to build (spec §1 rows 1,2)
### `installation/domain/package-store.ts` (pure — Rule 5: imports only `domain/spi/*`, `shared/canonical-json.ts`)
- `ResourceBlob { logicalId: string; kind: ResourceKind; bytes: Uint8Array; digest: string }` — `digest` = `sha256Hex(bytes)` (compute via crypto, NOT canonicalJson — bytes are raw). Pure.
- `StoredModulePackage { manifest: ProcessModuleManifest; resources: readonly ResourceBlob[]; packageDigest: string; storedAt: string }`. Pure.
- `PackageStoreError` codes: `PACKAGE_STORE_PATH_TRAVERSAL`, `PACKAGE_STORE_DIGEST_MISMATCH`, `PACKAGE_STORE_NOT_FOUND`, `PACKAGE_STORE_CORRUPT`.
- PORT `ModulePackageStore { store(manifest, resources): Promise<StoredModulePackage>; read(packageDigest): Promise<StoredModulePackage>; exists(packageDigest): Promise<boolean>; verify(packageDigest): Promise<boolean> }`.

### `installation/adapters/filesystem-package-store.ts` ( Rule 5 N/A — this is `adapters/`, allowed to use `node:fs`/`node:path`/`node:crypto`)
- `FilesystemModulePackageStore implements ModulePackageStore` — constructor `(rootDir: string)`.
- **Content-addressed layout**: `<rootDir>/<digest-prefix-2>/<digest-prefix-4>/<full-digest>/` containing `manifest.json` (canonical JSON of manifest) + `resources/<logicalId-slugified>` blobs + `package.meta.json` (`{ packageDigest, storedAt, resourceDigests }`).
- `store`: compute `packageDigest = sha256Hex(canonicalJson({ manifest, resourceIndex: manifest.resourceIndex, resourceDigests: resources.map(r => r.digest) }))`. Write atomically (write to tmp dir, rename). Reject path traversal in `logicalId` (no `..`, no absolute paths — plan §5.5.2). Reject undeclared resources (every blob's logicalId must be in `manifest.resourceIndex`).
- `read`: load `package.meta.json` + manifest + resources; reconstruct `ResourceBlob[]`. **Verify each resource digest** (`sha256Hex(bytes) === blob.digest`) — mismatch → `PACKAGE_STORE_DIGEST_MISMATCH`. Verify `packageDigest` matches the directory name.
- `verify`: `read` + recompute `packageDigest` from loaded content; compare to stored. Mismatch → false (caller flips installation status to `corrupt`).
- `exists`: stat the directory.

## Tests (`tests/installation/filesystem-package-store.test.mjs`)
- Use `mkdtempSync(...)` for rootDir. Cleanup in `try/finally`.
- Positive: store a manifest + 2 resources → directory created with correct content-addressed path; read returns identical bytes; verify true; exists true.
- Positive: `packageDigest` stable across two `store` calls with identical input (deterministic).
- Negative: path traversal in `logicalId` (`'../escape'`, `'/abs'`) → `PACKAGE_STORE_PATH_TRAVERSAL`.
- Negative: resource not declared in `manifest.resourceIndex` → rejected.
- Negative: mutate a stored resource file on disk → `read` throws `PACKAGE_STORE_DIGEST_MISMATCH`; `verify` returns false.
- Negative: `read` unknown digest → `PACKAGE_STORE_NOT_FOUND`.
- **The §14.3.8 exit-gate test**: store a package; mutate the IN-MEMORY manifest/resources; `read` the stored digest → returns the ORIGINAL bytes (immutability proof). Document this test clearly.

## Anti-scope
- Do NOT create the `saga3_module_installations` table (W2-A2 owns).
- Do NOT compute `packageDigest` differently than spec §4 (`sha256Hex(canonicalJson({manifest, resourceIndex, resourceDigests}))`).
- Do NOT touch `composition/` or existing production source.
- Do NOT edit `domain/spi/*`.

## Verify
```
cd .worktrees/w2-a1 && npm run build && node --test tests/installation/filesystem-package-store.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN. Note: `installation/domain/package-store.ts` imports from `domain/spi/*` (Rule 5 clean). `installation/adapters/filesystem-package-store.ts` is in `adapters/` — Rule 5 doesn't apply (it's not `domain/`); Rule 2 doesn't apply (it's not `modules/`).

## Commit
`feat(installation): W2-A1 ModulePackageStore port + FilesystemModulePackageStore (content-addressed, immutable)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet. 4. Exported symbols (`ModulePackageStore`, `StoredModulePackage`, `ResourceBlob`, `PackageStoreError` codes) — W2-A3 installer imports these. 5. The exact `packageDigest` formula you implemented (must match spec §4). 6. Confirmation. Escalate ambiguities.
