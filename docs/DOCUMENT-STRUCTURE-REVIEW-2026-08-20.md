# Структура docs/ — полный аудит и ядро (2026-08-20)

Аудит всех 207 файлов в 25 папках. Каждый файл прочитан и классифицирован.
Категории: **ЯДРО** (норматив, действует сейчас), **ПОДДЕРЖКА** (живое, но
второстепенное), **ИСТОРИЯ** (завершённые записи, ценность провенанса),
**УДАЛИТЬ-?** (устарело/дубли — кандидаты, решение за оператором).

Главный вывод: папка здорова, хаоса меньше, чем кажется — в ней три слоя
(нормативное ядро ~30 файлов + 60 ADR; журнал стадийной кампании stage2–18;
исследовательские отчёты одного дня). Реальных кандидатов на удаление 30
файлов, из них только 7 «чистые» (признаны устаревшими самими документами
репо); остальные — устаревшие копии шаблонов и выполненные планы.
2026-08-20 оператор утвердил удаление 29 из них (оставлен ideas/P22-trackplan.md).

---

## 1. ЯДРО — норматив, действует (не трогать)

### 1.1 Контракты конвейера (`docs/architecture/`)

| Файл | Что это |
|---|---|
| `CONVEYOR-MENTAL-MODEL.md` | Арбитр, архитектурный компас **v5.3**. Любое изменение runtime/персистентности/модулей сверяется с ним. Защищён собственным протоколом изменений. |
| `CONVEYOR-TRANSITION-DIAGNOSTICS.md` | Нормативный целевой контракт диагностики переходов (универсальная грамматика исполнения, трёхзаписная модель авторитета). §7 сам признаёт: cutover не завершён. |
| `CONVEYOR-TRANSITION-CHECKLIST.md` | Операционное приложение к диагностике: условия приёмки, карточки инцидентов. Потребляется тестом `conveyor-transition-diagnostics-doc.test.mjs`. |
| `FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md` | Нормативный доменный приложный реестр: 29 карточек REG-*, 14 E2E-сценариев. Самый цитируемый кодом документ. |
| `lifecycle-command-event-vocabulary.md` | Замороженный словарь lifecycle-команд/событий (Slice 0). Переименование — только через ADR. |
| `LEGACY-INVENTORY.md` | K2-инвентаризация легаси: правило «только сжимается», сжигание схемы. Проверяется freeze-тестами и `npm run legacy:report`. |
| `adr-closure-registry.json` | МАШИННЫЙ: реестр закрытия ADR (протокол ADR-076, K0–K20). Читают `tools/adr-closure-registry.mjs` и 2 теста. Удалять нельзя. |
| `legacy-allowlist.json` | МАШИННЫЙ: K2-заморозка легаси. Потребляют `tools/legacy-freeze.mjs` и 2 теста. Удалять нельзя. |
| `FAILURE-AXES.md` | Живая карта осей отказов (8 осей, честная таблица покрытия), 2026-08-20. Корм для матричных тестов. |
| `E9-RESERVE.md` | Защитная карта «не удалять»: кодовые резервы отложенного E9. Обязательна для ночных агентов. |
| `WORKSHOP-CONTROL-TRACKING.md` | Живой анализ (2026-08-20): обратная цепочка приёмки от `runnable-local`, Break 2 (K19), 3 предсказания. |

### 1.2 ADR-корпус (`docs/architecture/decisions/`, 60 файлов, 024–083)

ADR — immutable журнал решений, удалению не подлежит. Ключевые:
- **ADR-053** — системный диагноз (владелец материала — Workplace, не
  WorkerExecution); самый цитируемый документ репо (299 упоминаний в
  tests/src). Статус in-progress, K6–K13.
- **ADR-073** — довести cutover 053 до конца (запрет latest/newest-фолбэков).
- **ADR-076** — протокол закрытия реализаций + сам реестр.
- **ADR-048** (45 цит.) — temporal-конформность вместо канонической
  композиции;脊bone тестовой архитектуры.
- **ADR-082** — граница допуска ядра (открытый K14), ADR-075 (31 цит.) —
  без человека в цикле качества, ADR-079/080/081 — капсулы replay и
  доказательства AuthorityCommit.

