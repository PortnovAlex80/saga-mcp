# Seam Map

Artifact ID: ART-PHASE4-SEAM-MAP
Artifact Type: Seam Map
Phase: Phase Four
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE1-OPERATIONAL-PURPOSE, ART-PHASE2-SCENARIO-MATRIX, ART-PHASE2-STATE-OWNERSHIP, ART-PHASE2-DATA-FLOW, ART-PHASE3-CORE-MODEL, ART-PHASE3-RULE-CATALOG, full codebase context
Coverage: All seam types from protocol §14 assessed. 16 seams identified across intention/model, model/code, code/data, state ownership, transaction, temporal, consistency, failure/recovery, concurrency, and integration contract categories.
Confidence: High (E3-E5 for all seams; each traced to specific code locations)
Referenced Evidence: EVID-001 through EVID-026; FINDING-001 through FINDING-008; RULE-001 through RULE-018
Unresolved Questions: QUESTION-003 (as any extent), QUESTION-005 (dynamic imports)
Known Contradictions: CONTRADICTION-001 (four desks vs one-desk target)
Downstream Dependencies: Phase 5 (Workload Profile), Phase 5.5 (Cross-Cutting Constraints), Phase 6 (Target Architecture)

---

## SEAM-001: Intention versus model — "one desk" intention vs four desks reality

- **Seam type:** Intention versus model
- **Exact code locations:** 
  - saga3_proposals (proposal_submit → src/tools/saga3-proposals.ts:53)
  - saga3_managed_artifact_productions (artifact_create bridge → src/process-modules/persistence/sqlite-managed-production-ledger.ts:313)
  - saga3_managed_node_submissions (process_node_submit → src/tools/process-node-submissions.ts:21)
  - saga3_external_effect_events (kernel-only → src/process-modules/persistence/sqlite-external-effect-ledger.ts)
  - saga3_process_products (universal desk — EXISTS but used only by Development: src/process-modules/persistence/sqlite-process-product-repository.ts)
- **Exact mismatch:** CONVEYOR-MENTAL-MODEL.md v2 declares "one machine, one material, one desk" as the target architecture. The code has four module-specific desks plus one universal desk that only one module uses. The intention (universal desk) exists as infrastructure but is not wired to three of four modules.
- **Affected scenarios:** SCN-001 (steps 9→13→15→21 — four desk translations), SCN-006 (cross-module handoff works only via certificate ref, not via universal product read)
- **Affected state:** STATE-003 (artifacts), STATE-004 (proposals), STATE-005 (managed-artifact-productions), STATE-006 (managed-node-submissions)
- **Consequences:** Adding a new module requires choosing or creating a desk. LEGO contract broken. Cross-module product reads require module-specific resolvers.
- **Confidence:** High — confirmed in production paths (E2-E5)
- **Classification:** Architectural debt — the target is known, the infrastructure exists, the migration is not done.

## SEAM-002: Model versus code — "module as self-contained hexagon" vs distributed module

- **Seam type:** Model versus code
- **Exact code locations:**
  - Discovery module spread across: `modules/discovery/` (definition + installation), `saga3/domain/` (settlement policy, proposal types), `saga3/application/` (settlement service), `saga3/persistence/` (SQLite runtime), `saga3/authority/` (execution context), `saga3/shared/` (canonical JSON)
  - Formalization module spread across: `modules/formalization/` (definition + installation), `infrastructure/process-modules/formalization/` (SQLite kernel graph), `src/tools/artifacts.ts` (MCP bridge)
  - Development module spread across: `modules/development/` (definition + installation + settlement), `infrastructure/process-modules/development/` (SQLite store)
  - Delivery module spread across: `modules/delivery/` (definition + installation), `infrastructure/process-modules/delivery/` (SQLite runtime)
- **Exact mismatch:** The conceptual model says "a module is a workshop — a self-contained package." The code distributes each module across 2-4 root directories. Understanding Discovery requires reading files in `modules/discovery/` AND `saga3/` AND `src/tools/`. A developer (or agent) cannot understand one module without crossing directory boundaries that should be internal.
- **Affected scenarios:** ALL (every scenario touches at least one module)
- **Consequences:** Cognitive load per module is ~8-12 files across 4 directories instead of ~4-6 files in one directory. This is the primary driver of the "glass ceiling" (QUESTION-007).
- **Confidence:** High — structural fact verified from file manifest
- **Classification:** Structural debt — modules need physical consolidation.

