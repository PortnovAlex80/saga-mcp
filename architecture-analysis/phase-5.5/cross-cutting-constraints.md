# Cross-Cutting Constraints Profile

Artifact ID: ART-PHASE5.5-CONSTRAINTS
Artifact Type: Cross-Cutting Constraints Profile
Phase: Phase Five Point Five
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE3-CORE-MODEL, ART-PHASE4-SEAM-MAP, ART-PHASE5-WORKLOAD-PROFILE, full codebase context
Coverage: 12 constraint categories assessed for architectural impact
Confidence: High (E3-E5 for all constraints)
Downstream Dependencies: Phase 6 (Pattern Evaluation and Target Architecture)

---

## CONS-001: Authentication
- **Current state:** None. Single-tenant system. SQLite DB has no authentication. MCP stdio transport trusts the process that spawned it. tracker-view HTTP (port 4321) has no auth.
- **Architectural impact:** LOW for current scope. If saga scales to multi-tenant or remote-host, authentication becomes a driving force — but no evidence of this trajectory.
- **Evidence:** No auth code anywhere in src/. `SAGA_MANAGED_EXECUTION` is identity, not authentication.

## CONS-002: Authorization
- **Current state:** STRONG. `authorizeSagaToolCall` validates frozen execution_context against every MCP tool call. 4-valued verdict (deny-by-default). `allowed_saga_tools` whitelist enforced at gateway. Defense-in-depth: `visibleSagaToolNames` also filters tool list.
- **Architectural impact:** HIGH. Authorization placement determines the module boundary. The gateway (index.ts) is the ONLY enforcement point — if a tool bypasses it, authorization is meaningless. This means ALL module-facing APIs MUST go through MCP tools, not through direct function calls. This constrains the target architecture: modules cannot expose direct callable interfaces to workers — only MCP tools.
- **Evidence:** EVID-003, EVID-024, RULE-010
- **SEAM:** SEAM-014 (claude CLI version contract)

## CONS-003: Trust boundaries
- **Current state:** Two trust boundaries: (1) saga runtime ↔ MCP client (trusted — same process), (2) saga runtime ↔ worker (untrusted — external claude -p process with frozen authority). The worker CANNOT: call unauthorized tools, expand its authority, see other workers' cards, bypass gates.
- **Architectural impact:** MEDIUM. The worker boundary is clean (frozen snapshot + authority gateway). The MCP-client boundary is implicit (same process). If saga moves to remote MCP, the client boundary needs hardening.
- **Evidence:** EVID-003, EVID-024

## CONS-004: Secrets
- **Current state:** None managed. `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` passed to claude CLI via env (claude-runner.mjs:895-898). `~/.claude/settings.json` patched by tracker-view. LM Studio tokens are placeholders.
- **Architectural impact:** LOW. No secrets in saga DB, no secrets in artifacts, no secrets in logs (JSONL logs may contain tool inputs — potential leak if tool args contain credentials, but saga tasks do not involve credentials).

## CONS-005: Sensitive and personal data
- **Current state:** None. Saga DB contains task descriptions, artifact content (technical docs), worker prompts (skill text). No PII, no financial data, no health data.
- **Architectural impact:** LOW. The product being built (e.g., Autism-Buttons) may contain user-facing text, but saga's governance DB does not.

## CONS-006: Auditability
- **Current state:** STRONG. `activity_log` (append-only), `command_receipts` (idempotency ledger), `lifecycle_events` (event journal), `verification_evidence` (immutable), `saga3_discovery_outcome_certificates` (write-once), `saga3_process_outcome_certificates` (write-once). `runtime_observations` (append-only).
- **Architectural impact:** MEDIUM. The audit trail is rich and append-only by convention. This justifies the immutable, content-addressed product model. Any target architecture MUST preserve append-only audit — it is a cross-cutting invariant that spans all modules. If modules are consolidated, the audit trail must remain independent.
- **Evidence:** RULE-017, schema.ts constraints

## CONS-007: Logging and tracing
- **Current state:** `console.error` for MCP server startup. JSONL logs per worker (claude -p stream-json output). `worker-heartbeat.log` (text append). `engine-heartbeat.log` (text append). No structured tracing (no OpenTelemetry, no correlation IDs across components).
- **Architectural impact:** LOW-MEDIUM. The absence of structured tracing makes E6 evidence impossible to collect. A tracing layer (even lightweight: `execution_id` as correlation ID in all log lines) would improve observability without architectural change.
- **Missing evidence:** QUESTION-001 (runtime desk usage) cannot be answered without tracing.

