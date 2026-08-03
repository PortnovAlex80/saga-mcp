# State Ownership Map

Artifact ID: ART-PHASE2-STATE-OWNERSHIP
Artifact Type: State Ownership Map
Phase: Phase Two
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE0-MODULE-INVENTORY, ART-PHASE2-SCENARIO-MATRIX, full codebase context
Coverage: 14 significant state entities mapped for ownership, writers, readers, lifecycle, invariants, transaction boundaries
Confidence: High (E3-E5 for all entries; schema constraints verified from schema.ts)
Referenced Evidence: EVID-004, EVID-005, EVID-015, EVID-017, EVID-018
Unresolved Questions: QUESTION-003 (as any extent), QUESTION-006 (interface duplication)
Downstream Dependencies: Phase 3 (Real Core), Phase 4 (Seam Map), Phase 6 (Target Architecture)

---

## STATE-001: tasks (the Card)

| Field | Value |
|---|---|
| Creator | task_create handler (tasks.ts:385) or ensureProjectedTask (lm-node-executor.ts via persistence port) |
| **Authoritative owner** | **Work Dispatch context** (work-assignment-core.ts + atomic-release.ts) |
| Writers (owner columns: status, assigned_to, current_execution_id) | (1) findNextClaimable — work-assignment-core.ts:326 (2) releaseExecutionAtomically — atomic-release.ts:257 (3) recoverLegacyAssignments — worker-executions.ts:633 (4) markExecutionExited — worker-executions.ts:204 (DOCUMENTED EXCEPTION) |
| Writers (non-owner columns: metadata, tags, risk, integration_state) | task_update handler (tasks.ts:754), worker_done (integration_state), worker_merge_release, evaluateAndUpdateDependencies |
| Readers |几乎所有 components: dispatcher, tasks handler, artifacts handler, lifecycle, lm-node-executor, tracker-view, orchestrate-cli |
| Lifecycle | todo → in_progress → review → review_in_progress → done → blocked (6 states, CHECK constrained) |
| Allowed transitions | Only via worker_next (claim) + worker_done (complete) + auto-block/unblock (dependencies). task_update IGNORES status field. |
| Invariants | (1) todo/done/blocked ⇒ assigned_to IS NULL (2) in_progress/review_in_progress ⇒ assigned_to IS NOT NULL (3) Single-writer for owner columns (lint-enforced) (4) review-first dispatch ordering (5) conflict-key gate prevents parallel tasks on same file |
| Current persistence | SQLite `tasks` table, CHECK constraints on status/priority/execution_mode/integration_state |
| Transaction boundary | BEGIN IMMEDIATE for claim/release (atomic fence + status flip). DEFERRED for dependency reevaluation. |
| Concurrency assumptions | Single-writer model: SQLite BEGIN IMMEDIATE serializes all writers. No optimistic locking — the write lock IS the serialization. |
| Consistency expectations | Strong consistency within one SQLite DB. No cross-host consistency (single-machine assumption). |
| **Suspected ownership conflicts** | markExecutionExited (worker-executions.ts:204) writes `current_execution_id=NULL` — this is a FOURTH writer of owner columns, documented as exception. FU-D will consolidate into releaseExecutionAtomically. |

---

## STATE-002: worker_executions (the Pass/Badge)

