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

## Маппинг моделей

Coding-эндпоинт плана обслуживает 9 моделей (проверено `GET .../coding/paas/v4/models`
18.08.2026); в штатном реестре opencode (1.18.18) есть только 4 из них —
остальные шимка добавляет задокументированным паттерном «модель к встроенному
провайдеру» (`provider.zai-coding-plan.models[...]`, доки opencode /providers).
Каталог завода (`FACTORY_CLOUD_MODELS`) содержит все 9. Каждая проверена живым
вызовом через шимку 18.08.2026.

| claude / завод | opencode                        | в реестре opencode |
|----------------|---------------------------------|--------------------|
| glm-4.5        | zai-coding-plan/glm-4.5        | нет → конфиг-надстройка (128K) |
| glm-4.5-air    | zai-coding-plan/glm-4.5-air    | нет → конфиг-надстройка (128K) |
| glm-4.6        | zai-coding-plan/glm-4.6        | нет → конфиг-надстройка (200K) |
| glm-4.7        | zai-coding-plan/glm-4.7        | да |
| glm-5          | zai-coding-plan/glm-5          | нет → конфиг-надстройка (200K) |
| glm-5-turbo    | zai-coding-plan/glm-5-turbo    | да |
| glm-5.1        | zai-coding-plan/glm-5.1        | нет → конфиг-надстройка (200K) |
| glm-5.2        | zai-coding-plan/glm-5.2        | да |
| glm-5.3        | zai-coding-plan/glm-5.3        | нет → конфиг-надстройка (1M) |
| opus/sonnet    | через ANTHROPIC_DEFAULT_OPUS_MODEL, иначе дефолт glm-4.7 | — |

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
| `--output-format stream-json` | `opencode run --format json` + живой перевод реальных событий opencode (`tool_use`/`text`/`step_finish`) в claude-совместимые stream-json строки на stdout — чинит детектор повторных циклов (E-S1, stage-11), tail-вью `/api/worker/tail` и подсчёт токенов в lifecycle-endpoints без правок раннера. Без флага — прежний байт-в-байт passthrough |
| `--bare`, `--disable-slash-commands`, `--strict-mcp-config`, `--verbose`, `--forward-subagent-text`, `--no-session-persistence` | принимаются как no-op |

Выходной код и stdout/stderr пробрасываются. В режиме `--output-format
stream-json` stdout — транслированные claude stream-json строки (события
assistant/tool_use/text + финальный result с суммарным usage); во всех остальных
режимах stdout для формена — только сигнал прогресса (`markExecutionProgress`),
так что ANSI-вывод opencode безопасен. Фикстуры реальных событий opencode
(1.18.18) — в `tests/architecture/claude-shim-stream-json.test.mjs`.

## Provider-retry (429/5xx) — `docs/architecture/PROVIDER-RETRY-DESIGN.md`

Шимка владеет жизненным циклом воркера, поэтому транзиентные смерти провайдера
ретраятся внутри неё — завод не тратит на них бюджет рекавери. Ребёнок
запускается по pipes с живым tee: выход байт-в-байт виден раннеру как раньше
и одновременно захватывается для дискриминатора.

Дискриминатор (консервативный):

| класс | условие | лестница |
|---|---|---|
| `worker-done` | в выводе есть `saga_worker_done` (или claude-`result`-событие) | НИКОГДА (дабл-комплит) |
| `text` | в хвосте ТЕКУЩЕЙ попытки матч `/429\|rate.?limit\|overloaded\|too many requests\|status[: ]5\d\d\|socket connection was closed\|ECONNRESET\|ETIMEDOUT\|fetch failed/i` | по маркеру инструмента: до первого ⚙/`tool_use` — полная, после — сокращённая |
| `pre-tool-death` | exit≠0/сигнал, маркеров инструментов нет нигде в захвате (умер до первого ⚙, доказуемо без сайд-эффектов) | полная, 8 попыток |
| `post-tool-death` | exit≠0 после хотя бы одного ⚙/`tool_use` (риск-класс, который заводская рекавери уже принимает) | сокращённая, 3 попытки |
| `clean` | exit 0 без ретрай-текста | нет |

Сон: `min(2^(n-1), 256)c` + джиттер 0..250мс (фиксированные шаги
синхронизируют параллельных воркеров на одной квоте — джиттер развязывает).
Во время сна — heartbeat в stdout каждые 20с (`progress_at` раннера
троттлится 30с, рипер молчания — 10мин: тишина копится ПОПЫТКАМИ). Каждая
попытка — однострочная заметка в stderr (попадает в JSONL воркера), в конце —
`[agent-proxy] retry summary: N attempts, classes seen: ...`. Итоговый код
выхода — код ПОСЛЕДНЕЙ попытки, как и до ретрая. Тесты:
`tests/architecture/claude-shim-provider-retry.test.mjs` (герметичные —
стаб-бинарник `fixtures/opencode-stub.mjs` вместо opencode через
`SAGA_PROXY_OPENCODE_PATH`, сетевых вызовов и ~/.claude нет).

## Известные ограничения

- 5 из 9 моделей плана отсутствуют в реестре opencode (1.18.18) → шимка
  добавляет их конфигом к встроенному провайдеру (документированный паттерн);
  когда opencode включит их сам, записи станут безвредными дубликатами.
- `--effort` игнорируется (в этом провайдере reasoning выбирается моделью);
  профиль завода glm-5.3 с effort=max отработает как max на стороне модели.
- Инъекция хук-контекста идёт через `session.prompt noReply` — приходит в
  очередь сессии, а не в тело результата инструмента (у opencode нет прямого
  аналога `additionalContext`).
