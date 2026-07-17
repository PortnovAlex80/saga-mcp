---
name: saga-worker
description: "Execute exactly one dispatcher-assigned task for one logical product, using its repository workspace and worktree; complete review and merge protocol, then exit permanently. Use whenever Saga assigns development, review, verification, or integration work."
---

# Saga Worker — the autonomous dispatch loop

## Flow position (saga-flow)

- **Stage:** 6-Execution (рой, после planning) ИЛИ 7-AC-verification (role:reviewer, tag:ac-verification)
- **Precondition:** dev-задачи в статусе todo (созданы planner'ом). Проверь: `task_list({status:'todo', epic_id})` → не пусто.
- **Postcondition:** задача done + merged в dev (для dev-задачи) ИЛИ verified_by trace (для AC-verification)
- **Called by:** saga-dispatch (execution loop) ИЛИ saga-orchestrator напрямую (одна задача)
- **Next enables:** следующая задача в очереди (через worker_next). AC-verification → INTEGRATE.
- **Проверь precondition:** если очередь пуста → сообщи "no tasks", не выдумывай работу.
- **Solo-worker:** один launch = одна задача (claim → work → done → stop). Цикл = saga-dispatch.

You do not manage the board. You do not pick or create tasks yourself. You do
not ask "should I continue?" You run **one loop** against the dispatcher. That
is your entire job.

You share the repository with other workers. **Every task you take runs inside
its own git worktree** (`git worktree`) on a dedicated branch — so your edits
never collide with a sibling's. The dispatcher records the linkage; the merge
back into the integration branch (`dev`) is gated behind review. See
**WORKTREE LIFECYCLE** for the exact sequence.

## Heartbeat — отметься при старте (ОБЯЗАТЕЛЬНО)

Сразу после запуска процесса, перед любой другой работой — одной командой:

```bash
echo "$(date -u +%FT%TZ) pid=$$ worker=$SAGA_WORKER_ID project=$SAGA_PROJECT_ID task=$SAGA_TASK_ID CLAIMED начал работу" >> ~/.zcode/cli/worker-heartbeat.log
```

Это **не запрос задачи** (задача уже назначена диспатчером). Это маркер «я жив и
работаю» — оператор смотрит через `tail -f ~/.zcode/cli/worker-heartbeat.log`.
Переменные `SAGA_*` выставляет saga-runner в окружении процесса. Если их нет
(запуск не через board-runner), подставь `worker_id`/`task.id`/`project_id`
вручную из ответа `worker_next`.

Дополнительно, на ключевых шагах (опционально, не чаще раза в минуту):

```bash
echo "$(date -u +%FT%TZ) pid=$$ worker=$SAGA_WORKER_ID project=$SAGA_PROJECT_ID task=$SAGA_TASK_ID STEP пишу rub.py — exact_lower_cvar" >> ~/.zcode/cli/worker-heartbeat.log
```

## ONE TASK PER LAUNCH (NOT a loop)

You handle **exactly one** task per launch, then return a summary and STOP. The
orchestrator that spawned you calls you again for the next task — you do NOT loop
inside one launch.

```
[once per launch]
  resolve project_id (Step 0)            ← only if you don't have it yet
  worker_next({worker_id, project_id})
    → task + skill + active_tasks[]      (or { task: null } → report "queue empty", STOP)
  do the work IN YOUR WORKTREE (see below)
  worker_done({task_id, worker_id, result, verdict?})
    → completed_new_status + active_tasks[]
  [if completed→done] merge-lock + merge + release   ← integrates your branch into dev
  return a one-line summary ("task #N: <what you did>") and STOP.
```

**Critical:** do NOT call `worker_next` again after `worker_done`. One launch =
one `worker_next` + one `worker_done`. The orchestrator decides whether to spawn
you again. Looping inside one launch burns tokens and blocks the main session.

## Step 0 — resolve your project (ONCE, before the first worker_next)

For new products, project identity lives in `.saga/project.json`; the board
runner may also pass the resolved `project_id` and repository binding directly.
`./projectname.txt` is a legacy fallback. The shared DB holds many products, so
never guess identity from the directory name.

1. Read `.saga/project.json`; if supplied by the runner, use its resolved
   `project_id` directly.
2. If no manifest exists, read legacy `./projectname.txt` and resolve its name.
3. **If neither binding exists and no project_id was supplied → HARD STOP.**
   - Ask the user ONCE: *"What is the saga project name for this folder?"*
   - **Do NOT create anything.** Do NOT call `project_create`, `project_resolve_by_name`,
     `epic_create`, `task_create`, or any other mutation. Without a confirmed project
     name you have NO idea which project is yours — fabricating one creates work in
     the wrong place (a real failure: an agent spun up a duplicate "Lottery Solver"
     in an empty DB because projectname.txt was missing).
   - Wait for the user's answer and use `saga-start` to create the canonical
     product/repository binding.
   - The user's answer is the ONLY legitimate source of the project name — never
     infer it from the folder name, AGENTS.md, or any other file.
4. **Immediately proceed to ONE TASK PER LAUNCH** — call `worker_next({ worker_id, project_id })` right away.
   Do NOT report the resolved project_id back and wait for confirmation. Do NOT ask
   "ready to start?". Resolving the project IS the start — the next action is `worker_next`.

If you skip Step 0 and call `worker_next` without `project_id`, it throws — the
error gives these exact steps; follow them.

**Do NOT pre-check the dashboard.** Do not call `tracker_dashboard` /
`project_list` / `task_list` "to see what's there" before entering the loop.
The dispatcher is the source of truth about available work — call `worker_next`
immediately after Step 0. If the queue is empty, it returns `{task: null}` and
the QUEUE_EMPTY probe (below) handles that. Pre-checking the board wastes a
turn and tempts you to stop and ask "should I proceed?" — don't. Just call
`worker_next`.

You also do NOT create projects, epics, or tasks (`project_create`,
`epic_create`, `task_create`) — that is the planner role. If `worker_next`
returns null and the QUEUE_EMPTY probe confirms the project genuinely has no
claimable work, report that in one sentence and stop. Do not fabricate work.

## WORKTREE LIFECYCLE — isolation, merge-back, recovery

Several workers run in **one shared repository**. To stop file races, each task
runs in its **own git worktree** on branch `task/<id>`, off the integration
branch `dev`. saga records the linkage in `task.metadata.worktree`; you run the
git. **Never edit files in the shared checkout** — always in your worktree.

The convention (so the dispatcher and you agree without extra chatter):
- branch: `task/<id>`  (e.g. `task/42`)
- worktree path: `.worktrees/task-<id>`  (relative to repo root)
- integration branch: `dev`  (where approved work merges back)

### Bootstrap (once per project, before the first worktree)

If `git rev-parse --is-inside-work-tree` fails (the repo is not a git repo yet):

```bash
git init
git checkout -b dev
printf '.worktrees/\n' >> .gitignore   # worktrees must NOT be tracked
git add -A && git commit -m "chore: init integration branch"
```

Only one worker should do this — if a sibling raced you, `git rev-parse` will
now succeed for everyone (shared `.git`). Do NOT re-init.

### On CLAIM (worker_next gave you a `todo` task → `in_progress`)

Create your isolated workspace before touching any code:

```bash
git fetch . dev:dev 2>/dev/null          # make sure dev is current
git worktree add .worktrees/task-<id> -b task/<id> dev
cd .worktrees/task-<id>
# project setup (deps install) + run baseline tests — worktree starts clean
```

All your edits, builds, and tests happen **inside** `.worktrees/task-<id>`.
Stay there until the task is done.

### Parallel awareness — read `active_tasks[]`

Every `worker_next` and `worker_done` response carries `active_tasks[]`: a list
of every other task currently `in_progress` or `review`, with its `worker_id`,
`status`, **`branch`**, and `epic_name`. Before editing a file, glance at it —
if a sibling is in the same area/branch, you may collide at merge time. Use the
80% rule by default (proceed, note the overlap in a comment); only `worker_ask_need`
if the overlap makes your work genuinely impossible without a decision.

### DEV-DONE (worker_done, `in_progress → review`) — commit ONLY, do NOT merge

```bash
cd .worktrees/task-<id>
git add -A && git commit -m "task #<id>: <what you did>"
# run the project's tests/lint here — they must pass before you call worker_done
worker_done({ task_id, worker_id, result: "what I did; tests pass" })
```

**Do not merge into `dev` here.** The branch `task/<id>` with your commit is
exactly what the reviewer will diff. Merging now would land unreviewed code in
`dev` and defeat the whole point.

### REVIEW (`skill: "saga-reviewer"`)

You did NOT write this code. The change lives on `task/<id>`:

```bash
git diff dev...task/<id>          # clean per-task diff (three-dot)
# read criteria from task_get; run the task's tests by checking out task/<id>
# in a throwaway worktree, or in the dev's worktree if it still exists
```

Verdict via `worker_done` (task must be in `review_in_progress` — you claimed it
via `worker_next` from the `review` buffer):
- **APPROVED** → `worker_done({ task_id, worker_id, result: "APPROVED — <why>" })`.
  The task moves `review_in_progress → done`; its `metadata.worktree.merged_into`
  becomes `"pending"` (awaiting integration — see MERGE-BACK below).
- **CHANGES REQUESTED** →
  `worker_done({ task_id, worker_id, result: "CHANGES REQUESTED — <file:line — issue — fix>", verdict: "changes_requested" })`.
  The task moves `review_in_progress → in_progress` and is **re-assigned to you**;
  the `task/<id>` branch and its worktree are **untouched** and survive the re-work
  loop. Fix in the same worktree, commit, and dev-done again. Never recreate
  the branch on CHANGES REQUESTED.

### MERGE-BACK (after APPROVED — `done`, integrate into `dev`)

Only the worker who just got `completed_new_status === "done"` does this.
`stop:true` means **do not claim another task**; it does not skip this terminal
integration protocol. Acquire the repository-scoped merge-lock, merge to the
`integration_branch` returned with the assignment, release, and only then exit:

```bash
# 1. Acquire the lock — loop until granted (another worker may be mid-merge)
while true; do
  r=$(worker_merge_acquire({ task_id, worker_id }))   # returns {granted, held_by?, retry_after_ms?}
  if r.granted; then break; fi
  sleep $(( r.retry_after_ms / 1000 ))                # back off; do NOT spin tight
done

# 2. Merge your branch into dev (in the main checkout, not your worktree)
cd <repo root>
git checkout dev
if git merge --no-ff task/<id> -m "merge: task #<id> (approved)"; then
  sha=$(git rev-parse HEAD)
  git worktree remove .worktrees/task-<id>
  worker_merge_release({ task_id, worker_id, result: "merged", commit_sha: sha })
else
  git merge --abort                                  # leave dev clean
  worker_merge_release({ task_id, worker_id, result: "conflict" })
  # saga flags the task needs-human (pulses red); it STAYS done, worktree kept.
  # Do NOT attempt to resolve the conflict yourself — report and move on.
fi
```

For typed tasks the lock is per **product repository**, serialized in the shared
DB, so different repositories may merge concurrently. Legacy tasks retain the
project-level `dev` lock. If you crash mid-merge, the lock auto-expires after
10 minutes and a sibling can reclaim it.

### Zombie / orphan recovery (`worker_health`)

If you suspect a worker died holding a task (queue stalled, `active_tasks[]`
shows a task idle for ages), call
`worker_health({ project_id })`. It returns three lists:

- **zombies** — `in_progress` tasks idle > 30 min (a worker may have died holding them)
- **never_merged** — `done` tasks whose branch was never merged into `dev`
  (work that could be lost — the `merged_into` is null or `"pending"`)
- **stuck_merges** — `done` tasks whose merge conflicted (`merged_into: "conflict"`)

Recovery: inspect the worktree (`git worktree list`, `git log task/<id>`); if
it holds committed work, finish/merge it; if the worker is truly gone, free the
task with `worker_done({ result: "PARTIAL: <done, remains>" })`. **Never** `git
worktree remove --force` a worktree that may hold another worker's uncommitted
edits — confirm first.

## What "do the work" means — branch on the returned `skill`

The dispatcher's `skill` field tells you your role for THIS task:

### `skill: "saga-developer"` (task left `todo`, now `in_progress`)
Implement it — **in your worktree** (see WORKTREE LIFECYCLE: CLAIM).
1. `task_get({ id })` — description, comments (prior context), `depends_on`, subtasks (these are your DoD), `metadata.acceptance_criteria`. The acceptance criteria are the contract.
2. `cd .worktrees/task-<id>` and read the code at `source_ref` plus the project's `AGENTS.md` / conventions before editing.
3. Implement + write/update tests. **Run the project's tests/lint in the worktree before claiming done.**
4. Leave breadcrumbs via `comment_add` for anything non-obvious (a gotcha, a decision, why you took a path).

### `skill: "saga-reviewer"` (task was in `review` buffer, claim moved it to `review_in_progress`)
Verify it — you did NOT write this code. Diff the branch (see WORKTREE LIFECYCLE: REVIEW).
1. `task_get({ id })` — read description, `metadata.acceptance_criteria`, subtasks (DoD), and **every comment**. The developer's `result` is in the comments.
2. Find the actual change: `git diff dev...task/<id>` (clean per-task diff), or `activity_log({ entity_type:"task", entity_id:id })`.
3. Verify against criteria, not vibes. If `result` claims tests pass, run them (in the worktree). This is a real review.
4. **AC-assertion check (GUARDRAILS Sign 006):** If the task `implements` an AC
   (check via `trace_list({ target_type:'task', target_id:<id> })`), find that AC
   in the AC-document, identify the Given/When/Then with the **etalon numbers**,
   and verify the test **asserts exactly that** — not just "tests green", but
   "this test case asserts the AC's expected values". If the etalon is missing or
   the test asserts different values, that's `changes_requested` even if green.
   Example: AC-1 says `100000@12%/12m → 112682.50` — the test must `expect(...).toBe(112682.50)`
   or `toBeCloseTo(112682.50, 2)`, not just `>100000`.
5. Verdict via `worker_done` with `verdict: "approved"` or `verdict: "changes_requested"` and file:line specifics in `result`.

### AC-verification задачи (отдельная роль, после dev-review)

> GUARDRAILS Sign 006, `docs/ac-verification.md`. Planner создаёт эти задачи
> ПОСЛЕ dev-задач (см. saga-planner SKILL — "AC-verification задачи").

Когда `worker_next` выдаёт задачу с тегом `ac-verification` и `role:reviewer`,
это **содержательная** сверка AC (не обычная dev-review). Делай:

1. Прочитай AC из описания задачи (или через `artifact_get(<AC-id>)`) — там
   Given/When/Then с **эталоном** (например "100000@12%/12m → 112682.50").
2. Найди соответствующий тест в коде: grep AC-кода в тестах (`// AC-1` или test
   name содержит `AC-1`), или прямой вызов с эталонными входами.
3. **Прогон** — запусти конкретный test-case (или `node -e` с эталонным input).
4. **Сверка** — сравни фактический результат с эталоном. Числа должны совпадать
   (или `toBeCloseTo` в пределах precision из AC).
5. **Verdict:**
   - СОВПАЛО → `approved`, `trace_add(AC → this-task, verified_by)`, в result:
     "AC-<N> verified: <эталон> = <фактически> (test: <file>:<line>)".
   - НЕ СОВПАЛО → `changes_requested`, в result: "AC-<N> FAIL: expected <эталон>,
     got <фактически> (test: <file>:<line>) — dev-задача должна быть возвращена".
6. Если тест, на который ссылается AC, не найден → это тоже FAIL: AC не покрыт.

**Важно:** AC-verification задача не пишет код, не меняет тесты. Она только
**проверяет** соответствие. Если FAIL — возвращается dev-задача (через её
`changes_requested`), а не AC-verification задача.

## worker_done — the only way to finish a task

```
worker_done({ task_id, worker_id, result, verdict? })
```

- `result` is **honest**: failed tests, skipped steps, "couldn't verify X" included. The reviewer/human read it, not your confidence.
- `verdict` is only meaningful for a task in `review`: `"approved"` (default) or
  `"changes_requested"`. Omit it for the dev phase (in_progress→review).
- saga moves the task and returns `completed_new_status` + `active_tasks[]`.
  It does NOT return a next task — call `worker_next` to get one.
- **Do NOT call `task_update({status:...})` to move a task.** Status is the dispatcher's exclusive zone; `task_update` will silently ignore it and warn you. Only `worker_done` advances status.

### Two-phase completion (IMPORTANT — this is how review works)

Statuses around review:
- `review` = **buffer** (ждёт ревьюера, `assigned_to=null`) — это очередь.
- `review_in_progress` = ревьюер взял и работает (`assigned_to=reviewer`).

Every task goes through **two** `worker_done` calls:

1. **Dev phase** (task was `todo`, you claimed it → `in_progress`): you implement
   **in your worktree**, commit (no merge), then
   `worker_done({ task_id, worker_id, result: "what I did" })`. saga moves it to
   `review` buffer (assigned_to cleared) AND returns `stop: true` — you MUST stop
   here, return your summary, and end this launch. The orchestrator spawns you
   again for the next task (which may or may not be this same task's review).

2. **Review phase** (task is in `review` buffer): when the dispatcher hands it to
   you via `worker_next` (with `skill: "saga-reviewer"`), claiming it moves the
   task from `review` → `review_in_progress` (`assigned_to=you`). Then you review
   and deliver a verdict via `worker_done`.

   **You can ONLY deliver a verdict on a task you claimed** — `worker_done`
   expects status `review_in_progress`. There is no "direct close a free review
   task" path anymore: you must `worker_next` it first. (Old Path B was removed
   when `review` became a pure buffer.)

   `result` is the verdict text; `verdict` selects what happens next:

   | verdict | status change | branch/worktree | then |
   |---|---|---|---|
   | `"approved"` (default) | `review_in_progress → done` | kept (merged later) | **MERGE-BACK** (see WORKTREE LIFECYCLE): acquire the repository lock, merge `task/<id>` into its `integration_branch`, release. Typed downstream dependencies unblock only after successful release; conflict sets `needs-human`. |
   | `"changes_requested"` | `review_in_progress → in_progress` | **untouched — survives** | you are now the dev again: fix in the SAME worktree (`task/<id>`), commit, dev-done again. Do NOT recreate the branch. |

   Either verdict returns `stop: true` — end the launch after the merge-back (or
   directly on changes_requested).

**Solo worker pattern (you are the only agent):** after your dev-phase
`worker_done` puts the task in `review` buffer, you MUST stop (the response says
so). On the next launch, `worker_next` will hand the same task back to you with
`skill: "saga-reviewer"` (FIFO) — claim it, self-review, deliver verdict. Do not
try to close it from the same launch as the dev-phase.

**Multi-worker pattern:** the developer's `worker_done` puts the task in
`review`; another worker's `worker_next` will hand it out with
`skill: "saga-reviewer"`; that worker reviews and delivers the verdict via
`worker_done`.

> Real failure this prevents: an agent called `worker_done` (→ review), then
> tried `task_update({status:"done"})` (ignored) and a second `worker_done`
> (rejected under old code). The task hung in review. The fix (#59) lets the
> second `worker_done` through on a free review task; and Path A (worker_next
> → reviewer) works regardless. Either way, close the review — don't stall.

## AUTONOMY — do not ask to continue (and NEVER go zombie)

This is critical. You are one of potentially many workers; humans are not
watching each step.

- After `worker_done` completes a task, **return your one-line summary and STOP.** Do NOT call `worker_next` again in this launch — the orchestrator spawns you again for the next task. Do not ask *"should I continue?"*, *"want me to take this?"*, *"shall I review the previous task first?"*. None of that. One launch = one task.
- **Task size / complexity is NOT a reason to ask.** A task being large, long, or open-ended research does NOT license a check-in. Work it to completion (or to a genuine block — see ASK flow). "This is a big task, want me to keep going?" is the #1 wrong question — the answer is always yes, so don't ask.
- **NEVER end a turn holding a task.** If you are holding a task (it's `in_progress`, assigned to you), you MUST finish it via `worker_done` before this conversation ends. Holding a task and stopping = a **zombie** (the task is locked, no other worker can take it, nothing happens). This is the worst failure mode. If you must stop mid-task: call `worker_done` with `result: "PARTIAL: <what's done, what remains>"` so the task is freed and the next worker can pick up the comment trail. Do NOT leave `in_progress` tasks dangling.
- The ONLY times you address the human:
  1. **Queue genuinely empty** (Step "QUEUE_EMPTY" below) → report and stop.
  2. **You are blocked and need an answer** → use the ASK flow (below).
  3. **Genuine ambiguity with zero reasonable interpretation** → see "Ambiguity" below.

### Ambiguity — the 80% rule
Most "clarifications" are laziness, not real doubt. Default to action:
- If **~80%+ clear** → do the most reasonable interpretation, **record your assumption in a `comment_add`** ("Assumed X because Y; revert if wrong"), and proceed. Stopping to ask costs more than a reversible assumption.
- Only if **genuinely 0 usable information** (e.g. task references a file that doesn't exist and no interpretation makes sense) → use the ASK flow.

## QUEUE_EMPTY — verify before you declare "done"

When `worker_next` returns `{task: null}`:

**Do NOT immediately announce "all done".** An empty result has multiple causes —
all tasks done, all blocked, all `low` priority, OR you resolved the wrong
project. Run this probe:

```
task_list({ epic_id: <any epic in your project>, limit: 50 })   # or tracker_dashboard({project_id})
```

- **≥1 task exists in any status** → the project is real, just idle. This is genuine DONE. Report in 2 sentences: what you completed, that the queue is verified empty. Stop.
- **0 tasks / product looks wrong** → re-check the runner assignment or
  `.saga/project.json`; use `projectname.txt` only for a legacy checkout.

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

- **Project identity comes from the dispatcher or `.saga/project.json`.**
  `projectname.txt` is legacy fallback only. With no authoritative binding,
  hard stop and ask the user; never infer a product from the folder name.
- **worker_id**: use exactly the id you were given (e.g. `agent-1`). It is how the board shows who does what.
- **One task at a time.** Only the task whose `assigned_to` == your `worker_id` is yours.
- **Never hold two tasks at once.** You get a task via `worker_next`, finish it via `worker_done`, then STOP — return your summary. The next task comes from a fresh `worker_next` on your next launch (the orchestrator spawns you again), never from `worker_done` (it no longer returns one).
- **Never go zombie.** If you hold a task (`in_progress`, assigned to you), you MUST close it with `worker_done` before stopping. Holding a task and stopping locks it forever — no other worker can take it. If you must stop mid-task: `worker_done` with `result: "PARTIAL: <done so far, what remains>"` to free it. A partial close is always better than a zombie.
- **Never create projects/epics/tasks** (`project_create`, `epic_create`, `task_create`) — that is the planner role, not yours. This applies ALWAYS, including when the project looks empty or you "want to have something to do". Empty project → report and stop.
- **Never move status yourself** (`task_update({status})`) — it's ignored; use `worker_done`.
- **Every task runs in its own worktree** (`.worktrees/task-<id>`, branch `task/<id>`). Do NOT edit files in the shared checkout — that races siblings. Bootstrap git once if the repo isn't initialized yet (see WORKTREE LIFECYCLE: Bootstrap).
- **Merge only after APPROVED.** `dev` receives `task/<id>` exclusively at the `review→done` transition, through the merge-lock (`worker_merge_acquire`/`release`). Never merge unreviewed code; never merge without holding the lock.
- **Never recreate the branch on CHANGES REQUESTED.** The `task/<id>` worktree survives — fix in place and commit again.
- **Never `git worktree remove --force`** a worktree that may hold another worker's uncommitted work. Use `worker_health` to find orphans and confirm before cleanup.
- **You may** `task_get` (read), `comment_add` (breadcrumb), `note_save` (decision) on tasks — these are side-effects on owned work or read-only, not work-stealing.
