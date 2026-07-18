# Refactor: Passive Worker Kernel — Master Plan & Checklist

**Status:** Active. Slice 0 in progress.
**Branch:** `refactor/passive-worker-kernel` (от `master` @ `e816422`, ADR-012 multi-track).
**Created:** 2026-07-18.
**Source of truth:**
- ADR-010 — Passive worker command kernel (Proposed).
- ADR-011 — Work items and functional process managers (Proposed; refines ADR-010).
- `docs/architecture/passive-worker-kernel-blueprint.md` (1222 строки) — §16 (slices), §17 (work packages), §18 (test matrix), §22 (brief первому агенту).
- ADR-009 — Worker execution fencing (Accepted).

**Главный принцип:** один slice = один (или несколько тесно связанных) коммитов = независимо-релизуемая единица. Никаких big-bang. После каждого slice — вся suite зелёная (в пределах зафиксированного baseline).

---

## Базовые правила (не нарушать)

1. **Single writer.** Любая lifecycle-правка `tasks.status` / `tasks.assigned_to` / `tasks.current_execution_id` / `worker_executions.state` идёт через command bus (после Slice 1) или через projector (после Slice 2). Прямой `UPDATE` вне projector/migrations — запрещён архитектурным тестом (Slice 7).
2. **Functional core / imperative shell.** Reducers — pure TS, без imports из SQLite/Node/tools (guardrail WP-1, blueprint §17 line 960-963). Эффекты (spawn, Git, MCP-ответы) — только в shell.
3. **Idempotency.** Каждая command имеет `command_id`; повтор с тем же ID + той же payload → тот же ответ, без побочных эффектов. Повтор с тем же ID + другой payload → reject.
4. **Atomicity.** Принятие command + snapshot-write + event + outbox-insert — одна `BEGIN IMMEDIATE` транзакция. Внешние эффекты (spawn/Git) — ВНЕ транзакции, рапортуют через отдельную command.
5. **No resurrection.** Принятая терминальная command (review approved, merge observed) не откатывается процессным событием. Падение процесса убивает только attempt, не semantic item.
6. **Названия заморожены.** Command/event/effect-имена — в `docs/architecture/lifecycle-command-event-vocabulary.md` (создаётся в Slice 0.6). Slice 1+ их НЕ меняют.

---

## Baseline (зафиксирован перед стартом)

- **Тестов:** 174. **Pass:** 173. **Fail:** 1.
- **Pre-existing fail:** `tests/track-pipeline.test.mjs:207` — `track(clarify): engine pauses with needs-human`. Racy по дизайну (`Promise.race` 10s против движка с 10s poll). Не чиним — не в scope рефакторинга.
- **Acceptance для каждого slice:** после slice — 173 pass / 1 fail (тот же). Новых провалов нет. Если мой slice добавляет pass-тесты — pass-счёт растёт, fail-счёт остаётся 1.

---

## Pre-flight checklist

- [x] `npm test` baseline выполнен (174/173/1).
- [x] Zombie worktrees удалены: `saga-mcp-wt-gate`, `-langfix`, `-release`.
- [x] Слитые ветки удалены: `feat/complexity-gate`, `feat/release-skill`, `fix/language-cleanup`.
- [x] Ветка `refactor/passive-worker-kernel` создана от `master` @ `e816422`.
- [x] Working tree чистый на старте.
- [x] Файл-план создан (этот документ).

**Примечание:** остальные слитые feature/req/task ветки (`dev`, `req-008`…`req-013`, `task/215`…`task/225`) оставлены — вне scope cleanup. Чистить отдельно, с явным разрешением.

**Примечание:** `D:/Development/saga-mcp-wt-migration` — НЕ git worktree (нет `.git`), это snapshot пакета. Не трогать.

---

## Slice 0 — Characterization and invariant oracle

