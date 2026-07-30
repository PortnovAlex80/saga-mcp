# Artifact Snapshot/Restore — НЕ перегенерировать формализацию при каждом reset

Status: **Design**
Owner: saga-mcp architecture
Date: 2026-07-30
Связанные документы: `PARTIAL-RESET-AND-RESUME.md`, `TRACE-REPLAY-GUIDE.md`

## 0. Контекст и цель

Каждый багфикс в saga-mcp сегодня требует `reset-saga-db.mjs` и полного прогона
lifecycle. Formalization стоит **20–30 минут** и повторяется **идентично** каждый раз:
54 accepted артефакта (PRD/SRS/UC/AC/FR/NFR/RULE/brief), 669 traces, 13 node_runs,
4 exact-acceptance decisions, acceptance baseline, settlement certificate — всё это
модель создаёт заново через ~27 MCP-вызовов × 15 сек = 7+ минут на этап, плюс время
работers.

Цель: **после первого успешного прогона formalization сохранять её в JSON snapshot,
а после reset — восстанавливать в новую saga.db так, чтобы lifecycle resume сразу
продолжил с development**, минуя переигрывание формализационных nodes.

Контрольные цифры из живой БД (`C:/Users/user/.zcode/saga.db`, lifecycle_run 37,
epic 1):

| Слой | Таблицы | Строк |
|---|---|---|
| Tracker-артефакты | `artifacts` | 59 (54 accepted + 5 draft) |
| Traceability | `artifact_traces` | 669 (625 artifact→artifact, 44 artifact→task) |
| Episode state | `episode_workflows` | 1 (stage=discovery, но должно быть formalization) |
| Acceptance CAS | `saga3_exact_candidate_acceptance_decisions` + `_items` | 4 + 54 |
| Formalization baseline | `saga3_formalization_acceptance_baselines` | 1 |
| Solution contract | `saga3_formalization_solution_contracts` | 1 |
| Managed productions | `saga3_managed_artifact_productions`, `_trace_productions` | ~59, ~669 |
| Lifecycle process | `saga3_lifecycle_runs`, `_stage_runs`, `_process_runs`, `_node_runs`, `_process_transitions` | 1, 3, 3, ~30, 2 |
| Command receipts | `command_receipts` | 15 (8 tasks) |

Документы на диске НЕ теряются при reset (git workspace `C:/Temp/autism-buttons-workspace`)
— теряются только строки в БД. Поэтому snapshot фокусируется на **восстановлении строк БД**,
используя уже лежащие на диске `.md` файлы как source-of-truth для content_hash.

---

## 1. Что блокирует простой подход, и почему нужен full-snapshot

### 1.1 Gates формализации, которые надо удовлетворить

`handleEpisodeTransition` (`src/tools/lifecycle.ts:287-313`) для `formalization→planning`
требует одновременного выполнения:

1. **`assertTasksReady(epicId, 'formalization')`** — есть `tasks` с `workflow_stage='formalization'`,
   `status='done'` (исключая `summary.stage`/`recovery.heal`).
2. **`assertTraceability(epicId)`** (`:130-225`) — canonical edges в `artifact_traces`:
   - PRD → brief (`derived_from`)
   - SRS → PRD (`derived_from`)
   - каждый UC → PRD (`derived_from`) И ≥1 FR (`covers`)
   - каждый AC → ≥1 FR/NFR (`derived_from`), FR-derived ACs → ≥1 UC (`derived_from`)
3. **`acceptedBaseline(epicId)`** (`:60-84`) — все AC эпика:
   - `status='accepted'`, `accepted_hash IS NOT NULL`, `content_hash IS NOT NULL`
   - `accepted_hash = content_hash`, `drift_state='clean'`
4. `episode_workflows.stage = 'formalization'` (чтобы переход был валиден).

→ Вывод: одного восстановления `artifacts+traces` недостаточно. Нужен **full skip**:
восстанавливать и формализационные tasks, и сам `episode_workflows.stage`, и acceptance
state. Это и согласовано с выбором scope "Full skip".

### 1.2 Settlement ядра и immutable-таблицы

Даже если восстановить artifacts/traces/tasks и перевести episode в `planning`, lifecycle
оркестратор при `--resume` не «перепрыгнет» formalization stage_run — он будет искать
существующий `saga3_stage_runs` со статусом `completed` и `local_outcome='formalized'`,
и `saga3_process_transitions` с handoff-snapshot, передающим formalized-outcome в development.
Иначе оркестратор создаст **новый** formalization stage_run и **переиграет** его.

Поэтому snapshot обязан включать saga3-process-слой: `lifecycle_runs`, `stage_runs`,
`process_runs`, `node_runs`, `process_transitions` формализационной части. А т.к. эти
таблицы ссылаются на immutable-таблицы (`exact_candidate_acceptance_*`, `managed_node_submissions`,
`formalization_acceptance_baselines`) с `BEFORE DELETE/UPDATE RAISE(ABORT)`-триггерами —
restore должен сначала дропнуть триггеры (как `reset-saga-db.mjs:89-94`), вставить
immutable-строки напрямую, и позволить `getDb()` пересоздать триггеры `IF NOT EXISTS`.

### 1.3 content_hash — disk-as-truth

`artifactDiskHash` (`src/helpers/artifact-file.ts:6-31`) пересчитывает SHA-256 из файла
на диске по `path` относительно `project_repositories.local_path`. Документы в git workspace
после reset **идентичны** (git их не трогает) → content_hash восстанавливается автоматически.
Значит snapshot'у достаточно сохранить **логическое содержимое** артефакта (code+type+path),
а content_hash можно перещитать из диска на restore — это и проверка целостности бесплатно.

---

## 2. Архитектура: sidecar в `src/infrastructure/testing`

Точно как `test-warm-start.ts` (draft documents) и как задуманный `test-trace-cache.ts`
(`TRACE-REPLAY-GUIDE.md`): snapshot/restore — это **infrastructure sidecar**, активируемый
env-переменной, не трогающий production kernel/settlement/acceptance CAS **код**. Он пишет в
те же таблицы через тот же `better-sqlite3` handle (`getDb()`), но минуя MCP-инструменты
(прямые INSERT).

### 2.1 Файлы

| Файл | Назначение |
|---|---|
| `src/infrastructure/testing/artifact-snapshot.ts` | `captureArtifactSnapshot(db, epicId, snapshotDir)` и `restoreArtifactSnapshot(db, epicId, snapshotDir)` |
| `tools/saga-snapshot.mjs` | CLI: `node tools/saga-snapshot.mjs <epic_id> capture [--out=...]` / `restore [--in=...]` |
| `.saga/artifact-snapshots/epics/<epicId>/snapshot.json` | сам snapshot (sidecar, как draft-cache) |

### 2.2 Активация

- Capture: явно `saga-snapshot.mjs <epic> capture` после успешной формализации
  (либо хуком в `orchestrate-cli` после settle-formalization — см. §5.1).
