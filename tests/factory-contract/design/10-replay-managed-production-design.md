# 10 — ReplayCapsule, Managed-Production and Typed-Submission Design

Exhaustive map of the three ways a worker's production becomes a durable,
immutable, content-addressed Saga Factory product. Two of them are
**production paths** (how the bytes first enter the immutable store); the
third is a **reproduction path** (how a later run re-emits the same bytes
without ever calling a model).

```
                         WorkerExecution (fenced, running)
                                     |
            ┌────────────────────────┴────────────────────────┐
            │                                                 │
   product_submit /                            artifact_create / artifact_update / trace_add
   process_node_submit                         (against the Workplace desk)
            │                                                 │
            ▼                                                 ▼
  typed-submission path                            managed-production path
  factory_managed_node_submissions                 factory_managed_artifact_productions
  (one row per execution, immutable)               factory_managed_trace_productions
            │                                                 │
            │              ProductionCellNodeExecutor         │
            │        sealCandidateSet(workplaceRef,           │
            │          executionRef, role, products)          │
            │                      │                          │
            └──────────────────────►│◄─────────────────────────┘
                                   ▼
                          factory_candidate_sets
                          factory_candidate_set_members
                          (one sealed QC batch per role per execution)
                                   │
                          GateRun + GateDecision
                                   │
                            accepted? ── no ──► repair_wait / failed
                                   │
                                  yes
                                   │
                  postAcceptanceEffect: 'replay-capture'  (universal)
                                   │
                                   ▼
                        factory_replay_capsules
                        (archived, certified, content-addressed)
                                   │
            ┌──────────────────────┴───────────────────────────┐
            │                                                  │
       next run, same work item                                │
       bindReplayToClaim() looks up by replayKey               │
            │                                                  │
       hit? ── no ──► normal inference execution                │
            │                                                  │
           yes                                                 │
            │                                                  │
       ClaudeBoardWorkerExecutor.detectFrozenCapsule            │
            │                                                  │
       executeCapsuleReplay() — zero LLM calls                 │
       (re-publishes through SAME MCP handlers)                 │
```

Sources of truth (all paths absolute):
- `D:/Development/saga-mcp/src/process-modules/application/node-executors/production-cell-node-executor.ts`
- `D:/Development/saga-mcp/src/process-modules/persistence/sqlite-managed-node-submission-repository.ts`
- `D:/Development/saga-mcp/src/process-modules/persistence/sqlite-managed-production-ledger.ts`
- `D:/Development/saga-mcp/src/process-modules/shared/workplace-production-snapshot.ts`
- `D:/Development/saga-mcp/src/infrastructure/workplace/sqlite-candidate-set-repository.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/replay-capsule.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/sqlite-replay-capsule-repository.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/capsule-replay-executor.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/replay-claim-binder.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/replay-capture-effect.ts`
- `D:/Development/saga-mcp/src/infrastructure/replay/replay-capsule-completeness.ts`
- `D:/Development/saga-mcp/src/tools/products.ts`
- `D:/Development/saga-mcp/src/tools/process-node-submissions.ts`
- `D:/Development/saga-mcp/src/tools/dispatcher.ts` (`requireProductionCellSubmission`, line 1914)
- `D:/Development/saga-mcp/src/lifecycle/work-assignment-core.ts` (`activateProductionCellRoleTask`, line 736)
- `D:/Development/saga-mcp/src/app/product-lifecycle-runtime.ts` (composition root, line 393)
- `D:/Development/saga-mcp/src/process-modules/modules/formalization/formalization-process-module.ts` (canonical managed-production example)
- `D:/Development/saga-mcp/src/process-modules/modules/discovery/discovery-process-module.ts` (canonical typed-submission example)

---

## 1. productSource determination

`productSource` is the cell-level declaration that decides which of the two
production paths a WorkerExecution must follow. It is a literal of the union
`'typed-submission' | 'managed-production'`. Three layers cooperate.

### 1.1 Cell declaration (the authoritative source)

Every Production Cell declares its product contract in the module definition.
`singletonProductionCell` accepts `productSource` and propagates it into
`productContracts[0].productSource`:

```ts
// src/process-modules/application/standard-production-cell.ts (lines 14, 40-46)
readonly productSource?: 'typed-submission' | 'managed-production';
...
productContracts: [{
  binding: 'product',
  schemaRef: options.outputSchemaRef,
  mediaType: options.mediaType ?? 'application/json',
  cardinality: options.cardinality ?? '1..n',
  ...(options.productSource ? { productSource: options.productSource } : {}),
}],
```

Each module then pins its cells explicitly. The pattern is sharp and
universal:

| module | node | productSource | rationale |
|---|---|---|---|
| `product-discovery` | `produce-proposal`, `assess-readiness` | `typed-submission` | one typed `product_submit` per execution |
| `solution-formalization` | `define-product-contract`, `model-use-cases`, `define-acceptance-contract`, `define-architecture-contract` | `managed-production` (default of `reviewedCell`) | author creates artifacts + traces; factory assembles snapshot |
| `solution-formalization` | `reconcile-what` | `typed-submission` (explicit override) | reconciliation is a typed report, not artifacts |
| `solution-development` | all cells | `typed-submission` | typed task-graph + implementation + verification products |

`reviewedCell` in `formalization-process-module.ts` (lines 89-95) makes the
default explicit:

```ts
productSource?: 'typed-submission' | 'managed-production';
...
return singletonProductionCell({
  ...
  productSource: input.productSource ?? 'managed-production',
  ...
});
```

The single typed override inside Formalization is `reconcile-what` (line 201):

```ts
cellDefinition: reviewedCell({
  id: 'formalization-reconciliation',
  ...
  productSource: 'typed-submission',
}),
```

### 1.2 Composition root → executor → activation

`ProductionCellNodeExecutor.ensureRoleProjection` reads the contract and
forwards it through the persistence port. The relevant lines (816-823):

