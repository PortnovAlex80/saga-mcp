---
name: saga-tracker
description: "Use when working with tasks, projects, epics, or work tracking via saga-mcp — creating, reading, updating, moving through kanban stages, capturing decisions, or resuming work. Invoke before any saga tool call if unsure of the right tool, stage convention, taxonomy, or template. Covers our full process: 8 kanban stages, tag taxonomy, DoD, multi-project naming, review/acceptance via notes. On setups with the dispatcher enabled, also see the saga-developer / saga-reviewer skills for the worker loop."
---

# Saga Tracker — working with the task tracker

saga-mcp is a local SQLite-backed task tracker exposed via MCP. Use it for **persistent work tracking** across sessions: projects, epics, tasks, subtasks, dependencies, notes, comments, templates.

**Deep reference (read when unsure):** `docs/saga-research/` in this repo — 6 docs covering architecture, full API, kanban process, taxonomy, templates/DoD, multi-project + review.

## When to use

- User asks to create/track/move a task, epic, or project
- Recording a decision, context, or progress that must survive across sessions
- At the **start of a session** to recall where work left off
- Before any `mcp__saga__*` call if unsure of tool, argument, or convention

## When NOT to use

- One-off questions without persistence need
- Project has no saga configured (tools will error `DB_PATH required`)

## Mental model

```
Project  ─ top container (in our setup: ONE saga DB holds MANY projects — see Multi-project)
  └─ Epic    ─ feature/workstream (optionally git-branch scoped)
       └─ Task   ─ unit of work (status coarse, stage in tag)
            ├─ Subtask  ─ checklist item (use for DoD)
            ├─ Comment  ─ cross-session breadcrumb
            └─ depends_on: [task IDs]  ─ auto-blocks/unblocks
```

saga statuses are **fixed and coarse** (5 for tasks). Our detailed stage lives in a **tag**.

## The dispatcher (if enabled)

On setups where the dispatcher tools are present (`worker_next` / `worker_done`), an AI worker does NOT call task_*/project_* directly to pull work — it loops:

```
[bootstrap once] read ./projectname.txt → project_resolve_by_name → project_id
worker_next({worker_id, project_id})  →  work (saga-developer or saga-reviewer skill)  →  worker_done(...)  →  repeat
```

The dispatcher picks the next free task (`todo` or `review`, unassigned, deps met) **within the given project only**, atomically assigns it, and returns a `skill` telling the worker how to approach it:
- `saga-developer` — task was in `todo`, implement it.
- `saga-reviewer` — task was in `review`, verify it.

**`project_id` is REQUIRED on `worker_next`** — without it, the shared multi-project DB would hand the worker a task from some other project. Always resolve it from `./projectname.txt` first (see "Identity & projectname.txt" below). `worker_done` does not take project_id — it derives it from the task it just completed.

**Low-priority tasks are NOT dispatched.** `worker_next` only returns `critical` / `high` / `medium`. A `low` task stays in `todo` and waits for a human to raise its priority (then it enters the queue) or to take it manually. Don't be surprised when a `low` task never comes out of `worker_next`.

Outside the worker loop (planning, triage, one-off edits), use the normal task_*/note_*/comment_* tools below.

## Identity & projectname.txt

The shared saga DB holds MANY projects. A worker must know WHICH project is its. We do not trust the agent's memory for this — the identity lives in a file:

- `./projectname.txt` in the project root — **one line**, the exact saga project name.
- Read it once at session start, resolve with `project_resolve_by_name({ name: <from file> })` → `{ project_id, created }`.
- Pass that `project_id` to every `worker_next` call.
- Survives restarts; shared by every agent in the same folder (3 agents on one project all read the same file → same project_id).
- `project_resolve_by_name` is atomic (lookup-or-create under a write lock), so multiple cold agents starting at once do not create duplicate projects (name is not unique in saga).

If `projectname.txt` is missing, ask the human what saga project name this folder maps to, then create the file with that one line.

## Kanban stages (Harmess process)

The **stage** is in a tag `stage:<name>`. saga `status` stays coarse.

| Stage (board) | saga status | tag | meaning |
|---|---|---|---|
| Backlog | `todo` | (none) | not started |
| Системный анализ | `in_progress` | `stage:analysis` | requirements |
| Проектирование | `in_progress` | `stage:design` | architecture |
| Разработка | `in_progress` | `stage:dev` | coding |
| Ожидание тестирования | `blocked` | `stage:qa-wait` | dev done, waiting QA (+ add comment!) |
| Тестирование | `in_progress` | `stage:qa` | testing |
| Интеграционное тестирование | `in_progress` | `stage:integration` | module interaction |
| Ревью | `review` | (none) | code review before release |
| Готово | `done` | (none) | accepted |

