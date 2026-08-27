# core-view-ek

Пассивный наблюдатель за НОВЫМ событийным ядром — апгрейд минимального
`ek-fronts/core-view` до информационной плотности legacy-фронтов, в тёмной
теме legacy board-render.

Порт по умолчанию: **4323** (`CORE_VIEW_PORT` / `PORT`), bind `127.0.0.1`.

## Железные правила (унаследованы от legacy core-view SPEC)

- better-sqlite3 СТРОГО `readonly:true`;
- открытие БД **на каждый запрос** (нет долгоживущих хэндлов);
- **ни одной записи**; работает и против живой qualification DB;
- resolve зависимостей: `createRequire('file://D:/Development/saga-mcp-SAGA4/package.json')`.

## Запуск

```bash
CORE_VIEW_DB=D:/Development/ek-qual-evidence/<run>/R2/kernel/kernel.sqlite \
PORT=4323 \
node server.mjs
```

## Endpoint-ы

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/snapshot` | счётчики + головы `*_run` + карточки work item с lane (SQL-зеркало `deriveLane`) |
| GET | `/api/obligations` | реестр по видам (kind × state) + открытый список с target/aggregate |
| GET | `/api/waits` | панель ожиданий: pending (с wake-командами) + закрытые |
| GET | `/api/events?limit=N` | хроника `workflow_event` (kind/transition/status) |
| GET | `/api/tree` | дерево конвейера: factory > lifecycle > stage > process > node + цеха + work items |
| GET | `/api/proofs` | терминальные доказательства |
| GET | `/` | UI: вкладки Цеха / Конвейер / Обязательства / Ожидания / Хроника / Доказательства |

## Заметки

- Lane выводится тем же порядком прецедента, что в
  `workflow-kernel/projection/cards.js` (`terminal > waiting > repair >
  review > in-progress > todo`); repair/review-семейства статусов
  скопированы из того же файла.
- Дерево конвейера: родительских колонок в `*_run` головах нет — иерархия
  строится по `first_sequence` (первое появление инстанса в
  `workflow_event`) и структурному рангу агрегата. Это display-grouping
  закоммиченных фактов, не отдельная истина.
- Heartbeat: в ядре нет таймстампов — пульс по росту `MAX(sequence)`
  журнала между опросами (5с).