```ts
this.opts.persistence.activateRoleTask({
  taskId: plan.taskId,
  intentId: plan.intentId,
  workplaceRef: workplace.ref,
  role,
  executionProfileId: profile.id,
  productSource: cell.productContracts.find(
    c => c.schemaRef === node.outputSchema?.id
  )?.productSource,
});
```

The composition root in `product-lifecycle-runtime.ts` (lines 393-410) used
to drop the field; after commit `3d86044` it forwards it explicitly:

```ts
activateRoleTask: ({
  taskId, intentId, workplaceRef, role, executionProfileId, productSource,
}) => {
  const workplace = serializeWorkplaceRef(workplaceRef);
  activateProductionCellRoleTask(db, {
    taskId, intentId, workplaceRef: workplace,
    role, executionProfileId, productSource,
  });
},
```

### 1.3 Activation stamps the projection

`activateProductionCellRoleTask` (in `work-assignment-core.ts`, line 736) is
the single publisher of the durable role task. It calls
`resolveRoleProductSource` and stamps `metadata.product_source` onto the task
row:

```ts
const productSource = resolveRoleProductSource(db, input, metadata);
if (productSource) metadata.product_source = productSource;
```

### 1.4 The bug fixed in commit `3d86044`

Before `3d86044` the composition root destructured only
`{ taskId, intentId, workplaceRef, role, executionProfileId }` and silently
dropped `productSource`. `activateProductionCellRoleTask` therefore never
received it and the `metadata.product_source` projection was missing on
Formalization author tasks. As a consequence:

1. `requireProductionCellSubmission` in `dispatcher.ts` (line 1952) could not
   short-circuit on `product_source === 'managed-production'` and threw
   `PRODUCTION_CELL_PRODUCT_REQUIRED` on every Formalization author
   `worker_done`, because the worker had (correctly) not called
   `product_submit`.
2. Downstream code that reads `metadata.product_source` to decide between
   typed and managed assembly paths got `undefined`.

The fix has two layers and a migration defence:

1. The composition root now forwards `productSource` explicitly (above).
2. `resolveRoleProductSource` (lines 689-731) reconstructs the value if the
   composition path ever drops it again. Three-tier resolution:
   - Reviewer always returns `'typed-submission'` (a review verdict is a
     typed product, even on a managed-production cell).
   - Author: an explicit `input.productSource` is authoritative.
   - Otherwise: preserve `metadata.product_source` if already stamped.
   - Otherwise: inspect the frozen `factory_work_intents.authority_scope`.
     If the capability list `allowed_tools` contains `product_submit` →
     `typed-submission`; else `managed-production`.

```ts
function resolveRoleProductSource(db, input, metadata): ProductionSource | undefined {
  if (input.role === 'reviewer') return 'typed-submission';
  if (input.productSource) return input.productSource;
  const existing = metadata.product_source;
  if (existing === 'typed-submission' || existing === 'managed-production') {
    return existing;
  }
  const intent = db.prepare(
    'SELECT authority_scope FROM factory_work_intents WHERE id=?',
  ).get(input.intentId);
  ...
  return tools.includes('product_submit') ? 'typed-submission' : 'managed-production';
}
```

The companion test
`tests/factory-contract/production-source-and-tracker-hook.test.mjs` pins all
four branches (managed recovery, typed recovery, explicit override,
reviewer-forces-typed).

### 1.5 Two readers of `metadata.product_source`

Both gates are in `src/tools/dispatcher.ts`.

**`requireProductionCellSubmission`** (line 1914, called by `handleWorkerDone`
line 565) — the only thing this gate does for managed-production cells is
return early:

```ts
const productSource = meta.product_source ?? meta.cell_product_source ?? null;
if (productSource === 'managed-production') return;
```

For typed-submission cells it then queries
`factory_managed_node_submissions` for the exact `(task_id, execution_id)`
and throws `PRODUCTION_CELL_PRODUCT_REQUIRED` if missing or
`PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH` if the schema is wrong.

**`ProductionCellNodeExecutor.reconcile`** (line 488-498, via the
`productReader.readExecutionProducts` port) sets the
`requireTypedSubmission` flag for the production reader:

```ts
requireTypedSubmission: role === 'reviewer'
  || cell.productContracts.some(
       contract => contract.productSource === 'typed-submission'),
```

The reader in `product-lifecycle-runtime.ts` (line 479-552) then behaves
accordingly: if there is a managed-node-submission row, return it; if there
is none and `requireTypedSubmission` is true, return `[]`; otherwise
assemble a managed-production snapshot from the Workplace desk.

---

## 2. Managed-production path

A managed-production cell does NOT require the worker to call
`product_submit`. The worker instead uses `artifact_create`,
`artifact_update`, and `trace_add`. The factory captures those writes on the
Workplace desk, and at CandidateSet seal time it freezes the desk into an
immutable snapshot. This is the path Formalization PRD/UC/AC/SRS authors
take.

### 2.1 The desk tables

Two append-only ledger tables record every managed-production write against
the Workplace. Schema from `sqlite-managed-production-ledger.ts` (lines
100-149):

```sql
CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id  INTEGER NOT NULL REFERENCES factory_process_runs(id),
  module_ref      TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  intent_id       INTEGER NOT NULL,
  task_id         INTEGER NOT NULL,
  execution_id    TEXT NOT NULL,
  artifact_id     INTEGER NOT NULL,
  artifact_type   TEXT NOT NULL,
  artifact_status TEXT NOT NULL,
  content_hash    TEXT,
  operation       TEXT NOT NULL CHECK (operation IN ('create','upsert','update')),
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ... ON (... process_run_id, node_id, execution_id,
  artifact_id, operation, artifact_status, COALESCE(content_hash,''));

CREATE TABLE IF NOT EXISTS factory_managed_trace_productions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id  INTEGER NOT NULL REFERENCES factory_process_runs(id),
  module_ref      TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  intent_id       INTEGER NOT NULL,
  task_id         INTEGER NOT NULL,
  execution_id    TEXT NOT NULL,
  trace_id        INTEGER NOT NULL,
  source_id       INTEGER NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('artifact','task')),
  target_id       INTEGER NOT NULL,
  link_type       TEXT NOT NULL,
  trace_hash      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (process_run_id, node_id, execution_id, trace_id)
);
```

