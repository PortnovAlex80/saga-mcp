# План: перестановка SRS после AC + связывание Complexity Gate + декомпозиция

**Статус:** DRAFT
**Дата:** 2026-07-20
**Автор:** сессия пользователя (GLM-5.2 + user)
**Связанные артефакты:** note #1 (research decomposition approaches), Cannon REQ-001 (полигон)

---

## §0. Для чего мы это делаем — корень проблемы

### Фундаментальный принцип разработки (идеальный flow)

```
ИДЕЯ → ПОЧЕМУ → ЧТО → КАК ИСПОЛЬЗУЮТ → КАК ПРОВЕРИТЬ → КАК ПОСТРОИТЬ → КОМПОНЕНТЫ → РАБОТА → КОД → ПРОВЕРКА → ПРОД
       │         │       │                  │                 │               │           │        │          │
      BRIEF     PRD      UC                 AC                SRS         DECOMP        Planning  Dev      Verify    Integrate
```

Каждый шаг берёт вход от предыдущего. **Шаг «КАК ПОСТРОИТЬ» (Architecture/SRS) невозможен, пока не определён шаг «КАК ПРОВЕРИТЬ» (AC)** — нельзя выбрать архитектуру, не зная что строить и с какой сложностью.

### Корень проблемы

**Шаг 5 (SRS/Architecture) стоит НЕ на своём месте.**

### Как было (текущий pipeline)

```
BRIEF → PRD → [SRS + UC параллельно] → AC → Reconcile → Planning → Development
                   ↑
                   архитектор выбирает архитектуру (Hexagonal/Modular/KISS)
                   НЕ ВИДЯ AC — вслепую, на основе только PRD
```

Цепочка `workflow.ts` transitions:
```
brief_accepted  → prd_accepted → (srs_accepted || uc_accepted) → ac_accepted → baseline_accepted → planning
                                  ↑
                                  SRS и UC параллельно из PRD
```

### Какую боль это создаёт (наблюдения на Cannon REQ-001)

**Боль 1. Over-engineering.** Для Cannon (web-калькулятор баллистических траекторий, complexity M) saga-architect выбрал **Hexagonal / Ports & Adapters** с 5 модулями и 3 портами (SRS §2.1, строки 59-69). Для single-page калькулятора это избыточно — должно было быть Modular Monolith или KISS, 2-3 модуля. Доказательство: scaffold #10 «случайно» реализовал 80% всей логики (physics, renderer, ephemeris) — декомпозиция на 15 dev-задач оказалась избыточной, 5-6 из них свелись к дописыванию stubs.

**Болb 2. Planner работает вслепую.** saga-planner не использует SRS §2b Port Registry. Он копирует AC в description дословно (`SKILL.md:73-75`):
```
description: the AC's Given/When/Then + a pointer to the .md path + the FR
```
Body-задачи не знают, в какой файл писать, какие функции реализовывать. Воркер #9 (Trajectory Engine) потратил 7 Read на exploration структуры, которую scaffold уже создал. SRS §2b прямо содержит машино-читаемую строку `file_path=src/physics/orbital.ts, schema=OrbitResult, public_protocol=PhysicsEnginePort` — но planner её игнорирует.

**Боль 3. Рассинхрон SRS ↔ scaffold.** SRS §2b говорит `file_path=src/physics/orbital.ts`. Scaffold-воркер в ARCHITECTURE.md материализовал `src/physics-engine/orbital.ts`. Архитектор и scaffold уже разошлись — любой подход должен это учитывать.

**Боль 4. NFR-задачи идут как `development.code`.** Planner создал 7 NFR-задач (AC-NFR-1..7) как dev-задачи. Но NFR-1 (page load) — это настройки Vite, не отдельный код. NFR-5 (cross-browser) — это testing, не код. Planner не различает implement vs verify, потому что у него нет архитектурного контекста.

**Боль 5. Conflict keys бесполезны.** Все 15 dev-задач получили только `integration_branch=dev` (общий ключ) — потому что planner не проставил `metadata.target_file`/`schema`/`public_protocol`. Параллельная разработка (если бы она была нужна) не была бы защищена от файловых конфликтов.

### К чему идём (целевой pipeline)

```
BRIEF → PRD → UC → AC → Reconcile → SRS+DECOMP → Planning → Development → Verification → Integration
                                            ↑              ↑
                                            шаг 5 тут      планировщик = dumb copier
                                            архитектор ВИДИТ AC, выбирает стиль
                                            под их количество/сложность/связность
```

Цепочка `workflow.ts` transitions:
```
brief_accepted → prd_accepted → uc_accepted → ac_accepted → baseline_accepted
                                                                   ↓
                                                          srs_accepted (НОВЫЙ переход)
                                                                   ↓
                                                          decomp_accepted (НОВЫЙ)
                                                                   ↓
                                                          planning
```

### Какие боли закрывает (прогноз)

| Боль | Сейчас | После | Механизм |
|---|---|---|---|
| Over-engineering | Hexagonal для M-size | Modular Monolith через таблицу complexity→architecture | SRS пишется после AC, архитектор видит сложность + complexity.tshirt/topology_hint из brief |
| Planner вслепую | Копирует AC дословно | Dumb copier: читает DECOMP, копирует file_path/function/types в task.metadata | SRS содержит DECOMP §D2 с per-AC mapping |
| Рассинхрон SRS↔scaffold | Архитектор vs воркер расходятся | Один источник истины: DECOMP §D1 frozen file tree | Scaffold обязан следовать DECOMP, lint проверяет |
| NFR как dev.code | Все NFR → dev-задачи | NFR-AC либо verification-задачи, либо merge с FR-задачами | Архитектор классифицирует в DECOMP §D2 |
| Conflict keys пустые | Только integration_branch=dev | Полные: file_path+schema+public_protocol | Planner копирует из DECOMP в metadata + conflict_keys_auto_derive подхватывает |

---

## §1. Перекрёстные проверки гипотез

Перед началом работы — сверим, что гипотезы соответствуют фактам.

### Проверка 1.1. Complexity Gate действительно существует и его данные доступны

- [ ] `src/validators/brief.ts:36-65` содержит `BriefPayload` с `complexity.tshirt`, `topology_hint`, `shared_mutation_risk`
- [ ] Brief хранится в БД в `artifacts.metadata.brief_payload` (проверить SQL на Cannon epic 1)
- [ ] saga-kickstart SKILL документирует классификацию
- [ ] На Cannon: какой complexity.tshirt был установлен? (note: `discovery-brief.md` пропал, но в БД `artifacts.metadata` должен сохраниться)

