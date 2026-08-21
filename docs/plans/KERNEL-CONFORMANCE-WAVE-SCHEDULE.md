# KERNEL-CONFORMANCE-WAVE-SCHEDULE — план оставшихся волн

Дата: 2026-08-21 (ночь/утро). Подчинён мастер-плану
`docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md` (K0–K8, §16–§18) и ADR-084.
Этот файл — РАСПИСАНИЕ ИСПОЛНЕНИЯ оставшихся работ, не вторая нормативная
модель. Мастер-план не форкается; при конфликте побеждает он.

## Базовая линия (утро 2026-08-21)

Готово и влито в saga4 (push до `9f5da54d`): W0-1..W0-4 (каноническая
композиция, obligation-контракты + мутационная алгебра + kill-matrix,
scenario DSL/actor/observer, blocking-группа), K0 (baseline + нормализованная
authority-trace), K1-D (proof-claims реестр), W1-1 (флагманский causal
vertical: fabricated-hash → exact feedback → ремонт), W1-4 (ADR-078
two-lifecycle: F-2 кросс-lifecycle изоляция + F-1 внутри-lifecycle
консервация). Группа factory-proof 46/46.

На w0-waves (`b909ae4c`), ещё НЕ влито в saga4: **K2-A** — strict
workerSpawn seam (настоящий дочерний процесс под продакшн-конвертом,
эффекты через настоящий saga MCP, ячейка accepted за 3.4с, ноль
in-process инференций).

Элита-2 (stage-20, запуск 22:46Z на фиксированном билде `9f5da54d`):
**formalization ЗАКРЫТА ЦЕЛИКОМ** — все 6 ячеек accepted при 6 живых
отклонениях (ремонты прошли; фикс trace_delete→ledger-mirror выдержал
первую живую проверку — именно здесь Элита-1 умерла терминально). Завод в
Development: plan-task-graph accepted, 10 implementation work-items
(1 done, 1 review, 1 running, остальные в очереди). Парков нет, watchdog
чист, трекер :4321.

Открытая верификация: полный `npm test` после починки ADR-реестра гонялся
точечно (реестр 5/5 + регрессия 3/3), полного зелёного подтверждения 734/734
ещё нет — пункт 0.2.

## Волна 0 — немедленно (низкий риск, завод не трогаем)

- **0.1** Мерж `w0-waves` → `saga4` (только git-уровень; БЕЗ build в главной
  checkout, пока жив завод), push. K2-A становится частью канона.
- **0.2** Полный `npm test` в ворктри (контент идентичен слитому) —
  зафиксировать точный счёт и EXIT=0.
- **0.3** Заводовой трек (живёт всю смену): watchdog-jsonl; при терминале —
  внешняя проверка метки (запустить продукт, открыть фронт в браузере);
  после ЛЮБОГО resume переподнять `model_concurrency_limit=4`.

Merge gate Волны 0: push чист, полный счёт записан в memory-файл.

## Волна 1 — K2-B/C/D: строгий L3 актёр (критический путь к §17)

Цель: strict repair counterfactuals через НАСТОЯЩЕГО ребёнка + переворот
floor `CanonicalSpawn` в proof-claims. Это единственный оставшийся гэп
строгости: сегодня все драйвы честно canonical-fast.

- **1.1 (K2-B, формат)** — программа-модуль (.mjs) вместо JSON: диспетчер
  по ячейке (ключ ячейки из промпта — production-visible), repair-ветка по
  typed-фидбеку из промпта (`--- END PRIOR ATTEMPTS ---`), шаги `{write}`
  (запись только внутри cwd), плейсхолдер `$fileHash:<path>` (sha256
  собственных файлов — легитимная деривация актёра, сервер всё равно
  проверяет). Идентификаторы — ТОЛЬКО из собственного `task_get` /
  `artifact_list`. Неомнищиентность сохраняется: никаких attempt-счётчиков,
  scenario-id, DB.
