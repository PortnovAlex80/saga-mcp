# W2-A2 — ModuleInstallationRepository + SQL owner (the ONLY `db.ts` editor this wave)

**Wave:** 2 · **Lane:** A2 (SQL OWNER) · **Spec:** `09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` §1 rows 3,4 + §3
**Frozen input commit:** `15d931a` · **Branch:** `refactor/w2-a2` · **Worktree:** `.worktrees/w2-a2`

## CRITICAL: You are the SINGLE SQL owner this wave (plan §0.5.2, C083)
No other Wave 2 lane may edit `src/db.ts` or create SQL tables. You own ALL schema changes. Other lanes that need schema STOP and request through you.

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §3 schema, §4 identity rules).
2. `src/db.ts` (the migration chain + `getDb()` — you add to it).
3. `src/process-modules/persistence/sqlite-process-run-repository.ts` (the existing `ensureSaga3ProcessRunSchema` pattern — mirror it).
4. `src/process-modules/domain/spi/index.ts` (Wave 1 barrel — `ProcessModuleManifest`, `ResourceIndexEntry`, `HandlerRef`).

## Own (only you)
- `src/process-modules/installation/domain/installation.ts` — pure value types.
- `src/process-modules/installation/persistence/installation-repository.ts` — port + sqlite adapter + `ensureSaga3ModuleInstallationSchema(db)`.
- `tests/installation/installation-repository.test.mjs`.
- `src/db.ts` — ADD `ensureSaga3ModuleInstallationSchema(db)` call + 2 idempotent ALTERs on `saga3_process_runs` (the ONLY `db.ts` edit this wave).

## What to build (spec §3, §4)
### `installation/domain/installation.ts` (pure)
- `ModuleInstallationId` = branded type (e.g. `number & { __brand: 'ModuleInstallationId' }`) or plain `number`.
- `ModuleInstallationStatus = 'staged'|'validated'|'active'|'retired'|'corrupt'`.
- `ModuleInstallationRecord { id: ModuleInstallationId; name; version; packageDigest; manifestSnapshot: ProcessModuleManifest; storeLocation; resourceIndex: readonly ResourceIndexEntry[]; handlerRefs: readonly HandlerRef[]; dependencyLock: unknown; status; installedAt; activatedAt?; retiredAt? }`. Pure readonly.
- `MODULE_INSTALLATION_VERSION_COLLISION`, `MODULE_INSTALLATION_NOT_FOUND`, `MODULE_INSTALLATION_CORRUPT` error code constants.

### `installation/persistence/installation-repository.ts`
- PORT `ModuleInstallationRepository { insert(record): ModuleInstallationRecord; getById(id); getByPackageDigest(digest); getActiveByNameVersion(name, version); activate(id); retire(id); markCorrupt(id); listActive() }`.
- `SqliteModuleInstallationRepository implements ModuleInstallationRepository` — creates the table via `ensureSaga3ModuleInstallationSchema(db)` (spec §3 SQL verbatim: the `WHERE status='active'` UNIQUE index enforces version immutability; NO `ON DELETE SET NULL`).
- Serialize `manifestSnapshot`/`resourceIndex`/`handlerRefs`/`dependencyLock` via `canonicalJson` (Wave 1 primitive) — store as TEXT.
- `insert` REJECTS a second `status='active'` row for the same `(name, version)` with a different `packageDigest` → throw `MODULE_INSTALLATION_VERSION_COLLISION` (catch the SQLite UNIQUE violation and translate).
- NO delete method (deletion-restricted, plan §5.5.9). Only `retire` (status transition).

### `src/db.ts` edit (the ONLY one this wave)
- Add `import { ensureSaga3ModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';`
- In `getDb()` AFTER the existing migrations: call `ensureSaga3ModuleInstallationSchema(db);`
- Add 2 idempotent `try { db.exec('ALTER TABLE saga3_process_runs ADD COLUMN installation_id INTEGER'); } catch {}` + same for `package_digest TEXT` (match the existing `try/catch ALTER` pattern at db.ts:27-45).
- DO NOT touch any other migration function.

## Tests (`tests/installation/installation-repository.test.mjs`)
- Use `process.env.DB_PATH = mkdtempSync(...)` + `getDb()` (existing pattern).
- Positive: insert a staged record → getById returns it; activate → status='active'; getByPackageDigest; listActive.
- Negative: insert second active record with DIFFERENT digest under same (name,version) → `MODULE_INSTALLATION_VERSION_COLLISION`. Insert same digest → idempotent OK (or whatever you decide — document it).
- Negative: getById on unknown → `MODULE_INSTALLATION_NOT_FOUND`.
- Verify the UNIQUE index works at the SQL level (attempt direct INSERT bypassing the repo → caught).
- Verify NO delete path exists (the repo has no delete method).

## Anti-scope
- Do NOT touch `composition/product-lifecycle-runtime.ts` (integrator wires at checkpoint).
- Do NOT touch existing `sqlite-process-run-repository.ts` (W2-A4 reads the new columns via raw SQL, doesn't edit it).
- Do NOT create `saga3_lifecycle_runs`/`saga3_stage_runs` ALTERs (Wave 7).
- Do NOT edit `domain/spi/*` (Wave 1 frozen).

## Verify
```
cd .worktrees/w2-a2 && npm run build && node --test tests/installation/installation-repository.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
Build PASS · tests PASS · ratchet GREEN. Note: `installation/domain/installation.ts` imports `ProcessModuleManifest` from `domain/spi/index.js` — Rule 5 clean (domain→domain). The sqlite adapter is in `installation/persistence/` — allowed to import `db.ts`/`better-sqlite3`. `db.ts` importing back into `installation/persistence/` is a NEW edge but it's `src/db.ts → installation/persistence/` (not a ratchet-rule violation — Rule 5 is `domain/` purity; Rule 2 is `modules/`; this is neither).

## Commit
`feat(installation): W2-A2 ModuleInstallationRepository + saga3_module_installations table + process_runs ALTERs (SQL owner)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet. 4. Exported symbols + the exact `ensureSaga3ModuleInstallationSchema` signature (other lanes + `db.ts` depend on it). 5. The error-code constants. 6. Confirmation. Escalate any Rule-5/Rule-2 concern immediately.
