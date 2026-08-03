# saga-mcp — Архитектурный анализ: единый сводный документ

> Один документ для всех инсайтов протокола реконструкции.
> Обновляется после каждой фазы. Создан на фазе 8 (продолжаем до конца).

---

## Статус протокола

| Фаза | Статус | Главный инсайт (одно предложение) |
|---|---|---|
| 0. Coverage | ✅ | 1544 файла, 5 процессов, 4 модуля, 28+ таблиц |
| 1. Purpose | ✅ | Центр тяжести — transition gates, не артефакты |
| 2. Maps | ✅ | 4 стола, God Object composition, split-brain artifacts |
| 3. Core | ✅ | 18 pure policies = ядро. Policy engine, не domain model |
| 4. Seams | ✅ | 16 швов, 4 критических. Git merge crash = unbuilt ADR-010 |
| 5. Workload | ✅ | State machine engine. Performance НЕ драйвер. |
| 5.5 Constraints | ✅ | Authorization + audit + idempotency = cross-cutting силы |
| 6. Target | ✅ | Gate-centric hexagonal, self-contained modules, unified desk |
| 7. Adversarial | ✅ | Desk unification scope сужена: handoff-level, не full replacement |
| 8. Relocation | ✅ | Discovery = первый tranche (17 файлов + 3 cross-cutting) |
| 9. Algorithms | ✅ | 5 structural improvements (НЕ алгоритмических — performance не драйвер) |
| 10. Migration | ✅ | 15-step roadmap, 8 fitness functions, first tranche = Discovery |

---

## TOP-10 ИНСАЙТОВ (если читать только одно место)

### 1. Система — state-machine policy engine, не pipeline

Убери SQLite, MCP, claude CLI, git. Что останется? **18 чистых функций-политик**, которые решают: пропустить или отклонить переход. Это ядро системы. Всё остальное — инфраструктура для спавна внешних LLM-воркеров.

### 2. Центр тяжести — ворота (gates), не текст

Самый сложный и протестированный код — `findNextClaimable` (8-way race tested), `releaseExecutionAtomically` (fence CAS), `decideStuckAction` (pure), `authorizeSagaToolCall` (authority gateway), `exactCandidateAcceptance` (universal gate). LM (claude -p) — внешний. Система не генерирует текст — она **управляет условиями** его производства.

### 3. Четыре стола — архитектурный провал

Discovery → `saga3_proposals`. Formalization → `saga3_managed_artifact_productions`. Development → `saga3_managed_node_submissions`. Delivery → kernel-only. **Четыре таблицы, четыре submit-tool'а, четыре резолвера** — хотя все продукты физически одинаковые: текст с schema + hash. Универсальный стол (`saga3_process_products`) существует, но используется только development-модулем.

### 4. exactCandidateAcceptance — единая точка схождения

Независимо от того, через какой submit-tool и в какую таблицу записан продукт, **ворота принятия одни и те же**. Это доказывает: унификация столов архитектурно безопасна.

### 5. saga3/ — распределённый монолит, не bounded context

Discovery module разбросан по 4 директориям: `modules/discovery/` (определение), `saga3/domain/` (policy), `saga3/application/` (service), `saga3/persistence/` (SQLite). Агент с ограниченным контекстом не может понять один модуль без чтения 8-12 файлов из 4 директорий.

### 6. God Object composition root

`product-lifecycle-runtime.ts` — 780 строк, 40+ импортов, конструирует ВСЕ адаптеры для ВСЕХ 4 модулей. Добавление модуля = правка этого файла. LEGO контракт сломан.

### 7. Git merge crash = unbuilt ADR-010

`integration_intents` таблица объявлена в schema. ADR-010 описал детерминистический recovery механизм для crash mid-merge. **Он никогда не был построен.** Recovery от crash mid-merge полагается на LLM-эвристику — ровно то, что ADR-010 должен был исключить.

### 8. Производительность — не драйвер

Система на 99%+ ограничена latency внешнего LLM (30s-10min на вызов). Saga runtime добавляет микросекунды. SQLite ceiling (~10 concurrent workers) — теоретический при concurrency=3-4. Архитектурное решение должно определяться **cognitive load** и **module autonomy**.

### 9. Артефакт существует в четырёх представлениях

`artifacts` table (статус), `saga3_managed_artifact_productions` (provenance), `.md` file на диске (content hash), `FormalizationArtifactSnapshot` in-memory. Нет единого source of truth — каждый владеет своим аспектом.

### 10. 12 из 18 правил уже чистые функции

Emergent success от «Uncle Bob Wave» рефакторинга. Pure policies живут в правильных позициях, zero I/O. Это доказывает что команда УЖЕ умеет выделять чистую логику — нужно только довести до конца.

---

## ИНСАЙТЫ ПО ФАЗАМ (детально)

### Phase 0 — Coverage

**Что сделали:** 1544 файла в манифесте, 5 процессов, 3 composition roots, 4 модуля, 28+ table groups.

**Инсайт:** `saga3_process_products` (универсальный стол) существует, но только development его использует. Dead code: diagnosis handlers зарегистрированы но flow node удалён.

---

### Phase 1 — Operational Purpose

**Что сделали:** Определили что система ДЕЙСТВИТЕЛЬНО делает (не что декларирует).

**Инсайт:** Три действующих лица: human operator, claude -p worker, orchestrate-cli. Система принимает идею одной фразой и через 4 стадии (Discovery → Formalization → Development → Delivery) превращает в код. Каждый переход проходит через gate. Центр тяжести — **gates** (claim, fence, verify, accept, route), не текст.

