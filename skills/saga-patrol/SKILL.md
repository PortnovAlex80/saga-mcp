---
name: saga-patrol
description: "Read-only patrol of a running saga instance. Collects an express snapshot: which episode/stage, which tasks, what the model is thinking right now, are any workers stuck/looping, and an express quality read of the code on the board. NEVER writes — does not call worker_done, does not transition episodes, does not run npm install/test/build. Use when the user asks 'что делает сага / прогресс / не зависла ли / какие задачи / нет ли циклов / проверь качество кода'. Loaded in main-context for human-in-the-loop observation."
---

# saga-patrol — read-only наблюдатель саги

## Когда использовать

Пользователь хочет знать **что прямо сейчас делает сага**, **где она в процессе разработки**, **о чём думает модель**, **нет ли зацикливаний** и **в каком качестве код**, который она делает на этой доске. Скилл собирает срез за один прогон и отдаёт структурированный отчёт. Ничего не меняет.

**Скилл НЕ для:**
- Запуска/остановки engine, переключения моделей, правки задач — есть UI и `saga-orchestrator`.
- Сброса зависших задач, инъекции подсказок, merge'а веток — это `saga-worker` / `autonomous-recovery` с правами записи.
- Глубокого аудита (1000-score) — это разовая ручная работа, патруль даёт только **экспресс-оценку** (готовность к ревью, а не финальный балл).

## Что считается источником правды

| Что | Где | Read-only? |
|---|---|---|
| Engine live (running/pid/concurrency) | `GET /api/engine/status?epic_id=N` | да |
| Активные воркеры (task/pid/phase/tokens/log_path/is_quiet) | `GET /api/workers/active?project_id=N` | да |
| Хвост лога конкретного воркера (noise отфильтрован) | `GET /api/worker/tail?log_path=...&lines=N` | да |
| Pipeline эпизода (stage, needs_human, last_gate_error) | `GET /api/episode/pipeline?epic_id=N` | да |
| Последний heartbeat | `GET /api/heartbeat` | да |
| Текущая модель | `GET /api/models` | да |
| Engine-cycle телеметрия | `~/.zcode/cli/engine-heartbeat.log` | да (tail) |
| Worker-cycle телеметрия | `~/.zcode/cli/worker-heartbeat.log` | да (tail) |
| Состояние задач/артефактов/executions | `C:\Users\user\.zcode\saga.db` (SQLite, открыть **readonly**) | да |
| Git/LoC/TS продукта | `project_repositories.local_path` для каждого проекта | да (только git log/status/diff) |

**Эндпоинты, которые patrol НЕ дёргает** (они мутируют состояние):
- `/api/episode/stage-summary` — может spawn'уть `summary.stage` задачу.
- Любой `POST /api/...` — переход эпизода, старт/стоп engine, set model, save artifact.
- Любой MCP `mcp__saga__*` с write-семантикой (`task_update`, `worker_done`, `episode_transition`, …).

## Параметры окружения

Скилл рассчитывает на локальный стенд:
- `SAGA_DB` — путь к saga.db (деф. `C:\Users\user\.zcode\saga.db`).
- `SAGA_API` — tracker-view URL (деф. `http://localhost:4321`).
- `SAGA_LMSTUDIO` — LM Studio URL (деф. `http://localhost:1234`).

Если эндпоинты не отвечают — сказать об этом пользователю и **не пытаться поднять сервис** (это уже не read-only).

## Порядок сбора среза

Прогоняй команды по порядку. Каждый блок можно показывать пользователю сразу, не ждать全集.

### Шаг 0. Установить окружение и идентифицировать доски

```bash
SAGA_DB="${SAGA_DB:-C:/Users/user/.zcode/saga.db}"
SAGA_API="${SAGA_API:-http://localhost:4321}"
# Список всех проектов + эпиков + привязок к репо (один запрос к DB)
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT p.id AS pid, p.name AS project, p.status,
       e.id AS eid, e.name AS epic, e.status AS epic_status,
       ew.stage,
       json_extract(ew.metadata,'\$.engine_running')    AS eng,
       json_extract(ew.metadata,'\$.engine_pid')         AS eng_pid,
       json_extract(ew.metadata,'\$.active_model')       AS model
FROM projects p
LEFT JOIN epics e ON e.project_id=p.id
LEFT JOIN episode_workflows ew ON ew.epic_id=e.id
ORDER BY p.id, e.id;
SQL
```