## SEAM-003: Code versus data — artifact four representations

- **Seam type:** Code versus data
- **Exact code locations:**
  - Representation 1: `artifacts` table row (src/schema.ts, written by artifact_create handler at src/tools/artifacts.ts:90)
  - Representation 2: `saga3_managed_artifact_productions` row (written by recordManagedArtifactProduction at sqlite-managed-production-ledger.ts:313)
  - Representation 3: `.md` file on disk (written by worker via Write/Edit tools)
  - Representation 4: `FormalizationArtifactSnapshot` in-memory type (formalization-kernel-ports.ts:136, constructed by SqliteFormalizationArtifactGraph)
- **Exact mismatch:** An artifact exists as four different representations. The disk file is authoritative for `content_hash` (via artifactDiskHash). The artifacts table is authoritative for `status`. The managed-ledger is authoritative for `provenance`. The in-memory snapshot is what the kernel handler reasons about. No single representation is the source of truth — each owns a different aspect.
- **Affected scenarios:** SCN-001 (formalization steps), SCN-003 (recovery — kernel reads managed-ledger for provenance, artifacts table for status)
- **Affected state:** STATE-003 (artifacts), STATE-005 (managed-artifact-productions)
- **Consequences:** FINDING-007 (split-brain): crash between artifact table write and managed-ledger write leaves status and provenance inconsistent. Content hash duality (canonical JSON vs raw bytes).
- **Confidence:** High — E5 evidence, production paths
- **Classification:** Data model seam — four representations should be consolidated or their boundaries made explicit.

## SEAM-004: State ownership — markExecutionExited fourth writer

- **Seam type:** State ownership seam
- **Exact code locations:**
  - `markExecutionExited` (worker-executions.ts:190-219) — clears `tasks.current_execution_id` while zeroing worker_pid metadata
  - Single-writer set declares 3 allowed writers: work-assignment-core.ts, atomic-release.ts, legacy-assignment-recovery.ts
  - Source comment: "FU-D will consolidate this duplicate into releaseExecutionAtomically"
- **Exact mismatch:** The single-writer invariant (RULE-003) declares 3 writers for `tasks.{status, assigned_to, current_execution_id}`. But `markExecutionExited` is a FOURTH writer of `current_execution_id` (sets it to NULL). It is documented as an exception, but it breaks the invariant's cleanliness.
- **Affected state:** STATE-001 (tasks), STATE-002 (worker_executions)
- **Consequences:** A future refactor that moves markExecutionExited without updating the lint allowlist would silently violate the invariant. The exception is a load-bearing hack — markExecutionExited is called from ClaudeBoardRunner's close callback, which runs on a different code path than releaseExecutionAtomically.
- **Confidence:** High — E5, documented in source comments
- **Classification:** Load-bearing hack — needs isolation behind releaseExecutionAtomically before further decomposition.

## SEAM-005: State ownership — artifacts table split authority

- **Seam type:** State ownership seam
- **Exact code locations:**
  - `artifact_create` handler (artifacts.ts:90) writes to `artifacts` table (status, content_hash, accepted_hash, drift_state)
  - `exactCandidateAcceptance.accept` (sqlite-exact-candidate-acceptance.ts) ALSO writes to `artifacts` table (status: draft→accepted, accepted_hash, drift_state: clean) via atomic CAS
  - `artifact_update` handler (artifacts.ts:390) writes to `artifacts` table (title, path, code, status, etc.)
  - `refreshArtifactHash` (artifact-file.ts) writes content_hash and drift_state from disk
- **Exact mismatch:** Four different writers mutate the artifacts table, each owning a different subset of columns. `artifact_create` owns initial creation. `exactCandidateAcceptance` owns status→accepted transition. `artifact_update` owns mutable metadata. `refreshArtifactHash` owns content_hash from disk. No single component owns "the artifact's complete state."
- **Affected state:** STATE-003 (artifacts)
- **Consequences:** A race between `refreshArtifactHash` (disk-based) and `exactCandidateAcceptance.accept` (CAS-based) could flip drift_state inconsistently if the disk file changes between acceptance and hash refresh.
- **Confidence:** Medium — E5 for individual paths, but the race window is theoretical (in practice, acceptance happens after hash refresh)
- **Classification:** State ownership seam — needs a single authoritative owner or explicit column-level partition.

## SEAM-006: Transaction — worker_done non-atomic dependency release

