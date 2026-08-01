# Hooks & Tracking — Verify Report

> Дата: 2026-07-31. 4 verify-агента отработали end-to-end проверку.
> Каждый вердикт доказан `file:line`. Состояние: коммит `393a014`.

---

## Сводная матрица вердиктов

| Механизм | Вердикт | Суть |
|---|---|---|
| **Hook chain (доставка файлов в prompt)** | 🟢 **GREEN** | 4 канала работают: inline + PostToolUse hook + MCP task_get + env |
| **Tracker as program-counter** | 🟡 **PARTIAL** | Код работает, но enforcement — только текст в prompt, не механический gate |
| **assistance.json end-to-end** | 🟡 **YELLOW** | Работает ТОЛЬКО для Discovery; 3 модуля никогда не создают файл |
| **recovery-feedback.json** | 🟢 **WORKS** | Реально срабатывал (2 файла на диске); но development impl-tracker его не упоминает |
| **review-feedback.json** | 🟡 **WORKS-PARTIAL** | Код валиден, но ни разу не срабатывал в этой инсталляции |
| **node-stable workspace (P18)** | 🟢 **WORKS** (код+тест) | Cross-node leak невозможен; но 0 реальных node-keyed директорий на диске |

---

## 1. 🟢 Hook Chain — GREEN (4 канала доставки)

Механизм: **inline + hook + env + mcp-response** — все четыре активны.

```
materializePinnedWorkspace writes files to disk
        │
   ┌────┴─────────────────┬──────────────────────┐
   ▼                      ▼                      ▼
CH1 INLINE           CH2 HOOK                CH3 MCP
prompt body          PostToolUse reads       task_get returns
tracker_path,        agent-assistance.json   _workflow_hint
workspace_files      → additionalContext
[runner:262-280]     [hook:339-344]          [tasks.ts:740]
   │                      ▲
   │                      │
   └─────► CH4 ENV ───────┘
          SAGA_AGENT_ASSISTANCE_PATH
          [runner:907]
```

| Канал | Что доставляет | Доказательство |
|---|---|---|
| CH1 inline | пути tracker/feedback/call-files в системный промпт + приказ "Read tracker before action" | `tracker-view/claude-runner.mjs:262-280` |
| CH2 hook | agent-assistance.json content → additionalContext после каждого tool call | `tracker-view/structured-context-hook.mjs:339-344`, wired `claude-runner.mjs:794-797` |
| CH3 MCP | task_get возвращает `_workflow_hint` с путями | `src/tools/tasks.ts:740-743` |
| CH4 env | SAGA_AGENT_ASSISTANCE_PATH для hook subprocess | `tracker-view/claude-runner.mjs:907` |

> Runner НЕ читает tracker.md/assistance.json напрямую в промпт — только SKILL.md
> (`claude-runner.mjs:184,198,219`). Tracker байты попадают только когда Claude сам
> выполнит `Read` по пути из CH1/CH3.

---

## 2. 🟡 Tracker as Program-Counter — PARTIAL

| Аспект | Статус | Доказательство |
|---|---|---|
| Трекер создаётся в workspace | ✅ WORKS (код) | `pinned-workspace-materializer.ts:362` writeFileSync |
| Протокол говорит "читай трекер" | ✅ HARD rule | `skills/saga-process-module-worker-protocol/SKILL.md:33-41`: "Read it before every consequential action" |
| Hook парсит трекер | ❌ НЕТ (by design) | `structured-context-hook.mjs:326`: "Do not parse Markdown trackers" |
| Механическое enforcement | ❌ НЕТ | Только текст в промпте; модель может пропустить без ошибки |
| Реально запускался | ❌ НЕТ | `find . -path "*/executions/*" -name "*tracker*.md"` → 0 результатов |

