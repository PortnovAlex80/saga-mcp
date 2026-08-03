# 03 — Domain & Rules Extraction

> Phase 3. Business rules catalog, domain glossary, functional requirements (as-is).

## 3.1 Business Rules Catalog

Rules are grouped by domain area. Each rule is grounded in specific code.

### Governance — CGAD enforcement (cgad-spec-lint rules)

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| R1 | Deny-by-default: verification evidence without provider, or UNKNOWN/ERROR treated as PASS | `tools/cgad-spec-lint.mjs:155-237` | SQLite query on `verification_evidence` table |
| R2 | P15 risk floor: `final_risk < max(declared, derived, policy)` is a violation | `tools/cgad-spec-lint.mjs:250-300`; `src/tools/tasks.ts:40-50` (`computeFinalRisk`) | SQLite query + TS computation in `task_create/update` |
| R3 | Accepted AC with `implements` trace MUST also have `verified_by` evidence | `tools/cgad-spec-lint.mjs:R3` | SQLite query joining `artifact_traces` + `verification_evidence` |
| R4 | Greenfield episode ≥2 parallel git_change tasks in same module MUST have scaffold | `tools/cgad-spec-lint.mjs:R4` | SQLite query on tasks + tags |
| R5 | ≥2 active tasks sharing conflict_key = semantic collision | `tools/cgad-spec-lint.mjs:R5`; `src/schema.ts:335-344` (`task_conflict_keys`) | SQLite query on `task_conflict_keys` |
| R6 | Agent self-sets state without activity_log entry | `tools/cgad-spec-lint.mjs:R6` | SQLite query joining `tasks` + `activity_log` |
| R8 | Accepted artifact with `drift_state='drifted'` (frozen contract edited in place) | `tools/cgad-spec-lint.mjs:R8`; `src/tools/artifacts.ts:457-461` | SQLite query on `artifacts.drift_state` |
| R9 | Self-approval: verifier == builder for same AC | `tools/cgad-spec-lint.mjs:R9` | SQLite query on `verification_evidence.recorded_by` |
| R14 | FR contains forbidden implementation detail (HTTP verbs, DB tables, algorithms) | `tools/cgad-spec-lint.mjs:R14` | Regex on artifact .md file content |
| R15 | RULE artifact without `implements` or `implements_spec` trace | `tools/cgad-spec-lint.mjs:R15` | SQLite query on `artifact_traces` |

