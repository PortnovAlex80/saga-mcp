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
│   ├── tools/                   MCP API приложения
│   │   ├── projects.ts          Проекты
│   │   ├── epics.ts             Эпики
│   │   ├── tasks.ts             Задачи
│   │   ├── subtasks.ts          Подзадачи
│   │   ├── dispatcher.ts        Выдача работ агентам, merge-lock
│   │   ├── lifecycle.ts         Lifecycle-команды и переходы
│   │   ├── workflow.ts          Высокоуровневый workflow
│   │   ├── artifacts.ts         PRD/SRS/AC и другие артефакты
│   │   ├── conflicts.ts         Семантические конфликты
│   │   ├── repositories.ts      Подключённые Git-репозитории
│   │   ├── providers.ts         Реестр LLM-провайдеров
│   │   ├── observations.ts      Продуктовые наблюдения и метрики
│   │   └── ...                  Поиск, dashboard, notes, activity
│   │
│   ├── lifecycle/               Ядро машины состояний
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
│   ├── loop-detector.mjs        Детектор циклов, новый файл
│   └── docs-graph/              Граф артефактов и Markdown
│       ├── server.mjs           Сервер, порт 4322
│       ├── lib/                 Сканирование и построение графа
│       └── public/              Клиентский HTML/CSS/JS
│
├── skills/                      Инструкции для ролей агентов
│   ├── saga-orchestrator/
│   ├── saga-worker/
│   ├── saga-verifier/
│   ├── saga-planner/
│   ├── saga-architect/
│   ├── saga-product/
│   ├── saga-analyst/
│   ├── saga-dispatch/
│   └── ...
│
├── agents/                      Краткие определения ролей агентов
│
├── tests/                       Node test suite
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
