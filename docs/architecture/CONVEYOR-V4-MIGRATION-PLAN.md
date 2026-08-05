# Conveyor v4 — Migration Plan

**Статус:** утверждённый план рефакторинга saga-mcp на целевую архитектуру
Conveyor Mental Model v4.

**Нормативная база:**
- [`CONVEYOR-MENTAL-MODEL.md`](CONVEYOR-MENTAL-MODEL.md) (v4) — plain-language model.
- [`FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md`](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md) — REG/PROC/E2E acceptance registry.
- Формальный инвариант — CGAD P18 (`cgad-v2-spec.md`).

План дословно следует **migration-order** из v4 (раздел «One engine, two
channels»). Каждый PR обязан (Registry §6) ссылаться на затронутые
`REG-*`/`PROC-*`/`E2E-*`.

## Фиксированные решения (из документов, не развилки)

- **State authority:** authoritative `Workplace` aggregate + two-channel state
  (`kanbanPhase`+`loopState`+`nextRole`); `tasks` → rebuildable projection,
  drop после cutover (REG-05, REG-06, REG-28, migration-order §5).
- **Порядок цехов:** Formalization → Discovery → Development → LM-Delivery
  (v4 migration-order §3, workshop matrix).
- **Scope:** полный v4, все 6 шагов.

## Контракт «оставаться на фронте»

- DB additive между фазами; `SCHEMA_VERSION` bump один раз (шаг 6). Pre-release
  disposal policy уже в `db.ts`.
- MCP-имена стабильны до шага 5: `proposal_submit`/`process_node_submit`/
  `artifact_create`/`worker_done` → wrappers.
- `tasks` остаётся authority до шага 5; после — projection.
- Read-switch за `SAGA_WORKPLACE_READ=legacy|new|both`; cutover одним
  переключением + сравнением.
- Каждый этап = ветка/PR, между ними runtime ходит, тесты зелёные.
  Реверт N.c → N.b.

## Текущие активы (НЕ строить с нуля)

- `WorkplaceProductPort` + `SqliteWorkplaceProductAdapter` (T8) → будущий
  `ProductRepositoryPort`. Сейчас: non-authoritative, доверяет caller digest,
  не enforce'ит fence.
- `ProductRef`/`NodeProductionEnvelope`/`ProcessModuleOutputEnvelope` +
  валидаторы (pure SPI).
- `ExactCandidateAcceptance` (`saga3_exact_candidate_acceptance_decisions/items`)
  → proto-`GateDecision`: CAS, idempotency, immutable hash, lineage,
  review-receipt binding. Обобщается до closed verdict.
- Single-writer set (`atomic-release`, `work-assignment-core`,
  `unfenced-assignment-recovery`) + ratchet `tasks-writer-invariant.test.mjs`.
- `GenericFlowExecutor` graph walk, ProcessRun lease, recovery accounting,
  NodeRun, `RecoveryIssue`/`RecoveryCase`.
- `worker_executions` (lease/heartbeat/progress/PID/birth-token) — зрелая
  Execution Control.

## Текущие разрывы (строим)

`Workplace` aggregate, `WorkplaceRef`, two-channel state, `ExecutionReservation`,
`CandidateSet` seal, универсальный `GateDecision`/`GateRun`,
`CheckPlan`/`CheckProvider`/`CheckRunnerPort`/`CheckReceipt`,
`HumanInteractionRun`, `EffectAttempt`/`EffectReceipt`/`EffectExecutorPort`,
`production-cell` FlowNode, `ProductionCellCoordinator`.

---

# ШАГ 1 (migration-order §1): Authoritative stores + projection rebuilding

**REG-05, REG-06, REG-09, REG-11, REG-12, REG-14, REG-15, REG-17, REG-18,
REG-28.** Всё additive, не трогает runtime-путь.

**1.1 Pure-domain ядро** `src/process-modules/domain/workplace/` (чистые, без
SQLite):
- `workplace-ref.ts` (`WorkplaceRef{processRunId,moduleRef,productionCellId,
  workKey}` + `asWorkplaceRef`).
