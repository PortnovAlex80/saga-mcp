# Saga-mcp — Architecture Map

Эта схема отражает физическое расположение компонентов системы и связывает
каждый слой с **конвейерной ментальной моделью** Saga4. Используйте её для
быстрой ориентации в кодовой базе; формальный инвариант — `CGAD P18`
(`docs/architecture/cgad-v2-spec.md`), plain-language модель —
`docs/architecture/CONVEYOR-MENTAL-MODEL.md`.

## Конвейер в одном абзаце

Продукт движется через **стадии** (Discovery → Formalization → Development →
Delivery). Каждую стадию исполняет **модуль** — сменный плагин со своими
скиллами и специальностью. Внутри модуля работа течёт через **Flow** из
**узлов**. Узел в одном `ProcessRun` — это **workplace** (место): первичная
сущность, которой принадлежат карточка и стол. **Worker** (рабочий) —
одноразовый LM-execution, гость на месте: пришёл, сделал работу по карточке,
вызвал `worker_done`, ушёл. Worker **никогда не вызывает `worker_next`** —
инфраструктура назначает карточку до того, как рабочий приходит. Подробно:
`docs/architecture/CONVEYOR-MENTAL-MODEL.md`.

## Структура каталогов

```text
saga-mcp/
│
├── src/                              TypeScript-ядро
│   ├── index.ts                      Точка входа MCP-сервера
│   ├── db.ts                         SQLite: инициализация и миграции
│   ├── schema.ts                     Схема данных и определения сущностей
│   ├── types.ts                      Общие TypeScript-типы
│   ├── orchestrate-cli.ts            CLI-запуск оркестратора
│   ├── orchestrate-cli-scenario-adapter.ts  Сценарный адаптер CLI
│   ├── worker-executions.ts          Учёт запусков воркеров: lease,
│   │                                  heartbeat, progress, stuck-state,
│   │                                  fence-проверка, reaper
│   │
│   ├── app/                          Composition root + точка входа конвейера
│   │   ├── composition-root.ts         Единственное место wiring'а адаптеров
│   │   ├── dispatch-loop.ts            Диспетчер: нанимает воркеров, назначает
│   │   │                                карточки до старта worker (не worker
│   │   │                                сам их ищет)
│   │   ├── product-lifecycle-runtime.ts  Application-рантайм жизненного цикла
│   │   ├── product-lifecycle-run-starter.ts  Запуск LifecycleRun
│   │   ├── start-product-lifecycle-from-idea.ts  Bare idea → lifecycle input
│   │   └── product-lifecycle-repository-bindings.ts  Привязки репозиториев
│   │
│   ├── application/                  Use cases + порты (hexagonal)
│   │   ├── ports/                     Формальные outbound-контракты
│   │   │   ├── conveyor-ports.ts        ОДИН глобальный порт (IdGeneratorPort).
│   │   │   │                              Раньше здесь было 8 outbound-портов
│   │   │   │                              (в старых документах фигурировало
│   │   │   │                              «14 портов»), но ADR-022 вывел из
│   │   │   │                              употребления 7: их обязанности
│   │   │   │                              переехали в module-local SPI (Wave 7).
│   │   │   │                              См. docs/architecture/decisions/
│   │   │   │                              022-module-local-ports-over-global-catalog.md
│   │   │   ├── worker-executor.ts       WorkAssignmentPort + AssignedWork —
│   │   │   │                              единственный input запуска worker
│   │   │   ├── orchestration-engine.ts  Порт движка оркестрации
│   │   │   ├── board-projection.ts      Порт чтения канбан-проекции
│   │   │   ├── engine-administration.ts Порт администрирования движка
│   │   │   ├── saga2-host-runtime.ts    Порт host-runtime
│   │   │   └── saga2-runtime-persistence.ts  Порт persistence рантайма
│   │   ├── saga-application.ts        Корневой application-фасад
│   │   ├── module-conformance-runner.ts  Прогон модуля через контракт
│   │   ├── scenario-compiler.ts       Компиляция сценария вmanifest
│   │   └── package-describe.ts        Описание пакета модуля
│   │
│   ├── infrastructure/               Конкретные адаптеры (outboard)
│   │   ├── work/                      Диспетчеризация и надзор
│   │   │   ├── sqlite-work-assignment-adapter.ts  Реализация WorkAssignmentPort
│   │   │   │                                     (атомарный select-and-assign)
│   │   │   └── worker-supervision-service.ts      Foreman/watchman: lease,
│   │   │                                            heartbeat, reaper
│   │   ├── process-modules/           SQLite-адаптеры модулей (Wave 7 — модули
│   │   │                              больше не тащат SQLite напрямую)
│   │   │   ├── delivery/                delivery persistence + runtimes
│   │   │   ├── development/             development persistence + state
│   │   │   ├── formalization/           formalization kernel + persistence
│   │   │   ├── delivery-ports.ts        порты доставки
│   │   │   ├── git-machine-ports.ts     git-machine adapters
│   │   │   └── lifecycle-input-policy-validation.ts
│   │   ├── workers/                   Запуск claude-процессов
│   │   │   ├── claude-board-worker-executor.ts   WorkerExecutor (LM-раннер)
│   │   │   └── legacy-claude-worker-executor-factory.ts  WorkerExecutorFactory
│   │   ├── persistence/               SQLite-репозитории рантайма
│   │   ├── projections/               Чтение board-projection (канбан)
│   │   ├── runtime/                   NodeSaga2HostRuntime
│   │   ├── engine/                    LegacyEngineAdministration
│   │   ├── workspaces/                SqliteWorkspaceResolver
│   │   ├── conveyor/                  Конвейер-специфичные адаптеры
│   │   └── testing/                   Test warm-start helpers
│   │
│   ├── process-modules/              Универсальная композиция процессов Saga4
│   │   ├── domain/                    ЧИСТЫЙ домен: контракты, без адаптеров
│   │   │   ├── process-module.ts        Контракт модуля: Flow, узлы, профили
│   │   │   ├── lifecycle.ts             Stage Binding и Lifecycle contracts
│   │   │   ├── recovery.ts              RecoveryCase / RecoveryIssue контракты
│   │   │   └── spi/                     Service Provider Interfaces:
│   │   │                                  node-protocol, execution-envelope,
│   │   │                                  module-manifest, legacy-adapter,
│   │   │                                  resource-index, recovery-definitions
│   │   ├── application/               Application-слой рантайма модулей
│   │   │   ├── generic-flow-executor.ts Универсальный data-driven Flow-исполнитель
│   │   │   ├── scenario-runner.ts       Прогон сценарного манифеста
│   │   │   ├── process-module-registry.ts Версионированный registry модулей
│   │   │   ├── execution-profile-resolver.ts  Разрешение execution-профилей
│   │   │   ├── lifecycle-orchestrator.ts     Оркестрация lifecycle-run
│   │   │   ├── capability-packages.ts        Пакеты capabilities worker'ов
│   │   │   └── node-executors/              Исполнители узлов (lm-node и др.)
│   │   ├── installation/              Каталог и установка пакетов модулей
│   │   ├── composition/               Композиция stage bindings
│   │   ├── lifecycles/                Product-delivery lifecycle definition
│   │   │   ├── product-delivery-lifecycle.ts   LifecycleDefinition
│   │   │   └── product-delivery-module-contracts.ts  контракты модулей
│   │   ├── modules/                   Четыре цеха (workshop) — плагины:
│   │   │   ├── discovery/               product-discovery
│   │   │   ├── formalization/           solution-formalization
│   │   │   ├── development/             development
│   │   │   └── delivery/                product-delivery
│   │   │   Каждый содержит *-process-module.ts (контракт — остаётся здесь),
│   │   │   package/ (skills, templates, resources, schemas).
│   │   ├── persistence/               Рантайм-persistence (lifecycle-run,
│   │   │                              exact-candidate-acceptance и др.)
│   │   └── shared/                    managed-production (ledger contracts)
│   │
│   ├── modules/                      ⭐ Четыре цеха — module implementations
│   │   ├── discovery/                 domain/ + application/ + infrastructure/ + index.ts
│   │   ├── formalization/             domain/ + application/ + infrastructure/ + index.ts
│   │   ├── development/               domain/ + application/ + infrastructure/ + index.ts
│   │   ├── delivery/                  domain/ + application/ + infrastructure/ + index.ts
│   │   └── module-registration.ts     LEGO shared contract (ModuleSharedDeps, ModuleRegistries)
│   │       Каждый index.ts экспортирует register<Name>(registries, sharedDeps) —
│   │       composition root вызывает 4 функции. Добавление модуля = 1 register().
│   │
│   ├── shared/                       ⭐ Cross-cutting shared kernel
│   │   ├── canonical-json.ts         Deterministic JSON + SHA-256 (all modules)
│   │   ├── authority/                Execution-scoped MCP enforcement
│   │   ├── work-intent.ts            WorkIntent / ControlIntent types
│   │   └── conveyor/                 assign-one-card (cross-module conveyor physics)
│   │
│   ├── lifecycle/                    Машина состояний (legacy ядро)
│   │   ├── domain/                    ЧИСТЫЙ домен: commands, events, state,
│   │   │                              evolve, invariants, decode, ids, effects
│   │   ├── work-assignment-core.ts    Атомарное назначение карточек
│   │   ├── invariant-scanner.ts       Инварианты жизненного цикла
│   │   ├── atomic-release.ts          Fenced release (compare-and-set)
│   │   ├── compatibility-projector.ts Проецирование legacy→новое состояние
│   │   └── idempotency.ts             command_receipts (ExecutionJournalPort)
│   │
│   ├── engines/                      (удалено в saga4 cutover — был discovery/formalization engine)
│   │
│   ├── tools/                        MCP API surface (28+ файлов)
│   │   ├── dispatcher.ts              worker_next/worker_done, merge-lock,
│   │   │                                findNextClaimable (review-first)
│   │   ├── tasks.ts, epics.ts, projects.ts  CRUD сущностей
│   │   ├── artifacts.ts               PRD/SRS/AC и traceability
│   │   ├── conflicts.ts               Семантические конфликты
│   │   ├── process-modules.ts         Read-only каталог модулей/lifecycle
│   │   ├── discovery-*-tools.ts       Discovery MCP: proposals/readiness/normalization
│   │   ├── observations.ts            Продуктовые наблюдения и метрики
│   │   ├── providers.ts               Реестр Trusted Providers
│   │   └── repositories.ts            Подключённые Git-репозитории
│   │
│   ├── planner/                      Декомпозиция и планирование
│   │   ├── topology.ts                Зависимости и топология задач
│   │   ├── cascade.ts                 Каскадирование требований
│   │   └── fast-track.ts              Упрощённый маршрут задач
│   │
│   ├── worker/                       Анализ влияния работы воркера
│   ├── helpers/                      Git, metadata, completeness, SQL
│   ├── validators/                   Валидация входных артефактов (brief и др.)
│   └── runtime/                      saga-runtime-config (загрузка конфига)
│
├── tracker-view/                     Локальный веб-интерфейс + LM-раннер
│   ├── tracker-view.mjs              Канбан/API-сервер, порт 4321
│   ├── claude-runner.mjs             Запуск Claude-процессов (WorkerLauncher):
│   │                                  принимает AssignedWork, materializes desk,
│   │                                  child close → fenced release
│   ├── loop-detector.mjs             Детектор циклов
│   ├── product-delivery-composition.mjs  Delivery composition (fail-closed)
│   ├── artifact-presentation.mjs     Презентация артефактов
│   ├── git-bootstrap.mjs             Git-подготовка рабочих пространств
│   ├── structured-context-hook.mjs   Контекстный хук
│   └── docs-graph/                   Граф артефактов и Markdown
│       ├── server.mjs                Сервер, порт 4322
│       └── public/                   Клиентский HTML/CSS/JS
│
├── skills/                           Глобальные скиллы ролей агентов
│   ├── saga-orchestrator/            Оркестрация полного потока Saga
│   ├── saga-dispatch/                Dispatch-loop оркестратор
│   ├── saga-worker/                  (... также в development package)
│   ├── saga-verifier/                Независимый верификатор (CGAD §9)
│   ├── saga-patrol/                  Read-only обход инстанса
│   ├── saga-release/                 Release-чеклист
│   ├── saga-start/, saga-tracker/    Bootstrap + dispatcher contract
│   ├── saga-kickstart/               Discovery: idea → brief → decision
│   ├── autonomous-recovery/          Автономное восстановление
│   ├── senior-analyst/               Методология requirements engineering
│   ├── saga-process-module-designer/      Проектирование нового модуля
│   ├── saga-process-module-worker-protocol/  Универсальная физика LM execution
│   └── (диагностические: saga-diagnostician, saga-code-reviewer, ...)
│      Module-specific skills (saga-product, saga-analyst, saga-architect,
│      saga-planner, saga-discovery-*) живут ВНУТРИ соответствующих package/
│      каждого модуля — см. src/process-modules/modules/*/package/resources/skills/
│
├── tool-templates/                   Шаблоны tracker/MCP-вызовов для ролей
│   ├── discovery/                    Tracker, MCP calls, checklists Discovery
│   ├── formalization/                Tracker, artifact/trace/done calls
│   └── process-modules/              Generic manifest и tracker templates
│
├── agents/                           Краткие определения ролей агентов
│
├── modules-ext/                      Внешние модули (например, external-seo)
├── scenarios-ext/                    Внешние сценарии
│
├── tests/                            Node test suite
│   ├── architecture/                 ⭐ Архитектурные ratchet-тесты:
│   │   ├── dependency-direction.test.mjs     6 правил зависимости (храповик)
│   │   ├── cutover-architecture-checks.test.mjs  Cutover Seam-инварианты
│   │   ├── conveyor-ports.test.mjs           14 outbound-портов существуют
│   │   ├── saga2-boundaries.test.mjs         Границы saga2-runtime
│   │   └── w13-a4-retired-fallbacks.test.mjs  Запрещённые символы
│   ├── execution/                    definition-of-done §18 — финальный gate
│   ├── process-modules/              Контракты, routing, boundaries, MCP
│   ├── discovery/                    Discovery D1-D5 runtime/invariant тесты
│   ├── lifecycle/                    Машина состояний и инварианты
│   ├── dispatcher-race/              Гонки, claim, worktree isolation
│   ├── spi/, installation/, scenario/  SPI, установка, сценарии
│   └── ...                           completeness, migrations, e2e-pipeline
│
├── tools/                            CLI-инструменты
│   ├── cgad-spec-lint.mjs            Линтер CGAD-контрактов (18 правил)
│   └── dep-graph-scanner.mjs         Сканер графа зависимостей
│
├── docs/
│   ├── architecture/                 ⭐ Архитектурная документация
│   │   ├── CONVEYOR-MENTAL-MODEL.md    Plain-language конвейерная модель
│   │   ├── cgad-v2-spec.md             Формальный инвариант CGAD P18
│   │   ├── SAGA-3-CLEAN-ARCHITECTURE.md  Чистая архитектура Saga3
│   │   ├── passive-worker-kernel-blueprint.md  Blueprint пассивного worker
│   │   ├── WORK-ASSIGNMENT-REFACTOR-SPEC.md    Спека рефакторинга назначения
│   │   ├── LIFECYCLE-ORCHESTRATOR.md   Оркестратор lifecycle
│   │   ├── lifecycle-command-event-vocabulary.md  Словарь команд/событий
│   │   ├── COMPATIBILITY-INVENTORY.md  Inventory для Wave 13 removal
│   │   ├── decisions/                  ADR (Architecture Decision Records)
│   │   └── conveyor-wave-review/       Ремарки по волнам 1-7
│   ├── plans/                        Планы веток и этапов
│   ├── requirements/                 Шаблоны PRD/SRS/инвариантов
│   └── research/                     Исследования и аудиты
│
├── dist/                             Скомпилированный JavaScript
├── package.json                      Команды и зависимости
├── manifest.json                     Метаданные интеграции
├── GUARDRAILS.md                     Системные ограничения
├── README.md / README.ru.md          Документация
└── tsconfig.json                     strict TypeScript
```

