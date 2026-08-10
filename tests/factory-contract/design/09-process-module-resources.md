# 09 — Process Module Resources, Templates, Trackers, Checklists

Exhaustive map of every resource file the four Saga Factory process modules
(discovery, formalization, development, delivery) pin, what it is, who reads
it, and how a scripted worker turns it into an MCP call.

Source of truth (paths absolute):
- `D:/Development/saga-mcp/src/process-modules/modules/<module>/<module>-process-module.ts` — module definition
- `D:/Development/saga-mcp/src/process-modules/modules/<module>/package/manifest.ts` — pinned resource index
- `D:/Development/saga-mcp/src/process-modules/lifecycles/product-delivery-module-contracts.ts` — module identity refs

---

## 1. Module Catalog

The factory ships four canonical process modules plus two Development
continuation packages. Each module is a `ProcessModuleDefinition`
(see `src/process-modules/domain/process-module.ts`) — pure canonical data:
identity, input/output contracts, outcomes, flow graph, artifacts, policies,
invariants and execution profiles. Identity refs are owned by the lifecycle
(`product-delivery-module-contracts.ts`), not the module files, so a
Lifecycle Scenario references only durable contracts.

| Module | identity.name | version | entry node | terminal outcomes |
|---|---|---|---|---|
| Product Discovery | `product-discovery` | `3.0.2` | `produce-proposal` | go, clarify, reject, defer, inconclusive, failed |
| Solution Formalization | `solution-formalization` | `1.0.0` | `define-product-contract` | formalized, clarification-required, inconsistent, infeasible, failed |
| Solution Development | `solution-development` | `1.1.0` | `plan-task-graph` | verified, rework-required, clarification-required, blocked, failed |
| Solution Development (Managed Continuation) | `solution-development-managed` | `1.1.0` | `resolve-task-graph` | (same as Development) |
| Solution Development (Verification Continuation) | `solution-development-verification-continuation` | `1.0.0` | `adopt-verification-baseline` | (same as Development) |
| Delivery and Release | `delivery-release` | `1.0.0` | `preflight-release` | released, approval-required, blocked, failed |

### 1.1 Discovery (`product-discovery@3.0.2`)

Two cognitive desks (Production Cells) plus a kernel settlement. There is no
planner/normalization mini-orchestrator in this Flow — the legacy
diagnosis/normalization trackers and call templates still ship as resources
(see §2) but are not wired by `discovery-process-module.ts`.

Nodes:
| node_id | kind | description |
|---|---|---|
| `produce-proposal` | production-cell | Investigate the bounded subject; submit one canonical `DiscoveryProposal`. |
| `assess-readiness` | production-cell | Read the exact accepted Proposal ProductRef; submit one source-bound readiness assessment. |
| `settle` | kernel | Apply pinned deterministic policy; issue immutable outcome certificate. |
| `complete-{go\|clarify\|reject\|defer\|inconclusive\|failed}` | kernel | Outcome emitters (runtime-owned `process-outcome-emitter`). |

Flow transitions (entry `produce-proposal`):
```
produce-proposal --domain.accepted-->  assess-readiness
produce-proposal --domain.failed----->  complete-failed
assess-readiness --domain.accepted-->  settle
assess-readiness --domain.failed----->  complete-failed
settle           --domain.{go|clarify|reject|defer|inconclusive|failed}--> complete-<code>
```

Execution profiles (2):
| profile id | skill | executionMode | maxAttempts | allowedTools (summary) |
|---|---|---|---|---|
| `discovery-proposal-worker` | `saga-discovery-worker` | `tracker_only` | 2 | `task_get`, `product_submit`, `worker_done`, `Write/Read/Edit/Bash/Glob/Grep`, `repository_checkout_list`, `artifact_list`, `note_list` |
| `discovery-readiness-advisor` | `saga-discovery-readiness-advisor` | `tracker_only` | 2 | `task_get`, `product_read`, `product_submit`, `worker_done`, `Read/Edit` |

Both profiles pin `artifactAcceptanceAuthority: 'kernel-gate'`, `protocolSkill: 'saga-process-module-worker-protocol'`, recovery policy `resumeFromCheckpoint + reuseWorkIntent + reuseAcceptedOutput + onExhausted:'pause'`. Product source is `typed-submission` (the worker calls `product_submit`; the kernel materializes the immutable product).

### 1.2 Formalization (`solution-formalization@1.0.0`)

Five reviewed Production Cells (author + reviewer) interleaved with two kernel
nodes (baseline freeze + settlement). Every cognitive desk is a universal
Production Cell: structural/domain validation is a package CheckProvider in the
author gate; independent semantic review is a reviewer desk whose immutable
verdict is consumed by the final gate. There are no LM/resolver pairs and no
FlowRecovery machine.

Nodes (entry `define-product-contract`):
| node_id | kind | reviewer profile | description |
|---|---|---|---|
| `define-product-contract` | production-cell | `formalization-requirements-reviewer` | Produce PRD + FR/NFR/RULE artifacts; root lineage. |
| `model-use-cases` | production-cell | `formalization-requirements-reviewer` | Produce accepted UCs covering the FRs. |
| `define-acceptance-contract` | production-cell | `formalization-requirements-reviewer` | Produce ACs derived from UC/FR/NFR. |
| `reconcile-what` | production-cell | `formalization-requirements-reviewer` | Repair WHAT-traceability gaps; submit explicit reconciliation report (no-op allowed). |
| `freeze-acceptance-baseline` | kernel | — | Freeze exact accepted AC ids/hashes after reconciliation. |
| `define-architecture-contract` | production-cell | `formalization-architecture-reviewer` | Produce SRS/HOW contract against frozen AC baseline; SRS owns §D2 decomposition metadata; frozen ACs are never mutated. |
| `settle-formalization` | kernel | — | Derive Development bindings from accepted SRS §D2; issue Solution Contract certificate. |
| `complete-{formalized\|clarification-required\|inconsistent\|infeasible\|failed}` | kernel | — | Outcome emitters. |

Transitions: `define-product-contract` → `model-use-cases` → `define-acceptance-contract` → `reconcile-what` → `freeze-acceptance-baseline` → `define-architecture-contract` → `settle-formalization` → `complete-<outcome>`. `freeze-acceptance-baseline` may also route to `complete-inconsistent` on `domain.drift-detected`.