- `workplace-state.ts` (`KanbanPhase`, `LoopState`, `NextRole`,
  `TerminalReason`, закрытая таблица пар — REG-28-AC-01).
- `candidate-set.ts` (`CandidateSet`, members produced|carried-forward,
  seal key).
- `gate.ts` (`GateDecision`/`GateRun`/`CheckPlan`/`CheckReceipt`/
  `CheckProvider`-type; обобщение `RecoveryIssue`).
- `execution-reservation.ts`. Barrel `index.ts`. Property-тесты на
  пары/decision-uniqueness/CAS.

**1.2 SQLite-адаптеры** `src/infrastructure/workplace/` (additive CREATE TABLE
IF NOT EXISTS в `schema.ts`, без `SCHEMA_VERSION` bump):
- `SqliteWorkplaceRepository` (`workplaces` PK workplace_ref, kanban_phase,
  loop_state, next_role, revision, active_reservation/gate/recovery refs,
  CAS на revision).
- `SqliteCandidateSetRepository` (UNIQUE
  `(workplace_ref,producer_execution_ref,role)`).
- `SqliteGateRepository` (`gate_decisions`/`gate_runs`/`check_receipts`/
  `check_plans`, immutable triggers по образцу ExactCandidateAcceptance).
- `SqliteExecutionReservationRepository`.

**1.3 Rebuildable WorkItem projection**
`src/infrastructure/projections/work-item-projector.ts`: читает `workplaces`,
строит projection. На этом шаге пишется параллельно с `tasks`, ничего не читает
из неё (E2E-10).

**1.4 Ratchet-тесты**: `workplace-domain-purity`, `workplace-stores-additive`,
`gate-decision-immutability`.

**Приёмка:** stores существуют, projection пишется, runtime не changed,
текущие тесты зелёные.

---

# ШАГ 2 (§2): Production Cell coordinator + universal execution context/tools

**REG-04, REG-08, REG-10, REG-13, REG-15, REG-21, REG-25, REG-27.**

**2.1 `ProductionCellDefinition`**
(`domain/workplace/production-cell-definition.ts`) — структура из v4
§«Declarative Production Cell definition». FlowNode kind `production-cell`
добавляется в `FlowNodeKind`.

**2.2 `ProductionCellCoordinator`**
(`application/production-cell-coordinator.ts`) — извлечь из
`GenericFlowExecutor` bounded control-loop: materialize Workplace → lease →
launch → on `execution_complete` seal CandidateSet → GateRun → apply
GateDecision (CAS revision) → transition по таблице v4. `GenericFlowExecutor`
остаётся graph-walker.

**2.3 Universal execution context + tools** (REG-08, PROC-04/05): внутренние
MCP `workplace_get`/`product_read`/`product_submit`/`execution_complete`.
`ProductRepositoryPort` (замена prototype): canonicalize/hash internally,
enforce live fence, reject stale writes. Graduate `SqliteWorkplaceProductAdapter`
(убрать доверие caller digest, добавить fence-enforcement).

**2.4 `WorkerLauncherPort`** выделить из `LmNodeExecutor`/board-executor.

**2.5 Один launch path**: сегодня два (`LmNodeExecutor` directly + board
dispatcher) — унифицировать, один `concurrency=N`, один reservation path.

**Приёмка:** coordinator запускается в тени (feature-flag) на тестовых
cell-declarations; текущие flows не затронуты.

---

# ШАГ 3 (§3): Цехи на protocol — Formalization → Discovery → Development → LM-Delivery

Каждый цех = 4 подфазы (bridge → dual-write → read-switch → drop legacy).
Сохранять exact historical ProductRefs.

## 3.A Formalization (5–7 нед) — REG-03/11/13/18

Сильнейший кандидат: уже использует generic Flow + ExactCandidateAcceptance.

- **3.A.1** Schema `saga3.artifact-ref.v1`: workplace хранит ref на artifact
  (`artifact:<id>#<hash>`)+hash, НЕ копию. Правило
  `workplace_products.contentHash = artifacts.content_hash` (drift=блокирующая
  ошибка, тест).
- **3.A.2** Dual-write в `artifact_create`/`artifact_update`.
  `saga3_managed_artifact_productions` параллельно.