The Workplace — not WorkerExecution, task or node — is the ownership
boundary. `WorkplaceProductionResolver.read(workplaceRef)` returns the
canonical latest state of every artifact and trace physically contributed
by any execution belonging to that exact Workplace:

```ts
// src/process-modules/application/workplace-production-resolver.ts
read(workplaceRef: WorkplaceRef): {
  readonly artifacts: readonly ManagedArtifactProductionRecord[];
  readonly traces: readonly ManagedTraceProductionRecord[];
};
```

The fence is enforced by `resolveManagedExecutionProvenance` (line 191) which
requires `SAGA_MANAGED_EXECUTION=1`, `SAGA_EXECUTION_ID`, and (when
`requireLiveProducer` is set) `worker_executions.state = 'running'`.

### 2.2 Assembly at CandidateSet seal time

The `ProductionCellProductReader.readExecutionProducts` implementation in
`product-lifecycle-runtime.ts` (lines 479-552) is the canonical assembler:

```ts
readExecutionProducts: ({ processRunId, moduleRef, nodeId, executionRef,
                         expectedSchemaRefs, requireTypedSubmission }) => {
  // 1. typed submissions win first
  const submission = db.prepare(
    `SELECT id,schema_version,content_hash FROM factory_managed_node_submissions
      WHERE process_run_id=? AND module_ref=? AND node_id=? AND execution_id=?
      ORDER BY id DESC LIMIT 1`,
  ).get(...);
  if (submission) {
    return [{ schemaId: submission.schema_version,
              ref: `managed-node-submission:${submission.id}`,
              digest: submission.content_hash }];
  }
  if (requireTypedSubmission) return [];

  // 2. otherwise resolve the Workplace desk
  const executionContext = db.prepare(
    `SELECT t.workplace_ref FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id WHERE we.execution_id=?`,
  ).get(executionRef);
  ...
  const production = workplaceProductionResolver.read(workplaceRef);
  if (production.artifacts.length === 0 && production.traces.length === 0) return [];

  // 3. freeze the desk into an exact ProductRef BEFORE sealing
  return expectedSchemaRefs.filter(Boolean).map(schemaId => {
    const snapshot = buildWorkplaceProductionSnapshot({
      workplaceRef: executionContext.workplaceRef!,
      expectedSchemaRef: schemaId,
      presentationAuditRef: executionRef,
      artifacts: production.artifacts,
      traces: production.traces,
    });
    const contentHash = sha256Hex(snapshot);
    return workplaceProductPort.submitProduct({
      processRunId, nodeId, moduleRef,
      schema: schemaId, content: snapshot, contentHash, executionRef,
    }).productRef;
  });
},
```

Key points:
- The live desk is resolved from the Workplace, then **frozen** into a
  `WorkplaceProductionSnapshot` and submitted through the universal
  `WorkplaceProductPort`. The snapshot becomes a regular content-addressed
  product in `factory_process_products`.
- Later repairs can change the live desk, but the CandidateSet's ProductRef
  stays immutable. `candidate_read`, gate audit and replay all see the same
  frozen snapshot.
- The presenter (sealing) execution is decoupled from the executions that
  physically contributed the artifacts/traces. The
  `contributingExecutionRefs` field records the full set.

### 2.3 The snapshot shape

From `workplace-production-snapshot.ts`:

```ts
export const WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION =
  'factory.workplace-production-snapshot.v1';

export interface WorkplaceProductionSnapshot {
  readonly schemaVersion: typeof WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION;
  readonly workplaceRef: string;
  readonly expectedSchemaRef: string;
  readonly presentationAuditRef: string;
  readonly contributingExecutionRefs: readonly string[];
  readonly artifacts: readonly WorkplaceProductionArtifactSnapshot[];
  readonly traces: readonly WorkplaceProductionTraceSnapshot[];
}
```

Each artifact snapshot carries `{ artifactId, artifactType, artifactStatus,
contentHash, operation }`. Each trace snapshot
carries `{ traceId, sourceId, targetType, targetId, linkType, traceHash,
traceHash }`.

`workplaceProductionSemanticDigest(snapshot)` produces the cross-run-stable
digest by stripping every run-specific id (artifactId, traceId, sourceId,
targetId, workplaceRef, execution refs) and sorting — two runs producing the
same artifact content and trace structure yield the same digest. This is the
foundation for replay identity (see §5.3).

### 2.4 Why `product_submit` differs from `process_node_submit`

Both write to `factory_managed_node_submissions` and accept
`{ schema, payload }` vs `{ schema, content }`. The differences:

| aspect | `product_submit` | `process_node_submit` |
|---|---|---|
| file | `src/tools/products.ts` | `src/tools/process-node-submissions.ts` |
| arg name | `content` | `payload` |
| `content` may be a JSON string | yes (parsed) | yes (parsed) |
| pre-validation | `assertSchemaForCurrentExecution` | (none — submit path validates) |
| post-write side effect | `writeProduct` to universal desk; if schema is a Discovery proposal, also projects to `factory_proposals` | `writeProduct` to universal desk under `factory.node-submission.<schema>.v1` |
| return field | `product_ref` + `discovery_proposal_id` | `submission_ref` |
| canonical caller | Production-Cell author (typed-submission cell) | Legacy / Development LM node |

