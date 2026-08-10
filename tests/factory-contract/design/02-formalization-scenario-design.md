# Formalization Scenario Design — LLM-Free Scripted Test

This document is the complete specification of MCP tool calls for **цех Formalization**
(`solution-formalization@1.0.0`), the second stage of the Product Delivery conveyor
(Discovery → **Formalization** → Development → Delivery). It is written so a
scripted test double (no LLM) can drive every formalization node to the green
terminal outcome `formalized`.

Every claim below is backed by quoted code. File paths are absolute under
`D:/Development/saga-mcp/`.

---

## 1. Node Graph (the Flow)

### 1.1 Flow identity

From `src/process-modules/modules/formalization/formalization-process-module.ts`
(lines 137-274):

- `flow.id = 'factory.formalization.standard'`
- `flow.version = '2.0.0'`
- `entryNodeId = 'define-product-contract'`

The module identity is `solution-formalization@1.0.0`
(`FORMALIZATION_PROCESS_MODULE_REF` in
`src/process-modules/lifecycles/product-delivery-module-contracts.ts:35-38`).

### 1.2 The 7 main nodes in execution order

```
define-product-contract        (production-cell)  → PRD + FR/NFR/RULE + brief
        │ domain.accepted
        ▼
model-use-cases                (production-cell)  → UC-*
        │ domain.accepted
        ▼
define-acceptance-contract     (production-cell)  → AC-*
        │ domain.accepted
        ▼
reconcile-what                 (production-cell)  → typed reconciliation report
        │ domain.accepted
        ▼
freeze-acceptance-baseline     (kernel)           → frozen AC baseline snapshot
        │ domain.frozen          │ domain.drift-detected → complete-inconsistent
        ▼
define-architecture-contract   (production-cell)  → SRS (the HOW contract)
        │ domain.accepted
        ▼
settle-formalization           (kernel)           → Solution Contract certificate
        │ domain.formalized | domain.clarification-required
        │ domain.inconsistent | domain.infeasible | domain.failed
        ▼
complete-formalized | complete-clarification-required
complete-inconsistent | complete-infeasible | complete-failed
```

Plus 5 terminal outcome-emitter nodes (`complete-formalized`,
`complete-clarification-required`, `complete-inconsistent`, `complete-infeasible`,
`complete-failed`) — each is `kind: 'kernel'`, `handler: 'process-outcome-emitter'`,
and just emits its outcome code.

### 1.3 Transitions (full table from formalization-process-module.ts:250-269)

| From | To | On event |
|------|-----|----------|
| `define-product-contract` | `model-use-cases` | `domain.accepted` |
| `define-product-contract` | `complete-failed` | `domain.failed` |
| `model-use-cases` | `define-acceptance-contract` | `domain.accepted` |
| `model-use-cases` | `complete-failed` | `domain.failed` |
| `define-acceptance-contract` | `reconcile-what` | `domain.accepted` |
| `define-acceptance-contract` | `complete-failed` | `domain.failed` |
| `reconcile-what` | `freeze-acceptance-baseline` | `domain.accepted` |
| `reconcile-what` | `complete-failed` | `domain.failed` |
| `freeze-acceptance-baseline` | `define-architecture-contract` | `domain.frozen` |
| `freeze-acceptance-baseline` | `complete-inconsistent` | `domain.drift-detected` |
| `freeze-acceptance-baseline` | `complete-failed` | `domain.failed` |
| `define-architecture-contract` | `settle-formalization` | `domain.accepted` |
| `define-architecture-contract` | `complete-failed` | `domain.failed` |
| `settle-formalization` | `complete-formalized` | `domain.formalized` |
| `settle-formalization` | `complete-clarification-required` | `domain.clarification-required` |
| `settle-formalization` | `complete-inconsistent` | `domain.inconsistent` |
| `settle-formalization` | `complete-infeasible` | `domain.infeasible` |
| `settle-formalization` | `complete-failed` | `domain.failed` |

Note: the formalization flow no longer has separate `resolve-*` resolver nodes
in the Flow graph. The Flow has 7 functional nodes. The `FORMALIZATION_HANDLER_IDS`
(`resolveProduct`, `resolveUseCases`, etc.) are **kernel handler ids** wired into
the production cells' `postAcceptanceEffect`/gate path, not separate Flow nodes.
The Flow's two explicit kernel nodes are `freeze-acceptance-baseline`
(handler `formalization-baseline-freezer`) and `settle-formalization`
(handler `formalization-settlement-policy`).

### 1.4 Outcomes (formalization-process-module.ts:130-136)

| Code | Terminal | Meaning |
|------|----------|---------|
| `formalized` | yes | Complete frozen solution contract ready |
| `clarification-required` | yes | Required product/acceptance info missing |
| `inconsistent` | yes | Contract graph has unresolved contradictions/gaps |
| `infeasible` | yes | Requested solution cannot be implemented under constraints |
| `failed` | yes | Infrastructure could not produce authoritative result |

### 1.5 Production cell shape (the `reviewedCell` factory, lines 82-110)

Every author LM node is a **reviewed Production Cell** with:
- `cardinality: '1'` (one workplace)
- `maxAttempts: 5` (`FORMALIZATION_RECOVERY_MAX_ATTEMPTS`, line 48 — "allow four repair rounds before human escalation")
- `onExhausted: 'pause'`
- author gate = `buildCheckPlan` over the node-specific CheckProvider
- `postAcceptanceEffect: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID` (projects draft→accepted)
- review phase with `verdictSchemaRef: FACTORY_REVIEW_VERDICT_SCHEMA` and a final gate
- `acceptedTransition`: the transition fired on `domain.accepted`

The `productSource` differs:
- all cells use `'managed-production'` (default) EXCEPT `reconcile-what`, which
  uses `'typed-submission'` (line 201) because the reconciler publishes a typed
  reconciliation report rather than writing artifacts.

---

## 2. Per-Node Tool Call Sequence

Every formalization author worker executes the same overall pattern:
`task_get` → read upstream accepted artifacts → `artifact_create` (file-first) →
`trace_add` → `worker_done`. The reviewer worker pattern is:
`task_get` → `candidate_read` → `product_submit` (review verdict) → `worker_done`.

The scenario key format used by the test harness
(`tests/factory-contract/scenario-engine.mjs:113-132`) is:

```
scenarioKeyString = `${module}/${node}/${role}/${workKey}`
```

For formalization the module is `solution-formalization@1.0.0`, the nodes are
the 5 LM nodes, roles are `author`/`reviewer`, and `workKey` is `singleton`
(non-fan-out cells).

### 2.1 Node: `define-product-contract` (author)