- **1.2 (K2-B, корпус)** — программы ячеек до acceptance:
  discovery-proposal (готов), assess-readiness (bindings из task_get →
  `product_read` → `product_submit`), define-product-contract, model-use-cases,
  define-acceptance-contract с вилкой fault/repair (fabricated digest →
  typed `ARTIFACT_CONTENT_HASH_UNVERIFIABLE` → точный ремонт честными
  байтами).
- **1.3 (K2-B, вертикаль)** — fabricated-hash вертикаль в strict-режиме;
  контрфакты exact/absent/stale/corrupt: ремонт происходит ТОЛЬКО под exact
  фидбек (причинность, как в W1-1, но через spawn).
- **1.4 (K2-C)** — растчетки: ребёнок не импортирует db/finalizer/
  transition-handler; import-ratchet для strict-файлов; capability-контроль
  (никаких SQL/SQLite в дереве ребёнка).
- **1.5 (K2-D)** — негативные семейства: изъятие tool-permission или
  MCP-конфига из конверта роняет strict-сценарий ДО вызова хендлера.
- **1.6** — переворот floor `CanonicalSpawn` (тем же коммитом, что 1.3).

Merge gate Волны 1: strict happy + strict repair-only-with-exact-feedback
зелёные дважды (детерминизм); негативы 1.5 действительно падают до
хендлера; proof-claims больше не содержат floor-ошибку.

## Волна 2 — K6 замыкание: W1-2 + W1-3

- **2.1 W1-2** (Run B/C, §16 two-pass): реальный Factory Start A → новый
  Factory Start B на том же продукте; убрать выключенный Run B из
  `golden-path.test.mjs` (долг живым долгом).
- **2.2 W1-3** (Authorized Delivery → `released`): `actions.length>0`,
  независимое внешнее наблюдение через delivery-doubles канонической
  композиции; негативная семья — несанкционированная доставка НЕ происходит.

Merge gate: оба через каноническую композицию, blocking, детерминированные
повторы, честные proof-claims.

## Волна 3 — W1-5: систематический рост gate-family

Мутационные семьи из obligation-контрактов (алгебра K3 уже есть) → новые
сценарии по мере находок. Кандидат от Элиты-1: E2E «repair-between-seals»
(seal → ревью-раунд → trace_delete → reseal → сертификация чистая).
Требует машинерии ревью-раундов; если семантика ревью не даёт триггера —
записать как ADR-note с доказательством неприменимости, НЕ подгонять
сценарий. Unit-регрессия уже blocking (mirror/no-op/re-add).

## Волна 4 — K7: bounded explorer (честные L1/L2)

Три ортогональные машины (workplace/material, execution/engine,
lifecycle/pipeline), BFS кратчайших safety-нарушений + seeded random walks,
минимизация трейсов, replay через L2/L3 адаптеры. Жёстко: explorer-решения
никогда не пишутся в production-маршрутизацию; результаты помечаются L1/L2.

## Волна 5 — K8: универсальность + canaries

Кросс-воркшоп корпус (Discovery/Formalization/Development/Delivery) без
правок test-engine; синтетический воркшоп только пакетом+lifecycle+фикстурами;
закрытый каталог; 2 real-model canary (happy + repair через opencode-воркер) —
мониторные доказательства, НЕ детерминированные гейты. После — ревизия
стоп-условий §17 и закрытие архитектурной фазы.

## Порядок и параллелизм

0 → 1 → 2 → 3 → 4 → 5. Волны 2 и 3 частично параллелизуемы (разные файлы),
но merge-gates последовательны. Заводовой трек (0.3) живёт независимо всю
смену. Каноническую композицию правит один владелец за раз (§13.3) — K2-волны
не параллелят с правками composition-адаптера.

## Дисциплина (без изменений)

Нет 4-го runtime; нет authority через прямой SQL; норма не из production
declarations; актёр не видит scenario/attempt; зелёный счётчик ≠ proof;
гейты не ослаблять никогда. Build — только в ворктри, пока жив завод.
`~/.claude/settings.json` — только sha-трипваер (`2d6176e8…`). opencode
shim only. Явные пути git-add. Грязные файлы оператора не коммитить.
Терминал/аномалию завода — эскалировать, не чинить на живом.
