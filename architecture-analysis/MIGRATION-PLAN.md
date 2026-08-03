# Migration Plan: saga-mcp Architecture Reconstruction

> Подробный план трансформации saga-mcp из распределённого монолита
> в gate-centric hexagonal архитектуру с self-contained модулями.
> Основан на Architecture Reconstruction Protocol (Phases 0-10).

## Статус: recommended-pending-approval (T1 в процессе)

---

## 1. КОНТЕКСТ: ПОЧЕМУ ЭТО НУЖНО

### Проблема
saga-mcp — governance-платформа для параллельных LLM-агентов. Система
работает, тесты зелёные, ratchet держит. Но архитектура накопила долг:

1. **Четыре стола** (SEAM-001): каждый модуль (Discovery, Formalization,
   Development, Delivery) имеет свой submit-tool, свою таблицу, свой
   резолвер — хотя все продукты физически одинаковые: текст с schema + hash.

2. **Распределённый монолит** (SEAM-002): модуль Discovery разбросан по
   4 директориям (modules/discovery/, saga3/domain/, saga3/application/,
   saga3/persistence/). Агент с контекстом 200k тратит 16k токенов на
   один модуль — 8% окна.

3. **Зеркальные типы** (верификация Phase 6): discovery-domain-contracts.ts
   (737 строк) — зеркальная копия типов из saga3/domain/, созданная для
   обхода ratchet. Чистый overhead.

4. **God Object composition root** (SEAM-016): product-lifecycle-runtime.ts
   (780 строк) конструирует ВСЕ адаптеры для ВСЕХ модулей. LEGO контракт
   сломан.

5. **Dead code**: diagnosis handlers (993 строки) — flow node удалён,
   домен остался.

### Что мы строим
Gate-centric hexagonal: каждый модуль — самодостаточный гексагон в
`src/modules/<name>/` с domain/application/infrastructure/package.
Модули self-register через `register(deps)`. Composition root ~80 строк.
saga3/ расформирован. Один universal desk для cross-module handoff.

### Количественная цель

| Метрика | Сейчас | Цель | Метод |
|---|---|---|---|
| Discovery .ts файлов | 38 | ~15 | T1: relocation + delete mirrors + delete diagnosis |
| Discovery строк кода | ~3333 | ~1100 | T1: зеркала исчезают сами, diagnosis удаляется |
| Директорий на модуль | 3-4 | 1 | T1-T6: relocation |
| Composition root строк | 780 | ~80 | T7: self-registration |
| Product desks (таблиц) | 4 | 1 (logical) | T8: WorkplaceProductPort |
| Токенов на модуль | ~16k | ~5k | Следствие всех tranche |

---

## 2. АРХИТЕКТУРНАЯ ЦЕЛЬ (как выглядит результат)

### Target layering

```
┌────────────────────────────────────────────────────────────────┐
│ MCP API Surface (src/tools/)                                   │
│   Thin handlers → delegate to application use cases            │
│   Authority gateway stays here (cross-cutting)                 │
├────────────────────────────────────────────────────────────────┤
│ Conveyor Runtime (src/app/ + src/application/)                 │
│   GenericFlowExecutor (~600 строк, Wave debt удалена)          │
│   LifecycleOrchestrator (без изменений)                        │
│   dispatch-loop, composition-root (~80 строк)                  │
│   WorkAssignmentPort, ProcessRunRepository (ports)             │
├────────────────────────────────────────────────────────────────┤
│ Module Hexagons (src/modules/{discovery,formalization,...}/)   │
│   Каждый:                                                      │
│     domain/       — чистые policies, контракты, типы           │
│     application/  — kernel handlers, ports                     │
│     infrastructure/ — SQLite адаптеры, реализующие ports       │
│     package/      — manifest, resources, skills, templates     │
│     index.ts      — register(deps): void  ← ЕДИНСТВЕННЫЙ EXPORT│
├────────────────────────────────────────────────────────────────┤
│ Work Dispatch (src/lifecycle/ + src/work-dispatch/)            │
│   work-assignment-core, atomic-release, stuck-policy           │
│   (без изменений — это CONVEYOR physics, не модуль)            │
├────────────────────────────────────────────────────────────────┤
│ Cross-Cutting (src/shared/)                                    │
│   canonical-json.ts, authority/, work-intent.ts                │
│   (извлечено из saga3/ — НЕ принадлежит одному модулю)         │
├────────────────────────────────────────────────────────────────┤
│ Persistence (SQLite — таблицы без изменений)                   │
│   Все таблицы остаются. Desk unification логическая, не phys.  │
└────────────────────────────────────────────────────────────────┘
```

