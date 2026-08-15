# 04 — Delivery Stage Scenario Design

> LLM-free scripted test specification for the Saga Factory Delivery workshop
> (цех Delivery). Companion to `06-dispatcher-worker-design.md`.
>
> Scope: how Delivery runs end-to-end through the real Factory authority with
> deterministic physical workers, what MCP calls each node makes, how terminal
> state is reached, and how ADR-041/044/045 continuations carry production
> across the terminal boundary.

## 0. Primary source files

| Concern | Path |
|---|---|
| Process module definition | `src/process-modules/modules/delivery/delivery-process-module.ts` |
| Package manifest | `src/process-modules/modules/delivery/package/manifest.ts` |
| Node protocols | `src/process-modules/modules/delivery/package/nodes/delivery-node-protocols.ts` |
| Tool contributions | `src/process-modules/modules/delivery/package/contributions/tool-contributions.ts` |
| Human-approval contribution | `src/process-modules/modules/delivery/package/contributions/human-approval.ts` |
| External-effects contribution | `src/process-modules/modules/delivery/package/contributions/external-effects.ts` |
| Idempotency contribution | `src/process-modules/modules/delivery/package/contributions/idempotency.ts` |
| Ports contribution | `src/process-modules/modules/delivery/package/contributions/ports.ts` |
| Receipts contribution | `src/process-modules/modules/delivery/package/contributions/receipts.ts` |
| Output contracts + outcomes | `src/process-modules/modules/delivery/package/contributions/output-contracts.ts` |
| Kernel ports (interfaces) | `src/modules/delivery/domain/delivery-kernel-ports.ts` |
| Schemas | `src/modules/delivery/domain/delivery-schemas.ts` |
| Settlement + preflight policy | `src/modules/delivery/domain/delivery-settlement-policy.ts` |
| Handler wiring | `src/modules/delivery/application/delivery-installation.ts` |
| Runtime (product persistence) | `src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts` |
| Approval inbox | `src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts` |
| Local release continuation | `src/app/factory-release-continuation.ts` |
| Lifecycle definition | `src/process-modules/lifecycles/product-delivery-lifecycle.ts` |
| Lifecycle module contracts | `src/process-modules/lifecycles/product-delivery-module-contracts.ts` |
| LifecycleRun persistence | `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts` |
| Continuation repository | `src/process-modules/persistence/sqlite-lifecycle-continuation-repository.ts` |
| Approval MCP tools | `src/tools/delivery-approvals.ts` |
| Golden-path scenarios | `tests/factory-contract/golden-path-scenarios.mjs` |
| Golden-path test | `tests/factory-contract/golden-path.test.mjs` |
| Scenario engine | `tests/factory-contract/scenario-engine.mjs` |
| Scripted executor | `tests/factory-contract/scenario-scripted-executor.mjs` |
| ADR-041 (carry-forward) | `docs/architecture/decisions/041-carry-author-production-across-terminal-continuations.md` |
| ADR-044 (local release) | `docs/architecture/decisions/044-append-only-local-release-continuation.md` |
| ADR-045 (DevOps split) | `docs/architecture/decisions/045-product-revisions-change-requests-and-devops-split.md` |

## 1. Node graph

Delivery is the only standard process module authorized to create externally-
visible release state. Its Flow is `factory.delivery.standard@1.0.0` with five
processing nodes plus four terminal outcome emitters. Entry node is
`preflight-release`.

```
                         ┌───────────────────────┐
                         │ preflight-release      │  kernel
                         │ (delivery-preflight-   │  handler: delivery-preflight-policy
                         │  policy)               │  in:  factory.delivery-release-case.v2
                         │                        │  out: factory.delivery-preflight.v1
                         └──────────┬─────────────┘
              domain.ready          │ domain.blocked / domain.failed
     ┌──────────────────────────┐   └────────────────────────────────┐
     │                                                              │
     ▼                                                              ▼
┌──────────────────────┐                              ┌────────────────────────┐
│ approve-release      │  human                       │ settle-delivery        │ kernel
│ (delivery-release-   │  adapter: delivery-release-  │ (delivery-settlement-  │
│  approval)           │  approval                    │  policy)               │
│ in: preflight        │                              │ in:  observation       │
│ out: approval        │                              │ out: certificate       │
└──────────┬───────────┘                              └───────────┬────────────┘
           │                                                      │
  domain.approved /                                              domain.released /
  domain.not-required                                     domain.approval-required /
           │                                              domain.blocked / domain.failed
           ▼                                                      │
┌──────────────────────┐                                         │
│ publish-deploy       │ kernel                                   │
│ (delivery-publish-   │ handler: delivery-publish-deploy         │
│  deploy)             │ in:  approval                            │
│ out: publication     │ out: factory.delivery-publication.v1     │
└──────────┬───────────┘                                         │
           │ runtime.completed / runtime.failed                  │
           ▼                                                     │
┌──────────────────────┐                                         │
│ observe-release      │ kernel                                   │
│ (delivery-observe-   │ handler: delivery-observe-release        │
│  release)            │ in:  publication                         │
│ out: observation     │ out: factory.delivery-observation.v1     │
└──────────┬───────────┘                                         │
           │ runtime.completed / runtime.failed                  │
           └────────────────────────────────────────────────────►│
                                                                 │
                                                                 ▼
                                              ┌─────────────────────────────────┐
                                              │ complete-<outcome> emitters     │
                                              │ complete-released               │
                                              │ complete-approval-required      │
                                              │ complete-blocked                │
                                              │ complete-failed                 │
                                              └─────────────────────────────────┘
```

Source: `delivery-process-module.ts:65-207`. Verbatim transitions:

```ts
transitions: [
  { from: 'preflight-release', to: 'approve-release',   on: 'domain.ready' },
  { from: 'preflight-release', to: 'settle-delivery',   on: 'domain.blocked' },
  { from: 'preflight-release', to: 'settle-delivery',   on: 'domain.failed' },
  { from: 'approve-release',   to: 'publish-deploy',    on: 'domain.approved' },
  { from: 'approve-release',   to: 'publish-deploy',    on: 'domain.not-required' },
  { from: 'approve-release',   to: 'settle-delivery',   on: 'domain.approval-required' },
  { from: 'approve-release',   to: 'settle-delivery',   on: 'domain.denied' },
  { from: 'approve-release',   to: 'settle-delivery',   on: 'domain.failed' },
  { from: 'approve-release',   to: 'settle-delivery',   on: 'runtime.failed' },
  { from: 'publish-deploy',    to: 'observe-release',   on: 'domain.completed' },
  { from: 'publish-deploy',    to: 'observe-release',   on: 'domain.failed' },
  { from: 'observe-release',   to: 'settle-delivery',   on: 'domain.completed' },
  { from: 'observe-release',   to: 'settle-delivery',   on: 'domain.failed' },
  // settle-delivery → complete-<code> on domain.<code>
],
terminalNodeIds: [
  'complete-released',
  'complete-approval-required',
  'complete-blocked',
  'complete-failed',
],
```

Critical shape: every path eventually lands on `settle-delivery`. Even a
preflight failure or a denied approval reaches settlement because the worker
may have committed durable writes before dying (settlement instructions §1).

## 2. Outcomes and terminal states

Four outcomes, all terminal (`delivery-process-module.ts:39-64`,
`output-contracts.ts:205-230`):

| Outcome | Meaning | When emitted |
|---|---|---|
| `released` | Every required release action is authoritatively observed at its desired state. | All policy actions have `matched` observations; see `delivery-settlement-policy.ts:980-987`. |
| `approval-required` | A current authorized human decision is required before release effects may begin. | Deferred case, pending/expired approval, missing approval, or `humanApprovalRequired` with non-approved status. |
| `blocked` | A policy guard, denied decision, unavailable provider, or inconclusive external state blocks release. | Preflight check failed/inconclusive, provider untrusted, action receipt missing, observation unknown/mismatched, approval denied. |
| `failed` | Delivery integrity, lineage, or external-state validation failed. | Schema/hash invalid, lineage mismatch, infrastructure error, candidate drift. |

The lifecycle routes every Delivery outcome to a terminal status
(`product-delivery-lifecycle.ts:460-465`):

```ts
outcomeRoutes: {
  released:            { type: 'terminal', status: 'released' },
  'approval-required': { type: 'terminal', status: 'approval-required' },
  blocked:             { type: 'terminal', status: 'delivery-blocked' },
  failed:              { type: 'terminal', status: 'failed' },
},
```

### 2.1 How `terminal_status` is set

In `sqlite-lifecycle-run-repository.ts:983-1046`, when a stage run completes
and there is no `nextStage`, the lifecycle run row is updated:

```ts
const terminalStatus = command.target.type === 'terminal'
  ? command.target.status
  : null;
// ...
UPDATE factory_lifecycle_runs
   SET status='completed', current_stage_id=NULL, current_stage_run_id=NULL,
       terminal_status=?, error=NULL,
       completed_at=COALESCE(completed_at,datetime('now')),
       version=version+1, updated_at=datetime('now')
 WHERE id=? AND current_stage_run_id=?
   AND execution_lease_owner=? AND execution_lease_fence=?
```

`command.target` comes from the lifecycle's declarative `outcomeRoutes`
table. For Delivery, `target.type === 'terminal'` always, so
`terminal_status` is set to one of: `released`, `approval-required`,
`delivery-blocked`, `failed`. The `status` column becomes `'completed'`.
The stage run and process run both carry `local_outcome` matching the
module's emitted outcome code.

### 2.2 Distinction: `status` vs `terminal_status` vs `local_outcome`

- `factory_lifecycle_runs.status` — run-lifecycle phase (`running`,
  `completed`, `failed`, `cancelled`).
- `factory_lifecycle_runs.terminal_status` — the business outcome when
  `status='completed'` and there is no next stage (`released`,
  `approval-required`, `delivery-blocked`, `failed`). `NULL` while running.
- `factory_stage_runs.local_outcome` / `factory_process_runs.local_outcome`
  — the module-emitted outcome code for that stage/process
  (`released` / `approval-required` / `blocked` / `failed`).

A Delivery run that succeeds has:
`status='completed'`, `terminal_status='released'`, stage/process
`local_outcome='released'`.

## 3. Per-node tool calls and runtime flow

Delivery has NO LM authoring nodes. All five processing nodes are
`kernel` / `human` kind. The runtime does NOT hire scripted workers for
Delivery node execution — it calls the registered kernel handlers and
human adapters directly. Scripted workers are only involved indirectly:
the human approval adapter consults the durable approval inbox that an
operator (or test) writes to via the MCP tools.

This is the fundamental difference from Discovery/Formalization/Development:
**Delivery scenarios do not appear in `golden-path-scenarios.mjs`.** The
Delivery stage runs entirely through kernel handlers backed by injected
SQLite adapters and trusted-provider ports.

### 3.1 preflight-release (kernel)

Handler: `delivery-preflight-policy` (`DELIVERY_KERNEL_HANDLER_IDS.preflight`).

Runtime port calls (wired in `delivery-installation.ts` and
`sqlite-delivery-runtime.ts`):
- `DeliveryPreflightStatePort.buildPreflightSnapshot({ processRunId, deliveryCase, heartbeat })` — assembles the complete preflight snapshot from injected trusted providers.
- `DeliveryPreflightPolicyPort.evaluate(deliveryCase, preflight)` — the reference policy at `delivery-settlement-policy.ts:268-403`.

Output: a `DeliveryPreflightSnapshot` product persisted under
`PRODUCT_KINDS.preflight` via `DeliveryProcessProductRepositoryPort.persist`.
The product reference `{ schema, ref, hash }` is content-addressed by
`hashDeliveryPreflight`.

Domain event emitted by the handler:
- all required checks `passed` → `domain.ready` → transition to `approve-release`.
- any check `failed`/`unknown` or provider untrusted → `domain.blocked` → straight to `settle-delivery`.
- infrastructure error → `domain.failed` → straight to `settle-delivery`.

