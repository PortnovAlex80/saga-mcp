# Development Module Refactor — выровнять на принцип конвейера

## Проблема

Development — единственный модуль с `external`-узлами, которые **сами нанимают
рабочих** (`runScopedTasks` / `workerExecutorFactory` внутри
`SqliteDevelopmentRuntime`). Это нарушает принцип:

> Рабочий умеет делать работу из своего скилла. Всё.
> Рабочих нанимает инфраструктура. Количество — через `--concurrency=N`.
> Tasks из todo+review разбираются N рабочими. Точка.

Discovery и Formalization — чистые: lm+kernel, infrastructure нанимает.
Development — 3 external-узла с самонаймом.

## Принцип (из CONVEYOR-MENTAL-MODEL.md)

Все цеха = одинаковые рабочие места (lm+kernel) + разные навыки (скиллы).
External-узлы с самонаймом — нарушение. Concurrency — одно место (`--concurrency=N`).
Очередь — одна (review первые, потом todo).

## Текущая структура (неправильная)

```
plan (lm) → resolve (kernel) → execute-workset (external/!) → integrate (external/!) → verify (external/!) → settle (kernel)
                                   ↑ сам нанимает              ↑ сам нанимает          ↑ сам нанимает
```

External-узлы: `execute-implementation-workset`, `integrate-release-candidate`,
`verify-acceptance-workset`. Каждый вызывает `SqliteDevelopmentRuntime` который
через `runScopedTasks` сам spawn'ит воркеров.

## Целевая структура (правильная)

```
plan (lm) → resolve (kernel) → [20 impl tasks → todo kanban] → settle (kernel)
                                    ↑
                          инфраструктура разбирает через --concurrency=N
                          (как ЛЮБЫЕ задачи, через worker_next)
```

- impl-задачи — обычные kanban tasks, рабочие берут через `worker_next`
  (скилл `saga-worker`)
- integration — git merge, либо рабочий на месте, либо kernel step
- verification — отдельные verification-задачи на kanban, или kernel step
- `workerExecutorFactory` **уходит** из `SqliteDevelopmentRuntimeOptions`
- concurrency — только `--concurrency=N`
- merge/конфликты — работа с файлами, рабочий решает (не отдельный механизм)

## Что меняется

| Элемент | Сейчас | Станет |
|---|---|---|
| execute-implementation-workset | external (sam найм) | lm-узлы (impl tasks на kanban, инфра нанимает) |
| integrate-release-candidate | external (sam найм) | kernel step или git-merge задача |
| verify-acceptance-workset | external (sam найм) | kernel step или verification-задачи |
| workerExecutorFactory в runtime | да (нарушение) | нет (убрать) |
| runScopedTasks | в модуле | удалить |
| concurrency | 3 места | 1 (`--concurrency=N`) |

## Что НЕ меняется

- Планировщик (`plan-task-graph`) — тот же
- Инженер (`resolve-task-graph`) — тот же
- Settlement (`settle-development`) — тот же
- Centralized nodeProducts — уже работает
- Skills (saga-worker, saga-planner) — те же

## Порядок

1. Убрать `workerExecutorFactory` / `resolveWorkerContext` / `runScopedTasks`
   из `SqliteDevelopmentRuntime`.
2. Заменить 3 external-узла на lm-узлы (impl) + kernel-шаги (integrate/verify),
   либо на kanban-task projection (impl tasks в todo, инфра разбирает).
3. development-runtime SPI — только декларативные порты
   (taskGraph/settlementState/outputRepository), никаких исполнительских.
4. Проверить: formalization-подобная структура (lm+kernel, recovery, skills).
5. Smoke run: development проходит (не blocked).
