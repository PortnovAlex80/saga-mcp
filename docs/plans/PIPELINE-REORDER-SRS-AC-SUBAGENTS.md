# Декомпозиция плана для параллельных субагентов

**План-источник:** `D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC.md`
**Цель:** раскидать работу на 6 независимых субагентов, работающих параллельно без git-конфликтов, затем каскадно проверить результат.
**Дата:** 2026-07-20

---

## §1. Общий контракт (ВСЕ субагенты обязаны соблюдать)

Это спецификация того, что строят все вместе. Каждый субагент читает этот блок перед стартом.

### 1.1. Целевой pipeline (канон)

```
BRIEF → PRD (с FR/NFR/RULE) → UC → AC → Reconcile → SRS+DECOMP → Planning → Dev → Verify → Integrate
```

### 1.2. Новая последовательность transitions (workflow.ts)

| task_kind | transition, который он триггерит | что transition создаёт |
|---|---|---|
| `discovery.kickstart` | `brief_accepted` | `formalization.prd` (как раньше) |
| `formalization.prd` | `prd_accepted` | **ТОЛЬКО `formalization.uc`** (не SRS+UC) |
| `formalization.uc` | `uc_accepted` | `formalization.ac` (без ожидания SRS) |
| `formalization.ac` | `ac_accepted` | `formalization.reconciliation` (без dep на SRS) |
| `formalization.reconciliation` | `baseline_accepted` | `formalization.srs` (НОВОЕ — SRS после AC) |
| `formalization.srs` | `srs_accepted` (НОВЫЙ) | `planning.decomposition` |

### 1.3. Что переезжает между артефактами

- **FR/NFR/RULE**: из SRS → в PRD (создаёт saga-product, не saga-architect)
- **SRS**: остаётся чисто архитектурным (стиль, модули, порты, инварианты, tech stack, DECOMP §D)
- **UC/AC**: пишутся по PRD (не по SRS); AC `derived_from` → FR/NFR (которые теперь в PRD)

### 1.4. Новая секция SRS §D — DECOMP

Формат (машино-читаемый YAML, который planner копирует в задачи):
```yaml
# §D1 File Tree (canonical, scaffold обязан следовать)
# §D2 AC → Implementation Map (одна строка на AC)
- ac: AC-1
  files: [src/physics/orbital.ts]
  functions: [calculateOrbit]
  types: [LaunchParameters, OrbitResult]
  public_protocol: PhysicsEnginePort
  conflict_keys: [...]
  invariants: [INV-PHYS-1]
  ac_kind: implementation | verification | spike | merge_with
  depends_on: [scaffold:physics]
# §D3 Priority rationale
# §D4 Pattern selection per module cluster
```

### 1.5. Таблица complexity → architecture (для saga-architect SKILL)

| complexity.tshirt | topology_hint | Архитектурный стиль | Pattern |
|---|---|---|---|
| XS | sequence | KISS | Single task |
| S | sequence | KISS / Module | Pattern A |
| M | sequence | Modular Monolith | Pattern A |
| M | scaffold-then-parallel | Modular Monolith + Ports | Pattern B |
| L/XL | scaffold-then-parallel | Hexagonal / Ports | Pattern B |
| L/XL | sequence | Layered | Pattern A + spikes |
| research | any | Spike-first | Spike → re-plan |

---

## §2. Карта работы — 6 независимых потоков

Каждый поток работает в **изолированном наборе файлов**. Конфликтов нет.

