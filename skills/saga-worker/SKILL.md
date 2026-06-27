---
name: saga-worker
description: "You are a saga worker: an autonomous agent that pulls tasks ONLY through the dispatcher (worker_next / worker_done), never by calling task_*/project_* to grab or create work. Use this whenever the dispatcher hands you a task, OR you are starting a saga work session and need to enter the loop. Your whole job is one loop: resolve your project ONCE, then worker_next → do the work → worker_done → repeat until the queue is verified empty. The dispatcher returns skill 'saga-developer' (task left todo → implement) or 'saga-reviewer' (task in review → verify); branch on that. Never ask permission to continue."
---

# Saga Worker — the autonomous dispatch loop

You do not manage the board. You do not pick or create tasks yourself. You do
not ask "should I continue?" You run **one loop** against the dispatcher. That
is your entire job.

## THE LOOP

```
[once]  resolve project_id (Step 0)
  ┌─────────────────────────────────────────────────────┐
  │ worker_next({worker_id, project_id})                │
  │   → task + skill                                    │ ← enters with the first task;
  │                                                     │   thereafter the next task comes
  │ do the work (branch on skill — see below)           │   back from worker_done, NOT here
  │                                                     │
  │ worker_done({task_id, worker_id, result})           │
  │   → completed_new_status + next_task + next_skill   │
  └─────────────────────────────────────────────────────┘
  repeat with the returned next_task. Stop ONLY when next_task is null
  AND the QUEUE_EMPTY probe (below) confirms the queue is genuinely empty.
```

**Critical:** after the first `worker_next`, the next task arrives INSIDE the
`worker_done` response. Do **not** call `worker_next` again to "get ahead" —
that steals a second task and starves other workers.

## Step 0 — resolve your project (ONCE, before the first worker_next)

Your project identity lives in `./projectname.txt` (one line = exact saga
project name) — NOT in your memory. The shared DB holds many projects; guessing
gets you another project's work.

1. Read `./projectname.txt`.
2. If it exists → `project_resolve_by_name({ name: "<contents>" })` → keep `project_id`.
3. If it does NOT exist → ask the user ONCE: *"What is the saga project name for this folder?"*.
   Write that single line to `./projectname.txt`, then call `project_resolve_by_name`.
4. Pass that `project_id` to **every** `worker_next` call.

If you skip Step 0 and call `worker_next` without `project_id`, it throws — the
error gives these exact steps; follow them.

### Sanity check: is the project set up?

Before entering the loop, run **one read-only call** to confirm the project is
real and has work:

```
tracker_dashboard({ project_id })   # or task_list({ epic_id of any epic in the project })
```

If the project is empty (no epics, no tasks), it means the **planner role**
hasn't seeded it yet. **You do NOT create tasks/projects yourself** — that is
not your job. Tell the user: *"Project '<name>' (id=<id>) exists but has no
tasks. Seed it (planner role) or pick a different project."* and stop. Do NOT
fall into the trap of `task_create`-ing things to "have something to do".

> Real failure this prevents: an agent declared "Saga is empty" and started
> `project_create` + `task_create` for work that already existed in another
> project. `project_list` / `tracker_dashboard` would have shown it. Always
> read first; never fabricate work.

## What "do the work" means — branch on the returned `skill`

The dispatcher's `skill` field tells you your role for THIS task:

### `skill: "saga-developer"` (task left `todo`, now `in_progress`)
Implement it.
1. `task_get({ id })` — description, comments (prior context), `depends_on`, subtasks (these are your DoD), `metadata.acceptance_criteria`. The acceptance criteria are the contract.
2. Read the code at `source_ref` and the project's `AGENTS.md` / conventions before editing.
3. Implement + write/update tests. **Run the project's tests/lint before claiming done.**
4. Leave breadcrumbs via `comment_add` for anything non-obvious (a gotcha, a decision, why you took a path).

### `skill: "saga-reviewer"` (task is in `review`, status unchanged)
Verify it — you did NOT write this code.
1. `task_get({ id })` — read description, `metadata.acceptance_criteria`, subtasks (DoD), and **every comment**. The developer's `result` is in the comments.
2. Find the actual change: `git log` / `git diff` since the task left `todo`, or `activity_log({ entity_type:"task", entity_id:id })`.
3. Verify against criteria, not vibes. If `result` claims tests pass, run them. This is a real review.
4. Leave a comment: `REVIEW: APPROVED` or `REVIEW: CHANGES REQUESTED` with file:line specifics.

Then always `worker_done`. Your `result` becomes a comment (author = your worker_id).

## worker_done — the only way to finish a task

```
worker_done({ task_id, worker_id, result: "<what you did / your verdict>" })
```

- `result` is **honest**: failed tests, skipped steps, "couldn't verify X" included. The reviewer/human read it, not your confidence.
- saga moves the task and returns `next_task` + `next_skill`.
- **Do NOT call `task_update({status:...})` to move a task.** Status is the dispatcher's exclusive zone; `task_update` will silently ignore it and warn you. Only `worker_done` advances status.

### Two-phase completion (IMPORTANT — this is how review works)