- Restore: env `SAGA_ARTIFACT_SNAPSHOT=<path>` + `saga-snapshot.mjs <epic> restore`
  **после** `reset-saga-db.mjs`, **до** запуска `orchestrate-cli`.
- Fail-closed: нет snapshot → restore no-op → lifecycle работает с нуля.

---

## 3. Точная схема snapshot файла (JSON)

```jsonc
{
  "schemaVersion": "saga3.artifact-snapshot.v1",
  "capturedAt": "2026-07-30T18:00:00.000Z",
  "epicId": 1,
  "lifecycleRefKey": "product-delivery@1.0.0",
  "formalizationModuleRef": "solution-formalization@1.0.0",
  "packageDigest": "3c665f4429f9290082d8e4d5c98c1be72af2dc52730da837dc8a4c09b148e2f4",

  // 3.1 — Tracker-слой (логические ключи, не volatile id)
  "project": {
    "name": "Autism-Button-Library-GLM",
    "description": "...",
    "status": "active",
    "tags": []
  },
  "projectRepository": {
    "name": "autism-buttons-workspace",
    "remoteUrl": null,
    "localPath": "C:/Temp/autism-buttons-workspace",
    "defaultBranch": "main",
    "integrationBranch": "main",
    "role": "primary",
    "docsRoot": null
  },
  "epic": {
    "name": "Discovery Autism Buttons GLM-4.7",
    "description": "...",
    "status": "planned",
    "priority": "medium",
    "branch": null,
    "tags": []
  },
  "episodeWorkflow": {
    "stage": "formalization",
    "track": "formal",
    "baselineArtifactCode": null,
    "baselineHash": null,
    "metadata": {}
  },

  // Артефакты: id НЕТ (volatile). Логический ключ = (type, code).
  // Для code-less артефактов (единичные PRD/SRS/brief) ключ = (type, path).
  // parent_ref — это {type, code} или {type, path}, НЕ id.
  "artifacts": [
    {
      "ref": { "type": "PRD", "code": null, "path": "docs/.../00-PRD.md" },
      "title": "Hex Button Autism UI Component Library PRD",
      "status": "accepted",
      "contentHash": "c37bf34336f1312392f671004c183a9d7a726c2a9f688ea3387e19e5449bfa29",
      "acceptedHash": "c37bf34336f1312392f671004c183a9d7a726c2a9f688ea3387e19e5449bfa29",
      "driftState": "clean",
      "evidenceStatus": null,
      "tags": [],
      "metadata": { "...provenance сохраняется, но task_id/process_run_id ОБНУЛЯЮТСЯ..." },
      "parentRef": null
    }
    // ...54 accepted + 5 draft
  ],

  // Traces: source/target по ref, не по id.
  // target может быть artifact-ref ИЛИ task-kind+generationKey (для implements/depends_on).
  "traces": [
    {
      "sourceRef": { "type": "AC", "code": "AC-1" },
      "target": { "kind": "artifact", "ref": { "type": "FR", "code": "FR-1" } },
      "linkType": "derived_from"
    },
    {
      "sourceRef": { "type": "AC", "code": "AC-1" },
      "target": { "kind": "task", "taskKind": "development.code", "generationKey": "process-run:95:node:execute-implementation-workset" },
      "linkType": "implements"
    }
    // ...669
  ],

  // 3.2 — Формализационные tasks (нужно для assertTasksReady gate)
  // generationKey — стабильный логический ключ (не volatile id).
  "formalizationTasks": [
    {
      "title": "Define product contract (PRD)",
      "taskKind": "formalization.prd",
      "workflowStage": "formalization",
      "status": "done",
      "priority": "medium",
      "executionSkill": "saga-product",
      "reviewSkill": "saga-requirements-reviewer",
      "executionMode": "tracker_only",
      "generationKey": "process-run:94:node:define-product-contract",
      "tags": ["role:product"],
      "metadata": { "process_node_id": "define-product-contract", "...": "..." },
      "sourceArtifactRefs": [],
      "verificationTargetArtifactRef": null
    }
    // ...по одной на формализационный node
  ],

  // 3.3 — Acceptance CAS (immutable). Восстанавливается КАК ЕСТЬ — те же hashes.
  // idempotency_key и decision_hash детерминированы, переcоздание безопасно.
  "acceptanceDecisions": [
    {
      "schemaVersion": "saga3.exact-candidate-acceptance.v1",
      "idempotencyKey": "formalization-product-gate:pr94:node:define-product-contract",
      "requestHash": "...",
      "requestSnapshot": "{...}",   // ПОЛНЫЙ snapshot запроса (для replay-detector)
      "candidateSetHash": "...",
      "nodeId": "define-product-contract",
      "taskIdGenerationKey": "process-run:94:node:define-product-contract",
      "reviewRequired": false,
      "authority": "formalization-product-gate@1",
      "reasonCode": "FORMALIZATION_PRODUCT_VALIDATED",
      "decisionHash": "...",
      "items": [
        {
          "ordinal": 0,
          "artifactRef": { "type": "PRD", "code": null, "path": "docs/.../00-PRD.md" },
          "artifactType": "PRD",
          "expectedContentHash": "c37bf3...",
          "disposition": "accepted",
          "priorStatus": "draft",
          "priorAcceptedHash": null,
          "priorDriftState": "unknown",
          "finalStatus": "accepted",
          "finalAcceptedHash": "c37bf3...",
          "finalDriftState": "clean"
        }
        // ...по item на candidate артефакт
      ]
    }
    // ...4 decisions (product/use-case/acceptance/architecture gates)
  ],

  // 3.4 — Formalization baseline (saga3_formalization_acceptance_baselines)
  // payload + hashes сохраняются КАК ЕСТЬ; processRunId перепривязывается.
  "acceptanceBaseline": {
    "schemaVersion": "saga3.acceptance-baseline-snapshot.v1",
    "payload": "{...полный JSON baseline payload...}",
    "baselineHash": "4ee01b2547cb4629a7aab5a821f9e2b2096a0cb0f71bebb1bbc34828d607020d",
    "snapshotHash": "c4d6d62ade75e143f8ead969384a12f68acf20d3e105ef7926883e40a67af9f5"
  },

  // 3.5 — Solution contract (передаётся в development как формализационный выход)
  "solutionContract": {
    "schemaVersion": "saga3.solution-contract-certificate.v1",
    "payload": "{...полный JSON contract payload...}",
    "contentHash": "3834a3c7413ae85a17bade1df767a8c5ba5c802e9935131244b54f5fe3e2f394"
  },

  // 3.6 — saga3 process-слой формализации (нужен оркестратору для skip)
  // discovery-стейдж ТОЖЕ snapshot'ится — он предшествует formalization и его
  // certificate (discovery-certificate) входит в solution-contract handoff.
  "processLayer": {
    "lifecycleRun": {
      "lifecycleName": "product-delivery",
      "lifecycleVersion": "1.0.0",
      "lifecycleRefKey": "product-delivery@1.0.0",
      "definitionSnapshot": "{...полный LifecycleDefinition JSON...}",
      "definitionHash": "2ea303...",
      "initiatedBy": "orchestrate-cli",
      "idempotencyKey": "product-delivery:epic:1",
      "inputSchema": "saga3.product-delivery-lifecycle-input.v1",
      "inputSnapshot": "{...lifecycle input JSON...}",
      "inputHash": "95ae5d9c..."
    },
    // stages ДО и ВКЛЮЧАЯ formalization; development НЕ включается (он переигрывается)
    "stages": [
      {
        "ordinal": 1,
        "stageId": "initial-discovery",
        "moduleName": "product-discovery",
        "moduleVersion": "3.0.2",
        "moduleRefKey": "product-discovery@3.0.2",
        "bindingSnapshot": "{...}",
        "bindingHash": "...",
        "inputSchema": "saga3.discovery-case.v1",
        "inputSnapshot": "{...}",
        "inputHash": "...",
        "status": "completed",
        "localOutcome": "clarify",
        "processRun": {
          "idempotencyKey": "lifecycle:37:stage-run:77",
          "executorKind": "generic-flow",
          "inputSchema": "saga3.discovery-case.v1",
          "inputSnapshot": "{...}",
          "inputHash": "...",
          "projectedStage": "discovery",
          "status": "completed",
          "localOutcome": "clarify",
          "certificateSchema": "saga3.discovery-outcome-certificate.v1",
          "certificateRef": "discovery-certificate:63",
          "certificateHash": "a7426d13...",
          "authority": "discovery_settlement_policy"
        }
      },
      {
        "ordinal": 2,
        "stageId": "solution-formalization",
        "moduleName": "solution-formalization",
        "moduleVersion": "1.0.0",
        "moduleRefKey": "solution-formalization@1.0.0",
        // ...аналогично, status=completed, localOutcome='formalized'
        "processRun": {
          "idempotencyKey": "lifecycle:37:stage-run:78",
          "status": "completed",
          "localOutcome": "formalized",
          "certificateSchema": "saga3.solution-contract-certificate.generic.v1",
          "certificateRef": "certificate:13",
          "certificateHash": "fc8388da...",
          "outputSchema": "saga3.solution-contract-certificate.v1",
          "outputRef": "formalization-solution-contract:7",
          "outputHash": "3834a3c7...",
          "authority": "formalization_settlement_policy"
        }
      }
    ],
    // transitions: хранят handoff_snapshot — это уже готовый «кусок» БД,
    // ссылается на certificate refs (стабильны), не на id.
    "transitions": [
      {
        "ordinal": 1,
        "transitionKey": "lifecycle:37:stage-run:77:outcome",
        "outcome": "clarify",
        "targetType": "stage",
        "targetStageId": "solution-formalization",
        "handoffSnapshot": "{...полный JSON...}",
        "handoffHash": "b41ec83b...",
        "decisionHash": "58573b6f..."
      },
      {
        "ordinal": 2,
        "transitionKey": "lifecycle:37:stage-run:78:outcome",
        "outcome": "formalized",
        "targetType": "stage",
        "targetStageId": "solution-development",
        "handoffSnapshot": "{...включает acceptanceCriteria artifactIds — переписываются...}",
        "handoffHash": "982885001...",
        "decisionHash": "b6669898..."
      }
    ],
    // minimal node_runs (для checkpoint-resume детектора; полный envelope не нужен,
    // т.к. stage уже completed и не переигрывается)
    "nodeRuns": [
      { "stageOrdinal": 2, "nodeId": "define-product-contract", "nodeKind": "managed", "status": "completed", "attempt": 1 }
      // ...13 формализационных nodes
    ]
  },

  // 3.7 — Checksum целостности snapshot'а
  "snapshotHash": "sha256 канонического JSON всего вышестоящего (без самого поля)"
}
```