| Поток | Имя | Владение файлами | Зависит от | Время |
|---|---|---|---|---|
| A | **CORE** — код saga transitions | `src/tools/workflow.ts`, `src/tools/lifecycle.ts`, `src/orchestrate.ts` | только от §1 контракта | 4-6 ч |
| B | **PRODUCT** — saga-product + templates PRD/SRS | `skills/saga-product/SKILL.md`, `docs/requirements/templates/PRD.md`, `docs/requirements/templates/SRS.md`, `docs/requirements/templates/INVARIANCES.md` | от §1 контракта | 3-4 ч |
| C | **ARCHITECT** — saga-architect + reviewer | `skills/saga-architect/SKILL.md`, `skills/saga-architecture-reviewer/SKILL.md` | от §1 контракта | 4-6 ч |
| D | **ANALYST+PLANNER** — analyst, planner, orchestrator, reconciler | `skills/saga-analyst/SKILL.md`, `skills/saga-planner/SKILL.md`, `skills/saga-orchestrator/SKILL.md`, `skills/saga-reconciler/SKILL.md`, `skills/saga-requirements-reviewer/SKILL.md` | от §1 контракта | 4-6 ч |
| E | **DOCS** — READMEs, ADR, INSTALL, blog | `README.md`, `README.ru.md`, `docs/INSTALL.md`, `docs/saga-flow-overview.md`, `docs/saga-mcp-3.0-pipeline-ui-spec.md`, `docs/blog-saga-mcp-agent-governance.md`, `docs/saga-mcp-history.md`, `docs/srs-br-and-traceability.md`, `docs/saga-mcp-3.0-orchestration-plan.md`, `docs/architecture/decisions/008-*.md`, `docs/architecture/decisions/012-*.md`, НОВЫЙ `013-pipeline-reorder-srs-after-ac.md` | от §1 контракта | 4-6 ч |
| F | **TESTS** — тесты saga | `tests/lifecycle/formalization-mechanics.test.mjs`, `tests/lifecycle/traceability-gate.test.mjs`, `tests/product-workflow.test.mjs`, `tests/track-pipeline.test.mjs` (maybe) | **от потока A** (контракты transitions должны совпасть с тестами) | 8-12 ч |

### 2.1. Граф зависимостей

```
       ┌──────────────────────────────────────────┐
       │  §1 Общий контракт (читают все 6 агентов) │
       └──────┬───────────────┬──────────────┬────┘
              │               │              │
     ┌────────▼────┐  ┌───────▼──────┐ ┌─────▼──────┐
     │ A: CORE     │  │ B: PRODUCT   │ │ C: ARCHIT  │
     │ workflow.ts │  │ saga-product │ │ saga-arch  │
     │ lifecycle   │  │ templates    │ │ reviewer   │
     └────┬────────┘  └──────────────┘ └────────────┘
          │
     ┌────▼────────┐  ┌───────────────┐ ┌────────────┐
     │ F: TESTS    │  │ D: ANALYST+   │ │ E: DOCS    │
     │ (после A)   │  │ PLANNER+RECON │ │ README/ADR │
     └─────────────┘  └───────────────┘ └────────────┘
```

**Параллельные:** A, B, C, E стартуют одновременно (изолированные файлы).
**Последующий:** D тоже может стартовать сразу (не зависит от A).
**Зависимый:** F стартует **после** A — тесты должны проверять именно те transitions, что построил CORE.

---

## §3. Спецификации заданий для каждого субагента

### Поток A — CORE (src/ код saga)

**Файлы:**
- `src/tools/workflow.ts` (изменить)
- `src/tools/lifecycle.ts` (изменить acceptedBaseline + maybe assertTraceability)
- `src/orchestrate.ts` (проверить RECOVERY_TREE regex)

**Задача:** реализовать переходы из §1.2 контракта. Ключевые изменения:
1. `prd_accepted` создаёт только `formalization.uc` (не SRS+UC параллельно)
2. `uc_accepted` создаёт `formalization.ac` без sibling-ожидания SRS
3. `ac_accepted` создаёт `formalization.reconciliation` без dep на SRS
4. `baseline_accepted` создаёт `formalization.srs` (НОВОЕ)
5. `srs_accepted` (НОВЫЙ transition) создаёт `planning.decomposition`
6. `lifecycle.ts:acceptedBaseline` — SRS теперь после baseline, нужен хэш-слой для SRS при `srs_accepted`
7. `orchestrate.ts:197` regex `/no PRD|no SRS|no UC/` — проверить матчи

