# Saga2 → Saga4 Cutover — Architect Verify Report

> Дата: 2026-07-31. 6 архитекторов-верификаторов проверили каждое утверждение
> архитектора-критика с file:line доказательствами.
> Состояние: коммит `a83f20a`.

---

## Итоговый вердикт: архитектор-критик ПРАВ

Saga4 оторвана от Saga2 как **продуктовый orchestration engine** (выполнено),
но **НЕ оторвана как инфраструктурный runtime и control plane** (не завершено).

---

## Сводная матрица по слоям

| Слой | Статус | Доказательство |
|---|---|---|
| Product Lifecycle routing | ✅ Чисто | `selectEngine` = единственный engine (`composition-root.ts:156-181`) |
| Process Module Flow | ✅ Чисто после `0088685` | external kind удалён |
| Development worker mechanic | ✅ Чисто | общая очередь, lm+kernel |
| Board lifecycle projection | ✅ Чисто | `sqlite-board-projection-reader.ts:77-80` читает `saga3_lifecycle_runs` |
| Project bootstrap/delete/provenance | ✅ Чисто | `projects.ts:268` — saga3_lifecycle_runs guard |
| **Application composition** | ❌ НЕ чисто | 7 Saga2 infra объектов в production-default (`composition-root.ts:106-137,262`) |
| **Execution control** | ❌ НЕ чисто | `LegacyEngineAdministration` пишет engine_* в `episode_workflows` |
| **PID/concurrency/start/stop** | ❌ НЕ чисто | `legacy-engine-administration.ts:110-139,225-251` |
| **Worker model routing** | ❌ НЕ чисто (хранение) | `episode_workflows.metadata.active_model` в 3 сайтах |
| **Saga2 persistence interfaces** | ❌ Активны | `saga2-runtime-persistence.ts`, `saga2-host-runtime.ts` |
| **episode_workflows как operational authority** | ❌ Активна | engine_*, active_model, stage — live read/write |

---

## Что подтвердили 6 архитекторов

### 1. ✅ Composition root собирает Saga2 infrastructure (архитектор ПРАВ)

7 объектов реально создаются в production-default path `createSaga2Application`:

| объект | file:line | создаётся в prod? |
|---|---|---|
| `SqliteEpisodeRuntimeRepository` | `composition-root.ts:106` | ✅ default |
| `SqliteTaskRuntimeRepository` | `:107` | ✅ default |
| `SqliteExecutionRuntimeRepository` | `:108` | ✅ default |
| `SqliteWorkspaceResolver` | `:109` | ✅ default |
| `NodeSaga2HostRuntime` | `:119` | ✅ default |
| `LegacyEngineAdministration` | `:137` | ✅ default |
| `createLegacyClaudeWorkerExecutorFactory` | `:262` (через `createPinnedWorkerFactory`) | ✅ prod |

**Критическое уточнение:** ENGINE уже saga4 (`createProductLifecycleRuntime:174`),
но **infrastructure layer (persistence/host/admin/worker-adapter) = Saga2**.
~35% строк composition root — Saga2 wiring.

### 2. ✅ episode_workflows — operational authority (архитектор ПРАВ)

`episode_workflows.metadata` реально authority для control plane:

| поле | кто пишет | кто читает | влияет на решение? |
|---|---|---|---|
| `engine_running/pid/concurrency` | `LegacyEngineAdministration:110-139` | poll на каждом status | ✅ control plane |
| `active_model/provider/effort` | `POST /api/model/set` | `dispatcher.ts:515` в claim-транзакции | ✅ routing decision |
| `stage` | (legacy pump — удалён) | `saga3-discovery-engine.ts:501,510` | ✅ episode result |

**Уточнение:** `SqliteEpisodeRuntimeRepository` — 7 из 9 методов МЁРТВЫЕ (ensureWorkflow,
pause, needs-human, recovery metadata, patchMetadata — не вызываются в продакшене).
Живы только `currentStage` и `readWorkerModelRoute`.

### 3. ✅ CLI завёрнут в Saga2 shell (архитектор ПРАВ — но нейтральный порт)

- `orchestrate-cli.ts:180` → `createSaga2Application` → `application.runEpisode`
- `runEpisode` (`saga-application.ts:123-126`) — **нейтральный generic-порт** (чистая
  делегация в `OrchestrationEngine.run`), НЕ Saga2 semantics
- CLI зависит от Saga2 только через **имена символов**, не internals
- Переименование безопасно, механический refactor

### 4. ✅ Worker model routing — Saga2-зависимый (архитектор ПРАВ по сути)

- `active_model/provider/effort` живут только в `episode_workflows.metadata`
- 3 идентичных `json_extract` SQL в 3 файлах:
  - `sqlite-saga2-runtime-repositories.ts:127-131`
  - `legacy-claude-worker-executor-factory.ts:124-128`
  - `dispatcher.ts:215-219`
- **НО:** spawn hot-path уже нейтральный — `claude-runner.mjs:690` предпочитает
  frozen snapshot из `worker_executions.metadata`, re-read — только legacy fallback
- **НЕ operational blocker** — refactor candidate

### 5. ✅ saga3_* — durable kernel (архитектор ПРАВ)

- 41 таблица `saga3_*`, 850 обращений в src/
- `saga3_lifecycle_runs/process_runs/stage_runs` — **АКТИВНОЕ ЯДРО** saga4
- `schema.ts:960`: "saga4: saga3_lifecycle_runs is now read by production code"
- **Переименование — косметика, НЕ смешивать с cutover** (затронет 850 путей)
- `episode_workflows` — **saga2-era** таблица, подлежит отвязке

