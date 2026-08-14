# Development Scenario Design — LLM-Free Scripted Test

This document is the complete specification of MCP tool calls for **цех Development**
(`solution-development@1.1.0`), the third stage of the Product Delivery conveyor
(Discovery → Formalization → **Development** → Delivery). It is written so a
scripted test double (no LLM) can drive every Development node — planning,
parallel implementation, review, integration, candidate freeze, independent
verification, and deterministic settlement — to the green terminal outcome
`verified`.

Every claim below is backed by quoted code. File paths are absolute under
`D:/Development/saga-mcp/`.

Development is the most complex stage of the conveyor: it fans out parallel
git-changing workers in isolated worktrees, runs a runtime-owned merge, freezes
one immutable candidate, then independently verifies each AC against that
candidate. The scripted harness must reproduce the exact tool sequence a real
`saga-worker` would emit, including `product_submit` before every `worker_done`.

---

## 1. Node Graph (the Flow)

### 1.1 Flow identity

From `src/process-modules/modules/development/development-process-module.ts:116-119`:

- `flow.id = 'factory.development.standard'`
- `flow.version = '2.0.0'`
- `entryNodeId = 'plan-task-graph'`

Module identity is `solution-development@1.1.0` (`DEVELOPMENT_PROCESS_MODULE_REF`,
re-exported at line 39 from
`src/process-modules/lifecycles/product-delivery-module-contracts.js`).

### 1.2 The node graph in execution order

```
plan-task-graph           (production-cell, singleton)  → task-graph proposal
        │ domain.accepted
        ▼
resolve-task-graph        (kernel)                       → canonicalized task-graph snapshot
        │ domain.valid                                      │ domain.clarification-required
        │                                                   │ domain.failed
        ▼                                                   ▼
implement-work-items      (production-cell, FAN-OUT)     settle-development (early)
   ┌──────┴──────┐                                  each item: author → gate → reviewer → final-gate
   item A         item B   (parallel, isolated worktrees)
   │ accepted     │ accepted    (postAcceptanceEffect: 'git-integration' merges each into dev)
   └──────┬──────┘
        │ domain.accepted  (completionPolicy: 'all')
        ▼
freeze-integrated-candidate (kernel)                    → immutable IntegratedReleaseCandidate
        │ domain.frozen          │ domain.failed
        ▼                         └→ settle-development
verify-acceptance          (production-cell, FAN-OUT)    → one evidence product per AC
   ┌──────┴──────┐
   verify AC-1   verify AC-2   (read-only detached checkout at frozen candidate)
   │ accepted     │ accepted
   └──────┬──────┘
        │ domain.accepted  (completionPolicy: 'all')
        ▼
settle-development        (kernel)                       → Development Certificate
        │ domain.verified | domain.rework-required
        │ domain.clarification-required | domain.blocked | domain.failed
        ▼
complete-verified | complete-rework-required | complete-clarification-required
complete-blocked  | complete-failed
```

Plus 5 terminal outcome-emitter nodes
(`development-process-module.ts:276-284`) — each is `kind: 'kernel'`,
`handler: 'process-outcome-emitter'`, and just emits its outcome code.

### 1.3 Transitions (full table from `development-process-module.ts:286-304`)

| From | To | On event |
|------|-----|----------|
| `plan-task-graph` | `resolve-task-graph` | `domain.accepted` |
| `plan-task-graph` | `complete-failed` | `domain.failed` |
| `resolve-task-graph` | `implement-work-items` | `domain.valid` |
| `resolve-task-graph` | `settle-development` | `domain.clarification-required` |
| `resolve-task-graph` | `settle-development` | `domain.failed` |
| `implement-work-items` | `freeze-integrated-candidate` | `domain.accepted` |
| `implement-work-items` | `complete-failed` | `domain.failed` |
| `freeze-integrated-candidate` | `verify-acceptance` | `domain.frozen` |
| `freeze-integrated-candidate` | `settle-development` | `domain.failed` |
| `verify-acceptance` | `settle-development` | `domain.accepted` |
| `verify-acceptance` | `complete-failed` | `domain.failed` |
| `settle-development` | `complete-verified` | `domain.verified` |
| `settle-development` | `complete-rework-required` | `domain.rework-required` |
| `settle-development` | `complete-clarification-required` | `domain.clarification-required` |
| `settle-development` | `complete-blocked` | `domain.blocked` |
| `settle-development` | `complete-failed` | `domain.failed` |

### 1.4 Outcomes (`development-process-module.ts:109-115`)

| Code | Terminal | Meaning |
|------|----------|---------|
| `verified` | yes | All required implementation + acceptance evidence binds to the unchanged frozen candidate |
| `rework-required` | yes | Implementation/review/evidence found a product defect needing a new cycle |
| `clarification-required` | yes | Accepted decomposition cannot become a complete deterministic task graph |
| `blocked` | yes | Required work, trusted evidence, integration state, or a human decision is unavailable |
| `failed` | yes | Development infrastructure or immutable lineage validation failed |

### 1.5 Module invariants (`development-process-module.ts:325-334`)

| ID | Description | Enforcement |
|----|-------------|-------------|
| `development.planner-cell-gates-graph` | Task-graph semantics accepted or repaired inside the planner Cell before kernel materialization | runtime |
| `development.review-before-integration` | Only the exact source commit accepted by the implementation Cell may enter integration | policy |
| `development.integrate-before-verification` | Integration completes and one candidate freezes before verification starts | runtime |
| `development.evidence-pins-candidate` | Every acceptance record pins the accepted AC hash AND frozen candidate hash | policy |
| `development.no-post-verification-mutation` | Candidate drift invalidates prior evidence | policy |
| `development.unknown-denies` | `unknown`/`error` verification never authorizes a `verified` bundle | policy |
| `development.exact-lineage` | All cells/kernels consume exact immutable refs/hashes | test |
| `development.module-does-not-route` | Development emits only local outcomes; lifecycle routing is external | static |

These invariants are the load-bearing facts the scripted scenario must
preserve. They are enforced by code paths quoted in later sections.

---

## 2. The Planning Node — `plan-task-graph`

### 2.1 Cell shape

From `development-process-module.ts:120-142`. The planner is a **singleton
Production Cell** (one Workplace, not fan-out):

```ts
{
  id: 'plan-task-graph',
  kind: 'production-cell',
  inputSchema: { id: DEVELOPMENT_CASE_SCHEMA },                       // factory.development-case.v1
  outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },       // factory.development-task-graph-proposal.v1
  cellDefinition: singletonProductionCell({
    id: 'development-plan-task-graph',
    executionProfileId: 'development-task-graph-planner',
    outputSchemaRef: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    productSource: 'typed-submission',         // planner MUST call product_submit
    cardinality: '1',
    maxAttempts: 2,
    onExhausted: 'pause',
    checkPlan: PLANNER_CHECK_PLAN,             // development.plan-task-graph.final
    acceptedTransition: 'resolve-task-graph',
    failedTransition: 'complete-failed',
    humanRequiredTransition: 'complete-blocked',
  }),
}
```

The planner execution profile (`development-process-module.ts:335-359`):

| Field | Value |
|-------|-------|
| `id` | `development-task-graph-planner` |
| `workIntentKind` | `development.plan-task-graph` |
| `taskKind` | `planning.decomposition` |
| `executionSkill` | `saga-planner` |
| `executionMode` | `tracker_only` (no git) |
| `allowedTools` | read tools + `conflict_check`, `product_submit`, `worker_done`, `Write`, `Edit`, `Bash` |
| `outputSchema` | `factory.development-task-graph-proposal.v1` |
| `retryPolicy.retryOn` | `['schema-rejected', 'lineage-gap']` |

### 2.2 What feeds the planner — the DevelopmentCase

The planner's frozen input is the **DevelopmentCase**
(`src/modules/development/domain/development-schemas.ts:144-158`):

```ts
interface DevelopmentCase {
  schemaVersion: 'factory.development-case.v1';
  projectId: number;
  epicId: number;
  formalizationCertificate: ContentAddressedReference & { decision: 'formalized' };
  solutionContract:    ContentAddressedReference;
  acceptanceBaselineHash: string;
  srs:                 ContentAddressedReference;
  acceptanceCriteria:  readonly AcceptanceCriterionBinding[];
  repositories:        readonly DevelopmentRepositoryBinding[];
  policy:              DevelopmentPolicySnapshot;
  initiatedBy: string;
}
```

Each `AcceptanceCriterionBinding` (`development-schemas.ts:121-136`) carries:

```ts
{
  artifactId: number;             // canonical AC artifact id
  code: string | null;            // e.g. 'AC-1'
  acceptedHash: string;           // the AC's accepted content_hash — pin target
  implementationRequired: boolean;
  criticality: 'blocker' | 'degradable' | 'nice_to_have';
}
```

Each `DevelopmentRepositoryBinding` (`development-schemas.ts:138-142`) carries:

```ts
{
  projectRepositoryId: number;
  integrationBranch: string;        // typically 'dev'
  expectedBaseCommit: string;       // frozen base — worktrees branch from here
}
```

