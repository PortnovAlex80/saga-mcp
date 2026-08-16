# core-view SPEC — контракт для исполнителей

**Проект:** Factory Core View — пассивный наблюдатель за заводом saga-mcp.
**Дизайн-документ (почитать контекст):** `docs/design/FACTORY-CORE-VIEW.md`
**Железные правила:**

1. Завод работает. **Никаких записей в БД, никаких правок вне папки
   `core-view/`** (единственное исключение — этот SPEC уже написан).
   Не трогать `tracker-view/`, `src/`, `package.json`, скиллы, AGENTS.md.
2. БД открывать **только** `better-sqlite3` с `{readonly: true}`, открытие на
   каждый запрос. Никогда не открывать `*.bak-*` файлы. Если БД недоступна —
   эндпоинт отвечает `{ok:false, error}` с кодом 200 (фронт покажет «завод
   недоступен», не упадёт).
3. Чистый ESM `.mjs`, без билд-степа, без npm-установок, без CDN. Зависимость
   одна — `better-sqlite3` (резолвится из корневого `node_modules` сам).
   Платформа Windows, запуск из корня репо и из папки — работать должно из
   любого cwd (пути резолвить от `import.meta.url`).
4. Стиль кода — как в `tracker-view/docs-graph` и `tracker-view/lifecycle-pipeline`:
   vanilla, неймспейсы, никаких фреймворков.

## Владение файлами (строго, чужое не трогать)

| Исполнитель | Файлы |
|---|---|
| A (бэкенд) | `server.mjs`, `core-snapshot.mjs`, `core-events.mjs`, `core-cell.mjs`, `core-projects.mjs`, `log-tail.mjs`, `smoke.mjs`, `README.md` |
| B (шелл+L1+L3) | `public/index.html`, `public/core.css`, `public/main.js`, `public/views/chain.js`, `public/views/chain.css`, `public/views/tape.js`, `public/views/tape.css` |
| C (L2+L0) | `public/views/cell.js`, `public/views/cell.css`, `public/views/pulse.js`, `public/views/pulse.css` |

## Порты и запуск

- Порт `4323` (env `CORE_VIEW_PORT`), bind `127.0.0.1`.
- БД по умолчанию `<repo-root>/.factory-testbed/factory.sqlite`
  (env `CORE_VIEW_DB` может переопределить).
- PID-файл `core-view/.core-view.pid` при старте, удалять на выходе.
- Статика из `public/` с MIME- whitelist (`html,css,js,mjs,json,svg,png,ico`)
  и защитой от traversal — скопировать подход `tracker-view/lifecycle-pipeline/pipeline-api.mjs`.

## API-контракт (исполнитель A реализует, B/C потребляют)

Все ответы `{ok:true, ...}` либо `{ok:false, error:string}`. Время — ISO-строки
или `YYYY-MM-DD HH:MM:SS` как в БД (указать `now` в каждом ответе для сверки).

### GET /api/core/heartbeat
`{ok, now, db:{path, exists}, projects:n}`

### GET /api/core/projects
Сводка всех проектов для L0 (паттерн join — экспресс-проверка №4 из
`docs/testing/WORKSHOP-STATUS.md`):
```json
{ "ok": true, "projects": [ {
  "id": 3, "name": "tips",
  "lifecycle": {"runId":26,"status":"running","currentStageId":"formalization","terminalStatus":null,"updatedAt":"..."} | null,
  "tasks": {"total": 18, "done": 7},
  "lastHeartbeatAt": "..." | null } ] }
```

