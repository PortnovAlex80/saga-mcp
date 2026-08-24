> **Port note (2026-08-25):** ported from the archived `wip/documentation-workshop`
> branch (tag `archive/wip/documentation-workshop`, commit a05bc223) as the unique
> 16-touchpoint wiring checklist. Two supersessions apply: (1) the target
> layout is now the co-located `src/modules/<workshop>/` structure of
> ADR-085 — new workshops follow
> `docs/architecture/NEW-WORKSHOP-DESIGN-AUTHORING-GUIDE.md` §16 first ("do
> not add another global hand-list" — its step 13 advice on the global
> manifest list + WORKSHOP_EPOCH bump is deprecated); (2) admission is
> closed before C12: a new built-in requires the workshop-inventory
> baseline, conformance scenarios and WORKSHOP.md per the authoring guide.

# Как собрать цех завода saga4 — инструкция для агента (и человека)

> Написана 2026-08-19 по следам РЕАЛЬНОЙ сборки цеха `documentation-release`
> (четвёртый цех, PDF-документация). Всё, что здесь перечислено, — проверенные
> шаги и настоящие грабли, на которые наступили при сборке.
>
> Эта инструкция ЗАМЕНЯЕТ собой поиск рецепта по DRAGON-MAP/skills: рецепт там
> есть, но он короче реальности. Здесь — полная карта.

## 0. Что такое цех (30 секунд)

**Цех = Process Module package.** Цех НЕ имеет своего движка, очереди,
стейт-машины или хранилища. Он декларирует:

- узлы потока (kernel / human / production-cell);
- контракты продуктов (схемы + payload-контракты с дайджестами);
- чек-планы гейтов (провайдеры с дайджестами);
- профили исполнителей (скиллы, инструменты);
- recovery-политику.

Всё «КАК» (диспетчер, воркплейсы, CandidateSet, гейты, replay, transitions)
принадлежит заводскому рантайму. Запрещено: ветвления рантайма по имени цеха,
приватный submit-store, второй диспетчер, флаги mock-режима (§27
CONVEYOR-MENTAL-MODEL). Читать перед началом: `CONVEYOR-MENTAL-MODEL.md`
(целиком) и `DRAGON-MAP.md` этап 5.

## 1. Четыре слоя цеха

| Слой | Каталог | Что там |
|---|---|---|
| Lifecycle-топология | `src/process-modules/lifecycles/` | стадии, inputMapping, outcomeRoutes; контракты модулей (`product-delivery-module-contracts.ts`) |
| Декларация цеха | `src/process-modules/modules/<цех>/` | `<цех>-process-module.ts` + `package/manifest.ts` + `package/resources/` (скиллы, чеклисты, шаблоны) |
| Семантика цеха | `src/modules/<цех>/` | `domain/` (схемы, порты), `application/` (kernel-хендлеры, чек-провайдеры), `infrastructure/` (SQLite/git), `index.ts` (register) |
| Сборка завода | `src/app/product-lifecycle-runtime.ts`, `src/orchestrate-cli.ts`, `workshop-capability-manifest.ts` | регистрация, установка пакета, capability-рейчет |

## 2. Пошаговый чек-лист сборки (ПОЛНЫЙ — 16 шагов)

Эталоны для копирования: `delivery` (простой, kernel-heavy) → `formalization`
(LM-авторство + review) → `development` (fan-out ячеек, самое сложное).
Минимальный внешний пакет: `modules-ext/external-seo/`.

1. **Контракт модуля**: добавить `<WORKSHOP>_PROCESS_MODULE_REF` (name+version)
   и schema-id входа в `src/process-modules/lifecycles/product-delivery-module-contracts.ts`.
   Version — контент-адресная идентичность пакета; каждая правка декларации = bump.
2. **Домен**: `src/modules/<цех>/domain/<цех>-schemas.ts` — schema-id строки
   (`factory.<цех>-*.v1`), TS-типы, ЧИСТЫЕ валидаторы (без I/O). Валидатор
   схемы — единственный источник истин для payload-контракта и гейта.
3. **Порты**: `src/modules/<цех>/domain/<цех>-kernel-ports.ts` — id
   kernel-хендлеров + порты (repository/product-reader/render-провайдер...).
   Порты — интерфейсы; конструирует composition root.
