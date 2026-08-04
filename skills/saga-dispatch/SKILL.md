---
name: saga-dispatch
description: Dispatch-loop orchestrator — запускает воркеров в цикле до пустой очереди. Использовать когда нужно прогнать эпик/проект от начала до конца.
---

# Saga Dispatch — orchestrator loop (цикл оркестратора)

## Flow position (saga-flow — позиция в потоке)

## Product-board contract (контракт продуктовой доски)

Dispatch exactly one logical `project_id`. Tasks select their physical workspace
through `project_repository_id`; do not dispatch a separate builders project.
The board runner supplies the product and machine checkout. A fresh CLI process
handles one task and exits permanently.

(Диспетчеризируй ровно один логический `project_id`. Задачи выбирают своё
физическое рабочее пространство через `project_repository_id`; не запускай
отдельный проект сборщиков. Runner доски предоставляет продукт и машинную
checkout-копию. Свежий CLI-процесс обрабатывает одну задачу и завершается
навсегда.)

- **Stage (этап):** 6-Execution loop (цикл выполнения; после planning, до AC-verification)
- **Precondition (предусловие):** dev-задачи в очереди (todo/review). Проверь: `task_list({project_id, status:['todo','review']})` → не пусто.
- **Postcondition (постусловие):** очередь пуста (все dev-задачи done+merged). AC-verification задачи могут остаться.
- **Called by (вызывается):** saga-orchestrator (Этап 6)
- **Next enables (что разблокирует):** AC-verification задачи (продолжение dispatch loop), затем INTEGRATE
- **Проверь precondition:** если очередь пуста → сообщи "queue empty" (очередь пуста), не запускай воркеров впустую.
- **Это SUB-loop (под-цикл) оркестратора** — покрывает только execution-фазу (фазу выполнения), не весь флоу (для всего = saga-orchestrator).

Ты — оркестратор. Твоя единственная работа: **запускать saga-worker агентов
циклично, пока очередь не пуста**. Ты НЕ делаешь работу сам, ты НЕ пишешь код,
ты НЕ создаёшь задачи. Ты раздаёшь работу и ждёшь результатов.

## Когда использовать

- Пользователь говорит «запусти разработку», «прогоним до конца», «отработай эпик»
- Нужно выполнить все todo/review задачи в эпике или проекте
- Фаза разработки после того, как requirements готовы (PRD/SRS/UC/AC)

## Входные данные

Перед запуском определи:

1. **project_id** — from the board runner or `.saga/project.json`;
   `projectname.txt` is legacy fallback only.
2. **worker_count** (по умолчанию 3) — сколько параллельных воркеров запускать
   за раунд. Если задач мало (< worker_count) — запускай по числу задач.
3. **worker_id_prefix** — префикс для воркеров (например `dev` → `dev-1`,
   `dev-2`, `dev-3`).

## Алгоритм (строго соблюдай)

```
resolve project_id                          ← один раз

round = 0
while true:
  round += 1

  // 1. Проверяем — есть ли вообще задачи для раздачи?
  // worker_next пробный вызов от фиктивного воркера НЕ делаем.
  // Вместо этого смотрим dashboard или task_list.
  remaining = task_list({ project_id, epic_id?, status: ["todo","review"] })
  if remaining пуст:
    report("✅ Queue verified empty after round {round}. All work dispatched.")
    break

  // 2. Запускаем воркеров параллельно
  tasks_in_flight = min(len(remaining), worker_count)
  for i in 1..tasks_in_flight:
    spawn Agent(
      subagent_type: "saga-worker",
      worker_id: "{prefix}-{round}-{i}",
      prompt: "Рабочая директория: {cwd}. project_id={project_id}. Один цикл worker: worker_next → работа → worker_done. Работай в D:/Development/deposit-calc."
    )

  // 3. Ждём ВСЕХ воркеров текущего раунда
  // (Agent tool дождётся каждого, т.к. run_in_background=false)
  collect results

  // 4. Логируем статус раунда
  note = "Round {round}: {N} workers completed. Tasks done: {list}. Queue remaining: {count}"
  report(note)

  // 5. Повторяем — возвращаемся к шагу 1
```

## Completion contract (контракт завершения делегирования)

<!-- source: EXT-1 https://github.com/obra/superpowers -->

For one dispatched saga-worker, the dispatch loop treats exactly two outcomes
as terminal. There is no third state — a worker is either **returned** or
**terminal non-result**. Map each to our primitives (not to superpowers' four
status words).

(Для одного запущенного saga-worker оркестратор различает ровно два исхода.
Третьего состояния нет — воркер либо **вернул результат**, либо ушёл в
**терминальный не-результат**. Каждое состояние мапится на наши примитивы,
не на статусные слова superpowers.)

### Returned result (воркер вернул результат) — `worker_done`

A worker that holds a task and reaches a stopping point MUST call `worker_done`.
That single call is the delegation's returned result. The call carries:

- **`verdict=approved`** — review passed; for a typed `git_change` task this
  records `integration_state=pending` (merge still gated by
  `worker_merge_acquire`/`worker_merge_release`).
- **`verdict=changes_requested`** — only valid on a task in `review_in_progress`;
  returns it to the unassigned `todo` queue for a fresh developer execution.
- **`result` text** — recorded as a comment (author = `worker_id`).

`worker_done` always carries `stop:true` and clears `assigned_to`. This is the
normal per-task completion signal: the worker finished ITS task and exited. It
is NOT a dispatch-loop stop signal — the next `task_list` check decides whether
another round runs.

