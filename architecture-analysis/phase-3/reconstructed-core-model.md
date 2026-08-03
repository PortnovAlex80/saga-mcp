# Reconstructed Core Model

Artifact ID: ART-PHASE3-CORE-MODEL
Artifact Type: Reconstructed Core Model
Phase: Phase Three
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE1-OPERATIONAL-PURPOSE, ART-PHASE2-SCENARIO-MATRIX, ART-PHASE2-STATE-OWNERSHIP, ART-PHASE2-DATA-FLOW, full codebase context
Coverage: All policy functions, invariant enforcement points, calculation hotspots, and decision rules identified from E3-E5 evidence. Runtime-only rules (E6) not assessed.
Confidence: High for identified rules (code-traced); Medium for completeness (some rules may live in untested edge paths)
Referenced Evidence: EVID-001 through EVID-026; FINDING-001 through FINDING-008
Unresolved Questions: QUESTION-002 (saga3/ redistribution), QUESTION-006 (interface duplication)
Known Contradictions: CONTRADICTION-001 (four desks vs one-desk target)
Downstream Dependencies: Phase 4 (Seam Map), Phase 5 (Workload Profile), Phase 6 (Target Architecture)

---

## The Discovery Heuristic

> «The core consists of what remains semantically true when databases, transports, frameworks, queues, drivers, and external technologies are removed.»

Applied to saga-mcp: remove SQLite, remove MCP protocol, remove claude CLI, remove filesystem, remove git. What remains?

### What remains (the core)

1. **Transition gate policies** — WHEN a card may be claimed, WHEN an artifact may be accepted, WHEN a worker may be terminated, WHEN a stage may advance
2. **Content-addressing rules** — HOW a product is hashed, WHAT canonical JSON means, WHICH fields are excluded
3. **Flow routing logic** — HOW a node event maps to the next node, HOW a stage outcome maps to the next stage
4. **Recovery decision logic** — WHEN to retry, WHEN to pause, WHEN to fail, WHAT feedback to give the repair worker
5. **Authority validation** — WHAT tools a worker may call, HOW to verify the frozen snapshot, WHEN to deny
6. **Verification semantics** — WHAT counts as passing evidence, WHAT 4-valued verdict means, WHEN evidence is stale
7. **Risk computation** — HOW final_risk is derived from declared/derived/policy, WHEN it may be lowered
8. **Settlement policies** — Discovery go/clarify/reject decision, Formalization traceability+baseline, Development candidate+evidence, Delivery observe-before-settle

### What does NOT remain (infrastructure)

- SQLite tables and queries (persistence shape)
- MCP protocol handlers (transport)
- claude -p spawn mechanics (external process)
- git worktree/merge (external VCS)
- filesystem package store (storage)
- HTTP server (tracker-view UI transport)
- JSONL log parsing (observability)

### Verdict: the system is NOT a business domain model

The core is not a set of business entities (Order, Customer, Invoice) with behavior. It is a set of **policies, contracts, and decision functions** that govern an external process. The system's nature is:

**A policy engine and contract governance runtime for orchestrating external LLM workers through typed state transitions.**

This means:
- Entities (tasks, artifacts, certificates) are **data carriers**, not behavior-rich domain objects
- The real value lives in **pure functions** that decide transitions
- The architecture should be organized around **policies and contracts**, not around aggregates and entities

---

## Rule and Invariant Catalog

### RULE-001: Review-first dispatch ordering
- **Canonical semantic meaning:** A task in `review` status MUST be assigned before any task in `todo` status at the same priority.
- **Authoritative owner:** `findNextClaimable` (work-assignment-core.ts:311)
- **Current locations:** SQL `ORDER BY CASE WHEN t.status = 'review' THEN 0 ELSE 1 END`
- **Evidence:** E5 (dispatcher-race tests, FINDING from CHANGELOG: T-008 fix)
- **Duplicated enforcement:** None — single SQL query
- **Defensive enforcement:** None
- **Bypass paths:** `SAGA_ALLOW_MANUAL_STATUS=1` escape hatch (admin only)
- **Affected scenarios:** SCN-002, SCN-007
- **Classification:** Technical invariant → stays in dispatch policy
- **Target home:** DispatchPriorityPolicy (pure function or declarative SQL)

