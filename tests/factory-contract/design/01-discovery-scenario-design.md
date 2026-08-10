# Discovery Scenario Design — LLM-Free Scripted Test

This document is the complete specification of MCP tool calls for **цех Discovery**
(`product-discovery@3.0.2`), the FIRST stage of the Product Delivery conveyor
(**Discovery** → Formalization → Development → Delivery). It is written so a
scripted test double (no LLM) can drive every discovery node to the green
terminal outcome `go`.

Every claim below is backed by quoted code. File paths are absolute under
`D:/Development/saga-mcp/`.

---

## 1. Node Graph (the Flow)

### 1.1 Flow identity

From `src/process-modules/modules/discovery/discovery-process-module.ts`
(lines 67-70):

- `flow.id = 'factory.discovery.standard'`
- `flow.version = '2.0.0'`
- `entryNodeId = 'produce-proposal'`

The module identity is `product-discovery@3.0.2`
(`DISCOVERY_PROCESS_MODULE_REF` in
`src/process-modules/lifecycles/product-delivery-module-contracts.ts:30-33`):

```ts
export const DISCOVERY_PROCESS_MODULE_REF = {
  name: 'product-discovery',
  version: '3.0.2',
} as const satisfies ProcessModuleReference;
```

### 1.2 The 3 functional nodes in execution order

```
produce-proposal    (production-cell)  → DiscoveryProposal product
        │ domain.accepted
        ▼
assess-readiness    (production-cell)  → DiscoveryReadinessAssessment product
        │ domain.accepted
        ▼
settle              (kernel)           → DiscoveryOutcomeCertificate + outcome
        │ domain.go | domain.clarify | domain.reject
        │ domain.defer | domain.inconclusive | domain.failed
        ▼
complete-go | complete-clarify | complete-reject
complete-defer | complete-inconclusive | complete-failed
```

Plus 6 terminal outcome-emitter nodes — each `kind: 'kernel'`,
`handler: 'process-outcome-emitter'`, emits one outcome code
(discovery-process-module.ts:123-131). The outcome-emitter is runtime-owned
(manifest.ts:84-89 explains the generic `process-outcome-emitter` is excluded
from `DISCOVERY_HANDLER_IDS`).

### 1.3 Transitions (full table from discovery-process-module.ts:133-144)

| From | To | On event |
|------|-----|----------|
| `produce-proposal` | `assess-readiness` | `domain.accepted` |
| `produce-proposal` | `complete-failed` | `domain.failed` |
| `assess-readiness` | `settle` | `domain.accepted` |
| `assess-readiness` | `complete-failed` | `domain.failed` |
| `settle` | `complete-go` | `domain.go` |
| `settle` | `complete-clarify` | `domain.clarify` |
| `settle` | `complete-reject` | `domain.reject` |
| `settle` | `complete-defer` | `domain.defer` |
| `settle` | `complete-inconclusive` | `domain.inconclusive` |
| `settle` | `complete-failed` | `domain.failed` |

Terminal node ids (discovery-process-module.ts:145-148):
`complete-go`, `complete-clarify`, `complete-reject`, `complete-defer`,
`complete-inconclusive`, `complete-failed`.

### 1.4 Outcomes (discovery-process-module.ts:59-66)

| Code | Terminal | Meaning |
|------|----------|---------|
| `go` | yes | The subject is sufficiently grounded to continue |
| `clarify` | yes | Material information is missing or contradictory |
| `reject` | yes | The subject should not continue under current evidence and policy |
| `defer` | yes | The subject is valid but should be reconsidered later |
| `inconclusive` | yes | Discovery completed without enough basis for another decision |
| `failed` | yes | Discovery infrastructure could not produce an authoritative result |

The **golden path** targets `go`.

### 1.5 Production cell shape (discovery-process-module.ts:79-111)

Both cognitive nodes (`produce-proposal`, `assess-readiness`) are
**singleton Production Cells** built via `singletonProductionCell(...)`. Each
has:

- `cardinality: '1'` (one workplace, workKey `'singleton'`)
- `maxAttempts: 2` (one repair round, then `onExhausted: 'pause'`)
- `onExhausted: 'pause'`
- `productSource: 'typed-submission'` (see §5 — this is critical)
- `checkPlan`: the node-specific CheckProvider (see §3)
- NO `review` phase — Discovery is author-only. The skill explicitly forbids
  reviewer-style acceptance (saga-discovery-worker/SKILL.md:9-11):
  > "You produce a product; you do not accept it, route the process, create
  > tasks, or run a private recovery loop."
- `acceptedTransition`: `produce-proposal → assess-readiness`,
  `assess-readiness → settle`.

`failedTransition` for both is `complete-failed`.

There is **NO `postAcceptanceEffect`** declared on either cell — Discovery does
not project draft→accepted artifacts via the cell. The only "auto-artifact"
side-effect is the **brief provisioning port** (see §4.3), which is invoked
by the legacy proposal-submission resolver — NOT by the production-cell path.
Under the production-cell flow used by the factory contract tests, the brief
is provisioned by Formalization's `ensureBriefRoot` fallback
(`src/infrastructure/process-modules/brief-provisioning-ports.ts:46-96`).

---

## 2. Per-Node Tool Call Sequence

The scenario engine dispatches by **scenario key**
(`tests/factory-contract/scenario-engine.mjs:113-125`):

```js
{
  module: metadata.process_module_ref,   // 'product-discovery@3.0.2'
  node:   metadata.process_node_id,      // 'produce-proposal' | 'assess-readiness'
  cell:   metadata.production_cell_id,   // 'discovery-proposal' | 'discovery-readiness'
  role:   metadata.role,                 // 'author'  (Discovery is author-only)
  workKey: metadata.work_key,            // 'singleton'
  taskKind: task.task_kind,              // 'discovery.work' | 'discovery.assess'
}
```

