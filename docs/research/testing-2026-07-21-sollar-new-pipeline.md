# Отчёт о тестировании saga-mcp — Sollar, новый pipeline (ADR-014)

**Дата:** 2026-07-21
**Эпизод:** REQ-001-Sollar (project_id=1, epic_id=1)
**Задача продукта:** «Расчёт баллистических ракет для вывода спутников связи — визуализация и калькулятор траектории на веб-форме. Полёт на Луну и Марс, с орбитами планет Солнечной системы.»
**Модель:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, локально, 2×RTX 3090)
**Конфигурация engine:** concurrency=1, ctx=262144 (CLAUDE_CODE_MAX_CONTEXT_TOKENS fix)
**Baseline для сравнения:** Cannon (та же модель, ADR-013 pipeline) — **661/1000** в `audit-2026-07-20-cannon-1000-score.md`

**Назначение:** единый отчёт по тестированию нового пайплайна. Все кейсы, наблюдения, ложные тревоги, находки — в этом документе. Финальный 1000-score аудит будет в отдельном файле по итогам полного прогона.

---

## 0. Контекст тестирования

Это **A/B-сравнение** нового pipeline (ADR-014: reorder SRS after AC + Complexity Gate + DECOMP + recovery + autonomous-recovery + CLAUDE_CODE_MAX_CONTEXT_TOKENS fix) против baseline Cannon (ADR-013 pipeline).

**Условия эксперимента** (параметры зафиксированы):
- Та же модель: qwen3.6-35b-a3b@q4_k_xl
- Тот же engine_concurrency=1
- Тот же контекст 262144
- Тот же тип задачи: pure-frontend образовательный веб-калькулятор с визуализацией
- Тот же стенд: 2×RTX 3090, LM Studio, tracker-view @ :4321, saga.db @ `~/.zcode/saga.db`

**Изменилось vs Cannon:**
- Pipeline reorder: SRS теперь после AC (а не после UC)
- Complexity Gate: формальная оценка сложности перед formalization
- DECOMP: отдельная задача `planning.decomposition` для разложения baseline на dev-задачи
- Pattern B (scaffold-first) встроен в decomposition
- Recovery: `autonomous-recovery` skill + recovery-heuristics для gate failures
- Фикс контекста: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144` + `DISABLE_COMPACT=1`
- Engine: semantic conflict keys, worker_executions с fencing token, atomic-release

---

## 1. Прогресс по стадиям — хронология

Все времена UTC, движок запущен в 05:02:36 (pid=19708).

| Время | Длительность | Стадия / событие |
|---|---|---|
| 05:02:36 | — | engine start, qwen3.6-35b@q4_k_xl, concurrency=1 |
| 05:06 | 3m 30s | #1 Discovery: brief с 3 гипотезами + 5 OQ + Variant A (pure frontend) |
| 05:09:51 | — | #1 → done, автогенерация #2 PRD |
| 05:13:55 | 4m | #2 PRD: 9 FR + 6 NFR + 3 RULE + 3 hypothesis + 3 business_metric |
| 05:14:48 | — | #2 → done, автогенерация #3 UC |
| 05:17:32 | — | ⚠ #3 сброшен в todo — старый execution закрыт без worker_done, поднят новый. **Recovery сработал сам, без оператора.** |
| 05:19 | 5m | #3 UC: 5 use cases (Calc, Solar, Learn, SaveLoad, Quiz) |
| 05:20:26 | — | #3 → done, автогенерация #4 AC |
| 05:23–05:25 | 2m | #4 AC: **25 acceptance criteria** + 25 trace edges (derived_from AC→UC/FR/RULE) |
| 05:25:47 | — | #4 → done, автогенерация reconciliation task |
| ~05:30 | — | formalization gate OK → SRS + reconciliation → **baseline accepted** |
| 05:42:47 | ~12m | #6 SRS (Structural Requirements Spec) — Module Manifest + Port Registry + Invariant Registry |
| 05:42:54 | — | #6 → done, автогенерация #7 decomposition |
| 05:42:54 → ~05:53 | ~10m | #7 `planning.decomposition`: создание dev + verification + integration задач |
| ~05:53 | — | planning gate OK → **development** стартует |

**Время Discovery → Development:** ~51 минута.

### 1.1. Сравнение с Cannon baseline

| Метрика | Cannon (ADR-013) | Sollar (ADR-014) | Разница |
|---|---|---|---|
| Discovery → Development | ~1.5–2 ч | ~51 мин | **−50%** |
| Stage-gate stop'ов | 4–5 | **0** | all auto-recovered |
| Recovery-healing задач | 3 | **0** | pipeline не падал |
| Контекстных крахов | 2 (80k, 110k) | **0** | CLAUDE_CODE_MAX_CONTEXT_TOKENS держит |
| Зомби-каскадов | 2 эпизода | **0** | — |
| Orphan AC | 2 | **0** | traceability строится сразу |
| Hypotheses с метриками | 0 | **3** | H1/H2/H3 + business_metric |

**Предварительный вывод:** новый pipeline структурно здоровее. Discovery→Planning идёт по рельсам без ручного вмешательства.

---

## 2. Кейсы тестирования

### Кейс T-001: ложная тревога patrol «стагнация токенов» на thinking-моделях

**Дата/время обнаружения:** 2026-07-21 05:46–05:50 UTC
**Где:** скилл `saga-patrol`, метод `analyzeCycles()` в `patrol.mjs`
**Стадия саги:** planning (#7 `planning.decomposition`)
**Симптом:** patrol сообщил «⚠ стагнация токенов: input растёт, output=0 (тайный цикл)» — и stuck-cycle=60 в engine-heartbeat

**Что увидел patrol:**
```
- engine-heartbeat (последние 20 релевантных): stuck-cycle=60
  2026-07-21T05:46:16.415Z engine ... CYCLE stage=planning claimable=0 in_flight=1 workers=1
  ... ×60 строк подряд без STAGE_ADVANCED ...
