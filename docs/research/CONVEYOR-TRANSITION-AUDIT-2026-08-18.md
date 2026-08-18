# Ревизия конвейерной модели — переходы между машинами (2026-08-18)

> Метод: не «читать код подряд», а взять **нормативную таблицу переходов** §23
> CONVEYOR-MENTAL-MODEL и проверить каждое ребро на durability. Реальные модели
> НЕ запускались. Доказательства — из кода + БД реальных прогонов
> (`.factory-docker-runs/*/factory.sqlite`).

---

## 0. Почему именно переходы, а не код

Симптом оператора: «то цепочка проходит целиком, то падает где-то». Модель сама
называет этот класс (§23):

> *The production failure class that local transition tests cannot prove is a
> missing **synchronization edge**: machine A reaches a legal state but the real
> host never invokes the command that advances machine B.*

Отсюда объяснение парадокса «1000+ тестов зелёные, а завод нестабилен»:

| Слой | Что доказывает | Состояние |
|---|---|---|
| L0–L2 | каждая машина по отдельности корректна | **исчерпывающе покрыт** |
| L3/L4 | межмашинные рёбра и краш-расписания | *«The historically missing layer was L3/L4»* — признано самой моделью |

Локальный тест **по построению** не видит отсутствующее ребро. Поэтому ревизия
идёт по модели, а не по покрытию.

---

## 1. Карта: какие переходы durable, какие — нет

Модель §23 объявляет **12** обязательных hand-off'ов. Реализация имеет durable
ledger (`factory_transition_obligations`) ровно на **5**:

```
'close-presentation' | 'run-gate' | 'run-effects'
| 'record-final-acceptance' | 'route-lifecycle'
```

| # | Переход §23 | Durable? | Механизм |
|---|---|---|---|
| 1 | Launch claimed → LifecycleRun | ✗ | прямой вызов, реконсиляция в runEpisode |
| 2 | Stage selected → StageRun+ProcessRun | ✗ | прямой вызов |
| 3 | Flow → Production Cell → materialize | ✗ | идемпотентная материализация каждый цикл |
| 4 | queued → Reservation+WorkerExecution | ✗ | атомарная транзакция (by design) |
| 5 | worker completion → verifying | ✗ | dispatcher |
| 6 | OS exit → terminalize execution | ✗ | supervision reaper |
| 7 | verifying → CandidateSet + GateRun | ✓ | `close-presentation` + `run-gate` |
| 8 | gate+effect → EffectAttempt | ✓ | `run-effects` |
| 9 | finalize → CellFinalAcceptance | ✓ | `record-final-acceptance` |
| 10 | cell done → NodeRun + flow cursor | ✗ | in-memory возврат из executor |
| 11 | terminal ProcessRun → settle+route | ✓ | `route-lifecycle` |
| 12 | terminal Lifecycle → settle Launch/Order | ✗ | прямой вызов |

**Проверено и снято с подозрений:** отсутствие `settle-process` как отдельного
вида — осознанное решение (комментарий `production-cell-node-executor.ts:1086`):
обязательство на каждую принятую ячейку порождало *невозможные ранние*
обязательства при fan-out. Settlement атомарно пишется флоу-исполнителем на
терминальном узле. **Не дефект.**

Реконсилятор обязательств сам по себе построен корректно: fenced (монотонный
lease-fence, store-minted), idempotent, с типизированным `deferred`, и с
защитой от повторного внешнего эффекта (постусловие проверяется ДО вызова
хендлера — `product-lifecycle-runtime.ts:998`).

---

## 2. ⭐ ПРОВАЛ A — инвариант прогресса (§23) описан, но не реализован

### Что требует модель

```text
live owner       = валидный неистёкший lease/fence владеет следующей мутацией
runnable command = durable-предусловие включает идемпотентную команду ядра
typed wait       = ожидание с источником пробуждения
transition due   = committed-результат ждёт роутинга
```

> *If none applies, the scope is `stalled`. If several contradict one another,
> the scope is `inconsistent_state`.*

### Что в коде

**Классификатора нет.** В рантайме отсутствуют литералы `'stalled'` /
`'inconsistent_state'` — состояние «нетерминальная область без владельца»
не вычисляется, не логируется и не эскалируется.

`maxSteps` (`generic-flow-executor.ts:619`) ограничивает шаги **внутри одного**
вызова `execute()`, но **не число перезаходов** между циклами движка.

### Доказательство на реальных данных

`.factory-docker-runs/python-003-db/factory.sqlite` (прогон 2026-08-14):

```
process_run 3, node 'implement-work-items':
  9004 строк factory_node_runs, ВСЕ event='runtime.paused'
```

Состояние в тот момент:

