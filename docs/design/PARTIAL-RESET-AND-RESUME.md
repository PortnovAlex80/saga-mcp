# Partial Reset & Resume — старт с места сбоя без повтора всего lifecycle

Status: **Design**
Owner: saga-mcp architecture
Date: 2026-07-30

## 0. Контекст и цель

Каждый багфикс в saga-mcp сегодня требует полного `reset-saga-db.mjs` и прогона всего
lifecycle (`Discovery → Formalization → Development → Delivery`) заново. Прогон одной
формализации стоит 20–30 минут и повторяется **идентично** каждый раз. Цель — научиться:

1. откатываться на один node назад и продолжать;
2. возобновлять lifecycle после паузы / убитого процесса (stale lease);
3. сносить один stage, оставляя остальные нетронутыми;
4. перезапускать один `ProcessRun`, не трогая lifecycle transitions.

Документ основан на чтении исходников и анализе живой `saga.db`
(lifecycle_run 33, epic 1, находится на `solution-formalization`, node_run 500
`model-use-cases` в статусе `running` после убитого процесса).

---

## 1. Анализ текущих возможностей resume/reset

### 1.1 Что УЖЕ работает

**Resume после stale-lease (status=`running`, но процесс убит).**
`orchestrate-cli.ts` принимает `--resume`, который пробрасывается как
`RunLifecycleCommand.resumePaused` (`src/orchestrate-cli.ts:66-69`, `:153`).
Дальше путь такой:

- `LifecycleOrchestrator.run()` (`lifecycle-orchestrator.ts:149`) вызывает
  `lifecycleRunRepo.start(...)` с тем же `idempotency_key`
  (`product-delivery:epic:<epicId>`). Поскольку run с этим ключом уже существует и
  `input_hash` совпадает — возвращается `replayed: true` с существующей строкой
  (`sqlite-lifecycle-run-repository.ts:383-404`).
- Если `record.status === 'paused'` и `resumePaused` выставлен — вызывается
  `repo.resume(...)` (`lifecycle-orchestrator.ts:177-180`), который переводит
  `paused → running` (`sqlite-lifecycle-run-repository.ts:701-719`).
- Если `status === 'running'` (stale-lease — это и есть наш случай), resume **не нужен**:
  run уже не-paused. Дальше `acquireExecutionLease` (`:183-189`) отбирает lease, потому
  что старый `execution_lease_expires_at` уже протух (условие в
  `sqlite-lifecycle-run-repository.ts:1051-1058`: lease отдаётся, если он free, наш, или
  протух). Fence инкрементируется → новый исполнитель забирает run.
- Дальше цикл натыкается на `current_stage_run_id` (`:208`) и для существующего StageRun
  вызывает `ensureStageRun` → путь `replayed: true`
  (`sqlite-lifecycle-run-repository.ts:528-532`), потом `bindProcessRun` (то же
  idempotency → replay), и `executeOrReplayProcess` (`:404-474`). Если ProcessRun уже
  `completed` — сразу `kind:'completed'`; если `running/paused` — GenericFlowExecutor
  доигрывает Flow от последнего `node_run` (checkpoint-resume, см. §1.3).

**Вывод:** чистый `--resume` **работает** для:
- status=`paused` + `resumePaused`,
- status=`running` + протухший lease,
- при условии, что `definition_hash` lifecycle не изменился.

### 1.2 Resume одного ProcessRun / node

GenericFlowExecutor — универсальный для всех модулей. Алгоритм
(`generic-flow-executor.ts:13-22`, подтверждён development-process-module node-графом):

1. `process_run`: `created → preparing → running`;
2. от `entryNodeId` по transitions диспатчится каждый узел через `NodeExecutor` по
   `node.kind`;
3. **каждый шаг пишет `NodeRun` как checkpoint** (`sqlite-node-run-repository.ts`,
   `start/startV2` инкрементирует `attempt` по `(process_run_id, node_id)`);
4. на terminal node — settlement + certificate.

На рестарте executor читает последний completed NodeRun
(`readLastCompleted` / `readLastCompletedV2`, `sqlite-node-run-repository.ts:338-346`,
`:454-462`) и продолжает **со следующего transition**. Т.е. если `resolve-task-graph`
completed, а `execute-implementation-workset` упал — рестарт ProcessRun перепрыгнет
уже-done узлы и начнёт с `execute-implementation-workset`.

Это означает: **перезапуск одного ProcessRun БЕЗ удаления данных уже даёт
checkpoint-resume** на уровне node. Проблема возникает только когда нужно *переделать*
узел, а не *продолжить* его.

### 1.3 Recovery-loop внутри node