- #7 executing pid=18356 quiet=нет 1.1tok/s total=370
  - дубли tool_use: нет
  - ⚠ стагнация токенов: input растёт, output=0 (тайный цикл)
  - токены: input=82583 cache=79546 (96%) output=0
```

**Что было на самом деле:** два ложных сигнала подряд.

#### 2.1. Ложный сигнал A: «stuck-cycle=60 в engine-heartbeat»

60 строк `CYCLE claimable=0 in_flight=1` в engine-heartbeat **не являются аномалией**. Это нормальный режим pump-цикла: engine в каждом тике (5 с) проверяет «есть ли задача в очереди», и если есть активный воркер — пишет `claimable=0 in_flight=1`. **Длина серии сама по себе не патология** — она равна времени работы одного воркера, делённому на 5 с.

Реальный сигнал стагнации — не количество CYCLE, а:
- `is_quiet=true` у воркера (>30 с без записей в логе) при живом PID
- `WORKER_TERMINATED` подряд (execution'ы падают)
- серия `HEALING / ESCALATE / GENERIC_HEAL` (recovery не справляется)

`stuck-cycle=60` нужно убирать из детектора или переопределять: «N CYCLE подряд **без tool_use в логе воркера**».

#### 2.2. Ложный сигнал B: «input растёт, output=0» для thinking-модели

Qwen3.6 — thinking-модель: основная работа происходит в `content[].type=='thinking'`, и `message.usage.output_tokens` показывает **только visible text/tool_use output**, не reasoning tokens. Реальная последовательность в логе #7:

```
[05:50:41] tool_use: trace_add (source=34→task 14)
[05:50:42] tool_use: trace_add (source=36→task 11)
[05:50:44] tool_use: trace_add (source=37→task 15)
[05:50:45] tool_use: trace_add (source=38→task 19)
[05:50:47] tool_use: trace_add (source=39→task 8)
[05:50:48] tool_use: trace_add (source=40→task 27)
[05:50:54] thinking: "...verified_by stubs for verification tasks, mapping each
                     acceptance criterion to its corresponding implementation task..."