**Production evidence:** Autism-Buttons epic — 10/29 задач done, zombie states (#19, #20: воркер умер, fence остался).

---

### Phase 2 — Cross-Cutting Maps

**Что сделали:** 8 сценариев, 14 состояний, 3 data flow.

**Инсайт:** Composition root — God Object (участвует в 7/8 сценариев). Четыре стола ломают cross-module handoff. Worker execution ownership — чистая (single-writer). Artifacts table имеет split-brain: 4 писателя, каждый владеет разными колонками.

---

### Phase 3 — Real Core

**Что сделали:** 18 правил и инвариантов каталогизировано.

**Инсайт:** Ядро — **policy engine**. 12/18 правил уже чистые функции. RULE-012 (formalization traceability) — ДУБЛИРОВАН: две независимые реализации могут разойтись. RULE-006 (content-addressing) имеет двойственность: canonical JSON hash для payloads vs raw byte hash для files.

---

### Phase 4 — Seam Map

**Что сделали:** 16 швов, 4 критических.

**Инсайт:** SEAM-013 (git merge crash window) — самый опасный. `integration_intents` объявлены, ADR-010 описал решение, но **никогда не построено**. SEAM-003: артефакт в 4 представлениях. SEAM-010: duplicated traceability. SEAM-016: God Object composition.

---

### Phase 5 — Workload Profile

**Что сделали:** 11 алгоритмов, classification.

**Инсайт:** Система — **state machine engine** с policy-gated transitions, обёрнутый в workflow runtime. Performance — НЕ драйвер (99%+ latency от внешнего LLM). Data volume маленькая (10-30 задач, <5MB DB). SQLite ceiling — теоретический.

---

### Phase 5.5 — Cross-Cutting Constraints

**Что сделали:** 12 ограничений.

**Инсайт:** Authorization placement — HIGH force: все worker APIs ДОЛЖНЫ идти через MCP gateway. Auditability — append-only audit ДОЛЖЕН быть сохранён. Idempotency — все cross-boundary mutations ДОЛЖНЫ быть идемпотентны. Consistency gap (SQLite ↔ git) — ДОЛЖЕН быть адресован или документирован.

---

### Phase 6 — Target Architecture

**Что сделали:** 3 candidate architectures. 1 выбран.

**Инсайт:** **Gate-centric hexagonal with self-contained modules.** Каждый модуль — одна директория (domain/application/infrastructure/package). Модули self-register через `register(deps)`. saga3/ расформирован. Composition root ~80 строк. Desk unification на уровне cross-module handoff.

---

### Phase 7 — Adversarial Review

**Что сделали:** 10 attack vectors. 6 SAFE, 3 MANAGEABLE, 1 REVISED.

**Инсайт:** Desk unification scope сужена после ATTACK-007: universal desk для cross-module HANDOFF, module-internal provenance reads сохранены. Это менее амбициозно но более безопасно.

---

### Phase 8 — Relocation

**Что сделали:** 10 relocation clusters, 5 fossils, 5 load-bearing hacks, 7 emergent successes.

**Инсайт:** First tranche = Discovery module consolidation (17 файлов + 3 cross-cutting). Самый важный hack: HACK-003 (type cycle `completion: null as unknown as ModuleCompletion`) — нужно развести типы. Самый важный success: SUCCESS-007 (exactCandidateAcceptance как universal gate).

---

### Phase 9 — Algorithm Improvement

**Что сделали:** 5 structural improvements (НЕ алгоритмических).

**Инсайт:** Phase 5 доказал — алгоритмы уже appropriate для workload. Все 5 улучшений — STRUCTURAL: удалить legacy path, консолидировать дубликаты, развестить типы. Никаких Big-O оптимизаций — не нужно.

---

### Phase 10 — Migration Plan

**Что сделали:** 15-step roadmap, 8 fitness functions, detailed first tranche, final blueprint.

**Инсайт:** Migration ordered by dependency + risk. Lowest-risk first (Wave debt extraction), highest-risk later (composition slim-down). Total ~73h sequential, ~40h parallelizable. First tranche = Discovery (pure relocation, no behavioral change, rollback = git revert).

**8 Fitness functions** защищают новую архитектуру от erosion:
- FIT-001: module = one directory
- FIT-002: LEGO (register call per module, composition ≤ 100 lines)
- FIT-003: no saga3/
- FIT-004: dependency direction (extended ratchet)
- FIT-005: GenericFlowExecutor ≤ 700 lines
- FIT-006: universal desk for cross-module reads
- FIT-007: single-writer (exactly 3, not 3+1)
- FIT-008: no type-cycle hacks

---

### Финальный blueprint (полная трассировка)

```
code evidence (1544 files)
  → executable topology (5 processes, 3 composition roots)
    → 8 scenarios traced
      → 14 state entities mapped
        → 18 rules catalogued
          → 16 seams identified
            → 4 critical seams
              → target architecture: gate-centric hexagonal
                → 10 relocation clusters
                  → 15-step migration roadmap
                    → 8 fitness functions
                      → first tranche: Discovery (22 files)
```

**Status: recommended-pending-approval**

---

## ЦЕЛЕВАЯ АРХИТЕКТУРА (один абзац)

Gate-centric hexagonal: каждый из 4 модулей — самодостаточный гексагон в `src/modules/<name>/` с domain (pure policies), application (kernel handlers + ports), infrastructure (SQLite adapters), package (manifest + skills). Модули self-register через `register(deps)`. Composition root ~80 строк. saga3/ расформирован (Discovery domain → в модуль; shared/authority → cross-cutting). Universal desk для cross-module handoff (expand saga3_process_products). Wave debt → ADR documentation. ratchet-тесты продолжают защищать новые границы.

---

## СТАТУС

**recommended-pending-approval**

Целевая архитектура и first migration tranche готовы к ревью. Код не модифицировался. Изменения могут начаться только после human approval.
