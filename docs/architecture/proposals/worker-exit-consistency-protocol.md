# Worker-Exit Consistency Protocol — event-driven приведение к консистентному состоянию при завершении воркеров

- **Status:** Proposed (дизайн-документ, НЕ реализовано; коммиты кода не делались)
- **Date:** 2026-08-17
- **Связанные:** ADR-053 (материальный авторитет), CONVEYOR-MENTAL-MODEL §23
  (composed state machines, «OS worker exits → terminalize the exact
  WorkerExecution; host status is observation only»),
  `docs/architecture/lifecycle-command-event-vocabulary.md` (замороженный
  словарь команд/событий — переиспользуем, не расширяем)
- **Факт-база:** инцидент 17.08 15:46–16:10 (проект sudoku, эпик 17,
  БД `.factory-testbed/factory.sqlite`, read-only) + код
  `src/lifecycle/stuck-policy.ts`, `src/worker-executions.ts`,
  `src/lifecycle/atomic-release.ts`, `src/tools/dispatcher.ts`,
  `src/application/conveyor-runtime.ts`,
  `src/infrastructure/work/worker-supervision-service.ts`,
  `tracker-view/claude-runner.mjs`.

---

## 0. Постановка и вердикт по тезису заказчика

**Тезис:** «Если рабочий вышел правильно, тот, кто получает этот сигнал,
кидает событие, и система приводит себя к консистентному состоянию».

**Вердикт: тезис верен, но в текущем коде нарушен в одном месте — и чинится
не новым событием, а дисциплиной классификации.** Доказательство по фактам:

1. Событие «вышел правильно» **уже существует и уже атомарно**:
   обработчик `worker_done` (`src/tools/dispatcher.ts`, `withImmediateTransaction`)
   одной IMMEDIATE-транзакцией пишет: (а) принятый receipt в
   `command_receipts` (`worker_done` | `presentation_close`, `accepted=1`),
   (б) `worker_executions.phase='finishing'|'integrating'`,
   (в) продвигает воркспейс `running → verifying`
   (`releaseTaskExecution` → `ConveyorRuntime.releaseExecution`,
   событие редьюсера `candidate-sealed`). Семантический факт сдачи durable
   **до** физической смерти процесса — это уже event-driven ядро.
2. Событие «процесс умер» тоже существует и имеет **несколько эмиттеров**:
   OS close-callback раннера (`markExecutionExited`), supervision-sweep
   (30 c, PID-проба), стартап-реконсиляция после рестарта движка.
3. Дефект — в **терминальной классификации** строки `worker_executions`:
   gate (2) чистой политики (`src/lifecycle/stuck-policy.ts`, строки ~281–299)
   по предикату `notAlive` выпускает `RELEASE terminal='lost'`
   («OS process is not alive») **не глядя на `semanticCompletionAccepted`**.
   Grace (2a) (строки ~302–324) защищает строку только пока процесс **жив**
   (`input.isAlive` — условие ветки), т.е. мёртвый чисто сдавший воркер
   в него не попадает.

**Наблюдение (эпик 17, 8 задач 17.08 15:46–16:10, подтверждено read-only
запросами к БД):**

| execution (хвост) | state | phase | exit_code | accepted-receipt |
|---|---|---|---|---|
| …083332db | exited | finishing | 0 | 1 |
| …040197ca | **lost** | **finishing** | null | **1** |
| …80a46837 | **lost** | **finishing** | null | **1** |
| …925d0aa8 | **lost** | **finishing** | null | **1** |
| …1a887e0e | **lost** | **finishing** | null | **1** |
| …ec33852e | **lost** | **finishing** | null | **1** |
| …330b0ae9 | **lost** | **finishing** | null | **1** |
| …0ca74f31 | exited | finishing | 0 | 1 |

Все 8 задач `done`, все воркспейсы дошли до `terminal/accepted` — продукция
не теряется. Но 6 из 8 закрыты как `lost` при живом receipt. По всей
тестовой БД: **158 `lost`, из них 111 (70 %) — с принятым receipt.**
Последствия `lost`-при-receipt: ложное сжигание recovery-бюджета
(`countTerminalExecutionsForTask` считает `state IN
('lost','terminated','spawn_failed')` без оглядки на receipt), шумные
30-секундные окна обнаружения (wait-poll тикает по 1 с, obligation-defer,
перевыделения), ложный сигнал оператору.