Execution profiles (7):
| profile id | role | skill | tracker | callTemplates |
|---|---|---|---|---|
| `formalization-product` | author | `saga-product` | `process-module-stage-tracker.md` | artifact-create, trace-add, worker-done |
| `formalization-use-cases` | author | `saga-analyst` | `process-module-stage-tracker.md` | artifact-create, trace-add, worker-done (plus use-case-specific templates under `nodes/use-case/resources/`) |
| `formalization-acceptance` | author | `saga-analyst` | `process-module-stage-tracker.md` | artifact-create, trace-add, worker-done |
| `formalization-reconciler` | author | `saga-reconciler` | `process-module-stage-tracker.md` | artifact-create, trace-add, worker-done, reconciliation-product |
| `formalization-architect` | author | `saga-architect` | `process-module-stage-tracker.md` | artifact-create, trace-add, worker-done |
| `formalization-requirements-reviewer` | reviewer | `saga-requirements-reviewer` | `formalization-reviewer-tracker.md` | review-verdict, worker-done |
| `formalization-architecture-reviewer` | reviewer | `saga-architecture-reviewer` | `formalization-reviewer-tracker.md` | review-verdict, worker-done |

Common author tools (`COMMON_WRITE_TOOLS`): `task_get`, `artifact_list`, `artifact_get`, `trace_list`, `note_list`, `repository_checkout_list`, `Read`, `Glob`, `Grep`, `artifact_create`, `artifact_update`, `trace_add`, `trace_delete`, `worker_done`, `Write`, `Edit`, `Bash`. Reviewer tools (`REVIEW_TOOLS`): read-only common tools plus `candidate_read`, `product_read`, `product_submit`, `worker_done`. Reviewers never create artifacts/traces/files.

Author retry budget: `FORMALIZATION_RECOVERY_MAX_ATTEMPTS = 5` (initial CandidateSet plus four repair rounds before human escalation). Reviewer verdict gate may route `repairTargetRoleOnFailure: 'author'` or `repairTargetRoleOnIndeterminate: 'reviewer'`.

### 1.3 Development (`solution-development@1.1.0`)

Plans, implements, reviews, integrates, freezes and verifies one exact release
candidate. Two Production Cells (planning + implementation/review fan-out) plus
verification fan-out, with three kernel nodes (resolve task graph, freeze
candidate, settle).

Nodes (entry `plan-task-graph`):
| node_id | kind | description |
|---|---|---|
| `plan-task-graph` | production-cell (singleton) | Typed planner submits one implementation/verification graph; gate validates lineage, coverage, DAG semantics. |
| `resolve-task-graph` | kernel | Canonicalize the accepted proposal; materialize projected work idempotently. |
| `implement-work-items` | production-cell (fan-out) | Fan out implementation items through universal Workplace author/review/gate/repair loop. Reviewer verdict gate. Post-acceptance effect: `git-integration`. |
| `freeze-integrated-candidate` | kernel | Observe integration branches; persist one immutable content-addressed candidate. |
| `verify-acceptance` | production-cell (fan-out) | Independent acceptance verification over the exact frozen candidate. |
| `settle-development` | kernel | Re-read accepted Cell products + frozen candidate; issue Development certificate. |
| `complete-{verified\|rework-required\|clarification-required\|blocked\|failed}` | kernel | Outcome emitters. |

Fan-out cells use a `materialization` block (not singleton): `inputSelectors`, `workKeySelector`, `dependencySelector`, `completionPolicy: 'all'`, plus `taskProvenance.sourceArtifactIdsSelector`/`verificationTargetArtifactIdSelector`. Implementation items carry `capabilityPreset: 'sandbox-code-author'`/`'sandbox-code-reviewer'`; verification items use `'sandbox-verifier'`.

Execution profiles (4):
| profile id | skill | executionMode | taskKind | allowedTools (additions over COMMON_READ_TOOLS) |
|---|---|---|---|---|
| `development-task-graph-planner` | `saga-planner` (`reviewSkill: saga-planning-reviewer`) | `tracker_only` | `planning.decomposition` | `conflict_check`, `product_submit`, `worker_done`, `Write/Edit/Bash` |
| `development-implementation-worker` | `saga-worker` | `git_change` | `development.code` | `worker_done`, `worker_merge_acquire/release`, `verification_record`, `product_submit`, `Write/Edit/Bash` |
| `development-implementation-reviewer` | `saga-worker` | `tracker_only` | `development.code.review` | (same as implementation worker) |
| `development-verification-worker` | `saga-worker` | `tracker_only` | `verification.ac` | (same as implementation worker) |

Planner maxAttempts=2; implementation/review/verification maxAttempts=2. Retry triggers: `schema-rejected`/`lineage-gap` (planner), `review-rejected`/`merge-conflict` (implementation), `review-rejected` (reviewer), `evidence-rejected` (verification).

Continuation packages:
- `solution-development-managed@1.1.0` (`development-continuation-process-module.ts`) — keeps the universal Production Cell grammar but swaps `git_change` author for `artifact_change` (`development-managed-source-author` skill), text-only `SourceChangeCandidate` product, Factory-owned Git effects. Reviewer becomes `development-managed-source-reviewer`. The planner is removed; entry is `resolve-task-graph`.
- `solution-development-verification-continuation@1.0.0` (`development-verification-continuation-process-module.ts`) — incident-independent suffix for an already-accepted integrated candidate. No production/Git mutation node; entry is `adopt-verification-baseline`.

### 1.4 Delivery (`delivery-release@1.0.0`)

Five-node flow, all kernel or human — Delivery has **zero execution profiles**
(`executionProfiles: []`) and hires no LLM workers. Effects are deterministic
external-system calls through injected providers. Resources pinned under
`delivery/package/resources/` are node instructions/checklists consumed by the
kernel handlers, not by hired workers.

Nodes (entry `preflight-release`):
| node_id | kind | handler | description |
|---|---|---|---|
| `preflight-release` | kernel | `DELIVERY_KERNEL_HANDLER_IDS.preflight` | Deterministic release-guard evidence for the exact candidate. |
| `approve-release` | human | `DELIVERY_HUMAN_ADAPTER_IDS.approval` | Authorized decision bound to candidate + preflight + policy. |
| `publish-deploy` | kernel (external) | `DELIVERY_KERNEL_HANDLER_IDS.publishDeploy` | Desired-state actions through explicit providers with deterministic action keys. |
| `observe-release` | kernel (external) | `DELIVERY_KERNEL_HANDLER_IDS.observeRelease` | Authoritative target-state read after every publish/deploy response. |
| `settle-delivery` | kernel | `DELIVERY_KERNEL_HANDLER_IDS.settle` | Validate exact products + candidate immutability; issue ReleaseRecord + DeliveryCertificate. |
| `complete-{released\|approval-required\|blocked\|failed}` | kernel | `process-outcome-emitter` | Outcome emitters. |

Key invariants: `delivery.explicit-operator-authorization`, `delivery.approval-binds-exact-input`, `delivery.no-default-provider`, `delivery.observe-before-retry`, `delivery.push-is-not-release`, `delivery.no-force-or-bypass`, `delivery.candidate-is-immutable`, `delivery.module-does-not-route`.

---

## 2. Resource Inventory