| Field | Value |
|---|---|
| Creator | findNextClaimable (work-assignment-core.ts:349) — INSERT with reservation |
| **Authoritative owner** | **Infrastructure** (worker-executions.ts + atomic-release.ts) |
| Writers | markExecutionRunning, markExecutionProgress, markExecutionExited, markExecutionSpawnFailed, releaseExecutionAtomically, updateExecutionPhase |
| Readers | reconcileWorkerExecutions (reaper), authorizeSagaToolCall (authority gateway), tracker-view (/api/workers/active), worker_done (fence check) |
| Lifecycle | reserved → running → {exited | terminated | lost | spawn_failed} (5 terminal states) |
| Allowed transitions | reserved→running (markExecutionRunning, CAS on state='reserved'), running→terminal (markExecutionExited or releaseExecutionAtomically, CAS on active states) |
| Invariants | (1) Unique execution_id (PRIMARY KEY) (2) One active execution per task (UNIQUE INDEX WHERE state IN active) (3) One active execution per worker (UNIQUE INDEX WHERE state IN active) (4) PID + process_birth_token required for running state |
| Current persistence | SQLite `worker_executions` table with Wave 5 supervision columns (lease_expires_at, heartbeat_at, progress_at, suspected_stuck_at, cancel_requested_at, stuck_state) |
| Transaction boundary | openRuntimeDb (separate connection per write function). markExecutionExited uses db.transaction (DEFERRED). releaseExecutionAtomically uses db.transaction (DEFERRED) but relies on BEGIN IMMEDIATE from caller. |
| **Suspected ownership conflicts** | **Multiple connection paths**: markExecutionRunning uses openRuntimeDb (its own connection), while releaseExecutionAtomically receives db as parameter (caller's connection). Under WAL mode this is safe for concurrent readers, but a writer using a different connection than the IMMEDIATE lock holder could see stale state. In practice, the single-writer assumption holds because SQLite serializes all writers regardless of connection. |

---

## STATE-003: artifacts (the Product — Formalization desk)

| Field | Value |
|---|---|
| Creator | artifact_create handler (artifacts.ts:90) — upsert by (epic_id, type, code) |
| **Authoritative owner** | **Production & Evidence context** (MCP tools layer → SQLite) |
| Writers | artifact_create (upsert), artifact_update (mutable fields), exactCandidateAcceptance.accept (atomic CAS: draft→accepted), refreshArtifactHash (disk hash reconciliation) |
| Readers | artifact_get, artifact_list, artifact_coverage, trace_list (JOIN), formalization kernel handlers (via graph port), tracker-view (markdown rendering) |
| Lifecycle | draft → in_review → accepted → superseded (4 states, CHECK constrained) |
| Allowed transitions | draft→in_review (worker), in_review→accepted (kernel gate ONLY via exactCandidateAcceptance), accepted→superseded (new version). Workers CANNOT set status='accepted' under managed execution (assertManagedArtifactMutationAuthority). |
| Invariants | (1) accepted_hash = content_hash when status='accepted' (2) drift_state='clean' when accepted (3) content_hash = sha256(disk file) via artifactDiskHash (4) project_repository_id required for managed execution |
| Current persistence | SQLite `artifacts` table |
| Transaction boundary | artifact_create/update: no explicit transaction (single statement). exactCandidateAcceptance.accept: BEGIN IMMEDIATE (CAS on id + status + accepted_hash). |
| **Suspected ownership conflicts** | **DUAL WRITE PATH**: artifact_create writes to `artifacts` table AND `recordManagedArtifactProduction` writes to `saga3_managed_artifact_productions`. The artifacts table is the CANONICAL artifact store; the managed-production-ledger is PROVENANCE (who produced it, when, under what fence). But both are written from the same handler call, and there is no cross-table transaction. A crash between the two writes leaves them inconsistent. |

---

## STATE-004: saga3_proposals (the Product — Discovery desk)

| Field | Value |
|---|---|
| Creator | proposal_submit handler (saga3-proposals.ts:53) |
| **Authoritative owner** | **Saga3 Discovery bounded context** |
| Writers | proposal_submit (INSERT ON CONFLICT DO NOTHING — idempotent by content_hash) |
| Readers | discovery kernel handlers (resolve-proposal-submission, prepare-readiness, settlement), discovery settlement service, readiness/diagnosis handlers |
| Lifecycle | submitted → superseded/rejected_by_kernel (3 states) |
| Invariants | (1) UNIQUE(intent_id, execution_id, content_hash) — idempotent replay (2) content_hash = sha256(canonicalJson(payload)) (3) provenance records model/provider/effort/worker/exec/time |
| Current persistence | SQLite `saga3_proposals` table |
| Transaction boundary | withImmediateTransaction (BEGIN IMMEDIATE) in proposal_submit handler |
| **Suspected ownership conflicts** | None — single writer (proposal_submit), single context (Discovery). But this is a MODULE-SPECIFIC desk that should be unified (FINDING-001). |

---

## STATE-005: saga3_managed_artifact_productions (the Product — Formalization provenance)

| Field | Value |
|---|---|
| Creator | recordManagedArtifactProduction (sqlite-managed-production-ledger.ts:313) |
| **Authoritative owner** | **Production & Evidence context** (managed-production-ledger) |
| Writers | recordManagedArtifactProduction (called from artifact_create/artifact_update handlers when SAGA_MANAGED_EXECUTION=1) |
| Readers | Formalization kernel handlers (via listArtifactsForNodeInProcessRun), Development kernel handlers (via listArtifactsForNodeInProcessRun — shared ledger) |
| Lifecycle | Append-only (INSERT OR IGNORE). No UPDATE or DELETE path. |
| Invariants | (1) UNIQUE(process_run_id, node_id, execution_id, artifact_id, operation, artifact_status, COALESCE(content_hash,'')) (2) Live producer fence required (requireLiveProducer: true in resolveManagedExecutionProvenance) (3) Wave 6: execution-scoped reads REMOVED — only node-scoped (P18) |
| Current persistence | SQLite `saga3_managed_artifact_productions` table |
| **Suspected ownership conflicts** | See STATE-003 — the dual write path (artifacts table + this ledger) is the conflict. Also: Development and Formalization modules SHARE this ledger (same table, same SqliteManagedProductionLedger instance), but each declares its own interface copy (QUESTION-006). |

---

## STATE-006: saga3_managed_node_submissions (the Product — Development desk)

| Field | Value |
|---|---|
| Creator | process_node_submit handler (process-node-submissions.ts:21) via SqliteManagedNodeSubmissionRepository |
| **Authoritative owner** | **Production & Evidence context** (managed-node-submission) |
| Writers | process_node_submit (INSERT — idempotent by content hash) |
| Readers | Development kernel handler (resolve-task-graph reads readLatestForNode) |
| Lifecycle | Append-only |
| Invariants | Node-scoped provenance (processRunId + moduleRef + nodeId) |
| Current persistence | SQLite table (created by SqliteManagedNodeSubmissionRepository constructor) |
| **Suspected ownership conflicts** | None — single writer, single reader. But this is the THIRD product desk (after proposals and managed-artifact-productions). |

---

## STATE-007: verification_evidence (the Evidence)

| Field | Value |
|---|---|
| Creator | handleVerificationRecord (lifecycle.ts:21) |
| **Authoritative owner** | **Production & Evidence context** |
| Writers | verification_record MCP tool (verification.ac task holder only) |
| Readers | Development settlement policy (reads outcome for gate check), cgad-spec-lint R1 (deny-by-default audit) |
| Lifecycle | Append-only. UNIQUE(task_id, artifact_id, content_hash, execution_id) — per-execution retry allowed. |
| Invariants | (1) outcome IN (passed, failed, unknown, error) — 4-valued (2) Only 'passed' creates verified_by trace (3) Cross-AC evidence rejected (artifact_id must = verification_target_artifact_id) (4) Provider field required by CGAD §6 (5) passed requires content_hash = AC accepted_hash |
| Current persistence | SQLite `verification_evidence` table |
| Transaction boundary | INSERT OR IGNORE (idempotent). Not wrapped in explicit transaction. |
| **Suspected ownership conflicts** | None — single writer (verification_record), clean ownership. |

---

## STATE-008: saga3_discovery_outcome_certificates (the Certificate)

| Field | Value |
|---|---|
| Creator | Saga3DiscoverySettlementService.settle (discovery-settlement-service.ts:527) via issueCertificateAtomically |
| **Authoritative owner** | **Saga3 Discovery bounded context** (settlement service is the ONLY writer) |
| Writers | issueCertificateAtomically (BEGIN IMMEDIATE: verify settlement state → INSERT/reuse certificate → transition to certificate_issued → commit) |
| Readers | Discovery settlement handler (reads for ModuleCompletion envelope), LifecycleOrchestrator (handoff to Formalization via certificate ref) |
| Lifecycle | Write-once (certificate_hash UNIQUE). No UPDATE path. |
| Invariants | (1) 1:1 with settlement (UNIQUE settlement_id) (2) certificate_hash = sha256(certificate_payload) (3) issued_at = settlement.created_at (deterministic for replay) (4) Co-tamper rejection inside BEGIN IMMEDIATE |
| Current persistence | SQLite `saga3_discovery_outcome_certificates` table |
| **Suspected ownership conflicts** | None — single writer, write-once, content-addressed. This is the cleanest state entity in the system. |

---

## STATE-009: saga3_process_outcome_certificates (the Certificate — universal)

| Field | Value |
|---|---|
| Creator | ProcessOutcomeCertificateRepository.issue() — called by Formalization/Development/Delivery settlement kernels |
| **Authoritative owner** | **Conveyor Runtime** (ProcessOutcomeCertificateRepository) |
| Writers | certificateRepo.issue() — idempotent on certificate_hash |
| Readers | GenericFlowExecutor (settlement reads certificateRef from ModuleCompletion), LifecycleOrchestrator (handoff), module output resolvers |
| Lifecycle | Write-once (certificate_hash UNIQUE) |
| Invariants | Idempotent: re-issuing same payload+hash returns existing row (replayed=true) |
| **Suspected ownership conflicts** | **Wave 4 transition**: kernels now issue their own certificates (Wave 4). Previously GenericFlowExecutor issued them from magic-bindings (Wave 5 deleted). The magic-bindings path is gone, but some code paths may still have defensive reads from production.bindings (forbidden by no-execution-scoped-lookup.test.mjs). |

---

## STATE-010: task_conflict_keys (the Conflict Model)

| Field | Value |
|---|---|
| Creator | conflict_keys_set / conflict_keys_auto_derive (conflicts.ts) |
| **Authoritative owner** | **Work Dispatch context** |
| Writers | conflict_keys_set (manual), conflict_keys_auto_derive (from task fields: source_ref→file_path, metadata.schema→schema, repository binding→integration_branch) |
| Readers | findNextClaimable (conflict-key gate: blocks dispatch if sibling with overlapping key is in pending/conflict state) |
| Invariants | (1) UNIQUE(task_id, key_type, key_value) (2) key_type IN (file_path, schema, public_protocol, integration_branch) |
| **Suspected ownership conflicts** | None — clean ownership, single context. |

---

## STATE-011: saga3_process_runs (the Production Order)

| Field | Value |
|---|---|
| Creator | processRunRepo.start() — called by LifecycleOrchestrator for each stage |
| **Authoritative owner** | **Conveyor Runtime** |
| Writers | processRunRepo.update() (status transitions: created→preparing→running→settling→completed/failed), renewExecutionLease/acquireExecutionLease (lease management) |
| Readers | GenericFlowExecutor (reads run status, lease), LifecycleOrchestrator, orchestrate-cli |
| Invariants | (1) Lease-based single-driver (CAS on execution_lease_owner + fence) (2) Terminal is final (write-once on outcome/output/certificate) (3) installation_id pinning (Wave 2) |
| Transaction boundary | Lease operations use CAS (compare-and-set on version + lease_owner). Status updates use processRunRepo.update (single statement). |
| **Suspected ownership conflicts** | None — single owner (Conveyor Runtime). But the lease mechanism is custom (not SQLite-native advisory lock) and has a 120s TTL. Two GenericFlowExecutor instances could race if leases expire. In practice, orchestrate-cli is a singleton per epic (PID lock guard). |

---

## STATE-012: saga3_lifecycle_runs (the Lifecycle Run)

| Field | Value |
|---|---|
| Creator | lifecycleRunRepo.start() — called by LifecycleOrchestrator.run |
| **Authoritative owner** | **Lifecycle Composition context** |
| Writers | lifecycleRunRepo (start, resume, bindProcessRun, markStageRunning, completeStage, pauseStage, fail) |
| Readers | LifecycleOrchestrator, lifecycle_run_list MCP tool, tracker-view pipeline view |
| Invariants | (1) Idempotent on (project_id, lifecycle_ref_key, idempotency_key) (2) Terminal is final (3) Transition budget (maxTransitions) |
| **Suspected ownership conflicts** | None — single owner. |

---

## STATE-013: .saga/package-store/ (the Tooling)

| Field | Value |
|---|---|
| Creator | FilesystemModulePackageStore.write() — called by installPackage |
| **Authoritative owner** | **Module Catalog context** (FilesystemModulePackageStore) |
| Writers | installPackage (writes content-addressed blobs keyed by SHA-256 of canonical JSON) |
| Readers | InstallationBasedPackageRegistry (select/has/listSelectors), WorkspacePackageRegistry (getById for workspace materializer) |
| Lifecycle | Immutable (content-addressed). No UPDATE or DELETE. |
| Invariants | (1) digest = sha256(raw bytes) — verified on every read (2) One active installation per (name, version) — partial UNIQUE index |
| **Suspected ownership conflicts** | None — append-only content-addressed store. |

---

## STATE-014: integration_intents (the Integration Intent)

| Field | Value |
|---|---|
| Creator | (Declared in schema.ts, written by worker_merge_acquire path) |
| **Authoritative owner** | **Work Dispatch context** |
| Writers | (Slice 5: durable record of "review approved merging <sha> into <branch>") |
| Readers | (Future: deterministic Git executor for crash recovery) |
| Invariants | (1) UNIQUE intent_key per (repo, task, review-cycle, source-sha, target-branch) (2) State machine: pending→running→merged/conflict/base_advanced/retryable/dead |
| **Suspected ownership conflicts** | Currently UNUSED in production code paths (schema exists, declared in Slice 5, but no active writer found at E3 level). This is a declared-but-not-reached state entity. |
| **Classification:** Fossil candidate (Phase 8 will assess). Declared in ADR-010/011 but the deterministic Git executor that consumes it was never implemented. |

---

## State ownership summary

### Clean ownership (no conflicts)
- tasks (STATE-001) — single-writer invariant enforced
- worker_executions (STATE-002) — clean with documented exception
- saga3_discovery_outcome_certificates (STATE-008) — single writer, write-once
- saga3_process_outcome_certificates (STATE-009) — idempotent issue
- verification_evidence (STATE-007) — single writer
- task_conflict_keys (STATE-010) — single context
- saga3_process_runs (STATE-011) — lease-based
- saga3_lifecycle_runs (STATE-012) — single owner
- .saga/package-store/ (STATE-013) — content-addressed

### Suspected conflicts
- **artifacts + managed-production-ledger (STATE-003 + STATE-005): DUAL WRITE PATH.** Two tables written from the same handler without cross-table transaction. Crash between writes → inconsistency.
- **integration_intents (STATE-014): declared but unreached.** Schema exists, no E3 writer found.

### Cross-cutting observation
**The four product desks (saga3_proposals, saga3_managed_artifact_productions, saga3_managed_node_submissions, saga3_external_effect_events) each have CLEAN ownership within their module — but they are isolated silos.** No cross-desk reads exist except through the LifecycleOrchestrator's declarative handoff (which passes refs, not data). This means:
1. Each module is self-consistent
2. Cross-module data flow is mediated (good)
3. But the mediation uses 4 different mechanisms (certificate ref, artifact ref, submission ref, kernel-only) instead of 1 (FINDING-005)
