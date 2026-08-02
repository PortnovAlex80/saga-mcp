# Кибернетический анализ saga-mcp

> Анализ архитектуры saga-mcp через призму кибернетики, теории управления
> и науки об автономных агентных системах. Базируется на полном обзоре
> кодовой базы (≈890k токенов контекста, все ключевые файлы ветки saga4).
>
> Цель: определить, какая архитектура **правильна** для класса задач,
> который решает saga-mcp — управления неопределёнными автономными
> акторами (LLM-агентами), — и где текущий дизайн совпадает или
> расходится с теоретически обоснованным оптимумом.

## Постановка задачи

saga-mcp — не пайплайн и не трекер. Это **кибернетическая система
управления** для неопределённых автономных акторов. Класс задач тот же,
что у:

- автопилота (сделать турбулентную среду детерминированной по маршруту);
- гомеостаза в биологии (поддерживать стабильность через автоматическую
  коррекцию);
- заводского конвейера (сделать переменные входы → стабильный выход).

Каждая из этих дисциплин выработала свои принципы. Вопрос: насколько
saga-mcp им соответствует.

---

## 1. Закон Эшби о необходимом разнообразии (1956)

> «Разнообразие управляющей системы должно быть не меньше разнообразия
> возмущений, которые она регулирует.»

### Как сейчас

saga-mcp перечисляет каждый возможный недопустимый ход: 18 правил
CGAD-lint, ~25 forbidden constructs в спецификации, allowlist в authority
gateway. Это **variety amplification** — попытка угнаться за каждым
возможным поведением агента.

### Проблема

LLM-агенты имеют практически бесконечное поведенческое разнообразие.
Контрольная система никогда не перечислит все отказы. Это фундаментальный
стеклянный потолок: **правила всегда отстают от способов их обойти.**

### Элегантная альтернатива: Variety reduction

Не ловить ошибки, а сделать их **невыразимыми**. Не «агенту запрещено
вызывать `worker_next`» (он может попытаться), а «агент не имеет операции
`worker_next` в своём словаре». Authority gateway уже делает это
(allowlist), но частично. Полная реализация — **typed capability
surface**:

```typescript
// Вместо 90 инструментов, 80 из которых запрещены каждому воркеру:
type WorkerCapability =
  | { kind: 'read_task'; taskId: number }
  | { kind: 'write_artifact'; artifact: ArtifactInput }
  | { kind: 'complete_task'; result: string; verdict?: Verdict }
  | { kind: 'merge'; commitSha: string }

// Агент физически не может выразить недопустимое действие —
// тип не позволяет. Invalid state is unrepresentable.
```

Не «не вызывай это», а «это не существует в твоём мире».

---

## 2. Теорема Конанта о хорошем регуляторе (1970)

> «Каждый хороший регулятор системы должен быть моделью этой системы.»

### Как сейчас

Модель работы агента — граф артефактов (artifacts + traces + evidence).
Контроль работает по модели, не по агенту напрямую. Это **правильно**.

Но модель и реальность могут **расходиться**: агент пишет код, тесты
проходят, но AC не удовлетворён (GUARDRAILS Sign 006). Модель говорит
«implemented + verified», реальность — «не работает».

### Элегантная альтернатива: Executable specification

Модель ЕСТЬ спецификация ЕСТЬ тест. Не три отдельные сущности
(AC-документ → код → property test), а одна:

```typescript
// AC — это не markdown. Это тип, который одновременно:
//   - описывает требование
//   - генерирует property test
//   - является оракулом для верификации
type AC = {
  invariant: (input: Input, output: Output) => boolean
  examples: Example[]
  properties: Property[]
}
```

Сейчас property test — отдельный шаг, который verifier пишет вручную. В
элегантной архитектуре AC генерирует property test автоматически из своего
типа.

---

## 3. Viable System Model Стаффорда Бира (1972)

VSM описывает любую жизнеспособную систему через 5 подсистем.

| VSM | Функция | В saga-mcp | Чисто? |
|---|---|---|---|
| **S1** Operations | делает работу | Process Modules, Workers | да |
| **S2** Anti-oscillation | предотвращает дестабилизацию | conflict_keys, merge-lock, worktree | да, но verbose |
| **S3** Internal regulation | распределяет ресурсы, аудит | dispatcher, settlement policies | **смешано с S1** |
| **S4** Intelligence | сканирует среду, планирует | Discovery, hypothesis cycle | **неполный** |
| **S5** Policy/identity | задаёт нормы | CGAD Constitution | **частично prose** |