### Ключевые architectural decisions (ADR)

| ADR | Решение | Обоснование |
|---|---|---|
| ADR-RECON-001 | saga3/ расформировать — содержимое → modules/discovery/ и shared/ | saga3/ — распределённый монолит (SEAM-002). Discovery domain, application, persistence переезжают в модуль. Cross-cutting (canonical-json, authority) → shared/. |
| ADR-RECON-002 | Desk unification на уровне cross-module handoff, НЕ full table replacement | Adversarial review (ATTACK-007): модуль-специфичный provenance reads сохранены. Universal desk (saga3_process_products) — для cross-module ProductRef handoff. 4 существующих таблицы остаются как backing store. |
| ADR-RECON-003 | Module self-registration через register(deps) | composition root 780→80 строк. LEGO контракт: добавление модуля = 1 директория + 1 register вызов. |
| ADR-RECON-004 | Wave history → docs/architecture/WAVE-LOG.md | ~40% каждого файла — комментарии про Wave N. Убрать из кода, сохранить в документации. |
| ADR-RECON-005 | tracker-view.mjs (5605 строк) разбить на 4 модуля | SRP violation: HTTP + kanban + markdown + recovery в одном файле. |
| ADR-RECON-006 | integration_intents: реализовать ИЛИ документировать как limitation | SEAM-013: git merge crash recovery. ADR-010 описал решение, но не построил. |
| ADR-RECON-007 | Type cycle (ModuleCompletion ↔ ProcessModuleOutputEnvelope) развестись | HACK-003: `null as unknown as ModuleCompletion` в 4 файлах. |
| ADR-RECON-008 | ManagedProductionLedger — один canonical interface в shared/ | На самом деле уже в shared/managed-production.ts — aliases в модулях ОК. |

---

## 3. ПОШАГОВЫЙ ПЛАН (15 tranche)

### Порядок обоснован

Зависимости определяют порядок. Низкорисковое сначала, высокорисковое потом.

```
T9 (Wave debt → safe, no behavior change)
→ T2, T3 (shared/ + authority/ — enablers для T1)
→ T1 (Discovery — proof of concept)
→ ALG-IMP-003 (ledger interface)
→ T5 (Development)
→ T4 (Formalization — самый большой)
→ ALG-IMP-002 (traceability consolidation — после T4)
→ T6 (Delivery)
→ T7 (Composition slim-down — зависит от T1,T4,T5,T6)
→ T8 (WorkplaceProductPort — зависит от T7)
→ ALG-IMP-004, ALG-IMP-005 (hack cleanup)
→ T10 (tracker-view split — lowest priority)
```

### Dependency graph

```
T9 (Wave debt) ──────────────────────────────────────────→ independent
T2 (shared/) ──→ T1 (Discovery) ──→ T4 (Formalization) ──┐
T3 (authority/) ──→ T1 ──────────────────────────────────┤
                                                          ├──→ T7 (Composition)
ALG-IMP-003 (Ledger) ──→ T4 ──→ T5 (Development) ──────┤
                                                          │
T5 ──→ T6 (Delivery) ────────────────────────────────────┤
                                                          │
T7 ──→ T8 (WorkplaceProductPort) ───────────────────────→ │
                                                          │
ALG-IMP-002 (Traceability) ──→ after T4 ─────────────────┤
ALG-IMP-004 (Type cycle) ──→ independent ────────────────┤
ALG-IMP-005 (markExecutionExited) ──→ independent ────────┤
ALG-IMP-001 (v1 NodeRun removal) ──→ independent ────────┤
                                                          ↓
                                                       T10 (tracker-view split)
```

---

### T9: Wave Debt Extraction
**Статус:** не начали | **Риск:** LOW | **Effort:** 2h | **Prerequisites:** none

**Что:** Все комментарии "Wave N will...", "Slice 1.C", "FU-D will..." переносятся из кода в `docs/architecture/WAVE-LOG.md`. В коде остаются только комментарии о поведении, не об истории рефакторинга.