Required trusted providers (per `preflight-release-checklist.md`):
every check must be backed by a `deterministic_evidence` (or
`authoritative_state`) provider with `trusted=true`, `providerId>0`.

### 3.2 approve-release (human)

Adapter: `delivery-release-approval` (`DELIVERY_HUMAN_ADAPTER_IDS.approval`).
The only `kind: 'human'` node in the entire Delivery flow.

Runtime port calls (`delivery-installation.ts:200-264`):
- `DeliveryApprovalPort.decide({ processRunId, deliveryCase, preflightHash, heartbeat })` — returns `{ status, decision, provider }`.

Decision routing:
- `policy.humanApprovalRequired === false` → the runtime short-circuits to `status: 'not-required'` directly (`sqlite-delivery-runtime.ts:207-218`), no inbox lookup. Domain event `domain.not-required` → `publish-deploy`.
- `policy.humanApprovalRequired === true` → `DeliveryApprovalSource.decide()` is called, which consults `SqliteDeliveryApprovalInbox`. Status mapping:
  - `pending` → handler returns `{ runtimeEvent: 'paused', production }` with `approvalStatus: 'pending'`. The ProcessRun is persisted as paused; the lifecycle run remains `running`. The flow does NOT advance.
  - `approved` → `domain.approved` → `publish-deploy`.
  - `denied` → `domain.denied` → straight to `settle-delivery`.
  - `expired` → `domain.approval-required` → straight to `settle-delivery`.

Settlement additionally enforces (`delivery-settlement-policy.ts:560-623`):
- `humanApprovalRequired` + `pending`/`not-required` status → `approval-required` outcome.
- `humanApprovalRequired` + `denied` → `blocked`.
- `humanApprovalRequired` + `expired` → `approval-required`.
- `!humanApprovalRequired` + `denied` → `blocked`.
- `!humanApprovalRequired` + `pending`/`expired` → `approval-required`.

### 3.3 publish-deploy (kernel, external side effect)

Handler: `delivery-publish-deploy` (`DELIVERY_KERNEL_HANDLER_IDS.publishDeploy`).
Declared `sideEffect: 'external'`, `idempotency: 'idempotent'`
(`tool-contributions.ts:182-200`).

Runtime port calls:
- `DeliveryPublicationPort.publishAndDeploy({ processRunId, deliveryCase, preflight, approval, heartbeat })` — applies each `ReleaseActionDefinition` from the policy through its explicit provider.

For each action the adapter must:
1. Compute the deterministic action key via `deliveryActionKey(deliveryCase, action)` (`delivery-settlement-policy.ts:129-144`). Format: `delivery:<kind>:<identityHash>` where `identityHash = sha256Hex({ developmentCertificateHash, candidateHash, releasePolicyHash, actionId, kind, target, desiredStateHash, payloadHash })`. **ProcessRun id is deliberately excluded** so a retry reuses the first run's applied state.
2. Observe the target before acting (invariant `delivery.observe-before-retry`).
3. Apply the action through the external-effect ledger
   (`DeliveryExternalEffectLedgerPort.start` / `.claim` /
   `.recordExecutionResult`).
4. Persist a `DeliveryActionReceipt` with one of:
   `succeeded` / `failed` / `blocked` / `uncertain`.

Forbidden: force push, bypass branch protection, bypass registry
immutability, bypass deployment policy (invariant
`delivery.no-force-or-bypass`, enforced by test).

Output: a `DeliveryPublicationSnapshot` product persisted under
`PRODUCT_KINDS.publication`. Domain events: `domain.completed` or
`domain.failed` (observation runs either way).

### 3.4 observe-release (kernel, read)

Handler: `delivery-observe-release` (`DELIVERY_KERNEL_HANDLER_IDS.observeRelease`).
Declared `sideEffect: 'read'`, `idempotency: 'idempotent'`.

Runtime port calls:
- `DeliveryObservationPort.observe({ processRunId, deliveryCase, publication, heartbeat })` — reads authoritative target state for EVERY published destination, including those whose publication response was `uncertain` or `failed`.

Each `DeliveryActionObservation` carries `outcome` ∈
`{ matched, mismatched, unknown, error }`. Settlement admits release only
when every REQUIRED observation is `matched` and
`observedStateHash === action.desiredStateHash`.

Output: a `DeliveryObservationSnapshot` product persisted under
`PRODUCT_KINDS.observation`. Domain events: `domain.completed` or
`domain.failed`.

### 3.5 settle-delivery (kernel)

Handler: `delivery-settlement-policy` (`DELIVERY_KERNEL_HANDLER_IDS.settle`).
Declared `sideEffect: 'write'`, `idempotency: 'none'` (run-fence rejects
replays).

Runtime port calls:
- `DeliverySettlementStatePort.buildSettlementInput({ processRunId, deliveryCase })` — assembles the `DeliverySettlementInput` from all durable products + `currentCandidateHash`.
- `DeliverySettlementPolicyPort.settle(input)` — the reference policy at `delivery-settlement-policy.ts:423-988`.
- On `released` ONLY: `DeliveryOutputRepository.persist({ processRunId, projectId, epicId, payload: ReleaseRecord })` — persists the canonical `factory.release-record.v1`. Returns `{ record, replayed }`.
- `ProcessOutcomeCertificateRepository.issue(...)` — issues the `factory.delivery-certificate.v2`.

The settlement policy is the authoritative release gate. Its decision tree
(`delivery-settlement-policy.ts:430-987`):

1. Validate `DeliverySettlementInput` schema and common case lineage.
2. If `deliveryMode === 'deferred'` → `approval-required` (operator-authorization-missing).
3. Validate authorized case (policy hash, operator authorization scope, candidate scope).
4. Assert `currentCandidateHash === integratedCandidate.hash` else `blocked` (candidate-drifted).
5. Validate preflight durable reference matches snapshot; re-evaluate preflight policy.
6. Validate approval durable reference; check `humanApprovalRequired` matrix.
7. Validate publication durable reference; assert action plan matches policy.
8. Validate observation durable reference; assert lineage.
9. For each required action: observation must be `matched` with correct `observedStateHash`; receipt must carry `externalRef`.
10. If all pass → build `ReleaseRecord` from matched destinations → `released`.