Every resource is pinned in the module's `package/manifest.ts` `resourceIndex`
as a `ResourceIndexEntry` (`logicalId`, repo-root-relative POSIX `path`, `kind`,
`digest`). `digest` is currently the sentinel `PENDING_DIGEST = 'pending@wave-2'`
across all modules — the Wave 2 content-addressed installer replaces it with
the real `sha256Hex` at install time.

Recognized `kind` values (from `domain/spi/resource-index.ts`): `skill`,
`reviewer-skill`, `instruction`, `template`, `mcp-call-template`, `checklist`,
`schema`. Trackers are filed as `kind: 'template'` (the runtime stamps the
binding block at materialization time).

### 2.1 Discovery package — `src/process-modules/modules/discovery/package/resources/`

| Resource file | Type | Purpose | Used by |
|---|---|---|---|
| `discovery-doc-template.md` | template | Skeleton for the human-readable discovery document (Problem/Context/Users/Scope/Assumptions/Unknowns/Risks/Evidence/Recommendation). | `discovery-proposal-worker` (workspaceTemplate) |
| `proposal-call-template.json` | mcp-call-template | Body of the `product_submit` call for `factory.discovery-proposal.v1`. | `discovery-proposal-worker` |
| `proposal-stage-tracker.md` | template (tracker) | 8-step worker program counter. | `discovery-proposal-worker` |
| `proposal-checklist.md` | checklist | Pre-submit field validation. | `discovery-proposal-worker` |
| `readiness-call-template.json` | mcp-call-template | Body of `product_submit` for `factory.discovery-readiness-assessment.v1`. | `discovery-readiness-advisor` |
| `readiness-stage-tracker.md` | template (tracker) | 7-step advisor tracker. | `discovery-readiness-advisor` |
| `readiness-checklist.md` | checklist | 7-dimension validation + exact-Proposal binding. | `discovery-readiness-advisor` |
| `diagnosis-call-template.json` | mcp-call-template | Advisory diagnosis body (legacy/auxiliary; not wired into `discovery-process-module.ts` flow). | diagnosis advisor (legacy) |
| `diagnosis-stage-tracker.md` | template (tracker) | Legacy diagnosis tracker. | diagnosis advisor (legacy) |
| `diagnosis-checklist.md` | checklist | Decision-specific rules, forbidden authority fields. | diagnosis advisor (legacy) |
| `normalization-call-template.json` | mcp-call-template | Legacy normalization submit body. | normalizer (legacy) |
| `normalization-stage-tracker.md` | template (tracker) | Legacy normalization tracker. | normalizer (legacy) |
| `normalization-checklist.md` | checklist | Source-field-map validation. | normalizer (legacy) |
| `stage-tracker.md` | template (tracker) | Legacy 11-step combined tracker (proposal + readiness + diagnosis). | legacy dispatcher |
| `skills/saga-discovery-worker/SKILL.md` | skill | Proposal worker execution skill. | `discovery-proposal-worker` |
| `skills/saga-discovery-readiness-advisor/SKILL.md` | skill | Readiness advisor skill. | `discovery-readiness-advisor` |
| `skills/saga-discovery-normalizer/SKILL.md` | skill | Legacy normalizer skill. | legacy |
| `skills/saga-discovery-diagnosis-advisor/SKILL.md` | skill | Legacy diagnosis advisor skill. | legacy |
| (platform) `skills/saga-process-module-worker-protocol/SKILL.md` | instruction | Shared protocol skill (every module pins this repo-root path; not duplicated into packages). | all profiles |

Manifest also declares nine MCP tool contributions
(`discovery/package/contributions/tool-contributions.ts`): `proposal_submit`,
`normalization_get`, `normalization_submit`, `readiness_get`, `readiness_submit`,
`diagnosis_get`, `diagnosis_submit`, `artifact_create.brief`, `worker_done`.
Each declares `inputContractRef`, `outputContractRef`, `handlerRef`,
`callTemplateRef`, `checklistRef`, `errorHintRef`, `guardBindings`,
`idempotency`, `sideEffect`.

### 2.2 Formalization package — `src/process-modules/modules/formalization/package/resources/`

| Resource file | Type | Purpose | Used by |
|---|---|---|---|
| `artifact-create-call-template.json` | mcp-call-template | `artifact_create` arguments for PRD/FR/NFR/RULE/UC/AC/SRS (with `_TYPE_SPECIFIC_NOTES` per artifact type). | all author profiles |
| `trace-add-call-template.json` | mcp-call-template | `trace_add` arguments (`derived_from`, `covers`, etc.) with sidecar provenance. | all author profiles |
| `worker-done-call-template.json` | mcp-call-template | `worker_done` arguments + completion assertions. | all profiles |
| `review-verdict-call-template.json` | mcp-call-template | `product_submit(factory.review-verdict.v1)` for reviewer verdicts. | both reviewer profiles |
| `reconciliation-product-call-template.json` | mcp-call-template | `product_submit(factory.formalization-reconciliation-report.v1)`. | `formalization-reconciler` |
| `process-module-stage-tracker.md` | template (tracker) | 11-step author tracker with artifact/trace/error registers. | all author profiles |
| `formalization-reviewer-tracker.md` | template (tracker) | 6-step reviewer tracker; forbids artifact/trace/file creation. | both reviewer profiles |
| `formalization-node-checklist.md` | checklist | Author pre-submit validation (binding, ownership, artifact quality, traceability, file-first discipline). | all author profiles |
| `formalization-reviewer-checklist.md` | checklist | Reviewer pre-verdict validation. | both reviewer profiles |
| `skills/saga-product/SKILL.md` | skill | PRD author skill. | `formalization-product` |
| `skills/saga-analyst/SKILL.md` | skill | UC/AC author skill. | `formalization-use-cases`, `formalization-acceptance` |
| `skills/saga-reconciler/SKILL.md` | skill | Reconciliation skill. | `formalization-reconciler` |
| `skills/saga-architect/SKILL.md` | skill | SRS author skill. | `formalization-architect` |
| `skills/saga-requirements-reviewer/SKILL.md` | reviewer-skill | Requirements review skill. | `formalization-requirements-reviewer` |
| `skills/saga-architecture-reviewer/SKILL.md` | reviewer-skill | Architecture review skill + `security-axes.md` companion. | `formalization-architecture-reviewer` |
| `skills/saga-architecture-reviewer/security-axes.md` | instruction | Security review axes companion. | architecture reviewer |
| (platform) `skills/saga-process-module-worker-protocol/SKILL.md` | instruction | Shared protocol skill. | all profiles |

Use-case node-local resources (pinned by `nodes/use-case/use-case-node-protocol.ts`):

