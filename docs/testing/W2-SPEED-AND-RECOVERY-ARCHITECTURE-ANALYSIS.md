# W2: почему формализация занимает часы и почему завод не может самовосстанавливаться — архитектурный анализ

Дата: 2026-08-15 (вечер). Автор: ZCode / архитектурный аналитик (read-only сессия).
Источники: `.factory-testbed/factory.sqlite` (только чтение, better-sqlite3 readonly),
`/tmp/saga-engine-*.log` (79 логов за день), рабочее дерево `src/` (включая
незакоммиченные фиксы дня), `git log`, документы CONVEYOR-MENTAL-MODEL / ADR-053 /
WORKSHOP-BUGS / WORKSHOP-TEST-PLAN / WORKSHOP-JOURNAL.

Позиция документа: **расширение ADR-053, не повторение.** ADR-053 ставит диагноз
«владелец материала — execution, а не Workplace/Revision». Ниже показано, что тот же
дефект «strangler without strangulation» воспроизводится ещё на двух осях, на которых
ADR-053 не сфокусирован: **(1) область чтения (epic vs lifecycle)** и **(2) смерть
владельца (executor vs owner)**. Именно эти две оси съели день 2026-08-15.

---

## 1. Главные числа (одним экраном)

| Метрика | Значение | Источник |
|---|---|---|
| P02 (stopwatch, XS): elapsed от первого старта W2 до последней паузы | **8ч 25м 32с** (09:23:26→17:48:58 UTC) | factory_lifecycle_runs 2/21/25/26 |
| P02: суммарное «активное» время 4 попыток | **97м 04с** | сумма окон lifecycles |
| P02: чистое время работы модели (LM) за все попытки | **35м 33с = 7% elapsed** | worker_executions |
| P02: здоровый пол W2 для XS (bottom-up, rate=1) | **~31–36м** | §6.4 |
| W2-окно завода (08:46→17:49): реальная работа LM | **339м из 543м = 62% duty** | worker_executions |
| W2-партия: pass / fail / не начинались | **6 / 6 / 8** | WORKSHOP-JOURNAL |
| Причина 5 из 6 fail-ов | `verifying Workplace has no producer reservation` (lifecycle 9, 10, 11, 12, 21) | factory_lifecycle_runs.error |
| Zombie-обязательства (pending у мёртвых/паркованных lifecycle) | **38 шт., суммарно 32 834 повторных sweep-попыток, max 1603 на одно** | factory_transition_obligations |
| Replay-капсулы P02 с 2+ капсулами на один replay_key | **4 ключа** → `REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS` | factory_replay_capsules |
| Цикл движка во время kernel-стойла | **медиана 5.57с/цикл**, +1 полный checkpoint БД на цикл | saga-engine-1786807504436.log |
| Движков (логов) за день / на один P02 | 79 / ≥15 | /tmp/saga-engine-*.log |
| Потерянные воркеры за день | 24 из 203 executions (11.8%) | worker_executions.state |

**Вывод раздела в одну строку:** физика W2 для XS (10 LM-задач ≈ 30 мин) не является
проблемой; 4+ часа — это на 93% не LM-время, а парковки между раундами, вычисление
смертей lifecycle и ручное/автоматическое восстановление, которое само является
главным убийцей.

---

## 2. Автопсия P02: четыре lifecycle-рана вместо одного

### 2.1. Карта дня (все времена UTC)