### GET /api/core/snapshot?project=<id>
`project` необязателен: по умолчанию — самый последний активный (max
worker_executions.heartbeat_at / activity). Главные данные для L1:
```json
{
  "ok": true, "now": "...",
  "project": {"id":3,"name":"tips","epicId":3},
  "lifecycle": {"runId":26,"status":"running","currentStageId":"formalization",
    "stages":[{"stageRunId":55,"stageId":"discovery","name":"discovery@1.4.3","status":"completed","attempt":1,"outcome":"go","startedAt":"...","completedAt":"..."}]},
  "workplaces": [ {
    "workplaceRef":"workplace/41/solution-development@1.4.3/development-plan-task-graph/singleton",
    "processRunId":41, "moduleRef":"solution-development@1.4.3",
    "productionCellId":"development-plan-task-graph", "workKey":"singleton",
    "taskId": 207 | null,
    "kanbanPhase":"in_progress", "loopState":"repair_wait", "nextRole":"author",
    "terminalReason": null, "revision": 16,
    "createdAt":"...", "updatedAt":"...",
    "obligation": {"kind":"transition","state":"pending","leaseOwner":null,"attempt":2,"lastError":null} | null,
    "worker": {"executionId":"...","state":"running","phase":"...","pid":123,"heartbeatAt":"...","heartbeatAgeMs":4200,"alive":true} | null,
    "lastGate": {"gatePhase":"final","verdict":"repair_required","decidedAt":"..."} | null,
    "lastRepair": {"at":"...","reason":"первая строка причины (тултип чипа)"} | null,
    "stats": {"candidateSets":3,"gateDecisions":5,"repairs":2} } ],
  "dependencies": [ {"from":"<workplaceRef>","to":"<workplaceRef>"} ],
  "workers": [ {"executionId":"...","projectId":3,"taskId":71,"state":"running","phase":"...","pid":20276,
    "startedAt":"...","heartbeatAt":"...","heartbeatAgeMs":2100,"alive":true,
    "tokPerSec": 12.4 | null, "logPath":"...","logMtimeAgeMs": 900 | null, "stale": false} ],
  "counters": {"replayCapsules":167,"finalAcceptances":109,"recoveryCases":0,"candidateSets":194,"gateDecisions":188},
  "pulse": {"lastActivityAt":"...","activityPerMin": 3}
}
```

Соответствия столбцов БД → полей — прямое (`factory_workplaces`,
`worker_executions`). Связи:
- workplace → obligation: `factory_transition_obligations.subject_ref = workplace_ref` (взять последнюю по updated_at);
- workplace → worker: через `factory_workplace_graph_items` (`workplace_ref` ↔ `task_id`) и `worker_executions.task_id`, брать живой (`state='running'|'cancel_requested'`), иначе последний; `alive` — проверка процесса по pid (копия паттерна `isProcessAlive` из `tracker-view/lifecycle-endpoints.mjs`);
- workplace → lastGate: `factory_gate_decisions.workplace_ref` max `decided_at`;
- stats: count по `factory_candidate_sets.workplace_ref`,
  `factory_gate_decisions.workplace_ref` (repairs = verdict='repair_required');
- dependencies: `factory_workplace_dependencies` (проверить колонки на месте);
- tokPerSec/logMtimeAgeMs: из JSONL-лога по `log_path` (существует не всегда),
  паттерн `/api/workers/active` в `tracker-view/lifecycle-endpoints.mjs`;
  логи лежат в `C:\Users\user\.zcode\cli\board-runs\...` — читать только
  mtime/хвост, аккуратно с отсутствием файла.
Обязательно сверить реальные колонки/связи выборками перед финализацией —
контракт полей не менять, внутренние join'ы — на исполнителе.

### GET /api/core/events?since=<ISO>&limit=200
Хроника для L3. `since` — ISO-время; сервер возвращает события
`at > since - 5s` (оверлап), клиент дедуплицирует по `key`:
```json
{ "ok": true, "events": [ {
    "key": "activity:12345", "at": "...", "kind": "activity|gate|transition",
    "title": "status_changed", "detail": "Task 'development-plan-task-graph/author: ...'",
    "entityType": "Task", "entityId": "..." } ],
  "now": "..." }
```
Источники: `activity_log` (action → title, summary → detail),
`factory_gate_decisions` (title=`gate:<phase>:<verdict>`, detail=workplace),
`factory_process_transitions` (title=`transition:<transition_key>:<outcome>`).