The DevelopmentCase is built by lifecycle Formalization settlement and frozen
into `factory_process_runs.input_snapshot` before Development starts. The
planner reads it back via `task.metadata.process_node_input`
(see `development-workspace-preparation.ts:39-63` for the validation that
parses `process_node_input` back into a typed `DevelopmentCase`).

### 2.3 What the planner produces

A typed `DevelopmentTaskGraphProposal`
(`development-schemas.ts:195-200`):

```ts
interface DevelopmentTaskGraphProposal {
  schemaVersion: 'factory.development-task-graph-proposal.v1';
  implementationItems:  readonly DevelopmentTaskGraphItem[];
  verificationItems:    readonly DevelopmentTaskGraphItem[];
  integrationTargets:   readonly CandidateIntegrationTarget[];
}
```

Each `DevelopmentTaskGraphItem` (`development-schemas.ts:164-181`):

```ts
{
  key: string;                     // stable unique id, e.g. 'impl-AC-1'
  kind: 'implementation' | 'verification';
  taskKind: string;                // 'development.code' or 'verification.ac'
  executionSkill: string;
  executionMode: string;           // 'git_change' or 'read_only_evidence'
  projectRepositoryId: number;
  acceptanceCriterionIds: readonly number[];   // coverage obligation
  dependsOnKeys: readonly string[];            // DAG edges (impl items only)
  changeScopes: readonly string[];             // repo-local ownership units
  required: boolean;
  criticality: AcceptanceCriticality;          // carried from AC binding
}
```

Each `CandidateIntegrationTarget` (`development-schemas.ts:183-188`):

```ts
{
  projectRepositoryId: number;
  sourceWorkItemKeys: readonly string[];       // impl items merged into this repo
  targetBranch: string;                        // 'dev'
  expectedBaseCommit: string;
}
```

A machine-filled template is materialized into the planner's workspace by
`buildDevelopmentTaskGraphSubmitCallFromCase`
(`src/modules/development/application/development-workspace-preparation.ts:77-118`).
That helper auto-generates **verification items** (one per AC, `kind=verification`,
`taskKind=verification.ac`, `executionSkill=saga-verifier`,
`executionMode=read_only_evidence`) and **integration targets** (one per
repository). It deliberately leaves `implementationItems` empty — the planner
owns decomposition, never the machine.

### 2.4 Planner check plan

The author gate runs `DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID`
(`development.check-providers.ts:25-32`). Its `run()` function
(`development-check-providers.ts:84-132`):

1. Reads the CandidateSet, asserts `role==='author'`.
2. Loads the matching `factory_managed_node_submissions` row, asserts
   `schema_version === DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA`.
3. Decodes the proposal via `decodeDevelopmentTaskGraphProposal`.
4. Re-reads the DevelopmentCase from `factory_process_runs.input_snapshot`.
5. Builds the canonical graph via `buildCanonicalDevelopmentTaskGraph`.
6. Runs `policy.validate(developmentCase, graph)` and returns `passed`/`failed`.

This is the gate the planner Cell runs BEFORE the proposal is accepted. A
scripted planner must produce a proposal that survives this validation.

### 2.5 `resolve-task-graph` kernel

After the planner Cell accepts, the kernel handler
`DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph = 'development-resolve-task-graph'`
(`development-kernel-ports.ts:75-84`) canonicalizes the proposal:
re-validates ids, dependencies, repository bindings, coverage, fills immutable
lineage fields, computes `graphHash`, and persists a
`DevelopmentTaskGraphSnapshot` (`development-schemas.ts:202-214`). On
`domain.valid` the flow proceeds to `implement-work-items`; on
`domain.clarification-required` or `domain.failed` it routes to
`settle-development` early.

### 2.6 Planner scripted actions

From `tests/factory-contract/golden-path-scenarios.mjs:229-281`:

```js
const developmentPlan = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const developmentCase = findObject(
    meta.process_node_input ?? meta.cell_input_item ?? meta,
    value => value.schemaVersion === 'factory.development-case.v1',
  );
  if (!developmentCase) throw new Error('DevelopmentCase not found');
  const repo = developmentCase.repositories[0];
  const criteria = developmentCase.acceptanceCriteria || [];

  const implementationItems = criteria
    .filter(ac => ac.implementationRequired)
    .map(ac => ({
      key: `impl-${ac.artifactId}`,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: repo.projectRepositoryId,
      acceptanceCriterionIds: [ac.artifactId],
      dependsOnKeys: [],
      changeScopes: [`ac-${ac.artifactId}`],
      required: true,
      criticality: ac.criticality || 'blocker',
    }));

  const verificationItems = criteria.map(ac => ({
    key: `verify-${ac.artifactId}`,
    kind: 'verification',
    taskKind: 'verification.ac',
    executionSkill: 'saga-worker',
    executionMode: 'read_only_evidence',
    projectRepositoryId: repo.projectRepositoryId,
    acceptanceCriterionIds: [ac.artifactId],
    dependsOnKeys: [],
    changeScopes: [],
    required: true,
    criticality: ac.criticality || 'blocker',
  }));

  await actions.submitProduct(
    client,
    'factory.development-task-graph-proposal.v1',
    {
      schemaVersion: 'factory.development-task-graph-proposal.v1',
      implementationItems,
      verificationItems,
      integrationTargets: [{
        projectRepositoryId: repo.projectRepositoryId,
        sourceWorkItemKeys: implementationItems.map(i => i.key),
        targetBranch: repo.integrationBranch,
        expectedBaseCommit: repo.expectedBaseCommit,
      }],
    },
  );
  await actions.done(client, Number(prompt.task_id),
    prompt.worker_id, prompt.execution_id,
    `planned ${implementationItems.length} impl + ${verificationItems.length} verify items`);
};
```

Scenario key: `${DEV}/plan-task-graph/author/singleton`
(see `golden-path-scenarios.mjs:416`).

---

## 3. The Implementation Node — `implement-work-items` (development.code)

### 3.1 Cell shape (FAN-OUT)

From `development-process-module.ts:154-205`. This is a fan-out Production Cell
that materializes one Workplace per `implementationItems` entry:

```ts
{
  id: 'implement-work-items',
  kind: 'production-cell',
  cellDefinition: {
    id: 'development-implementation',
    inputSelectors: ['resolve-task-graph.items'],
    materialization: {
      sourceBinding: 'resolve-task-graph',
      workKeySelector: 'items',
      dependencySelector: 'dependsOnKeys',
      completionPolicy: 'all',
      taskProvenance: { sourceArtifactIdsSelector: 'acceptanceCriterionIds' },
    },
    author: {
      skillRef: 'development-implementation-worker',
      capabilityPreset: 'sandbox-code-author',
    },
    productContracts: [{
      binding: 'implementationResult',
      schemaRef: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,    // factory.development-implementation-result.v1
      mediaType: 'application/json',
      cardinality: '1',
      productSource: 'typed-submission',                       // worker MUST product_submit
    }],
    authorGate: {
      gateId: 'development-implementation-author',
      gatePhase: 'author',
      checkPlan: IMPLEMENTATION_AUTHOR_PLAN,                   // product-contract check
    },
    review: {
      reviewer: { skillRef: 'development-implementation-reviewer', capabilityPreset: 'sandbox-code-reviewer' },
      verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,     // factory.development-review-verdict.v1
      finalGate: {
        gateId: 'development-implementation-final',
        gatePhase: 'final',
        checkPlan: IMPLEMENTATION_FINAL_PLAN,                  // review-verdict check; repairTargetRoleOnFailure='author'
      },
    },
    recovery: { maxAttempts: 2, onExhausted: 'pause' },
    postAcceptanceEffect: 'git-integration',                   // factory merges source commit into dev
    transitions: {
      accepted: 'freeze-integrated-candidate',
      humanRequired: 'complete-blocked',
      failed: 'complete-failed',
    },
  },
}
```

Key facts:
- `productSource: 'typed-submission'` — every author worker MUST call
  `product_submit({ schema: 'factory.development-implementation-result.v1', content })`
  before `worker_done`. The MCP layer enforces this in
  `requireProductionCellSubmission` (`src/tools/dispatcher.ts:1914-1985`).
- `postAcceptanceEffect: 'git-integration'` — the runtime (NOT the worker)
  merges the reviewed source commit into `dev`. The worker never runs `git merge`.
- `completionPolicy: 'all'` — every item must reach `terminal(accepted)`.
- `dependencySelector: 'dependsOnKeys'` — items wait for their declared
  dependencies. The Production Cell reconciler
  (`production-cell-node-executor.ts:386-403`) blocks an idle item until every
  dependency is `terminal(accepted)`.

### 3.2 Implementation execution profile

From `development-process-module.ts:361-379`:

| Field | Value |
|-------|-------|
| `id` | `development-implementation-worker` |
| `taskKind` | `development.code` |
| `executionMode` | `git_change` |
| `allowedTools` | `COMMON_WRITE_TOOLS` (read tools + `worker_done`, `worker_merge_acquire/release`, `verification_record`, `product_submit`, `Write`, `Edit`, `Bash`) |
| `outputSchema` | `factory.development-implementation-result.v1` |
| `retryPolicy.retryOn` | `['review-rejected', 'merge-conflict']` |

### 3.3 How is the git worktree provisioned? — RepositoryDeskProvisioner