WIP limits: **none** (we show counts, we don't block).

Move along the board = update `tags` (+ maybe `status`):
```
task_update({ id, status: "in_progress", tags: ["stage:analysis"] })  # into analysis
task_update({ id, tags: ["stage:dev"] })                              # into dev
task_update({ id, status: "blocked", tags: ["stage:qa-wait"] })       # waiting QA
comment_add({ task_id: id, content: "Готово к тестированию, ждёт QA" })
task_update({ id, status: "in_progress", tags: ["stage:qa"] })        # into QA
task_update({ id, status: "review" })                                 # review
task_update({ id, status: "done" })                                   # done
```

## Tag taxonomy (use namespaces, always lowercase)

Tags are the **only filterable axis**. Use `namespace:value` to avoid collisions.

| Prefix | Examples | Use for |
|---|---|---|
| `stage:` | `stage:dev`, `stage:qa` | kanban stage (see table above) |
| `module:` | `module:femdriver`, `module:postprocess` | code module/subsystem |
| `team:` | `team:backend`, `team:qa` | team/role |
| `type:` | `type:bug`, `type:feature`, `type:spike`, `type:docs` | kind of work |
| `flow:` | `flow:release-v2.3.1`, `flow:hotfix` | cross-cutting release/stream |
| (free) | `urgent`, `tech-debt` | contextual markers |

Rules: one concept per tag (`["stage:qa","type:test"]`, not `stage-qa-test`); kebab-case values; lowercase (SQLite `=` is case-sensitive); at least one `stage:` once `status != todo`.

## Metadata (JSON, not filterable, but shown in task_get)

Put things you store but don't search:
```json
{
  "external_refs": { "github_issue": 42, "jira": "PROJ-123" },
  "version": "2.3.1",
  "estimate_breakdown": { "analysis": 2, "dev": 8 },
  "acceptance_criteria": ["M_C1 within 5% of SCAD"],
  "reviewers": ["mike"],
  "risk": "high"
}
```

**Decision:** want to filter/group by it → tag. Want to see it in task_get only → metadata.

## Session start routine (ALWAYS when resuming)

1. `project_list({ status: "active" })` — find your project (we have MANY in one DB). Never call `tracker_dashboard` blind — it grabs "first".
2. `tracker_dashboard({ project_id: X })` — overview: summary + epics + blocked + recent activity + notes.
3. If you have a "last session" timestamp: `tracker_session_diff({ since: "2026-06-26T10:00:00" })`.
4. `note_list({ note_type: "context" })` — open context threads.

State the summary in 2-3 sentences before doing anything.

## Core workflows

### Start a feature (use template if it exists)
```
template_list()                                    # check if feature_workflow exists
template_apply({ template_id, epic_id, variables: { feature: "auth" } })
# if no template:
task_create({ epic_id, title: "[proj] Системный анализ: auth", priority: "high", tags: ["stage:analysis","type:feature","module:auth"] })
```

### Task with dependencies (auto-blocking)
```
task_create({ epic_id, title: "Design schema" })          # → 1
task_create({ epic_id, title: "Implement", depends_on: [1] })  # → 2, auto-blocked
task_update({ id: 1, status: "done" })                   # 2 auto-unblocks to todo
```
Self-deps ignored. `depends_on` on update **replaces** the full list.

### Definition of Done (subtasks + metadata)
```
task_create({ epic_id, title: "Implement CVaR kernel",
  metadata: { acceptance_criteria: ["M_C1 within 5% of SCAD", "converges < 100 iter"] } })
subtask_create({ task_id, titles: [
  "Unit tests >= 90% coverage",
  "Benchmark vs SCAD within 5%",
  "Docs in docs/",
  "Code review passed"
]})
```
⚠️ saga does NOT enforce: marking `done` doesn't check subtasks. It's agent discipline — verify `subtask_done_count == subtask_count` before `done`.

### Capture a decision (decision-note = our ADR)
```
note_save({ title: "Decision: SQLite WAL for saga",
  content: "## Context\n...\n## Alternatives\n...\n## Decision\nSQLite WAL.\n## Consequences\n...",
  note_type: "decision", related_entity_type: "project", related_entity_id, tags: ["type:decision"] })
```
note_types: `general | decision | context | meeting | technical | blocker | progress | release`.
- `decision` — architectural/design choices (our ADR replacement)
- `context` — "where we stopped" (read at session start)
- `blocker` — what's blocking and why

### Review + acceptance
```
task_update({ id, status: "review" })
comment_add({ task_id, author: "mike", content: "Line 45: extract constant. APPROVED after fix." })
note_save({ title: "Review: M_C1 — APPROVED", note_type: "decision", related_entity_type: "task", related_entity_id })
task_update({ id, status: "done" })
# release acceptance:
note_save({ title: "Release v2.3.1 — accepted", note_type: "release", related_entity_type: "project", related_entity_id, tags: ["flow:release-v2.3.1"] })
```

### Find things
```
tracker_search({ query: "CVaR", entity_types: ["task","note"] })
task_list({ tag: "stage:qa" })              # all in testing
task_list({ status: "blocked", priority: "critical" })
note_search({ query: "почему" })            # decisions
```

## Multi-project (CRITICAL — we have hundreds in ONE DB)

Our reality: one saga DB holds **many** saga-projects (one per code folder). Isolation is logical, not physical.

### Project naming convention
```js
project_create({
  name: "femdriver — FEM Mast M_C1",
  description: "Folder: D:/Development/femdriver. Goal: base moment.",
  tags: ["folder:femdriver", "domain:fem", "lang:python"]
})
```
- `folder:<slug>` tag = link to disk folder
- Name includes folder slug → searchable
- Task titles prefixed `[proj]` for readability

### Never call `tracker_dashboard` without project_id
With hundreds of projects it grabs "first" = wrong context. Always: `project_list({status:"active"})` → pick → `dashboard({project_id})`.

## Canonical templates (create once per project)

- `feature_workflow` — analysis→design→dev→tests→docs (`docs/saga-research/05`)
- `bugfix_workflow` — localize→repro→fix→regression
- `release_prep` — freeze→IT→changelog→review→tag
- `spike_workflow` — research→POC→decision

See `05-templates-and-dod.md` for full definitions. Templates live in their DB (not global); recreate or import per project.

## Hard rules and gotchas (from source reading)

1. **DB_PATH mandatory**, no auto-detect. saga errors `DB_PATH environment variable is required` if ZCode didn't pass it.
2. **Statuses are SQL CHECK-constrained.** Cannot invent "приемка". Use `stage:` tags for fine stages.
3. **No hard-delete** for projects/epics/tasks (soft only: archived/cancelled/done). `subtask_delete` IS hard delete (batch-supported).
4. **`project_list` returns archived by default** — filter `status:"active"`.
5. **`tracker_import` takes `data` OBJECT, not a file path.**
6. **`task_list` `tag` is a single string** — call multiple times for "any of".
7. **`depends_on` on `task_update` replaces entire list** — include all deps.
8. **Auto-time-tracking:** `status → done` computes `actual_hours` from last `in_progress` (unless set manually).
9. **Branch scoping looks for `.git` in `dirname(DB_PATH)`** — if DB in `.zcode/`, `branch:"current"` may return null.
10. **`blocked` is overloaded:** auto (deps) vs manual (waiting QA). Always add a comment when manual.
11. **Templates don't support subtasks or depends_on** — set sequencing after apply.
12. **saga doesn't validate DoD** — marking `done` doesn't check subtasks. Agent discipline.

## Writing tasks well

- **Title:** imperative, scannable, project-prefixed — `"[femdriver] Этап 0.1: localize cantilever bug"`
- **Description:** what + why (not how — code goes in comments as discovered)
- **`source_ref`:** link to code — `{ file: "src/auth.ts", line_start: 45, commit: "abc123" }`
- **`tags`:** always `stage:` once started; add `module:`/`type:`/`flow:` as relevant
- **`metadata`:** acceptance criteria, external refs, reviewers, risk

## Reporting back

After any change batch: 2-3 sentence status — what moved, what's blocked, what's next. Pull a one-line `tracker_dashboard` summary if helpful. Never dump raw JSON unless asked.

## References (deep dive)

- `docs/saga-research/01-saga-architecture.md` — internals, DB_PATH, schema, git
- `docs/saga-research/02-saga-api-reference.md` — all 31 tools (+ dispatcher)
- `docs/saga-research/03-kanban-process.md` — stages detail
- `docs/saga-research/04-taxonomy-and-metadata.md` — tag/metadata rules
- `docs/saga-research/05-templates-and-dod.md` — templates + DoD
- `docs/saga-research/06-multi-project-and-review.md` — hundreds of projects + review/acceptance