## Слои и зависимость (hexagonal)

Зависимость всегда направлена **внутрь**. Это enforce'ится
`tests/architecture/dependency-direction.test.mjs` — храповиком, который
пропускает только зарегистрированные нарушения и падает при появлении новых.

```text
MCP / CLI / scheduler / tests                 inbound adapters
                 │
                 v
  app/ + application/ + use cases             application layer
  (composition-root, dispatch-loop, saga-application,
   module-conformance-runner, scenario-runner)
                 │
                 v
  domain/ (process-modules, saga3, lifecycle) domain model + pure policies
                 │   чистый: НИКАКИХ импортов из infrastructure/persistence/
                 │           sqlite/db.ts/schema.ts/tools — 0 нарушений
                 ^
                 │
  ports/ (conveyor-ports, worker-executor)    outbound ports (interfaces)
                 ^
                 │
  infrastructure/                              outbound adapters
  (work/, workers/, persistence/, process-modules/,
   runtime/, projections/)
```

Доменные слои (`modules/*/domain/`, `process-modules/domain/`,
`lifecycle/domain/`) — **полностью чистые**: они не импортируют SQLite, MCP,
файловую систему, `db.ts` или `schema.ts`. Это проверяется grep'ом и
архитектурными тестами.

## Главная граница Saga4 (конвейер)