| Факт | Значение |
|---|---|
| Workplace `…/development-implementation/2d1471042ad261f73145361e` | `loop_state='effect_pending'`, kanban `review_in_progress`, revision 7 |
| EffectReceipt для него | **отсутствует** |
| CellFinalAcceptance для него | **отсутствует** |
| Обязательство `run-effects` | **`completed`, attempt=1** |
| Незавершённых обязательств во всей БД | **0** |

Это буквально `inconsistent_state` по §23: ledger утверждает «переход выполнен»,
Workplace остаётся нетерминальным, **никто не владеет следующей мутацией** — и
цикл крутится 9004 раза без эскалации.

Масштаб явления (перезаходы узлов в реальных прогонах): 13, 18, 23, 24, 27, 40,
45, 49, 59, 70 … 9004.

### Почему это и есть «то проходит, то падает»

Когда все рёбра совпали — цепочка идёт до конца. Когда область попала в
состояние без владельца — **детектора нет**, и завод молча крутится до
вмешательства оператора. Недетерминизм = попал/не попал в окно.

---

## 3. ⭐ ПРОВАЛ B — у эффектов нет durable типизированного исхода

### Что требует модель (§20)

> *Effects perform authorized external changes with exact desired-state identity,
> idempotency key, **durable EffectAttempt** and EffectReceipt.*

```text
accepted GateDecision -> effect_pending -> durable EffectAttempt
   | successful exact EffectReceipt -> CellFinalAcceptance
   | recoverable outcome            -> RecoveryIssue / retry / repair
   | human-required outcome         -> pause
   | policy-terminal outcome        -> failed
```

Четыре различимых исхода + отдельная сущность попытки.

### Что в схеме (текущий `src/schema.ts:1400`)

```sql
CREATE TABLE factory_cell_effect_receipts (
  effect_receipt_ref, workplace_ref, effect_id, candidate_set_ref,
  gate_decision_key, provider_receipt_ref, provider_receipt_digest,
  evidence_snapshot, receipt_digest, created_at
);
```

- **нет колонки исхода** (`outcome`/`status`/`success`) — успех кодируется
  *самим фактом существования строки*;
- **таблицы `factory_effect_attempts` не существует вовсе**.

Следствие: неуспешный эффект **непредставим** как receipt. Он может быть
выражен только как effect-repair issue (появился лишь в ADR-074) либо не
выражен никак. Постусловие `run-effects` проверяет существование строки —
`SELECT 1 … WHERE workplace_ref=? AND gate_decision_key=?` — то есть
**наличие**, а не успешность.

Это ровно та фитнес-функция, которую §27 запрещает нарушать:

> *effect-provider failures flattened into unattributed lifecycle exceptions
> instead of typed outcomes and RecoveryIssues*

**Связь с провалом A:** именно отсутствие типизированного исхода эффекта
оставляет Workplace в `effect_pending` при закрытом обязательстве. B —
механизм, A — отсутствие детектора, который обязан был это поймать.

---

## 4. ПРОВАЛ D — схлопывание «работает» и «ждёт человека»

`production-cell-node-executor.ts:371-382`:

```ts
if (outcomes.some(o => o.paused))  return { runtimeEvent: 'paused', … }; // человек нужен
if (outcomes.some(o => o.pending)) return { runtimeEvent: 'paused', … }; // ВОРКЕР РАБОТАЕТ
```

Два семантически противоположных состояния (`live owner` против `typed wait`
по §23) отдаются одним литералом. Контракт `NodeExecutionResult.runtimeEvent`
знает только `completed | failed | paused` — значения «ещё в работе» нет.

**Что проверено:** Flow **не** сдвигает курсор по `paused` — бросает
`ProcessRunPausedError` (`generic-flow-executor.ts:847`). Потери прогресса нет.
Это дефект **наблюдаемости**, а не корректности: оператор и любой детектор не
могут отличить «завод работает» от «завод стоит». Вместе с провалом A это
делает stall принципиально невидимым.

Модель §19 требует обратного: *«Operator views must present this as active
factory work…, while `paused` with zero workers remains an actual pause»*.

---

## 5. Гипотеза C — ОПРОВЕРГНУТА (фиксирую честно)

Рабочая гипотеза была: `inputBeforeNodeRun` (`generic-flow-executor.ts:1232`)
с 3-го цикла выбирает «предыдущий completed» = **собственную прошлую паузу
узла**, та подставляется в `chainInput`, а `resolveSourceProduction` падает в
fallback на `ctx.input` → fan-out получает собственный манифест → дрейф
workKey → сироты Workplace.

Первые два звена верны: строка на каждый цикл действительно создаётся
(`start()`: `attempt = count+1`), и `manifestProduction` действительно кладёт
`bindings.items` с `id = workKey`, то есть формально проходит `extractItems`.