**Редакция заказчика принимается с двумя уточнениями:**

- «вышел правильно» определяется **не наблюдателем смерти**, а durable
  receipt'ом; наблюдатель смерти фиксирует только физический факт;
- «кидает событие» — событие уже есть (`TaskReleased` с
  `preservedProjection` + receipt `ObserveProcessExited`); не плодим новые
  kind'ы, наводим порядок в классификации и payload.

---

## 1. Текущая машина состояний `worker_executions`

### 1.1 Диаграмма

Три параллельных канала в одной строке (state — владелец: reaper/callback;
phase — владелец: worker-протокол; stuck_state — владелец: reaper):

```text
Канал state (терминалы необратимы, CAS через WHERE state IN (active)):

  reserved ──markRunning──► running ─────────────────────────────┐
     │                        │                                   │
     │ boot-timeout           │ (stuck-эскалация, только alive)   │
     ▼                        ▼                                   │
  spawn_failed          suspected_stuck ──► cancel_requested      │
                              │                    │              │
                              │                    ▼              ▼
                              │            TERMINATE(kill+CAS)► terminated
                              │                    │
                              ▼                    │ PID-reuse grace 10 мин
                     (fall-through к TERMINATE)    ▼
                                                 lost  ◄── все «выводы о смерти»:
                                                         notAlive / remote-lease /
                                                         PID-guard / PID-reuse-grace
  running ──markExecutionExited (OS close-callback)──► exited (exit_code)
  running|cancel ──reaper RELEASE──► lost|spawn_failed
  running|finishing ──(in-process replay, прямой SQL)──► exited

Канал phase (CHECK IN ('executing','reviewing','finishing','integrating')):
  executing ──worker_done──► finishing
  executing ──worker_done(done+git_change+pending)──► integrating

Канал stuck_state (только при alive): active → suspected_stuck → cancel_requested
```

### 1.2 Таблица всех переходов с триггерами и писателями

| # | Переход | Триггер | Писатель (код) | Что пишется той же транзакцией |
|---|---|---|---|---|
| 1 | INSERT `reserved`/`executing` | claim карты: `worker_next` → assign | `src/lifecycle/work-assignment-core.ts` (резервирование) | `tasks.current_execution_id` (fence), `tasks.assigned_to`; воркспейс `queued → leased` (`reserveWorkplace`) |
| 2 | `reserved → running` | раннер заспавнил процесс | `markExecutionRunning` (`src/worker-executions.ts:214`) | pid, `process_birth_token`, `tasks.metadata.worker_pid` |
| 3 | `running → running` (touch `progress_at`) | stdout / tool-call воркера | `markExecutionProgress` | — |
| 4 | `phase → finishing/integrating` (state НЕ меняется) | **worker_done принят** | `src/tools/dispatcher.ts:845` (`updateExecutionPhase`) внутри `withImmediateTransaction` | **accepted receipt** (`command_receipts`), статус/`assigned_to=NULL` задачи, воркспейс `running → verifying` (`releaseExecution(outcome='completed')`, reservation сохраняется), comment |
| 5 | `running|cancel → exited|terminated` + `exit_code` | OS close/exit-callback раннера | `workerFinalize` → `markExecutionExited` → `releaseExecutionAtomically` (`tracker-view/claude-runner.mjs:1202–1295`) | очистка fence (`clearTaskFence`, статус preserved при receipt), best-effort receipt `ObserveProcessExited` + `lifecycle_events.TaskReleased{preservedProjection}` |
| 6 | `reserved → spawn_failed` | ошибка спавна | `markExecutionSpawnFailed` | `last_error` |
| 7 | `reserved → spawn_failed` | reaper: boot-timeout 60 c / истёкший lease резерва | gate (2) `RELEASE` | то же, что № 5 |
| 8 | **`running → lost`** | **reaper: локальный `notAlive`** | **gate (2) `RELEASE('lost','OS process is not alive')` — БЕЗ проверки receipt** | № 5 + burn бюджета |
| 9 | `running → lost` (remote) | reaper: remote lease expired | gate (1) | № 5 |
| 10 | `running → lost` | PID-guard FIX 1: alive-but-foreign + heartbeat stale 2 мин | `reconcileWorkerExecutions` (pre-policy guard) | № 5 |
| 11 | `cancel_requested → lost` | PID-reuse grace 10 мин (Wave 8 HIGH 5B) | gate (4) | № 5 + human-notify |
| 12 | `running → terminated` | verified kill: alive+lease-expired (HIGH 5A), stuck-stage-3, alive-illegitimate | `TERMINATE` → `killVerified` → `releaseExecutionAtomically('terminated')` | № 5 |
| 13 | `running|finishing → exited` (прямой SQL) | in-process replay капсулы | `claude-worker-executor-factory.ts:733` | — (worker_done уже прошёл путём № 4) |
| 14 | fence-реконсиляция без смены state | повторный `releaseExecutionAtomically` по уже терминальной строке + fence наш + receipt | ветка «Reconciliation case» (`atomic-release.ts:94–120`) | `clearTaskFence` со status preserved |

