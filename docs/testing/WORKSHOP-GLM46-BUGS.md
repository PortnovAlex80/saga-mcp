# Баг-реестр GLM-46 кампании — ЕДИНЫЙ ФАЙЛ БАГОВ

> **Модель прогона: `glm-4.6` (провайдер zai, effort high, параллелизм 1).**
> 21 проект P01–P21 (docs/testing/projects.json), каскад W1→W2→W3,
> пространство `.factory-testbed-glm46/`, фронт `http://localhost:4323`.
> Дата старта: 2026-08-15 (ночной прогон, оператор спит).

Все баги этой кампании фиксируются ТОЛЬКО здесь: один файл — один материал.
Каждый entry: ID, PID, цех, категория, серьёзность (S1/S2/S3), симптом с точной
строкой лога/кода, гипотеза, статус. Если симптом совпадает с известным багом
qwen-кампании (WORKSHOP-BUGS.md, KI-*/TB-*) — помечать `регрессия TB-x`
и фиксить по его плану, затем перезапускать цех/проект.

## Найденные в этой кампании

| ID | PID | Цех | Кат | S | Симптом (точная строка лога/артефакт) | Гипотеза | Статус |
|---|---|---|---|---|---|---|---|
| GB-1 | P01–P05 | W1 | engine | Все 5 первых проектов: lifecycle terminal failed `LIFECYCLE_RESULT_SNAPSHOT_MISMATCH` при 2/2 задач done, все воркеры exit 0, артефакты accepted | **Доказано (код)**: wave-2/TB-8 (8b66b6c2) добавил в общий `processRunResultSnapshot` 11-й ключ `error`, но repo-сторона `expectedResultSnapshot` (sqlite-lifecycle-run-repository.ts:915) пересобирала только 10 старых ключей → хэши NEVER match на реальном lifecycle-orchestrator пути. Golden-path не ловил: scripted-путь (scenario-runner) имел собственный 10-ключевой билдер | **fixed**: (1) repo-сторона читает `error` и включает в expected-снапшот; (2) scenario-runner переведён на ЕДИНЫЙ `processRunResultSnapshot` (один канонический билдер — архитектурно правильно, не затычка); тест-литерал обновлён. Валидация: P06–P12 PASS W1 живыми прогонами; 24/24 юнит-тестов репо+сценарийника |
| GB-2 | P13–P21 | W1 | process/ops | 9 проектов FAIL за 0.1с `dist/schema.js` import error | `npm run build` (rmSync dist → tsc ~80с) запущен, пока очередь провижинила проекты: harness-спавны бьют в отсутствующий dist. Операционная дисциплина, не код движка | **mitigated (правило)**: НЕ ребилдить dist при живой очереди; перед build — остановить очередь, после — перезапустить с места смерти (--attach). Убитые проекты добирутся re-run'ом |
| GB-3 | golden-path | W2 (scripted) | engine | S2 (только scripted-harness; живой путь W1 21/21 прошёл) | **Слоёный дефект, 4 слоя, все сверены с CONVEYOR-MENTAL-MODEL.** (a) TOCTOU в `releaseExecutionAtomically`: статус задачи читался вне транзакции, `presentation_close` (ADR-072) коммитил `done` в зазоре, `clearTaskFence` перетирал устаревшим `review_in_progress` → воскрешение завершённой задачи. (b) Живой scripted-воркер помечен `lost` (строки: reserved, heartbeat=reserved_at, лиз 5 мин, RELEASE(lost) на экспирации) → следующий write заблокирован `MANAGED_PRODUCTION_FENCE_VIOLATION` → FATAL. (c) Карточка ушла в небюджетный repair-рекью-цикл: **68 исполнений одной задачи** без срабатывания retry-budget (бюджет считает только lost/spawn_failed/terminated, не «clean-exit-but-reopened»). (d) Тестовый сценарий acceptance-ячейки использует легаси-протокол (artifact_create + worker_done) там, где модель требует типизированный product_submit («worker_done is not proof that production exists»); движок fail-closed ПРАВ, сценарий отстал от managed-production cutover | Норма модели: «host status is observation only» / «within its declared cycle budget» / «Runtime owns heartbeat and supervision». Фикс-направления: (a) **fixed** — перечит статуса под write-lock (идеологически верен, юнит-тесты 10/10); (b) liveness по durable-свидетельству, а не только лизу; (c) бюджет на reopen-цикл → typed wait; (d) обновить golden-path сценарии на product_submit-протокол | **open**: (b)(c)(d) — план согласован с оператором: без точечных фиксов, сверять каждый слой с моделью; живая кампания (реальные воркеры, product_submit) не блокируется |
| GB-4 | P01 (все 21) | W2 | engine/protocol | S1 | **Двухслойный.** Слой 1: у авторов формализации не было `product_submit` (COMMON_WRITE_TOOLS — легаси) → ingress-mode `managed-workplace` → acceptance-воркер делал ПОЛНУЮ работу (27 managed-записей артефактов за каждое исполнение — доказано по ledger), но `worker_done` завершения ячейки не давал → небюджетный рекью-цикл 15-16 исполнений. Слой 2 (моё вмешательство): добавление product_submit переключило формализацию в `typed-submission` → вскрылся GB-5. Первоначальная причина слоя 1 (почему managed-completion не закрывал ячейку при непустом ledger) — НЕ доизолирована | Слой 1: кандидат — acceptance-гейт отвергал снапшот/TB-6-класс; требует утренней изоляции. Слой 2 = GB-5 | **open** (инструменты возвращены: product_submit у авторов формализации оставлен; каталог моделей дополнен glm-4.6/limit 3 = GB-6 fixed) |
| GB-5 | P01 (L27) | W2 | architecture | S1 — **блокер W2/W3, требует решения оператора** | `FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_SNAPSHOT`: product-гейт ПРИНЯЛ типизированный бандл воркера (валидатор формализации не проверяет форму), а пост-акцептанс эффект требует factory-снапшот (`factory.workplace-production-snapshot.v3`, camelCase, schemaVersion). Две формы одного продукта = два авторитета. Payload воркера (snake_case, эхо artifact_list) разумен, но не канон | **Два варианта: (A)** строгий контракт сабмита: валидатор бандла на гейте + точная форма в промпте (минус: модель транскрибирует хэши — модель называет это «redundant consistency assertion», хрупко); **(B) рекомендую** — фабрика оборачивает сабмит: на product_submit для бандл-схем формализации канонический продукт строится из managed-ledger исполнителя (`buildWorkplaceProductionSnapshot`), payload воркера = интент; «Factory computes the canonical digest» (ADR-053/CONVEYOR-MENTAL-MODEL) | **fixed (вариант B, решение оператора 2026-08-16)**: материализатор formalization-snapshot-materializer — product_submit для бандл-схем формализации запечатывает фабричный снапшот из managed-ledger исполнителя (payload воркера = интент; пустой ledger = fail-closed FORMALIZATION_SNAPSHOT_EMPTY с понятной моделью ошибкой и путём починки). Тест 12/12 |
| GB-6 | — | — | engine | S3 | `rerun` отвергал `glm-4.6`: модель отсутствовала в каталоге FACTORY_CLOUD_MODELS (эндпоинт z.ai её отдаёт, план допускает 3 параллельных — оператор верифицировал) | Каталог — не валидатор провайдера | **fixed**: профиль glm-4.6 (zai, effort high, limit 3) добавлен в каталог |
| GB-7 | все 21 | W2 | engine/ops | S1 (операционный) | Mid-flight смена allowedTools отравила все запинованные workplaces формализации: 10 lifecycles terminally failed `PRODUCTION_CELL_PLAN_BINDING_MISMATCH`, 11 paused с тем же биндингом. Класс = «in-flight не переживает смену профиля» (тот же, что с bump версии модуля на rtk-dual) | Пиннинг биндинга по дизайну (fail-closed корректен); пробел — отсутствие миграции in-flight | **mitigated**: recovery-драйвер scripts/testbed-night-rerun.mjs (abandon + rerun на новый профиль, механика проверена: L27 создался и прошёл discovery идемпотентно). Архитектурный пробел — в бэклог |

