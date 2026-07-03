---
name: saga-tracker
description: "Bootstrap + the one rule for any saga session. Two things: (1) resolve your project once from ./projectname.txt; (2) if you are a WORKER, the ONLY way to get/return a task is the dispatcher (worker_next / worker_done) — never task_*/project_*. Load this FIRST. For the worker loop, load saga-worker. For planning/triage (creating projects, writing tasks, moving the board), you DO use task_*/project_* directly — but that is a different role, not the worker loop."
---

# Saga tracker — bootstrap + the one rule that matters

saga-mcp is a local SQLite task tracker over MCP, holding **many projects in one
shared DB**. This skill covers only what every saga session needs; the worker
loop is in `saga-worker`, and the operational reference (kanban stages, tag
taxonomy, DoD, multi-project conventions) is linked at the bottom.

## 1. Resolve your project (ONCE per session)

Identity does NOT live in your memory — it lives in a file, because the shared
DB holds many projects and guessing gets you another project's work.

```
1. Read ./projectname.txt (one line = exact saga project name).
   Missing? Ask the human ONCE "What is the saga project name for this folder?",
   write that single line to ./projectname.txt, then continue.
2. project_resolve_by_name({ name: "<line from file>" })
     → { project_id, created, project }   // atomic lookup-or-create; safe under concurrent cold starts
3. Hold project_id. Pass it to every worker_next call. worker_done derives it itself.
```

This is the ONLY safe way to scope work to your project. If `worker_next`
throws the "project_id is missing" error, it is telling you to do exactly
steps 1-3.

## 2. The one rule — workers go through the dispatcher

```
THE ONLY WAY A WORKER GETS A TASK   IS worker_next({worker_id, project_id}).
THE ONLY WAY A WORKER RETURNS ONE   IS worker_done({task_id, worker_id, result}).
```

- A **worker** never calls `task_*` / `project_*` / `epic_*` to claim, assign,
  or create work. If you are in the worker loop → **load `saga-worker`** and
  follow it.
- A worker MAY call `task_get` (read), `comment_add` (breadcrumb), `note_save`
  (decision) on a task it already holds — side-effects on owned work, not
  work-stealing.
- A worker MUST NOT call `task_update({status:...})` to move its own task —
  status is the dispatcher's exclusive zone; `task_update` silently ignores it.

## When this skill is NOT the worker loop

This skill is also the entry point for the **planning/triage role**: creating
projects, writing tasks, setting up epics, moving things on the board, triage,
decision notes. For that role you DO use `task_*` / `project_*` / `note_*`
directly — but you are curating the queue the workers pull from, not in the
worker loop.

## Mental model

```
Project  ─ top container (ONE shared saga DB holds MANY projects)
  └─ Epic    ─ feature/workstream (optionally git-branch scoped)
       └─ Task   ─ unit of work (status coarse, stage in tag)
            ├─ Subtask   ─ checklist item (DoD)
            ├─ Comment   ─ cross-session breadcrumb
            ├─ depends_on: [task IDs]  ─ auto-blocks/unblocks
            └─ metadata.worktree  ─ {branch:"task/<id>", merged_into: pending|dev|conflict}
```

saga statuses are **fixed and coarse** (5 for tasks): `todo / in_progress /
review / done / blocked`. Detailed stage lives in a `stage:<name>` tag.

**Workers share one repo but each task runs in its OWN git worktree**
(branch `task/<id>`, path `.worktrees/task-<id>`), so concurrent agents don't
race files. The dispatcher records the linkage in `task.metadata.worktree`;
the merge back into the integration branch (`dev`) is gated behind review
(APPROVED → `worker_merge_acquire` → merge → `worker_merge_release`). Every
`worker_next` / `worker_done` response also carries `active_tasks[]` so a
worker can see what its siblings are doing. Full lifecycle in `saga-worker`.

## Deep reference (operational content)

The kanban stages, tag taxonomy, DoD, templates, and multi-project conventions
were moved OUT of this skill to keep it focused. Read on demand:

- `docs/saga-research/01-saga-architecture.md` — internals, DB_PATH, schema
- `docs/saga-research/02-saga-api-reference.md` — all tools + the dispatcher
- `docs/saga-research/03-kanban-process.md` — the kanban stages, tag↔status mapping
- `docs/saga-research/04-taxonomy-and-metadata.md` — tag namespaces, metadata rules
- `docs/saga-research/05-templates-and-dod.md` — feature/bugfix/release/spike templates, DoD
- `docs/saga-research/06-multi-project-and-review.md` — many projects in one DB, review/acceptance

If a doc is missing, the source of truth is `src/` and the README; flag the gap.
