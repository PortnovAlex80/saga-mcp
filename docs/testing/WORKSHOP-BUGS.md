# Баг-реестр по-цехового тестирования

Серьёзность: **S1** блокирующий (прогон умер/данные потеряны) · **S2** деградация
(repair-циклы, потеря времени, артефакт с дефектом принят) · **S3** косметика/доки.
Категории: `engine` (движок/supervision) · `protocol` (воркер/MCP/сабмиты) ·
`quality` (семантика артефактов) · `env` (LM Studio/шаблоны/клиент) · `docs`.

## Известные на старте (базовая линия, из mars-ballistic 2026-08-13)

| ID | Кат | S | Симптом | Гипотеза | Статус |
|---|---|---|---|---|---|
| KI-1 | engine | S1 | Движок 100% CPU, лог замер (polls=200), supervision молчит; воркер в отдельном процессе продолжает работать | бесконечный синхронный цикл в event loop (кандидат: гейт-код на данных use-cases); точный стек не снят — процесс убит | open; harness: watchdog 3 мин → авто-рестарт |
| KI-2 | protocol | S2 | Воркер утверждает «нет Write tool» при наличии; тратит ходы на реверс-инжиниринг | галлюцинация toolset у qwen 3.6-35b | open; метрика лишних ходов в W1 |
| KI-3 | engine | S2 | Первый claim нового заказа замораживается на облачном профиле до флипа модели | старт пишет cloud-профиль и сразу спавнит движок | mitigated by design: harness пишет `lmstudio/qwen/limit 1` в control-строку ДО старта lifecycle (WORKSHOP-TEST-PLAN §4.3) — гонка исключена архитектурно |
| KI-4 | env | S1 | LM Studio 500 «Jinja: System message must be at the beginning» — тихо в GUI | GGUF-вшитый шаблон; лечится user-override | closed (патч 2026-08-13; смоук перед каждым раундом) |
| KI-5 | quality | S2 | Семантические швы WHAT-графа пропущены reviewer: вход без потребителя (FR-2 высота орбиты), внутреннее противоречие (FR-4: 180 точек ≠ 361 день) | слабая модель + reviewer-чек-план не ловит межартефактные связи | open; ожидаем подтверждения/опровержения в раунде W2 |

## Найденные в раундах

| ID | PID | Цех | Кат | S | Симптом (точная строка лога/артефакт) | Гипотеза | Статус |
|---|---|---|---|---|---|---|---|
| TB-1 | — | — | env | S3 | `DELETE FROM projects` падает `no such table: main.factory_node_runs` (схема создаёт триггер на таблицу, которой нет) — мешает очистке тестбеда | SCHEMA_SQL неполон относительно своих же триггеров | open |
| TB-2 | P01,P03 | W1 | engine | S1 | **KI-1, 3 воспроизведения**: (1) mars 19:38 use-cases gate; (2) P01 07:17 discovery-proposal; (3) P03 07:40 discovery-proposal — везде: воркер чисто выходит (worker_done accepted), workplace → verifying rev.3 с НЕочищенным active_reservation_ref, движок 100% CPU spin (≈5s/5s), тишина до смерти. **Контр-факты**: тот же workplace после kill+resume обрабатывается штатно (P01 07:28, P03 resume); P02 прошёл идентичный гейт без спина → недетерминизм, race | гонка между наблюдением выхода воркера (ObserveProcessExited/runner close) и синхронным verifying-переходом ядра; подозрение на retry-цикл при неочищенном reservation | open — субагент расследует (передана улика №3); workaround: spin-детект → kill+resume
| TB-3 | — | — | env | S2 | Трекер запущен БЕЗ `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` → каждый его resume-движок умирает на старте `SAGA_PRODUCT_LIFECYCLE_COMPOSITION_REQUIRED` (лог /tmp/saga-engine-3-*.log 07:23) — завод выглядит «на паузе», воркеров нет. ЗАВОД молча не сообщает на доске | трекеровские движки наследуют env трекера; в доках env есть (ЗАВОД-ЗАПУСК §2), но легко упустить. Фикс: полный env у трекера. Предложение: engine-start фейл должен показываться на доске | mitigated (трекер перезапущен с полным env); docs-hardening предложение записано |
| TB-4 | — | — | tooling | S2 | stopEverything/psKill убивал СВОЙ powershell (его CommandLine содержит match-паттерн) → count=0, движки/воркеры выживали, копились сироты и параллельные карточки (нарушение rate=1). Фикс: фильтр Name (node.exe/claude%) в psKill | инструментальный, завода не касается; после фикса — клинап до 0 процессов | fixed |
| TB-5 | — | — | engine | S3 | Мёртвый артефакт сборки: dist/process-modules/application/node-executors/lm-node-executor.js:470 — сырой while(true)-поллинг, никем не импортируется (src мапит lm→production-cell); сбивает диагностику спинов | удалить | open |