[05:50:55] tool_use: trace_add (source=55→task 12)
```

За 14 секунд — **7 tool_use**, 1 thinking-блок с планом «достраиваю implements/verified_by-traces для verification chain». Это **активная работа**, а не цикл. Причина ложной тревоги: patrol смотрел на `usage.output_tokens` (который всегда 0 у thinking-моделей Qwen), а не на `thinking_tokens` или количество tool_use за единицу времени.

**Правильный детектор «thinking-loop» для thinking-моделей:**
- взять последние N assistant-записей;
- если `output_tokens=0` **И** количество tool_use за окно = 0 **И** нет ни одного нового thinking-блока за последние K записей → тайный цикл.
- иначе — нормальный режим thinking.

То есть «input растёт + output=0» без проверки **присутствия tool_use** — некорректный критерий.

#### 2.3. Исправление в скилле

Требуется патч `patrol.mjs`, метод `analyzeCycles()`:

```javascript
// ДО (некорректно):
if (inGrowth > 5000 && outSum === 0) stagnant = true;

// ПОСЛЕ (корректно):
const toolUseCount = events
  .filter(e => e.type === 'assistant')
  .flatMap(e => e.message.content.filter(c => c.type === 'tool_use'))
  .length;
const recentThinking = events
  .filter(e => e.type === 'assistant')
  .flatMap(e => e.message.content.filter(c => c.type === 'thinking'))
  .length;
// thinking-loop = НЕТ tool_use И НЕТ новых thinking-блоков
const stagnant = inGrowth > 5000 && outSum === 0
  && toolUseCount === 0 && recentThinking === 0;
