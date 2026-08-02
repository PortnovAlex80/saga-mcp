# saga-mcp — План рефакторинга: эталонная модульная архитектура

> Цель: убрать accidental complexity (~40-50% контекста, который тратит
> агент), сделать каждый модуль самодостаточным гексагоном, уменьшить
> composition root с 780 до ~80 строк. После рефакторинга агент с 64k
> контекста может работать с одним модулем целиком; агент с 200k — с 2-3
> модулями + runtime core.

## Проблема: стеклянный потолок

Стеклянный потолок — **не размер кода, а траектория понимания**. Чтобы
ответить на один практический вопрос, агенту нужно прочитать 4-6 файлов в
разных слоях. Источники accidental complexity:

| Источник | Доля | Тип |
|---|---|---|
| Wave-археология в комментариях | ~30-40% файла | accidental |
| Дублирование interface'ов | ~5% | accidental |
| v1/v2 dual-write (уже не нужен) | ~15% executor | accidental |
| Type cycle workaround | ~2% | accidental |
| Composition root 780 строк | ~10% understanding cost | accidental |

## Целевая архитектура: модуль = самодостаточный гексагон

```
modules/discovery/                    ← ОДНА директория, полностью автономная
  domain/
    discovery-case.ts                 ← input contract
    discovery-proposal.ts             ← output contract (pure types)
    settlement-policy.ts              ← PURE decision (CGAD policy v1)
    outcome-certificate.ts            ← certificate type
    authority-scope.ts                ← frozen authority snapshot type
  application/
    kernel-handlers.ts                ← 6 handlers (resolve, prepare, settle)
    settlement-service.ts             ← certificate issuance (pure→port)
    ports.ts                          ← DiscoveryRuntimePersistencePort
                                      ← DiscoveryBriefProvisioningPort
  infrastructure/
    sqlite-discovery-runtime.ts       ← SQLite adapter implements ports
    sqlite-brief-provisioning.ts      ← SQLite adapter implements port
  package/
    manifest.ts                       ← ProcessModuleManifest
    resources/                        ← skills, templates, schemas
  index.ts                            ← register(deps): void — ЕДИНСТВЕННЫЙ export
```

Принцип: `index.ts` модуля экспортирует **одну функцию** —
`register(deps)`. Composition root передаёт общую инфраструктуру (DB
handle, workerExecutorFactory, workAssignment) и получает registration.

## Что меняется в composition root

**Сейчас** (780 строк): 40+ импортов, ручное wiring каждого handler'а.

**Целевое** (~80 строк):

```typescript
const sharedDeps = { db, workerExecutorFactory, workAssignment, ... };
const registry = new ProcessModuleInstallationRegistry(...);

registerDiscoveryModule(registry, sharedDeps);
registerFormalizationModule(registry, sharedDeps);
registerDevelopmentModule(registry, sharedDeps);
registerDeliveryModule(registry, sharedDeps);

return { engine: createLifecycleEngine(registry, lifecycleDefinition) };
```

## saga3/ — расформирование

После рефакторинга `saga3/` перестаёт существовать как директория:

```
saga3/domain/discovery-*      → modules/discovery/domain/
saga3/application/            → modules/discovery/application/
saga3/persistence/            → modules/discovery/infrastructure/
saga3/authority/              → shared/authority/ (cross-cutting)
saga3/shared/                 → shared/canonical-json.ts (уже re-export)
```

## Метрики

| Метрика | Сейчас | После | Выигрыш |
|---|---|---|---|
| Файлов для понимания одного модуля | 8-12 в 4 директориях | 4-6 в одной | ~50% |
| Composition root | 780 строк | ~80 строк | 90% |
| GenericFlowExecutor | ~1500 строк | ~600 строк | 60% |
| Дублирующихся interface'ов | 3+ | 0 | — |
| Wave-археология в коде | ~40% файла | 0 (в ADR) | 40% |
| Steps для добавления модуля | правка 7 файлов | 1 директория + 1 строка | linear |

## План волн

### Wave A: Очистка ( parall. ≤ 2 — overlapping files )

```
A1. Вынести Wave-археологию из комментариев в docs/architecture/WAVE-LOG.md
A2. Удалить v1 legacy path из GenericFlowExecutor (v2 = единственный)
A3. Удалить type-cycle workaround (развести completion/envelope)
A4. Consolidate ManagedProductionLedger в один canonical interface
```

**Важно:** A1 конфликтует со всеми (трогает комментарии везде). A2 и A3
конфликтуют в generic-flow-executor. Реалистично: 2 параллельных агента
максимум без merge conflicts.

Рекомендуемое расписание:
- Агент-1: A4 (автономна — development-kernel-ports + formalization-kernel-ports + sqlite-managed-production-ledger)
- Агент-2: A2 (generic-flow-executor v1 legacy removal)
- Затем последовательно: A3 → A1 (A1 последняя, трогает комментарии везде)

### Wave B: Модульная автономия (параллельно по модулям)

```
B1. discovery: перенести saga3/domain/discovery-* → modules/discovery/domain/
B2. discovery: перенести saga3/application/ → modules/discovery/application/
B3. discovery: перенести saga3/persistence/ → modules/discovery/infrastructure/
B4. formalization: перейти на локальные порты (не импортировать saga3/)
B5. development: перейти на локальные порты
B6. delivery: перейти на локальные порты
B7. authority: перенести saga3/authority/ → shared/authority/
B8. Каждый модуль: index.ts с register(deps)
```

B1-B3 (discovery) — последовательны внутри модуля. B4/B5/B6 (другие
модули) — параллельны между собой. B7 (authority) — после всех.

### Wave C: Composition slim-down

```
C1. product-lifecycle-runtime.ts → 4 register*Module() вызова
C2. Каждый register*Module() — в modules/<name>/index.ts
C3. tracker-view.mjs → разбить на http-server.mjs + kanban-render.mjs + ...
```

C1/C2 — последовательны. C3 — независима, параллельна.

### Wave D: Self-registration

```
D1. Модули регистрируют себя через manifest
D2. Добавление модуля = директория + manifest + lifecycle entry
```

## Стеклянный потолок: поднимается ли?

После рефакторинга:
- Агент с **64k** — работает с одним модулем целиком
- Агент с **200k** — 2-3 модуля + runtime core
- Агент с **200k** — добавляет новый модуль, не читая остальные
- Composition root читается за один взгляд
- GenericFlowExecutor читается за один взгляд

## Параллелизм: предупреждение

saga-mcp сам решает проблему параллельных агентов на overlapping files
через conflict_keys. **Иронично: нам нужно применить это к собственному
рефакторингу.** Главный риск волн — не сложность задач, а merge
conflicts между параллельными агентами, правящими одни и те же файлы.

Перед запуском волны:
1. Определить exact file scope каждой задачи (как conflict_keys)
2. Проверить `conflict_check` на задачах
3. Задачи с overlapping scope — последовательны
4. Задачи с disjoint scope — параллельны