**Запрет:** НЕ трогать SKILLs, тесты, документацию. Только src/.

**Проверка:** после завершения прогнать `npm run build` — TypeScript должен компилироваться.

---

### Поток B — PRODUCT (saga-product + шаблоны)

**Файлы:**
- `skills/saga-product/SKILL.md` (изменить)
- `docs/requirements/templates/PRD.md` (добавить FR/NFR/RULE)
- `docs/requirements/templates/SRS.md` (убрать FR/NFR/RULE, добавить §D)
- `docs/requirements/templates/INVARIANCES.md` (обновить комментарий R13)

**Задача:**
1. В SKILL saga-product добавить создание FR/NFR/RULE артефактов (с `derived_from` PRD, не SRS)
2. В шаблон PRD добавить секции §FR, §NFR, §RULE (перенести формулировки из текущего SRS шаблона)
3. В шаблон SRS убрать §FR/§NFR/§RULE, оставить только архитектуру (§2, §2b, §2.3, §2.5, §7, §8, §9)
4. В шаблон SRS добавить новую секцию §D DECOMP с форматом из контракта §1.4
5. Обновить INVARIANCES.md комментарий про R13 и SRS §2.3 как source of truth

**Запрет:** НЕ трогать saga-architect SKILL (это поток C), templates AC/UC (поток D).

**Проверка:** после завершения мысленно прогнать — saga-product теперь создаёт FR/NFR/RULE? SRS шаблон чисто архитектурный? §D DECOMP присутствует?

---

### Поток C — ARCHITECT (saga-architect + reviewer)

**Файлы:**
- `skills/saga-architect/SKILL.md` (переписать)
- `skills/saga-architecture-reviewer/SKILL.md` (обновить)

**Задача:**
1. Убрать из saga-architect SKILL секции FR/NFR/RULE (теперь в saga-product)
2. Изменить Precondition: SRS запускается после `baseline_accepted` (AC заморожены), не после PRD
3. Добавить обязательную секцию "Read Complexity Gate inputs": `artifact_get(brief)` → извлечь `complexity.tshirt`, `topology_hint`, `shared_mutation_risk`
4. Добавить таблицу complexity→architecture→decomposition из контракта §1.5 как ОБЯЗАТЕЛЬНОЕ правило выбора стиля
5. Добавить новую секцию `§D Decomposition` с форматом из контракта §1.4
6. Добавить правило "DECOMP §D1 File Tree — canonical, scaffold обязан следовать дословно"
7. Добавить поле `ac_kind` для каждого AC (implementation | verification | spike | merge_with)
8. Обновить `Registering artifacts` — архитектор больше НЕ создаёт FR/NFR/RULE
9. Обновить `trace_add` инструкции — SRS `derived_from` PRD (как раньше, но порядок другой)
10. В saga-architecture-reviewer: review критерии SRS без FR/NFR; добавить review DECOMP §D на соответствие таблице complexity→architecture

**Запрет:** НЕ трогать saga-product SKILL (поток B), шаблоны (поток B).

**Проверка:** мысленно прогнать saga-architect на Cannon с complexity=M, topology=sequence — должен выбрать Modular Monolith, не Hexagonal. §D должен содержать per-AC mapping.

---

### Поток D — ANALYST + PLANNER + ORCHESTRATOR + RECONCILER + REVIEWER

**Файлы:**
- `skills/saga-analyst/SKILL.md` (изменить)
- `skills/saga-planner/SKILL.md` (переписать)
- `skills/saga-orchestrator/SKILL.md` (обновить)
- `skills/saga-reconciler/SKILL.md` (обновить)
- `skills/saga-requirements-reviewer/SKILL.md` (обновить — КЛЮЧЕВОЙ БЛОКЕР)
- `skills/senior-analyst/SKILL.md` (minor — обновить перечень artifact-set)
- `skills/autonomous-recovery/SKILL.md` (minor — DIAGNOSE)

