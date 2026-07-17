# Design: saga-worker worktree isolation + parallel-work visibility

**Status:** proposed · **Date:** 2026-06-28
**Scope:** minimal changes to `saga-mcp` (dispatcher) + `saga-worker` skill + docs sync
**Decisions (user-approved):**
- Area: skill **+ minimal saga-mcp changes** (real task↔branch↔worktree linkage).
- Merge strategy: **Variant A — merge at `review→done` into `dev`**, plus three hardening fixes.
- Merge-lock: **DB-based** (`worker_merge_acquire` / `worker_merge_release`, serialized via `BEGIN IMMEDIATE`).
- On post-approval merge conflict: **flag `needs-human`, task stays `done`** (worker cycle is not held hostage to the merge).

---

## 1. Problem

Today, multiple saga workers run in **one shared working directory**:

1. **File races.** Three agents edit the same repo checkout concurrently — builds break mid-edit, edits clobber each other, test runs see a half-written tree.
2. **No parallel-work visibility.** `worker_next` / `worker_done` only surface `status IN ('todo','review') AND assigned_to IS NULL` (`dispatcher.ts:89,121-132`). Tasks in `in_progress` are invisible to siblings — an agent cannot know what its neighbors are doing, so it may start on the same files/area.
3. **No merge-back lifecycle.** A task reaching saga `done` says nothing about whether its code is integrated. Work done in a branch can be lost (branch deleted, dir reset) even though saga claims it is finished.

This design adds **git worktree isolation per task** and **parallel-work visibility**, without disturbing saga's two-phase status machine or its race-protection logic.

## 2. Architecture

### 2.1 Lifecycle (Variant A + 3 fixes)

```
[git bootstrap — once]  git init → branch dev → .gitignore .worktrees/ → initial commit
   │
   ▼
CLAIM (worker_next: todo → in_progress)
   saga:   task.metadata.worktree = { branch, path, merge_target:"dev", created_at }
   agent:  git worktree add .worktrees/task-<id> -b task/<id> dev
           cd .worktrees/task-<id> ; install deps ; baseline tests
   ── parallel work: N agents, N worktrees, 0 file races ──
   │
   ▼
DEV-DONE (worker_done: in_progress → review)
   agent:  git add -A && git commit -m "task #<id>: ..."     ← NO merge
   saga:   status → review, assigned_to = NULL
           + active_tasks[] in the response (sibling visibility)
   │
   ▼
REVIEW (worker_next returns the task with skill = "saga-reviewer")
   reviewer:  git diff dev...task/<id>      ← clean per-task diff
              verify against criteria + run tests in the worktree
   │
   ├─ APPROVED ─────────────────────────────────────────────┐
   │   worker_done({ verdict: "approved" })  →  done        │
   │   agent: worker_merge_acquire (loop) →                  │
   │          git checkout dev && git merge --no-ff task/<id>│
   │          → git worktree remove .worktrees/task-<id>      │
   │          → worker_merge_release({ merged, commit_sha }) │
   │                                                          ▼
   │                                              [DONE + INTEGRATED]
   │
   └─ CHANGES REQUESTED ─────────────────────────────────────┐
       worker_done({ verdict: "changes_requested" })          │
       saga: status → in_progress, branch/worktree UNTOUCHED  │
       agent: cd .worktrees/task-<id>, fix, commit →          ▼
              dev-done again                             [RE-WORK LOOP]

[CONFLICT PATH]  if merge --no-ff fails after APPROVED:
   worker_merge_release({ conflict: true })  →  task flagged needs-human
   task stays done; worktree + branch kept; merged_into = "conflict"
```

### 2.2 Why this fits saga

| Property | Today | With this design |
|---|---|---|
| File isolation | none (shared dir) | per-task worktree |
| `in_progress` visibility | none | `active_tasks[]` in dispatcher responses |
| Merge point | n/a | `review → done` (aligns with the existing transition) |
| Unreviewed code in integration | n/a | never (merge only after APPROVED) |
| CHANGES REQUESTED | impossible via dispatcher (`dispatcher.ts:245-253` has no `review→in_progress`) | supported via `verdict` param |
| Work-loss safety | none | commits live on `task/<id>` ref; survive crashes |
| `depends_on` | unblocks on `done` | `done` = merged into `dev`, so dependents branch from `dev` that already contains the dep — *correct* |