Output: a `DeliveryCertificatePayload` carrying `decision`,
`reasonCodes`, `rationale`, all lineage hashes, and `releaseRecordHash`
(non-null only on `released`).

## 4. Approval flow (delivery_approval_*)

Three MCP tools in `src/tools/delivery-approvals.ts`. These are the ONLY
way an operator (or a test) records a human decision.

### 4.1 `delivery_approval_list`

```ts
// src/tools/delivery-approvals.ts:35-47
const handleList = args => {
  const projectId = args.project_id === undefined
    ? undefined
    : requiredInteger(args, 'project_id');
  const requests = inbox().listOpen(projectId);
  return { requests, count: requests.length, next_action: ... };
};
```

- Input: optional `project_id` (positive integer).
- Annotations: `readOnlyHint: true`, `idempotentHint: true`.
- Backed by `SqliteDeliveryApprovalInbox.listOpen(projectId)` which queries
  `factory_delivery_approval_requests WHERE state='open'`.

### 4.2 `delivery_approval_get`

```ts
// src/tools/delivery-approvals.ts:49-56
const handleGet = args => {
  const requestId = requiredString(args, 'request_id');
  const request = inbox().readRequest(requestId);
  if (!request) throw new Error(`DELIVERY_APPROVAL_REQUEST_NOT_FOUND: ${requestId}`);
  return { request };
};
```

- Input: `request_id` (non-empty string).
- Returns the exact `DeliveryApprovalRequestRecord` with its
  `candidateHash`, `preflightHash`, `releasePolicyHash` binding.

### 4.3 `delivery_approval_decide`

```ts
// src/tools/delivery-approvals.ts:58-78
const handleDecide = args => {
  const status = requiredString(args, 'status'); // approved|denied|expired
  const result = inbox().recordDecision({
    requestId, status, decidedBy, rationale, providerId,
  });
  return { ...result, next_action: 'Resume the same lifecycle run...' };
};
```

- Input: `request_id`, `status` (∈ `approved|denied|expired`),
  `decided_by`, `rationale`, `provider_id`.
- `provider_id` MUST reference a `trusted_providers` row with
  `category='authorized_decision'`, `status='active'`, bound to the same
  project (or global). Otherwise:
  `DELIVERY_APPROVAL_PROVIDER_NOT_TRUSTED`.
- The decision is **immutable**. Re-calling with a different status or
  payload throws `DELIVERY_APPROVAL_DECISION_IMMUTABLE`.
- Idempotent: re-calling with identical input returns `replayed: true`.

### 4.4 Request creation (automatic)

The inbox request is created automatically when the `approve-release` node
first runs and `policy.humanApprovalRequired === true`. From
`sqlite-delivery-approval-inbox.ts:232-272`:

```ts
private ensureRequest(input) {
  const requestId = `delivery-approval-request:${input.processRunId}`;
  // ... insert with candidateHash, preflightHash, releasePolicyHash
}
```

`requestId` is deterministic: `delivery-approval-request:<processRunId>`.
Re-running the same ProcessRun re-reads the existing request and verifies
the binding has not drifted (else `DELIVERY_APPROVAL_REQUEST_REPLAY_MISMATCH`).

### 4.5 Resume after decision

After `delivery_approval_decide` records a decision, the same lifecycle run
must be resumed (the orchestrator re-leases it). The `approve-release` node
re-runs, the inbox returns the decision, and the flow advances to
`publish-deploy`. The decision is bound to the exact candidate/preflight/
policy hashes and cannot float (invariant
`delivery.approval-binds-exact-input`).

## 5. Local-git-tag release (ADR-044)

### 5.1 The problem

A lifecycle run terminated at Delivery with `terminal_status='approval-required'`. Terminal rows are immutable — they cannot be reopened or relabelled. The operator now authorizes a local release of that exact candidate.

### 5.2 The mechanism

`src/app/factory-release-continuation.ts` creates an append-only
continuation: a single-use child LifecycleRun that inherits the completed
prefix (Discovery + Formalization + Development) and executes only
Delivery with a synthesized local-release policy.

Eligibility check (`factory-release-continuation.ts:23-33`):

```ts
if (!parent || parent.epic_id === null || parent.status !== 'completed'
  || parent.terminal_status !== 'approval-required') {
  throw new Error('LOCAL_RELEASE_PARENT_NOT_APPROVAL_REQUIRED');
}
```

It then reads the exact boundary ProcessRun input snapshot
(`factory-release-continuation.ts:34-42`):

```ts
const boundary = db.prepare(
  `SELECT pr.input_snapshot FROM factory_stage_runs sr
     JOIN factory_process_runs pr ON pr.id=sr.process_run_id
    WHERE sr.lifecycle_run_id=? AND sr.stage_id='delivery-release'
      AND sr.status='completed' AND sr.local_outcome='approval-required'
      AND pr.status='completed' AND pr.local_outcome='approval-required'
    ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
).get(command.parentLifecycleRunId);
if (!boundary) throw new Error('LOCAL_RELEASE_BOUNDARY_NOT_EXACT');
```

### 5.3 Git operations

From `factory-release-continuation.ts:44-71`:

```ts
const repo = repository[0];
const commit = git(repo.local_path, 'rev-parse', `refs/heads/${repo.integration_branch}`);
const tree   = git(repo.local_path, 'rev-parse', `${commit}^{tree}`);
const tag    = `saga/local/${previous.integratedCandidate.hash.slice(0, 12)}`;
const target = `project-repository:${repo.id}|${tag}|${commit}|${tree}`;
const desiredStateHash = sha256Hex({ repositoryId: repo.id, tag, commit, tree });