### 1.3 Гонка poller-vs-callback (текущее поведение)

Оба наблюдателя (# 5 callback и # 7–12 sweep) терминализируют одну строку.
Сериализация уже правильная: `releaseExecutionAtomically` делает
`UPDATE … WHERE state IN ('reserved','running','cancel_requested')` —
первый коммит побеждает, второй получает `noRelease('execution already in
terminal state')` и **теряет свой exit_code** (обогащения нет).

Расхождение в **классификации**: callback пишет `exited`, sweep пишет
`lost` — при идентичной физике завершения. Кто победил, определяется не
протоколом, а таймингом доставки:

- sweep ходит каждые 30 c (`DEFAULT_INTERVAL_MS`);
- `close` на Windows может не приходить неограниченно долго (наследованные
  pipe-хэндлы; страховка `exit` + 5 c force-finalize в раннере помогает
  только если раннер жив и event-loop движка здоров);
- dispatch-loop FIX 2 при переполнении wait-бюджета уходит, не диспозив
  раннер — естественный receipt всё равно придёт, но позже sweep.

Итог инцидента: у 6 из 8 воркеров классифицировал sweep → `lost`.

Ключевой сигнал о расхождении уже виден в БД: `phase='finishing'` +
receipt=1 + `state='lost'` + `exit_code IS NULL` — комбинация, невозможная
по смыслу (воркер сдался, но записан «потерян»).

---

## 2. Целевая модель

### 2.1 Разделение фактов

| Факт | Носитель | Кто создаёт | Статус в модели |
|---|---|---|---|
| F1 — семантическая сдача | `command_receipts` (`worker_done`/`presentation_close`, `accepted=1`) | worker-протокол (или kernel `presentation_close`), IMMEDIATE-транзакция | **семантический авторитет** (ADR-053: Workplace движется по этому) |
| F2 — физическое наблюдение смерти | событие OS close (code) / PID-проба notAlive / remote-lease-expired / verified-kill / boot-timeout | любой наблюдатель (callback, sweep, стартап-реконсиляция) | наблюдение, может дублироваться |
| F3 — терминальная классификация строки | `worker_executions.state` | **производное: чистая функция от (F1, F2)** | provenance + attempt-accounting, НЕ материальный авторитет |

### 2.2 Инварианты

- **I1 (receipt доминирует).** Если F1 существует на момент классификации,
  терминал — всегда `exited`, никогда `lost`/`terminated`/`spawn_failed`.
  Формально: `terminal = classify(receipt, observation)` по таблице § 2.3.
  Обоснование корректности: worker_done коммитится **до** смерти процесса,
  поэтому любой наблюдатель смерти (все они стартуют после смерти) видит
  receipt в своём read-snapshot (WAL). Гонки по видимости receipt нет.
- **I2 (ровно один терминал).** Переход active → terminal происходит ровно
  один раз: CAS `WHERE state IN ('reserved','running','cancel_requested')`.
  Проигравший наблюдатель — идемпотентный no-op; терминал никогда не
  переписывается (терминальная монотонность, CONVEYOR §23). Опоздавший
  close-callback может только **обогатить** `exit_code`/`last_error`
  отдельным UPDATE без смены state (только если поля NULL).
- **I3 (Workplace движется по receipt, не по терминалу строки).** Loop
  `running → verifying` происходит в транзакции worker_done (уже так).
  Терминализация строки никогда не двигает воркспейс; она только расчищает
  task-fence (`clearTaskFence`), и при receipt — с сохранением projection
  (`preserveTaskStatus`). Все projection-потребители (`promoteTaskToDone`,
  obligation-reconciler `close-presentation / run-gate / run-effects /
  record-final-acceptance / settle-process / route-lifecycle`) читают
  receipt/postcondition, а не `worker_executions.state`. Для бюджетов и
  аналитики действует **effective-terminal** (см. § 4.2).
- **I4 (честность бюджета).** Сдавший воркер не расходует recovery-бюджет:
  `exited` не входит в `countTerminalExecutionsForTask`; I1 гарантирует
  `exited` при receipt. (Сегодня I1 нарушен → 111 ложных списаний в testbed.)
- **I5 (одна точка классификации).** Все писатели терминала проходят через
  одну чистую функцию `classifyExecutionTerminal(receipt, observation)`.
  Дублей логики «if receipt then … else …» по кодовой базе нет.

### 2.3 Таблица классификации (целевая, чистая функция)

| receipt (F1) | observation (F2) | terminal | exit_code | reason-семейство | receipt-kind (audit) |
|---|---|---|---|---|---|
| 1 | `os-close(code)` | `exited` | code | `process exited after accepted worker_done` | `ObserveProcessExited` |
| 1 | `not-alive` (PID-проба) | `exited` | null → обогатить | `OS process not alive; accepted receipt is completion authority` | `ObserveProcessExited` |
| 1 | `remote-lease-expired` | `exited` | null | `remote lease expired after accepted receipt` | `ObserveProcessExited` |
| 1 | `janitorial-kill` (alive + lease-expired / stuck / PID-reuse-grace; kill по birth-token) | `exited` | null | `killed after semantic completion — OS hygiene only` | `ObserveProcessExited` |
| 0 | `os-close(code)` | `exited` | code | `process closed without accepted worker_done` (восстановление статуса — как сегодня) | `ObserveProcessExited` |
| 0 | `not-alive` / `remote-lease-expired` / PID-guard | `lost` | null | как сегодня | **`ObserveProcessLost`** |
| 0 | `verified-kill` (stuck-эскалация, HIGH 5A) | `terminated` | null | как сегодня | `ObserveProcessExited` |
| 0 | `boot-timeout` (reserved) | `spawn_failed` | null | как сегодня | `ObserveProcessLost` |

Замечания:

- Семантика терминалов после cutover: `exited` = «завершил попытку; при
  receipt — сдал», `lost` = **«умер, не сдав»** (единственный
  бюджето-сжигающий и ремонтный сигнал), `terminated` = «убит политикой,
  не сдав», `spawn_failed` = «не родился». Observation-провенанс уезжает в
  `last_error`/payload, а не в имя терминала.
- Строка `receipt=1 ∧ reserved` ненаблюдаема (worker_done требует state
  running) — защитная ветка возвращает `exited` + телеметрию
  `INVARIANT_EXECUTION_RECEIPT_ON_RESERVED`.
- Сегодня `appendReleaseEvent` пишет `ObserveProcessExited` для **всех**
  терминалов, включая `lost`/`spawn_failed` — ложь о факте. Целево: kind
  соответствует классификации (последняя колонка). `ObserveProcessLost`
  уже есть в замороженном словаре команд — новый kind не изобретается.

### 2.4 Целевая таблица переходов (дельта к § 1.2)

| Переход | Кто применяет (после cutover) | Изменение против текущего |
|---|---|---|
| `running → exited` при `notAlive` + receipt | sweep / стартап-реконсиляция (gate 2 сначала спрашивает `classifyExecutionTerminal`) | было `lost` |
| `running → exited` при remote-lease-expired + receipt | sweep | было `lost` |
| `alive + lease-expired + receipt` | gate: kill остаётся (HIGH 5A — защита от двойного найма), терминал `exited`, reason «janitorial kill» | было `terminated` |
| PID-guard / PID-reuse-grace + receipt | терминал `exited`, уведомление человеку сохраняется | было `lost` |
| `lost`/`terminated`/`spawn_failed` | только при receipt=0 | — |
| `exit_code` после терминала | только os-close-callback, только в NULL | нового нет — легализуется как идемпотентное обогащение |
| `phase → finishing` + receipt + воркспейс `→ verifying` | worker_done (без изменений) | — |

### 2.5 Событие: переиспользуем, не плодим

**Переиспользуются существующие kind'ы** (словарь FROZEN —
`lifecycle-command-event-vocabulary.md`):