| Окно | Время | Длительность | Что произошло |
|---|---|---|---|
| W1 (lc 2) | 07:30:27→07:33:44 | 3м17с | Discovery pass; движок успел заклеймить первую карточку W2 (dirty:1) |
| **Парковка на границе** | 07:33:44→09:23:26 | **1ч49м42с** | harness-стоп W1 убил воркера task 6; execution `lost` («OS process is not alive»), run стоит до resume W2 |
| W2-попытка 1 (lc 2) | 09:23:26→09:34:50 | **11м24с** | 6 воркеров; терминальный fail `FORMALIZATION_ACCEPTANCE_HASH_DRIFT: artifact 37` (TB-6, гонка repair-edit vs gate-accept) |
| Очередь W2 (P05–P12) | 09:34:50→15:25:06 | 5ч50м16с | завод работал над другими проектами; P02 «в очереди на реран» |
| W2-попытка 2 (lc 21) | 15:25:06→15:58:54 | **33м48с** | replay-воркер отработал за 1с; дальше 33м kernel-verifying-стойла (цикл 5.6с) → engine-start adoption гасит резервацию → фатал `verifying Workplace has no producer reservation` |
| W2-попытка 3 (lc 25) | 16:16:14→16:54:52 | **38м38с** |Discovery за 2м14с (капсулы), 5 цехов формализации пройдены, 12/12 карточек done, все артефакты accepted → сэттлмент вынес **`formalization-inconsistent: tasks-not-ready #73,#74,#75`** (мёртвые таски рана 2 отравили гейт) |
| W2-попытка 4 (lc 26) | 17:35:44→17:48:58+ | **13м14с+** | фатал `REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS` на диспетчеризации → spawn_failed-резервация держит workplace в `running` → после фикса binder: replay падает `FINAL_PRESENTATION_FENCE_MISMATCH` → empty-queue streak → пауза «requires explicit resume». В 17:53:07 очередной движок снова крутит task 171 |
| **Итого elapsed / актив** | 09:23:26→17:48:58 | **8ч25м32с / 97м04с** | |

### 2.2. Попытка 1 (lc 2): где были 11м24с

| Таска | Роль | Execution | Время | Длит. |
|---|---|---|---|---|
| #6 | author PRD (перезапуск после reap) | e0bb8a66 | 09:23:26→09:28:12 | 285с |
| #72 | reviewer PRD | 54cd3c18 | 09:28:13→09:28:58 | 44с |
| #73 | author UC | 92bc63f4 | 09:29:03→09:30:59 | 116с |
| #74 | reviewer UC → REPAIR_REQUIRED | f37c17f0 | 09:31:01→09:32:10 | 68с |
| #73 | author UC (repair) | 380dbd8b | 09:32:13→09:34:01 | 108с |
| #75 | reviewer UC (2-й accept) | f4b8dffa | 09:34:02→09:34:49 | 47с |

Авторинг 509с + ревью 159с + накладные 16с. **98% окна — полезная работа**, рана
убита на последнем шаге сэттлмента (замороженный хэш базлайна не совпал с
отредактированным между двумя accept-гейтами черновиком UC — TB-6).

### 2.3. Попытка 3 (lc 25): где были 38м38с — эталонная декомпозиция

| Фаза | Время | Длительность |
|---|---|---|
| discovery settlement (kernel) | 16:16:43→16:18:28 | 1м45с |
| #147/#148 (discovery, **replay**) | 16:16:14–16:16:43 | ~0с |
| #149/#150 (product-contract, **replay**) | 16:18:34–16:18:56 | ~0с |
| #152 author UC (LM) | 16:18:58→16:23:02 | 4м04с |
| #159 reviewer UC (LM) | 16:23:16→16:24:30 | 1м14с |
| **Смерть движка: `LifecycleRun 25 is already owned by another executor`** | 16:24:35 | — |
| **Окно без движка** | 16:24:34→16:32:38 | **8м04с** |
| #161 author AC (LM) | 16:32:38→16:37:13 | 4м35с |
| #166 reviewer AC | 16:37:25→16:39:10 | 1м45с |
| #167 author reconciliation | 16:39:40→16:41:13 | 1м33с |
| #168 reviewer reconciliation | 16:41:27→16:42:01 | 0м34с |
| #169 author SRS (LM) | 16:42:39→16:52:31 | 9м52с |
| #170 reviewer SRS | 16:52:56→16:53:48 | 0м52с |
| freeze+settle (kernel) | 16:53:48→16:54:52 | 1м04с |