Formatted as `${module}/${node}/${role}/${workKey}`
(`scenario-engine.mjs:130-132`). The golden-path scenario map
(`golden-path-scenarios.mjs:402-403`) registers exactly two keys:

```js
'product-discovery@3.0.2/produce-proposal/author/singleton': discoveryProposal,
'product-discovery@3.0.2/assess-readiness/author/singleton': discoveryReadiness,
```

The `settle` kernel node has **no scenario key** — it is executed by the
kernel handler `discovery-settlement-policy`, not by a worker
(see §2.3).

### 2.1 Node `produce-proposal` — the Proposal worker

**Execution profile** (discovery-process-module.ts:170-194):
- `id: 'discovery-proposal-worker'`
- `taskKind: 'discovery.work'`
- `executionSkill: 'saga-discovery-worker'`
- `executionMode: 'tracker_only'` (no git worktree)
- `allowedTools`: `task_get`, `repository_checkout_list`, `artifact_list`,
  `note_list`, `product_submit`, `worker_done`, `Write`, `Read`, `Edit`,
  `Bash`, `Glob`, `Grep`
- `outputSchema: { id: 'factory.discovery-proposal.v1' }`
- `retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' }`

**Workspace templates materialized for the worker**:
- `discovery-doc-template.md` (the human-readable discovery narrative)
- `proposal-call-template.json` (the typed product envelope skeleton)
- `proposal-stage-tracker.md` (progress checklist)
- `proposal-checklist.md` (validation rules)

**Skill** (`saga-discovery-worker/SKILL.md`): worker is told to produce one
typed `DiscoveryProposal` via `product_submit` and then call `worker_done`.

**Exact MCP calls in order** (from `golden-path-scenarios.mjs:47-62`):

| # | Tool | Arguments | Purpose |
|---|------|-----------|---------|
| 1 | `task_get` | `{ id: <task_id> }` | Read task metadata (process_node_input, workplace_ref). Done automatically by the scenario engine (`scenario-engine.mjs:157`) before dispatching to the handler. |
| 2 | `product_submit` | `{ schema: 'factory.discovery-proposal.v1', content: { problem_statement, observed_context, stakeholders_or_actors[], assumptions[], unknowns[], risks[], candidate_scope, evidence_refs[], recommended_outcome, rationale } }` | Submit the typed proposal. Server derives process/module/node/task/execution from the live fence (`SAGA_EXECUTION_ID` env). |
| 3 | `worker_done` | `{ task_id, worker_id, execution_id, result: 'produced discovery proposal with recommended_outcome=go' }` | Signal physical execution complete. `execution_id` is REQUIRED (fencing token). |

**Critical detail**: The worker does NOT call `artifact_create`, `trace_add`,
or any tracker artifact API. Discovery's "products" are typed-submission
products, not artifact rows. The proposal lives in
`factory_managed_node_submissions` and (via the projection at
`src/tools/products.ts:60-75`) also in `factory_proposals` so D3/D4 can see it.

**Exact product content** the golden path uses
(`golden-path-scenarios.mjs:48-59`):

```js
{
  problem_statement: 'The current pipeline lacks automated end-to-end validation.',
  observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
  stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
  assumptions: ['Factory physics is correct in isolation.',
                'Deterministic workers can substitute LLM.'],
  unknowns: ['None blocking.'],
  risks: ['Fixture drift risk.'],
  candidate_scope: 'Run Product Delivery through the real Factory with deterministic physical workers.',
  evidence_refs: ['CONVEYOR-MENTAL-MODEL.md §16', 'factory-contract harness'],
  recommended_outcome: 'go',
  rationale: 'Concrete gap, bounded scope and deterministic verification path.',
}
```

**Why `recommended_outcome: 'go'`**: the settlement policy's GO branch
(settlement-policy.ts:439) only fires when `workerOutcome === 'go'`. Any other
value (clarify/reject/defer/inconclusive/failed) routes to a non-go terminal.

**`product_submit` response shape** (`src/tools/products.ts:76-93`):
```js
{
  accepted: true,
  replayed: false,
  product_ref: { schemaId, ref, digest },     // THE canonical ProductRef
  universal_ref: ...,
  submission_id: <number>,                    // used by readiness as proposal_id
  process_run_id, module_ref, node_id, execution_id,
  discovery_proposal_id: <number|null>,       // factory_proposals projection
  _workflow_hint: 'Product sealed on the desk. Call worker_done exactly once.'
}
```

The worker records `product_ref` in the tracker (step 8 in
`proposal-stage-tracker.md:27`) — but this is a file write, not an MCP call.

### 2.2 Node `assess-readiness` — the Readiness advisor

**Execution profile** (discovery-process-module.ts:195-215):
- `id: 'discovery-readiness-advisor'`
- `taskKind: 'discovery.assess'`
- `executionSkill: 'saga-discovery-readiness-advisor'`
- `executionMode: 'tracker_only'`
- `allowedTools`: `task_get`, `product_read`, `product_submit`,
  `worker_done`, `Read`, `Edit`  (NOTE: much smaller tool surface — no Write,
  no Bash, no artifact APIs)
- `outputSchema: { id: 'factory.discovery-readiness-assessment.v1' }`
- `retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' }`

**Workspace templates**: `readiness-call-template.json`,
`readiness-stage-tracker.md`, `readiness-checklist.md`.

**Skill** (`saga-discovery-readiness-advisor/SKILL.md`): advisor must read the
EXACT accepted Proposal ProductRef from `task.metadata.process_node_input`,
call `product_read` with the exact triple, bind the assessment's
`proposal_id` and `proposal_content_hash` to that exact Proposal, and submit
one readiness assessment.