`saga3_recovery_cases` + `saga3_recovery_attempts` (`sqlite-recovery-case-repository.ts`)
реализуют verify→repair петлю с лимитом `max_attempts` (development: `verify-acceptance-workset`
→ `integrate-release-candidate` → повтор). Это встроенный "retry последнего узла" внутри
модуля, но он не покрывает случай "пересоздать задачу планировщика".

---

## 2. Что блокирует resume / откат

### 2.1 `LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY` (главный блокер)

`sqlite-lifecycle-run-repository.ts:390-395`: при replay того же `idempotency_key`, если
`existing.definition_hash !== command.definitionHash` — бросается
`LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY`. Это блокирует resume, как только **любой** байт
`LifecycleDefinition` (сами stages, их `inputMapping`, `outputMapping`, `outcomeRoutes`,
маппинги модулей) изменился — даже если поменялся только skill в `executionProfile`, а
код ProcessModule не тронут.

В живой БД `definition_hash=2ea303...` — любой ребилд с правкой lifecycle-файла ломает
resume.

### 2.2 Idempotency-key reuse на ProcessRun

`sqlite-process-run-repository.ts:289-305`: тот же `(project, module, idempotency_key)`
с **другим** `input_hash` (или другим `installation_id`/`package_digest`) →
`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`. ProcessRun idempotency_key имеет форму
`lifecycle:<runId>:stage-run:<stageRunId>` (`lifecycle-orchestrator.ts:256`), поэтому при
той же LifecycleRun+StageRun ключ стабилен, пока не меняется вход stage. Если
stage-input пересчитался (например, поменялась формализационная baseline) — replay
заблокирован.

### 2.3 Immutable-триггеры (acceptance items, node submissions)

Таблицы с `BEFORE DELETE/UPDATE ... RAISE(ABORT)`:

- `saga3_exact_candidate_acceptance_decisions` — `no_update`, `no_delete`
  (`sqlite-exact-candidate-acceptance.ts:187-208`);
- `saga3_exact_candidate_acceptance_items` — `no_update`, `no_delete`;
- `saga3_managed_node_submissions` — `no_update`, `no_delete`
  (`sqlite-managed-node-submission-repository.ts:70-80`).

Поэтому **нельзя** просто `DELETE FROM saga3_process_runs WHERE id=X`: RESTRICT-FK
на `saga3_stage_runs.process_run_id` (`ON DELETE RESTRICT`,
`sqlite-lifecycle-run-repository.ts:87-88`) и на `saga3_managed_node_submissions`
(`ON DELETE RESTRICT`) блокируют каскад, а триггеры блокируют прямое удаление. Ровно
поэтому `reset-saga-db.mjs:89-94` сначала **дропает все ABORT-триггеры**, потом чистит
таблицы. Любой partial-reset должен повторить этот приём в рамках своей транзакции.

### 2.4 Pinned packages / module digest

`orchestrate-cli.ts:247-251` ставит production-модули в content-addressed store через
`installProductionModules` (идемпотентно: тот же DB + те же байты → reuse,
`orchestrate-cli.ts:243-246`). Каждый ProcessRun пинится к
`installation_id`+`package_digest` (`lifecycle-orchestrator.ts:243-251`).

Если **код модуля не менялся** — digest совпадает, `installProductionModules` переис-
пользует установку, replay ProcessRun проходит. Если код модуля правился (даже без правки
lifecycle-файла) — `package_digest` меняется, и `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`
срабатывает на ProcessRun (см. §2.2), потому что `installation_id`/`package_digest` входят
в `sameInvocation` (`sqlite-process-run-repository.ts:290-297`).

### 2.5 Leases при убитом процессе

В живой БД: lifecycle_run 33 `status='running'`, `execution_lease_owner` ещё заполнен,
process_run 83 тоже `status='running'` с заполненным `execution_lease_owner`. Это
нормально — lease протухнет по времени, и новый `--resume` отберёт его (см. §1.1).
**Никакой ручной очистки lease для resume не требуется**, только ожидание истечения или
`acquireExecutionLease`, который сам видит протухший `expires_at`.

---

## 3. Дизайн по сценариям

### Карта данных (load-bearing)

Понимание этих связей критично для всех сценариев:

```
saga3_lifecycle_runs (id, current_stage_id, current_stage_run_id, status, definition_hash, idempotency_key)
  └─ saga3_stage_runs (lifecycle_run_id, ordinal, stage_id, process_run_id UNIQUE, status)
       └─ saga3_process_runs (id, module_name, idempotency_key='lifecycle:<lr>:stage-run:<sr>', status, local_outcome)
            ├─ saga3_node_runs (process_run_id, node_id, attempt, status) [CASCADE]
            ├─ saga3_recovery_cases + saga3_recovery_attempts (process_run_id) [CASCADE]
            ├─ saga3_managed_artifact_productions (process_run_id, task_id) [CASCADE]
            ├─ saga3_managed_trace_productions (process_run_id, task_id) [CASCADE]
            ├─ saga3_managed_node_submissions (process_run_id, task_id) [RESTRICT + no-delete trigger]
            └─ saga3_exact_candidate_acceptance_decisions (process_run_id, task_id, artifact_id) [RESTRICT + no-delete trigger]

tasks (workflow_stage ∈ discovery/formalization/development/verification,
       generation_key='process-run:<prid>:node:<nodeId>', task_kind)
saga3_work_intents (kind='formalization.use-cases', projected_task_id → tasks.id)
```

Stage → module → node-ids (`product-delivery-lifecycle.ts:164-348`):

| stage_id                | module                  | nodes (dev/form) или flow                        |
|-------------------------|-------------------------|--------------------------------------------------|
| `initial-discovery`     | product-discovery       | produce-proposal → ... → settle → complete-*     |
| `solution-formalization`| solution-formalization  | define-product-contract, model-use-cases, ...    |
| `solution-development`  | solution-development    | plan-task-graph → resolve → execute → integrate → verify → settle |
| `delivery-release`      | delivery                | (delivery flow)                                  |

### Сценарий C — "Resume после паузы/убитого процесса" (ДЕЛАЕМ ПЕРВЫМ, 0 кода)

**Когда:** lifecycle_run `running`/`paused`, процесс убит, данные не повреждены.
Это ~80% реальных кейсов (как в живой БД).

**Действие:** просто

```bash
DB_PATH=C:/Users/user/.zcode/saga.db \
  SAGA_ORCHESTRATION_MODE=saga3-lifecycle \
  SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./product-lifecycle-composition.mjs \
  SAGA_PRODUCT_LIFECYCLE_INPUT=./hex-lifecycle-input.json \
  node dist/orchestrate-cli.js <project_id> <epic_id> --resume --idempotency-key=product-delivery:epic:<epic_id>
```

**Почему работает (см. §1.1):** `start()` → replay (тот же idempotency_key + тот же
input_hash); `acquireExecutionLease` отбирает протухший lease; `ensureStageRun`/`bindProcessRun`
replay'ят существующий StageRun+ProcessRun; GenericFlowExecutor доигрывает Flow с
последнего completed `node_run`.

**Блокируется только если** `definition_hash` поменялся (§2.1). Лекарство — Сценарий A
(partial reset formalization) или "resume без definition check" (§3-Extra).

### Сценарий A — "Перезапусти Development, не трогая Formalization"

**Когда:** Formalization завершилась (`formalized`), Development упал. Хотим снести
Development-данные и продолжить с того же lifecycle_run.

**Что чистить** (только stage `solution-development` + его process_run + tasks + work
intents development-стадии). **Не трогаем**: lifecycle_run, formalization-stage_run,
formalization process_run, все accepted artifacts (PRD/FR/UC/AC/SRS), exact-acceptance
decisions (это и есть «наследие»).

Шаги SQL (всё в одной транзакции, FK off, immutable-триггеры сначала дропаются):

1. Найти development-данные:
   ```sql
   SELECT id, process_run_id FROM saga3_stage_runs
    WHERE lifecycle_run_id=:lr AND stage_id='solution-development';
   ```
2. Очистить development-специфичные строки (CASCADE-таблицы почистятся автоматически,
   когда удалим process_run; RESTRICT/trigger-таблицы чистим явно или оставляем —
   см. §4 пояснение про idempotency):
   ```sql
   DELETE FROM saga3_development_task_projections WHERE process_run_id=:dev_pr;
   DELETE FROM saga3_development_outputs           WHERE process_run_id=:dev_pr;
   DELETE FROM saga3_development_integration_observations WHERE process_run_id=:dev_pr;
   DELETE FROM saga3_recovery_cases WHERE process_run_id=:dev_pr;
   DELETE FROM saga3_node_runs WHERE process_run_id=:dev_pr;
   ```
3. Tasks development-стадии (по `workflow_stage` + `generation_key` с process_run_id):
   ```sql
   DELETE FROM tasks WHERE workflow_stage IN ('development','verification')
     AND generation_key LIKE 'process-run::dev_pr:%';
   -- либо надёжнее по metadata.process_run_id:
   DELETE FROM tasks WHERE workflow_stage IN ('development','verification')
     AND json_extract(metadata,'$.process_run_id')=:dev_pr;
   ```
   (Внимание: подзапрос на generation_key безопаснее — см. §4.)