Итого: **авторинг 20м04с + ревью 4м25с + kernel 2м49с + окно мёртвого движка 8м04с +
диспетчерские зазоры ~2м + неучтённое ~44с.** Вся полезная работа рана (24м29с LM)
была обнулена одной строкой вердикта сэттлмента:

```
certificate:30 → decision=inconsistent, reason_codes=["tasks-not-ready"],
rationale="Formalization tasks not ready: #73, #74, #75"
```

#73/#74/#75 — таски МЁРТВОГО рана 2. При этом у рана 25 все 12 карточек done,
все 5 workplaces terminal/accepted, baseline заморожен (domain.frozen, node_run 38923).

### 2.4. Попытка 2 (lc 21): 33м48с чистой патологии восстановления

Лог `/tmp/saga-engine-1786807504436.log` (15:25:04):
- 15:25:09 — replay-воркер task 139 завершён (exit 0, мгновенно);
- далее 83 цикла `kernel-owned workplace progress pending {"verifying":1}` с медианой
  **5.57с/цикл**, каждый цикл = полный runEpisode + **checkpoint всей БД**
  (checkpoint-4-4-26 … 108) + sweep 256 обязательств;
- движок перезапускают (лог ротирован), в 15:56 — четыре старта подряд
  (`Cannot find module 'D:\…\1'` — артефакт ручного запуска), наконец 15:58:50:
  `engine-start adoption: adopted=1 … state=verifying` → cycle 1 → **fatal**:
  `verifying Workplace has no producer reservation` → lifecycle 21 терминально мёртв.

Причинно-следственная связь «adoption → фатал» доказана порядком строк в одном
логе: adoption очистил `active_reservation_ref`, который исполнителю нужен как
указатель на автора вклада (см. §5 D4). Полезной работы в этой попытке — 1 секунда.

### 2.5. Попытка 4 (lc 26): тупик, в котором P02 остался

`/tmp/saga-engine-1786815339002.log` (17:35:39) — движок уже с новым кодом burial:
- `engine-start lifecycle burial: buried=17 workplaces_released=7` — каскад смерти
  сработал, 17 обязательств мёртвых lifecycle abandoned, 7 workplace отпущены;
- тут же на диспетчеризации: **фатал `REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS:
  07e5cdd9…`** (`replay-claim-binder.js:149`, старый dist) → движок умирает,
  оставив spawn_failed-резервацию на workplace/55 в состоянии `running`;
- 17:42:50 — движок с новым binder: `[replay-claim-binder] 2 capsules share
  replay_key 07e5cdd9… — binding newest (created_at 2026-08-15 16:16:31)`; replay
  выбранной капсулы падает `CAPSULE_REPLAY_PRODUCT_FAILED … FINAL_PRESENTATION_FENCE_MISMATCH`
  → execution `lost`, карточка возвращается, но empty-queue streak 3/3 → пауза;
- 17:46, 17:48 — рестарты: repair spawn_failed срабатывает
  (`repaired spawn-failed reservation … state=running`), но workplace уже
  «requires explicit resume» — автоматический прогон останавливается в paused;
- 17:53:07 — ещё один движок, task 171 снова running. **P02 не прошёл W2 за день.**

---

## 3. Куда уходят часы: сводная бухгалтерия категорий

### 3.1. P02, распределение 8ч25м32с elapsed

| Категория | Время | Доля | Комментарий |
|---|---|---|---|
| LM-авторинг (реальные runs) | 28м29с | 5.6% | 9 авторских runs (вкл. repair) |
| LM-ревью | 6м44с | 1.3% | 7 ревью-runs |
| Kernel-фазы (settle/freeze/baseline) | ~6м | 1.2% | discovery settle 1м45с ×2, freeze+settle ×2 |
| Диспетчерские зазоры (task→task) | ~4м | 0.8% | 9–38с на проекцию следующего узла |
| Replay-диспетчеризация (4 таски) | ~0с | 0% | единственный быстрый механизм |
| Recovery-патология внутри попыток | 41м52с | 8.3% | 33м47с verifying-стойла + 8м04с окно мёртвого движка |
| Парковка на границе W1→W2 | 1ч49м42с | 21.0% | убитый на границе воркер + ожидание очереди W2 |
| Очередь/testbed-дисциплина и ручные рестарты | 5ч07м | 60.7% | P05–P12 + диагностика + ребилды между попытками |