const policyBody = {
  id: 'saga-local-source-tag', version: '1.0.0', channel: 'local',
  releaseVersion: previous.integratedCandidate.hash.slice(0, 12),
  releaseTag: tag,
  humanApprovalRequired: false,   // operator grant represents approval
  requiredPreflightCheckIds: ['candidate-integrity'],
  actions: [{
    actionId: 'local-source-tag', kind: 'source-tag', target,
    desiredStateHash, payloadHash: sha256Hex({ target, desiredStateHash }),
    required: true,
  }],
};
```

Git operations performed by `git()` helper
(`factory-release-continuation.ts:123-127`):

```ts
function git(path, ...args) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
```

Pre-continuation git reads:
- `git rev-parse refs/heads/<integration_branch>` → current commit.
- `git rev-parse <commit>^{tree}` → tree hash.

The actual tag creation is NOT done in `prepareLocalReleaseContinuation` —
it happens later when the child Delivery run executes `publish-deploy`
through the local source-tag provider. ADR-044 §Decision:

> A local Git tag provider resolves the project repository from factory
> authority, validates the exact candidate commit and tree, and creates a
> content-addressed tag without force. It observes before mutation and
> again after mutation. An existing tag is successful only when it
> resolves to the exact authorized commit/tree; any collision blocks.

### 5.4 Operator authorization

```ts
// factory-release-continuation.ts:72-85
const grantBody = {
  schema: 'factory.delivery-operator-authorization.v1',
  requestedBy: command.actorId,
  releasePolicyHash: policy.contentHash,
  candidateScope: { mode: 'exact', candidateHash: previous.integratedCandidate.hash },
  localOnly: true,
  reason: command.reason,
};
```

`candidateScope.mode === 'exact'` binds the grant to one specific candidate
hash. `localOnly: true` marks this as local-only — it does NOT authorize
remote publication.

### 5.5 Continuation consume

The synthesized policy + grant are packed into
`externalBaseline.delivery` and passed to
`SqliteLifecycleContinuationRepository.authorize()` with
`stageOverrides` that inject the new delivery input mapping
(`factory-release-continuation.ts:86-110`). Then `.consume()` starts the
child LifecycleRun. The child runs ONLY Delivery; upstream stages are
inherited prefix evidence (ADR-044 guardrail 1: "Discovery, Formalization,
and Development production must not run again").

### 5.6 Idempotency / crash safety

The action key `delivery:source-tag:<identityHash>` excludes ProcessRun id
(ADR-044 §Pre-mortem: "Crash after Git mutation: observe-before-act
recognizes the exact tag and the effect ledger settles the same desired
state idempotently"). A second run for the same candidate/action observes
the existing tag and settles `released` without re-creating it.

## 6. Carry-forward (ADR-041)

### 6.1 Scope

ADR-041 is NOT Delivery-specific. It addresses the general case: an
upstream Production Cell (typically Development author) produced an exact
CandidateSet that was accepted at the author gate, but the run failed
downstream (e.g., reviewer submitted the wrong schema). Reopening the
failed run is forbidden; re-running the author repeats accepted work.

### 6.2 The mechanism (Option B: bounded carry-forward)

Create one immutable authorization for the exact failure class. The child
seals a NEW author CandidateSet whose member origin is `carried-forward`
and names the source set. The child then runs:
1. the child package's current **author gate** (re-verified, not copied);
2. a **fresh reviewer** (never the old reviewer verdict);
3. current **final gate**;
4. Factory Git effect;
5. final acceptance.

Quote (ADR-041 §Decision):

> Choose B: bounded author carry-forward. This is a generic Production
> Cell capability keyed by exact contracts and failure evidence; core
> code does not branch on Development module names. It is not ReplayCapsule
> certification and does not reinterpret the parent.

### 6.3 Eligibility predicate (narrow)

The bounded rule applies ONLY when (ADR-041 §Red Team):
- the source failure is exactly post-author / pre-final reviewer-schema mismatch;
- the source author CandidateSet, member ProductRef/digest, author gate digest, WorkIntent output schema, semantic item, base commit, source commit/tree/ref and unchanged canonical head are reverified;
- no reviewer CandidateSet, final decision, or CellFinalAcceptance exists on the source;
- if any check fails → fall back to Option A (fresh managed author), never weaken the predicate.

### 6.4 Authority flow

The continuation repository's `consume()` method
(`sqlite-lifecycle-continuation-repository.ts:200-233`) reads
`factory_production_adoption_decisions` and
`factory_development_verification_adoptions` keyed by `continuation_ref`,
and injects them into the child's input as `continuation.adoptions[]` and
`continuation.verificationAdoption`. The child's Production Cell consults
these adoption refs as INPUTS ONLY — current-run gates still run, old
decisions remain evidence, never authority.

### 6.5 Continuation terminal boundary

`SqliteLifecycleContinuationRepository.isContinuableTerminal()`
(`sqlite-lifecycle-continuation-repository.ts:351-417`) admits three
terminal shapes for continuation:

1. Infrastructure-failed leaf: `status='failed'`, `terminal_status='failed'`, `current_stage_id=resumeStageId`.
2. Business-blocked leaf: `status='completed'`, stage+process `local_outcome='blocked'`.
3. Approval-required leaf: `status='completed'`, stage+process `local_outcome='approval-required'`, certificate `reason_codes=['operator-authorization-missing']` (exactly one).

For shape 3 (the ADR-044 local-release path), the certificate reason
codes are checked precisely:

```ts
// sqlite-lifecycle-continuation-repository.ts:386-399
if (boundary.stage_outcome === 'approval-required'
  && boundary.process_outcome === 'approval-required') {
  const certificate = this.db.prepare(
    `SELECT reason_codes FROM factory_process_outcome_certificates
      WHERE process_run_id=? ORDER BY id DESC LIMIT 1`,
  ).get(boundary.process_run_id);
  const reasonCodes = JSON.parse(certificate.reason_codes);
  return Array.isArray(reasonCodes)
    && reasonCodes.length === 1
    && reasonCodes[0] === 'operator-authorization-missing';
}
```

## 7. ADR-045 context (DevOps split)

ADR-045 supersedes ADR-044 as the DEFAULT MVP start path. Under ADR-045,
ordinary product construction terminates at `ready-to-run` (a Factory-owned
finalization effect + RunReceipt), NOT at Delivery. Delivery/Release
becomes a separate future DevOps request consuming an exact
`ProductRevision`.

**For scripted test design**: ADR-045 means the default new-product
lifecycle under the MVP composition does NOT route through Delivery.
Tests that exercise Delivery explicitly must either:
- Use the legacy `product-delivery@1.0.0` lifecycle (still readable/resumable under its pinned definition); OR
- Construct an authorized Delivery case directly with `deliveryMode: 'authorized'`; OR
- Exercise the ADR-044 continuation path from a parent that terminated at `approval-required`.

The existing `golden-path.test.mjs` uses the legacy authorized path
(`golden-path.test.mjs:75-82`):

```ts
delivery: {
  mode: 'authorized',
  policy: releasePolicy,
  operatorAuthorization,
  deferredProfile: null,
},
```

## 8. Deferred mode (terminal approval-required)

When the lifecycle input has `delivery.mode: 'deferred'`
(`product-delivery-lifecycle.ts:188-205`):

```ts
if (value.delivery.mode === 'deferred') {
  // ...validate deferredProfile
  return;
}
```

The Delivery case becomes `DeferredDeliveryReleaseCase` with
`policy: null`, `operatorAuthorization: null`. The settlement policy
short-circuits (`delivery-settlement-policy.ts:450-465`):

```ts
if (deliveryCase.deliveryMode === 'deferred') {
  if (!validDeferredProfile(deliveryCase.deferredProfile)) {
    return settlementResult('failed', ['invalid-input-contract'], ...);
  }
  return settlementResult(
    'approval-required',
    ['operator-authorization-missing'],
    'Delivery was explicitly deferred until a real release policy and operator authorization are supplied.',
    inputHash,
  );
}
```

This is the start-from-idea path: the factory builds the product but
cannot release it without explicit operator authorization. The lifecycle
terminates at `terminal_status='approval-required'`. ADR-044's
`prepareLocalReleaseContinuation` then resumes from this boundary.

## 9. Scripted scenario fragments

Delivery does NOT use scripted worker scenarios in the current golden-path
harness — it runs through kernel handlers. The scripted surface for
Delivery is the **approval inbox**: a test records a decision via MCP, then
resumes the lifecycle run.

### 9.1 Authorized release with `humanApprovalRequired: false` (golden path)

This is what `golden-path.test.mjs` does. No approval-scenario fragment is
needed — the runtime short-circuits to `not-required`.

```js
// tests/factory-contract/golden-path.test.mjs:28-46
const releaseAction = {
  actionId: 'deploy-factory-contract',
  kind: 'deployment',
  target: 'factory-contract-test-target',
  desiredStateHash: sha256Hex({ target: 'factory-contract-test-target', state: 'released-v1' }),
  payloadHash: sha256Hex({ package: 'factory-contract-v1' }),
  required: true,
};
const releasePolicy = {
  id: 'factory-contract-release-policy', version: '1.0.0', contentHash: '',
  channel: 'test', releaseVersion: '1.0.0', releaseTag: 'factory-contract-v1',
  humanApprovalRequired: false,           // <-- short-circuits approval
  requiredPreflightCheckIds: ['candidate-integrity'],
  actions: [releaseAction],
};
releasePolicy.contentHash = hashDeliveryReleasePolicy(releasePolicy);
```

Trusted providers must exist for preflight (`deterministic_evidence`) and
observation (`authoritative_state`):

```js
// golden-path.test.mjs:127-134
db.prepare(`INSERT INTO trusted_providers
  (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
  VALUES (9101,1,'deterministic_evidence','factory-contract-preflight',...,  'full','factory-contract','L0','1.0.0','active')`).run();