- **3.A.3** Generalize `ExactCandidateAcceptance` → универсальный
  `GateDecision`: closed verdict
  `{accepted|repair_required|human_required|failed}`, `acceptedOutputBindings`
  (только final-gate — REG-18-AC-02/03), обязательный `repairTargetRole`
  (REG-18-AC-04), decision+transition через idempotent outbox (REG-18-AC-05).
  Formalization settlement-policy первой переходит.
- **3.A.4** Read-switch в formalization kernel. За флагом.
- **3.A.5** Freeze `saga3_managed_artifact_productions`.
- **3.A.6** Reviewer cell: pin к author CandidateSet (REG-12-AC-04). Два
  reject-типа (E2E-04/05).
- **3.A.7** Conformance: `formalization-e2e-smoke` → real-LM (E2E-14).

## 3.B Discovery (5–7 нед) — REG-03/11. Тяжёлый: proposal↔settlement/certificate
по hash.

- **3.B.1** Bridge proposal↔ProductEnvelope, `ref='proposal:<legacy_id>'`. FK
  settlement/readiness/certificate на числовой id через join-view (не ломать
  UNIQUE/INDEX).
- **3.B.2** Dual-write proposal. Idempotency по `content_hash`.
- **3.B.3** Read-switch в `SqliteSaga3DiscoveryRuntime`
  (`readLatestProposalForIntent` и т.п.).
- **3.B.4** Settlement (D4) → GateDecision (`go/clarify/reject` → closed
  verdict).
- **3.B.5** Stop dual-write; settlement/certificate join'ят через
  `workplace_products`.
- **Обязательный gate:** тот же `certificate_hash` на историческом dump'е
  до/после. Без этого — не идём дальше.
- Discovery-таблицы readiness/settlement/certificates/diagnosis остаются
  (authoritative D3/D4/D5).

## 3.C Development (4–6 нед) — REG-04 (fan-out)/11/23

- **3.C.1** `TextSetManifest` (REG-11-AC-05): paths/modes/rename/delete, не
  конкатенация текста. `process_node_submit` → `product_submit` schema
  `saga3.text-set.v1`.
- **3.C.2** Fan-out cell: accepted task-graph → `implement-work-item` cell, по
  одному Workplace на stable item id (`workKey` из accepted binding, НЕ array
  index — REG-04-AC-03). Completion `all`.
- **3.C.3** Test/build → CheckProvider (read-only sandbox, REG-16). Git merge →
  EffectAttempt (REG-23), отдельный control-node.
- **3.C.4** Read-switch в development settlement. Freeze
  `saga3_managed_node_submissions`.

## 3.D LM-Delivery (2–3 нед) — REG-22/23

LM-cell только где LM authors desired state.

- **3.D.1** LM desired-state cell (опционально).
- **3.D.2** `HumanInteractionRun` (REG-22): delivery approval → durable, не
  hidden в CheckProvider.
- **3.D.3** `EffectAttempt`/`EffectReceipt`/`EffectExecutorPort` (REG-23):
  publish/deploy/observe с exact digest + idempotency + observe-before-retry.
- **3.D.4** Checks vs effects граница (REG-14/16).

**Приёмка шага 3:** все 4 цеха через universal desk + GateDecision;
module-specific stores frozen. E2E-01..06.

---

# ШАГ 4 (§4): Effects через versioned providers

**REG-16/23/26.** `CheckProvider`/`EffectProvider` — отдельно versioned,
security-reviewed capability plugins. Composition-root владеет registry; domain
только ссылается на id. Git merge/tag/push (сейчас `integration-executor.ts`),
CI, deploy → providers. Provider не запускает LM/human скрыто (REG-14-AC-04,
REG-16-AC-03). Effect idempotency: exact desired-state digest + idempotency key
+ observe-before-retry (REG-23-AC-03, E2E-12/30).

---

# ШАГ 5 (§5): Conformance proof + запрет core reads из legacy

**REG-01/05/06/09/28; E2E-07..14.** Самый рискованный шаг.