### 3.8 Почему ref, а не id

- `id` — autoincrement, **меняется** после reset (sequence сбрасывается в
  `reset-saga-db.mjs:111`).
- `(type, code)` — код артефакта (AC-1, FR-3) **стабилен** между прогонами: draft-cache
  возвращает идентичные `.md` → worker перевыпускает с тем же code (см.
  `TRACE-REPLAY-GUIDE.md` §«Почему code — стабильный ключ»).
- Для code-less артефактов ключ = `(type, path)`. PRD/SRS/brief — единственные в эпике,
  их path стабилен (git workspace не меняется).
- `generationKey` задач (`process-run:<prid>:node:<nodeId>`) **почти** стабилен —
  `prid` меняется, но мы контролируем вставку process_run и можем присвоить **тот же**
  id через явный INSERT (см. §4.6). Поэтому generationKey можно сохранить дословно.

---

## 4. SQL операции

### 4.1 Snapshot — SELECT (read-only, в одной транзакции)

Все SELECT параметризованы `:epicId`, `:formalizationProcessRunId` (вычисляется).

```sql
-- Эпик, проект, репозиторий
SELECT * FROM epics WHERE id=:epicId;
SELECT * FROM projects WHERE id=(SELECT project_id FROM epics WHERE id=:epicId);
SELECT pr.*, r.name AS repo_name FROM project_repositories pr
  JOIN repositories r ON r.id=pr.repository_id
  WHERE pr.project_id=(SELECT project_id FROM epics WHERE id=:epicId)
    AND pr.status='active';
SELECT * FROM episode_workflows WHERE epic_id=:epicId;

-- Артефакты эпика (включая draft — формализация их создала, gates их не требуют, но
-- development может ссылаться). parent_artifact_id → ref join по artifacts.
SELECT * FROM artifacts WHERE epic_id=:epicId ORDER BY id;

-- Traces: target_type='artifact' → резолвим target_id через artifacts;
--         target_type='task'      → через tasks по generation_key.
SELECT t.*, a.type AS src_type, a.code AS src_code, a.path AS src_path,
       CASE WHEN t.target_type='artifact'
            THEN (SELECT type FROM artifacts WHERE id=t.target_id)
            ELSE NULL END AS tgt_type,
       CASE WHEN t.target_type='artifact'
            THEN (SELECT code FROM artifacts WHERE id=t.target_id)
            ELSE NULL END AS tgt_code,
       CASE WHEN t.target_type='artifact'
            THEN (SELECT path FROM artifacts WHERE id=t.target_id)
            ELSE NULL END AS tgt_path,
       CASE WHEN t.target_type='task'
            THEN (SELECT generation_key FROM tasks WHERE id=t.target_id)
            ELSE NULL END AS tgt_generation_key,
       CASE WHEN t.target_type='task'
            THEN (SELECT task_kind FROM tasks WHERE id=t.target_id)
            ELSE NULL END AS tgt_task_kind
  FROM artifact_traces t
  JOIN artifacts a ON a.id=t.source_id
  WHERE a.epic_id=:epicId
  ORDER BY t.source_id, t.link_type;

-- Формализационные tasks
SELECT * FROM tasks
  WHERE epic_id=:epicId AND workflow_stage='formalization'
  ORDER BY id;

-- Формализационный process_run + его stage_run
SELECT sr.* FROM saga3_stage_runs sr
  WHERE sr.lifecycle_run_id=:lifecycleRunId
    AND sr.stage_id IN ('initial-discovery','solution-formalization')
  ORDER BY sr.ordinal;
SELECT pr.* FROM saga3_process_runs pr
  WHERE pr.id IN (SELECT process_run_id FROM saga3_stage_runs
                   WHERE lifecycle_run_id=:lifecycleRunId
                     AND stage_id IN ('initial-discovery','solution-formalization'));

-- Node_runs формализации (для checkpoint-resume детектора)
SELECT * FROM saga3_node_runs
  WHERE process_run_id=:formalizationProcessRunId ORDER BY id;

-- Lifecycle run + definition snapshot
SELECT * FROM saga3_lifecycle_runs WHERE epic_id=:epicId ORDER BY id DESC LIMIT 1;

-- Transitions (handoff snapshots)
SELECT * FROM saga3_process_transitions
  WHERE lifecycle_run_id=:lifecycleRunId
    AND from_stage_run_id IN (SELECT id FROM saga3_stage_runs
                               WHERE lifecycle_run_id=:lifecycleRunId
                                 AND stage_id IN ('initial-discovery','solution-formalization'))
  ORDER BY id;

-- Acceptance CAS формализации
SELECT * FROM saga3_exact_candidate_acceptance_decisions
  WHERE process_run_id=:formalizationProcessRunId;
SELECT i.*, d.node_id AS node_id, d.task_id AS task_id
  FROM saga3_exact_candidate_acceptance_items i
  JOIN saga3_exact_candidate_acceptance_decisions d ON d.id=i.decision_id
  WHERE d.process_run_id=:formalizationProcessRunId
  ORDER BY i.decision_id, i.ordinal;

-- Formalization baseline + solution contract
SELECT * FROM saga3_formalization_acceptance_baselines WHERE process_run_id=:formalizationProcessRunId;
SELECT * FROM saga3_formalization_solution_contracts WHERE process_run_id=:formalizationProcessRunId;

-- Managed productions формализации (provenance audit trail; опционально — без них
-- development работает, но теряется «какой execution создал artifact»)
SELECT * FROM saga3_managed_artifact_productions WHERE process_run_id=:formalizationProcessRunId;
SELECT * FROM saga3_managed_trace_productions   WHERE process_run_id=:formalizationProcessRunId;
```