**Exact MCP calls in order** (from `golden-path-scenarios.mjs:64-101`):

| # | Tool | Arguments | Purpose |
|---|------|-----------|---------|
| 1 | `task_get` | `{ id: <task_id> }` | Read task. Done by engine. |
| 2 | `product_read` | `{ schema_id: 'factory.discovery-proposal.v1', ref: <proposalRef>, digest: <proposalDigest> }` | Read the exact accepted Proposal. The triple is extracted from `task.metadata.process_node_input.bindings.items[].products[]` (see §2.2.1). |
| 3 | `product_submit` | `{ schema: 'factory.discovery-readiness-assessment.v1', content: { proposal_id, proposal_content_hash, overall_readiness, dimension_assessments{7 dims}, blocking_gaps, non_blocking_gaps, recommended_next_action, confidence, rationale } }` | Submit the readiness assessment. |
| 4 | `worker_done` | `{ task_id, worker_id, execution_id, result: 'produced readiness assessment: ready' }` | Complete physical execution. |

**2.2.1 Finding the Proposal ProductRef** (`golden-path-scenarios.mjs:66-77`):

```js
const meta = metaOf(task);                // task.metadata, parsed if string
const pni = meta.process_node_input;      // bound by ProductionCellNodeExecutor
let proposalSchema, proposalRef, proposalDigest;
if (pni?.bindings?.items) {
  for (const item of pni.bindings.items) {
    const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
    if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
  }
}
if (!proposalSchema) throw new Error('No proposal product in manifest');
```

The `process_node_input` is set by `bindProjectedTaskProcessContext` in
`src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts:92-153`.
For `assess-readiness`, `nodeInput` is the upstream `produce-proposal`
production manifest (the `NodeProduction` shape with `contentHash`, `bindings`,
`semanticDigest` — see production-cell-node-executor.ts:789-791). That
manifest's `bindings.items[].products[]` carries the exact ProductRefs
(`{ schemaId, ref, digest }`) of accepted upstream products.

**2.2.2 Extracting `proposal_id`** (`golden-path-scenarios.mjs:78`):
```js
const proposal = await client.callJson('product_read', {...});
const proposalId = proposal.submission_id ?? 0;
```
The `product_read` response includes `submission_id` — the
`factory_managed_node_submissions.id` (products.ts:122-133). That integer is
the readiness assessment's `proposal_id`.

**2.2.3 Extracting `proposal_content_hash`**:
The exact Proposal ProductRef `digest` (a 64-char lowercase hex SHA-256) —
passed through verbatim. The readiness gate will reject any mismatch.

**Exact readiness content** the golden path uses
(`golden-path-scenarios.mjs:80-98`):

```js
{
  proposal_id: proposalId,                              // from product_read
  proposal_content_hash: proposalDigest,                // exact Proposal digest
  overall_readiness: 'ready',
  dimension_assessments: {
    problem_clarity:         { status: 'sufficient', rationale: 'Clear.',
                               source_refs: ['$.problem_statement'] },
    scope_boundedness:       { status: 'sufficient', rationale: 'Bounded.',
                               source_refs: ['$.candidate_scope'] },
    stakeholder_coverage:    { status: 'sufficient', rationale: 'Identified.',
                               source_refs: ['$.stakeholders_or_actors'] },
    assumption_visibility:   { status: 'sufficient', rationale: 'Explicit.',
                               source_refs: ['$.assumptions'] },
    unknowns_manageability:  { status: 'sufficient', rationale: 'No blocker.',
                               source_refs: ['$.unknowns'] },
    risk_visibility:         { status: 'sufficient', rationale: 'Visible.',
                               source_refs: ['$.risks'] },
    evidence_grounding:      { status: 'sufficient', rationale: 'Grounded.',
                               source_refs: ['$.evidence_refs'] },
  },
  blocking_gaps: [],
  non_blocking_gaps: [],
  recommended_next_action: 'proceed_to_settlement',
  confidence: 0.95,
  rationale: 'Ready for deterministic formalization.',
}
```

**Why each value matters for the GO path** (cross-referenced against the
settlement policy §3.2):
- `overall_readiness: 'ready'` — required (policy checks `=== 'ready'`).
- `evidence_grounding.status: 'sufficient'` — required (policy checks this
  dimension specifically).
- `blocking_gaps: []` — required (`blockingGapsMax: 0`).
- `recommended_next_action: 'proceed_to_settlement'` — required.
- `confidence: 0.95` — must be `>= 0.70` (`GO_MIN_CONFIDENCE`).
- `source_refs` — must be exact Proposal JSON paths (`$.<field>`). The gate
  computes `allowedProposalSourceRefs` (check-providers.ts:112-122) and
  rejects anything not in that set.

### 2.3 Node `settle` — the kernel settlement (NO worker)

The `settle` node is `kind: 'kernel'`, `handler: 'discovery-settlement-policy'`
(discovery-process-module.ts:113-122). It is **not** a production cell —
no worker is launched, no scenario key is invoked.

The handler is registered by
`createDiscoveryProductionCellKernelHandlers` in
`src/modules/discovery/application/discovery-production-cell-installation.ts:52-59`
and executed by the kernel-node-executor. The scripted test never sees this
node directly; it manifests only as the ProcessRun advancing from
`assess-readiness` to one of the terminal outcomes.

**What the handler does** (production-cell-installation.ts:61-176):

1. Reads `ctx.frame.productions['produce-proposal']` — the upstream cell's
   `NodeProduction` manifest. Calls `requireAcceptedSingletonCellItem` to
   extract the single accepted item.
