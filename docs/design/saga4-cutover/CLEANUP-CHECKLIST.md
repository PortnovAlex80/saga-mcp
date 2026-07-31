# saga4 Cleanup Checklist

> **Цель:** удалить legacy, не потеряв рабочий функционал.
> **Принцип:** каждый шаг имеет (1) что удаляем, (2) какой функционал затрагивает,
> (3) что проверить после, (4) какой тест защищает.
> **Правило:** если проверка падает — откатываем шаг, не идём дальше.

---

## Базовый уровень (что должно работать ДО и ПОСЛЕ каждого шага)

Перед началом cleanup зафиксируй baseline:

```bash
npx tsc --noEmit                    # должен быть exit 0
node --test tests/lifecycle/engine-control.test.mjs     # engine start/stop/concurrency
node --test tests/lifecycle/concurrency-transition.test.mjs  # concurrency + model
node --test tests/architecture/saga2-boundaries.test.mjs     # shared infra contracts
node --test tests/characterization/saga2-runtime-contracts.test.mjs  # runtime files
node --test tests/process-modules/trace-gap-blocks-development.test.mjs  # traceability routing
node --test tests/app/git-bootstrap.test.mjs            # git init on create-from-idea
node --test tests/app/product-lifecycle-start-receipt.test.mjs  # durable start handshake
node --test tests/process-modules/start-from-idea.test.mjs      # lifecycle input assembler
```

**Baseline (на момент создания чеклиста, saga4 @ 585c5b5):** tsc clean, все перечисленные тесты green.

---

## Шаг 1 — Control-state таблица `lifecycle_execution_controls`

### Что делаем
Создаём новую таблицу для operational control-state, переносим engine/model/concurrency
из `episode_workflows.metadata`.

### Функционал, который затрагиваем
| Функционал | Где сейчас | Куда переносим |
|---|---|---|
| Engine PID / running / started_at | `ew.metadata.engine_running/engine_pid/engine_started_at` | `lifecycle_execution_controls.engine_pid/engine_state/started_at` |
| Concurrency | `ew.metadata.engine_concurrency` | `lifecycle_execution_controls.concurrency` |
| Model route (provider/name/effort) | `ew.metadata.active_model/active_provider/active_model_effort` | `lifecycle_execution_controls.model_provider/model_name/model_effort` |
| Model limit | `ew.metadata.active_model_limit` | `lifecycle_execution_controls.model_concurrency_limit` |

### Что НЕ переносим (legacy, удаляем)
- `ew.stage` / `ew.track` — legacy stage machine
- `ew.baseline_artifact_id` / `ew.baseline_hash` — derivable from accepted AC
- `ew.metadata.needs-human` / `pause_reason` / `paused_at` — lifecycle pause state (LifecycleRun owns)
- `ew.metadata.lastHealError` / `lastHealAttempt` — legacy healer diagnostics
- `ew.metadata.last_gate_error` / `last_gate_from` / `last_gate_to` — stage-gate residue

### Файлы для изменения
- `src/schema.ts` — CREATE TABLE lifecycle_execution_controls
- `src/db.ts` — migrateLifecycleExecutionControls (additive migration)
- `src/infrastructure/engine/legacy-engine-administration.ts` — readPersisted/setMeta → новая таблица
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` — readTargetConcurrency/readWorkerModelRoute → новая таблица
- `src/infrastructure/projections/sqlite-board-projection-reader.ts` — board читает control-state из новой таблицы
- `src/app/composition-root.ts` — wire новой таблицы

### Проверки после
- [ ] tsc clean
- [ ] `tests/lifecycle/engine-control.test.mjs` green (start/stop/status/concurrency)
- [ ] `tests/lifecycle/concurrency-transition.test.mjs` green (concurrency + model writes)
- [ ] `tests/architecture/saga2-boundaries.test.mjs` green (engine admin contracts)
- [ ] `tests/characterization/saga2-runtime-contracts.test.mjs` green (worker infra anchors)
- [ ] Ручная проверка: frontend /api/engine/status возвращает pid/concurrency/model
- [ ] Ручная проверка: POST /api/engine/concurrency меняет concurrency
- [ ] Ручная проверка: POST /api/model/set меняет model route
- [ ] Ручная проверка: worker получает правильную model route

---

## Шаг 2 — Удаление `episode_workflows.stage`/`.track` writes

### Что делаем
После шага 1 control-state уехал в новую таблицу. Теперь удаляем writes в
`episode_workflows.stage`/`.track` — это legacy stage machine.

### Функционал, который затрагиваем
| Функционал | Где | Действие |
|---|---|---|
| Stage projection mirror | `sqlite-saga2-runtime-repositories.ts` INSERT/UPDATE ew | Удалить — board читает lifecycle projections |
| Fast-track INSERT | `planner/fast-track.ts:206` INSERT ew (stage,track) | Удалить — formalization module сам решает XS |
| Fast-track backfill | `db.ts:808` UPDATE ew SET track | Удалить |
| Export ew row | `export-import.ts:408` INSERT ew | Удалить — export сериализует lifecycle runs |
| Import ew backfill | `export-import.ts:500` UPDATE ew baseline | Удалить |
| Pause/clearNeedsHuman | `sqlite-saga2-runtime-repositories.ts:39-69` | Удалить — lifecycle pause owns this |

### Файлы для изменения
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` — убрать pause/clearNeedsHuman/readHealMetadata, INSERT OR IGNORE ew
- `src/planner/fast-track.ts` — убрать ew INSERT
- `src/db.ts` — убрать migrateEpisodeTrack fast-track backfill
- `src/tools/export-import.ts` — убрать ew INSERT/UPDATE
- `src/infrastructure/projections/sqlite-board-projection-reader.ts` — убрать ew.stage JOIN → lifecycle_stage_runs

