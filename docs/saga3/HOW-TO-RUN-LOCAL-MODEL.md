# Как запустить Saga 3 Discovery Edition на локальной модели (LM Studio)

Пошаговая инструкция для прогона discovery-pipeline на локальной модели через
LM Studio. Актуальна для ветки `saga3-discovery` (D1 / D1.1).

> Соседние документы: `D1-SMOKE-EVIDENCE.md`, `D1-1-SMOKE-EVIDENCE.md`.

## 0. Что нужно заранее

- **LM Studio** запущен, модель загружена и доступна по локальному серверу
  (по умолчанию `http://localhost:1234/v1`). Проверка:
  ```bash
  curl -s http://localhost:1234/v1/models | head -c 200
  ```
  Должен вернуть `data[].id` с id модели, например
  `qwen3.6-35b-a3b@q4_k_xl`.
- **claude CLI** установлен и в PATH (движок зовёт `claude -p ...`).
- **settings.cloud.json** и **settings.lmstudio.json** в `~/.claude/` — это
  ДВА постоянных шаблона. `/api/model/set` переключает `settings.json` между
  ними атомарно (fsync + readback). **Не редактируй их вручную** — модель
  выставляется только через API (см. шаг 3).
- saga DB: `C:/Users/user/.zcode/saga.db` (или любой путь через `DB_PATH`).
  `platform_policies` (глобальный seed) не трогается purge'ем — он выживает.

## 1. Сборка dist

```bash
npm run build
```

`dist/` gitignored — нужен для запуска (tracker-view импортирует из `dist/`).

## 2. Запуск tracker-view в режиме saga3-discovery

КРИТИЧНО: три env-переменные.

```bash
DB_PATH="C:/Users/user/.zcode/saga.db" \
SAGA_ORCHESTRATION_MODE=saga3-discovery \
TRACKER_AUTOSTART=0 \
node tracker-view/tracker-view.mjs > /tmp/tracker.log 2>&1 &
```

- `DB_PATH` — путь к saga DB (**обязателен**, иначе `loadSagaRuntimeConfig`
  падает).
- `SAGA_ORCHESTRATION_MODE=saga3-discovery` — выбирает Saga3DiscoveryEngine в
  composition-root (иначе стартует дефолтный Saga2 + legacy kickstart).
- `TRACKER_AUTOSTART=0` — не форкать вложенный MCP-сервер / docs-graph из
  tracker-view (мы запускаем tracker-view отдельно от MCP).

Проверка:
```bash
curl -s http://localhost:4321/api/projects | head -c 100
```
Должен ответить JSON (или HTML страницы проектов).

## 3. ВЫСТАВИТЬ МОДЕЛЬ НА ЭПИК (до первого claim) ⚠

Это **самый частый грабль**. Discovery-движок замораживает model route в
иммутабельный `execution_context` снапшот при **claim**'е задачи. Если модель
не стоит на эпике на момент claim — снапшот заморозит дефолт `zai/opus`, и
воркер пойдёт в облако z.ai вместо LM Studio. После claim менять поздно
(снапшот immutable).

Проблема в том, что эпик ещё не существует до создания проекта. Поэтому порядок:
**сначала создаёшь проект (шаг 4), потом СРАЗУ ставишь модель на epic_id, потом
позволяешь движку сделать первый claim**. Но `create-from-idea` с `auto_start`
стартует движок немедленно — первый claim может произойти раньше model/set.

Два рабочих варианта:

**Вариант A (рекомендуемый): модель ГЛОБАЛЬНО + потом на эпик.**
1. Перед созданием проекта выставь модель глобально (пишет `settings.json`):
   ```bash
   curl -s -X POST http://localhost:4321/api/model/set \
     -H "Content-Type: application/json" \
     -d '{"epic_id":null,"model":"qwen3.6-35b-a3b@q4_k_xl"}'
   ```
   ВАЖНО: `epic_id:null` пишет ТОЛЬКО `settings.json`, **НЕ** пишет
   `active_model` в `episode_workflows`. Этого недостаточно для снапшота.