| Resource file | Type | Purpose |
|---|---|---|
| `nodes/use-case/resources/use-case-skill.md` | instruction | Package-local use-case authoring fragment. |
| `nodes/use-case/resources/use-case-create-call-template.json` | mcp-call-template | Specialized `artifact_create` for UC (metadata pinned to `node_id: model-use-cases`). |
| `nodes/use-case/resources/use-case-derived-from-prd-call-template.json` | mcp-call-template | `trace_add` UC→PRD `derived_from`. |
| `nodes/use-case/resources/use-case-covers-fr-call-template.json` | mcp-call-template | `trace_add` UC→FR `covers`. |
| `nodes/use-case/resources/use-case-checklist.md` | checklist | UC-specific 8-item checklist. |

Architecture-lane resources (pinned by `nodes/architecture/architecture-resources.ts`):
re-uses the package-root `artifact-create`/`trace-add`/`worker-done` templates
plus `formalization-node-checklist.md` and `process-module-stage-tracker.md`,
declared against logical ids `formalization.architecture.*`. No separate
architecture-specific call template files exist — the architecture lane
re-uses the shared formalization templates.

### 2.3 Development package — `src/process-modules/modules/development/package/resources/`

| Resource file | Type | Purpose | Used by |
|---|---|---|---|
| `task-graph-submit-call-template.json` | mcp-call-template | `product_submit(factory.development-task-graph-proposal.v1)` body. | `development-task-graph-planner` |
| `task-graph-planner-checklist.md` | checklist | Planner pre-submit validation (DAG, coverage, closed dependencies). | `development-task-graph-planner` |
| `process-module-stage-tracker.md` | template (tracker) | 10-step planner tracker. | `development-task-graph-planner` |
| `implementation-task-tracker.md` | template (tracker) | 9-step implementation/review/verification tracker (git_change mode). | `development-implementation-worker`, `-reviewer`, `-verifier` |
| `implementation-worker-checklist.md` | checklist | Implementation worker pre-done validation (merge lock, exact commit, reviewer verdict binding). | implementation profiles |
| `skills/saga-planner/SKILL.md` | skill | Planner skill. | `development-task-graph-planner` |
| `skills/saga-planning-reviewer/SKILL.md` | reviewer-skill | Planning review skill. | `development-task-graph-planner.reviewSkill` |
| `skills/saga-worker/SKILL.md` | skill | Universal implementation/review/verification worker skill. | all three implementation profiles |
| `skills/saga-development-code-reviewer/SKILL.md` | reviewer-skill | Code review skill fragment. | implementation review |
| (platform) `skills/saga-process-module-worker-protocol/SKILL.md` | instruction | Shared protocol skill. | all profiles |
| (platform) `skills/saga-verifier/SKILL.md` | reviewer-skill | Verifier skill. | verification |

Managed-source continuation resources (`resources/managed-source/`):

| Resource file | Type | Purpose |
|---|---|---|
| `managed-source/managed-source-tracker.md` | template (tracker) | Author tracker for `artifact_change` mode. |
| `managed-source/managed-source-checklist.md` | checklist | Text-only change manifest validation (baseCommit, changeScopes, no .git/traversal/binary). |
| `managed-source/managed-review-tracker.md` | template (tracker) | Reviewer tracker for managed source. |
| `managed-source/managed-review-checklist.md` | checklist | Combined-tree review validation. |
| `managed-source/skills/saga-managed-source-author/SKILL.md` | skill | Text author skill. |
| `managed-source/skills/saga-managed-source-reviewer/SKILL.md` | skill | Text reviewer skill. |

Implementation profiles carry **empty `callTemplates`** (`callTemplates: []`)
— the worker's terminal MCP calls (`worker_merge_acquire`, `worker_merge_release`,
`verification_record`, `product_submit`, `worker_done`) are not templated as
JSON files; the skill markdown (`saga-worker/SKILL.md`) and checklist describe
their arguments inline. Only the planner has a JSON call template.

### 2.4 Delivery package — `src/process-modules/modules/delivery/package/resources/`

Delivery has no hired workers and no execution profiles. These resources are
pinned by `delivery/package/nodes/delivery-node-protocols.ts` and consumed by
the kernel/human handlers, not by LMs.

| Resource file | Type | Purpose | Pinned as logical id |
|---|---|---|---|
| `preflight-release-instructions.md` | instruction | Deterministic release-guard evidence assembly rules. | `delivery.instruction.preflight-release` |
| `preflight-release-checklist.md` | checklist | Guard-set checklist (10 items blocking `domain.ready`). | `delivery.checklist.preflight-release` |
| `approve-release-instructions.md` | instruction | Authorized-decision interaction rules. | `delivery.instruction.approve-release` |
| `publish-deploy-instructions.md` | instruction | Desired-state action application rules (no force-push, deterministic action keys). | `delivery.instruction.publish-deploy` |
| `observe-release-instructions.md` | instruction | Authoritative target-state observation rules. | `delivery.instruction.observe-release` |
| `settle-delivery-instructions.md` | instruction | Exact-product + immutability settlement rules. | `delivery.instruction.settle-delivery` |
| `delivery-error-hints.md` | instruction | Reason-code → recovery-route catalog. | `delivery.hint.error-catalog` |

Delivery ships zero JSON call templates. Its MCP tool contributions (if/when
declared) would be `delivery_approval_decide`, `delivery_approval_get`,
`delivery_approval_list` — but these are surfaced as MCP tools for external
callers, not as worker templates.

---

## 3. Call Templates — the Script Primitives

Each JSON call template is a **filled-at-runtime MCP call body**. The worker
copies the template into the workspace, replaces every `FILL_*`/`{PLACEHOLDER}`
token with machine-known values, re-reads it, ticks the matching checklist, and
only then invokes the named MCP tool. A scripted worker reproduces this exactly:
fill template → invoke MCP tool → record ProductRef/receipt.

### 3.1 `proposal-call-template.json` (discovery)

- **MCP tool**: `product_submit`
- **Schema**: `factory.discovery-proposal.v1`
- **Placeholders**:
  - `FILL_FROM_DISCOVERY_DOC_PROBLEM_SECTION`, `_CONTEXT_SECTION`, `_CANDIDATE_SCOPE_SECTION`, `_RECOMMENDATION_SECTION` — copied from the filled `discovery-doc-template.md`
  - `FILL_USER_1/2`, `FILL_ASSUMPTION_1`, `FILL_UNKNOWN_1`, `FILL_RISK_1`, `FILL_EVIDENCE_1`
  - `recommended_outcome`: literal enum (default `"go"`)
- **Machine identity is ABSENT from the body** — the server derives ProcessRun/WorkIntent/task/execution from the live fence.
- **Example filled values**: `"problem_statement": "Users cannot export audit logs..."`, `"stakeholders_or_actors": ["compliance-team", "ops-eng"]`, `"recommended_outcome": "go"`.

### 3.2 `readiness-call-template.json` (discovery)