### Главное нарушение

S3 (regulation) встроена в S1 (operations). Settlement policy живёт
внутри kernel handler'а модуля (formalization-installation.ts:843-995 —
settlement handler в том же файле, что и operational resolvers). В VSM
эти слои **разделены**: S3 наблюдает за S1 сверху, S1 не знает о
существовании S3.

### Элегантная альтернатива: Разделение S1 и S3

```
S1 — операционный (выполняет работу, возвращает результат):
  kernel-handler: (input) → Production + ModuleCompletion
  // «Я произвёл эти артефакты, вот доказательства»

S3 — регулятор (проверяет, решает):
  settlement-policy: (Production, Evidence, Baseline) → Decision
  // «Произведённое соответствует или нет стандарту»
```

В saga-mcp эти две функции в одном файле. Разделение = тестирование
каждой независимо + понятность каждой в отдельности.

---

## 4. Иерархическое управление (Месарович, 1970)

Высшие уровни задают ограничения, низшие решают внутри них.

```
L4: Constitution (CGAD P0-P18)
L3: Lifecycle Orchestrator (stage routing)
L2: Process Module Flow (node sequencing)
L1: Worker (one task execution)
L0: SQLite / Git / claude -p (substrate)
```

### Нарушение

Development module's `areProjectedTasksTerminal` — это L1/L2 узел
(settle-development), принимающий L3 решение (ждать пока все задачи
завершатся). Нарушение иерархии: уровень 1 лезет в координацию уровня 3.
GenericFlowExecutor не имеет condition-wait, поэтому модуль эмулирует его
через `runtimeEvent: 'paused'` — и orchestrate-cli в цикле drain'ит
worker_next очередь.

### Элегантная альтернатива

Conveyor (L3) сам проверяет, завершены ли projected tasks. Модуль (L2)
только декларирует «я нуждаюсь в этих задачах», а conveyor решает когда
продолжить. Это разделяет ответственность: модуль описывает семантику,
conveyor управляет потоком.

---

## 5. Целевая архитектура: Pure Functional Pipeline + Tagless Final

> Весь жизненный цикл продукта — **чистая функция** от идеи до
> проверенного продукта.

### Базовая идея

Доменный слой — чистые функции. Они ничего не читают из БД, не вызывают
claude, не пишут в Git. Они берут вход и возвращают выход.

Побочные эффекты — на краях, через алгебру (tagless final):

```typescript
// Алгебра — интерфейс эффектов, которые нужны домену
interface DiscoveryAlgebra<F> {
  investigate: (idea: Idea) => F<Proposal>;
  assessReadiness: (proposal: Proposal) => F<Readiness>;
  settle: (proposal: Proposal, readiness: Readiness) => F<Certificate>;
}

// Чистая программа — композиция эффектов
function discoveryProgram<A>(alg: DiscoveryAlgebra<A>, idea: Idea): A {
  return pipe(
    alg.investigate(idea),
    chain(proposal => alg.assessReadiness(proposal)),
    chain(readiness => alg.settle(proposal, readiness)),
  );
}

// Production interpreter — реальные побочные эффекты
const sqliteInterp: DiscoveryAlgebra<Promise> = {
  investigate: idea => spawnWorker('saga-discovery-worker', idea),
  assessReadiness: p => spawnWorker('saga-readiness-advisor', p),
  settle: (p, r) => runSettlementPolicyV1(p, r),
};

// Test interpreter — чистый, детерминированный
const fakeInterp: DiscoveryAlgebra<Identity> = {
  investigate: idea => ({ problem_statement: idea }),
  assessReadiness: () => ({ overall_readiness: 'ready' }),
  settle: () => ({ decision: 'go' }),
};
```

### Структурная декомпозиция