db.prepare(`INSERT INTO trusted_providers
  (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
  VALUES (9102,1,'authoritative_state','factory-contract-deployment-state',...,'partial','factory-contract','L4','1.0.0','active')`).run();
```

Assertions after orchestration (`golden-path.test.mjs:181-198`):

```js
function assertLifecycleOutcomes(db, runOffset = 0, diagnostics = '') {
  const runs = db.prepare(
    'SELECT id,module_name,status,local_outcome FROM factory_process_runs ORDER BY id',
  ).all().slice(runOffset);
  const expected = new Map([
    ['product-discovery', 'go'],
    ['solution-formalization', 'formalized'],
    ['solution-development', 'verified'],
    ['delivery-release', 'released'],          // <-- Delivery terminal
  ]);
  for (const [moduleName, outcome] of expected) {
    const run = runs.find(row => row.module_name === moduleName);
    assert.ok(run, `${moduleName} ProcessRun exists`);
    assert.equal(run.status, 'completed');
    assert.equal(run.local_outcome, outcome);
  }
}
```

And the external-effect ledger assertion (`golden-path.test.mjs:236-238`):

```js
assert.ok(
  db.prepare(`SELECT COUNT(*) AS n FROM factory_external_effect_actions
               WHERE module_ref_key LIKE 'delivery-release@%'`).get().n >= 1,
  'Run A Delivery used real external-effect ledger',
);
```

### 9.2 Authorized release WITH human approval (two-phase)

For a `humanApprovalRequired: true` policy, the test must drive the
approval inbox. Pattern:

```js
// Phase 1: lifecycle pauses at approve-release with a pending request.
// The orchestrator run exits; terminal_status is NOT yet set (run is still
// 'running' with the ProcessRun paused at the human node).

// Inspect the inbox:
const list = await client.callJson('delivery_approval_list', { project_id: 1 });
// list.requests[0].request_id === `delivery-approval-request:<processRunId>`
// list.requests[0].candidateHash / preflightHash / releasePolicyHash
//   are the exact bindings the decision must match.

const req = await client.callJson('delivery_approval_get', {
  request_id: list.requests[0].request_id,
});

