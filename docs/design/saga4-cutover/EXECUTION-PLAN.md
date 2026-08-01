# saga4 Cutover — Unified Execution Plan

> **Цель:** единый execution-ready план, сводящий `CLEANUP-CHECKLIST.md` (блоки A/B/C/D)
> с вердиктом 6 архитекторов из `docs/research/CUTOVER-VERIFY.md` (коммит `a83f20a`).
>
> **Принцип:** НЕ изобретать заново. Каждое имя берётся из кодовой базы или из
> существующего плана в этой папке. Каждый шаг имеет concrete `file:line` target.
>
> **Канон:** `ProductLifecycle` (НЕ `ProductFactory`). `createProductLifecycleRuntime`
> уже существует в `src/app/product-lifecycle-runtime.ts:298` и есть в phase-1..9.
>
> **Что НЕ в этом плане:** переименование `saga3_*` таблиц (косметика, 850 путей,
> отдельно); assistance hooks (P0, отдельный epic). См. §7.

---

## 0. Сводка блоков и порядок выполнения

| Блок | Что | Объём | Risk | Блокирует | Параллельно с |
|---|---|---|---|---|---|
| **A** | `lifecycle_execution_controls` table + repoint reads | ~400 строк | **high** (control plane live) | B, C, D | — (стартовый) |
| **B** | Удалить 8 `episode_workflows` writers | ~150 строк | medium (lossy export/import) | gated на A | — |
| **C** | Cosmetic renames (5 символов) | ~600 строк правок, dozens файлов | low (механический) | gated на A (читают control table) | можно после B |
| **D** | Dead code cleanup (3 цели) | ~900 строк удалений | low (zero callers) | независим | **в любое время** |

### Граф зависимостей

```
            ┌─── Блок D (dead code) ─── независим, можно стартовать сразу
            │
Старт ──► Блок A (control-state table)
            │
            ├─► Блок B (kill ew writers) ── gated на A
            │       │
            │       └─► Блок C (renames) ── gated на A; желательно после B
            │
            └─► (acceptance: grep episode_workflows → 0; smoke run lifecycle)
```

**Каждый блок — отдельный feature branch / PR.** Внутри блока — атомарные коммиты
по шагам. Если baseline-тест падает — откат шага, не идём дальше (правило из
`CLEANUP-CHECKLIST.md`).

---

## 1. Baseline (фиксируем ДО начала)

```bash
npx tsc --noEmit                                                  # exit 0
node --test tests/lifecycle/engine-control.test.mjs               # engine start/stop/concurrency
node --test tests/lifecycle/concurrency-transition.test.mjs       # concurrency + model
node --test tests/architecture/saga2-boundaries.test.mjs          # shared infra contracts
node --test tests/characterization/saga2-runtime-contracts.test.mjs
node --test tests/process-modules/trace-gap-blocks-development.test.mjs
node --test tests/app/git-bootstrap.test.mjs
node --test tests/app/product-lifecycle-start-receipt.test.mjs
node --test tests/process-modules/start-from-idea.test.mjs
```

Сохранить вывод `grep -rln "episode_workflows" src/ | wc -l` (baseline = 14 файлов).

---

## БЛОК A — `lifecycle_execution_controls` table (КЛЮЧЕВОЙ)

> Источник: `CLEANUP-CHECKLIST.md` Step 1 + `CUTOVER-VERIFY.md` Блок A.
> Это единственный pure-new-work блок. После него `episode_workflows.metadata`
> перестаёт быть operational authority.

### A.1 — CREATE TABLE в schema