4. **Payload-контракты + чек-провайдер**: `application/<цех>-check-providers.ts`.
   Дайджест контракта: `productPayloadContractDigest({schemaId, contractId,
   version, definition})`. Чек-провайдер обязан РЕАЛЬНО читать subject
   CandidateSet (`input.candidateSets.read(ref)` → member.productRef →
   `factory_managed_node_submissions` по id+schema+content_hash) и возвращать
   `passed|failed|error`; `'error'` НИКОГДА не авторизует приём (§17).
5. **Kernel-хендлеры**: `application/<цех>-installation.ts` —
   `create<Цех>KernelHandlers(deps)` возвращает Record по handler-id. Контракт:
   `ctx` = {input, frame.productions[producerNodeId], projectId, processRunId...};
   вернуть `{event, production: {schema, artifactRef, contentHash, semanticDigest?, bindings}, completion?}`.
   Сеттлер выпускает сертификат через `certificateRepo.issue(...)` и
   `completion: moduleCompletion(outcome, certificateRef)`.
6. **Persistence**: `infrastructure/sqlite-<цех>-output-repository.ts` —
   СВОЯ таблица `factory_<цех>_*` через `CREATE TABLE IF NOT EXISTS` +
   триггеры immutability (RAISE ABORT на UPDATE/DELETE). Схему завода
   (`schema.ts`) НЕ трогать, версию схемы НЕ поднимать.
7. **Инфраструктурные адаптеры**: product-reader (читает sealed-продукты по
   точному ref+digest), git-наблюдение репозитория (только exact commit,
   никогда mutable checkout) — по необходимости.
8. **Регистрация**: `src/modules/<цех>/index.ts` — `register<Цех>(registries,
   sharedDeps, options)`: ensure persistence → trusted_providers строка
   провайдера (INSERT при отсутствии, `*_TRUST_DRIFT` при расхождении) →
   `registerWorkshopCheckProvider(...)` → kernelHandlers.registerAll →
   `new GenericFlowExecutor({...})` → moduleRegistry + installationRegistry.
9. **Декларация цеха**: `src/process-modules/modules/<цех>/<цех>-process-module.ts`
   — identity (kind, displayName), inputContract/outputContract, outcomes
   (ВСЕ terminal: true), flow (узлы+переходы+terminalNodeIds), artifacts,
   policies, invariants, executionProfiles (executionSkill, protocolSkill =
   `saga-process-module-worker-protocol`, allowedTools, outputSchema,
   tracker/checklists/callTemplates).
10. **Ячейки**: узел `kind: 'production-cell'` с inline
    `ProductionCellDefinition`. Синглтон — `singletonProductionCell(...)` из
    `standard-production-cell.ts`. Fan-out: `inputSelectors:
    ['<узел>.<items-поле>']`, `materialization: {sourceBinding, workKeySelector,
    completionPolicy}`. Контракты продуктов с payloadContract. Гейты —
    `buildCheckPlan(...)` с провайдерами и digest'ами.
11. **Ресурсы**: `package/resources/` — SKILL.md воркеров (автор/ревьюер),
    чеклисты, call-шаблоны (`product_submit` + `worker_done`), трекер.
    Скилл обязан называть ТОЧНЫЙ schema-id продукта.
12. **Манифест пакета**: `package/manifest.ts` — resourceIndex (все пути
    repo-root-relative, файлы ДОЛЖНЫ существовать), handlerRefs через
    `handlerImplementationDigest(HERE, '<относительный путь к installation.js>', '<цех>')`,
    contractRefs, `runtimeCompatibilityRange: '^3.0.0'`, валидация при загрузке.
13. **Capability-манифест**: `src/process-modules/application/workshop-capability-manifest.ts` —
    payload-контракты в `WORKSHOP_PAYLOAD_CONTRACTS`, чек-провайдеры/эффекты в
    `WORKSHOP_EXECUTABLE_CAPABILITIES`, владелец в `PAYLOAD_CONTRACT_OWNERS`,
    **bump `WORKSHOP_EPOCH`**. Рейчет `tests/architecture/workshop-manifest-parity.test.mjs`
    запрещает регистрацию в обход.
14. **Установка пакета**: `src/orchestrate-cli.ts` — импорт
    `<цех>PackageManifest` + строка в списке `installProductionModules(...)` (≈761).
15. **Lifecycle**: стадия в lifecycle-определении (`product-delivery-lifecycle.ts`
    или свой вариант): inputMapping (чтение `$.stages.<стадия>.*` из frame),
    outputMapping, outcomeRoutes (каждый declared outcome должен иметь маршрут;
    каждая стадия достижима из entry — F1). Регистрация цеха в
    `product-lifecycle-runtime.ts`: `register<Цех>(...)` + entry в
    `resolversBySchema` по схеме выхода (иначе — `no output payload resolver
    for schema` на первом handoff).