The factory (NOT the worker) provisions a per-task git worktree BEFORE the
worker process spawns. The single place that runs `git worktree` is
`src/infrastructure/workers/repository-desk-provisioner.ts`.

For an **author desk** (`repository-desk-provisioner.ts:120-207`):

1. Branch name is deterministic: `worktreeBranchName(taskId)` returns
   `task/${taskId}` (line 73-75).
2. Worktree path is deterministic: `worktreePath(repoRoot, taskId, 'task')`
   returns `<repoRoot>/.worktrees/task-<taskId>` (line 77-79).
3. Base commit comes from `DevelopmentCase.repositories[].expectedBaseCommit`
   (the scripted executor reads it from
   `factory_process_runs.input_snapshot`, see
   `scenario-scripted-executor.mjs:162-178`).
4. Provision is **idempotent**: if the worktree already exists on the right
   branch AND its HEAD descends from the base commit, it is reused
   (lines 143-159).
5. Provision asserts ancestry via `git merge-base --is-ancestor` (line 95-102)
   and throws `REPOSITORY_DESK_BASE_MISMATCH` if the worktree HEAD has drifted
   off the base.

The resulting `RepositoryDesk` (line 279-309) carries:

```ts
{
  projectRepositoryId, repositoryRoot, executionPath, role: 'author',
  git: {
    branch: `task/${taskId}`,
    baseCommit,              // frozen starting commit
    headCommit,              // current worktree HEAD (may advance as worker commits)
    integrationBranch,       // 'dev'
    detached: false,
  },
}
```

For a **reviewer desk** (`repository-desk-provisioner.ts:214-231`) the
provisioner creates a **detached** worktree at the frozen source commit:

```
worktreePath(repoRoot, taskId, `review-${shortSha(sourceCommit)}`)
git worktree add --detach <path> <sourceCommit>
```

The scripted executor mirrors this exactly
(`scenario-scripted-executor.mjs:130-159`):

```js
if (isReview) {
  // Reviewer: read-only detached worktree at the accepted source commit.
  const row = db.prepare(
    `SELECT payload_snapshot FROM factory_managed_node_submissions
      WHERE task_id=? ORDER BY id DESC LIMIT 1`,
  ).get(Number(assignment.taskId));
  const payload = JSON.parse(row.payload_snapshot);
  const sourceCommit = payload?.source?.commitSha;
  const desk = provisioner.provisionReviewerDesk({
    repositoryRoot: repo.local_path,
    taskId: Number(assignment.taskId),
    sourceCommit,
    projectRepositoryId,
    integrationBranch,
  });
  // ...
}
```

> **Critical**: a scripted reviewer MUST read the source commit from the
> author's accepted CandidateSet (via `candidate_read`), never from the moving
> branch HEAD. If two implementation workers share a checkout and both run
> `git checkout -B`, the second orphan's the first's source commit and the
> gate throws `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH` (see §9.1).

### 3.4 productSource resolution

`productSource` is resolved at activation time by
`activateProductionCellRoleTask`
(`src/lifecycle/work-assignment-core.ts:736-775`). It calls
`resolveRoleProductSource` (lines 691-733):

1. Reviewer output is ALWAYS `typed-submission` (a verdict product).
2. If the cell declaration forwarded `productSource`, use it.
3. Otherwise: check `metadata.product_source`.
4. Otherwise: recover from the frozen WorkIntent's `allowed_tools` —
   `product_submit` present → `typed-submission`; absent → `managed-production`.

For `implement-work-items`, the cell declares `productSource: 'typed-submission'`
(`development-process-module.ts:178`), so every author task is stamped with
`metadata.product_source = 'typed-submission'`. The dispatcher's
`requireProductionCellSubmission` then refuses `worker_done` until at least one
matching `product_submit` row exists
(`src/tools/dispatcher.ts:1955-1984`):

```ts
const submission = db.prepare(
  `SELECT s.id,s.schema_version,wi.output_schema
     FROM factory_managed_node_submissions s
     JOIN factory_work_intents wi ON wi.id=s.intent_id
    WHERE s.task_id=? AND s.execution_id=? ORDER BY s.id DESC LIMIT 1`,
).get(taskId, exactExecutionId);
if (submission && submission.schema_version === submission.output_schema) return;
if (submission) throw new Error(`PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH: ...`);
throw new Error(`PRODUCTION_CELL_PRODUCT_REQUIRED: task ${taskId} cannot call worker_done before its exact execution '${exactExecutionId}' has a typed product_submit. ...`);
```

### 3.5 What is a CandidateSet?

A `CandidateSet` is the immutable sealed product of one Production Cell role
execution. Defined in `src/process-modules/domain/workplace/` (the
`CandidateSet` type re-exported at
`production-cell-node-executor.ts:23-27`). Structure (paraphrasing the seal at
`production-cell-node-executor.ts:827-850`):

```ts
interface CandidateSet {
  workplaceRef: WorkplaceRef;
  candidateSetRef: string;          // opaque id
  candidateSetDigest: string;       // sha256 over {workplaceRef, productionRevisionRef, role, subject}
  productionRevisionRef: string;   // immutable Workplace material authority
  role: 'author' | 'reviewer';
  subjectCandidateSetRef: string | null;   // for reviewer: the author set under review
  members: readonly CandidateMember[];     // one per product_submit
  sealReceiptRef: string;
  sealedAt: string;
}

interface CandidateMember {
  productRef: { schemaId: string; ref: string; digest: string };  // ProductRef
  origin: 'produced' | 'carried-forward';
  sourceCandidateSetRef: string | null;
}
```

The CandidateSet is sealed by
`ProductionCellNodeExecutor.sealCandidateSet` AFTER the worker process exits
and the productReader has resolved the typed products for that exact
`executionRef` (`production-cell-node-executor.ts:486-515`).

The **source commit captured** is the one inside the product body, NOT the
worktree HEAD. The product schema is
`factory.development-implementation-result.v1`
(`development-schemas.ts:55-76`):

```ts
interface DevelopmentImplementationResultProduct {
  workItemKey: string;
  terminalStatus: 'complete' | 'blocked' | 'failed';
  source: {
    branch: string;           // 'task/<id>' — must equal the desk branch
    commitSha: string;        // THE captured commit
    workItemKey: string;
  };
  snapshot: {
    commitSha: string;        // must equal source.commitSha
    treeSha: string;
    files: readonly unknown[];
  };
  repository: {
    projectRepositoryId: number;
    integrationBranch: string;
    baseCommit: string;       // must equal desk.baseCommit
    name: string;
  };
  buildProducts: readonly unknown[];
  reasonCodes: readonly string[];
}
```

The git-integration effect later reads `payload.source.commitSha`,
`payload.snapshot.treeSha`, `payload.source.branch` and verifies all three
match the actual repository state (see §5.2).

### 3.6 Implementation scripted actions (the full tool sequence)

From `golden-path-scenarios.mjs:283-333`:

