# saga-mcp — Обзор с высоты птичьего полета

> Архитектурный анализ кодовой базы ветки saga4, проведённый с полной
> загрузкой исходников в контекст (≈890k токенов, все ключевые файлы
> от `src/index.ts` до `tools/cgad-spec-lint.mjs`, от domain SPI до
> SQLite-адаптеров, от ADR до skills). Документ фиксирует архитектурную
> модель системы «как она есть», не как задумывалась — отмечает
> правильные подходы и структурные риски.

## Что это на самом деле

saga-mcp — не таск-трекер и не CI/CD. Это **детерминированный
governance-конвейер для параллельных LLM-агентов**, где каждый переход
состояния проходит через формальные ворота. Фундаментальная идея:
**недопустимое действие невозможно провести как валидный переход.** Всё
остальное — механика вокруг этой идеи.

## Семь логических слоёв

```
┌─────────────────────────────────────────────────────────┐
│ 1. MCP API Surface (src/tools/, 28 файлов)              │  ← агенты видят только это
│    authority gateway перехватывает каждый вызов         │
├─────────────────────────────────────────────────────────┤
│ 2. Skills (13+ ролей)                                   │  ← промпты-инструкции для LM
│    saga-worker, saga-planner, saga-verifier, ...        │
├─────────────────────────────────────────────────────────┤
│ 3. Conveyor Application (src/app/, src/application/)    │  ← оркестрация
│    dispatch-loop, lifecycle-orchestrator, composition   │
├─────────────────────────────────────────────────────────┤
│ 4. Process Modules (4 цеха, data-driven)                │  ← предметное содержание
│    discovery / formalization / development / delivery   │
│    GenericFlowExecutor ходит по Flow, не зная модулей   │
├─────────────────────────────────────────────────────────┤
│ 5. Work Dispatch & Lifecycle (src/lifecycle/)           │  ← атомарное назначение
│    findNextClaimable, atomic-release, stuck-policy      │
│    single-writer invariant для tasks.{status,...}       │
├─────────────────────────────────────────────────────────┤
│ 6. Saga3 Bounded Context (src/saga3/)                   │  ← Discovery kernel
│    settlement-policy (pure), certificate, authority     │
├─────────────────────────────────────────────────────────┤
│ 7. Persistence (src/infrastructure/, SQLite)            │  ← concrete adapters
│    worker_executions, process_runs, node_runs, ledger   │
└─────────────────────────────────────────────────────────┘
```

Зависимость направлена **строго внутрь**. Слои 4–6 чистые (0 импортов
из infra/db). Это enforce'ится ratchet-тестом с `KNOWN_VIOLATIONS = 0`.

## Главное архитектурное решение: конвейер (CGAD P18)

Три сущности, и кто чем владеет:

| Сущность | Владелец | Жизненный цикл | Аналогия |
|---|---|---|---|
| **Workplace** (узел ProcessRun) | ProcessRun | durable — первичная | рабочее место на заводе |
| **Worker** (LM execution) | infrastructure | one-shot — гость | рабочий за смену |
| **Card + Desk** (task + workspace) | workplace | durable — переживает worker | наряд на работу + верстак |

Это решает **главную проблему** agent-оркестрации: recovery. Когда worker
умирает, новый приходит на **то же место**, видит **ту же карточку** (с
предыдущей работой) и **тот же стол** (с черновиками). Не «новый воркер →
новая задача → чистый лист» (бесконечный цикл), а «новый воркер → та же
работа → продолжение».

## Протекание логики (один полный цикл)