### RULE-002: Conflict-key gate (parallel collision prevention)
- **Canonical semantic meaning:** A git_change task MUST NOT be dispatched while another task with an overlapping conflict_key is in `pending` or `conflict` integration state.
- **Authoritative owner:** `findNextClaimable` (work-assignment-core.ts:301-310)
- **Current locations:** SQL `NOT EXISTS (SELECT 1 FROM tasks other JOIN task_conflict_keys ...)`
- **Evidence:** E5 (CHANGELOG: T-008 fix, SIGN-002 scaffold-conflict)
- **Duplicated enforcement:** None
- **Bypass paths:** None (SQL gate)
- **Affected scenarios:** SCN-002 (parallel workers)
- **Classification:** Technical invariant → stays in dispatch policy
- **Target home:** ConflictGatePolicy (pure check)

### RULE-003: Single-writer invariant for task owner columns
- **Canonical semantic meaning:** Only 3 modules + 1 documented exception may write `tasks.{status, assigned_to, current_execution_id}`.
- **Authoritative owner:** `work-assignment-core.ts` (claim), `atomic-release.ts` (release), `legacy-assignment-recovery.ts` (legacy)
- **Documented exception:** `worker-executions.ts:204` (markExecutionExited clears current_execution_id)
- **Evidence:** E5 (source-level lint: tasks-writer-invariant.test.mjs)
- **Duplicated enforcement:** Source-level lint gate + `assertExecutionFence` at every mutation point
- **Bypass paths:** `SAGA_ALLOW_MANUAL_STATUS=1` + `_recovery_override=true` (autonomous-recovery)
- **Affected scenarios:** ALL
- **Classification:** Technical invariant → first-class architectural rule
- **Target home:** WriterInvariant ratchet (fitness function)

### RULE-004: Fence validation (execution identity)
- **Canonical semantic meaning:** Every worker-side mutation MUST present the exact `execution_id` that matches `task.current_execution_id`. A stale or missing execution_id is rejected.
- **Authoritative owner:** `assertExecutionFence` (worker-executions.ts:95)
- **Current locations:** Called from worker_done, verification_record, worker_ask_need, worker_merge_acquire, worker_merge_release, task_update
- **Evidence:** E5 (fenced verdict race tests, 8 parallel processes)
- **Duplicated enforcement:** Every mutating handler calls assertExecutionFence — this is defensive enforcement at each boundary, not duplication of the rule
- **Bypass paths:** Legacy unfenced tasks (current_execution_id IS NULL) — compatibility path
- **Affected scenarios:** SCN-002, SCN-003, SCN-005, SCN-007
- **Classification:** Technical invariant → execution fence policy
- **Target home:** ExecutionFencePolicy (assertFence pure check + caller passes executionId)