### GET /api/core/cell?workplace=<ref>
Детали одной ячейки для L2:
```json
{ "ok": true, "now": "...",
  "workplace": { ...те же поля, что в snapshot.workplaces[]... },
  "candidates": [ {"candidateSetRef":"...","role":"author","digest":"...","sealedAt":"...","members":2} ],
  "gates": [ {"gateRunRef":"...","gatePhase":"final","verdict":"accepted","repairTargetRole":null,"decidedAt":"...",
              "reason":{"source":"review","reviewVerdict":"changes_requested","findings":["..."]} | {"source":"checks","checksFailed":["provider:failed"]} | null} ],
  "executions": [ {"executionId":"...","state":"exited","workerId":"...","pid":123,"startedAt":"...","finishedAt":"...","logPath":"...","meta":{...пarsed metadata|...}} ],
  "recovery": [ {"caseRef":"...","createdAt":"...","issueRef":"..."} ],
  "effects": [ {"ref":"...","kind":"git","state":"...","at":"...","receipt":true} ],
  "finalAcceptance": {"ref":"...","subjectCandidateSetRef":"..."} | null,
  "cards": [ {"taskId":271,"title":"development-implementation/reviewer: ...","status":"review_in_progress","role":"reviewer|author|null"} ],
  "projectId": 8 | null, "projectName": "units" | null,
  "logTail": {"lines":[{"ts":"...","level":"info|thinking|tool|system|result","text":"..."}]} | null }
```
`cards` — канбан-канал (§19): карточки станции на доске :4321 (обычно
авторская + ревьюерская), `status` = колонка доски. Агентский цикл станции —
это `workplace.loopState/nextRole` (круг L2), отдельный канал от карточек.
Пустые массивы — норма (таблицы recovery/effects в тестбеде пустые).
`logTail` — последние ~40 строк JSONL лога живого/последнего execution:
`JSON.parse` с fallback на сырую строку. `recovery` из
`factory_recovery_cases` (сверить колонки), `effects` из
`factory_external_effect_actions` + `factory_cell_effect_receipts`.

## Front-end контракт (исполнители B и C)

### Каркас B (`index.html` + `main.js` + `core.css`)
- Тёмная тема GitHub-dark + неоны. Дизайн-токены в `core.css` под `:root`:
  `--core-bg:#0d1117; --core-surface:#161b22; --core-surface2:#21262d;
  --core-border:#30363d; --core-text:#e6edf3; --core-muted:#8b949e;
  --core-flow:#22d3ee; --core-ok:#3fb950; --core-scan:#58a6ff;
  --core-wait:#f39c12; --core-fail:#f85149; --core-replay:#a371f7;`
- Шапка: имя проекта + селектор (из `/api/core/projects`), табы
  `Пульс | Цепочка | Ячейка | Хроника`, плаха `PROJECTION — наблюдение, не
  авторитет`, пульс-точка (свежесть `pulse.lastActivityAt`).
- `main.js`: polling-цикл: snapshot каждые 1000 мс, projects каждые 5000 мс;
  `AbortController`, бэкофф при ошибках; store последнего снапшота; строгий
  неймспейс `.core-*`.
- Представления — динамический `import()` с `try/catch`: если модуль вида
  отсутствует — заглушка «вид в разработке» (это делает интеграцию C
  прозрачной).
- Кросс-видовой протокол — CustomEvent на `window`:
  - `core:select-workplace` `{detail:{workplaceRef}}` — любая карточка станции
    кликабельна, main.js переключает на вид «Ячейка»;
  - `core:select-project` `{detail:{projectId}}` — смена проекта снапшота.
