# Ответ на кибернетическую критику

Кибернетический анализ полезен как диагностическая оптика, но пока не как
готовая целевая архитектура. Он правильно указывает направление, однако
местами превращает метафору или теорему в слишком сильный технический вывод.

Главная цель для saga-mcp: не «весь lifecycle как чистая функция + tagless
final», а **durable state machine с чистыми decision kernels, явными эффектами,
строгими authority-границами и независимым control plane**.

## Сначала фактическое противоречие

`GREENFIELD-OR-EVOLUTION.md` объявляет Waves 0–9 завершёнными. Но production
всё ещё создаёт executor-ы без v2 в `product-lifecycle-runtime.ts:540`, а свежий
run может войти в v2 только при уже существующем v2-marker в
`generic-flow-executor.ts:415`.

Дополнительно:

- `ModuleCompletion ↔ ProcessModuleOutputEnvelope` образует реальный цикл.
- Delivery и Formalization создают несериализуемые циклические объекты.
- Discovery и Development обходят тип через
  `null as unknown as ModuleCompletion`.
- Terminal outcome пока возможен без сертификата.
- Dynamic settlement bridge скрыт от dependency ratchet.
- Reaper и single-writer ещё имеют известные дефекты.

Поэтому начинать «парадигмальные» Waves B–F преждевременно. Сначала нужен
честный cutover.

## Поправка к Эшби

CGAD и allowlist — не variety amplification, а уже **аттенюаторы
разнообразия**. Typed union полезен, но TypeScript-типы стираются, а LLM
отправляет недоверенный JSON.

Рабочая формула:

> Invalid state unrepresentable внутри trusted core; invalid input безусловно
> отклоняется на trust boundary.

Нужны одновременно:

1. Worker физически получает только разрешённые инструменты.
2. JSON декодируется в discriminated union.
3. Capability grant привязан к execution/card/workplace/fence.
4. Gateway проверяет scope и stale authority.
5. CAS/DB constraints защищают конечное состояние.

Типы не заменяют authority gateway. Лучше выводить TS-типы, MCP surface,
runtime schema и gateway policy из одного capability catalog.

## Поправка к Конанту

Из теоремы хорошего регулятора не следует `model = specification = test`.

Artifact graph — только часть модели. Также нужны state machine, leases,
authority snapshot, policy version, causal transitions и состояние `unknown`,
когда наблюдение недостоверно.

Предложенный `AC { invariant: function }`:

- не сериализуем;
- не content-addressable;
- не создаёт generators и shrinkers;
- может породить common-mode failure, когда один ошибочный predicate
  одновременно является gate и тестовым oracle.

Лучше использовать immutable `AcceptanceContractRef`, декларативную схему,
`policyId/version/hash` и независимо зарегистрированный evaluator. Producer не
должен самостоятельно объявлять свой результат проверенным.

## Поправка к Биру

VSM рекурсивна, а сначала нужно определить system-in-focus. Product Discovery
не является автоматически S4 всей платформы. На уровне платформы все четыре
Process Modules являются S1-единицами.

Settlement нужно разделить на два уровня:

- **Локальный регулятор модуля:**
  `settle(immutableSnapshot, policyRef) -> SemanticDecision`. Модуль владеет
  смыслом `formalized`, `verified`, `delivered`.
- **Глобальный S3:** проверяет authority, schema, lineage, digest, terminal
  contract и атомарно фиксирует completion. Он не знает семантику конкретных
  outcomes.
- **S3\*:** независимый audit/reconciliation/reaper.
- **S2:** scheduling, conflicts, fairness, backpressure, durable waits.
- **S4:** telemetry, simulation, capacity и rollout новых policies.
- **S5:** Constitution, ADR, compatibility и human authority.

Сам факт нахождения кода в одном файле не доказывает смешение S1/S3. Сейчас
Formalization уже вызывает injected policy в `formalization-installation.ts:891`.
Реальный долг: handler одновременно собирает snapshot, читает порты, принимает
решение, сохраняет SolutionContract, выдаёт сертификат и строит completion.