Открытые по реестру (живая работа): in-progress 053/073/074/075;
planned 30 шт. (025, 029–032, 036, 038–039, 041, 043–044, 046–049, 054,
056, 058–059, 061–066, 068, 070–071, 082–083); 077 implemented-not-closed.
Аномалии: 038 «Proposed» при доставленном механизме; 046 и 062 без Status;
044 — механизм с нулём импортёров; 062 без владельца-релиза.

### 1.3 Программные планы и статус (`docs/vision/`, `docs/verification/`)

| Файл | Что это |
|---|---|
| `vision/SAGA-CORE-RENEWAL-PLAN.md` | Нормативная лестница K0–K20 (Core 3.0 GA). Владелец остатка ADR-053. Стадии 2–18 исполняют именно её. |
| `vision/CONTROLLED-CHANGE-PLANE-PLAN.md` | Плановая лестница C0–C13 (Change Desk, C12 SDK, C13 пилот). Запускается ПОСЛЕ Core 3.0 GA. Дополняет, не дублирует SCRP (их границы разведены в самих доковах). |
| `verification/PROGRAM-STATUS.md` | Точка входа уровня программы: что закрыто, что читать дальше. Отстаёт: нет секции K13 (см. §5). |
| `verification/K13-AUTHORITY-CLOSURE-PROOF.md` | Живое доказательство K13: «evidence produced, gate UNSIGNED» — ждёт подписи архитектора; реестр пинует K13=open. |
| `verification/verification-manifest.json` | МАШИННЫЙ: 8-suite зелёный базлайн, читается/пишется `tools/verification-manifest.mjs` (`npm run verify:check`). |

### 1.4 Живые инструкции кампании (`docs/handoff/`, `docs/factory-run/`)

- `handoff/STAGE-18-AGENT-BRIEF.md` — **исполняется сейчас** (R1/R2/R3 уже
  закоммичены; отчёт `factory-run/stage18/REPORT.md` обещан, ещё не написан).
- `handoff/STAGE-17-AGENT-BRIEF.md` — частично исполнен (Space F закоммичен,
  `tests/matrix/g-world-fidelity.test.mjs` лежит untracked — риск потери).
- `factory-run/stage11/ARCHITECT-HANDOVER-DRAFT.md` — «Status: final»,
  входная точка в состояние stage-11 (названа брифом 12).

### 1.5 Операционные и машинные (`docs/factory/`, корень, шаблоны)

- `INSTALL.md` (обновлён 2026-08-20) — установка и запуск.
- `SYSTEM-ACCEPTANCE-CRITERIA.md` — верхние критерии приёмки системы
  («как должна работать»); ссылка на `docs/saga3/...` мертва — освежить.
- `factory/CI-02-ACCEPTANCE-MATRIX.md` — блокирующая матрица приёмки;
  цитируется `tools/run-acceptance-matrix.mjs` и `ci.yml`.
- `factory/COMPLETION-LEDGER.md` — живая карточная ведомость W-программы;
  машинно парсится `tools/validate-completion-evidence.mjs` (шаг CI).
- `testing/WORKSHOP-BUGS.md` — реестр багов KI/TB с корнями; цитируется
  исходниками (`busy-retry.ts`, `durable-state-probe.ts`, `capture-spawn.ts`).
- `testing/SNAPSHOT-TEST-DESIGN.md` — активная программа сборки
  snapshot-тестов (scripted double через настоящий MCP-шов).
- `testing/G3-MERGE-GRANT-CONFLICT.md` — ОТКРЫТОЕ решение архитектора
  (worker_merge на живом пути против factory-owned git).
- `design/FACTORY-CHECKPOINT-AND-TEST-PROFILES.md` — профили
  live/checkpoint_replay/test-warm-start, ядро результатов 0–10.
- `design/FACTORY-TEMPORAL-TESTING.md` — нормативное дополнение к
  тест-стратегии (ADR-048/049); команды живут в package.json.
- `plans/PROCESS-MODULE-PACKAGE-SPI.md` — фундаментальный SPI
  «модуль владеет содержанием, рантайм — физикой»; реализован в
  `src/process-modules/`.
- `requirements/templates/` — PRD.md, SRS.md, INVARIANCES.md — шаблоны,
  на которые ссылаются скиллы и saga-release.

**Итого ядро: ~31 файл + 60 ADR.**

---

## 2. ПОДДЕРЖКА — живое, второстепенное