### Проверка 1.2. Архитектор сейчас НЕ получает complexity контракт

- [ ] `skills/saga-architect/SKILL.md` — нет ссылок на `complexity.tshirt`/`topology_hint` (grep)
- [ ] `skills/saga-architect/SKILL.md` — нет таблицы «complexity → architecture»
- [ ] На Cannon SRS §2.1: выбор Hexagonal не обоснован сложностью — просто «primary style»

### Проверка 1.3. Архитектор работает до AC

- [ ] `workflow.ts:190-205` — `prd_accepted` создаёт SRS+UC параллельно (SRS до AC)
- [ ] `workflow.ts:223-260` — AC создаётся после SRS+UC, читает SRS (FR/NFR/invariants)
- [ ] На Cannon: timestamps artifacts — SRS created раньше AC? (проверить SQL)

### Проверка 1.4. Planner игнорирует SRS Port Registry

- [ ] `skills/saga-planner/SKILL.md:71-89` — bridge loop читает только AC, не SRS §2b
- [ ] На Cannon tasks: `metadata.target_file`/`schema`/`public_protocol` отсутствуют у всех dev-задач (проверить SQL)
- [ ] `src/tools/conflicts.ts:144-167` — `conflict_keys_auto_derive` умеет читать `metadata.target_file` (подтверждено, просто не заполняется)

### Проверка 1.5. Трассировка graf не сломается при перестановке

- [ ] `lifecycle.ts:assertTraceability` — AC→FR/NFR (не SRS), UC→PRD (не SRS), SRS→PRD (остаётся). Граф корректен после перестановки
- [ ] `lifecycle.ts:acceptedBaseline` — frozen baseline AC останется; но SRS теперь после baseline, нужен новый хэш-слой

### Проверка 1.6. Целостность скиллов (выполнено агентом 2026-07-20)

- [x] **Полный список скиллов: 17 шт.** (saga-orchestrator, saga-product, saga-architect, saga-architecture-reviewer, saga-analyst, saga-requirements-reviewer, saga-reconciler, saga-planner, saga-verifier, saga-worker, saga-dispatch, saga-kickstart, saga-start, saga-tracker, saga-release, senior-analyst, autonomous-recovery)
- [x] **Затронуто: 11 из 17** (6 YES обязательно + 5 MAYBE проверить). План изначально предполагал 8 — оценка занижена
- [x] **Ключевой блокер:** `saga-requirements-reviewer` строка 27 — проверяет `AC derived_from → FR/NFR`. FR/NFR сейчас создаются архитектором внутри SRS. После перестановки AC пишется ДО SRS → ребро невозможно → gate падает. Решение: FR/NFR переезжают в PRD (см. §2.2)
- [x] **Найден сторонний SKILL:** `.claude/skills/saga-mcp/SKILL.md` — spranab/saga-tracker v1.5.0. К перестановке отношения не имеет
- [x] **Агенты в `D:/Разработка/saga-mcp/agents/`:** saga-analyst, saga-architect, saga-planner, saga-product, saga-worker, saga-kickstart (6 шт). Агентов для orchestrator/reconciler/verifier/dispatch/tracker/start/reviewers/senior-analyst/recovery/release — нет, они вызываются через `Skill(...)` из main-context

### Проверка 1.7. Целостность тестов (выполнено агентом 2026-07-20)

- [x] **Всего test-файлов: 29** (просканированы все)
- [x] **Сломаются гарантированно: 3 файла, ~700-770 строк** (`formalization-mechanics.test.mjs`, `traceability-gate.test.mjs`, `product-workflow.test.mjs`)
- [x] **Maybe сломаются: 3 файла, ~50-80 строк** (`track-pipeline.test.mjs`, `fast-track.test.mjs`, `migration-tests.test.mjs`)
- [x] **НЕ затронуты: 23 test-файла**
- [x] **Ключевые helper'ы:** `seedTraceabilityPyramid` (product-workflow:41-76, используется в 4+ тестах), `buildCompletePyramid` (traceability-gate:58-124, во всех 9 тестах). Их правка каскадно обновит все зависящие тесты

### Проверка 1.8. Целостность документации (выполнено агентом 2026-07-20)

- [x] **Шаблоны: 3 существуют + 2 отсутствуют**. `acceptance-criteria.md` и `UC.md` шаблоны не существуют, хотя README на них ссылается — это pre-existing doc gap. Решить: создать или убрать ссылки
- [x] **Документация: 12 файлов затронуты** (~350-500 LoC). Изначально план упоминал только 3 — пропущены: `saga-flow-overview.md`, `saga-mcp-3.0-pipeline-ui-spec.md`, `saga-mcp-history.md`, `blog-saga-mcp-agent-governance.md`, `srs-br-and-traceability.md`, `saga-mcp-3.0-orchestration-plan.md`, ADR-008, ADR-012
- [x] **ADR-008** (`brief-accepted-prd-only.md`) — его rationale про `sibling()` между SRS и UC **инвалидирован** перестановкой. Нужен addendum или superseding ADR
- [x] **cgad-v2-spec.md** (1619 строк) — НЕ затронут, не упоминает PRD/SRS/UC/AC (проверено grep)
- [x] **GUARDRAILS.md** — НЕ затронут (Signs 001-011 — postmortems, не pipeline-спецификация)

---

## §2. Целевая архитектура процесса

### §2.1. Новый pipeline

```
Discovery:
  BRIEF (complexity.tshirt + topology_hint + shared_mutation_risk)
    ↓ brief_accepted
  PRD (scope, success criteria, hypotheses)
    ↓ prd_accepted
Formalization Part 1 (WHAT):
  UC (use cases, из FR в PRD)
    ↓ uc_accepted
  AC (acceptance criteria, из UC + FR + RULE)
    ↓ ac_accepted
  Reconciliation (проверка трассировки, hash freeze)
    ↓ baseline_accepted (заморозка AC baseline_hash)
Formalization Part 2 (HOW):
  SRS (архитектор ВИДИТ замороженные AC + brief complexity)
    ├─ §2.1 Architectural Style — выбор по таблице complexity→architecture
    ├─ §2.2 Module Manifest
    ├─ §2b Port Registry (if Hexagonal)
    ├─ §2.3 Invariant Registry
    └─ §D Decomposition — per-AC mapping в файлы/функции/типы
    ↓ srs_accepted (НОВЫЙ transition)
Planning:
  saga-planner (dumb copier) — читает DECOMP, создаёт задачи в БД
    ↓ planning complete
Development → Verification → Integration
```