<!-- source: EXT-1 https://github.com/obra/superpowers -->
superpowers frames this as the implementer reporting DONE/DONE_WITH_CONCERNS
with a commit list and test summary, then a separate task-reviewer verdict. We
collapse both into the single `worker_done` call (verdict field) because in
CGAD the worker IS the typed execution unit and `worker_merge_release` is the
authoritative integration verdict — there is no parallel reviewer subagent the
dispatcher spawns.

### Terminal non-result (терминальный не-результат) — `worker_ask_need` / crash

A worker that cannot reach `worker_done` falls into one terminal non-result
path. The dispatcher MUST treat both as "no result will come from this worker"
and MUST NOT block the loop waiting.

<!-- source: EXT-1 https://github.com/obra/superpowers -->
superpowers calls this BLOCKED and lists: provide more context and re-dispatch,
re-dispatch on a more capable model, break the task into smaller pieces, or
escalate to the human. We keep ONLY the escalate-to-human branch and DROP the
self-re-dispatch branches — they would let a worker authorize its own retry or
degradation, violating CGAD's no-self-authorization invariant.

1. **`worker_ask_need` (Slice 3 ADR-011) — TERMINAL park for human input.**
   The call persists the question + resume context, opens a `human_request`,
   releases the execution, **terminalizes the worker process**, and clears
   `assigned_to`. The task returns to its queue only once a human answers via
   `worker_ask_done`; a fresh worker picks it up later. The dispatch loop sees
   `stop:true` and MUST treat it as terminal: do NOT re-poll the same worker,
   do NOT wait for a `worker_done` that will never arrive. The task is now
   gated behind human input, not behind this worker.

   This is the explicit reconciliation with reality: `worker_ask_need` is a
   hard terminalization, not a wait. A dispatch loop that sleeps on a
   `worker_ask_need`'d worker waits forever — the worker process is gone.

2. **Crash / lost worker** — the worker process died without calling either
   `worker_done` or `worker_ask_need`. The task is left in `in_progress` with
   a stale `assigned_to`. The dispatcher detects this via `worker_health`:
   zombies = `in_progress` tasks idle > 30 min. Treatment: report the zombie
   to the human; do NOT auto-reassign (a human decides whether the worktree
   holds salvageable work). Saga never deletes the worktree.

### How dispatch treats each (как оркестратор обрабатывает каждый исход)

| Outcome (исход) | Primitive | Task state after | Dispatch action (действие) |
|---|---|---|---|
| Returned — approved | `worker_done(verdict=approved)` | `done` (typed: `pending` merge) | Continue loop; next `task_list` may re-enter |
| Returned — changes requested | `worker_done(verdict=changes_requested)` | back to `todo` | Continue loop; task is reclaimable by a fresh worker |
| Terminal — needs human | `worker_ask_need` | parked, `needs-human` tag pulses | Continue loop on OTHER tasks; surface the parked task in the status report; do NOT wait on it |
| Terminal — crash | (no call) | `in_progress` + stale `assigned_to` | Run `worker_health`; report zombie; do NOT auto-reassign |

<!-- source: EXT-1 https://github.com/obra/superpowers -->
superpowers' continuous-execution rule ("execute all tasks without stopping;
the only reasons to stop are BLOCKED you cannot resolve, ambiguity that
genuinely prevents progress, or all tasks complete") maps onto our stop
criterion below: keep dispatching while `task_list` has `todo`/`review`, and
stop only when the queue is empty or every remaining task is gated behind
human input (`needs-human`) or a stuck worker.

## Критерий остановки

**Единственный способ остановиться** — `task_list` вернул 0 задач в statuses
`todo` и `review`. Не останавливайся после одного раунда. Не останавливайся
если воркеры вернули `stop:true` — это нормально, это значит «я закончил свою
задачу, дай мне следующую» (см. Completion contract выше: `stop:true` — это
нормальный returned result от `worker_done`, либо терминальный non-result от
`worker_ask_need`; в обоих случаях воркер завершён, ждать его не надо).

Если после раунда остались задачи в `in_progress` или `review_in_progress`
но нет `todo`/`review` — это значит воркеры ещё работают, ждут review, либо
воркер ушёл в терминальный non-result (`worker_ask_need` / crash). Подожди и
проверь ещё раз. Если задача висит в `in_progress` с тегом `needs-human` или
стабильным `assigned_to` > 30 мин — это merge conflict или потерянный воркер;
остановись и сообщи пользователю (не авто-переопределяй).

## Parallel awareness (параллельное выполнение)

- При запуске N воркеров — запускай их **одним сообщением** с несколькими
  Agent-вызовами. Это настоящая параллельность.
- Каждый воркер получает уникальный `worker_id` (префикс-раунд-номер).
- Воркеры сами разбирают кто что делает через `worker_next` — оркестратор НЕ
  назначает задачи вручную.

## Статус-отчёт (статусный отчёт)

Каждый раунд — краткий отчёт пользователю:

```
Round 1: 3 workers → tasks #199 ✅ #200 ✅ #201 ✅ (review→done→merge)
Round 2: 3 workers → tasks #202 ✅ #203 ✅ #204 ⚠️ conflict
Round 3: 2 workers → tasks #205 ✅ #206 ✅
...
Round N: queue empty ✅
```

Если есть `needs-human` задачи (merge conflict) — упомяни их в отчёте
но НЕ останавливай цикл (остальные задачи продолжают выполняться).

## Что НЕ делать

- НЕ вызывай `worker_next` / `worker_done` сам — это зона воркеров
- НЕ создавай задачи / эпики / артефакты — это зона planner/product
- НЕ модифицируй статусы через `task_update` — это зона dispatcher
- НЕ делай код — ты оркестратор, не разработчик
- НЕ останавливайся после первого раунда (если очередь не пуста)
- НЕ запускай воркеров если task_list показывает 0 todo/review задач