**Но цепочка рвётся на третьем звене.** `assembleFrameFromDurableNodeRuns`:

```ts
if (run.status !== 'completed' || run.event === 'runtime.paused') continue;
frame.productions[run.nodeId] = restoreProduction(run);
```

Frame регидрируется **по nodeId** и **исключает paused-строки**, а
`resolveSourceProduction` проверяет `frame.productions[sourceBinding]` **до**
fallback'а. Источник fan-out берётся из durable-строки upstream-узла.

Эмпирика подтверждает код, а не гипотезу: в прогоне с 9004 циклами
`development-implementation` имеет **3 workplace / 3 distinct workKey** — дрейфа
нет. Гипотеза снята.

Остаётся мелкое замечание: загрязнение `chainInput` реально существует, но
безвредно ровно потому, что nodeId-ключевой frame имеет приоритет. Это
**незащищённый инвариант** — стоит закрепить ratchet-тестом, чтобы будущая
правка `assembleFrameFromDurableNodeRuns` не сняла защиту молча.

---

## 6. Наблюдение E — амплификация записи NodeRun

`start()` вставляет **новую строку на каждый перезаход** узла. Реальные
значения: 70, 45, 59 … **9004** строк на один узел. Это не про корректность, но:

- безграничный рост таблицы на длинных прогонах;
- `readLastCompleted` / `inputBeforeNodeRun` сканируют растущий набор каждый цикл;
- диагностика тонет: 9004 строки «пауза» вместо одной строки «жду воркера».

---

## 7. Вердикт ревизии

Концепция конвейера **здоровая**: Production Cell как универсальный цикл
качества, разделение материала/провенанса, fenced-обязательства, идемпотентные
хендлеры — всё это спроектировано верно и в основном реализовано верно.

Провал не в концепции, а в **её незамкнутости на двух рёбрах**:

1. **A** — центральный liveness-контракт §23 (единственное, что превращает
   «застрял» в «эскалирован») существует только как текст в markdown;
2. **B** — типизированный исход эффекта, без которого ребро
   `effect_pending → ?` физически не может быть замкнуто.

Оба — не «баги в функции», а **отсутствующие сущности**. Поэтому их не ловит ни
один из 1000+ тестов: нельзя протестировать то, что не объявлено.

### Порядок починки (от концепта, как и просил оператор)

| Приоритет | Что | Почему первым |
|---|---|---|
| **P0** | Ввести durable `EffectAttempt` + типизированный исход эффекта (4 значения §20) | без этого ребро 8→9 нечем замкнуть; это причина наблюдаемого livelock |
| **P1** | Реализовать классификатор прогресса (`live owner / runnable / typed wait / transition due / stalled / inconsistent_state`) как исполняемую функцию над снимком | превращает молчаливый спин в типизированный инцидент; закрывает §23 |
| **P2** | Расщепить `paused` на `waiting`(живой владелец) и `human_required` в `NodeExecutionResult` | без этого классификатор P1 не имеет входных данных |
| **P3** | Ratchet-тест на nodeId-ключевой paused-фильтрованный frame (§5) | защитить инвариант, который сейчас держится неявно |
| **P4** | Не плодить NodeRun-строку на каждый холостой перезаход | снять амплификацию и вернуть читаемость логов |

P0+P1 закрывают наблюдённый класс «9004 холостых цикла» целиком: P0 даёт
факт, P1 — его обнаружение и эскалацию.

---

# ЧАСТЬ II — Выполнение: критерий готовности и результат

## Критерий «цель достигнута» (чтобы не рефакторить бесконечно)

Выводится из §23: *«Every enabled internal transition eventually commits, loses a
fenced race, or produces a typed durable wait/terminal incident within its
declared cycle budget.»* Пять проверяемых условий:

| # | Условие | Статус | Доказательство |
|---|---|---|---|
| 1 | Классификация исполнима для любого durable-снимка | ✅ | `progress-classification.ts` + 13/13 тестов на все loop-состояния |
| 2 | Молчания нет: вне здоровых классов → типизированный инцидент | ✅ | `[progress-invariant]` в цикле движка (`product-lifecycle-runtime.ts`) |
| 3 | Эффект типизирован: durable попытка + 4 исхода §20 | ✅ | `factory_effect_attempts` (immutable) + запись во всех ветвях исхода |
| 4 | Регресс механически запрещён | ✅ | 6 фитнес-функций `conveyor-completeness-ratchets.test.mjs` |
| 5 | Проверено на реальных данных прошлых прогонов | ✅ | 10 архивных БД: найден ровно 1 `stalled` (тот самый), 19 здоровых |

