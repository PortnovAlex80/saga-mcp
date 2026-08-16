# core-view — пассивный наблюдатель за заводом (порт 4323)

Read-only проекция завода saga-mcp: lifecycle, workplaces, обязательства
переходов, гейты, воркеры и хроника — всё из той же SQLite-БД, без единой
записи и без правок рантайма. Дизайн: `docs/design/FACTORY-CORE-VIEW.md`,
контракт API: `core-view/SPEC.md`.

**PROJECTION — наблюдение, не авторитет.**

## Запуск

```bash
node core-view/server.mjs        # из корня репо (работает из любого cwd)
```

- URL: `http://127.0.0.1:4323` (bind строго 127.0.0.1)
- Порт: env `CORE_VIEW_PORT` (поддерживается `0` — ephemeral, для тестов)
- БД: `.factory-testbed/factory.sqlite`, переопределяется env `CORE_VIEW_DB`
- Корни логов воркеров: `~/.zcode/cli/board-runs` (+ env `CORE_VIEW_LOG_ROOT`)
- PID-файл: `core-view/.core-view.pid` (пишется на старте, удаляется на выходе;
  второй живой инстанс не стартует)
- Зависимости: только `better-sqlite3` из корневого `node_modules`, чистый ESM

## Самопроверка

```bash
node core-view/smoke.mjs
```

Поднимает сервер на ephemeral порту (НЕ 4323), дёргает все эндпоинты, печатает
сводку и выходит. Если БД нет — проверяет деградацию `{ok:false,error}` (200).

## API (только GET; все ответы `{ok:true,...}` либо `{ok:false,error}`)

| Эндпоинт | Назначение |
|---|---|
| `GET /api/core/heartbeat` | `{ok, now, db:{path,exists}, projects:n}` |
| `GET /api/core/projects` | сводка всех проектов для L0 |
| `GET /api/core/snapshot?project=<id>` | ядро для L1; без `project` — последний активный (max heartbeat) |
| `GET /api/core/events?since=<ISO>&limit=200` | хроника L3 (оверлап 5с, дедуп по `key` на клиенте) |
| `GET /api/core/cell?workplace=<ref>` | детали ячейки L2 (+ `logTail` хвоста JSONL) |

Если БД недоступна — любой эндпоинт отвечает `{ok:false,error}` с кодом 200.

## Архитектура файлов

| Файл | Роль |
|---|---|
| `server.mjs` | node:http, роутинг, статика public/ (MIME-whitelist + traversal guard), PID-файл |
| `core-snapshot.mjs` | общие хелперы (`withCoreDb` readonly-per-request, `parseTs`/`toIso`) + сборка snapshot |
| `core-projects.mjs` | `/api/core/projects` + `/api/core/heartbeat` |
| `core-events.mjs` | `/api/core/events` — merge activity_log + gates + transitions |
| `core-cell.mjs` | `/api/core/cell` — кандидаты, гейты, executions, recovery, effects, logTail |
| `log-tail.mjs` | `isProcessAlive`, mtime/tok-s по JSONL, хвост лога (контейnement под board-runs) |
| `smoke.mjs` | самопроверка на ephemeral порту |
| `public/` | фронтенд (исполнители B/C) — серверу достаточно, что папки нет: статика отдаст 404 |

## Нормализация времени

В БД два формата: `YYYY-MM-DD HH:MM:SS` (UTC без T/Z — локальные таблицы) и
ISO-Z (`worker_executions.heartbeat_at`, `factory_candidate_sets.sealed_at`).
Все ответы отдают единый ISO-Z. Строчные сравнения форматов в SQL не
используются (это источник tz-багов) — только парсинг в JS.

## Расхождения SPEC ↔ живая БД (контракт полей не менялся)

Найдено выборками (readonly) против `.factory-testbed/factory.sqlite`:

1. **projects → lifecycle**: `factory_order_runs` пуста (0 строк) — join из
   экспресс-проверки №4 WORKSHOP-STATUS.md даёт NULL. Реальная связь —
   `factory_orders.lifecycle_run_id`; snapshot/projects берут последний рун
   проекта (`max(factory_lifecycle_runs.id)`), что на живых данных совпадает
   с руной актуального ордера.
2. **`factory_workplace_dependencies`**: колонок `from`/`to` нет; реальные —
   `workplace_ref` (зависимый) и `depends_on_workplace_ref` (предшественник).
   Отдаём `{from: depends_on_workplace_ref, to: workplace_ref}`. Рёбра с
   внешним по отношению к проекту концом не включаются (лента L1 рисует DAG
   только из станций проекта).
3. **`obligation.kind`** ← `factory_transition_obligations.handoff_kind`
   (реальные значения: `run-gate`, `run-effects`, `route-lifecycle`,
   `record-final-acceptance`, `settle-process`, `close-presentation` —
   информативнее абстрактного «transition» и не меняет форму поля).
4. **`obligation` = null**: берётся последняя по `updated_at` запись с
   `state != 'completed'` — completed-долг означает «обязательства нет»,
   что и должен подсвечивать фронт как отсутствие лампы.
5. **task ↔ workplace**: цепочка из SPEC
   (`worker_executions.task_id → factory_workplace_graph_items.task_id →
   workplace_ref`) покрывает на живой БД ТОЛЬКО implementation-графы (7 строк);
   например `workplace/41/.../development-plan-task-graph/singleton` (task 71,
   4 executions) в graph_items отсутствует. Каноническая связь — колонка
   **`tasks.workplace_ref`**: она и используется как основная, graph_items —
   fallback. `worker_executions` не имеет колонки `id` — порядок по `rowid`.
   Живые состояния: `running`, `cancel_requested` (SPEC) + `reserved`
   (активное состояние рантайма) — передаётся как есть в поле `state`.6. **`recovery`/`effects`**: `factory_recovery_cases` и
   `factory_external_effect_actions` в тестбеде пустые (норма, `[]`);
   `factory_cell_effect_receipts` (57 строк) не пустая — отдаётся как effects
   с `receipt:true`, `kind` = `effect_id` (провайдера «git» в таблице нет).
   `caseRef` для recovery собирается как `recovery-case:<id>` (колонки
   case_ref в таблице нет); связи actions↔workplace нет — джойн по
   `(process_run_id, module_ref_key)`, best effort.
7. **Счётчики snapshot** (`counters`) считаются в рамках выбранного проекта
   (capsules имеют `project_id`, остальное — через множество workplaces
   проекта), а не по всей БД: пример в SPEC содержит тоталы всего тестбеда,
   для `?project=` это было бы некорректно.
8. **`logTail.ts`**: stream-json JSONL не содержит пер-строчных таймстампов —
   `ts` почти всегда `null`, уровень и текст выводятся из типа события
   (`assistant`/`system`/`result`/raw) с fallback на сырую строку.

## Безопасность

- БД: `better-sqlite3` `{readonly:true}`, открытие на каждый запрос, бэкапы
  `*.bak-*` не открываются никогда.
- Логи: чтение только путей под разрешёнными корнями (traversal guard).
- Статика: whitelist MIME (`html,css,js,mjs,json,svg,png,ico`), containment +
  realpath-проверка, только `public/`.
- Только GET; write-эндпоинтов не существует.