- **MCP tool**: `product_submit`
- **Schema**: `factory.discovery-readiness-assessment.v1`
- **Placeholders**:
  - `proposal_id`: integer from `product_read.submission_id`
  - `FILL_64_CHAR_HEX_FROM_ACCEPTED_PROPOSAL_PRODUCT_REF_DIGEST` — exact digest from the accepted Proposal ProductRef
  - 7 dimension rationale strings (`FILL_NON_EMPTY_RATIONALE_FOR_*`)
  - `blocking_gaps`/`non_blocking_gaps` arrays with `code`/`description`/`source_refs`
  - `overall_readiness`: `ready | conditionally_ready | not_ready | inconclusive`
  - `recommended_next_action`: `proceed_to_settlement | request_clarification | repeat_discovery | defer | reject | manual_review`
  - `confidence`: finite number in `[0,1]`
- **source_refs MUST be** exact Proposal JSON paths (`$.problem_statement`) or evidence refs literally present in `Proposal.evidence_refs`.

### 3.3 `artifact-create-call-template.json` (formalization, universal)

- **MCP tool**: `artifact_create`
- **Arguments**: `project_id`, `epic_id`, `project_repository_id`, `type`, `title`, `path`, `code`, `status`, `parent_artifact_id`, `metadata{process_module_ref, process_run_id, node_id, work_intent_id, task_id, execution_id, input_snapshot_hash}`
- **Placeholders**: all `FILL_INTEGER_MACHINE_BOUND_*`, `FILL_NODE_OWNED_ARTIFACT_TYPE`, `FILL_STABLE_CODE` (must be stable: `PRD`, `FR-1`, `NFR-1`, `RULE-1`, `brief` — NOT execution-specific).
- **Critical embedded instructions**:
  - `_PRE_CALL_INSTRUCTION`: call `artifact_list({project_id, epic_id})` first; if an artifact of this type exists, call `artifact_update` on the EXISTING id (artifact_create is an upsert by `(epic, type, code)`).
  - `_TYPE_SPECIFIC_NOTES`: per-type rules — `brief` requires `metadata.brief_payload`; `PRD/FR/NFR/RULE` require `derived_from → PRD` (except PRD itself which derives from `brief`); `UC` requires `covers → FR`; `AC` requires `derived_from → FR and/or UC`; `SRS` requires `derived_from → PRD` and must contain §12 Decision Log and §D2 stanzas.
  - `_POST_CALL_VERIFY`: re-read via `artifact_list`; `content_hash` must NOT be null (Write the file BEFORE create, otherwise hash is null).

### 3.4 `trace-add-call-template.json` (formalization)

- **MCP tool**: `trace_add`
- **Arguments**: `source_id`, `target_type: "artifact"`, `target_id`, `link_type`
- **`link_type` enum**: `covers | implements | implements_spec | derived_from | depends_on | verified_by | superseded_by`
- **Sidecar provenance**: `call_provenance{process_module_ref, process_run_id, node_id, work_intent_id, task_id, execution_id, input_snapshot_hash}` — the `trace_add` MCP row currently has no metadata column; the file is durable evidence of who materialized the call.

### 3.5 `worker-done-call-template.json` (formalization)

- **MCP tool**: `worker_done`
- **Arguments**: `task_id`, `worker_id`, `execution_id`, `result`
- **Completion assertions** (embedded, not sent to server): `tracker_current_step: 11`, `all_owned_artifacts_read_back: true`, `all_required_traces_read_back: true`, `no_unresolved_FILL_placeholders: true`, `no_unreported_errors: true`.
- **Mandatory instruction**: this file is a validated argument template only. After filling it, invoke the ACTUAL `mcp__saga__worker_done` tool and wait for an accepted `stop:true` receipt. Saving the file does not complete the task.

### 3.6 `review-verdict-call-template.json` (formalization)

- **MCP tool**: `product_submit`
- **Schema**: `factory.review-verdict.v1`
- **Content**: `{subject_candidate_set_ref, verdict, findings}`
- **`verdict` enum**: `approved` (author accepted) | `changes_requested` (author must fix; each finding needs `severity: error|warning`, `message`, `subjectRef`)
- **`subject_candidate_set_ref`** MUST equal the exact CandidateSet ref from `candidate_read`.
- **Reviewer constraints** (embedded): do NOT create artifacts, traces, or files. After `product_submit`, call `worker_done` exactly once. No other semantic work.

### 3.7 `reconciliation-product-call-template.json` (formalization)

- **MCP tool**: `product_submit`
- **Schema**: `factory.formalization-reconciliation-report.v1`
- **Content**: `{status: "reconciled", repairs: [], remaining_gaps: [], rationale}` — no-op report is valid (`repairs: []`, `remaining_gaps: []`).

### 3.8 `task-graph-submit-call-template.json` (development)

- **MCP tool**: `product_submit`
- **Schema**: `factory.development-task-graph-proposal.v1`
- **Content shape**:
  ```
  {
    schemaVersion, implementationItems[], verificationItems[], integrationTargets[]
  }
  ```
- **`implementationItems[].fields`**: `key` (stable, e.g. `IMPL-AUTH-001`), `kind: "implementation"`, `taskKind: "development.code"`, `executionSkill: "saga-worker"`, `executionMode: "git_change"`, `projectRepositoryId`, `acceptanceCriterionIds[]`, `dependsOnKeys[]`, `changeScopes[]` (repository ownership scope), `required`, `criticality: "blocker"|"major"|"minor"`.
- **`verificationItems[].fields`**: `key`, `kind: "verification"`, `taskKind: "verification.ac"`, `executionSkill: "saga-verifier"`, `executionMode: "read_only_evidence"`, exactly ONE `acceptanceCriterionIds[]` entry, `dependsOnKeys[]` (the implementation key), empty `changeScopes`.
- **`integrationTargets[].fields`**: `projectRepositoryId`, `sourceWorkItemKeys[]`, `targetBranch` (exact integration branch), `expectedBaseCommit` (exact base).

### 3.9 Use-case-specific templates (formalization, node-local)

Under `formalization/package/nodes/use-case/resources/`:
- `use-case-create-call-template.json` — specialized `artifact_create` with `type: "UC"`, `metadata.node_id: "model-use-cases"`.
- `use-case-derived-from-prd-call-template.json` — `trace_add(UC → PRD, link_type: "derived_from")`.
- `use-case-covers-fr-call-template.json` — `trace_add(UC → FR, link_type: "covers")`.

### 3.10 Legacy discovery templates (not wired by current flow)

- `diagnosis-call-template.json` — `diagnosis_submit` body (`factory.discovery-diagnosis.v1`): `target.certificate_id/hash/settlement_input_hash/decision`, `cause_analysis[]`, `information_requests[]`, `recommended_actions[]`, `residual_risks[]`, `confidence`. Forbidden authority fields: `new_outcome`, `override_decision`, `approved`, `settled`, `transition_stage`, `new_certificate`.
- `normalization-call-template.json` — `normalization_submit` body (`factory.discovery-normalization-proposal.v1`): top-level `control_intent_id`/`source_submission_id`/`execution_id`/`schema_version`, `payload{source_raw_hash, normalized_payload, source_field_map, notes}`.