- **Seam type:** Transaction seam
- **Exact code locations:**
  - `handleWorkerDone` (dispatcher.ts:412-710): status transition + comment insert + integration_state set happen under BEGIN IMMEDIATE (steps 3-6)
  - `reevaluateDownstream` (tasks.ts:373): auto-block/unblock dependent tasks — called AFTER the transaction commits (step 5 in the handler, but outside the immediate tx scope for some paths)
- **Exact mismatch:** The logical operation "complete this task AND release its dependents" spans two transaction boundaries. A crash between the worker_done commit and the dependency reevaluation leaves downstream tasks blocked even though their dependency is done.
- **Affected state:** STATE-001 (tasks — downstream status)
- **Consequences:** FINDING-008: downstream tasks may be permanently blocked if the engine crashes at the wrong moment. The reaper does NOT re-evaluate dependencies — it only handles execution fence cleanup.
- **Confidence:** Medium — the race window is narrow (dependency reevaluation runs synchronously after the transaction), and the engine calls `reevaluateDownstream` every cycle. But under crash conditions, a manual intervention would be needed.
- **Classification:** Transaction seam — dependency reevaluation should be inside the same BEGIN IMMEDIATE as the status transition.

## SEAM-007: Transaction — artifacts + managed-ledger dual write

- **Seam type:** Transaction seam
- **Exact code locations:**
  - `handleArtifactCreate` (artifacts.ts:90): 
    1. INSERT/UPDATE artifacts table (inside `db.transaction(() => handleArtifactCreate(args)).immediate()`)
    2. `recordManagedArtifactProduction(db, artifact, ...)` — writes to saga3_managed_artifact_productions
  - The managed-ledger write happens INSIDE the same `immediate()` transaction when under managed execution (artifacts.ts:93-94), BUT `recordManagedArtifactProduction` calls `resolveManagedExecutionProvenance` which opens its OWN read path.
- **Exact mismatch:** Two table writes in one transaction (good), but the managed-ledger write's provenance resolution reads `worker_executions` and `saga3_process_runs` — if those rows changed between the artifacts INSERT and the ledger INSERT (within the same transaction), the provenance would be stale. Under WAL mode, the transaction sees a consistent snapshot, so this is theoretically safe. But the pattern is fragile: adding a write between the two would break the invariant.
- **Affected state:** STATE-003 (artifacts), STATE-005 (managed-artifact-productions)
- **Consequences:** If managed-ledger write fails (e.g., schema validation), the artifact is created but provenance is lost. The artifact exists but its kernel handler cannot find it via `listArtifactsForNodeInProcessRun`.
- **Confidence:** Medium — the transaction IS atomic (both writes in one BEGIN IMMEDIATE), but the semantic dependency between them is implicit
- **Classification:** Transaction seam — should be explicitly coupled or the managed-ledger write should be a trigger/after-hook.

## SEAM-008: Temporal — authority snapshot must be captured before spawn

- **Seam type:** Temporal seam
- **Exact code locations:**
  - `findNextClaimable` (work-assignment-core.ts:341-358): captures execution_context (model_route + authority) and INSERTs into worker_executions.metadata
  - `ClaudeBoardRunner.launch` (claude-runner.mjs:706-708): reads execution_context from worker_executions to determine model args
  - `authorizeSagaToolCall` (authorize-saga-tool-call.ts:156): reads execution_context from worker_executions to authorize tool calls
- **Exact mismatch:** The authority snapshot is captured at claim time. If the model route or authority scope changes between claim and spawn (e.g., operator changes model via POST /api/model/set), the spawned worker uses the OLD route but the MCP gateway validates against the OLD authority. This is CORRECT (frozen snapshot = no drift) but creates a temporal coupling: the claim path MUST capture both model_route AND authority in the same transaction.
- **Affected state:** STATE-002 (worker_executions.metadata.execution_context)
- **Consequences:** If findNextClaimable captured model_route but not authority (bug), the worker would spawn with the right model but have NO tool restrictions. This is prevented by executionContextHash (which covers both), but the coupling is implicit.
- **Confidence:** High — the hash covers both fields, preventing partial capture
- **Classification:** Temporal seam — correct by construction, but the coupling should be made explicit (single `freezeExecutionContext` function that captures both atomically).

## SEAM-009: Consistency — discovery diagnosis handlers registered but flow node removed

