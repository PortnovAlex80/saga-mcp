# LEGO-контракты конвейера — строгие интерфейсы всех деталей

> 3 архитектора проанализировали кодовую базу. Каждый слой (стол, рабочий,
> цех/фабрика) оценён на strictness. Ниже — единый план: что уже защищено,
> где бреши, что сделать.
>
> Дата: 2026-08-01. Ветка saga4. Коммит cc82edf.

---

## Аналогия и принцип

```
ФАБРИКА (lifecycle) — один контейнер
├── ЦЕХ (process module) — заменяемый механизм конвейера
│   ├── РАБОЧЕЕ МЕСТО (node в Flow) — durable сущность
│   │   ├── СТОЛ (workspace desk) — файлы для рабочего
│   │   │   ├── tracker.md (program counter)
│   │   │   ├── agent-assistance.json (hooks)
│   │   │   ├── recovery-feedback.json (замечания gate)
│   │   │   ├── review-feedback.json (замечания reviewer)
│   │   │   ├── call templates (materialized MCP)
│   │   │   └── checklists
│   │   └── РАБОЧИЙ (worker) — одноразовый гость
│   └── Flow (lm → kernel → terminal)
└── Stage Bindings (как цеха подключаются)
```

**Принцип LEGO:** каждая деталь имеет строгий интерфейс. Детали соединяются
только через объявленные слоты. Никаких "других форм" детали.

---

## Слой 1: СТОЛ (Workplace Desk)

### Что есть сейчас

Два создателя стола:
- `materializePinnedWorkspace` (`pinned-workspace-materializer.ts:201`) — правильный
- `prepareProcessExecutionWorkspace` (`process-execution-workspace.ts:387`) — legacy fallback

Legacy **мёртв в production** (composition-root всегда передаёт packageInstallation),
но код существует. Если `pinned === null` — молча fallback на legacy, который:
- НЕ пишет agent-assistance.json
- НЕ имеет execution-сегмента (перезаписывает каталог)
- НЕ имеет draft inheritance

### Строгий контракт WorkplaceDesk

```typescript
interface WorkplaceDesk {
  // ИДЕНТИЧНОСТЬ (REQUIRED)
  readonly nodeId: string;                    // CGAD P18 — node-durable
  readonly profileId: string;
  readonly moduleRef: string;

  // ПУТИ (REQUIRED)
  readonly trackerPath: string;
  readonly trackerAbsolutePath: string;
  readonly executionDirectory: string;

  // КОНТЕНТ (REQUIRED arrays)
  readonly callFiles: readonly string[];
  readonly checklists: readonly string[];

  // FEEDBACK (explicit presence)
  readonly recoveryFeedback: { present: boolean; path: string | null };
  readonly reviewFeedback: { present: boolean; path: string | null };

  // HOOKS (invariant)
  readonly agentAssistance: {
    readonly required: boolean;  // true iff package has assistance manifest
    readonly path: string | null; // non-null iff required===true
  };
}

// INVARIANTS:
// I1. trackerAbsolutePath endsWith node-${nodeId}.md (node-stable)
// I2. executionDirectory includes node-${nodeId} (desk keyed by node)
// I3. agentAssistance.required === true  → path !== null (else throw)
// I4. recoveryFeedback.present === true   → path !== null
// I5. reviewFeedback.present === true     → path !== null
```

### Что сделать

| # | Действие | Файл | Объём |
|---|---|---|---|
| D1 | `WorkplaceDesk` interface + `assertDeskInvariants()` | `pinned-workspace-materializer.ts` | ~80 строк |
| D2 | Удалить `prepareProcessExecutionWorkspace` + `ProcessExecutionWorkspace` | `process-execution-workspace.ts` | -170 строк |
| D3 | Удалить legacy else-ветку → throw если pinned===null | `legacy-claude-worker-executor-factory.ts:388-403` | ~15 строк |
| D4 | Удалить legacy branch в composition-root | `composition-root.ts:116-118` | ~3 строки |
| D5 | Ratchet-тест: запретить `prepare*Workspace` экспорт | `w13-a4-retired-fallbacks.test.mjs` | ~5 строк |
| D6 | Переписать тесты legacy path на pinned creator | 2 test files | ~100 строк |

---

## Слой 2: РАБОЧИЙ (Worker)

### Что есть сейчас

Контракт рабочего **уже строгий для LM-пути** (lm-node-executor → claude-runner):
- One task = one `claude -p` process
- `claimScope.taskIds: [taskId]` — ровно одна задача
- Frozen execution_context (authority + model route)
- Fence: `SAGA_MANAGED_EXECUTION=1` + `SAGA_EXECUTION_ID`
- Gateway-guard: каждый saga-tool-call проверяется
- `worker_done` → `stop: true` → exit

