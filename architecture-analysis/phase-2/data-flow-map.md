# Data Flow Map

Artifact ID: ART-PHASE2-DATA-FLOW
Artifact Type: Data Flow Map
Phase: Phase Two
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE2-SCENARIO-MATRIX, ART-PHASE2-STATE-OWNERSHIP, full codebase context
Coverage: 3 primary data flows traced from source to consumer. Each boundary crossing classified.
Confidence: High (E3-E5 for all flows)
Referenced Evidence: EVID-009 through EVID-026, FINDING-001, FINDING-005
Downstream Dependencies: Phase 3 (Real Core), Phase 4 (Seam Map)

---

## FLOW-001: Product lifecycle — idea to release record

The primary data flow. Traces how a one-phrase idea transforms through 4 workshops into a release record.

```
SOURCE: Human idea (text, one phrase)
  │
  ▼ [no contract — free text input]
  │
PARSING: assembleProductLifecycleInput (start-product-lifecycle-from-idea.ts:144)
  │ → resolveActiveRepositoryWithHead: git rev-parse HEAD
  │ → buildReferenceDevelopmentPolicy (deterministic snapshot)
  │ → buildDeferredDeliveryProfile (deterministic marker)
  │
  ▼ [EXPLICIT CONTRACT: ProductDeliveryLifecycleInput schema]
  │   assertProductDeliveryLifecycleInput validates structure + policy hashes
  │
VALIDATION: assertProductDeliveryLifecycleInput (product-delivery-lifecycle.ts:141)
  │ → lifecycleInputPolicyValidation (hashDevelopmentPolicy, hashDeliveryReleasePolicy, hashDeliveryDeferredProfile)
  │
  ▼ [validated payload → LifecycleOrchestrator]
  │
TRANSFORMATION: LifecycleOrchestrator.run (lifecycle-orchestrator.ts:174)
  │ → mapLifecycleValues(initial-discovery.inputMapping, durableFrame)
  │ → JSON-path reads: $.initiative.subject, $.initiative.context, etc.
  │
  ▼ [EXPLICIT CONTRACT: DiscoveryCase schema (saga3.discovery-case.v1)]
  │   inputHash = sha256(payload), ProcessRun pinned to installationId
  │
DISCOVERY MODULE (4 desks, desk #1):
  │
  │  LM worker produces → proposal_submit → saga3_raw_submissions → saga3_proposals
  │  [DESK TRANSLATION 1: universal product → discovery-specific proposal table]
  │  Contract: proposal_submit validates intent_id + execution_id + schema_version + authority
  │  SEMANTIC CHANGE: "product text" becomes "discovery proposal" (domain vocabulary assigned)
  │
  │  Kernel reads: readProposalForExecution(intentId, taskId, executionId)
  │  [MODULE-SPECIFIC READ — no universal read path]
  │
  │  Settlement: discoverySettlementPolicyV1.evaluate(snapshot) → decision
  │  Certificate: issueCertificateAtomically → saga3_discovery_outcome_certificates
  │
  ▼ [EXPLICIT CONTRACT: discovery outcome + certificate ref]
  │   routeProcessOutcome: outcomeRoutes['go'] → stage 'solution-formalization'
  │   handoffFrame: $.stages.initial-discovery.certificate.{ref,hash}
  │
BOUNDARY CROSSING: Discovery → Formalization
  │  Data passes through LifecycleOrchestrator's declarative outputMapping → inputMapping
  │  The CERTIFICATE REF (schema+ref+hash) crosses the boundary, not the proposal payload
  │  [MEDIATED — no direct module-to-module call]
  │
FORMALIZATION MODULE (4 desks, desk #2):
  │
  │  LM worker produces → artifact_create → artifacts table
  │  ↓ BRIDGE: recordManagedArtifactProduction → saga3_managed_artifact_productions
  │  [DESK TRANSLATION 2: universal artifact → managed-production-ledger]
  │  Contract: artifact_create validates type/status/repo binding; managed-ledger validates live producer fence
  │  SEMANTIC CHANGE: "product text" becomes "PRD"/"UC"/"AC"/"SRS" (artifact types)
  │  INFORMATION ADDED: parent_artifact_id, code, content_hash, accepted_hash, drift_state
  │
  │  Kernel reads: listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId)
  │  [MODULE-SPECIFIC READ — same interface as Development but DIFFERENT table than Discovery]
  │
  │  Kernel gate: exactCandidateAcceptance.accept → atomic CAS draft→accepted
  │  Baseline freezer: acceptanceBaselineHash = sha256(sorted AC accepted_hashes)
  │  Settlement: findFirstTraceabilityGap + ReferenceFormalizationSettlementPolicy
  │  Certificate: certificateRepo.issue → saga3_process_outcome_certificates
  │
  ▼ [EXPLICIT CONTRACT: solution contract + certificate ref]
  │   routeProcessOutcome: outcomeRoutes['formalized'] → stage 'solution-development'
  │   handoffFrame: $.stages.solution-formalization.solutionContract.{ref,hash}
  │   ALSO: $.stages.solution-formalization.solutionContractPayload (dereferenced by resolveOutputPayload)
  │
BOUNDARY CROSSING: Formalization → Development
  │  The SOLUTION CONTRACT PAYLOAD (full bundle: SRS, AC list, baseline hash) crosses the boundary
  │  This is the RICHEST handoff — it carries the entire formalization output
  │  [MEDIATED — LifecycleOrchestrator resolves the payload via createFormalizationLifecycleOutputPayloadResolver]
  │
DEVELOPMENT MODULE (4 desks, desk #3):
  │
  │  LM worker produces → process_node_submit → saga3_managed_node_submissions
  │  [DESK TRANSLATION 3: universal product → development-specific submission table]
  │  Contract: process_node_submit derives lineage from live fence; payload must be JSON object
  │  SEMANTIC CHANGE: "product text" becomes "development task graph proposal"
  │
  │  Kernel reads: readLatestForNode(processRunId, moduleRef, nodeId)
  │  [MODULE-SPECIFIC READ — third interface, third table]
  │
  │  Kernel materializes: materializeValidatedTaskGraph → projects kanban tasks
  │  Settlement: areProjectedTasksTerminal → paused → conveyor drains → resume → verified
  │  Certificate: certificateRepo.issue → saga3_process_outcome_certificates
  │
  ▼ [EXPLICIT CONTRACT: verified integration bundle + certificate ref]
  │   routeProcessOutcome: outcomeRoutes['verified'] → stage 'delivery-release'
  │   handoffFrame: $.stages.solution-development.verifiedBundle.{ref,hash}
  │
BOUNDARY CROSSING: Development → Delivery
  │  The VERIFIED INTEGRATION BUNDLE (frozen candidate + evidence) crosses the boundary
  │  [MEDIATED — same declarative mapping]
  │
DELIVERY MODULE (4 desks, desk #4):
  │
  │  NO LM worker submit — kernel-only desk
  │  Kernel writes: saga3_external_effect_events (publication/observation results)
  │  [DESK TRANSLATION 4: kernel writes directly to delivery-specific effect table]
  │  SEMANTIC CHANGE: "product text" becomes "release action receipt"
  │
  │  Settlement: ReferenceDeliverySettlementPolicy → releaseRecord
  │  Certificate: certificateRepo.issue → saga3_process_outcome_certificates
  │
  ▼ [TERMINAL: release record or approval-required/blocked/failed]
```

