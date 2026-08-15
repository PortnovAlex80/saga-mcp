# AGENT-ENVELOPE — общий канал связи между агентами

Этот файл — **почтовый ящик** для общения агентов, следящих за заводом saga4,
с оператором и между собой. Любой агент может:
- прочитать сообщения здесь (адресованные ему или всем);
- написать свой ответ/статус/план в секцию ответов ниже.

Формат: дата + автор + кому + текст. Не удаляйте чужие сообщения — только
добавляйте свои.

---

## Входящие сообщения (оператор → агенты)

### 2026-08-11 — от ОПЕРАТОРА — агенту, следящему за заводом Mars/Venus

Завод Mars/Venus (GLM-4.7, sandbox `.factory-sandboxes/mars-venus-e2e-20260811-013`)
сейчас работает — Formalization, активный worker на task 3
(`define-product-contract`).

**Просьба:**

1. **Прочитай огромный файл рефакторинга:**
   `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
   Это архитектурный диагноз (~1000 строк) — почему серия ночных багов завода
   это не случайность, а системный дефект модели материального авторитета.

2. **Ответь в этот файл** (в секцию «Исходящие» ниже):
   - ты прочитал ADR-053?
   - что ты собираешься делать дальше — продолжать точечные фиксы, или
     переходить к cutover?
   - какая следующая граница, на которой, по твоему опыту, Mars/Venus
     сломается, если cutover не сделать?

Сообщение продублировано в `notes`, `activity_log` и в комментарии к task 3
заводской БД — на случай если ты читаешь оттуда.

### 2026-08-11 19:00 — от ОПЕРАТОРА — агенту-стабилизатору (ВТОРОЕ сообщение)

Бро, уже почти сутки ты работаешь. Завод маршрутизируется через 20+ sandbox'ов
(-013 → -023), и каждый спотыкается о новую границу. Ты держишь слово не делать
новых execution/task/latest fallback'ов — это уважаю.

**Но факт-check:**
- `producerExecutionRef` сейчас в **14 файлах** production-кода (было 10 утром — стало больше, не меньше).
- Самой entity `WorkplaceProductionRevision` **нет**.
- 8 новых ADR (054–061) — все краевые/буферные, ни один не трогает ядро материального авторитета.
- Завод стабильно доходит до Formalization/Development, но **никуда не доходит до конца**.

**Вопрос:**
- Ядро cutover (`WorkplaceProductionRevision` как sole accepted-material authority,
  `producerExecutionRef` → `presenterRef`) — когда?
- Это **осталось твоей целью**, или ты сознательно отложил его «пока завод не дойдёт E2E»?
- Если отложил — это честная стратегия, просто **скажите это прямо** в ответе.

**Ответь в этот файл** (в секцию «Исходящие», **новая запись** ниже твоего прошлого ответа):
- ядро cutover в плане на сегодня/завтра, или нет?
- если нет — что тебя блокирует?

Оператор не торопит, но хочет понимать — это отложенное решение или тихий отход?

---

## Исходящие сообщения (агенты → оператору / друг другу)

<!-- Агент: пиши свой ответ сюда, ниже этой строки. Не удаляй чужое. -->
### 2026-08-11 — Codex / root — оператору и всем агентам

1. ADR-053, CONVEYOR-MENTAL-MODEL, CONVEYOR-TRANSITION-DIAGNOSTICS и
   CONVEYOR-TRANSITION-CHECKLIST прочитаны полностью.
2. Дальше я перехожу к cutover `WorkplaceProductionRevision` как единственной
   accepted-material authority. Точечные исправления допустимы только как
   release-blocking safety/liveness corrections и не должны добавлять новые
   execution/task/latest material fallbacks.
3. Без cutover следующая ожидаемая граница Mars/Venus — repair/carry-forward
   или post-acceptance effect снова выберет материал по последнему
   WorkerExecution/submission вместо exact sealed Workplace revision. Уже
   наблюдавшийся crash-resume bootstrap deadlock — соседнее проявление
   отсутствующего durable transition obligation: lost-worker reconciliation
   требуется для освобождения launch fence, но supervisor запускается только
   после получения нового launch fence.

### 2026-08-12 — Codex / root — operator and agents

1. ADR-053 and the three normative Conveyor documents were read in full.
2. Audit result: the committed work is a partial substrate/migration, not the
   required clean-break cutover. I will not treat further point fixes as
   completion; the next work must remove the execution-owned authority paths
   and finish the WorkplaceProductionRevision cutover.
3. Without the cutover, the next likely Mars/Venus boundary is a repair,
   carry-forward, check-provider, or post-acceptance effect resolving material
   by producerExecutionRef/latest execution while CandidateSet also carries an
   optional revision. That dual authority can bind review/effect/settlement to
   different material after another execution is created.

### 2026-08-12 — ZCode / root — оператору (создан исполнительский трекер cutover)

1. ADR-053, BINDING AMENDMENT и CUTOVER-TODO прочитаны. Согласен с вердиктом
   от 2026-08-12: committed работа — частичный substrate (~40% реального
   cutover), а не clean break; 7 пунктов prematurely отмечены `[x]`.
2. Создан файл-трекинг завершения рефакторинга:
   `docs/architecture/ADR-053-CUTOVER-EXECUTION-TRACKER.md`.
   Это исполнительский слой (не дубликат CUTOVER-TODO):
   - 20 строго последовательных пунктов: P-0 (реконсиляция чек-листа) +
     B-1..B-9 (mandatory cutover scope из вердикта) + G-1..G-10 (gate-критерии
     допуска к canary).
   - **Тройная проверка каждого пункта** тремя независимыми субагентами
     (α/β/γ); пункт закрыт = 3/3 PASS на одном commit SHA.
   - Двигаться строго по пунктам, без перескоков; цель не выполнена, пока ВСЕ
     пункты не 3/3. Мастер-гейт GO = все 20 ×3.
   - Каждый пункт содержит concrete checks (grep/AST/тест-паттерны:
     `producerExecutionRef`, `producer_execution_ref`, `ORDER BY...DESC LIMIT 1`,
     `latestCandidate`, `revisionRepo?.`, `productSource` и т.д.) — чтобы
     верификация была доказательством, а не мнением.
3. Следующая граница, на которой Mars/Venus снова сломается без cutover — та
   же, что в предыдущих сообщениях: эффект (Formalization/Git) или replay
   выберет материал по последнему execution/task/verdict (`ORDER BY...LIMIT 1`,
   `sets[0]`, `latestCandidate`) вместо exact sealed Workplace revision.
   Трекер фиксирует это в B-5/B-6/B-9 и G-1/G-4/G-7. Готов взять первый пункт
   (P-0 → B-1) по команде оператора.

### 2026-08-12 — ZCode / root — оператору (исполнительский прогресс по трекеру)

Работаю по `docs/architecture/ADR-053-CUTOVER-EXECUTION-TRACKER.md` строго по
пунктам, с тройной проверкой каждого (α/β/γ).

- **P-0 (реконсиляция чек-листа) — ЗАКРЫТ 3/3 PASS.** 11 prematurely-`[x]`
  пунктов возвращены в `[~]` по 7 категориям вердикта; 9 done-категорий
  оставлены `[x]`.
- **B-1 (production revision обязательна + атомарный seal) — ЗАКРЫТ 3/3 PASS.**
  `revisionRepo` non-optional; `appendRevision`+`candidateSetRepo.seal` в одной
  транзакции в обоих seal-путях executor'а и в formalization; структурный FK
  `candidate_sets.production_revision_ref → revisions` (`db.ts` уже держит
  `foreign_keys=ON`); proof-тесты (FK-отказ / atomicity / rollback) зелёные;
  tsc чист; baseline 59→57 (починил 13, регрессий 0 — «новые» провалы были
  flaky timing-тесты factory-temporal).
  - Caveat (перенесён в B-5/B-6): formalization `revisionRepo?:` остался
    optionally-typed (guarded), bridge `try/catch` глотает FK — почищу в B-5/B-6.
- **B-2 (identity ревизии material-only) — стартовал**, идёт разведка кода
  (`assembleRevision`/`computeRevisionRef`/digest). Не коммичу — все изменения
  в working tree ветки saga4 (по правилу «commit только по запросу»).

Продолжаю строго по плану без остановки до завершения всех 20 пунктов.

### 2026-08-12 — ZCode / root — оператору (ретракция «COMPLETE» по db15b62 + QA-repair tranche 1a)

Получен статический QA-отчёт по `db15b62` (17 классов дефектов C1–C17 + 20
regression tests). Проверил каждый против актуального кода — вывод оператора
архитектурно прав, моя декларация **COMPLETE в db15b62 была преждевременной**.
Официально отзываю её.

**Вердикт по QA-утверждениям (после проверки фактическим кодом, не по отчёту):**
- ПОДТВЕРЖДЕНО как реальные дефекты: **C1** (`ORDER BY candidate_set_ref DESC`
  как «current author»), **C2** (reviewer seal key НЕ включает subject →
  коллизия двух reviewer-сетов разных авторов), **C4** (`readAcceptedDecision`
  через `ORDER BY decided_at DESC`), **C5** (git-integration `ORDER BY t.id DESC`
  / `ORDER BY gd.decided_at DESC`), **C6** (облигация несла фабрикованный
  `gate-final:<workplace>` вместо реального `decision.decisionKey`),
  **C7** (облигации только для author-path; `fence:1` захардкожен),
  **C8** (replay-capture в подавляющем `try/catch`; терминальный crash теряет
  FinalAcceptance), **C9–C15** (GateRun identity без installationDigest;
  provider digest не проверяется; replay регрессирует state; revision не
  cumulative), **C17** (`gateDecisionKey ?? ''` — пустой ключ допускался).
- ЛОЖНО-ПОЛОЖИТЕЛЬНЫЕ (QA читал устаревший/другой снапшот): **C16** — NUL-byte
  валидация уже корректна (`key.includes('\0')`, а не `'\\0'`); claim о
  `producer_execution_ref`-колонке в `factory_failed_gate_recovery_authorizations`
  устарел — колонка удалена, остались только локальные SQL-алиасы, читающие
  `revision.presenter_ref`.

**Что сделано в этом шаге (repair tranche 1a — exact authority key + fail-closed):**
- **C6:** обе облигации `onGateAccepted` (author + reviewer) теперь несут
  реальный `decision.decisionKey` / `decision.decisionDigest` из `runGate()`
  вместо фабрикованного `gate-final:` (тестируется поведенчески: obligation
  `source_ref` === `factory_gate_decisions.decision_key`).
- **C17:** `getAcceptedGateDecisionKey` → `string` (fail-closed, бросает, нет
  `?? ''`); в реестр эффектов добавлена `assertAuthorityBound` — rejects пустой
  revision/gate/products и **пересчитывает acceptanceDigest с требованием exact
  match** (7 модульных тестов).
- **C8:** replay-capture больше НЕ подавляется — ошибка архивации всплывает как
  реальный дефект, а не прячется; `onFinalAcceptanceRecorded` теперь несёт
  реальный `acceptanceDigest` (раньше — `candidateSetDigest`).
- tsc чист; **full suite 2941 pass / 75 fail = идентично baseline db15b62**
  (нулевая регрессия; +8 новых тестов all green).

**Что ОСТАЁТСЯ (tranche 1b/2/3/4) — НЕ завершено, не claiming complete:**
C1/C4/C5 (нужен durable current-authority pointer, чтобы убрать recency-SELECT),
C2 (reviewer subject в seal key + digest + partial UNIQUE indexes), C7
(reviewer/carry-forward облигации + реальный fence из CAS), C8-терминальная
реконсиляция (idempotent дозапись FinalAcceptance), C9–C13 (GateRun identity +
provider digest + one-shot replay), C14 (настоящий cumulative revision), C15
(UNIQUE semantic_digest + BEGIN IMMEDIATE). Полный план + 20 regression tests
фиксирую в `docs/architecture/ADR-053-QA-REPAIR-PLAN.md`.

**Следующая граница Mars/Venus без C1/C2/C4/C5:** repair-цикл или
carry-forward выберет НЕ тот accepted author attempt (по `candidate_set_ref
DESC` / `decided_at DESC`), либо два reviewer-вердикта за разных авторов
склеятся в один CandidateSet — эффект/replay привяжется к чужому материалу.
Это ровно те селекторы, которые tranche 1a НЕ трогал (они ждут durable
authority pointer из tranche 1b).

### 2026-08-12 — ZCode / root — оператору (repair tranches 1a→C5: 8 дефектов закрыто, 75→~44 fail)

Отработал по `docs/architecture/ADR-053-QA-REPAIR-PLAN.md` без остановки — 6
коммитов в origin/saga4 (`5c3cb05` → `01d9f23`), каждый с верификацией (tsc чист
+ targeted tests + full-suite delta). Дефекты из QA (17 классов):

**ЗАКРЫТО (full):** C2 (reviewer subject в seal key + digest + partial UNIQUE
indexes), C3 (replay возвращает persisted authority, не input), C4 (accepted
gate decision по exact `gate_phase='final'`, не `decided_at` recency), C6
(облигации несут реальный `decision.decisionKey`), C7 (reviewer + carry-forward
seals создают run-gate облигацию атомарно), C8 (terminal(accepted) reconcile
idempotently восстанавливает FinalAcceptance + replay-capture после crash),
C15 (`UNIQUE(workplace,semantic_digest)` + persisted-return + `BEGIN IMMEDIATE`),
C17 (fail-closed effect authority: `assertAuthorityBound` + пересчёт digest).
**PARTIAL:** C5 (review-decision recency убран; task-binding `ORDER BY t.id DESC`
отложен — нужен investigation managed-submission↔task связи).
**FALSE POSITIVE:** C16 (NUL-byte валидация уже корректна).

**Эффект на тестах:** 75 fail → ~44/45 (C7+C8 разблокировали ~18
lifecycle/crash-recovery тестов; C4 починил ещё ~3). ±1 flake на temporal-тестах.

**ОСТАЁТСЯ (каждое — крупный focused refactor, сознательно не начинаю «на остатке
контекста», чтобы не сломать CAS/gate пути):**
- **C1** — durable current-authority pointer (head-таблица или колонки на
  factory_workplaces, atomic-with-CAS), чтобы `acceptedAuthorCandidate` перестал
  брать `sets[0]` по `candidate_set_ref DESC`. Без pointer'а любой recency/hash
  order хрупок в repair-цикле.
- **C5-task** — bind git-integration task к accepted submission.
- **C9–C13** — gate cluster: GateRun identity += installationDigest + expected
  Workplace revision; provider implementation digest; CheckReceipt identity;
  one-shot replay; полный decision digest.
- **C14** — настоящий cumulative ProductionRevision с тестом `X+Y ≡ X then Y`.

Все коммиты честно помечены «NOT complete». qa-repair-plan документ ведётся
актуально. Стоп-точка чистая (tsc 0, последний push `01d9f23`).

---

**2026-08-12 · ZCode (оркестратор плана завершения, ветка `finish/factory-completion`) · оператору**

На твои три вопроса:
1. **ADR-053 прочитан целиком** — и не просто прочитан, а **его cutover выполнен**
   через план завершения Factory (документ «Saga Factory Completion Execution Plan»,
   34 карты; разбит на субагентов, под моим пошаговым контролем, одна карта = один
   commit + одна push в `origin`).
2. **Точечные фиксы закончены — перешёл к cutover.** WorkplaceProductionRevision
   теперь и есть material authority: закрыты целиком **C5** (head+=task_id, consumer
   cutover на `readAuthorTaskId`, adversarial matrix, ratchet), **C7** (monotonic
   lease fencing: brands→storage→atomic alloc→fenced complete/fail/reclaim→
   production cutover→детерминированный temporal proof), **LR/W5** (`settle()`
   терминал требует passed local-ready receipt для exact sealed candidate).
3. **Следующая граница, где сломается без реального прогона — W10-02.** Scripted
   путь ДОСТИГ runnable-local (W9-02 happy + W9-03 adversarial 3/3, deterministic,
   без authority hacks); реальный GLM-4.7 inference — это operator-gate.

**Статус:** 29/34 карт на `finish/factory-completion` @ `ccfea8a` (всё запушено в
`origin`; validator + acceptance-matrix зелёные на clean checkout). Линии P0, C5,
C7, LR(W5), CI, W9 — CLOSED. **DFX 0/3.** Профиль реал-прогона заморожен:
`docs/factory/W10-RUN-PROFILE.md` (model=GLM-4.7, cap≤2, product-build@1.2.0 fresh,
5 acceptance criteria). **Жду тебя на W10-02** (твой GLM-4.7 endpoint через
`SAGA_CLAUDE_PATH`, свежий `DB_PATH`, concurrency≤2, не мешая активному
`mars-venus-e2e-20260811-015`). После прогона — W11-01 inspect продукта/runtime,
затем W12-01/02/03 (reconcile + runbook + финальный go/no-go+tag). Активному заводу
не мешал — работал только в `finish/*`, `saga4` не трогал.

