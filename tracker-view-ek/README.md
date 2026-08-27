# tracker-view-ek

Клон legacy доски трекера (saga-mcp `tracker-view` + `board-render.mjs`) на
**новом событийном ядре** (`saga-mcp-SAGA4/dist/workflow-kernel`).
Портирован визуальный язык старой доски (тёмная тема, колонки, карточки с
значками, пульс needs-human, чипы-фильтры, heartbeat, summary-хедер) и
полностью заменён слой данных: колонки = лейны проекции нового ядра
(`todo / in-progress / review / repair / waiting / terminal`), карточка =
`work_item` + состояние его `Workplace`, значки = открытые обязательства и
pending-ожидания.

Порт по умолчанию: **4330** (`PORT`). Bind: `127.0.0.1`.

## Два режима

### SAFE (только чтение) — для ЖИВЫХ qualification DB

```bash
TRACKER_DB=D:/Development/ek-qual-evidence/<run>/R2/kernel/kernel.sqlite \
TRACKER_READONLY=1 \
PORT=4330 \
node server.mjs
```

- Композиция ядра НЕ поднимается; БД открывается на каждый запрос строго
  `better-sqlite3 { readonly: true }` (железное правило core-view).
- Доска собирается SQL-зеркалом `projector.factsOfItem + cards.deriveLane`
  (порядок прецедента: terminal > waiting > repair > review > in-progress >
  todo; binding work-item → workplace из durable `workplace_work_intent`).
- Кнопки команд скрыты; консольные endpoint-ы (`/api/command`,
  `/api/projection/rebuild`, …) отвечают типизированным отказом
  `SAFE_READONLY_MODE` (HTTP 403).
- **Ни одного байта записи в БД.**

### LIVE (полный) — только для РАБОЧИХ КОПИЙ kernel.sqlite

```bash
TRACKER_DB=D:/Development/tracker-demo/kernel-r2.sqlite \
PORT=4330 \
node server.mjs
```

- Поднимается полная композиция: `composeProduction` +
  `consoleAdapterDeps` (как в минимальном `ek-fronts/tracker-view`).
- Сервер сам подставляет env для armed-композиции, если их нет:
  `SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"`
  (opencode shim; claude CLI запрещён) и
  `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- При старте, если проекция (`kanban_card`) пуста, один раз выполняется
  `POST /api/projection/rebuild` (проекция одноразовая по построению —
  авторитетный журнал событий не меняется).
- Доска читает `/api/kanban`-проекцию (через `/api/board`); запись —
  ТОЛЬКО типизированные команды `POST /api/command`
  (`claim | review | stop | resume | retry | human-response`, закрытый
  словарь адаптеров; запрещённые поля payload отбрасываются ядром).

**НИКОГДА не запускай LIVE против DB под `ek-qual-evidence/`** —
композиция открывает БД на запись.

## Endpoint-ы

Собственные (оба режима):

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/board` | карточки доски (унифицированная форма) |
| GET | `/api/summary` | счётчики для summary-хедера |
| GET | `/api/heartbeat` | голова журнала (seq) для пульса |
| GET | `/api/events?limit=N` | хроника (вкладка «Мир», readonly SQL) |

Консоль ядра (только LIVE; в SAFE — отказ 403 `SAFE_READONLY_MODE`):

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/kanban` | одноразовая проекция (cards) |
| GET | `/api/world` | мир: heads / obligations / waits / proofs |
| GET | `/api/identity` | состав workshop-ов + route pin |
| POST | `/api/projection/rebuild` | перестроить проекцию из фактов |
| POST | `/api/command` | ЕДИНСТВЕННАЯ поверхность записи |

Статика: `/` (index.html).

## Что взято из legacy доски, что переписано

Взято (дословно CSS-блоки из `page()` старого board-render.mjs): тёмная
палитра `#0d1117/#161b22/#21262d/#30363d`, `.board/.col/.col-head/.count/
.col-body/.col-empty`, `.card` + `needs-human` пульс (`@keyframes
card-pulse`), `.ask-flag`, `.card-head/.prio/.assigned/.card-title/
.card-id/.card-meta`, `.task-badges/.task-badge` (repo/stage/kind/
role-author/role-reviewer/wp), `.filter-bar/.chip(.active)`, `.heartbeat/
.hb-dot` (+`hb-pulse`), `.summary/.sum-item`, `.tabs/.tab`, `.btn(.primary)`,
структура страницы (board-head → summary → filter-bar → board).

Переписано (новый слой данных): колонки — лейны нового ядра вместо статусов
задач legacy; карточка — work item + Workplace вместо task; значки —
обязательства/ожидания вместо repo/stage/kind tags; heartbeat — пульс по
росту sequence журнала (в новом ядре нет таймстампов); командная панель —
типизированный JSON-диалог + quick-actions вместо engine ▶/⏸ и model-select.

## Не портировано (сознательно)

- **Engine ▶/⏸/⏹ и selector модели** — в новом ядре это типизированные
  команды `stop/resume` через `/api/command` и пин route в композиции;
  прямой engine-контроль умер вместе с legacy runtime (EK-8).
- **Human-gate console (✅/❌ гейты)** — заменена типизированной командой
  `human-response` в диалоге карточки; проверок-провайдеров в ядре нет.
- **Артефакты/Покрытие/Приёмка (табы legacy)** — сущностей artifact/trace в
  новом ядре нет; их место — evidence-реестр (см. core-view-ek).
- **Монитор-панель воркеров (логи JSONL)** — воркеров-подпроцессов у
  командной консоли нет; когниции видны как `activity_attempt` в core-view-ek.
- **Индекс проектов / admin** — в ядре одна фабрика на БД, мультипроектного
  индекса нет.