```
shared/
  algebra/                    ← интерфейсы эффектов (не реализации)
    persistence.ts            ← save/load artifacts, tasks, evidence
    computation.ts            ← run LM, get typed result
    observation.ts            ← observe runtime (metrics, logs)
    time.ts                   ← now()
  canonical/                  ← sha256Hex, canonicalJson
  cgad/                       ← Constitution as typed predicates
    constitution.ts           ← P0-P18 as (state) → boolean
    policy-version.ts         ← immutable policy versioning

modules/                      ← каждый — самодостаточный гексагон
  discovery/
    domain/                   ← ЧИСТЫЕ функции и типы
      settlement-policy.ts    ← (Proposal, Readiness) → Decision
      certificate.ts          ← immutable type
      proposal.ts             ← input type
    application/              ← чистая композиция
      program.ts              ← Kleisli pipeline
    infrastructure/           ← интерпретаторы алгебры
      sqlite-interpreter.ts
    index.ts                  ← register(lifecycle, sharedDeps)
  formalization/              ← та же структура
  development/
  delivery/

runtime/
  conveyor.ts                 ← walks stages, threads pure results
  supervisor.ts               ← S2: anti-oscillation (conflict, reaper)
  recovery.ts                 ← pure: (Failure, Policy) → Action

composition/
  product-delivery.ts         ← discovery >=> formalization >=> ... >=> delivery
  interpreters.ts             ← production interpreters
```

### Жизненный цикл как Kleisli composition

```typescript
discovery :: Idea → Either<Clarify, DiscoveryCertificate>
formalization :: DiscoveryCertificate → Either<Inconsistency, SolutionContract>
development :: SolutionContract → Either<Rework, VerifiedBundle>
delivery :: VerifiedBundle → Either<Blocked, ReleaseRecord>

// Композиция — Kleisli binding
product = discovery >=> formalization >=> development >=> delivery
```

---

## 6. Влияние на стеклянный потолок

Стеклянный потолок текущей архитектуры — не одна точка, а кумулятивная
нагрузка. Каждый файл на 30-40% длиннее из-за Wave-археологии в
комментариях; каждый модуль требует чтения saga3/; composition root — 780
строк. Сумма этих overhead'ов делает систему непостижимой для агента с
ограниченным контекстом.

### Метрика: на сколько снижается контекстная нагрузка

| Вопрос агенту | Сейчас (строк) | После (строк) |
|---|---|---|
| «Почему formalization не выдал сертификат?» | 3300 в 4 директориях | 300 в одной |
| «Как добавить пятый модуль?» | 7 файлов, 600+ строк | 1 директория, 1 строка в composition |
| «Что делает вся система?» | недоступно (<1M контекста) | `product-delivery.ts` — 10 строк |
| «Что делает один модуль?» | 8-12 файлов, 4 директории | 4-6 файлов, 1 директория |

После рефакторинга:
- Агент с **64k контекста** может работать с одним модулем целиком
- Агент с **200k контекстом** может работать с 2-3 модулями + runtime core
- Агент с **200k контекстом** может добавить новый модуль, не читая
  остальные
- Composition root читается за один взгляд

---

## 7. Практики из науки об автономных агентных системах

### Уже реализованы (правильные подходы)

**Стигмергия** (термитники, Grace 2006): агенты координируются через
общую среду, а не через прямую коммуникацию. saga-mcp: artifact graph —
workers видят артефакты друг друга, не сообщения. Элегантно и правильно.

**Theory of mind** (Premack & Woodruff, 1978): каждый агент имеет модель
того, что делают другие. saga-mcp: `active_tasks[]` в ответе
worker_done. Правильно, но можно усилить — каждый worker должен видеть не
только task list, но и artifact graph соседей.

**Апоптоз** (запрограммированная гибель клетки): если единица неисправима
— она умирает. saga-mcp: `RecoveryExhaustedError` → pause для человека.
Правильно.

### Отсутствуют или неполны

**Метаболический контроль**: rate-limiting enzymes управляют throughput
путём inhibition/activation. saga-mcp: `--concurrency=N` — глобальный.
Элегантнее — **per-module concurrency budget**: Discovery = 1
(последовательный), Development = 8 (параллельный), Delivery = 1
(последовательный). Это адаптивный throughput control.

**Гомеостатическая адаптация**: пороги correction фиксированы
(STUCK_SILENCE_MS = 10 min). В биологии пороги адаптируются к истории.
saga-mcp мог бы учиться: «этот worker обычно отвечает за 5 мин, молчит 8
→ подозрительно; другой обычно 15 мин, молчит 8 → нормально». Это
adaptive thresholding.