Both delegate to `SqliteManagedNodeSubmissionRepository.submitForCurrentExecution`
— so the underlying storage, idempotency, fence check, schema check and
contract pin are identical. The only real difference is the secondary
projection (Discovery proposal projection is `product_submit`-only).

The dual-write is explicit in `process-node-submissions.ts` (line 55):

```ts
// Conveyor v4 step 3.C.2: dual-write submission-ref onto the universal desk.
writeProduct(getDb(), {
  schemaRef: `factory.node-submission.${schema}.v1`,
  content: payload,
  executionRef: result.record.executionId ?? 'system',
  productKey: `content:${result.record.contentHash}`,
});
```

---

## 3. Typed-submission path

A typed-submission cell REQUIRES the worker to call `product_submit` (or the
older `process_node_submit`) exactly once before `worker_done`. Discovery,
Development and Formalization reconciliation use this path.

### 3.1 The submission table

`factory_managed_node_submissions` is the immutable fence product. Schema
from `sqlite-managed-node-submission-repository.ts` (lines 55-88):

```sql
CREATE TABLE IF NOT EXISTS factory_managed_node_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id   INTEGER NOT NULL REFERENCES factory_process_runs(id),
  module_ref       TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  intent_id        INTEGER NOT NULL,
  task_id          INTEGER NOT NULL REFERENCES tasks(id),
  execution_id     TEXT NOT NULL REFERENCES worker_executions(execution_id),
  schema_version   TEXT NOT NULL,
  payload_snapshot TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  submitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (process_run_id, node_id, execution_id)
);
CREATE INDEX idx_factory_managed_node_submission_exact
  ON factory_managed_node_submissions(
     process_run_id,module_ref,node_id,intent_id,task_id,execution_id);

CREATE TRIGGER trg_factory_managed_node_submissions_no_update
BEFORE UPDATE ON factory_managed_node_submissions
BEGIN SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_IMMUTABLE'); END;

CREATE TRIGGER trg_factory_managed_node_submissions_no_delete
BEFORE DELETE ON factory_managed_node_submissions
BEGIN SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_DELETE_FORBIDDEN'); END;
```

Two triggers enforce immutability: no UPDATE, no DELETE. The unique key is
`(process_run_id, node_id, execution_id)` — one execution gets exactly one
submission.

### 3.2 Fields

| field | meaning |
|---|---|
| `id` | row id — used as the ProductRef `ref` suffix (`managed-node-submission:<id>`) |
| `process_run_id` | the ProcessRun scope |
| `module_ref` | `<name>@<version>`, e.g. `product-discovery@3.0.2` |
| `node_id` | the Flow node id (e.g. `produce-proposal`) |
| `intent_id` | the `factory_work_intents.id` that pinned the schema |
| `task_id` | the projected role task |
| `execution_id` | the fenced WorkerExecution |
| `schema_version` | the submitted schema id |
| `payload_snapshot` | canonical JSON of the payload (re-canonicalised and validated on read) |
| `content_hash` | SHA-256 over the payload |
| `submitted_at` | wall clock |

### 3.3 Submission algorithm

`submitForCurrentExecution` (line 102) is a single IMMEDIATE transaction:

1. `resolveManagedExecutionProvenance(db, env)` — pulls
   `processRunId / moduleId / nodeId / intentId / taskId / executionId`
   from `SAGA_MANAGED_EXECUTION` env + task metadata. Throws if missing.
2. `assertLiveFence(...)` — the `worker_executions.state` must be
   `running` AND either `factory_process_runs.status = 'running'` OR
   (for Production Cells) `status = 'paused'` + a live Workplace
   (`loop_state = 'running'`).
3. `assertIntentOutputSchema(intentId, schema)` — the submitted `schema`
   MUST match the `output_schema` declared by the WorkIntent. If the intent
   pinned a `payload_contract`, that pin is returned.
4. `assertPinnedProductPayload` (pinned contract) or `assertProductPayload`
   (legacy) — schema-specific structural validation.
5. Look up an existing row by exact
   `(processRunId, moduleId, nodeId, intentId, taskId, executionId)`.
   - If a row exists with identical `payload_snapshot` and `content_hash` →
     idempotent replay, return `replayed: true`.
   - If a row exists with different content → throw
     `MANAGED_NODE_SUBMISSION_ALREADY_FINAL`.
6. Otherwise INSERT, re-read, return `replayed: false`.

The `rowToRecord` reader validates the row on every read:
`canonicalJson(payload) === payload_snapshot` and
`sha256Hex(payload) === content_hash`. Any drift throws
`MANAGED_NODE_SUBMISSION_CORRUPT`.

### 3.4 `product_submit` versus `process_node_submit` — when to use which

Workers should prefer `product_submit`. The handler (`src/tools/products.ts`
line 34):

1. `requiredString(args, 'schema')`, require `content`.
2. `submissionRepo().assertSchemaForCurrentExecution(schema)` — preflight
   the intent contract before any side effect.
3. `materializeManagedSourceChange(...)` — schema-specific augmentation.
4. `submissionRepo().submitForCurrentExecution({ schema, payload: content })`.
5. `writeProduct(...)` to the universal desk with `productKey:
   'content:<hash>'` (content-addressed dedup).
6. If `requiresDiscoveryProjection(schema)` — i.e. it's a Discovery
   proposal — also project into `factory_proposals` and write a
   `factory.proposal-ref.v1` ProductRef. **This is the architectural
   invariant**: inference and replay follow the same projection path; the
   readiness gate cannot distinguish them.

Return payload carries both a `product_ref` (the immutable triple) and a
`universal_ref` (the universal-desk key), with the hint:
`Product sealed on the desk. Call worker_done exactly once.`

`process_node_submit` is the older spelling. It lacks the Discovery proposal
projection and is preserved for backward compatibility with the Development
continuation module.

---

## 4. CandidateSet

### 4.1 Definition

A CandidateSet is the immutable QC batch the gate evaluates. From
`SqliteCandidateSetRepository` (line 1):