1. **`TaskReleased`** (`lifecycle_events`) — единственное событие, на которое
   подписан projection-мир. Пишется уже сегодня в
   `releaseExecutionAtomically.appendReleaseEvent`. Payload расширяется
   аддитивно (старые читатели игнорируют неизвестные поля):

```json
{
  "kind": "TaskReleased",
  "taskId": 430,
  "resumePhase": "implementation",
  "reason": "OS process not alive; accepted receipt is completion authority",
  "executionId": "worker-execution:…",
  "preservedProjection": true,
  "terminal": "exited",
  "semanticCompletionAccepted": true,
  "classification": "receipt-driven",
  "observer": "supervision-sweep"
}
```

- `semanticCompletionAccepted` — явный алиас `preservedProjection` (устраняет
  двусмысленность «preserved чего?»);
- `terminal` — итог классификации;
- `classification`: `receipt-driven` (I1) | `observation-driven`;
- `observer`: `os-close` | `supervision-sweep` | `startup-reconciliation` —
  кто применил (для аудита гонок).

2. **`ObserveProcessExited` / `ObserveProcessLost`** (`command_receipts`) —
   audit-receipt терминализации, kind по таблице § 2.3.

**Идемпотентный ключ:** `command_id = 'release:{executionId}:{terminal}'`
(стабильный). Сегодня ключ содержит `Date.now()`
(`release:${executionId}:${Date.now()}`) — повторная терминализация той же
строки создала бы дубль строки receipt (её предотвращяет только CAS
`clearTaskFence`, а не ключ). Фикс: убрать `Date.now()`, тогда
`INSERT OR IGNORE` схлопывает любые повторы. Для enrichment-обновления
`exit_code` ключ не используется (это UPDATE, не новая строка).