**Файлы (основные):**
- `src/process-modules/application/generic-flow-executor.ts` (~600 строк комментариев про Wave 1-6)
- `src/db.ts` (~200 строк Wave-комментариев)
- `src/process-modules/persistence/sqlite-node-run-repository.ts` (~150 строк)
- `src/process-modules/modules/*/installation.ts` (~100 строк каждый)

**Механизм:** Direct extraction (comments → WAVE-LOG.md)

**Verification:** `npx tsc --noEmit` green + `npm test` green

**Rollback:** `git revert`

---

### T2: saga3/shared → shared/
**Статус:** ✅ СДЕЛАНО (внутри T1a) | **Риск:** LOW | **Effort:** 1h

**Что:** `src/saga3/shared/discovery-canonical.ts` → `src/shared/canonical-json.ts`

**Обновлено:** re-export в `src/process-modules/shared/canonical-json.ts` → указывает на `../../shared/canonical-json.js`

---

### T3: saga3/authority → shared/authority/
**Статус:** ✅ СДЕЛАНО (внутри T1a) | **Риск:** LOW-MED | **Effort:** 2h

**Что:**
- `src/saga3/authority/authorize-saga-tool-call.ts` → `src/shared/authority/authorize-tool-call.ts`
- `src/saga3/authority/build-execution-context.ts` → `src/shared/authority/build-execution-context.ts`
- `src/saga3/domain/execution-context.ts` → `src/shared/authority/execution-context.ts`
- `src/saga3/domain/work-intent.ts` → `src/shared/work-intent.ts`

**Импортеров:** ~25 файлов обновлены (index.ts, tools/, lifecycle/, saga3/)

---

### T1: Discovery Module Consolidation
**Статус:** ⏳ В ПРОЦЕССЕ | **Риск:** MEDIUM | **Effort:** ~8h | **Prerequisites:** T2, T3

**Что:** Перенести ВСЕ discovery-specific файлы из saga3/ в `src/modules/discovery/`.

**Структура после:**
```
src/modules/discovery/
  domain/           ← чистые типы, policies, контракты
  application/      ← kernel handlers, services, ports
  infrastructure/   ← SQLite адаптеры
  package/          ← manifest, skills, templates, checklists
  discovery-process-module.ts  ← определение модуля (Flow, nodes)
```

**Файлы (22 файла):**

*Domain (10 файлов) — ПЕРЕНЕСЕНЫ:*
1. `saga3/domain/discovery-settlement-policy.ts` → `modules/discovery/domain/`
2. `saga3/domain/discovery-settlement-input.ts` → `modules/discovery/domain/`
3. `saga3/domain/discovery-settlement-records.ts` → `modules/discovery/domain/`
4. `saga3/domain/discovery-proposal.ts` → `modules/discovery/domain/`
5. `saga3/domain/discovery-normalization.ts` → `modules/discovery/domain/`
6. `saga3/domain/discovery-normalization-proposal.ts` → `modules/discovery/domain/`
7. `saga3/domain/discovery-normalization-records.ts` → `modules/discovery/domain/`
8. `saga3/domain/discovery-outcome-certificate.ts` → `modules/discovery/domain/`
9. `saga3/domain/discovery-readiness-assessment.ts` → `modules/discovery/domain/`
10. `saga3/domain/discovery-readiness-records.ts` → `modules/discovery/domain/`

*Application (2 файла) — ПЕРЕНЕСЕНЫ:*
11. `saga3/application/discovery-settlement-service.ts` → `modules/discovery/application/`
12. `saga3/application/discovery-certificate-bundle.ts` → `modules/discovery/application/`

*Infrastructure (2 файла) — ПЕРЕНЕСЕНЫ:*
13. `saga3/persistence/saga3-discovery-runtime-port.ts` → `modules/discovery/infrastructure/`
14. `saga3/persistence/saga3-settlement-repository.ts` → `modules/discovery/infrastructure/`