```text
Process Module   → содержание работы (Flow, узлы, профили, контракты)
Runtime          → физика исполнения (data-driven generic-flow-executor)
Lifecycle        → композиция модулей и маршрутизация outcomes (stage bindings)
Stage Binding    → адаптация модуля к месту в конкретном Lifecycle
```

### Три сущности конвейера (кто чем владеет)

| Сущность | Код | Владелец | Жизненный цикл |
|---|---|---|---|
| **Workplace** (место) | узел в `ProcessRun` | `ProcessRun` | durable — первичная сущность |
| **Worker** (рабочий) | LM-execution (task + fence) | infrastructure | one-shot — гость |
| **Card** (карточка) | projected task row | Work Dispatch context | durable — принадлежит workplace |
| **Desk** (стол) | workspace directory | workplace | durable — переживает worker |

**Жёсткая граница:** worker знает ТОЛЬКО свою специальность (скилл). Он не
нанимает воркеров, не выбирает задачи, не решает, сколько воркеров running.
Инфраструктура нанимает, выбирает из очереди (review-first), кладёт точную
карточку на стол ДО прихода worker'а, предоставляет стол, управляет
fencing/heartbeat/persistence.

**Один контракт запуска:** `AssignedWork` — единственный input запуска worker.
`claimScope` (legacy) удалён. Worker **никогда не вызывает `worker_next`** —
это работа инфраструктуры (`dispatch-loop.ts` + `WorkAssignmentPort`).