4. Удалить development process_run и его stage_run:
   ```sql
   DELETE FROM saga3_managed_node_submissions WHERE process_run_id=:dev_pr;  -- после drop триггера
   DELETE FROM saga3_process_runs WHERE id=:dev_pr;          -- CASCADE: managed_artifact/trace_productions
   UPDATE saga3_stage_runs SET process_run_id=NULL WHERE id=:dev_sr;
   DELETE FROM saga3_stage_runs WHERE id=:dev_sr;
   DELETE FROM saga3_process_transitions
     WHERE lifecycle_run_id=:lr AND to_stage_run_id=:dev_sr;
   ```
5. Вернуть курсор lifecycle на formalization (чтобы orchestrator пере-зашёл в development
   по её terminal-transition):
   ```sql
   UPDATE saga3_lifecycle_runs
       SET current_stage_id='solution-formalization',
           current_stage_run_id=(SELECT id FROM saga3_stage_runs
                                   WHERE lifecycle_run_id=:lr
                                     AND stage_id='solution-formalization'),
           status='paused',           -- --resume с resumePaused подхватит
           terminal_status=NULL, error=NULL, version=version+1,
           execution_lease_owner=NULL, execution_lease_expires_at=NULL
     WHERE id=:lr;
   ```
   (formalization stage_run уже `completed` с outcome=`formalized` — orchestrator на
   следующем цикле увидит `completed` и сразу сделает handoff в development заново,
   создав новый stage_run + process_run с новым idempotency_key.)

6. Запустить `--resume` (Сценарий C).

**Почему не ломается acceptance:** `saga3_exact_candidate_acceptance_items` указывают на
`artifact_id` (настоящие artifacts), а не на process_run/task. Это **чужой** слой (baseline
формализации). Re-acceptance в development-верификации идемпотентен: при повторе
`disposition` будет `already-accepted` (`sqlite-exact-candidate-acceptance.ts:171-172`).

### Сценарий B — "Откати последний node, не весь stage"

**Когда:** SRS-node settlement упал, reconciliation уже accepted. Хотим пересоздать
один node_run + его task, оставив reconciliation и stage_run.

**Действие:** это самый узкий откат. Не трогаем stage_run/process_run lifecycle-курсоры.

1. Найти последний node_run:
   ```sql
   SELECT id, node_id, task_id FROM saga3_node_runs
    WHERE process_run_id=:pr ORDER BY id DESC LIMIT 1;
   ```
2. Удалить его managed-продукцию и task (если он один-одному с node):
   ```sql
   DELETE FROM saga3_managed_node_submissions WHERE ... ;   -- только строки этого node/execution (после drop триггера)
   DELETE FROM saga3_managed_artifact_productions
     WHERE process_run_id=:pr AND node_id=:nodeId AND task_id=:taskId;
   DELETE FROM saga3_managed_trace_productions
     WHERE process_run_id=:pr AND node_id=:nodeId AND task_id=:taskId;
   DELETE FROM tasks WHERE id=:taskId;   -- если generation_key = process-run:pr:node:nodeId
   DELETE FROM saga3_node_runs WHERE id=:nodeRunId;
   ```
3. **Перевести process_run в не-terminal**, чтобы executor пере-заходил в node:
   ```sql
   UPDATE saga3_process_runs
       SET status='paused', error=NULL, local_outcome=NULL,
           output_ref=NULL, output_schema=NULL, output_hash=NULL,
           certificate_ref=NULL, certificate_schema=NULL, certificate_hash=NULL,
           authority=NULL, active_recovery_case_id=NULL,
           execution_lease_owner=NULL, execution_lease_expires_at=NULL,
           completed_at=NULL, updated_at=datetime('now')
     WHERE id=:pr;
   ```
   (Это обходит write-once guard `assertTransitionAllowed`/COALESCE-охрану в
   `sqlite-process-run-repository.ts:409-463`, которые в нормальной работе запрещают менять
   terminal — мы действуем в обход, как admin-recovery.)
4. Если stage_run тоже стал terminal/failed — откатить и его:
   ```sql
   UPDATE saga3_stage_runs
       SET status='paused', error=NULL, local_outcome=NULL, completed_at=NULL,
           output_ref=NULL, output_schema=NULL, output_hash=NULL,
           certificate_ref=NULL, certificate_schema=NULL, certificate_hash=NULL,
           mapped_output_snapshot=NULL, result_snapshot=NULL, updated_at=datetime('now')
     WHERE id=:sr;
   UPDATE saga3_lifecycle_runs
       SET status='paused', current_stage_id=:stageId, current_stage_run_id=:sr,
           terminal_status=NULL, error=NULL, version=version+1,
           execution_lease_owner=NULL, execution_lease_expires_at=NULL
     WHERE id=:lr;
   ```