> Hook намеренно НЕ парсит трекеры — он рендерит blocks из agent-assistance.json (JSON),
> не из markdown. Tracker — это "model-only" артефакт: файл доступен, протокол просит
> читать, но нет gate который блокирует действие если модель не прочитала.
>
> `agent-assistance-projection.ts:4-5`: "bootstrap projection used BEFORE the durable
> inner-NodeProtocol cursor is wired" — долговечный курсор объявлен, но НЕ подключён.

---

## 3. 🟡 assistance.json — YELLOW (только Discovery)

| Звено | Discovery | Formalization/Development/Delivery |
|---|---|---|
| Файл создаётся | ✅ `manifest.ts:428` → assistance.ts (3 узла) | ❌ `manifest.assistance` пустой/отсутствует |
| Hook читает | ✅ `structured-context-hook.mjs:106-116` | ✅ (но fail-closed в `{}` т.к. env пустой) |
| Доходит до prompt | ✅ additionalContext после tool call | ❌ hook молчит, модель без assistance |
| Реально на диске | ❌ 0 файлов (`find . -name agent-assistance.json`) | ❌ |

### Мёртвый код: `agent-assistance-renderer.ts` (780 строк)
- Схема `saga3.agent-assistance.v1` — **НИКТО не импортирует** в продакшене
- Реальный producer — `agent-assistance-projection.ts` (124 строки), схема `saga3.agent-assistance-projection.v1`
- Renderer имеет mode/budget/dedup функции — **всё мёртвое**
- Только тест импортирует: `tests/process-modules/agent-assistance-renderer.test.mjs`

### Механизм "невидимый" для модели
Ни один skill/tracker НЕ документирует agent-assistance.json:
- `grep -rln "agent-assistance" skills/` → 0
- `grep -rln "agent-assistance" src/process-modules/modules/*/package/resources/` → 0

---

## 4. 🟢 recovery-feedback.json — WORKS (с оговоркой)

| Аспект | Статус | Доказательство |
|---|---|---|
| Пишется | ✅ | `pinned-workspace-materializer.ts:236`, `process-execution-workspace.ts:416` |
| Источник данных | ✅ | recovery engine → `generic-flow-executor.ts:1030-1047` → lineage bag → task metadata |
| Реально срабатывал | ✅ | `docs/formalization/projects/1/executions/task-4/recovery-feedback.json` (attempt 1/2) |
| Трекеры говорят читать | ✅ 6/7 | все кроме `implementation-task-tracker.md` |
| Протокол упоминает | ❌ | `skills/saga-process-module-worker-protocol/SKILL.md` — 0 упоминаний |
| Инжект в objective | ✅ | `lm-node-executor.ts:296-309`: "Recovery attempt N/M: ... Read recovery_feedback" |

> Discovery/formalization спасает **дублирование каналов** (трекер + assistance.ts +
> semantic skill + objective injection). Development уязвим — impl-tracker не
> упоминает recovery-feedback.

---

## 5. 🟡 review-feedback.json — WORKS-PARTIAL

| Аспект | Статус | Доказательство |
|---|---|---|
| Пишется | ✅ (код) | `pinned-workspace-materializer.ts:247`, `process-execution-workspace.ts:431` |
| Источник данных | ✅ | `dispatcher.ts:911`: `json_set('$.managed_review_last_feedback', result)` на changes_requested |
| Реально срабатывал | ❌ НЕТ | `find . -name review-feedback.json` → 0 результатов |
| Трекеры говорят читать | ✅ 7/7 | включая `implementation-task-tracker.md:50` |

### Dead code: `readTaskReviewFeedback`
- `sqlite-saga3-discovery-runtime.ts:473-487` — реализован
- `lm-node-executor.ts:181` — объявлен в интерфейсе
- **0 вызовов** в продакшене (grep по `src/`, `tracker-view/`, `tests/`)
- НЕ блокер — рабочий путь через `reviewFeedbackFromMetadata` → materializer

---

## 6. 🟢 Node-Stable Workspace (CGAD P18) — WORKS

