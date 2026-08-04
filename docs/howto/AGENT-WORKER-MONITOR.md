# Agent worker monitor — как быстро читать мысли модели

Цель: за 30 секунд понять, **что воркер делает прямо сейчас** — без grep'а
по логам, без долгого ожидания. Для любого агента (или человека), который
наблюдает за saga-движком.

## TL;DR — 3 шага

```bash
# 1. Какие воркеры сейчас активны (даёт log_path каждого)
curl -s "http://localhost:4321/api/workers/active?project_id=13"

# 2. Что воркер думает/делает прямо сейчас (последние 10 событий стрима)
curl -s "http://localhost:4321/api/worker/tail?log_path=<path из п.1>&lines=10"

# 3. Готово — видны tool_use + text + tool_result
```

## Где живут логи (физически)

```
~/.zcode/cli/board-runs/
  board-<projectId>-<enginePid>-<timestamp>/
    task-<taskId>-<workerId>.jsonl   ← stream-json от claude -p
```

**Формат каждой строки JSONL** — claude stream-json:
- `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}, {"type":"tool_use","name":"...","input":{...}}]}}`
- `{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}`
- `{"type":"system","subtype":"thinking_tokens"}` ← ШУМ, тысячи на один turn
- `{"type":"result","subtype":"success","result":"..."}` ← финальный ответ claude

## Канал быстрого чтения мыслей

### Endpoint: `GET /api/workers/active`

**Что даёт:** список активных воркеров с их `log_path`.
**Источник:** SQLite (`worker_executions.state='running'`) + фильтр по живому pid.

```bash
curl -s "http://localhost:4321/api/workers/active?project_id=13"
```

Ответ (упрощённо):
```json
{
  "ok": true,
  "workers": [{
    "id": 113,                        // task_id
    "title": "Discovery: ...",
    "assigned_to": "board-13-...-5",  // worker_id
    "phase": "executing",
    "pid": 8468,
    "started_at": "2026-07-23T...",
    "log_path": "C:\\Users\\...\\board-runs\\board-13-.../\\task-113-board-13-...-5.jsonl",
    "log_mtime_ms": 1784803000000
  }]
}
```

### Endpoint: `GET /api/worker/tail`

**Что даёт:** последние N **значимых** событий из JSONL лога.
**Умность:** фильтрует шум (`thinking_tokens`, `hook_*`) — читает backwards
по 256KB чанкам до 2MB, чтобы найти `lines` осмысленных событий.

```bash
curl -s "http://localhost:4321/api/worker/tail?log_path=<путь>&lines=10"
```

Параметры:
- `log_path` — абсолютный путь к JSONL (из `/api/workers/active` или из БД `worker_executions.log_path`)
- `lines` — сколько значимых событий вернуть (1..50, по умолчанию 8)

Ответ — массив событий, каждый с short label:
```json
{
  "ok": true,
  "events": [
    {"type":"assistant","kind":"tool","tool":"mcp__saga__task_get","snippet":"{\"id\":113}","subagent":false},
    {"type":"assistant","kind":"text","snippet":"Now I understand the task...","subagent":false},
    {"type":"user","kind":"tool_result","snippet":"{\"id\":113,\"title\":\"Discovery: Hello World..."},
    {"type":"assistant","kind":"tool","tool":"mcp__saga__artifact_save","snippet":"{\"path\":\"briefs/...\"}"},
    {"type":"system","subtype":"api_retry","attempt":2,"status":429}
  ]
}
```

**Kind'ы событий:**
| type | kind | что значит |
|---|---|---|
| `assistant` | `tool` | модель вызывает tool (name + snippet input) |
| `assistant` | `text` | модель «думает вслух» (snippet текста) |
| `user` | `tool_result` | результат вызова tool (snippet ответа) |
| `user` | `user_msg` | обычное user-сообщение |
| `system` | `api_retry` | ретрай API (429 / 500 / etc) — внимание к rate-limit |
| `system` | `init` / `plugin_install` | старт сессии |

**Безопасность:** `log_path` обязан резолвиться внутри `board-runs/` root
(path traversal guard). Иначе 403.

## Где искать `log_path` напрямую (без /api/workers/active)

Если движок запущен в другом процессе, можно из БД:

```sql
SELECT log_path, task_id, worker_id, started_at
FROM worker_executions
WHERE epic_id = 14 AND state = 'running'
ORDER BY started_at DESC LIMIT 1;
```

Или по конвенции имени файла (если в log_path пусто):
```
~/.zcode/cli/board-runs/board-<projectId>-*/task-<taskId>-<workerId>.jsonl
```
Свежайший по mtime — текущий.

## Признаки здорового воркера (по tail)

✅ **Воркер работает** — если в tail за последние минуты есть:
- `tool` с `mcp__saga__*` — воркер зовёт saga MCP (правильный путь)
- `text` с осмысленным рассуждением
- `tool_result` без `"is_error":true`

⚠️ **Воркер застрял** — если в tail подряд:
- десятки `thinking_tokens` (модель ушла в длинный reasoning)
- `api_retry` с `status=429` (rate-limit)
- `tool` с `Agent` / `TaskCreate` (модель делегирует вместо работы — saga-worker это запрещает)

❌ **Воркер упал** — если:
- `result` event с `subtype=error`
- `tool_result` с `is_error:true` от saga MCP
- лог перестал расти (проверить `stat -c %s`)

## Признаки больной модели (по текстам)

Гемма и слабые qwen'и ломают XML tool_call формат — это видно в `text`:
```
"Create Discovery Brief</div>"}<tool_call|><|channel>thought
<channel|><|tool_call>call:mcp_saga_task_create{epic_id:14,title:
```
Если видите `<tool_call|>`, `<|channel|>`, `</div>` в `text` или `title` —
модель не справляется с форматом, нужен апгрейд модели.

## Что НЕ делать

- ❌ Читать весь JSONL файл в память (может быть 100MB+). Только `tail` endpoint.
- ❌ Парсить `thinking_tokens` — это шум, один token = одно событие.
- ❌ Полагаться на `tasks.updated_at` для активности воркера — он bump'ится
  на любой metadata change. Смотрите `worker_executions.started_at` и
  `log_mtime_ms` из `/api/workers/active`.

## Сводка контракта

```
                    saga SQLite DB
                          │
                          │ worker_executions.log_path
                          ▼
        ~/.zcode/cli/board-runs/board-*/task-*.jsonl
                          │
                          │ tail (backwards, filter thinking_tokens)
                          ▼
                /api/worker/tail
                          │
                          ▼
            agent / operator видит мысли модели
```

Один curl → виден прогресс. Это и есть «канал быстрого чтения мыслей».