**Кто эмитит:** единственная точка — `releaseExecutionAtomically` (после
CAS-победы). Эмиттер-наблюдатель (callback/poller/реконсиляция) — параметр
payload, не отдельный писатель.

### 2.6 Правило разрешения гонки

1. **Порядок неважен.** `classifyExecutionTerminal` детерминирована, receipt
   durable-до-смерти ⇒ любые два наблюдателя вычисляют **одинаковый**
   терминал для одной строки (см. обоснование в I1).
2. **Single-writer по CAS.** Терминализация — один
   `UPDATE … WHERE state IN (active)` внутри IMMEDIATE-транзакции
   `releaseExecutionAtomically` (уже так). `changes=1` ⇒ этот наблюдатель
   эмитит `TaskReleased`; `changes=0` ⇒ no-op.
3. **Обогащение после проигрыша.** Только os-close-callback может дозаписать
   `exit_code` в уже терминальную строку (`UPDATE … WHERE execution_id=?
   AND exit_code IS NULL`), без смены state/события.
4. **Детектор расхождения.** Если два наблюдателя вычислили разные терминалы
   (возможно только при баге или гонке видимости receipt) — это инвариантное
   нарушение: код причины `INVARIANT_EXECUTION_CLASSIFICATION_CONFLICT`,
   incident card по CONVEYOR-TRANSITION-DIAGNOSTICS § 5, никогда тихий
   «второй пишет поверх».
5. **Владелец гонки приоритетен для обогащения, не для классификации:**
   близость к процессу даёт данные (exit_code), но не власть над классом
   завершения.

---

## 3. Протокол реконсиляции после рестарта движка

Сценарий: движок умер между commit'ом receipt и наблюдением смерти; процесс
доработал и умер (или ещё жив, но бесхозен). Шаги boot-resume, все до
первого dispatch:

1. **Startup classification sweep.** `startWorkerSupervision` уже делает
   немедленный проход. Для каждой строки `state IN (active)`:
   - `machine_id = this host` → PID-проба + birth-token → F2 ∈
     {os-close-недоступен, not-alive, alive…}; alive-строки живут по
     обычной stuck-политике (их терминализировать нельзя);
   - remote → F2 = remote-lease-expired при просроченном lease, иначе KEEP;
   - прочитать F1 (receipt) → `classifyExecutionTerminal` → терминал.
   Результат: строка «умер чисто, сдав» → `exited`, НЕ `lost`.