### Проверки после
- [ ] tsc clean
- [ ] `tests/lifecycle/claim-dependency.test.mjs` green (task claimability)
- [ ] `tests/process-modules/trace-gap-blocks-development.test.mjs` green (traceability routing)
- [ ] `tests/architecture/saga2-boundaries.test.mjs` green
- [ ] Ручная проверка: board отображает stage из lifecycle runs
- [ ] Ручная проверка: export/import round-trip работает без ew
- [ ] Ручная проверка: fast-track эпик проходит formalization без ew INSERT

---

## Шаг 3 — Legacy persistence cleanup

### Что делаем
Чистим 4 класса от stage-based логики, оставляя task/execution persistence.

### Функционал, который затрагиваем
| Класс | Что вырезать | Что оставить |
|---|---|---|
| `SqliteEpisodeRuntimeRepository` | pause/clearNeedsHuman/readHealMetadata/stage-reads | (если ничего не остаётся — удалить класс) |
| `SqliteTaskRuntimeRepository` | createRecoveryTask (legacy recovery) | task CRUD, reevaluateDownstream |
| `SqliteExecutionRuntimeRepository` | — (проверить на stage-логику) | execution runtime |
| `NodeSaga2HostRuntime` | scanRateLimitSignals (dead после pump) | workerPaths, heartbeat, lock |