Scenario key: `solution-formalization@1.0.0/define-product-contract/author/singleton`
Execution profile: `formalization-product`, skill `saga-product`.
Allowed artifact types: `PRD`, `FR`, `NFR`, `RULE`, plus supporting types
`brief`, `decision`, `hypothesis`, `business_metric`, `theme`
(`formalization-installation.ts:252-259`,
`assertOnlyTypes` enforced in `createResolveProductHandler`).

Source: `tests/factory-contract/golden-path-scenarios.mjs:107-145` (`formalizationProduct`).

Sequence:
1. `task_get({ id: <taskId> })` — read task to obtain `project_id`, `epic_id`.
2. Write files to disk (file-first discipline):
   - `docs/formalization/BRIEF-1.md`
   - `docs/formalization/PRD.md`
   - `docs/formalization/FR-1.md`
   - `docs/formalization/NFR-1.md`
   - `docs/formalization/RULE-1.md`
3. `artifact_create({ project_id, epic_id, type: 'brief', code: 'BRIEF-1', title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md', status: 'accepted', content_hash: <sha256>, metadata: { brief_payload: { classification: 'product', complexity: { tshirt: 'M', risk_triggers: [] }, decision: 'go', reasoning: '...', affected_projects: [<projectId>], topology_hint: 'sequence', scaffold_artifacts: [], shared_mutation_risk: false, completeness: 'high', degraded: false } } })`
   - The `brief_payload` is **mandatory** when `type:'brief'`
     (`artifact-create-call-template.json` line 25: "Without brief_payload,
     artifact_create is REJECTED"). It must contain `decision`, `reasoning`,
     `affected_projects`, `topology_hint`, `completeness`.
4. `artifact_create({ project_id, epic_id, type: 'PRD', code: 'PRD', title: 'Product Requirements', path: 'docs/formalization/PRD.md', status: 'draft', content_hash: <sha256> })`
5. `artifact_create({ project_id, epic_id, type: 'FR', code: 'FR-1', title: 'Functional Requirement 1', path: 'docs/formalization/FR-1.md', status: 'draft', content_hash: <sha256> })`
6. `artifact_create({ project_id, epic_id, type: 'NFR', code: 'NFR-1', title: 'Non-Functional Requirement 1', path: 'docs/formalization/NFR-1.md', status: 'draft', content_hash: <sha256> })`
7. `artifact_create({ project_id, epic_id, type: 'RULE', code: 'RULE-1', title: 'Business Rule 1', path: 'docs/formalization/RULE-1.md', status: 'draft', content_hash: <sha256> })`
8. `trace_add({ source_id: <prd.id>, target_type: 'artifact', target_id: <brief.id>, link_type: 'derived_from' })`
9. `trace_add({ source_id: <fr.id>, target_type: 'artifact', target_id: <prd.id>, link_type: 'derived_from' })`
10. `worker_done({ task_id, worker_id, execution_id, result: 'formalization product-contract: brief→PRD→FR/NFR/RULE' })`

Trace contract (`findContractGap` in `formalization-installation.ts:1676-1763`,
`required.product` branch):
- Exactly **one** PRD (`categories.prd.length !== 1` → fail).
- At least **one** FR (`categories.frs.length === 0` → fail).
- PRD must have a `derived_from` trace to a root ancestor (brief/decision/discovery-doc — any accepted artifact that is NOT itself PRD/FR/NFR/RULE/UC/AC/SRS). The `brief` artifact satisfies this.
- FR/NFR/RULE do not strictly require their own `derived_from → PRD` trace for `findContractGap` to pass, but the skill and the artifact-create template both say they should have one (best practice + reviewer expectation).

The `ensureBriefRootTrace` helper (`formalization-installation.ts:415-446`)
auto-provisions a `brief → PRD derived_from` trace if the worker did not, via the
`BriefProvisioningPort`. In the scripted scenario we create the brief ourselves
so this auto-provisioning is not exercised.

### 2.2 Node: `define-product-contract` (reviewer)

Scenario key: `solution-formalization@1.0.0/define-product-contract/reviewer/singleton`
Skill: `saga-requirements-reviewer`.
Allowed tools: `task_get, artifact_list, artifact_get, trace_list, note_list,
repository_checkout_list, Read, Glob, Grep, candidate_read, product_read,
product_submit, worker_done` (the `REVIEW_TOOLS` set,
formalization-process-module.ts:59-62).

Sequence (`approvedReview` in `golden-path-scenarios.mjs:214-223`):
1. `task_get({ id: <taskId> })` — read `task.metadata.workplace_ref`.
2. `candidate_read({ workplace_ref: <wpRef>, role: 'author' })` — read the
   exact author CandidateSet. Returns `candidate_set_ref` + `product_refs`.
3. `product_submit({ schema: 'factory.review-verdict.v1', content: { subject_candidate_set_ref: <cand.candidate_set_ref>, verdict: 'approved', findings: [] } })`
4. `worker_done({ task_id, worker_id, execution_id, result: 'review: approved' })`

The reviewer must NOT create artifacts/traces/files
(`review-verdict-call-template.json` line 2:
"As a reviewer, your job is to inspect the exact author CandidateSet, render a
verdict, and call worker_done. Do NOT create artifacts, traces, or files.").

### 2.3 Node: `model-use-cases` (author)

Scenario key: `solution-formalization@1.0.0/model-use-cases/author/singleton`
Execution profile: `formalization-use-cases`, skill `saga-analyst`.
Allowed artifact type: `UC` only (`assertOnlyTypes(writes.artifacts, ['UC'])`,
`createResolveUseCasesHandler` line 567).

The full node protocol lives in
`src/process-modules/modules/formalization/package/nodes/use-case/use-case-node-protocol.ts`
(steps: `load-product-contract` → `author-use-cases` → `link-contract-traces` →
`verify-completeness` → `submit-use-case-bundle`).

Sequence (`formalizationUseCases` in `golden-path-scenarios.mjs:147-161`):
1. `task_get({ id })` — get `project_id`, `epic_id`.
2. `artifact_list({ epic_id, type: 'PRD', status: 'accepted' })` — find accepted PRD.
3. `artifact_list({ epic_id, type: 'FR', status: 'accepted' })` — find accepted FRs.
4. Write `docs/formalization/UC-1.md` to disk.
5. `artifact_create({ project_id, epic_id, type: 'UC', code: 'UC-1', title: 'Use Case 1', path: 'docs/formalization/UC-1.md', status: 'draft', content_hash: <sha256>, parent_artifact_id: <prd.id> })`
   - `parent_artifact_id` is optional but recommended (the use-case-create-call-template.json sets it to the PRD id).
6. `trace_add({ source_id: <uc.id>, target_type: 'artifact', target_id: <prd.id>, link_type: 'derived_from' })`
7. `trace_add({ source_id: <uc.id>, target_type: 'artifact', target_id: <fr.id>, link_type: 'covers' })`
8. `worker_done({ task_id, worker_id, execution_id, result: 'formalization use-cases: UC→PRD+FR' })`

Trace contract (`findContractGap`, `required.useCases` branch, lines 1726-1738):
- At least one UC.
- **Every** UC must have `derived_from → exact PRD` trace.
- **Every** UC must have `covers → exact FR` trace.

### 2.4 Node: `model-use-cases` (reviewer)

Same as 2.2 with scenario key `.../model-use-cases/reviewer/singleton`.

### 2.5 Node: `define-acceptance-contract` (author)

Scenario key: `solution-formalization@1.0.0/define-acceptance-contract/author/singleton`
Execution profile: `formalization-acceptance`, skill `saga-analyst`.
Allowed artifact type: `AC` only (`assertOnlyTypes(writes.artifacts, ['AC'])`,
line 636).

Sequence (`formalizationAcceptance` in `golden-path-scenarios.mjs:163-183`):
1. `task_get({ id })`.
2. `artifact_list({ epic_id, type: 'FR', status: 'accepted' })`.
3. `artifact_list({ epic_id, type: 'NFR', status: 'accepted' })`.
4. `artifact_list({ epic_id, type: 'UC', status: 'accepted' })`.
5. Write `docs/formalization/AC-1.md`, `docs/formalization/AC-2.md`.
6. `artifact_create({ project_id, epic_id, type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes', path: 'docs/formalization/AC-1.md', status: 'draft', content_hash: <sha256> })`
7. `trace_add({ source_id: <ac1.id>, target_type: 'artifact', target_id: <fr.id>, link_type: 'derived_from' })`
8. `trace_add({ source_id: <ac1.id>, target_type: 'artifact', target_id: <uc.id>, link_type: 'derived_from' })`
9. `artifact_create({ project_id, epic_id, type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance', path: 'docs/formalization/AC-2.md', status: 'draft', content_hash: <sha256> })`
10. `trace_add({ source_id: <ac2.id>, target_type: 'artifact', target_id: <nfr.id>, link_type: 'derived_from' })`
11. `worker_done({ task_id, worker_id, execution_id, result: 'formalization acceptance: AC→FR/NFR+UC' })`

Trace contract (`findContractGap`, `required.acceptance` branch, lines 1739-1754):
- At least one AC.
- **Every** AC must have `derived_from → exact FR` **OR** `derived_from → exact NFR`.
- If an AC derives from an FR, it **must also** have `derived_from → exact UC`
  ("FR-derived AC has no derived_from → exact UC trace").

So AC-1 (FR-derived) needs both FR and UC traces; AC-2 (NFR-derived) needs only
the NFR trace. The acceptance validator
(`src/modules/formalization/application/acceptance-contract-validator.ts`) runs
the SAME `findContractGap({ acceptance: true })` at worker_done time — shift-left.

### 2.6 Node: `define-acceptance-contract` (reviewer)

Same as 2.2 with scenario key `.../define-acceptance-contract/reviewer/singleton`.

### 2.7 Node: `reconcile-what` (author)

Scenario key: `solution-formalization@1.0.0/reconcile-what/author/singleton`
Execution profile: `formalization-reconciler`, skill `saga-reconciler`.
**`productSource: 'typed-submission'`** — the only formalization cell that does
NOT use managed-production. The reconciler publishes a typed reconciliation
report, not artifacts.

Allowed tools include `product_submit`
(formalization-process-module.ts:304: `allowedTools: [...COMMON_WRITE_TOOLS, 'product_submit']`).

Sequence (`formalizationReconcile` in `golden-path-scenarios.mjs:185-192`):
1. `task_get({ id })`.
2. (Optionally) `trace_list`, `artifact_list` to inspect the WHAT graph.
3. `product_submit({ schema: 'factory.formalization-reconciliation-report.v1', content: { status: 'reconciled', rationale: 'All artifacts trace correctly.', remaining_gaps: [], repairs: [] } })`
4. `worker_done({ task_id, worker_id, execution_id, result: 'formalization reconciliation: reconciled' })`

The reconciliation product schema
(`reconciliation-product-call-template.json`):
```json
{
  "schema": "factory.formalization-reconciliation-report.v1",
  "content": {
    "status": "reconciled",
    "repairs": [],
    "remaining_gaps": [],
    "rationale": "..."
  }
}
```

A no-op report (`repairs: []`, `remaining_gaps: []`) is valid when the WHAT graph
is already consistent. The reconciler does NOT freeze the baseline.

### 2.8 Node: `reconcile-what` (reviewer)

Same as 2.2 with scenario key `.../reconcile-what/reviewer/singleton`.

### 2.9 Node: `freeze-acceptance-baseline` (kernel — no worker)

This is a **kernel** node (`kind: 'kernel'`,
`handler: formalization-baseline-freezer`). It has NO worker, NO scripted
scenario. The Production Cell executor / lifecycle orchestrator runs it
automatically after `reconcile-what` is accepted.

What it does (`createBaselineFreezer` in
`formalization-production-cell-installation.ts:76-136`):
- Reads accepted AC artifacts via `graph.readAcceptedArtifacts(epicId)`.
- Requires ≥1 accepted AC (else `baselineFailure`).
- Reads baseline hash via `graph.readAcceptanceBaselineHash(epicId)`; if not
  clean → emits `drift-detected`.
- Persists the frozen baseline via `baselineRepository.freeze(...)`.
- Emits `domain.frozen` on success.

The output schema is `factory.acceptance-baseline-snapshot.v1`
(`ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA`).

There is a second baseline-freezer implementation in
`formalization-installation.ts:763-840` (`createBaselineFreezerHandler`) which
is the older resolver-path freezer. It reads from the reconciliation production
rather than epic-wide accepted artifacts. Both produce the same
`ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA` artifact.

### 2.10 Node: `define-architecture-contract` (author — SRS)

Scenario key: `solution-formalization@1.0.0/define-architecture-contract/author/singleton`
Execution profile: `formalization-architect`, skill `saga-architect`.
Allowed artifact type: `SRS` only (`assertOnlyTypes(writes.artifacts, ['SRS'])`,
line 859). The execution profile carries `contractRef: SRS_CONTRACT_REF`
(version 2.2) — the only profile with a pinned contract ref.

Sequence (`formalizationArchitecture` in `golden-path-scenarios.mjs:194-212`):
1. `task_get({ id })`.
2. `artifact_list({ epic_id, type: 'PRD', status: 'accepted' })`.
3. Write the SRS markdown file to `docs/formalization/SRS.md` (content must
   pass §D2 + §12 structural validation — see §5 below).
4. `artifact_create({ project_id, epic_id, type: 'SRS', code: 'SRS', title: 'SRS', path: 'docs/formalization/SRS.md', status: 'draft', content_hash: <sha256 of file content>, project_repository_id: 1 })`
5. `trace_add({ source_id: <srs.id>, target_type: 'artifact', target_id: <prd.id>, link_type: 'derived_from' })`
6. `worker_done({ task_id, worker_id, execution_id, result: 'formalization architecture: SRS→PRD' })`

Trace contract (`findContractGap`, `required.architecture` branch, lines 1755-1761):
- Exactly **one** SRS.
- The SRS must have `derived_from → exact PRD`.

The SRS artifact must be file-backed (the SRS validator reads it from disk).
`content_hash` must equal `sha256(file content)` exactly, else the validator
fails with `FORMALIZATION_SRS_INCOMPLETE` (file-hash-match gap).

### 2.11 Node: `define-architecture-contract` (reviewer)

Scenario key: `solution-formalization@1.0.0/define-architecture-contract/reviewer/singleton`
Skill: `saga-architecture-reviewer` (NOT `saga-requirements-reviewer` — this is
the only node with a different reviewer skill).

Sequence is structurally identical to 2.2 (read candidate, submit
`factory.review-verdict.v1`, worker_done). The reviewer skill is different but
the MCP call sequence is the same.

### 2.12 Node: `settle-formalization` (kernel — no worker)

Kernel node (`handler: formalization-settlement-policy`). No scripted scenario.
Runs automatically after `define-architecture-contract` is accepted.

What it does (`createSettlementHandler` in
`formalization-production-cell-installation.ts:138-242`):
- Reads the FormalizationCase from `ctx.frame.runInput`.
- Reads the frozen baseline from `baselineRepository.readByProcessRun`.
- Reads accepted artifacts via `graph.readAcceptedArtifacts(epicId)`.
- Builds a `SolutionContractBundle`.
- Calls `settlementPolicy.settle(graph, settlementInput)` → decision
  (`formalized`/`clarification-required`/`inconsistent`/`infeasible`/`failed`).
- If `formalized`: builds `FormalizationSolutionContractPayload` (which reads
  SRS §D2 stanzas to derive `implementationRequired` from `ac_kind` and
  `criticality` from §D2), persists it, issues a ProcessOutcomeCertificate.
- Emits the decision as the domain event.

Output schema: `factory.solution-contract-certificate.v1`.

---

## 3. Production Cell Mechanics

### 3.1 The author → CandidateSet → Gate → Reviewer loop

From `src/process-modules/application/node-executors/production-cell-node-executor.ts`
(the `reconcile` method, lines 359-605):

1. **Materialize workplace**: `asWorkplaceRef({ processRunId, moduleRef, productionCellId, workKey })`.
   For formalization all cells are singleton (`workKey: 'singleton'`).
2. **Admit work**: `coordinator.admitWork(workplace.ref)` — workplace enters `queued` state.
3. **Project role task**: `ensureRoleProjection` creates an execution intent + task
   with `taskKind`, `executionSkill`, `metadata.workplace_ref`,
   `metadata.production_cell_id`, `metadata.role`, `metadata.cell_input_item`.
4. **Worker claims** the task (via `worker_next` outside the scenario — the
   scenario dispatcher is launched by the scripted executor).
5. **Worker runs** the scripted MCP calls, then calls `worker_done`.
6. **Executor reads products**: `productReader.readExecutionProducts(...)` with
   `requireTypedSubmission` = (role is reviewer OR cell has a typed-submission contract).
   - For 4 author cells (product, use-cases, acceptance, architecture):
     `requireTypedSubmission = false` (managed-production — products are read from
     the managed artifact/trace productions table, not from `product_submit`).
   - For the reconciler author cell: `requireTypedSubmission = true`.
   - For all reviewer cells: `requireTypedSubmission = true`.
7. **Seal CandidateSet**: `candidateSetRepo.seal(...)` with the produced ProductRefs
   as members.
8. **Run author gate**: `driveGateRun(gateRepo, checkProviders, ...)` over the
   author check plan. For formalization this is the submission-validator check
   provider that wraps the per-node validator (see §4).
9. **Apply gate decision**:
   - `accepted` → if the cell has a review phase, workplace moves to reviewer
     `queued`; the author CandidateSet becomes the subject for review.
   - `repair_required` → workplace moves to `repair_wait`, then requeues the
     author role (subject to `maxAttempts`).
10. **Reviewer runs** (if applicable): same flow — `product_submit(review-verdict)`,
    `worker_done`, seal reviewer CandidateSet.
11. **Run final gate**: `driveGateRun` over `cell.review.finalGate` with the
    author CandidateSet as subject and the reviewer CandidateSet as assessment.
    The final gate uses the `REVIEW_VERDICT_CHECK_PROVIDER`.
12. **Apply reviewer verdict**:
    - `accepted` → `postAcceptanceEffect` runs (`FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID`),
      which flips the produced artifacts from `draft` → `accepted` (CAS-guarded
      on content_hash). Then the node emits `domain.accepted`.
    - `changes_requested` → back to author `repair_wait`.

### 3.2 productSource per node

| Node | productSource | What the worker produces |
|------|--------------|--------------------------|
| `define-product-contract` | `managed-production` | brief + PRD + FR/NFR/RULE artifacts + traces |
| `model-use-cases` | `managed-production` | UC artifacts + traces |
| `define-acceptance-contract` | `managed-production` | AC artifacts + traces |
| `reconcile-what` | `typed-submission` | typed reconciliation product via `product_submit` |
| `define-architecture-contract` | `managed-production` | SRS artifact + trace |

`managed-production` means the products are derived from the
`factory_managed_artifact_productions` / `factory_managed_trace_productions`
ledger rows written by the `artifact_create` / `trace_add` MCP handlers. The
worker does NOT call `product_submit` for these cells.

`typed-submission` means the worker MUST call `product_submit` with the schema
`factory.formalization-reconciliation-report.v1`.

### 3.3 Post-acceptance effect (artifact flip)

`src/modules/formalization/application/formalization-accept-products-effect.ts`:
`FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID = 'formalization.accept-exact-products.v1'`.

On accepted GateDecision, it runs (lines 41-99):
```sql
SELECT artifact_id, content_hash FROM factory_managed_artifact_productions
 WHERE process_run_id=? AND execution_id=?
   AND id IN (SELECT MAX(id) FROM ... GROUP BY artifact_id)
```
Then for each produced artifact:
- Verify `artifact.content_hash === produced.content_hash` (no drift).
- `UPDATE artifacts SET status='accepted', accepted_hash=?, drift_state='clean'`.
- CAS-guarded: `WHERE id=? AND content_hash=?` (fails if content changed).

This is why the scripted worker creates artifacts as `status: 'draft'` — the
effect promotes them. The `brief` artifact is the exception: the golden-path
scenario creates it with `status: 'accepted'` directly (it is the root ancestor,
not a node product).

---

## 4. Gate Validation (per node)

### 4.1 Check provider wiring

`src/modules/formalization/application/formalization-check-providers.ts` registers
5 submission-validator check providers, one per author node:

| Node | validatorId | validator | required dimensions |
|------|------------|-----------|---------------------|
| `define-product-contract` | `formalization.product-contract.v1` | `createFormalizationContractValidator` | `{ product: true }` |
| `model-use-cases` | `formalization.use-cases.v1` | `createFormalizationContractValidator` | `{ product: true, useCases: true }` |
| `define-acceptance-contract` | `formalization.acceptance-contract.v1` | `createAcceptanceContractValidator` | `{ product, useCases, acceptance }` |
| `reconcile-what` | `formalization.reconciliation.v1` | `createFormalizationContractValidator` | `{ product, useCases, acceptance }` |
| `define-architecture-contract` | `formalization.srs-contract.v1` | `createSrsContractValidator` | SRS contract v2.2 |

`FORMALIZATION_CHECK_REFS` (lines 20-52) pins each with `requireManagedProduction`
(true for all except reconciliation, which is `typed-submission`).

### 4.2 The generic formalization contract validator

`src/modules/formalization/application/formalization-contract-validator.ts`:
reads all `factory_managed_artifact_productions` for the process run, builds a
`ContractSnapshot` via `buildContractSnapshot`, runs `findContractGap(snapshot, required)`.

Reject codes:
- `FORMALIZATION_CONTRACT_INCOMPLETE` — traceability gap (missing edge).
- Gap string format: "UC <id> has no derived_from → exact PRD trace",
  "AC <id> has no derived_from → exact FR/NFR trace", etc.

### 4.3 The acceptance contract validator

`src/modules/formalization/application/acceptance-contract-validator.ts`:
specialized for AC. Runs `findContractGap({ product: true, useCases: true, acceptance: true })`.
Reject code: `FORMALIZATION_ACCEPTANCE_INCOMPLETE`.

### 4.4 The SRS contract validator (most complex)

`src/modules/formalization/application/srs-contract-validator.ts`. Checks
(line 25-34 docstring):
1. SRS artifact exists for the process run (else `FORMALIZATION_SRS_MISSING`).
2. SRS → PRD `derived_from` trace exists.
3. Repository binding exists; SRS file exists on disk.
4. `sha256(file content) === artifact.content_hash` (byte-level integrity).
5. §12 Decision Log section exists with ≥ required columns.
6. §D2 stanzas exist; each has every required field; enum fields valid.
7. criticality present and valid in every §D2 stanza.
8. `contractRef`: if caller pins a version, it must match `SRS_CONTRACT_REF` v2.2
   (else `SRS_CONTRACT_VERSION_MISMATCH`).
9. Every frozen AC code appears exactly once in §D2; no extra codes.

Reject codes: `FORMALIZATION_SRS_MISSING`, `FORMALIZATION_SRS_INCOMPLETE`,
`SRS_CONTRACT_VERSION_MISMATCH`.

### 4.5 The reviewer final gate

Uses `REVIEW_VERDICT_CHECK_PROVIDER` (from
`src/process-modules/application/review-verdict-check-provider.ts`) over schema
`factory.review-verdict.v1`. The reviewer's `product_submit` verdict is consumed
here. `repairTargetRoleOnFailure: 'author'`, `repairTargetRoleOnIndeterminate: 'reviewer'`
(formalization-process-module.ts:77-78).

### 4.6 SRS structural check provider (gate-side)

`src/modules/formalization/application/srs-structural-check-provider.ts`:
`SRS_STRUCTURAL_CHECK_PROVIDER_ID = 'formalization.srs-structural.v1'`. Runs the
SAME §D2 + §12 structural checks inside the GateRun after CandidateSet sealing.
Used by `buildArchitectureCheckPlan()`.

---

## 5. SRS D.2 Parser (the strict YAML format)

### 5.1 The canonical contract

`src/modules/formalization/domain/srs-contract.ts` (version 2.2):

```js
SRS_CONTRACT = {
  version: '2.2',
  requiredSections: [
    '§2.1 Architectural Style', '§2.2 Module Manifest',
    '§2.3 Invariant Registry', '§2.5 Test Strategy',
    '§7 Glossary', '§9 Technology Stack',
    '§D Decomposition', '§12 Decision Log',
  ],
  d2RequiredFields: [
    'ac', 'title', 'module', 'files', 'invariants',
    'test_layers', 'pattern', 'depends_on', 'ac_kind', 'criticality',
  ],
  d2EnumFields: {
    ac_kind: ['implementation', 'verification'],
    pattern: ['A', 'B'],
    criticality: ['blocker', 'degradable', 'nice_to_have'],
  },
  decisionLogColumns: ['#', 'Decision', 'Source/profile',
    'Alternatives considered', 'Rationale', 'Date'],
  decisionLogPolicy: 'semantic-coverage-no-numeric-minimum',
}
```

### 5.2 Parser rules (`src/modules/formalization/application/srs-d2-parser.ts`)

The parser is **strict**: exactly one `§D2 AC Map/Decomposition` heading
followed by exactly one fenced `yaml` block. The heading regex (line 36):
```js
const CANONICAL_HEADING = /^(#{2,4})\s*§D\.?2\b[^\n]*(?:AC\s*(?:Map|Mapping)|Decomposition)[^\n]*$/gim;
```
The YAML block regex (line 37):
```js
const YAML_BLOCK = /```(?:yaml|yml)\s*\r?\n([\s\S]*?)```/gi;
```

Stanza format (each starts with `- ac:`):
```yaml
- ac: AC-1
  title: Exact frozen AC title
  module: core
  files: [src/core.ts]
  invariants: [INV-1]
  test_layers: [L0]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
```

Field-line regex (line 139):
```js
const field = rawLine.match(/^\s{2,}([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/i);
```
So fields must be indented ≥2 spaces under the `- ac:` line. Inline YAML lists
(`[a, b]`) are accepted as scalar strings and not parsed further.

### 5.3 Valid SRS content for the scripted scenario

From `golden-path-scenarios.mjs:200` (`formalizationArchitecture`):

```markdown
# SRS

## §D2 Acceptance Criteria Decomposition

```yaml
- ac: AC-1
  title: Pipeline Completes
  module: src/factory-contract
  files: ['src/factory-contract/']
  invariants: ['Factory reaches terminal']
  test_layers: ['e2e']
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
- ac: AC-2
  title: NFR Compliance
  module: src/factory-contract
  files: ['src/factory-contract/']
  invariants: ['Deterministic']
  test_layers: ['contract']
  pattern: B
  depends_on: []
  ac_kind: implementation
  criticality: degradable
```

## §12 Decision Log

| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|---------------|------------------------|-----------|------|
| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-08 |
```

Critical requirements for this to pass:
- The §D2 heading must contain "D2" (or "D.2") AND ("AC Map"/"AC Mapping"/"Decomposition").
- Exactly one fenced YAML block under that heading.
- One stanza per frozen AC code (AC-1, AC-2) — codes must match the frozen
  baseline exactly, no more, no less.
- Each stanza has all 10 required fields with valid enum values.
- §12 Decision Log heading + either a markdown table with ≥6 columns OR
  `### Decision N` subsections.

### 5.4 What the parser rejects

- Markdown tables in §D2 (only fenced YAML).
- `D.2 AC-2` subsection headings (not the canonical section).
- Mixing YAML with another representation.
- Missing required fields, empty required fields.
- Invalid enum values (e.g. `pattern: C`, `ac_kind: spike`).
- Duplicate `ac:` codes or duplicate fields within a stanza.
- Malformed YAML lines.

---

## 6. Artifact Tree After Formalization

After all 5 author nodes + 2 kernel nodes complete, the formalization epic holds:

```
brief (BRIEF-1)              [accepted, root ancestor — created by product node]
  └── PRD (PRD)              [accepted]
       ├── FR (FR-1)         [accepted]
       │    └── UC (UC-1)    [accepted]  (UC covers FR, derives from PRD)
       │         └── AC (AC-1) [accepted, FR-derived → needs FR + UC traces]
       ├── NFR (NFR-1)       [accepted]
       │    └── AC (AC-2)    [accepted, NFR-derived → needs only NFR trace]
       └── RULE (RULE-1)     [accepted]
            └── SRS (SRS)    [accepted, derived_from PRD]
                            (§D2 decomposes AC-1 + AC-2)
```

### Trace edges (canonical, enforced by `buildContractSnapshot`):

| Source | Target | link_type | Enforced by |
|--------|--------|-----------|-------------|
| PRD | brief | `derived_from` | product gate (root ancestor) |
| FR | PRD | `derived_from` | product gate (best practice) |
| NFR | PRD | `derived_from` | product gate (best practice) |
| RULE | PRD | `derived_from` | product gate (best practice) |
| UC | PRD | `derived_from` | useCases gate (required) |
| UC | FR | `covers` | useCases gate (required) |
| AC (FR-derived) | FR | `derived_from` | acceptance gate (required) |
| AC (FR-derived) | UC | `derived_from` | acceptance gate (required) |
| AC (NFR-derived) | NFR | `derived_from` | acceptance gate (required) |
| SRS | PRD | `derived_from` | architecture gate (required) |

`buildContractSnapshot` (formalization-installation.ts:1581-1621) only keeps
traces that match these exact (sourceType, linkType, targetType) patterns;
other traces are filtered out of the contract digest.

### Durable product artifacts (kernel-issued, not worker-authored):

- `acceptance-baseline-snapshot` (schema `factory.acceptance-baseline-snapshot.v1`)
  — frozen by `freeze-acceptance-baseline`. Contains `acArtifactIds`,
  `acArtifactHashes`, `baselineHash`.
- `solution-contract-certificate` (schema `factory.solution-contract-certificate.v1`)
  — issued by `settle-formalization`. Contains the full `SolutionContractBundle`
  + per-AC `implementationRequired` + `criticality` derived from SRS §D2.

---

## 7. Scripted Scenario Fragment (complete for all formalization nodes)

This is the JS for the scenario map, mirroring
`tests/factory-contract/golden-path-scenarios.mjs`. The scenario key format is
`${module}/${node}/${role}/${workKey}`.

```js
import { actions } from './scenario-engine.mjs';

const FRM = 'solution-formalization@1.0.0';

// --- Node 1: define-product-contract (author) ---
const formalizationProduct = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;

  // brief_payload is MANDATORY for type='brief'
  const briefPayload = {
    classification: 'product',
    complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go',
    reasoning: 'Feasible and bounded.',
    affected_projects: [projectId],
    topology_hint: 'sequence',
    scaffold_artifacts: [],
    shared_mutation_risk: false,
    completeness: 'high',
    degraded: false,
  };
  const briefHash = actions.contentHash('brief:BRIEF-1');
  if (repoPath) actions.writeFile(repoPath, 'docs/formalization/BRIEF-1.md', '# Product Brief\n');

  const brief = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted', content_hash: briefHash,
    metadata: { brief_payload: briefPayload },
  });

  const prd = await actions.createArtifact(client, {
    projectId, epicId, type: 'PRD', code: 'PRD',
    title: 'Product Requirements',
    artifactPath: 'docs/formalization/PRD.md', repoPath,
  });
  const fr = await actions.createArtifact(client, {
    projectId, epicId, type: 'FR', code: 'FR-1',
    title: 'Functional Requirement 1',
    artifactPath: 'docs/formalization/FR-1.md', repoPath,
  });
  await actions.createArtifact(client, {
    projectId, epicId, type: 'NFR', code: 'NFR-1',
    title: 'Non-Functional Requirement 1',
    artifactPath: 'docs/formalization/NFR-1.md', repoPath,
  });
  await actions.createArtifact(client, {
    projectId, epicId, type: 'RULE', code: 'RULE-1',
    title: 'Business Rule 1',
    artifactPath: 'docs/formalization/RULE-1.md', repoPath,
  });

  await actions.addTrace(client, prd.id, brief.id, 'derived_from');
  await actions.addTrace(client, fr.id, prd.id, 'derived_from');

  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'formalization product-contract: brief→PRD→FR/NFR/RULE');
};

// --- Node 2: model-use-cases (author) ---
const formalizationUseCases = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const prds = await actions.findAcceptedArtifacts(client, epicId, 'PRD');
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  if (!prds.length || !frs.length) throw new Error('No accepted PRD/FR for use-cases');

  const uc = await actions.createArtifact(client, {
    projectId, epicId, type: 'UC', code: 'UC-1', title: 'Use Case 1',
    artifactPath: 'docs/formalization/UC-1.md', repoPath,
  });
  await actions.addTrace(client, uc.id, prds[0].id, 'derived_from');
  await actions.addTrace(client, uc.id, frs[0].id, 'covers');

  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'formalization use-cases: UC→PRD+FR');
};

// --- Node 3: define-acceptance-contract (author) ---
const formalizationAcceptance = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  const nfrs = await actions.findAcceptedArtifacts(client, epicId, 'NFR');
  const ucs = await actions.findAcceptedArtifacts(client, epicId, 'UC');
  if (!frs.length) throw new Error('No accepted FR for acceptance');

  // AC-1: FR-derived → needs BOTH FR and UC traces
  const ac1 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-1',
    title: 'AC-1: Pipeline Completes',
    artifactPath: 'docs/formalization/AC-1.md', repoPath,
  });
  await actions.addTrace(client, ac1.id, frs[0].id, 'derived_from');
  if (ucs.length) await actions.addTrace(client, ac1.id, ucs[0].id, 'derived_from');

  // AC-2: NFR-derived → needs only NFR trace
  const ac2 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-2',
    title: 'AC-2: NFR Compliance',
    artifactPath: 'docs/formalization/AC-2.md', repoPath,
  });
  if (nfrs.length) await actions.addTrace(client, ac2.id, nfrs[0].id, 'derived_from');

  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'formalization acceptance: AC→FR/NFR+UC');
};

// --- Node 4: reconcile-what (author, typed-submission) ---
const formalizationReconcile = async ({ client, prompt }) => {
  await actions.submitProduct(client, 'factory.formalization-reconciliation-report.v1', {
    status: 'reconciled',
    rationale: 'All artifacts trace correctly.',
    remaining_gaps: [],
    repairs: [],
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'formalization reconciliation: reconciled');
};

// --- Node 5: define-architecture-contract (author, SRS) ---
const formalizationArchitecture = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const prds = await actions.findAcceptedArtifacts(client, epicId, 'PRD');
  if (!prds.length) throw new Error('No accepted PRD for architecture');

  // The SRS MUST contain §D2 (one fenced YAML block) + §12 Decision Log.
  // §D2 must list every frozen AC code exactly once.
  const srsContent = [
    '# SRS',
    '',
    '## §D2 Acceptance Criteria Decomposition',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: Pipeline Completes',
    '  module: src/factory-contract',
    '  files: ["src/factory-contract/"]',
    '  invariants: ["Factory reaches terminal"]',
    '  test_layers: ["e2e"]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '- ac: AC-2',
    '  title: NFR Compliance',
    '  module: src/factory-contract',
    '  files: ["src/factory-contract/"]',
    '  invariants: ["Deterministic"]',
    '  test_layers: ["contract"]',
    '  pattern: B',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: degradable',
    '```',
    '',
    '## §12 Decision Log',
    '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|---------------|------------------------|-----------|------|',
    '| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-08 |',
  ].join('\n');

  const srsPath = 'docs/formalization/SRS.md';
  actions.writeFile(repoPath, srsPath, srsContent);
  const fileHash = actions.contentHash(srsContent);

  const srs = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS',
    title: 'SRS', path: srsPath, status: 'draft',
    content_hash: fileHash, project_repository_id: 1,
  });
  await actions.addTrace(client, srs.id, prds[0].id, 'derived_from');

  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'formalization architecture: SRS→PRD');
};

