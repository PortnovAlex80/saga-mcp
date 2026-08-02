# Ответ кибернетику: фактическая сверка и исправления

> Документ является критическим ответом на CYBERNETIC-ANALYSIS.md и
> GREENFIELD-OR-EVOLUTION.md. Он фиксирует фактические ошибки, принимает
> поправки к теоретическим выводам и определяет исправленный порядок
> работ.

## 1. Фактические ошибки в предшествующих документах

Кибернетический анализ был проведён с полной загрузкой кодовой базы, но
несколько фактических утверждений оказались неточными. Ниже — сверка с
кодом.

### 1.1. «ManagedProductionLedger дублируется» — уже исправлено

GREENFIELD-OR-EVOLUTION.md (раздел 5, Wave A, пункт 4) и
BIRDS-EYE-VIEW.md (раздел «Структурные риски», пункт 2) утверждали, что
`ManagedProductionLedger` дублируется в development-kernel-ports.ts и
formalization-kernel-ports.ts.

**Фактически:** коммит `f1ce40e` (2026-08-02, между моими коммитами)
консолидировал интерфейс в `src/process-modules/shared/managed-production.ts`.
Оба модуля теперь re-export через `import type` + `export type`.

Документы устарели в этом пункте.

### 1.2. «Waves 0-9 завершены» — преждевременное заявление

GREENFIELD-OR-EVOLUTION.md (раздел 3) заявил, что Waves 0-9
из CONVEYOR-MENTAL-MODEL «в значительной степени выполнены». Сверка с
кодом показывает, что ряд пунктов **не закрыт**:

- **Production-v2 bypass.** Composition root
  (`product-lifecycle-runtime.ts:540-583`) создаёт четыре GenericFlowExecutor
  **без** передачи `v2:` options. Следовательно `runHasV2Marker` всегда
  `false` на свежих run, и v2 path (execution-context-assembler, exact
  ProductRef resolution, ModuleCompletion persistence) **не активируется**.
  Система работает на legacy frame path, а v2 остаётся мёртвым кодом.

- **Type cycle.** `ModuleCompletion ↔ ProcessModuleOutputEnvelope` —
  реальный цикл типов. Delivery и Formalization создают несериализуемые
  циклические объекты (`envelope.completion = completion` через
  mutable holder). Discovery и Development обходят через
  `null as unknown as ModuleCompletion`.

- **Terminal outcome без сертификата.** GenericFlowExecutor допускает
  `certificate = null` когда `explicitCertificateRef` отсутствует.
  Wave 4.5 bridge исправил часть, но не все модули эмитят completion
  на каждом пути.

- **Dynamic settlement bridge.** `createLegacySettlementBridge`
  в discovery-installation.ts использует dynamic import для обхода
  dependency-direction ratchet. Рантайм-зависимость реальна, но статический
  граф её не видит.

- **Reaper и single-writer дефекты.** CONVEYOR-MENTAL-MODEL «Current
  baseline» перечисляет известные дефекты в reaper semantics и
  single-writer invariant, которые ещё не закрыты.

**Вывод:** «Waves 0-9 завершены» — преждевременно. Корректная
формулировка: «Waves 0-9 частично выполнены; ряд critical cutover
остался незакрытым».

## 2. Принятые поправки к теоретическим выводам

### 2.1. Поправка к Эшби: типы не заменяют gateway

**Оригинальный вывод (CYBERNETIC-ANALYSIS.md §1):** «Typed capability
surface — агент физически не может выразить недопустимое действие, тип
не позволяет.»

**Поправка:** TypeScript-типы стираются при компиляции. LLM отправляет
недоверенный JSON через MCP. Типизированный union внутри trusted core
не останавливает внешний ввод.

**Рабочая формула:**

> Invalid state unrepresentable **внутри trusted core**; invalid input
> **безусловно отклоняется** на trust boundary.

Типы не заменяют authority gateway — они **дополняют** его. Нужно
одновременно:

1. Worker физически получает только разрешённые инструменты (MCP surface).
2. JSON декодируется в discriminated union (runtime validation).
3. Capability grant привязан к execution/card/workplace/fence.
4. Gateway проверяет scope и stale authority.
5. CAS/DB constraints защищают конечное состояние.

Элегантный подход: выводить TS-типы, MCP surface, runtime schema и
gateway policy из **одного capability catalog** (single source of truth).

### 2.2. Поправка к Конанту: artifact graph ≠ полная модель

**Оригинальный вывод (CYBERNETIC-ANALYSIS.md §2):** «AC должен быть
executable specification (тип = тест = оракул). `AC { invariant: function }`
объединяет требование, тест и оракул.»

**Поправка:** Теорема хорошего регулятора не сводится к
`model = specification = test`. Artifact graph — только **часть** модели.
Также нужны: state machine, leases, authority snapshot, policy version,
causal transitions, и состояние `unknown` когда наблюдение недостоверно.

Предложенный `AC { invariant: function }` имеет критические дефекты:

- **не сериализуем** (function не сериализуется в canonical JSON);
- **не content-addressable** (нет стабильного хеша);
- **не создаёт generators и shrinkers** (property test нуждается в них);
- **common-mode failure**: один ошибочный predicate одновременно
  является gate и тестовым oracle.

**Правильнее:** immutable `AcceptanceContractRef`, декларативная схема,
`policyId/version/hash`, и независимо зарегистрированный evaluator.
Producer не должен самостоятельно объявлять свой результат проверенным.

### 2.3. Поправка к Биру: VSM рекурсивна

**Оригинальный вывод (CYBERNETIC-ANALYSIS.md §3):** «Settlement policy
должна быть вынесена из kernel handler'а (S3 наблюдает за S1 сверху).»

**Поправка:** VSM рекурсивна — нужно сначала определить system-in-focus.
На уровне платформы все четыре Process Modules — это S1-единицы.
Product Discovery не является автоматически S4.

Settlement нужно разделять на уровни:

| Уровень | Функция | semantika |
|---|---|---|
| **Локальный регулятор модуля** | `settle(immutableSnapshot, policyRef) → SemanticDecision` | Модуль владеет смыслом `formalized`, `verified`, `delivered` |
| **Глобальный S3** | Проверяет authority, schema, lineage, digest, terminal contract; атомарно фиксирует completion | Не знает семантику конкретных outcomes |
| **S3\*** | Независимый audit / reconciliation / reaper | |
| **S2** | Scheduling, conflicts, fairness, backpressure, durable waits | |
| **S4** | Telemetry, simulation, capacity, rollout новых policies | |
| **S5** | Constitution, ADR, compatibility, human authority | |

Сам факт нахождения кода в одном файле не доказывает смешение S1/S3.
Formalization уже вызывает injected policy
(`formalization-installation.ts:891`). Реальный долг: handler
одновременно собирает snapshot, читает порты, принимает решение,
сохраняет SolutionContract, выдаёт сертификат и строит completion.
**Это ответственность handler'а, не evidence of S1/S3 confusion.**

### 2.4. Поправка к Месаровичу: модуль не управляет conveyor'ом

**Оригинальный вывод (CYBERNETIC-ANALYSIS.md §4):** «Development module's
`areProjectedTasksTerminal` — L1 узел принимает L3 решение.»

**Поправка:** Runtime **не должен** самостоятельно понимать Development
tasks — иначе доменная семантика утечёт в conveyor.

Модуль должен возвращать типизированное durable ожидание:

```typescript
type StepDecision =
  | { kind: 'continue'; effects: EffectRequest[] }
  | { kind: 'await'; condition: ConditionRef }
  | { kind: 'complete'; completion: ProposedCompletion }
```

Модуль определяет **смысл** условия. Runtime сохраняет его, подписывается
на изменения и идемпотентно возобновляет run.

### 2.5. Поправка к tagless final: ports уже дают большую часть пользы

**Оригинальный вывод (CYBERNETIC-ANALYSIS.md §5):** «Tagless final:
алгебра эффектов, чистая программа, production/test interpreters.»