### 2.1 Дизайн-доки реализованного (баннеры «to implement» устарели — §5)

`architecture/`: PAUSE-DESIGN, PROVIDER-RETRY-DESIGN, WORKER-NAMES-DESIGN,
REPAIR-CODE-PRESERVATION, REPLAN-CYCLE-TZ, FINDING-TRAJECTORY-BUDGET,
AC-DRIFT-REMEDY-DESIGN — все проверены в src/ и закоммичены (ветви слиты,
см. BRANCH-CLEANUP-2026-08-20). Оставить как дизайн-провенанс.

### 2.2 Частично открытые дизайны (действие ещё pending)

- `CERTIFICATION-GAMING-REMEDY.md` — шаг 1 (coverageReport) в коде,
  шаг 4 (derived canonical set) НЕ сделан.
- `SEAM-ARCHITECT-DESIGN.md` — слой 2 (интеграционная верификация целого)
  в src отсутствует.
- `RECYCLE-RUN-DESIGN.md` + `E2-MIGRATION-NOTE.md` — осознанно отложены
  (E9), входят в ядро будущих решений вместе с E9-RESERVE.

### 2.3 Прочее живое

- `architecture/proposals/worker-exit-consistency-protocol.md` — реализован
  (releaseExecutionAtomically, effective_terminal), баннер «Proposed» врёт.
- `architecture/README.md` — индекс классификации; верен, но покрывает 10/30
  файлов и знает v5.2 вместо v5.3 — расширить, не выбрасывать.
- `WEAK-MODEL-CONTROL-CHECKLIST.md` (корень) — чек-лист контроля слабой
  модели, концептуально жив.
- `howto/AGENT-WORKER-MONITOR.md` — как читать мозг живого воркера (:4321).
  `howto/CODEX-HOOK-ENVELOPE.md` — рецепт впрыска контекста в Codex-сессию
  (однократное успешное применение; AGENTS.md ссылается на ту же механику).
- `design/EXECUTION-ROUTE-ARCHITECTURE.md` — claim-time merge маршрутов
  (factory.execution.v2), низкий дрейф.
- `design/FACTORY-CORE-VIEW.md` — реализованное sidecar-наблюдение (:4323).
- Цеховой набор `testing/`: WORKSHOP-STATUS.md + WORKSHOP-JOURNAL.md
  (по уставу живые, по содержанию ЗАМОРОЖЕНЫ с 2026-08-15: W1 20/20,
  W2 брошен на ~12/20, W3 не начинался — кампания ушла в stage2–18),
  WORKSHOP-TEST-PLAN.md (формат журнала), projects.json (каталог 20 проектов,
  потребляется scripts/testbed-*), G4-LEASE-ARITHMETIC, W2-SPEED-AND-RECOVERY
  (цитируется тестом), W9-04 (цитируется схемой).
- `factory/`: CI-01-LEGACY-LINT-BACKLOG (источник eslint-рашета),
  COMPLETION-EVIDENCE-CONTRACT (контракт T3-доказательств),
  W9-SCRIPTED-E2E-EVIDENCE (индекс ещё открытых W10-02/W11/W12),
  ADR-053-CUTOVER-TODO.md — исторический, НО его читает
  `tests/architecture/adr-053-cutover-gates.test.mjs` — не удалять, пока
  читает тест.
- `verification/`: CANONICAL-BASELINE-K1.md, LEGACY-BURNDOWN-K2.md — закрытые
  базлайны (провенанс).
- `vision/`: FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT (гипотеза продукта,
  породила ADR-082), GO-TO-MARKET-RU-THEN-EU (бизнес-исследование) — не
  нормативные, но уникальные.
- `ideas/P01-counter.md, P02-stopwatch.md, P03-tips.md, P21-foodlog.md` —
  тестовые входы конвейера (полуфабрикаты идей), используются как E2E-фодер.
- `factory-run/stage10/BUG-DATABASE.json` — структурированные дефекты
  первого реального прогона; корм для форензики stage11–12.
- `factory-run/stage11/INDEX.md` — declares current/superseded внутри stage11.

**Итого поддержка: ~40 файлов.**

---

## 3. ИСТОРИЯ — журнал кампании (провенанс, не удалять без архива)

