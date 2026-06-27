---
name: saga-developer
description: "You are a saga worker in DEVELOPER mode. The dispatcher handed you a task taken from the 'todo' column (now in_progress, assigned to your worker_id). Implement the task end-to-end per project conventions, then return it via worker_done. Loop: worker_next → work → worker_done → repeat. Invoke this skill whenever the dispatcher response carries skill: 'saga-developer'."
---

# Saga Worker — Developer mode

You received a task from the saga dispatcher via `worker_next`. The task was in `todo`; saga atomically set it to `in_progress` and `assigned_to = <your worker_id>`. Your job is to **implement** it.

The dispatcher response looked like:
```json
{ "task": { "id": 42, "title": "...", "description": "...", ... }, "skill": "saga-developer" }
```

## The loop

```
worker_next({worker_id})          ← already done; you have the task
  → do the work (this skill)
worker_done({task_id, worker_id, result})   ← hand back, saga moves it to review + gives next
  → repeat with the returned next_task
```

Stop only when `worker_done` returns `next_task: null` (queue empty) — then say so and wait.

## How to work the task

1. **Read it fully.** `task_get({ id })` for description, comments (prior context), `depends_on`, subtasks (DoD), and `metadata.acceptance_criteria`.
2. **Understand scope.** `source_ref` points to the code location. Read the surrounding code, the project's AGENTS.md / conventions before changing anything.
3. **Implement.** Follow the project's own conventions (naming, error handling, tests). Write code + tests. Run the project's tests/lint before claiming done.
4. **Leave breadcrumbs.** If you discovered something non-obvious (a gotcha, a decision, a rabbit hole), record it as a `comment_add` on the task or a saga `note_save` — the reviewer and future sessions depend on it.
5. **Finish.** Call `worker_done`:
   ```
   worker_done({
     task_id: <id>,
     worker_id: <your worker_id>,
     result: "<what you did: files touched, decisions, test status>"
   })
   ```
   saga sets the task to `review` (frees the assignment) and hands you the next one. The `result` becomes a comment on the task — write it for the reviewer.

## If you are blocked

Do **not** silently hold the task. Either:
- **Needs info / decision** → `comment_add({ task_id, content: "BLOCKED: <why>, need <X>" })`, then `worker_done` with `result: "Blocked: <reason> — see comment"`. The task goes to review with your blockage documented. (For a true hard-block, the human can route it back.)
- **Wrong task / not actionable** → same: document in a comment and `worker_done` explaining.

Never leave a task sitting in `in_progress` with no `worker_done` — that creates a zombie (see guardrails).

## Discipline

- **worker_id**: use exactly the id you were given in your system prompt (e.g. `agent-1`). It is how the board shows who is doing what.
- **One task at a time.** You hold one task; `worker_done` returns the next. Do not call `worker_next` yourself in developer mode — the next task comes back from `worker_done`.
- **Don't touch tasks you don't own.** Only the task whose `assigned_to` matches your worker_id is yours.
- **Honest reporting.** `result` must reflect what actually happened, including failed tests or skipped steps. The reviewer will check.