### 3.2. Уровень завода, W2-окно 08:46→17:49 (543м)

| Категория | Время |
|---|---|
| Реальный LM (145 exited-воркеров, среднее 140с, медиана 91с) | 339м (62%) |
| Replay-воркеры (24 шт.) | ~0 |
| Всё остальное: kernel, зазоры, стойла, рестарты, паузы | 204м (38%) |

Шесть чистых pass W2 длились 19–42м (медиана ~32м) — это и есть здоровая
производительность конвейера на qwen3.6-35b при rate=1. Ни один из 6 fail-ов
не связан со скоростью или качеством модели: 5× `no producer reservation`
(дефект восстановления), 1× TB-8 (regex грамматики AC), 1× TB-6 (гонка гейта).

---

## 4. Структурные усилители: сколько задач порождает W2 и почему

### 4.1. Фиксированный граф цеха — 10 LM-задач на проект любого тира

`src/process-modules/modules/formalization/formalization-process-module.ts:147-248`:
5 reviewed-cells (product-contract → use-cases → acceptance-contract →
reconciliation → [kernel freeze-baseline] → architecture-contract) + 2 kernel-узла
(freeze-acceptance-baseline, settle-formalization). Каждая reviewed-cell =
author-таска + reviewer-таска (`reviewedCell()`, :89-121). **Итого 10 воркеров
для XS ровно столько же, сколько для XXL** — масштабирование нагрузки происходит
внутри задач (объём артефактов), а не в числе задач. Рост «14→15→…→20» у P02 — это
+2 таски на цех (author+reviewer) по мере прохождения графа плюс перенос
накопленных тасок прошлых ранов (21 таска на эпике после 4 ранов).

### 4.2. Ограничен ли review-цикл?

Да, формально: `FORMALIZATION_RECOVERY_MAX_ATTEMPTS = 5` (тот же файл, :51),
`onExhausted: 'pause'`. Ремонт-цикл не бесконечен, но каждый отказ ревьюера
стоит author+reviewer пару ≈ 6–7 мин на XS (116+68+108+47с в попытке 1).
Фактические циклы author→review за день: 13 author / 13 reviewer candidate-sets
на use-cases по всем проектам, 16/13 на product-contract (лишние author- попытки —
потерянные/переспавненные воркеры), т.е. в среднем 1.0–1.2 прохода на цех.
**Раздувание времени даёт не review-цикл, а потеря целых ранов.**

### 4.3. Стойла движка как множитель

Kernel-verifying-стойло (`src/orchestrate-cli.ts:540-551`): цикл «resume lifecycle»
со sleep 250мс, но фактическая итерация 5.57с (runEpisode + checkpoint + sweep).
Цикл **не ограничен** — TB-9 наблюдал 4600+ попыток за 57 минут. Каждый цикл пишет:
checkpoint всей БД (при включённом `SAGA_FACTORY_CHECKPOINT_STORE`,
`src/orchestrate-cli.ts:344-370`), node_run `runtime.paused`-событие (268 шт. на
процесс 54, 84 шт. на процесс 47), lease/defer-обновления обязательств.

---

## 5. Инвентаризация механизмов восстановления: почему «их куча, а завод не встаёт»

### 5.1. Полный реестр (что лечит / что не лечит / цена)