2. **Расчистка stranded-fence.** Для `tasks.current_execution_id`,
   указывающего на терминальную строку: существующая ветка
   «Reconciliation case» в `releaseExecutionAtomically` (terminal + fence
   наш + receipt → `clearTaskFence` c preserve) — оставить и распространить
   на любую терминальную классификацию (работает и для старых `lost`-строк
   с receipt — это already-ships). Для терминала без receipt —
   существующий recovery-путь `work-assignment-core` (status restored).
3. **Redrive Workplace-долгов.** Obligation-ledger
   (`factory_transition_obligations`: close-presentation → run-gate →
   run-effects → record-final-acceptance → settle-process →
   route-lifecycle) перегоняется obligation-reconciler'ом как сегодня —
   по receipt/postcondition, **не** по терминалу строки (I3). Движок,
   умерший между receipt и смертью воркера, не мешает воркспейсу дойти от
   `verifying` до `terminal(accepted)`.
4. **Projection-доход.** `promoteTaskToDone` требует
   `current_execution_id IS NULL` — после шага 2 fence чист, workplace
   terminal → существующая `projectWorkplace`-проекция завершает
   `tasks.status='done'` + `reevaluateDownstream`.

**Классификация не становится obligation-kind'ом.** Obligation — это
«должен сделать переход с побочным эффектом»; терминализация —
детерминированная проекция над durable-фактами, сходящаяся сама за один
проход. Новый kind в ledger не вводится (принцип «не плодить»).

**Сходимость:** один проход startup-sweep + один sweep obligation-ledger;
идемпотентность каждым CAS; повторный рестарт в середине — безопасен
(терминалы монотонны, ключи стабильны).

---

## 4. Обратная совместимость и миграция

### 4.1 Схема БД: БЕЗ изменений

Все данные для целевой классификации уже есть: `command_receipts`
(индекс `idx_command_receipts_execution` существует), `state`, `exit_code`,
`last_error`, `phase`. Новых колонок в `worker_executions` НЕ вводим —
классификация производная; ввод колонки закрепил бы за строкой статус
авторитета (против ADR-053).

### 4.2 Интерпретация старых строк (read-side, без переписывания истории)

Исторические `lost`-с-receipt строки (в testbed — 111) не переписываются
(терминальная монотонность; append-only аудит). Потребители читают
**effective-terminal**:

```sql
CASE WHEN EXISTS (
       SELECT 1 FROM command_receipts cr
        WHERE cr.execution_id = we.execution_id
          AND cr.command_kind IN ('worker_done','presentation_close')
          AND cr.accepted = 1)
     THEN 'exited' ELSE we.state END AS effective_terminal
```

Точки применения (единственный read-фикс, входящий в объём):

- `countTerminalExecutionsForTask` (`src/app/product-lifecycle-runtime.ts`)
  и `physicalRetryExhausted` (`atomic-release.ts`) — исключить
  receipt-строки из счётчика неудач;
- ретроспектива/аналитика (saga-retrospective, WORKSHOP-статистика);
- UI-бейдж «lost» — показывать `effective_terminal`.

### 4.3 Строки, застрявшие на момент деплоя

`state='running'` с мёртвым процессом и receipt — стартап-sweep нового
кода классифицирует `exited` (путём § 3.1). `running` без receipt — `lost`
как сегодня. Двойной деплой/откат безопасен: классификация не имеет
собственного состояния.

### 4.4 Соотнесение с ADR-053

Протокол **не углубляет** авторитет WorkerExecution — наоборот, завершает
его понижение: строка = «физическое наблюдение + attempt-accounting +
provenance», семантический авторитет завершения = accepted receipt (F1),
материальный авторитет = Workplace/ревизия. I3 — прямое кодирование тезиса
ADR-053 «WorkerExecution is provenance only» для границы завершения.
Никаких новых execution-scoped material lookups не появляется; напротив,
`state='lost'` перестаёт быть неявной командой «перенайми» для
потребителей, которые читали его как семантический вердикт.