`lifecycleRunId` и `formalizationProcessRunId` определяются так:

```sql
SELECT id FROM saga3_lifecycle_runs WHERE epic_id=:epicId ORDER BY id DESC LIMIT 1;
SELECT pr.id FROM saga3_process_runs pr
  JOIN saga3_stage_runs sr ON sr.process_run_id=pr.id
  WHERE sr.lifecycle_run_id=:lifecycleRunId AND sr.stage_id='solution-formalization';
```

### 4.2 Restore — порядок INSERT (одна транзакция, FK off, triggers dropped)

Полностью повторяет транзакционный шаблон из `reset-saga-db.mjs:84-113` и
`PARTIAL-RESET-AND-RESUME.md` §4.1:

```js
db.pragma('foreign_keys = OFF');
const tx = db.transaction(() => {
  // 1. Дропнуть immutable-триггеры (ровно как reset-saga-db.mjs:89-94)
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'"
  ).all();
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);

  // 2. Убедиться, что целевая БД пуста для этого эпика (restore идемпотентен
  //    только поверх чистой БД; если эпик уже есть — abort с явной ошибкой).
  const existing = db.prepare('SELECT 1 FROM epics WHERE id=?').get(snapshot.epicId);
  if (existing) throw new Error(`ARTIFACT_SNAPSHOT_RESTORE_TARGET_NOT_EMPTY: epic ${snapshot.epicId} already exists; reset-saga-db first`);

  // 3. Восстановить project / repository / epic (см. §4.3)
  // 4. Восстановить artifacts с id-remapping (см. §4.4)
  // 5. Восстановить traces (см. §4.5)
  // 6. Восстановить formalization tasks (см. §4.5b)
  // 7. Восстановить saga3 process layer (см. §4.6)
  // 8. Восстановить acceptance CAS (см. §4.7)
  // 9. Перевести episode_workflows.stage = 'formalization' (см. §4.8)
  // 10. Триггеры НЕ пересоздаём вручную — следующий getDb() сделает CREATE IF NOT EXISTS.
});
tx();
db.pragma('foreign_keys = ON');
```

### 4.3 project / repository / epic — с id preservation

Чтобы все будущие строки (artifacts, tasks, saga3_*) могли сохранить свои id,
**восстанавливаем projects/epics с теми же id** через явный INSERT id. После
`reset-saga-db.mjs:111` sequences сброшены, новые id будут начинаться с 1 —
конфликта нет.

```sql
-- project
INSERT INTO projects (id, name, description, status, tags, metadata, created_at, updated_at)
  VALUES (:id, :name, :description, :status, :tagsJson, :metadataJson, :capturedAt, :capturedAt);
-- repository (parent of project_repositories)
INSERT INTO repositories (id, name, remote_url, default_branch, metadata, created_at, updated_at)
  VALUES (:repoId, :repoName, :remoteUrl, :defaultBranch, '{}', :capturedAt, :capturedAt);
-- project_repository
INSERT INTO project_repositories (id, project_id, repository_id, role, local_path,
                                  integration_branch, docs_root, status, metadata,
                                  created_at, updated_at)
  VALUES (:prId, :projectId, :repoId, :role, :localPath, :integrationBranch,
          :docsRoot, 'active', '{}', :capturedAt, :capturedAt);
-- epic
INSERT INTO epics (id, project_id, name, description, status, priority, sort_order,
                   branch, tags, metadata, created_at, updated_at)
  VALUES (:id, :projectId, :name, :description, :status, :priority, 0,
          :branch, :tagsJson, :metadataJson, :capturedAt, :capturedAt);
```

`sqlite_sequence` обновляем явно, чтобы новые AUTOINCREMENT не коллизили:

```sql
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  VALUES ('projects', MAX(:projectId, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='projects'),0)));
-- аналогично для repositories, epics, project_repositories
```

### 4.4 artifacts — INSERT с id preservation + disk-hash verify

Сохраняем исходные `id` (чтобы parent_artifact_id, trace.source_id, acceptance
items.artifact_id, handoff-snapshot artifactIds остались валидны — никакого remapping).

```sql
INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status,
                       parent_artifact_id, project_repository_id, content_hash,
                       accepted_hash, drift_state, evidence_status, tags, metadata,
                       created_at, updated_at)
  VALUES (:id, :projectId, :epicId, :type, :code, :title, :path, :status,
          :parentArtId, :prId, :diskHash, :acceptedHash, :driftState,
          :evidenceStatus, :tagsJson, :metadataJson, :capturedAt, :capturedAt);
```

**Verify pass** (после вставки, для accepted артефактов):