```
пользователь: «идея одной фразой»
  │
  ▼ startProductLifecycleFromIdea
  │ → resolveActiveRepositoryWithHead (git rev-parse HEAD)
  │ → assembleProductLifecycleInput (deferred delivery profile)
  │ → assertProductDeliveryLifecycleInput (fail-closed валидация)
  │
  ▼ createSpawnCliLifecycleRunStarter → spawn orchestrate-cli (detached)
  │
  ▼ orchestrate-cli main loop:
  │   while (true):
  │     application.runEpisode({projectId, epicId, lifecycleInput})
  │       │
  │       ▼ LifecycleOrchestrator.run
  │       │   for each stage in productDeliveryLifecycle:
  │       │     mapLifecycleValues(stage.inputMapping, durableFrame)
  │       │     processRunRepo.start({moduleRef, input, installationId})
  │       │     installation.executor.execute(module, context)
  │       │       │
  │       │       ▼ GenericFlowExecutor.walk
  │       │       │   for each node in flow:
  │       │       │     nodeExecutors.get(node.kind).execute(ctx)
  │       │       │       │
  │       │       │       │ [lm] LmNodeExecutor:
  │       │       │       │   ensureExecutionPlan (WorkIntent + projected task)
  │       │       │       │   workAssignment.assignTask (BEGIN IMMEDIATE: claim+fence)
  │       │       │       │   workerExecutor.start({assignment}) → spawn claude -p
  │       │       │       │   poll loop (status/timeout)
  │       │       │       │   return receipt (NOT domain production)
  │       │       │       │
  │       │       │       │ [kernel] KernelNodeExecutor:
  │       │       │       │   handler = registry.get(node.handler)
  │       │       │       │   result = handler(ctx) ← MODULE CONTENT
  │       │       │       │   exactCandidateAcceptance.accept(command) ← KERNEL GATE
  │       │       │       │   return NodeProduction + ModuleCompletion
  │       │       │       │
  │       │       │     transition = nextNode(flow, node, event)
  │       │       │     if terminal: settle → certificate → ProcessRun completed
  │       │       │
  │       │     route = routeProcessOutcome(stage, outcome)
  │       │     completeStage (handoff frame → next stage input)
  │       │
  │       if result.reason === 'paused':  ← development ждёт пока воркеры доделают
  │         distributeQueuedTasks:
  │           workAssignment.assignTask → ClaudeBoardRunner.start
  │             → spawn claude -p с pinned skills + frozen authority
  │             → poll → close → markExecutionExited
  │         if dispatched === 0: break (stuck)
  │       else: break (terminal)
```

## Архитектурные паттерны

### 1. Data-driven execution

GenericFlowExecutor — один на все модули. Ни одной строки со словом
"discovery". Модуль = данные (Flow, узлы, профили, handler ids). Это
паттерн **interpreter + plugin registry**.

### 2. Pure policy / mechanism split

`decideStuckAction` — чистая функция, zero I/O. Механизм
(`reconcileWorkerExecutions`) делает I/O и диспатчит на Action. Тесты
политики детерминированы, без mock'ов. Это Uncle Bob Clean Architecture в
чистом виде.

### 3. Content-addressed everything

`ProductRef = (schemaId, ref, digest)`. Хеш от canonical JSON.
Неизменяемые сертификаты. Replay работает по конструкции.

### 4. Ratchet enforcement

Архитектурные тесты только туже. `KNOWN_VIOLATIONS` может только
уменьшаться. Новое нарушение → тест падает. Удалённое нарушение без
удаления entry → тест падает (stale detection). Это паттерн
**progressive tightening**.

### 5. Wave-based migration

13+ волн рефакторинга. Каждая волна: dual-write (новый путь + старый) →
characterization tests (не сломать) → cutover (удалить старый) →
forbidden-fallback ratchet (запретить возврат). Это паттерн
**expand-contract refactoring**.

### 6. Deny-by-default

4-valued verdict (passed/failed/unknown/error). Unknown ≠ pass. Evidence
без provider → reject. Это correct security discipline.

### 7. Single-writer invariant

`tasks.{status, assigned_to, current_execution_id}` пишут ровно 3
модуля + 1 documented exception. Lint-тест на уровне исходников
(`tasks-writer-invariant.test.mjs`). Это предотвращает distributed-write
races.

## Правильные подходы

- **Exact-lineage reads.** Kernel handler'ы никогда не читают "latest by
  epic". Только по exact id + hash из NodeProduction chain или
  managed-production ledger. Снимает целый класс race conditions.
- **Authority gateway на каждом MCP-вызове.** `authorizeSagaToolCall`
  проверяет frozen execution_context. Worker не может расширить свои
  полномочия после claim.
- **Crash-resume через durable NodeRun.** GenericFlowExecutor
  восстанавливается с последнего завершённого узла. `completion` column
  (Wave 4) переживает crash.