Это даёт полный список досок сразу. Если хочешь сфокусироваться — спроси у пользователя project_id/epic_id, иначе прогоняй срез по каждой активной доске.

### Шаг 1. Engine + workers live

```bash
# 1a. Engine жив?
curl -s "$SAGA_API/api/engine/status?epic_id=N" | jq .

# 1b. Активные воркеры (key-поля: process_phase, tokens_per_sec, is_quiet, log_mtime_ms)
curl -s "$SAGA_API/api/workers/active?project_id=N" | jq '.workers[] |
  {task_id, status, task_kind, process_phase, pid, started_at, is_quiet,
   tokens_per_sec, total_tokens, log_path}'

# 1c. Последняя активность в саге вообще (любая запись в activity_log)
curl -s "$SAGA_API/api/heartbeat" | jq .
```

**Что считываем с 1b:**
- `is_quiet: true` → лог не пишет > 30 с. Если при этом `process_phase='executing'` — **первый сигнал зависания**.
- `tokens_per_sec < 1` при активной фазе → модель не отвечает (rate limit? OOM на GPU?).
- `process_phase='reviewing'` очень долго → ревьюер не может вынести вердикт (часто на unverifiable AC).
- `total_tokens` растёт между двумя срезами, а `phase` не меняется → классический прогресс-без-продвижения.

### Шаг 2. Pipeline — где в процессе разработки

```bash
curl -s "$SAGA_API/api/episode/pipeline?epic_id=N" | jq .
```

В ответе: массив `stages` (discovery/formalization/planning/development/verification/integration/completed) с `started_at/completed_at/duration_s/status`. **Текущая стадия** = где `status='in_progress'`. Сравниваем `stage` с тем, что должен делать эпизод — если `discovery` идёт 3 часа, это ненормально.

Также читаем:
- `needs_human: true` → где-то висит `worker_ask_need`, нужно проверить `human_requests`.
- `last_gate_error` → последняя причина отказа в переходе (gate failed).

### Шаг 3. Задачи — что в какой стадии

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT id, status, task_kind, workflow_stage,
       assigned_to, integration_state,
       ROUND((julianday('now') - julianday(updated_at)) * 86400, 0) AS age_s,
       substr(title,1,60) AS title
FROM tasks
WHERE epic_id = N
ORDER BY workflow_stage, id;
SQL
```

И сводка по статусам:

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT workflow_stage, status, COUNT(*) AS n
FROM tasks WHERE epic_id=N
GROUP BY workflow_stage, status
ORDER BY workflow_stage, status;
SQL
```

**Что считываем:**
- Серия `review_in_progress` без продвижения в `done` → ревьюер застрял.
- `integration_state='conflict'` → merge-конфликт ждёт человека.
- `age_s` для `in_progress` задачи > 30 мин без новых записей в логе → кандидат в зомби.

### Шаг 4. Циклы — детекция зацикливаний

Это ключевая фишка скилла. **Четыре независимых сигнала**, каждый самостоятелен:

#### 4a. Engine stuck на одной задаче (engine-heartbeat.log)

```bash
ENGINE_LOG=~/.zcode/cli/engine-heartbeat.log
tail -n 200 "$ENGINE_LOG" | grep -E "CYCLE|STAGE_ADVANCED|WORKER_LOST|WORKER_TERMINATED|HEALING|ESCALATE|REJECT|PAUSED|RATE_LIMIT" | tail -n 60
```

**Аномалия:** длинная серия `CYCLE stage=X claimable=0 in_flight=1 workers=1` (> 20 строк без `STAGE_ADVANCED`). Расшифровка:
- `claimable=0 in_flight=1` подолгу → один воркер занят, очереди нет, прогресса нет.
- `WORKER_TERMINATED ... released=true` → execution упал, engine сам пересоздал. Если подряд много — нестабильность.
- `HEALING / ESCALATE / GENERIC_HEAL` подряд → recovery-шторм, saga пытается починить gate failure, но не получается.
- `RATE_LIMIT` → упёрлись в лимит провайдера.

#### 4b. Worker делает одни и те же tool_use

Для каждого активного воркера (path из `/api/workers/active`):

```bash
# jq: выбрать assistant-сообщения, вытащить tool_use, сгруппировать по name+input-hash
LOG="C:/Users/user/.zcode/cli/board-runs/board-1-.../task-N-....jsonl"
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
        | {name, input: (.input|tostring)}' "$LOG" \
  | sort | uniq -c | sort -rn | head -n 15
```