| Аспект | Статус | Доказательство |
|---|---|---|
| Directory keyed by NODE | ✅ | `pinned-workspace-materializer.ts:204,209-214`: `executions/node-${nodeId}/` |
| Tracker filename node-scoped | ✅ | `:355`: `project-${epicId}-${stage}-node-${nodeId}.md` |
| Draft inheritance | ✅ safe | `:260`: `dirname` ограничивает сканирование папкой узла; cross-node leak невозможен |
| Тесты | ✅ | `pinned-workspace-materializer.test.mjs:119,144` |
| Реально запускался | ❌ | 0 node-keyed директорий на диске; существующие `docs/.../executions/` используют legacy `task-<id>/` |

---

## 🔧 Что нужно сделать (приоритезировано)

### P0 — Критично (модели без assistance умирают)

1. **Создать `assistance.ts` для formalization** (5 LM-узлов) — активирует CH2 hook канал
   - Узлы: define-product-contract, model-use-cases, define-acceptance-contract, reconcile-what, define-architecture-contract
   - Подключить в `src/process-modules/modules/formalization/package/manifest.ts`

2. **Создать `assistance.ts` для development** (планнер + impl-worker)
   - Узлы: plan-task-graph (Flow LM), development-implementation-worker (flow-less profile)
   - Фикс `resolveOwningNodeId` (`pinned-workspace-materializer.ts:162-180`) для flow-less профилей
   - Подключить в `src/process-modules/modules/development/package/manifest.ts`

### P1 — Важно (протокол слеп к feedback/assistance)

3. **Обновить `skills/saga-process-module-worker-protocol/SKILL.md`**:
   - Добавить правило: "Read agent-assistance.json beside tracker when present"
   - Добавить правило: "Read recovery-feedback.json / review-feedback.json FIRST when present"
   - Сейчас протокол молчит про оба — слабая модель не знает об их существовании

4. **Поправить `implementation-task-tracker.md`**: добавить recovery-feedback.json в правило feedback-first (сейчас только review-feedback.json)

### P2 — Чистка (мёртвый код)

5. **Удалить `agent-assistance-renderer.ts`** (780 строк) — мёртвый, никто не импортирует
6. **Удалить `readTaskReviewFeedback`** из интерфейса и реализации — 0 вызовов, есть рабочий путь

---

## Ссылки (кликабельные)

### Доставка в prompt (hook chain)
- Runner buildPrompt: `tracker-view/claude-runner.mjs:262-280`
- Hook registration: `tracker-view/claude-runner.mjs:769-907`
- Hook reads assistance: `tracker-view/structured-context-hook.mjs:106-116,339-344`
- MCP task_get hint: `src/tools/tasks.ts:740-743`

### Materializer (writer)
- Tracker: `src/process-modules/application/pinned-workspace-materializer.ts:362`
- Assistance: `:374-422` (только если manifest.assistance непустой)
- Recovery feedback: `:236`
- Review feedback: `:247`

### Assistance (данные)
- Discovery (единственный живой): `src/process-modules/modules/discovery/package/assistance.ts`
- Projection (живой renderer): `src/process-modules/application/agent-assistance-projection.ts`
- Renderer (МЁРТВЫЙ): `src/process-modules/application/agent-assistance-renderer.ts`

### Feedback (writer/reader)
- Recovery source: `src/process-modules/application/generic-flow-executor.ts:1030-1047`
- Review source (DB): `src/tools/dispatcher.ts:906-922`
- Review reader (рабочий): `src/process-modules/application/process-execution-workspace.ts:367-385`
- Review reader (DEAD): `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts:473-487`

### Protocol skill
- `skills/saga-process-module-worker-protocol/SKILL.md` (молчит про assistance + feedback)

### Trackers
- Discovery (4): `src/process-modules/modules/discovery/package/resources/*-stage-tracker.md`
- Formalization: `src/process-modules/modules/formalization/package/resources/process-module-stage-tracker.md`
- Development planner: `src/process-modules/modules/development/package/resources/process-module-stage-tracker.md`
- Development impl (асимметрия): `src/process-modules/modules/development/package/resources/implementation-task-tracker.md:50`