### Шесть bounded contexts (DDD)

Документ `CONVEYOR-MENTAL-MODEL.md` выделяет 6 контекстов. Их физическое
размещение:

1. **Conveyor Runtime** (`ProcessRun`, workplace, Flow transitions) —
   `process-modules/application/` + `lifecycle/`
2. **Work Dispatch** (Card, Assignment, Lease, Fence, `AssignedWork`) —
   `application/ports/worker-executor.ts` + `infrastructure/work/` +
   `lifecycle/work-assignment-core.ts`
3. **Module Contracts** (Flow/node/profiles/contracts) —
   `process-modules/domain/` + `process-modules/modules/*/`
4. **Production & Evidence** (products, artifacts, traces, receipts) —
   `modules/*/domain/` + `process-modules/persistence/`
5. **Module Catalog & Installation** (manifests, digests, install) —
   `process-modules/installation/`
6. **Lifecycle Composition** (stage bindings, outcome routing) —
   `process-modules/lifecycles/` + `process-modules/composition/`

Подробно об агрегатах, инвариантах и границах транзакций — раздел «DDD
interpretation» в `CONVEYOR-MENTAL-MODEL.md`.

## Тестирование архитектуры

`npm run test:architecture` прогоняет:

- `tests/architecture/*.test.mjs` — ratchet'ы зависимостей, границ и портов
- `tests/dispatcher-race/*` — гонки назначения, изоляция worktree, review-loop
- `tests/process-modules/node-durable-identity.test.mjs` — P18: workplace
  identity стабильна across recovery attempts (card reuse)

`tests/execution/definition-of-done.test.mjs` — финальный gate §18: изоляция
модулей, immutable output envelopes, durable receipts, pinned package bytes.

## Куда смотреть дальше

- **Конвейерная модель (plain language):** `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
- **Формальный инвариант:** `docs/architecture/cgad-v2-spec.md` (CGAD P18)
- **Решения (ADR):** `docs/architecture/decisions/`
- **Обзор потока:** `docs/saga-flow-overview.md` (если есть)