- `handoff/` брифы 2–16 + STAGE-9-ADDENDUM + STAGE-12 (его OPERATOR OVERRIDE
  переехал в AGENTS.md): строго линейная цепочка «Continues <previous>».
  Два топологических исключения: STAGE-16 «continues stage 14», STAGE-18
  исполняется раньше 17.
- `factory-run/` отчёты stage10–16 (stage15 закрыт записью в RUN-TRACKER,
  отдельный отчёт так и не написан; stage17/18 папок нет — их выводы легли
  в код/тесты/FAILURE-AXES), stage13 evidence-файлы RED-*.txt (~84K сырых
  логов), stage12 NIGHT-TRACKER (ЗАКРЫТ 09:00 20.08 — а AGENTS.md всё ещё
  говорит «read FIRST») + ARCHITECT-NIGHT-REPORT, SNAPSHOT-MVP-ANSWERS.
- `research/` — все 6: kernel-surface-evidence и ees-admission-judgment
  кодифицированы в ADR-082; real-run-gap-analysis породил G1–G5;
  ARCHITECTURE-RESEARCH и CONVEYOR-TRANSITION-AUDIT свёрнуты в код/тесты;
  WORKER-FEEDBACK-LOOP-MAP — предложение v2 без следов внедрения.
- `testing/`: W1-BLIND-REVIEW, WORKSHOP-W1-W2-ANALYSIS-REPORT,
  WORKSHOP-W1-W2-INDEPENDENT-VERIFICATION, TASK-C-PREVERIFICATION.
- `factory/`: C7-TEMPORAL-FENCING-CLOSED, CI-03-CLEAN-BASELINE,
  COMPLETION-BASELINE.
- `architecture/`: ADR-053-QA-REPAIR-PLAN, BRANCH-CLEANUP-2026-08-20.
- Корень: REFACTORING-PLAN-AND-STATUS.md (точка остановки волны 15–16.08;
  п.15 «handler digests» закрыт позже в e3204790).
- `design/PARTIAL-RESET-AND-RESUME.md` (старейший, 30.07: анализирует
  saga3_*-таблицы, пути переехали; идеи поглощены ADR-024 и
  tools/saga-reset-stage.mjs).
- `gold-material/` PLAN-1..3 (выполнен только PLAN-1: tests/golden-runs/
  production-run-001; PLAN-2 не реализован; ссылок на папку — ноль).

**Итого история: ~60 файлов.**

---

## 4. УДАЛИТЬ-? — кандидаты (решение оператора)

> **РЕШЕНИЕ (оператор, 2026-08-20):** из 30 кандидатов удалено 29;
> `ideas/P22-trackplan.md` ОСТАВЛЕН. Ссылки в DRAGON-MAP.md проверены —
> ссылок на удалённое нет. Два комментария в src (replan-supersede.ts,
> replan-cycle-policy.ts) переведены с удалённого REPLAN-CYCLE-DESIGN.md
> на REPLAN-CYCLE-TZ.md. AGENT-ENVELOPE.md (замороженный исторический
> конверт) упоминает ADR-053-CUTOVER-EXECUTION-TRACKER и W10-RUN-PROFILE —
> оставлено как история. Папки discovery/tools/ и formalization/tools/
> рантайм пересеивает из src/process-modules/.../resources при следующем
> discovery-прогоне (это генерируемый вывод, больше не коммитим).

### 4.1 Все 30 кандидатов по дате создания (git: первый коммит с файлом)