**Задача:**
1. **saga-analyst**: обновить Preconditions — UC/AC пишутся после PRD accepted (не SRS). UC `derived_from` PRD, AC `derived_from` UC + FR/NFR (в PRD)
2. **saga-planner**: ПОЛНОСТЬЮ переписать bridge loop — теперь dumb copier из DECOMP §D. Для каждой строки §D2 → `task_create` с копированием file_path/functions/types/conflict_keys. `ac_kind=verification` → `verification.ac` задача. Убрать ответственность planner'а за выбор Pattern A/B (это архитектор в §D4)
3. **saga-orchestrator**: обновить диаграмму pipeline (новая последовательность). Обновить описание этапов
4. **saga-reconciler**: baseline_hash замораживается ДО SRS. SRS проверяется через formalization gate отдельно. lineage граф SRS→PRD обновить
5. **saga-requirements-reviewer (КЛЮЧЕВОЙ БЛОКЕР)**: обновить проверку `AC derived_from → FR/NFR` — FR/NFR теперь создаются saga-product в PRD, не saga-architect в SRS. Проверка UC/AC трассировок к PRD
6. **senior-analyst**: строка 18 перечня `thin: brief → PRD → SRS → FR → NFR → UC → AC` → обновить под новый поток
7. **autonomous-recovery**: обновить DIAGNOSE-фазу под новый gate-контракт formalization

**Запрет:** НЕ трогать saga-architect SKILL (поток C), saga-product SKILL (поток B), src/ код (поток A), тесты (поток F).

**Проверка:** мысленно прогнать:
- AC пишется ДО SRS, derived_from UC (в PRD есть FR)?
- Planner — dumb copier из §D, не принимает решений?
- requirements-reviewer не падает на AC→FR (FR теперь в PRD)?

---

### Поток E — DOCS (READMEs + ADR + пр.)

**Файлы:**
- `README.md` (изменить)
- `README.ru.md` (изменить)
- `docs/INSTALL.md` (изменить)
- `docs/saga-flow-overview.md` (изменить)
- `docs/saga-mcp-3.0-pipeline-ui-spec.md` (изменить)
- `docs/blog-saga-mcp-agent-governance.md` (изменить)
- `docs/saga-mcp-history.md` (изменить)
- `docs/srs-br-and-traceability.md` (изменить)
- `docs/saga-mcp-3.0-orchestration-plan.md` (изменить)
- `docs/architecture/decisions/008-brief-accepted-prd-only.md` (addendum)
- `docs/architecture/decisions/012-multi-track-pipeline.md` (minor)
- НОВЫЙ `docs/architecture/decisions/013-pipeline-reorder-srs-after-ac.md`

**Задача:** обновить все упоминания pipeline `PRD → SRS → UC → AC` на новый `PRD → UC → AC → SRS`. Создать ADR-013 с обоснованием перестановки. Добавить addendum к ADR-008 про инвалидацию rationale `sibling()`.

**Запрет:** НЕ трогать SKILLs, src/, тесты, templates.

**Проверка:** grep по всем docs/ на "PRD.*SRS.*UC" или "SRS.*UC.*AC" — должно совпадать с новым каноном.

---

### Поток F — TESTS (зависит от A)

**Файлы:**
- `tests/lifecycle/formalization-mechanics.test.mjs` (переписать полностью, ~320 строк)
- `tests/lifecycle/traceability-gate.test.mjs` (переписать helper + 9 тестов, ~200 строк)
- `tests/product-workflow.test.mjs` (переписать 3 e2e + helper, ~250 строк)
- `tests/track-pipeline.test.mjs` (maybe, ~30 строк)
- `tests/fast-track/fast-track.test.mjs` (maybe, 0-10 строк)
- `tests/migrations/migration-tests.test.mjs` (maybe, 0-30 строк)