// Record the decision (idempotent, immutable):
await client.callJson('delivery_approval_decide', {
  request_id: list.requests[0].request_id,
  status: 'approved',                  // or 'denied' / 'expired'
  decided_by: 'test-operator',
  rationale: 'scripted approval',
  provider_id: 9201,                   // trusted_providers row, category='authorized_decision'
});

// Phase 2: resume the SAME lifecycle run. The orchestrator re-leases;
// approve-release re-runs; the inbox returns the immutable decision;
// flow advances to publish-deploy → observe-release → settle-delivery → released.
```

The trusted `authorized_decision` provider must be registered before
`delivery_approval_decide`:

```js
db.prepare(`INSERT INTO trusted_providers
  (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
  VALUES (9201,1,'authorized_decision','test-operator',
          'scripted test operator','none','delivery-approval','L4','1.0.0','active')`).run();
```

### 9.3 Deferred mode → approval-required → local release continuation

Full ADR-044 path:

```js
// Step 1: lifecycle input with deferred delivery.
const lifecycleInput = {
  // ... initiative, development ...
  delivery: {
    mode: 'deferred',
    policy: null,
    operatorAuthorization: null,
    deferredProfile: {
      schemaVersion: 'factory.delivery-deferred-profile.v1',
      reason: 'authorization-required',
      source: 'start-from-idea',
      profileHash: hashDeliveryDeferredProfile(profileBody),
    },
  },
};

// Step 2: run orchestrator. Delivery settles approval-required immediately.
// Parent lifecycle run: status='completed', terminal_status='approval-required'.
// Delivery ProcessRun: local_outcome='approval-required'.
// Certificate reason_codes=['operator-authorization-missing'].

// Step 3: prepare local release continuation.
const { prepareLocalReleaseContinuation } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/app/factory-release-continuation.js')).href
);
const continuation = prepareLocalReleaseContinuation(db, {
  orderRef,
  parentLifecycleRunId,
  actorId: 'test-operator',
  reason: 'local release of exact candidate',
});
// continuation.tag === `saga/local/${candidateHash.slice(0,12)}`
// continuation.childLifecycleRunId is the new suffix run.