**Цель достигнута.** Дальнейшие улучшения (декомпозиция монстров, покрытие
остальных 7 недюрабельных рёбер) — отдельные задачи с собственными критериями,
а не продолжение этой.

## Что сделано

### Провал A — инвариант прогресса стал исполняемым

- `src/application/progress/progress-classification.ts` — чистая функция:
  `live_owner | runnable_command | typed_wait | transition_due | stalled |
  inconsistent_state`, каждый вывод с причиной и точными refs-уликами.
- `src/application/progress/sqlite-progress-reader.ts` — факты **только** из
  авторитетных таблиц. Владелец мутации читается из
  `factory_workplaces.active_reservation_ref` (Workplace сам объявляет актора),
  а не через проекцию `tasks`.
- Подключено в цикл движка: раз в 30 эпизодов, лог по изменению класса +
  строка `RECOVERED` при выздоровлении.

**Проверка на истории:** прогнано по 10 архивным БД. Найден ровно один
проблемный scope — тот самый `python-003`, и с точной причиной:
*«effect_pending но ни одной EffectAttempt и ни одного открытого обязательства»*.
Остальные 19 нетерминальных областей классифицированы здоровыми — то есть
классификатор различает, а не кричит.

### Провал B — у эффекта появился durable типизированный исход

- Таблица `factory_effect_attempts` (append-only, триггеры неизменяемости),
  ключ идемпотентности = acceptance digest, `attempt_no` на одно желаемое
  состояние.
- `recordEffectAttempt` пишется **во всех** ветвях, включая `pending` — раньше
  эта ветвь не оставляла durable-следа вообще, что и делало livelock невидимым.
- Снимок схемы обновлён осознанно (96 → 97 таблиц), как требует раччет.

### Четыре претензии

| # | Претензия | Решение |
|---|---|---|
| 1 | newest-wins выбор капсулы | Типизированный исход `miss/hit/conflict`. Расхождение → улики ADR-080 §2 → **fail closed** (§15 запрещает звать платную модель в той же попытке); улики делают капсулы ineligible → следующая попытка законно уходит на модель |
| 2 | `pending`/`paused` схлопнуты | Добавлен `NodePauseKind`: `worker_active` (живой владелец) vs `human_required` (ожидание человека), проброшен в `ProcessRunPausedError` |
| 3 | Строка NodeRun на каждый холостой цикл | Пауза = продолжение той же попытки: `startV2` переиспользует строку. **Сквозной E2E ускорился вдвое** (25.7s → 11.9s) — исчез O(циклов) скан |
| 4 | Монстр-файлы | **Осознанно отложено.** Массовая декомпозиция сейчас — крупное механическое изменение без функционального выигрыша, которое затруднило бы атрибуцию 38 унаследованных падений. Вместо этого новая логика вынесена в новый модуль `src/application/progress/`, а не дописана в монстра — это устойчивый паттерн выхода из проблемы |

### Важная самокоррекция

Первая версия фикса №1 деградировала конфликт в промах **внутри той же
попытки**. Это нарушает §15 («не звать платную модель в той же попытке после
испорченного хита»). Kernel-теорема K8/C была права; решение исправлено на
fail-closed. Типизированный исход при этом сохранён — он строго лучше
строкового кода ошибки.

## Состояние тестов

| Набор | Было (база после мержа) | Стало |
|---|---|---|
| architecture | 289/291 | **291/291** |
| replay | 24/24 | **24/24** |
| factory-cycle | 23/23 | **23/23** |
| golden-path E2E | ✅ | **✅** |
| w9-02 E2E (полный прогон) | ✅ | **✅ и вдвое быстрее** |
| infrastructure | 324/336 | **327/336** (−3 моих) |
| lifecycle | 109/122 | 109/122 |
| process-modules | 1019/1035 | 1019/1035 |

**Регрессий ноль** — проверено эмпирически: базовая линия собрана в отдельном
worktree на коммите мержа и дала ровно те же числа падений.

Оставшиеся **38 падений унаследованы от мержа** (семантическая развилка saga4 и
kernel), не связаны с этой работой и не трогались: `outbox`
(`EXECUTION_FENCE_REQUIRED`), `appsvc`, learn-policy, accessible-counter и др.
Это следующая отдельная задача.

## Следующие шаги (не входят в этот критерий)

1. Разобрать 38 унаследованных падений мержа.
2. **Этап 2 по замыслу оператора:** нарастить библиотеку ЛЛМ-имитаторов
   (тексты + вызовы тулов) на существующем scripted-seam до покрытия всех
   outcome-рёбер жизненного цикла. Инфраструктура уже есть и построена верно —
   подменяет только inference-спавн.
3. Аудит единства ядра цехов: проверить, что цех = чистая декларация, а
   `development` не содержит собственной механики.