| Дата | Файл | Причина |
|---|---|---|
| 2026-07-25 | `discovery/tools/diagnosis-call-template.json` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/diagnosis-checklist.md` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/discovery-doc-template.md` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/normalization-call-template.json` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/normalization-checklist.md` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/proposal-call-template.json` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/proposal-checklist.md` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/readiness-call-template.json` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/readiness-checklist.md` | устаревшая копия шаблона |
| 2026-07-25 | `discovery/tools/stage-tracker.md` | устаревшая копия шаблона |
| 2026-07-26 | `formalization/tools/artifact-create-call-template.json` | устаревшая копия шаблона |
| 2026-07-26 | `formalization/tools/formalization-node-checklist.md` | устаревшая копия шаблона |
| 2026-07-26 | `formalization/tools/process-module-stage-tracker.md` | устаревшая копия шаблона |
| 2026-07-26 | `formalization/tools/trace-add-call-template.json` | устаревшая копия шаблона |
| 2026-07-26 | `formalization/tools/worker-done-call-template.json` | устаревшая копия шаблона |
| 2026-07-27 | `discovery/tools/proposal-stage-tracker.md` | устаревшая копия шаблона |
| 2026-07-27 | `discovery/tools/readiness-stage-tracker.md` | устаревшая копия шаблона |
| 2026-08-08 | `architecture/FACTORY-CONTRACT-HARNESS-REFACTORING-PLAN.md` | цели в коде, якоря мертвы |
| 2026-08-08 | `formalization/SRS.md` | выход тестового прогона, не док завода |
| 2026-08-11 | `FACTORY-E2E-STABILIZATION-TRACKER.md` | предок COMPLETION-LEDGER, «active» врёт |
| 2026-08-12 | `architecture/ADR-053-CUTOVER-EXECUTION-TRACKER.md` | stale по признанию README папки |
| 2026-08-12 | `gold-material/PLAN-1-SNAPSHOT-BACKUP.md` | план выполнен, ссылок ноль |
| 2026-08-12 | `gold-material/PLAN-2-REGRESSION-TESTS.md` | план не реализован и заброшен |
| 2026-08-12 | `gold-material/PLAN-3-UTILIZATION.md` | план закрыт частично |
| 2026-08-13 | `factory/W10-RUN-PROFILE.md` | профиль запрещённого claude CLI |
| 2026-08-15 | `testing/WORKSHOP-STATUS-SHEET.html` | снимок старее .md, не генерируется |
| 2026-08-16 | `ideas/P22-trackplan.md` | ОСТАВЛЕН по решению оператора |
| 2026-08-18 | `factory-run/CANARY-RUN-PLAYBOOK.md` | одноразовый прогон BLOCKED, механизм запрещён |
| 2026-08-19 | `architecture/REPLAN-CYCLE-DESIGN.md` | заменён REPLAN-CYCLE-TZ |
| 2026-08-19 | `factory-run/stage11/FINAL-REPORT-PREP.md` | superseded по INDEX stage11 |

### 4.2 Группировка по причинам

«Чистые» — признаны устаревшими документами самого репо:

1. `architecture/ADR-053-CUTOVER-EXECUTION-TRACKER.md` — README папки сам
   помечает stale: таблица не соответствует коду, остаток ADR-053 ведёт
   реестр. Дублирует реестр + TODO.
2. `architecture/FACTORY-CONTRACT-HARNESS-REFACTORING-PLAN.md` — цели в
   коде, якоря (ded7ebf, v4.3) мертвы, цитат нет.
3. `factory-run/stage11/FINAL-REPORT-PREP.md` — помечен superseded
   собственным INDEX.md.
4. `testing/WORKSHOP-STATUS-SHEET.html` — ручной снимок от 13:20 UTC,
   на 2 часа СТАРЕЕ WORKSHOP-STATUS.md (15:06), ничем не генерируется.
5. `factory/W10-RUN-PROFILE.md` — замороженный профиль claude CLI; claude
   CLI запрещён директивой 2026-08-20 (aa104969). Единственная ссылка —
   исторический AGENT-ENVELOPE.md в корне.
6. `factory-run/CANARY-RUN-PLAYBOOK.md` — одноразовый предполётный прогон
   2026-08-18 с вердиктом «BLOCKED»; весь механизм flip/claude запрещён.
7. `architecture/REPLAN-CYCLE-DESIGN.md` — заменён REPLAN-CYCLE-TZ.md
   (пятёрка архитектиков назвала TZ-actionable; сам это признаёт).

Устаревшие копии шаблонов (каноник — в
`src/process-modules/modules/{discovery,formalization}/package/resources/`,
рантайм пересеивает docs-копии идемпотентно; docs-копии разошлись с кодом,
в коде есть 6 файлов, которых в docs нет):

8. `discovery/tools/` — все 12 файлов.
9. `formalization/tools/` — все 5 файлов.

Выполненные/заброшенные планы и чужие артефакты:

10. `gold-material/` — все 3 плана (золотой материал живёт в
    tests/golden-runs/; ссылок на папку ноль).
11. `formalization/SRS.md` — ВЫХОД тестового прогона конвейера (крошечный
    SRS по tests/mock-claude), а не документация завода; лежит не на месте.