2. Reads `ctx.input` (the `assess-readiness` manifest) the same way.
3. For each, calls `readSubmission(db, processRunId, executionId, schema)`:
   - Queries `factory_managed_node_submissions` by
     `(process_run_id, execution_id)` ordered `id DESC LIMIT 1`.
   - Validates `schema_version` matches the expected schema id.
   - **Re-validates content_hash**: recomputes `sha256Hex(JSON.parse(payload_snapshot))`
     and compares to the stored `content_hash`. Mismatch → throws
     `DISCOVERY_PRODUCT_HASH_MISMATCH`.
4. Reads `factory_process_runs.input_hash` and `started_at` for the snapshot.
5. Builds a `DiscoverySettlementInputSnapshot` (proposal + readiness + policy
   + captured_at = run.started_at for byte-stable replay).
6. Computes `snapshotHash = buildSettlementInputHash(snapshot)`.
7. Runs `policy.settle(snapshot)` — pure deterministic function
   (see §3.2 for decision rules).
8. Builds the certificate payload, hashes it, calls
   `certificates.issue(...)` to persist
   `factory_process_outcome_certificates`.
9. Returns a `KernelHandlerResult` with:
   - `event: decision` (`'go'|'clarify'|'reject'`)
   - `production.bindings`: `{ authority, reasonCodes, settlementInputHash }`
   - `completion`: `{ outcome, outputEnvelope: { outcome, certificateRef, productions: [] }, terminal: true }`

The `completion.outputEnvelope.certificateRef` is the durable
`DiscoveryOutcomeCertificate` ProductRef
(`{ schemaId: 'factory.discovery-outcome-certificate.v1', ref: 'certificate:<id>', digest: <hash> }`).

On **error** (any thrown exception): returns `event: 'failed'` with the error
message in `bindings.error` → routes to `complete-failed`.

---

## 3. Gate Checks

Each Production Cell runs exactly **one GateDecision** after the worker calls
`worker_done`. The gate is driven by `driveGateRun`
(`src/process-modules/application/gate-run-driver.ts`) over a `checkPlan`
that references a semantic CheckProvider.

### 3.1 Proposal gate (`produce-proposal`)

**CheckProvider**: `discovery.proposal-contract.v1` v1.0.0
(`discovery-check-providers.ts:14-21`).

**Provider digest** is `sha256Hex({ providerId, version, invariant: 'discovery-proposal-schema-and-required-fields' })`.

**What the check does** (`discovery-check-providers.ts:42-61`):
1. Resolves the producer submission from the CandidateSet's
   `subjectCandidateSetRef` (reads `factory_managed_node_submissions` by
   `process_run_id + execution_id`).
2. If no row OR `schema_version !== 'factory.discovery-proposal.v1'` →
   `'failed'`.
3. Runs `validateDiscoveryProposal(JSON.parse(payload_snapshot))`
   (discovery-proposal.ts:68-104):
   - `problem_statement`, `observed_context`, `candidate_scope`, `rationale`
     must be non-empty strings.
   - `stakeholders_or_actors`, `assumptions`, `unknowns`, `risks`,
     `evidence_refs` must be arrays of strings.
   - `recommended_outcome` must be one of
     `['go','clarify','reject','defer','inconclusive','failed']`.
4. Returns `'passed'` if valid, `'failed'` if invalid, `'error'` on throw.

**Can fail on**:
- Missing required string field (empty/whitespace).
- Non-string-array field.
- `recommended_outcome` outside the enum.
- Schema mismatch (wrong `schema` arg to `product_submit`).

**Repair behavior**: the Cell has `maxAttempts: 2`, `onExhausted: 'pause'`.
On a failed gate, the workplace transitions to `repair_wait`; a fresh
WorkerExecution is launched in the same Workplace with `recovery_feedback`
in the task metadata. After 2 failed attempts the workplace pauses
(`verdict: 'human_required'`).

### 3.2 Readiness gate (`assess-readiness`)

**CheckProvider**: `discovery.readiness-contract.v1` v1.0.0
(`discovery-check-providers.ts:23-30`).

**Provider digest** is `sha256Hex({ providerId, version, invariant: 'readiness-binds-exact-accepted-proposal-and-cites-only-allowed-sources' })`.

**What the check does** (`discovery-check-providers.ts:63-110`):
1. Resolves the readiness producer submission from the CandidateSet.
2. Validates `schema_version === 'factory.discovery-readiness-assessment.v1'`
   AND `Number.isSafeInteger(parameters.processRunId)` AND `processRunId >= 1`
   (else `'failed'`).
3. Loads the accepted Proposal by:
   ```sql
   SELECT id, content_hash, payload_snapshot
     FROM factory_managed_node_submissions
    WHERE process_run_id=? AND node_id='produce-proposal'
      AND schema_version='factory.discovery-proposal.v1'
    ORDER BY id DESC LIMIT 1
   ```
   If missing → `'error'`.
4. Computes `allowedProposalSourceRefs(proposalPayload)`:
   - Adds `$.<key>` for every top-level field of the proposal.
   - Adds every literal string in `proposal.evidence_refs`.
5. Runs `validateReadinessAssessment(assessment, proposal.id, proposal.content_hash, allowedRefs)`
   (discovery-readiness-assessment.ts:156-322). Validates:
   - `proposal_id` is an integer AND equals `proposal.id`.
   - `proposal_content_hash` matches `/^[0-9a-f]{64}$/` AND equals
     `proposal.content_hash`.
   - `overall_readiness` ∈ `['ready','conditionally_ready','not_ready','inconclusive']`.
   - `recommended_next_action` ∈ the 6-value enum.
   - `confidence` finite in `[0,1]`.
   - `rationale` non-empty.
   - `dimension_assessments` is an object with EXACTLY the 7 required
     dimensions, no more, no less. Each dimension: `status` in enum,
     non-empty `rationale`, non-empty `source_refs` array.
   - `blocking_gaps` / `non_blocking_gaps`: arrays, each gap has unique
     non-empty `code`, non-empty `description`, non-empty `source_refs`.
     No code in both lists.
   - **Anti-invent-evidence**: every `source_ref` must be in `allowedRefs`
     (a proposal JSON path `$.<field>` or a literal evidence ref string).
