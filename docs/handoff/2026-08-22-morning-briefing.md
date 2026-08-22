# Morning briefing — night shift 2026-08-21/22

Оператор просил к утру: Elite-3 (с фронтом), новые тесты на все 4 цеха,
рефакторинг-состояние, слитие в saga4. Всё выполнено; ниже — суть и цифры
(все зелёные — реальные прогоны, ничего не сфабриковано).

## 1. Elite-3: типизированный терминал `failed` на планере — честный исход

- Discovery `go` → Formalization **formalized** (первый ночной прогон, прошедший
  формализацию) → Development **12/13 карточек** → 13-я (планер
  `development-plan-task-graph`) исчерпала бюджет → **терминал `failed`
  в 00:09:09Z**. Движок завершился сам; никаких зависших процессов.
- Корневая цепочка (логи воркеров сохранены в
  `docs/factory-run/stage20-elite/task13-evidence/`):
  1. 9 gate-отказов за 3 эпохи: сначала замкнутость/ацикличность графа, потом
     парные «items overlap without a dependency order» — фидбек конкретный,
     но glm-4.6 не удовлетворил валидатор за 9 попыток.
  2. Далее промпт распух до **436 283 байт** (накопленный rejection-фидбек) —
     opencode/Z.AI API отказывал pre-tool (8 ретраев на спавн, все
     `pre-tool-death`, ~3 мин на спавн) → 3 lost-экзекуции, каждая
     переспавнена супервизией.
  3. Бюджет закрыл ран типизированно. §15/ADR-075 сработали как задумано.
- **Диагноз уточнён оператором утром 2026-08-22 (ниже) — первоначальные
  формулировки агента частично неверны. Авторитетная версия:**
  - **F-A (подтверждён, глубже):** дефект не «накопление gate-фидбека», а
    ОТСУТСТВИЕ prompt budget при нескольких ПЕРЕКРЫВАЮЩИХСЯ каналах
    исторической информации: protocol skill + semantic skill + current
    recovery feedback + prior deaths + previous_failures (до 20×2000 chars)
    + attempt_history (до 50×2000 chars) + recovery memory — и весь
    `JSON.stringify(task)` целиком, чей metadata уже несёт те же слои.
  - **F-B (ДИАГНОЗ АГЕНТА НЕВЕРЕН — отозван):** правило overlap-ordering
    УЖЕ преподавалось в planner skill на коммите Elite-3
    (skills/saga-planner/SKILL.md:34 «overlapping scopes require a dependency
    path», :40 «On a repair attempt, rebuild the pairwise overlap matrix»;
    чеклист — то же). «Прописать правило в промпт» продублировало бы
    существующий текст. Правильный фикс: фабрика сама детерминированно
    вычисляет unordered-overlap set / repair delta и даёт планеру готовый
    список конфликтующих пар, вместо ожидания ручного графового анализа
    десятков scopes у LLM.
  - **F-C (ПРОПУЩЕН агентом):** provider adapter ретраит ОКОНЧАТЕЛЬНЫЙ
    отказ. API отвечал `400 / "Prompt exceeds max length" / isRetryable:
    false`, но classifyFailure() в claude-shim любой pre-tool exit делает
    retryable → полная лестница 1s..64s ×8 на каждый спавн (~3 мин),
    затем new WorkerExecution с тем же 436KB промптом — цикл сжигал recovery
    budget инфраструктурой. Должно быть: 400 non-retryable → fail-fast →
    typed diagnosis → factory recovery.
  - «Завод отработал образцово» — ПРЕУВЕЛИЧЕНО: safety/recovery сработали
    (нет вечных зависаний, typed terminal), но prevention (prompt budget) и
    retry classification (F-C) провалились.
- ~~Первоначальные (частично неверные) формулировки F-A/F-B агента:~~
  F-A «обрезать gate feedback» — слишком мелко; F-B «правило не преподаётся» —
  опровергнуто кодом. Зафиксировано для истории триажа.

## 2. Тестовый движок: все 4 цеха зелёные

