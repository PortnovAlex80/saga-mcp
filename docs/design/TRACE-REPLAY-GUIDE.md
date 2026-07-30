# Trace Replay Guide — дизайн (2026-07-30)

> Решение проблемы: после reset saga.db модель тратит время на повторную
> регистрацию traces и ошибается (UC→UC-1 вместо UC→PRD), запуская review loops.
> Правильные traces уже известны из managed productions.

## Проблема

- Draft-cache кеширует **документы** между прогонами ✓
- Но **traces** НЕ кешируются — после reset модель заново регистрирует их через MCP
- Модель ошибается (лишние traces), reviewer ловит → review loop → трата времени
- При этом правильные traces уже в `saga3_managed_trace_productions`

## Отклонённые варианты

| Вариант | Почему нет |
|---|---|
| A: Кешировать managed productions | FK на process_run_id ломается после reset; нарушает fence инварианты |
| B: Snapshot artifacts+traces напрямую | id меняются → remapping; либо обходит acceptance gate, либо бесполезен |
| C: Machine-fill trace calls | source_id новых artifacts ещё не существуют до worker launch |
| D: Restore accepted state | Полностью обходит worker + kernel + acceptance gate — нарушение |

## Рекомендуемый вариант F: Trace Replay Guide sidecar

**Суть:** после успешного worker exit — snapshot traces в **stable-key форму**
(code+type, не volatile id). Перед worker launch — materialize guide.json +
заполнить Trace register трекера. Модель следует руководству, не придумывает.

### Расположение

- `src/infrastructure/testing/test-trace-cache.ts` (рядом с test-warm-start.ts)
- Подключается через **существующие** хуки `prepareWorkspace`/`captureWorkspace`
  в `legacy-claude-worker-executor-factory.ts`

### Активация

`SAGA_TEST_TRACE_CACHE=1` (или reuse `SAGA_TEST_WARM_START=1`).
Fail-closed: нет cache → нет guide → worker работает нормально.

### Cache формат

```
.saga/test-trace-cache/epics/<epicId>/<moduleRef>/<nodeId>/
  guide.json     # replay guide, stable keys (code+type)
  metadata.json  # inputHash, packageDigest, lastOutcome
  history/       # предыдущие версии
```

guide.json edges: `{ source: {code, type}, target: {code|role, type}, linkType }`

### Почему code — стабильный ключ

Артефакты имеют `code` (UC-35, PRD, FR-3). После reset draft-cache возвращает
идентичные документы → worker перевыпускает с теми же кодами. Предки (PRD/FR)
идентичны между прогонами. Значит `(sourceCode, linkType, targetCode)`
детерминированно воспроизводим.

### Flow

```
prepareWorkspace:
  prepareProcessExecutionWorkspace(...)   # production
  applyTestWarmStart(...)                 # draft documents cache
  applyTestTraceGuide(...)                # НОВОЕ: guide.json + trace register

captureWorkspace (after worker exit):
  captureTestWarmStart(...)               # draft documents
  captureTraceGuide(..., outcome)         # НОВОЕ: snapshot managed traces → guide
```

### Capture (после worker exit)

- Только при `outcome === 'completed'` (не кешировать сломанный граф)
- Читает `listTracesForNodeInProcessRun` (read-only public API)
- Join с artifacts → resolve code/type/contentHash
- Projection в stable-key форму
- Drop edges с неразрешимыми целями (fail-closed)

### Restore (перед worker launch)

- Проверить metadata.inputHash/packageDigest (gate, как draft-cache)
- Materialize `trace-replay-guide.json` в executionDirectory
- **Заполнить Trace register трекера** (сейчас пустой) — sourceCode, linkType, targetCode
- Инструкция: "Выполните каждую грань через trace_add. Не добавляйте следы,
  не указанные здесь."

### Чистота архитектуры

- НЕ трогает production path (kernel, settlement, acceptance CAS)
- НЕ обходит gates — kernel всё равно валидирует реальный граф
- НЕ добавляет test-понятия в production DTO (guide = просто workspace file)
- Sidecar: только read managed productions + materialize files
- Те же хуки, тот же паттерн, что draft-cache

### Риски

| Риск | Митигация |
|---|---|
| Код предка меняется между прогонами | Key по code+type; drop если не разрешается |
| Кеш неверного графа | Capture только при outcome=completed |
| Guide расходится с реальным графом | inputHash/packageDigest gate перед restore |
| Модель слепо доверяет stale guide | Guide advisory; kernel + reviewer проверяют |
| Test-утечка в production | Sidecar в infrastructure/testing; нет новых DTO полей |

### Ключевые файлы

- `src/infrastructure/testing/test-warm-start.ts` — паттерн для зеркалирования
- `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:306-419` — хуки
- `src/process-modules/persistence/sqlite-managed-production-ledger.ts:533-559` — read API
- `src/process-modules/application/process-execution-workspace.ts:343-467` — tracker materialization
- `src/process-modules/modules/formalization/package/resources/process-module-stage-tracker.md:63-67` — пустой Trace register для заполнения