---

## 4. Tracker Format

Two tracker lineages ship:

### 4.1 Stage trackers (`*-stage-tracker.md`, `process-module-stage-tracker.md`, `implementation-task-tracker.md`)

These are the **external execution frame** for one LM node. The runtime
materializes a copy into the worker's workspace with placeholders filled from
the durable ProcessRun/WorkIntent/task state. The worker reads it before every
action and updates it after every completed step.

Common structure:
1. **Machine-filled binding block** — `process_module_ref`, `process_run_id`, `lifecycle_run_id`, `stage_binding_id`, `node_id`, `work_intent_id`, `project_id`, `epic_id`, `project_repository_id`, `task_id`, `execution_id`, `worker_id`, `input_snapshot_ref`, `input_snapshot_hash`, `output_schema`. Plus `allowed_tools`, `authority_scope`, `authority_enforcement: runtime`. The worker must not add tools, widen scope, or change immutable binding values.
2. **Current node program counter** — `current_step`, `current_action`, `attempt`, `max_attempts`, `checkpoint_status: ready|in_progress|completed|paused|failed`.
3. **Step progress** — numbered Markdown checkboxes (`- [ ] N. <action>`). The worker ticks them (`- [x]`) as it completes each step. Step 1 is always "Read this tracker and `task_get({id: task_id})`; verify the machine binding." The final step is always "Call `worker_done` exactly once and exit."
4. **Artifact register** (formalization) — table of `Role | Artifact type | Artifact id | Code/path | Hash/status | Notes`.
5. **Trace register** (formalization) — table of `From | Relation | To | Recorded | Verified`.
6. **Materialized MCP calls** (formalization) — table of `Call file | Tool | State | Result/ref`.
7. **Durable result** — `product_schema`, `product_ref`, `product_digest` (filled from `product_submit` receipt).
8. **Errors and recovery** — table of `Time | Step | Error/code | Action taken | Resume step`.
9. **Repair rule** — "A rejected CandidateSet never becomes accepted by editing task status. A repair is a new fenced execution in this same Workplace. Reuse accepted context, change only what the GateDecision/feedback identifies, submit a new immutable product."

Placeholders use `{UPPERCASE_WITH_UNDERSCORES}` (e.g. `{PROCESS_RUN_ID}`, `{NODE_ID}`). These are distinct from the `FILL_*` tokens used inside JSON call templates — tracker tokens are filled by the runtime materializer, JSON tokens are filled by the worker.

### 4.2 Protocol-projection trackers (deterministic renderer)

`src/process-modules/application/tracker-renderer.ts` renders a SECOND tracker
format from durable `ProtocolRunRecord` + `ProtocolStepRunRecord[]`. This is a
read-only projection — the worker CANNOT mutate it by editing Markdown. Steps
render in declaration order with FIXED symbol tokens (not checkboxes):

| Symbol | Status |
|---|---|
| `DONE` | `completed` |
| `DOING` | `in_progress` |
| `PENDING` | `pending` |
| `SKIPPED` | `skipped` |
| `FAILED` | `failed` |

Format:
```
# Protocol Tracker — <module.id>@<module.version>

- protocol_run_id: ...
- current_step: ...
- run_status: ...

## Step Progress
> Read-only projection from ProtocolRun state. Do not edit; the runtime advances it.

### [DOING] <step.id> (attempt N) *<-- current*
> <step.instructions verbatim>
- allowed_tools: <comma list>
- resources: <comma list>
- evidence: 2 attached, 1 required (missing: artifact-reference)
```

This format is used by node-protocols that declare `NodeProtocolDefinition`
(use-case node, delivery nodes). The Markdown-checkbox trackers above are used
by execution profiles that pre-date the protocol-runtime wave.

### 4.3 Reviewer tracker (`formalization-reviewer-tracker.md`)

6-step reviewer tracker. Header: "You are a REVIEWER, not an author. Do NOT
create artifacts, traces, or files." Steps: read tracker + task → read
CandidateSet via `candidate_read` → read each product via `product_read` →
evaluate against checklist + domain contract → submit
`factory.review-verdict.v1` → `worker_done` exactly once. Reviewer constraints
block: no artifact/trace/file creation, no editing author's tracker, output is
exactly one verdict product + one `worker_done`.

---

## 5. Checklist Format

Checklists are Markdown files with `- [ ]` items the worker ticks before the
named MCP call. They differ from gates as follows:

| Aspect | Checklist | Gate (CheckProvider) |
|---|---|---|
| Who enforces | The worker (advisory, pre-submit) | The runtime (authoritative, post-submit) |
| When | Before `product_submit`/`worker_done` | Inside the Production Cell `checkPlan` after submission |
| Failure consequence | Worker repairs in place, retries | CandidateSet rejected → repair round or human escalation |
| Content | Field shape, enum membership, placeholder absence, provenance binding | Deterministic schema + lineage + coverage validation via `CheckProvider` |
| Reversibility | Fully reversible (worker just unticks and re-edits) | Creates durable `GateDecision` row; repair consumes an attempt |

Checklist categories observed:
- **Product-shape checklists** (proposal-checklist, readiness-checklist) — validate `schema` string, field types, enum values, no `FILL_` remains.
- **Node checklists** (formalization-node-checklist, use-case-checklist) — validate execution binding, ownership/scope, artifact quality (file-first discipline), traceability, recovery discipline.
- **Reviewer checklists** (formalization-reviewer-checklist, managed-review-checklist) — validate CandidateSet exact binding, verdict quality, no author-side mutations.
- **Planner checklists** (task-graph-planner-checklist) — validate DAG semantics, coverage completeness, integration-target matching.
- **Implementation checklists** (implementation-worker-checklist, managed-source-checklist) — validate claim-via-`worker_next`, AC coverage, merge-lock protocol, exact commit binding.

Every checklist ends with a "Final" or "Recovery" section: "If any check
fails, repair the same file and re-read it. The Production Cell gate performs
the authoritative validation after submission."

---

## 6. Profile Definitions — authorProfile vs reviewerProfile

Formalization defines the canonical split (Development mirrors it for
implementation/review; Discovery has no reviewer desk; Delivery has neither).

### 6.1 authorProfile (formalization factory function)

```typescript
{
  id, workIntentKind, workIntentSchema: {id: `factory.work-intent.<id>.v1`},
  taskKind, executionSkill, reviewSkill: null,
  protocolSkill: 'saga-process-module-worker-protocol',
  semanticSkill: executionSkill,
  artifactAcceptanceAuthority: 'kernel-gate',
  executionMode: 'tracker_only',
  allowedTools: COMMON_WRITE_TOOLS,
  trackerTemplate: 'process-module-stage-tracker.md',
  workspaceTemplates: [artifact-create, trace-add, worker-done, checklist],
  callTemplates: [artifact-create, trace-add, worker-done],
  checklists: ['formalization-node-checklist.md'],
  outputSchema: {id: <bundle schema>},
  retryPolicy: {maxAttempts: 5, retryOn: ['gate-repair'], backoff: 'none'},
  recoveryPolicy: {resumeFromCheckpoint, reuseWorkIntent, reuseAcceptedOutput, onExhausted: 'pause'}
}
```

