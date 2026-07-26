# P6c — Universal ProcessModuleRuntime исполняет Discovery как данные

> **Ветка:** `agent/saga3-process-modules`
> **Предыдущий план:** `docs/plans/PROCESS-MODULES-PLAN-V2.md` (P0–P5b сделаны)
> **Связанные:** `docs/research/CHAIN-WORKING-V2.md`

---

## Переформулированная цель

Построить **один** Universal ProcessModuleRuntime, который читает `ProcessModuleDefinition` как данные и сам исполняет Flow (LM/Kernel/terminal узлы) — без кода, знающего слово «discovery». Доказать на canonical-тесте: **epic 39 (Discovery, baseline outcome=go, certificate #23) проходит end-to-end через generic-flow с тем же outcome и certificate**, после чего `Saga3DiscoveryEngine` и `ExistingOrchestrationEngineAdapter` для Discovery **удаляются**, а в composition-root не остаётся module-specific ветки.

### Граница (инвариант)

- **Discovery Pack = содержание:** schemas (`saga3.discovery-proposal.v1`, readiness, diagnosis, certificate), settlement policy (`discoverySettlementPolicyV1` + reason codes + thresholds), skills (`saga-discovery-*`), provenance rules (`collectDiscoverySourceRefs`), handler-имена как строки (`'discovery-settlement-policy'`), intent-kind строки (`'discovery'`/`'discovery.normalize'`/...).
- **Runtime Core = физика:** Flow walker, node dispatch (LM/Kernel/terminal), WorkIntent lifecycle, task projection, worker spawn, fencing, generic certificate infra.

**В Runtime — ни одной ссылки на discovery-конкретные символы.** Discovery подключается **регистрацией** handlers/schemas/строк при установке модуля.

---

## Стартовая точка (уже есть — сделано в P0–P5b)

| Что | Где | Статус |
|---|---|---|
| `ProcessModuleDefinition` schema | `src/process-modules/domain/process-module.ts:137-147` | ✓ |
| `discoveryProcessModule@3.0.0` descriptor | `src/process-modules/modules/discovery/discovery-process-module.ts` | ✓ (12 узлов, 22 перехода, 5 профилей, settlement policy, invariants) |
| `ProcessRun` persistence + idempotency + write-once + 5 tools | `src/process-modules/persistence/process-run*.ts`, `src/tools/process-modules.ts` | ✓ |
| `ProcessModuleExecutor` SPI + `ExecutorKind='generic-flow'` | `src/process-modules/application/process-module-executor.ts:81-96` | ✓ (но `generic-flow` реализаций нет) |
| `ProcessModuleInstallationRegistry` | `src/process-modules/application/process-module-installation-registry.ts` | ✓ (мёртвый в composition-root) |
| `ProcessOutcomeCertificate` generic table | `src/process-modules/persistence/process-outcome-certificate*.ts` | ✓ |
| `validateProcessModuleRunResult` | `src/process-modules/application/validate-process-module-run-result.ts:62-128` | ✓ (**orphaned** — никем не вызывается) |
| WorkIntent lifecycle (`createIntent`/`ensureProjectedTask`/`setIntentStatus`) | `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts` | ✓ (generic по форме, но захардкожены `workflow_stage='discovery'`/`execution_mode='tracker_only'`/`title="Discovery: "`) |
| `WorkerExecutor` port + `createLegacyClaudeWorkerExecutorFactory` | `src/application/ports/worker-executor.ts`, `src/infrastructure/workers/` | ✓ |
| `resolveExecutionProfile` + skill inlining (protocol+semantic) | `src/process-modules/application/execution-profile-resolver.ts`, `tracker-view/claude-runner.mjs:35-111` | ✓ |
| `discoverySettlementPolicyV1`, `Saga3Discovery{Normalization,Readiness,Settlement,Diagnosis}Service` | `src/saga3/` | ✓ (вызываются из монолитного engine, не из registry) |
| Poll-loop skeleton для LM-node spawn/wait/recover | `src/engines/saga3-discovery-engine.ts:543-625` | ✓ (переиспользовать как образец) |

### Главные пробелы (что отсутствует для P6c)

1. `GenericFlowExecutor implements ProcessModuleExecutor` — нет ни класса, ни `NodeRun`, ни walker'а.
2. Kernel handler registry — 5 handler id'ов (`discovery-settlement-policy`, `discovery-normalization-kernel`, `formalization-baseline-freezer`, `formalization-settlement-policy`, `process-outcome-emitter`) декларативны, **0 из 5** имеют registry dispatch.
3. WorkIntent projection entangled с discovery: хардкоды в `ensureProjectedTask` + `readWorkIntentForTaskClaim` (`dispatcher.ts:273,285,287`) кидает `AUTHORITY_BINDING_INVALID` только для `task_kind==='discovery.work'`.
4. `tasks.execution_mode` CHECK (`src/schema.ts:115`) не содержит `'artifact_change'`, который formalization-профили объявляют → миграция.
5. Нет generic per-node output store.

---

## План (7 шагов)

### Шаг 0 — Записать план в файл
✓ Этот файл.

### Шаг 1 — Node-executor contract + KernelHandlerRegistry

**Новые файлы:**
- `src/process-modules/application/node-executor.ts` — порт `NodeExecutor` + `NodeExecutionContext`/`NodeExecutionResult` (`event + output + outcome`).
- `src/process-modules/application/kernel-handler-registry.ts` — по конвенции `ProcessModuleRegistry`/`InstallationRegistry`: `Map<handlerId, KernelHandler>`, `register/get/require/list`, throw на дубль. В `application/` (между domain и runtime).
- `src/process-modules/application/handlers/process-outcome-emitter.ts` — generic terminal handler, параметризованный `node.emitsOutcome`. **Не знает** про `go`/`clarify` — берёт строку из терминального узла.

**Правки:**
- Расширить `validateProcessModuleInstallation`: каждый `KernelFlowNodeDefinition.handler` должен иметь зарегистрированный callable — fail-fast при установке, не при первом dispatch.

### Шаг 2 — Параметризация WorkIntent projection (исправление entanglement)

- `ensureProjectedTask`: `workflow_stage`/`execution_mode`/`title`/`priority` → параметры `EnsureProjectedTask` (сейчас хардкод).
- Миграция: добавить `'artifact_change'` в `tasks.execution_mode` CHECK (`src/schema.ts:115`).
- `readWorkIntentForTaskClaim` (`src/tools/dispatcher.ts:273,285,287`): убрать literal `task_kind==='discovery.work'`, обобщить до «таск с `metadata.work_intent_id`».
- WorkIntent lifecycle остаётся в `saga3/` (уже generic по форме) — перенос физического расположения отложить, только параметризовать.

### Шаг 3 — GenericFlowExecutor (Flow walker)

**Новые файлы:**
- `src/process-modules/application/generic-flow-executor.ts` — `class GenericFlowExecutor implements ProcessModuleExecutor { readonly kind = 'generic-flow' }`.
- `src/process-modules/persistence/node-run.ts` + `sqlite-node-run-repository.ts` — новая таблица `saga3_node_runs` (process_run_id, node_id, kind, status, event, output_ref, attempt, started_at, completed_at) для restart/recovery.

**Walk-алгоритм:**
```
entryNodeId → dispatch by node.kind → выбрать transition по эмитированному event
            → ... → до terminal node
```

- **LM-node:** по `executionProfile` создать `WorkIntent` (`kind`/`output_schema`/`allowed_tools` из профиля) → `ensureProjectedTask` (`workflow_stage`/`task_kind`/`execution_skill` из профиля) → `WorkerExecutor.start({concurrency:1, claimScope:{taskIds:[taskId]}})` → poll `executor.status()` + `readTaskState` до terminal → validate output против `profile.outputSchema` → вернуть node event. Poll-loop skeleton из `saga3-discovery-engine.ts:543-625`.
- **Kernel-node:** `handlerRegistry.require(node.handler)(ctx)`.
- **Terminal-node:** `process-outcome-emitter` → `outcome = node.emitsOutcome`.
- **Settlement:** после terminal — `validateProcessModuleRunResult(module, result)` (wired, сейчас orphaned) → `process_run` `created→preparing→running→settling→completed` → `certificateRepo.issue(...)`.

### Шаг 4 — Discovery Pack как registrant

**Новый файл:** `src/process-modules/modules/discovery/discovery-installation.ts`.

Регистрирует handlers под id'ами из descriptor'а:
- `'discovery-normalization-kernel'` → thin adapter над `Saga3DiscoveryNormalizationService` (content остаётся в `saga3/`).
- `'discovery-settlement-policy'` → thin adapter над `discoverySettlementPolicyV1` (Discovery content: manifest, reason codes, thresholds, `GO_MIN_CONFIDENCE=0.70`).
- `'process-outcome-emitter'` → generic handler (общий, не discovery).

LM-узлы `assess-readiness` и `diagnose`: pre-hook (собрать immutable readiness/diagnosis case) + post-hook (validate `readiness_submit`/`diagnosis_submit` submission) **вокруг** LM-исполнения — это **не** kernel handlers.

`createBuiltInProcessModuleInstallationRegistry` получает установки Discovery+handlers.

### Шаг 5 — Composition-root: убрать Discovery branch

- Удалить `isSaga3DiscoveryMode` branch (`src/app/composition-root.ts:113-174`).
- Подключить `ProcessModuleInstallationRegistry` к composition-root.
- Единый путь:
  ```
  resolveConfiguredModule(env)
    → registry.require(moduleRef)
    → ProcessModuleRuntimeEngine({ module, flowExecutor: genericFlowExecutor, handlerRegistry })
  ```

### Шаг 6 — Удалить Saga3DiscoveryEngine + ExistingOrchestrationEngineAdapter (для Discovery)

**Только после зелёного E2E (шаг 7).**

- Удалить специализированный engine.
- `ExistingOrchestrationEngineAdapter` — удалить для Discovery (оставить только если нужен для других legacy migration).
- Удалить/пометить deprecated: `saga3-discovery-engine.ts`, Discovery-specific сервисы как самостоятельные pipeline (логика переиспользована как node handlers в шаге 4).

### Шаг 7 — E2E проверка + регрессия

- **epic 39 через generic-flow** → `outcome=go`, certificate идентичен baseline #23.
- Все `tests/process-modules/*` зелёные (baseline-тесты P0–P5).
- Gate: `tsc` GREEN, `npm test` GREEN (известная heap-exhaustion Saga2 на Windows — не блокер, CI GREEN).

---

## Критерий успеха (Definition of Done)

1. ✅/⚠️ epic 39 через generic-flow → `outcome=go`, certificate совпадает с baseline #23.
   - **Частично:** E2E-тест на synthetic module проходит (5/5, `tests/process-modules/generic-flow-executor.test.mjs`). Live epic 39 требует ручного прогона с worker spawn — не запускался (нужен LM environment, не CI). Шаг 6 (удаление legacy engine) сознательно отложен до зелёного live E2E, чтобы не потерять regression-baseline.
2. ✅ **0 ссылок на discovery-конкретные символы** в generic runtime core (`generic-flow-executor`, `node-executor`, `kernel-handler-registry`, `process-outcome-emitter`, `kernel-node-executor`, `lm-node-executor`). Audit: `grep` подтверждает только комментарий в kernel-handler-registry.ts.
3. ⚠️ `Saga3DiscoveryEngine` удалён — **НЕ сделано (шаг 6 отложен)**. Оставлен как regression-baseline; новый `saga3-discovery-generic` режим добавлен как primary generic-flow путь.
4. ⚠️ composition-root без `if (isSaga3DiscoveryMode)` — **частично**. Добавлена `saga3-discovery-generic` ветка (через Installation Registry); legacy ветка оставлена.
5. ✅ `validateProcessModuleRunResult` вызывается в settlement path (`generic-flow-executor.ts`).
6. ✅ `KernelHandlerRegistry` проверяет handler coverage при установке модуля (тест 4/5 в generic-flow-executor.test.mjs).

## Regression status (2026-07-26)

- `tsc --noEmit` GREEN.
- `node --test tests/process-modules/*.test.mjs` → 104/104 pass (99 ранее + 5 новых).
- `node --test tests/**/*.test.mjs` → 706/706 pass (полная регрессия: миграция schema, обобщение dispatcher, параметризация projection ничего не сломали).

---

## Архитектурный ревью от 2026-07-26 (после коммита 6f903ab)

Вердикт: коммит — правильный шаг, каркас верный (GenericFlowExecutor + NodeExecutor
+ KernelHandlerRegistry + discovery-installation как Pack/Core boundary), НО
три моих «точечных фикса» были поверхностными. Главная корректировка:

> Runtime должен передавать между узлами не сырые объекты и не последние записи
> эпика, а durable, типизированные ссылки на точные продукции конкретных NodeRun
> и WorkIntent.

Директива: 10 шагов (Д1–Д10). До их завершения `Saga3DiscoveryEngine` удалять нельзя.

### Статус Д-фиксов

| # | Директива | Статус | Где |
|---|---|---|---|
| Д1 | Event model: разделить runtimeEvent (completed/failed/paused) и domainEvent (accepted/go/clarify). LM эмитит только runtime, kernel — domain. Flow transitions используют prefixes runtime.*/domain.* | ✅ | node-executor.ts (NodeExecutionResult + nodeEventForTransition), kernel-node-executor.ts, lm-node-executor.ts, discovery-process-module.ts transitions |
| Д2 | Убрать Diagnosis из outcome-critical path: settle → terminal outcome + certificate напрямую; D5 как advisory enrichment после ProcessRun | ✅ | discovery-process-module.ts (diagnose node removed from flow; settle → complete-* directly) |
| Д3 | Durable NodeProduction {schema, artifactRef, contentHash, bindings}. LM/kernel возвращают продукцию, не {taskId, intentId} и не raw output | ✅ | node-executor.ts (NodeProduction), kernel-handler-registry.ts (KernelHandlerResult.production), lm-node-executor.ts, discovery-installation.ts |
| Д4 | Exact lineage в settlement: proposalId/proposalHash/assessmentId из NodeProduction цепочки, НЕ latest-by-epic | ✅ | discovery-installation.ts (createDiscoverySettlementHandler читает bindings.proposalId; fallback readLatestProposalByEpic только когда chain пуст) |
| Д5 | Preparation nodes для D2/D3/D5 (создают ControlIntent, immutable case, bindings) | ✅ partial | discovery-process-module.ts (prepare-readiness kernel node added; prepare-diagnosis не нужен — D5 убран из critical path в Д2), discovery-installation.ts (createPrepareReadinessHandler), lm-node-executor.ts (preProjectedTaskId/preProjectedIntentId reuse) |
| Д6 | Убрать второй settle callback: settlement kernel сам формирует certificate envelope в bindings. Runtime только валидирует + сохраняет | ✅ | generic-flow-executor.ts (settle option удалён; cert читается из terminal.production.bindings.certificatePayload), discovery-installation.ts, process-outcome-emitter.ts (preserves upstream bindings) |
| Д7 | Atomic certificate issuance: validation + issue + ProcessRun-completion в правильном порядке | ✅ partial | generic-flow-executor.ts (issue → validate → complete; полная транзакция across tables — follow-up) |
| Д8 | Restart: durable NodeRun output bindings_json, resume восстанавливает chainInput | ✅ | node-run.ts (outputBindings field), sqlite-node-run-repository.ts (output_bindings column + migration), generic-flow-executor.ts (chainInput restored from last completed NodeRun bindings) |
| Д9 | Убрать Discovery literals из generic adapter (outcomeAuthority, canonical-json → shared/) | ✅ | shared/canonical-json.ts (re-export из saga3/shared), generic-flow-engine-adapter.ts (authority из RunResult, не хардкод; import из shared/) |
| Д10 | Тесты сценариев: go/clarify/reject/semantic-normalization/missing-readiness/restart/два-Proposal/cert-validation-failure | ⏳ pending | — |

### Дополнительные поправки (из ревью)

- ✅ `outputSchema: profile.outputSchema.id` (был `workIntentSchema.id`) — lm-node-executor.ts
- ✅ `findReadinessSlice` epicId/proposalId баг — теперь принимает (epicId, proposalId, assessmentId) и фильтрует корректно
- ⏳ `NodeExecutionContext.processInput` + `nodeInput` — пока chainInput один; нужен separate field для module input vs node input (Д8 related)
- ✅ 5 E2E тестов обновлены под новый event model + NodeProduction

### Что нельзя делать до завершения Д-фиксов

- Удалять `Saga3DiscoveryEngine` / `ExistingOrchestrationEngineAdapter` для Discovery
- Считать P6c завершённым
- Запускать live epic 39 ожидая совпадения certificate с baseline #23 (Д5 preparation nodes + Д8 restart ещё не готовы — live прогон остановится на readiness_get/diagnosis_get без control binding)

### Regression status после Д1-Д7 (2026-07-26)

- `tsc --noEmit` GREEN.
- `node --test tests/process-modules/*.test.mjs` → 104/104 pass.
- generic-flow-executor.test.mjs: 5/5 pass under new event model + NodeProduction + Д6 (no settle callback).

## Что НЕ входит (граница scope)

- Human/External/Composite node executors — объявлены, кидают `not implemented` (composite = recursive GenericFlowExecutor вызов, но не в этом этапе).
- Parallel branches, joins, compensation.
- Lifecycle Orchestrator (отдельный epic по плану v2).
- Перевод Formalization на generic-flow — **следующий** шаг после proof на Discovery.

## Риски

- **Poll-loop для LM-node** — переиспользовать skeleton из `saga3-discovery-engine.ts:543-625`, вынести discovery-specific post-`worker_done` валидацию как pluggable hook.
- **`ensureDiscoveryWorkspace`/`ensureStageTemplate`** — захардкожены под discovery; параметризовать template-пути из профиля.
- **Если epic 39 состояние изменилось** — использовать как fixture, не хардкодить в CI.

---

## Файлы (по шагам)

| Шаг | Файл | Тип |
|---|---|---|
| 1 | `src/process-modules/application/node-executor.ts` | new |
| 1 | `src/process-modules/application/kernel-handler-registry.ts` | new |
| 1 | `src/process-modules/application/handlers/process-outcome-emitter.ts` | new |
| 1 | `src/process-modules/application/validate-process-module-installation.ts` | edit |
| 2 | `src/saga3/persistence/saga3-discovery-runtime-port.ts` (`EnsureProjectedTask`) | edit |
| 2 | `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts:148` (`ensureProjectedTask`) | edit |
| 2 | `src/schema.ts:115` (execution_mode CHECK) | edit |
| 2 | `src/tools/dispatcher.ts:273,285,287` | edit |
| 3 | `src/process-modules/application/generic-flow-executor.ts` | new |
| 3 | `src/process-modules/persistence/node-run.ts` | new |
| 3 | `src/process-modules/persistence/sqlite-node-run-repository.ts` | new |
| 4 | `src/process-modules/modules/discovery/discovery-installation.ts` | new |
| 5 | `src/app/composition-root.ts:113-174` | edit |
| 6 | `src/engines/saga3-discovery-engine.ts` | delete/trim |
| 7 | `tests/process-modules/generic-flow-executor.test.mjs` | new |