| Цех | Прогон | Результат |
|---|---|---|
| Discovery | coverage drive | **27/27** |
| Formalization | coverage drive | **26/26** |
| Development | happy-verified spine | **PASS** (9/9 оракулов, терминал verified) |
| Delivery | happy-released-authorized spine | **PASS** (5/5 оракулов, терминал released, публикация в реальном леджере) |

Движок — это scenario packs (декларативные сценарии + независимые оракулы,
читающие только авторитетные таблицы) через НАСТОЯЩИЙ прод-фабрик.

## 3. Главные находки ночи: движок поймал реальный прод-дефект

Каждый красный верифицирован 2–3 прогонами + исследовательскими сабагентами
(«кто виноват — тест или код?»). Итоги триажа:

1. **Delivery spine red → харнесс виноват** (дважды): провайдеры сидались с
   автоинкрементными id, а дубли пинили 9001/9002 → resolveTrustedProvider
   честно фейл-закрывался «untrusted». Оракул читал легаси-таблицу вместо
   реального delivery-леджера. Прод не тронут; фиксы тестовые (aec34b18).
2. **Restart-proof'ы red → пруф-дизайн**: stage-boundary пруфы должны
   закрывать ран между стартами продакшн-`abandonLifecycleRun` (scope-guard
   прав). «Естественный терминал» для них недостижим — lifecycle уходит в
   следующий цех без акторов.