### 4.5 Регламентируемое нарушение byte-identity

`stuck-policy.ts` объявляет BYTE-IDENTITY CONTRACT относительно
процедурного предшественника, а golden-тесты
(`tests/architecture/worker-supervision-reaper.test.mjs`,
`tests/lifecycle/stuck-policy.test.mjs`) — его фиксация. Gate (2) меняется
сознательно: это не «ещё один fix(...)», а смена инварианта I1 — golden
обновляется в том же коммите, с таблицей § 2.3 как новым оракулом.

---

## 5. Границы применимости

- **Remote-исполнения.** Классификация — только от durable-lease (PID чужого
  хоста непробуем). Lease expired + receipt → `exited`; без receipt →
  `lost`. Residual-риск: worker_done удалённого хоста в полёте в момент
  expiry-sweep может не попасть в snapshot sweep'а → редкий ложный `lost`.
  Смягчение: классифицировать remote-lease-expired только после
  lease + margin (один sweep-интервал). Финальную классификацию всегда
  делает host-владелец, когда жив.
- **Lease expiry при живом процессе (Wave 8 HIGH 5A).** Kill остаётся
  обязательным (двойной найм недопустим), но при receipt терминал `exited`
  («janitorial kill»): семантика завершена, budget не горит. Birth-token
  verify перед kill сохраняется.
- **TERMINATE-путь (stuck-эскалация).** По определению receipt=0 (воркер
  молчал и не сдавал) → `terminated` без изменений. Протокол не смягчает
  эскалацию, только не лжёт о сдавших.
- **PID reuse (Wave 8 HIGH 5B, сценарий 16; PID-guard FIX 1).** Все
  защитные гранки (birth-token, foreign-классификация, 2-мин stale-heartbeat,
  10-мин reuse-grace, human-notify) сохраняются; меняется только терминал
  при receipt: `exited`. Воркер, сдавший и умерший, чей PID переиспользован,
  больше не жжёт бюджет и не выглядит «пропавшим».
- **In-process replay.** Уже пишет `exited` после worker_done (переход № 13)
  — конгруэнтно classify-таблице, не трогаем.
- **needs-human / voided.** Voided-строки (операторский soft-stop) исключены
  из бюджета уже маркером `voided_at` — протокол их не классифицирует.
  `needs-human`-фенсинг в `releaseExecutionAtomically` не меняется.
- **Single-host bounded.** Протокол живёт в текущей однохостовой физике
  (machine_id = hostname). Мультихост требует owner-host-классификатора с
  эпохами — вне scope (см. § 6).

---

## 6. Риски дизайна и что сознательно НЕ решаем

### Риски

1. **Скрытые потребители семантики `lost`.** Аудит всех читателей
   `state='lost'` (UI, ретроспектива, статистика тестбеда, тесты) до
   cutover: часть из них может неявно полагаться на «lost = нужен повтор».
   Митигация: переход на `effective_terminal` (§ 4.2) в том же коммите.
2. **Регрессия stuck-policy.** Изменение gate (2) ломает byte-identity
   контракт; golden-тесты нужно переписать по таблице § 2.3, риск потерять
   угол (reserved-ветки, remote-ветки) при небрежном обновлении.
   Митигация: таблица § 2.3 как единственный оракул + мутационный тест
   (вернуть старый gate → red).
3. **Remote late-receipt.** Окно между lease-expiry и коммитом worker_done
   удалённого хоста (см. § 5) — редкий ложный `lost`. Mitigation margin
   уменьшает, не устраняет.
4. **Стабильный ключ release-receipt.** Замена `Date.now()`-ключа на
   стабильный делает повторы молчащими (INSERT OR IGNORE) — это желаемо,
   но любой код, считающий строки `ObserveProcessExited`, увидит «меньше»
   строк после cutover (дедупликация), не «потерю» фактов.
5. **`ObserveProcessLost` для spawn_failed.** Потребители, ожидающие только
   `ObserveProcessExited`, должны игнорировать неизвестный kind (проверить
   читателей `command_receipts` по kind).
6. **Потеря exit_code при sweep-классификации** остаётся (audit-gap):
   терминал `exited` без наблюдённого кода. Осознанно: код — обогащение,
   не авторитет.