```js
const diskHash = artifactDiskHash(db, artifact.path, artifact.project_repository_id);
if (artifact.status === 'accepted') {
  if (diskHash !== artifact.acceptedHash) {
    throw new Error(
      `ARTIFACT_SNAPSHOT_DRIFT: ${artifact.type} ${artifact.code ?? ''} ` +
      `path=${artifact.path}: disk hash ${diskHash} ≠ snapshot acceptedHash ${artifact.acceptedHash}. ` +
      `Документ на диске изменился; переснимите snapshot или верните файл.`
    );
  }
}
```

`metadata` артефактов содержит provenance (`task_id`, `process_run_id`, `work_intent_id`,
`execution_id`, `node_id`, `process_module_ref`). Эти id **перепривязываются** (см. §4.6):
`task_id` → новый id формализационной task, `process_run_id` → новый id saga3_process_run.
Для restore это критично: saga3 settlement при replay сверяет lineage (см.
`assertLineage` в `sqlite-exact-candidate-acceptance.ts`). Поэтому metadata должна
содержать **новые** id.

### 4.5 artifact_traces — INSERT с remapping только для task-targets

artifact→artifact traces: source_id и target_id уже валидны (artifact id сохранён).

```sql
INSERT OR IGNORE INTO artifact_traces (source_id, target_type, target_id, link_type, created_at)
  VALUES (:sourceId, 'artifact', :targetId, :linkType, :capturedAt);
```

artifact→task traces: target_id = task id. Task id сохраняем (§4.5b), но только для
**формализационных** tasks (планировщик ещё не запускался → development tasks отсутствуют
в snapshot). Это значит: на момент snapshot'а **development tasks ещё не созданы**,
и artifact→task traces с `link_type='implements'`/`'depends_on'` **отсутствуют**.

Из живой БД: 44 artifact→task traces существуют, потому что development stage уже
запущен. **Вывод**: snapshot формализации нужно делать **до** старта development
(`stage='formalization'`, development stage_run ещё не создан). Тогда артефакт→task
traces в snapshot не попадают, и remapping для tasks тривиален. Если же development уже
зашёл — snapshot формализации всё равно валиден (он про формализацию), но development
traces будут потеряны (development пересоздаёт их сам). См. §6.4.

### 4.5b formalization tasks — INSERT с id preservation

```sql
INSERT INTO tasks (id, epic_id, title, description, status, priority, sort_order,
                   task_kind, workflow_stage, execution_skill, review_skill,
                   execution_mode, project_repository_id, generation_key, tags, metadata,
                   current_execution_id, integrated_at, integrated_commit,
                   created_at, updated_at)
  VALUES (:id, :epicId, :title, :description, 'done', :priority, :sortOrder,
          :taskKind, 'formalization', :execSkill, :reviewSkill, :execMode,
          :prId, :genKey, :tagsJson, :metadataJson,
          NULL, NULL, NULL, :capturedAt, :capturedAt);
```

`metadata` содержит `process_node_id`, `process_run_id` (волатильный — см. §4.6), `project_repository_id`.
`generation_key='process-run:<prid>:node:<nodeId>'` — `prid` сохраняем как есть (§4.6 вставит process_run с тем же id).

### 4.6 saga3 process layer — INSERT с id preservation

Здесь самое деликатное: saga3 таблицы имеют много cross-FK и id поля. Стратегия —
**сохранить все saga3 id дословно** (id, stage_run_id, process_run_id, node_run_id),
чтобы handoff-snapshots (которые ссылаются на эти id) остались валидны без patching.

```sql
-- saga3_module_installations: НЕ трогаем. installProductionModules в orchestrate-cli
-- переустановит пакеты идемпотентно (тот же package_digest → тот же installation_id).
-- Snapshot хранит packageDigest только для gate-проверки перед restore.

-- lifecycle_run
INSERT INTO saga3_lifecycle_runs (id, lifecycle_name, lifecycle_version, lifecycle_ref_key,
    display_name, description, definition_snapshot, definition_hash, project_id, epic_id,
    initiated_by, idempotency_key, input_schema, input_snapshot, input_hash, status,
    entry_stage_id, current_stage_id, current_stage_run_id, terminal_status, version,
    started_at, completed_at, created_at, updated_at)
  VALUES (:id, :name, :version, :refKey, :displayName, :desc, :defSnapshot, :defHash,
          :projectId, :epicId, :initBy, :idempKey, :inputSchema, :inputSnap, :inputHash,
          'paused',   -- НЕ running: --resume с resumePaused подхватит и продолжит с development
          'initial-discovery', :formalizationStageRunId, NULL, 1,
          :capturedAt, NULL, :capturedAt, :capturedAt);
-- execution_lease_* = NULL (нет активного holder после reset)

-- stage_runs (только discovery + formalization; development НЕ вставляем)
INSERT INTO saga3_stage_runs (id, lifecycle_run_id, ordinal, stage_id, attempt,
    module_name, module_version, module_ref_key, binding_snapshot, binding_hash,
    input_schema, input_snapshot, input_hash, status, process_run_id, local_outcome,
    authority, output_schema, output_ref, output_hash, certificate_schema,
    certificate_ref, certificate_hash, mapped_output_snapshot, result_snapshot,
    started_at, completed_at, created_at, updated_at)
  VALUES (...);

-- process_runs (id preserved; installation_id/package_digest БУДУТ другие после reinstall —
-- см. §6.2)
INSERT INTO saga3_process_runs (id, project_id, epic_id, module_name, module_version,
    module_ref_key, idempotency_key, executor_kind, input_schema, input_snapshot, input_hash,
    projected_stage, status, local_outcome, output_schema, output_ref, output_hash,
    certificate_schema, certificate_ref, certificate_hash, executor_run_ref, error,
    started_at, completed_at, created_at, updated_at, authority)
  VALUES (...);
-- installation_id/package_digest обновляем ОТДЕЛЬНЫМ UPDATE после installProductionModules
-- (см. §6.2): они входят в sameInvocation-проверку replay, поэтому должны совпадать.

-- node_runs (минимальный набор полей для checkpoint-resume)
INSERT INTO saga3_node_runs (id, process_run_id, node_id, node_kind, attempt, status,
    event, started_at, completed_at, node_ref, package_ref, definition_digest,
    transition_cursor)
  VALUES (...);

-- process_transitions (handoff snapshots — САМОЕ ЦЕННОЕ; содержат acceptanceCriteria,
-- traceIds, certificateRefs, baselineSnapshotRef; id дословно)
INSERT INTO saga3_process_transitions (id, lifecycle_run_id, from_stage_run_id,
    transition_key, outcome, target_type, target_stage_id, terminal_status,
    to_stage_run_id, handoff_snapshot, handoff_hash, decision_hash, created_at)
  VALUES (...);
```

**Важно**: `current_stage_id='initial-discovery'` + `current_stage_run_id=<formalization stage_run id>`
+ `status='paused'` — это позиция «формализация завершена, ждём resume, чтобы оркестратор
увидел completed formalization-stage и создал development-stage по outcomeRoutes.formalized».
Это сценарий A из `PARTIAL-RESET-AND-RESUME.md`, применённый к snapshot-restore.

### 4.7 Acceptance CAS + baseline + solution contract — INSERT дословно