5. `--resume` (resumePaused подхватит paused).

**Граница:** откатывать node можно только если **не был выписан outcome-certificate для
этого process_run** (`saga3_process_outcome_certificates`). Если settlement уже записал
сертификат — node-rollback небезопасен, надо подниматься на Сценарий A (пересоздать
весь process_run/stage).

### Сценарий D — "Перезапусти конкретный ProcessRun, не трогая lifecycle transitions"

**Когда:** Development ProcessRun failed, но lifecycle stage-машину трогать не нужно
(например, хотим ровно "пере-стартовать" development ProcessRun и доиграть).

По сути это **сценарий A, но без сдвига current_stage_id** — чистим только
process_run + node_runs + recovery + development-проекции + development-tasks, а stage_run
и lifecycle-курсор оставляем, после чего:

```sql
UPDATE saga3_stage_runs SET process_run_id=NULL, status='created',
       local_outcome=NULL, completed_at=NULL, output_ref=NULL, ...
  WHERE id=:dev_sr;
-- process_run удаляем целиком (CASCADE чистит node_runs/recovery/managed_*_productions)
DELETE FROM saga3_process_runs WHERE id=:dev_pr;
```

Дальше orchestrator на `--resume` увидит stage_run `created` с `process_run_id=NULL`,
вызовет `ensureStageRun` → вернёт существующий stage (т.к. `current_stage_run_id` уже
указывает на него), затем стартанёт **новый** ProcessRun с новым
`lifecycle:<lr>:stage-run:<sr>` idempotency_key (старый удалён, коллизии нет), и
GenericFlowExecutor прогонит Flow с нуля.

**Отличие от A:** в A мы двигаем `current_stage_id` на формализацию, чтобы orchestrator
сам пере-перешёл в development по `outcomeRoutes.formalized`. В D мы остаёмся на
development-stage и заставляем orchestrator пересоздать только process_run.

**Когда D лучше A:** когда нужно сменить **вход development** (например, подправить
policy репозиториев), но не пересоздавать сам stage binding. Тогда D оставляет
development stage_run, а пересчёт `inputMapping` даст новый `input_hash` → это легитимно
приведёт к новому ProcessRun (старый удалён → нет `IDEMPOTENCY_KEY_REUSED`).

### Сценарий Extra — "Resume без definition check"

**Когда:** поменялся только skill/data (не код lifecycle-файла и не код модуля), но
`definition_hash` пересчитался и блокирует replay (§2.1).

**Минимальное решение (SQL, не трогая код):** перезаписать `definition_hash` и
`definition_snapshot` в существующем lifecycle_run на новые значения, **только если**
новая definition структурно совместима (те же stage_ids, те же module refs, тот же
entry). Тогда `start()` на следующем `--resume` увидит совпадение и сделает replay.

```sql
UPDATE saga3_lifecycle_runs
    SET definition_hash=:newHash, definition_snapshot=:newSnapshot, version=version+1
  WHERE id=:lr AND lifecycle_ref_key='product-delivery@1.0.0';
```

Это **единственный сценарий, где оправдана правка кода**: добавить в
`lifecycle-orchestrator.ts` (или в `start()`) "мягкий" режим, в котором расхождение
`definition_hash` не фатально, если совпадают `(lifecycle_ref_key, entry_stage_id,
stage_ids, module_refs)`. См. §5.

---

## 4. Конкретные SQL-операции cleanup (общий справочник)

### 4.1 Шаблон транзакции partial-reset

```js
db.pragma('foreign_keys = OFF');
const tx = db.transaction(() => {
  // 1. Дропнуть immutable-триггеры (ровно как reset-saga-db.mjs:89-94)
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'"
  ).all();
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);

  // 2. Stage-специфичные DELETE (см. сценарии A/B/D)

  // 3. Восстановить триггеры: НЕ делаем вручную — следующий getDb()/ensureSaga3*Schema
  //    пересоздаст их idempotently (CREATE ... IF NOT EXISTS).
});
tx();
db.pragma('foreign_keys = ON');
```

Триггеры не нужно пересоздавать вручную: `ensureSaga3ProcessRunSchema`,
`ensureManagedNodeSubmissionSchema`, `ensureExactCandidateAcceptanceSchema` и т.д. —
все с `CREATE TRIGGER IF NOT EXISTS` и вызываются при construction соответствующих
репозиториев. Следующий запуск saga-сервера / orchestrate-cli их поднимет.

### 4.2 Полная очистка одного ProcessRun (ядро для A и D)

`:pr` — process_run_id стадии. Порядок важен (RESTRICT/CASCADE):