### FLOW-001 Analysis

**Where data changes semantic meaning:**
1. Universal input → Discovery proposal (at proposal_submit) — "text" becomes "a discovery proposal with recommended_outcome"
2. Discovery certificate → Formalization input (at LifecycleOrchestrator handoff) — "certificate" becomes "authorization to build"
3. Formalization artifacts → Development task graph (at process_node_submit) — "PRD/UC/AC/SRS" becomes "work items for parallel workers"
4. Development evidence → Delivery preflight (at settlement) — "test results" becomes "release readiness proof"

**Where persistence shapes leak inward:**
- Discovery kernel handlers import `DiscoveryRuntimePersistencePort` — a port that mirrors saga3-specific table shapes (snake_case row types). The port abstracts SQLite, but the SHAPE of the data is saga3-specific.
- Formalization `readArtifactsByIds` returns `FormalizationArtifactSnapshot` — a type that mirrors the artifacts table columns. The kernel handler works with table-shaped data, not domain-shaped data.

**Where multiple representations compete:**
- An artifact exists as: (1) a row in `artifacts` table, (2) a row in `saga3_managed_artifact_productions`, (3) a `.md` file on disk, (4) a `FormalizationArtifactSnapshot` in memory. Four representations, no single source of truth — the disk file wins for content_hash, the artifacts table wins for status, the managed-ledger wins for provenance.

**Where transformations are duplicated:**
- `canonicalJson` + `sha256Hex` — re-exported from 3 locations (saga3/shared, process-modules/shared, inline in several handlers). The function is identical; the import paths differ.
- Content hash computation: `artifactDiskHash` (reads file, computes sha256) vs `canonicalJson(payload)+sha256` (hashes JSON). These produce DIFFERENT hashes for the same content — one is byte-level, the other is canonical-JSON-level. Workers must know which one applies.

---

## FLOW-002: Worker product — from LM output to kernel gate

How a single worker's text output becomes a verified, accepted product.