**Источник:** blueprint §16 (line 815), §17 WP-1 (line 945), §22 (line 1184).
**Цель:** заморозить текущую модель в виде pure-TS oracle + read-only scanner, без правок production-кода. Всё, что Slice 1+ будет переписывать, должно быть сначала описано и протестировано здесь.

### 0.1 Pure domain oracle — `src/lifecycle/domain/`

- [ ] `src/lifecycle/domain/state.ts` — `TaskState` discriminated union (typestate). Покрыть все composite-состояния: `UnclaimedTodo`, `ClaimedImplementation`, `ActiveReview`, `ReviewVerdictPending`, `ApprovedPendingIntegration`, `Integrated`, `ConflictedIntegration`, `ParkedForHuman`, `Blocked`, `TerminalDone`. Impossible combinations — не представлены в union.
- [ ] `src/lifecycle/domain/commands.ts` — `Command` discriminated union. Имена из §11 transition table: `ReserveWorkItem`, `ReportImplementationCompleted`, `SubmitReviewVerdict(approved|changes_requested, git|non_git)`, `ObserveProcessExited`, `ObserveProcessLost`, `ReserveIntegrationAttempt`, `ObserveIntegrationMerged`, `ObserveIntegrationConflict`, `ParkForHuman`, `RecordHumanAnswer`, `ReconcileDependencies(blocked|unblocked)`, `RegisterWorkerProcess`.
- [ ] `src/lifecycle/domain/events.ts` — `Event` discriminated union (работа reducer'а).
- [ ] `src/lifecycle/domain/effects.ts` — `Effect` discriminated union (spawn, kill, git-merge, notify) — без выполнения, только описание.
- [ ] `src/lifecycle/domain/decode.ts` — `decodeTaskState(row: TaskRow): TaskState`. Pure. Принимает плоский объект (status, integration_state, current_execution_id, assigned_to, tags) → typestate. Impossible combos → `DecodingViolation` (имя заморожено).
- [ ] `src/lifecycle/domain/evolve.ts` — `evolve(state, command): { events: Event[]; effects: Effect[]; newState: TaskState } | { error: FrozenErrorName }`. Pure reducer. Все 19 переходов из §11.
- [ ] `src/lifecycle/domain/invariants.ts` — predicates, которые истинны после любого allowed-перехода (см. §18 Pure domain: «events.reduce(evolve) всегда удовлетворяет invariants»).
- [ ] `src/lifecycle/domain/index.ts` — реэкспорт.

**Forbidden (architectural, enforced test'ом в Slice 7):** импорты из `better-sqlite3`, `node:*`, `../tools`, `../db`, `../../tracker-view`. Pure TS only.

### 0.2 Invariant scanner — `src/lifecycle/invariant-scanner.ts`

- [ ] `classifyTask(row): { kind: 'valid_managed' | 'valid_legacy' | 'named_violation'; violation?: NamedViolation }`. Read-only.
- [ ] Замороженные имена `NamedViolation`:
  - `fenced_task_without_active_execution` — `current_execution_id` set, но строки в `worker_executions` нет или не active.
  - `done_pending_without_integration_intent` — `status='done' AND integration_state='pending'` без worktree-meta или executor-state.
  - `assigned_without_active_execution` — `assigned_to` не null, `current_execution_id` null, в legacy-таблице нет живого PID.
  - `needs_human_with_live_assignment` — тег `needs-human` + `assigned_to` не null (должно быть park → release).
  - `integration_state_inconsistent_with_status` — напр. `status='todo' AND integration_state='merged'`.
- [ ] `scanDatabase(db): ClassificationReport`. Read-only. SQL только `SELECT`.

### 0.3 Failure fixtures — `tests/lifecycle/fixtures/`

JSON-снимки плоских task-rows (не SQLite-дампы — pure data, чтобы oracle/scanner тестировались без БД):

- [ ] `post-approval-pending.json` — status=done, integration_state=pending, assigned_to=null, current_execution_id=lost. **Критический seam** (тот, что аудит вскрывал).
- [ ] `lost-mid-merge.json` — execution integrating, pid dead, integration_state=pending.
- [ ] `zombie-in-progress.json` — status=in_progress, assigned_to=dead_worker, execution=running но pid не отвечает.
- [ ] `legacy-unfenced.json` — status=in_progress, current_execution_id=null (pre-ADR-009).
- [ ] `needs-human-assigned.json` — tag needs-human + assigned_to=set (dead-assignment trap).
- [ ] `blocked-with-dependency.json`.
- [ ] `terminal-merged.json` — status=done, integration_state=merged.
- [ ] `terminal-conflict.json` — status=done, integration_state=conflict.
- [ ] `clean-todo.json`, `clean-in-progress.json`, `clean-review.json`, `clean-review-in-progress.json` — валидные managed.

### 0.4 Characterization tests — `tests/lifecycle/oracle.test.mjs`

- [ ] `decodeTaskState` — для каждой fixture: возвращает ожидаемый typestate (или `DecodingViolation` для impossible).
- [ ] `evolve` — для каждой команды из §11: входной state + команда → ожидаемый events/effects/newState. Покрытие **19 transition rows** из §11.
- [ ] Каждое «соседнее» некорректное composite-state → reject (§18: «neighboring invalid composite state is rejected»).
- [ ] Determinism: одинаковый вход → одинаковый выход, повтор 100 раз.
- [ ] Immutability: входной state не мутируется.
- [ ] Property: `events.reduce(evolve)` сохраняет invariants.

### 0.5 Scanner tests — `tests/lifecycle/invariant-scanner.test.mjs`

- [ ] Для каждой fixture: классификация совпадает с ожидаемой (`valid_managed` / `valid_legacy` / конкретный `NamedViolation`).
- [ ] `post-approval-pending.json` → `done_pending_without_integration_intent`.
- [ ] `needs-human-assigned.json` → `needs_human_with_live_assignment`.
- [ ] `clean-*.json` → `valid_managed` (или `valid_legacy` для legacy fixture).

### 0.6 Vocabulary freeze — `docs/architecture/lifecycle-command-event-vocabulary.md`

- [ ] Полный список command names (со stabilizing ID).
- [ ] Полный список event names.
- [ ] Полный список effect kinds.
- [ ] Полный список named errors / violation names.
- [ ] Замечание: « Slice 1+ не меняют эти имена без ADR-update».

### Slice 0 — коммиты

- `refactor(slice-0): pure lifecycle domain oracle`
- `refactor(slice-0): read-only invariant scanner`
- `refactor(slice-0): characterization fixtures + tests`
- `refactor(slice-0): freeze command/event vocabulary`

### Slice 0 — Acceptance

- [ ] Production-код не изменён: `git diff master -- src/ | wc -l` = 0 в существующих файлах `src/`; только **новые** файлы в `src/lifecycle/domain/`, `src/lifecycle/invariant-scanner.ts`.
- [ ] `npm test`: 173 pass + N новых pass / 1 fail (тот же pre-existing).
- [ ] Каждая fixture классифицирована.
- [ ] Каждый transition из §11 покрыт characterization-тестом.
- [ ] Architecture-test заглушка: pure-domain модули не импортируют SQLite/Node/tools (полная версия — в Slice 7).

### Slice 0 — Rollback

Удалить ветку или `git reset --hard master`. Никаких миграций БД, никаких изменений production-кода — rollback тривиален.

---

## Slice 1 — Terminal execution kernel

**Источник:** blueprint §16 (line 829), §17 WP-2+WP-3, §22 brief (line 1193-1199).
**Цель:** заменить дублированное recovery-поведение в `worker-executions.ts` и `orchestrate.ts` одним command-bus путём. Terminalization + task release в ОДНОЙ `BEGIN IMMEDIATE` транзакции.

### Задачи

- [ ] **WP-2 partial:** schema migration для `command_receipts` и `lifecycle_events` (additive — только новые таблицы, без изменения существующих).
- [ ] `src/lifecycle/command-bus.ts` — `submit(db, command): Receipt`. `BEGIN IMMEDIATE`. На Slice 1 обрабатывает только 5 команд: spawn-failed, stop-requested, process-exited, process-lost/terminated, task-release.
- [ ] `src/lifecycle/ports/store.ts` + `src/lifecycle/infrastructure/sqlite/store.ts` — narrow storage port + SQLite adapter.
- [ ] Рефактор `markExecutionExited` (worker-executions.ts:108-137) — delegate to command bus, терминализация + release в одной транзакции.
- [ ] Рефактор `releaseOwnedTask` (worker-executions.ts:220-236) — теперь часть reducer'а.
- [ ] Рефактор `reconcileWorkerExecutions` (worker-executions.ts:246-398) — вызывает те же команды, а не собственный SQL.
- [ ] Рефактор `recoverAssignment` в `src/orchestrate.ts:905-929` — заменить на вызов command bus.
- [ ] Рефактор `recoverRunnerAssignment` в `tracker-view/tracker-view.mjs` (если есть дубликат — убрать).
- [ ] Рефактор `claude-runner.mjs` FAILED-path (line 425-445) — единый atomic вызов вместо двух.

### Slice 1 — Тесты (из §22 required tests + §18 Process races)

- [ ] Pure allowed/rejected transition table (унаследован из Slice 0, обновить).
- [ ] Same command_id replay → byte-equivalent response.
- [ ] Same command_id + different payload → rejected.
- [ ] Transaction fault rollback (fault-injection — эмулировать throw между UPDATE'ами).
- [ ] Close vs reconciler race (две одновременные terminalization — одна выиграла, вторая no-op).
- [ ] Process loss after reassignment (старая execution не терминирует задачу, присвоенную новой).
- [ ] Terminal execution cannot remain a task fence (после terminalization `current_execution_id` гарантированно null).
- [ ] Existing suite остаётся зелёной.

### Slice 1 — Acceptance

- [ ] Execution terminalization и task release в одной транзакции.
- [ ] Close/reconciler races idempotent.
- [ ] No terminal execution remains as a task fence.
- [ ] Дубликат recovery SQL убран (один путь в engine, один в tracker-view → один общий).
- [ ] Точный список lifecycle-SQL writers (deliverable из §22 line 1219).

### Slice 1 — Rollback

Миграция additive (новые таблицы), rollback = DROP новых таблиц + revert code. Существующие данные не тронуты.

---

## Slice 2 — Work-item shadow model

**Источник:** blueprint §16 (line 847), §17 WP-4 (line 993).
**Цель:** 3 новые таблицы (`task_work_items`, `work_attempts` + существующая `worker_executions`) + compatibility projector. Old task columns остаются authoritative в этом slice; new таблицы — shadow.

### Задачи

- [ ] Migration: `task_work_items`, `work_attempts` (additive).
- [ ] `src/lifecycle/work-item-repository.ts`.
- [ ] `src/lifecycle/compatibility-projector.ts` — пересчитывает `tasks.status`/`integration_state` из work-items.
- [ ] Honest synthetic backfill (из §16 line 851-859): todo→ready impl, in_progress→active impl+legacy attempt, review→completed impl+ready review, и т.д.
- [ ] Dual-write: projector обновляет legacy columns + work-items синхронно.
- [ ] `history_complete=false` для ambiguous imports.
- [ ] Equivalence report: recomputed projection vs legacy rows → named mismatch если расходятся.

### Тесты

- [ ] Каждый managed-task имеет ровно один current semantic item.
- [ ] Recomputed projection совпадает с legacy или сообщает named mismatch.
- [ ] **Review approval survives loss of integration attempt** (ключевой тест из аудита — упадёт attempt, не review).
- [ ] Backfill не фабрикует prior cycle history.

### Rollback

Новые таблицы не authoritative — DROP + revert projector. Legacy columns не изменены.

---

## Slice 3 — Passive human wait (ASK terminal) + admin boundary

**Источник:** blueprint §16 (line 871), §17 WP-5 (line 1008), §12.3 (line 565-578).

### Задачи

- [ ] Сделать ASK terminal: persist question, release process, exclude from dispatch, spawn fresh worker on answer.
- [ ] Migration: `human_requests` (additive).
- [ ] Excluir open human_requests из claimability query.
- [ ] **Убрать lifecycle-правки из `task_batch_update`** (activity.ts:171-182) — critical defect из аудита.
- [ ] Audited admin transition (для human-forced status changes — единый путь).
- [ ] Обновить `skills/saga-worker/SKILL.md` ASK-секцию (lines 428-444) — терминальный паттерн.

### Тесты

- [ ] Waiting task has no live process or assignment.
- [ ] Answering creates no resurrection of old execution.
- [ ] Fresh worker receives persisted question/answer context.
- [ ] `task_batch_update` НЕ может менять status/assigned_to ( архитектурный тест ).

### Rollback

Revert skill + handler. `human_requests` additive.

---

## Slice 4 — Worker outcomes

**Источник:** blueprint §16 (line 885), §17 WP-6 (line 1023).

### Задачи

- [ ] Move `worker_done`-обработку в command bus: implementation-complete, review-changes-requested, non-git approval, verification-gated approval.
- [ ] Idempotency receipts для worker outcomes.
- [ ] `changes_requested` всегда создаёт fresh developer execution (НЕ возвращает ревьюеру — фикс расхождения SKILL/runtime из аудита).
- [ ] Update SKILL.md verdict table (line 366-369) — соответствует runtime.

### Тесты

- [ ] Duplicate semantic report → same stored response.
- [ ] Result comments/activity не дублируются.
- [ ] `changes_requested` → fresh dev execution (не тот же reviewer).

### Rollback

Revert dispatcher + bus-routes. Existing `worker_done` path остаётся как fallback.

---

## Slice 5 — Integration intent and deterministic Git executor

**Источник:** blueprint §16 (line 900), §17 WP-7 (line 1037), §13 (line 580-678).

### Задачи

- [ ] Approval writes frozen reviewed SHA + integration intent.
- [ ] `src/lifecycle/integration-executor.ts` — deterministic Git executor.
- [ ] Ancestry/trailer observation перед retry (НЕ слепой merge).
- [ ] Target `update-ref` CAS против `expected_target_sha`.
- [ ] Remove same-process merge из worker prompt (reviewer выходит сразу после approval).
- [ ] Crash reconciliation по 4 окнам (§13 line 669-676).
- [ ] `worker_merge_release` reject без prior acquire (фикс аудита).
- [ ] Merge-lock: liveness-check перед stale-reclaim (фикс аудита).

### Тесты (§18 Git)

- [ ] Already-ancestor → idempotent success.
- [ ] Source branch advanced after review.
- [ ] Target advanced before CAS.
- [ ] Crash before/after merge commit.
- [ ] Crash after `update-ref` before DB report.
- [ ] Deterministic conflict manifest.
- [ ] Two integrations в одном repo serialize.
- [ ] Integrations в разных repos — concurrent.
- [ ] Cleanup retries не реверсят completion.

### Rollback

Revert executor + intent-table. Worker возвращается к same-process merge (старый путь).

---

## Slice 6 — Claim and dependency writers

**Источник:** blueprint §16 (line 914).

### Задачи

- [ ] Move `worker_next` claim logic в command bus.
- [ ] Shared claimability query между engine counts и actual claim (фикс аудита: count и claim predicate идентичны).
- [ ] Move dependency block/unblock через commands.
- [ ] Dependency reconciliation НЕ терминирует active fenced execution (фикс аудита).

### Тесты

- [ ] Active task не переводится напрямую в blocked.
- [ ] Concurrent claims → ровно одна reservation.
- [ ] Count и claim predicates идентичны.

### Rollback

Revert claim-handler + dep-reconciler.

---

## Slice 7 — Work-item cutover and single-writer enforcement

**Источник:** blueprint §16 (line 926), §17 WP-8 (line 1053).

### Задачи

- [ ] Work items/attempts — authoritative для managed lifecycle.
- [ ] Route UI, admin, import/recovery, оставшиеся adapters через commands.
- [ ] **Architecture test** (§18 line 1117-1124):
  - no direct lifecycle `UPDATE tasks` outside projector/migrations;
  - no direct `UPDATE worker_executions` outside projector/migrations;
  - domain imports no infrastructure;
  - all unions use exhaustive `assertNever`;
  - engine count uses same claimability query as claim;
  - managed worker prompt contains no queue/merge ownership commands.
- [ ] Delete obsolete recovery и merge-healer paths.
- [ ] Update skills + MCP descriptions.
- [ ] Mark all compatibility adapters с removal-release.

### Тесты

- [ ] Production lifecycle columns имеют ровно одного writer.
- [ ] Task board state — deterministic projection из canonical items/attempts.
- [ ] No LLM healer required to infer process/Git truth.

### Rollback

Возврат к dual-write (Slice 2). Work-items остаются, но перестают быть authoritative.

---

## Final — Merge в master

- [ ] All 8 slices зелёные.
- [ ] `npm test` и `npm run test:e2e` проходят.
- [ ] Architecture test блокирует регрессии.
- [ ] SKILL.md и MCP-описания обновлены.
- [ ] CHANGELOG.md обновлён (раздел Unreleased).
- [ ] ADR-010 и ADR-011 переведены из Proposed → Accepted (с датой и commit-ref).
- [ ] Merge `refactor/passive-worker-kernel` → `master` (--no-ff, ревью-сообщение со ссылкой на этот checklist).
- [ ] `master` → `origin/master` (после ревью).

---

## Definition of Done (всего рефакторинга)

1. Дефекты из аудита (часть 1) закрыты:
   - `task_batch_update` bypass — Slice 3.
   - ASK incompatibility — Slice 3.
   - Review rollback after merge crash — Slice 2 (shadow) + Slice 5 (executor).
   - Merge-lock staleness — Slice 5.
   - Dependency reconcile kills fenced task — Slice 6.
   - Split transaction terminal/release — Slice 1.
   - Non-idempotent commands — Slice 1 (receipts) + Slice 4.
   - SKILL/runtime drift — Slice 3 (ASK) + Slice 4 (verdict).
2. Архитектура соответствует blueprint: command kernel как механизм, work-items как модель.
3. Architecture test защищает от регрессии всех 6 audit-дефектов.
4. Полный e2e failure-suite (claim → implement → review → merge → crash → recovery) зелёный.
5. CHANGELOG + ADR'ы Accepted.

---

## Cross-references

- ADR-009: `docs/architecture/decisions/009-worker-execution-fencing.md`
- ADR-010: `docs/architecture/decisions/010-passive-worker-command-kernel.md`
- ADR-011: `docs/architecture/decisions/011-work-items-and-functional-process-managers.md`
- Blueprint: `docs/architecture/passive-worker-kernel-blueprint.md`
- Audit (часть 1, верифицирована): см. commit `f11f1d1` (ADR-010) и `9b1bc1d` (blueprint + ADR-011).
- GUARDRAILS: `GUARDRAILS.md` signs 010/011.

---

## Журнал прогресса

- **2026-07-18:** Pre-flight завершён. Baseline зафиксирован (174/173/1). Cleanup зомби-worktrees выполнен. Ветка `refactor/passive-worker-kernel` создана от master @ `e816422`. Файл-план создан. Приступаю к Slice 0.