16. **Тесты** (импорт из `dist/`, значит `tsc` первым): манифест-тест
    (структура+ресурсы на диске+handlerRefs), contributions-тест, топология
    lifecycle (маршруты/терминалы), доменные валидаторы. Существующие ретчеты
    (`workshop-manifest-parity`, `no-sqlite-in-modules`, `dependency-direction`,
    `lifecycle-outcome-edge-coverage`) подхватят цех автоматически.

## 3. Грабли (наступлено и задокументировано)

1. **Рецепт ≠ реальность.** Рецепт в DRAGON-MAP — 8 шагов, реально — 16 точек
   правки. Пропущенные шаги взрываются В РАНТАЙМЕ, не в компиляторе:
   `no output payload resolver for schema`, `WORKSHOP_CAPABILITY_UNDEARED`,
   `resolveModuleInstallation: no record` (пакет не в списке установки CLI).
2. **Нет параллельных стадий.** `TransitionTarget` = одна стадия|терминал,
   оркестратор — один курсор `currentStageId` под одним lease. «Два цеха
   параллельно после разработки» на уровне lifecycle НЕ ВЫРАЗИМО без хирургии
   ядра. Легальные пути: (а) цех с внутренним fan-out; (б) ОТДЕЛЬНЫЕ
   lifecycle-раны/продолжения на одном проекте (паттерн FactoryRequest из
   приложения к ментальной модели).
3. **Продолжение режет снапшот РОДИТЕЛЯ.** `authorize()` срезает
   `parent.definitionSnapshot` — резюмировать можно только стадию, которая
   ЕСТЬ в пинненном определении родителя. Новую стадию нельзя «дорастить» к
   уже завершённому рану: продолжение применяется к рану, запущенному с
   топологией, где стадия уже была.
4. **Вкл/выкл цеха — это топология, не флаг.** `product-build-lifecycle.ts`
   «отключает» доставку фильтром стадии + переписыванием маршрута
   `verified → terminal runnable-local`. Зафиксированные раны хранят свой
   снапшот — смена дефолта не меняет живые/завершённые раны.
5. **`expectedParentError` — точная строка.** Для продолжения строка терминала
   = `parent.error ?? TERMINAL_OUTCOME:<terminal_status>`; несоответствие →
   `CONTINUATION_PARENT_DRIFT`.
6. **Payload-контракт ≠ TypeScript-тип.** Строковый schema-id без
   исполняемого валидатора — плацебо (§17). Валидатор — один, чистый, в
   домене; его едят контракт, гейт и (у нас) рендер.
7. **Продукты ячеек = managed submissions.** Воркер trackers-профиля сдаёт
   продукт через `product_submit` → строка `factory_managed_node_submissions`;
   member.productRef.ref = `managed-node-submission:<id>`. Читать только по
   id+schema+content_hash. Любой `ORDER BY ... DESC LIMIT 1` в material-path —
   дефект (ADR-053 B-6).
8. **Fan-out downstream.** Ячейка отдаёт downstream `NodeProduction`
   `factory.production-cell-output-manifest.v1`: `bindings.items[].products` —
   ProductRef'ы принятых продуктов по workKey. Kernel-узел после ячейки читает
   их через `ctx.frame.productions['<node-id>']` + product-reader.
9. **WorkKey — из semanticDigest источника.** Fan-out workKey выводится из
   `semanticDigest` продакшена-источника (fallback contentHash) + стабильный
   id элемента. Никогда — позиция в массиве, execution, время.
10. **`$.`-маппинги не прощают пропусков.** Отсутствующее поле во frame →
    `LIFECYCLE_MAPPING_SOURCE_MISSING` в первом же переходе. Опциональные
    операторские члены делайте обязательными в профиле входа
    (start-from-idea/continuation additive mapping), а не «может быть пусто».
11. **Новые члены корневого входа — только optional.**
    `assertProductDeliveryLifecycleInput` валидирует известные члены; старые
    пинненные входы должны продолжать проходить assert без изменений.
12. **Манифест валидируется при загрузке.** `validateProcessModuleManifest`
    бросается синхронно: несериализуемые значения, дубли logicalId, пути
    ресурсов вне корня — сборка падает сразу. Ресурсы должны СУЩЕСТВОВАТЬ
    (тест проверяет диск, инсталлер хеширует байты).
