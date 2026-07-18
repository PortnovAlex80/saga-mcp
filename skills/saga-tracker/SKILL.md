---
name: saga-tracker
description: "Bootstrap and dispatcher contract for one logical product board. Resolve `.saga/project.json` or a runner-supplied project binding, then use worker_next/worker_done for exactly one assigned task. `projectname.txt` is legacy fallback."
---

# Saga tracker — bootstrap (начальная загрузка) + the one rule that matters (единственное правило, которое важно)

## Flow position (saga-flow — позиция в потоке)

- **Stage (этап):** 0-Bootstrap (до всего, утилитарный)
- **Precondition (предусловие):** saga-mcp MCP подключен. `.saga/project.json` or a
  runner-supplied `project_id` is available.
- **Postcondition (постусловие):** project_id resolved (разрешён; для всех остальных ролей)
- **Called by (вызывается):** любой скилл/агент при старте (через project_resolve_by_name)
- **Next enables (что разблокирует):** любая роль (им нужен project_id)
- **Это не фаза флоу** — это bootstrap-утилита (утилита начальной загрузки). Загружай первой в любой сессии.

saga-mcp is a local SQLite task tracker over MCP, holding **many projects in one
shared DB**. This skill covers only what every saga session needs; the worker
loop is in `saga-worker`, and the operational reference (kanban stages, tag
taxonomy, DoD, multi-project conventions) is linked at the bottom.

## 1. Resolve your project (разреши свой проект; ONCE per session — один раз за сессию)

Identity comes from the dispatcher or `.saga/project.json`. Never infer a
product from a repository directory; one product may contain many repositories.

```
1. Use the `project_id` supplied by the board runner, or read
   `.saga/project.json`.
2. Validate its project/repository IDs. If absent, use `saga-start`.
3. Only for legacy repositories, resolve the exact name from `projectname.txt`.
4. Hold project_id. Pass it to every worker_next call.
```

Never create a second project for another repository, specialty, requirements,
or builders.

## 2. The one rule (единственное правило) — workers go through the dispatcher (воркеры проходят через диспетчера)

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

## When this skill is NOT the worker loop (когда этот скилл НЕ рабочий цикл)

This skill is also the entry point for the **planning/triage role**: creating
projects, writing tasks, setting up epics, moving things on the board, triage,
decision notes. For that role you DO use `task_*` / `project_*` / `note_*`
directly — but you are curating the queue the workers pull from, not in the
worker loop.

## Mental model (ментальная модель)

```
Project  ─ top container (ONE shared saga DB holds MANY projects)
  └─ Epic    ─ feature/workstream (optionally git-branch scoped)
       └─ Task   ─ unit of work (status coarse, stage in tag)
            ├─ Subtask   ─ checklist item (DoD)
            ├─ Comment   ─ cross-session breadcrumb
            ├─ depends_on: [task IDs]  ─ auto-blocks/unblocks
            └─ metadata.worktree  ─ {branch:"task/<id>", merged_into: pending|dev|conflict}
```

saga statuses are **fixed and coarse** (6 for tasks): `todo / in_progress /
review / review_in_progress / done / blocked`. `review` is the buffer (waits for
a reviewer, no assignee); `review_in_progress` means a reviewer claimed it and
is working. Detailed stage lives in a `stage:<name>` tag.

**Workers share one repo but each task runs in its OWN git worktree**
(branch `task/<id>`, path `.worktrees/task-<id>`), so concurrent agents don't
race files. The dispatcher records the linkage in `task.metadata.worktree`;
the merge back into the integration branch (`dev`) is gated behind review
(APPROVED → `worker_merge_acquire` → merge → `worker_merge_release`). Every
`worker_next` / `worker_done` response also carries `active_tasks[]` so a
worker can see what its siblings are doing. Full lifecycle in `saga-worker`.

### "Development complete" — the dispatcher-decides rule

A project (or a single epic / REQ episode) is **done only when the dispatcher
says so** — never when an agent or human "feels finished". Concretely:

- Keep calling `worker_next({ project_id, role? })` per role. The dispatcher
  hands out any task in `todo` / `review` (and tracks the in-flight
  `in_progress` / `review_in_progress` ones).
- A role's queue is exhausted when `worker_next` returns `{ task: null }` for it.
- The project/episode is complete only when **every role** you dispatch returns
  `{ task: null }` AND no task is left in `todo` / `in_progress` / `review` /
  `review_in_progress`. (`blocked` tasks are a separate problem — investigate,
  don't ignore.)

Corollary: a task sitting in `review` is **not finished**. Some reviewer must
claim it (`worker_next` → `review_in_progress`), deliver a verdict
(`worker_done` → `done` or back to `in_progress` on changes_requested). Until
that loop closes, the work is open. Do not declare the episode ready for the
downstream stage (e.g. requirements → development tasks) on the dispatcher's
silent output — verify `{ task: null }` for every role first.

## Deep reference (глубокий справочник; operational content — операционное содержимое)

The kanban stages, tag taxonomy, DoD, templates, and multi-project conventions
were moved OUT of this skill to keep it focused. Read on demand:

- `docs/saga-research/01-saga-architecture.md` — internals, DB_PATH, schema
- `docs/saga-research/02-saga-api-reference.md` — all tools + the dispatcher
- `docs/saga-research/03-kanban-process.md` — the kanban stages, tag↔status mapping
- `docs/saga-research/04-taxonomy-and-metadata.md` — tag namespaces, metadata rules
- `docs/saga-research/05-templates-and-dod.md` — feature/bugfix/release/spike templates, DoD
- `docs/saga-research/06-multi-project-and-review.md` — many projects in one DB, review/acceptance

If a doc is missing, the source of truth is `src/` and the README; flag the gap.