Immutable-таблицы. Триггеры дропнуты (§4.2 шаг 1), вставляем напрямую:

```sql
-- decisions
INSERT INTO saga3_exact_candidate_acceptance_decisions (id, schema_version, idempotency_key,
    request_hash, request_snapshot, candidate_set_hash, process_run_id, module_ref, node_id,
    intent_id, task_id, execution_id, project_id, epic_id, review_required,
    producer_receipt_command_id, producer_receipt_hash, review_receipt_command_id,
    review_receipt_hash, authority, reason_code, decision_hash, decided_at)
  VALUES (...);
-- task_id здесь — НОВЫЙ id формализационной task (сохранён в §4.5b).
-- process_run_id — НОВЫЙ id saga3_process_run (сохранён в §4.6).
-- intent_id — saga3_work_intents.id; НЕ snapshot'ится (см. §6.3). ОСТАВЛЯЕМ ИЗ SNAPSHOT
--   дословно — work_intent не воссоздаётся, но acceptance decision ссылается на него;
--   dangling FK на work_intent допустим (work_intent не рестартует).

-- items
INSERT INTO saga3_exact_candidate_acceptance_items (id, decision_id, ordinal, artifact_id,
    artifact_type, expected_content_hash, ledger_id, disposition, prior_status,
    prior_accepted_hash, prior_drift_state, final_status, final_accepted_hash,
    final_drift_state)
  VALUES (...);
-- artifact_id — сохранённый id артефакта (§4.4). ledger_id — managed_artifact_productions.id;
--   если managed productions НЕ реставрированы (опц.), ставим NULL — settlement при replay
--   не сверяет ledger_id, только artifact_id+hash.

-- formalization baseline (immutable, UNIQUE on snapshot_hash)
INSERT INTO saga3_formalization_acceptance_baselines (id, process_run_id,
    formalization_epic_id, schema_version, payload, baseline_hash, snapshot_hash, created_at)
  VALUES (...);
-- process_run_id — сохранённый id saga3_process_run.

-- solution contract (immutable, UNIQUE on content_hash)
INSERT INTO saga3_formalization_solution_contracts (id, process_run_id,
    formalization_epic_id, schema_version, payload, content_hash, created_at)
  VALUES (...);
```

### 4.8 episode_workflows — перевести в formalization

```sql
INSERT INTO episode_workflows (epic_id, stage, track, baseline_artifact_id, baseline_hash,
                               metadata, created_at, updated_at)
  VALUES (:epicId, 'formalization', 'formal', NULL, NULL, '{}', :capturedAt, :capturedAt);
```

`baseline_artifact_id` / `baseline_hash` оставляем NULL — они выставляются только при
`formalization→planning` переходе (`handleEpisodeTransition:308-313`). На restore мы
**оставляем эпизод в formalization**, и `--resume` оркестратора сам доведёт переход
`formalization→planning` через нормальный путь (он увидит completed formalization
stage_run, вызовет episode_transition, пройдет gates, выставит baseline). Это чище,
чем подделывать baseline вручную.

### 4.9 sqlite_sequence — финальная подстройка

После всех INSERT:

```sql
INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES
  ('projects',      (SELECT MAX(id) FROM projects)),
  ('repositories',  (SELECT MAX(id) FROM repositories)),
  ('project_repositories', (SELECT MAX(id) FROM project_repositories)),
  ('epics',         (SELECT MAX(id) FROM epics)),
  ('artifacts',     (SELECT MAX(id) FROM artifacts)),
  ('tasks',         (SELECT MAX(id) FROM tasks)),
  ('artifact_traces',(SELECT MAX(id) FROM artifact_traces)),
  ('saga3_lifecycle_runs', (SELECT MAX(id) FROM saga3_lifecycle_runs)),
  ('saga3_stage_runs',     (SELECT MAX(id) FROM saga3_stage_runs)),
  ('saga3_process_runs',   (SELECT MAX(id) FROM saga3_process_runs)),
  ('saga3_node_runs',      (SELECT MAX(id) FROM saga3_node_runs)),
  ('saga3_process_transitions', (SELECT MAX(id) FROM saga3_process_transitions)),
  ('saga3_exact_candidate_acceptance_decisions', (SELECT MAX(id) FROM saga3_exact_candidate_acceptance_decisions)),
  ('saga3_exact_candidate_acceptance_items', (SELECT MAX(id) FROM saga3_exact_candidate_acceptance_items)),
  ('saga3_formalization_acceptance_baselines', (SELECT MAX(id) FROM saga3_formalization_acceptance_baselines)),
  ('saga3_formalization_solution_contracts', (SELECT MAX(id) FROM saga3_formalization_solution_contracts));
```

---

## 5. Куда встроить в flow

### 5.1 Capture — после settle-formalization

**Вариант A (рекомендуемый, 0 кода в production path):** явный CLI после формализации.

```bash
# После того как formalization stage показал status=completed + localOutcome=formalized:
node tools/saga-snapshot.mjs 1 capture \
  --out=C:/Temp/autism-buttons-workspace/.saga/artifact-snapshots/epics/1/snapshot.json
git add .saga/artifact-snapshots/   # snapshot живёт в git workspace, версионный
git commit -m "snapshot: formalization epic 1"
```

**Вариант B (хук в orchestrate-cli):** после `settle-formalization` node, если
`SAGA_ARTIFACT_SNAPSHOT_DIR` задан — вызвать `captureArtifactSnapshot` в `finally`.
Не рекомедуется: добавляет код в production path, риск side-effect на стабильный run.

### 5.2 Restore — после reset, до lifecycle

```bash
# 1. Сбросить БД (существующий скрипт)
node reset-saga-db.mjs

# 2. Восстановить snapshot формализации
DB_PATH=C:/Users/user/.zcode/saga.db \
  node tools/saga-snapshot.mjs 1 restore \
  --in=C:/Temp/autism-buttons-workspace/.saga/artifact-snapshots/epics/1/snapshot.json \
  --verify-disk-hash

# 3. Запустить lifecycle resume — оркестратор увидит formalization completed,
#    создаст development stage_run и продолжит
SAGA_ORCHESTRATION_MODE=saga3-lifecycle \
SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./product-lifecycle-composition.mjs \
SAGA_PRODUCT_LIFECYCLE_INPUT=./hex-lifecycle-input.json \
  node dist/orchestrate-cli.js 1 1 --resume --idempotency-key=product-delivery:epic:1
```

`--resume` критичен: он даёт `resumePaused=true`, что переводит lifecycle_run
`paused→running` через `repo.resume()` (`PARTIAL-RESET-AND-RESUME.md` §1.1). Снимок
вставил lifecycle_run со `status='paused'`, и оркестратор:

1. `start()` с тем же `idempotency_key=product-delivery:epic:1` → replayed
   (тот же input_hash в snapshot).
2. `current_stage_run_id` указывает на formalization stage_run (status=completed,
   local_outcome=formalized) → orchestrator видит terminal transition, создаёт
   **новый** development stage_run + process_run.
3. GenericFlowExecutor начинает development Flow с нуля (development не в snapshot).