## 3. saga-mcp changes (minimal)

All changes are additive; the 31 base tools and the dispatcher's lock logic are untouched.

### 3.1 `metadata.worktree` contract (no schema migration)

`saga` already has `tasks.metadata` (TEXT JSON, `schema.ts:49`, `types.ts:40`). We standardise a sub-object:

```jsonc
// task.metadata
{
  "worktree": {                         // absent when task has no worktree yet
    "branch":         "task/42",
    "path":           ".worktrees/task-42",
    "merge_target":   "dev",
    "created_at":     "2026-06-28T12:00:00Z",
    "merged_into":    null,             // null | "pending" | "dev" | "conflict"
    "merged_commit":  null,             // sha once merged
    "merge_conflict": false             // true when last merge attempt conflicted
  }
}
```

**Why metadata, not a new column:** `epics.branch` needed an `ALTER` migration + SQL rewrites (`db.ts:27`). `metadata` is read/written everywhere already. Indexing/GC-by-branch is a future concern — for MVP, `worker_health` scans `json_extract(metadata,'$.worktree.*')`.

### 3.2 `active_tasks[]` — parallel-work visibility (read-only)

In `handleWorkerNext` (`dispatcher.ts:195-200`) and `handleWorkerDone` (`dispatcher.ts:309-314`), after the claim, run an additional **read-only** SELECT (outside the lock is fine — visibility is best-effort):

```sql
SELECT t.id, t.title, t.assigned_to, t.status, t.metadata, e.name AS epic_name
FROM tasks t JOIN epics e ON e.id = t.epic_id
WHERE e.project_id = ?
  AND t.status IN ('in_progress','review')
  AND t.assigned_to IS NOT NULL
```

For each row, parse `metadata.worktree.branch` and return:

```jsonc
"active_tasks": [
  { "task_id": 43, "title": "...", "assigned_to": "agent-2",
    "status": "in_progress", "branch": "task/43", "epic_name": "mesh" }
]
```

~15 lines; does not touch the lock or the status machine.

### 3.3 `verdict` param + `review → in_progress` transition (REQUIRED fix)

`worker_done` today only moves `review → done` (`dispatcher.ts:245-253`). CHANGES REQUESTED is impossible through the dispatcher. Add an optional param:

```ts
// worker_done inputSchema (dispatcher.ts:461-476), new optional field:
verdict: { type: 'string', enum: ['approved','changes_requested'], default: 'approved',
           description: "For tasks in review: 'approved' advances to done (and the worktree is ready to merge); 'changes_requested' returns the task to in_progress, leaving the branch/worktree in place for re-work." }
```

In `handleWorkerDone`, branch on `task.status === 'review'`:

```ts
if (task.status === 'review') {
  if (verdict === 'changes_requested') {
    newStatus = 'in_progress';            // back to work
    keepAssignment = workerId;            // lock returns to this worker
    // branch/worktree untouched — survives the re-work loop
  } else {                                 // 'approved' (default — backward compatible)
    newStatus = 'done';
    keepAssignment = null;                 // freed
  }
}
```

The conditional UPDATE (`dispatcher.ts:258-263`) gains a branch: when `verdict === 'changes_requested'`, set `assigned_to = workerId` instead of NULL.

On the `approved` path, `worker_done` also sets `task.metadata.worktree.merged_into = "pending"` (means "APPROVED, awaiting integration") the moment the task flips to `done`. `worker_merge_release` then resolves `"pending"` to either `"dev"` (merged) or `"conflict"` (stuck). This three-valued state is what lets `worker_health` distinguish "done but never integrated" from "integrated" from "stuck".

### 3.4 `worker_merge_acquire` / `worker_merge_release` — DB merge-lock

Because multiple saga-mcp processes serve the workers, the **only shared coordination surface is the SQLite DB** (already serialized via `BEGIN IMMEDIATE`, `dispatcher.ts:33-49`). We store the merge-lock in project metadata:

```jsonc
// project.metadata.merge_lock = null | { task_id, worker_id, acquired_at }
```

