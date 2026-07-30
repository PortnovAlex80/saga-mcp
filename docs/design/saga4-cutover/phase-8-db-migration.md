# Phase 8 — Database Migration: retire `episode_workflows`

> Phase 8 of the saga2 → saga4 hard legacy-engine cutover.
> Scope: **read-only investigation output.** This file proposes SQL/TS changes
> for later phases to apply; it does not itself modify any source.

Goal: stop writes to `episode_workflows`, migrate the display data that is not
already derivable into lifecycle projections, then `DROP TABLE episode_workflows`
**only after** phases 2–7 have proven at runtime that no code path reads or
writes it. User artifacts (`.md` files, `artifacts`, `tasks`, execution logs in
`worker_executions`/`command_receipts`/`lifecycle_events`) are preserved
untouched.

---

## 1. Inventory of the legacy table

### 1.1 DDL — `src/schema.ts:77-88` (fresh-DB creation)

```sql
CREATE TABLE IF NOT EXISTS episode_workflows (
  epic_id              INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL DEFAULT 'discovery'
                         CHECK (stage IN ('discovery','formalization','planning','development','verification','integration','completed','cancelled')),
  track                TEXT NOT NULL DEFAULT 'formal'
                         CHECK (track IN ('formal','fast-track')),
  baseline_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  baseline_hash        TEXT,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Indexes:**
- `idx_episode_workflows_stage` — `src/schema.ts:401` (`CREATE INDEX IF NOT EXISTS … ON episode_workflows(stage)`).
- `idx_episode_workflows_track` — added by the `migrateEpisodeTrack` migration at `src/db.ts:811` (not present in `schema.ts` because the `track` column itself is migration-added for older DBs; on a fresh DB the column is in `schema.ts` but the index is still created by the migration call, which is idempotent).

### 1.2 All `ALTER TABLE episode_workflows`

There is exactly **one** schema evolution of this table:

- `src/db.ts:798-812` `migrateEpisodeTrack(db)` — `ALTER TABLE episode_workflows ADD COLUMN track TEXT NOT NULL DEFAULT 'formal' CHECK (track IN ('formal','fast-track'))`, then a backfill `UPDATE … SET track='fast-track' WHERE json_extract(metadata,'$.fast_track')=1`, then `CREATE INDEX idx_episode_workflows_track`.

There is no other `ALTER TABLE episode_workflows` and no `DROP TABLE episode_workflows` anywhere in the tree (verified: only `tasks`, `artifacts`, `artifact_traces`, `verification_evidence`, and a `saga3_work_intents` rebuild use the detect/copy/drop idiom).

### 1.3 Related legacy tables to also drop

**None.** `episode_workflows` is the *only* `episode_*` or legacy-execution table:

```
$ grep -n "CREATE TABLE" src/schema.ts | grep -i "episode\|workflow\|stage"
77:CREATE TABLE IF NOT EXISTS episode_workflows (
```

The other saga2-execution surfaces are columns on surviving tables (`tasks.workflow_stage`, `tasks.task_kind`, `tasks.current_execution_id`, `worker_executions`) or dedicated tables that the saga4 runtime still owns (`task_work_items`, `work_attempts`, `human_requests`, `command_receipts`, `lifecycle_events`). Those are **out of scope** for phase 8; only `episode_workflows` is dropped.

---

## 2. Migration framework — how migrations are applied

There is **no version/sequence-number migration framework** (no `PRAGMA user_version`, no migration files). The mechanism in `src/db.ts:getDb()` is **detection-based and idempotent**, applied on every connection open:

1. `db.exec(SCHEMA_SQL)` — runs every `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` in `src/schema.ts`. This is the **fresh-DB creation path** and a no-op for existing DBs.
2. A block of bare `try { db.exec('ALTER TABLE … ADD COLUMN …') } catch { /* exists */ }` for additive columns (`src/db.ts:31-49`).
3. Named `migrateXxx(db)` functions. Two idioms:
   - **Additive column** (e.g. `migrateEpisodeTrack`, `migrateRiskClass`): `try { ALTER TABLE … ADD COLUMN } catch {}` + idempotent backfill + `CREATE INDEX IF NOT EXISTS`.
   - **CHECK-constraint change** (e.g. `migrateReviewInProgress`, `migrateArtifactTypes`, `migrateVerificationOutcome`, `migrateTracesLinkType`): inspect `SELECT sql FROM sqlite_schema WHERE type='table' AND name='X'`; if the old CHECK string is present, rebuild via the **detect → copy all columns into a temp/direct insert → `DROP TABLE` → `CREATE TABLE` with new CHECK → re-copy → recreate indexes** idiom (see `src/db.ts:225-319` for the canonical pattern).

**Implication for phase 8:** the DROP of `episode_workflows` must be a *new*
`migrateXxx(db)` function added to the `getDb()` sequence in `src/db.ts`, **not**
a change to `SCHEMA_SQL`. It runs only on existing DBs and must be guarded so it
never fires on a fresh DB (see §5).

---

## 3. `reset-saga-db.mjs` — current reset behaviour

`reset-saga-db.mjs` wipes **run data** but **preserves schema**. It is a DELETE-based
reset, not a DROP:

- `episode_workflows` is in the `runDataTables` wipe list (`reset-saga-db.mjs:26`).
- It also drops immutability `ABORT` triggers before deleting saga3 run tables and
  recreates them afterwards, so the next `getDb()` re-installs them.
- It clears `sqlite_sequence` for `projects,epics,repositories,tasks,artifacts`.

**Phase 8 change to `reset-saga-db.mjs`:** simply **remove** `'episode_workflows'`
from the `runDataTables` array. Because the table no longer exists after phase 8,
the current `try/catch` (`if (!String(e.message).includes('no such table'))`)
would already silently skip it, but removing the entry keeps the reset list honest
and avoids a misleading log line. No other reset change is needed.

---

## 4. SQL touch inventory — classification

Every `episode_workflows` reference in `src/`, classified. This is the contract
phases 2–7 retire.

### 4.1 WRITE (must stop — removed in phases 2–5)

| Location | Statement | Purpose |
|---|---|---|
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:22` | `INSERT OR IGNORE INTO episode_workflows (epic_id)` | `ensureWorkflow` — saga2 pump boot |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:42` | `UPDATE … metadata=json_set($.needs-human,$.pause_reason,$.paused_at)` | `pause(epicId)` |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:64` | `UPDATE … metadata=json_remove($.needs-human,$.pause_reason,$.paused_at)` | `clearNeedsHuman` |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:145` | `UPDATE … metadata=json_set(...)` dynamic | `patchMetadata` |
| `src/tools/lifecycle.ts:52` | `INSERT OR IGNORE INTO episode_workflows (epic_id)` | `getOrCreate` |
| `src/tools/lifecycle.ts:332` | `UPDATE … SET stage=?, baseline_artifact_id=?, baseline_hash=?` | `episode_transition` (the stage write) |
| `src/tools/lifecycle.ts:362` | `UPDATE … metadata=json_remove($.last_gate_error,$.last_gate_from,$.last_gate_to)` | `advanceReadyEpisodes` clear |
| `src/tools/lifecycle.ts:371` | `UPDATE … metadata=json_set($.last_gate_error,$.last_gate_from,$.last_gate_to,$.last_gate_checked_at)` | `advanceReadyEpisodes` gate-failure stamp |
| `src/tools/workflow.ts:164` | `UPDATE … SET track='fast-track' WHERE epic_id=? AND track='formal'` | fast-track routing |
| `src/planner/fast-track.ts:206` | `INSERT … VALUES (?,'development',json_object('fast_track',1,'brief_artifact_id',?)) ON CONFLICT DO UPDATE SET stage='development', metadata=json_set($.fast_track,1,$.brief_artifact_id,…)` | XS path: jump straight to development |
| `src/tools/export-import.ts:408` | `INSERT INTO episode_workflows (epic_id,stage,baseline_hash,metadata)` | tracker import |
| `src/tools/export-import.ts:500` | `UPDATE … SET baseline_artifact_id=?` | import baseline stamp |
| `src/infrastructure/engine/legacy-engine-administration.ts:236` | `UPDATE … SET metadata=?, updated_at=datetime('now')` | engine running/pid/concurrency persistence |

### 4.2 READ-for-legacy-execution (delete with the saga2 engine — phases 2–5)

| Location | Statement | Purpose |
|---|---|---|
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:27` | `SELECT stage` | `currentStage` — the pump's stage source |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:74` | `SELECT json_extract(metadata,$.lastHealError),$.lastHealAttempt` | `readHealMetadata` |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:100` | `SELECT json_extract(metadata,$.engine_concurrency),$.active_model_limit` | `readTargetConcurrency` |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:112` | `SELECT json_extract(metadata,$.active_model),$.active_provider,$.active_model_effort` | `readWorkerModelRoute` |
| `src/tools/dispatcher.ts:221` | `SELECT json_extract(metadata,$.active_model),$.active_provider,$.active_model_effort` | `readModelRouteAtClaim` |
| `src/tools/dispatcher.ts:406,408` | `NOT EXISTS / EXISTS (SELECT 1 FROM episode_workflows ew WHERE ew.epic_id=t.epic_id [AND ew.stage=t.workflow_stage])` | stage-gate veto in claim query |
| `src/infrastructure/engine/legacy-engine-administration.ts:212` | `SELECT json_extract(metadata,$.engine_running),$.engine_pid,$.engine_concurrency,$.engine_started_at` | persisted engine state |
| `src/infrastructure/engine/legacy-engine-administration.ts:231` | `SELECT metadata` | `setMeta` read-before-write |
| `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:128` | `SELECT json_extract(metadata,$.active_model),$.active_provider,$.active_model_effort` | `readLegacyModelRoute` |
| `src/tools/tasks.ts:450` | `SELECT 1 FROM episode_workflows WHERE epic_id=?` | `episodeInitialized` provenance gate |
| `src/tools/projects.ts:267` | `SELECT ew.epic_id … WHERE json_extract(ew.metadata,$.engine_running)=1` | project-delete running-engine guard |
| `src/orchestrate.ts:798` | (comment only — no SQL) | documentation of model-limit re-read |

### 4.3 READ-for-display (migrate to a lifecycle projection — phase 6)

| Location | Statement | Purpose |
|---|---|---|
| `src/infrastructure/projections/sqlite-board-projection-reader.ts:63-73` | `LEFT JOIN episode_workflows ew ON ew.epic_id=e.id` → `ew.stage AS episode_stage`, `json_extract(ew.metadata,$.last_gate_error) AS gate_error`, `$.needs-human AS needs_human`, `$.pause_reason AS pause_reason` | **The single board/UI display consumer.** Feeds `BoardEpicProjection`. |
| `src/tools/export-import.ts:122` | `SELECT * FROM episode_workflows WHERE epic_id=?` | tracker export (round-trips stage/metadata) |

This is the crux: phases 2–5 kill the engine writes/reads; **phase 6 must
re-point this one board projection query** at a lifecycle-derived view before
the table can be dropped.

---

## 5. The migration plan

Four ordered steps. Steps 1–2 land before the drop; step 3 lands only after
phases 2–7 prove zero runtime touch; step 4 keeps fresh DBs clean.

### Step 1 — Stop writes (DB-side guard is informational; code is the real fence)

The write stoppage is **enforced by the code changes in phases 2–5** (deleting the
call sites in §4.1). SQLite has no row-level "read-only table" guard, so there is
no DB-side fence to add. The only DB-side action in this step is to make the
board projection (§4.3) and the engine reads (§4.2) stop touching the table —
which is exactly what phases 2–6 do.

**Acceptance for step 1:** a grep for `episode_workflows` in `src/` returns only
(a) the projection re-point (step 2) and (b) the DROP migration (step 3). No
`INSERT`/`UPDATE`/`DELETE` against the table remain.

### Step 2 — Data migration: copy display data into lifecycle projections

The goal is that the board projection in §4.3 can be served **without**
`episode_workflows`. Two projection homes already exist:

1. **`saga3_lifecycle_runs.current_stage_id`** (`src/process-modules/persistence/sqlite-lifecycle-run-repository.ts:46`) — the authoritative stage for any episode that has a lifecycle run. `saga3_stage_runs` + `saga3_process_transitions` carry the full transition audit trail.
2. **`saga3_process_runs.projected_stage`** (`src/process-modules/persistence/sqlite-process-run-repository.ts:68`, comment: *"legacy episode_workflows.stage projection"*) — a one-way capture of where a process run would have projected. **Verified:** nothing writes `projected_stage` back into `episode_workflows`; the projection is capture-only.

#### 2a. What is already derivable (no copy needed)

- **`stage`** for episodes on the lifecycle engine: derived from
  `saga3_lifecycle_runs.current_stage_id` (join on `epic_id`). No copy required.
- **`track`** (`formal` / `fast-track`): derivable from the brief artifact —
  `readLatestBriefDecision` (`sqlite-saga2-runtime-repositories.ts:79-94`) already
  reads `artifacts.metadata.brief_payload.decision === 'fast-track'`. The brief
  artifact survives (it is a user artifact, never dropped). No copy required.
- **`baseline_artifact_id` / `baseline_hash`**: derivable from the accepted AC
  artifact set (`acceptedBaseline` in `src/tools/lifecycle.ts:60-83` computes the
  digest from `artifacts.accepted_hash`). No copy required.

#### 2b. What is NOT derivable and must be migrated

The only columns that carry **user-visible runtime state not present elsewhere** are
the `metadata` JSON keys the board shows. These must be migrated to a projection
table (recommended: a small `episode_display_state` projection, or — preferred —
folded into the lifecycle-run row). The keys:

| metadata key | Board column | Notes |
|---|---|---|
| `$.needs-human` | `needs_human` | Pause flag. Lives nowhere else. |
| `$.pause_reason` | `pause_reason` | Free text. Lives nowhere else. |
| `$.last_gate_error` | `gate_error` | Last `episode_transition` failure message. |

**Recommended migration target:** add nullable columns to
`saga3_lifecycle_runs` (`needs_human INTEGER`, `pause_reason TEXT`,
`last_gate_error TEXT`) via an additive `ensureSaga3LifecycleRunSchema` migration,
and migrate with one idempotent `UPDATE`:

```sql
-- One-shot, idempotent. Runs only on existing DBs that still have
-- episode_workflows (guarded by table-existence check in the migration fn).
UPDATE saga3_lifecycle_runs
   SET needs_human   = COALESCE(needs_human,   (SELECT json_extract(ew.metadata,'$.needs-human')     FROM episode_workflows ew WHERE ew.epic_id = saga3_lifecycle_runs.epic_id)),
       pause_reason  = COALESCE(pause_reason,  (SELECT json_extract(ew.metadata,'$.pause_reason')    FROM episode_workflows ew WHERE ew.epic_id = saga3_lifecycle_runs.epic_id)),
       last_gate_error = COALESCE(last_gate_error, (SELECT json_extract(ew.metadata,'$.last_gate_error') FROM episode_workflows ew WHERE ew.epic_id = saga3_lifecycle_runs.epic_id))
 WHERE EXISTS (SELECT 1 FROM episode_workflows ew WHERE ew.epic_id = saga3_lifecycle_runs.epic_id);
```

For episodes **without** a lifecycle run (legacy saga2 episodes never migrated to
the lifecycle engine), the stage is not derivable. Two options, decided in
phase 6 (this is the one genuine product decision; see §7):

- **(A) Backfill a lifecycle run** for every episode that lacks one, seeded from
  `episode_workflows.stage`. Heaviest, but leaves a single stage source of truth.
- **(B) Tolerate NULL stage** on the board for legacy-only episodes (the episode
  is historical; its tasks/artifacts still render). Lightest.

Phase 6 picks one; the DROP in step 3 is gated on that decision being shipped.

#### 2c. Re-point the board projection query

`sqlite-board-projection-reader.ts:60-76` `LEFT JOIN episode_workflows` becomes a
`LEFT JOIN saga3_lifecycle_runs lr ON lr.epic_id = e.id` (plus the new columns).
This is the single display-side edit and must ship in phase 6, before step 3.

### Step 3 — `DROP TABLE episode_workflows` (existing DBs only)

**Gate:** ship ONLY after phases 2–7 have removed/redirected every entry in §4.1,
§4.2, and §4.3, and a full test run + grep proves zero remaining
`episode_workflows` SQL in `src/` outside the migration itself.

Add a new migration function to the `getDb()` sequence in `src/db.ts` (alongside
`migrateEpisodeTrack`, etc.), using the **detect → preserve → drop** idiom. It must
be **guarded against fresh DBs** (where the table was never created, see step 4):

```ts
// src/db.ts — added after migrateEpisodeTrack in the getDb() sequence.
/**
 * Phase 8 cutover: drop the legacy episode_workflows table.
 * GUARDED: only runs when the table still exists AND still has data we have
 * not yet migrated. By the time this ships, phases 2-7 have removed every
 * code path that reads or writes the table (see
 * docs/design/saga4-cutover/phase-8-db-migration.md §4). The display data
 * was copied into saga3_lifecycle_runs in step 2.
 *
 * Fresh DBs never create episode_workflows (step 4 removes it from SCHEMA_SQL),
 * so this is a no-op there: sqlite_schema lookup returns nothing.
 */
export function dropLegacyEpisodeWorkflows(db: Database.Database): void {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='episode_workflows'",
  ).get() as { name?: string } | undefined;
  if (!row?.name) return; // fresh DB or already dropped — nothing to do.

  // Defence-in-depth: refuse to drop if any row still carries unmigrated
  // display state that has no lifecycle-run home. Once phase 6's step 2b
  // decision ships, this guard becomes vacuously true and the drop proceeds.
  const unmigrated = db.prepare(
    `SELECT ew.epic_id
       FROM episode_workflows ew
       LEFT JOIN saga3_lifecycle_runs lr ON lr.epic_id = ew.epic_id
      WHERE lr.id IS NULL
        AND (json_extract(ew.metadata,'$.needs-human') = 1
             OR json_extract(ew.metadata,'$.pause_reason') IS NOT NULL)
      LIMIT 1`,
  ).get() as { epic_id?: number } | undefined;
  if (unmigrated?.epic_id) {
    // Do NOT drop: a legacy episode still has user-visible pause state with no
    // lifecycle-run home. Phase 6 step 2b must resolve epic {epic_id} first.
    return;
  }

  // Drop indexes first (they vanish with the table, but be explicit for clarity).
  db.exec('DROP INDEX IF EXISTS idx_episode_workflows_track');
  db.exec('DROP INDEX IF EXISTS idx_episode_workflows_stage');
  db.exec('DROP TABLE IF EXISTS episode_workflows');
}
```

Notes:
- The table has `ON DELETE CASCADE` to `epics`, so dropping it does NOT cascade
  to anything else — it is a leaf. `artifacts` and `epics` are untouched.
- `idx_episode_workflows_track` was created by the migration, not `schema.ts`;
  dropping it explicitly keeps `sqlite_master` clean if a future schema refresh
  runs first.
- `DROP TABLE IF EXISTS` is idempotent; re-running `getDb()` is a no-op.

### Step 4 — Remove legacy creation from fresh-DB `schema.ts`

**Critical distinction (fresh vs existing):**

- **Fresh DB** (`SCHEMA_SQL` path): remove the `CREATE TABLE IF NOT EXISTS episode_workflows (…)` block at `src/schema.ts:77-88` and the `CREATE INDEX idx_episode_workflows_stage` at `src/schema.ts:401`. New DBs never create the table.
- **Existing DB**: the `dropLegacyEpisodeWorkflows` migration (step 3) drops it. Because `schema.ts` no longer contains the `CREATE TABLE`, a subsequent `db.exec(SCHEMA_SQL)` will **not** recreate it — the drop sticks.

Because `dropLegacyEpisodeWorkflows` checks `sqlite_master` first, removing the
`CREATE TABLE` from `schema.ts` is safe in both orders:
- Fresh DB after step 4: table never created → migration no-ops.
- Existing DB after step 4: table exists → migration drops it → `SCHEMA_SQL` no longer recreates it.

Also remove, in the same edit:
- The `migrateEpisodeTrack` call and its `idx_episode_workflows_track` creation in `src/db.ts:56, 811` — once the table is gone the column/index are meaningless. Keep the function body only if a test still references it; otherwise delete.
- `'episode_workflows'` from `reset-saga-db.mjs:26` (see §3).

---

## 6. Test impact (informational — phases 2–7 own these)

`episode_workflows` is referenced in tests:
- `tests/architecture/saga2-boundaries.test.mjs:283,334,415` — inline `CREATE TABLE episode_workflows` fixtures for dispatcher/admin tests. These fixtures must be replaced with the new projection fixture once the code under test is re-pointed.
- `tests/characterization/saga2-runtime-contracts.test.mjs:113` — lists `episode_workflows` as a saga2-owned table; this characterization assertion is the one that flips to "dropped" in phase 7.
- `tests/lifecycle/*` (engine-control, model-selector, concurrency-transition, formalization-mechanics, project-delete) — assert on stage transitions/engine metadata. These move to lifecycle-run assertions.
- `tests/execution/migration-conformance.test.mjs` — add a case asserting `dropLegacyEpisodeWorkflows` is idempotent and no-ops on a fresh DB.

---

## 7. Open decisions (for phase 6, not phase 8)

1. **Legacy episodes without a lifecycle run** (§2b option A vs B): backfill a lifecycle run from `stage`, or tolerate NULL stage on the board for historical episodes. Recommended: **(B) tolerate NULL** — legacy episodes are historical; their tasks/artifacts still render; backfilling lifecycle runs retroactively risks inventing transition audit trails that never happened.
2. **Export/import** (`export-import.ts:122,408,500`): tracker export currently round-trips `stage`/`metadata`. After the drop, export must either (a) export the derived lifecycle-run stage instead, or (b) drop the `workflow` field from the export shape. Recommended: **(a)** derive from `saga3_lifecycle_runs` so imports remain lossless.

---

## 8. Rollout order (dependency graph)

```
phase 2-5 : delete WRITE call sites (§4.1) and engine READ call sites (§4.2)
phase 6   : step 2a/2b — migrate display data, re-point board projection (§4.3)
phase 7   : prove zero runtime touch (grep + full test suite green)
phase 8   : step 3 — dropLegacyEpisodeWorkflows migration (existing DBs)
            step 4 — remove CREATE TABLE from schema.ts + reset list (fresh DBs)
```

Phase 8 is the **last** step. It must not ship before phase 7's proof, or a
running engine will hit `no such table: episode_workflows`.