2. Создай проект (шаг 4), узнай epic_id из ответа.
3. **Повтори `/api/model/set` С `epic_id`** — теперь `active_model` попадёт в
   `episode_workflows.metadata` эпика, и первый claim заморозит LM Studio.
4. Если build-execution уже успел claim'уться с дефолтным маршрутом — это
   видно в `worker_executions.metadata.execution_context.model_route`. В этом
   случае build-цикл отработает на zai/opus (медленно/401), но review-цикл
   поднимется уже на правильной модели (см. `D1-1-SMOKE-EVIDENCE.md` — там
   ровно этот кейс задокументирован).

**Вариант B: создать проект БЕЗ auto_start, поставить модель, потом стартовать.**
1. Создай проект с `auto_start:false` (шаг 4) — движок НЕ стартует.
2. `/api/model/set` с `epic_id` из ответа.
3. `/api/engine/start { epic_id, concurrency:1 }` — теперь первый claim
   заморозит LM Studio сразу.

Вариант B чище для smoke (нет гонки), вариант A удобнее из веб-формы.

Проверка что модель прописана:
```bash
node -e "const db=require('better-sqlite3')('C:/Users/user/.zcode/saga.db'); \
  console.log(db.prepare(\"SELECT json_extract(metadata,'\$.active_model') AS m, \
  json_extract(metadata,'\$.active_provider') AS p FROM episode_workflows \
  WHERE epic_id=?\").get(<EPIC_ID>));"
```
Должно быть `{"m":"qwen3.6-35b-a3b@q4_k_xl","p":"lmstudio"}`.

## 4. Создание discovery-проекта

```bash
curl -s -X POST http://localhost:4321/api/project/create-from-idea \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-discovery",
    "idea": "<что исследовать, 1-2 предложения>",
    "local_path": "D:/Разработка/my-discovery-workspace",
    "auto_start": true
  }'
```

В ответе: `project_id`, `repo_id`, `epic_id`, `task_id:null` (норма — движок
проектирует задачу из WorkIntent), `engine_spawned:true`,
`orchestration_mode:"saga3-discovery"`.

Для saga3-discovery bootstrap создаёт **только** project + repo + epic +
episode_workflows. Legacy kickstart (brief/task) **пропускается**
(`isSaga3DiscoveryMode` gate). Discovery-задачу создаёт сам движок из
WorkIntent — это правильно, не пугайся что `task_id:null`.

## 5. Мониторинг прогона

Heartbeat-лог (одна строка на событие, `tail -f`):
```bash
tail -f ~/.zcode/cli/worker-heartbeat.log
```
События: `STARTED` (spawn), `CLAIMED` (воркер взял задачу из скилла),
`CLOSED exit=0 completed status=done` (успех), `FAILED` (упал до worker_done).

JSONL-лог конкретного воркера (stream-json от claude):
```bash
ls -t ~/.zcode/cli/board-runs/*/task-<TASK_ID>-*.jsonl | head -1 | xargs tail -f
```

Состояние в БД:
```bash
node -e "
const db=require('better-sqlite3')('C:/Users/user/.zcode/saga.db');
console.log('task:', db.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(<TASK_ID>));
console.log('intent:', db.prepare('SELECT status FROM saga3_work_intents WHERE projected_task_id=?').get(<TASK_ID>));
console.log('exec route:', db.prepare(\"SELECT json_extract(metadata,'\$.execution_context.model_route') AS r, json_extract(metadata,'\$.execution_context.authority.enforcement') AS e FROM worker_executions WHERE task_id=? ORDER BY reserved_at DESC LIMIT 1\").get(<TASK_ID>));
console.log('proposal:', db.prepare('SELECT id, status FROM saga3_proposals WHERE task_id=?').get(<TASK_ID>));
"
```

Ожидаемый happy-path статус-переход:
`todo → in_progress → review → review_in_progress → done`
intent: `open → executing → concluded`