3. **РЕАЛЬНЫЙ ПРОД-ДЕФЕКТ (Type C), найден §15-серией**: контракт
   review-verdict'а ТРЕБУЕТ `subject_candidate_set_ref` (ref с номером
   workplace), а захват капсулы не видел его в input-биндингах → каждый
   кросс-lifecycle приём семантически идентичного материала сажал
   РАСХОДЯЩУЮСЯ капсулу под один семантический ключ → §15 честно фейл-закрыл
   следующий claim (REPLAY_KEY_PAYLOAD_CONFLICT). Фикс (2fee5c6e): захват
   шаблонизирует subject-ref (синтетический `$.subject_candidate_set_ref`
   биндинг, разрешается на реплее против текущего subject'а), конфликт
   сравнивает СЕМАНТИЧЕСКУЮ проекцию payload, `prefix:counter`-хэндлы —
   identity-candidates. Угроза реальному заводу: только мульти-lifecycle
   рестарты одного проекта (пруфы, abandon+restart), НЕ одиночные Elite-раны.
4. **Фикстурная честность (ADR-079)**: W9-хендлеры писали статический
   контент (proposal, PRD/UC/AC/SRS) — байт-равный материал = легальный
   replay, «несовместимый» вход обязан расходиться контентом. Теперь всё
   производно от digest'а proposal.

## 4. Полный сьют: 4303 теста, 4270 pass, 0 fail (33 skipped)

10 красных, найденных финальным прогоном, починены точечно:
- 4 устаревших роутинг-теста не знали о терминальности discovery `failed`
  (сознательный дневной фикс 9d37a9e1) — тесты закрепили новый контракт.
- K7×2: дневные селекторы 9d37a9e1 классифицированы в решётке (repair-desk
  frontier + logical-key revision tiebreak — рекенсия не выбирает материал).
- K8/K9×3: фикстуры конфликта теперь расходятся семантически (raw-hash
  расходимость = легальный алиас после 2fee5c6e).
- CF2: ленивая схема managed-submissions в минимальном мире теста.
- E1: пины строк пере-выведены (модуль формализации вырос на 14 строк).

## 5. Merge и рефакторинг

- **w0-waves → saga4 слит (d7d23d72), без конфликтов.** Все 88+ ночных
  коммитов + все дневные коммиты удалённого агента (включая docs-graph
  frontend) сохранены. Пост-мердж сьют на saga4: **4303 теста, 4272 pass,
  0 fail**. Обе ветки запушены.
- Ночью на удалёнку w0-waves приехали ЕЩЁ 10 коммитов удалённого агента
  (workshop-designer — визуальный редактор воркшопов, новый каталог
  `workshop-designer/`). Они влиты в w0-waves (4c1cc059) и затем в saga4
  (9c55210c) — ничего не потеряно; финальный контрольный сьют запущен.
- **НЕ закоммичено (намеренно):** несмёрженный диф удалённого агента
  в `src/modules/discovery/application/discovery-production-cell-installation.ts`
  (worktree w0-waves) — оставлен как был, помечен: владелец должен решить.
  В основном чекауте также лежит несмёрженная правка `DRAGON-MAP.md`
  (+61/−15) — не наша, не тронута.
- Рефакторинг (два гайда): ночно-безопасные фазы 1–3 выполнены ранее (R0
  инвентарь+baseline, R1 дескриптор, gate-green). R2–R10 отложены
  квалификационным гейтом самих планов — теперь гейт ЗЕЛЁНЫЙ, поездка может
  начинаться днём.
- Watchdog-автомат (20 мин) оставлен; в трекере стоит ⛔-guard: ран терминален,
  НЕ перезапускать — ночью батч владел машиной.

## 6. Work order перед Elite-4 (замена первоначальных рекомендаций)

1. **F-A — Prompt Budget (системно):** per-layer бюджеты (protocol /
   semantic skill / current RecoveryIssue / historical summary / task
   projection). История остаётся durable полностью (feedback-history.json,
   attempt-history, DB), но в промпт попадают только: текущая точная
   проблема + ограниченное summary + path/digest/count полной истории.
   Обязательно логировать состав промпта: totalBytes, protocolBytes,
   semanticSkillBytes, taskProjectionBytes, currentFeedbackBytes,
   historySummaryBytes, priorDeathsBytes.
2. **F-B — Planner Assistance:** НЕ дублировать правило в промпте; фабрика
   детерминированно вычисляет unordered-overlap set / repair delta и
   передаёт планеру готовый список конфликтующих пар.
3. **F-C — Non-retryable provider failures:** HTTP 400 / «Prompt exceeds
   max length» / isRetryable:false → fail-fast без retry-лестницы →
   typed diagnosis → factory recovery.
4. Далее: coverage-драйвы Dev/Delivery до полных вселенных, R2–R10.

## Watchdog addendum (03:1xZ cycle)

Night plan COMPLETE and verified this cycle: Elite-3 terminal (failed@planner,
00:09:09Z — evidence in task13-evidence/, no restart per the tracker guard);
4-workshop engine green (discovery 27/27, formalization 26/26, development
spine 9/9, delivery spine 5/5); full suite 4303 tests / 4272 pass / 0 fail on
BOTH w0-waves and saga4 (run twice post-merge); w0-waves and saga4 merged and
pushed (saga4 a0a88e4a, w0-waves 4c1cc059 — including the late-arriving 10
remote workshop-designer commits; 0 unpushed commits on either branch);
tripwire 2d6176e8 unchanged; the remote agent's uncommitted discovery diff
preserved untouched. No action for the next watchdog cycles beyond liveness
of this state — the morning briefing above owns the narrative.

- 03:3xZ cycle: state unchanged and verified — tripwire intact, 0 unpushed
  commits on both branches, 0 new remote commits, worktree clean except the
  preserved foreign discovery diff, Elite-3 terminal (no restart). Plan
  remains complete; next cycles are liveness-only.
- 03:5xZ cycle: unchanged — tripwire intact, 0/0 unpushed, 0/0 new remote,
  foreign diff preserved, Elite-3 terminal. Liveness-only.
- 04:1xZ cycle: unchanged — tripwire intact, 0/0 unpushed, 0/0 new remote,
  foreign diff preserved, Elite-3 terminal. Liveness-only.
- 04:3xZ cycle: unchanged — tripwire intact, 0/0 unpushed, 0/0 new remote,
  foreign diff preserved, Elite-3 terminal. Liveness-only.
- 04:5xZ cycle: unchanged — tripwire intact, 0/0 unpushed, 0/0 new remote,
  foreign diff preserved, Elite-3 terminal. Liveness-only.
- 05:1xZ cycle: unchanged — tripwire intact, 0/0 unpushed, 0/0 new remote,
  foreign diff preserved, Elite-3 terminal. Liveness-only.