```

Также: убрать «stuck-cycle=60» как самостоятельный сигнал стагнации, оставить только как контекст. Реальный сигнал — связка `{is_quiet=true, дубли tool_use, нет новых tool_use}`.

**Статус:** найдено в тесте, исправление в backlog. Скилл работает, но даёт ложные срабатывания на thinking-моделях.

**Урок для следующей версии patrol:** любые эвристики на `usage.output_tokens` требуют уточнения «какая это модель» — у Anthropic/Claude output_tokens включает и reasoning, у OpenAI o1 — `reasoning_tokens` отдельно, у Qwen3.6 — `thinking_tokens` в отдельном subtype. Универсальный детектор должен смотреть на **поток tool_use + ассистентских text-блоков**, а не на счётчики токенов.

---

### Кейс T-002: autonomous recovery без оператора (#3 UC)

**Дата/время:** 2026-07-21 05:17:32 UTC
**Стадия:** formalization (UC task)

**Симптом:** в activity_log зафиксировано:
```
05:17:32 task 3 assigned_to: board-1-1784610893927-7 -> ""   ← освобождено
05:17:34 task 3 claimed by board-1-1784611054790-8           ← новый execution
```

Старый execution `board-1-1784610893927-7` закрылся без `worker_done` (вероятно, process exit ≠ 0 или таймаут). Engine в следующем CYCLE увидел `assigned_to IS NULL` + задача не done → перевыдана новому execution'у `board-1-1784611054790-8`.

**Что важно:** в Cannon baseline аналогичная ситуация приводила к **зомби-каскаду** — engine продолжал считать старый execution активным, новый не поднимался, требовалась ручная правка БД. Здесь **atomic-release сработал сам**: fencing token в `worker_executions` позволяет разрулить «PID умер, ownership надо снять» без гонок.

**Проверка в DB:**
```sql
SELECT execution_id, state, finished_at, exit_code, last_error
FROM worker_executions WHERE task_id=3 ORDER BY reserved_at;
-- execution_id=exec-1-19708-1784610893927-7  state=exited  exit_code≠0  finished_at=05:17:32
-- execution_id=exec-1-19708-1784611054790-8  state=exited  exit_code=0   finished_at=05:20:22 (done)
```

Оба execution'а в финальном состоянии, задача #3 успешно завершена. **Вмешательство оператора: 0.**

**Урок:** fencing-token + atomic-release — критическая инфраструктура для устойчивости pipeline. В baseline этого не было, и любой нештатный exit воркера означал ручное восстановление.

---

### Кейс T-003: traceability graph строится автоматически

**Дата/время:** 2026-07-21 05:23–05:50 UTC
**Стадии:** formalization (AC) → planning (decomposition)

**Наблюдение:** patrol по артефактам показал **0 orphan AC** — все 25 acceptance criteria имеют parent-trace (`derived_from` → UC/FR/RULE). Это не магия: saga-analyst в AC-задаче #4 явно проставил 25 trace edges одновременно с созданием AC.

В Cannon baseline 2 AC были orphan'ами — верификатор не знал, к чему их привязать, и это было одним из пунктов потери баллов в аудите (category D: Artifacts & traceability).

Дополнительно: в #7 `planning.decomposition` модель сама создаёт **24 `implements`-trace** (AC → dev-task) + **24 `verified_by`-trace** (AC → verification-task) + **24 `conflict_keys_set`** для Pattern B collision detection. Это значит, что когда начнётся development, каждая dev-задача уже знает:
- какой AC она реализует (`source_artifact_ids`)
- какой verifier будет её проверять (`verified_by` edge)
- какие файлы/схемы она трогает (для conflict-check перед merge)

**Урок:** traceability — не отдельная ручная работа, а встроенный в pipeline автомат. Это структурное преимущество saga-mcp перед «генеративным» агентным кодингом (где связи между требованиями и кодом остаются только в голове модели).

---

### Кейс T-004: thinking-модель в long-running decomposition

**Дата/время:** 2026-07-21 05:43–05:53 UTC (~10 мин)
**Стадия:** planning (#7 decomposition)
**Модель:** qwen3.6-35b-a3b@q4_k_xl

**Наблюдение:** декомпозиция 25 AC в 28 задач (dev + verification + integration) заняла ~10 минут при:
- input 109k токенов (97% cache hit)
- output 0 visible text (вся работа в thinking)
- ~98 assistant-сообщений в логе
- 28 task_create + 24 conflict_keys_set + 24 trace_add + 4 Bash (чтение SRS)

Скорость ~1 tok/s на thinking'е — низкая для 35B, но в пределах нормы для q4-кванта на 2×3090.

**Сравнение с Cannon:** там декомпозиция была частью planner-задачи и занимала меньше времени, но产出 был хуже (orphan AC, неверные trace-связи). Здесь модель **тратит время на продумывание trace-graph'а**, и результат — 0 orphan.

**Урок для аудита:** время decomposition не должно идти в минус — это инвестиция в качество downstream. В category F (Efficiency) 10 минут «молчаливой» работы модели надо оценивать с учётом того, что она экономит 30+ минут ручной правки trace-связей позже.

---

## 3. Метрики саги на 05:53 UTC (на момент отчёта)

### 3.1. Задачи

| Стадия | done | in_progress | review | todo | blocked |
|---|---|---|---|---|---|
| discovery | 1 | — | — | — | — |
| formalization | 5 | — | — | — | — |
| planning | 1 | — | — | — | — |
| development | — | — | — | 6 | 11 |
| verification | — | — | — | (через decomposition) | — |
| integration | — | — | — | (через decomposition) | — |

**Всего:** 7 done, 17 ожидают старта development.

### 3.2. Артефакты

| Тип | accepted | draft |
|---|---|---|
| brief | 1 | — |
| PRD | 1 | — |
| SRS | 1 | — |
| UC | 5 | — |
| FR | 9 | — |
| NFR | 6 | — |
| RULE | 3 | — |
| AC | 25 | — |
| hypothesis | — | 3 |
| business_metric | — | 3 |

**Итого accepted:** 50 артефактов. **Orphan AC:** 0.

### 3.3. GPU / модель — мгновенный снимок

| GPU | Util | Memory | Temp | Power | Fan | Core clock | Pstate |
|---|---|---|---|---|---|---|---|
| 0 | 42% | 20071/24576 MiB (82%) | 61°C | 124/245 W (51%) | 32% | 1530/2100 MHz | P3 |
| 1 | 47% | 18156/24576 MiB (74%) | 70°C | 141/245 W (57%) | 53% | 1530/2100 MHz | P3 |

LM Studio: qwen3.6-35b@q4_k_xl loaded, ctx=262144/262144. Температуры в норме, троттлинга нет (`clocks_event_reasons.active = 0x1` = Idle, не throttle).

---

## 3.3bis. GPU / энергия / тепло / износ — накопительные метрики

Для сравнения стоимости прогона (электричество, охлаждение, износ карт) patrol теперь пишет CSV-лог на каждый запуск: `~/.zcode/cli/patrol-gpu-sollar.csv`. Каждая строка — сэмпл (timestamp, gpu, util, temp, power, fan, clocks, throttle-flag). Из него считается:

| Метрика | Что значит | Порог тревоги |
|---|---|---|
| **kWh** | Потреблено электричества (avgW × span_hours / 1000) | — (база для сравнения) |
| **deg·h > 50°C** | Интеграл времени, проведённого выше 50°C — тепловой износ | > 500 за прогон = проблема |
| **throttle %** | Доля сэмплов с активным троттлингом (clocks_event_reasons ≠ 0x1) | > 5% = плохое охлаждение |
| **thermal cycles (Δ≥10°C)** | Количество циклов нагрев/остывание ≥ 10°C — усталость пайки/термопасты | > 20 за прогон = износ |
| **avg/max power** | Средняя и пиковая мощность — насколько близко к лимиту 245W | avg > 200W = карты на пределе |
| **avg/max temp** | Температурный режим | max > 85°C = троттлинг близко |
| **avg/max fan** | Скорость вентиляторов — износ подшипников | avg > 80% = карты перегружены по охлаждению |

### Кумулятив по прогону Sollar (на 06:03 UTC, span ~5 мин наблюдения)

| GPU | avgUtil | avgW | maxW | avgT | maxT | kWh | deg·h>50 | throttle% | cycles | fan avg/max |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 37% | 127 | 150 | 61°C | 62°C | 0.001 | 0 | 0% | 0 | 32% |
| 1 | 49% | 141 | 146 | 70°C | 70°C | 0.001 | 0.1 | 0% | 0 | 53% |

CSV: `C:\Users\user\.zcode\cli\patrol-gpu-sollar.csv`. По мере прогонки — таблица расширяется.

### Baseline Cannon (за ~12 ч работы на тех же картах)

Cannon-прогон шёл ~12 часов. Метрики сохранены фрагментарно (тогда patrol ещё не было), поэтому данные реконструированы из снимков в journal'е:

| Метрика | Cannon (12 ч) | Оценка для Sollar |
|---|---|---|
| avg power GPU0/GPU1 | ~115W / ~140W | похоже (сейчас 127/141) |
| avg temp GPU0/GPU1 | ~60°C / ~70°C | точно совпадает |
| max temp | 72°C / 78°C (пики при active thinking) | пока не достигнуто |
| throttle % | 0% (за весь прогон) | пока 0% |
| thermal cycles (Δ≥10°C) | ~30 (карты остывали между задачами) | ожидаемо ~30 к концу |
| kWh GPU0 + GPU1 | ≈ (115+140) × 12 / 1000 = **~3.06 kWh** | пропорционально времени |
| Fan avg | 33% / 55% | совпадает |
| износ (proxy) | deg·h > 50 ≈ (60-50 + 70-50) × 12 = **~360** | если Sollar идёт 12 ч — то же |

**Удельные затраты Cannon (база для сравнения):**
- Электричество: ~3.06 kWh за 12 ч → при тарифе ~6 ₽/kWh = **~18 ₽ за весь прогон**
- Тепловыделение: ~3.06 kWh → ~11 МДж тепла в комнату
- Износ карт: ~360 deg·h > 50°C → в пределах нормы (порог тревоги 500)
- Cycle-износ: ~30 циклов Δ≥10°C → норма (порог 20 — на грани)

### Что отслеживаем в Sollar

По мере прохождения development → verification → integration patrol пишет в CSV. Финальный аудит сравнит:

1. **Время до completion.** Если Sollar закончит за 6 ч (в 2 раза быстрее Cannon) при тех же avgW → **половина электричества и тепла** — это прямой выигрыш нового pipeline.
2. **Throttle-эпизоды.** Если в Sollar появится throttle% > 0 — значит, новый pipeline нагружает карты жёстче (более плотная работа = меньше idle), что увеличивает throughput, но и тепло.
3. **Thermal cycles.** Если cycles Δ≥10°C будет сильно больше Cannon → движок чаще гоняет карты в idle/peak, что хуже для пайки.
4. **Fan profile.** Если fan avg вырастет заметно (например, 33% → 60%) — близко к температурному потолку, нужен тюнинг fan curve в LM Studio.

### Скрипт экспорта CSV в человекочитаемую сводку

Для финального аудита — однострочник:

```bash
node -e '
const fs = require("fs");
const rows = fs.readFileSync("C:/Users/user/.zcode/cli/patrol-gpu-sollar.csv","utf8")
  .trim().split("\n").slice(1).map(l => l.split(","));