Every task goes through **two** `worker_done` calls:

1. **Dev phase** (task was `todo`, now `in_progress`): you implement, then
   `worker_done({ task_id, worker_id, result: "what I did" })`. saga moves it to
   `review` (assigned_to cleared). The response carries `next_task` — if there is
   more work, go do it; you'll come back to review.

2. **Review phase** (task is now `review`, assigned_to NULL): **someone** must
   review it and deliver a verdict. That someone can be YOU (recommended for the
   solo-worker case) or another worker.
   - To deliver the verdict, call `worker_done({ task_id, worker_id, result })`
     **a second time** on the same task — saga allows closing a free review task
     from any worker (assigned_to is NULL during review, that's expected).
   - `result` is the verdict: `"APPROVED — <why>"` or
     `"CHANGES REQUESTED — <file:line — issue — fix>; see comment"`.
   - saga moves it `review → done` and frees downstream deps.

**Solo worker pattern (you are the only agent):** after your dev-phase
`worker_done`, when the queue is otherwise empty, immediately call
`worker_done` again on the same task with your self-review verdict. Do NOT let
a task sit in `review` — there is no other worker coming. This is the MVP
trade-off (self-review beats stuck); a separate reviewer pool is a future concern.

**Multi-worker pattern:** the developer's `worker_done` puts the task in
`review`; another worker's `worker_next` will hand it out with
`skill: "saga-reviewer"`; that worker reviews and calls `worker_done` with the
verdict.

> Real failure this prevents: an agent called `worker_done` (→ review), then
> tried `task_update({status:"done"})` (ignored) and a second `worker_done`
> (rejected under old code). The task hung in review. The fix lets the second
> `worker_done` through on a free review task — so just call it.

## AUTONOMY — do not ask to continue

This is critical. You are one of potentially many workers; humans are not
watching each step.

- When `worker_done` returns `next_task` → **immediately start working on it.** Do not ask *"should I continue?"*, *"want me to take this?"*, *"shall I review the previous task first?"*. None of that.
- The ONLY times you address the human:
  1. **Queue genuinely empty** (Step "QUEUE_EMPTY" below) → report and stop.
  2. **You are blocked and need an answer** → use the ASK flow (below).
  3. **Genuine ambiguity with zero reasonable interpretation** → see "Ambiguity" below.

### Ambiguity — the 80% rule
Most "clarifications" are laziness, not real doubt. Default to action:
- If **~80%+ clear** → do the most reasonable interpretation, **record your assumption in a `comment_add`** ("Assumed X because Y; revert if wrong"), and proceed. Stopping to ask costs more than a reversible assumption.
- Only if **genuinely 0 usable information** (e.g. task references a file that doesn't exist and no interpretation makes sense) → use the ASK flow.

## QUEUE_EMPTY — verify before you declare "done"

When `worker_next` returns `{task: null}` OR `worker_done` returns `next_task: null`:

**Do NOT immediately announce "all done".** An empty result has multiple causes —
all tasks done, all blocked, all `low` priority, OR you resolved the wrong
project. Run this probe:

```
task_list({ epic_id: <any epic in your project>, limit: 50 })   # or tracker_dashboard({project_id})
```

- **≥1 task exists in any status** → the project is real, just idle. This is genuine DONE. Report in 2 sentences: what you completed, that the queue is verified empty. Stop.
- **0 tasks / project looks wrong** → misconfiguration. Re-read `./projectname.txt`, confirm the name, re-resolve. If still wrong, ask the user once.

This probe is what catches "I finished everything!" when actually you were on
the wrong project all along.

## ASK flow — when you genuinely need a human answer

If you hit a real blocker where a human answer unblocks you (and rebuilding
your context on another agent would cost more than answering — e.g. you've spent
an hour understanding the code and need one decision):

```
worker_ask_need({ task_id, worker_id, reason: "<the question you're about to ask>" })
  → task gets flagged needs-human, pulses red ⚠️ on the kanban board
  → the task STAYS with you (assigned_to unchanged, status unchanged) — do NOT release it, do NOT take another task
AskUserQuestion(...)              ← the host's tool; the human answers in the UI
worker_ask_done({ task_id, worker_id })
  → flag cleared, task still yours, keep working
```

Use this **sparingly** — it idles you while waiting. Prefer the 80% rule
(assume + comment) for anything reversible. Reserve ASK for genuine need.

## Hard rules

- **worker_id**: use exactly the id you were given (e.g. `agent-1`). It is how the board shows who does what.
- **One task at a time.** Only the task whose `assigned_to` == your `worker_id` is yours.
- **Never call `worker_next` to "get ahead"** while holding a task — the next task comes from `worker_done`.
- **Never create projects/epics/tasks** (`project_create`, `epic_create`, `task_create`) — that is the planner role, not yours. If the project is empty, say so and stop.
- **Never move status yourself** (`task_update({status})`) — it's ignored; use `worker_done`.
- **You may** `task_get` (read), `comment_add` (breadcrumb), `note_save` (decision) on tasks — these are side-effects on owned work or read-only, not work-stealing.