### Сознательно НЕ решаем (вне scope этого протокола)

- **Первопричину недоставки close-callback** (наследованные pipe-хэндлы
  Windows, здоровье event-loop движка) — это дефект физики наблюдения;
  протокол лишь перестаёт ошибаться в вердикте, когда callback опаздывает.
- **Сжатие 30-секундного окна обнаружения** — тюнинг интервалов sweep,
  не протокол.
- **Мультихостовую координацию** классификации (owner-epoch, распределённый
  lease) — до появления второго хоста исполнения.
- **Переписывание исторических `lost`-строк** (включая 111 в testbed) —
  история append-only; лечится read-side `effective_terminal`.
- **Общий cutover материального авторитета ADR-053/073** (эпик-накопление
  формализации, newest-wins капсульный биндер) — смежные, но отдельные
  дефекты; данный протокол закрывает только границу завершения воркера.

---

## 7. Тестовая матрица (для инженера — без вопросов)

| Уровень | Тест | Ожидание |
|---|---|---|
| L1 pure | `classifyExecutionTerminal` по всем парам (receipt ∈ {0,1}) × (observation ∈ {os-close(0), os-close(≠0), not-alive, remote-lease-expired, janitorial-kill, verified-kill, boot-timeout}) | в точности таблица § 2.3; детерминизм (двойной вызов — тот же результат) |
| L1 pure | stuck-policy: gate (2) с `semanticCompletionAccepted=true`, `isAlive=false`, `phase='finishing'` | `RELEASE('exited')`, не `'lost'` |
| L1 pure | gate (2) с receipt=0, `isAlive=false` | `RELEASE('lost')` — без регресса |
| L1 pure | HIGH 5A: alive + lease-expired + receipt → kill + `exited`; без receipt → `terminated` | бюджет не горит при receipt |
| L2 durable | гонка: callback и sweep терминализируют одну строку (реальный SQLite, два соединения) | ровно один терминал; второй — noRelease без события; exit_code обогащён только из callback |
| L2 durable | идемпотентность: повторный `releaseExecutionAtomically` той же строки | ноль новых `TaskReleased`/`ObserveProcess*` (стабильный ключ) |
| L2 durable | `appendReleaseEvent` kind | `lost`/`spawn_failed` → `ObserveProcessLost`; `exited`/`terminated` → `ObserveProcessExited` |
| L3 temporal | реплика эпика 17: 8 scripted-воркеров, worker_done принят, close-callback задержан > sweep-интервала | все 8 строк `exited`; `countTerminalExecutionsForTask`=0; воркспейсы `terminal(accepted)` без повторного найма; ноль `TaskReleased` с `classification='observation-driven'` |
| L3 temporal | receipt=0, процесс умер молча | `lost`, задача восстановлена, бюджет −1 — старое поведение сохранено |
| L4 fault | kill движка между commit'ом receipt и смертью процесса → рестарт | startup-sweep: `exited`; fence расчищен с preserve; obligation-redrive доводит `verifying → terminal(accepted)`; повторного найма нет |
| L4 fault | kill движка до worker_done → рестарт | `lost` (или alive-путь), recovery-найм — как сегодня |
| L4 fault | рестарт в середине реконсиляции (двойной) | сходимость, без дублей терминалов/событий |
| Mutation | вернуть gate (2) без проверки receipt | L1/L3-тесты красные |
| Read-side | `effective_terminal` на testbed-снимке со старыми `lost`-строками | 111 из 158 читаются `exited`; бюджетные счётчики не увеличиваются |

---

## 8. Резюме одной страницей

Терминальная классификация воркера — чистая функция
`classify(receipt, exit-observation)`, применяемая идемпотентно тем, кто
наблюдал первым (OS callback / poller / стартап-реконсиляция), через
единственный CAS-механизм `releaseExecutionAtomically`. Receipt принятого
`worker_done` — семантический авторитет завершения; воркспейс движется по
нему (и уже движется), а не по терминалу строки. Событие `TaskReleased` с
`preservedProjection` (+`terminal`, `classification`, `observer`) —
единственная проекция; новые kind'ы не вводятся. Схема БД не меняется;
старые строки читаются через `effective_terminal`. Рестарт сходится за
один startup-sweep без новых obligation-kind'ов.