**НО:** dispatch-loop (`dispatch-loop.ts`) — **вторая, урезанная реализация**:
- Нет fence (нет SAGA_MANAGED_EXECUTION)
- Нет authority from WorkIntent (хардкод tool list)
- Нет claimScope (рабочий берёт любую задачу)
- Нет hooks (нет structured-context)
- Нет materializer (нет agent-assistance.json)

### Строгий контракт Worker

```
Worker MUST:
  BIRTH:   spawned by WorkerExecutorFactory (единственный легальный путь)
           receive claimScope (one taskId OR null-for-queue)
           receive frozen execution_context {execution_id, model_route, authority}
  ENTER:   read task_get FIRST
           read agent-assistance.json (auto-injected by hook)
  WORK:    call only tools in frozen authority surface
           every saga-call carries SAGA_EXECUTION_ID fence
           for LM nodes: process_node_submit ONCE before worker_done
  SUBMIT:  worker_done({task_id, worker_id, result, execution_id})
           for git_change: worker_merge_acquire → merge → worker_merge_release
  DIE:     on stop:true — exit immediately, never call worker_next again

INVARIANTS:
  W1. ONE_TASK_PER_PROCESS — рабочий не держит два task
  W2. NO_ZOMBIE — умерший процесс не остаётся assigned_to
  W3. NO_STATUS_BYPASS — только dispatcher меняет status
  W4. NO_REBIND_WORKPLACE — task нельзя перепривязать к другому ProcessRun
  W5. NODE_DURABLE_IDENTITY (P18) — repair round = тот же workplace
  W6. FENCE_OWNED_TERMINAL — только владелец fence делает terminal-переход
  W7. NO_EXTERNAL_HIRE — модуль не может нанять (external kind удалён)
```

### Что сделать

| # | Действие | Файл | Объём |
|---|---|---|---|
| W1 | Переписать dispatch-loop на WorkerExecutorFactory | `dispatch-loop.ts` | ~150 строк rewrite |
| W2 | `claimScope: undefined` для queue-mode (рабочий из очереди) | тот же | ~5 строк |
| W3 | Fence для dispatch workers: генерировать execution_id | тот же | ~20 строк |
| W4 | Authority из task profile вместо хардкода | тот же | ~15 строк |

**Главное:** dispatch-loop должен идти через тот же `WorkerExecutorFactory` + `createClaudeBoardRunner`, но с `claimScope = undefined`. Вся обвязка (fence, authority, hooks, materializer) — общая.

---

## Слой 3: ЦЕХ (Process Module / Workshop)

### Что есть сейчас

`ProcessModuleDefinition` — **все 9 полей обязательны** в TypeScript.
Catalog validator (`validate-process-module.ts`) — **сильный**: flow-граф,
reachability, outcomes, terminal nodes. Но есть бреши.

### Бреши в контракте цеха

| # | Брешь | Где | Risk |
|---|---|---|---|
| C1 | composite-узел без moduleRef — не проверяется | `validate-process-module.ts:70-88` | medium |
| C2 | LM-узлы без executionProfiles — не проверяется | `validate-process-module.ts` | high |
| C3 | identity.kind — не закрытое множество | `validate-process-module.ts:137` | low |
| C4 | handlerRefs не покрывают kernel handlers | `validateProcessModuleManifest` | medium |
| C5 | resourceIndex не покрывает profile resources | `validateProcessModuleManifest` | medium |

### Invariant'ы цеха

```
Workshop MUST:
  - identity.{name,version,kind} непустые, kind ∈ {discovery,formalization,development,delivery}
  - flow имеет entry → промежуточные → terminal (проверяется)
  - каждый lm-узел ссылается на executionProfile (проверяется)
  - каждый kernel-узел имеет handler (проверяется)
  - каждый human-узел имеет interactionContract (проверяется)
  - каждый composite-узел имеет moduleRef (НЕТ — добавить)
  - если есть lm-узлы → executionProfiles непустой (НЕТ — добавить)
  - external kind запрещён (закрыто типом + комментарий)

Workshop CANNOT:
  - сам нанимать воркеров (external kind удалён)
  - маршрутизировать между модулями (invariant module-does-not-route)
  - излучать outcome не из outcomes[] (проверяется)
```

---

## Слой 4: ФАБРИКА (Lifecycle / Factory)

### Что есть сейчас