**Аномалия:** одна и та же пара `(name, input)` повторяется > 3 раз. Норма для AC-задачи — много `artifact_create` с **разными** input (по одному на AC). Патология — тот же input повторяется (модель не видит, что уже сделала).

#### 4c. Рост токенов без прогресса

```bash
# Брать usage из assistant-сообщений по таймстемпам, последние 10
jq -rc 'select(.type=="assistant") | {ts: .timestamp,
        in: .message.usage.input_tokens,
        cache: .message.usage.cache_read_input_tokens,
        out: .message.usage.output_tokens}' "$LOG" | tail -n 10
```

**Аномалия:** `input_tokens` растёт от записи к записи, а `output_tokens: 0` или `cache_read_input_tokens ≈ input_tokens` → модель пересчитывает тот же контекст, не двигаясь. Это **тайный цикл**, который engine не видит (воркер жив, делает запросы).

#### 4d. api_retry шторм

```bash
jq -rc 'select(.type=="system" and .subtype=="api_retry")
        | {ts:.timestamp, status:.error_status, err:.error}' "$LOG" | tail -n 20
```

**Аномалия:** много записей подряд с `error_status:429` → упёрлись в rate limit провайдера. Сага сама снижает concurrency (`detectRateLimits` в engine), но если 429-е не заканчиваются — модельный лимит выбран неверно.

### Шаг 5. О чём прямо сейчас думает модель

Через готовый tail-эндпоинт (он фильтрует `thinking_tokens`/`hook_*` шум):

```bash
curl -s "$SAGA_API/api/worker/tail?log_path=<URL-encoded>&lines=15" | jq '.events[]'
```

Каждое событие: `{type, kind, tool, snippet}`. Смотрим последние 10–15 и формулируем **одной фразой**, чем занят воркер:
- «пишет FR-3 в PRD»
- «создаёт trace edges AC → UC»
- «читает saga-verifier SKILL.md, готовит property-тесты»
- «повторно вызывает Bash с теми же аргументами — возможен цикл (см. 4b)»

Если сниппеты непонятны — открыть полный лог и прочитать **последний assistant-блок** (text + tool_use). Цитировать мысль модели буквально, без интерпретации.

### Шаг 6. Экспресс-оценка качества кода на доске

**Важно:** на стадиях `discovery`/`formalization`/`planning` кода ещё нет — пишутся `.md`-артефакты. В этом случае пропускаем §6 и сообщаем: «кодовая фаза ещё не стартовала, оцениваю только артефакты (§7)».

Для каждой доски получаем её физический репо:

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT pr.id, r.name, pr.role, pr.local_path, pr.integration_branch, pr.default_branch, pr.status
FROM project_repositories pr
JOIN repositories r ON r.id = pr.repository_id
WHERE pr.project_id = N AND pr.status='active';
SQL
```

Для каждого `local_path`:

#### 6a. Git — что вообще сделано

```bash
cd "<local_path>"   # но НЕ запускать cd в patrol-команде — использовать git -C
git -C "<local_path>" log --oneline -20
git -C "<local_path>" status --short
git -C "<local_path>" diff --stat HEAD~5..HEAD 2>/dev/null
```

**Что считываем:**
- Коммиты есть? Если пусто — development не стартовал.
- Кто автор? Все от одного worker'а? (ожидаемо для саги)
- Какие файлы менялись за последние N коммитов — туда ли идёт работа.
- Незакоммиченные изменения в `dev` / `integration_branch` — модель не до конца завершила задачу.

#### 6b. Размер и структура

```bash
ROOT="<local_path>"
# Количество строк кода по типам (без node_modules/dist)
find "$ROOT" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
                       -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \) \
       -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' \
       -exec wc -l {} + 2>/dev/null | tail -n 1
# Количество тестов
find "$ROOT" -type f \( -name '*.test.*' -o -name '*_test.*' -o -name '*.spec.*' \) \
       -not -path '*/node_modules/*' | wc -l