### Файлы для изменения
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts`
- `src/infrastructure/runtime/node-saga2-host-runtime.ts`
- `src/application/ports/saga2-runtime-persistence.ts` (убрать dead methods из port)

### Проверки после
- [ ] tsc clean
- [ ] `tests/architecture/saga2-boundaries.test.mjs` green (host runtime contracts)
- [ ] `tests/characterization/saga2-runtime-contracts.test.mjs` green (persistence anchors)
- [ ] Ручная проверка: worker spawn получает workerPaths/heartbeat
- [ ] Ручная проверка: engine lock работает (duplicate-run detection)

---

## Шаг 4 — Frontend stage-summary

### Что делаем
`/api/episode/stage-summary` создаёт `summary.stage` task — frontend-owned task generation.
Меняем на module-owned projection.

### Функционал, который затрагиваем
| Функционал | Где | Действие |
|---|---|---|
| Stage summary markdown | `tracker-view.mjs` GET /api/episode/stage-summary | Переписать: читать из module products/certificates |
| summary.stage task spawn | `tracker-view.mjs` handler | Удалить — не frontend job |

### Проверки после
- [ ] tsc clean
- [ ] `node --check tracker-view/tracker-view.mjs`
- [ ] Ручная проверка: stage detail страница отображает summary (из lifecycle projection)
- [ ] Ручная проверка: нет orphan summary.stage tasks в очереди

---

## Шаг 5 — Dead SPI recovery-engine

### Что делаем
`UniversalRecoveryEngine` + `*_RECOVERY_POLICY_BINDINGS` — zero production consumers.
Canonical recovery = `flow.recovery[]`. Удаляем мёртвый SPI.

### Файлы для удаления/изменения
- `src/process-modules/application/recovery-engine.ts` — удалить (@deprecated, zero consumers)
- `src/process-modules/modules/*/package/contributions/recovery-policies.ts` — удалить (4 файла)
- `src/process-modules/modules/*/package/contributions/index.ts` — убрать re-exports
- `tests/process-modules/recovery-engine.test.mjs` — удалить
- `tests/execution/recovery-conformance.test.mjs` — проверить, адаптировать

### Проверки после
- [ ] tsc clean
- [ ] `tests/process-modules/formalization-settlement.test.mjs` green (canonical recovery via flow.recovery[])
- [ ] `tests/process-modules/formalization-e2e-smoke.test.mjs` green
- [ ] Ручная проверка: formalization recovery loop работает (flow.recovery[])

---

## Шаг 6 — Skills tombstone

### Что делаем
9 skills упоминают удалённые инструменты. Deprecation banner недостаточен для слабой модели.
Заменяем содержимое deprecated skills на короткий tombstone.

### Файлы
- `skills/saga-orchestrator/SKILL.md` — tombstone (старый алгоритм → заглушка)
- `skills/saga-orchestrator/delegation-contract.md` — tombstone
- `skills/autonomous-recovery/SKILL.md` — tombstone
- Остальные 6 skills — проверить что "deleted" заметки корректны (не активные инструкции)

### Проверки после
- [ ] `grep -rln "CALL: episode_transition\|CALL: workflow_generate_next" skills/` → 0 hits
- [ ] `grep -rln "call episode_transition\|invoke workflow_generate_next" skills/` → 0 активных инструкций
- [ ] Ручная проверка: saga-patrol/saga-start не пытаются вызвать удалённые инструменты

---

## Шаг 7 — Fast-track concept removal

### Что делаем
`NEXT_FAST_TRACK`, `fast-track.ts`, fast-track backfill — legacy XS-path.
Formalization module должен сам решать complexity, не внешний planner.

### Файлы
- `src/planner/fast-track.ts` — оценить: нужен ли формализации XS-path, или удалить
- `src/validators/brief.ts` — fast-track validation
- `src/schema.ts` / `src/db.ts` — track column (после шага 2 уже не пишется)

### Проверки после
- [ ] tsc clean
- [ ] Formalization module обрабатывает XS epic без fast-track
- [ ] `tests/process-modules/formalization-e2e-smoke.test.mjs` green

---

## Шаг 8 — Phase 6 stable references (full rollout)

### Что делаем
`epic_slug` prerequisite добавлен. Полная миграция durable surrogate IDs.

### Аудит
- `artifactId` в module payloads → content-addressed ref
- `taskId` в snapshots → stable ref
- `epicId` в export/import → epic_slug
- `providerId` → stable ref

### Проверки после
- [ ] Export/import round-trip: IDs remappable
- [ ] Snapshot/restore: работает после reset
- [ ] `tests/process-modules/delivery-lifecycle-resume.test.mjs` green

---

## Финальный acceptance (после всех шагов)

```bash
# 1. Build
npx tsc --noEmit

# 2. Mandatory search (из жёсткого промпта)
grep -rl "episode_workflows" src/ | wc -l    # → 0 (или только historical migration)
grep -rl "tryAdvanceStage" src/              # → 0
grep -rl "RECOVERY_TREE" src/                # → 0
grep -rl "generateNextForCompletedTask" src/ # → 0
grep -rl "episode_transition" src/           # → 0
grep -rl "workflow_generate_next" src/       # → 0
grep -rl "Saga2Engine" src/                  # → 0
grep -rl "engine=v2" src/                    # → 0

# 3. Smoke run
# Создать новый эпик через frontend → Discovery → Formalization → Development
# Проверить: один orchestrator, zero episode_workflows writes

# 4. Full suite
node --test
```

---

## Порядок выполнения

```
Шаг 1 (control-state таблица)
  ↓
Шаг 2 (удаление ew.stage writes)  ← зависит от 1
  ↓
Шаг 3 (legacy persistence cleanup) ← зависит от 2
  ↓ параллельно ↓
Шаг 4 (stage-summary)    Шаг 5 (dead SPI)    Шаг 6 (skills tombstone)
  ↓
Шаг 7 (fast-track)       ← зависит от 2
  ↓
Шаг 8 (stable refs)      ← независимый, можно в любое время
  ↓
Финальный acceptance
```

**Каждый шаг — отдельный коммит.** Если проверка падает — откат, не идём дальше.
