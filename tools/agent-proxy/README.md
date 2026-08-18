# Agent Proxy — переключение бэкендов завода (opencode / claude / zcode)

Слой совместимости: завод спавнит воркеров через claude-CLI-поверхность
(`claude -p --model X --mcp-config Y --settings <hooks> ...`), а этот прокси
переводит вызов на другой официальный CLI-агент без правок раннера.

## Файлы

- `claude-shim.mjs` — claude-совместимая шимка над `opencode run`
  (Z.AI Coding Plan, провайдер `zai-coding-plan`).
- `saga-structured-context.plugin.js` — порт PostToolUse/PostToolUseFailure-хуков
  завода на OpenCode-плагин (`tool.execute.after` + `session.prompt noReply`).
  Копируется в `~/.config/opencode/plugins/` шимкой; без фабричного env — no-op.

## Переключение агентов

```bash
# OpenCode (Z.AI Coding Plan — официальный провайдер в opencode)
export SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"

# Claude (резерв, по умолчанию) — просто не задавать переменную
unset SAGA_REAL_CLAUDE_PATH
```

Авторизация OpenCode: `~/.local/share/opencode/auth.json`, провайдер
`zai-coding-plan` (ключ Coding Plan, тот же что у claude-канала; эндройнт
`https://api.z.ai/api/coding/paas/v4`).

## Маппинг моделей (проверен по `opencode models` 2026-08-18)

| claude / завод | opencode                       |
|----------------|--------------------------------|
| glm-4.7        | zai-coding-plan/glm-4.7        |
| glm-5-turbo    | zai-coding-plan/glm-5-turbo    |
| glm-5.2        | zai-coding-plan/glm-5.2        |
| glm-5.3        | zai-coding-plan/glm-5.2 (fallback — 5.3 нет в реестре opencode) |
| opus/sonnet    | через ANTHROPIC_DEFAULT_OPUS_MODEL, иначе дефолт glm-4.7 |

`--effort` игнорируется (в этом провайдере reasoning выбирается моделью).
Дефолт-модель прокси: `SAGA_PROXY_DEFAULT_MODEL`.

## Что переводится

| claude-флаг | Куда |
|---|---|
| `-p` + промпт из stdin | `opencode run` (промпт пайпом в stdin) |
| `--model` | `--model` (маппинг выше) |
| `--mcp-config <path>` | `OPENCODE_CONFIG` с секцией `mcp` (local, command[], environment, timeout 60s) |
| `--settings` (PostToolUse-хуки) | плагин `saga-structured-context` (см. выше) |
| `--disallowedTools` | `OPENCODE_PERMISSION` deny (оба написания MCP-инструментов; реальная authority — гейтвей saga) |
| `--allowedTools` | не переводится (opencode не имеет allowlist-only режима; D-whitelist — оптимизация токенов, authority остаётся за гейтвеем) |
| `--bare`, `--disable-slash-commands`, `--strict-mcp-config` | принимаются как no-op |

Выходной код и stdout пробрасываются. stdout для формена — только сигнал
прогресса (`markExecutionProgress`), так что ANSI-вывод opencode безопасен.

## Известные ограничения

- glm-5.3 отсутствует в реестре провайдера opencode → автоматический fallback
  на glm-5.2 (тот же план/квота), с пометкой в stderr.
- Инъекция хук-контекста идёт через `session.prompt noReply` — приходит в
  очередь сессии, а не в тело результата инструмента (у opencode нет прямого
  аналога `additionalContext`).
