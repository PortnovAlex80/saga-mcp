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
| GB-1b | — | — | architecture | S3 (гигиена) | Фикс GB-1 оставил в repo ТРЕТЬЮ копию формы снапшота (11-ключевой литерал) — тот же класс дрейфа, что породил GB-1 | Канонический билдер `processRunResultSnapshot` должен лежать в нейтральном слое (shared/ или process-modules/domain/) и импортироваться ОБОИМИ: application и persistence. Зависимость persistence→application запрещена — потому и появилась копия | **open** (следующий архитектурный шаг; не срочно — форма зафиксирована тестом) |

## Примечания по базовой линии

На старте кампании все известные движковые баги qwen-кампании закрыты в HEAD
(saga4): TB-1..TB-4, TB-6, TB-7, TB-8 (regex AC-кодов), TB-9/TB-10 (RETAIN +
fallback по конверту), TB-12 (completed-handoff). Открытые: KI-2 (галлюцинации
toolset — специфична qwen, для glm-4.6 проверяем отдельно), KI-5 (семантика
WHAT-графа — ожидается в W2+), TB-5 (косметика dist — закрыт clean-шагом build).