**Negative feedback loop ( homeostat)**: У. Росс Эшби (1952) — система
поддерживает стабильность, автоматически корректируя параметры. saga-mcp:
rate-limit scanner снижает concurrency при 429 → это работает, но
только для одного параметра. Элегантнее — гомеостат, который
корректирует не только concurrency, но и: retry budget, model selection
(более сильную модель для сложных задач), timeout thresholds.

---

## 8. Сводная таблица: где saga-mcp совпадает и расходится с теорией

| Принцип | Соответствие | Действие |
|---|---|---|
| Эшби: необходимое разнообразие | Частичное — amplification вместо reduction | Typed capabilities |
| Конант: регулятор = модель | Да — artifact graph | executable spec (AC = test) |
| Бир: S1/S3 разделение | Нет — settlement в kernel handler | Вынести S3 |
| Бир: S4/S5 полнота | Частичное — Constitution как prose | Typed CGAD predicates |
| Месарович: иерархия уровней | Нарушение — L1 принимает L3 решения | Conveyor condition-wait |
| Functional pipeline | Нет — побочные эффекты в domain | Tagless final |
| Hexagonal modules | Частичное — модули разбросаны по директориям | Self-contained hexagons |
| Стигмергия | Да — artifact graph | — |
| Апоптоз | Да — RecoveryExhausted | — |
| Метаболический контроль | Глобальный только | Per-module budget |
| Adaptive thresholds | Нет — фиксированные константы | Homeostat |

---

## 9. План трансформации (волновой, обратимый)

### Wave A: Очистка (accidental complexity → 0)

1. Вынести Wave-археологию из комментариев в `docs/architecture/WAVE-LOG.md`
2. Удалить v1 legacy path из GenericFlowExecutor (v2 = единственный)
3. Удалить type-cycle workaround (развести completion/envelope)
4. Consolidate `ManagedProductionLedger` в один canonical interface

### Wave B: Модульная автономия (каждый модуль — гексагон)

5. Перенести `saga3/domain/discovery-*` → `modules/discovery/domain/`
6. Перенести `saga3/application/` → `modules/discovery/application/`
7. Перенести `saga3/persistence/` → `modules/discovery/infrastructure/`
8. Перенести `saga3/authority/` → `shared/authority/`
9. Каждый модуль получает `index.ts` с `register(deps)`

### Wave C: Composition slim-down

10. `product-lifecycle-runtime.ts` → 4 `register*Module()` вызова + sharedDeps
11. Каждый `register*Module()` — в `modules/<name>/index.ts`
12. `tracker-view.mjs` — разбить на `http-server.mjs` + `kanban-render.mjs`

### Wave D: Functional core

13. Доменный слой — чистые функции (settlement policy уже чистая)
14. Побочные эффекты — на края, через interpreters (tagless final)
15. Kleisli composition: `product = discovery >=> formalization >=> development >=> delivery`

### Wave E: Variety reduction

16. Typed capability surface — агент выражает действия только через тип
17. Authority gateway остаётся, но проверяет типизированные capability, не строки
18. Rules count (CGAD lint) начинает **уменьшаться**: запреты уходят, типы берут на себя

### Wave F: Homeostasis

19. Per-module concurrency budget (метаболический контроль)
20. Adaptive thresholds (stuck-silence зависит от истории worker'а)
21. Feedback loop: failed verification → повышает risk → усиливает gate

---

## 10. Итог

Текущая архитектура saga-mcp — продукт эволюции, а не дизанйа. Каждое
решение в ней обосновано (ADR, GUARDRAILS, Wave spec), но кумулятивный
эффект — система, которая делает правильные вещи, но требует ~1M контекста
чтобы понять, какие именно.

Элегантная архитектура для этого класса задач:
- **Pure functional core** (чистые доменные функции)
- **Tagless final** (эффекты на краях, интерпретируемые)
- **Hexagonal modules** (самодостаточные гексагоны)
- **Typed capabilities** (invalid state unrepresentable)
- **Homeostatic control** (адаптивные пороги, per-module budget)

Это снижает контекстную нагрузку на 40-60% и делает систему постижимой
для агента с 64-200k контекстом — что и есть снятие стеклянного потолка.
