# Development Module — снимок для перестройки на типовую механику

## Принцип

Код = текстовый файл. Development перестраивается на механику Formalization:
lm-узлы + kernel-узлы, рабочие из общей очереди через worker_next,
никаких external-узлов с самонаймом.

## Текущий Flow (НЕправильный — 3 external-узла)

```
plan-task-graph (lm: saga-planner)
  → resolve-task-graph (kernel)
  → execute-implementation-workset (external!) ← сам нанимает
  → integrate-release-candidate (external!)     ← сам нанимает
  → verify-acceptance-workset (external!)       ← сам нанимает
  → settle-development (kernel)
  → complete-{verified|rework-required|clarification-required|blocked|failed}
```

## Целевой Flow (правильный — клон formalization-механики)

```
plan-task-graph (lm: saga-planner)
  → resolve-task-graph (kernel) → materialize impl tasks на канбан
  → [impl tasks в todo → worker_next разбирает через --concurrency=N]
  → settle-development (kernel: settlement policy, проверяет impl results)
  → complete-{verified|rework-required|clarification-required|blocked|failed}
```

Impl tasks — обычные kanban tasks (task_kind='implementation.feature'),
рабочие берут через worker_next (скилл saga-worker), делают код,
сдают через worker_done, потом settle проверяет результат.

## Сохраняем (domain logic — НЕ МЕНЯТЬ)

### Outcomes
- verified (terminal)
- rework-required (terminal)
- clarification-required (terminal)
- blocked (terminal)
- failed (terminal)

### Artifacts
- development-case (kernel, schema: saga3.development-case.v1)
- development-task-graph-proposal (worker, schema: saga3.development-task-graph-proposal.v1)
- development-task-graph (kernel, schema: saga3.development-task-graph.v1)
- development-implementation-workset (external→kernel, schema: saga3.development-implementation-workset.v1)
- integrated-release-candidate (external→kernel, schema: saga3.integrated-release-candidate.v1)
- acceptance-verification-workset (external→kernel, schema: saga3.acceptance-verification-workset.v1)
- verified-integration-bundle (kernel, schema: saga3.verified-integration-bundle.v1)
- development-certificate (kernel, schema: saga3.development-certificate.v1)

### Invariants (semantics — НЕ МЕНЯТЬ)
- development.lm-proposes-kernel-authorizes
- development.review-before-integration
- development.integrate-before-verification
- development.evidence-pins-candidate
- development.no-post-verification-mutation
- development.unknown-denies
- development.exact-lineage
- development.module-does-not-route

### Policies
- development-task-graph-validation (v1.0.0)
- development-settlement (v1.0.0)

### Skills
- saga-planner (планировщик: decomposition → task-graph proposal)
- saga-planning-reviewer (reviewer для planner)
- saga-worker (implementation: пишет код)

### Schemas (content — НЕ МЕНЯТЬ)
- saga3.development-case.v1
- saga3.development-task-graph-proposal.v1
- saga3.development-task-graph.v1
- saga3.development-implementation-workset.v1
- saga3.integrated-release-candidate.v1
- saga3.acceptance-verification-workset.v1
- saga3.verified-integration-bundle.v1
- saga3.development-certificate.v1

## Меняем (механика)

### Удалить
- `sqlite-development-runtime.ts` — ПОЛНОСТЬЮ (runScopedTasks, workerExecutorFactory, process_products)
- `ScopedWorksetRunnerPort` — больше не нужен
- 3 external-узла (execute/integrate/verify) → lm/kernel-узлы
- `claimScope` — не нужен (общая очередь)

### Переписать
- `development-process-module.ts` — Flow: lm+kernel только
- `development-installation.ts` — handlers без external-adapters
- `development-kernel-ports.ts` — formalization-style ports (ledger+graph, не process_products)
- `product-lifecycle-runtime.ts` — development deps как formalization
- tracker templates + skills — под новый Flow

## Файлы development module (текущие)

- `src/process-modules/modules/development/development-process-module.ts` (428 строк)
- `src/process-modules/modules/development/development-installation.ts` (1122 строки)
- `src/process-modules/modules/development/sqlite-development-runtime.ts` (1525 строк → УДАЛИТЬ)
- `src/process-modules/modules/development/development-kernel-ports.ts`
- `src/process-modules/modules/development/development-schemas.ts`
- `src/process-modules/modules/development/development-settlement-policy.ts`
- `src/process-modules/modules/development/development-persistence.ts`
- `src/process-modules/modules/development/package/resources/` (skills, trackers)

## Эталон для клонирования механик

`src/process-modules/modules/formalization/` — КАК development ДОЛЖЕН работать:
- lm-узлы нанимаются через LmNodeExecutor (инфраструктура)
- kernel-узлы проверяют через kernel handlers
- managed-production-ledger хранит результаты (рабочий стол)
- recovery через flow.recovery[]
- skills через executionProfiles

## Installation Deps — интерфейс модуля к инфраструктуре

### Formalization (эталон — чисто декларативные порты)
```ts
interface FormalizationInstallationDeps {
  ledger: FormalizationManagedProductionLedger;        // читать результаты
  graph: FormalizationCanonicalGraphPort;              // читать traces
  baselineRepository: FormalizationBaselineRepository; // читать baseline
  solutionContractRepository;                           // читать contract
  settlementPolicy: FormalizationSettlementPolicyPort; // принять решение
  candidateAcceptance: Pick<ExactCandidateAcceptance, 'isAcceptedExact'>;
}
```

### Development (СЕЙЧАС — исполнительные порты, НАРУШЕНИЕ)
```ts
interface DevelopmentModuleInstallationDependencies {
  plannerSubmissions: ManagedNodeSubmissionReader;
  taskGraph: DevelopmentTaskGraphPort;                  // декларативный ✅
  implementationWorkset: DevelopmentImplementationWorksetPort;  // ИСПОЛНИТЕЛЬНЫЙ ❌
  candidateIntegration: DevelopmentCandidateIntegrationPort;    // ИСПОЛНИТЕЛЬНЫЙ ❌
  acceptanceVerification: DevelopmentAcceptanceVerificationPort;// ИСПОЛНИТЕЛЬНЫЙ ❌
  settlementState: DevelopmentSettlementStatePort;      // декларативный ✅
  outputRepository: DevelopmentOutputRepository;
  taskGraphPolicy: DevelopmentTaskGraphPolicyPort;
  settlementPolicy: ReferenceDevelopmentSettlementPolicy;
}
```

### Development (ЦЕЛЕВОЙ — как formalization, чисто декларативные)
```ts
interface DevelopmentInstallationDeps {
  ledger: ManagedProductionLedger;                     // читать результаты рабочих (рабочий стол)
  graph: CanonicalGraphPort;                           // читать traces
  settlementPolicy: DevelopmentSettlementPolicyPort;   // принять решение
  taskGraphPolicy: DevelopmentTaskGraphPolicyPort;     // валидация graph'а
  // Никаких исполнительных портов — модуль не нанимает, не merge'ит, не тестирует
}
```

Ключевой принцип: Installation Deps = ТОЛЬКО декларативные порты (читать, решать).
Исполнение (нанимать, merge'ить, тестировать) = инфраструктура.