| # | Механизм | Код | Какую смерть лечит | Что НЕ лечит | Цена работы |
|---|---|---|---|---|---|
| 1 | Supervision reaper | `src/infrastructure/work/worker-supervision-service.ts:105,191` (sweep 30с) | смерть OS-процесса воркера: reap → `lost` → release → реплани | следующую фазу (verifying) чужого/умершего движка; P10–P12: release стёр указатель продюсера → фатал | 30с лаг + 1 sweep/30с |
| 2 | Engine-start adoption | `src/app/engine-start-adoption.ts:19-34` (+фикс дня) | kernel-состояния verifying/effect_pending c терминальным execution и receipt | до фикса дня: САМ УБИВАЛ lifecycle (очистка резервации, §2.4); spawn_failed-резервации — починлено сегодня же | 1 проход на старте движка |
| 3 | Engine-start lifecycle burial | `src/app/engine-start-lifecycle-burial.ts` (новый, 226 строк) | смерть lifecycle: abandon обязательств, release kernel-workplaces, cancel тасков мёртвых ранов | запускается только на старте движка, не в момент терминализации; paused (не failed) lifecycle не хоронит | 1 проход на старте движка |
| 4 | Obligation reconciler | `src/process-modules/application/transition-obligation-reconciler.ts:121-190`; вызов `src/app/product-lifecycle-runtime.ts:929-937` (batch 256) | потерянные cross-machine handoff'ы (crash между машинами) | обязательства без классификации смерти владельца: 38 zombie × до 1603 перепопыток (32 834 sweep за день); голодание при ORDER BY created_at (исправлено сегодня на round-robin, `sqlite-transition-obligation-ledger.ts:208-225`) | sweep каждый цикл движка (~5.6с) |
| 5 | Replay-капсулы | `src/infrastructure/replay/*` (binder :197-, repo :350-) | повторное выполнение семантически той же работы (rerun после fail) | до фикса дня: 2 капсулы на ключ = фатал AMBIGUOUS; после: newest-wins, но `FINAL_PRESENTATION_FENCE_MISMATCH` не имеет пути invalidate/Regenerate → P02 запаркован навсегда | ~0 при hit |
| 6 | Checkpoints | `src/orchestrate-cli.ts:344-370` | восстановление операционного состояния рана | ничего не «двигает»; на стойле = полный снапшот БД каждые 5.6с (83 шт. за 7.7м) | I/O на каждый цикл |
| 7 | Empty-queue streak | `src/orchestrate-cli.ts:304-311,553-567` (MAX=3) | бесконечный спин по пустой очереди | ситуацию «очередь пуста, но durable-работа есть» — движок выходит, harness обязан перезапустить (17:43, 17:46) | — |
| 8 | Kernel-progress pending loop | `src/orchestrate-cli.ts:540-551` (250мс) | своевременный re-drive verifying/effect_pending | случай, когда re-drive детерминированно не продвигается → бесконечный хот-цикл 5.6с (TB-9: 57м) | CPU+I/O навсегда |
| 9 | Pre-spawn recovery | `src/app/automatic-pre-spawn-recovery.ts:55-` | ровно один класс: `REPOSITORY_DESK_BASE_MISMATCH` | все остальные причины паузы | 1 проход |
| 10 | Worker-loss resume | `src/app/factory-start.ts:1207-` (`resumeWorkerLossWorkplace`) | потерянный воркер на workplace в repair-budget pause | kernel-owned verifying без резервации | ручной вызов harness'ом |
| 11 | Lifecycle-lease (busy) | `src/process-modules/application/lifecycle-orchestrator.ts:140-143` | двойной запуск lifecycle | трактует гонку как фатал движка → 8м04с окно (§2.3); нет ожидания/backoff | — |
| 12 | Launch-контроллер / respawn супервизор трекера | `FACTORY_LAUNCH_ALREADY_CONTROLLED`, TB-7 | перезапуск движков | сам устраивает гонки переспавна против 30с lease-истечения (25м у P04) | — |
| 13 | Harness watchdog (testbed) | тест-план §9, KI-1 | спин/стойло движка >3м | убивает движок → порождает lost-воркеров и zombie-состояния (цикл «лечение порождает болезнь») | — |