### Governance — runtime invariants

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| G1 | Only `passed` evidence admits a transition (deny-by-default) | `src/tools/lifecycle.ts:89-96` | `verification_record` handler |
| G2 | Cross-AC evidence is forbidden (canonical target only) | `src/tools/lifecycle.ts:83-88` | `verification_record` handler |
| G3 | Agent cannot self-lower `derived_risk` or `policy_minimum` (P15 monotonicity) | `src/tools/tasks.ts:64-83` (`enforceP15Monotonicity`) | `task_update` handler, pre-write check |
| G4 | `task_update` silently ignores `status` field (dispatcher's exclusive zone) | `src/tools/tasks.ts:826-838` | `handleTaskUpdate` |
| G5 | Worker_next rejects if execution already holds an active card | `src/tools/dispatcher.ts:246-268` | `handleWorkerNext` |
| G6 | Merge lock must be acquired before release | `src/tools/dispatcher.ts:1254-1260` | `handleWorkerMergeRelease` |

### Governance — authority model

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| A1 | Every MCP call passes through authority gateway | `src/index.ts:187-199` | `authorizeSagaToolCall` |
| A2 | Managed executions are fail-closed (unlisted tool = denied) | `src/saga3/authority/authorize-saga-tool-call.ts:283-298` | `authorizeSagaToolCall` |
| A3 | Execution context frozen at claim time (immutable) | `src/saga3/domain/execution-context.ts:1-134`; `src/lifecycle/work-assignment-core.ts:340-358` | `buildExecutionContext` at claim, stored in `worker_executions.metadata` |
| A4 | `proposal_submit` validates execution fence + strict context | `src/tools/saga3-proposals.ts:74-90` | `handleSubmitProposal` |
| A5 | `SAGA_MANAGED_EXECUTION` + `SAGA_EXECUTION_ID` must be consistent | `src/index.ts:61-73` | `assertManagedExecutionIdentity` |

### Governance — process module

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| P1 | GenericFlowExecutor contains zero module-name literals | `tests/architecture/dependency-direction.test.mjs:258-306` (Rule 4a) | Source scan |
| P2 | Module domain layer imports nothing from application/persistence/infra | `tests/architecture/dependency-direction.test.mjs:330-347` (Rule 5) | Dependency graph scan |
| P3 | No execution-scoped product lookup (only node-scoped) | `tests/architecture/no-execution-scoped-lookup.test.mjs` | Banned identifier scan |
| P4 | No certificate read from opaque `production.bindings` (magic-bindings ban) | `tests/architecture/no-execution-scoped-lookup.test.mjs:305-358` | Regex scan |
| P5 | Outcome must be terminal and declared by module | `src/process-modules/application/validate-process-module-run-result.ts:76-85` | `validateProcessModuleRunResult` |
| P6 | Settlement kernel issues its own certificate (Wave 4) | `src/process-modules/modules/*/installation.ts` (issueCertificate calls) | Code convention + ModuleCompletion envelope |

### Domain — Discovery settlement

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| D1 | GO requires worker AND advisor agreement, evidence, confidence ≥ 0.70 | `src/saga3/domain/discovery-settlement-policy.ts:373-381` (`goChecks`), `:158` (`GO_MIN_CONFIDENCE = 0.70`) | Pure policy function |
| D2 | REJECT requires worker AND advisor agreement, blocking gaps with source_refs, confidence ≥ 0.70 | `src/saga3/domain/discovery-settlement-policy.ts:360-368` (`rejectChecks`), `:159` (`REJECT_MIN_CONFIDENCE = 0.70`) | Pure policy function |
| D3 | Every indeterminate state fails-closed to CLARIFY | `src/saga3/domain/discovery-settlement-policy.ts:269-283` (`clarify` helper) | Pure policy function |
| D4 | Settlement input hash = SHA-256 over canonical JSON of immutable snapshot | `src/saga3/domain/discovery-settlement-input.ts:101-103` (`buildSettlementInputHash`) | Pure function |
| D5 | Policy hash = SHA-256 over canonical JSON of full manifest (not just version) | `src/saga3/domain/discovery-settlement-policy.ts:232-234` (`POLICY_V1_CONTENT_HASH`) | Pure function |

### Domain — Formalization traceability

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| F1 | PRD must trace `derived_from` → root artifact (brief/decision/discovery-doc) | `src/process-modules/modules/formalization/formalization-installation.ts:1263-1285` (`findContractGap`) | `findFirstTraceabilityGap` |
| F2 | Each UC must trace `derived_from` → PRD AND `covers` → ≥1 FR | `formalization-installation.ts:1287-1299` | `findContractGap` |
| F3 | Each AC must trace `derived_from` → ≥1 FR/NFR; FR-derived ACs also → ≥1 UC | `formalization-installation.ts:1300-1315` | `findContractGap` |
| F4 | SRS must trace `derived_from` → PRD | `formalization-installation.ts:1316-1322` | `findContractGap` |
| F5 | Baseline freeze requires all ACs accepted + clean (no drift) | `formalization-installation.ts:694-705` (`createBaselineFreezerHandler`) | Kernel handler |
| F6 | Exact-candidate-acceptance: only kernel gate sets artifacts to accepted+clean | `src/process-modules/application/exact-candidate-acceptance.ts:53-74` | `accept(command)` with CAS |

### Domain — Development settlement

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| DEV1 | Every accepted AC must have a verification task | `skills/saga-planner/SKILL.md` (T-014 rule); `development-settlement-policy.ts:273-287` | Planner rule + policy validation |
| DEV2 | Verification evidence pins both AC accepted hash AND frozen candidate hash | `src/process-modules/modules/development/development-settlement-policy.ts:795-813` | Pure policy function |
| DEV3 | Candidate drift invalidates all prior evidence | `development-settlement-policy.ts:656-663` | Pure policy function |
| DEV4 | Unknown/error evidence never authorizes verified bundle | `development-settlement-policy.ts:835-843` | Pure policy function |

### Domain — Work dispatch

| Rule ID | Rule | Evidence | Enforcement |
|---|---|---|---|
| W1 | `review` tasks are dispatched before `todo` tasks (review-first kanban) | `src/lifecycle/work-assignment-core.ts:311-314` (`ORDER BY CASE WHEN status='review' THEN 0 ELSE 1 END`) | SQL in `findNextClaimable` |
| W2 | Task with open `human_requests` is not claimable | `src/lifecycle/work-assignment-core.ts:290-292` | SQL NOT EXISTS |
| W3 | Task with unmet dependencies is not claimable | `src/lifecycle/work-assignment-core.ts:293-300` | SQL NOT EXISTS |
| W4 | Task with conflict-key sibling in pending/conflict state is not claimable | `src/lifecycle/work-assignment-core.ts:301-310` | SQL NOT EXISTS |
| W5 | Only 3 modules may write `tasks.{status, assigned_to, current_execution_id}` | `src/lifecycle/work-assignment-core.ts:1-42` (module header); `tests/architecture/tasks-writer-invariant.test.mjs` | Source-level lint |

### Duplicated/contradictory rules

| Rule pair | Location A | Location B | Risk |
|---|---|---|---|
| `ManagedProductionLedger` interface | `development-kernel-ports.ts:105-144` | `formalization-kernel-ports.ts:90-126` | Structural compatibility by accident; drift is silent |
| Acceptance baseline hash computation | `formalization-installation.ts:1973-1979` (`acceptanceBaselineHash`) | `sqlite-formalization-kernel.ts:143-166` (`readAcceptanceBaselineHash`) | Two independent implementations of same algorithm; one uses `createHash` directly, other uses SQLite |
| Canonical JSON | `saga3/shared/discovery-canonical.ts:28-35` | `process-modules/shared/canonical-json.ts:17` (re-export) | Currently one source (re-export), but the indirection obscures ownership |

---

## 3.2 Domain Glossary (Ubiquitous Language)

Terms are extracted from code identifiers, skill documents, and CGAD spec, reconciled against actual behavior.

| Term | Code symbol | Definition | Source |
|---|---|---|---|
| **Workplace** | `node` in `ProcessRun` | The primary durable entity. Owns the card and the desk. Survives worker changes. | `docs/architecture/CONVEYOR-MENTAL-MODEL.md`, CGAD P18 |
| **Worker** | `worker_executions` row, LM execution | One-shot LM execution. Guest on the workplace. Arrives, works, leaves. | `CONVEYOR-MENTAL-MODEL.md` |
| **Card** | projected `tasks` row | The work done so far. Belongs to the workplace, not the worker. | `CONVEYOR-MENTAL-MODEL.md` |
| **Desk** | workspace directory (`executions/node-<id>/`) | Worker's drafts/tools. Durable across worker changes. | `CONVEYOR-MENTAL-MODEL.md` |
| **Process Module** | `ProcessModuleDefinition` | A swappable plugin with its own Flow, skills, and specialty (discovery/formalization/development/delivery). | `src/process-modules/domain/process-module.ts` |
| **Flow** | `FlowDefinition` | A directed graph of nodes with transitions. Declarative; executor walks it as data. | `process-module.ts:207-216` |
| **Node** | `FlowNodeDefinition` | One step in a Flow. Kind ∈ {lm, kernel, human, composite}. | `process-module.ts:127-161` |
| **Stage Binding** | `StageBinding` | Maps a module to its place in a Lifecycle. Declarative input/output mappings + outcome routes. | `src/process-modules/domain/lifecycle.ts:33-47` |
| **Lifecycle** | `LifecycleDefinition` | Composition of stages with declarative routing. Owns cross-module go/no-go. | `lifecycle.ts:49-61` |
| **Fence** | `current_execution_id` on `tasks` | Fencing token. Every managed worker mutation must present the exact id. | `src/worker-executions.ts:95-112` (`assertExecutionFence`) |
| **Lease** | `lease_expires_at` on `worker_executions` | Authority deadline. When it passes, execution loses the right to mutate. | `src/schema.ts:207`, `CONVEYOR-MENTAL-MODEL.md` |
| **Heartbeat** | `heartbeat_at` on `worker_executions` | LIVENESS signal: "the supervisor still owns this execution". | `src/schema.ts:208` |
| **Progress** | `progress_at` on `worker_executions` | PROGRESS signal: "the worker produced observable activity". Independent of lease renewal. | `src/schema.ts:209` |
| **Authority** | `ExecutionAuthority` | Frozen snapshot of enforcement + allowed tools. Captured at claim time. | `src/saga3/domain/execution-context.ts:53-60` |
| **WorkIntent** | `saga3_work_intents` row | The deterministic kernel's request for product work. Worker never commits directly. | `src/saga3/domain/work-intent.ts` |
| **Proposal** | `saga3_proposals` row | Typed worker proposal. Has content_hash. Kernel decides, not worker. | `src/tools/saga3-proposals.ts` |
| **Certificate** | `saga3_discovery_outcome_certificates` / `ProcessOutcomeCertificate` | Immutable authoritative process result. Write-once. | `src/saga3/domain/discovery-settlement-records.ts` |
| **ProductRef** | `ProductRef` | Content-addressed reference: (schemaId, ref, digest). | `src/process-modules/domain/spi/production-envelope.ts:179-183` |
| **ModuleCompletion** | `ModuleCompletion` | Explicit terminal envelope replacing legacy magic bindings. Carries certificateRef. | `src/process-modules/domain/spi/module-completion.ts:110-114` |
| **Exact Candidate Acceptance** | `ExactCandidateAcceptance` | Universal kernel gate for artifact acceptance. CAS on exact ids + hashes. | `src/process-modules/application/exact-candidate-acceptance.ts:184-201` |
| **RiskClass** | `final_risk` on `tasks` | `max(declared_risk, derived_risk, policy_minimum)`. Agent cannot self-lower. | `src/tools/tasks.ts:40-50` |
| **Conflict Key** | `task_conflict_keys` row | Semantic collision surface (file_path, schema, public_protocol, integration_branch). | `src/schema.ts:335-344` |
| **Frozen Contract** | `accepted_hash` + `drift_state` on artifacts | Accepted baseline that cannot be edited in place. | `src/schema.ts:309-312` |
| **Recovery Issue** | `RecoveryIssue` | Module-authored verifier finding. Opaque reason codes to runtime. | `src/process-modules/domain/recovery.ts:62-83` |
| **Recovery Feedback** | `RecoveryFeedback` | Runtime-owned envelope delivered to repair worker. Embeds original issue. | `recovery.ts:106-120` |
| **Preflight** | `DeliveryPreflightSnapshot` | Deterministic release guards for certified candidate. | `delivery-schemas.ts` |
| **Conveyor** | the Saga runtime | The whole system: orchestration, executors, dispatch, persistence. | `CONVEYOR-MENTAL-MODEL.md` |

---

## 3.3 Functional Requirements (As-Is)

Derived strictly from observed behavior in code.

### FR-1: Project & Repository Management

| ID | Requirement | Evidence |
|---|---|---|
| FR-1.1 | The system SHALL create projects with name, description, tags. | `src/tools/projects.ts` |
| FR-1.2 | The system SHALL register physical repositories under projects with integration branch. | `src/tools/repositories.ts` |
| FR-1.3 | The system SHALL register machine-specific checkouts for repositories. | `repository_checkout_register` |
| FR-1.4 | The system SHALL resolve-or-create a project by exact name atomically. | `project_resolve_by_name` |

### FR-2: Task Lifecycle

| ID | Requirement | Evidence |
|---|---|---|
| FR-2.1 | The system SHALL atomically assign a task to a worker under `BEGIN IMMEDIATE` with fence creation. | `work-assignment-core.ts:252-365` |
| FR-2.2 | The system SHALL prevent a task with unmet dependencies from being claimed. | `work-assignment-core.ts:293-300` |
| FR-2.3 | The system SHALL prevent a task with open human_requests from being claimed. | `work-assignment-core.ts:290-292` |
| FR-2.4 | The system SHALL dispatch `review` tasks before `todo` tasks at equal priority. | `work-assignment-core.ts:311-314` |
| FR-2.5 | The system SHALL atomically terminalize an execution and release its task in one transaction. | `atomic-release.ts:138-291` |
| FR-2.6 | The system SHALL enforce a merge lock per repository before allowing merge. | `dispatcher.ts:1108-1204` |

### FR-3: Artifact & Traceability

| ID | Requirement | Evidence |
|---|---|---|
| FR-3.1 | The system SHALL create artifacts with type, code, path, status, content_hash, and drift_state. | `artifacts.ts:90-300` |
| FR-3.2 | The system SHALL compute content_hash from the artifact's .md file on disk. | `artifacts.ts:183` (`artifactDiskHash`) |
| FR-3.3 | The system SHALL detect drift when an accepted artifact's file changes after baseline. | `artifacts.ts:447-461` |
| FR-3.4 | The system SHALL stamp every managed artifact mutation with immutable ProcessRun/node/task/execution lineage. | `sqlite-managed-production-ledger.ts:313-389` |

### FR-4: Authority & Enforcement

| ID | Requirement | Evidence |
|---|---|---|
| FR-4.1 | Every MCP tool call SHALL pass through the authority gateway. | `index.ts:187-199` |
| FR-4.2 | Managed executions SHALL be fail-closed (unlisted tool = denied). | `authorize-saga-tool-call.ts:283-298` |
| FR-4.3 | The execution context SHALL be frozen at claim time and never mutated. | `execution-context.ts:1-22`; `work-assignment-core.ts:340-358` |

### FR-5: Process Module Execution

| ID | Requirement | Evidence |
|---|---|---|
| FR-5.1 | The GenericFlowExecutor SHALL walk the Flow from entry node to terminal, dispatching by `node.kind`. | `generic-flow-executor.ts:399-832` |
| FR-5.2 | The executor SHALL persist a NodeRun for every node execution attempt. | `generic-flow-executor.ts:610-763` |
| FR-5.3 | The executor SHALL support crash-resume from the last completed NodeRun. | `generic-flow-executor.ts:442-536` |
| FR-5.4 | Settlement kernels SHALL issue their own certificates (Wave 4 explicit completion). | `modules/*/installation.ts` |

### FR-6: Discovery Settlement

| ID | Requirement | Evidence |
|---|---|---|
| FR-6.1 | The system SHALL produce an immutable outcome certificate for each unique (proposal hash, readiness target, policy version) tuple. | `discovery-settlement-service.ts:351-416` |
| FR-6.2 | The settlement policy SHALL be a pure function with no I/O. | `discovery-settlement-policy.ts:289-527` |
| FR-6.3 | GO SHALL require worker + advisor agreement, evidence, confidence ≥ 0.70. | `discovery-settlement-policy.ts:373-464` |

### FR-7: Worker Supervision

| ID | Requirement | Evidence |
|---|---|---|
| FR-7.1 | The system SHALL track `lease_expires_at`, `heartbeat_at`, `progress_at` independently. | `schema.ts:207-209` |
| FR-7.2 | The reaper SHALL use a pure policy (`decideStuckAction`) for all stuck-state decisions. | `stuck-policy.ts:184-338` |
| FR-7.3 | Process termination SHALL require matching PID + process birth token. | `worker-executions.ts:281-310` |
| FR-7.4 | The reaper SHALL NOT kill a process with a mismatched birth token (PID reuse scenario). | `stuck-policy.ts:296-301` |

### FR-8: Verification

| ID | Requirement | Evidence |
|---|---|---|
| FR-8.1 | Verification evidence SHALL use a 4-valued verdict (passed/failed/unknown/error). | `schema.ts:383`, `lifecycle.ts:29` |
| FR-8.2 | Only `passed` SHALL create a `verified_by` trace and admit a transition. | `lifecycle.ts:108-113` |
| FR-8.3 | Cross-AC evidence SHALL be rejected (canonical target enforcement). | `lifecycle.ts:83-88` |
| FR-8.4 | Evidence SHALL be immutable per execution attempt. | `schema.ts:386-390` (UNIQUE index includes execution_id) |

### FR-9: Package Installation

| ID | Requirement | Evidence |
|---|---|---|
| FR-9.1 | The system SHALL install module packages as immutable, content-addressed blobs. | `production-install.ts:121-183` |
| FR-9.2 | ProcessRuns SHALL be pinned to `installation_id` + `package_digest`. | `product-lifecycle-runtime.ts:642-653` |
| FR-9.3 | A changed module package under the same name@version SHALL trigger version collision. | `production-install.ts:160-168` |

### Open questions (cannot be determined from code)

| Question | Why it matters | Stakeholder needed |
|---|---|---|
| What are the SLA targets for lifecycle completion? | NFRs cannot be derived from code alone. | Product owner |
| What is the retention policy for worker logs, activity_log, and worker_executions? | Data accumulates indefinitely. No purging logic exists. | Operations |
| What is the compliance scope (GDPR, SOC2, etc.)? | No compliance controls observed in code. | Legal/compliance |
| What are the load/throughput targets (concurrent epics, workers, DB size)? | Single SQLite, single process. Architectural ceiling. | Product owner |