**`worker_merge_acquire({ task_id, worker_id }) → { granted: boolean, held_by?: {task_id,worker_id,age_min}, retry_after_ms?: number }`**

Under `BEGIN IMMEDIATE`:
1. Read `project.metadata.merge_lock`.
2. If `null` OR `acquired_at < now - 10 min` (stale-safe — clears zombie locks): set it to `{task_id, worker_id, acquired_at: now}`, return `granted: true`.
3. Else: return `granted: false, held_by: {...}, retry_after_ms: 3000`.

**`worker_merge_release({ task_id, worker_id, result: 'merged'|'conflict', commit_sha? })`**

Under `BEGIN IMMEDIATE`:
1. Verify `merge_lock.task_id === task_id && merge_lock.worker_id === worker_id` (only the holder may release).
2. Clear `merge_lock = null`.
3. Update `task.metadata.worktree`:
   - `result === 'merged'` → `merged_into: "dev"`, `merged_commit: <sha>`.
   - `result === 'conflict'` → `merged_into: "conflict"`, `merge_conflict: true`, and **add the `needs-human` tag** (reuse the existing flag from `dispatcher.ts:334`) so it pulses red on the board. Task stays `done`.

**Skill contract:** after `worker_done` returns `completed_new_status === 'done'`, the worker loops `worker_merge_acquire` until `granted`, performs the git merge in its own process, then calls `worker_merge_release` with the outcome.

### 3.5 `worker_health` — zombie / orphan-worktree discovery (read-only)

New read-only tool so a watcher (the orchestrator in `docs/saga-research/07`) or a human can find stuck work:

```sql
SELECT t.id, t.title, t.assigned_to, t.status,
       json_extract(t.metadata,'$.worktree.path')      AS wt_path,
       json_extract(t.metadata,'$.worktree.branch')    AS branch,
       json_extract(t.metadata,'$.worktree.merged_into) AS merged_into,
       t.updated_at
FROM tasks t JOIN epics e ON e.id = t.epic_id
WHERE e.project_id = ?
  AND json_extract(t.metadata,'$.worktree.path') IS NOT NULL
  AND (
    (t.status = 'in_progress' AND t.updated_at < datetime('now','-30 minutes'))  -- zombies
    OR json_extract(t.metadata,'$.worktree.merged_into') = 'conflict'           -- stuck merges
    OR (t.status = 'done' AND json_extract(t.metadata,'$.worktree.merged_into') IS NULL)  -- never merged
  )
```