### 5.3 Проверка перед restore (gate)

`saga-snapshot.mjs restore` должен отказаться работать, если:

- Эпик уже существует в БД (restore идемпотентен только поверх чистой БД).
- `definition_hash` в snapshot не совпадаёт с тем, что посчитает текущий билд
  (опциональный `--strict-definition-hash` — для строгого режима; по умолчанию
  warn-only, т.к. правка skills меняет hash без поломки структурного скелета).
- Disk-hash любого accepted артефакта не совпал с `acceptedHash` в snapshot
  (с `--verify-disk-hash`): документ дрифтил, снимок устарел.

---

## 6. Риски и митигации

### 6.1 `package_digest` / `installation_id` drift (главный риск)

**Проблема:** snapshot хранит `package_digest='3c665f...'`. После `reset-saga-db.mjs:76-80`
`installations` тоже сбрасываются. `installProductionModules` переустановит пакет
по байтам из `dist/modules/formalization/...`. Если **код модуля не менялся** — digest
совпадёт → тот же `installation_id` → replay ProcessRun работает. Если правили код —
digest другой → `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` на ProcessRun
(`PARTIAL-RESET-AND-RESUME.md` §2.2/§2.4).

**Митигация:**
- Snapshot хранит `packageDigest`. Restore **после** `installProductionModules` делает
  `UPDATE saga3_process_runs SET installation_id=?, package_digest=? WHERE id=?`
  с актуальными значениями. Это НЕ нарушает immutability (process_run mutable до terminal;
  формализационный process_run уже terminal, но триггеры дропнуты в §4.2 — UPDATE проходит).
- Capture-warn: при snapshot сохранять `git rev-parse HEAD` репозитория saga-mcp; при
  restore — сравнивать. Если commit отличается, warn «код мог измениться; replay может
  упасть на IDEMPOTENCY_KEY_REUSED».

### 6.2 `definition_hash` drift (второй главный риск)

**Проблема:** snapshot хранит `definition_hash='2ea303...'`. Если после reset правили
`product-delivery-lifecycle.ts` (или skills, входящие в definition) — пересчитанный hash
не совпадёт → `LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY` (`PARTIAL-RESET-AND-RESUME.md`
§2.1).

**Митигация:**
- В snapshot хранить полный `definition_snapshot` (уже есть в `saga3_lifecycle_runs`).
- При restore вставлять `definition_hash`/`definition_snapshot` дословно (§4.6).
- Тогда `start()` увидит совпадение `existing.definition_hash === command.definitionHash`
  ТОЛЬКО если текущий билд посчитает тот же hash. Если правили lifecycle — hash разойдётся.
- **Решение (выход за рамки snapshot, уже спроектировано в PARTIAL-RESET §5.2):**
  «мягкий» режим в `SqliteLifecycleRunRepository.start()`, сравнивающий структурный скелет
  (entry_stage_id, stage_ids, module_refs, outcomeRoutes), а не весь snapshot. До его
  реализации restore работает только при **неизменном** lifecycle-definition — что для
  iterative bug-fix в development-модуле обычно выполняется.

### 6.3 work_intents / control_intents не snapshot'ятся

**Проблема:** `saga3_exact_candidate_acceptance_decisions` имеет FK `intent_id → saga3_work_intents`,
но `reset-saga-db.mjs` сносит `saga3_work_intents`. Если work_intent не восстановлен — dangling FK.

**Митигация:**
- `foreign_keys = OFF` во время restore (§4.2) — FK не проверяется.
- Acceptance decision остаётся «осиротевшим» по work_intent, но это допустимо: replay acceptance
  не идёт (immutable decision уже есть), development не трогает work_intents формализации.
- Если хочется чистоты — snapshot'ить и work_intents формализации (add-опц.; 4 строки).
  На первом этапе пропускаем.

### 6.4 Snapshot формализации после старта development

**Проблема:** Если делать snapshot, когда development уже идёт — artifact→task traces
(`implements`/`depends_on`) ссылаются на development tasks, которых в snapshot формализации
нет. При restore они потеряются.

**Митигация:**
- Документировать: snapshot формализации делается **только когда** `episode_workflows.stage='formalization'`
  И development stage_run отсутствует. Capture проверяет это:
  ```js
  const devStage = db.prepare(
    `SELECT 1 FROM saga3_stage_runs WHERE lifecycle_run_id=? AND stage_id='solution-development'`
  ).get(lrId);
  if (devStage) throw new Error('ARTIFACT_SNAPSHOT_CAPTURE_TOO_LATE: development already started; snapshot only valid pre-development');
  ```
- Для «snapshot после development» — отдельный, больший snapshot (включает development
  tasks, traces, verification_evidence). Это вне scope этого дизайна; на первом этапе
  формализация — самая дорогая часть, её и снимем.

### 6.5 content_hash drift на диске

**Проблема:** Документ `.md` в git workspace мог измениться после snapshot (ручная правка,
другой прогон formalization перезаписал).

**Митигация:**
- `--verify-disk-hash` (§5.3): каждый accepted артефакт проверяется через
  `artifactDiskHash`. Mismatch → abort с явным сообщением.
- Для draft артефактов (hypothesis, business_metric) — warn-only: они не в baseline,
  drift не ломает gates.

### 6.6 Immutable triggers не пересозданы

**Проблема:** После restore мы дропнули immutable triggers (§4.2 шаг 1) и не пересоздали.
Следующий запуск saga-server вызовет `ensureExactCandidateAcceptanceSchema` /
`ensureManagedNodeSubmissionSchema` через `CREATE TRIGGER IF NOT EXISTS` (см.
`PARTIAL-RESET-AND-RESUME.md` §4.1 конец) — триггеры вернутся. Но между restore и
первым `getDb()` они отсутствуют — окно уязвимости.

**Митигация:**
- Restore и последующий `orchestrate-cli` запускаются в одном скрипте/флоу, без ручных
  правок БД между ними. Первый же `getDb()` (`orchestrate-cli.ts:143` →
  `createSaga2Application` → getDb) пересоздаст триггеры до любой worker-мутации.
- Альтернатива: в конце restore явно вызвать `ensureExactCandidateAcceptanceSchema(db)` и
  `ensureManagedNodeSubmissionSchema(db)`. Надёжнее; рекомендую.

### 6.7 `--resume` без `resumePaused`

**Проблема:** Если запустить `orchestrate-cli` без `--resume`, lifecycle_run.status='paused'
приведёт к `start()` без `resumePaused` → orchestrator может отказаться трогать paused run.

**Митигация:**
- Документировать обязательный `--resume` в команде запуска (§5.2).
- Либо: вставить lifecycle_run со `status='running'` + `execution_lease_expires_at` в прошлом
  → `acquireExecutionLease` отберёт протухший lease (`PARTIAL-RESET-AND-RESUME.md` §1.1).
  Но это менее явно; `paused` + `--resume` чище.

### 6.8 Saga-handoff snapshot содержит artifactIds как числа