- Интерфейс модуля вида (все четыре обязательны к экспорту):
  `export const viewId; export function mount(container, ctx); export function update(snapshot); export function destroy();`
  `ctx = {api:{snapshotUrl, projectsUrl, eventsUrl, cellUrl}, selectWorkplace(ref), selectProject(id)}`.
  `update` вызывается только когда вид активен.

### L1 «Цепочка» (B, `chain.js`)
- Полоса стадий lifecycle (как степпер, но с attempt-бейджами `↻N`).
- Лента станций: станции-чипы по `workplaces`, слева «двигатель» диспетчера:
  живой параллелизм (workers alive) и очередь (todo/idle count).
- Чип станции: `workKey`, `productionCellId`, цвет по `kanbanPhase`
  (todo=приглушён, in_progress=cyan, review=scan-синий, blocked=amber),
  loop-state текстом, кольцо ревизий (revision как число орбит/сегментов),
  лампа обязательства: obligation.state `pending|...` + kind → цвет
  (live owner=пульсирующий cyan, typed wait=amber, transition due=синий,
  STALLED — obligation==null при non-terminal loop = мигающий красный,
  противоречие = violet), точка воркера с `heartbeatAgeMs` (>30s → серый/stale),
  мини-иконка lastGate.verdict.
- Зависимости: рёбра `dependencies` — SVG-линии/подсветка предшественников
  при hover (сильно усложнять лэйаут не надо, DAG-укладка на усмотрение).
- Анимация потока: CSS/Canvas-«пакеты» по ленте при изменениях — на вкус,
  обязательно уважать `prefers-reduced-motion`.

### L3 «Хроника» (B, `tape.js`)
- Подписка на `/api/core/events` (poll 1000 мс, оверлап+дедуп по `key`),
  буфер ≤500 событий, новые сверху, автоскролл с паузой при hover,
  фильтр-чипы по `kind`, цвет строки по kind (activity=текст, gate=verdict,
  transition=scan-синий), клик по gate-событию с workplaceRef →
  `core:select-workplace`.

### L2 «Ячейка» (C, `cell.js`)
- Подписка на `core:select-workplace` (или поиск по workKey в поле поиска):
  fetch `/api/core/cell?workplace=...`, poll 1500 мс пока открыт.
- Круговой цикл клетки (SVG): сегменты `author → candidate → gate → reviewer →
  final → effect` по окружности; активный сегмент светится по
  `kanbanPhase/loopState/nextRole/lastGate`; попытки — концентрические кольца
  (revision); repair — дуга назад (amber); принятая ячейка — зелёное свечение +
  `finalAcceptance`.
- Под кругом: хронология попыток (gates+executions во времени), карточка
  терминала `logTail` (моноширинный, уровни цветом), счётчики candidates/gates.
- Replay: если у execution в `meta` есть replay/capsule признак — фиолетовый
  маркер (best effort).

### L0 «Пульс» (C, `pulse.js`)
- Сетка мини-реакторов по `/api/core/projects`: проект = ячейка с именем,
  стадией (`lifecycle.currentStageId`), статусной лампой
  (running=cyan-пульс, completed=зелёный, failed=красный, null=приглушён),
  прогрессом `tasks.done/total`, свежестью heartbeat. Клик →
  `core:select-project`.
- Верхняя полоса: counters из snapshot (капсулы, принятия, гейты) + спарклайн
  активности (сам накапливает кольцевой буфер из `/api/core/events`).

## Проверка каждым исполнителем

- A: `node core-view/smoke.mjs` — поднимает сервер на ephemeral порту с
  реальной БД (если есть) и проверяет все эндпоинты на форму ответа; печатает
  сводку. README.md: как запустить `node core-view/server.mjs`, порт, env.
- B/C: `node --check` на каждый свой модуль; сверка имён полей с этим SPEC
  (не с живым API — оно появится от A параллельно).
- Никто не запускает сервер на 4323 надолго (могу мешать друг другу при
  интеграции): smoke — на ephemeral порту, проверку фронтенда — статикой.