*Cross-cutting (5 файлов) — ПЕРЕНЕСЕНЫ (T1a):*
15-19. shared/canonical-json.ts, shared/authority/*, shared/work-intent.ts

*Осталось перенести (7 файлов):*
20. `saga3/persistence/sqlite-saga3-discovery-runtime.ts` → `modules/discovery/infrastructure/` (1314 строк — большой файл)
21. `saga3/persistence/saga3-readiness-repository.ts` → `modules/discovery/infrastructure/`
22. `saga3/persistence/saga3-proposal-repository.ts` → `modules/discovery/infrastructure/`
23. `saga3/persistence/saga3-normalization-repository.ts` → `modules/discovery/infrastructure/`
24. `saga3/application/discovery-readiness-service.ts` → `modules/discovery/application/`
25. `saga3/application/discovery-normalization-service.ts` → `modules/discovery/application/`
26. `saga3/application/ensure-discovery-workspace.ts` → `modules/discovery/application/`

*Удалить (6 файлов — diagnosis dead code):*
27-31. `saga3/domain/discovery-diagnosis-*.ts` (4 файла, ~993 строки)
32. `saga3/application/discovery-diagnosis-service.ts`
33. `saga3/persistence/saga3-diagnosis-repository.ts`

*Также проверить:*
34. `saga3/domain/proposal.ts` — что это? (не discovery-proposal, возможно cross-cutting)
35. `saga3/application/assign-one-card.ts` — что это? (возможно legacy engine)

**Механизм:** git mv + update import paths. Чистое relocation, no behavioral change.

**Что исчезнет автоматически:**
- `discovery-domain-contracts.ts` (737 строк зеркальных типов) — оригиналы теперь внутри модуля, зеркала не нужны
- Все импорты `saga3/domain/discovery-*` из modules/ — теперь указывают на `./domain/` (та же директория)

**Verification:**
1. `npx tsc --noEmit` — 0 errors
2. `npm test` — all green
3. `npm run test:architecture` — ratchet green (обновить classifiers)
4. NEW test: `modules/discovery/` содержит весь discovery-specific код
5. NEW test: ни один файл в `modules/discovery/` не импортирует из `src/saga3/`

**Rollback:** `git revert` (один commit)

**Спецификация registerDiscovery(deps):**
```typescript
function registerDiscovery(
  registry: {
    kernelHandlers: KernelHandlerRegistry;
    moduleRegistry: ProcessModuleRegistry;
    installationRegistry: ProcessModuleInstallationRegistry;
  },
  sharedDeps: {
    db: Database;
    processRunRepo: SqliteProcessRunRepository;
    nodeRunRepo: SqliteNodeRunRepository;
    certificateRepo: SqliteProcessOutcomeCertificateRepository;
    recoveryCaseRepo: SqliteRecoveryCaseRepository;
    resolveNodeProducts: (...) => NodeProducts | null;
    nodeExecutors: Map<string, NodeExecutor>;
    executorV2Options: { productRepo: ... };
    discoveryRuntimePersistence?: Saga3DiscoveryRuntimePersistence;
  }
): { executor: GenericFlowExecutor; runtimePersistence: Saga3DiscoveryRuntimePersistence }
```

Конструирует внутри:
1. runtimePersistence (default: SqliteSaga3DiscoveryRuntime)
2. briefProvisioning (SqliteDiscoveryBriefProvisioning)
3. settlementService (Saga3DiscoverySettlementService)
4. handlers (createDiscoveryKernelHandlers — 6 handlers)
5. lmPersistence (createDiscoveryLmNodePersistence)
6. executor (GenericFlowExecutor)

Регистрирует:
1. kernelHandlers.registerAll(handlers)
2. moduleRegistry.register(discoveryProcessModule)
3. installationRegistry.register({ definition, executor })

---

### ALG-IMP-003: Consolidate ManagedProductionLedger interface
**Статус:** не начали | **Риск:** LOW | **Effort:** 1h | **Prerequisites:** T1

**Что:** ManagedProductionLedger уже объявлен в `src/process-modules/shared/managed-production.ts`. Modules используют type aliases (`DevelopmentManagedProductionLedger = ManagedProductionLedger`). Это ПРАВИЛЬНЫЙ паттерн — не нужно менять.

**Action:** Подтвердить что дублирования нет. Если найдены другие дубли — консолидировать.

---

### T5: Development Module Consolidation
**Статус:** не начали | **Риск:** MEDIUM | **Effort:** ~4h | **Prerequisites:** ALG-IMP-003

**Что:** Перенести development-specific infrastructure из `src/infrastructure/process-modules/development/` в `src/modules/development/infrastructure/`.

**Файлы (17 .ts):** development-persistence, sqlite-development-settlement-state, development-schemas, development-settlement-policy, development-task-graph, development-workspace-preparation + module definition + handlers.

**Структура после:**
```
src/modules/development/
  domain/           ← schemas, settlement-policy, task-graph (уже тут)
  application/      ← handlers, ports
  infrastructure/   ← SQLite adapters (перенести из infrastructure/)
  package/          ← manifest, skills, templates
```

---

### T4: Formalization Module Consolidation
**Статус:** не начали | **Риск:** MEDIUM-HIGH | **Effort:** ~12h | **Prerequisites:** T1, ALG-IMP-003

**Что:** Перенести formalization infrastructure + консолидировать duplicated traceability (SEAM-010).

**Файлы (26 .ts):** formalization-kernel-ports (240 строк), formalization-installation (2043 строки!), formalization-schemas, formalization-settlement-policy, formalization-persistence-contracts + infrastructure/sqlite-formalization-kernel.ts + formalization-persistence.ts.

**Специфические риски:**
- formalization-installation.ts — 2043 строки, самый большой handler файл
- SEAM-010: findFirstTraceabilityGap (SQL) и findContractGap (in-memory) — две реализации одного правила (RULE-012). Нужно консолидировать ПОСЛЕ или ВО ВРЕМЯ T4.

**ALG-IMP-002 (после T4): Traceability consolidation**
- Дифференциальный тест: обе реализации на 10 графах → identical results
- Извлечь одну pure function `checkTraceability(snapshot): GapReport`
- Удалить дубликат

---

### T6: Delivery Module Consolidation
**Статус:** не начали | **Риск:** LOW-MEDIUM | **Effort:** ~4h | **Prerequisites:** T1 pattern

**Что:** Перенести delivery infrastructure из `src/infrastructure/process-modules/delivery/` в `src/modules/delivery/infrastructure/`.

**Файлы (22 .ts):** delivery-persistence, sqlite-delivery-runtime, sqlite-delivery-approval-inbox, delivery-schemas, delivery-settlement-policy, delivery-kernel-ports + module definition + handlers.

---

### T7: Composition Root Slim-Down
**Статус:** не начали | **Риск:** HIGH | **Effort:** ~8h | **Prerequisites:** T1, T4, T5, T6

**Что:** Заменить inline wiring в `product-lifecycle-runtime.ts` (780 строк) на 4 вызова `register*()`.

**ДО (780 строк):**
```typescript
const discoveryLedger = new SqliteManagedProductionLedger(db);
const formalizationLedger = new SqliteManagedProductionLedger(db);
// ... 40 lines of imports ...
const discoveryHandlers = createDiscoveryKernelHandlers({...});
const formalizationHandlers = createFormalizationKernelHandlers({...});
// ... 600 more lines ...
```

**ПОСЛЕ (~80 строк):**
```typescript
const shared = createSharedDeps(db, workerFactory, workAssignment);
const registry = new ProcessModuleInstallationRegistry({...});

const { executor: discoveryExec } = registerDiscovery(registry, shared);
const { executor: formalizationExec } = registerFormalization(registry, shared);
const { executor: developmentExec } = registerDevelopment(registry, shared);
const { executor: deliveryExec } = registerDelivery(registry, shared);

return { engine: createLifecycleEngine(registry, lifecycleDefinition) };
```

**Риск:** HIGH — behavioral equivalence должна быть доказана characterization tests.

**Verification:**
- Все существующие тесты green
- E2E pipeline test (если есть)
- composition root ≤ 100 строк (FIT-002 fitness function)

---

### T8: WorkplaceProductPort — "Один Стол"
**Статус:** не начали | **Риск:** MEDIUM-HIGH | **Effort:** ~8h | **Prerequisites:** T7

**Что:** Universal desk для cross-module product handoff.

**ADR-RECON-002 (revised after adversarial review):**

Desk unification scoped to CROSS-MODULE HANDOFF level:
- `submitWork({ schema, content, executionRef })` — universal submit, пишет в `saga3_process_products`
- `readWorkplaceOutput(processRunId, nodeId)` — universal read для cross-module handoff
- Module-internal provenance reads (managed-production-ledger) — СОХРАНЕНЫ, не заменены
- 4 существующих таблицы остаются как backing store

**Не является full table replacement.** Это надстройка: universal API поверх существующих столов. Cross-module handoff (Discovery→Formalization→Development→Delivery) идёт через universal desk. Module-internal kernel handlers продолжают читать свои provenance tables.

**WorkplaceProductPort contract:**
```
PORT-001: WorkplaceProductPort
  submit({ schema, content, executionRef }) → { productRef }
    - Idempotent by content_hash (ON CONFLICT DO NOTHING)
    - Validates execution fence
    - Writes to saga3_process_products

  readWorkplaceOutput(processRunId, nodeId) → ProductRef | null
    - Universal cross-module read
    - Returns { schema, ref, hash } — typed ProductRef

  readWorkplaceProvenance(processRunId, nodeId) → ProvenanceRecord[]
    - Delegates to existing managed-production-ledger
    - Module-internal, NOT replaced
```

**Migration mechanism:** Expand-contract
1. Add WorkplaceProductPort as THIN WRAPPER over existing 4 tables (expand)
2. Migrate cross-module handoff callers to use universal read (contract)
3. Legacy submit tools (proposal_submit, artifact_create, process_node_submit) become thin wrappers → eventually removed

**Fitness function FIT-006:** "all cross-module product reads go through WorkplaceProductPort"

---

### ALG-IMP-001: Remove v1 legacy NodeRun path
**Статус:** не начали | **Риск:** MEDIUM | **Effort:** 4h | **Prerequisites:** update test fakes

**Что:** GenericFlowExecutor имеет v1 fallback path (для in-memory test fakes). В production всегда активируется v2. Удаление v1 → ~400 строк меньше.

**Prerequisite:** Обновить все test fakes чтобы реализовывали NodeRunRepositoryV2 (startV2/completeV2/readByExactCursor).

---

### ALG-IMP-002: Consolidate formalization traceability
**Статус:** не начали | **Риск:** MEDIUM | **Effort:** 4h | **Prerequisites:** T4

**Что:** RULE-012 дублирован. findFirstTraceabilityGap (SQL) и findContractGap (in-memory) — две независимые реализации одного правила.

**Шаги:**
1. Написать differential test: обе реализации на 10 репрезентативных графах → identical
2. Извлечь одну pure function: `checkTraceability(snapshot: ContractSnapshot): GapReport`
3. Удалить дубликат
4. Проверить что formalization settlement test green

---

### ALG-IMP-004: Break ModuleCompletion type cycle
**Статус:** не начали | **Риск:** LOW-MEDIUM | **Effort:** 3h | **Prerequisites:** none (independent)

**Что:** `ModuleCompletion ↔ ProcessModuleOutputEnvelope` — cycle via `import type`. HACK-003: `completion: null as unknown as ModuleCompletion` в 4 kernel файлах.

**Решение:** Развести CompletionEnvelope (outcome + terminal + certificateRef) от ProcessModuleOutputEnvelope (productions + outcome + optional completion ref). Нет cycle → нет hack.

**Verification:** `grep -rc "null as unknown as ModuleCompletion" src/` = 0

---

### ALG-IMP-005: Route markExecutionExited through releaseExecutionAtomically
**Статус:** не начали | **Риск:** MEDIUM | **Effort:** 4h | **Prerequisites:** none (independent)

**Что:** HACK-001: markExecutionExited — четвёртый писатель `tasks.current_execution_id`. Должен быть перенаправлен через releaseExecutionAtomically.

**После:** Single-writer set = ровно 3 (lint allowlist упрощается, FIT-007).

---

### T10: tracker-view.mjs Split
**Статус:** не начали (lowest priority) | **Риск:** LOW-MEDIUM | **Effort:** 8h

**Что:** 5605 строк → 4 файла:
- `http-server.mjs` — HTTP routing, port binding
- `kanban-api.mjs` — /api/workers, /api/episode, /api/models
- `artifact-render.mjs` — markdown rendering, artifact resolution
- `board-runner-adapter.mjs` — ClaudeBoardRunner wiring, recovery

---

## 4. FITNESS FUNCTIONS (защита от erosion)

| FIT ID | Правило | Enforcement | Частота | Действие при нарушении |
|---|---|---|---|---|
| FIT-001 | Module = one directory under src/modules/ | Architecture test: scan src/modules/, assert each contains domain/application/infrastructure/package/index.ts | Every CI | FAIL: directory incomplete |
| FIT-002 | LEGO: adding module must not edit composition root beyond one register() call | Architecture test: composition root ≤ 100 lines; each module = 1 register call | Every CI | FAIL: root grew or register mismatch |
| FIT-003 | No saga3/ directory remains | Test: `! exists('src/saga3/')` | Every CI | FAIL: saga3/ exists |
| FIT-004 | Dependency direction: modules import only inward + shared/ | Extended ratchet: modules/<name>/domain/ imports from domain/ + shared/ only | Every CI | FAIL: new outward dependency |
| FIT-005 | GenericFlowExecutor ≤ 700 lines | Test: `wc -l` | Every CI | FAIL: budget exceeded |
| FIT-006 | Universal desk: cross-module reads via WorkplaceProductPort | Architecture test: no module imports another module's product table | Every CI | FAIL: cross-module table import |
| FIT-007 | Single-writer: exactly 3 writers of task owner columns | tasks-writer-invariant.test.mjs (tighten: remove HACK-001 exception) | Every CI | FAIL: 4th writer |
| FIT-008 | Type cycle ban: no `null as unknown as` | Grep test | Every CI | FAIL: hack reappeared |

---

## 5. ОБЩАЯ ОЦЕНКА

| Метрика | Значение |
|---|---|
| Total tranches | 15 (10 structural + 5 algorithmic) |
| Total effort (sequential) | ~73h |
| Total effort (parallel, 2 agents) | ~40h |
| Risk level | MEDIUM (behavior-preserving moves + characterization tests) |
| Rollback | Каждый tranche = git revert (no data migration) |
| Behavioral change | NONE (pure relocation + cleanup) |
| Schema changes | NONE |
| New tests per tranche | 1-3 (boundary verification) |

---

## 6. СТАТУС ВЫПОЛНЕНИЯ

| Tranche | Статус | Коммит | Результат |
|---|---|---|---|
| T2 (shared/) | ✅ | `7ca50a3` | canonical-json → src/shared/ |
| T3 (authority/) | ✅ | `7ca50a3` | authority + work-intent + execution-context → src/shared/ |
| T1 (Discovery part 1) | ✅ | `7ca50a3` | 19 файлов: 10 domain + 2 app + 2 infra + 5 cross-cutting |
| T1-remaining (Discovery part 2) | ✅ | `16643d0` | 7 файлов перенесено + 6 diagnosis dead code удалено (993 строки) |
| T5 (Development) | ✅ | `16643d0` | 2 infrastructure файла → modules/development/infrastructure/ |
| T6 (Delivery) | ✅ | `16643d0` | 3 infrastructure файла → modules/delivery/infrastructure/ |
| ALG-IMP-003 | ✅ | подтверждено | ManagedProductionLedger уже в shared/ — дублирования нет |
| T4 (Formalization) | ⏳ не начали | | 7 файлов в infrastructure/ — самый большой (sqlite-formalization-kernel.ts) |
| ALG-IMP-002 | ⏳ после T4 | | traceability consolidation |
| T7 (Composition) | ⏳ после T1,T4,T5,T6 | | 780→80 строк |
| T8 (WorkplaceProductPort) | ⏳ после T7 | | "один стол" для cross-module handoff |
| ALG-IMP-001 | ✅ | `7344529` | v1 NodeRun — уже удалён в Wave-археологии cleanup |
| ALG-IMP-004 | ✅ | Wave 8 | type cycle — уже устранён (BLOCKER 2) |
| ALG-IMP-005 | ⏳ проверка | | markExecutionExited → releaseExecutionAtomically |
| T9 (Wave debt) | ⏳ | | comments → WAVE-LOG.md |
| T10 (tracker-view) | ⏳ | | 5605 строк → 4 файла |

### Итоги выполненных tranche

**saga3/ статус:** 2 файла осталось (assign-one-card.ts, proposal.ts) — из 38 изначальных.
**Удалено dead code:** 6 diagnosis файлов (993 строки) + 9 diagnosis тестов (~8821 строк deletions всего).
**Module consolidation:**
- Discovery: 21 .ts файл в modules/discovery/ (было 38 в 4 директориях)
- Development: module + infrastructure consolidated
- Delivery: module + infrastructure consolidated
- Formalization: 0 infrastructure moved (T4 pending)

**Verification gates на каждом шаге:**
- tsc --noEmit: 0 errors
- npm test: 3220 pass, 0 fail, 37 skipped
- Behavioral change: NONE