## CONS-008: Retries and idempotency
- **Current state:** STRONG. `command_receipts` provide idempotency for worker_done (RULE-017). Product submits use `ON CONFLICT DO NOTHING` (idempotent by content_hash). Certificate issuance is idempotent (same hash = same row). `exactCandidateAcceptance` is idempotent (same idempotency_key = same decision).
- **Architectural impact:** MEDIUM. Idempotency is a cross-cutting pattern that MUST be preserved in any target architecture. Every mutation that crosses a trust boundary (worker → saga) MUST be idempotent. This constrains the unified desk design: `submitWork` MUST be idempotent by content hash, just like all four current submit tools.
- **Evidence:** RULE-017, EVID-015, EVID-017

## CONS-009: Consistency
- **Current state:** Strong consistency within one SQLite DB (WAL mode, foreign_keys ON). No eventual consistency. No cross-store transactions (SQLite is the only store, except filesystem + git which are NOT transactional with SQLite).
- **Architectural impact:** HIGH for git integration. The SQLite ↔ git boundary is the consistency gap (SEAM-013). SQLite says "task is done"; git may or may not have the merge. This gap is the motivation for `integration_intents` (declared but unbuilt). Any target architecture MUST either: (a) implement the durable intent + deterministic Git executor from ADR-010, or (b) explicitly accept "git crash = manual recovery" as a documented limitation.
- **Evidence:** SEAM-013, STATE-014

## CONS-010: Configuration
- **Current state:** Environment variables (DB_PATH, SAGA_MANAGED_EXECUTION, SAGA_EXECUTION_ID, SAGA_PRODUCT_LIFECYCLE_COMPOSITION, etc.). `loadSagaRuntimeConfig` (runtime/saga-runtime-config.ts) reads env vars. `lifecycle_execution_controls` table stores per-epic engine state + model route.
- **Architectural impact:** LOW. Configuration is simple and env-based. No feature flags (except SAGA_ALLOW_MANUAL_STATUS escape hatch). No dynamic reconfiguration (model change requires settings.json patch + env update).

## CONS-011: Existing test coverage
- **Current state:** 
  - Architecture tests: dependency-direction ratchet (6 rules), cutover checks, conveyor ports, no-execution-scoped-lookup, tasks-writer-invariant — STRONG
  - Dispatcher race tests: 8-way concurrent claim, worktree isolation, review verdict race — STRONG
  - Process module tests: node-durable-identity, characterization, formalization settlement — GOOD
  - Saga3 D1-D5 tests: settlement atomicity, readiness, diagnosis — GOOD
  - **GAP:** No end-to-end lifecycle test (idea → release) with real claude CLI. Autism-Buttons is the closest to E6 but is a manual run, not an automated test.
  - **GAP:** No test for SEAM-013 (git merge crash recovery) — because the mechanism doesn't exist.
- **Architectural impact:** MEDIUM. Test coverage is strong for governance mechanics but weak for lifecycle integration. The ratchet tests are the strongest asset — they make refactoring SAFE. Any target architecture MUST add new ratchet tests for new boundaries (e.g., "unified desk test: all products go through one table").

## CONS-012: Deployment topology
- **Current state:** Single-machine, single-process-per-role. MCP server (stdio), orchestrate-cli (detached background), tracker-view (HTTP detached), docs-graph (HTTP detached). All share one SQLite DB on local filesystem. Workers are short-lived claude -p child processes.
- **Architectural impact:** HIGH for scaling. The single-machine assumption is baked into: (1) SQLite BEGIN IMMEDIATE as sole serialization, (2) filesystem-based package store, (3) git worktree isolation on local disk, (4) PID-based process liveness checks. Multi-host deployment would require: distributed locks, remote package store, remote git access, network-based liveness. This is a MAJOR architectural force IF scaling is a goal — but no evidence suggests it is.
- **Evidence:** SEAM-011

---

## Constraints that affect architecture

| Constraint | Force on architecture | Strength |
|---|---|---|
| Authorization (CONS-002) | All worker APIs MUST go through MCP gateway | HIGH |
| Auditability (CONS-006) | Append-only audit MUST be preserved | MEDIUM |
| Idempotency (CONS-008) | All cross-boundary mutations MUST be idempotent | MEDIUM |
| Consistency (CONS-009) | SQLite ↔ git gap MUST be addressed or documented | HIGH |
| Test coverage (CONS-011) | Ratchet tests enable safe refactoring | MEDIUM (enabler) |
| Deployment (CONS-012) | Single-machine assumption baked deep | HIGH (if scaling needed) |

### Constraints that do NOT affect architecture
- Authentication (CONS-001): single-tenant, no auth code
- Secrets (CONS-004): none managed
- Personal data (CONS-005): none stored
- Configuration (CONS-010): simple env vars