### §2.2. Что переезжает между артефактами

| Поле | Было в | Стало в | Обоснование |
|---|---|---|---|
| FR (functional requirements) | SRS §1 | **PRD §3** | FR — это про ЧТО, а не КАК. PRD = бизнес-требования, FR — это их детализация |
| NFR (capacity targets) | SRS §3 | **PRD §3** | Аналогично — это про свойства, не про архитектуру |
| RULE (business rules) | SRS §5 | **PRD §3** | Бизнес-правила — прерогатива продукта |
| Architectural Style | SRS §2.1 | остаётся в SRS §2.1 | Это архитектура |
| Module Manifest | SRS §2.2 | остаётся в SRS §2.2 | Это архитектура |
| Port Registry | SRS §2b | остаётся в SRS §2b | Это архитектура |
| Invariant Registry | SRS §2.3 | остаётся в SRS §2.3 | Это архитектура (как обеспечивать) |
| Test Strategy L0-L4 | SRS §2.5 | остаётся в SRS §2.5 | Это архитектура тестирования |
| Tech Stack | SRS §9 | остаётся в SRS §9 | Это архитектурное решение |
| Glossary | SRS §7 | остаётся в SRS §7 | Ubiquitous language |
| DECOMP §D (новое) | — | SRS §D (новая секция) | Архитектурная декомпозиция AC → компоненты |

**Ключевая мысль:** PRD теперь отвечает «ЧТО», SRS — только «КАК (построить)». Раньше SRS смешивал оба.

### §2.3. Таблица complexity → architecture → decomposition

Эта таблица — основной новый артефакт, встраивается в SKILL saga-architect.

| complexity.tshirt | topology_hint | shared_mutation_risk | Архитектурный стиль | Pattern декомпозиции | Ожидаемое кол-во dev-задач |
|---|---|---|---|---|---|
| XS | sequence | false | KISS (single file) | Single task | 1 |
| S | sequence | false | KISS / Module | Pattern A (sequence) | 1-2 |
| M | sequence | false | Modular Monolith | Pattern A (sequence) | 2-4 |
| M | scaffold-then-parallel | true | Modular Monolith + Ports | Pattern B (scaffold + parallel) | 4-8 |
| L | scaffold-then-parallel | true | Hexagonal / Ports | Pattern B (scaffold + parallel) | 8-15 |
| XL | scaffold-then-parallel | true | Hexagonal / Clean Architecture | Pattern B + интеграция | 15-30 |
| L/XL | sequence | false | Layered / Pipeline | Pattern A + spikes для рисков | 5-12 |
| research | (any) | (any) | Spike-first | Spike tasks → повторное планирование | N spike + M body |

**Принцип:** архитектор не свободен в выборе — он обязан следовать таблице. Это убирает over-engineering.

### §2.4. DECOMP §D — формат per-AC mapping

Новая секция SRS, которую архитектор пишет зная все AC.

```yaml
# §D1 File Tree (frozen, canonical — scaffold обязан следовать)
src/
  physics/
    orbital.ts          # AC-1: calculateOrbit
    transfers.ts        # AC-4, AC-5: calculateMoonTransfer, calculateMarsTransfer
    constants.ts        # shared
  ui/
    calculator-form.tsx # AC-6

# §D2 AC → Implementation Map (одна строка на AC)
- ac: AC-1
  title: "Trajectory Calculation Engine"
  module: physics
  files: [src/physics/orbital.ts]
  functions: [calculateOrbit]
  types: [LaunchParameters, OrbitResult]
  public_protocol: PhysicsEnginePort
  conflict_keys:
    - {key_type: file_path, key_value: 'src/physics/orbital.ts'}
    - {key_type: schema, key_value: 'OrbitResult'}
    - {key_type: public_protocol, key_value: 'PhysicsEnginePort'}
  invariants: [INV-PHYS-1, INV-PHYS-3]
  test_layers: [L0, L2, L3]
  pattern: B          # потому что AC-4, AC-5 разделяют PhysicsEnginePort
  depends_on: [scaffold:physics]
  ac_kind: implementation   # implementation | verification | spike | merge_with

- ac: AC-NFR-1
  title: "Page Load Time"
  ac_kind: verification     # не dev-задача — это проверка через Lighthouse
  depends_on: [AC-7]        # после UI

# §D3 Priority rationale (критический путь)
- AC-1: high (consumed by AC-2, AC-4, AC-5 — Shared Kernel)
- AC-2: medium
...

# §D4 Pattern selection per module cluster
- cluster: physics (AC-1, AC-4, AC-5)
  pattern: B (scaffold:physics → 3 parallel bodies)
  reason: "shared PhysicsEnginePort, parallel safe"
```

Поле `ac_kind` — главное нововведение: архитектор определяет, **является ли AC отдельной dev-задачей, verification-задачей, spike'ом, или merge с другой**. Это решает Боль 4 (NFR как dev.code).

---

## §3. Перекрёстная проверка целостности — ПОЛНАЯ инвентаризация

> Выполнена 2026-07-20 через 4 параллельных агента, проверяющих: (1) все 17 скиллов, (2) все ссылки в коде, (3) все 29 тест-файлов, (4) все docs/templates. Результаты ниже — канонический список затронутых мест. Любое место не из этого списка считается НЕ затронутым.

### §3.1. Скиллы (17 шт. — полный список)

