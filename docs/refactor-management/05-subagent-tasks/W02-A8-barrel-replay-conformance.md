# W2-A8 — Barrel + Wave 2 exit-gate conformance (install → mutate → replay → identical)

**Wave:** 2 · **Lane:** A8 · **Spec:** §1 barrel + §6 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a8` · **Worktree:`.worktrees/w2-a8`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §6 exit gate, §1 barrel).
2. W0-A7 fixtures (`tests/fixtures/synthetic-modules/`) + W2-A7 3rd-synthetic fixture (`tests/installation/fixtures/3rd-synthetic-module/`).
3. All sibling W2 task files (to know the export surface).

## Own (only you)
- `src/process-modules/installation/index.ts` — barrel re-exporting the Wave 2 surface.
- `tests/installation/round-trip-replay-conformance.test.mjs` — THE Wave 2 exit-gate proof.

## What to build
### `index.ts` barrel
Re-export from sibling `installation/domain/*.ts` + `installation/persistence/*.ts` (the port, not the sqlite adapter — or both, your call but document) + `installation/adapters/*.ts`. Use the W1-A8 lesson: use explicit named re-exports where sibling files share type names (e.g. `ValidationResult`) to avoid `export *` collisions.

### `round-trip-replay-conformance.test.mjs` — THE §0.5.12 / §6 exit gate
This single test file proves the Wave 2 exit gate end-to-end:
1. **Install** the W2-A7 3rd synthetic module via `installPackage(manifest, resources, {store, repo})` (real `FilesystemModulePackageStore` mkdtemp + `SqliteModuleInstallationRepository` mkdtemp DB). Assert returns active `ModuleInstallationRecord`.
2. **Replay-after-source-mutation** (§14.3.8 / §6 item 2): after install, MUTATE the in-memory `manifest`/`resources` (change a field, change resource bytes). `store.read(record.packageDigest)` MUST return the ORIGINAL bytes (immutability). `repo.getByPackageDigest` returns the original record.
3. **Version collision** (§6 item 3): attempt to install a DIFFERENT manifest under the same `(name, version)` → `MODULE_INSTALLATION_VERSION_COLLISION`.
4. **Pinned installation not nullifiable** (§6 item 4): `setPinnedInstallation(runId, installationId, packageDigest)`; `getPinnedInstallation` returns the pin; a legacy run (NULL) resolves via the fallback adapter.
5. **3rd module installs without catalog/Runtime/module edit** (§6 item 5 / §14.4.7): the test imports ONLY from `installation/` + `domain/spi/` + the fixture — NO import from `modules/catalog.ts`, `modules/installations.ts`, or any production module. Assert this structurally (the test file's import list IS the proof).
6. **Dependency lock resolves** (§6 item 6): `computeDependencyLock(manifest)` produces a non-empty lock with one entry per resource/handler/contract ref.
7. **Corruption detection** (§5.5.7): after install, corrupt a stored resource file on disk → `store.verify(digest)` returns false → caller marks installation `corrupt`.
8. **describeInstallation** produces a correct summary of the installed record.

## Cross-lane imports
- Everything from sibling `installation/domain/*` + `installation/persistence/*` + `installation/adapters/*` via the barrel.
- W0-A7 + W2-A7 fixtures.

## Anti-scope
- Do NOT modify sibling `installation/*` files (you only create `index.ts`). If a sibling export name diverges, STOP + escalate.
- Do NOT wire into composition root (integrator at checkpoint).

## Verify
```
cd .worktrees/w2-a8 && npm run build && node --test tests/installation/round-trip-replay-conformance.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
**EXPECTED**: fails locally with unresolved imports (siblings absent). Integrator runs full gate after cherry-picking A2→A1→A3→A5→A6→A4→A7→A8. State clearly in return: pass or unresolved-import.

## Commit
`test(installation): W2-A8 barrel + Wave 2 exit-gate conformance (install→mutate→replay→identical)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result (pass OR unresolved-import — state which). 4. Full barrel export list + every sibling symbol referenced (integrator verifies all landed). 5. Confirmation. Escalate sibling-spec mismatches immediately.