| TB-6 | P02 | W2 | engine | S1 | Формализация упала terminal `FORMALIZATION_ACCEPTANCE_HASH_DRIFT: artifact 37` (09:34:58). Артефакт 37 = UC "Start/Pause Timer" (P02): **draft**, создан 09:29:57, **изменён 09:34:16 — между двумя ACCEPTED-гейтами use-cases (09:34:01 и 09:34:50, после REPAIR_REQUIRED 09:32)**. Ремонт-автор редактировал draft в тот же момент, когда reviewer принимал CandidateSet; второй accept прошёл, но замороженный хэш базлайна соответствовал до-редакционной версии → дрифт → fail-closed цеха | гонка repair-edit vs gate-accept vs baseline-freeze на одном workplace; вопрос к архитектуре: почему гейт принял дважды за 49с и чей хэш фризит baseline | open — нужен разбор по логам воркеров task72-75; P02 = первый содержательный ✖ W2; корреляция: у P02 был слабейший proposal партии (18/25, слепой ревью) |
| TB-7 | P04 | W2 | engine | S3 | 25-мин задержка старта W2 у P04: движки падали `FACTORY_LAUNCH_ALREADY_CONTROLLED` (лиз-эпохи до 6), пока трекеровский engine-supervisor переспавнивал их друг против друга; итог — самозакрепление на epoch 6, работа пошла (без ручного вмешательства) | respawn-гонка супервизора против 30с лиз-истечения — шумно, но самолечится; при повторах чаще — кандидат на backoff | mitigated (self-healed); наблюдение |
## Root-cause note TB-2 (субагент-расследование, 2026-08-15)

Механизм доказан контролируемым экспериментом (копия БД во временном каталоге):
коллизия write-lock → нативный busy-spin better-sqlite3 на главном потоке
(busy_timeout=5000; замер 5.5s wall / 16s CPU ≈ 3 ядра; без держателя — 14ms/0s).
Каждый наблюдавшийся CPU-семпл (5.02s/5s, 5.03s/5s, 6.05s/6s) = ровно одно окно
busy_timeout. Пока поток в спине, таймеры ПРОЦЕССА мертвы → если держатель лока —
другое соединение того же процесса с релизом по таймеру, спин ВЕЧНЫЙ (второй
контроль — воспроизведён дедлок).

Окно коллизии (первый verifying-попыт после worker_done): барьст транзакций
MCP-чайлда воркера + markExited по ОТДЕЛЬНОМУ соединению (claude-runner) +
seal/BEGIN IMMEDIATE движка + 10s lease-renewal + 30s supervision + чекпоинт-
соединение. Uncleared active_reservation_ref — симптом (cleared by design
только внутри того же синхронного блока, после seal+gate). Форма данных
исключена (форензика обеих БД). Недетерминизм = живая конкуренция записей
(P02 прошёл идентичный гейт).

Фикс-направление (тикет владельцам): сериализовать записи движка в одно
соединение getDb() (openRuntimeDb-per-call — выбивается); busy_timeout ~250ms
+ явный backoff, чтобы коллизия быстро падала, а не крутила поток.