| # | skill | stage | затронут | что менять |
|---|---|---|---|---|
| 1 | **saga-orchestrator** | весь флоу | **YES** | владелец pipeline-порядка, строки 86-89/165-191 |
| 2 | **saga-architect** | formalization-SRS | **YES** | ПЕРЕПИСАТЬ: убрать FR/NFR, precondition после baseline, добавить complexity→architecture таблицу + DECOMP §D |
| 3 | **saga-analyst** (роль AC) | formalization-AC | **YES** | precondition `SRS+UC accepted` → `PRD accepted` (FR/NFR в PRD) |
| 4 | **saga-requirements-reviewer** | formalization review | **YES** | **КЛЮЧЕВОЙ БЛОКЕР**: проверка `AC derived_from → FR/NFR` сломается, FR/NFR теперь в PRD |
| 5 | **saga-reconciler** | formalization-reconciliation | **YES** | baseline_hash замораживается ДО SRS; lineage граф SRS→PRD обновить |
| 6 | **saga-product** | formalization-PRD | **YES** | ПЕРЕПИСАТЬ: добавить FR/NFR/RULE (переезжают из SRS) |
| 7 | **saga-planner** | planning | **MAYBE→YES** | УПРОСТИТЬ: dumb copier из DECOMP §D |
| 8 | **saga-analyst** (роль UC) | formalization-UC | **MAYBE** | `Next enables` ссылка на AC-ждёт-SRS обновить |
| 9 | **saga-architecture-reviewer** | formalization review | **MAYBE** | таймлайн ревью сдвигается; review DECOMP §D добавить |
| 10 | **senior-analyst** | Complexity Gate (1.5) | **MAYBE** | строка 18 перечисляет `thin: brief → PRD → SRS → FR → NFR → UC → AC` — обновить |
| 11 | **autonomous-recovery** | recovery (cross-stage) | **MAYBE** | DIAGNOSE должен знать новый gate-контракт formalization |
| 12 | **saga-verifier** | AC-verification | NO | читает frozen AC contract |
| 13 | **saga-worker** | execution/review | NO | получает задачу от dispatcher |
| 14 | **saga-dispatch** | execution loop | NO | очередь задач |
| 15 | **saga-kickstart** | discovery | NO | Complexity Gate уже работает корректно |
| 16 | **saga-start** | bootstrap | NO | утилита |
| 17 | **saga-tracker** | bootstrap | NO | утилита |
| 18 | **saga-release** | release checklist | NO | чеклист |
| 19 | **autonomous-recovery** | recovery | MAYBE | см. #11 |

**Дополнительно найденный файл:** `.claude/skills/saga-mcp/SKILL.md` — сторонний saga-tracker v1.5.0 от spranab. К перестановке отношения не имеет.

**ИТОГО СКИЛЛОВ ЗАТРОНУТО:** 6 YES + 5 MAYBE = **11 из 17** (планировали 8 — занизили оценку)

### §3.2. Код saga — 7 критичных точек + 3 maybe

**Критичные (workflow.ts — единственный определитель порядка):**

| Файл:строка | Что | Действие |
|---|---|---|
| `src/tools/workflow.ts:190-206` | `prd_accepted` создаёт SRS+UC параллельно | переписать: `prd_accepted` создаёт ТОЛЬКО UC |
| `src/tools/workflow.ts:223-249` | `srs_accepted/uc_accepted` + sibling-gate для AC | переписать: `uc_accepted` → AC без ожидания SRS |
| `src/tools/workflow.ts:251-284` | `ac_accepted` deps включают SRS-сиблинга | убрать dep на SRS; `baseline_accepted` создаёт SRS |
| `src/tools/workflow.ts:286-302` | `baseline_accepted` → planning | переписать: `baseline_accepted` → SRS task |
| `src/tools/workflow.ts:340-346` | task_kind → transition mapping | добавить `srs_accepted` transition для `planning.decomposition` |
| `src/tools/workflow.ts:364` | enum transitions | добавить `srs_accepted` post-baseline |
| `src/tools/workflow.ts:86-99, 357` | комментарии + description | обновить текст |

**Maybe (проверить, возможно править):**

| Файл:строка | Что | Действие |
|---|---|---|
| `src/tools/lifecycle.ts:110-205` | assertTraceability — рёбра каноничны | убедиться что skills проставляют SRS→PRD даже когда SRS после AC |
| `src/orchestrate.ts:197` | regex `/no PRD artifacts\|no SRS artifacts\|no UC artifacts/i` | проверить что матчит новые gate-сообщения |
| `src/tools/lifecycle.ts:40-64` | acceptedBaseline — заморозка AC | SRS теперь после baseline — нужен новый хэш-слой для SRS |

**НЕ затронуты (проверено, работают с рёбрами/фактами, не с порядком):**
- `src/tools/artifacts.ts` (ARTIFACT_TYPES, LINK_TYPES)
- `src/schema.ts`, `src/db.ts`, `src/types.ts` (список типов артефактов)
- `src/tools/dispatcher.ts` (role-фильтр)
- `src/planner/topology.ts`, `cascade.ts`, `fast-track.ts` (Pattern A/B, не formalization)
- `src/validators/brief.ts` (complexity уже правильно определён)
- `tools/cgad-spec-lint.mjs` R3/R13/R15/R17/R18 — все работают с accepted-артефактами, не с порядком

### §3.3. Канбан-UI — 2 косметические правки (не ломающие)

| Файл:строка | Что | Действие |
|---|---|---|
| `tracker-view/tracker-view.mjs:1703` | `typeOrder = ['PRD','SRS','UC','AC','FR','NFR',...]` | обновить порядок отображения chips |
| `tracker-view/tracker-view.mjs:3076-3114` | HTML-описание формализации | обновить текст «Параллельная генерация PRD, SRS, UC» → новый поток |

### §3.4. Тесты — 3 файла гарантированно сломаются + 3 maybe

| Файл | Затронутость | Строк к изменению |
|---|---|---|
| `tests/lifecycle/formalization-mechanics.test.mjs` | 💥 СЛОМАЕТСЯ | **~320 (весь файл)** — все 7 тестов проверяют переходы |
| `tests/lifecycle/traceability-gate.test.mjs` | 💥 СЛОМАЕТСЯ | **~150-200** — helper `buildCompletePyramid` + 9 тестов рёбер |
| `tests/product-workflow.test.mjs` | 💥 СЛОМАЕТСЯ | **~200-250** — 3 e2e теста + helper `seedTraceabilityPyramid` (используется в 4+ тестах) |
| `tests/track-pipeline.test.mjs` | ⚠️ MAYBE | ~20-40 (formalization.prd assertions) |
| `tests/fast-track/fast-track.test.mjs` | ⚠️ MAYBE | 0-10 (каталог артефактов) |
| `tests/migrations/migration-tests.test.mjs` | ⚠️ MAYBE | 0-30 (CHECK-constraints если типы меняются) |
| остальные 23 тест-файла | ✅ НЕ затронут | 0 |

**ИТОГО ТЕСТОВ ЗАТРОНУТО:** ~700-770 строк гарантированно + 50-80 maybe = **~800 строк**

**Ключевые helper'ы (общие для многих тестов):**
- `seedTraceabilityPyramid` в `product-workflow.test.mjs:41-76` — используется в 4+ тестах
- `buildCompletePyramid` в `traceability-gate.test.mjs:58-124` — используется во всех 9 тестах

### §3.5. Документация и шаблоны — 12 файлов

**Шаблоны (3 существующих + 2 отсутствующих):**