`LifecycleDefinition` — **слишком минимальный** (3 поля).
Lifecycle validator (`lifecycle-router.ts`) — **заметно слабее** catalog validator.

### Бреши в контракте фабрики

| # | Брешь | Где | Risk |
|---|---|---|---|
| F1 | Stages не проверяются на reachability из entry | `lifecycle-router.ts` | high |
| F2 | inputMapping referential integrity — не проверяется | нет | high |
| F3 | Transition/reentry budget — нет защиты от зацикливания | нет | medium |
| F4 | outputMapping optional, но downstream может требовать | `lifecycle.ts:38` | medium |
| F5 | Две stage с разными версиями одного модуля — не проверяется | нет | low |

### Invariant'ы фабрики

```
Factory MUST:
  - entryStageId существует в stages (проверяется)
  - каждый stage.moduleRef зарегистрирован (проверяется)
  - каждый outcome имеет маршрут (проверяется)
  - каждый маршрут → stage или terminal (проверяется)
  - все stages достижимы из entry (НЕТ — добавить)
  - inputMapping пути ссылаются на реальные outputMapping (НЕТ — добавить)
  - transition budget для защиты от зацикливания (НЕТ — добавить)

Factory CANNOT:
  - маршрутизировать в цех не из stages (проверяется)
  - иметь stage без маршрутов для всех outcomes (проверяется)
  - иметь исполняемый routeResolver (закрыто для scenario-manifest)
```

---

## Карта enforcement (текущая)

| Проверка | manifest | catalog | installation | lifecycle | runtime |
|---|---|---|---|---|---|
| Каноническая сериализуемость | ✅ | — | — | — | — |
| Flow reachability / terminal / outcomes | ❌ | ✅ | — | — | — |
| LM-узел ↔ executionProfile | ❌ | ✅ | — | — | — |
| **composite-узел ↔ moduleRef** | ❌ | ❌ **брешь** | — | — | — |
| **LM-узлы есть, но profiles пуст** | ❌ | ❌ **брешь** | — | — | — |
| Kernel-handler в registry | ❌ | ❌ | ✅ | — | — |
| Stage ↔ moduleRef | — | — | — | ✅ | — |
| Outcome ↔ route | — | — | — | ✅ | — |
| **Stages reachable from entry** | — | — | — | ❌ **брешь** | — |
| **inputMapping integrity** | — | — | — | ❌ **брешь** | — |
| **Transition budget** | — | — | — | ❌ **брешь** | — |
| WorkplaceDesk invariants | — | — | — | — | ❌ **нет** |

---

## План реализации (приоритезированный)

### Phase 1: Стол (P0 — рабочие без подсказок умирают)
- D1: `WorkplaceDesk` interface + `assertDeskInvariants()`
- D2: Удалить legacy `prepareProcessExecutionWorkspace`
- D3: Throw если pinned===null (вместо fallback)
- D4-D6: Очистка composition-root + тестов

### Phase 2: Рабочий (P0 — единый spawn-путь)
- W1: Переписать dispatch-loop на WorkerExecutorFactory
- W2-W4: claimScope, fence, authority из profile

### Phase 3: Цех (P1 — закрыть бреши валидации)
- C1: composite-узел moduleRef проверка
- C2: LM-узлы → executionProfiles непустой
- C4-C5: handlerRefs + resourceIndex coverage

### Phase 4: Фабрика (P1 — усилить lifecycle validator)
- F1: Reachability stages из entry
- F2: inputMapping referential integrity
- F3: Transition budget

---

## Ссылки (кликабельные)

### Стол
- `src/process-modules/application/pinned-workspace-materializer.ts` (правильный создатель)
- `src/process-modules/application/process-execution-workspace.ts` (legacy, удалить)
- `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:370-403` (if/else)

### Рабочий
- `src/process-modules/application/node-executors/lm-node-executor.ts` (главный spawn)
- `src/app/dispatch-loop.ts` (второй spawn, переписать)
- `src/tools/dispatcher.ts` (worker_next/worker_done, fence, CAS)
- `src/process-modules/application/gateway-guard.ts` (authority pipeline)

### Цех
- `src/process-modules/domain/process-module.ts` (ProcessModuleDefinition)
- `src/process-modules/application/validate-process-module.ts` (catalog validator)

### Фабрика
- `src/process-modules/domain/lifecycle.ts` (LifecycleDefinition)
- `src/process-modules/application/lifecycle-router.ts` (lifecycle validator)
- `src/process-modules/lifecycles/product-delivery-lifecycle.ts` (единственная фабрика)
