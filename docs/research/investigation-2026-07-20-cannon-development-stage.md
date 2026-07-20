# Отчёт расследования: saga-mcp на стадии development

**Дата наблюдения:** 2026-07-20
**Эпизод:** REQ-001-Cannon (id=1)
**Проект:** Cannon-` (id=1)
**Стадия:** development (с 05:15)
**Режим:** наблюдение без вмешательства

---

## 1. Контекст

Наблюдали работу saga на одном эпизоде (REQ-001-Cannon) от перехода в стадию
development (05:15) до ~14:08. Цель — понять, как saga реально ведёт параллельные
воркеры на слабой локальной модели (qwen на RTX 3090), где пределы, где дыры.

Все факты ниже — подтверждены прямыми инструментами (tsc, git, activity_log,
worker_health, Get-Process). Без интерпретаций в утвердительной форме там,
где данные не позволяют.

---

## 2. Сводка прогресса

| Метрика | Значение | Источник |
|---|---:|---|
| Всего задач | 37 | `epic_list` |
| Done | 20 | `task_list` |
| In progress | 1 (#21) | `task_list` |
| Blocked | 3 | `task_list` |
| Todo | 13 | `task_list` |
| Строк src/ (TS+TSX) | 6058 | `wc -l` |
| Строк src/ (CSS) | 749 | `wc -l` |
| Строк tests/ | 6320 в 20 файлах | `wc -l` |
| Соотношение test:code | 1.04 : 1 | расчёт |

Темп: ~1 задача в 15-20 минут на стадиях NFR-1..NFR-4.

---

## 3. Подтверждённые факты

Каждый факт сверен с источником. Если было расхождение с ранними словами —
помечено как «уточнение».

### Факт 1: воркер на #21 завис, worktree не существует

**Источник:** `git worktree list`, `Get-Process -Id 6964`, `worker_health`

`git worktree list` показывает 7 worktrees: `task-9, task-13, task-14, task-15,
task-17, task-19, task-20`. **`task-21` отсутствует.**

`Get-Process -Id 6964` (PID воркера из `metadata.worker_pid:6964`) возвращает
пусто — процесс мёртв.

`worker_health` помечает #21 как zombie: `stale_min: 54`.

**Уточнение к ранним словам:** изначально я писал «воркер падал 2 раза на #21,
atomic-release поднимал». По `activity_log` подтверждён **только один recovery**
(в 10:16), второй claim сразу после него (worker-42) — больше движок #21 не
поднимал. То есть фактически сейчас воркер мёртв ~54 минуты, но движок ещё не
сделал повторный recovery (ждёт истечения zombie timeout, обычно 30 мин).

### Факт 2: TS-ошибки — все в одном файле tests/browser/setup.ts

**Источник:** `npx tsc --noEmit`

```
tests/browser/setup.ts(40,8):  error TS1005: ',' expected.
tests/browser/setup.ts(40,15):  error TS1005: ',' expected.
tests/browser/setup.ts(40,17):  error TS1134: Variable declaration expected.
tests/browser/setup.ts(41,16):  error TS1005: ';' expected.
tests/browser/setup.ts(42,15):  error TS1005: ';' expected.
tests/browser/setup.ts(43,1):   error TS1109: Expression expected.
```

Всего 6 ошибок, все в `tests/browser/setup.ts:40-43`. Причина — object literal
с дефисом без кавычек:
```ts
export const ROUTE_LINKS: Record<string, string> = {
  calculator: 'Calculator',
  solar-system: 'Solar System',        // ← TS1005
  moon-transfer: 'Moon Transfer',      // ← TS1005
  mars-mission: 'Mars Mission',        // ← TS1005
};
```

В `src/` — 0 ошибок TS. Это уточнение к ранним словам «30 TS ошибок в src/» —
ошибки действительно были, но воркеры за следующие часы их починили (через
review fixup). Сейчас `src/` чистый.

### Факт 3: SRS §9 stack declaration присутствует, но пути расходятся

**Источник:** `01-SRS.md`

SRS §9 содержит все 6 нужных полей:
```yaml
language: typescript
test_framework: jest (unit + integration), playwright (E2E cross-browser)
property_test_framework: fast-check
linter: eslint (@typescript-eslint/recommended)
formatter: prettier
type_checker: tsc (strict mode)
build_tool: npm (Vite dev server + production build)
```

Но пути в SRS §2 Module Manifest и §2b Port Registry **расходятся с реальными**:

| SRS указывает | Реальный путь |
|---|---|
| `src/physics/orbital.ts` | `src/physics-engine/orbital.ts` |
| `src/visualize/renderer.ts` | `src/visualization/renderer.ts` |
| `src/data/ephemeris.ts` | `src/data-service/ephemeris.ts` |
| `src/app/main.tsx` | `src/app-shell/main.tsx` |
| (нет) | `src/ui/` — целый модуль не описан в §2 |

Также `conflict_keys` в §2b указывают на несуществующие пути, например:
```
file_path=`src/physics/orbital.ts`     ← не существует
```

Это значит, что защита от коллизий (REQ-010) по file_path **фактически не
сработала бы** — даже если бы два воркера параллельно трогали один файл,
ключи бы не совпали.

### Факт 4: downstream skills не читают SRS §9

**Источник:** grep по `saga-planner/SKILL.md`, `saga-worker/SKILL.md`,
`saga-verifier/SKILL.md`

В каждом из трёх скиллов слово "§9" встречается ровно 1 раз — и **все три
раза это CGAD §9** (Verification & Property Tests), не SRS §9 (Technology
Stack).

Конкретно:
- `saga-planner/SKILL.md:298` — "from the frozen AC contract (CGAD §9…)"
- `saga-worker/SKILL.md:324` — "For true independent verification (CGAD §9)…"
- `saga-verifier/SKILL.md:3` — "Independent Verifier for CGAD §9"

Слов `test_framework`, `type_checker`, `build_tool` в этих трёх скиллах —
0 совпадений.

`saga-worker/SKILL.md:165` (точная цитата):
```
# run the project's tests/lint here — they must pass before you call worker_done
worker_done({ task_id, worker_id, result: "what I did; tests pass" })
```

Ни `tsc`, ни `build` — не упомянуты. Воркер волен запустить только `jest`
и удовлетворить «tests/lint».

При этом `saga-architect/SKILL.md:223` честно пишет:
```
Downstream skills read §9 to know their tooling:
- saga-planner: test_framework → creates correct verification.ac task format
- saga-verifier: property_test_framework → generates correct L3 tests
- cgad-spec-lint: may run language-specific checks (future)
```

То есть **договор на уровне архитектора декларирован, но downstream skills
его не реализуют**. Это и есть архитектурная дыра.

### Факт 5: scratch-файлы и бинарные артефакты попадают в git

**Источник:** `git ls-files`, `.gitignore`

`_calc.awk` (177 строк, 8.8 КБ) — awk-скрипт, который воркер на #20 написал
чтобы посчитать эталонные NASA/JPL значения перед тем как вписать их в TS.
Scratch-файл рассуждения. `git ls-files _calc.awk` подтверждает — **закоммичен**
в коммите 3056dbf (task #20).

`.gitignore` содержит: `.worktrees/`, `node_modules/`, `.env`, `dist/`.
В нём **нет**:
- `playwright-report/` (воркер на #21 сгенерил 526 КБ index.html — если
  закоммитит, попадёт в git)
- `*.awk`, `*.scratch`, `_*` (любые scratch-паттерны)

### Факт 6: ядро saga не знает слово "build"

**Источник:** `src/tools/lifecycle.ts:207-233` (assertVerificationPassed),
`src/tools/lifecycle.ts:66-87` (assertTasksReady)

`assertVerificationPassed` — гейт formalization→…→completed, проверяет только
записи в `verification_evidence`: `outcome IN ('passed','unknown') AND
content_hash = accepted_hash`.

`assertTasksReady` (integration gate) — проверяет только `status='done' AND
integration_state='merged'`.

Ядро оперирует двумя вещами:
1. **evidence** — запись в БД от провайдера (test_runner / human / etc)
2. **integration_state** — зафиксирован ли git-merge commit

Ни одного упоминания `tsc`, `jest`, `npm run build`, `cargo`, `pytest` в
`src/tools/lifecycle.ts`. Ядро **намеренно стек-агностик**.

### Факт 7: phantom-zombie — saga-core не замечает смерть воркера, tracker-view замечает

**Источник:** `/api/workers/active?project_id=1`, `worker-heartbeat.log`,
JSONL-логи `board-runs/board-1-9552-1784522078785/`,
`tracker-view.mjs:4770` (фильтр по `isProcessAlive`)

API tracker-view возвращает точное состояние:
```json
GET /api/workers/active?project_id=1
{ "ok": true, "project_id": 1, "workers": [] }
```

То есть **фронт уже знает**: активных воркеров нет. Логика фильтра
(`tracker-view.mjs:4770`):
```js
.filter(r => r.machine_id === os.hostname() && isProcessAlive(r.pid));
```

`isProcessAlive(6964)` возвращает `false` — процесс мёртв — воркер исключён
из списка.

При этом **сама saga-core об этом не знает**:
- `worker_executions.state = 'running'` для execution `exec-1-9552-…-42`
- `tasks.status = 'in_progress'` для #21 (статус не скинут)
- Pump-loop (`orchestrate.ts`) не вызывает `isProcessAlive` — он смотрит
  только на SQL state
- Recovery не запускается

**Полные логи worker-41 vs worker-42** (`board-runs/board-1-9552-…/`):

| Воркер | Лог | Размер | Что произошло |
|---|---|---:|---|
| worker-41 (10:06–10:16) | `task-21-…-41.jsonl` | 826 732 B, 1818 строк | честно работал 10 мин, последняя мысль: *"Now let me update the mars-mission and navigation spec files"* при контексте 80 989 токенов |
| worker-42 (10:16–…) | `task-21-…-42.jsonl` | **0 байт** | spawn завершился «успешно», но ни одного байта stdout/stderr за 4 часа |

worker-42 — **phantom execution**: claude CLI стартовал (получил PID 6964),
движок пометил `state='running'`, и больше ничего. Процесс тихо умер, pipe
stdout/stderr не закрылся корректно, поэтому pump-loop не получил ни `exit`
event, ни `end` event. Saga ждёт вывода, который никогда не придёт.

`worker-heartbeat.log` последняя запись про worker-42:
```
2026-07-20T10:16:19 pid=6964 worker-42 STARTED claude -p task_id=21 role=developer pid=6964
... тишина 4 часа ...
```

**Это подтверждённая реализация Дыры D** — медленная зомби-детекция, но с
уточнением: проблема не в «медленной» детекции, а в её **отсутствии на уровне
saga-core**. Tracker-view правильно видит через `isProcessAlive(pid)`, но
saga-core этот метод в pump-loop не вызывает.

---

## 4. Архитектурные наблюдения

### Что работает хорошо

1. **atomic-release реально спасает.** За время наблюдения задачи #19, #20, #21
   падали (Claude process exited with code 1). Движок поднимал их через
   `Engine recovered (atomic)` без потери данных. Ни одной потерянной задачи.

2. **Worktree изоляция** (там, где worktree реально создался) держит параллельные
   воркеры раздельно. 7 worktrees (`task-9, task-13..20`) — каждый со своим
   HEAD, никто никому не мешает.

3. **AC-driven разработка.** Каждый воркер в commit message ссылается на AC
   (AC-1, AC-NFR-2 и т.д.) и реально копирует Given/When/Then из AC в тело
   задачи. Это не «творчество» модели, это контракт saga-planner → dev task.

4. **Качество кода — высокое для слабой модели.** accuracy-validator.ts (#20)
   содержит реальные ссылки на NASA JPL / IERS / USNO, двойную проверку эталонов,
   33 теста. Это не «UI-мусор», это инженерия.

### Архитектурные дыры

#### Дыра A: stack declaration декларирована, но не исполняется

```
architect (SRS §9)         ← декларирует стек ✓
   │
   │ "downstream skills read §9 to know their tooling"
   │ (сказано в архитекторе, НЕ реализовано downstream)
   ▼