**Файл:** `src/schema.ts`
**Точка вставки:** после `episode_workflows` блока, перед `tasks` (после строки **105**),
либо в конце `SCHEMA_SQL` перед закрывающим `` ` `` на строке **999** (рядом с
`saga3_lifecycle_runs`, т.к. обе таблицы — saga4 runtime). Рекомендация: **в конце**,
рядом с lifecycle runs.

**DDL (канон из CLEANUP Step 1):**

```sql
CREATE TABLE IF NOT EXISTS lifecycle_execution_controls (
  epic_id              INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
  engine_state         TEXT NOT NULL DEFAULT 'stopped'
                         CHECK (engine_state IN ('running','stopped','unknown')),
  engine_pid           INTEGER,
  concurrency          INTEGER,
  started_at           TEXT,
  stopped_at           TEXT,
  concurrency_changed_at TEXT,
  -- model route (fold-into-control-table approach — см. §8 решение)
  model_provider       TEXT,
  model_name           TEXT,
  model_effort         TEXT,
  model_concurrency_limit INTEGER,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_execution_controls_state
  ON lifecycle_execution_controls(engine_state);
```

### A.2 — Миграция в db.ts (additive, idempotent)

**Файл:** `src/db.ts`
**Точка вызова:** строка **57** (после `migrateEpicSlug(db);`) — добавить
`migrateLifecycleExecutionControls(db);`
**Точка определения:** после `migrateEpicSlug` (после строки **839**).

**Логика миграции** (one-shot copy из `episode_workflows.metadata` → новая таблица):

```ts
export function migrateLifecycleExecutionControls(db: Database.Database): void {
  // CREATE TABLE — no-op если уже есть (SCHEMA_SQL тоже её создаёт).
  // Backfill: для каждой строки episode_workflows вытащить engine_* и active_model_*
  // из metadata и INSERT OR IGNORE в lifecycle_execution_controls.
  db.exec(`
    INSERT OR IGNORE INTO lifecycle_execution_controls
      (epic_id, engine_state, engine_pid, concurrency, started_at,
       model_provider, model_name, model_effort, model_concurrency_limit)
    SELECT ew.epic_id,
      CASE WHEN json_extract(ew.metadata,'$.engine_running')=1 THEN 'running' ELSE 'stopped' END,
      json_extract(ew.metadata,'$.engine_pid'),
      json_extract(ew.metadata,'$.engine_concurrency'),
      json_extract(ew.metadata,'$.engine_started_at'),
      json_extract(ew.metadata,'$.active_provider'),
      json_extract(ew.metadata,'$.active_model'),
      json_extract(ew.metadata,'$.active_model_effort'),
      json_extract(ew.metadata,'$.active_model_limit')
    FROM episode_workflows ew;
  `);
}
```

### A.3 — Repoint reads: `legacy-engine-administration.ts`

**Файл:** `src/infrastructure/engine/legacy-engine-administration.ts`

| Метод | Строки | Сейчас (ew.metadata) | Станет (lifecycle_execution_controls) |
|---|---|---|---|
| `readPersisted` | **218-239** | `SELECT json_extract(metadata,'$.engine_running')... FROM episode_workflows` | `SELECT engine_state, engine_pid, concurrency, started_at FROM lifecycle_execution_controls` |
| `setMeta` (start) | **110-115** | `setMeta({ engine_running, engine_pid, ... })` | `INSERT … ON CONFLICT(epic_id) DO UPDATE SET engine_state='running', engine_pid=?, concurrency=?, started_at=?` |
| `setMeta` (stop) | **136-139** | `setMeta({ engine_running:0, engine_stopped_at })` | `UPDATE … SET engine_state='stopped', stopped_at=?` |
| `setConcurrency` | **164-167** | `setMeta({ engine_concurrency, engine_concurrency_changed_at })` | `UPDATE … SET concurrency=?, concurrency_changed_at=?` |
| `status` (running=!alive) | **185** | `setMeta({ engine_running:0 })` | `UPDATE … SET engine_state='stopped'` |

**Проверки после A.3:**
- [ ] `tests/lifecycle/engine-control.test.mjs` green
- [ ] `tests/lifecycle/concurrency-transition.test.mjs` green
- [ ] Ручная: `GET /api/engine/status` возвращает pid/concurrency/model
- [ ] Ручная: `POST /api/engine/concurrency` меняет concurrency в новой таблице

### A.4 — Repoint model route reads (3 сайта)

Три идентичных `json_extract` SQL по `active_model`/`active_provider`/`active_model_effort`.
Все три заменить на чтение из `lifecycle_execution_controls.model_*`.

| Сайт | Файл:строка | Контекст |
|---|---|---|
| **dispatcher claim-time** | `src/tools/dispatcher.ts:215-219` | `readModelRouteAtClaim` — внутри IMMEDIATE-транзакции claim |
| **runtime repo** | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:128-131` | `readWorkerModelRoute(epicId)` |
| **worker factory** | `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:124-128` | тот же SQL, fallback path |

**Новый SQL (везде одинаковый):**
```sql
SELECT model_name AS m, model_provider AS p, model_effort AS e
  FROM lifecycle_execution_controls WHERE epic_id=?
```

Также `readTargetConcurrency` (`sqlite-saga2-runtime-repositories.ts:108-123`)
читает `engine_concurrency` и `active_model_limit` из `ew.metadata` — repoint на
`lifecycle_execution_controls.concurrency` / `.model_concurrency_limit`.

**Проверки после A.4:**
- [ ] `tests/lifecycle/concurrency-transition.test.mjs` green (model writes)
- [ ] Ручная: `POST /api/model/set` меняет `model_name` в новой таблице
- [ ] Ручная: worker spawn получает правильную model route
- [ ] Smoke: один lifecycle run проходит start→formalization

### A.5 — Composition root: wiring новой таблицы

**Файл:** `src/app/composition-root.ts`
В `createSaga2Application` (строки **100-145**) — таблица создаётся схемой
автоматически, отдельного repo-класса не требуется (доступ через `getDb()` как
сейчас в `LegacyEngineAdministration`). Если ввести `LifecycleExecutionControlsRepository`
(рекомендуется для A.4 — единая точка SQL), создать его на строке **137** рядом с
`engineAdministration` и передать в `LegacyEngineAdministration` через options.

**Проверки после A.5:**
- [ ] tsc clean
- [ ] Все baseline-тесты green
- [ ] `grep -rln "episode_workflows" src/` — 14 → 11 (3 файла из A.3/A.4 repointed)

### A — Итог по блоку
- **Объём:** ~400 строк (DDL + миграция + 3 файла repoint + composition wiring)
- **Risk:** high — control plane live, polling каждые 2s из frontend
- **Параллельно:** нет, это стартовый блок
- **Acceptance gate:** frontend /api/engine/status и /api/model/set работают на новой таблице; smoke run lifecycle проходит

---

## БЛОК B — Удалить 8 `episode_workflows` writers

> Источник: `CLEANUP-CHECKLIST.md` Step 2 + `CUTOVER-VERIFY.md` Блок B.
> Gated на блок A (control state уже не в ew.metadata).

### B.1 — Карта 8 writers (file:line)

| # | Файл:строка | Что пишет | Действие |
|---|---|---|---|
| 1 | `src/infrastructure/engine/legacy-engine-administration.ts:248-252` | `UPDATE ew SET metadata=?` (setMeta generic) | **Удалить метод `setMeta`** — после A.3 он не вызывается (engine_* уже пишет в control table) |
| 2 | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:42-49` | `UPDATE ew SET metadata=…'$.needs-human'…` (`pause`) | **Удалить** — lifecycle pause owns this (LifecycleRun.status='paused') |
| 3 | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:64-68` | `UPDATE ew SET metadata=json_remove(…)` (`clearNeedsHuman`) | **Удалить** — то же |
| 4 | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:145-153` | `UPDATE ew SET metadata=json_set(…)` (`patchMetadata`) | **Удалить** |
| 5 | `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:22` | `INSERT OR IGNORE INTO ew (epic_id)` (`ensureWorkflow`) | **Удалить** — после удаления всех writes строка не нужна |
| 6 | `src/planner/fast-track.ts:206-212` | `INSERT INTO ew (epic_id,stage,metadata)…` (fast-track XS path) | **Удалить INSERT** — formalization module сам решает XS (CLEANUP Step 7) |
| 7 | `src/db.ts:807-811` | `UPDATE ew SET track='fast-track'…` (`migrateEpisodeTrack` backfill) | **Удалить backfill** (функцию целиком — CLEANUP Step 7) |
| 8a | `src/tools/export-import.ts:408` | `INSERT INTO ew (epic_id,stage,baseline_hash,metadata)…` | **Удалить** — export сериализует lifecycle runs, не ew |
| 8b | `src/tools/export-import.ts:500` | `UPDATE ew SET baseline_artifact_id=?` (import backfill) | **Удалить** |

### B.2 — Дополнительные правки (logically tied)

- `src/tools/export-import.ts:122` — `SELECT * FROM episode_workflows WHERE epic_id=?`
  (export читает ew row). Удалить вместе с writer'ами 8a/8b — lifecycle runs сериализуются отдельно.
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:25-30` —
  `currentStage` (читает `ew.stage`). Repoint на `saga3_lifecycle_runs.current_stage_id`
  (см. `sqlite-board-projection-reader.ts:65-67` — там уже так). Это последний
  живой ридер `ew.stage`.
- `src/infrastructure/projections/sqlite-board-projection-reader.ts` — **уже** читает
  `saga3_lifecycle_runs` (строки **65-84**), `ew` не трогает. Ничего делать не нужно.

### B.3 — Reads-only после B (gated на A + B.2)

После B.1+B.2 в `src/` не остаётся writes в `episode_workflows`. Оставшиеся reads —
только `sqlite-saga2-runtime-repositories.ts:25-30` (`currentStage`) до его repoint
в B.2, и comments (не считаются).

**Проверки после B:**
- [ ] tsc clean
- [ ] `grep -rln "INSERT INTO episode_workflows\|UPDATE episode_workflows" src/` → **0**
- [ ] `tests/lifecycle/claim-dependency.test.mjs` green
- [ ] `tests/process-modules/trace-gap-blocks-development.test.mjs` green
- [ ] `tests/architecture/saga2-boundaries.test.mjs` green
- [ ] Ручная: export/import round-trip без ew row
- [ ] Ручная: fast-track эпик проходит formalization без ew INSERT
- [ ] Ручная: board показывает stage из `saga3_lifecycle_runs`

### B — Итог по блоку
- **Объём:** ~150 строк удалений + repoint `currentStage` (~20 строк)
- **Risk:** medium — export/import round-trip надо прогнать вручную
- **Параллельно:** нет, gated на A
- **Acceptance gate:** `grep -rln "INSERT INTO episode_workflows\|UPDATE episode_workflows" src/` = 0

---

## БЛОК C — Cosmetic renames (5 символов)

> Источник: `CUTOVER-VERIFY.md` Блок C + `phase-3 §8` (decision point 3).
> Механический refactor. Gated на A (некоторые из них читают control table).

### C.1 — Карта переименований

| # | Старое (legacy) | Новое (канон) | Файл-определение | Importers |
|---|---|---|---|---|
| 1 | `createSaga2Application` | `createProductLifecycleApplication` | `src/app/composition-root.ts:100` | `src/orchestrate-cli.ts:24,180`; `tests/**` |
| 2 | `runEpisode` | `runProductLifecycle` | `src/application/saga-application.ts:29,123` | `src/orchestrate-cli.ts:181`; `tests/**` |
| 3 | `Saga2RuntimePersistence` | `RuntimePersistence` | `src/application/ports/saga2-runtime-persistence.ts` | все импортеры port'а |
| 4 | `NodeSaga2HostRuntime` | `WorkerExecutionHost` | `src/infrastructure/runtime/node-saga2-host-runtime.ts:52` | `src/app/composition-root.ts:26,119`; `tests/architecture/saga2-boundaries.test.mjs` |
| 5 | `LegacyEngineAdministration` | `LifecycleExecutionAdministration` | `src/infrastructure/engine/legacy-engine-administration.ts:37` | `src/app/composition-root.ts:19,86,137`; `tests/**` |

### C.2 — Замечания по blast radius

- **C.1 (`createSaga2Application`)** — самый безопасный старт. Затрагивает
  `composition-root.ts` + `orchestrate-cli.ts` + ~5 тестов. Механический rename.
- **C.2 (`runEpisode`)** — **high blast radius**: каждый saga3 service + scenario
  adapter вызывает `application.runEpisode(...)`. Рекомендуется отдельным коммитом
  после C.1, прогнать `tests/process-modules/**` целиком.
- **C.3 (`Saga2RuntimePersistence`)** — high blast radius (имя port'а, импортируется
  везде где есть repo-интерфейсы). Отдельный коммит.
- **C.4 (`NodeSaga2HostRuntime`)** — medium. ~3 importers + test assertions.
- **C.5 (`LegacyEngineAdministration`)** — medium. ~3 importers. Имя файла
  `legacy-engine-administration.ts` тоже переименовать в
  `lifecycle-execution-administration.ts` (импорт-пути поправятся автоматически).

### C.3 — Что НЕ переименовывать в этом блоке

- `Saga2HostRuntime` (port) — `phase-3 §3.1` оставляет решение на Phase 4;
  rename в `HostRuntime` возможен, но не критичен. Вне scope этого плана.
- `Sqlite*Saga2*Repository` классы — cosmetic, можно в той же волне, но не блокирует
  cutover. Оставить на отдельный cleanup-PR.
- `saga3_*` таблицы — **категорически отдельно** (850 путей, cosmetic only).
  См. §7.

**Проверки после C (после КАЖДОГО rename):**
- [ ] tsc clean
- [ ] `grep -rln "<old name>" src/ tests/` → **0**
- [ ] Все baseline-тесты green (особенно `saga2-boundaries.test.mjs` для C.4/C.5)
- [ ] Smoke: `node dist/orchestrate-cli.js …` поднимается

### C — Итог по блоку
- **Объём:** ~600 строк правок в dozens файлов (в основном import statements)
- **Risk:** low (механический), но C.2/C.3 high blast radius — по коммиту на символ
- **Параллельно:** можно после B (или параллельно с D)
- **Acceptance gate:** `grep -rln "createSaga2Application\|runEpisode\|Saga2RuntimePersistence\|NodeSaga2HostRuntime\|LegacyEngineAdministration" src/` = 0

---

## БЛОК D — Dead code cleanup

> Источник: `CLEANUP-CHECKLIST.md` Step 3 (частично) + `CUTOVER-VERIFY.md` Блок D.
> Независим от A/B/C — можно стартовать сразу, параллельно.

### D.1 — `SqliteEpisodeRuntimeRepository` — 7 из 9 методов мёртвые

**Файл:** `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:20-155`

Метод (строки) | Статус | Доказательство
---|---|---
`ensureWorkflow` (22) | dead после B.5 | выше в B
`currentStage` (25-30) | **жив** | repoint в B.2, потом удалить с классом
`projectIdForEpic` (32-37) | проверить callers | дублирует `legacy-engine-administration.ts:208`
`pause` (39-60) | **dead** | lifecycle `LifecycleRun.status='paused'` owns
`clearNeedsHuman` (62-69) | **dead** | то же
`isNeedsHuman` (71-77) | **dead** | `board-projection-reader.ts:70` читает `lr.status='paused'`
`readLatestBriefDecision` (79-94) | **dead** | brief — accepted artifact, читается через `artifact_get`
`readHealMetadata` (96-106) | **dead** | pump удалён (Phase 3 FINAL-REPORT §1)
`readTargetConcurrency` (108-123) | **жив до A.4**, dead после | repoint в A.4
`readWorkerModelRoute` (125-142) | **жив до A.4**, dead после | repoint в A.4
`patchMetadata` (144-154) | **dead** | см. B.4

**Действие:** после A+B класс теряет всех живых callers. Удалить класс целиком
(строки 20-155) + убрать из `EpisodeRuntimeRepository` interface
(`saga2-runtime-persistence.ts`) мёртвые методы. Если от класса остался только
`currentStage`, перенести его в `lifecycle-run-repository` или board-projection-reader.

### D.2 — `readTaskReviewFeedback` — 0 вызовов

| Файл:строка | Роль | Действие |
|---|---|---|
| `src/process-modules/application/node-executors/lm-node-executor.ts:181` | optional port field `readTaskReviewFeedback?` | удалить поле из port |
| `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts:473` | реализация | удалить метод |

`grep -rn "readTaskReviewFeedback\b" src/` — только определение + порт, 0 callsites.

### D.3 — `agent-assistance-renderer.ts` — 0 production importers

**Файл:** `src/process-modules/application/agent-assistance-renderer.ts` (**779 строк**)

Importers (только тесты):
- `tests/execution/hardening-weak-model.test.mjs`
- `tests/execution/workspace-tracker-hook-tests.test.mjs`
- `tests/process-modules/agent-assistance-renderer.test.mjs`

**Действие:** удалить файл целиком + 3 теста. Если `hardening-weak-model` /
`workspace-tracker-hook-tests` тестируют ещё что-то — адаптировать (убрать ассерты
по renderer), не удалять целиком.

### D.4 — `scanRateLimitSignals` (бонус, низкий приоритет)

**Файлы:**
- `src/application/ports/saga2-host-runtime.ts:38` (port method)
- `src/infrastructure/runtime/node-saga2-host-runtime.ts:144` (impl)

Dead после удаления pump (`FINAL-REPORT.md` §6: RECOVERY_TREE gone). Удалить из
port и impl. Затрагивает `tests/architecture/saga2-boundaries.test.mjs` —
адаптировать ассерты.

**Проверки после D:**
- [ ] tsc clean
- [ ] `grep -rln "readTaskReviewFeedback\|agent-assistance-renderer\|scanRateLimitSignals" src/` → **0**
- [ ] `tests/architecture/saga2-boundaries.test.mjs` green (после адаптации)
- [ ] Все baseline-тесты green
- [ ] `node --test` — полный suite green (за исключением известных pre-existing fails из FINAL-REPORT §7)

### D — Итог по блоку
- **Объём:** ~900 строк удалений (779 renderer + ~100 SqliteEpisodeRuntimeRepository + тесты)
- **Risk:** low (zero callers proven grep'ом)
- **Параллельно:** да, полностью независимо от A/B/C
- **Acceptance gate:** grep по трём целям = 0; full test suite green

---

## Финальный acceptance (после всех блоков)

```bash
# 1. Build
npx tsc --noEmit

# 2. Mandatory search — из жесткого промпта + CUTOVER-VERIFY
grep -rl "episode_workflows" src/                          # → только historical comments / migration
grep -rln "INSERT INTO episode_workflows\|UPDATE episode_workflows" src/   # → 0
grep -rl "tryAdvanceStage" src/                            # → 0
grep -rl "RECOVERY_TREE" src/                              # → 0
grep -rl "generateNextForCompletedTask" src/               # → 0 (кроме module-owned MCP)
grep -rl "episode_transition" src/                         # → orchestrator-owned MCP only
grep -rl "workflow_generate_next" src/                     # → module-owned MCP only
grep -rl "Saga2Engine" src/                                # → 0
grep -rl "engine=v2" src/                                  # → 0
grep -rln "createSaga2Application\|runEpisode\b\|Saga2RuntimePersistence\|NodeSaga2HostRuntime\|LegacyEngineAdministration" src/   # → 0 (после C)
grep -rln "readTaskReviewFeedback\|agent-assistance-renderer\|scanRateLimitSignals" src/   # → 0 (после D)

# 3. Smoke run — один orchestrator, zero episode_workflows writes
#    Создать epic через frontend → Discovery → Formalization → Development
#    Проверить: SELECT COUNT(*) FROM lifecycle_execution_controls WHERE epic_id=…;  → 1
#    Проверить: SELECT COUNT(*) FROM episode_workflows WHERE epic_id=…;             → 0 (после drop)

# 4. Full suite
node --test
```

---

## §7 — Что НЕ в этом плане (отдельные эпики)

1. **`saga3_*` rename таблиц** — 41 таблица, 850 обращений в `src/`. Cosmetic,
   НЕ смешивать с cutover. `saga3_lifecycle_runs` — АКТИВНОЕ ЯДРО saga4
   (`schema.ts:960`). Отдельный эпик.

2. **Phase 6 stable references full rollout** — `CLEANUP Step 8`. Durable surrogate
   IDs (artifactId/taskId/epicId/providerId) → content-addressed refs. Большая
   отдельная задача, паттерн доказан в `50e065c`.

3. **Dead SPI `UniversalRecoveryEngine` / `recovery-policies.ts`** — `CLEANUP Step 5`.
   `@deprecated`, 0 production consumers, но 7 test files depend. Отдельный PR.

4. **Stage-summary frontend** — `CLEANUP Step 4`. `/api/episode/stage-summary`
   spawn'ит `summary.stage` task. Не блокирует cutover.

5. **Skills tombstone** — `CLEANUP Step 6`. 9 skills упоминают удалённые инструменты.

6. **Assistance hooks (P0)** — модели умирают без контекста. Параллельный эпик,
   не блокирует cutover, но влияет на текущие прогоны.

7. **Drop `episode_workflows` table целиком** — возможен **только** после A+B+C+D
   и после того как все reads repointed на `saga3_lifecycle_runs`. На этом этапе
   `ALTER TABLE … DROP COLUMN stage, track` (или重建 без них). Финальный шаг cutover.

---

## §8 — Решения (resolution of open questions)

### 8.1 — Терминология: `ProductFactory` vs `ProductLifecycle`

**Канон: `ProductLifecycle`.**

Доказательства:
- `createProductLifecycleRuntime` уже существует (`src/app/product-lifecycle-runtime.ts:298`)
- `ProductLifecycleRuntimeOptions` — канонический тип (`product-lifecycle-runtime.ts:250`)
- `assembleProductLifecycleInput`, `startProductLifecycleFromIdea`,
  `ProductLifecycleCompositionOverrides` — вся codebase использует `ProductLifecycle`
- Все 9 phase-документов в этой папке используют `ProductLifecycle`
- Архитектор-критик ввёл `ProductFactory` заново, не сославшись на существующий канон

**Действие:** `createSaga2Application` → `createProductLifecycleApplication` (Блок C.1),
НЕ `createProductFactoryApplication`. `runEpisode` → `runProductLifecycle` (Блок C.2).

### 8.2 — Блок 3 (model route): standalone repo vs fold в control table

**Решение: fold в `lifecycle_execution_controls` (следовать существующему плану).**

Доказательства:
- `CLEANUP-CHECKLIST.md` Step 1 явно кладёт model route в control table
  (`model_provider/model_name/model_effort/model_concurrency_limit`)
- Model route — operational control-state, не domain aggregate; отдельная таблица
  избыточна
- 3 идентичных `json_extract` сайта (dispatcher:215, runtime-repo:128, worker-factory:124)
  заменяются одним `SELECT model_* FROM lifecycle_execution_controls`
- Standalone `ModelRouteRepository` чище архитектурно, но добавляет таблицу +
  repo-класс + wiring без functional benefit

**Действие:** DDL в A.1 уже включает `model_*` columns. Все 3 сайта в A.4 repointed
на одну таблицу. Если позже появится 4-й consumer с другой lifecycle — выделить
`ModelRouteRepository` как refactor, не как cutover blocker.

### 8.3 — Приоритет: cutover vs assistance hooks

**Оба важны, последовательные эпики:**
- **Cutover (A+B+C+D)** — инфраструктурный долг. Блокирует rename, удаление ew,
  чистую трассируемость "saga4 = ProductLifecycle". Делается первым.
- **Assistance hooks (P0)** — влияет на текущие прогоны (модели умирают без
  контекста). Параллельный эпик; не блокируется cutover'ом (трогает другой слой —
  node-executors / worker context, не control plane).

Рекомендация: A+B+D в одном спринте (cutover core), C и assistance — параллельно
в следующем.

---

## §9 — Ссылки (источники)

**Существующий план (read first):**
- `docs/design/saga4-cutover/FINAL-REPORT.md` — что уже сделано (commits 9a69c8a…50e065c)
- `docs/design/saga4-cutover/CLEANUP-CHECKLIST.md` — Steps 1-8 (= база этого плана)
- `docs/design/saga4-cutover/phase-1-authority-map.md` — §0 glossary, §8 composition-root
- `docs/design/saga4-cutover/phase-3-delete-legacy-engine.md` — §3 ports KEEP, §7 LegacyEngineAdministration rename

**Свежая верификация:**
- `docs/research/CUTOVER-VERIFY.md` — 6 архитекторов, file:line доказательства

**Saga2 infra (active, под замену):**
- `src/app/composition-root.ts:100-145` (`createSaga2Application`)
- `src/infrastructure/engine/legacy-engine-administration.ts` (engine control, 374 строки)
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts` (episode repo, 306 строк)
- `src/infrastructure/runtime/node-saga2-host-runtime.ts` (host runtime)
- `src/application/ports/saga2-runtime-persistence.ts` (persistence port)
- `src/application/ports/saga2-host-runtime.ts` (host port)
- `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:124-128` (model route)

**saga3 kernel (durable, НЕ трогать):**
- `src/schema.ts:963-998` (`saga3_lifecycle_runs` DDL)
- `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`
- `src/process-modules/persistence/sqlite-process-run-repository.ts`
- `src/infrastructure/projections/sqlite-board-projection-reader.ts:65-84` (образец чтения lifecycle runs)

**episode_workflows writers (подлежат удалению в B):**
- `src/infrastructure/engine/legacy-engine-administration.ts:248-252`
- `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:22,42,64,145`
- `src/planner/fast-track.ts:206-212`
- `src/db.ts:799-813` (`migrateEpisodeTrack`)
- `src/tools/export-import.ts:122,408,500`
- `src/tools/dispatcher.ts:215-219` (read в claim — repoint в A.4)