// --- Reviewer (shared by all 5 nodes) ---
const approvedReview = async ({ client, task, prompt }) => {
  const meta = typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
  const wpRef = meta.workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  await actions.submitProduct(client, 'factory.review-verdict.v1', {
    verdict: 'approved',
    findings: [],
    subject_candidate_set_ref: cand.candidate_set_ref,
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id,
    prompt.execution_id, 'review: approved');
};

export const formalizationScenarios = {
  // Authors
  [`${FRM}/define-product-contract/author/singleton`]: formalizationProduct,
  [`${FRM}/model-use-cases/author/singleton`]: formalizationUseCases,
  [`${FRM}/define-acceptance-contract/author/singleton`]: formalizationAcceptance,
  [`${FRM}/reconcile-what/author/singleton`]: formalizationReconcile,
  [`${FRM}/define-architecture-contract/author/singleton`]: formalizationArchitecture,
  // Reviewers (note: architecture uses saga-architecture-reviewer skill, but
  // the MCP call sequence is identical)
  [`${FRM}/define-product-contract/reviewer/singleton`]: approvedReview,
  [`${FRM}/model-use-cases/reviewer/singleton`]: approvedReview,
  [`${FRM}/define-acceptance-contract/reviewer/singleton`]: approvedReview,
  [`${FRM}/reconcile-what/reviewer/singleton`]: approvedReview,
  [`${FRM}/define-architecture-contract/reviewer/singleton`]: approvedReview,
};
```

### Scenario key matching

The engine (`scenario-engine.mjs:167-170`) matches:
1. Exact key: `${module}/${node}/${role}/${workKey}`
2. Wildcard workKey: `${module}/${node}/${role}/*`
3. Global fallback: `*`

For formalization all cells are singleton, so exact keys suffice. The engine
reads `task.metadata` to derive the key
(`scenarioKey`, lines 113-125): `process_module_ref`, `process_node_id`,
`role`, `work_key` (or `cell_input_item.key`).

### MCP client contract

The scripted worker uses a stdio MCP client (`McpClient` in scenario-engine.mjs:35-104):
- `client.callJson(name, args)` → sends `tools/call`, parses the first text
  content as JSON.
- `client.call(name, args)` → returns raw content array.
- 30s timeout per call.

---

## 8. Known Failure Modes

### 8.1 Recovery exhaustion (`maxAttempts: 5`)

`FORMALIZATION_RECOVERY_MAX_ATTEMPTS = 5` (formalization-process-module.ts:48).
Comment: "allow four repair rounds before human escalation". When the author or
reviewer gate rejects a CandidateSet, the workplace enters `repair_wait` and is
requeued. After 5 sealed CandidateSets (or terminal executions, per the crash
recovery fallback in `attemptCount`, production-cell-node-executor.ts:971-997),
`onExhausted: 'pause'` fires → workplace goes to `paused`/`human_required`.

The test harness must ensure the golden path never triggers repair_wait.

### 8.2 `FORMALIZATION_SRS_INCOMPLETE`

The most common SRS failure. Reject code from `srs-contract-validator.ts:382`.
Triggered by ANY of:
- SRS → PRD `derived_from` trace missing.
- Repository binding missing / file not on disk.
- `sha256(file) !== artifact.content_hash`.
- §12 Decision Log missing or < 6 columns.
- §D2 missing required fields, invalid enums, duplicate ACs.
- Frozen AC code missing from §D2 (or extra code present).
- §D2 representation wrong (table, subsections, no fenced YAML).

### 8.3 `FORMALIZATION_SRS_MISSING`

Reject code from `srs-contract-validator.ts:142`. No SRS artifact produced for
the process run. The resolver path emits `clarification-required`
(createResolveArchitectureHandler, line 852-857).

### 8.4 `SRS_CONTRACT_VERSION_MISMATCH`

Reject code from `srs-contract-validator.ts:105`. The architect execution
profile pins `contractRef: SRS_CONTRACT_REF` (v2.2). If the validator is built
against a different version/digest, the submission is rejected as a config error
(NOT `changes_requested`).

### 8.5 `FORMALIZATION_CONTRACT_INCOMPLETE`

From `formalization-contract-validator.ts:67`. Traceability gaps in the
product/useCases/reconciliation dimensions. Gap examples:
- "contract must contain exactly one PRD"
- "contract must contain at least one FR"
- "PRD <id> has no derived_from → root artifact (brief/decision/discovery-doc) trace"
- "UC <id> has no derived_from → exact PRD trace"
- "UC <id> has no covers → exact FR trace"

### 8.6 `FORMALIZATION_ACCEPTANCE_INCOMPLETE`

From `acceptance-contract-validator.ts:182`. AC traceability gaps:
- "AC <id> has no derived_from → exact FR/NFR trace"
- "FR-derived AC <id> has no derived_from → exact UC trace"

### 8.7 Baseline drift (`domain.drift-detected`)

The `freeze-acceptance-baseline` kernel node reads the frozen AC set. If any AC
is not accepted+clean, or if its content_hash differs from the reconciliation
production's hash, the freezer emits `drift-detected` → terminal
`complete-inconsistent`. This cannot happen in the golden path (ACs are accepted
by the post-acceptance effect before the freezer runs), but a test that mutates
an AC after acceptance would trigger it.

### 8.8 Settlement failures

`settle-formalization` can emit `clarification-required`, `inconsistent`,
`infeasible`, or `failed`. Causes:
- `clarification-required`: SRS missing or no canonical SRS produced.
- `inconsistent`: `findContractGap` returns a gap after architecture.
- `failed`: exception in the handler (e.g. baseline missing, FormalizationCase invalid).

### 8.9 Artifact-not-accepted at settlement

`createSettlementHandler` (production-cell-installation.ts:285-287) requires
every artifact in the bundle to be `accepted+clean`. The
`formalization-accept-products-effect` runs per-cell after gate acceptance, so
by settlement time all products must be accepted. If the effect failed silently
(it doesn't — it throws), settlement would throw "solution contract artifact
set is incomplete".

### 8.10 Duplicate artifact codes

`artifact_create` is an upsert by `(epic, type, code)` (per the
`artifact-create-call-template.json` PRE_CALL_INSTRUCTION). Creating the same
code twice in different executions of the same node updates the existing draft
rather than creating a duplicate. BUT creating a different code creates an
unwanted duplicate. The scripted scenario uses stable codes (`PRD`, `FR-1`,
`UC-1`, `AC-1`, `SRS`) — never execution-specific codes.

### 8.11 File-first discipline

The checklist (`formalization-node-checklist.md:56-59`) and the SRS validator
require every artifact to have a physical file written to disk BEFORE
`artifact_create`. If `content_hash` is NULL after create, the file was not
found — the worker must STOP and Write the file first. The scripted scenario
uses `actions.writeFile` before `artifact_create` / `actions.createArtifact`
(`actions.createArtifact` in scenario-engine.mjs:206-220 does this).

---

## 9. Test Harness Integration Notes

### 9.1 The scripted executor

`tests/factory-contract/scenario-scripted-executor.mjs` substitutes for the real
LLM executor. It:
1. Provisions a per-task git worktree (`RepositoryDeskProvisioner`) for
   `git_change` tasks. Formalization tasks are `tracker_only` so no worktree.
2. Spawns the scenario dispatcher (`scenario-dispatcher.mjs`) with an MCP config
   pointing at `dist/index.js` (the saga CLI as stdio MCP server).
3. The dispatcher reads the task, computes the scenario key, runs the handler.
4. On child exit, `finalizeManagedWorkerProcess` interprets the outcome
   (semantic completion via the real production finalizer).

### 9.2 The scenario engine

`tests/factory-contract/scenario-engine.mjs` provides:
- `McpClient` — stdio JSON-RPC client.
- `scenarioKey(task)` / `scenarioKeyString(key)` — derive the scenario key from
  task metadata.
- `runScenarioWorker({ mcpConfigPath, prompt, scenarios, ... })` — the main loop.
- `actions` — composable helpers: `submitProduct`, `createArtifact`, `addTrace`,
  `findAcceptedArtifacts`, `readAuthorCandidate`, `done`, `writeFile`,
  `contentHash`.

### 9.3 The scenario map

Export a map keyed by scenario key string → handler function. The engine matches
exact, then wildcard role, then global fallback. See the `formalizationScenarios`
export in §7.

### 9.4 Database / repo setup

The golden-path test (`golden-path.test.mjs`) creates a temp git repo, registers
it as a project repository, builds a lifecycle input, and calls
`requestFactoryLaunch`. The factory then drives Discovery → Formalization →
Development → Delivery, dispatching scripted workers per node.

The `project_repository_id` for the SRS artifact must match the registered repo
(so the validator can find `local_path` and read the SRS file). In the golden
path this is `1`.

---

## 10. Quick Reference — Schema IDs

| Schema ID | Used by |
|-----------|---------|
| `factory.formalization-case.v1` | FormalizationCase input |
| `factory.formalization-product-bundle.v1` | Product cell output |
| `factory.formalization-use-case-bundle.v1` | Use-case cell output |
| `factory.formalization-acceptance-bundle.v1` | Acceptance cell output |
| `factory.formalization-reconciliation-report.v1` | Reconciliation typed product |
| `factory.acceptance-baseline-snapshot.v1` | Frozen baseline |
| `factory.formalization-architecture-bundle.v1` | Architecture cell output |
| `factory.srs.v1` | SRS artifact schema |
| `factory.solution-contract-certificate.v1` | Settlement output |
| `factory.review-verdict.v1` | Reviewer verdict |
| `factory.solution-contract-certificate.generic.v1` | Certificate payload schemaVersion |

## 11. Quick Reference — Handler IDs

| Handler ID | Node | Purpose |
|-----------|------|---------|
| `formalization-resolve-product-contract` | (gate) | Resolve product writes |
| `formalization-resolve-use-cases` | (gate) | Resolve UC writes |
| `formalization-resolve-acceptance-contract` | (gate) | Resolve AC writes |
| `formalization-resolve-reconciliation` | (gate) | Resolve reconciliation |
| `formalization-baseline-freezer` | `freeze-acceptance-baseline` | Freeze AC baseline |
| `formalization-resolve-architecture-contract` | (gate) | Resolve SRS writes |
| `formalization-settlement-policy` | `settle-formalization` | Issue Solution Contract |

Note: only `formalization-baseline-freezer` and `formalization-settlement-policy`
are Flow node handlers. The five `resolve-*` handler ids are registered kernel
handlers called from the production-cell post-acceptance path (via
`FORMALIZATION_KERNEL_HANDLER_IDS` in
`formalization-production-cell-installation.ts:52-55`, and the full set in
`formalization-installation.ts:93-101`).