planner SKILL              ← не упоминает §9
worker SKILL (line 165)    ← "run tests/lint" абстрактно
verifier SKILL             ← не упоминает §9
```

SRS §9 содержит `type_checker: tsc (strict mode)`, `build_tool: npm run build`.
Если бы worker SKILL читал §9, воркер запускал бы до `worker_done`:
```bash
npm test                       # test_framework — L2
npx tsc --noEmit               # type_checker — L0  ← сейчас пропущено
npm run build                  # build_tool — gate  ← сейчас пропущено
npx eslint .                   # linter
```

6 TS-ошибок в `tests/browser/setup.ts` всплыли бы на первой же задаче, а не
копились необнаруженными до сих пор.

#### Дыра B: scratch-файлы и бинарные артефакты попадают в git

Воркеры пишут scratch-файлы (`_calc.awk`) и генерируют бинарные отчёты
(`playwright-report/index.html` 526 КБ). SKILL не говорит «удали scratch».
`.gitignore` не покрывает типовые паттерны (`_*`, `*-report/`).

Ревьюер тоже не ловит — потому что не знает что искать.

#### Дыра C: пути в SRS §2b Port Registry расходятся с реальными

`conflict_keys` (file_path, schema) в SRS указывают на несуществующие пути.
Защита от коллизий (REQ-010) по file_path **не сработала бы** при реальном
параллельном touch одного файла разными воркерами.

В этом эпизоде повезло — воркеры не конфликтовали. Но это luck, не protection.

#### Дыра D: зомби-детекция отсутствует на уровне saga-core (подтверждено Фактом 7)

Воркер на #21 фактический мёртв **~4 часа** (с 10:16 до момента наблюдения),
движок **не запускает recovery**. Состояние в БД застыло:
- `worker_executions.state = 'running'` (execution не терминальнут)
- `tasks.status = 'in_progress'` (задача не возвращена в очередь)

`worker_health` нашёл zombie (`stale_min: 54`), но это **пассивный read-only
отчёт** — он не терминальрует execution. Pump-loop в `orchestrate.ts`
смотрит только на SQL state; не вызывает `isProcessAlive(pid)`. Поэтому:

- Tracker-view знает правду: `/api/workers/active → workers: []`
- Saga-core не знает: pump-loop считает execution активным

**Корень проблемы:** child-process pipe (stdout/stderr) не закрылся
корректно при краше claude CLI → `child.on('exit')` не срабатывает →
pump-loop не получает сигнал → `state='running'` висит бесконечно.

**Минимальная фикса:** в `src/orchestrate.ts` pump-loop рядом с
`ZOMBIE_CHECK_TICKS` добавить проверку `isProcessAlive(pid)` для каждого
execution с `state='running'`. Если false — терминальнуть через
`releaseExecutionAtomically` (тот же механизм, что для exit code 1).
Функция `isProcessAlive` уже экспортируется из `worker-executions.ts`
и используется в tracker-view — достаточно импортировать её в orchestrate.

---

## 5. Динамика качества по задачам

| # | Тип | +LoC | Что добавлено | Качество |
|---|---|---:|---|---|
| 6c43a70 | AC-1 | core engine | Kepler solver + Newton-Raphson + invariants | ✅ высокое |
| c933c14 | AC-2 | viz | Canvas + Three.js renderer | ✅ высокое |
| 4bfec41 | AC-3 | solar | ephemeris adapter + solar-system view | ✅ высокое |
| 660b681 | AC-4 | moon | patched-conic delta-v + 3D + sensitivity | ✅ высокое |
| 1c34c0b | AC-5 | mars | Hohmann + 3D + launch window | ✅ высокое |
| abee83d | AC-6 | ui | real-time validation + visual feedback | ✅ высокое |
| ba67157 | AC-7 | responsive | CSS grid + ResizeObserver | ✅ высокое |
| b9562e0 | NFR-1 | perf | lazy routes + critical CSS + code splitting | ✅ высокое |
| 01c98e7 | NFR-2 | latency | adaptive Kepler (5-15 iter) + sqrt(1±e) cache | ✅ высокое |
| e374712 | NFR-2fix | flaky | batch-stability 0.8→0.5 (Node GC variance) | ✅ зрелое решение |
| 9d9e49d | NFR-3 | fps | precompute + pool + frustum culling | ✅ высокое |
| 3056dbf | NFR-4 | accuracy | NASA/JPL references + двойная проверка | ✅✅ самое сильное |

Все FR и NFR dev-задачи закрыты с высоким качеством. Самый сильный код —
`accuracy-validator.ts` (реальная физика с привязкой к авторитетным источникам).

Самая длительная задача — #21 NFR-5 (кросс-браузер): краш → atomic-recovery →
висит 54+ мин без worker_done. Playwright тест требует реального browser
launch, что плохо совмещается со слабой моделью на 3090.

---

## 6. Выводы

### Что saga делает правильно

1. **Управление lifecycle эпизода** работает: discovery → formalization →
   planning → development — все переходы штатные, с gate-проверками.
2. **Recovery** после крашей воркеров — atomic-release реален, не теоретический.
3. **AC-контракт** реально управляет тем, что воркеры пишут. Не «творчество
   модели», а исполнение замороженного AC.
4. **Стек-агностик ядро** — saga-core работает одинаково для любого стека.

### Где архитектура не доведена

1. **Договор между архитектором и downstream skills не замкнут.** Архитектор
   декларирует стек в SRS §9 и явно пишет «downstream skills read §9». Но
   planner/worker/verifier этого не делают. Это **главная архитектурная дыра**:
   данные есть, потребитель не реализован.

2. **Ядро не знает "build", но SKILL тоже не говорит.** Ядро правильно
   стек-агностик (проверяет contracts: evidence + merge state, не код).
   Но SKILL воркера на строке 165 говорит абстрактное «run tests/lint» —
   этого недостаточно, чтобы слабая модель вызвала `tsc --noEmit` и
   `npm run build`. Дыра — на уровне SKILL, не ядра.

3. **Конфликт-ключи в SRS §2b рассинхронизированы с реальностью.** SRS говорит
   `src/physics/`, код в `src/physics-engine/`. Если завтра запустят второй
   эпизод на этом же репо — защита от коллизий не сработает.

4. **Scratch-файлы и бинарные артефакты не фильтруются.** `_calc.awk` уже в
   git, `playwright-report/` (526 КБ) следующий кандидат.

### Минимальные правки (не применены — наблюдение)

1. **saga-architect/SKILL.md** — требовать, чтобы §9 содержал **runnable
   команды**, не только названия:
   ```yaml
   type_checker: tsc --noEmit (strict mode)        # ← command
   build_tool: npm run build                        # ← command
   test_framework: npm test                         # ← command
   linter: npx eslint .                             # ← command
   ```

2. **saga-worker/SKILL.md:165** — заменить абстрактное "run tests/lint"
   на явное чтение §9:
   ```
   Before worker_done, prove the project still builds.
   Read SRS §9 stack declaration. Run ALL of these:
     1. type_checker command (e.g. tsc --noEmit) — must be clean
     2. test_framework command (e.g. npm test) — must be green
     3. build_tool command (e.g. npm run build) — must succeed
   Paste actual output of each command into `result`.
   ```

3. **saga-planner/SKILL.md** — при создании dev-задачи читать SRS §9 и
   подставлять конкретные команды в `metadata.pipeline` задачи.

4. **.gitignore** шаблон для всех saga-проектов: `_calc*`, `*-report/`,
   `playwright-report/`, `coverage/`, scratch-паттерны.

5. **SRS §2b paths sync check** — cgad-spec-lint правило: file_path в
   conflict_keys должен существовать в репо на момент planning→development
   transition. Иначе scaffold задача не создала нужные пути.

### Что показал эксперимент с qwen3.6-35b на 3090

- **Работает.** 12 dev-задач закрыто, 6058 строк src + 6320 строк tests за ~6
  часов. Качество кода — высокое (real Kepler solver, frustum culling, NASA/JPL
  validation).
- **Спотыкается на NFR-5** (Playwright): требует реального browser launch,
  плохо совмещается со слабой моделью.
- **Падает и поднимается** — saga-движок страхует на уровне atomic-release.
- **Не вызывает tsc/build** — не потому что не умеет, а потому что SKILL не
  говорит. Это управляемая проблема, фикса — одна строка в SKILL.

---

## 7. Источники (прямые ссылки на проверенные данные)

- `npx tsc --noEmit` → 6 ошибок в `tests/browser/setup.ts:40-43`
- `git worktree list` → 7 worktrees, task-21 отсутствует
- `git ls-files _calc.awk` → закоммичен
- `Get-Process -Id 6964` → процесс мёртв
- `worker_health` → #21 zombie, stale 54 min
- `01-SRS.md` §9 строки 229-251, §2b строки 113-147
- `saga-planner/SKILL.md:298`, `saga-worker/SKILL.md:165,324`,
  `saga-verifier/SKILL.md:3` — все три §9 это CGAD §9, не SRS §9
- `saga-architect/SKILL.md:223` — downstream wiring promise
- `src/tools/lifecycle.ts:207-233` (assertVerificationPassed),
  `:66-87` (assertTasksReady)
- `activity_log` для task 21 — 1 recovery (10:16), дальше zombie
- `GET /api/workers/active?project_id=1` → `workers: []` — фронт знает, что
  активных нет (saga-core — нет)
- `tracker-view.mjs:4770` — фильтр `.filter(r => … && isProcessAlive(r.pid))`,
  который правильно отбрасывает мёртвые PID
- `board-runs/board-1-9552-1784522078785/`:
  - `task-21-…-41.jsonl` — 826 732 B, 1818 строк (упавший worker-41)
  - `task-21-…-42.jsonl` — **0 байт** (phantom worker-42, spawn без вывода)
- `worker-heartbeat.log` — последняя запись про worker-42 в 10:16:19 STARTED,
  дальше тишина 4 часа
- `nvidia-smi` → GPU 0: 16.6 ГБ занято (веса llama-server), GPU-Util 0%
  (никто не инферит — подтверждение, что запросов к модели нет)

---

## 8. Уточнения к ранним словам в разговоре

- ~~«30 TS ошибок в src/»~~ → подтверждено 0 в src/, 6 в tests/. Воркеры
  починили исходные ошибки в последующих task fixup'ах (см. коммиты
  `72b6415`, `ac1c0d3`, `6afb8df` с пометкой "review fix").
- ~~«воркер падал 2 раза на #21»~~ → подтверждён 1 recovery (10:16). После
  него был 1 claim (worker-42), который сейчас zombie ~54 мин.
- ~~«воркер не удалил scratch _calc.awk»~~ → точнее: воркер **закоммитил**
  scratch `_calc.awk` вместе с task #20 (3056dbf).