// Step 4: resume the CHILD orchestrator. It runs ONLY Delivery with the
// synthesized saga-local-source-tag policy. The local source-tag provider
// creates the git tag (observe-before-act). Delivery settles 'released'.
// Child lifecycle run: status='completed', terminal_status='released'.
// Parent remains visibly 'approval-required' (immutable).
```

### 9.4 Denied approval → blocked

```js
await client.callJson('delivery_approval_decide', {
  request_id, status: 'denied',
  decided_by: 'test-operator', rationale: 'denied in test',
  provider_id: 9201,
});
// Resume the run. approve-release emits domain.denied.
// settle-delivery: deliveryCase.policy.humanApprovalRequired && status==='denied'
//   → blocked, reasonCodes=['approval-denied'].
// terminal_status='delivery-blocked'.
```

## 10. Edge cases and failure modes

### 10.1 What blocks delivery (outcome matrix)

| Condition | Outcome | reasonCodes (subset) |
|---|---|---|
| `deliveryMode: 'deferred'` | `approval-required` | `operator-authorization-missing` |
| Invalid release-policy hash | `failed` | `release-policy-invalid` |
| Operator authorization scope mismatch | `blocked` | `operator-authorization-missing` |
| `currentCandidateHash !== integratedCandidate.hash` | `blocked` | `candidate-drifted` |
| Missing preflight snapshot | `blocked` | `preflight-missing` |
| Preflight hash invalid | `failed` | `preflight-hash-invalid` |
| Required preflight check missing | `blocked` | `preflight-check-missing` |
| Preflight check `failed` | `blocked` | `preflight-check-failed` |
| Preflight check `unknown` | `blocked` | `preflight-check-inconclusive` |
| Preflight check `error` | `failed` | `infrastructure-error` |
| Preflight provider not trusted | `blocked` | `preflight-provider-untrusted` |
| Missing approval (policy requires) | `approval-required` | `approval-missing` |
| Approval status `pending` | (run pauses, not terminal) | — |
| Approval status `expired` | `approval-required` | `approval-expired` |
| Approval status `denied` | `blocked` | `approval-denied` |
| Approved but provider untrusted | `blocked` | `approval-provider-untrusted` |
| Missing publication | `blocked` | `publication-missing` |
| Action plan mismatch | `failed` | `action-plan-mismatch` |
| Required action receipt missing | `blocked` | `action-receipt-missing` |
| Missing observation | `blocked` | `observation-missing` |
| Observation `mismatched` (receipt failed) | `failed` | `action-failed` |
| Observation `mismatched` (receipt ok) | `blocked` | `observation-mismatched` |
| Observation `unknown` (receipt uncertain) | `blocked` | `action-uncertain` |
| Observation `unknown` (receipt ok) | `blocked` | `observation-inconclusive` |
| Observation `error` | `failed` | `infrastructure-error` |
| Matched but missing `externalRef` | `blocked` | `action-receipt-missing` |
| Infrastructure/port error | `failed` | `infrastructure-error` |

### 10.2 Approval denied

If `delivery_approval_decide` records `status: 'denied'`:
1. The decision is immutable — cannot be reversed to `approved`.
2. On resume, `approve-release` emits `domain.denied` → straight to `settle-delivery`.
3. Settlement: `blocked` with `reasonCodes=['approval-denied']`.
4. `terminal_status='delivery-blocked'`.

Recovery: the only path is a NEW continuation with a fresh operator
authorization. The denied run remains immutable evidence.

### 10.3 Approval expired

Same flow as denied EXCEPT the outcome is `approval-required` (not
`blocked`), because expiration is a state of the decision, not an operator
rejection. The operator may re-authorize via a new continuation.

### 10.4 Candidate drift

If `currentCandidateHash !== integratedCandidate.hash` at settlement
(`delivery-settlement-policy.ts:475-484`):

```ts
if (input.currentCandidateHash !== deliveryCase.integratedCandidate.hash) {
  return settlementResult(
    'blocked', ['candidate-drifted'],
    'The candidate changed after Development certification.',
    inputHash,
  );
}
```

Outcome `blocked`. Invariant `delivery.candidate-is-immutable`: any
candidate hash change after Development certification requires fresh
Development verification. Cannot be recovered within Delivery alone.

### 10.5 Push is not release

A successful `publish-deploy` command response alone NEVER establishes
release (invariant `delivery.push-is-not-release`, enforced by policy). If
`observe-release` returns `mismatched`/`unknown`/`error` for any required
destination, settlement does NOT admit `released` even if every receipt is
`succeeded`. The observation snapshot is the sole input to settlement.

### 10.6 Paused run (pending approval)

When `humanApprovalRequired === true` and no decision exists:
- `approve-release` returns `{ runtimeEvent: 'paused' }`.
- The ProcessRun is persisted with the pending approval product.
- The lifecycle run remains `status='running'`, `terminal_status=NULL`.
- The orchestrator releases its lease. NO terminal state is reached.
- The `delivery_approval_list` inbox now shows the open request.

This is NOT a terminal state. The test must record a decision and resume
the run to reach a terminal.

### 10.7 Idempotent re-submission

Three tools are declared `idempotency: 'idempotent'`:
`delivery.publish_deploy`, `delivery.observe_release`,
`delivery.record_release`. A replayed action uses the deterministic
`actionKey` (which excludes ProcessRun id) and observes the target before
acting. A second run for the same immutable candidate/action reuses the
first run's applied state and settles the same outcome.

### 10.8 Local release: tag collision

ADR-044 §Pre-mortem: "Tag moved or collided — use compare-and-set creation;
never force/update." The local source-tag provider creates the tag without
force. An existing tag is successful only when it resolves to the exact
authorized commit/tree; any collision (different commit/tree) blocks and
the outcome is `blocked` with an observation-mismatch reason code.

### 10.9 Local release: parent drift

`SqliteLifecycleContinuationRepository.consume()` checks parent integrity
(`sqlite-lifecycle-continuation-repository.ts:170-179`):

```ts
if (
  !parent
  || !this.isContinuableTerminal(parent, row.resume_stage_id)
  || parent.version !== row.expected_parent_version
  || this.parentTerminalEvidence(parent) !== row.expected_parent_error
  || parent.definitionHash !== row.parent_definition_hash
  || parent.inputHash !== row.parent_input_hash
) {
  throw new Error('CONTINUATION_PARENT_DRIFT');
}
```

Any mutation of the parent run's version, definition, or input after
authorization invalidates the continuation. It also checks
`CONTINUATION_ACTIVE_WORKERS` (no in-flight worker executions in the
epic) and `CONTINUATION_PARENT_LEASED` (no active orchestrator lease).

### 10.10 Continuation prefix must be exact

`buildPrefixEvidence` (`sqlite-lifecycle-continuation-repository.ts:435-495`)
requires exactly one completed StageRun per prefix stage with complete
`mappedOutput`, `resultSnapshot`, `processRunId`, and matching transitions.
Any ambiguity throws `CONTINUATION_PREFIX_NOT_EXACT` /
`CONTINUATION_PREFIX_STAGE_INCOMPLETE` /
`CONTINUATION_PREFIX_TRANSITIONS_INCOMPLETE`.

## 11. Scenario design recommendations

### 11.1 For the LLM-free scripted test harness

Delivery scenarios should NOT be added to
`golden-path-scenarios.mjs` (which keys on worker invocations). Instead:

1. **Authorized no-approval path**: already covered by `golden-path.test.mjs`. Delivery runs through kernel handlers; trusted providers 9101/9102 are pre-registered; no scripted worker is invoked for Delivery nodes. Assertion: `factory_process_runs WHERE module_name='delivery-release'` has `status='completed'`, `local_outcome='released'`, and `factory_external_effect_actions` has at least one row with `module_ref_key LIKE 'delivery-release@%'`.

2. **Human-approval path**: a new test that sets `humanApprovalRequired: true`, runs the orchestrator until pause, then drives `delivery_approval_decide` via MCP and resumes. Asserts the two-phase flow reaches `released`.

3. **Deferred → local release**: a new test that uses `delivery.mode: 'deferred'`, asserts parent terminates at `approval-required`, then calls `prepareLocalReleaseContinuation` and asserts the child reaches `released` and the git tag `saga/local/<candidateHash.slice(0,12)>` exists.

4. **Denied approval**: assert `blocked` terminal and `delivery-blocked` terminal_status.

### 11.2 Trusted provider fixtures

Every Delivery test needs at minimum:

| provider_id | category | scope | Used by |
|---|---|---|---|
| 9101 | `deterministic_evidence` | preflight checks | preflight-release |
| 9102 | `authoritative_state` | deployment observation | observe-release |
| 9201 | `authorized_decision` | approval inbox | delivery_approval_decide (only when `humanApprovalRequired: true`) |

Without these, the preflight/observation/approval handlers route to
`blocked` with provider-untrusted reason codes.

### 11.3 External-effect provider fixture

The publish-deploy adapter calls an injected provider per action kind
(`source-tag` / `source-release` / `package-publish` / `deployment`). For
the golden-path deployment, the test composition provides a deterministic
deployment provider that records the action in
`factory_external_effect_actions` and returns an `externalRef` +
`resultHash` that the observation provider later confirms as `matched`.

## 12. Summary

Delivery is a kernel-driven workshop with a single human node
(`approve-release`). Its flow is strictly linear with short-circuit paths
from preflight/approval directly to settlement. Four terminal outcomes,
all mapped to lifecycle terminal statuses. The settlement policy is the
authoritative release gate: it requires a `matched` authoritative
observation for every required action before emitting `released` and the
canonical `ReleaseRecord`.

The scripted test surface for Delivery is NOT worker scenarios — it is
the approval inbox (`delivery_approval_*` MCP tools) and the continuation
authority (`prepareLocalReleaseContinuation`). The kernel handlers and
their injected SQLite adapters do the rest, driven entirely by trusted
providers and the deterministic action-key idempotency strategy.
