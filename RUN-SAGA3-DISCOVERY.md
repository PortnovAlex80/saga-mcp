# RUN-SAGA3-DISCOVERY — инструкция запуска Discovery pipeline end-to-end

> **Прочитай меня первым, прежде чем запускать Discovery эпик.**
> Эта инструкция — результат часа ресёрча в сессии 2026-07-26 (epic 38,
> «Баллистический калькулятор Маска»). Если что-то не получается — почти всегда
> причина в одном из пунктов ниже. Не делай ресёрч заново, иди по чеклисту.

---

## ⚠️ ОБНОВЛЕНИЯ 2026-07-27 (читай ПЕРВЫМ)

После рефакторинга Process Module + трёх фиксов saga-MCP кое-что изменилось.
Старые секции ниже всё ещё полезны для контекста, но запускать надо по новому.

### Режим движка: `saga3-discovery-generic` (НЕ `saga3-discovery`)

`SAGA_ORCHESTRATION_MODE=saga3-discovery` гонит **legacy** движок
(Saga3DiscoveryEngine). После рефакторинга цель — гнать через новый
**generic-flow** executor, который читает `discoveryProcessModule` как данные.

```bash
SAGA_ORCHESTRATION_MODE=saga3-discovery-generic    # ← НЕ saga3-discovery
```

### Модель: `glm-4.7` (НЕ `glm-5.2` по умолчанию)

Z.ai Coding Plan поддерживает три модели (каталог в
`tracker-view/tracker-view.mjs:5101`):
- `glm-5.2` — opus-level, **x3 peak rate** (дороже по квоте)
- `glm-5-turbo` — opus-level, x1 rate
- `glm-4.7` — **sonnet-level, x1 rate, рекомендуемый дефолт** ← используем

Переключение через `~/.claude/settings.json`:
```json
"env": {
  "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
  "ANTHROPIC_AUTH_TOKEN": "<z.ai token>",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.7",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.2"
}
```

saga-runner spawn'ит воркеров с `--model opus`, а claude remap'ит алиас opus в
значение `ANTHROPIC_DEFAULT_OPUS_MODEL`. То есть достаточно поменять одну
строку в settings.json — все воркеры автоматически пойдут на выбранную модель.