**5.1 Universal real-model conformance harness (E2E-14):** один suite,
deterministic + real LM driver. Asserts durable protocol facts (не wording):
exact inputs read, checks passed, `execution_complete` sealed one CandidateSet
но не accept'нула, real CheckPlan → typed GateDecision, repair keeps
Workplace/card/desk, 3 distinct transitions (author failure / invalid reviewer
/ reviewer-proven defect), crash/lease/stale/pause/resume converge без Kanban
rollback в `todo`.

**5.2 Cutover authority:**

- Запретить core reads из `tasks` (REG-06-AC-01/02, REG-28).
  `tasks.{status,integration_state,current_execution_id}` → projection из
  `workplaces`.
- `worker_next/done/ask_*/merge_*`/`task_batch_update` → wrappers вокруг
  Conveyor Runtime use cases. MCP-имена те же.
- Single-writer set: owner-columns `workplaces` пишет только
  `ProductionCellCoordinator`+`ConveyorRuntime` (CAS revision); owner-columns
  `tasks` пишет только `WorkItemProjector` (one-way).

**5.3 Two-channel enforcement** (REG-28): закрытые пары фаз×loop;
crash/expiry/repair меняют loop НЕ Kanban (REG-28-AC-02); reviewer-defect —
явный semantic backward (REG-28-AC-04).

**5.4 Absence-of-readers ratchet:** core не читает `tasks`/`worker_executions`
как orchestration truth.

**Приёмка:** authority на Workplace; `tasks` — projection; conformance green
(deterministic + real-LM).

---

# ШАГ 6 (§6): Drop legacy

**Ratchet → drop.** Запретить legacy writes, затем drop
`saga3_managed_artifact_productions`, `saga3_managed_node_submissions`,
`saga3_proposals` (после join'ов через workplace; исторические данные
disposable), `saga3_delivery_*` submission, `tasks` owner-колонки,
`episode_workflows`, legacy bridges/launch path, prototype
`WorkplaceProductPort`, module-name/task-kind switch'и (REG-01-AC-04,
REG-03-AC-05). `SCHEMA_VERSION` → 2. `tracker_export/import` → format_version
1.5. Финальные ratchet: `no-task-table-in-core`, `no-module-name-switch`,
`fifth-workshop-installs-without-core-change` (REG-03-AC-04, E2E-13).

---

## Сквозные принципы (каждый PR)

1. **REG/E2E citation** (Registry §6.1).
2. **Definition of Accepted** (§7): язык/identity/authority/behavior/boundaries/
   evidence/recovery/projection/conformance.
3. **17 architecture review questions** (v4 §), особенно #13/#14/#15/#16.
4. **Pure-domain ratchet** + single-writer evolution.
5. DB additive; `SCHEMA_VERSION` один раз.
6. Read-switch за флагом.

## Риски

- **3.B Discovery lineage**: proposal↔certificate по hash → bridge-view + gate
  «тот же certificate_hash на dump'е».
- **3.A artifact/product двойственность**: workplace хранит ref+hash, не
  content → архитектурный тест `contentHash=artifacts.content_hash`.
- **Шаг 5 cutover authority**: ломает single-writer set, новая CAS-механика на
  Workplace revision. Feature-flag + длительный `both`.
- **3.C TextSet**: digest покрывает paths/modes/rename/delete (REG-11-AC-05).

## Первый PR (начать сразу)

**Шаг 1.1** — pure-domain ядро: `WorkplaceRef`, `WorkplaceState` (two-channel),
`CandidateSet`, `GateDecision`/`GateRun`/`CheckPlan`/`CheckReceipt`,
`ExecutionReservation` в `src/process-modules/domain/workplace/` +
property-тесты. Нулевой риск, точка опоры. REG-04/05/09/12/14/15/17/18/28.

---

# Статус реализации (status snapshot)

Ветка `feat/v4-workplace-domain`. Реализовано и покрыто тестами:

**ШАГ 1 — done.** Pure-domain ядро `src/process-modules/domain/workplace/`
(9 файлов: workplace-ref/state, candidate-set, gate, execution-reservation,
recovery-issue-target, production-cell-definition/reducer, index).
SQLite-адаптеры `src/infrastructure/workplace/` (5 файлов: workplace /
candidate-set / gate / execution-reservation / product repository, CAS на
revision, immutability triggers). Rebuildable WorkItem projection
`src/infrastructure/projections/work-item-projector.ts`. Ratchets:
`workplace-domain-purity`, `workplace-stores-additive`,
`gate-decision-immutability` — green.