6. Returns `'passed'` if valid, `'failed'` if invalid, `'error'` on throw.

**Can fail on**:
- `proposal_id` mismatch (wrong submission_id used).
- `proposal_content_hash` mismatch (wrong digest, or not 64-char hex).
- Unknown dimension key, or missing dimension.
- Empty `source_refs` array (P1-1 grounding rule).
- Invented source ref (e.g. `$.foo` where `foo` is not a proposal field, or
  `$.evidence_refs[0]` — the allowed ref is the literal evidence string, not
  a JSONPath into it).
- Duplicate gap code, or gap code in both lists.
- `confidence` outside `[0,1]`.

### 3.3 Settlement "gate" (kernel, not a CheckProvider)

The `settle` node is not gated by a CheckProvider — it runs the **deterministic
policy** (`discovery-settlement-policy.ts`). The policy is pure and
unconditionally produces one of `go`/`clarify`/`reject` (with reason codes);
the kernel node routes to the matching terminal. See §3.4.

### 3.4 Settlement decision rules (discovery-settlement-policy.ts)

**GO** requires ALL of (policy v1 manifest, settlement-policy.ts:202-224):
- `worker_outcome === 'go'`
- `proposal.evidence_refs` has at least one non-empty string
  (`proposal_evidence_min: 1`)
- `assessment.overall_readiness === 'ready'`
- `assessment.blocking_gaps.length === 0` (`blocking_gaps_max: 0`)
- `assessment.dimension_assessments.evidence_grounding.status === 'sufficient'`
- `assessment.recommended_next_action === 'proceed_to_settlement'`
- `assessment.confidence >= 0.70` (`GO_MIN_CONFIDENCE`)

Emits: `decision: 'go'`, `reason_codes: ['GO_READY_AND_GROUNDED']`.

**REJECT** requires ALL of:
- `worker_outcome === 'reject'`
- `assessment.overall_readiness === 'not_ready'`
- `assessment.recommended_next_action === 'reject'`
- `assessment.blocking_gaps.length >= 1`
- every blocking gap has non-empty `source_refs`
- `assessment.confidence >= 0.70`

Emits: `decision: 'reject'`, `reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE']`.

**CLARIFY** is the fail-closed fallback. Short-circuits:
- `worker_outcome === 'clarify'` → `CLARIFY_WORKER_REQUESTED`.
- No accepted readiness (`status !== 'accepted_by_kernel'`) →
  `CLARIFY_READINESS_MISSING|FAILED|PAUSED`.

Otherwise: every failed GO/REJECT precondition emits its own reason code, and
if none match, `CLARIFY_POLICY_FALLBACK`.

**Catch-all**: `worker_outcome` ∈ `{defer, inconclusive, failed}` →
`CLARIFY_POLICY_FALLBACK`.