**История:** до 2026-07-27 в settings.json стояло `glm-5.2` для всех алиасов.
Старая инструкция ниже упоминала просто «GLM-5.2», но это было inherited из
дефолта, а не有意 выбор. Сейчас дефолт — 4.7 (дешевле, sonnet-level достаточно
для discovery worker'а).

### 3 фикса saga-MCP (важно, если воркер «не видит» saga tools)

Если воркер крутится, но `mcp__saga__*` tools отсутствуют в его schema — это
был реальный баг, починен в коммитах `63bc2b4` + `ce89fcc`:

1. **`claude-runner.mjs`** — `mcp__saga__` префикс навешивался на builtin tools
   (Write/Read/Edit/...). Фильтровать builtin'ы перед добавлением префикса.
2. **`sqlite-saga3-discovery-runtime.ts`** — description задачи = lineage-мусор.
   Description = `{objective, work_intent_id}` (legacy shape).
3. **`composition-root.ts`** — `sagaEntry: process.argv[1]` указывал на
   `dist/orchestrate-cli.js` (CLI), а MCP-сервер — `dist/index.js`.
   Резолвить через `package.json bin.saga-mcp`.

Эти фиксы уже в ветке `agent/saga3-process-modules`. Симптом «воркер не видит
saga-MCP» после них должен исчезнуть. Если нет — читай лог воркера
(`~/.zcode/cli/board-runs/<run-id>/task-<id>-*.jsonl`) и считай `mcp__saga__`
tool_use; их должно быть > 0.

### ProcessRun может зависнуть в `running` после принудительной остановки

Если движок прибит `taskkill`/TaskStop, ProcessRun остаётся в статусе `running`
(не terminal). При следующем запуске движок попытается его продолжить, что
может дать странное поведение. Чистить перед прогоном (см. clean-скрипт ниже).

### Не коммитить артефакты прогона

`docs/discovery/projects/<N>/` содержит результаты прогонов — это **мусор**, не
коммитить. Шаблоны живут в `docs/discovery/tools/` (общие для всех эпиков).

---

## TL;DR — одна команда запуска

```bash
cd "D:/Разработка/saga-mcp"
DB_PATH="C:/Users/user/.zcode/saga.db" \
SAGA_ORCHESTRATION_MODE=saga3-discovery \
node dist/orchestrate-cli.js <PROJECT_ID> <EPIC_ID> --concurrency=1
```

Два env-вара — **оба обязательны**. Без `DB_PATH` движок не запустится. Без
`SAGA_ORCHESTRATION_MODE=saga3-discovery` запустится **старый Saga2-движок**,
который ждёт formalization-задачи и вместо Discovery поднимет `recovery.heal`.

---

## Pipeline (что движок делает сам, в правильном порядке)

```
1. work_intent       (kind='discovery', status: ready → executing → concluded)
2. task              (task_kind='discovery.work', спавнит LM-воркера)
3. worker            (LM читает контекст, пишет discovery-N.md, proposal_submit)
4. normalization     (если raw невалиден — bounded LM-нормализатор)
5. readiness         (LM shadow-assessment: proposal_id, source_refs, dimension_scores)
6. settlement        (deterministic kernel: go / clarify / reject)
7. certificate       (immutable OutcomeCertificate)
8. diagnosis         (LM shadow-report: объясняет выданный certificate)
```

Полный pipeline на GLM-5.2 через z.ai занимает 15–40 минут. Epic 37 (GeoSophia)
прошёл полностью (proposal 138 → readiness 78 → settlement 20 → certificate 21
→ diagnosis 20, всё accepted_by_kernel).

---

## Шаг 1. Prerequisites (один раз, проверять перед каждым запуском)

### 1.1. Свежий build

```bash
cd "D:/Разработка/saga-mcp"
npm run build
```

`dist/` должен быть новее `src/`. Сравни `stat -c '%y %n' src/engines/saga3-discovery-engine.ts dist/engines/saga3-discovery-engine.js`.

### 1.2. Токен z.ai в `~/.claude/settings.json`

Должно быть:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<z.ai token>",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
  }
}
```

Проверка:
```bash
node -e "const j = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')); console.log('token:', !!j.env?.ANTHROPIC_AUTH_TOKEN, 'base:', j.env?.ANTHROPIC_BASE_URL)"
```

Если токена нет — будет 401 authentication_failed от z.ai.

### 1.3. Никаких зомби-процессов

```bash
tasklist | grep -iE "node.*orchestrate|claude"
```

Если что-то висит — прибей `taskkill /PID <pid> /F`.

---

## Шаг 2. Создание проекта/эпика/repo (только для нового эпика)

Если эпик уже есть и чистый — пропускай к Шагу 3.

Сам движок проект НЕ создаёт. Нужно руками через direct-DB writes (тот же shape,
что MCP tools `projects.js` / `epics.js` / `repositories.js`).

**Проверенные значения (не менять):**
- `repositories.default_branch = 'saga3-discovery'` (текущая рабочая ветка)
- `project_repositories.local_path = 'D:/Разработка/saga-mcp'`
- `project_repositories.integration_branch = 'saga3-discovery'`
- `episode_workflows.stage = 'discovery'` (NOT NULL, default)
- `episode_workflows.track = 'formal'` (**NOT NULL, без default на запись — обязательное поле!**)

Пример bootstrap-скрипта: `bootstrap-ballistic.mjs` в корне (эталонный шаблон).
Запустил, получил project_id / epic_id — вставляй в команду из TL;DR.

---

## Шаг 3. Запуск

```bash
DB_PATH="C:/Users/user/.zcode/saga.db" \
SAGA_ORCHESTRATION_MODE=saga3-discovery \
node dist/orchestrate-cli.js <PROJECT_ID> <EPIC_ID> --concurrency=1 \
  2>&1 | tee /tmp/discovery-run.log