> Target contract: REG-12 (Партия на проверку — CandidateSet).
> Idempotency: the seal key `(workplace_ref, production_revision_ref, role, subject)`
> is UNIQUE. A replay of the same material completion returns the
> existing row; a different payload under the same key is rejected with
> `CANDIDATE_SET_REPLAY_MISMATCH`.

Domain type (rebuilt from `factory_candidate_sets` + members):

```ts
interface CandidateSet {
  candidateSetRef: string;
  workplaceRef: WorkplaceRef;
  productionRevisionRef: string;       // exact accepted material
  role: 'author' | 'reviewer';
  subjectCandidateSetRef: string | null; // reviewer → author subject
  members: CandidateMember[];            // ProductRefs + origin
  sealReceiptRef: string;
  candidateSetDigest: string;
  sealedAt: string;
}

interface CandidateMember {
  productRef: ProductRef;
  origin: 'produced' | 'carried-forward';
  sourceCandidateSetRef: string | null;
}
```

Tables (lines 87-118):

```sql
INSERT INTO factory_candidate_sets
  (candidate_set_ref, workplace_ref, production_revision_ref, role,
   subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

INSERT INTO factory_candidate_set_members
  (candidate_set_ref, ordinal, product_schema, product_ref, product_digest,
   origin, source_candidate_set_ref)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

### 4.2 When is it captured?

Only the `ProductionCellNodeExecutor.reconcile` loop seals CandidateSets,
once per `(workplace, execution, role)` when the Workplace reaches the
`verifying` loop state. Two sealing paths:

1. **Normal production** (`sealCandidateSet`, line 827). Members are the
   `ProductRef[]` returned by `productReader.readExecutionProducts`.
   `candidateSetDigest` is `sha256({ workplaceRef, executionRef, role,
   products })`.
2. **Carried-forward candidate** (`sealCarriedForwardCandidateSet`, line
   852). Used when an `AuthorCandidateCarryForward` directive authorises
   reusing an upstream accepted CandidateSet; members are stamped
   `origin: 'carried-forward'`.

### 4.3 What the gate does with it

`runGate(...)` (line 879) calls `driveGateRun(gateRepo, checkProviders,
{subjectCandidateSetRef, assessmentCandidateSetRefs, ...})` and returns a
verdict. For an author role the subject is the author CandidateSet; for a
reviewer the subject is the **author** CandidateSet and the assessment is
the reviewer's verdict CandidateSet. The gate never looks at the live desk —
only at the sealed immutable material.

### 4.4 What the reviewer sees

`candidate_read` (in `src/tools/products.ts` line 141) is the reviewer's
view. After re-reading the sealed ProductRefs it explicitly refuses to
reconstruct from presenter execution or current live state:

```ts
// CandidateSet is the immutable QC handoff. Do NOT reconstruct its material
// from presenter execution provenance or from the current live Workplace.
// Read the exact sealed ProductRefs and, for managed-production members,
// expose the artifact/trace snapshot persisted BEFORE CandidateSet sealing.
```

For each member:
- If `productRef.ref` starts with `managed-node-submission:` → read the row
  from `factory_managed_node_submissions` and expose `payload_snapshot`.
- Otherwise look it up via `productRepo().getByProductRef(productRef)` in
  `factory_process_products` — this is where managed-production snapshots
  live.

The `produced_artifacts` and `produced_traces` fields are flat-mapped from
the WorkplaceProductionSnapshot members; the reviewer sees the exact sealed
material, never the live desk.

---

## 5. ReplayCapsule

### 5.1 Definition

A ReplayCapsule is the certified archival of one accepted worker production
so that a future run producing the same semantic output can replay it
without calling the LLM. It is "an internal production source of the normal
fenced WorkerExecution, not another Factory/executor mode" (see header of
`capsule-replay-executor.ts`).

The payload type is in `src/replay/replay-capsule.ts` (lines 104-113):

```ts
export interface ReplayCapsulePayload {
  readonly schemaVersion: typeof REPLAY_CAPSULE_SCHEMA; // 'factory.replay-capsule.v1'
  readonly key: ReplayKeyMaterial;
  readonly replayKey: string;
  readonly inputBindings: readonly ReplayInputBinding[];
  readonly typedProducts: readonly ReplayTypedProduct[];
  readonly artifacts: readonly ReplayArtifactProduct[];
  readonly traces: readonly ReplayTraceProduct[];
  readonly git: ReplayGitRecipe | null;
}
```

A capsule contains ONLY worker production. It NEVER stores GateDecision,
lifecycle state, task status or any other authority (lines 98-103).

### 5.2 When is it created?

Two paths converge on `SqliteReplayCapsuleRepository.captureAcceptedExecution`
(line 463):

1. **Direct certification** — `replay-capture-effect` runs as a universal
   post-acceptance effect from `ProductionCellNodeExecutor.recordFinalAcceptanceAndCapture`
   (line 667) right after the Workplace is durably `terminal(accepted)`:

   ```ts
   // UNIVERSAL: replay capture runs for EVERY accepted candidate, regardless
   // of module. This is not a cell-specific effect — it is the factory-wide
   // mechanism that archives accepted production for future deterministic
   // replay. Best-effort: failure never revokes the GateDecision.
   try {
     this.opts.postAcceptanceEffects.run('replay-capture', effectInput);
   } catch { /* Best-effort: replay capture failure is logged inside. */ }
   ```

2. **Lazy certification** — `certifyAcceptedReplayCapsules` in
   `replay-claim-binder.ts` (line 196) is called by `bindReplayToClaim`
   every time a worker is about to be spawned. It scans every
   `factory_workplaces` row that is `terminal(accepted)` and backfills any
   missing capsule. This is a crash-recovery fallback for the rare case
   where direct capture failed or never ran.

Both paths wrap capture in `captureReplayCapsuleFailClosed` (in
`replay-capsule-completeness.ts` line 175): if the completeness proof
(`assertReplayCapsuleComplete`) fails, the partial row is deleted.

### 5.3 The replay key

Cross-run identity is the heart of the system. `ReplayKeyMaterial` (lines
10-32):

```ts
export interface ReplayKeyMaterial {
  readonly projectId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly productionCellId: string;
  readonly workKey: string;
  readonly role: 'author' | 'reviewer';
  readonly packageDigest: string;
  /** Cross-run-stable semantic input digest (CONVEYOR v4.3 §8-9). */
  readonly semanticInputDigest: string;
  /**
   * Reviewer capsules are pinned to the semantic author production digest
   * (CONVEYOR v4.3 §10): a canonical { schemaId, digest } multiset of the
   * subject author CandidateSet's products.
   */
  readonly subjectProductionDigest: string | null;
}