### 6.2 reviewerProfile (formalization factory function)

```typescript
{
  id, workIntentKind, workIntentSchema,
  taskKind: 'formalization.review',
  executionSkill, reviewSkill: null,
  protocolSkill: 'saga-process-module-worker-protocol',
  semanticSkill: executionSkill,
  artifactAcceptanceAuthority: 'kernel-gate',
  executionMode: 'tracker_only',
  allowedTools: REVIEW_TOOLS,           // READ-ONLY: candidate_read, product_read, product_submit, worker_done
  trackerTemplate: 'formalization-reviewer-tracker.md',
  workspaceTemplates: [review-verdict, worker-done, reviewer-checklist],
  callTemplates: [review-verdict, worker-done],
  checklists: ['formalization-reviewer-checklist.md'],
  outputSchema: {id: 'factory.review-verdict.v1'},
  retryPolicy: {maxAttempts: 5, retryOn: ['gate-repair'], backoff: 'none'},
  recoveryPolicy: {...}
}
```

### 6.3 What differs

| Field | authorProfile | reviewerProfile |
|---|---|---|
| `allowedTools` | `COMMON_WRITE_TOOLS` (artifact_create/update, trace_add/delete, Write/Edit/Bash, worker_done) | `REVIEW_TOOLS` (read-only common + `candidate_read`, `product_read`, `product_submit`, `worker_done`) |
| `callTemplates` | artifact-create, trace-add, worker-done | review-verdict, worker-done |
| `trackerTemplate` | author stage tracker (11 steps) | reviewer tracker (6 steps, forbids author-side work) |
| `checklists` | formalization-node-checklist (file-first discipline) | formalization-reviewer-checklist (CandidateSet exact binding) |
| `outputSchema` | per-node bundle schema (product/use-case/acceptance/reconciliation/architecture) | `factory.review-verdict.v1` |
| `taskKind` | `formalization.product/use-cases/acceptance/reconcile/architecture` | `formalization.review` |
| Can create artifacts | YES | NO |
| Can submit products | via `worker_done` (author gate materializes) | via `product_submit(factory.review-verdict.v1)` |
| `reviewSkill` field | `null` (review is a separate profile) | `null` (the reviewer IS the review skill) |

### 6.4 Skill mapping per role

| Role | executionSkill | semanticSkill | protocolSkill |
|---|---|---|---|
| Discovery proposal worker | `saga-discovery-worker` | `saga-discovery-worker` | `saga-process-module-worker-protocol` |
| Discovery readiness advisor | `saga-discovery-readiness-advisor` | (same) | (same) |
| Formalization product author | `saga-product` | `saga-product` | (same) |
| Formalization use-case author | `saga-analyst` | `saga-analyst` | (same) |
| Formalization reconciler | `saga-reconciler` | `saga-reconciler` | (same) |
| Formalization architect | `saga-architect` | `saga-architect` | (same) |
| Formalization requirements reviewer | `saga-requirements-reviewer` | (same) | (same) |
| Formalization architecture reviewer | `saga-architecture-reviewer` | (same) | (same) |
| Development planner | `saga-planner` (`reviewSkill: saga-planning-reviewer`) | `saga-planner` | (same) |
| Development implementation worker | `saga-worker` | `saga-worker` | (same) |
| Development implementation reviewer | `saga-worker` | `saga-worker` | (same) |
| Development verification worker | `saga-worker` | `saga-worker` | (same) |
| Managed source author | `saga-managed-source-author` | (same) | (same) |
| Managed source reviewer | `saga-managed-source-reviewer` | (same) | (same) |

The `protocolSkill: 'saga-process-module-worker-protocol'` is pinned by EVERY
profile in EVERY module. It is a platform resource at
`skills/saga-process-module-worker-protocol/SKILL.md` — intentionally NOT
duplicated into each package.

---

## 7. Key Insight — The Templates ARE the Script

A scripted worker does not need to infer MCP arguments from skill prose. The
JSON call templates are **literal MCP call bodies with placeholders**. The
scripting algorithm is mechanical:

```
1. worker_next({worker_id, project_id}) → claims a task
2. task_get({id}) → reads task metadata (process_workspace, process_node_input,
   cell_input_item, trusted_provider_bindings)
3. resolveWorkspaceTemplates(profile) → copy each template file into the workspace
4. For each callTemplate in profile.callTemplates:
   a. Read the template JSON
   b. Replace FILL_* tokens with machine-known values from task metadata
      (PROJECT_ID, EPIC_ID, TASK_ID, EXECUTION_ID, WORKER_ID, NODE_ID,
       WORK_INTENT_ID, PROCESS_RUN_ID, INPUT_SNAPSHOT_HASH, etc.)
   c. Replace domain-specific tokens with the worker's product
      (problem_statement, artifact title/code, source_id, target_id, etc.)
   d. Re-read the file; run the matching checklist
   e. Invoke the named MCP tool with the filled arguments
   f. Record the returned ProductRef/artifact_id/trace_id in the tracker
5. worker_done({task_id, worker_id, execution_id, result})
```

The placeholders split into two disjoint sets:
- **Runtime-filled** (`{PROCESS_RUN_ID}`, `{NODE_ID}`, `{TASK_ID}`,
  `{EXECUTION_ID}`, `{WORKER_ID}`, `{INPUT_SNAPSHOT_HASH}`,
  `FILL_INTEGER_MACHINE_BOUND_*`) — the runtime materializer or the script
  reads these from `task_get`/`task.metadata.process_workspace`.
- **Worker-filled** (`FILL_FROM_DISCOVERY_DOC_*`, `FILL_STABLE_CODE`,
  `FILL_NON_EMPTY_RATIONALE_*`, `FILL_EXACT_CANDIDATE_SET_REF`, domain content)
  — these are the worker's actual cognitive output.

A scripted executor (see `tests/factory-contract/scenario-scripted-executor.mjs`)
can fully drive a Production Cell by: (a) materializing the workspace from the
profile's `workspaceTemplates`/`callTemplates`/`checklists`/`trackerTemplate`;
(b) substituting known bindings; (c) substituting scripted domain content; (d)
invoking `product_submit`/`artifact_create`/`trace_add`/`worker_done` via the
real MCP handler containers (`dist/tools/products.js`,
`dist/tools/artifacts.js`, `dist/tools/dispatcher.js`).

