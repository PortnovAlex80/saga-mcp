# W2-A4 — ProcessRun installation pinning + legacy nullable adapter

**Wave:** 2 · **Lane:** A4 · **Spec:** §1 rows 7,8 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a4` · **Worktree:** `.worktrees/w2-a4`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 rows 7,8, §3 the ALTERs, §4 pinning rules, §5 anti-scope "No edits to existing sqlite-process-run-repository.ts").
2. `src/process-modules/persistence/process-run.ts` (`ProcessRunRecord`, `StartProcessModuleCommand` — note NO `installationId`/`packageDigest` today).
3. `src/process-modules/persistence/sqlite-process-run-repository.ts` (the existing `saga3_process_runs` table — DO NOT EDIT; you read the new columns via raw SQL).
4. W2-A2 task: the ALTERs add `installation_id INTEGER` + `package_digest TEXT` (nullable).

## Own (only you)
- `src/process-modules/installation/domain/process-run-pinning.ts`
- `src/process-modules/installation/persistence/process-run-installation-adapter.ts`
- `tests/installation/process-run-pinning.test.mjs`

## What to build (spec §1 rows 7,8, plan §14.3.7)
### `process-run-pinning.ts` (pure)
- `PinnedInstallation { processRunId: number; installationId: ModuleInstallationId; packageDigest: string; pinnedAt: string }`. Pure.
- `pinInstallationOnProcessRun(processRunId, installationId, packageDigest): PinnedInstallation` — value builder (no side effects; the adapter persists).

### `process-run-installation-adapter.ts` (the legacy nullable adapter)
- `ProcessRunInstallationAdapter` — constructor `(db: Database)` (better-sqlite3). Uses RAW SQL via `db.prepare(...)` — DOES NOT import or edit `SqliteProcessRunRepository`.
- `setPinnedInstallation(processRunId, installationId, packageDigest): void` — `UPDATE saga3_process_runs SET installation_id=?, package_digest=? WHERE id=?`.
- `getPinnedInstallation(processRunId): PinnedInstallation | null` — `SELECT installation_id, package_digest FROM saga3_process_runs WHERE id=?`. Returns null if both columns are NULL (legacy run, plan §14.3.7).
- `resolveInstallationForLegacyRun(processRunId, fallbackRegistry): ModuleInstallationRecord | null` — the LEGACY NULLABLE ADAPTER: if `installation_id` is NULL, resolve via the injected `PackageRegistry`/fallback by the run's `module_name`+`module_version` (read those columns too). This is the explicit compatibility path (plan §14.3.7) — Wave 13 removes it.
- **Verify pinned digest on read**: when `getPinnedInstallation` returns non-null, the caller (Wave 3 executor) will verify `package_digest` against the installation record's digest. Wave 2 only provides the read; the verification is Wave 3.

## Tests (`tests/installation/process-run-pinning.test.mjs`)
- Use mkdtemp DB. Insert a `saga3_process_runs` row (via the existing repo OR raw SQL — match existing test patterns). 
- Positive: `setPinnedInstallation` → `getPinnedInstallation` returns the pin.
- Positive (legacy): insert a run with NULL installation_id → `getPinnedInstallation` returns null → `resolveInstallationForLegacyRun` with a fake fallback registry returns the record by name+version.
- Positive: re-pin (update) an already-pinned run → new values stored.
- Negative: `setPinnedInstallation` on nonexistent run → no-op or error (document your choice).
- The pin survives across DB reopen (persistence).

## CRITICAL: do NOT edit `sqlite-process-run-repository.ts`
W2-A2 added the columns via `db.ts` ALTERs. You read/write them via raw SQL in your adapter. This avoids hot-file conflicts (plan §0.2.4) and keeps W2-A2 as the single schema writer.

## Anti-scope
- Do NOT add NOT NULL constraint (Wave 11).
- Do NOT verify digest against installation bytes here (Wave 3).
- Do NOT touch composition root.

## Verify
```
cd .worktrees/w2-a4 && npm run build && node --test tests/installation/process-run-pinning.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN. Depends on W2-A2's ALTERs being present (they are, in `db.ts` at integration time; locally the columns may not exist yet — if your test fails locally on "no such column", that's expected until W2-A2 cherry-picks; use a fake or note in return).

## Commit
`feat(installation): W2-A4 ProcessRun installation pinning + legacy nullable adapter (§14.3.7)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result (pass or pending-W2-A2-ALTERs). 4. Exported symbols. 5. Confirmation.