## Примечания по базовой линии

На старте кампании все известные движковые баги qwen-кампании закрыты в HEAD
(saga4): TB-1..TB-4, TB-6, TB-7, TB-8 (regex AC-кодов), TB-9/TB-10 (RETAIN +
fallback по конверту), TB-12 (completed-handoff). Открытые: KI-2 (галлюцинации
toolset — специфична qwen, для glm-4.6 проверяем отдельно), KI-5 (семантика
WHAT-графа — ожидается в W2+), TB-5 (косметика dist — закрыт clean-шагом build).

## GB-1b (гигиена, не срочно)

Фикс GB-1 оставил в repo ТРЕТЬЮ копию формы снапшота (11-ключевой литерал) — тот же класс дрейфа.
Канонический билдер `processRunResultSnapshot` должен лежать в нейтральном слое
(shared/ или process-modules/domain/) и импортироваться обеими сторонами; зависимость
persistence→application запрещена — потому копия и появилась. Форма зафиксирована тестом.

## Состояние на конец ночи 2026-08-16 ~01:40 UTC

Завод ОСТАНОВЛЕН намеренно (GB-5 — архитектурное решение, не ночной фикс).
W1 Discovery: 21/21 PASS (валидирован на glm-4.6, GB-1-фикс подтверждён живым прогоном).
W2 Formalization: заблокирован GB-5; все lifecycles отравлены GB-7 → обновляются
night-rerun драйвером ПОСЛЕ решения GB-5. Снапшоты: W1-round-start, post-w1-partial-2057,
pre-restart-2100, pre-gb4-renewal-2220.
Утренние решения для оператора: (1) GB-5 вариант A или B (рекомендую B);
(2) изолировать первоначальную причину GB-4-цикла в managed-workplace режиме;
(3) GB-3b/c (liveness по durable-свидетельству + бюджет reopen-циклов) — по плану из qwen-реестра.