**What is NOT scripted**: the kernel nodes. `settle`, `freeze-acceptance-baseline`,
`resolve-task-graph`, `freeze-integrated-candidate`, `settle-development`, and
all Delivery kernel/human nodes run as deterministic TypeScript handlers
registered behind `*_KERNEL_HANDLER_IDS`. A script triggers them by driving the
flow to the `domain.accepted` transition; the handler executes server-side.

### 7.1 Scripting matrix per profile

| Profile | JSON templates available | Scripted calls |
|---|---|---|
| discovery-proposal-worker | proposal-call-template.json | `product_submit` + `worker_done` |
| discovery-readiness-advisor | readiness-call-template.json | `product_read` + `product_submit` + `worker_done` |
| formalization-{product,use-cases,acceptance,architect} | artifact-create, trace-add, worker-done | `artifact_create/update` + `trace_add` + `worker_done` |
| formalization-reconciler | + reconciliation-product | + `product_submit(reconciliation-report)` |
| formalization-{requirements,architecture}-reviewer | review-verdict, worker-done | `candidate_read` + `product_read` + `product_submit(review-verdict)` + `worker_done` |
| development-task-graph-planner | task-graph-submit-call-template.json | `product_submit(task-graph-proposal)` + `worker_done` |
| development-implementation-worker | (none — skill/checklist inline) | `worker_merge_acquire` + `git merge` + `worker_merge_release` + `product_submit(implementation-result)` + `worker_done` |
| development-implementation-reviewer | (none) | `candidate_read` + `product_read` + `product_submit(review-verdict)` + `worker_done` |
| development-verification-worker | (none) | `verification_record` + `product_submit(verification-evidence)` + `worker_done` |
| managed-source-author | (none — checklist only) | `product_submit(source-change-candidate)` + `worker_done` |

The Development implementation/review/verification profiles have **no JSON call
templates** — their terminal MCP calls are documented only in the skill
markdown and checklist. A scripted worker for these profiles must construct
the MCP arguments from the skill's documented contract (e.g.
`factory.development-implementation-result.v1` requires `workItemKey`,
`terminalStatus`, `source{branch,commitSha,workItemKey}`, `snapshot{commitSha,treeSha,files[]}`,
`repository{projectRepositoryId,name,integrationBranch,baseCommit}`,
`buildProducts`, `reasonCodes`).

---

## 8. Resource Pinning — How the Runtime Resolves Files

Each module's `package/manifest.ts` declares a `resourceIndex:
readonly ResourceIndexEntry[]`. Each entry is:

```typescript
{
  logicalId: '<module-namespaced unique id>',
  path: '<repo-root-relative POSIX path>',
  kind: 'skill' | 'reviewer-skill' | 'instruction' | 'template'
        | 'mcp-call-template' | 'checklist' | 'schema',
  digest: 'pending@wave-2'   // replaced by sha256Hex at install time
}
```

Execution profiles reference resources by listing repo-root-relative paths in
`trackerTemplate`, `workspaceTemplates`, `callTemplates`, `checklists`. The
workspace materializer (`application/process-workspace-preparation.ts` +
`pinned-workspace-materializer.ts`) resolves each path against the pinned
installation and copies the file into the worker's execution directory.

Key invariants:
- **No global resource lookup** (Wave 8/9 exit gate §2.2): every resource a
  profile references MUST be declared in the owning module's `resourceIndex`.
  Undeclared resources are a hard failure.
- **No fallback context**: the worker reads ONLY the materialized files. There
  is no implicit skill loading, no platform-default template.
- **Manifest is pure data** (plan §3.5): no functions, no Map/Set, no class
  instances. `validateProcessModuleManifest` runs at module load; structural
  regression throws synchronously and fails the build.
- **`PENDING_DIGEST`** is the documented sentinel across all modules. Real
  content-addressing lands in Wave 2.

### 8.1 Manifest field map

| Field | Type | Purpose |
|---|---|---|
| `manifestFormatVersion` | `'1'` | Envelope version. |
| `definition` | `ProcessModuleDefinition` | The pure module definition (wraps, does not duplicate). |
| `resourceIndex` | `ResourceIndexEntry[]` | Every pinned skill/template/checklist/schema. |
| `handlerRefs` | `HandlerRef[]` | Stable content-addressed references to kernel handlers. |
| `inputContractRef` / `outputContractRef` | `ContractRef` | Schema-id + version + digest. |
| `runtimeCompatibilityRange` | `'^3.0.0'` | saga runtime API range. |
| `assistance` | `AgentAssistanceDefinition[]` | Per-node event-driven prompt blocks. |

### 8.2 Agent Assistance (`package/assistance.ts`)

Each module ships an `assistance.ts` that defines `AgentAssistanceDefinition`
per node. These are event-driven prompt blocks the runtime hydrates:

- **Events**: `step-enter`, `post-tool-success`, `post-tool-error`, `resume`.
- **Block kinds**: `goal`, `current-step`, `next-action`, `retry-instruction`,
  `resource-path`, `allowed-tools`, `completion-criteria`.
- **Placeholders** (runtime-filled): `{NODE_ID}`, `{TRACKER_PATH}`,
  `{CALL_FILES}`, `{CHECKLISTS}`, `{ALLOWED_TOOLS}`.
- **Budgets**: `maxTokensPerBlock: 220`, `maxBlocksPerEvent: 7`,
  `maxRetriesBeforeEscalate: 2`.

The assistance definition is the runtime's instruction channel to the worker —
it complements (does not replace) the tracker and skill files.

---

## 9. File Inventory Summary

Total resource files scanned across the four packages:

| Package | JSON templates | MD trackers | MD checklists | MD instructions | SKILL.md files |
|---|---|---|---|---|---|
| discovery | 4 (proposal, readiness, diagnosis, normalization) | 5 (proposal/readiness/diagnosis/normalization stage + legacy stage) | 4 (proposal/readiness/diagnosis/normalization) | 1 (discovery-doc-template) | 4 (+1 platform) |
| formalization | 7 (artifact-create, trace-add, worker-done, review-verdict, reconciliation, +3 use-case node-local) | 2 (stage, reviewer) | 3 (node, reviewer, use-case) | 1 (use-case-skill) + 1 (security-axes) | 6 (+1 platform) |
| development | 1 (task-graph-submit) | 4 (planner stage, implementation, managed-source, managed-review) | 4 (planner, implementation, managed-source, managed-review) | 0 | 6 (planner, planning-reviewer, worker, code-reviewer, managed-source-author, managed-source-reviewer) (+2 platform: protocol, verifier) |
| delivery | 0 | 0 | 1 (preflight-checklist) | 6 (preflight/approve/publish/observe/settle instructions + error-hints) | 0 |
| **Total** | **12** | **11** | **12** | **9** | **20** |

Every file listed is pinned by exactly one `ResourceIndexEntry` in exactly one
module manifest, referenced by `logicalId` from the execution profile or node
protocol that consumes it.