```

Запускать в фоне (background). В stdout будет минимум (`[orchestrate-cli] starting ...`),
реальный прогресс — в БД (Шаг 4).

**Не запускать без `--concurrency=1`.** Concurrency > 1 не тестировалась на
saga3-discovery.

---

## Шаг 4. Мониторинг прогресса

Каждые 60–120 секунд проверяй БД:

```bash
node -e "
const Database = require('D:/Разработка/saga-mcp/node_modules/better-sqlite3');
const db = new Database('C:/Users/user/.zcode/saga.db', { readonly: true });
const EPIC = <EPIC_ID>;
console.table(db.prepare('SELECT id, title, status, task_kind, assigned_to FROM tasks WHERE epic_id = ? ORDER BY id').all(EPIC));
console.table(db.prepare('SELECT id, kind, status, projected_task_id FROM saga3_work_intents WHERE epic_id = ?').all(EPIC));
console.table(db.prepare(\"SELECT execution_id, task_id, state, phase, last_error FROM worker_executions WHERE epic_id = ? ORDER BY reserved_at DESC LIMIT 5\").all(EPIC));
console.table(db.prepare('SELECT id, epic_id, kind, status FROM saga3_raw_submissions WHERE epic_id = ? ORDER BY id DESC LIMIT 3').all(EPIC));
console.table(db.prepare('SELECT id, epic_id, kind, status FROM saga3_proposals WHERE epic_id = ? ORDER BY id DESC LIMIT 3').all(EPIC));
console.table(db.prepare('SELECT id, epic_id, decision, status FROM saga3_discovery_outcome_certificates WHERE epic_id = ?').all(EPIC));
db.close();
"
```

**Здоровая последовательность появления артефактов:**

| Время после старта | Что появляется |
|---|---|
| ~5–15 с | `saga3_work_intents` row (status='executing'), `tasks` row (status='in_progress'), `worker_executions` row (state='running', phase='executing') |
| 5–15 мин | `saga3_raw_submissions` row (worker сделал proposal_submit), task 6261 → status='done' |
| 5–15 мин | `saga3_proposals` row (после normalization) |
| 5–20 мин | второй `tasks` row (task_kind='discovery.assess'), новый worker |
| 10–25 мин | `saga3_readiness_assessments` row |
| ~25 мин | `saga3_discovery_settlements` row (decision: go/clarify/reject) |
| ~25 мин | `saga3_discovery_outcome_certificates` row |
| ~25 мин | третий `tasks` row (task_kind='discovery.diagnose') |
| 30–40 мин | `saga3_discovery_diagnosis_reports` row (status='accepted_by_kernel') |

Движок завершается с exit 0 после diagnosis.

---

## Шаг 5. Грабли (что обычно идёт не так)

### Грабли #1 — запустился Saga2-движок

**Симптом:** в `tasks` появилась задача `task_kind='recovery.heal'` с заголовком
вида «formalization gate failed: no formalization tasks exist». В
`episode_workflows.stage='formalization'` (движок сам перезаписал).

**Причина:** забыт `SAGA_ORCHESTRATION_MODE=saga3-discovery`. По умолчанию
композиционный root выбирает Saga2-движок.

**Лечение:**
1. Остановить движок (`TaskStop` или `taskkill`).
2. Почистить:
   ```bash
   node -e "
   const Database = require('D:/Разработка/saga-mcp/node_modules/better-sqlite3');
   const db = new Database('C:/Users/user/.zcode/saga.db');
   db.prepare(\"UPDATE worker_executions SET state='lost', phase='executing', last_error='saga2 by mistake' WHERE epic_id = <EPIC>\").run();
   db.prepare(\"DELETE FROM tasks WHERE epic_id = <EPIC> AND task_kind = 'recovery.heal'\").run();
   db.prepare(\"UPDATE episode_workflows SET stage='discovery', track='formal', baseline_artifact_id=NULL, baseline_hash=NULL, metadata='{}' WHERE epic_id = <EPIC>\").run();
   db.close();
   "
   ```
   Внимание: `worker_executions.phase` имеет CHECK constraint — только
   `'executing','reviewing','finishing','integrating'`. `'exited'`/`'finished'`
   **нельзя**.
   `episode_workflows.track` NOT NULL — нужно явно `'formal'`.
3. Перезапустить с правильным env var.

### Грабли #2 — stale worker_execution блокирует worker_next

**Симптом:** worker не спавнится, в логе зацикливается.

**Причина:** после краша движка осталась `worker_executions` row с
`phase='executing'` и `state='running'` — новый движок думает, что воркер жив.

**Лечение:**
```bash
node -e "
const Database = require('D:/Разработка/saga-mcp/node_modules/better-sqlite3');
const db = new Database('C:/Users/user/.zcode/saga.db');
db.prepare(\"UPDATE worker_executions SET state='lost', phase='executing' WHERE epic_id = <EPIC> AND state = 'running'\").run();
db.close();
"
```

### Грабли #3 — 401 authentication_failed от z.ai

**Причина:** нет/истёк `ANTHROPIC_AUTH_TOKEN` в `~/.claude/settings.json`.

**Лечение:** спросить у пользователя новый токен, прописать в settings.json.

### Грабли #4 — модель не обновляет tracker

**Симптом:** `docs/discovery/projects/<N>/project-N-discovery-stage.md` не двигается.

**Норма:** tracker — это **advisory** артефакт для человека. Движок не зависит от
него. Источник правды — БД (`saga3_*` таблицы). Tracker может отставать.

### Грабли #5 — при перезапуске движок создаёт дублирующий work_intent

**Симптом:** после краша движка и рестарта — два `saga3_work_intents` для одного эпика.

**Лечение:** движок умеет переиспользовать concluded/failed intent (фикс `543ac58`
«reuse concluded discovery intent on restart»). Если всё же продублировалось —
удали младший, оставь старший (по `created_at`).

---

## Шаг 6. Финальный отчёт

После завершения движка (exit 0) проверить:

```bash
node -e "
const Database = require('D:/Разработка/saga-mcp/node_modules/better-sqlite3');
const db = new Database('C:/Users/user/.zcode/saga.db', { readonly: true });
const EPIC = <EPIC_ID>;
console.log('=== settlement ===');
console.table(db.prepare('SELECT id, decision, status, reason_codes FROM saga3_discovery_settlements WHERE epic_id = ?').all(EPIC));
console.log('=== certificate ===');
console.table(db.prepare('SELECT id, decision, status FROM saga3_discovery_outcome_certificates WHERE epic_id = ?').all(EPIC));
console.log('=== diagnosis (last) ===');
console.table(db.prepare('SELECT id, status, executive_summary FROM saga3_discovery_diagnosis_reports WHERE epic_id = ? ORDER BY id DESC LIMIT 1').all(EPIC));
console.log('=== discovery doc ===');
console.table(db.prepare('SELECT id, code, title, status FROM artifacts WHERE epic_id = ?').all(EPIC));
db.close();
"
```

Успех = `saga3_discovery_outcome_certificates.status='issued'` И
`saga3_discovery_diagnosis_reports.status='accepted_by_kernel'`.

Discovery doc читается из `docs/discovery/projects/<EPIC>/discovery-<EPIC>.md`.

---

## Чего эта инструкция НЕ покрывает

- Formalization / Planning / Development / Verification / Integration — они на
  ветке `saga-3-0` (Gate 1-10), но не на `saga3-discovery`. Для них — отдельная
  инструкция когда они будут доведены до production.
- Concurrency > 1 — не тестировалось.
- Локальные модели через LM Studio — смотри `skills/saga-discovery-worker/SKILL.md`
  и документацию по `tracker-view/claude-runner.mjs` (env `ANTHROPIC_BASE_URL`
  на localhost, `ANTHROPIC_AUTH_TOKEN='lm-studio'`).

---

## Канонические источники (если что-то непонятно)

- `skills/saga-discovery-worker/SKILL.md` — что делает worker
- `skills/saga-discovery-readiness-advisor/SKILL.md` — что делает readiness advisor
- `skills/saga-discovery-diagnosis-advisor/SKILL.md` — что делает diagnosis advisor
- `skills/saga-discovery-normalizer/SKILL.md` — что делает normalizer
- `src/engines/saga3-discovery-engine.ts` — движок
- `src/saga3/application/discovery-*.ts` — 5 сервисов (normalization, readiness, settlement, certificate-bundle, diagnosis)
- `src/app/composition-root.ts` — выбор движка по `SAGA_ORCHESTRATION_MODE`
- `docs/saga3/D6-FIRST-REAL-RUN-EVIDENCE.md` — отчёт о первом полном прогоне (epic 37)
- `bootstrap-ballistic.mjs` — эталонный bootstrap-скрипт