```

**Экспресс-балл по размеру** (грубая прикидка, не финальный аудит):
- 0 строк кода + 0 тестов → development не стартовал (N/A).
- < 200 строк и 0 тестов → каркас, ничего не доказано.
- 200–2000 строк и есть хотя бы 1 тестовый файл → MVP-форма.
- > 2000 строк и > 5 тестовых файлов → зрелый MVP, кандидат на глубокий аудит.

#### 6c. TypeScript — если применимо

Только если в `local_path` есть `tsconfig.json`:

```bash
# НЕ запускает сборку/emit, только проверка типов
( cd "<local_path>" && npx --no-install tsc --noEmit 2>&1 | tail -n 30 )
```

**Read-only-сертификат:** `--noEmit` ничего не пишет на диск. `npx --no-install` не качает пакеты. Если `tsc` не стоит локально — сообщить, **не ставить**.

Экспресс-балл по TS:
- 0 ошибок → типы чистые.
- 1–10 → мелочи, не блокируют ревью.
- > 10 или много `error TS2xxx` → типы не доделаны, в ревью нельзя.

#### 6d. Сравнить структуру с тем, что планировалось

Сверить реальные файлы с тем, что заявлено в SRS/AC эпизода:

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT a.type, a.code, substr(a.title,1,60) AS title, a.status
FROM artifacts a
WHERE a.epic_id=N AND a.type IN ('FR','NFR','AC')
ORDER BY a.type, a.code;
SQL
```

Если в SRS 9 FR, а в коде нет даже 9 точек входа (модулей/компонентов) — coverage дырявый. Это пока гипотеза для ревью, не финальный вердикт.

### Шаг 7. Качество артефактов (требования и traceability)

Для эпизода — какие артефакты приняты, какие в draft:

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT type, status, COUNT(*) AS n
FROM artifacts WHERE epic_id=N
GROUP BY type, status ORDER BY type, status;
SQL
```

**Здоровые признаки:**
- BRIEF/PRD/SRS/UC — `accepted`.
- AC — либо все `accepted` (на planning/dev), либо часть `draft` (если formalization ещё идёт).
- `evidence_status='passed'` для AC на стадии verification.

**Красные флаги:**
- AC в `draft` при стартовавшем `development` → baseline не зафиксирован, dev-задачи пишут код под движущуюся мишень.
- `drift_state='drifted'` → артефакт правился после accept'а без supersede.

Traceability — есть ли связь AC → UC → FR:

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
SELECT a.code AS ac,
       (SELECT t.code FROM artifacts t
          JOIN artifact_traces tr ON tr.target_id=t.id AND tr.target_type='artifact'
          WHERE tr.source_id=a.id AND tr.link_type='derived_from') AS parent_uc_fr
FROM artifacts a
WHERE a.epic_id=N AND a.type='AC'
ORDER BY a.code;
SQL
```

Каждый AC должен иметь родителя (UC или FR). Пустые `parent_uc_fr` — orphan AC, их нельзя верифицировать по контракту.

### Шаг 8. Зависания и needs-human

```bash
sqlite3 -readonly "$SAGA_DB" <<SQL
.mode column
.headers on
-- Открытые human_requests
SELECT hr.task_id, t.task_kind, substr(hr.question,1,80) AS question,
       hr.state, hr.created_at
FROM human_requests hr JOIN tasks t ON t.id=hr.task_id
WHERE t.epic_id=N AND hr.state='open';

-- Tasks с needs-human тегом
SELECT t.id, t.status, t.task_kind, json_extract(t.tags,'\$') AS tags
FROM tasks t
WHERE t.epic_id=N AND t.tags LIKE '%needs-human%';

-- Зависшие executions (> 15 мин в одной фазе)
SELECT we.execution_id, we.task_id, we.phase, we.state,
       CAST((julianday('now') - julianday(we.phase_updated_at))*86400 AS INT) AS phase_age_s,
       we.last_error
FROM worker_executions we
WHERE we.epic_id=N AND we.state IN ('running','cancel_requested')
  AND (julianday('now') - julianday(we.phase_updated_at))*86400 > 900
ORDER BY phase_age_s DESC;
SQL
```

Если есть открытые `human_requests` — сообщить задачу и вопрос текстом, предложить человеку ответить через UI или `worker_ask_done` (но **сам скилл не отвечает**).

### Шаг 9. GPU / модель (если локально)

```bash
nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed \
           --format=csv,noheader 2>/dev/null
curl -s "http://localhost:1234/api/v0/models" 2>/dev/null \
  | jq '.data[] | {id, state, loaded_context_length, max_context_length}'
```