```js
const developmentImplement = async ({ client, task, prompt, repoPath, desk }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item
            || findObject(meta.process_node_input, x => x.kind === 'implementation');
  const workItemKey = String(item.key);
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  // Git Desk parity: commit inside the per-task worktree the factory provisioned.
  // The worktree is already on branch task/<id> at the frozen base commit —
  // NO `checkout -B`, NO `checkout` back. This eliminates the shared-checkout
  // race that caused PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH under concurrency ≥ 2.
  const filePath = `src/factory-contract/${safe}.ts`;
  const branch        = desk?.branch        || `factory-contract-${safe}-${prompt.task_id}`;
  const integration   = desk?.integrationBranch || 'dev';
  const baseCommit    = desk?.baseCommit
                     || git(repoPath, ['rev-parse', `refs/heads/${integration}`]);

  if (!desk) {
    // Legacy shared-root path: checkout -B is required.
    git(repoPath, ['checkout', '-B', branch, integration]);
  }

  actions.writeFile(repoPath, filePath,
    `// deterministic implementation for ${workItemKey}\nexport const ${safe} = true;\n`);
  git(repoPath, ['add', filePath]);
  git(repoPath, ['commit', '-m', `factory-contract: implement ${workItemKey}`]);
  const commitSha = git(repoPath, ['rev-parse', 'HEAD']);
  const treeSha   = git(repoPath, ['rev-parse', `${commitSha}^{tree}`]);

  await actions.submitProduct(
    client,
    'factory.development-implementation-result.v1',
    {
      workItemKey,
      terminalStatus: 'complete',
      source: { branch, commitSha, workItemKey },
      snapshot: { commitSha, treeSha, files: [filePath] },
      repository: {
        projectRepositoryId: Number(item.projectRepositoryId || task.project_repository_id || 1),
        integrationBranch: integration,
        baseCommit,
        name: 'factory-contract-repo',
      },
      buildProducts: [],
      reasonCodes: [],
    },
  );

  // NO checkout back to integration branch when using a desk — the worktree is disposable.
  if (!desk) git(repoPath, ['checkout', integration]);

  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, `implemented ${workItemKey}`);
};
```

The exact tool sequence a scripted author worker MUST emit:

| Step | MCP tool / Bash | Purpose |
|------|------------------|---------|
| 1 | `task_get({id})` | read task metadata (already done by the engine; the scenario may re-read for `cell_input_item`) |
| 2 | `Bash: git rev-parse HEAD` (optional) | confirm worktree state |
| 3 | `Write: <filePath>` | write the implementation file inside `desk.executionPath` |
| 4 | `Bash: git add <filePath>` | stage |
| 5 | `Bash: git commit -m` | commit on `task/<id>` |
| 6 | `Bash: git rev-parse HEAD` | capture `source.commitSha` |
| 7 | `Bash: git rev-parse <sha>^{tree}` | capture `snapshot.treeSha` |
| 8 | `product_submit({ schema, content })` | publish typed result — REQUIRED before `worker_done` |
| 9 | `worker_done({ task_id, worker_id, result, execution_id })` | close author phase → triggers author gate + reviewer projection |

The worker does NOT call `worker_merge_acquire`/`worker_merge_release`. Those
are for the legacy direct-dispatch path; under the Production Cell flow the
`git-integration` post-acceptance effect handles merging (see §5).

Scenario keys: `${DEV}/implement-work-items/author/*` for authors,
`${DEV}/implement-work-items/reviewer/*` for reviewers.

---

## 4. The Review Phase — `development.code.review`

### 4.1 Reviewer Cell wiring

`implement-work-items` declares a `review` block
(`development-process-module.ts:185-196`):

```ts
review: {
  reviewer: {
    skillRef: 'development-implementation-reviewer',
    capabilityPreset: 'sandbox-code-reviewer',
  },
  verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,    // factory.development-review-verdict.v1
  finalGate: {
    gateId: 'development-implementation-final',
    gatePhase: 'final',
    checkPlan: IMPLEMENTATION_FINAL_PLAN,
  },
},
```

The final gate runs the **ReviewVerdictCheckProvider**
(`REVIEW_VERDICT_CHECK_PROVIDER_ID`,
`src/process-modules/application/review-verdict-check-provider.ts`), configured
with `parameters: { verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA }`
and `repairTargetRoleOnFailure: 'author'` (`development-process-module.ts:85`).
A rejected verdict routes the Workplace back to the author with feedback.

Reviewer profile (`development-process-module.ts:380-399`):

| Field | Value |
|-------|-------|
| `id` | `development-implementation-reviewer` |
| `taskKind` | `development.code.review` |
| `executionMode` | `tracker_only` (no git writes — read-only detached desk) |
| `outputSchema` | `factory.development-review-verdict.v1` |

### 4.2 Reviewer scripted actions

The reviewer MUST read the author CandidateSet (via `candidate_read`), then
submit a verdict that binds to it. From `golden-path-scenarios.mjs:335-359`:

```js
const developmentReview = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const wpRef = meta.workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);   // candidate_read
  const implRef = (cand.product_refs || []).find(
    p => p.schemaId === 'factory.development-implementation-result.v1',
  );
  if (!implRef) throw new Error('implementation result missing from author CandidateSet');

  const read = await client.callJson('product_read', {
    schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
  });
  const impl = read.content || read;

  await actions.submitProduct(
    client,
    'factory.development-review-verdict.v1',
    {
      subject_candidate_set_ref: cand.candidate_set_ref,   // bind to author set
      verdict: 'approved',
      findings: [],
      workItemKey: impl.workItemKey,
      reviewedCandidate: {
        sourceCommit: impl.source?.commitSha,
        sourceTree:    impl.snapshot?.treeSha,
      },
    },
  );
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, `review approved ${impl.workItemKey}`);
};
```

Tool sequence:

| Step | MCP tool | Purpose |
|------|----------|---------|
| 1 | `task_get({id})` | read `workplace_ref` from metadata |
| 2 | `candidate_read({workplace_ref, role:'author'})` | fetch the author CandidateSet |
| 3 | `product_read({schema_id, ref, digest})` | read the implementation result body |
| 4 | `product_submit({schema:'factory.development-review-verdict.v1', content})` | submit the verdict |
| 5 | `worker_done({task_id, worker_id, result, execution_id})` | close reviewer phase |

The verifier-style independent gate (`PRODUCTION_CELL_REVIEW_BINDING_INVALID`)
is enforced inside the git-integration effect
(`sqlite-production-cell-integration.ts:280-288`):

```ts
if (
  reviewPayload?.verdict !== 'approved'
  || review?.subject_candidate_set_ref !== input.candidateSetRef
  || reviewPayload.subject_candidate_set_ref !== input.candidateSetRef
  || !Array.isArray(reviewPayload.findings)
) {
  throw new Error(`PRODUCTION_CELL_REVIEW_BINDING_INVALID: task ${task.id}`);
}
```

So `subject_candidate_set_ref` MUST match the author set exactly, and `findings`
MUST be an array (empty only for approval).

---

## 5. The Integration Node — runtime-owned `git-integration` post-acceptance effect

### 5.1 What the worker does NOT do

Under the Production Cell flow, the worker NEVER calls
`worker_merge_acquire`/`worker_merge_release`. The skill explicitly says so
(`saga-worker/SKILL.md:49-51`):

> Call `worker_done` and stop. The runtime-owned post-acceptance provider merges
> the exact reviewed source commit; an LM must not mutate the integration branch
> or manufacture an integration receipt.

The `git-integration` effect is registered by
`createGitIntegrationEffect(SqliteProductionCellIntegration, ledger)`
(`src/infrastructure/workplace/git-integration-effect.ts:12-127`) and bound via
`postAcceptanceEffect: 'git-integration'` on the implementation Cell.

### 5.2 How the merge actually happens

`SqliteProductionCellIntegration.integrateAcceptedWorkplace`
(`src/infrastructure/workplace/sqlite-production-cell-integration.ts:133-338`):

1. **Resolve the task** by joining `factory_candidate_sets` +
   `factory_candidate_set_members` + `factory_managed_node_submissions` —
   picks the author task whose `workplace_ref` matches and whose member
   schema is `factory.development-implementation-result.v1`.
2. **Validate payload shape** — `terminalStatus === 'complete'`,
   `workItemKey` is a string, `source.commitSha` and `source.branch` are
   present, `snapshot.commitSha === source.commitSha`,
   `snapshot.treeSha` is a string,
   `repository.projectRepositoryId === task.project_repository_id`,
   `repository.integrationBranch === task.integration_branch`.
   Otherwise: `PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING`.
3. **Verify the source commit is real** (`sqlite-production-cell-integration.ts:209-226`):
   ```ts
   const source     = git(local_path, ['rev-parse', `${sourceCommit}^{commit}`]);
   const sourceRef  = sourceBranch.startsWith('refs/') ? sourceBranch : `refs/heads/${sourceBranch}`;
   const branchHead = git(local_path, ['rev-parse', sourceRef]);
   const sourceTree = git(local_path, ['rev-parse', `${sourceCommit}^{tree}`]);
   if (source !== sourceCommit || branchHead !== sourceCommit || sourceTree !== payload.snapshot.treeSha) {
     throw new Error(`PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task ${task.id} submitted ${sourceCommit} but branch is ${branchHead ?? 'missing'}`);
   }
   ```
   This is THE invariant: the branch HEAD must equal the submitted commitSha,
   and the commit's tree must equal the submitted treeSha. A scripted worker
   that commits to the wrong branch or lets another worker move the ref will
   hit this throw.
4. **Verify the review binding** (lines 250-288) — fetches the final-gate
   decision's assessment CandidateSet (the reviewer set), asserts
   `verdict==='approved'`, `subject_candidate_set_ref` matches, and
   `findings` is an array.
5. **Fast-forward / already-applied path** (lines 233-249) — if
   `integration_state==='merged'` OR `sourceCommit` is already an ancestor
   of `targetHead`, mark the task merged and return `succeeded` with
   `alreadyApplied: true`.
6. **Perform the merge** (lines 289-318):
   ```ts
   spawnSync('git', ['-C', local_path, 'checkout', integration_branch]);
   const beforeHead = git(local_path, ['rev-parse', `refs/heads/${integration_branch}`]);
   const merge = spawnSync('git', ['-C', local_path, 'merge', '--no-ff',
     '-m', `factory: integrate task #${task.id}`, sourceCommit]);
   if (merge.status !== 0) {
     spawnSync('git', ['-C', local_path, 'merge', '--abort']);
     db.prepare(`UPDATE tasks SET integration_state='conflict'...`).run(task.id);
     return { outcome: 'repair_required', reason: `PRODUCTION_CELL_INTEGRATION_CONFLICT: task ${task.id}` };
   }
   const afterHead = git(local_path, ['rev-parse', 'HEAD']);
   db.prepare(`UPDATE tasks SET integration_state='merged', integrated_commit=?...`).run(afterHead, task.id);
   ```
7. **External-effect ledger** — the entire operation is wrapped by the
   `ExternalEffectLedger` (`git-integration-effect.ts:27-126`) which records
   the request, claim, execution result, and observation. This makes the merge
   idempotent across crashes: if the process died mid-merge, a later
   `observeAcceptedWorkplace` call detects that `sourceCommit` is now an
   ancestor of the target HEAD and transitions to `matched` (line 109-118).

### 5.3 What happens on conflict?

`outcome: 'repair_required'` returns from `integrateAcceptedWorkplace`. The
git-integration effect records it in the ledger and returns
`{ outcome: 'repair_required', reason, evidence }`
(`git-integration-effect.ts:90-104`). The Production Cell reconciler
(`production-cell-node-executor.ts:635-639`) then calls
`coordinator.requireAcceptanceEffectRepair(workplace.ref)`, which re-queues
the author with feedback. The author must rebase / re-implement on the new
base and resubmit. After `maxAttempts: 2` the cell pauses with
`human_required`.

### 5.4 The legacy direct-dispatch merge (worker_merge_acquire / release)

For non-Production-Cell tasks (or for the manual-integration skill flow), the
MCP `worker_merge_acquire` / `worker_merge_release` tools serialize merges via
a per-repository SQLite lock. From `src/tools/dispatcher.ts`:

`handleWorkerMergeAcquire` (lines 1236-1332):
- Lock stored in `project_repositories.metadata.merge_lock` (when
  `task.task_kind != null && project_repository_id != null`) or
  `projects.metadata.merge_lock` (legacy global scope).
- Lock record: `{ task_id, worker_id, acquired_at }`.
- Auto-expires after `MERGE_LOCK_STALE_MIN = 10` minutes (line 105) **but
  only if the holder process is verifiably dead** (`isProcessAlive(exec.pid)`,
  line 1292-1303). This prevents stealing a lock from a slow-but-live worker.
- Rejects with `{ granted: false, held_by: {...}, retry_after_ms: 3000 }`
  when contention exists.

`handleWorkerMergeRelease` (lines 1334-1446):
- Requires prior `acquire` — throws if no lock exists (line 1382-1388).
- Only the holder may release (line 1389-1393).
- `result: 'merged'`: sets `worktree.merged_into = <integration_branch>`,
  `integration_state='merged'`, `integrated_commit=<sha>`,
  clears any `needs-human` tag, calls `reevaluateDownstream`.
- `result: 'conflict'`: sets `worktree.merged_into='conflict'`,
  `integration_state='conflict'`, adds `needs-human` tag (task pulses red on
  the kanban), keeps the worktree and branch for human resolution.

The scripted Production Cell scenarios DO NOT use these tools — the
`git-integration` effect replaces them.

---

## 6. The Verification Node — `verify-acceptance` (verification.ac)

### 6.1 Cell shape

From `development-process-module.ts:217-265`:

```ts
{
  id: 'verify-acceptance',
  kind: 'production-cell',
  cellDefinition: {
    id: 'development-verification',
    inputSelectors: [
      'resolve-task-graph.verificationItems',
      'freeze-integrated-candidate.candidate',
    ],
    materialization: {
      sourceBinding: 'resolve-task-graph',
      workKeySelector: 'verificationItems',
      completionPolicy: 'all',
      taskProvenance: {
        sourceArtifactIdsSelector: 'acceptanceCriterionIds',
        verificationTargetArtifactIdSelector: 'acceptanceCriterionIds',
      },
    },
    author: {
      skillRef: 'development-verification-worker',
      capabilityPreset: 'sandbox-verifier',
    },
    productContracts: [{
      binding: 'verificationEvidence',
      schemaRef: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,   // factory.candidate-verification-evidence-product.v2
      mediaType: 'application/json',
      cardinality: '1',
      productSource: 'typed-submission',
      payloadContract: {
        contractId: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
        version:    DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
        contractDigest: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
      },
    }],
    authorGate: {
      gateId: 'development-verification-final',
      gatePhase: 'final',
      checkPlan: VERIFICATION_FINAL_PLAN,
    },
    recovery: { maxAttempts: 2, onExhausted: 'pause' },
    transitions: {
      accepted: 'settle-development',
      humanRequired: 'complete-blocked',
      failed: 'complete-failed',
    },
  },
}
```

Note:
- The cell consumes BOTH `verificationItems` and the frozen
  `freeze-integrated-candidate.candidate`. The verifier sees the candidate
  hash in `task.metadata.process_node_input.upstream.bindings.candidate`.
- `verificationTargetArtifactIdSelector: 'acceptanceCriterionIds'` — exactly
  one AC per verifier. Enforced by `production-cell-node-executor.ts:734-737`.
- `payloadContract` is pinned: the verifier's `product_submit` content MUST
  conform to `DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DEFINITION`
  (`development-check-providers.ts:46-63`).
- **No review phase** — the verifier is independently authoritative. Its
  final gate is the only gate.

### 6.2 How does the verifier generate L3 property tests from the AC contract?

The skill `saga-verifier` (`skills/saga-verifier/SKILL.md`) mandates:

> **Anti-self-certification (CGAD P7).** The Verifier must NOT use the Builder's
> tests as the oracle. The oracle is the frozen AC contract. Build every test
> FROM THE AC, never FROM `tests/`.

Phase 0 (coverage audit) builds a gap list from the AC `properties:` block.
Phase 1 authors L3 property tests under `tests/verifier/`. The scripted
scenario elides both phases — it records a deterministic `passed` evidence
product. A real verifier scenario would read the AC's
`properties:` block (via `artifact_get`) and emit observations keyed off each
named property.

### 6.3 The verification evidence product

Schema `factory.candidate-verification-evidence-product.v2`
(`development-schemas.ts:78-91`):

```ts
interface DevelopmentVerificationEvidenceProduct {
  schemaVersion: 'factory.candidate-verification-evidence-product.v2';
  verificationItemKey: string;
  acceptanceCriterionId: number;
  acceptedCriterionHash: string;        // AC.accepted_hash — pinned
  candidateHash: string;                // frozen IntegratedReleaseCandidate.candidateHash — pinned
  outcome: 'passed' | 'failed' | 'unknown' | 'error';
  evidence: {
    summary: string;
    observations: readonly string[];
    limitations: readonly string[];
  };
}
```

### 6.4 The verification check provider

`createDevelopmentVerificationCheckProvider`
(`development-check-providers.ts:134-210`) runs in the verifier's author gate.
It re-reads the submission payload, decodes it, and validates:

- `verificationItemKey === metadata.cell_input_item.key`
- `acceptanceCriterionId` matches the cell-input `acceptanceCriterionIds[0]`
- `acceptanceCriterionId === task.verification_target_artifact_id`
- `acceptedCriterionHash === artifact.accepted_hash`
- `candidateHash === metadata.process_node_input.upstream.bindings.candidate.candidateHash`

If any mismatch: `failed`. If all match: **`unknown`** (line 204). The provider
is deliberately NOT an executable oracle — it cannot promote an LM-authored
`passed` to Factory acceptance. Final acceptance requires an independent
candidate-check receipt (registered separately). The check plan declares
`indeterminateDisposition: 'human-required'` (`development-process-module.ts:95`),
so `unknown` pauses the line. In scripted tests, the harness typically wires
a deterministic candidate-check receipt OR the test asserts the line pauses at
`unknown` (an allowed non-green outcome).

### 6.5 The `verified_by` trace

The independent `verification_record` MCP tool
(`src/tools/verification.ts`, signatures re-exported by the MCP
definitions) creates a row in `verification_evidence` and — when
`outcome='passed'` — inserts an `artifact_traces` row with
`link_type='verified_by'` from the AC artifact to the verifying task. The
scripted scenario in `golden-path-scenarios.mjs` instead publishes a typed
evidence product (which the gate consumes directly). For tests that exercise
the legacy `verification_record` path, the call is:

```js
await client.callJson('verification_record', {
  task_id: taskId,
  artifact_id: acId,
  outcome: 'passed',
  evidence: 'deterministic factory-contract check passed',
  recorded_by: workerId,
  content_hash: ac.accepted_hash,
});
```

This path is governed by `handleWorkerDone`'s verification loop-escape
(`dispatcher.ts:715-744`): a `verification.ac` task cannot reach `done`
without either a `passed` evidence row OR a metadata-flagged loop-escape
(`verification_loop_escaped` set after ≥2 `failed` records —
`dispatcher.ts:628-649`).

### 6.6 Verifier scripted actions

From `golden-path-scenarios.mjs:361-399`:

```js
const developmentVerify = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item
            || findObject(meta.process_node_input, x => x.kind === 'verification');
  const candidate = findObject(
    meta.process_node_input ?? meta,
    value => value.schemaVersion === 'factory.integrated-release-candidate.v1'
          && typeof value.candidateHash === 'string',
  );
  const acId = Number(item.acceptanceCriterionIds?.[0]
                  || task.verification_target_artifact_id || 0);
  const acResp = await client.callJson('artifact_get', { id: acId });
  const ac = acResp.artifact || acResp;
  const acceptedCriterionHash = ac.accepted_hash || ac.content_hash;

  await actions.submitProduct(
    client,
    'factory.candidate-verification-evidence-product.v2',
    {
      schemaVersion: 'factory.candidate-verification-evidence-product.v2',
      verificationItemKey: item.key,
      acceptanceCriterionId: acId,
      acceptedCriterionHash,
      candidateHash: candidate.candidateHash,
      outcome: 'passed',
      evidence: {
        summary: `Factory contract verification passed for ${item.key}`,
        observations: [`evidence digest ${actions.contentHash(item.key)}`],
        limitations: [],
      },
    },
  );
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, `verified ${item.key}`);
};
```

Scenario key: `${DEV}/verify-acceptance/author/*`.

Tool sequence:

| Step | MCP tool | Purpose |
|------|----------|---------|
| 1 | `task_get({id})` | read `cell_input_item`, find verification work item |
| 2 | `artifact_get({id: acId})` | read AC `accepted_hash` |
| 3 | `product_submit({schema, content})` | submit evidence product (pinned to AC hash + candidate hash) |
| 4 | `worker_done({task_id, worker_id, result, execution_id})` | close verifier |

---

## 7. The Freeze Kernel — `freeze-integrated-candidate`

After every implementation item is `terminal(accepted)`, the flow enters
`freeze-integrated-candidate` (`development-process-module.ts:207-215`).
Handler: `DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate =
'development-freeze-integrated-candidate'`
(`development-kernel-ports.ts:78`).

The kernel reads every accepted implementation result, every git-integration
receipt, the canonical task graph, and the current state of every repository
HEAD, then assembles one immutable `IntegratedReleaseCandidate`
(`development-schemas.ts:258-267`):

```ts
interface IntegratedReleaseCandidate {
  schemaVersion: 'factory.integrated-release-candidate.v1';
  taskGraphHash: string;
  implementationWorksetHash: string;
  repositories: readonly CandidateRepositorySnapshot[];   // commit+tree per repo
  buildProducts: readonly CandidateBuildProduct[];
  integrationIntentRefs: readonly string[];
  frozen: true;
  candidateHash: string;                                   // sha256 over all other fields
}
```

Implementation: `SqliteDevelopmentModuleStore.freezeIntegratedCandidate`
(`sqlite-development-settlement-state.ts:179-...`). On `domain.frozen` it
proceeds to `verify-acceptance`; on `domain.failed` it short-circuits to
`settle-development`. The candidate hash is the immutable target every
verifier must pin (`invariant: development.evidence-pins-candidate`).

---

## 8. Settlement — `settle-development`

Kernel handler `DEVELOPMENT_KERNEL_HANDLER_IDS.settle =
'development-settlement-policy'` re-reads every accepted Cell product by
exact ref/hash and assembles a `DevelopmentSettlementInput`
(`development-kernel-ports.ts:178-183`,
`development-schemas.ts:319-338`). It then runs the pure
`DevelopmentSettlementPolicyPort` (the reference implementation lives in
`src/modules/development/domain/development-settlement-policy.ts`) which emits
one of the five outcomes. The final artifact is the
`DevelopmentCertificate` (`development-schemas.ts:378-393`), persisted via
the `ProcessOutcomeCertificateRepository`. On `domain.verified` the lifecycle
advances to Delivery.

The scripted golden path produces a `verified` certificate when:
- every implementation item reached `terminal(accepted)`,
- every git-integration receipt is `succeeded`,
- the frozen candidate's hash is unchanged from freeze to settlement
  (`invariant: development.no-post-verification-mutation`),
- every verification evidence product is `passed` (or `unknown` for
  `degradable` ACs, never for `blocker`).

---

## 9. Production Cell Flow for dev (author → candidate → gate → reviewer)

The Production Cell reconciler
(`src/process-modules/application/node-executors/production-cell-node-executor.ts`)
drives the loop. One reconciliation pass per Workplace:

### 9.1 Loop states (per Workplace)

From `production-cell-node-executor.ts:359-605`:

| `loopState` | Meaning | Reconciler action |
|-------------|---------|-------------------|
| `idle` | just materialized | check dependencies; if all terminal-accepted → `admitWork` (→ `queued`) |
| `queued` | work admitted, no active reservation | ensure role projection (author task → `todo`); if carry-forward authorized, present candidate |
| `leased` / `running` | a worker execution holds the lease | return `pending` |
| `verifying` | worker exited, products to seal | read products, seal CandidateSet, run gate |
| `repair_wait` | gate rejected, retry budget left | if attempts < maxAttempts → `requeue`; else `human_required`/`failed` |
| `effect_pending` | accepted, post-acceptance effect pending | run `git-integration`; on success → `terminal(accepted)` |
| `paused` | human_required / onExhausted: pause | return `paused` |
| `terminal` | done | return outcome (`accepted` or `failed`) |

### 9.2 The gate flow for `implement-work-items`

1. **Author produces** → worker `product_submit`s the implementation result,
   calls `worker_done`. Worker process exits.
2. **Reconciler seals** the CandidateSet with role=`author`
   (`sealCandidateSet`, `production-cell-node-executor.ts:827-850`).
3. **Author gate** runs (`development-implementation-author`,
   product-contract check). On `accepted` and `cell.review` present → NOT
   final; transition to reviewer projection. On `failed` →
   `repairTargetRole: 'author'` → `repair_wait`.
4. **Reviewer produces** → reviewer `product_submit`s the verdict, calls
   `worker_done`.
5. **Reviewer CandidateSet sealed** with role=`reviewer`,
   `subjectCandidateSetRef = <author set ref>`.
6. **Final gate** runs (`development-implementation-final`,
   ReviewVerdictCheckProvider) with `subjectCandidateSetRef=author set`,
   `assessmentCandidateSetRefs=[reviewer set]`
   (`production-cell-node-executor.ts:551-557`). On `accepted` →
   `postAcceptanceCandidate = subjectAuthorSet`, transition to
   `effect_pending`.
7. **Post-acceptance effect** (`git-integration`) merges the source commit
   into `dev`. On success → `terminal(accepted)` and
   `recordFinalAcceptanceAndCapture` archives the candidate for replay.
8. **Completion** — when `completionSatisfied('all', acceptedCount, total)`
   (`production-cell-node-executor.ts:294-302`, `1434-1444`), the cell emits
   `domain.accepted` and the flow proceeds.

### 9.3 Key invariants enforced here

- `PRODUCTION_CELL_REVIEW_BINDING_INVALID` — reviewer verdict must bind the
  exact author CandidateSet (`sqlite-production-cell-integration.ts:280-288`).
- `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH` — branch HEAD must equal
  submitted commitSha (`sqlite-production-cell-integration.ts:217-226`).
- `PRODUCTION_CELL_PRODUCT_REQUIRED` — no `worker_done` without a typed
  `product_submit` of the declared schema (`dispatcher.ts:1978-1984`).
- `PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH` — submitted schema must equal the
  WorkIntent's declared `output_schema` (`dispatcher.ts:1971-1977`).
- Attempt counting (`production-cell-node-executor.ts:971-997`) — sealed
  CandidateSets + terminal worker_executions; on exhaustion `pause`.

---

## 10. Concurrency Model — `concurrency=N` and worktree isolation

### 10.1 Where concurrency is set

Concurrency lives in `lifecycle_execution_controls.concurrency`
(`work-assignment-core.ts:73-90` reads the row, but the value is set at
factory launch). The parallel-git-desk test sets it explicitly
(`parallel-git-desk.test.mjs:103-104`):

```js
db.prepare(`INSERT INTO lifecycle_execution_controls
            (epic_id,concurrency,model_concurrency_limit)
            VALUES (1,2,2)`).run();
```

The orchestrate-cli reads `SAGA_CONCURRENCY` and the launch ticket's
`concurrency` field (`parallel-git-desk.test.mjs:139`) and spawns up to N
worker processes in parallel.

### 10.2 How worktrees are isolated

Each `git_change` task gets its own worktree at
`<repoRoot>/.worktrees/task-<taskId>` on branch `task/<taskId>`
(`repository-desk-provisioner.ts:73-79`). Two parallel implementation tasks
live in **different directories** on **different branches** — there is no
shared `git checkout -B` race.

The scripted executor mirrors this in `provisionScriptedDesk`
(`scenario-scripted-executor.mjs:106-196`):

```js
const provisioner = new RepositoryDeskProvisioner();
if (isReview) {
  const desk = provisioner.provisionReviewerDesk({
    repositoryRoot: repo.local_path,
    taskId, sourceCommit, projectRepositoryId, integrationBranch,
  });
  // ... detached worktree at sourceCommit
} else {
  // Author: resolve expectedBaseCommit from DevelopmentCase.
  let baseCommit = null;
  const md = JSON.parse(task.metadata);
  const runRow = db.prepare('SELECT input_snapshot FROM factory_process_runs WHERE id=?')
    .get(md.process_run_id);
  const input = JSON.parse(runRow.input_snapshot);
  const target = (input.repositories || []).find(
    r => r.projectRepositoryId === projectRepositoryId,
  );
  baseCommit = target?.expectedBaseCommit;

  const desk = provisioner.provisionAuthorDesk({
    repositoryRoot: repo.local_path,
    taskId, integrationBranch, baseCommit, projectRepositoryId,
  });
  // ... worktree at task/<id> on base commit
}
```

The desk is forwarded to the scenario worker via env vars
(`scenario-scripted-executor.mjs:295-303`):

```js
const deskEnv = desk ? {
  SAGA_DESK_EXECUTION_PATH: desk.executionPath,
  SAGA_DESK_BRANCH: desk.branch,
  SAGA_DESK_BASE_COMMIT: desk.baseCommit,
  SAGA_DESK_HEAD_COMMIT: desk.headCommit || '',
  SAGA_DESK_INTEGRATION_BRANCH: desk.integrationBranch,
  SAGA_DESK_REPOSITORY_ROOT: desk.repositoryRoot,
  SAGA_DESK_DETACHED: desk.detached ? '1' : '0',
} : {};
const deskCwd = desk ? desk.executionPath : (context.workspaceRoot || process.cwd());
```

The scenario worker reads `desk` from these (the engine injects it into the
scenario context, see `scenario-engine.mjs:146`). It then commits inside
`desk.executionPath` instead of the shared root.

### 10.3 The integration-branch merge is serialized

Even though N workers commit in parallel, the **merge into `dev`** is
serialized by the `git-integration` post-acceptance effect: it runs inside
the Production Cell reconciler, one Workplace at a time, and each merge is
wrapped by `ExternalEffectLedger.claim` (60-second lease,
`git-integration-effect.ts:75-82`). If a second Workplace tries to integrate
while the first holds the lease, it gets `{ outcome: 'pending', reason:
'integration execution is already claimed' }` and the reconciler returns
`pending` — the next pass retries.

The legacy `worker_merge_acquire` path serializes via a SQLite-level lock
stored in `project_repositories.metadata.merge_lock`
(`dispatcher.ts:1305-1314`).

### 10.4 Conflict-key safety (semantic collision detection)

Beyond git-level isolation, `findNextClaimable`
(`work-assignment-core.ts:476-488`) refuses to claim a task whose
`task_conflict_keys` collide with another active `git_change` task in the
same process run. So two workers editing the same file path / schema /
protocol are serialized at the queue level before they ever reach git.

---

## 11. Scripted Scenario Fragment — full dev cycle for one impl + one verify

This is the canonical pattern. It uses the helpers in
`tests/factory-contract/scenario-engine.mjs:199-279` (`actions.submitProduct`,
`actions.done`, `actions.writeFile`, `actions.contentHash`,
`actions.readAuthorCandidate`) and the per-task git desk provisioned by
`scenario-scripted-executor.mjs`.

```js
// tests/factory-contract/dev-scenarios.mjs
import { spawnSync } from 'node:child_process';
import { actions } from './scenario-engine.mjs';

const DEV = 'solution-development@1.1.0';

function git(repoPath, args) {
  const r = spawnSync('git', ['-C', repoPath, ...args],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.trim()}`);
  return r.stdout.trim();
}

function metaOf(task) {
  return typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
}

// --- Planner (singleton) ---
const plan = async ({ client, task, prompt }) => {
  const dc = metaOf(task).process_node_input;
  const repo = dc.repositories[0];
  const acs  = dc.acceptanceCriteria;
  const impl = acs.filter(a => a.implementationRequired).map(ac => ({
    key: `impl-${ac.code}`, kind: 'implementation',
    taskKind: 'development.code', executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: repo.projectRepositoryId,
    acceptanceCriterionIds: [ac.artifactId], dependsOnKeys: [],
    changeScopes: [`ac-${ac.artifactId}`], required: true,
    criticality: ac.criticality,
  }));
  const verify = acs.map(ac => ({
    key: `verify-${ac.code}`, kind: 'verification',
    taskKind: 'verification.ac', executionSkill: 'saga-worker',
    executionMode: 'read_only_evidence',
    projectRepositoryId: repo.projectRepositoryId,
    acceptanceCriterionIds: [ac.artifactId], dependsOnKeys: [],
    changeScopes: [], required: true, criticality: ac.criticality,
  }));
  await actions.submitProduct(client,
    'factory.development-task-graph-proposal.v1', {
      schemaVersion: 'factory.development-task-graph-proposal.v1',
      implementationItems: impl, verificationItems: verify,
      integrationTargets: [{
        projectRepositoryId: repo.projectRepositoryId,
        sourceWorkItemKeys: impl.map(i => i.key),
        targetBranch: repo.integrationBranch,
        expectedBaseCommit: repo.expectedBaseCommit,
      }],
    });
  await actions.done(client, Number(prompt.task_id),
    prompt.worker_id, prompt.execution_id, 'plan emitted');
};

// --- Implementation author (per-item, git_change) ---
const impl = async ({ client, task, prompt, desk }) => {
  const item = metaOf(task).cell_input_item;
  const key  = String(item.key);
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '-');
  const filePath = `src/feature/${safe}.ts`;

  // The factory provisioned desk.executionPath on branch task/<id> at base commit.
  // NEVER `git checkout -B` here — that orphans parallel source commits.
  const cwd = desk.executionPath;
  const branch = desk.branch;             // task/<id>
  const integration = desk.integrationBranch; // dev
  const baseCommit  = desk.baseCommit;

  actions.writeFile(cwd, filePath,
    `// impl ${key}\nexport const ${safe.replace(/[^a-zA-Z0-9_]/g,'_')} = true;\n`);
  git(cwd, ['add', filePath]);
  git(cwd, ['commit', '-m', `factory: implement ${key}`]);
  const commitSha = git(cwd, ['rev-parse', 'HEAD']);
  const treeSha   = git(cwd, ['rev-parse', `${commitSha}^{tree}`]);

  await actions.submitProduct(client,
    'factory.development-implementation-result.v1', {
      workItemKey: key, terminalStatus: 'complete',
      source:      { branch, commitSha, workItemKey: key },
      snapshot:    { commitSha, treeSha, files: [filePath] },
      repository:  {
        projectRepositoryId: Number(item.projectRepositoryId),
        integrationBranch: integration, baseCommit, name: 'product-repo',
      },
      buildProducts: [], reasonCodes: [],
    });
  await actions.done(client, Number(prompt.task_id),
    prompt.worker_id, prompt.execution_id, `implemented ${key}`);
};

// --- Implementation reviewer (read-only detached desk) ---
const review = async ({ client, task, prompt }) => {
  const wpRef = metaOf(task).workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  const implRef = cand.product_refs.find(
    p => p.schemaId === 'factory.development-implementation-result.v1');
  const read = await client.callJson('product_read', {
    schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
  });
  const body = read.content || read;
  await actions.submitProduct(client,
    'factory.development-review-verdict.v1', {
      subject_candidate_set_ref: cand.candidate_set_ref,
      verdict: 'approved', findings: [],
      workItemKey: body.workItemKey,
      reviewedCandidate: {
        sourceCommit: body.source.commitSha,
        sourceTree:    body.snapshot.treeSha,
      },
    });
  await actions.done(client, Number(prompt.task_id),
    prompt.worker_id, prompt.execution_id, `approved ${body.workItemKey}`);
};

// --- Verifier (per AC, read_only_evidence, after candidate freeze) ---
const verify = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item;
  const candidate = findNested(meta.process_node_input,
    v => v.schemaVersion === 'factory.integrated-release-candidate.v1');
  const acId = Number(item.acceptanceCriterionIds[0]);
  const ac   = (await client.callJson('artifact_get', { id: acId })).artifact;
  await actions.submitProduct(client,
    'factory.candidate-verification-evidence-product.v2', {
      schemaVersion: 'factory.candidate-verification-evidence-product.v2',
      verificationItemKey: item.key,
      acceptanceCriterionId: acId,
      acceptedCriterionHash: ac.accepted_hash,
      candidateHash: candidate.candidateHash,
      outcome: 'passed',
      evidence: {
        summary: `verified ${item.key} against frozen candidate`,
        observations: [`sha ${candidate.candidateHash.slice(0,12)}`],
        limitations: [],
      },
    });
  await actions.done(client, Number(prompt.task_id),
    prompt.worker_id, prompt.execution_id, `verified ${item.key}`);
};

function findNested(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findNested(child, predicate, seen);
    if (found) return found;
  }
  return null;
}

export const devScenarios = {
  [`${DEV}/plan-task-graph/author/singleton`]: plan,
  [`${DEV}/implement-work-items/author/*`]:    impl,
  [`${DEV}/implement-work-items/reviewer/*`]:  review,
  [`${DEV}/verify-acceptance/author/*`]:       verify,
};
```

A test that drives this end-to-end at concurrency=2 follows the same shape as
`parallel-git-desk.test.mjs`: create a temp git repo with `dev` branch,
insert AC rows with `implementationRequired=true`, request a factory launch
with `concurrency: 2`, spawn `orchestrate-cli`, and assert:

```js
// After the run:
assert.equal(`${lifecycle.status}/${lifecycle.terminal_status}`, 'completed/released');
for (const t of implTasks) {
  assert.equal(t.status, 'done');
  assert.equal(t.integration_state, 'merged');
  assert.ok(t.integrated_commit);
}
// dev branch history contains N implementation commits
const log = execSync('git log --oneline dev', { cwd: repoPath }).toString();
assert.ok(log.split('\n').filter(l => l.includes('factory: implement')).length >= N);
```

---

## 12. Key Risks and Failure Modes

### 12.1 `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH`

Where: `src/infrastructure/workplace/sqlite-production-cell-integration.ts:217-226`.

```ts
if (source !== sourceCommit || branchHead !== sourceCommit || sourceTree !== payload.snapshot.treeSha) {
  throw new Error(`PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task ${task.id} submitted ${sourceCommit} but branch is ${branchHead ?? 'missing'}`);
}
```

Root cause: the submitted `source.commitSha` does not match the current HEAD
of `refs/heads/task/<id>`. Happens when:
- two workers share a checkout and one runs `git checkout -B task/<id>`
  overwriting the other's ref;
- the worker committed to the wrong branch;
- a parallel worker pushed the integration branch forward and the worker
  rebased onto the new tip, changing its commitSha.

Fix: per-task worktrees via `RepositoryDeskProvisioner`
(`parallel-git-desk.test.mjs` exists specifically to prove this). Scripted
workers MUST commit inside `desk.executionPath` and NEVER run
`git checkout -B` when a desk is provided.

### 12.2 Git race conditions on the integration branch

Multiple implementation Workplaces integrating into the same `dev` branch
race. Mitigations:
- `ExternalEffectLedger.claim` (60s lease) inside `git-integration-effect.ts`
  serializes one merge at a time per Workplace.
- The legacy `worker_merge_acquire` path uses a SQLite lock with staleness
  check + `isProcessAlive` guard (`dispatcher.ts:1280-1303`).
- The merge itself runs `git checkout dev && git merge --no-ff` and aborts
  cleanly on conflict (`sqlite-production-cell-integration.ts:289-318`).

### 12.3 Desk cleanup

Worktrees accumulate at `<repoRoot>/.worktrees/task-*`. Saga does NOT delete
them automatically (`dispatcher.ts:1449-1453` — `worker_health` returns the
list but a human decides). `worker_health` returns three buckets
(`dispatcher.ts:1455-1529`):

| Bucket | Detection | Meaning |
|--------|-----------|---------|
| `zombies` | `status IN ('in_progress','review_in_progress')` AND `updated_at < now - 30 min` | a worker may have died holding the card |
| `never_merged` | `status='done'` AND `metadata.worktree.merged_into IS NULL OR 'pending'` | approved but never integrated — work could be lost |
| `stuck_merges` | `metadata.worktree.merged_into = 'conflict'` | needs human conflict resolution |

The scripted tests prune with `git worktree prune` in a `finally` block
(`parallel-git-desk.test.mjs:247-253`). The provisioner's `disposeDesk`
(`repository-desk-provisioner.ts:260-268`) is best-effort and safe to call
on already-removed paths.

### 12.4 `PRODUCTION_CELL_PRODUCT_REQUIRED` / `_SCHEMA_MISMATCH`

Where: `src/tools/dispatcher.ts:1914-1985`. Any `typed-submission` Cell task
calling `worker_done` without a prior `product_submit` of the EXACT declared
schema throws. Scripted scenarios must always pair the two calls.

### 12.5 `PRODUCTION_CELL_INTEGRATION_CONFLICT`

When `git merge --no-ff` fails, the effect returns `repair_required`
(`sqlite-production-cell-integration.ts:300-317`), the Workplace re-queues
the author with `merge-conflict.json` feedback, and after `maxAttempts: 2`
the Cell pauses (`human_required`). Scripted conflict tests should assert the
run terminates `blocked` (or `failed`, depending on `onExhausted`).

### 12.6 Verification loop escape (T-013)

A `verification.ac` task cannot loop forever on `changes_requested`.
`handleWorkerDone` (`dispatcher.ts:621-649`) tracks `failed` evidence count
and after `VERIFICATION_MAX_RETRIES = 2` closes the task as `done` with
`metadata.verification_outcome='failed'` and
`verification_loop_escaped=<timestamp>`. Scripted negative-verification
scenarios should assert this metadata rather than expect an infinite loop.

### 12.7 Candidate drift after freeze

Invariant `development.no-post-verification-mutation`
(`development-process-module.ts:330`). If between freeze and settlement any
repository HEAD moves (e.g. a stray manual merge), the observed candidate
hash diverges from the frozen one and settlement fails with
`candidate-drifted-after-freeze`. Scripted tests must not touch the `dev`
branch between freeze and settlement — only the `git-integration` effect may.

### 12.8 Idempotency of `worker_done`

`handleWorkerDone` checks `command_receipts` FIRST
(`dispatcher.ts:520-537`): a replay with the same `command_id` and payload
hash returns the stored reply without side effects. A different payload with
the same `command_id` throws `IDEMPOTENCY_KEY_REUSED`. Scripted retry tests
must reuse the exact same `(task_id, worker_id, result, verdict,
execution_id)` tuple or expect the rejection.

---

## 13. Scenario Key Reference Table

Compiled from `golden-path-scenarios.mjs:401-420`. Module ref is
`solution-development@1.1.0` (`DEV`).

| Scenario key | Handler | Role | Tools used |
|--------------|---------|------|------------|
| `${DEV}/plan-task-graph/author/singleton` | `developmentPlan` | author | `product_submit`, `worker_done` |
| `${DEV}/implement-work-items/author/*` | `developmentImplement` | author | `Write`, `Bash` (git add/commit/rev-parse), `product_submit`, `worker_done` |
| `${DEV}/implement-work-items/reviewer/*` | `developmentReview` | reviewer | `candidate_read`, `product_read`, `product_submit`, `worker_done` |
| `${DEV}/verify-acceptance/author/*` | `developmentVerify` | author (verifier) | `artifact_get`, `product_submit`, `worker_done` |

The `*` wildcard in the workKey position matches any fan-out item. The
engine first tries exact `${module}/${node}/${role}/${workKey}`, then
`${module}/${node}/${role}/*`, then `*`
(`scenario-engine.mjs:167-171`).

---

## 14. File Reference

All paths absolute under `D:/Development/saga-mcp/`.

**Module definition & manifest:**
- `src/process-modules/modules/development/development-process-module.ts` — the Flow, nodes, cells, execution profiles, invariants.
- `src/process-modules/modules/development/package/manifest.ts` — resource index, handler refs, contract refs.
- `src/process-modules/modules/development/development-continuation-process-module.ts` — managed-source recovery variant (same Flow shape, different handler ids).
- `src/process-modules/modules/development/development-verification-continuation-process-module.ts` — verification-only recovery.

**Domain schemas & handlers:**
- `src/modules/development/domain/development-schemas.ts` — every Development type and schema id.
- `src/modules/development/domain/development-kernel-ports.ts` — `DEVELOPMENT_KERNEL_HANDLER_IDS`, declarative ports.
- `src/modules/development/domain/development-settlement-policy.ts` — pure settlement decision.
- `src/modules/development/domain/development-task-graph.ts` — graph canonicalization + proposal decoding.
- `src/modules/development/application/development-check-providers.ts` — planner and verifier CheckProviders.
- `src/modules/development/application/development-workspace-preparation.ts` — machine-filled planner call template.
- `src/modules/development/infrastructure/sqlite-development-settlement-state.ts` — freeze / adopt / build-settlement-input.

**Production Cell & Workplace:**
- `src/process-modules/application/node-executors/production-cell-node-executor.ts` — the reconciler that drives author → gate → reviewer → effect.
- `src/process-modules/application/post-acceptance-effects.ts` — effect registry.
- `src/infrastructure/workplace/git-integration-effect.ts` — the `git-integration` post-acceptance effect.
- `src/infrastructure/workplace/sqlite-production-cell-integration.ts` — actual git merge logic; throws `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH`.
- `src/infrastructure/workers/repository-desk-provisioner.ts` — the single place that runs `git worktree`.

**Dispatcher & assignment:**
- `src/tools/dispatcher.ts` — `worker_next`, `worker_done`, `worker_ask_need`, `worker_ask_done`, `worker_merge_acquire`, `worker_merge_release`, `worker_health`, `requireProductionCellSubmission`.
- `src/lifecycle/work-assignment-core.ts` — `findNextClaimable`, `activateProductionCellRoleTask`, `resolveRoleProductSource`, `buildAssignedWorkFromClaim`.

**Skills (resources pinned by the manifest):**
- `src/process-modules/modules/development/package/resources/skills/saga-planner/SKILL.md`
- `src/process-modules/modules/development/package/resources/skills/saga-worker/SKILL.md`
- `src/process-modules/modules/development/package/resources/skills/saga-development-code-reviewer/SKILL.md`
- `skills/saga-verifier/SKILL.md` (platform skill, pinned by path)

**Test harness:**
- `tests/factory-contract/scenario-engine.mjs` — `McpClient`, `runScenarioWorker`, `actions`, `scenarioKey`.
- `tests/factory-contract/scenario-scripted-executor.mjs` — `createScriptedWorkerExecutorFactory`, `provisionScriptedDesk`.
- `tests/factory-contract/scenario-dispatcher.mjs` — the CLI entry spawned per worker.
- `tests/factory-contract/golden-path-scenarios.mjs` — existing dev scenarios (`developmentPlan`, `developmentImplement`, `developmentReview`, `developmentVerify`).
- `tests/factory-contract/parallel-git-desk.test.mjs` — concurrency=2 worktree isolation proof.

**Design siblings (for format reference):**
- `tests/factory-contract/design/02-formalization-scenario-design.md`
- `tests/factory-contract/design/06-dispatcher-worker-design.md`