### 5.2. Ответ на вопрос оператора «почему куча рестарт-механизмов не восстанавливает»

**Все 13 механизмов лечат смерть исполнителя (executor/process). Ни один (до
сегодняшнего burial) не лечит смерть владельца (lifecycle/workplace).** Умирал
lifecycle — оставались жить: открытые обязательства (38 zombie, 32 834 перепопыток),
kernel-workplaces в verifying/effect_pending навсегда, открытые таски
(in_progress/review_in_progress у мёртвых ранов — 15+1 шт. к вечеру), капсулы
с неоднозначным авторитетом. Хуже того, механизмы №1 и №2 **сами производили
ownerless-состояния**: и reaper-release, и adoption очищали `active_reservation_ref`,
который ядро затем требует как contributor-pointer → фатал `verifying Workplace has
no producer reservation` → **5 терминально убитых lifecycle за день** (9, 10, 11,
12, 21 — P09, P10, P11, P12, P02).

Подсчёт швов дня по классам: из 6 багов дня (a)–(f): (a) zombie-обязательства
мёртвых lifecycle, (b) adoption убил владельческий указатель, (c) epic-scope
чтение гейта, (d) отсутствие death-cascade, (e) капсулы без lifecycle-границы,
(f) spawn_failed-резервация без владельца. **Все шесть — варианты ровно одного
дефекта: состояние переживает своего владельца, и ни один recovery-проход не
владеет фактом смерти владельца.** Это ADR-053, спроецированный с «execution vs
workplace» на «epic vs lifecycle» и «executor death vs owner death».

---

## 6. Корневые дефекты (ранжировано по ущербу дня) и рекомендации

### 6.1. Рейтинг дефектов

**D1. Нет каскада смерти владельца (lifecycle/workplace).**
Улика: 5 убитых lifecycle одной ошибкой; 38 zombie-обязательств; workplace/4
(effect_pending рана 2) «отпущен» только в 17:35:39 — через 8ч после смерти рана.
Код: burial появился только сегодня и только на engine-start.

**D2. Epic-scoped чтения вместо lifecycle-scoped.**
Улика: certificate:30 (`tasks-not-ready #73,#74,#75` — таски рана 2 отравили
сэттлмент рана 25). Код: `areTasksReady(epicId)` → исправлено сегодня на
`areTasksReady(epicId, lifecycleRunId)`, `sqlite-formalization-kernel.ts:261-293`.
Следующая граница того же класса (по анализу fix-агента): `readAcceptedArtifacts`,
baseline, traceability — читают накопление эпика.

**D3. Fail-closed фаталы на уровне движка вместо типизированных исходов.**
Улика: `REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS` уронил ВЕСЬ движок на диспетчеризации
(17:35:44, стек: bindReplayToClaim→assignTask→startOne→main); `LifecycleRunBusyError`
уронил движок 16:24:35 → окно 8м04с; `no producer reservation` уронил lifecycle.
Каждый фатал = минимум потерянный такт + порождение новых ownerless-состояний.

**D4. Recovery-проходы уничтожают указатели, которыми не владеют.**
Улика: adoption (и release у reaper) чистил `active_reservation_ref`, который
исполнитель читает как contributor-pointer. Это зеркальное отражение ADR-053:
«effect читает последний execution» ↔ «recovery переписывает состояние, чей
авторитет принадлежит ревизии стола». Фикс дня сохраняет резервацию — правильно.

**D5. Небоскрёб цикла движка: неограниченный kernel-progress spin + checkpoint
на каждый цикл + sweep всех обязательств.**
Улика: 5.57с/цикл медиана, 83 checkpoint за 462с стойла; TB-9 — 4600+ paused;
TB-2 (busy-spin better-sqlite3 на главном потоке) — та же família: движок в
синхронном коде не может даже заметить собственную смерть.