12. `ideas/P22-trackplan.md` — 39K план ж/д приложения для ВНЕШНЕГО workspace
    (`C:\Users\user\Documents\Kaprem_5.2`); к заводу отношения не имеет
    (либо перенести туда).
13. `docs/FACTORY-E2E-STABILIZATION-TRACKER.md` — предок W-программы; баннер
    «active» устарел (W9–W12 переехали в COMPLETION-LEDGER и stage-кампанию).
    Низкая историческая ценность против ведомости.

Спорные (я бы чинил/сливал, а не удалял):

- `design/TESTING-STRATEGY.md` — поглощён FACTORY-TEMPORAL-TESTING и
  чекпоинтами (tests/regression/ не существует), но L5-команды живы →
  кандидат на СЛИЯНИЕ в FACTORY-TEMPORAL-TESTING.
- `design/PARTIAL-RESET-AND-RESUME.md` — история, но единственная кулинарная
  книга SQL-очистки → в архив, не в удаление.

**Итого кандидаты: 30 файлов (7 + 17 копий-шаблонов + 6 планов/чужих); удалено 29, P22 оставлен.**

---

## 5. Противоречия и несвежие указатели (чинить, не удалять)

1. **AGENTS.md** ведёт на NIGHT-TRACKER как «live status — read FIRST» —
   смена ЗАКРЫТА (09:00 20.08); текущая стадия — 18. WORKSHOP-STATUS.md как
   «читать первым для состояния завода» — цех заморожен с 15.08.
2. **architecture/README.md** — v5.2 → уже v5.3; нет классификации для ~19
   файлов волны 19–20.08.
3. **Баннеры**: 6 реализованных дизайн-доков всё ещё «to implement after
   stage-11» (PAUSE, PROVIDER-RETRY, WORKER-NAMES, REPAIR-CODE-PRESERVATION,
   FINDING-TRAJECTORY, REPLAN-CYCLE-TZ); proposal worker-exit — «Proposed,
   NOT implemented» при живом коде.
4. **PROGRAM-STATUS.md** — нет секции K13 (доказательство есть, гейт не
   подписан); G3 прямо оспаривает его запись о K11: «реестр прав, статус
   ошибочен».
5. **WORKSHOP-STATUS/JOURNAL** — «живые по уставу, мёртвые по содержанию»:
   W2 оборван на ~12/20, сводка пуста. Нужна явная пометка «заморожено,
   кампания перешла в stage2–18».
6. **SYSTEM-ACCEPTANCE-CRITERIA.md** — ссылка на `docs/saga3/process-modules/
   ARCHITECTURE.md` мертва (папки saga3 нет).
7. **Сломанные ссылки скиллов**: saga-analyst → `requirements/templates/
   use-cases.md` и `acceptance-criteria.md`, saga-kickstart →
   `discovery-brief.md` — файлов нет.
8. **stage18/REPORT.md** обещан stage15-трекером как дом базовой линии
   stage-19 — не написан (задача исполняющейся стадии 18).
9. **tests/matrix/g-world-fidelity.test.mjs** — untracked (вне docs, но
   потеряется при чистке).

## 6. Мёртвые ссылки НА docs/ извне (отдельный трек чистки)

`README.md`, `README.ru.md`, `DRAGON-PROMPT.md`, `AGENT-ENVELOPE.md`,
`modules-ext/*` ссылаются на несуществующие:
`docs/refactor-management/**` (WAVE-спеки — топ по числу ссылок, ~29×),
`docs/saga-mcp-history.md`, `docs/README.md`, `docs/FACTORY-START-QUICKSTART.md`,
`docs/SRS.md`, `docs/LangRef.html`, `docs/prd.md`, `docs/x.md`,
`docs/architecture/WAVE-LOG.md`, `docs/architecture/passive-worker-kernel-blueprint.md`,
`docs/requirements/REQ-001*/**`, `docs/formalization/{PRD,FR-1,...}.md` и др.
(324 уникальных пути, из них существуют ~55).

## 7. Методология

Прочитаны все 207 файлов (для монолитов >40K — структура + статус + выводы).
Каждый вердикт проверен против src/tests/tools (потребление), git-статуса и
перекрёстных ссылок. Пять параллельных исследований + сводка; использованы
готовые классификации: architecture/README.md (стадия 5), stage11/INDEX.md,
ADR-076-реестр. Дата среза: 2026-08-20, ветка saga4.