export function computeReplayKey(input: ReplayKeyMaterial): string {
  return sha256Hex({ schema: REPLAY_CAPSULE_SCHEMA, ...input });
}
```

Critical property: every field is **cross-run stable**. The
`semanticInputDigest` is NOT the raw `nodeInputHash` (which includes
provenance) — it is authored by the Production Cell from canonical business
input for entry cells, or from `upstream.semanticDigest + itemId +
itemDigest` for fan-out cells. See `computeSemanticInputDigest` in
`production-cell-node-executor.ts` (line 1116).

For a reviewer, `subjectProductionDigest` is `sha256Hex` over the
canonical multiset of author products with each product's digest
substituted by its stable semantic digest
(`resolveStableProductDigest`). This is computed in
`SqliteReplayCapsuleRepository.resolveClaim` (line 378-405).

### 5.4 What does a capsule archive?

`captureAcceptedExecution` reads ONLY the immutable CandidateSet
(`readCandidateMembers`) — never the execution's own raw writes. The P18
boundary (lines 455-462):

> sourceExecutionRef remains audit/key provenance (the execution that
> presented the set), but product material is resolved exclusively from the
> immutable CandidateSet ProductRefs. This is the P18 boundary: an accepted
> replacement execution may have written nothing itself.

For each CandidateSet member:
- If `product_ref` starts with `managed-node-submission:` → load typed
  product from `factory_managed_node_submissions`. The payload is templated
  against `inputBindings` so that run-local ids (artifactId, traceId,
  task ids, hashes etc.) become `{ $sagaReplayInput: '<path>' }` markers
  (`templateAgainstInput`, line 155).
- Otherwise → load from `factory_process_products`; must be a
  `WorkplaceProductionSnapshot`. Collect its artifact ids and trace ids.

Artifacts and traces are then resolved by id, selectors are written
(`{ type, code, title, path, contentHash }`), file bytes are read
base64-encoded (when `storage_kind = 'file_backed'`), parents resolved.
Task-targeted traces record `targetTaskGenerationKey` (the generationKey
format) instead of an opaque id so they can be re-resolved against the
current run.

For `git_change` executions the capsule also captures a `ReplayGitRecipe`
(`captureGitRecipe`, line 220): the binary patch from `baseCommit` to
`sourceCommit`, the tree sha, the exact committer/author identities and
dates, the commit message.

### 5.5 How replay works (zero LLM calls)

Two-stage: bind, then execute.

**Bind.** `bindReplayToClaim` (`replay-claim-binder.ts` line 281) runs as
the final step of `worker_next` assignment. It:
1. Resolves `ReplayKeyMaterial` from the task's metadata (returns null if
   `semantic_input_digest` was not frozen).
2. Calls `certifyAcceptedReplayCapsules` (lazy backfill).
3. Computes `replayKey = computeReplayKey(material)`.
4. Looks up `factory_replay_capsules` by `(project_id, replay_key)`. If
   none → miss; freeze only the `replayKey` on the execution metadata.
5. Hit: check `isCapsuleIneligibleInWorkplace` (rejects capsules already
   rejected by a gate in this Workplace, or whose replay execution
   previously failed).
6. Stamps `execution_context.replay = { key, key_material, capsule_ref,
   capsule_payload_hash }` onto `worker_executions.metadata`.

**Execute.** `ClaudeBoardWorkerExecutor.start` checks
`hasFrozenCapsule(assignment)` (line 50). If true, it dispatches to the
in-process replay runner instead of spawning the CLI. The runner
(`createInProcessReplayRunner` in `claude-worker-executor-factory.ts` line
651):
1. Sets `SAGA_MANAGED_EXECUTION`, `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`,
   `SAGA_WORKER_ID` env vars (same as a spawned worker's env).
2. Flips the execution row `reserved → running`.
3. Calls `executeCapsuleReplay(db, handlers, { taskId, workerId,
   executionId, cwd })`.

`executeCapsuleReplay` (`capsule-replay-executor.ts` line 72) is the heart
of the reproduction:
1. Load the capsule by `capsule_ref`.
2. Verify `payload_hash` against the recomputed `sha256Hex(payload)` —
   tamper detection. Verify the frozen `capsule_payload_hash` matches.
3. For each artifact in `payload.artifacts`: rebind metadata, materialise
   the file bytes (verify `sha256` against `selector.contentHash`), call
   `handlers.artifact_create(...)`. Build an `artifactIdBySelector` map
   for parent and trace resolution.
4. For each trace in `payload.traces`: resolve source and target via the
   map or by selector match against existing artifacts in this project
   (`resolveExistingArtifactId`); for task targets, resolve by
   `generation_key` first, then by cross-run semantic identity
   (`module_ref + production_cell_id + work_key + role`,
   `resolveCurrentTaskFromCapturedGenerationKey`). Call
   `handlers.trace_add(...)`.
5. If `payload.git`: `applyGitRecipe` — verify worktree HEAD matches
   `baseCommit`, verify integration branch matches, require clean
   worktree, checkout the source branch, `git apply --index` the patch,
   commit with the captured author/committer identity and dates, verify
   produced tree sha and commit sha match exactly, checkout integration.
6. For each `payload.typedProducts`: rehydrate templated values
   (`rehydrateReplayValue`), rebind authority references
   (`rebindReplayAuthorityReferences`), call
   `handlers.product_submit({ schema, content })`.
7. Calls `handlers.worker_done(...)` — the normal lifecycle advances, the
   GateRun runs, the gate independently decides accept/reject.

The handlers are the SAME MCP handlers exposed to a spawned worker (line
667-720), so replay and inference are observationally indistinguishable to
the gate.

On success the executor marks the run `completed`. On failure it checks
whether a durable `worker_done` had already landed (e.g. the gate accepted
the replay but the runner crashed afterwards) — if yes, treat as success;
otherwise `recoverReplayFailure`.

### 5.6 The completeness proof

`assertReplayCapsuleComplete` (`replay-capsule-completeness.ts` line 50)
proves the capsule reconstructs the EXACT accepted CandidateSet:
- For typed members: the `typedProducts` set matches the expected
  `(schema, contentHash)` pairs.
- For managed members: the artifact and trace id sets are non-empty and
  every expected id has a captured selector; file-backed artifacts must
  have file bytes; parent ids must be captured; task-targeted traces
  must have `targetTaskGenerationKey`.
- For `git_change` executions: `payload.git !== null`.

Failure of the proof deletes the partial capsule row
(`captureReplayCapsuleFailClosed`).

### 5.7 Replay tables

```sql
CREATE TABLE factory_replay_capsules (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  capsule_ref               TEXT NOT NULL UNIQUE,
  replay_key                TEXT NOT NULL,
  project_id                INTEGER NOT NULL REFERENCES projects(id),
  source_execution_ref      TEXT NOT NULL,
  source_candidate_set_ref  TEXT NOT NULL,
  payload_hash              TEXT NOT NULL,
  payload_snapshot          TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(replay_key, payload_hash)
);
CREATE INDEX idx_factory_replay_capsules_lookup
  ON factory_replay_capsules(project_id, replay_key, id DESC);