**D6. Капсульный авторитет не переживает рераны.**
Улика: 4 replay-ключа P02 с 2 капсулами; после newest-wins — FENCE_MISMATCH без
пути инвалидации: завод не может ни забыть капсулу, ни принудительно regenerate.

**D7. Протокол границы раундов убивает воркеров (testbed-уровень).**
Улика: dirty:1 у 18/20 проектов на W1→W2; 1ч49м42с парковки P02; каждый убитый
граничный воркер = lost-execution + verifying-workplace — вход для D1/D4.

Отдельно: **аномалия конфигурации** — движки 16:18 и 17:35 стартовали с
`concurrency=2` (логи: `starting project=4 epic=4 concurrency=2`) при контрольной
строке `concurrency=1, model_concurrency_limit=1`
(`effectiveConcurrency = min(c, limit)`,
`src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts:88`).
Двойной параллелизм — топливо для LifecycleRunBusy-гонки (§2.3).

### 6.2. Рекомендации — слой 0: тестбед (часы, без кода завода)

| Действие | Убивает | Оценка |
|---|---|---|
| Один движок на эпик: единый лаунчер, запрет ручных запусков, проверка `engine_pid` перед спавном; зафиксировать concurrency=1 везде | гонку 16:24 (D3-топливо) | 2–3ч |
| Graceful drain на границе раунда вместо kill: остановка dispatch, ожидание текущей карточки | D7, вход в D1/D4 | 2–4ч (harness) |
| Выключить/событийно ограничить `SAGA_FACTORY_CHECKPOINT_STORE` (checkpoint только при смене durable-состояния) | D5 (I/O-половину стойла) | 1ч (конфиг) |
| Watchdog: вместо «стойло>3м → kill» сначала типизированный зонд (какая машина не продвинулась) | D5, цикл «лечение порождает болезнь» | 2ч |

### 6.3. Рекомендации — слой 1: швы кода (1–3 дня каждая)

1. **Типизация фаталов диспетчеризации** (D3): `bindReplayToClaim`/`assignTask`
   возвращают `{assigned|capsule_ineligible|at_capacity|…}`; неоднозначная капсула
   → пометить ineligible → обычный модельный воркер. Движок не имеет права умирать
   от одного назначения. Место: `src/infrastructure/replay/replay-claim-binder.ts:197+`,
   `src/app/dispatch-loop.ts:27+`.
2. **Bounded kernel-progress spin** (D5): N=10 циклов без изменения durable-состояния
   → типизированный `stalled`-инцидент + выход с кодом «требует оператора», без
   checkpoint'ов на неизменённых циклах. Место: `src/orchestrate-cli.ts:540-551`.
3. **Reconciler не сканирует мёртвых владельцев** (D1, дешёвое дополнение к burial):
   `findReady` фильтрует по активному lifecycle (JOIN через subject_ref → process_run
   → stage_run), paused-раны получают typed wait, а не перепопытки каждые 5.6с.
   Место: `sqlite-transition-obligation-ledger.ts:208+`.
4. **Каскад смерти в момент терминализации** (D1): терминальный статус lifecycle в
   одной транзакции abandons обязательства + отпускает kernel-workplaces + cancel'ит
   таски (сегодня это делает только следующий engine-start). Место: lifecycle
   settlement, рядом с `route-lifecycle` handler.
5. **Lifecycle-scope ВСЕХ epic-чтений W2** (D2): readAcceptedArtifacts / baseline /
   traceability / dispatch-подстраховки — по цепочке
   task.workplace_ref→process_run_id→stage_run.lifecycle_run_id
   (паттерн уже в `readOwningLifecycleRunId`, `sqlite-formalization-kernel.ts:313-327`).
6. **Путь инвалидации капсулы** (D6): команда Regenerate/invalidate на
   replay_key (+причина), которая делает все капсулы ключа ineligible; FENCE_MISMATCH
   при replay → не `lost`-воркер, а ineligible + модельный fallback.