> **Note**: the policy can only emit `go`/`clarify``/`reject`. The flow's
> `complete-defer`, `complete-inconclusive`, `complete-failed` terminal
> nodes are reachable only via `'domain.failed'` from a prior cell, or via
> the settlement handler's error path. The `defer`/`inconclusive` outcomes
> in `module.outcomes` are declared but the v1 policy never emits them.

---

## 4. Artifacts Produced

### 4.1 Typed products (in `factory_managed_node_submissions`)

| Product | Schema id | Node | Authority |
|---------|-----------|------|-----------|
| `DiscoveryProposal` | `factory.discovery-proposal.v1` | `produce-proposal` | worker (`product_submit`) |
| `DiscoveryReadinessAssessment` | `factory.discovery-readiness-assessment.v1` | `assess-readiness` | advisor (`product_submit`) |
| `DiscoveryOutcomeCertificate` | `factory.discovery-outcome-certificate.v1` | `settle` | kernel (`certificates.issue`) |

Additionally, the proposal is projected into `factory_proposals` by
`projectDiscoveryProposal` (`src/tools/products.ts:60-75`) so that the legacy
D3/D4/D5 spine can read it. The projection creates a row with
`proposal_id` and `content_hash`.

### 4.2 Module artifacts declared (discovery-process-module.ts:150-155)

```ts
artifacts: [
  { type: 'discovery-case',                    schema: factory.discovery-case.v1,                       authority: 'kernel'  },
  { type: 'discovery-proposal',                schema: factory.discovery-proposal.v1,                   authority: 'worker'  },
  { type: 'discovery-readiness-assessment',    schema: factory.discovery-readiness-assessment.v1,       authority: 'advisor' },
  { type: 'discovery-outcome-certificate',     schema: factory.discovery-outcome-certificate.v1,        authority: 'kernel'  },
]
```

These are **declared** types (used by manifest validation / coverage queries).
They are NOT all materialized as artifact rows on the golden path — Discovery
stores them as typed products / certificates, not in `artifacts`.

### 4.3 The auto-provisioned `brief` artifact

**Important**: on the production-cell flow, Discovery does **NOT** create a
`brief` artifact row itself. The legacy
`discovery-resolve-proposal-submission` handler (in
`discovery-installation.ts:240-251`) does call `briefProvisioning.ensureDiscoveryBrief`,
which inserts a row into `artifacts` with:
- `type: 'brief'`, `code: 'BRIEF-1'`, `title: 'Discovery Brief'`
- `path: 'docs/discovery/brief-auto-provisioned.md'`
- `status: 'accepted'`, `storage_kind: 'db_native'`
- `content_hash = accepted_hash = sha256Hex({ schema, epic_id, problem_statement, candidate_scope, recommended_outcome, note })`

(`src/infrastructure/process-modules/brief-provisioning-ports.ts:143-178`)

BUT that handler is wired to the legacy `'discovery-resolve-proposal-submission'`
handler id, which is NOT the handler the Flow's `produce-proposal` node uses
(that node is a production cell with no kernel handler). On the factory
contract path the brief materializes via Formalization's fallback
(`SqliteFormalizationBriefProvisioning.ensureBriefRoot`,
brief-provisioning-ports.ts:46-96) when the first PRD is created without a
root ancestor.

**For the scripted test this means**: do NOT call `artifact_create({type:'brief'})`
inside the Discovery scenarios. The brief either does not exist after Discovery
(legacy resolver path) or is auto-created by Formalization (production-cell
path). The golden-path scenarios correctly omit any brief creation
(`golden-path-scenarios.mjs:47-62` does not call `artifact_create`).

### 4.4 No traces, no PRD/FR/UC/AC, no decision/hypothesis/business_metric

Unlike Formalization, Discovery creates:
- **NO** `trace_add` calls
- **NO** PRD/FR/NFR/RULE/UC/AC/SRS artifacts
- **NO** decision/hypothesis/business_metric/theme/SPEC artifacts

Those are Formalization-stage concerns. The Discovery scenarios must NOT
create them.

---

## 5. Managed-Production vs Typed-Submission

**Discovery uses `typed-submission` for both cognitive cells.**

Quoted from `discovery-process-module.ts:79-90` (proposal cell):

```ts
cellDefinition: singletonProductionCell({
  id: 'discovery-proposal',
  executionProfileId: 'discovery-proposal-worker',
  outputSchemaRef: DISCOVERY_PROPOSAL_SCHEMA,
  productSource: 'typed-submission',    // <-- NOT 'managed-production'
  cardinality: '1',
  maxAttempts: 2,
  onExhausted: 'pause',
  checkPlan: PROPOSAL_PLAN,
  acceptedTransition: 'assess-readiness',
  failedTransition: 'complete-failed',
}),
```

Same for `assess-readiness` (line 104). Compare with Formalization where most
cells use `managed-production` and only `reconcile-what` uses `typed-submission`.

**Consequences for the scripted test**:
1. The worker calls **`product_submit`** (the typed-submission MCP tool), NOT
   `artifact_create`/`trace_add` (the managed-production MCP tools).
2. `product_submit` validates the `schema` against the WorkIntent's declared
   `output_schema` via `submissionRepo().assertSchemaForCurrentExecution(schema)`
   (products.ts:39-40). A schema mismatch is rejected before any write.
3. The submission row in `factory_managed_node_submissions` carries
   `schema_version`, `payload_snapshot`, `content_hash`. The Cell gate reads
   this row directly (check-providers.ts:124-139).
4. The Production Cell node executor's `productReader.readExecutionProducts`
   is called with `requireTypedSubmission: true` for these cells
   (production-cell-node-executor.ts:496-498).

The `productSource: 'typed-submission'` flows from the cell definition into
the task metadata via `activateRoleTask`
(production-cell-node-executor.ts:816-823), which is how the MCP server knows
to accept `product_submit` for this task.

---

## 6. Scripted Scenario Fragment

The complete, working golden-path Discovery scenarios
(`tests/factory-contract/golden-path-scenarios.mjs:47-101`):

```js
import { actions } from './scenario-engine.mjs';

const DISC = 'product-discovery@3.0.2';

// --- produce-proposal/author/singleton ---
const discoveryProposal = async ({ client, prompt }) => {
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', {
    problem_statement: 'The current pipeline lacks automated end-to-end validation.',
    observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
    stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
    assumptions: ['Factory physics is correct in isolation.',
                  'Deterministic workers can substitute LLM.'],
    unknowns: ['None blocking.'],
    risks: ['Fixture drift risk.'],
    candidate_scope: 'Run Product Delivery through the real Factory with deterministic physical workers.',
    evidence_refs: ['CONVEYOR-MENTAL-MODEL.md §16', 'factory-contract harness'],
    recommended_outcome: 'go',
    rationale: 'Concrete gap, bounded scope and deterministic verification path.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'produced discovery proposal with recommended_outcome=go');
};

