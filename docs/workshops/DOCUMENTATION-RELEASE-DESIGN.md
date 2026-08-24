# Цех documentation-release — дизайн (v1.0.0, 2026-08-19)

Цех выпуска PDF-документации ПО. Четвёртый цех завода; собирается при живом
заводе без правок ядра рантайма (LEGO: только декларации, хендлеры и wiring).

## Задача

После верифицированного завершения разработки (`solution-development.verified`)
выпускать для точного интегрированного кандидата набор PDF-документов:

- **user-manual** — Руководство пользователя;
- **programmer-manual** — Руководство программиста;
- **acceptance-report** — Отчёт о приёмочных испытаниях (по умолчанию);
- **operator-manual** — Руководство оператора (опциональный вид).

Состав — data-driven: `DOCUMENTATION_KINDS` в
`src/modules/documentation/domain/documentation-schemas.ts`; новый вид
документа = запись реестра + секция в скилле, без правок потока.

## Архитектурное решение (LM пишет текст, рендер — deterministic kernel)

- Воркер авторизует **структурированный** документ
  (`factory.documentation-document.v1`: секции/блоки), НЕ PDF.
- Author gate — детерминированный провайдер полноты (структура + обязательные
  секции вида); final gate — review-verdict (переиспользованный cross-cutting
  провайдер).
- PDF рендерит **kernel-узел** через внедрённый `DocumentationRenderProvider`
  (pdfkit + шрифт с кириллицей; ленивые импорты). Отсутствие движка = честный
  `blocked` (typable, продолжаем), никогда не деградация (§17 unknown rule).
- Сеттлер проверяет полный отрендеренный workset, выпускает сертификат.

## Поток

```
assemble-documentation-case (kernel)
  └─ валидация кейса; наблюдение репозитория ТОЧНО на integrated commit
     (git ls-tree/show); брифы по видам документов
author-documents (production-cell, fan-out по видам)
  └─ Workplace на каждый вид: автор → author gate → ревьюер → final gate
render-documentation-bundle (kernel)
  └─ каждый принятый продукт → PDF в outputRoot; bundle-запись (immutable)
settle-documentation (kernel)
  └─ сертификат + исходы documented | blocked | failed
```

## Топология lifecycle и «параллельность»

`product-documentation-lifecycle.ts`: полная цепочка из 4 стадий, где
delivery-release заменён на documentation-release:
`dev.verified → documentation-release`; `documented → terminal runnable-local`
(закон 12: документация ничего не релизит); `blocked → documentation-blocked`
(продолжаемо); `failed → failed`.

Lifecycle-роутинг одиоцеленный (один курсор, один lease) — параллельных стадий
в ядре НЕТ. Параллельность достигается:
1. **внутри цеха** — fan-out workplaces по видам документов (одновременное
   авторство руководств);
2. **на уровне заказов** — документация и доставка как отдельные
   раны/продолжения от одного принятого префикса (паттерн FactoryRequest из
   CONVEYOR-MENTAL-MODEL). Продолжение (`factory-documentation-continuation.ts`)
   ретраит documentation-release у рана в терминале `documentation-blocked`
   (например, поставили pdf-движок). Продолжение режет снапшот РОДИТЕЛЯ —
   стадия должна была быть в его топологии с момента старта.

## Включение

- Новый старт: `SAGA_FACTORY_LIFECYCLE=product-documentation` при запуске
  движка (+ `SAGA_DOCS_OUTPUT_ROOT` опционально; дефолт
  `<repoRoot>/.factory-docs/project-<id>`). Дефолтный product-build НЕ изменён.
- Ретрай blocked: `node scripts/factory.mjs continue <db> --from-lifecycle N
  --documentation [--kinds user-manual,...] [--out <dir>]`.
- Активация кода: `npm install && npm run build` (только по указанию
  оператора; при живом заводе НЕ собирать).

## Хранение и идентичность

- Таблица `factory_documentation_bundles` (модульная, immutable-триггеры):
  payload-снапшот + bundleHash. PDF-файлы — артефакты в outputRoot; байтовый
  sha256 — evidence в bundle. Идентичность авторитета — дайджест ВХОДНОГО
  документа (структурированный JSON), не байты PDF.
- semanticDigest сеттлера: {candidateHash, kinds, documentDigests} — без
  run-переменных (replay-stable).

## Границы MVP (честно)

- Один репозиторий на кандидат (мультирепо → бриф без tree-экцерптов).
- Таблицы PDF простые (без колоночной сетки) — рендер v1.
- Отчёт о ПИ компилирует критерии из accepted baseline; построчные чек-рецепты
  верификации подключаются следующим шагом (чтение acceptance-verification
  workset по ref).