```sql
-- 1. development-специфика (только для solution-development stage)
DELETE FROM saga3_development_integration_observations WHERE process_run_id=:pr;
DELETE FROM saga3_development_task_projections               WHERE process_run_id=:pr;
DELETE FROM saga3_development_outputs                        WHERE process_run_id=:pr;
-- 2. discovery-специфика (только для initial-discovery stage)
DELETE FROM saga3_discovery_diagnosis_reports USING ... ;   -- по control_intent → source_submission → intent → process? (нет прямой связи)
--    на практике discovery-таблицы цепляются за epic_id, чистить по epic опасно —
--    discovery-сценарий лучше решать через Сценарий A со сдвигом на formalization.
-- 3. recovery + node_runs (CASCADE, но явно — для предсказуемости)
DELETE FROM saga3_recovery_attempts
  WHERE recovery_case_id IN (SELECT id FROM saga3_recovery_cases WHERE process_run_id=:pr);
DELETE FROM saga3_recovery_cases                WHERE process_run_id=:pr;
DELETE FROM saga3_node_runs                     WHERE process_run_id=:pr;
-- 4. immutable tables (после drop триггеров)
DELETE FROM saga3_managed_node_submissions      WHERE process_run_id=:pr;
DELETE FROM saga3_exact_candidate_acceptance_items
  WHERE decision_id IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id=:pr);
DELETE FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id=:pr;
-- 5. process_run — CASCADE почистит managed_artifact/trace_productions
DELETE FROM saga3_process_runs WHERE id=:pr;
-- 6. tasks этой стадии
DELETE FROM tasks WHERE json_extract(metadata,'$.process_run_id')=:pr;
--    либо DELETE FROM tasks WHERE generation_key LIKE 'process-run:'||:pr||':node:%';
```

**Важно про managed_artifact/trace_productions:** они CASCADE'атся с process_run, но это
**история provenance** ("какой execution создал этот artifact/trace"). После удаления
process_run они осиротеют (привязка к процессу потеряна), но сами artifacts/traces в
`artifacts`/`traces` остаются. Это приемлемо: artifacts нужны development-верификации
(через exact-acceptance, которая указывает на artifact_id напрямую), а не через
managed-productions.

### 4.3 Очистка tasks — выбор критерия

Tasks-development создаются через `generation_key` вида
`process-run:<prid>:node:<nodeId>` (`sqlite-development-runtime.ts:614-619`). Два способа:

- **По `metadata.process_run_id`** (надёжнее, универсально — development, formalization
  тоже пишет этот metadata): `WHERE json_extract(metadata,'$.process_run_id')=:pr`.
- **По `generation_key`** (development-only, быстрее): `LIKE 'process-run:'||:pr||':node:%'`.

Formalization-tasks (`task_kind='formalization.prd'` и т.д.) тоже имеют
`generation_key='process-run:83:node:define-product-contract'` — поэтому `generation_key`
работает и для них. Но для формализации мы обычно НЕ хотим их сносить (Сценарий A
оставляет formalization нетронутой).

### 4.4 Откат lifecycle-курсора (общий для A/B/D)

```sql
UPDATE saga3_lifecycle_runs
    SET status='paused',
        current_stage_id=:targetStageId,
        current_stage_run_id=:targetStageRunId,
        terminal_status=NULL, error=NULL,
        execution_lease_owner=NULL, execution_lease_expires_at=NULL,
        version=version+1, updated_at=datetime('now')
  WHERE id=:lr;
```

`status='paused'` выбран намеренно: `--resume` с `resumePaused=true` сделает явный
`paused→running` через `repo.resume()` (`sqlite-lifecycle-run-repository.ts:701-719`),
что чище, чем оставлять `running` с протухшим lease (хотя оба работают).

---

## 5. Минимальные изменения в коде (если нужны)

Большинство сценариев решается **SQL без правки TS**. Изменения кода оправданы только для
эргономики и для Сценария Extra.

### 5.1 `tools/saga-reset-stage.mjs` (NEW, высокоприоритетно)

Обёртка над SQL из §4. CLI-дизайн:

```
node tools/saga-reset-stage.mjs <lifecycle_run_id> --stage=solution-development
                                                          [--dry-run] [--confirm]
node tools/saga-reset-stage.mjs <lifecycle_run_id> --node=<nodeId>
                                                          [--dry-run] [--confirm]   # Сценарий B
node tools/saga-reset-stage.mjs <lifecycle_run_id> --process-run=<prid>
                                                          [--dry-run] [--confirm]   # Сценарий D
node tools/saga-reset-stage.mjs <lifecycle_run_id> --rewind-to=<stageId>
                                                          [--dry-run] [--confirm]   # Сценарий A
```