```

`UNIQUE(replay_key, payload_hash)` allows the same `replay_key` to evolve
(when a cell definition changed but the work identity did not) — the
binder always picks the latest by `id DESC`.

---

## 6. ProductRef

### 6.1 The triple

From `src/process-modules/domain/spi/production-envelope.ts` (line 185):

```ts
/**
 * Pure, serializable reference to a single product produced by a node.
 *
 * `schemaId` is the schema identity (e.g. 'factory.discovery-proposal.v1').
 * `ref` is an opaque, module-owned artifact reference (e.g. 'proposal:141').
 * `digest` is the SHA-256 over the canonical product body — lowercase hex,
 * immutable, content-addressing the exact bytes.
 */
export interface ProductRef {
  readonly schemaId: string;
  readonly ref: string;
  readonly digest: string;
}
```

The triple is the ONLY way to reference a product durably. `product_read`
advertises this explicitly in its description:

> Read one immutable product by the exact ProductRef triple returned by the
> factory. No latest/by-task fallback is allowed.

### 6.2 How `product_read` works

`productRead` in `src/tools/products.ts` (line 95) splits on the `ref`
prefix:

- `managed-node-submission:<id>` → read row `id` from
  `factory_managed_node_submissions`, verify `schema_version === schemaId`
  and `content_hash === digest`, else `PRODUCT_NOT_FOUND`. Returns the
  parsed payload plus all provenance fields (processRunId, moduleId,
  nodeId, intentId, taskId, executionId, submittedAt).
- Otherwise → `productRepo().getByProductRef({schemaId, ref, digest})`
  which reads `factory_process_products` by exact triple.

Any mismatch in schema or digest throws `PRODUCT_NOT_FOUND`. There is no
fuzzy match.

### 6.3 Immutability guarantees

Three layered guarantees:

1. **Schema-level triggers** on `factory_managed_node_submissions`
   (`MANAGED_NODE_SUBMISSION_IMMUTABLE` on UPDATE,
   `MANAGED_NODE_SUBMISSION_DELETE_FORBIDDEN` on DELETE).
2. **Content-addressed uniqueness** in `factory_process_products` and the
   universal desk: a second submit with the same `(schema, ref)` but
   different `digest` throws `WORKPLACE_PRODUCT_REPLAY_MISMATCH`.
3. **CandidateSet immutability**: `factory_candidate_sets.candidate_set_digest`
   + the UNIQUE seal key `(workplace_ref, production_revision_ref, role, subject)`.
   Re-sealing the same key with a different digest throws
   `CANDIDATE_SET_REPLAY_MISMATCH`.

Plus the read-time validators: `rowToRecord` (line 384) re-canonicalises
and re-hashes every row and throws `MANAGED_NODE_SUBMISSION_CORRUPT` on any
drift.

### 6.4 `ref` shapes in practice

| productSource | ref shape | example |
|---|---|---|
| typed-submission | `managed-node-submission:<row-id>` | `managed-node-submission:42` |
| managed-production (Workplace desk) | `workplace-production:<workplaceRef>:<schemaId>:<contentHash>` (emitted by `submitProduct`) | `workplace-production:workplace/3/.../default:factory.formalization-product-bundle.v1:ab12...` |
| Universal desk (cross-module) | `desk:<schemaRef>:content:<contentHash>` | `desk:factory.discovery-proposal.v1:content:ab12...` |
| Discovery proposal ref | `proposal:<proposalId>` | `proposal:7` |

---

## 7. Scripting implications (for LLM-free testing)

### 7.1 Managed-production nodes

A scripted worker does NOT call `product_submit`. The script:

1. Calls `worker_next` (gets a task with `metadata.product_source =
   'managed-production'`).
2. Calls `artifact_create` (one or more), `artifact_update` if needed,
   `trace_add` for lineage. These writes land on the Workplace desk via
   `factory_managed_artifact_productions` /
   `factory_managed_trace_productions`.
3. Calls `worker_done({ task_id, worker_id, result, execution_id })`.

The factory then:
- `requireProductionCellSubmission` returns immediately because
  `metadata.product_source === 'managed-production'`.
- `ProductionCellNodeExecutor.reconcile` reads the desk, freezes a
  `WorkplaceProductionSnapshot`, persists it via `submitProduct`, seals
  the CandidateSet, runs the gate.
- On accept, the post-acceptance effect chain runs and the replay capsule
  is captured directly.

Scripted test implication: assert the resulting CandidateSet members are
`managed-production` refs (i.e. NOT `managed-node-submission:`); assert the
snapshot's `artifacts`/`traces` arrays match the writes; assert
`contributingExecutionRefs` includes the worker execution.

### 7.2 Typed-submission nodes

A scripted worker MUST call `product_submit` (or `process_node_submit`)
with the exact schema declared by the WorkIntent. The script:

1. Calls `worker_next`.
2. Does whatever work it needs to compute the product.
3. Calls `product_submit({ schema: '<declared schema>', content: {...} })`
   — exactly once. Equal content is idempotent; differing content under
   the same execution throws `MANAGED_NODE_SUBMISSION_ALREADY_FINAL`.
4. Calls `worker_done`.

`requireProductionCellSubmission` will reject `worker_done` with
`PRODUCTION_CELL_PRODUCT_REQUIRED` if `product_submit` was skipped, and
with `PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH` if the submitted schema
differs from `factory_work_intents.output_schema`.

The Discovery projection is automatic: submitting a
`factory.discovery-proposal.v1` product triggers
`projectDiscoveryProposal`, which writes into `factory_proposals` — the
readiness gate cannot tell inference and scripted submission apart.

### 7.3 Replay: pre-seeding capsules for LLM-free tests

Replay is the cleanest LLM-free mode: a capsule carries the full
reproduction recipe. Two strategies:

**Strategy A — capture once, replay many.** Run the factory once with a
real (or scripted) worker. The direct certification path will write
`factory_replay_capsules` for every accepted Workplace. Snapshot the
SQLite DB. In the test, restore the snapshot and trigger the same work
item — `bindReplayToClaim` will hit, `executeCapsuleReplay` reproduces the
artifacts/traces/git/products through the same MCP handlers, the gate
re-evaluates and accepts. Zero LLM calls.

**Strategy B — manually seed a capsule.** The schema is documented above
(§5.4). A test can:
1. Build a `ReplayCapsulePayload` with the artifacts/traces/typedProducts
   you want reproduced. Use `templateAgainstInput`/`$sagaReplayInput`
   markers for any field that depends on run-specific ids.
2. `sha256Hex(payload)` → `payload_hash`. `capsule_ref =
   'replay-capsule:<replayKey>:<payload_hash>'`.
3. INSERT into `factory_replay_capsules`.
4. Set up tasks whose metadata carries the same `{ process_run_id,
   process_node_id, process_module_ref, production_cell_id, work_key,
   role, semantic_input_digest }`. Bind `factory_process_runs.package_digest`
   to match the key material.
5. Trigger the assignment. The executor will detect the frozen capsule
   and dispatch the in-process replay.

The subtlety: `semantic_input_digest` must match. The Production Cell
authored it during the original run from canonical business input; for
manual seeding, compute it yourself using the same rules
(`computeSemanticInputDigest` in production-cell-node-executor.ts). Entry
cell: `sha256Hex(canonicalizeLifecycleInput(input))`. Fan-out:
`sha256Hex({ upstreamSemanticDigest, immediateUpstreamSemanticDigest,
itemId, itemDigest })`.

For git_change executions the capsule MUST include a `git` recipe
(verified by `assertReplayCapsuleComplete`), otherwise completeness
throws `REPLAY_CAPTURE_GIT_RECIPE_MISSING`.

### 7.4 Verification checklist

When a scripted test for a cell completes:

- [ ] `factory_managed_node_submissions` has the expected row(s) for
      typed-submission cells; empty for managed-production cells.
- [ ] `factory_managed_artifact_productions` /
      `factory_managed_trace_productions` have the expected writes for
      managed-production cells.
- [ ] `factory_process_products` has the typed product AND, for
      managed-production cells, the frozen
      `factory.workplace-production-snapshot.v1` product.
- [ ] `factory_candidate_sets` + `factory_candidate_set_members` have one
      sealed set per role; `candidate_set_digest` matches recomputation.
- [ ] `factory_gate_decisions` has the expected verdict.
- [ ] On accepted: `factory_cell_final_acceptances` has a row; and
      `factory_replay_capsules` has a row whose `payload_hash` verifies
      and whose `source_candidate_set_ref` matches the accepted set.
- [ ] `task.metadata.product_source` is set correctly
      (`'managed-production'` for Formalization authors,
      `'typed-submission'` for typed cells and all reviewers).
- [ ] Reviewer-only: `candidate_read(workplace_ref, 'reviewer')` returns
      the verdict; `produced_artifacts` is empty (the verdict is a typed
      product).

### 7.5 Quick reference — what to call from a test script

| goal | call |
|---|---|
| produce a typed product | `product_submit({schema, content})` |
| produce a managed-production desk write | `artifact_create(...)` then `trace_add(...)` |
| read a typed product back | `product_read({schema_id, ref, digest})` |
| read the sealed QC batch | `candidate_read({workplace_ref, role})` |
| complete the work | `worker_done({task_id, worker_id, result, execution_id})` |
| integrate (git_change) | `worker_merge_acquire` → `git merge` → `worker_merge_release({result:'merged', commit_sha})` |