13. **Epoch манифеста — общий на завод.** Любой новый payload-контракт =
    bump `WORKSHOP_EPOCH` + запись в оба списка; parity-тест ловит рассинхрон
    оркестратор/worker-MCP процессами.
14. **Правка скилла без bump версии пакета = дрейф.** Пакеты immutable и
    digest-pinned: байты ресурса входят в packageDigest. Правишь скилл —
    осознай, что это ДРУГОЙ пакет (resume-совместимость решается явно).
15. **Не билдить и не `npm install` при живом заводе.** Движок и воркеры
    исполняют `dist/`; `npm run build` стирает и пересоздаёт `dist/` — живой
    ран продолжит исполнять СТАРЫЙ код из памяти, а новые спавны упадут в
    перемешанном состоянии. Сначала стоп, потом build, потом resume.
16. **Тесты идут за `tsc`.** Все тесты цехов импортируют `dist/` —
    `npm run build` (или минимум `tsc`) перед прогоном.
17. **Элементы fan-out обязаны нести строковый `id`.** `extractItems`
    признаёт элемент только с полем `id` (или `key`/`workItemKey`/`criterionId`)
    — иначе «fan-out source has no stable items». У брифов документации это
    ловилось только на первом прогоне. Проверяй тип элемента-источника до
    декларации ячейки.
18. **(2026-08-24, порт documentation на каноничную ветку) Политика
    submission-валидации узла.** Каждый LM-узел цеха обязан иметь запись в
    `wire-submission-validation.ts` — иначе ПЕРВЫЙ `worker_done` умирает с
    `SUBMISSION_VALIDATION_POLICY_MISSING: <module>@<version>/<node>` (это
    17-я точка правки, не входившая в исходные 16; ловится только реальным
    прогоном). Для цехов с типизированными продуктами ячеек — `mode: 'none'`
    c rationale; ключ — из канонического `*_PROCESS_MODULE_REF`, никогда
    hand-pinned литерал (правило ADR-095 Phase-6). Заодно: ядра ПОСЛЕ ячейки
    получают `ctx.input` = выход ячейки (manifest), а не план — читай план из
    `ctx.frame.productions['<узел-ассемблера>']` (canonical post-cell input
    path), иначе `*_PLAN_SCHEMA_MISMATCH` на первом переходе к рендеру.

## 4. Как цех получает материалы (шпаргалка потока)

```
LifecycleRun frame ($.stages.<id>.* из outputMapping + runtime поля)
  → StageRun input (заморожен, hash)
  → ProcessRun (пинненный пакет: installationId + packageDigest)
  → GenericFlowExecutor: узлы
     kernel     → handler(ctx) → NodeProduction
     cell       → fan-out Workplaces → CandidateSet → Gate → FinalAcceptance
                 → manifest production (items[].products)
  → settlement kernel → certificateRepo.issue → ModuleCompletion
  → complete-<outcome> (process-outcome-emitter)
  → outcomeRoutes → следующая стадия | терминал
```

## 5. Минимальный тест-план нового цеха

1. `<цех>-package-manifest.test.mjs` — структура, ресурсы на диске, handlerRefs.
2. Топология lifecycle — маршруты/терминалы/достижимость, неизменность дефолта.
3. Доменные валидаторы — позитивы + негативы.
4. (Позже) contributions + e2e с scripted worker (замена ТОЛЬКО inference
   порта, не гейтов/роутинга — §23 L3).

## 6. Список эталонных файлов цеха documentation-release

- Декларация: `src/process-modules/modules/documentation/documentation-process-module.ts`
- Манифест: `.../documentation/package/manifest.ts` (+ `resources/`)
- Домен: `src/modules/documentation/domain/documentation-{schemas,kernel-ports}.ts`
- Application: `.../application/documentation-{check-providers,installation}.ts`, `.../application/pdf/pdfkit-documentation-render-provider.ts`
- Инфраструктура: `.../infrastructure/{sqlite-documentation-output-repository,documentation-infrastructure}.ts`
- Регистрация: `src/modules/documentation/index.ts`
- Lifecycle: `src/process-modules/lifecycles/product-documentation-lifecycle.ts`
- Продолжение: `src/app/factory-documentation-continuation.ts`
- Wiring: `product-lifecycle-runtime.ts`, `orchestrate-cli.ts`,
  `workshop-capability-manifest.ts`, `start-product-lifecycle-from-idea.ts`,
  `scripts/factory.mjs`
