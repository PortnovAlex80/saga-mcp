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

#### Дыра E: бесконечный retry при unreachable AC (без circuit breaker)

Подтверждено на task #31 (AC-NFR-1: Lighthouse ≥80).

**Класс проблем:** AC требует характеристики, которую dev-воркер **объективно
не может выполнить** в текущем окружении / своими знаниями. Примеры:

- Performance-метрика (Lighthouse score ≥80, p95 latency <Xms) — требует
  expertise по Vite bundle analysis, React.lazy patterns, Three.js tree-shaking
- Browser-specific edge case (Safari flexbox bug, Firefox WebGL quirk) — требует
  deep browser internals
- External API contract conformance (OAuth flow, specific REST error format) —
  требует domain expertise, недоступный локально
- Hardware-specific (touch precision on iPad, Retina DPR) — требует устройства

**Что происходит в saga сейчас (наблюдено на #31):**

```
worker → запускает Lighthouse → Performance=78 (нужно ≥80) → failed
       → worker_done с failed → recovery → task в todo
       → новый worker → запускает Lighthouse → снова 78 → failed
       → ... 38 циклов за 1.5 часа
```

**156 событий activity_log, 38 failed + 12 unknown за 95 минут.**
Каждый новый worker начинает с чистым контекстом, не знает что предыдущий
уже пробовал. Пробует то же самое → тот же результат.

Worker-3 (последний перед нами) на контексте 63k сделал:
- 39 tool_use: **19 Bash, 7 Read, 6 Glob, 4 Grep, 2 task_get, 1 artifact_get**
- **0 Edit, 0 Write** ← ключевой симптом

То есть воркер **видит проблему** (Lighthouse=78), но **не знает как её фиксить**.
Только читает и гоняет тесты. Никаких правок кода.

**Что не хватает saga (3 уровня):**

1. **Circuit breaker** (минимально): после N=3 failed на одной задаче
   → tag `needs-human` → эпизод останавливается, человек смотрит.
   СAGA не может завершиться gracefully без этого.

2. **Эскалация к специалисту**: dev-воркер не справился за N попыток →
   saga поднимает другой skill (например, `saga-performance-tuner` для
   Lighthouse-задач, `saga-cross-browser-expert` для Safari edge cases).
   Это требует **library of specialised skills**, не только `saga-worker`.

3. **Channel для подсказок**: оператор видит что воркер застрял →
   добавляет **solution hint** в `task.metadata.hint` → следующий worker
   читает hint и пробует указанный подход. Без этого каждый worker
   с чистым контекстом обречён повторять те же ошибки.

**Контр-аргумент "но это так и задумано, deny-by-default":** да, deny-by-default
правильно — `failed` блокирует transition. Но deny-by-default без условия
выхода — это **вечный цикл**, не graceful degradation.

**Минимальная фикса (как класс):**

- После 3 failed на одной задаче → инкремент `tasks.metadata.failure_count`
- На 3-м failed → tag `needs-human`, `releaseExecutionAtomically` НЕ возвращает
  в очередь (atomic-release.ts:194 уже honours needs-human)
- В UI: оператор видит красный "needs-human" → читает что не так →
  добавляет hint в task.metadata → saga продолжает

Это **класс проблем**, не специфичный для #31. Любая performance/accessibility/
security задача с объективным gate (Lighthouse, axe, Snyk) рискует попасть
в ту же ловушку.

#### Дыра E+ (follow-up): ручной hint в task.description — это не масштабируется

**Что мы сделали как workaround:** вставили в `task.description` блок
"SOLUTION HINT" с пошаговым рефакторингом renderer.ts (разделить на port.ts +
impl.ts, lazy-import в main.tsx, и т.д.). Следующий worker прочитал hint
и начал применять — **это сработало**. Но это **workaround, не решение**.

**Почему не масштабируется:**

1. **Требует человека в цикле.** Оператор должен заметить "worker застрял",
   прочитать код, придумать решение, вписать hint. Это ровно то, что saga
   должна автоматизировать — снять человека с цикла.

2. **Hint не передаётся между попытками надёжно.** Мы вписали hint в
   `description` — но saga-core не знает что это hint. Любой update
   `description` через `task_update` (например, planner пересоздаёт задачу)
   затрёт hint без предупреждения. Нет типизированного поля.

3. **Hint не связан с причиной failed.** Worker получает hint, но не знает
   **почему именно** предыдущие попытки провалились (какую именно правку
   они пробовали, какой был Lighthouse score). Каждый новый worker видит
   только hint, не полную историю. Это лучше чем пустой контекст, но не
   full picture.

4. **Нет автоматического извлечения hint'а.** Saga знает что task fail'ит
   38 раз подряд. Но не знает **почему**. Lighthouse возвращает число (78),
   но saga не парсит это число и не понимает что "78 < 80 = bundle size issue".

**Что нужно (механизмы на уровне saga-core, не workaround):**

##### Механизм 1: Circuit breaker + auto-tag needs-human (минимальный)

Уже описан в Дыре E выше. После 3 failed — tag needs-human, saga
останавливается. Это **предел** — saga признаёт что не справляется и зовёт
человека. Не решает проблему, но **прекращает бесконечный цикл**.

Реализация: ~25 LoC в `src/orchestrate.ts` (increment `metadata.failure_count`,
на 3-м failed → `addTag('needs-human')`).

##### Механизм 2: Automated failure-context propagation (средний)

Каждый `failed` evidence сохраняет не только outcome, но и **детали**:
- Какой именно gate провалился (Lighthouse score 78, axe violations 5, etc.)
- Что worker пробовал (список tool_use из последней attempt)
- Стек ошибок / diff применённых правок

Следующий worker при claim'е читает `task.metadata.previous_failures` —
видит **что уже пробовали**. Это не hint от человека, а **детальная
история попыток** от предыдущих воркеров. Помогает модели не повторять
проверенные подходы.

Реализация: ~80 LoC в `worker_done` handler + extension `task.metadata`.

##### Механизм 3: Specialised skill escalation (архитектурный)

После N failed на задаче определённого **типа** — saga эскалирует к
специализированному skill'у. Примеры:

| Тип failed | Эскалация к skill | Что он умеет |
|---|---|---|
| Lighthouse/Performance | `saga-perf-tuner` | bundle analysis, Vite config, code-splitting patterns |
| TypeScript errors | `saga-type-fixer` | tsc diagnostics, tsconfig tuning |
| Cross-browser failure | `saga-browser-expert` | Safari/Firefox/Edge specific patterns |
| Security (Snyk/Semgrep) | `saga-security-hardener` | CVE knowledge, dependency upgrades |
| Accessibility (axe) | `saga-a11y-expert` | ARIA patterns, keyboard nav, contrast |

Это **не универсальный воркер**, а **library of specialists**. Каждый
специалист знает домен-специфичные паттерны (например "Three.js в
entry chunk → разделить port/impl"). Первый worker пробует generic
подход; на 2-м failed — эскалируется к специалисту.

Реализация: новая таблица `skill_specialisations`, ~300 LoC в planner /
orchestrator. Требует **написания самих skill'ов** (каждый ~500-1000 строк
markdown с домен-экспертизой).

##### Механизм 4: Deterministic tool gate (CGAD extension)

Если AC имеет **objective gate** (Lighthouse ≥80, tsc --noEmit exit 0,
jest exit 0) — зарегистрировать этот gate как Trusted Provider
(deterministic_evidence). Тогда:

- `verification_evidence` с `outcome=failed` **автоматически** триггерит
  recovery. Сейчас триггерит (это работает).
- **Но** recovery должен не просто вернуть в очередь, а **передать worker'у
  конкретный diagnostic**. Например: "tsc error count: 30, first error:
  src/ui/calculator-form.tsx:23 TrajectoryResult not found". Это **явный
  сигнал модели**, не абстрактный "failed".

Реализация: parse tool output при записи evidence. ~150 LoC.

##### Механизм 5: Hint channel (минимально-инвазивный)

Типизированное поле `tasks.metadata.hint` (string, optional). UI позволяет
оператору вписать hint (как мы сделали руками), но:
- Поле **типизированное**, saga-core знает что это hint
- Hint **сохраняется** при planner updates (не в `description`)
- Worker SKILL **обязан** читать `task.metadata.hint` перед началом работы
- Hint может добавлять также **автоматически** verifier (например, при
  failed Lighthouse — автоматически добавить "Lighthouse=78, check bundle
  size via `npm run build && du -sh dist/assets/`")

Реализация: ~40 LoC (типизированное поле + UI input + SKILL patch).

##### Сводная таблица механизмов

| Механизм | LoC | Что даёт | Когда |
|---|---:|---|---|
| 1. Circuit breaker + needs-human | 25 | Прекращает цикл, зовёт человека | Всегда (минимум) |
| 2. Failure-context propagation | 80 | Worker видит историю попыток | Всегда (хорошо) |
| 3. Specialised skill escalation | 300+ | Эскалация к эксперту | Production |
| 4. Deterministic tool gate | 150 | Конкретный diagnostic вместо "failed" | Для objective gates |
| 5. Hint channel | 40 | Оператор может подсказать | Всегда (минимум) |

**Рекомендация:** Механизмы 1+5 — минимальный набор (65 LoC).
Дальше — 2 (failure-context) и 4 (tool gate). Механизм 3 — долгосрочная
цель, требует library of skills.

**Главный вывод:** То что мы сделали руками (hint в description) —
**подтверждает гипотезу** (воркер может применить решение если его дать).
Но это **не решение само по себе**. Saga нужен автоматический механизм
эскалации. Без него saga **не может быть автономной** для задач с
objective gates — всегда будет требовать человека в цикле.

#### Дыра E++ (доп. наблюдение): verifier правит код, нарушая read_only_evidence

**Источник:** task #31, worker-2 (PID 2848), heartbeat 18:03:03–18:08:23.

Worker-2 выполнил задачу `task_kind=verification.ac`,
`execution_mode=read_only_evidence` (это режим verifier'а — должен только
записывать evidence, не трогать код). Однако в логе:

| Tool | Кол-во |
|---|---:|
| Bash | 14 |
| **Edit** | **7** ← правки кода |
| Read | 5 |
| Write | 1 (новый файл) |
| verification_record | 1 |
| worker_done | 1 |

То есть **verifier сам отрефакторил renderer.ts** (разделил на port/impl,
сделал lazy import в main.tsx), после чего Lighthouse поднялся до ≥80,
и он же записал `outcome=passed`.

**Что это означает концептуально:**

Верификатор в saga — это **независимый арбитр** (CGAD §9): он генерирует
property tests из замороженного AC контракта и фиксирует evidence. Он **не
должен** править код, который проверяет — это нарушение независимости.

Но в наблюденном случае verifier **одновременно**:
1. Запустил Lighthouse → увидел fail (78 < 80)
2. Прочитал hint из task.description
3. **Отрефакторил код** (7 Edit + 1 Write нового renderer-port.ts)
4. Пересобрал и снова запустил Lighthouse → ≥80
5. Записал evidence=passed
6. Вызвал worker_done

**Это нарушение CGAD-принципа separation of concerns**, но это **сработало**
и привело к решению, которого 38 предыдущих циклов не могли достичь.

**Два чтения ситуации:**

1. **Строгое (CGAD-correct):** verifier нарушил контракт. Править код должен
   dev-воркер, verifier только проверяет. Если verifier может править, он
   перестаёт быть "независимым арбитром" — становится dev-воркером с
   привилегиями. **Это дыра**: `execution_mode=read_only_evidence` не
   enforced на уровне инструментов, только на уровне SKILL.md.

2. **Прагматичное:** saga получила результат за 1 цикл вместо 38. Verifier
   видит конкретную проблему (Lighthouse=78), у него есть hint, он может
   сразу применить фикс. Это **более эффективно**, чем возвращать задачу
   dev-воркеру, который начнёт с чистого контекста. Получается гибридная
   роль — "verifier-fixer".

**Класс проблем:** Любой AC с objective gate (Lighthouse, axe, Snyk, tsc)
в текущей saga может попасть в ситуацию, где verifier **может** технически
починить код, но **по контракту не должен**. Это создаёт два режима:

- verifier правит (быстро, но нарушает CGAD)
- verifier только фиксирует fail, dev правит (правильно, но циклиться)

**Что с этим делать (3 опции):**

1. **Enforce read_only на уровне инструментов.** Запретить Edit/Write в
   `execution_mode=read_only_evidence` через `--disallowedTools` в
   claude-runner.mjs (там уже есть precedent для `worker_next`).
   ~5 LoC. Тогда verifier не сможет править, даже если захочет. Цикл E
   решается только через механизмы выше.

2. **Легализовать "verifier-fixer" режим.** Ввести новый
   `execution_mode = read_write_with_repair` для verification.ac задач.
   Verifier может править код, но с ограничениями (например, только в
   `tests/` или только в указанных в hint файлах). Тогда нарушение
   CGAD становится задокументированным компромиссом.

3. **Не менять, задокументировать как known limitation.** Verifier
   иногда правит код — это работает на практике, нарушает теорию.
   Принять как trade-off, описать в SKILL.md как "verifier MAY apply
   small fixes from hints; for structural changes escalate to dev".

**Рекомендация:** Опция 1 (enforce read_only) — самая чистая. Заставляет
saga использовать правильный путь (dev-side fix через эскалацию,
см. Дыра E+ механизм 3 — specialised skill escalation). Без enforcement
верификатор маскирует настоящую проблему (отсутствие specialist escalation)
тем, что делает работу dev-воркера.

Однако — если механизмы эскалации из Дыры E+ **не реализованы**, опция 1
приведёт к тому, что все Lighthouse-подобные задачи будут циклиться.
То есть enforcement нужно вводить **вместе** с circuit breaker / hint
channel, не отдельно.

**Факт-чекинг:**
- task #31 task_kind='verification.ac', execution_mode='read_only_evidence'
  (подтверждено DB)
- worker-2 role=reviewer в heartbeat (подтверждено логом)
- 7 Edit, 1 Write в логе worker-2 (подтверждено парсингом JSONL)
- Lighthouse перешёл с 78 на ≥80 после правок (worker-2 сам записал
  evidence=passed)
- `execution_mode=read_only_evidence` **не enforced** инструментально в
  claude-runner.mjs (там только `--disallowedTools mcp__saga__worker_next`,
  Edit/Write разрешены)

---

#### Дыра F: kanban скрывает агентский цикл — нет attempt history

**Источник:** наблюдение за #31 (38 failed без сохранения истории между
попытками) + обсуждение команды 2026-07-20.

**Контекст.** Канбан-метафора (todo → in_progress → done) пришла из
человеческих project-management систем (Atlassian Jira, Trello). Человек не
делает 38 попыток на одной задаче — он либо делает, либо эскалирует.

Но saga — **агентская система**. Один контракт (AC) может пережить **N попыток**
(каждая — отдельный worker с чистым контекстом). Это норма, не ошибка.
Применять к агентскому циклу человеческий kanban **без расширения** — терять
критическую информацию.

**Что происходит сейчас:**

```
worker fails → recovery → task in todo → fresh worker (cold start) → fails again
```

Каждый новый worker начинает **с пустым контекстом**. Не знает:
- Что предыдущие 37 попытались
- Какие подходы уже проверены
- Какой именно gate провален (Lighthouse=78, не абстрактный "failed")
- На какой модели и с каким контекстом предыдущие запускались
- Сколько правок кода уже сделано

**Что нужно хранить** в `tasks.metadata.attempt_history[]` (массив объектов):

| Поле | Зачем | Пример |
|---|---|---|
| `attempt_number` | счётчик для circuit breaker | `38` |
| `worker_id` | какой воркер пытался | `board-1-1784569756287-3` |
| `outcome` | passed/failed/unknown | `failed` |
| **`recovery_summary`** | **вербальная рефлексия: почему вернули** | "Lighthouse=78, blocker: vendor-three.js 612KB synchronous в entry chunk" |
| `model` | какая модель | `qwen3.6-35b-a3b@q4_k_xl` |
| `context_peak` | размер контекста в этой попытке | `152745` |
| `tool_use_count` | сколько всего действий | `39` |
| `edit_count` | сколько правок кода | `0` ← критический сигнал |
| `failed_at` | timestamp | `2026-07-20T17:48:58Z` |
| `evidence_id` | ссылка на verification_evidence | `69` |

**Почему именно эти поля:**

- **`recovery_summary`** — самое ценное. Это **verbal RL рефлексия**
  ([Shinn 2023, Reflexion](https://arxiv.org/abs/2303.11366)). Verifier пишет
  failed evidence → заодно пишет короткое резюме почему. Следующий worker
  читает это — не начинает с пустого контекста. Это **ровно тот hint, что мы
  написали руками в description**, но генерируется автоматически verifier'ом
  и сохраняется типизированно.

- **`context_peak` + `model`** — для specialist routing. Если видим
  "worker на qwen3.6-35b с контекстом 152k fail'ит 3 раза" → это сигнал
  поднять более сильную модель (z.ai glm-5.2) или специалиста
  (saga-perf-tuner).

- **`edit_count`** — различие между "worker ничего не пробовал" (edit_count=0)
  и "worker пытался, но не вышло" (edit_count=7). Разные сценарии → разные
  эскалации. Это **позволяет circuit breaker'у принимать умные решения**.

**Как это меняет recovery loop:**

```
worker fails → writes recovery_summary →
  attempt_history.append({outcome:'failed',
    recovery_summary:'Lighthouse=78, vendor-three.js 612KB',
    context_peak:152745, edit_count:0}) →
  todo → fresh worker читает attempt_history →
    "ага, предыдущие 3 попытки не правили код, надо Edit" →
    пробует другой подход → succeeds
```

**Circuit breaker с умной эскалацией** (на основе attempt_history):

```typescript
function onFailed(task, evidence, recoverySummary) {
  const attempts = JSON.parse(task.metadata.attempt_history || '[]');
  attempts.push({
    attempt_number: attempts.length + 1,
    worker_id, outcome: 'failed', recovery_summary: recoverySummary,
    model: currentModel, context_peak: peakContext, 
    edit_count: editCount, failed_at: now, evidence_id
  });
  
  const n = attempts.length;
  updateTask(task.id, {
    metadata: { attempt_history: JSON.stringify(attempts) }
  });
  
  // Умная эскалация по паттерну провалов
  const lastAttempt = attempts[attempts.length - 1];
  
  if (n >= 3 && lastAttempt.edit_count === 0) {
    // Worker'ы ничего не правили → нужен specialist
    addTag('needs-specialist');
    routeToSpecialist(task);  // saga-perf-tuner, saga-a11y-expert, etc.
  } else if (n >= 5) {
    // 5 неудач даже с правками → needs-human
    addTag('needs-human');
  }
}
```

**Recovery worker (saga-recovery) триггерится по счётчику:**
- При `n=3` с `edit_count=0` → запускает `saga-perf-tuner` (или другой
  specialist по домену failed-задачи)
- Specialist читает `attempt_history` → понимает что пробовали →
  генерирует diagnosis/plan → передаёт свежему dev-воркеру через hint
- При `n=5` → `needs-human`, saga останавливается

**Почему это допустимо несмотря на "нарушение канбана":**

Классический канбан предполагает 1 задача = 1 человек = 1 попытка. В агентском
дроп-цикле (agent drop-cycle) **нормально** делать N попыток — это часть дизайна.
Канбан **должен быть осведомлён об итерациях**, иначе он скрывает критическую
информацию. Это не "поломка канбана", а **расширение его под агентский use case**.

Связь с литературой:
- **Reflexion** ([Shinn 2023](https://arxiv.org/abs/2303.11366)) — verbal RL
  через episodic memory. `recovery_summary` = episodic memory saga.
- **Voyager skill library** ([Wang 2023](https://arxiv.org/abs/2305.16291)) —
  накопление verified skills. `attempt_history` + specialist routing = путь
  к skill library: каждый успешный recovery → переиспользуемый skill.
- **TAO hierarchical escalation** ([arxiv 2506.12482](https://arxiv.org/html/2506.12482v2))
  — complexity-based routing. Circuit breaker → specialist = TAO tier.

**Реализация:**

- `tasks.metadata.attempt_history` — JSON array, append-only.
  ~30 LoC в `verification_record` / `worker_done` handler.
- `recovery_summary` — новое поле в verifier SKILL: "при failed пиши 1-2
  предложения диагностики в comment_add с prefix `RECOVERY:`". Handler
  парсит и кладёт в attempt_history.
- Circuit breaker в `orchestrate.ts` pump-loop: проверяет
  `metadata.attempt_history` length, эскалирует. ~25 LoC.
- Specialist routing: tag-based dispatcher extension. ~50 LoC.
- UI: kanban card показывает `⚠ 38 attempts (last: Lighthouse=78)` red badge.

**Объём:** ~105 LoC + SKILL patches + UI badge. Без изменений saga-core схемы
(всё в `metadata`).

**Главный вывод:** Канбан для людей и агентский drop-cycle — **разные модели**.
saga имеет право расширить kanban: хранить attempt history, model, context_peak,
edit_count, recovery_summary. Без этого saga слепа к собственным итерациям и
обречена на cold-start retries. С этим — recovery worker может триггериться по
счётчику и запускать нужный specialist skill. Это **минимальная** необходимая
эволюция kanban под агентский режим.

---


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