## GB-8 — acceptance-ячейка: вечный repair из-за версии валидатора в квитанции (fixed)

**Симптом:** каждый сабмит acceptance-бандла проходил (GB-5/B-снапшот запечатан канонически),
но чек `submission-validator.formalization.acceptance-contract.v1` выдавал
`SUBMISSION_VALIDATION_RECEIPT_REQUIRED` → гейт `repair_required` → авторская карточка
переоткрывалась (у P01 — 5 исполнений, до исчерпания repair-бюджета).

**Root cause (доказано по БД+код):** `acceptWithReceipt` в acceptance-contract-validator.ts
писал в квитанцию захардкоженный `validatorVersion: '1.0.0'`, тогда как валидатор, его
rejection'и и check-plan корректно объявляют `ACCEPTANCE_CONTRACT_VALIDATOR_VERSION`='1.1.0'
(bump TB-8). Чек сравнивает версии → детерминированный mismatch на каждом сабмите.
Квитанции id 25-29 в живой БД несут 1.0.0 при rejection'ах 1.1.0 — прямое доказательство.

**Фикс:** `validatorVersion: ACCEPTANCE_CONTRACT_VALIDATOR_VERSION` (константа, не строка).
Свип по остальным модулям — других захардкоженных версий нет. **fixed**.

## GB-9 — Development: workplace уходит в explicit-pause ПОСЛЕ accepted-гейта (open, жду вторую выборку)

**Симптом (P02, L29, карточка #109 development.code):** 3 исполнения; история гейта
repair_required → repair_required → **accepted**; git-эффект для этой карточки НЕ создан
(единственный эффект-action в БД — другая карточка, succeeded); workplace → loop_state=paused
(«requires explicit resume»), движок штатно остановился, драйвер ушёл на P03. Карточки
#105-116 (9 шт.) остались todo/review.

**Гипотезы:** (а) recovery-budget pause сработал по счётчику repair-попыток в момент,
когда финальный accept уже был durable (гонка бюджета и вердикта); (б) пост-акцептанс
обязательство (run-effects) не создалось/не клеймилось и workplace спроецировался в pause.
**План:** дождаться повтора на P03/P04 (development дойдёт через ~30-40 мин/проект),
диффить две выборки; затем изолировать по obligations/production_envelope карточки.
**Статус:** open. Recovery-путь: factory.mjs continue (explicit resume) — проверю на P02
финальным проходом, если движок не разберётся сам.

## GB-10 — REPLAY_CAPTURE_TRACE_NOT_FOUND на завершении формализации (open)

**Симптом (P04 themes, L31, 01:07):** lifecycle terminally failed
`REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 1, resolved 0` при завершении формализации
(этап дошел до конца, упало на replay-capture сinchронизации капсулы).

**Проверено (не источник):** все trace_ids квитанций валидации (receipts 43/44) живы;
все 18 managed-trace productions эпика живы в artifact_traces.

**Гипотеза:** набор traceIds капсулы берётся из snapshot ячейки (workplace production
snapshot traces[]) и ссылается на трейс, созданный в ОТРАВЛЕННОМ lifecycle до abandon
(каскад abandon удалил трейс, snapshot обновления — путь: acceptance/srs ячейка трейсится
к артефакту прошлого цикла). Проверить: сравнить traceIds последней запечатанной
ревизии L31 против artifact_traces с учётом времени abandon.
**Статус:** open — если повторится на P05+, поднять приоритет и доделать изоляцию.