Discovery — **single-shot**: один WorkIntent, одна projected задача, build-cycle
сабмитит Proposal и зовёт worker_done (→ review), review-cycle закрывает
(→ done), движок выходит сам (`terminal=clean`).

## 6. Остановка движка / чистка

**Остановить движок эпика** (НЕ убивает активный claude-процесс, но останавливает
pump — НЕ ЗОВИ посередине review-цикла, иначе движок CAS'нет intent в `concluded`
пока задача в `review_in_progress`, и при рестарте создаст дубликат intent/task):
```bash
curl -s -X POST http://localhost:4321/api/engine/stop \
  -H "Content-Type: application/json" -d '{"epic_id":<EPIC_ID>}'
```

**Полный сброс БД** (каскадно через project_delete, сохраняет platform_policies
и глобальные trusted_providers, не трогает .md-файлы и machine checkouts):
```bash
curl -s -X POST http://localhost:4321/api/admin/purge-all-projects \
  -H "Content-Type: application/json" -d '{}'
```

**Остановить tracker-view** (освободить порт 4321):
```bash
powershell -Command "Get-NetTCPConnection -LocalPort 4321 -State Listen |
  Select-Object -ExpandProperty OwningProcess |
  ForEach-Object { Stop-Process -Id \$_ -Force }"
```

## 7. Что проверять после прогона (D1.1 acceptance)

Для каждого execution'а в `worker_executions.metadata`:

- `execution_context.policy_version` = `saga3.execution.v1`
- `execution_context.authority.enforcement` = `runtime` (D1.1 flip)
- `execution_context.authority.allowed_saga_tools` = `[task_get,
  repository_checkout_list, artifact_list, note_list, proposal_submit,
  worker_done]`
- `execution_context.model_route` = `{provider:"lmstudio", model:"<lm-studio-id>"}`
- `execution_context_hash` присутствует

**Negative-check** (гейт должен запретить неразрешённый tool до handler'а):
```bash
node -e "
const db=require('better-sqlite3')('C:/Users/user/.zcode/saga.db');
const exec=db.prepare(\"SELECT execution_id FROM worker_executions WHERE json_extract(metadata,'\$.execution_context.authority.enforcement')='runtime' ORDER BY reserved_at DESC LIMIT 1\").get();
const {authorizeSagaToolCall}=await import('./dist/saga3/authority/authorize-saga-tool-call.js');
console.log('task_get ->', JSON.stringify(authorizeSagaToolCall({toolName:'task_get',db,executionId:exec.execution_id}).allow));
const d=authorizeSagaToolCall({toolName:'task_create',db,executionId:exec.execution_id});
console.log('task_create -> allow:', d.allow, 'code:', d.code);
"
```
Ожидание: `task_get -> true`, `task_create -> allow: false code: AUTHORITY_DENIED`.

## 8. Известные грабли

- **Модель не на эпике → build-execution на zai/opus.** См. шаг 3. Снапшот
  immutable, после claim не починить; дождись review-cycle или перезапусти
  после model/set.
- **`/api/engine/stop` посреди review → дубликат intent/task на рестарте.**
  Discovery single-shot: движок conclude'ит intent при остановке, даже если
  задача в `review_in_progress`. На рестарте `readOpenIntent` не находит
  открытый intent → проектирует новый. Не глуш движок в середине цикла;
  дождись `done` либо аккуратно reset'ни (cancelled duplicate intent +
  reopen original — см. инцидент-нот в `D1-1-SMOKE-EVIDENCE.md`).
- **Cyrillic в `local_path` curl'ом.** Windows + URL-encoding ломает кириллицу
  в пути. Используй ASCII-пути или выставляй через веб-форму.
- **`artifacts` таблица пуста.** Это правильно для discovery — Proposal идёт
  в `saga3_proposals`, `artifact_create` запрещён. Artifacts (PRD/SRS/UC/AC)
  появятся только в formalization (D3+).