- **Seam type:** Consistency seam (dead representation)
- **Exact code locations:**
  - `discovery-process-module.ts:139-153`: "Д2: D5 Diagnosis REMOVED from the outcome-critical flow"
  - `discovery-installation.ts:130-137`: `createDiscoveryKernelHandlers` registers 6 handlers — does NOT include diagnosis
  - BUT `src/index.ts:51,109`: `createSaga3DiagnosisHandlers()` IS registered in ALL_TOOLS and ALL_HANDLERS
  - AND `discovery-process-module.ts:297-313`: `discovery-diagnosis-advisor` execution profile IS declared
- **Exact mismatch:** Diagnosis MCP tools (diagnosis_get, diagnosis_submit) and the diagnosis execution profile are registered and reachable. But no Flow node activates them — the diagnosis path was removed from the outcome-critical flow. The tools are live orphans: callable but never called by the lifecycle.
- **Affected scenarios:** None (diagnosis is advisory-only, runs AFTER ProcessRun completion per the comment)
- **Consequences:** An agent could call `diagnosis_submit` and it would succeed — but the result would never be consumed by any Flow. Cognitive noise for agents exploring the tool list.
- **Confidence:** High — E2 (registered), E3 (reachable), but no Flow path activates
- **Classification:** Fossil candidate — Phase 8 will assess whether to remove or reactivate.

## SEAM-010: Consistency — formalization traceability duplicated

- **Seam type:** Consistency seam (RULE-012 from Phase 3)
- **Exact code locations:**
  - Implementation 1: `SqliteFormalizationArtifactGraph.findFirstTraceabilityGap` (sqlite-formalization-kernel.ts:168) — SQL JOINs on artifact_traces
  - Implementation 2: `findContractGap` (formalization-installation.ts:1237) — in-memory traversal of ContractSnapshot built from FormalizationCanonicalGraphPort reads
- **Exact mismatch:** Two independent implementations of "is the formalization traceability graph complete?" They check the same edges (PRD→brief, UC→PRD+FR, AC→FR/NFR+UC, SRS→PRD) but use different data access patterns. Implementation 1 queries SQL directly; Implementation 2 traverses an in-memory snapshot. If the snapshot construction (buildContractSnapshot) drifts from the SQL query (e.g., a new artifact type is added to one but not the other), they will disagree.
- **Affected rules:** RULE-012 (formalization traceability)
- **Consequences:** A traceability gap could be detected by one implementation but missed by the other. In practice, Implementation 2 (in-memory) runs first (in the handler); Implementation 1 (SQL) is available via the port but used by the settlement policy which delegates to Implementation 2's result.
- **Confidence:** High — E5, both implementations inspected
- **Classification:** Model-vs-code seam — consolidate into one canonical pure function that takes a graph snapshot as input.

## SEAM-011: Concurrency — SQLite BEGIN IMMEDIATE as sole serialization

- **Seam type:** Concurrency seam
- **Exact code locations:**
  - `findNextClaimable` (work-assignment-core.ts:90): `withImmediateTransaction(db, ...)` — write-locks the ENTIRE database
  - `handleWorkerDone` (dispatcher.ts:773): same
  - `releaseExecutionAtomically` (atomic-release.ts:257): `db.transaction(...)` — DEFERRED (caller must provide IMMEDIATE context)
  - `merge-lock` (dispatcher.ts:1117): project_repositories.metadata JSON column under BEGIN IMMEDIATE
- **Exact mismatch:** All concurrency control is "BEGIN IMMEDIATE on the shared SQLite database." This serializes ALL writers globally — no two writes can proceed in parallel, even if they touch different tasks, different modules, or different repositories. For a single-machine saga with 3-4 workers, this is fine. But it is an architectural ceiling: scaling beyond ~10 concurrent workers would hit SQLite lock contention.
- **Affected state:** ALL (every write goes through BEGIN IMMEDIATE)
- **Consequences:** The system cannot scale beyond one machine or ~10 concurrent workers without changing the concurrency model. Advisory locks on scope (per-task, per-repository) would allow parallelism.
- **Confidence:** High — structural fact
- **Classification:** Architectural ceiling — not a bug, but a scaling limit. Phase 5 will profile the workload.

## SEAM-012: Concurrency — merge-lock stale detection vs isProcessAlive