Поведение:
1. `--dry-run` печатает (не выполняет) DELETE/UPDATE + показывает, что будет затронуто
   (counts по каждой таблице), и явно перечисляет **что останется** (artifacts count,
   acceptance decisions count — пользователь видит, что formalization-наследие цело).
2. До любой записи: проверяет `status` lifecycle_run не `completed`/`cancelled` (для
   completed rollback бессмысленен — нужен полный re-run).
3. Сбрасывает leases (§4.4), переводит в `paused`.
4. Транзакция из §4.1.
5. В конце печатает команду `--resume` для запуска.

Карта `stage_id → {module, tables-to-clean}` захардкожена из
`product-delivery-lifecycle.ts` (т.к. lifecycle-определение не хранится в БД в машино-
читаемом виде для cleanup; это нормально — stages фиксированы).

### 5.2 Resume без definition-check (Сценарий Extra, средний приоритет)

В `SqliteLifecycleRunRepository.start()` (`sqlite-lifecycle-run-repository.ts:390-395`)
заменить жёсткий `LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY` на двухуровневую проверку:

```ts
if (existing.definition_hash !== command.definitionHash) {
  // мягкий режим: сравниваем структурный скелет, а не весь snapshot
  const skelEqual = structuralSkeletonsEqual(
    JSON.parse(existing.definition_snapshot),
    JSON.parse(command.definitionSnapshot),
  );
  if (!skelEqual) {
    throw new Error(`LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY: ...`);
  }
  // скелет совпал — обновляем snapshot/hash под новый (напр., поменялся skill)
  this.db.prepare(
    `UPDATE saga3_lifecycle_runs
        SET definition_snapshot=?, definition_hash=?, version=version+1
      WHERE id=?`,
  ).run(command.definitionSnapshot, command.definitionHash, existing.id);
}
```

Где `structuralSkeletonsEqual` проверяет только: тот же `entry_stage_id`, то же
множество `stage_id` в том же порядке, те же `moduleRef` на каждый stage, те же
`outcomeRoutes` (target type + stageId/status). **Не** сравнивает `inputMapping`/
`outputMapping`/`executionProfile` — именно они меняются при правке skills и не должны
блокировать resume кода модуля.

Это закрывает самый частый триггер полного re-run: "я поправил skill, пересобрал,
definition_hash поплыл".

### 5.3 (Опц.) `--force-resume` флаг в orchestrate-cli

Добавить `--force-resume`, который эквивалентен SQL из §4.4 (сброс leases + status=paused)
перед стартом orchestrator. Это выносит Сценарий C из ручного SQL в CLI. Низкоприори-
тетно: ручной SQL тривиален, а `--resume` уже работает для протухших lease.

---

## 6. Рекомендуемый приоритет

| # | Что                                | Усилие     | Покрытие      | Почему первым |
|---|------------------------------------|------------|---------------|---------------|
| 1 | **Документировать Сценарий C**     | 0 (док)    | ~80% кейсов   | Уже работает, просто没人 не знает; живая БД именно в этом состоянии |
| 2 | **`tools/saga-reset-stage.mjs`**   | ~1 день    | A, B, D       | Закрывает все destructive-сценарии одним инструментом; `--dry-run` делает безопасным |
| 3 | **Resume без definition-check** (§5.2) | ~2 часа | Сценарий Extra | Самый частый триггер "не могу resume"; устраняет `LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY` при правке skills |
| 4 | `--force-resume` (§5.3)            | ~1 час     | эргономика C  | Сахар поверх работающего механизма |

Рекомендация: начать с **1** (текст в этот же doc, §3-C уже готов) и **2** (инструмент).
Этого достаточно, чтобы перестать делать полный `reset-saga-db.mjs`. Пункт 3 — когда
следующий раз упрётесь в definition-hash.

---

## 7. Риски

1. **Acceptance items / artifacts — нельзя трогать.** Это единственное "постоянное
   наследие". `saga3_exact_candidate_acceptance_*` имеют ABORT-триггеры и RESTRICT-FK.
   Любой cleanup должен (а) дропать триггеры, (б) удалять decisions **только** того
   process_run, который мы сносим, никогда — по artifact_id. Скрипт
   `saga-reset-stage.mjs` должен явно печатать: "acceptance decisions preserved: N,
   artifacts preserved: M".

2. **Managed-productions orphaning.** После удаления process_run, таблицы
   `saga3_managed_artifact_productions`/`saga3_managed_trace_productions` CASCADE'ся
   (исчезнут вместе с процессом). Это **стирает provenance-историю** о том, какой
   execution создал artifact. Для повторного прогона это нормально (новый process_run
   создаст свежие provenance-записи), но если кто-то рассчитывает на audit-trail
   "оригинального создания" — он потеряется. Альтернатива: перед удалением process_run
   сделать `INSERT INTO` backup-таблицу (`saga3_managed_artifact_productions_archive`).
   На первом этапе не нужно.

