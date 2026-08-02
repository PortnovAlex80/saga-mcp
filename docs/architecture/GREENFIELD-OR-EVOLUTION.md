# Greenfield или эволюция: пересмотренный вердикт

> Анализ выполнен после кибернетического аудита (CYBERNETIC-ANALYSIS.md) и
> сверки с существующим планом CONVEYOR-MENTAL-MODEL.md. Документ
> фиксирует стратегическое решение: продолжать эволюцию (волны), а не
> переписывать систему с нуля, и определяет, какие именно следующие шаги
> вытекают из кибернетического анализа, но **отсутствуют** в текущем
> плане.

## 1. Что показал сводный анализ

| Источник | Что говорит |
|---|---|
| BIRDS-EYE-VIEW.md | Система работает, но несёт ~60% accidental complexity |
| CYBERNETIC-ANALYSIS.md | Целевая архитектура: functional core + tagless final + hexagons + typed capabilities |
| CONVEYOR-MENTAL-MODEL.md | **Уже существующий 10-волновой план рефакторинга** (Wave 0-9) с целевой гексагональной архитектурой, VSM и DDD |
| Код (прочитанный полностью) | **Waves 0-9 в значительной степени выполнены** |

## 2. CONVEYOR-MENTAL-MODEL.md — не описание, а живой roadmap

Документ уже определяет:

- Гексагональную архитектуру с inbound use cases и outbound ports (строки 552-630)
- 6 bounded contexts в VSM-терминологии (Conveyor Runtime, Work Dispatch, Module Contracts, Production & Evidence, Module Catalog, Lifecycle Composition)
- DDD aggregates: ProcessRun, Card, WorkerExecution, RecoveryCase, Product, ModuleInstallation
- 7 чистых политик (FlowTransition, DispatchPriority, Recovery, LeaseExpiry, ResumeCompatibility, ProductAcceptance)
- 25 acceptance criteria для factory model
- 17 mandatory end-to-end scenarios
- 12 architecture review questions

Это **более детальный план**, чем мой кибернетический анализ предлагал.

## 3. Что из плана уже сделано (по сверке с кодом)

CONVEYOR-MENTAL-MODEL.md фиксирует «Current baseline» (2026-08-01) с
открытыми пунктами. Сверка с кодом показывает, что **большинство уже
закрыто**:

| Пункт baseline | Реальное состояние |
|---|---|
| LmNodeExecutor passes claimScope | ✅ Сделано — assignTask через WorkAssignmentPort |
| dispatch-loop без atomic select-and-assign | ✅ Сделано — SqliteWorkAssignmentAdapter |
| Module implementations still contain getDb | ✅ Сделано — Wave 7 вынес за порты |
| dependency-direction ratchet has allowlist | ✅ Сделано — KNOWN_VIOLATIONS = 0 |
| reconcile() has no production scheduling | ✅ Сделано — orchestrate-cli вызывает startWorkerSupervision |
| No durable periodic lease heartbeat | ✅ Сделано — lease_expires_at, heartbeat_at, progress_at |
| No stuck policy (observe→cancel→terminate) | ✅ Сделано — decideStuckAction (pure) + reconcileWorkerExecutions |
| Resume-tolerant package replacement | ✅ Сделано — replaceOnDigestChange в installPackage |
| Execution-scoped product lookups | ✅ Удалены — Wave 6 cutover (no-execution-scoped-lookup.test.mjs) |

**Вывод:** Waves 0-9 из CONVEYOR-MENTAL-MODEL выполнены. Система прошла
через направленную эволюцию и ratchet держит результат.

## 4. Пересмотренный вердикт: НЕ greenfield

Первоначальный аргумент за greenfield был: «accidental > essential
(60/40), 13+ волн пройдено, усталость». Но:

1. **Wave-подход работает в этом проекте.** 9 волн выполнено, система
   работает, ratchet держит, KNOWN_VIOLATIONS = 0.
2. **Каждая волна оставляла repository buildable.** Это не переписывание,
   а направленная эволюция.
3. **Документ уже описывает целевую архитектуру** — гексагон, VSM, DDD,
   pure policies. Не нужно изобретать заново.
4. **Essential knowledge (CGAD, recovery, authority, settlement
   policies) нельзя переносить механически** — это выстраданный
   tacit-knowledge, а не код.

**Решение: продолжать эволюцию волнами, не переписывать.**

## 5. Что кибернетический анализ добавляет к существующему плану

CONVEYOR-MENTAL-MODEL.md фокусируется на **conveyor mechanics**
(workplace/worker/card/desk, hooks, supervision, recovery). Кибернетический
анализ выявил три направления, которых план **не покрывает**:

### 5.1. Variety reduction (Закон Эшби) — НЕТ в плане

План описывает allowlist (authority gateway, frozen execution_context).
Но не ставит вопрос: **можем ли мы сделать запреты невыразимыми через
типы?** Authority gateway фильтрует вызовы по списку строк; typed
capability surface делает недопустимое **unrepresentable**.

Это не refinement allowlist'а, а **парадигмальный сдвиг**: от
правил-как-фильтров к типам-как-границам.

### 5.2. S1/S3 separation (VSM Бира) — НЕТ в плане

План разделяет bounded contexts, но settlement policy всё ещё **внутри
kernel handler'а** (`formalization-installation.ts:843-995`). В VSM Бира
S3 (regulation) наблюдает за S1 (operations) **сверху**. Разделение:

- **S1 (operational):** kernel handler производит артефакты, возвращает
  Production + ModuleCompletion
- **S3 (regulator):** settlement policy (pure function) решает, соответствует ли
  production стандарту

Сейчас они в одном файле. Разделение = независимое тестирование каждой
ответственности.

### 5.3. Functional core / Tagless final — НЕТ в плане

План говорит «policies must be pure», но не идёт до конца: domain как
**чистая функция**, effects через **algebra/interpreter**. Settlement
policy уже pure, но kernel handler'ы содержат I/O (через порты). Tagless
final убирает I/O из domain полностью — domain описывает только логику,
interpreter выполняет эффекты.

### 5.4. Метаболический контроль (per-module concurrency budget) — НЕТ в плане

План описывает один глобальный `--concurrency=N`. Кибернетика
предполагает **per-module budget**: Discovery = 1 (последовательный),
Development = 8 (параллельный), Delivery = 1. Это адаптивный throughput
control, как rate-limiting enzymes в клетке.

### 5.5. Homeostatic adaptation (adaptive thresholds) — НЕТ в плане

Stuck policy использует фиксированные константы
(STUCK_SILENCE_MS = 10 min). В биологии пороги адаптируются к истории.
saga-mcp мог бы учиться: «этот worker обычно отвечает за 5 мин, молчит 8
→ подозрительно; другой обычно 15 мин, молчит 8 → нормально».

## 6. Следующие волны: A-F (достраивают, не повторяют)

Эти волны идут **после** Wave 0-9 из CONVEYOR-MENTAL-MODEL. Они не
дублируют выполненную работу, а добавляют новые измерения.

### Wave A: Контекстная очистка (1-2 недели)

Убирает accidental complexity без изменения поведения.

- Вынести Wave-археологию из комментариев в `docs/architecture/WAVE-LOG.md`
- Удалить v1 legacy path из GenericFlowExecutor (v2 = единственный)
- Удалить type-cycle workaround (развести completion/envelope)
- Consolidate `ManagedProductionLedger` в один canonical interface
- Разбить `tracker-view.mjs` (5605 строк) на http-server + kanban-render + ...

### Wave B: S1/S3 разделение (2-3 недели)

- Вынести settlement policy из kernel handler'ов в отдельные чистые функции
- Kernel handler (S1) производит артефакты + ModuleCompletion
- Settlement policy (S3) — отдельная pure function, вызывается после S1
- Независимое тестирование каждой ответственности

### Wave C: Functional core (3-4 недели)

- Доменный слой каждого модуля — чистые функции
- Эффекты через interpreters (tagless final)
- Composition: `discovery >=> formalization >=> development >=> delivery`
- Interpreter для production (SQLite, claude -p) и для tests (fakes)

### Wave D: Typed capabilities (2-3 недели)

- Worker capability = union type, не allowlist строк
- Authority gateway проверяет типизированные capability
- Invalid state is unrepresentable (Закон Эшби: variety reduction)
- CGAD lint rules count начинает **уменьшаться** (типы заменяют правила)

### Wave E: Homeostatic control (2-3 недели)

- Per-module concurrency budget (метаболический контроль)
- Adaptive thresholds (stuck-silence зависит от истории worker'а)
- Feedback loop: failed verification → повышает risk → усиливает gate

### Wave F: Composition slim-down (1-2 недели)

- `product-lifecycle-runtime.ts` → 4 `register*Module()` вызова
- Каждый `register*Module()` — в `modules/<name>/index.ts`
- Composition root ≈ 80 строк (вместо 780)
- Добавление модуля = 1 директория + 1 строка

## 7. Почему не greenfield: five reasons

1. **CONVEYOR-MENTAL-MODEL работает.** 9 волн выполнено, ratchet держит.
2. **Essential knowledge не переносим механически.** CGAD, GUARDRAILS,
   skills discipline — tacit knowledge из реальных инцидентов.
3. **Каждая волна оставляла систему buildable.** Greenfield теряет это
   свойство.
4. **Parallel greenfield разделяет внимание команды.** Пока одни строят
   новое, другие support старое — обе стороны теряют.
5. **Типы (Wave D) можно ввести инкрементально.** Typed capabilities
   накладываются поверх authority gateway, не требуют переписывания.

## 8. Стеклянный потолок: снимается ли?

Да, по мере выполнения Wave A-F:

| Волна | Эффект на контекстную нагрузку |
|---|---|
| A (очистка) | -30-40% (убирает wave-археологию, legacy paths, дубли) |
| B (S1/S3) | -10% (settlement отдельно — меньше контекста на понимание gate) |
| C (functional core) | -10% (domain = чистые функции, эффекты на краях) |
| D (typed capabilities) | -5% (меньше правил для запоминания) |
| F (composition slim) | -5% (composition root = 80 строк) |

**Кумулятивный эффект: -50-60% контекстной нагрузки.** Система становится
постижимой для агента с 64-200k контекстом — без переписывания.

## 9. Итог

CONVEYOR-MENTAL-MODEL.md — живой roadmap, который работает. Waves 0-9
выполнены. Кибернетический анализ добавляет Waves A-F — не повторение, а
**следующий уровень абстракции** (типы вместо правил, functional core,
homeostasis). Эти волны достраивают систему до теоретического оптимума,
не отбрасывая выстраданного essential knowledge.