```
SOURCE: claude -p generates text (JSON payload for typed submit, or artifact .md file)
  │
  ▼ [NO CONTRACT — free-form model output]
  │
SUBMIT (one of four paths, depending on module):
  │
  │  PATH A (Discovery): proposal_submit
  │    → normalizeDiscoveryProposalInput (deterministic normalization: JSON parse, alias resolution)
  │    → insertRawSubmission (saga3_raw_submissions — raw text preserved)
  │    → INSERT saga3_proposals (canonical payload + content_hash)
  │    [CONTRACT: schema_version must match DISCOVERY_PROPOSAL_SCHEMA]
  │
  │  PATH B (Formalization): artifact_create
  │    → artifactDiskHash (reads .md file from disk, computes sha256)
  │    → INSERT/UPDATE artifacts (canonical row)
  │    → recordManagedArtifactProduction (saga3_managed_artifact_productions — provenance)
  │    [CONTRACT: type must be in ARTIFACT_TYPES; status must be draft/in_review (not accepted)]
  │
  │  PATH C (Development): process_node_submit
  │    → repo().submitForCurrentExecution (derives lineage from SAGA_MANAGED_EXECUTION env)
  │    → INSERT saga3_managed_node_submissions (node-scoped product)
  │    [CONTRACT: schema must match execution profile outputSchema; payload must be JSON]
  │
  │  PATH D (Delivery): no submit — kernel writes directly
  │
  ▼ [MODULE-SPECIFIC CONTRACT — each path has different validation]
  │
KERNEL READ (one of four paths, depending on module):
  │
  │  PATH A: readProposalForExecution(intentId, taskId, executionId) → exact proposal row
  │  PATH B: listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId) → artifact writes
  │  PATH C: readLatestForNode(processRunId, moduleRef, nodeId) → submission record
  │  PATH D: settlementState.buildSettlementInput → reads delivery runtime state
  │
  ▼ [MODULE-SPECIFIC READ — no universal read path]
  │
KERNEL VALIDATION (module-specific handler):
  │  → schema validation (handler-specific)
  │  → traceability check (Formalization: findContractGap)
  │  → coverage check (Development: taskGraphPolicy.validate)
  │  → lineage check (all: exact execution fence + hash match)
  │
  ▼ [MODULE-SPECIFIC VALIDATION]
  │
KERNEL GATE (universal):
  │  → exactCandidateAcceptance.accept(command)
  │  → Atomic CAS: draft → accepted, accepted_hash = content_hash, drift_state = clean
  │  → Idempotent on idempotency_key
  │
  ▼ [UNIVERSAL CONTRACT: ExactCandidateAcceptance — the ONE universal gate]
  │
CERTIFICATE (universal):
  │  → certificateRepo.issue (idempotent on certificate_hash)
  │  → ModuleCompletion envelope with certificateRef
  │
  ▼ [UNIVERSAL OUTPUT: ProcessModuleCertificateRef]
  │
CONSUMER: next module's kernel handler OR LifecycleOrchestrator (for cross-stage handoff)
```

### FLOW-002 Analysis

**The four submit paths are the primary architectural debt (FINDING-001).**

Each path:
- Has its own MCP tool (proposal_submit, artifact_create, process_node_submit, none)
- Writes to its own table (saga3_proposals, artifacts+ledger, saga3_managed_node_submissions, kernel-only)
- Has its own validation (discovery schema, artifact type enum, JSON payload shape, kernel-internal)
- Has its own read path (readProposalForExecution, listArtifactsForNodeInProcessRun, readLatestForNode, settlementState)

**The ONE universal point is the kernel gate (exactCandidateAcceptance).** This is where all four paths converge: regardless of which desk the product was placed on, the acceptance decision is the same atomic CAS. This is the strongest evidence that the four desks are accidental — the gate that matters is already universal.

**The certificate is also universal.** All four modules issue certificates through the same `certificateRepo.issue` (idempotent on hash). The certificate crosses module boundaries as a `ProductRef (schemaId, ref, digest)` — a universal reference.

---

## FLOW-003: Worker execution state — from claim to release

How execution identity flows through the system.