## Поправка к Месаровичу

Runtime не должен самостоятельно понимать Development tasks. Иначе доменная
семантика утечёт в conveyor.

Модуль должен возвращать типизированное durable ожидание:

```ts
type StepDecision =
  | { kind: 'continue'; effects: EffectRequest[] }
  | { kind: 'await'; condition: ConditionRef }
  | { kind: 'complete'; completion: ProposedCompletion };
```

Модуль определяет смысл условия. Runtime сохраняет его, подписывается на
изменения и идемпотентно возобновляет run.

## Functional core вместо догмы tagless final

Пример `DiscoveryAlgebra<F>` из документа нативно не типизируется в TypeScript
без HKT-эмуляции или Effect/fp-ts. Порты проекта уже дают большую часть пользы
algebra/interpreter.

Для crash-resume правильнее:

```text
decode + authorize
load immutable snapshot
decide(state, command, policy) -> events + effect requests
interpret effects through ports
persist receipts
settle(snapshot, receipts, policyRef)
atomically commit completion
```

Kleisli-цепочка `discovery >=> formalization >=> ...` скрывает checkpoints,
ожидания, retries, cancellation и idempotency. Full tagless final имеет смысл
только для небольшого workflow DSL, если действительно нужны production,
simulation и replay interpreters.

## О двенадцати рисках

- Критические: type cycle, production-v2 bypass, необязательный сертификат,
  dynamic-import blind spot, reaper semantics и незакрытый single-writer.
- Реальные cleanup-задачи: `as any`, 5605 строк `tracker-view.mjs`,
  wave-комментарии и oversized composition.
- Не баги, а ограничения: SQLite `BEGIN IMMEDIATE`, состояние `reserved`,
  последовательный Formalization gate, fail-closed Delivery.
- `ManagedProductionLedger` уже консолидирован в `f1ce40e`; документ устарел.
  При этом общий интерфейс оправдан только как контракт bounded context
  `Production and Evidence`, а не просто потому, что две формы совпали.
- Старый сертификат не должен становиться невалидным после изменения policy.
  Нужны `policyRef`, issuer, subject digest и механизм supersession/revocation.

## Исправленный порядок

1. Закрыть production-v2 cutover, сделать completion ациклическим и
   обязательным.
2. Добавить completion digest и реальный SQLite crash-after-settlement E2E для
   четырёх модулей.
3. Исправить reaper, single-writer и dynamic bridge.
4. Ввести snapshot-based settlement на одном модуле как вертикальный пилот.
5. Добавить generic durable `AwaitCondition` и разделить local settlement /
   platform commit.
6. Усилить capability catalog как defense-in-depth.
7. После этого декомпозировать tracker/composition и удалять migration
   archaeology.
8. Adaptive control вводить последним, в shadow mode, с hard bounds,
   hysteresis, audit и rollback. Lease и kill-safety thresholds должны
   оставаться детерминированными.

## Иерархия архитектурных документов

Три документа пока не составляют полную карту. Правильные роли такие:

- `BIRDS-EYE-VIEW` — доказуемый as-is snapshot с commit SHA.
- `CONVEYOR-MENTAL-MODEL` — нормативный ubiquitous language и инварианты.
- `CYBERNETIC-ANALYSIS` — архитектурные гипотезы, не «теоретический оптимум».
- `GREENFIELD-OR-EVOLUTION` — только незавершённый roadmap с зависимостями и
  exit gates.
- ADR фиксируют решения; executable scenarios предоставляют доказательства.

Из `CYBERNETIC-ANALYSIS.md` стоит убрать необоснованные проценты снижения
сложности, обещание «весь lifecycle — чистая функция» и буквальное «вынести S3
наверх».

Сильная формулировка цели: **module-owned semantic decisions, platform-owned
authority and atomic completion, durable functional decision cores**.