**Поправка:** Пример `DiscoveryAlgebra<F>` нативно не типизируется в
TypeScript без HKT-эмуляции или Effect/fp-ts. Порты проекта уже дают
большую часть пользы algebra/interpreter.

Для crash-resume правильнее event-sourced decision core:

```text
decode + authorize
load immutable snapshot
decide(state, command, policy) → events + effect requests
interpret effects through ports
persist receipts
settle(snapshot, receipts, policyRef)
atomically commit completion
```

Kleisli-цепочка `discovery >=> formalization >=> ...` скрывает
checkpoints, ожидания, retries, cancellation и idempotency. Full tagless
final имеет смысл только для workflow DSL, если действительно нужны
production, simulation и replay interpreters.

**Принятая формулировка цели:**

> Module-owned semantic decisions, platform-owned authority and atomic
> completion, durable functional decision cores.

## 3. Исправленный порядок работ

Wave A-F из GREENFIELD-OR-EVOLUTION.md были преждевременны. Правильный
порядок:

### Этап 1: Честный cutover (предварительно)

1. Закрыть production-v2 cutover (передать `v2:` options во все четыре
   executor в composition root).
2. Сделать completion ациклическим и обязательным.
3. Добавить completion digest и реальный SQLite crash-after-settlement
   E2E для четырёх модулей.

### Этап 2: Инфраструктурная корректность

4. Исправить reaper semantics (известные дефекты из CONVEYOR-MENTAL-MODEL
   baseline).
5. Закрыть single-writer invariant exceptions.
6. Заменить dynamic settlement bridge на injected port (убрать blind spot
   в dependency ratchet).

### Этап 3: Вертикальный пилот snapshot-based settlement

7. Ввести snapshot-based settlement на одном модуле как вертикальный
   пилот.
8. Разделить local settlement (модуль владеет семантикой) / platform
   commit (платформа владеет authority + atomic completion).
9. Добавить generic durable `AwaitCondition` (модуль декларирует
   условие, runtime подписывается и возобновляет).

### Этап 4: Capability catalog

10. Усилить capability catalog как defense-in-depth (TS-типы + MCP
    surface + runtime schema + gateway policy из одного источника).
11. Это не заменяет, а **усиливает** authority gateway.

### Этап 5: Cleanup

12. Декомпозировать tracker/composition (tracker-view.mjs 5605 строк →
    разбить).
13. Удалить migration archaeology (wave-комментарии → ADR).
14. Убрать `as any` в composition root.

### Этап 6: Adaptive control (последним)

15. Adaptive thresholds вводить **только** в shadow mode, с hard bounds,
    hysteresis, audit и rollback.
16. Lease и kill-safety thresholds должны оставаться детерминированными.

## 4. Роли документов (исправленные)

Три документа не составляют полную карту. Правильные роли:

| Документ | Роль |
|---|---|
| `BIRDS-EYE-VIEW.md` | Доказуемый as-is snapshot с commit SHA |
| `CONVEYOR-MENTAL-MODEL.md` | Нормативный ubiquitous language и инварианты |
| `CYBERNETIC-ANALYSIS.md` | Архитектурные **гипотезы**, не «теоретический оптимум» |
| `GREENFIELD-OR-EVOLUTION.md` | Только незавершённый roadmap с зависимостями и exit gates |
| ADR | Фиксируют решения |
| Executable scenarios | Предоставляют доказательства |

## 5. Убираемые из CYBERNETIC-ANALYSIS.md утверждения

Следующие формулировки признаны необоснованными и подлежат удалению или
ослаблению:

- «на 40-60% контекстной нагрузки» — нет метрики, нет baseline.
- «весь lifecycle — чистая функция» — скрывает checkpoints, ожидания,
  retries, idempotency.
- «вынести S3 наверх» — буквальное прочтение VSM без учёта рекурсивности.
- «AC { invariant: function }» — не сериализуем, не content-addressable.
- «Kleisli composition `discovery >=> ...`» — скрывает crash-resume
  механику.

Сильная формулировка цели, принимаемая как canon:

> **Module-owned semantic decisions, platform-owned authority and atomic
> completion, durable functional decision cores.**
