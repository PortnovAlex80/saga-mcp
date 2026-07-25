# Saga-mcp — Architecture Map

Эта схема отражает физическое расположение компонентов системы.
Используйте её для быстрой ориентации в кодовой базе.

```text
saga-mcp/
│
├── src/                         Основной TypeScript-код
│   ├── index.ts                 Точка входа MCP-сервера
│   ├── db.ts                    SQLite, инициализация и миграции
│   ├── schema.ts                Схема данных и определения сущностей
│   ├── types.ts                 Общие TypeScript-типы
│   │
│   ├── orchestrate.ts           Автономный orchestration/pump loop
│   ├── orchestrate-cli.ts       CLI-запуск оркестратора
│   ├── worker-executions.ts     Учёт запусков воркеров
│   │
│   ├── process-modules/         Универсальная композиция процессов Saga 3
│   │   ├── domain/
│   │   │   ├── process-module.ts  Контракт Process Module, Flow, профили LM-узлов
│   │   │   └── lifecycle.ts       Stage Binding и Lifecycle contracts
│   │   ├── application/
│   │   │   ├── validate-process-module.ts   Детерминированная проверка модуля
│   │   │   ├── process-module-registry.ts   Версионированный registry
│   │   │   ├── process-module-runtime-engine.ts Runtime/adapter boundary
│   │   │   └── lifecycle-router.ts          Проверка и маршрутизация outcomes
│   │   ├── modules/
│   │   │   ├── discovery/        product-discovery@3.0.0
│   │   │   └── formalization/    solution-formalization@1.0.0
│   │   └── lifecycles/            Discovery → Formalization Stage Bindings
│   │
│   ├── tools/                   MCP API приложения
│   │   ├── projects.ts          Проекты
│   │   ├── epics.ts             Эпики
│   │   ├── tasks.ts             Задачи
│   │   ├── subtasks.ts          Подзадачи
│   │   ├── dispatcher.ts        Выдача работ агентам, merge-lock
│   │   ├── lifecycle.ts         Legacy lifecycle-команды и переходы
│   │   ├── process-modules.ts   Read-only module/lifecycle catalog и validation
│   │   ├── workflow.ts          Высокоуровневый workflow
│   │   ├── artifacts.ts         PRD/SRS/AC и другие артефакты
│   │   ├── conflicts.ts         Семантические конфликты
│   │   ├── repositories.ts      Подключённые Git-репозитории
│   │   ├── providers.ts         Реестр LLM-провайдеров
│   │   ├── observations.ts      Продуктовые наблюдения и метрики
│   │   └── ...                  Поиск, dashboard, notes, activity
│   │
│   ├── saga3/                   Реализованные Saga 3 domain/application/adapters
│   │   ├── domain/              Discovery contracts, WorkIntent, certificates
│   │   ├── application/         Normalization/readiness/settlement/diagnosis
│   │   ├── authority/           Execution-scoped MCP enforcement
│   │   └── persistence/         Durable Discovery runtime
│   │
│   ├── lifecycle/               Legacy ядро машины состояний
│   │   ├── domain/
│   │   │   ├── commands.ts      Команды
│   │   │   ├── events.ts        Доменные события
│   │   │   ├── state.ts         Состояние агрегата
│   │   │   ├── evolve.ts        Применение событий к состоянию
│   │   │   └── invariants.ts    Инварианты жизненного цикла
│   │   ├── integration-executor.ts
│   │   ├── invariant-scanner.ts
│   │   ├── atomic-release.ts
│   │   ├── docs-worktree.ts
│   │   └── work-item-repository.ts
│   │
│   ├── planner/                 Декомпозиция и планирование
│   │   ├── topology.ts          Зависимости и топология задач
│   │   ├── cascade.ts           Каскадирование требований
│   │   └── fast-track.ts        Упрощённый маршрут задач
│   │
│   ├── helpers/                 Git, metadata, completeness, SQL
│   ├── validators/              Валидация входных артефактов
│   └── worker/                  Анализ влияния работы воркера
│
├── tracker-view/                Локальный веб-интерфейс
│   ├── tracker-view.mjs         Канбан/API-сервер, порт 4321
│   ├── claude-runner.mjs        Запуск Claude-процессов
│   ├── loop-detector.mjs        Детектор циклов
│   └── docs-graph/              Граф артефактов и Markdown
│       ├── server.mjs           Сервер, порт 4322
│       ├── lib/                 Сканирование и построение графа
│       └── public/              Клиентский HTML/CSS/JS
│
├── skills/                      Инструкции для ролей агентов
│   ├── saga-process-module-designer/         Проектирование нового модуля
│   ├── saga-process-module-worker-protocol/ Универсальная физика LM execution
│   ├── saga-discovery-worker/
│   ├── saga-discovery-normalizer/
│   ├── saga-discovery-readiness-advisor/
│   ├── saga-discovery-diagnosis-advisor/
│   ├── saga-product/
│   ├── saga-analyst/
│   ├── saga-reconciler/
│   ├── saga-architect/
│   └── ...
│
├── tool-templates/
│   ├── discovery/               Tracker, MCP calls, checklists Discovery
│   ├── formalization/           Tracker, artifact/trace/done calls, checklist
│   └── process-modules/         Generic manifest и tracker templates
│
├── agents/                      Краткие определения ролей агентов
│
├── tests/                       Node test suite
│   ├── process-modules/         Contracts, routing, boundaries, MCP, runtime
│   ├── saga3/                   Discovery D1-D5 runtime/invariant tests
│   ├── lifecycle/               Машина состояний и инварианты
│   ├── dispatcher-race/         Гонки, claim и worktree isolation
│   ├── planner-ac9/             Планирование и каскадирование
│   ├── completeness/            Проверки полноты
│   ├── migrations/              Миграции БД
│   └── e2e-pipeline.test.mjs    Полный pipeline
│
├── tools/
│   └── cgad-spec-lint.mjs       Линтер CGAD-контрактов
│
├── docs/
│   ├── saga3/process-modules/   Архитектура, checklist, Formalization design
│   ├── architecture/            Архитектура и ADR
│   ├── plans/                   Планы веток и этапов
│   ├── requirements/            Шаблоны PRD/SRS/инвариантов
│   ├── research/                Исследования и аудиты
│   └── saga-flow-overview.md    Обзор основного потока
│
├── dist/                        Скомпилированный JavaScript
├── package.json                 Команды и зависимости
├── manifest.json                Метаданные интеграции
├── GUARDRAILS.md                Системные ограничения
├── README.md                    Основная документация
└── README.ru.md                 Русская документация
```

## Главная граница Saga 3

```text
Process Module  → содержание работы
Runtime         → физика исполнения
Lifecycle       → композиция модулей и маршрутизация outcomes
Stage Binding   → адаптация модуля к месту в конкретном Lifecycle
```

Подробно: `docs/saga3/process-modules/ARCHITECTURE.md`.