**Аномалии:**
- Обе карты < 5% утилизации при активных воркерах → модель не отвечает.
- Memory > 95% → риск OOM.
- Temperature > 85°C → троттлинг.

## Шаблон финального отчёта

Структура, которую patrol выдаёт пользователю. Без воды, с цифрами.

```markdown
# 🚨/✅ Срез saga-patrol — <YYYY-MM-DD HH:MM UTC>

**Доска:** <project> / <epic> / stage=<X> / model=<qwen3.6-35b>

## Engine & workers
- engine: running / pid=NNNN / concurrency=N
- workers active: N (фазы: executing=N, reviewing=N)
- последний heartbeat: <X с назад>
- ⚠/✅ сигналы зависания: ...

## Pipeline
- stage: formalization (норма для <N> ч работы)
- needs_human: no
- last_gate_error: <текст или "—">

## Задачи
- done=N, in_progress=N, review=N, todo=N, blocked=N
- самая долгая in_progress: #<id> (age=Nm, phase=executing)

## Циклы
- 4a engine-cycle: <норма/странных серий нет> ИЛИ <N подряд claimable=0 in_flight=1>
- 4b tool_use: top-3 — <tool>:N, <tool>:N, ...; дубликатов нет / есть (X повторов Y)
- 4c токены: input растёт/стабилен, cache=N%, out=N — <прогресс/стагнация>
- 4d api_retry: 0 / N (последние статусы: ...)

## О чём прямо сейчас думает модель
- #<id>: <одна-две фразы из последнего assistant-блока>

## Код (если development+)
- repo: <local_path> / branch=<dev>
- коммиты: N (последний: "<subject>", Nm назад)
- LoC: N (TS=N, tests=N) — экспресс-класс <каркас/MVP/зрелый>
- tsc --noEmit: <ошибок N> — <чисто/есть проблемы>
- незакоммичено: <да/нет>

## Артефакты
- accepted: PRD, SRS, UC×N, FR×N, NFR×N
- draft: AC×N — <норма/отставание>
- orphan AC (без parent): <0 / N>
- drift: <0 / N>

## Needs-human
- открытых запросов: <0 / N>
- вопрос: "<текст>"

## Экспресс-вердикт
<1–3 предложения: эпизод идёт по рельсам / есть проблема X / требует вмешательства человека по Y>
```

## Что patrol НЕ делает никогда

- ❌ Не запускает `npm install`, `npm test`, `npm run build` — они пишут на диск и качают пакеты.
- ❌ Не запускает `tsc` без `--noEmit`.
- ❌ Не вызывает MCP write-tools (`task_update`, `worker_*`, `episode_*`).
- ❌ Не дёргает POST-эндпоинты tracker-view.
- ❌ Не перезапускает engine, не убивает воркеров, не чистит worktrees.
- ❌ Не правит `settings.json`, не переключает модель.
- ❌ Не выдаёт **финальный** балл (1000-score) — только экспресс-оценку готовности к ревью. Финал — это отдельный аудит.

Если в ходе сбора patrol видит проблему, требующую вмешательства — **сообщает** пользователю конкретные шаги и инструменты (какой MCP-вызов / какой UI-кнопкой / какой командой), но **не выполняет** их сам.

## Типовые заключения

- «Эпизод идёт по рельсам» → engine жив, очереди двигаются, циклов нет, артефакты принимаются по плану.
- «Висит на unverifiable AC» → `review_in_progress` долго, в логе — повторяющиеся попытки фикс без смены подхода; рекомендация — либо `worker_ask_done` с реальным ответом, либо пересмотреть AC.
- «Rate limit» → 4d показывает 429-е; рекомендация — снизить `engine_concurrency` или сменить модель.
- «Зомби» → 1b `is_quiet:true` + 4a `WORKER_TERMINATED` подряд; рекомендация — проверить worker-health и при необходимости поднять engine.
- «Recovery-шторм» → 4a много `HEALING/ESCALATE`; рекомендация — посмотреть последний gate error и решить, не нужна ли правка контракта.

## Границы скилла

- Не видит, что происходит на удалённой машине (только локальный stand).
- Не оценивает UX/дизайн/производительность продукта — только формальные метрики (LoC, типы, тесты, commit-graph).
- Не различает «правильно» и «по форме» — глубокая семантика требует отдельного code review.
- Не предсказывает — даёт срез текущего момента.