**ШАГ 2 — done.** `ProductionCellDefinition` + `production-cell` FlowNode kind
(REG-04). `ProductionCellCoordinator` (REG-13) runtime component с полным
lifecycle (materialize → admit → launch → seal → gate-accepted/repair/human/
failed → crash/requeue), 13 integration тестов. Authoritative
`ProductRepositoryPort` (REG-08/11/12) с internal canonicalization + fence
enforcement. `WorkerLauncherPort` (REG-21). `ConcurrentLaunchBudget`
(REG-10-AC-05) — единый concurrency budget. Universal desk helper.

**ШАГ 3 — bridges + dual-write done; per-workshop read-switch pending.**
- 3.A.1 artifact-ref bridge (REG-11), 3.A.2 dual-write в `artifact_create`,
  3.A.3 GateDecision adapter (4 closed verdicts, REG-18). 3.A.4 read-switch
  в formalization kernel — НЕ выполнен (в whitelist ratchet, шаг 5.4).
- 3.B.1 proposal-ref bridge, 3.B.2 dual-write. 3.B.3 read-switch — НЕ выполнен.
- 3.C.1 TextSetManifest (REG-11-AC-05), 3.C.2 dual-write. 3.C.4 read-switch
  — НЕ выполнен.
- 3.D `HumanInteractionRun` (REG-22) + `EffectAttempt`/`EffectReceipt`/
  `EffectExecutorPort` (REG-23) — done.

**ШАГ 4 — done (contracts).** `EffectExecutorPort` + delivery effect contracts
с exact digest + idempotency + observe-before-retry (REG-23-AC-03).

**ШАГ 5 — done (conformance + ratchets); cutover read-switch pending.**
- 5.1 conformance harness: E2E-01..06/10 (`workplace-conformance-harness`),
  E2E-07..09/11..13 (`workplace-conformance-e2e-extended`). E2E-14 (real-LM)
  требует реальной модели.
- 5.2 dual-write shadow из production dispatcher (`workplace-projector`,
  feature-flagged `SAGA_WORKPLACE_WRITE=on`) + read comparator при
  `SAGA_WORKPLACE_READ=both`. **Cutover authority (`SAGA_WORKPLACE_READ=new`
  как единственный source) НЕ выполнен** — требует sustained zero-drift и
  per-workshop read-switch (см. шаг 3).
- 5.3 two-channel enforcement — done (закрытые пары в reducer, REG-28).
- 5.4 absence-of-readers ratchet (`tasks-reader-invariant.test.mjs`): 16
  allowed core readers captured как shrinkage whitelist, target = 0.

**ШАГ 6 — partial.** `SCHEMA_VERSION` bumped 1→2 (v4 additive layer обязателен).
`tracker_export/import` format_version 1.4→1.5. Final ratchets:
`no-module-name-switch` (4 allowed, shrinkage), `fifth-workshop-installable`
(E2E-13 green). **Destructive drop legacy таблиц/owner-колонок НЕ выполнен** —
требует завершения cutover (шаг 5.2) и per-workshop read-switch (шаг 3);
runtime сегодня зависит от legacy таблиц. Pre-release disposal policy
позволяет drop, но план требует «после join'ов через workplace».

**Запуск:** `SAGA_WORKPLACE_WRITE=on SAGA_WORKPLACE_READ=both
DB_PATH=./saga4-v4.db npm start` — сервер поднимается, 7 v4_* таблиц + 4
immutability triggers создаются, dual-write активен.

**Остающиеся пробелы (последовательность выполнения):**
1. Per-workshop read-switch (3.A.4 / 3.B.3 / 3.C.4) — каждое уводит читателя
   из whitelist шага 5.4.
2. Cutover `SAGA_WORKPLACE_READ=new` после sustained zero-drift в `both`.
3. Destructive drop legacy (шаг 6 полный) после cutover.
4. E2E-14 real-LM conformance.

