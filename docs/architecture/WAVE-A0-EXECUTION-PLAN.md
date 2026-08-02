# Wave A0: Production Truth and Cutover — Execution Plan

> Исполняемый план. Не «архитектурная гипотеза», а конкретные задачи с
> Definition of Done. Каждая задача проверяется кодом и тестами.

## Что запускать сейчас

### Поток 1: Ациклический ModuleCompletion

**Проблема:** `ModuleCompletion ↔ ProcessModuleOutputEnvelope` образует
реальный цикл типов. Delivery и Formalization создают несериализуемые
циклические объекты. Discovery и Development обходят через
`null as unknown as ModuleCompletion`.

**Работа:**
1. Удалить обратную ссылку `ProcessModuleOutputEnvelope.completion`.
2. Оставить одно направление: `ModuleCompletion → outputEnvelope`.
3. Исправить четыре module builders (discovery, formalization, development, delivery).
4. Удалить `null/undefined as unknown as ModuleCompletion`.

**Gate:** любой completion сериализуется (`JSON.stringify` не падает) и
валидируется (`validateModuleCompletion` проходит).

### Поток 2: Reaper и single-writer

**Проблема:** Известные дефекты в reaper semantics и single-writer
invariant (CONVEYOR-MENTAL-MODEL baseline).

**Работа:**
1. Живой локальный процесс с expired lease: сначала verified terminate,
   потом release.
2. PID birth mismatch: не убивать чужой PID, но освободить старую execution.
3. `markExecutionExited` направить через общий atomic release
   (`releaseExecutionAtomically`).
4. Удалить временное исключение из single-writer gate
   (`worker-executions.ts:202` — documented exception в
   `work-assignment-core.ts` header).

**Gate:** один lifecycle transition имеет одного writer. Нет
documented exceptions.

### Поток 3: Dynamic-import scanner и честный ratchet

**Проблема:** `createLegacySettlementBridge` использует dynamic import
для обхода dependency-direction ratchet. Scanner не видит literal
`import()`.

**Работа:**
1. Scanner (`dep-graph-scanner.mjs`) должен видеть все literal `import()`.
2. Удалить `createLegacySettlementBridge`.
3. Settlement service явно передавать через composition root (как injected
   port, не через dynamic import).
4. Нулевая dependency-метрика должна соответствовать runtime-графу.

**Gate:** ratchet учитывает static и dynamic imports.

---

## Последовательная цепочка (после Потока 1)

```text
completion model (ациклический)
  → v2 wiring/bootstrap
  → mandatory completion + digest
  → SQLite crash-resume E2E
  → legacy v1 removal
  → dynamic bridge removal (или в Потоке 3)
  → документация
```

### Шаг 4: Настоящий production-v2 cutover

**Проблема:** Composition root (`product-lifecycle-runtime.ts:540-583`)
создаёт четыре `GenericFlowExecutor` без опции `v2:`. Fresh run не имеет
v2-marker, поэтому `runHasV2Marker()` всегда false. v2 path — мёртвый код.

**Работа:**
1. Передать `v2:` dependencies (productRepo + identity/digest) четырём
   executor'ам.
2. Исправить bootstrap: свежему run не должен требоваться уже существующий
   v2-marker. Fresh run должен стартовать на v2 по конструкции.
3. Удалить dual-path (legacy v1 frame) после подтверждения миграции.

**Gate:** свежий production run реально вызывает `completeV2`.

**Зависимость:** v2 нельзя включать до устранения цикла (Шаг 1):
Delivery и Formalization начнут падать на `JSON.stringify` циклического
completion-объекта.

### Шаг 5: Обязательный и целостный completion

**Проблема:** Terminal outcome возможен без сертификата. Completion может
быть `null`. Повреждённый JSON тихо становится null вместо ошибки.

**Работа:**
1. Terminal outcome, требующий сертификат, не коммитится без него.
2. Добавить `completion_digest` (SHA-256 over canonical JSON of completion).
3. На чтении пересчитывать digest и валидировать всю структуру.
4. Повреждённый JSON должен давать corruption/error, а не превращаться в
   `null`.

**Gate:** terminal run не существует без требуемого валидного сертификата.
Повреждение persisted completion обнаруживается fail-closed.

### Шаг 6: Crash-resume E2E

**Проблема:** Нет реального end-to-end теста crash-resume для completion.

**Работа:**
1. Реальная SQLite, все четыре модуля.
2. Краш после settlement, но до lifecycle routing.
3. После рестарта восстанавливается тот же completion и digest.
4. Повторный запуск не выпускает второй сертификат.

**Gate:** crash-resume возвращает тот же digest. Реальный SQLite E2E
проходит для четырёх модулей.

### Шаг 7: Legacy v1 removal

**Работа:**
1. Удалить legacy frame path из GenericFlowExecutor.
2. Удалить `assembleFrameFromDurableNodeRuns` boundary adapter (если v2
   покрывает все случаи).
3. Удалить `runHasV2Marker` — v2 единственный путь.

**Gate:** старый путь удалён, а не оставлен с комментарием «следующая
волна».

---

## Что пока НЕ запускать

- Full tagless final / HKT.
- Adaptive reaper thresholds.
- Multi-host concurrency model.
- Параллелизацию Formalization.
- Массовое удаление CGAD rules.
- Большое переписывание `tracker-view.mjs`.

---

## Definition of Done (общее)

- [ ] Нет циклических completion-объектов и соответствующих type casts.
- [ ] Fresh production run проходит исключительно по v2.
- [ ] Terminal run не существует без требуемого валидного сертификата.
- [ ] Crash-resume возвращает тот же digest.
- [ ] Повреждение persisted completion обнаруживается fail-closed.
- [ ] Один lifecycle transition имеет одного writer.
- [ ] Ratchet учитывает static и dynamic imports.
- [ ] Реальный SQLite E2E проходит для четырёх модулей.
- [ ] `npm test` и `npm run test:architecture` зелёные.
- [ ] Старый путь удалён, а не оставлен с комментарием «следующая волна».

---

## После Wave A0

После завершения A0 — один вертикальный пилот snapshot-based settlement
(лучше Formalization). На нём проверять:
- functional decision core
- разделение локального settlement с платформенным completion control
- `StepDecision` union (continue/await/complete)