Лайв-кетч: node --cpu-prof (НЕ флешится при TerminateProcess — только graceful
exit), либо 3 log-брекета: claude-runner finalize enter/exit (~1196/1280),
dispatch-loop poll top (~204), production-cell verify-enter/seal-exit (528/1179).
Testbed-workaround: автоворекавери harness (stall→kill→tracker-resume, ≤2).

## TB-8 — P07 snake W2: silent terminal fail на freeze-acceptance-baseline (root-caused)

| Поле | Значение |
|---|---|
| PID | P07 (snake, epic 9, lifecycle 7, process_run 14) |
| Цех | W2 Formalization |
| Кат | protocol/quality (краеугольный шов: kernel-узел без repair-пути) |
| S | S2 (прогон потерян терминально, но fail-closed корректен; данные целы) |
| Код | NEW (первый фейл на коде 4f6c9190; НЕ TB-6 — HASH_DRIFT не при чём) |

**Симптом:** 12:28:59 UTC lifecycle завершился `terminalStatus:"failed"`, `lastError:null`, `processOutcome {code:"failed", authority:null}` при 10/10 карточек done, все воркеры exit 0, все артефакты accepted, все workplace'ы terminal/accepted. Ошибка нигде не видна — ни в логе движка, ни в stage_runs.error.

**Root cause (доказано по production_envelope node_run 2460):** kernel-узел `freeze-acceptance-baseline` выбросил
`baselineFailure: "atomic acceptance artifact 'AC-NFR-1.1' has no matching document heading"` —
принятый ревьюером NFR-AC артефакт не содержит заголовка, совпадающего со своим стабильным кодом AC-NFR-1.1
(парсер `acceptanceCriteriaForArtifact` в `formalization-production-cell-installation.ts:86..156` кидает исключение → catch → event failed).

**Почему терминально и молча:** freeze — kernel-узел, не production-cell: у него нет repair_wait/retry-цикла;
ошибка попадает только в bindings production-конверта (`formalization-baseline-status:14:55d45ee2…`), в stage error/lastError — нет.

**Шов модели:** ревьюер формализации принимает AC без проверки «код ↔ заголовок документа», первый строгий
чекер — базлайн-фризер, который уже терминален. Класс «поймали слишком поздно, чинить некому».

**Фикс-направления:** (1) валидация «код AC ↔ heading» на гейте ревью AC (до freeze), или в
`record-final-acceptance`; (2) repair-путь для kernel-узла freeze (requeue с REPAIR_REQUIRED вместо terminal fail);
(3) прокинуть baseline-failure reason в stage_runs.error/lastError (сейчас silent).

**Воспроизведение/форензика:** node_run 2460 (`freeze-acceptance-baseline`, event domain.failed), node 2461 (`complete-failed`); артефакт AC-NFR-1.1 в epic 9 (id 246..253 диапазон, accepted 12:22:40). dirty=0, lost-воркер 1.

### Коррекция TB-8 (расследование субагентов, 2026-08-15)

Первоначальная формулировка «в документе нет заголовка с кодом» НЕВЕРНА. Заголовок в
`repos/snake/docs/requirements/REQ-001-snake/03-acceptance-criteria.md:399` ЕСТЬ и корректен:
`## AC-NFR-1.1: Offline Operation — Local Filesystem`.

Реальная причина — **узкая грамматика regex в движке**
(`src/modules/formalization/domain/acceptance-criterion-document.ts:9`):
`/^(#{2,3})\s+(AC-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*):\s+(.+?)\s*$/gm` — сегменты кода не допускают дефис,
поэтому `AC-NFR-1.1` не матчится ВООБЩЕ (parsed непуст за счёт 34 плоских `AC-N` → fallback не срабатывает → throw).

Змея — единственный проект партии с иерархическими кодами AC (8 шт. AC-NFR-x.y из 42); все 5 прошедших
использовали плоские `AC-N`. Категория: баг движка ~75% (грамматика artifact_create свободнее грамматики
парсера; дубль той же regex — в `sqlite-development-verification-adoption.ts:486`, надо чинить синхронно).