| Файл | Действие | Объём |
|---|---|---|
| `docs/requirements/templates/PRD.md` | добавить §FR/§NFR/§RULE | ~60-90 LoC |
| `docs/requirements/templates/SRS.md` | убрать §FR/§NFR/§RULE; добавить §D DECOMP | ~120-160 LoC |
| `docs/requirements/templates/INVARIANCES.md` | обновить комментарий про R13 | ~10-15 LoC |
| `docs/requirements/templates/acceptance-criteria.md` | **НЕ СУЩЕСТВУЕТ**, хотя README ссылается | создать ~80 LoC (AC→PRD-FR) |
| `docs/requirements/templates/UC.md` | **НЕ СУЩЕСТВУЕТ** | создать ~40 LoC (опционально) |

**Документация (9 файлов — план §3.4 их пропускал):**

| Файл | Что менять | Объём |
|---|---|---|
| `README.md` | pipeline диаграмма, saga-architect описание, упоминание acceptance-criteria.md | ~25-40 |
| `README.ru.md` | то же на русском | ~25-40 |
| `docs/saga-flow-overview.md` | формализация box, artifact tree, topology table | ~15-25 |
| `docs/INSTALL.md` | пример диалога + таблица | ~5-10 |
| `docs/saga-mcp-3.0-pipeline-ui-spec.md` | mock + summary formula | ~8-12 |
| `docs/blog-saga-mcp-agent-governance.md` | диаграмма Discovery→Formalization | ~5-8 |
| `docs/saga-mcp-history.md` | упоминание SRS template секций | ~5-10 |
| `docs/srs-br-and-traceability.md` | артефакт-пирамида BR→PRD→SRS/UC/FR→AC | ~8-15 |
| `docs/saga-mcp-3.0-orchestration-plan.md` | transition list, superseded sections | ~20-30 |
| `docs/architecture/decisions/008-brief-accepted-prd-only.md` | rationale sibling() invalidated | ~10-20 (addendum) |
| `docs/architecture/decisions/012-multi-track-pipeline.md` | minor note | ~2-5 |
| `GUARDRAILS.md` | не затронут (Signs 001-011 — postmortems) | 0 |
| `CHANGELOG.md` | добавить entry при релизе | +15-30 |
| `docs/architecture/cgad-v2-spec.md` | не затронут (нет PRD/SRS/UC/AC упоминаний) | 0 |

**ИТОГО ДОКУМЕНТАЦИИ:** ~350-500 LoC в ~12 файлах

### §3.6. Сводка по целостности

| Категория | Затронуто | Объём правок |
|---|---|---|
| Скиллы | 11 из 17 (6 YES + 5 MAYBE) | ~1000-1500 LoC |
| Код saga | 7 критичных точек + 3 maybe | ~80-150 LoC |
| Канбан-UI | 2 косметических | ~30 LoC |
| Тесты | 3 файла сломаются + 3 maybe | ~700-800 LoC |
| Шаблоны | 3 существующих + 2 отсутствующих | ~280-380 LoC |
| Документация | 12 файлов | ~350-500 LoC |
| **ИТОГО** | **37 файлов** | **~2400-3300 LoC** |

**Ключевые блокеры (без них перестановка невозможна):**
1. `saga-requirements-reviewer` — проверка `AC derived_from → FR/NFR` сломается, FR/NFR теперь в PRD
2. `saga-reconciler` — baseline_hash замораживается ДО SRS
3. `workflow.ts:251-284` — `ac_accepted` deps на SRS-сиблинга
4. `seedTraceabilityPyramid`/`buildCompletePyramid` helpers в тестах — общие для многих случаев

---

## §4. Детальный чек-лист реализации

### Этап 0. Подготовка и проверки (2-3 часа)