Returns a list; saga does **not** auto-delete (other agents' work may be in the worktree). The watcher/human resolves.

### 3.6 `getCurrentBranch` cache fix (`helpers/git.ts:4`)

`let cached` is process-global — a latent bug that activates under multi-worker worktrees. Remove the cache (read is cheap) or scope it per-call. ~5 lines, independent of the rest.

## 4. `saga-worker` skill changes

New sections inserted into `saga-worker/SKILL.md`, interleaved with the existing two-phase flow:

| New section | Content |
|---|---|
| **Step 0a — Git bootstrap** | If `git rev-parse --is-inside-work-tree` fails: `git init` → `git checkout -b dev` → append `.worktrees/` to `.gitignore` → initial commit. Once per project. |
| **Step 0b — Integration branch** | Read/write `dev` as `merge_target`. Stored in `project.metadata.integration_branch` (default `dev`). |
| **CLAIM → worktree setup** | `git worktree add .worktrees/task-<id> -b task/<id> dev` → `cd` → install deps → baseline tests. The dispatcher writes `metadata.worktree` at claim. |
| **DEV-DONE → commit only** | Emphasise: NO merge at this step. Commit + `worker_done`. |
| **REVIEW → diff against dev** | `git diff dev...task/<id>`, verify criteria from `task_get`. |
| **APPROVED → merge + cleanup** | `worker_merge_acquire` (loop until granted) → `git checkout dev && git merge --no-ff task/<id>` → on success `git worktree remove .worktrees/task-<id>` → `worker_merge_release({merged, commit_sha})`. |
| **CONFLICT after APPROVED** | `git merge --abort`, `worker_merge_release({conflict:true})` → task flagged `needs-human`, stays `done`. Do **not** force; report and move on. |
| **CHANGES REQUESTED → re-work** | `worker_done({verdict:'changes_requested'})` → branch survives → fix in the **same** worktree → commit → dev-done again. |
| **Parallel awareness** | Read `active_tasks[]` from every dispatcher response. Before editing a file, check whether a sibling is on the same area (`branch`/`title` hint). Suspected collision → `worker_ask_need`. |
| **Zombie / orphan recovery** | `worker_health` lists stuck worktrees. Recovery: `git worktree list`, inspect commits on `task/<id>`, `worker_done` with `result: "PARTIAL: ..."` to free. Never delete a worktree holding another worker's uncommitted work. |

`saga-tracker/SKILL.md` gains a one-paragraph pointer: workers operate in per-task worktrees; the dispatcher records the linkage.

## 5. What we do NOT do in this MVP

- ❌ First-class `tasks.branch` column (metadata suffices; revisit if GC/indexing needs it).
- ❌ Auto-resolving merge conflicts (flag `needs-human`).
- ❌ PR-style review with a separate merge role (that was Variant C; deferred).
- ❌ Cross-task semantic conflict detection (only textual git conflicts are caught).
- ❌ Auto-scaling worker pools.

## 6. Scope of work

| Part | Location | Estimate |
|---|---|---|
| `metadata.worktree` contract | docs + skill | doc |
| `active_tasks[]` in dispatcher responses | `src/tools/dispatcher.ts` | ~20 lines |
| `verdict` param + `review→in_progress` | `src/tools/dispatcher.ts` | ~30 lines |
| `worker_merge_acquire` / `worker_merge_release` | `src/tools/dispatcher.ts` | ~80 lines |
| `worker_health` | `src/tools/dispatcher.ts` | ~40 lines |
| `getCurrentBranch` cache fix | `src/helpers/git.ts` | ~5 lines |
| Tests (merge-lock serialization, verdict transition, visibility) | `tests/` | ~3 cases |
| Update `saga-worker/SKILL.md` | `skills/saga-worker/` | ~150 new lines |
| Sync `saga-tracker/SKILL.md` + `docs/saga-research/*` | docs | sync |

## 7. Acceptance criteria (DoD)

1. Two workers, two tasks, same project → each lands in its own `.worktrees/task-<id>`; a file written by worker A is **not** visible in worker B's tree until A's task reaches `done` and is merged.
2. `worker_next` / `worker_done` responses include `active_tasks[]` listing every task currently `in_progress` or `review` with an assignee, including its `branch`.
3. A reviewer returning `worker_done({ verdict: "changes_requested" })` moves the task `review → in_progress`, keeps its `task/<id>` branch, and re-assigns to the same worker.
4. Two APPROVED tasks finishing within the same second: the second `worker_merge_acquire` returns `granted: false` until the first calls `worker_merge_release`; both eventually merge cleanly into `dev`.
5. A merge that conflicts sets `merged_into: "conflict"`, adds the `needs-human` tag, leaves the worktree in place, and the task remains `done`.
6. `worker_health` returns a task whose worktree was never merged / has been `in_progress > 30 min` / is in `conflict`.
7. `getCurrentBranch()` returns the caller's actual branch, not a stale process-wide cache, when called from different worktrees.
8. All existing dispatcher race tests (`tests/dispatcher-race`) still pass.

## 8. Open questions / risks (deferred to implementation)

- **`git init` bootstrap race.** First-claim on a fresh project may have two agents racing `git init`. Mitigation: a project-level `metadata.git_initialized` flag under `BEGIN IMMEDIATE`, set by the first claimant; others wait. (Implementation detail.)
- **Worktree path convention.** Default `.worktrees/task-<id>` at repo root; needs `.gitignore` (the `using-git-worktrees` skill already mandates this). Configurable via project metadata if needed.
- **Reviewer has no worktree of its own.** Reviewer reads `git diff dev...task/<id>` from any checkout of the shared repo (the diff works on refs in the common object store). Tests are run in the developer's worktree if it still exists, or in a throwaway `git worktree add` of `task/<id>`.
- **Windows `git worktree remove` reliability** when a process holds a file handle. Mitigation: `--force` after confirming no uncommitted work; the `worker_health` GC path catches stragglers.