const byGpu = {};
for (const v of rows) {
  (byGpu[v[1]] ||= []).push({t:new Date(v[0]).getTime(), temp:+v[6], power:+v[7], fan:+v[9], thr:+v[16]});
}
for (const [gpu, arr] of Object.entries(byGpu)) {
  const n = arr.length;
  const spanH = (arr[n-1].t - arr[0].t) / 3.6e6;
  const avgP = arr.reduce((s,x)=>s+x.power,0)/n;
  const avgT = arr.reduce((s,x)=>s+x.temp,0)/n;
  const maxT = Math.max(...arr.map(x=>x.temp));
  const thrPct = 100*arr.filter(x=>x.thr===1).length/n;
  console.log(`GPU ${gpu}: ${spanH.toFixed(1)}ч, ${n} сэмплов, avg=${avgP.toFixed(0)}W / ${avgT.toFixed(0)}°C, max=${maxT}°C, throttle=${thrPct.toFixed(1)}%, kWh≈${(avgP*spanH/1000).toFixed(2)}`);
}
'
```

### 3.4. Engine

- running, pid=19708, concurrency=1
- recovery-heuristics: **0 срабатываний**
- autonomous-recovery skill: **0 запусков**
- human_requests (open): **0**
- worker_executions: все в финальном состоянии, зомби **0**

---

## 4. Что проверяем дальше (backlog наблюдений)

По мере прохождения development / verification / integration — добавлять в этот же отчёт:

- [ ] **Pattern B scaffold-first:** как архитектор (или decomposition) создаёт API-контракты перед parallel dev-задачами. Появится ли в Sollar SRS §2b Port Registry → реальные порты в коде.
- [ ] **Build-gate** (Дыра A из Cannon investigation): есть ли теперь в pipeline автоматический build/type-check после каждой dev-задачи, или всё ещё ожидается ручной запуск.
- [ ] **Loop-detector** (Дыра E): если какая-то dev/verify задача уйдёт в retry-loop — сработает ли autonomous-recovery сам, или потребуется ручная подсказка.
- [ ] **Hint injection channel** (как в Cannon #31/#36): если verifier застрянет на unverifiable AC (например, «≥60fps» NFR-3) — есть ли в новом pipeline способ передать подсказку без правки БД вручную.
- [ ] **Settings.json bootstrap bug:** не ревернется ли settings.json к z.ai после рестарта tracker-view. Проверить при первом падении.
- [ ] **DISABLE_COMPACT=1:** добавлен ли в env claude-runner.mjs. Без него на 80k+ контекста может начаться compaction-крах (Cannon повтор).
- [ ] **--effort xhigh per-task-kind:** Qwen3.6 не поддерживает low/medium/high, только on/off. Проверить, не падает ли LM Studio с варнингом и не режет ли это качество.
- [ ] **Hourly snapshots:** продолжать собирать срезы patrol'ом для финального аудита.

---

## 5. Предварительная оценка (экспресс, не финал)

На момент planning→development перехода, по 7 категориям 1000-score framework (финал — после completion):

| Категория | Max | Экспресс | Комментарий |
|---|---|---|---|
| A. Architecture & modularity | 200 | ~150 | SRS + Port Registry есть, но кода ещё нет → оценим в development |
| B. Code cleanliness | 150 | — | development не стартовал |
| C. Test coverage | 150 | — | development не стартовал |
| D. Artifacts & traceability | 150 | **~140** | 50 артефактов, 0 orphan, baseline зафиксирован — лучше Cannon |
| E. Runnable state | 150 | — | кода нет |
| F. Efficiency (time/tokens) | 100 | ~75 | Discovery→Planning за 51 мин vs Cannon 1.5–2 ч; но thinking-model slow |
| G. Autonomy | 100 | **~90** | 0 ручных вмешательств vs Cannon 4–5; recovery сам, зомби 0 |

**Экспресс-сумма (видимые категории):** ~455/700 ≈ **650/1000 extrapolated** (если development пройдёт так же чисто). Это уже на уровне Cannon-финала, и кодовая фаза ещё не начиналась.

Финальный отчёт с полным 1000-score — после `integration` → `completed`.

---

## 6. Журнал наблюдений (append-only)

Сюда добавляем короткие заметки по мере прогона. Каждая запись — дата/время + факт.

- **2026-07-21 05:02:36** — engine start (pid=19708), qwen3.6-35b@q4_k_xl, concurrency=1.
- **2026-07-21 05:09:51** — #1 Discovery done. Brief: Variant A (pure frontend), L2/M complexity, 3 гипотезы.
- **2026-07-21 05:14:48** — #2 PRD done. 9 FR + 6 NFR + 3 RULE.
- **2026-07-21 05:17:32** — **Кейс T-002**: #3 UC recover'нулся сам после падения execution.
- **2026-07-21 05:20:26** — #3 UC done. 5 use cases.
- **2026-07-21 05:25:47** — #4 AC done. **25 AC + 25 trace edges**.
- **2026-07-21 ~05:30** — formalization gate OK, SRS+reconciliation, baseline accepted.
- **2026-07-21 05:42:54** — #6 SRS done. Module Manifest + Port Registry.
- **2026-07-21 05:42:54** — #7 decomposition стартовала.
- **2026-07-21 05:46** — patrol smoke-test, **Кейс T-001**: ложная тревога «стагнация токенов».
- **2026-07-21 05:50** — проверка лога #7: модель активно работает (28 task_create + 24 trace), ложная тревога подтверждена.
- **2026-07-21 ~05:53** — planning gate OK, **development стартовал**: claimable=4 (был 0), in_flight=1, 11 blocked → разблокированы.
- **2026-07-21 06:00** — `#9` development executing, **is_quiet=true** при PID живом → кандидат на зависание. Разбирательство в следующем срезе.
- **2026-07-21 06:03** — добавлен раздел GPU/энергия/тепло/износ в отчёт. Patrol теперь пишет CSV-лог (`~/.zcode/cli/patrol-gpu-sollar.csv`) для накопительных метрик. Текущие значения: GPU0=61°C/124W, GPU1=70°C/141W, throttle=0%.

---

## 7. Ссылки

- `audit-2026-07-20-cannon-1000-score.md` — baseline 661/1000, 1000-score framework.
- `investigation-2026-07-20-cannon-development-stage.md` — Дыры A-G в baseline.
- `design-2026-07-20-worker-loop-detection.md` — дизайн loop-детектора (в новой версии должен быть в pipeline).
- `autonomous-decision-unverifiable-acs.md` — saga-arbiter для unverifiable AC.
- `saga-vs-gost-34-602-and-iso-12207.md` — покрытие ГОСТ / ISO 12207.
- Скилл `saga-patrol` — `D:\Разработка\saga-mcp\skills\saga-patrol\{SKILL.md, patrol.mjs}`.