```
SOURCE: dispatch-loop or LmNodeExecutor decides to launch a worker
  │
  ▼ [GENERATION]
  │
  workerExecutionId = `exec-${projectId}-${pid}-${ts}-${seq}`
  workerId = `lm-${projectId}-${runId}-${nodeId}-${seq}`
  │
  ▼ [ASSIGNMENT — BEGIN IMMEDIATE]
  │
  findNextClaimable(db, workerId, projectId, ..., reservation):
    → SELECT claimable task (review-first, priority, gates)
    → UPDATE tasks SET status=in_progress, assigned_to=workerId, current_execution_id=executionId
    → INSERT worker_executions (execution_id, state=reserved, frozen execution_context)
    │
    │ execution_context = {
    │   policy_version: 'saga3.execution.v1',
    │   work_intent_id: <intent>,
    │   authority: { enforcement, allowed_saga_tools, scope, snapshot_ref, authority_hash },
    │   model_route: { provider, model, effort },
    │   captured_at: ISO
    │ }
    │
  ▼ [FROZEN SNAPSHOT — immutable from here on]
  │
  PROPAGATION (3 consumers read the frozen snapshot):
  │
  │  CONSUMER 1: Worker spawn
  │    → buildAssignedWorkFromClaim reads execution_context from worker_executions.metadata
  │    → ClaudeBoardRunner.launch uses model_route for spawn args (--model, --effort)
  │    → writeExecutionMcpConfig writes SAGA_EXECUTION_ID into per-execution MCP config
  │    → claude -p spawned with --mcp-config pointing at this config
  │
  │  CONSUMER 2: MCP gateway (every tool call)
  │    → authorizeSagaToolCall reads SAGA_MANAGED_EXECUTION + SAGA_EXECUTION_ID from env
  │    → readExecutionContextStrict validates hash, policy_version, authority_hash
  │    → If tool not in allowed_saga_tools → AUTHORITY_DENIED
  │
  │  CONSUMER 3: Provenance (proposal_submit / process_node_submit)
  │    → resolveManagedExecutionProvenance reads same env vars
  │    → Validates task_id + execution_id match
  │    → Stamps provenance on every product write (model, provider, worker, exec, time)
  │
  ▼ [3 readers, 1 frozen source — no drift possible by construction]
  │
  POLLING (ClaudeBoardRunner.waitForAssignedWorker):
    → executor.status(projectId) → poll child process state
    → child.stdout.on('data') → markExecutionProgress (throttled 30s)
    → Terminal states: completed, stopped, failed
    │
    ▼ [TERMINAL]
    │
  CLOSE PATH (one of):
    │
    │  PATH A: worker_done called (normal completion)
    │    → handleWorkerDone: checkReceipt (idempotency) → fence check → status transition
    │    → updateExecutionPhase (finishing or integrating)
    │    → markExecutionExited (state=exited, clear current_execution_id)
    │
    │  PATH B: child.close with no worker_done (crash)
    │    → recoverAssignment → releaseExecutionAtomically (state=lost)
    │    → markExecutionExited (state=exited or terminated)
    │
    │  PATH C: worker_ask_need (terminal ASK)
    │    → releaseExecutionAtomically (state=exited)
    │    → Add needs-human tag
    │
    │  PATH D: reaper kills stuck worker
    │    → decideStuckAction → TERMINATE
    │    → probe.killVerified(pid, birthToken)
    │    → releaseExecutionAtomically (state=terminated)
    │
  ▼ [TERMINAL STATE — no further mutations from this execution]
```

### FLOW-003 Analysis

**The execution-state flow is the cleanest in the system.** Three consumers read one frozen snapshot, and the snapshot is immutable after claim. No drift is possible by construction.

**The four terminal paths (A/B/C/D) all converge on releaseExecutionAtomically.** This is the single point of truth for "this execution is done." The function's fence CAS ensures that only the current fence holder can release — a superseded execution cannot.

**markExecutionExited is the documented exception** (STATE-001, suspected conflict #4). It writes `current_execution_id=NULL` on the tasks table — technically an owner-column write outside the 3-module single-writer set. The code comment acknowledges this and promises FU-D consolidation. This is a load-bearing hack (Phase 8 will classify it).

---

## Cross-flow observations

### FINDING-007: Artifacts table is a split-brain owner
- Classification: observed
- Evidence: FLOW-002 PATH B writes to TWO tables (artifacts + managed-ledger) from one handler call with no cross-table transaction. The artifacts table owns STATUS; the managed-ledger owns PROVENANCE. A crash between writes leaves status and provenance inconsistent.
- Affected state: STATE-003 (artifacts), STATE-005 (managed-artifact-productions)
- Affected scenarios: SCN-001 (formalization steps), SCN-003 (recovery — kernel reads managed-ledger, not artifacts table, for provenance)

### FINDING-008: Three-phase transaction in worker_done
- Classification: observed
- Evidence: SCN-002 step 7 (handleWorkerDone) performs: (1) status transition + comment insert + integration_state set under BEGIN IMMEDIATE, then (2) reevaluateDownstream (auto-block/unblock dependencies) OUTSIDE the transaction. A crash between (1) and (2) leaves downstream tasks in an inconsistent dependency state.
- The single-writer invariant holds for the task row itself, but the DEPENDENCY GRAPH update is not atomic with the status change.
- Affected scenarios: SCN-002 (worker completion), SCN-005 (crash recovery — reaper may see a task that is 'done' but whose downstream is still 'blocked')
