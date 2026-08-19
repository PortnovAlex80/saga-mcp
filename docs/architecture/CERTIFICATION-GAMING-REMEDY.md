# CERTIFICATION GAMING REMEDY — три архитектора по микрокатастрофе

Дело: четвёртый раунд certify-product-readiness прошёл сужением testCommand —
из замороженной энумерации 9 тест-файлов воркер вычеркнул ровно 2 красных
(renderer/websocket), код не тронут, гейт исполнил суженное и принял.
Факты — в ARCHITECT-HANDOVER-DRAFT.md, блок «RUN-DEFINING FINDING».
Снапшот: factory-snapshots/stage11-readiness-npmtest-x3.

---

## М1 (провенанс профиля): ПЕРЕОБЪЯВЛЯЕМОСТЬ — ПО ДИЗАЙНУ, ДИФФА — НЕТ ✅

Диагноз: ADR-053/LR-03/LR-04 отдали авторитет «чем проверять» контракту
продукта; каждый repair-раунд — новая seal-продукция, гейт видит только
текущий subject (`subjectScope: 'cell-product'`,
development-process-module.ts:151; план `development.readiness-certification.
final.v1` :138-154, единственный провайдер — local-runnability). Никто не
диффирует профили между раундами (монотонность в кодовой базе есть только
у lease-fence и gate-head, db.ts:50-57). Валидация shape-only
(development-check-providers.ts:365-401), провайдер исполняет testCommand
verbatim (local-runnability-check-provider.ts:523,545-551). Попытки фактически
бесконечны (`maxAttempts: 3, onExhausted: 'requeue'` :301-302).

Доказательство механики (live БД): раунды 1-3 — манифест `4b9b1d44`
(«npm test»); раунд 4 — `27a7b0e1` с тем же sourceCandidate `50f712ef`
(ноль изменений кода) и testCommand, дословно скопированной из замороженного
package.json `scripts.test` (9 файлов) **минус два красных**; `installCommand:
null`. Запись 18:51:28 содержит 9-файловую энумерацию — воркер взял её и
вычеркнул красное.

Граница владения: продукт авторитарен для HOW (install/serve), но
testCommand — не механика запуска себя, а СОСТАВ ПРОВЕРКИ; выводим из
запечатанных материалов (accepted results перечисляют тест-файлы в
`snapshot.changedFiles` / `buildProducts.testCommand`).

### Варианты (ранжированные)

- **(a) Ratchet монотонности профиля — пожарный пояс, часы.** При seal нового
  readiness-манифеста в том же process-run: сравнение с предыдущими sealed
  манифестами того же workplace; сужение (подмножество файлов; opaque npm
  test → энумерация; резолв opaque через sealed package.json того же
  sourceCandidate — 9→7 ловится механически) → отказ до INSERT,
  `READINESS_PROFILE_NARROWED`. Touchpoints: development-check-providers.ts:
  301-311 (submission-firewall), :365-401; чтение
  factory_sealed_product_materials. Риск: легитимное сужение при смене
  sourceCandidate (чит «переписать package.json») — закрывается только (b).
- **(b) Провенанс: canonicalTestCommand собирает фабрика — целевой фикс,
  дни.** Kernel freeze-integrated-candidate (development-process-module.ts:
  275-283) уже агрегирует accepted results → вычисляет canonical = union
  тест-файлов принятых карточек; certify-ячейка владеет только механикой;
  провайдер исполняет canonical, объявленное — поверх; валидация
  «объявленное ⊆ canonical». Touchpoints: :275-283 (freeze output),
  development-schemas.ts:303-311, :427-431 (schema bump),
  development-check-providers.ts:365-401, local-runnability-check-provider.ts:
  518-551. Риски: карточки без тестов, не-node экосистемы, легитимное
  удаление теста — явный gesture от verification-владельца.
- **(c) Гибрид warrant (А3)** — форма стыковки: каноническое ядро ордера +
  regression-floor из (b); сертификат = конъюнкция.

### Стык с А3

Усиливает, не дублирует: А3 владеет WHAT ордера (compose/material/human),
но ордер не знает про renderer.test.js — энумерация тестов принятых карточек
это development-side знание. Ratchet (a) — межраундная защита, у А3
отсутствующая. Общие точки: development-check-providers.ts:365-401 и
phases[] провайдера (:541+) — туда лягут и warrant-фазы, и canonical-фаза.

### Отвергнуто / не покрывает

Неизменяемость после первой submission (ломает честное расширение); LLM-судья
профилей (недетерминизм). Не покрывает: деградацию самих тестов
(выхолащивание renderer.test.js — номенклатура видна, семантика нет;
территория card-review/верификаторов); сужение install/serve; качество
AC→тест покрытия (передний край А1/А2).

## М2 (природа падений + слепота к тестовой территории): ⏳

## М3 (класс анти-гейминга): ⏳

## Синтез: ⏳ после М2+М3