### 6.4. Рекомендации — слой 2: контракт конвейера (ADR-053 cutover)

Это фиксус ADR-053, сюда добавляются два требования, прямо вытекающих из дня:

- **Obligation/Workplace обязаны нести lifecycle_run_id** как индексируемый
  owner-column: «обязательство живёт не дольше владельца» становится
  инвариантом L2, а не свойством конкретного sweep-запроса.
- **Death-cascade — первоклассный переход** в таблице синхронизации
  (CONVEYOR-MENTAL-MODEL §23): строка «terminal LifecycleRun exists → settle
  LaunchRequest and FactoryOrder leaf projection» дополняется «→ abandon open
  obligations, release kernel-owned workplaces, cancel open tasks».
- WorkplaceProductionRevision как единственный материальный авторитет убивает D4
  классически: recovery больше не может стереть то, чем не владеет.

### 6.5. Сколько будет стоить W2 для XS после слоя 0+1 (без cutover)

Bottom-up при rate=1 (замеры дня): авторинг XS = 285+243+275+93+591 ≈ 24.8м;
ревью = 44+74+104+34+51 ≈ 5.1м; kernel ≈ 3м; диспетчерские зазоры ≈ 2м;
средневзвешенно на repair-циклы (наблюдаемая частота ~1 доп. пара на 2 проекта)
+2м. **Итого ≈ 35–37м чистого прогона; с капсульным replay первого цеха (как в
ране 25) ≈ 30–32м.** То есть реалистичная цель: **с «4+ часов» до ~30–35 минут**
(×7–8), целиком за счёт ликвидации recovery-патологии; дальше режет только
модель/параллелизм (например, ревьюер на втором слоте LM Studio — ещё −4–5м).

Гарантия результата измерима: pass-раны дня уже сегодня укладываются в 19–42м —
значит достаточно перестать терять раны. Порог Go/No-Go W2→W3 при текущем
состоянии (6/12) не пройден не из-за модели, а из-за D1–D4.

---

## 7. Приложение: улики с координатами

- Сертификат отравленного сэттлмента: `factory_process_outcome_certificates` id=30
  (`reason_codes=["tasks-not-ready"]`, rationale `#73, #74, #75`; process_run 54).
- Zombie-обязательства: `factory_transition_obligations` state=pending — 38 строк,
  top-attempt 1603 (`gate-accepted:decision:gate-run:130bbf9f…:run-effects`,
  workplace/8, создано 10:30:42, обновлялось до 17:48:52).
- Двойные капсулы P02: `factory_replay_capsules` replay_key in
  {07e5cdd9…, 4fa58a97…, 328b6746…, 9d2c147f…} — по 2 капсулы (07:32/16:16 и
  09:29/16:18).
- Логи: verifying-стойло — `/tmp/saga-engine-1786807504436.log` (15:25);
  adoption-фатал — `/tmp/saga-engine-4-1786809530812.log` (15:58);
  LifecycleRunBusy — `/tmp/saga-engine-4-1786810708111.log` (16:18–16:24);
  capsule-ambiguuous фатал + burial — `/tmp/saga-engine-1786815339002.log` (17:35);
  spawn-failed repair — `/tmp/saga-engine-4-1786816132334.log` (17:48).
- Незакоммиченные фиксы дня (рабочее дерево): ledger round-robin+abandon
  (`sqlite-transition-obligation-ledger.ts`), lifecycle-scoped гейт
  (`sqlite-formalization-kernel.ts`), retention резервации в adoption
  (`engine-start-adoption.ts`), burial (новый `engine-start-lifecycle-burial.ts`),
  newest-wins капсулы (`replay-claim-binder.ts`, `sqlite-replay-capsule-repository.ts`),
  spawn_failed repair. **Сборки дня были смешанными: раны 25/26 частично
  исполняли уже новый код** — чем и объясняется, что burial виден в 17:35,
  а фатал binder'а — ещё старый.