3. **Out-of-band worker всё ещё жив.** Если cleanup делает один оператор, а параллельно
   крутится забытый `orchestrate-cli`/воркер со старым lease — он может дописать в
   чистимый process_run. `saga-reset-stage.mjs` должен **сначала** сбросить lease и
   перевести lifecycle в `paused` (status `paused` отдаёт `acquireExecutionLease`
   `null`, `sqlite-lifecycle-run-repository.ts:1033-1040`), и только потом чистить.
   + Желательно проверять отсутствие активных worker_executions для этого epic.

4. **`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` при пересчёте stage-input.** Если
   cleanup оставил stage_run + process_run, но вы хотите сменить их вход (новый
   formalization baseline) — replay упадёт. Решение: в Сценарии A/D **удалять** process_run
   (и обнулять `stage_run.process_run_id`), чтобы orchestrator создал свежий. Это учтено
   в §3-A/D.

5. **Drift module digest.** Если правили код development-модуля — `package_digest`
   изменится, и даже свежий process_run может потребовать пере-установки пакета
   (`installProductionModules` идемпотентен по байтам, но разные байты = новая
   installation row; это ок и не блокирует). Для **resume без пере-установки** убедитесь,
   что `dist/modules/development/...` не менялся — тогда digest совпадёт и
   `installation_id`/`package_digest` в `sameInvocation` совпадут.

6. **Сценарий B и outcome-certificate.** Если settlement уже выписал
   `saga3_process_outcome_certificates` для этого process_run — node-rollback (B)
   оставит "сиротский" сертификат. Либо удалять сертификат вместе с node (теряем
   immutability-гарантию), либо подниматься на Сценарий D. Документировать в скрипте:
   "если есть certificate для process_run — сценарий B заблокирован, используй D".

7. **`saga3_module_installations` не трогаем.** `reset-saga-db.mjs:76-80` их чистит,
   но для **partial** reset этого делать нельзя — иначе все остальные stages потеряют
   pinned installation. Скрипт partial-reset должен **явно исключать** эту таблицу.

---

## Приложение A. Соответствие файлов исходников

| Что                                        | Файл |
|--------------------------------------------|------|
| Lifecycle transitions / lease / resume     | `src/process-modules/application/lifecycle-orchestrator.ts` |
| `--resume` CLI wiring                      | `src/orchestrate-cli.ts:66-69,153` |
| LifecycleRun start + definition-check      | `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts:359-449, 701-719` |
| ProcessRun idempotency + write-once        | `src/process-modules/persistence/sqlite-process-run-repository.ts:248-332, 409-556` |
| NodeRun checkpoint-resume                   | `src/process-modules/persistence/sqlite-node-run-repository.ts:272-346` |
| GenericFlowExecutor walk                    | `src/process-modules/application/generic-flow-executor.ts` |
| Recovery verify→repair loop                 | `src/process-modules/persistence/sqlite-recovery-case-repository.ts` |
| Immutable triggers (acceptance)             | `src/process-modules/persistence/sqlite-exact-candidate-acceptance.ts:187-208` |
| Immutable triggers (node submissions)       | `src/process-modules/persistence/sqlite-managed-node-submission-repository.ts:70-80` |
| Managed productions (CASCADE)               | `src/process-modules/persistence/sqlite-managed-production-ledger.ts:155-205` |
| Lifecycle definition (stage→module→nodes)   | `src/process-modules/lifecycles/product-delivery-lifecycle.ts:164-348` |
| Existing full-reset reference               | `reset-saga-db.mjs` |
| Schema (work_intents, control_intents)      | `src/schema.ts:677-725` |

## Приложение B. Живая БД (контрольный пример)

`C:/Users/user/.zcode/saga.db`, lifecycle_run **33**, epic **1**:
- `status='running'`, `current_stage_id='solution-formalization'`, lease заполнен (stale).
- StageRuns: discovery (completed, `clarify`), formalization (running).
- ProcessRuns: 82 (discovery, completed), 83 (formalization, running).
- NodeRuns: до `model-use-cases` (id 500, running — убит на середине).
- Tasks: 1–4, workflow_stage discovery/formalization, generation_key по process-run.
- Acceptance decisions: 1 (formalization product, 27 items — artifacts 2.., всё accepted).
- Work intents: discovery + formalization.* kinds.

Для Сценария C: `--resume` → Lease отбирается, node_run 500 пере-выполняется.
Для Сценария B: откат node_run 500 + task 4, process_run 83 → paused, `--resume`.