**Проблема:** `saga3_process_transitions.handoff_snapshot` — JSON с
`"solutionContractPayload.bundle.acArtifactIds":[42,43,...]` и
`"artifactHashes":{"42":"db61...","43":"db61..."}`. Это **id** артефактов. Если id
сохранён (§4.4) — snapshot остаётся валидным дословно.

**Митигация:**
- Id preservation (§4.4/§4.6) — гарантирует, что handoff_snapshot не требует patching.
- Если в будущем решим делать id-remapping (new ids), то handoff_snapshot придётся
  парсить и переписывать все числовые artifactId. Поэтому **id preservation —
  сознательное упрощение**: оно делает restore тривиальным за счёт требования чистой БД.

### 6.9 Idempotency restore

**Проблема:** повторный restore поверх уже-восстановленной БД → duplicate key errors.

**Митигация:**
- Pre-check (§4.2 шаг 2): `epicId` уже существует → abort с явной инструкцией
  `reset-saga-db` сначала. Не пытаемся быть идемпотентными — restore — одноразовая
  операция над чистой БД.

---

## 7. План реализации (по приоритету)

| # | Что | Усилие | Зависимость |
|---|---|---|---|
| 1 | `src/infrastructure/testing/artifact-snapshot.ts` — `captureArtifactSnapshot` | ~1 день | — |
| 2 | `tools/saga-snapshot.mjs` capture subcommand | ~0.5 дня | 1 |
| 3 | `captureArtifactSnapshot` на live БД epic 1 → валидация JSON-схемы из §3 | ~0.5 дня | 2 |
| 4 | `restoreArtifactSnapshot` (§4.2-4.9) | ~1 день | 1 |
| 5 | `tools/saga-snapshot.mjs` restore subcommand + `--verify-disk-hash` | ~0.5 дня | 4 |
| 6 | End-to-end: reset → restore → `--resume` → verify development стартует без пере-formализации | ~0.5 дня | 5 |
| 7 | (опц.) Snapshot work_intents формализации (§6.3) | ~1 час | 4 |
| 8 | (опц.) Snapshot development (§6.4, после stab) | — | — |

Итого ядро: ~3.5 дня на завершённый механизм, который экономит 20-30 мин на каждый прогон
после первого.

---

## 8. Проверка корректности (acceptance для самой фичи)

После restore + `--resume`, lifecycle должен:

1. Не создавать НОВЫЕ artifacts/traces формализации (`SELECT COUNT(*) FROM artifacts WHERE
   epic_id=1` == 59, как в snapshot; activity_log без `artifact/created` формализации).
2. Не создавать НОВЫЕ saga3_stage_runs/process_runs для `solution-formalization`
   (`SELECT status FROM saga3_stage_runs WHERE stage_id='solution-formalization'` ==
   `completed`).
3. Создать development stage_run + process_run (`SELECT * FROM saga3_stage_runs WHERE
   stage_id='solution-development'` ровно 1 строка, status не `completed` сразу после resume).
4. Pass всех formalization→planning gates `assertTasksReady` / `assertTraceability` /
   `acceptedBaseline` (`episode_transition({epic_id:1, to_stage:'planning'})` не бросает).
5. `episode_workflows.stage` переходит `formalization → planning → development` за
   время < 2 минут (вместо 20-30 мин полного прогона).

---

## Приложение A. Соответствие файлов исходников

| Что | Файл |
|---|---|
| Draft cache sidecar (паттерн) | `src/infrastructure/testing/test-warm-start.ts` |
| Trace cache sidecar (дизайн) | `docs/design/TRACE-REPLAY-GUIDE.md` |
| Full reset + trigger drop pattern | `reset-saga-db.mjs:84-113` |
| Partial reset + resume дизайн | `docs/design/PARTIAL-RESET-AND-RESUME.md` |
| artifact_create handler (upsert by code) | `src/tools/artifacts.ts:223-300` |
| artifactDiskHash / refreshArtifactHash | `src/helpers/artifact-file.ts:6-50` |
| Episode transition gates | `src/tools/lifecycle.ts:60-313` |
| acceptedBaseline (AC gate) | `src/tools/lifecycle.ts:60-84` |
| assertTraceability (formalization gate) | `src/tools/lifecycle.ts:130-225` |
| Exact acceptance CAS + triggers | `src/process-modules/persistence/sqlite-exact-candidate-acceptance.ts:125-232` |
| Managed productions schema | `src/process-modules/persistence/sqlite-managed-production-ledger.ts:154-206` |
| Formalization baseline + contract | `src/process-modules/modules/formalization/formalization-persistence.ts:45-75` |
| Lifecycle orchestrator (resume) | `src/process-modules/application/lifecycle-orchestrator.ts` |
| orchestrate-cli (entry point) | `src/orchestrate-cli.ts:112-168` |
| Worker workspace hooks | `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:306-419` |
| Schema (artifacts, traces, episode_workflows, tasks) | `src/schema.ts:58-140, 251-396` |
| Schema (work/control intents) | `src/schema.ts:677-725` |

## Приложение B. Контрольный пример (живая БД)

`C:/Users/user/.zcode/saga.db`:

- `lifecycle_run 37`, `epic 1`, `status='running'`, `current_stage_id='solution-development'`.
- `stage_runs`: discovery (77, completed, `clarify`), formalization (78, completed, `formalized`),
  development (79, running).
- `process_runs`: 93 (discovery), 94 (formalization), 95 (development).
- `node_runs` pr 94: 13 nodes, все completed (define-product-contract … complete-formalized).
- `artifacts`: 59 (54 accepted: 17 AC, 10 FR, 8 NFR, 1 PRD, 8 RULE, 1 SRS, 9 UC, 1 brief;
  5 draft: 1 business_metric, 3 hypothesis).
- `traces`: 669 (70 covers, 555 derived_from — artifact→artifact; 22 depends_on,
  22 implements — artifact→task development).
- `exact_acceptance_decisions`: 4 (product/use-case/acceptance/architecture gates, pr 94).
- `exact_acceptance_items`: 54 (по item на candidate артефакт).
- `formalization_acceptance_baselines`: 1 (id 11, baseline_hash `4ee01b25…`).
- `formalization_solution_contracts`: 1 (content_hash `3834a3c7…`).
- `process_transitions`: 2 (discovery→formalization, formalization→development, handoff
  snapshots содержат полные acceptanceCriteria/traceIds/baseline refs).

**Внимание для capture:** эта БД уже в development — snapshot формализации из неё
зафиксирует состояние «post-development-start», что нарушит §6.4. Для чистого snapshot
формализации нужно откатить development (Сценарий A из `PARTIAL-RESET-AND-RESUME.md`)
ПЕРЕД capture, либо дождаться следующего чистого прогона и снять snapshot на стадии
`episode_workflows.stage='formalization'`.

Альтернатива: добавить в `captureArtifactSnapshot` фильтр «только formalization stage
артефакты/traces» (по `metadata.process_node_id` формализационных nodes), игнорируя
development-created traces. Это расширяет применимость, но усложняет capture. На первом
этапе — требование «capture pre-development» (§6.4).
