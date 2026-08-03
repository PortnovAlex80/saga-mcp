# Reconstructed Operational Purpose

Artifact ID: ART-PHASE1-OPERATIONAL-PURPOSE
Artifact Type: Reconstructed Operational Purpose
Phase: Phase One
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE0-EXECUTABLE-TOPOLOGY, ART-PHASE0-EVIDENCE-LEDGER, full codebase context (≈890k tokens), tracker activity log (Autism-Buttons epic, real production run)
Supersedes: none
Coverage: Production execution paths (E3-E5). No E6 (runtime telemetry). One real production run (Autism-Buttons GLM) used as behavioral evidence.
Confidence: High for observed operational behavior; Medium for business intent hypotheses
Referenced Evidence: EVID-001 through EVID-026; CONTRADICTION-001 (four-desks gap)
Unresolved Questions: QUESTION-001 (runtime desk usage), QUESTION-007 (glass ceiling hypothesis)
Known Contradictions: CONVERYOR-MENTAL-MODEL.md v2 claims "one machine, one material, one desk" as target; code shows four desks in active use
Downstream Dependencies: Phase 2 (Scenario-Component Matrix), Phase 3 (Real Core), Phase 5 (Workload Profile)

---

## Part A — Observed Operational Purpose

### A.1 System Actors

| Actor | Interaction surface | Evidence |
|---|---|---|
| **Human operator** | tracker-view web UI (port 4321): creates project from idea, monitors kanban, restarts engine, changes model, views worker tails | EVID-012 (ClaudeBoardRunner), tracker-view.mjs endpoints. Observed in Autism-Buttons activity log: "POST /api/project/create-from-idea" → project creation at 2026-07-30 14:27 |
| **MCP client (ZCode)** | stdio MCP protocol: calls saga tools (task_get, worker_next, worker_done, artifact_create, proposal_submit, etc.) | EVID-001 (index.ts main), EVID-002 (CallToolRequestSchema handler). Every tool call passes through authorizeSagaToolCall gateway |
| **Claude CLI worker** | spawned by ClaudeBoardRunner as `claude -p` child process. Receives assignment via prompt. Communicates with saga via per-execution MCP child (SAGA_EXECUTION_ID) | EVID-012 (claude-runner.mjs:680 launch). Observed in Autism-Buttons: worker_pid=26168 on task #20 at 2026-07-30 18:12 |
| **Orchestration CLI** | detached background process. Runs lifecycle loop: runEpisode → distributeQueuedTasks → resume | EVID-021 (orchestrate-cli.ts:272 main loop). Spawned by tracker-view on "create-from-idea" |
| **LM Studio (optional)** | local Anthropic-compatible endpoint. Worker claude CLI redirected via ANTHROPIC_BASE_URL env | claude-runner.mjs:895 lmstudioEnv. Model dropdown in tracker-view |

### A.2 External Systems

| System | Interaction | Evidence |
|---|---|---|
| **SQLite** | Primary state store. All tables in DB_PATH. WAL mode, busy_timeout=5000. Shared between MCP server, orchestrate-cli, and tracker-view | EVID-001, schema.ts, db.ts:22-26 |
| **Filesystem** | `.saga/package-store/` (content-addressed module packages), `.worktrees/task-<id>/` (worker isolation), `docs/requirements/REQ-NNN-*/` (artifact .md files), worker JSONL logs | EVID-026 (installProductionModules), claude-runner.mjs worktree lifecycle |
| **Git** | `git worktree add` (isolation), `git merge --no-ff` (integration), `git rev-parse HEAD` (base commit resolution) | saga-worker SKILL.md WORKTREE LIFECYCLE, start-product-lifecycle-from-idea.ts:127 |
| **Claude CLI (`claude -p`)** | External binary. Spawned with `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--output-format stream-json`. Reads prompt from stdin | EVID-012 (claude-runner.mjs launch) |
| **`~/.claude/settings.json`** | Patched by `POST /api/model/set` to change active model. Worker claude CLI reads this | tracker-view.mjs model/set endpoint |

### A.3 Primary Operations (what the system observably does)

**Operation 1: Transform a phrase into a working product.**

The system accepts a one-phrase idea from a human operator and drives it through a sequence of LM-driven stages until code exists in a git repository. This is not a claim from the README — it is traced through the executable topology:

```
startProductLifecycleFromIdea (E4)
  → assembleProductLifecycleInput({ idea })
  → spawn orchestrate-cli (detached)
  → orchestrate-cli main loop (EVID-021):
      runEpisode → LifecycleOrchestrator → GenericFlowExecutor.walk
        → LmNodeExecutor → assignTask → spawn claude -p
        → claude -p reads skill, does work, calls worker_done
        → kernel handler resolves product, emits certificate
      → route to next stage
      → if paused (development waits for workers): distributeQueuedTasks
```

Evidence: Autism-Buttons epic progressed from project creation (2026-07-30 14:27) through Discovery (brief artifact #59 created), Formalization (PRD tasks #3-5 done), Development (dev tasks #8-9 done), and into Verification (AC tasks #18-20 reached in_progress). Task #20 has `worker_pid=26168` — a real OS process was spawned.

**Operation 2: Govern every state transition through deterministic gates.**

Every change to task status, artifact acceptance, and stage progression passes through a gate:

- Task status: only `worker_next`/`worker_done` may change it (EVID-004, EVID-015). `task_update` silently ignores `status` field.
- Artifact acceptance: `exactCandidateAcceptance.accept()` performs atomic CAS (EVID-017). Workers keep artifacts in `draft`; only the kernel gate may flip to `accepted`.
- Stage progression: `routeProcessOutcome` uses declarative `outcomeRoutes` table — no code branches on module name.
- Tool calls: `authorizeSagaToolCall` validates frozen execution_context on every MCP call (EVID-003).

Evidence: The Autism-Buttons run shows task #20 returning from `review_in_progress` to `todo` via `changes_requested` verdict (activity log 2026-07-30 18:14:42). The verification evidence for AC #46 was `failed` (18:14:37) — deny-by-default.

**Operation 3: Produce immutable text artifacts with content-addressed provenance.**

Every LM worker, in every workshop, produces text. The system treats all products uniformly at the physical level — they have a `schema`, a `ref`, and a `content_hash` — but stores them in four separate tables (CONTRADICTION-001):

| Workshop | Product | Table | Submit tool | Schema |
|---|---|---|---|---|
| Discovery | Proposal | saga3_proposals | proposal_submit | saga3.discovery-proposal.v1 |
| Formalization | PRD/UC/AC/SRS/FR/NFR/RULE | saga3_managed_artifact_productions | artifact_create (bridged) | saga3.formalization-*-bundle.v1 |
| Development | Task graph proposal | saga3_managed_node_submissions | process_node_submit | saga3.development-task-graph-proposal.v1 |
| Delivery | Publication/observation | saga3_external_effect_events | (kernel-only, no submit tool) | saga3.delivery-*.v1 |

**FINDING-001: Four-desks gap is confirmed in production paths.**
- Classification: observed
- Evidence Level: E2 (tables exist), E3 (handlers reach them), E5 (tests write to them), production activity log shows artifacts created in Autism-Buttons run
- Affected Scenarios: every cross-module handoff (Discovery → Formalization reads proposals; Formalization → Development reads artifacts; Development → Delivery reads submissions)
- This is the primary evidence for the hypothesis that the system is fundamentally a text-artifact pipeline where the four desks are accidental, not essential.

**Operation 4: Recover from worker death without losing work.**

When a claude -p process dies (crash, kill, rate-limit exhaustion), the system:
1. Detects death via OS PID probe + process-birth-token verification (EVID-007)
2. Releases the execution fence atomically (EVID-005)
3. Returns the card to its queue (todo or review)
4. A new worker claims the same card and sees prior work

The workplace (node) is the durable entity. The worker is disposable. The card (task) and desk (workspace) survive worker replacement.

Evidence: Task #20 in Autism-Buttons has `current_execution_id: "exec-1-7536-..."` but `assigned_to: null` — a zombie state where the worker died but the fence was not cleaned. Task #19 is in `in_progress` with no executor — same pattern. These are OBSERVED production failure states that the reaper is designed to fix but did not (possibly because the engine was stopped, not crashed).

**Operation 5: Enforce independent verification (no self-approval).**

The system structurally separates Builder from Verifier:
- Builder (saga-worker) writes code in `.worktrees/task-<id>/`, commits to `task/<id>` branch
- Verifier (saga-verifier) generates L3 property tests from the frozen AC contract, NOT from Builder's tests
- Evidence is 4-valued (passed/failed/unknown/error); only `passed` admits a transition
- Verification task owns exactly one canonical AC (`verification_target_artifact_id`); cross-AC evidence is rejected

Evidence: Autism-Buttons task #20 recorded `outcome=failed` for AC #46 (2026-07-30 18:14:37) — a real verification failure that blocked progression.

### A.4 Observable Capabilities (what the system can do when running)

| Capability | How observed | Evidence |
|---|---|---|
| Accept one-phrase idea and produce working code | Autism-Buttons: 10 tasks done, code in autism-buttons repo | E4 (configured), production activity log |
| Run multiple workers in parallel | dispatch-loop concurrency=N, worktree isolation | EVID-020, E5 (dispatcher-race tests: 8 parallel, no double-claim) |
| Recover from worker crash | decideStuckAction → releaseExecutionAtomically → re-dispatch | EVID-005, EVID-006, E5 |
| Enforce authority per execution | frozen execution_context, AUTHORITY_DENIED on unlisted tools | EVID-003, EVID-024, E5 |
| Record immutable evidence | verification_evidence (4-valued), runtime_observations (append-only) | E5, schema.ts CHECK constraints |
| Handle merge conflicts | worker_merge_release(result:"conflict") → needs-human tag | EVID-015, E5 (35/35 worktree/review/merge tests pass) |
| Pause and resume lifecycle | Development settlement returns runtimeEvent:'paused'; orchestrate-cli drains queue, resumes | EVID-010, EVID-021, E5 |
| Install immutable module packages | content-addressed store, packageDigest pinning | EVID-026, E4 |
| Lint CGAD invariants | 18 deterministic rules, read-only DB audit | cgad-spec-lint.mjs, E5 |

### A.5 Center of Gravity

**FINDING-002: The center of gravity is the transition gate, not the artifact.**
- Classification: inferred
- Evidence Level: E3-E5
- Evidence: The system's most complex and most tested code is NOT artifact production (which is delegated to claude -p) but the TRANSITION MECHANICS between states:
  - `findNextClaimable` (E5, 8-way race-tested) — who gets the card
  - `releaseExecutionAtomically` (E5) — who releases the card
  - `decideStuckAction` (E5, pure function) — when to kill a worker
  - `exactCandidateAcceptance.accept` (E5) — when to accept an artifact
  - `authorizeSagaToolCall` (E5) — what tools a worker may call
  - `discoverySettlementPolicyV1` (E5, pure) — when to issue a certificate
  - `validateProcessModuleRunResult` (E5) — what constitutes a valid outcome

The LM (claude -p) is EXTERNAL to the system. The system does not generate text — it governs the conditions under which an external text generator may act, and it records what the external generator produced. The system's value is in the gates, not in the text.

**FINDING-003: The system is a state-machine engine for governing external LLM workers, not a text-processing pipeline.**
- Classification: inferred
- Evidence Level: E3-E5
- Evidence: GenericFlowExecutor walks a Flow graph (nodes + transitions). Each node is either:
  - LM (external: claude -p produces text, system records receipt)
  - Kernel (internal: deterministic handler validates and decides)
  - Human (internal: operator makes a decision)
- The system NEVER executes an LLM inference internally. It spawns a process that does. The system's executable paths are entirely about: claim → fence → spawn → wait → verify → accept/reject → route.
- Alternative Explanation: one could argue the system is a "conveyor for text artifacts" (CONVEYOR-MENTAL-MODEL.md v2 framing). But the conveyor's MECHANICS (claim, fence, gate, verify, route) are where the complexity and testing effort live. The text itself is opaque to the system — it only checks schema + hash, never content semantics.

---

## Part B — Inferred Business Intent (hypotheses, NOT verified)

### HYPOTHESIS-001: Governance platform for parallel LLM agents

**Claim:** The system's business value is making it impossible for parallel LLM agents to produce invalid work, corrupt each other's state, or bypass quality gates.

**Evidence FOR:**
- README: "Goal: make it impossible to pass an invalid action as a valid transition"
- CGAD spec (P0-P18, 25 forbidden constructs)
- 18 lint rules, architecture ratchet tests, dispatcher-race tests
- Single-writer invariant for task status

**Evidence AGAINST:**
- The system also provides a kanban UI, markdown artifact rendering, and a docs graph viewer — these are not governance functions
- Delivery module exists but is fail-closed (always blocks without a real provider) — governance without delivery is theoretical

**Status:** Strong hypothesis. The governance mechanics dominate the codebase by complexity and test coverage.

### HYPOTHESIS-002: "One machine, one material" (from CONVEYOR-MENTAL-MODEL.md v2)

**Claim:** The system is fundamentally a text-artifact pipeline. All workshops produce text. The four desks are accidental, not essential.

**Evidence FOR:**
- Every LM product IS text (JSON/Markdown/source code) with schema + hash
- `saga3_process_products` table exists as a universal store (used by Development only)
- The runtime does not interpret content semantics — only schema + hash
- GenericFlowExecutor does not switch on module name

**Evidence AGAINST:**
- Four desks ARE in active production use (FINDING-001)
- Each desk has a module-specific submit tool with module-specific validation (e.g., `proposal_submit` validates discovery proposal schema; `process_node_submit` validates task-graph schema)
- Kernel handlers read from module-specific desks using module-specific resolvers — the "one read" abstraction does not exist yet
- The `artifact_create` bridge (Formalization) writes to BOTH `artifacts` table AND `saga3_managed_artifact_productions` — the managed-production-ledger is a SECOND write path, not the primary one

**Status:** Plausible but UNVERIFIED. The physical reality (all products are text) supports it. The operational reality (four desks, four tools, four resolvers) contradicts it. Phase 2 (Data Flow Map) and Phase 4 (Seam Map) will resolve this.

### HYPOTHESIS-003: The "glass ceiling" is accidental, not essential

**Claim:** The system's cognitive complexity for an LLM agent is dominated by accidental complexity (Wave debt, four desks, distributed modules) rather than essential complexity (CGAD governance, conveyor model).

**Evidence FOR:**
- ~40% of key files are comments documenting Wave history (not behavior)
- Understanding one module requires reading 8-12 files across 4 directories (saga3/, modules/, infrastructure/, shared/)
- Composition root is 780 lines where 80 would suffice with self-registering modules
- Four submit tools, four tables, four resolvers where one universal desk would work
- The CGAD spec (the essential governance model) is 1500 lines of clear, well-structured documentation — NOT the bottleneck

**Evidence AGAINST:**
- The domain IS complex: 7 logical layers, 4 process modules, authority gateway, recovery model, merge-lock protocol
- Even without accidental complexity, understanding the conveyor model requires reading CGAD P18, CONVEYOR-MENTAL-MODEL.md, and the Flow/Node/Profile type system
- A "minimal saga" (one module, one desk, no Wave debt) would still be ~5000 lines of essential code

**Status:** Partially verified. Accidental complexity IS significant (~40% estimate). But essential complexity is also non-trivial. The glass ceiling would be LOWERED by cleanup but not ELIMINATED. Phase 5 (Workload Profile) and Phase 9 (Algorithmic Improvement) will quantify this.

### HYPOTHESIS-004: System purpose is evolving from "governance" to "autonomous product factory"

**Claim:** The system is transitioning from a governance layer (where humans make decisions and agents execute) to a fully autonomous product factory (where the conveyor runs idea → code → release without human intervention).

**Evidence FOR:**
- orchestrate-cli runs autonomously in a while(true) loop
- Recovery system (autonomous-recovery skill, reaper, stuck-policy) is designed for unattended operation
- Discovery is permissive (every outcome forwards to Formalization — the market is the real gate)
- Delivery module is fail-closed (blocks without provider) — the infrastructure for autonomous release EXISTS but waits for a real provider

**Evidence AGAINST:**
- Human operator is still required: start the engine, answer AskUser questions, resolve merge conflicts
- saga-kickstart requires main-context (Sign 005) — it asks the human questions interactively
- Delivery approval is a `human` node — the human must approve before publication

**Status:** Weak hypothesis. The system has autonomous INFRASTRUCTURE but not autonomous AUTHORITY. The human remains the authority boundary for irreversible decisions (release, security, business intent). This aligns with CGAD P11 (Inversion of authorship).

---

## Part C — Summary: What System Has the Code Actually Become?

### One-paragraph operational purpose

saga-mcp is a **state-machine engine that governs external LLM workers through deterministic transition gates**. It accepts a one-phrase idea, spawns Claude CLI processes to produce text artifacts (proposals, requirements, code, release records), and enforces that every state change — task claim, artifact acceptance, stage progression, tool call — passes through a formal gate backed by atomic transactions, content-addressed hashes, and frozen execution authority. The system's center of gravity is the **gate mechanics** (claim, fence, verify, accept/reject, route), not the text production. The text is opaque to the system; only its schema and hash matter. The system's primary architectural debt is that four workshops each invented their own "desk" (table + submit tool + resolver) for storing text products, when physically all products are the same entity: text with a schema and a hash.

### Operational purpose vs. declared purpose

| Dimension | Declared (README/docs) | Observed (code behavior) |
|---|---|---|
| Primary value | "Make it impossible to pass an invalid action as a valid transition" | Confirmed: gates dominate code complexity and test coverage |
| Architecture | "Hexagonal, dependency-direction inward, pure domain" | Partially confirmed: domain IS pure, but modules are distributed across saga3/, modules/, infrastructure/ — not self-contained hexagons |
| Pipeline | "Idea → Discovery → Formalization → Development → Delivery" | Confirmed in code (productDeliveryLifecycle stages). Delivery is fail-closed (always blocks without provider). |
| Skills | "13 role skills drive the conveyor" | Confirmed: each skill is a prompt for claude -p. Skills are advisory; MCP gateway is authoritative. |
| Recovery | "New worker, same card, same desk" | Confirmed in code (P18 node-durable identity). Production observation shows zombie states where recovery did NOT fire (engine stopped, not crashed). |
| Products | "One machine, one material, one desk" (CONVEYOR-MENTAL-MODEL v2) | NOT confirmed: four desks in active use. Universal desk EXISTS (saga3_process_products) but is used by one module only. |

### The "text pipeline" hypothesis: verdict

The user's framing — «завод/цеха/столы — это надстройки над LLM моделями, которые генерят текст» — is **physically correct but operationally incomplete**.

**Correct:** Every product IS text. Every worker IS an LLM. Every workshop produces the same physical entity (text with schema + hash).

**Incomplete:** The system's VALUE is not in moving text — it is in GOVERNING the conditions under which text is produced, verified, and accepted. The gates (claim, fence, verify, accept, route) are where complexity, testing, and bugs live. Treating the system as "a pipeline that moves text" would miss that the gates are the product.

**Implication for target architecture:** A unified desk (one table, one submit, one read) would reduce accidental complexity. But the gates must remain first-class. The target architecture should be a **gate-centric hexagonal model**, not a **pipeline-centric model**. The gates are the core; the desk is infrastructure.

---

## Coverage Statement

### What was covered
- All 5 processes traced from entry to side effects
- All 4 modules traced from definition to product desk
- 10 core components identified with evidence levels
- One real production run (Autism-Buttons) used as behavioral evidence
- 3 business hypotheses evaluated against code evidence

### What was only inferred
- Production behavior of Delivery module (always blocks — no real provider configured)
- The "glass ceiling" quantification (40% accidental complexity estimate is approximate)
- The center-of-gravity claim (gates > text) is inferred from code complexity distribution, not from runtime profiling

### What remains unresolved
- QUESTION-001: Runtime desk usage (no E6 telemetry)
- QUESTION-007: Glass ceiling quantification (needs Phase 5)
- NEW QUESTION-008: Is the gate-centric model the correct framing for the target architecture, or should the system be reframed as a workflow engine / plugin host / integration router?
- NEW QUESTION-009: Does the Autism-Buttons zombie state (#19, #20) indicate a production bug in the reaper, or simply that the engine was manually stopped?

### Phase confidence
**Medium-High.** The operational purpose is well-evidenced from executable topology + one production run. The business hypotheses are clearly separated from observed behavior. The center-of-gravity finding (gates > text) is the most consequential claim and carries the most uncertainty — it should be tested in Phase 5 (Workload Profile) against actual code execution patterns.