// --- assess-readiness/author/singleton ---
const discoveryReadiness = async ({ client, task, prompt }) => {
  const meta = typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
  const pni = meta.process_node_input;
  let proposalSchema, proposalRef, proposalDigest;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
      if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
    }
  }
  if (!proposalSchema) throw new Error('No proposal product in manifest');
  const proposal = await client.callJson('product_read', {
    schema_id: proposalSchema, ref: proposalRef, digest: proposalDigest,
  });
  const proposalId = proposal.submission_id ?? 0;

  await actions.submitProduct(client, 'factory.discovery-readiness-assessment.v1', {
    proposal_id: proposalId,
    proposal_content_hash: proposalDigest,
    overall_readiness: 'ready',
    dimension_assessments: {
      problem_clarity:        { status: 'sufficient', rationale: 'Clear.',
                                source_refs: ['$.problem_statement'] },
      scope_boundedness:      { status: 'sufficient', rationale: 'Bounded.',
                                source_refs: ['$.candidate_scope'] },
      stakeholder_coverage:   { status: 'sufficient', rationale: 'Identified.',
                                source_refs: ['$.stakeholders_or_actors'] },
      assumption_visibility:  { status: 'sufficient', rationale: 'Explicit.',
                                source_refs: ['$.assumptions'] },
      unknowns_manageability: { status: 'sufficient', rationale: 'No blocker.',
                                source_refs: ['$.unknowns'] },
      risk_visibility:        { status: 'sufficient', rationale: 'Visible.',
                                source_refs: ['$.risks'] },
      evidence_grounding:     { status: 'sufficient', rationale: 'Grounded.',
                                source_refs: ['$.evidence_refs'] },
    },
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.95,
    rationale: 'Ready for deterministic formalization.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'produced readiness assessment: ready');
};

export const goldenPathScenarios = {
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};
```

**Action helpers used** (`scenario-engine.mjs:199-279`):

```js
actions.submitProduct(client, schema, content)
  // -> client.callJson('product_submit', { schema, content })

actions.done(client, taskId, workerId, executionId, result)
  // -> client.callJson('worker_done', {
  //      task_id, worker_id, result, execution_id
  //    })
```

**Scenario key registration** requires the literal strings
`product-discovery@3.0.2/produce-proposal/author/singleton` and
`product-discovery@3.0.2/assess-readiness/author/singleton`. A typo in the
module version (e.g. `3.0.0` instead of `3.0.2`) produces
`SCENARIO_NOT_FOUND`.

---

## 7. Edge Cases and Failure Modes

### 7.1 Empty / placeholder fields

The proposal checklist (`proposal-checklist.md:17`) and the validator
(discovery-proposal.ts:79-84) reject any field that is empty or whitespace.
A worker that leaves `FILL_...` placeholders in the call template will fail
the gate. The scripted test must always submit fully-populated content.

### 7.2 `proposal_id` type discipline

The readiness template (`readiness-call-template.json:5`) ships with
`"proposal_id": 0`. The validator requires `Number.isInteger(proposal_id)`
(discovery-readiness-assessment.ts:168) AND that it equals the accepted
Proposal's `factory_managed_node_submissions.id`. The scripted test must read
`product_read(...).submission_id` and use that exact integer — never 0, never
a string, never a ProductRef string.

### 7.3 `proposal_content_hash` must be exact

- Must match `/^[0-9a-f]{64}$/` (64-char lowercase hex SHA-256).
- Must equal the Proposal ProductRef `digest` byte-for-byte.
- The gate recomputes the proposal's `content_hash` from its stored
  `payload_snapshot` and compares (check-providers.ts:94-104).

A common bug: hashing the JSON *string* of the content rather than the parsed
canonical form. The factory stores `payload_snapshot` as a JSON string; the
gate reads `proposal.content_hash` directly from the row, so the script just
passes through the ProductRef `digest`.

### 7.4 Source-ref grounding (P1-1)

Every dimension's `source_refs` must be non-empty AND every entry must be in
the allowed set computed from the Proposal (check-providers.ts:112-122):

```js
allowedRefs = [
  '$.problem_statement', '$.observed_context',
  '$.stakeholders_or_actors', '$.assumptions', '$.unknowns',
  '$.risks', '$.candidate_scope', '$.evidence_refs',
  '$.recommended_outcome', '$.rationale',
  // plus every literal string in evidence_refs:
  'CONVEYOR-MENTAL-MODEL.md §16', 'factory-contract harness',
];
```

Invalid refs that look plausible but are rejected:
- `$.stakeholders_or_actors[0]` — the allowed ref is the field path, not an
  indexed JSONPath.
- `the proposal` / `context` — explicitly rejected as vague
  (discovery-readiness-assessment.ts:134-139).
- An evidence ref NOT present in `Proposal.evidence_refs` — invention.

### 7.5 Unknown dimension keys

`dimension_assessments` must contain EXACTLY the 7 required dimensions
(`READINESS_DIMENSIONS`, discovery-readiness-assessment.ts:59-67). Adding
`market_fit` or omitting `evidence_grounding` fails the gate
(discovery-readiness-assessment.ts:241-245).

### 7.6 Gap-code uniqueness

Codes must be unique within `blocking_gaps`, unique within
`non_blocking_gaps`, AND not appear in both lists
(discovery-readiness-assessment.ts:282-294). The golden path uses empty
arrays, which trivially satisfies this.

### 7.7 `confidence` range

Must be a finite number in `[0, 1]` (discovery-readiness-assessment.ts:199-204).
`NaN`, `Infinity`, negative, or >1 values fail. Additionally, the settlement
policy requires `>= 0.70` for the GO path — submitting `confidence: 0.5`
(the template default) passes the gate but routes to `clarify` at settlement.

### 7.8 `recommended_outcome` ≠ `'go'` in the proposal

If the worker submits `recommended_outcome: 'clarify'`, the settlement policy
short-circuits to `CLARIFY_WORKER_REQUESTED` (settlement-policy.ts:327-331)
regardless of the readiness assessment. The ProcessRun will end in
`local_outcome: 'clarify'`, not `'go'`.

### 7.9 Readiness advisor editing the Proposal

The skill explicitly forbids this
(`saga-discovery-readiness-advisor/SKILL.md:62-71`). The scripted test never
calls `product_submit` with the proposal schema from the readiness scenario.
If it did, the second submission would be a separate product (typed
submissions are immutable and append-only), but the readiness gate reads the
`produce-proposal` node's LATEST accepted submission — so a stale
`proposal_id` / `proposal_content_hash` would fail the binding check.

### 7.10 Worker calling `worker_done` without `product_submit`

If a scenario handler exits without calling `product_submit`, the worker
process still exits 0, but the Production Cell reconciler finds no product
to seal into a CandidateSet. The workplace is marked crashed/failed; after
`maxAttempts: 2` it pauses with `verdict: 'human_required'`. The
`actions.exitWithoutDone()` helper (`scenario-engine.mjs:253-257`) simulates
this for crash-recovery tests.

### 7.11 Worker calling `product_submit` twice

`submitForCurrentExecution` is idempotent on `(execution_id, schema)` — the
second call returns the same `submission_id` with `replayed: true`
(products.ts:77-78). The worker should still call `worker_done` exactly once.

### 7.12 Scenario key mismatch → `SCENARIO_NOT_FOUND`

If the installed module version differs from the scenario map key (e.g.
module registered as `product-discovery@3.0.3` but scenarios keyed on
`@3.0.2`), the dispatcher throws `SCENARIO_NOT_FOUND` and the worker exits 1
(scenario-engine.mjs:172-174). The dispatcher also supports wildcard role
(`${module}/${node}/${role}/*`) and a global `*` fallback, but the golden
path uses exact keys.

### 7.13 Missing `execution_id` in `worker_done`

`worker_done` requires `execution_id` as a fencing token
(scenario-engine.mjs:241-245). The scripted executor sets `SAGA_EXECUTION_ID`
in the worker env (scenario-scripted-executor.mjs:265), and the prompt
includes `execution_id=<id>` (scenario-scripted-executor.mjs:278). A scenario
that omits it from the `worker_done` call will hit a fencing error.

### 7.14 Settlement handler cannot find upstream productions

The settlement kernel handler reads `ctx.frame.productions['produce-proposal']`
and `ctx.input` (the `assess-readiness` manifest). If either is missing — e.g.
because the cell was paused/failed rather than accepted — the handler throws
`DISCOVERY_PROPOSAL_CELL_OUTPUT_MISSING` and routes to `complete-failed`
(production-cell-installation.ts:69, 163-174).

### 7.15 Content-hash drift on replay

The settlement handler recomputes `sha256Hex(JSON.parse(payload_snapshot))`
and compares to the stored `content_hash` (production-cell-installation.ts:224).
If a future migration changes canonical JSON serialization, replays of old
runs would fail with `DISCOVERY_PRODUCT_HASH_MISMATCH`. The scripted test
always submits fresh content per run, so this is not an issue for the golden
path — but it is the reason Run B in the golden-path test re-runs the
workers (via capsule replay) rather than synthesizing products from memory.

---

## 8. End-to-End Assertions (Golden Path)

After both Discovery scenarios run, the ProcessRun for `product-discovery`
should be (golden-path.test.mjs:181-198):

```sql
SELECT id, module_name, status, local_outcome
  FROM factory_process_runs
 WHERE module_name = 'product-discovery';
-- status='completed', local_outcome='go'
```

The DB should contain:
- 2 rows in `factory_managed_node_submissions` (proposal + readiness).
- 1 row in `factory_proposals` (the proposal projection).
- 1 row in `factory_process_outcome_certificates` (the settlement certificate).
- 2 rows in `factory_workplaces` (one per cell).
- 2 rows in `factory_candidate_sets` (one sealed per cell).
- 2 rows in `factory_gate_decisions` (one per cell gate).
- 2 terminal worker_executions (both `state='exited'`, `exit_code=0`).

The certificate payload's `decision` should be `'go'` with `reasonCodes:
['GO_READY_AND_GROUNDED']`.

---

## 9. File Reference (all paths absolute under `D:/Development/saga-mcp/`)

**Module definition**:
- `src/process-modules/modules/discovery/discovery-process-module.ts`
- `src/process-modules/modules/discovery/package/manifest.ts`
- `src/process-modules/modules/discovery/package/index.ts`

**Resources**:
- `src/process-modules/modules/discovery/package/resources/proposal-call-template.json`
- `src/process-modules/modules/discovery/package/resources/readiness-call-template.json`
- `src/process-modules/modules/discovery/package/resources/proposal-checklist.md`
- `src/process-modules/modules/discovery/package/resources/readiness-checklist.md`
- `src/process-modules/modules/discovery/package/resources/proposal-stage-tracker.md`
- `src/process-modules/modules/discovery/package/resources/readiness-stage-tracker.md`
- `src/process-modules/modules/discovery/package/resources/skills/saga-discovery-worker/SKILL.md`
- `src/process-modules/modules/discovery/package/resources/skills/saga-discovery-readiness-advisor/SKILL.md`

**Domain (validators + policy)**:
- `src/modules/discovery/domain/discovery-domain-contracts.ts`
- `src/modules/discovery/domain/discovery-proposal.ts`
- `src/modules/discovery/domain/discovery-readiness-assessment.ts`
- `src/modules/discovery/domain/discovery-settlement-policy.ts`

**Application (gates, handlers)**:
- `src/modules/discovery/application/discovery-check-providers.ts`
- `src/modules/discovery/application/discovery-production-cell-installation.ts`
- `src/modules/discovery/application/discovery-settlement-service.ts`
- `src/modules/discovery/application/discovery-installation.ts` (legacy handlers — NOT used by production-cell flow)

**Process-module runtime**:
- `src/process-modules/application/node-executors/production-cell-node-executor.ts`
- `src/process-modules/application/handlers/process-outcome-emitter.ts`
- `src/process-modules/lifecycles/product-delivery-module-contracts.ts`

**Infrastructure**:
- `src/infrastructure/process-modules/brief-provisioning-ports.ts`
- `src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts`
- `src/tools/products.ts`

**Scenario harness**:
- `tests/factory-contract/scenario-engine.mjs`
- `tests/factory-contract/scenario-dispatcher.mjs`
- `tests/factory-contract/scenario-scripted-executor.mjs`
- `tests/factory-contract/scenario-composition.mjs`
- `tests/factory-contract/golden-path-scenarios.mjs`
- `tests/factory-contract/golden-path.test.mjs`