- **Worktree isolation.** Каждый worker в `.worktrees/task-<id>`. Merge
  gated behind review. Single-file monolith conflict prevention через
  conflict_keys.
- **Production package pinning.** ProcessRun pinned to immutable
  packageDigest. Skill drift → digest change → visible.

## Структурные риски

### 1. Type cycle workaround

`ModuleCompletion ↔ ProcessModuleOutputEnvelope` — цикл типов, разрешённый
через `import type`. При сериализации `completion: null as unknown as
ModuleCompletion`. Code smell: типы борются с моделью сериализации.

### 2. Дублирование interface'ов

`ManagedProductionLedger` объявлен в development-kernel-ports.ts И в
formalization-kernel-ports.ts — структурно идентичны, но два независимых
источника. Дрейф одного пройдёт молча.

### 3. Dynamic import для обхода ratchet

`createLegacySettlementBridge` — dynamic import чтобы scanner не видел
static edge. Рантайм-зависимость реальна, но статический граф чист.
Подрывает доверие к ratchet: если один dynamic import легален, почему не
десять?

### 4. `as any` в composition root

`installationRegistry.register(inst as any)` в
product-lifecycle-runtime.ts. Type safety обойдена в единственном месте,
но всё же.

### 5. tracker-view.mjs — 5605 строк в одном файле

UI, HTTP-server, markdown renderer, kanban dispatch, artifact resolver,
heartbeat, recovery — всё в одном .mjs. Нарушает SRP, который сама saga
пропагандирует.

## Архитектурные риски

### 6. Wave debt

Комментарии "Wave 11 will...", "Slice 1.C", "FU-D will consolidate" —
повсюду. Это незавершённый рефакторинг. Каждая "волна" добавляет слой
абстракции, но не все слои доходят до завершения. Риск: абстракции
накапливаются быстрее, чем удаляются старые пути.

### 7. Comment-to-code ratio

В некоторых файлах комментарии длиннее кода в 2–3 раза. Это документирует
Wave-историю, но затрудняет чтение. `generic-flow-executor.ts` — ~1500
строк, половина — комментарии про Wave 3/4/5/6. Нужен architecture
decision log отдельно от кода.

### 8. SQLite BEGIN IMMEDIATE как единый serialization point

`findNextClaimable` берёт IMMEDIATE lock на всю БД. Для single-machine
saga это ОК. Но это архитектурный потолок — multi-host оркестрация
потребует другого concurrency model (advisory locks на scope, не на всю
БД).

### 9. Reserved-but-not-running gap

Reserved execution (fence создан, PID ещё нет) имеет 60-секундный boot
timeout. Между reserve и spawn есть окно где карточка занята, но процесса
нет. CONVEYOR Wave 5 закрыл это lease'ами, но не полностью.

## Логические / domain риски

### 10. Formalization как bottleneck

Formalization module — самый тяжёлый: 7 kernel handlers,
exact-candidate-acceptance для каждого, baseline freezer, traceability
graph checks. Если formalization застревает (loop recovery), весь
pipeline стоит.

### 11. Delivery fail-closed по конструкции

`product-delivery-composition.mjs` — local-dry-run profile. Publication
throws, observation возвращает `{observed: false}`. Правильно для
fail-closed, но без реального deployment provider delivery всегда
заканчивается `blocked`.

### 12. Власть settlement kernel

Settlement kernel в каждом модуле issue'ит собственный сертификат (Wave
4). Ошибка в settlement policy = невосстановимый сертификат. Изменение
правил = новая policy version = новый idempotency target — старые
сертификаты остаются, новые перевычисляются. Правильно, но хрупко: одна
ошибка в manifest hash → все сертификаты невалидны.

## Куда можно копнуть (следующие шаги анализа)

- **A. Cross-cutting consistency audit** — найти расхождения между
  заявленной архитектурой и кодом (dynamic imports, `as any`, ratchet
  blind spots).
- **B. Failure mode analysis** — карта race conditions и recovery holes.
- **C. Domain model coherence** — где конвейерная метафора течёт.
- **D. Complexity heatmap** — essential vs accidental complexity по
  файлам.
- **E. Evolution retrospective** — траектория от fork до saga4.
- **F. Practical recommendations** — по конкретному вопросу
  (масштабирование, новый модуль, устранение Wave debt).