- **Seam type:** Concurrency seam
- **Exact code locations:**
  - `handleWorkerMergeAcquire` (dispatcher.ts:1159-1175): `isStale = ageMs > MERGE_LOCK_STALE_MIN * 60_000`; `holderAlive = isProcessAlive(exec.pid)`
  - Reclaim condition: `!lock || (isStale && !holderAlive)`
- **Exact mismatch:** The merge lock can be reclaimed after 10 minutes IF the holder's PID is not alive. But `isProcessAlive` uses `process.kill(pid, 0)` which checks if ANY process has that PID. On Windows, PID reuse is fast. The `process_birth_token` check (used in the reaper for TERMINATE decisions) is NOT applied here — merge-lock stale reclaim uses PID only, not PID+birth-token.
- **Affected state:** `project_repositories.metadata.merge_lock`
- **Consequences:** A PID reuse scenario (stale worker PID reassigned to an unrelated process) would cause the merge lock to be reclaimed from a "live" (but wrong) holder. The unrelated process would NOT be killed (the reclaim just clears the lock), but a second worker could grab the lock and merge while the first is still mid-merge.
- **Confidence:** Medium — the window is narrow (10 min stale + PID reuse), and the consequence is a merge conflict (not data corruption — git handles that), but it IS a correctness gap
- **Classification:** Concurrency seam — merge-lock reclaim should verify PID+birth-token, same as the reaper.

## SEAM-013: Failure/recovery — git merge crash window

- **Seam type:** Failure and recovery seam
- **Exact code locations:**
  - `worker_merge_release` (dispatcher.ts:1206): records result='merged' or 'conflict' AFTER the git merge completes
  - The git merge itself happens in the worker process (claude -p spawns bash: `git merge --no-ff task/<id>`)
  - `integration_intents` table (STATE-014): declared in schema for durable crash recovery, but NO ACTIVE WRITER at E3 level
- **Exact mismatch:** The git merge is an external side effect that can partially complete (merge succeeds, but worker crashes before calling worker_merge_release). The durable recovery mechanism (integration_intents) was designed (ADR-010) but never implemented. Recovery currently relies on a future LLM healer reading the task and guessing whether the merge happened.
- **Affected scenarios:** SCN-002 (steps 9-10)
- **Consequences:** A crashed worker mid-merge leaves the repository in an unknown state. The task stays `done + integration_state=pending`. Another worker may attempt to re-merge and hit a conflict (because the first merge actually succeeded). This is the SPECIFIC problem ADR-010 was designed to solve — and the solution (integration intents + deterministic Git executor) was never built.
- **Confidence:** High — E0 (schema declared), E1 (ADR-010 documents the design), E2 (integration_intents table exists), but NO E3 writer found
- **Classification:** Failure/recovery seam — load-bearing gap. The declared solution needs implementation, or the system accepts "merge crash = manual recovery."

## SEAM-014: Integration contract — claude CLI as implicit contract

