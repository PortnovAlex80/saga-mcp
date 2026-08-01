# Cutover Live Checklist — coordinator tracking

> Этот файл — рабочий чек-лист координатора. Агенты делают работу,
> координатор сверяет каждый пункт. Не коммитить изменения пока пункт не ✅.

## Baseline (ДО начала)
- [ ] `npx tsc --noEmit` exit 0
- [ ] `grep -rln "episode_workflows" src/` = 14 файлов (baseline)
- [ ] `node tools/run-process-module-tests.mjs all` — 616 pass / 1 fail (external-seo pre-existing)

---

## Блок D — Dead code cleanup (независимый, low risk)
Агент: background

### D.2 — readTaskReviewFeedback (0 callers)
- [ ] `src/process-modules/application/node-executors/lm-node-executor.ts:181` — поле удалено из port
- [ ] `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts:473` — метод удалён
- [ ] `grep -rn "readTaskReviewFeedback" src/` = 0
- [ ] tsc clean

### D.3 — agent-assistance-renderer.ts (779 строк, 0 production importers)
- [ ] `src/process-modules/application/agent-assistance-renderer.ts` — файл удалён
- [ ] `tests/process-modules/agent-assistance-renderer.test.mjs` — удалён
- [ ] `tests/execution/hardening-weak-model.test.mjs` — адаптирован (asserts по renderer убраны, остальное сохранено)
- [ ] `tests/execution/workspace-tracker-hook-tests.test.mjs` — адаптирован
- [ ] `grep -rln "agent-assistance-renderer" src/` = 0
- [ ] tsc clean

### D.4 — scanRateLimitSignals (dead after pump removal)
- [ ] `src/application/ports/saga2-host-runtime.ts:38` — метод удалён из port
- [ ] `src/infrastructure/runtime/node-saga2-host-runtime.ts:144` — реализация удалена
- [ ] `tests/architecture/saga2-boundaries.test.mjs` — адаптирован
- [ ] `grep -rln "scanRateLimitSignals" src/` = 0
- [ ] tsc clean

### D — финальная проверка
- [ ] `grep -rln "readTaskReviewFeedback\|agent-assistance-renderer\|scanRateLimitSignals" src/` = 0
- [ ] Все baseline-тесты green

---

## Блок A.1+A.2 — lifecycle_execution_controls table (additive, safe)
Агент: background

### A.1 — CREATE TABLE в schema.ts
- [ ] `src/schema.ts` — DDL добавлен в конце SCHEMA_SQL (рядом с saga3_lifecycle_runs)
- [ ] DDL точно: `lifecycle_execution_controls` с колонками epic_id (PK), engine_state, engine_pid, concurrency, started_at, stopped_at, concurrency_changed_at, model_provider, model_name, model_effort, model_concurrency_limit, updated_at
- [ ] `CREATE INDEX idx_lifecycle_execution_controls_state`
- [ ] tsc clean

### A.2 — Миграция в db.ts
- [ ] `src/db.ts:57` — вызов `migrateLifecycleExecutionControls(db)` добавлен
- [ ] Функция определена после `migrateEpicSlug`
- [ ] Логика: `INSERT OR IGNORE INTO lifecycle_execution_controls ... SELECT ... FROM episode_workflows` (backfill engine_* + active_model_*)
- [ ] Идемпотентная (INSERT OR IGNORE)
- [ ] tsc clean
- [ ] Ручная: `node -e "require('./dist/db.js'); console.log('OK')"` — таблица создаётся

---

## Блок A.3 — Repoint engine-administration reads (HIGH RISK)
Gated на A.1+A.2. Делать только после проверки чек-листа выше.

- [ ] `legacy-engine-administration.ts` readPersisted — читает из lifecycle_execution_controls
- [ ] setMeta (start) — пишет в lifecycle_execution_controls
- [ ] setMeta (stop) — пишет в lifecycle_execution_controls
- [ ] setConcurrency — пишет в lifecycle_execution_controls
- [ ] status (running=!alive) — пишет в lifecycle_execution_controls
- [ ] `tests/lifecycle/engine-control.test.mjs` green
- [ ] `tests/lifecycle/concurrency-transition.test.mjs` green

---

## Блок A.4 — Repoint model route reads (3 сайта)
Gated на A.1+A.2.

- [ ] `dispatcher.ts:215-219` — SQL читает из lifecycle_execution_controls
- [ ] `sqlite-saga2-runtime-repositories.ts:128-131` — SQL читает из lifecycle_execution_controls
- [ ] `legacy-claude-worker-executor-factory.ts:124-128` — SQL читает из lifecycle_execution_controls
- [ ] readTargetConcurrency repointed
- [ ] tsc clean

---

## Блок B — Удалить episode_workflows writers
Gated на A.3+A.4.

- [ ] 8 writers удалены (см. EXECUTION-PLAN.md B.1)
- [ ] `grep -rln "INSERT INTO episode_workflows\|UPDATE episode_workflows" src/` = 0