- [ ] **0.1.** Создать рабочую ветку `pipeline-reorder-srs-ac` в saga-mcp
- [ ] **0.2.** Проверка 1.1 — Complexity Gate данные на Cannon (SQL запрос к `artifacts.metadata` для brief #1)
- [ ] **0.3.** Проверка 1.2 — grep saga-architect SKILL на отсутствие complexity-ссылок
- [ ] **0.4.** Проверка 1.3 — timestamps артефактов Cannon (SRS раньше AC?)
- [ ] **0.5.** Проверка 1.4 — metadata всех dev-задач Cannon (target_file/schema пустые?)
- [ ] **0.6.** Проверка 1.5 — патч assertTraceability мысленно (грaf остаётся валидным)
- [ ] **0.7.** Запустить полный `npm test`, сохранить baseline результатов (до изменений)

### Этап 1. Код saga — переходы и гейты (4-6 часов)

- [ ] **1.1.** `workflow.ts:specsForTransition` — `prd_accepted` создаёт ТОЛЬКО UC (не SRS+UC)
- [ ] **1.2.** `workflow.ts:specsForTransition` — `uc_accepted` создаёт AC (был: SRS+UC → AC)
- [ ] **1.3.** `workflow.ts:specsForTransition` — `baseline_accepted` создаёт SRS (было: planning.decomposition)
- [ ] **1.4.** `workflow.ts:specsForTransition` — `srs_accepted` (НОВЫЙ) создаёт planning.decomposition
- [ ] **1.5.** `workflow.ts:generateNextForCompletedTask` — обновить switch на task_kind → transition
- [ ] **1.6.** `workflow.ts` — обновить enum transitions в inputSchema
- [ ] **1.7.** `lifecycle.ts:assertTraceability` — оставить как есть (граф корректен, проверить вручную)
- [ ] **1.8.** `lifecycle.ts:acceptedBaseline` — заморозить baseline AC ДО SRS; SRS добавляется к baseline_hash отдельно при `srs_accepted`
- [ ] **1.9.** `lifecycle.ts:assertTasksReady('formalization')` — теперь формализация включает SRS, проверка остаётся
- [ ] **1.10.** `lifecycle.ts:gate formalization→planning` — проверить, что проходит после SRS done
- [ ] **1.11.** Запустить unit-тесты lifecycle, зафиксировать какие упали

### Этап 2. Перенос FR/NFR/RULE из SRS в PRD (2-3 часа)

- [ ] **2.1.** `docs/requirements/templates/PRD.md` — добавить секции FR, NFR, RULE
- [ ] **2.2.** `docs/requirements/templates/SRS.md` — убрать секции FR, NFR, RULE; оставить только архитектуру
- [ ] **2.3.** `docs/requirements/templates/SRS.md` — добавить новую секцию §D Decomposition
- [ ] **2.4.** Решить: FR/NFR остаются отдельными артефактами в БД или становятся подтаблицами PRD? (рекомендация: остаются, `derived_from` от PRD вместо SRS)
- [ ] **2.5.** `lifecycle.ts:assertTraceability` — обновить проверки UC→FR, AC→FR/NFR (FR/NFR всё ещё отдельные артефакты, `derived_from` PRD)

### Этап 3. SKILL saga-product (2-3 часа)

- [ ] **3.1.** Прочитать текущий SKILL, отметить что оставить (scope, hypotheses, success criteria), что добавить (FR, NFR, RULE)
- [ ] **3.2.** Перенести секции FR/NFR/RULE из SKILL saga-architect в saga-product
- [ ] **3.3.** Обновить `Registering artifacts` — saga-product теперь создаёт FR/NFR/RULE, не saga-architect
- [ ] **3.4.** Обновить `trace_add` инструкции: FR/NFR `derived_from` PRD, не SRS
- [ ] **3.5.** smoke-test: мысленно прогнать saga-product на Cannon идее, проверить что PRD будет валидным

### Этап 4. SKILL saga-architect (4-6 часов)

- [ ] **4.1.** Удалить секции FR/NFR/RULE (теперь в saga-product)
- [ ] **4.2.** Изменить `Preconditions`: SRS запускается после `baseline_accepted` (AC заморожены), не после PRD
- [ ] **4.3.** Добавить обязательную секцию "Read Complexity Gate inputs": `artifact_get(brief)` → извлечь `complexity.tshirt`, `topology_hint`, `shared_mutation_risk`
- [ ] **4.4.** Добавить таблицу complexity→architecture→decomposition (из §2.3 этого плана) как обязательное правило выбора стиля
- [ ] **4.5.** Добавить новую секцию `§D Decomposition` с форматом из §2.4
- [ ] **4.6.** Добавить правило "DECOMP §D1 File Tree — canonical, scaffold обязан следовать дословно"
- [ ] **4.7.** Добавить поле `ac_kind` (implementation | verification | spike | merge_with) для каждого AC в §D2
- [ ] **4.8.** smoke-test: мысленно прогнать на Cannon — что бы архитектор выбрал для M/sequence? (Modular Monolith, ~4 задачи)

### Этап 5. SKILL saga-analyst (1-2 часа)

- [ ] **5.1.** Обновить `Preconditions`: UC/AC пишутся после PRD accepted, не после SRS
- [ ] **5.2.** Обновить инструкции: UC `derived_from` PRD (где FR), не SRS
- [ ] **5.3.** AC `derived_from` UC + FR/NFR (которые в PRD), не SRS
- [ ] **5.4.** Убрать ссылку на SRS в процессе написания AC (invariants берутся из RULE, которые в PRD)

### Этап 6. SKILL saga-planner (1-2 часа)

- [ ] **6.1.** Полностью переписать bridge loop: planner теперь читает DECOMP §D, не AC напрямую
- [ ] **6.2.** Алгоритм: для каждой строки DECOMP §D2 → `task_create` с копированием всех полей (file_path/functions/types/conflict_keys/pattern/depends_on)
- [ ] **6.3.** Если `ac_kind=verification` → создавать `verification.ac` задачу, не `development.code`
- [ ] **6.4.** Если `ac_kind=spike` → создавать `development.spike` (или новый task_kind, обсудить)
- [ ] **6.5.** Убрать задачу planner'а выбирать Pattern A/B — теперь архитектор это делает в DECOMP §D4
- [ ] **6.6.** Убрать задачу planner'а выбирать priority — теперь архитектор это делает в DECOMP §D3
- [ ] **6.7.** Idempotency: `generation_key` остаётся `'<REQ>:<AC>:<repo>:dev'`, planner проверяет существующие traces

### Этап 7. SKILL saga-orchestrator (1-2 часа)

- [ ] **7.1.** Обновить диаграмму pipeline (новая последовательность)
- [ ] **7.2.** Обновить описание каждого этапа (Discovery → Formalization Part 1 → Formalization Part 2 → Planning → Dev → Verify → Integrate)
- [ ] **7.3.** Проверить, что Complexity Gate (Stage 1.5) явно связан с saga-architect через контракт

### Этап 8. SKILLs reviewers и MAYBE-скиллы (3-4 часа)

- [ ] **8.1.** `saga-architecture-reviewer` — обновить: review SRS без FR/NFR; review DECOMP §D на соответствие таблице complexity→architecture; таймлайн ревью сдвигается
- [ ] **8.2.** `saga-requirements-reviewer` — **КЛЮЧЕВОЙ БЛОКЕР**: review PRD с FR/NFR/RULE; проверка `AC derived_from → FR/NFR` (FR/NFR теперь в PRD); UC/AC трассируются к PRD
- [ ] **8.3.** `saga-reconciler` — обновить: baseline замораживается ДО SRS; lineage граф SRS→PRD; SRS проверяется отдельно (через assertTasksReady formalization gate)
- [ ] **8.4.** `saga-analyst` (роль UC) — обновить `Next enables` (UC → AC без ожидания SRS)
- [ ] **8.5.** `senior-analyst` — строка 18: обновить `thin: brief → PRD → SRS → FR → NFR → UC → AC` → `thin: brief → PRD(+FR/NFR/RULE) → UC → AC → SRS`
- [ ] **8.6.** `autonomous-recovery` — обновить DIAGNOSE-фазу под новый gate-контракт formalization (если gate-сообщения изменятся, regex в `orchestrate.ts:197` может не совпасть)

### Этап 9. Тесты saga (8-12 часов — самая большая работа)

> Конкретный объём известен из инвентаризации §3.4.

- [ ] **9.1.** Прогнать `npm test`, собрать список упавших
- [ ] **9.2.** Классифицировать упавшие: real breaks vs outdated assertions
- [ ] **9.3.** **`tests/lifecycle/formalization-mechanics.test.mjs`** (320 строк) — переписать полностью:
  - [ ] **9.3.1.** Test 1 (79-92): `prd_accepted` создаёт ТОЛЬКО UC, не SRS+UC
  - [ ] **9.3.2.** Test 2 (98-121): `uc_accepted` → AC без ожидания SRS
  - [ ] **9.3.3.** Test 3 (127-148): `ac_accepted` → reconciliation без dep на SRS
  - [ ] **9.3.4.** Test 4 (155-176): gate regex обновить
  - [ ] **9.3.5.** Test 5 (184-267): полная перестройка пирамиды + pin hash
  - [ ] **9.3.6.** Test 6 (275-300): execution_mode всех formalization task_spec
  - [ ] **9.3.7.** Test 7 (307-320): tracker_only deps
- [ ] **9.4.** **`tests/lifecycle/traceability-gate.test.mjs`** (352 строки):
  - [ ] **9.4.1.** Helper `buildCompletePyramid` (58-124) — обновить все рёбра (AC→FR в PRD)
  - [ ] **9.4.2.** Test 2 (PRD → brief)
  - [ ] **9.4.3.** Test 3 (SRS → PRD)
  - [ ] **9.4.4.** Test 4 (UC → PRD)
  - [ ] **9.4.5.** Test 5 (UC → FR covers)
  - [ ] **9.4.6.** Test 6/6b (AC → UC + AC → FR/NFR)
  - [ ] **9.4.7.** Test 7-9 (AC variants)
- [ ] **9.5.** **`tests/product-workflow.test.mjs`** (1995 строк):
  - [ ] **9.5.1.** Helper `seedTraceabilityPyramid` (41-76) — обновить; это каскадно обновит 4+ зависящих теста
  - [ ] **9.5.2.** Test `typed PRD generates SRS and UC exactly once` (144-232) — полностью переписать e2e (90 строк)
  - [ ] **9.5.3.** Test `ADR-008: brief_accepted seeds EXACTLY ONE formalization.prd` (234-319) — обновить контракт `prd_accepted`
  - [ ] **9.5.4.** Test `ADR-008: brief_accepted decision-guard` (321-372)
  - [ ] **9.5.5.** Test `typed git work generates downstream` (431-465) — список потомков PRD
  - [ ] **9.5.6.** Test `episode planning gate` (467-503) — gate contract
  - [ ] **9.5.7.** Tests `artifact_create stamps accepted_hash` (535-601), `REQ-009 risk` (1234-1244)
- [ ] **9.6.** **`tests/track-pipeline.test.mjs`** (maybe) — formalization.prd assertions
- [ ] **9.7.** **`tests/fast-track/fast-track.test.mjs`** (maybe) — каталог артефактов
- [ ] **9.8.** **`tests/migrations/migration-tests.test.mjs`** (maybe) — CHECK-constraints
- [ ] **9.9.** Добавить новые тесты:
  - [ ] **9.9.1.** PRD содержит FR/NFR/RULE
  - [ ] **9.9.2.** SRS не содержит FR/NFR/RULE
  - [ ] **9.9.3.** SRS создаётся после baseline_accepted, не после prd_accepted
  - [ ] **9.9.4.** AC трассируется к FR (в PRD), не к SRS
  - [ ] **9.9.5.** DECOMP §D2 генерируется архитектором
  - [ ] **9.9.6.** Planner копирует DECOMP поля в task.metadata
  - [ ] **9.9.7.** conflict_keys_auto_derive находит правильные ключи
- [ ] **9.10.** Прогнать `npm test` повторно, все зелёные

### Этап 10. Канбан UI и CGAD lint (1-2 часа)

- [ ] **10.1.** `tools/cgad-spec-lint.mjs` — проверено агентом, R3/R13/R15/R17/R18 работают с accepted-артефактами, не с порядком. **Изменений не требуется** (но проверить после Этапа 12)
- [ ] **10.2.** `tracker-view/tracker-view.mjs:1703` — `typeOrder` массив отображения chips (косметика)
- [ ] **10.3.** `tracker-view/tracker-view.mjs:3076-3114` — HTML-описание стадии formalization (текст)
- [ ] **10.4.** `tracker-view/tracker-view.mjs:3093` — roles-метки (текст)
- [ ] **10.5.** Опционально: `tracker-view/tracker-view.mjs:463-466` — комментарий про pipeline

### Этап 11. Документация и шаблоны (4-6 часов)

> Полный список файлов из инвентаризации §3.5. Изначально план упоминал только 3 — пропущено 9.

- [ ] **11.1.** `docs/requirements/templates/PRD.md` — добавить §FR/§NFR/§RULE (переезжают из SRS)
- [ ] **11.2.** `docs/requirements/templates/SRS.md` — убрать §FR/§NFR/§RULE; добавить §D DECOMP
- [ ] **11.3.** `docs/requirements/templates/INVARIANCES.md` — обновить комментарий R13
- [ ] **11.4.** Решить с отсутствующими шаблонами: `acceptance-criteria.md` (создать с AC→PRD-FR) и `UC.md` (опционально)
- [ ] **11.5.** `README.md` — pipeline диаграмма (строка 34), таблица (строка 68), saga-architect описание (строка 298), SRS секции (строка 328), fix ссылка на acceptance-criteria.md (строка 329)
- [ ] **11.6.** `README.ru.md` — то же на русском (строки 34, 66, 133, 171, 172)
- [ ] **11.7.** `docs/saga-flow-overview.md` — формализация box, artifact tree, topology table (строки 40-47, 87-91, 131-133)
- [ ] **11.8.** `docs/INSTALL.md` — пример диалога (строка 59), таблица (строка 125)
- [ ] **11.9.** `docs/saga-mcp-3.0-pipeline-ui-spec.md` — mock (строка 21), summary formula (строка 127)
- [ ] **11.10.** `docs/blog-saga-mcp-agent-governance.md` — диаграмма (строки 27-31, 87)
- [ ] **11.11.** `docs/saga-mcp-history.md` — упоминание SRS template секций (строки 117-123)
- [ ] **11.12.** `docs/srs-br-and-traceability.md` — артефакт-пирамида (строки 35-40, 169-175)
- [ ] **11.13.** `docs/saga-mcp-3.0-orchestration-plan.md` — transition list, superseded §2 (строки 86-94, 179, 291)
- [ ] **11.14.** `docs/architecture/decisions/008-brief-accepted-prd-only.md` — addendum: rationale `sibling()` инвалидирован
- [ ] **11.15.** `docs/architecture/decisions/012-multi-track-pipeline.md` — minor note (строка 16)
- [ ] **11.16.** **Новый ADR** (`docs/architecture/decisions/014-pipeline-reorder-srs-after-ac.md`) — обоснование перестановки, ссылка на этот план
- [ ] **11.17.** `CHANGELOG.md` — добавить entry при релизе (Этап 13)

### Этап 12. End-to-end проверка (4-8 часов)

- [ ] **12.1.** Создать новый тестовый эпизод (маленький, S-size) — например «калькулятор депозита»
- [ ] **12.2.** Прогнать через новый pipeline на LM Studio
- [ ] **12.3.** Проверить:
  - [ ] **12.3.1.** BRIEF содержит complexity=S, topology_hint=sequence
  - [ ] **12.3.2.** PRD содержит FR/NFR/RULE
  - [ ] **12.3.3.** UC написан по PRD
  - [ ] **12.3.4.** AC написан по PRD (не по SRS)
  - [ ] **12.3.5.** SRS создан после AC
  - [ ] **12.3.6.** SRS §2.1 выбрал архитектуру по таблице complexity (KISS для S)
  - [ ] **12.3.7.** SRS §D содержит per-AC mapping
  - [ ] **12.3.8.** Planner создал 1-2 задачи (не 10+)
  - [ ] **12.3.9.** dev-задачи содержат target_file/schema/public_protocol
  - [ ] **12.3.10.** conflict_keys_auto_derive находит верные ключи
  - [ ] **12.3.11.** Воркер не делает 7 Read на exploration
- [ ] **12.4.** Сравнить с Cannon (старый pipeline) — кол-во задач, время, качество

### Этап 13. Релиз (1-2 часа)

- [ ] **13.1.** `npm run cgad-lint -- <db>` — 0 findings
- [ ] **13.2.** `npm test` — все зелёные
- [ ] **13.3.** `Skill("saga-release")` — чек-лист релиза
- [ ] **13.4.** Commit + push в master
- [ ] **13.5.** Обновить версию в package.json
- [ ] **13.6.** CHANGELOG.md — описание изменений

---

## §5. Риски и митигации

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| Сломаются существующие эпизоды в БД (Cannon) | высокая | среднее | Не мигрировать; Cannon остаётся как есть, новые эпизоды идут по новому pipeline |
| Воркеры путаются в новых SKILLs | средняя | высокое | Тестировать на одном маленьком эпизоде сначала (Этап 12) |
| Архитектор не справляется с DECOMP §D (перегрузка) | средняя | среднее | Fallback: если DECOMP не создан → planner работает по старому алгоритму |
| SRS без FR/NFR выглядит пустым | низкое | низкое | Это правильно — SRS теперь только архитектура |
| Тесты ломаются массово | высокая | высокое | Этап 9 самый дорогой, заложить 4-8 часов |
| CGAD lint блокирует новые transitions | средняя | среднее | Этап 10 — проверить и обновить lint правила |
| Complexity Gate данные не доходят до архитектора | средняя | высокое | В SKILL архитектора явный `artifact_get(brief)` шаг |

---

## §6. Временная оценка (пересмотренная после инвентаризации)

| Этап | Время | Объём | Кому |
|---|---|---|---|
| 0. Подготовка и проверки | 2-3 ч | 7 чекбоксов | agent |
| 1. Код saga — переходы | 4-6 ч | 11 чекбоксов, 7 критичных + 3 maybe точек | agent |
| 2. Перенос FR/NFR/RULE | 2-3 ч | 5 чекбоксов | agent |
| 3. SKILL saga-product | 2-3 ч | 5 чекбоксов | agent |
| 4. SKILL saga-architect | 4-6 ч | 8 чекбоксов (самая большая правка SKILL) | agent |
| 5. SKILL saga-analyst | 1-2 ч | 4 чекбоксов | agent |
| 6. SKILL saga-planner | 1-2 ч | 7 чекбоксов | agent |
| 7. SKILL saga-orchestrator | 1-2 ч | 3 чекбоксов | agent |
| 8. SKILLs reviewers + MAYBE | 3-4 ч | 6 чекбоксов (вкл. requirements-reviewer блокер) | agent |
| 9. Тесты | **8-12 ч** | 10 чекбоксов, 3 файла сломаются, ~800 строк | agent |
| 10. Канбан UI | 1-2 ч | 5 чекбоксов (в основном косметика) | agent |
| 11. Документация и шаблоны | **4-6 ч** | 17 чекбоксов, 12 файлов ~350-500 LoC | agent |
| 12. E2E проверка | 4-8 ч | 11 чекбоксов | saga на LM Studio |
| 13. Релиз | 1-2 ч | 6 чекбоксов | agent |
| **ИТОГО** | **~38-60 ч** | **~115 чекбоксов, ~2400-3300 LoC** | |

**Разница с первой оценкой:** +7-6 ч. Основной прирост — тесты (4-8 → 8-12 ч) и документация (1-2 → 4-6 ч), потому что инвентаризация нашла больше затронутых файлов чем предполагалось.

С учётом ожидания saga-воркеров на LM Studio (Этап 12) — **6-8 дней календарно**.

---

## §7. Критерии успеха

План считается успешным если после применения:

1. **Архитектор выбирает архитектуру по сложности.** На эпизоде S-size (deposit calculator) выбирается KISS или Modular Monolith, не Hexagonal.
2. **Архитектор работает после AC.** Timestamps артефактов: PRD < UC < AC < SRS.
3. **Planner — dumb copier.** В task.metadata есть target_file/schema/public_protocol, скопированные из DECOMP.
4. **Кол-во задач адекватно сложности.** S-size → 1-2 задачи, M-size → 3-7, L-size → 8-15. Не 15 для M-size.
5. **Воркеры не exploration'ят структуру.** В логе воркера первые 3 tool_use: heartbeat → task_get → Read (целевого файла из metadata.target_file), не 7 Read.
6. **Тесты зелёные.** `npm test` проходит.
7. **CGAD lint чистый.** `npm run cgad-lint` без findings.

---

## §8. Откат (rollback plan)

Если что-то пошло не так:

- [ ] **R1.** Кодовая ветка `pipeline-reorder-srs-ac` просто не мержится — master остаётся старым
- [ ] **R2.** SKILLs копируются в `skills.backup.YYYYMMDD/` перед правками
- [ ] **R3.** Cannon эпизод не мигрируется — остаётся как работающий пример старого pipeline
- [ ] **R4.** Если новые SKILLs приводят к регрессии воркеров — восстановить из `skills.backup.YYYYMMDD/`

---

## §9. История изменений плана

- **2026-07-20 v1:** создан (сессия пользователя, GLM-5.2). 13 этапов, оценка 31-54 ч. Инвентаризация §3 предварительная
- **2026-07-20 v2:** полная инвентаризация через 4 параллельных агента (скиллы, код, тесты, документация). Затронуто **37 файлов** вместо предполагаемых ~15. Скиллов 11/17 (не 8), тестов 3 сломаются (не 1), документации 12 файлов (не 3). Оценка пересмотрена: 38-60 ч (было 31-54). Добавлены §1.6-1.8 (перекрёстные проверки целостности), §3.1-3.6 (полные таблицы), Этап 8 расширен MAYBE-скиллами, Этап 9 конкретизирован по файлам/строкам, Этап 11 расширен до 17 чекбоксов. Найдены 2 отсутствующих шаблона (`acceptance-criteria.md`, `UC.md`) — pre-existing doc gap. Найден ADR-008 с инвалидированным rationale
