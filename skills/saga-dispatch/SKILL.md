---
name: saga-dispatch
description: Dispatch-loop orchestrator — запускает воркеров в цикле до пустой очереди. Использовать когда нужно прогнать эпик/проект от начала до конца.
---

# Saga Dispatch — orchestrator loop

## Flow position (saga-flow)

## Product-board contract

Dispatch exactly one logical `project_id`. Tasks select their physical workspace
through `project_repository_id`; do not dispatch a separate builders project.
The board runner supplies the product and machine checkout. A fresh CLI process
handles one task and exits permanently.

- **Stage:** 6-Execution loop (после planning, до AC-verification)
- **Precondition:** dev-задачи в очереди (todo/review). Проверь: `task_list({project_id, status:['todo','review']})` → не пусто.
- **Postcondition:** очередь пуста (все dev-задачи done+merged). AC-verification задачи могут остаться.
- **Called by:** saga-orchestrator (Этап 6)
- **Next enables:** AC-verification задачи (продолжение dispatch loop), затем INTEGRATE
- **Проверь precondition:** если очередь пуста → сообщи "queue empty", не запускай воркеров впустую.
- **Это SUB-loop оркестратора** — покрывает только execution-фазу, не весь флоу (для всего = saga-orchestrator).

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

## Критерий остановки

**Единственный способ остановиться** — `task_list` вернул 0 задач в statuses
`todo` и `review`. Не останавливайся после одного раунда. Не останавливайся
если воркеры вернули `stop:true` — это нормально, это значит «я закончил свою
задачу, дай мне следующую».

Если после раунда остались задачи в `in_progress` или `review_in_progress`
но нет `todo`/`review` — это значит воркеры ещё работают или ждут review.
Подожди и проверь ещё раз (это может быть merge conflict с `needs-human` —
тогда остановись и сообщи пользователю).

## Parallel awareness

- При запуске N воркеров — запускай их **одним сообщением** с несколькими
  Agent-вызовами. Это настоящая параллельность.
- Каждый воркер получает уникальный `worker_id` (префикс-раунд-номер).
- Воркеры сами разбирают кто что делает через `worker_next` — оркестратор НЕ
  назначает задачи вручную.

## Статус-отчёт

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