**Зависимость:** СТАРТУЕТ ПОСЛЕ ЗАВЕРШЕНИЯ ПОТОКА A. Тесты проверяют именно те transitions, что построил CORE.

**Задача:**
1. `seedTraceabilityPyramid` helper — обновить рёбра: AC→FR (FR в PRD, не SRS). Это каскадно обновит 4+ тестов
2. `buildCompletePyramid` helper — то же. Каскадно обновит 9 тестов
3. `formalization-mechanics.test.mjs` — 7 тестов под новый поток (Test 1: prd→только UC; Test 2: uc→AC без ожидания SRS; Test 3: ac→reconciliation без SRS dep; Test 5: полный pipeline через новый путь)
4. `traceability-gate.test.mjs` — 9 тестов рёбер (AC→FR в PRD работает)
5. `product-workflow.test.mjs` — 3 e2e теста (144-232, 234-319, 321-372) + helper
6. Новые тесты: PRD содержит FR/NFR/RULE; SRS не содержит; SRS после baseline_accepted; AC→FR в PRD; DECOMP §D2 генерируется; planner копирует DECOMP; conflict_keys правильные

**Запрет:** НЕ трогать SKILLs, src/ (только читает для понимания контракта), templates, docs.

**Проверка:** `npm test` — все зелёные (после завершения потока A).

---

## §4. План запуска и каскадной проверки

### Фаза 1 — Параллельный запуск (одновременно)

Запустить 5 субагентов одновременно (A, B, C, D, E):
```
Поток A (CORE)      — src/ код
Поток B (PRODUCT)   — saga-product SKILL + templates
Поток C (ARCHITECT) — saga-architect SKILL + reviewer
Поток D (ANALYST)   — analyst/planner/orchestrator/reconciler/reviewer SKILLs
Поток E (DOCS)      — README + docs + ADR
```

**Каждый получает:** ссылку на план `PIPELINE-REORDER-SRS-AC.md` секцию §1 (общий контракт) + свой поток спецификацию.

### Фаза 2 — Зависимый запуск (после A)

Запустить 1 субагента (F):
```
Поток F (TESTS)     — после завершения A
```

### Фаза 3 — Каскадная проверка (после всех)

Этапы проверки целостности, прогоняемые последовательно:

#### Проверка 3.1 — TypeScript компиляция
- [ ] `npm run build` — без ошибок (поток A)
- [ ] `npm run lint` — без ошибок

#### Проверка 3.2 — Тесты
- [ ] `npm test` — все зелёные (поток F)
- [ ] Если упали — найти какой поток виноват, вернуть ему задачу

#### Проверка 3.3 — CGAD lint
- [ ] `node tools/cgad-spec-lint.mjs <db>` — 0 findings

#### Проверка 3.4 — Кросс-потоковая целостность (KEY)

Проверить, что контракты между потоками соблюдены:

- [ ] **3.4.1.** `workflow.ts` transitions (поток A) совпадают с тестами (поток F): `prd_accepted` → только UC, `baseline_accepted` → SRS, `srs_accepted` → planning
- [ ] **3.4.2.** `saga-product SKILL` (поток B) создаёт FR/NFR/RULE с `derived_from` PRD — соответствует `saga-requirements-reviewer` (поток D) проверке AC→FR
- [ ] **3.4.3.** `saga-architect SKILL` (поток C) пишет §D DECOMP в формате, который `saga-planner SKILL` (поток D) умеет парсить
- [ ] **3.4.4.** `saga-architect SKILL` (поток C) таблица complexity→architecture соответствует контракту §1.5
- [ ] **3.4.5.** `README.md` (поток E) pipeline совпадает с `saga-orchestrator SKILL` (поток D) и `workflow.ts` (поток A)
- [ ] **3.4.6.** `saga-architect SKILL` (поток C) precondition SRS после baseline соответствует `workflow.ts:baseline_accepted` (поток A) создающему SRS

