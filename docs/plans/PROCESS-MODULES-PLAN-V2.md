# Process Module SPI + Formalization runtime — Plan v2

> **Ревизия v2:** применены 16 архитектурных поправок из review от 2026-07-26.
> Главные изменения: разделение Definition/Installation, исправленный idempotency key,
> отказ от второго специализированного Formalization poll-loop, добавлен Generic Flow
> Executor, разделены catalog/runtime MCP API, P12 (Lifecycle Orchestrator) вынесен в
> отдельный epic. Жирным отмечены правки относительно v1.

**Ветка:** `agent/saga3-process-modules` (extends `saga3-discovery`).
**Базовый PR:** PortnovAlex80/saga-mcp#9 (draft).
**Трекер:** project_id=40 (Saga3-Process-Modules), epic_id=40.

---

## Цель

Доказать, что **новый Process Module добавляется по стандартному протоколу без изменения Runtime**. Formalization = испытание универсальности SPI на второй предметной области. После Formalization — третий минимальный модуль через skill на базе **Generic Flow Executor**, заморозка SPI, только потом Lifecycle Orchestrator (отдельный epic).

## Канонические решения (директивы)

1. **Lifecycle Orchestrator — ОТЛОЖЕН в отдельный epic.** Текущий epic заканчивается на P11 (SPI freeze). Durable Lifecycle transitions не входят в scope.
2. **Adaptive wrapper без нового poll-loop.** **(поправка #7)** `LegacyFormalizationProcessAdapter` — это тонкий shim: command-transformer + boundary guard + downstream-transition interceptor + result-transformer. Он НЕ копирует orchestration loop Saga2 pump. Терминальное условие — Formalization settlement завершён и certificate выдан (а не "нет claimable tasks").
3. **Generic ProcessOutcomeCertificate.** **(поправка #6)** Generic persistence `saga3_process_outcome_certificates`. Discovery D4 — через **GenericCertificateView** (read-only проекция, НЕ повторная подпись). Formalization — первое нативное хранилище.

## Разделение ответственности

```
Process Module Definition   — содержание работы (что процесс делает)
Process Module Installation — физическая установка (как Runtime его исполнит)  [поправка #1]
ProcessModuleRuntime        — исполняет один модуль (НЕ маршрутит)
LifecycleRouter             — вычисляет следующий StageBinding              [отдельный epic]
LifecycleOrchestrator       — управляет циклом исполнения модулей           [отдельный epic]
```

---

## Этап A — Core SPI

### P0 — ProcessRun contract, state machine, persistence [critical]
- Таблица `saga3_process_runs` (generic envelope, не заменяет модуль-специфичное состояние).
- **(поправка #3)** Idempotency key:
  ```sql
  UNIQUE (project_id, module_name, module_version, idempotency_key)
  ```
  `input_hash` хранится рядом. При повторном вызове с тем же key:
  - тот же input_hash → вернуть существующий ProcessRun
  - другой input_hash → ошибка `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`
- Domain `ProcessRun` record + port `ProcessRunRepository` + SQLite impl.
- **(поправка #2, #4)** MCP tools, разделённые на две группы:
  ```
  Catalog (read-only, существующие):
    process_module_list
    process_module_get
    process_module_validate
    process_module_installation_get    [новый, после P1]

  Runtime (новые, префикс process_run_*):
    process_run_start
    process_run_get
    process_run_cancel                [заменяет stop]
  ```
  `pause`/`resume` НЕ входят в P0 — они зависят от capabilities executor'а (поправка #4).
- Status state machine с ALLOWED_TRANSITIONS, write-once terminal fields.
- Тесты: lifecycle, idempotency, write-once, illegal transition throws.

### P1 — Definition Registry + Installation/Executor Registry [critical]
**(поправка #1)** — это центральная архитектурная правка.

НЕ добавлять executor в `ProcessModuleDefinition`. Разделить:
```ts
interface ProcessModuleDefinition {
  identity: ProcessModuleIdentity;
  contracts: ProcessModuleContracts;     // input + output + certificate  [поправка #5]
  outcomes: OutcomeDefinition[];
  flow: FlowDefinition;
  artifacts: ArtifactTypeDefinition[];
  policies: PolicyDefinition[];
  invariants: InvariantDefinition[];
  executionProfiles: ExecutionProfileDefinition[];
}

interface ProcessModuleInstallation {
  moduleRef: ProcessModuleReference;
  executor: {
    kind: 'generic-flow' | 'legacy-adapter' | 'external-adapter' | 'human-process';
    executorRef: string;
  };
  capabilities: {
    start: true;
    pause: boolean;
    resume: boolean;
    cancel: boolean;
  };
}
```

Два уровня проверки:
- `validateProcessModuleDefinition` — содержательная корректность (контракты, Flow, артефакты).
- `validateProcessModuleInstallation` — исполняемая готовность (executor существует, capabilities указаны).

Два состояния модуля:
- `registered` — definition известен системе.
- `installed` / `executable` — definition связан с доступным executor.

`ProcessModuleExecutor` интерфейс:
```ts
interface ProcessModuleExecutor {
  execute(command: ExecuteProcessModuleCommand): Promise<ProcessModuleRunResult>;
}
```
Возможные реализации: `LegacyEngineAdapter` | `GenericFlowExecutor` | `ExternalProcessAdapter` | `HumanProcessAdapter`.

Discovery: `product-discovery@3.0.0` → `DiscoveryEngineAdapter` → `Saga3DiscoveryEngine`.
Formalization: `solution-formalization@1.0.0` → `LegacyFormalizationProcessAdapter` → Saga2 pump.

### P2 — ProcessModuleRunResult + process_run_start/get API
**(поправка #5)** — сертификат и семантический output разделены.

```ts
interface ProcessModuleRunResult {
  processRunId: string;
  moduleRef: ProcessModuleReference;
  status: 'completed' | 'failed' | 'paused' | 'cancelled';
  outcome: string | null;
  output: {                              // что было создано
    schema: string;
    artifactRef: string;
    contentHash: string;
  } | null;
  certificate: {                         // почему Runtime считает процесс авторитетно завершённым
    schema: string;
    certificateRef: string;
    certificateHash: string;
  } | null;
  error: ProcessModuleError | null;
}
```

`StartProcessModuleCommand` — общий вход.

Никаких специальных `run_discovery`/`run_formalization` — только `process_run_start`.

### P3 — Generic ProcessOutcomeCertificate envelope/persistence
**(поправка #6)** — projection adapter, НЕ второй источник истины.

```ts
interface ProcessOutcomeCertificate<TPayload> {
  schemaVersion: string;
  certificateId: string;
  processRunId: string;
  moduleRef: ProcessModuleReference;
  outcome: string;
  authority: string;
  inputHash: string;
  outputHash: string;
  policyVersion: string;
  policyHash: string;
  payload: TPayload;
  issuedAt: string;
  certificateHash: string;
}
```

Таблица `saga3_process_outcome_certificates`.

Discovery — через **GenericCertificateView**: read-only проекция над существующей таблицей `saga3_discovery_outcome_certificates`. НЕ копирование, НЕ повторная подпись. Условие: один и тот же сертификат не может одновременно быть авторитативным в двух таблицах.

### P3b — Discovery adapter к ProcessRun / RunResult / certificate view
**(новая фаза)** — сделать так, чтобы Discovery нативно использовал ProcessRun persistence и RunResult contract, не создавая дублей:
- При запуске Discovery движок создаёт ProcessRun (status=running).
- По завершении заполняет output + certificate через GenericCertificateView.
- D4 certificate остаётся физически в старой таблице; view читает его.
- Тесты: идемпотентность ProcessRun для Discovery E2E restart.

---

## Этап B — Formalization как второй исполняемый модуль

### P4 — Formalization schemas, settlement, certificate [critical]
**(поправка #5)** — контракты разделены, не слиты.

```ts
interface ProcessModuleContracts {
  input: SchemaReference;       // saga3.formalization-case.v1
  output: SchemaReference;      // saga3.solution-contract.v1
  certificate: SchemaReference; // saga3.formalization-outcome-certificate.v1
}
```

Для Formalization:
- `input` = FormalizationCase (discovery cert ref + subject ref + constraints + evidence + authority scope).
- `output` = SolutionContract (что создано: PRD/UC/AC/SRS/baseline_hash refs + artifact_hashes).
- `certificate` = FormalizationCertificatePayload (почему авторитетно: baseline_hash включён как проверяемая ссылка + traceability assessment + invariants assessment + decision).

**(поправка #12)** Outcomes в kebab-case (validator разрешает дефис, не underscore):
```
formalized
clarification-required
inconsistent
infeasible
failed
```

Различение:
- `ProcessRun.status=failed` → инфраструктурное исполнение сломалось, certificate обычно нет.
- `ProcessRun.status=completed, outcome=inconsistent` → процесс успешно вынес отрицательное предметное решение, certificate ЕСТЬ.

**(поправка #8)** — kernel handlers через порты, не прямые вызовы:
```ts
interface AcceptanceBaselineFreezer {
  freeze(input: BaselineInput): BaselineSnapshot;
}
interface FormalizationTraceabilityGate {
  evaluate(input: FormalizationGraph): TraceabilityResult;
}
interface FormalizationReadinessGate {
  evaluate(input: FormalizationGraph): ReadinessResult;
}
```

Legacy-реализации вызывают существующие `acceptedBaseline`, `assertTraceability`, НО **не `assertTasksReady`** — нужно проверить её семантику (имя похоже на implementation tasks readiness, не на formalization completeness). Не включать в settlement без подтверждения.

### P5 — LegacyFormalizationProcessAdapter [critical]
**(поправка #7)** — самая опасная правка. НЕ создавать `Saga3FormalizationEngine` с собственным poll-loop.

```ts
class LegacyFormalizationProcessAdapter implements ProcessModuleExecutor {
  execute(command): Promise<ProcessModuleRunResult>
}
```

Тонкий shim, допустимые роли:
- преобразователь команды (StartProcessModuleCommand → формат Saga2 pump).
- binding контекста (projectId/epicId → episode binding).
- boundary guard (проверить вход формализации).
- преобразователь результата (Saga2 formalization result → ProcessModuleRunResult).
- перехват downstream transition (после SRS accepted НЕ вызывать `episode_transition({to_stage:'planning'})`).

Он НЕ становится новым orchestration engine. Не копирует poll-loop Saga2 pump. Делегирует исполнение Saga2 pump или существующей сервис-функции.

**Терминальное условие (правильное):**
```
Formalization settlement завершён
И authoritative certificate выдан
→ status=completed, outcome=formalized (или inconsistent/infeasible/clarification-required)

ИЛИ

ProcessRun вошёл в failed/paused/cancelled
→ записать причину
```

Не "нет claimable tasks" — это может быть переходное состояние (worker ещё исполняется, задача paused, ожидается worker_done).

Точка перехвата downstream: `src/tools/workflow.ts:317-333` (srs_accepted → planning.decomposition). Adapter либо: (a) вызывает Saga2 pump с опцией `stopBeforeStage='planning'`, либо (b) перехватывает `episode_transition` после SRS. Не добавлять новый poll-loop в `src/engines/`.

### P5b — Runtime composition of protocolSkill + semanticSkill
**(поправка #9)** — НЕ копировать worker protocol в каждый skill.

Правильная модель:
```
protocolSkill + semanticSkill
    ↓ (Runtime/runner инлайнит оба)
Execution Capsule
```

НЕ вручную дописывать worker protocol в `saga-product`, `saga-analyst`, `saga-architect`, `saga-reconciler`. Иначе протокол расходится.

В ExecutionProfile:
```ts
{
  protocolSkill: 'saga-process-module-worker-protocol',
  semanticSkill: 'saga-analyst'
}
```

**(поправка #9)** Решить судьбу `executionSkill`:
- Вариант 1: удалить после миграции runner.
- Вариант 2: переименовать в `legacyCompositeSkill` для совместимости с Saga2 runner.
- Оставлять три равноправных поля нельзя. Источник истины должен быть один.

Runtime/runner (в claude-runner.mjs) должен инлайнить ОБА навыка в prompt.

### P6 — Deterministic integration suite + separate real-LM smoke
**(поправка #11)** — разделить типы тестов.

**Детерминированный integration suite** (CI-stable):
- Сам создаёт project, epic, Discovery certificate fixture, artifacts, fake worker outputs, ProcessRun.
- Проверяет happy path, clarification-required, inconsistent, restart, duplicate start, certificate replay.
- Без real LM.

**Real-LM smoke** (вручную, не в CI):
- Использует epic 39 + Discovery certificate #23.
- Проверяет один happy path.
- НЕ требует воспроизведения inconsistent/clarification-required.
- Epic 39 НЕ хардкодить в CI — состояние окружения меняется.

---

## Этап C — Стандартное исполнение новых модулей

### P6c — Generic Flow Executor MVP
**(новая фаза — поправка #10)** — без неё P10 не доказывает универсальность.

Минимальная поддержка:
- LM node
- Kernel node
- terminal outcome node

Возможности:
- прочитать FlowDefinition;
- создать NodeRun;
- для LM node — создать WorkIntent;
- применить ExecutionProfile (protocol + semantic skills);
- запустить WorkerExecutorFactory;
- дождаться worker_done;
- проверить output schema;
- вызвать Kernel handler через registry;
- выбрать внутренний transition;
- восстановиться после restart;
- завершить ProcessRun локальным outcome.

Пока НЕ поддерживать: Human/External/Composite nodes, parallel branches, joins, compensation.

### P7 — Scaffold: definition + installation + assets + tests
**(поправка #14)** — генерировать два descriptor.

```
module.manifest.json    — предметное определение
module.installation.json — способ исполнения
```

Пример Formalization installation:
```json
{
  "module_ref": "solution-formalization@1.0.0",
  "executor": {
    "kind": "legacy-adapter",
    "ref": "legacy.saga2-formalization.v1"
  }
}
```

Skill по умолчанию выбирает `generic-flow`. `legacy-adapter` — исключение для миграции существующей реализации.

Стандартная структура модуля:
```
src/process-modules/modules/<name>/
├── module.ts                          (definition)
├── installation.ts                    (executor binding + capabilities)
├── contracts/{input,output,certificate}.schema.ts
├── flow/{flow,nodes,transitions}.ts
├── policies/{settlement,recovery}-policy.ts
├── invariants/invariants.ts
├── executors/module-executor.ts
├── profiles/execution-profiles.ts
└── artifacts/artifact-types.ts
```

### P8 — Designer skill (мастер создания плагина)
14 фаз от inspect existing runtime до readiness report. Skill доказывает:
`registered → validated → startable → observable → restartable → settleable → certificate-producing`.

Phase 5 (choose executor strategy):
- A. Legacy Adapter (миграция существующего процесса).
- B. Generic Flow (стандартный путь для новых модулей, по умолчанию).
- C. External Adapter.
- D. Human Process.

### P9 — Definition and Installation conformance kits
**(поправка #15)** — разделить.

**Definition conformance:**
- contracts (input + output + certificate разделены);
- outcomes (kebab-case, без underscore);
- Flow closure (terminal nodes, reachability);
- schemas, artifact definitions, policies, invariants;
- skills, templates, checklists, allowed tools;
- отсутствие downstream dependencies.

**Installation conformance:**
- executor существует;
- executor capabilities совместимы;
- kernel handlers зарегистрированы;
- external adapters зарегистрированы;
- MCP tools существуют;
- schema refs разрешимы;
- tracker provisioning работает;
- ProcessRun создаётся;
- output и certificate выдаются;
- restart работает;
- **нет module-specific веток в core**.

---

## Этап D — Доказательство

### P10 — Artifact Review через generic-flow
**(поправка #10, #13)** — третий модуль обязан использовать GenericFlowExecutor.

Flow:
```
LM review → Kernel validate → certificate
```

`executor.kind = generic-flow`. НЕ писать custom adapter.

**(поправка #13)** Уточнённый критерий "без изменений":
- 0 изменений в generic Process Runtime core (ProcessModuleRuntimeEngine, Flow Executor).
- 0 module-specific branches в MCP authorization gateway.
- 0 `if (module === ...)` в generic Runtime.
- 0 изменений generic ProcessRun/certificate schema.

Разрешены через стандартные extension registries:
- собственный artifact schema;
- собственная module-owned таблица;
- собственный MCP tool;
- собственный kernel handler.

Создаётся ЧЕРЕЗ skill (P8) + scaffold (P7).

### P11 — SPI freeze + ADR + regression gate
- Заморозка Definition, Installation, RunResult, Certificate, StartProcessModuleCommand.
- `docs/process-modules/SPI-FROZEN.md`.
- ADR (почему выбрали эти интерфейсы, какие альтернативы были).
- conformance-kit (P9) становится regression gate — любое изменение SPI сохраняет прохождение всех 3 модулей (Discovery legacy, Formalization legacy, Artifact Review generic).
- Backward-compat гарантии: типы расширяются только optional полями.

---

## Отдельный будущий epic (НЕ текущий)

### Lifecycle Orchestrator (atomic transitions)
**(поправка #16)** — вынести из текущего epic.

```
Epic 40: Process Module SPI and Authoring Infrastructure  (P0–P11)
Future epic: Lifecycle Orchestrator                         (зависимость: SPI-FROZEN)
```

Включает:
- Durable таблицы: saga3_lifecycle_runs, saga3_stage_runs, saga3_process_transitions.
- Atomic transition с идемпотентным ключом.
- episode_transition → legacy persistence adapter.
- Watcher, cycles, compensation (опционально).

Stage Binding definitions можно оставить в текущем коде как декларативные. Durable transitions — нет.

---

## Что НЕ входит (явно отложено)

- Discovery → Formalization автоматический transition (Lifecycle Orchestrator).
- Durable LifecycleRun до стабилизации SPI.
- Watcher, циклы, compensation.
- Resume между модулями.
- Сложный input mapping engine.

---

## Gate на каждую фазу

- tsc GREEN.
- npm test GREEN (Saga2 e2e-pipeline/track-pipeline heap exhaustion на Windows — известная проблема окружения, не блокер; CI GitHub Actions GREEN).
- Коммит на `agent/saga3-process-modules`.
- НЕ коммитить `nul`, `docs/research/CHAIN-WORKING-V2.md`, `hello.py`, `CLAUDE.md`, `bootstrap-*.mjs`.

---

## Definition of Done всей инфраструктуры (epic 40)

- **Discovery:** запускается через `process_run_start`, имеет ProcessRun, возвращает ProcessModuleRunResult, D4 certificate через GenericCertificateView (НЕ копия).
- **Formalization:** тот же API, реально исполняется через LegacyFormalizationProcessAdapter (БЕЗ нового poll-loop), reusable worker protocol композируется Runtime, artifacts + traces, settlement через порты, Formalization certificate, restart, E2E.
- **Generic Flow Executor:** исполняет модули без специализированного engine.
- **Artifact Review:** через skill + scaffold + generic-flow. Runtime не меняется. Smoke проходит.
- **Ручная композиция:** Discovery completed → оператор получает result → формирует FormalizationCase → process_run_start(Formalization).

---

## Текущее проверенное состояние

- tsc GREEN на ветке `agent/saga3-process-modules`.
- Discovery E2E через Process Module boundary подтверждён (epic 39 Circle Points, outcome=go, certificate #23, 191 cycle).
- Saga2 formalization = SQL-инструменты + 6 skills, НЕ отдельный engine.
- Точки перехвата для shim: workflow.ts:317 (srs_accepted→planning.decomposition), lifecycle.ts:273 (handleEpisodeTransition).

---

## Текущий P0 progress (требует пересмотра по v2)

Реализовано в коммите до v2:
- ✅ Таблица `saga3_process_runs` (нужно исправить idempotency key — поправка #3).
- ✅ Domain `ProcessRun` + port + SQLite impl.
- ✅ Тесты lifecycle (15 passing).
- ⚠️ MCP tools имеют конфликт имён: `process_module_get` vs `process_module_get_run` — переименовать в `process_run_*` (поправка #2).
- ⚠️ `process_module_pause`/`resume` удалить из P0 (поправка #4 — capabilities ещё не объявлены).
- ⚠️ Idempotency UNIQUE через input_hash — переделать на (project_id, module_name, module_version, idempotency_key) + проверка IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT.

## Что делать с уже написанным кодом P0

Применить правки #2, #3, #4:
1. Переименовать `process_module_start/get_run/list_runs/set/pause/resume/cancel` → `process_run_start/get/list/set/pause/resume/cancel`.
2. Изменить SQL UNIQUE constraint с `(module_ref_key, input_hash, idempotency_key)` на `(project_id, module_name, module_version, idempotency_key)`. В `start()` добавить проверку: если key существует с другим input_hash → throw `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
3. Удалить `process_run_pause`/`resume` из P0 (оставить только start/get/list/set/cancel). pause/resume вернутся в P1 после capabilities.
4. Обновить тесты.