### 6. ✅ 8 cutover блоков — НО существует уже готовый план!

**Прорывная находка:** в `docs/design/saga4-cutover/` есть **11 файлов плана**
(FINAL-REPORT + CLEANUP-CHECKLIST + phase-1..9). Архитектор-критик частично
изобрёл термины вместо того чтобы сослаться на существующий план.

| # | блок архитектора | статус | в плане? | имя в плане |
|---|---|---|---|---|
| 1 | `LifecycleExecutionAdministration` | EXISTS (legacy name), rename deferred | ✅ phase-3 §7 | то же |
| 2 | `lifecycle_execution_controls` table | NOT-STARTED, PLANNED (exact name) | ✅ CLEANUP Step 1 | то же |
| 3 | `ModelRouteRepository` | NOT-STARTED, **расходится с планом** | ❌ | план: fold в control table |
| 4 | `WorkerExecutionHost` | EXISTS (legacy name), rename deferred | ✅ phase-1 | то же |
| 5 | Neutral ports | EXISTS (legacy name), rename deferred | ✅ phase-3 §3 | `RuntimePersistence` |
| 6 | `createProductFactoryApplication` | NOT-STARTED, **термин изобретён** | ❌ | план: `ProductLifecycle` |
| 7 | `runProductLifecycle` | NOT-STARTED, **термин изобретён** | ❌ | план: не требует rename |
| 8 | Remove `episode_workflows` | PARTIALLY DONE (pump gone), 8 writes remain | ✅ CLEANUP Steps 1-3 | то же |

**Счёт:** 4 начаты/частично готовы, 1 pure new work (запланирован), 3 расходятся с планом.

---

## Что осталось до полного cutover

### Блок A — Control-state table (КЛЮЧЕВОЙ, блокирует остальное)

Создать `lifecycle_execution_controls` table — описано в `CLEANUP-CHECKLIST.md` Step 1:
1. `src/schema.ts` — CREATE TABLE
2. `src/db.ts` — `migrateLifecycleExecutionControls` (миграция engine_* из episode_workflows)
3. Repoint reads в `legacy-engine-administration.ts` (engine_*)
4. Repoint reads в `dispatcher.ts:215` + `legacy-claude-worker-executor-factory.ts:124` (model route)
5. Repoint `sqlite-board-projection-reader.ts` (stage)

### Блок B — Удалить episode_workflows writers (gated на блоке A)

8 активных write-путей:
- `legacy-engine-administration.ts:249` (setMeta)
- `sqlite-saga2-runtime-repositories.ts:42,64,145` (stage mirror, pause, patchMetadata)
- `planner/fast-track.ts:206` (INSERT)
- `db.ts:808` (backfill)
- `export-import.ts:408,500` (export/import)

### Блок C — Cosmetic renames (отложены, низкий приоритет)

- `createSaga2Application` → `createProductLifecycleApplication`
- `runEpisode` → `runProductLifecycle` (high blast radius — каждый saga3 service + scenario adapter)
- `Saga2RuntimePersistence` → `RuntimePersistence` (high blast radius)
- `NodeSaga2HostRuntime` → `WorkerExecutionHost`
- `LegacyEngineAdministration` → `LifecycleExecutionAdministration`

### Блок D — Dead code cleanup

- `SqliteEpisodeRuntimeRepository` — 7 из 9 методов мёртвые
- `readTaskReviewFeedback` — 0 вызовов
- `agent-assistance-renderer.ts` (780 строк) — 0 импортеров

---

## Решения, которые нужно принять

1. **Блок 3 (model route)**: следовать плану (fold в `lifecycle_execution_controls`)
   или создать standalone `ModelRouteRepository`? План проще, standalone чище.

2. **Блоки 6-7 (terminology)**: "ProductFactory" (архитектор) vs "ProductLifecycle"
   (кодовая база + все plan docs). Рекомендация: следовать кодовой базе.

3. **Приоритет**: cutover (блок A+B) vs assistance hooks (P0)?
   Cutover — инфраструктурный долг, assistance — модели умирают без контекста.
   Оба важны, но assistance влияет на текущие прогоны.

---

## Ссылки (кликабельные)

### Существующий план cutover
- `docs/design/saga4-cutover/FINAL-REPORT.md`
- `docs/design/saga4-cutover/CLEANUP-CHECKLIST.md`
- `docs/design/saga4-cutover/phase-1-authority-map.md`
- `docs/design/saga4-cutover/phase-3-delete-legacy-engine.md`

### Saga2 infrastructure (active)
- `src/app/composition-root.ts:100-145` (createSaga2Application)
- `src/infrastructure/engine/legacy-engine-administration.ts` (engine control)
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` (episode repo)
- `src/infrastructure/runtime/node-saga2-host-runtime.ts` (host runtime)
- `src/application/ports/saga2-runtime-persistence.ts` (persistence port)
- `src/application/ports/saga2-host-runtime.ts` (host port)

### saga3 kernel (durable, НЕ трогать)
- `src/schema.ts:960-998` (lifecycle_runs DDL)
- `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`
- `src/process-modules/persistence/sqlite-process-run-repository.ts`

### episode_workflows writers (подлежат удалению)
- `src/infrastructure/engine/legacy-engine-administration.ts:249`
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:42,64,145`
- `src/planner/fast-track.ts:206`
- `src/tools/dispatcher.ts:215` (read в claim)