#### Проверка 3.5 — Smoke-test через saga E2E

- [ ] Создать новый тестовый эпизод (S-size, "deposit calculator")
- [ ] Прогнать через новый pipeline
- [ ] Проверить артефакты: PRD с FR/NFR, UC по PRD, AC по PRD, SRS после AC
- [ ] Проверить DECOMP §D присутствует
- [ ] Проверить dev-задачи содержат target_file (planner их скопировал из §D)

---

## §5. Управление рисками параллельной работы

| Риск | Митигация |
|---|---|
| Два потока правят один файл | §2 карта файлов у каждого потока уникальна. Конфликт невозможен |
| Потоки расходятся в интерпретации контракта | §1 общий контракт читают ВСЕ. Любое отклонение — фиксируется в §3.4 каскадной проверке |
| Поток F не может стартовать (A не готов) | Явная зависимость в §2.1 |
| Saga-reviewer (поток D) не сходится с workflow.ts (поток A) | Каскадная проверка 3.4.1 + 3.4.2 |
| Planner (поток D) не понимает §D формат архитектора (поток C) | Каскадная проверка 3.4.3 — формат YAML из §1.4 каноничен |
| Документация (поток E) расходится с кодом | Каскадная проверка 3.4.5 |
| Усугубление: регрессия в реальной работе saga | Smoke-test 3.5 + откат через `git checkout` (все правки в одной ветке) |

---

## §6. Шаблон промпта для каждого субагента

```
Ты — субагент в параллельной команде, выполняющей перестановку SRS после AC в saga-mcp.

## Обязательное чтение перед стартом
1. Прочитай ОБЩИЙ КОНТРАКТ: D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC-SUBAGENTS.md §1
2. Прочитай ПОЛНЫЙ ПЛАН (свою часть): D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC.md
   особенно §2 (целевая архитектура), §3 (инвентаризация), §4 (свой этап)

## Твой поток: <ИМЯ_ПОТОКА>

## Файлы под твоим владением (ТОЛЬКО эти)
<список файлов из §3 спецификации>

## Запрещено трогать
<список того, что владение других потоков>

## Задача
<детальная спецификация из §3>

## По завершении
- Сообщи список изменённых файлов
- Для каждого файла — краткое summary что изменено
- НЕ делай commit (это сделает оркестратор после каскадной проверки)
```

---

## §7. Чек-лист запуска

### Перед запуском
- [ ] Создать ветку `pipeline-reorder-srs-ac` в saga-mcp git
- [ ] Сделать backup SKILLs: `cp -r skills skills.backup.YYYYMMDD`
- [ ] Убедиться, что `npm test` проходит на master (baseline)
- [ ] Зафиксировать baseline: `npm test 2>&1 | tee tests-baseline.log`

### Параллельный запуск (Фаза 1)
- [ ] Старт потока A (CORE)
- [ ] Старт потока B (PRODUCT)
- [ ] Старт потока C (ARCHITECT)
- [ ] Старт потока D (ANALYST+PLANNER)
- [ ] Старт потока E (DOCS)

### После Фазы 1
- [ ] Все 5 потоков отчитались списком изменённых файлов
- [ ] Проверить что файлы не пересекаются между потоками

### Зависимый запуск (Фаза 2)
- [ ] Старт потока F (TESTS) — после A

### Каскадная проверка (Фаза 3)
- [ ] Проверка 3.1 — TypeScript
- [ ] Проверка 3.2 — тесты
- [ ] Проверка 3.3 — CGAD lint
- [ ] Проверка 3.4 — кросс-потоковая целостность (6 проверок)
- [ ] Проверка 3.5 — Smoke-test через saga

### Финал
- [ ] Все проверки зелёные
- [ ] Commit всех изменений
- [ ] Обновить §9 истории изменений плана
- [ ] Создать PR или merge в master