- **Seam type:** Integration contract seam
- **Exact code locations:**
  - `ClaudeBoardRunner.launch` (claude-runner.mjs:770-881): constructs claude -p args (`--model`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--output-format stream-json`, `--verbose`, `--forward-subagent-text`, `--no-session-persistence`)
  - The claude CLI version is NOT pinned or checked. `SAGA_CLAUDE_PATH` env var defaults to 'claude'.
- **Exact mismatch:** The system assumes a specific claude CLI behavior (stdin prompt reading, stream-json output, MCP config format, hook system). But the claude CLI is an external binary that can change between versions. There is no version check, no capability detection, no contract test for the CLI interface.
- **Affected scenarios:** ALL worker scenarios
- **Consequences:** A claude CLI update that changes stdin behavior, stream-json format, or MCP config handling would silently break every worker. The CHANGELOG documents this: "claude v2.x settings.json wins over env" required a defensive workaround.
- **Confidence:** High — documented in CHANGELOG and CLAUDE.md
- **Classification:** Integration contract seam — needs version detection or capability negotiation.

## SEAM-015: Integration contract — LM Studio model-card assumption

- **Seam type:** Integration contract seam
- **Exact code locations:**
  - `claude-runner.mjs:710-718`: `isLmstudio = am.provider === 'lmstudio' && am.model`; if true, omits `--effort` flag
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144'` hardcoded for LM Studio (claude-runner.mjs:904)
  - `tracker-view.mjs`: `/api/lmstudio/models` fetches model list from LM Studio
- **Exact mismatch:** The system assumes LM Studio models need `--effort` omitted, have a 262144 context window, and use `ANTHROPIC_BASE_URL` redirect. These are assumptions about a specific external service that can change.
- **Affected scenarios:** SCN-002 (worker spawn with LM Studio)
- **Consequences:** A new LM Studio version with different context window or different effort handling would produce suboptimal worker configurations.
- **Confidence:** Medium — E4 (configured), documented in CLAUDE.md
- **Classification:** Integration contract seam — model card should be queried, not assumed.

## SEAM-016: Composition root as God Object — knowledge concentration

- **Seam type:** Intention versus model (FINDING-004)
- **Exact code locations:** `product-lifecycle-runtime.ts` (780 lines, 40+ imports, constructs ALL concrete adapters for ALL 4 modules)
- **Exact mismatch:** The LEGO principle says "adding a module = creating a package." But adding a 5th module today requires editing THIS FILE (add imports, add register call, add wiring). The composition root KNOWS about every module's internal needs (which ledger, which graph port, which settlement policy, which output resolver).
- **Affected scenarios:** ALL
- **Consequences:** Every module change risks breaking the composition root. Every new module increases this file's size. An agent cannot understand "how to add a module" without reading this file — and at 780 lines, it consumes significant context.
- **Confidence:** High — structural fact
- **Classification:** Structural debt — modules should self-register via a `register(deps)` interface.

---

## Seam Summary

### By type

| Seam type | Count | Seams |
|---|---|---|
| Intention versus model | 2 | SEAM-001 (four desks), SEAM-016 (God Object composition) |
| Model versus code | 1 | SEAM-002 (distributed modules) |
| Code versus data | 1 | SEAM-003 (four artifact representations) |
| State ownership | 2 | SEAM-004 (markExecutionExited), SEAM-005 (artifacts split authority) |
| Transaction | 2 | SEAM-006 (non-atomic deps), SEAM-007 (dual write) |
| Temporal | 1 | SEAM-008 (authority capture before spawn) |
| Consistency | 2 | SEAM-009 (dead diagnosis), SEAM-010 (duplicated traceability) |
| Concurrency | 2 | SEAM-011 (SQLite ceiling), SEAM-012 (merge-lock PID reuse) |
| Failure/recovery | 1 | SEAM-013 (git merge crash window) |
| Integration contract | 2 | SEAM-014 (claude CLI), SEAM-015 (LM Studio) |

### By severity (architectural impact)

**Critical (blocks LEGO principle or correctness):**
- SEAM-001: Four desks — breaks module independence
- SEAM-002: Distributed modules — breaks module autonomy
- SEAM-013: Git merge crash window — correctness gap in recovery
- SEAM-016: God Object composition — blocks scaling modules

**Significant (causes inconsistency or limits scaling):**
- SEAM-003: Four artifact representations — data model confusion
- SEAM-004: markExecutionExited fourth writer — invariant impurity
- SEAM-005: Artifacts split authority — race potential
- SEAM-006: Non-atomic dependency release — crash gap
- SEAM-010: Duplicated traceability — rule drift potential
- SEAM-011: SQLite ceiling — scaling limit

**Moderate (known and documented):**
- SEAM-007: Dual write (actually in one transaction — better than feared)
- SEAM-008: Temporal coupling (correct by hash construction)
- SEAM-012: Merge-lock PID reuse (narrow window, conflict not corruption)
- SEAM-014: Claude CLI contract (external, version-dependent)
- SEAM-015: LM Studio assumptions (external, configurable)

**Low (cleanup opportunity):**
- SEAM-009: Dead diagnosis handlers (cognitive noise, no functional impact)

### Relationship to Phase 3 rules

| Seam | Rule affected | Impact |
|---|---|---|
| SEAM-001 | (no specific rule — architectural shape) | Four desks prevent universal product read |
| SEAM-004 | RULE-003 (single-writer) | Fourth writer breaks invariant cleanliness |
| SEAM-005 | RULE-009 (exact-candidate acceptance) | Split authority on artifacts table |
| SEAM-007 | RULE-006 (content-addressing) | Dual write is in one tx (OK), but pattern is fragile |
| SEAM-010 | RULE-012 (formalization traceability) | Duplicated implementation can drift |
| SEAM-012 | RULE-016 (lease expiry) | Merge-lock PID reuse weaker than reaper PID+token |
| SEAM-013 | (no rule — undeclared gap) | integration_intents declared but not wired |