### RULE-005: Deny-by-default (4-valued verdict)
- **Canonical semantic meaning:** Only `passed` admits a transition. `failed`, `unknown`, `error` all deny. Missing evidence = denial (not implicit pass).
- **Authoritative owner:** `verification_record` handler (lifecycle.ts:21) + settlement policies (each module's settle handler checks outcome)
- **Current locations:** SQL CHECK constraint on verification_evidence.outcome; each settlement policy checks evidence outcome
- **Evidence:** E5 (cgad-spec-lint R1, REQ-008 convergence)
- **Duplicated enforcement:** cgad-spec-lint R1 audits evidence rows for non-passing outcomes; settlement policies re-check
- **Bypass paths:** T-013 review-loop escape (after ≥2 failed, task closed as done with metadata flag — pragmatic, not a bypass of deny-by-default)
- **Affected scenarios:** SCN-008
- **Classification:** Protocol invariant → verification policy
- **Target home:** DenyByDefaultPolicy (pure verdict check)

### RULE-006: Content-addressed identity (canonical JSON + SHA-256)
- **Canonical semantic meaning:** Every product has a deterministic identity = SHA-256 over canonical JSON (sorted keys, no whitespace). Two products with the same canonical bytes are the same product.
- **Authoritative owner:** `canonicalJson` + `sha256Hex` (saga3/shared/discovery-canonical.ts:28-43)
- **Current locations:** Re-exported from process-modules/shared/canonical-json.ts; used in ALL settlement services, ALL certificate issuance, ALL content_hash computations
- **Evidence:** E5 (hash reproducibility tested in settlement atomicity tests)
- **Duplicated enforcement:** None — single function, single import path (despite 3 re-export locations)
- **Bypass paths:** `artifactDiskHash` uses raw file bytes (not canonical JSON) — DIFFERENT hash for the same content. This is a known duality: canonical JSON hash for payloads, raw byte hash for files.
- **Affected scenarios:** ALL (every product, every certificate)
- **Classification:** Technical invariant → content-addressing primitive
- **Target home:** shared/canonical-json.ts (single module, all import from here)

### RULE-007: Monotonic risk (P15)
- **Canonical semantic meaning:** `final_risk = max(declared_risk, derived_risk, policy_minimum)`. An agent may not self-lower final_risk below derived or policy floor.
- **Authoritative owner:** `computeFinalRisk` (tasks.ts:40) + `enforceP15Monotonicity` (tasks.ts:64)
- **Current locations:** tasks.ts (task_create + task_update); cgad-spec-lint R2b (audit)
- **Evidence:** E5 (REQ-009, R2 lint rule)
- **Duplicated enforcement:** cgad-spec-lint R2b audits final_risk consistency post-hoc
- **Bypass paths:** Direct SQL write (no handler) — but lint catches it
- **Affected scenarios:** SCN-002 (task creation/update)
- **Classification:** Business/security invariant → risk policy
- **Target home:** RiskPolicy (pure function: computeFinalRisk + enforceMonotonicity)

### RULE-008: P18 node-durable identity (recovery card reuse)
- **Canonical semantic meaning:** A recovery attempt reuses the SAME card (task) and the SAME desk (workspace) as the original producer. The generationKey does NOT include `:recovery:caseId:attempt:N`.
- **Authoritative owner:** `LmNodeExecutor` (lm-node-executor.ts:406) computes `generationKey = process-run:<runId>:node:<nodeId>` (no recovery suffix)
- **Current locations:** lm-node-executor.ts:406; buildSagaBoardLineageBag strips recoveryFeedback from stable node-input hash (saga-board-adapter-data-builder.ts:153)
- **Evidence:** E5 (node-durable-identity.test.mjs: 3 tests prove hash stability, feedback isolation, key sharing)
- **Duplicated enforcement:** None — single computation point
- **Bypass paths:** None
- **Affected scenarios:** SCN-003 (recovery)
- **Classification:** Protocol invariant → recovery policy
- **Target home:** NodeDurableIdentityPolicy (generationKey computation + hash stability)

### RULE-009: Exact-candidate acceptance (kernel gate authority)
- **Canonical semantic meaning:** Under managed execution with `artifactAcceptanceAuthority: 'kernel-gate'`, workers keep artifacts in draft/in_review. Only the kernel gate (exactCandidateAcceptance) may flip to accepted, and only with exact id+hash+type matching.
- **Authoritative owner:** `exactCandidateAcceptance.accept()` (sqlite-exact-candidate-acceptance.ts)
- **Enforced at:** KernelNodeExecutor (applies acceptance directive from handler result)
- **Evidence:** E5 (managed execution provenance tests)
- **Duplicated enforcement:** `assertManagedArtifactMutationAuthority` (artifacts.ts:53) rejects worker attempt to set status='accepted' under managed execution
- **Bypass paths:** `artifactAcceptanceAuthority: 'worker'` (legacy modules — backward compat)
- **Affected scenarios:** SCN-001 (formalization), SCN-003 (recovery gate)
- **Classification:** Authority invariant → acceptance policy
- **Target home:** AcceptancePolicy (exactCandidateAcceptance port — already exists)

### RULE-010: Authority scope enforcement (frozen execution context)
- **Canonical semantic meaning:** A worker may call ONLY the tools listed in `authority.allowed_saga_tools` from the execution_context frozen at claim time. Unlisted tools are denied before the handler runs.
- **Authoritative owner:** `authorizeSagaToolCall` (authorize-saga-tool-call.ts:236)
- **Current locations:** index.ts:187 (CallToolRequestSchema handler — the single chokepoint)
- **Evidence:** E5 (authority gateway tests)
- **Duplicated enforcement:** `visibleSagaToolNames` (index.ts:147) ALSO filters the tool LIST (defense-in-depth: invisible + denied)
- **Bypass paths:** `enforcement: 'advisory'` mode (logs but does not block — transitional)
- **Affected scenarios:** SCN-004
- **Classification:** Security invariant → authority policy
- **Target home:** AuthorityPolicy (authorizeSagaToolCall — already a clean pure-ish function)

### RULE-011: Discovery settlement decision (go/clarify/reject)
- **Canonical semantic meaning:** GO requires worker+advisor agreement on readiness + evidence + confidence ≥0.70. REJECT requires worker+advisor agreement on rejection + blocking gaps + confidence ≥0.70. Everything else falls back to CLARIFY.
- **Authoritative owner:** `discoverySettlementPolicyV1.evaluate()` (discovery-settlement-policy.ts:306)
- **Current locations:** Single pure function. Called by Saga3DiscoverySettlementService.
- **Evidence:** E5 (D4 settlement atomicity tests, policy manifest hash tests)
- **Duplicated enforcement:** None — single function, deterministic
- **Bypass paths:** None (kernel-only, no worker access)
- **Affected scenarios:** SCN-001 (Discovery → Formalization gate)
- **Classification:** Business decision → settlement policy
- **Target home:** DiscoverySettlementPolicy (already pure, already correct location)

### RULE-012: Formalization traceability completeness
- **Canonical semantic meaning:** Before a `formalized` certificate is issued: PRD → brief, SRS → PRD, every UC → PRD + ≥1 FR, every AC → ≥1 FR/NFR (+ UC if FR-derived). All artifacts accepted+clean.
- **Authoritative owner:** `findFirstTraceabilityGap` (sqlite-formalization-kernel.ts:168) + `findContractGap` (formalization-installation.ts:1237)
- **Current locations:** TWO implementations of traceability checking:
  - `sqlite-formalization-kernel.ts:168` (SQL-based, used by FormalizationArtifactGraphPort)
  - `formalization-installation.ts:1237` (in-memory, used by formalization handlers)
- **Evidence:** E5 (formalization settlement tests)
- **Duplicated enforcement:** **YES — two independent implementations of the same rule.** The SQL version queries artifact_traces directly. The in-memory version traverses a ContractSnapshot built from graph port reads. They SHOULD produce the same answer but are structurally independent.
- **Bypass paths:** None
- **Affected scenarios:** SCN-001 (formalization gate)
- **Classification:** Business rule → traceability policy
- **Target home:** TraceabilityPolicy (ONE pure function — consolidate the two implementations)
- **SEAM candidate:** Phase 4 will flag this as a model-vs-code seam

### RULE-013: Development task graph validation (DAG + coverage)
- **Canonical semantic meaning:** A task graph must be: unique keys, closed dependencies, acyclic, every AC has required implementation + verification, repositories match DevelopmentCase, integration targets exact.
- **Authoritative owner:** `ReferenceDevelopmentTaskGraphPolicy.validate()` (development-settlement-policy.ts:159)
- **Current locations:** Single pure class. Called by resolve-task-graph kernel handler.
- **Evidence:** E5 (development settlement tests)
- **Duplicated enforcement:** None
- **Bypass paths:** None
- **Classification:** Business rule → task graph policy
- **Target home:** TaskGraphPolicy (already pure)

### RULE-014: Development verified-candidate settlement
- **Canonical semantic meaning:** `verified` requires: frozen candidate + trusted deterministic evidence for every AC + no open human gates. Candidate drift invalidates all prior evidence.
- **Authoritative owner:** `ReferenceDevelopmentSettlementPolicy.settle()` (development-settlement-policy.ts:444)
- **Current locations:** Single pure class (905 lines — the longest policy)
- **Evidence:** E5 (development settlement tests)
- **Duplicated enforcement:** None
- **Classification:** Business rule → development settlement policy
- **Target home:** DevelopmentSettlementPolicy (already pure)

### RULE-015: Delivery observe-before-settle
- **Canonical semantic meaning:** A release is NOT established by a push command response. Settlement requires AUTHORITATIVE OBSERVED STATE matching the desired state.
- **Authoritative owner:** `ReferenceDeliverySettlementPolicy.settle()` (delivery-settlement-policy.ts)
- **Current locations:** Single pure class
- **Evidence:** E4 (tested but fail-closed — no real provider in production)
- **Duplicated enforcement:** Delivery invariant: `delivery.push-is-not-release`
- **Classification:** Business rule → delivery settlement policy
- **Target home:** DeliverySettlementPolicy (already pure)

### RULE-016: Lease-based execution authority
- **Canonical semantic meaning:** An execution's authority to mutate expires when its lease passes. The lease is renewed by the supervisor. When expired, the execution may not clear a newer fence.
- **Authoritative owner:** `decideStuckAction` (stuck-policy.ts:184) — step 1 (remote) and step 2 (local lease expired → RELEASE)
- **Current locations:** Pure policy + `reconcileWorkerExecutions` (mechanism)
- **Evidence:** E5 (stuck-policy table-driven tests)
- **Classification:** Technical invariant → lease policy
- **Target home:** LeasePolicy (pure: decideStuckAction already is)

### RULE-017: Idempotency (command receipts)
- **Canonical semantic meaning:** A retry with the same command_id + same payload_hash returns the stored reply without re-running effects. Same command_id + different payload_hash = IDEMPOTENCY_KEY_REUSED rejection.
- **Authoritative owner:** `checkReceipt` + `storeReceipt` (lifecycle/idempotency.ts)
- **Current locations:** worker_done (dispatcher.ts:468), command_receipts table
- **Evidence:** E5 (Slice 4 idempotency tests)
- **Classification:** Protocol invariant → idempotency policy
- **Target home:** IdempotencyPolicy (checkReceipt + storeReceipt)

### RULE-018: Baseline immutability (frozen contract)
- **Canonical semantic meaning:** Accepted AC baseline hash cannot be edited in place. A drift in accepted content_hash after baseline freeze → `drift_state='drifted'` → gate rejects.
- **Authoritative owner:** `createBaselineFreezerHandler` (formalization-installation.ts:678)
- **Current locations:** baseline freezer kernel handler + `findBaselineDrift` (formalization-installation.ts:1863)
- **Evidence:** E5 (formalization baseline tests)
- **Duplicated enforcement:** `refreshArtifactHash` (artifact-file.ts) re-computes disk hash and sets drift_state
- **Classification:** Protocol invariant → baseline policy
- **Target home:** BaselinePolicy (freeze + drift detection)

---

## Core Model Summary

### The core is a POLICY ENGINE, not a domain model

The system's real center of value is a set of **18 pure decision functions and invariants** that govern transitions. These are:

| # | Rule | Pure function? | Location quality |
|---|---|---|---|
| 001 | Review-first dispatch | SQL (not pure function) | OK — SQL IS the policy |
| 002 | Conflict-key gate | SQL | OK |
| 003 | Single-writer invariant | Lint (source-level) | OK — ratchet |
| 004 | Fence validation | assertExecutionFence (semi-pure) | OK |
| 005 | Deny-by-default | SQL CHECK + policy re-check | OK |
| 006 | Content-addressing | canonicalJson+sha256Hex (pure) | OK — one function |
| 007 | Monotonic risk | computeFinalRisk+enforceP15 (pure) | OK |
| 008 | P18 node-durable identity | generationKey + hash strip (pure) | OK |
| 009 | Exact-candidate acceptance | exactCandidateAcceptance.accept (port) | OK |
| 010 | Authority scope | authorizeSagaToolCall (semi-pure) | OK |
| 011 | Discovery settlement | discoverySettlementPolicyV1 (pure) | EXCELLENT |
| 012 | Formalization traceability | findFirstTraceabilityGap + findContractGap | **DUPLICATED** |
| 013 | Task graph validation | ReferenceDevelopmentTaskGraphPolicy (pure) | EXCELLENT |
| 014 | Verified-candidate settlement | ReferenceDevelopmentSettlementPolicy (pure) | EXCELLENT |
| 015 | Delivery observe-before-settle | ReferenceDeliverySettlementPolicy (pure) | EXCELLENT |
| 016 | Lease expiry | decideStuckAction (pure) | EXCELLENT |
| 017 | Idempotency | checkReceipt+storeReceipt | OK |
| 018 | Baseline immutability | freezer+findBaselineDrift | OK |

### Assessment

**12 of 18 rules are already pure functions** living in the correct architectural position (domain or application layer, zero I/O). This is a strong emergent success — the team's "Uncle Bob Wave" refactoring series successfully extracted pure policies from procedural code.

**4 rules are SQL-embedded** (review-first, conflict-key, deny-by-default CHECK, single-writer lint). These are OK — SQL constraints ARE the policy for these cases. Extracting them into pure functions would add indirection without benefit.

**1 rule is DUPLICATED** (RULE-012: formalization traceability). Two implementations exist and can drift. This is a seam (Phase 4).

**1 rule has a duality** (RULE-006: content-addressing uses canonical JSON hash for payloads but raw byte hash for files). This is known and documented, not a defect — but it means workers must know which hash applies to which product type.

### What the core is NOT

- NOT a CRUD application (no entity has rich behavior beyond status transitions)
- NOT a domain model with aggregates (entities are data carriers; policies are the behavior)
- NOT a pipeline processor (the pipeline is a side effect of stage routing; the VALUE is in the gates)
- NOT a workflow engine (workflow engines manage arbitrary graphs; saga manages a FIXED 4-stage lifecycle with module-specific Flows)
- NOT a microkernel/plugin host (modules don't extend the runtime; they declare content that the runtime executes)

### What the core IS

**A contract-governed state machine with pure transition policies, where:**
- States are task statuses + artifact statuses + stage statuses + execution statuses
- Transitions are gated by pure policy functions
- Products are content-addressed text with schema+hash
- Workers are external processes governed by frozen authority
- Recovery preserves workplace identity across worker changes
- Certificates are immutable proof of settlement decisions

This characterization will be tested against pattern candidates in Phase 6.