Фикс: расширить regex до `AC-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*` в ОБОИХ местах + ранний чекер
heading↔code на гейте ревью AC (draft-стадия с repair-циклом), а не терминальный kernel-freeze.

### Уточнения по независимой проверке (2026-08-15, ревьюер кода + локальная верификация)

- **TB-8 → S1** (был S2): по собственной шкале реестра S1 = «прогон умер»; P07 завершился
  terminal failed. Fail-closed сработал корректно (данные целы), но исход — потеря прогона.
  **Диагноз подтверждён независимо** (accepted-документ содержит корректный заголовок
  `AC-NFR-1.1`; узкая грамматика была продублирована в Formalization и Development).
  **Исправлено**: PR #31 (`4af3adb5`/`961c1d0f`), regex `AC-[A-Za-z0-9-]+` в обоих цехах,
  regression-тесты + architecture-ratchet на расхождение грамматик. Влито в saga4 `d4098f02`.
- **TB-6 → статус понижен до НЕдоказанной гипотезы.** Сам HASH_DRIFT реален, effect
  fail-closed по дизайну (mutable artifacts не могут подменить sealed material); managed
  artifact writes требуют живого producer execution — значит по одному `artifacts.updated_at`
  нельзя определить, какой execution сделал запись. Варианты A–E (repair-запись после
  submission / законный новый execution / неверная revision у гейта / смешение версий
  CandidateSet / system-writer) требуют точной provenance-цепочки:
  `factory_managed_artifact_productions → execution_id → worker_executions →
  WorkplaceProductionRevision → CandidateSet #1/#2 → GateDecision → sealed hash vs
  artifacts.content_hash`. **До форензики — никаких архитектурных ослаблений HASH_DRIFT.**
- W1 слепое ревью: среднее 21.64/25 (86.6%) по 14 оценкам (303/14), а не 21.8/25 —
  исправлено в W1-BLIND-REVIEW.md (335c1bc3).

## TB-9 — P09 kanban: deadlock kernel-verifying после смены движка (root-caused, вылечено вручную)

| Поле | Значение |
|---|---|
| PID | P09 (kanban, epic 11, process_run 18) |
| Цех | W2 Formalization |
| Кат | engine (supervision/recovery не переисполняет kernel-owned verifying) |
| S | S1 (очередь стояла ~57 мин, 13:16→14:13) |

**Симптом:** воркер последней карточки acceptance-contract завершился ШТАТНО (exit 0, 13:16:14),
но движок был остановлен (переход на TB-8-фикс, kill ~13:21) до обработки его выхода.
Workplace `formalization-acceptance-contract/singleton` остался в `loop_state=verifying`
с `active_reservation_ref` мёртвой execution; узел define-acceptance-contract сделал 4600+
runtime.paused-попыток; supervision-sweep держал lease (kept=1, renewed=1), CPU 0% (не TB-2-спин).
Новые движки не пожинают executions чужих инстансов → само не рассасывалось (наблюдали 9 срезов).

**Root cause:** «обработка выхода воркера» живёт в процессе движка, а не в БД-обязательстве.
ADR-053-паттерн: authority перехода привязана к живому процессу. Пункт #4 отложенного списка
автора фиксов (obligation-aware pump) прямо про это.

**Лечение (применено 14:14–14:15 UTC, оператор санкционировал):** бэкап БД
(`factory.sqlite.bak-tb9-1415`) → `UPDATE factory_workplaces SET active_reservation_ref=NULL`
для зависшего workplace (ровно post-seal/gate состояние по дизайну) → движок переисполнил
verifying идемпотентно по sealed-материалу и задиспетчеризовал карточку заново
(execution bb60d2ad, task 30, hb свежий). Потери данных нет (7/8 карточек и все артефакты целы).

**Фикс-направления:** (1) при engine-start — reap/adopt чужих executions: exited + stuck_state=active
→ обработать выход (markExited-эквивалент) или очистить reservation; (2) lease kernel-owned
verifying с TTL + идемпотентный re-drive; (3) obligation-aware pump (пункт #4).
