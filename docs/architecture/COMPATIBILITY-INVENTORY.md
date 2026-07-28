# Compatibility Inventory — Wave 13 removal surfaces

**Frozen at commit:** `fd26fd1`
**Captured by:** W0-A8 (plan §14.1.5)
**Companion ADR:** [ADR-021 — compatibility policy](decisions/021-compatibility-policy.md)

This document tabulates the seven compatibility surfaces Wave 13 may remove
**only after** the owning module has migrated and the relevant deletion gate
(plan §16.4–16.8) has been satisfied. Each surface is frozen as a compatibility
boundary per plan §14.1.5: no later wave may rename, reorder, or silently
reinterpret these without going through the integrator's contract-change
process (plan §0.1.7).

The tool-name list and the migration list are cross-checked against W0-A3
(MCP catalog) at integrator checkpoint.

---

## 1. Public MCP tool names (frozen boundary — 90 tools)

**Source:** `ALL_TOOLS` array in `src/index.ts` (concat of every `definitions`
export from `src/tools/*.ts` plus four `createSaga3*Handlers()` factories).

**Why frozen:** plan §14.1.5 and §16.7 ("do not remove current tools before
module tool aliases and replay behavior are verified"). Any rename breaks
existing skill prompts, CLI invocations, and saved MCP client configurations.

**Sorted pinned list (90):**

```
activity_log
artifact_coverage
artifact_create
artifact_get
artifact_list
artifact_update
comment_add
comment_list
conflict_check
conflict_keys_auto_derive
conflict_keys_clear
conflict_keys_list
conflict_keys_set
delivery_approval_decide
delivery_approval_get
delivery_approval_list
diagnosis_get
diagnosis_submit
epic_create
epic_list
epic_update
episode_status
episode_transition
lifecycle_run_get
lifecycle_run_list
normalization_get
normalization_submit
note_delete
note_list
note_save
note_search
observation_list
observation_record
process_lifecycle_get
process_module_get
process_module_list
process_module_validate
process_node_submit
process_run_cancel
process_run_get
process_run_list
process_run_set
process_run_start
project_create
project_delete
project_list
project_resolve_by_name
project_update
proposal_submit
provider_list
provider_register
readiness_get
readiness_submit
repository_checkout_bootstrap
repository_checkout_list
repository_checkout_register
repository_get
repository_list
repository_register
repository_update
subtask_create
subtask_delete
subtask_update
task_batch_update
task_create
task_get
task_list
task_update
template_apply
template_create
template_delete
template_list
trace_add
trace_delete
trace_list
tracker_dashboard
tracker_export
tracker_import
tracker_init
tracker_search
tracker_session_diff
verification_record
worker_ask_done
worker_ask_need
worker_done
worker_health
worker_merge_acquire
worker_merge_release
worker_next
workflow_generate_next
```

**Derivation method:** `npm run build` then assembled from the same imports as
`src/index.ts` (`projects`, `epics`, `tasks`, `subtasks`, `notes`, `dashboard`,
`search`, `activity`, `comments`, `templates`, `export-import`, `dispatcher`,
`artifacts`, `repositories`, `workflow`, `lifecycle`, `observations`,
`conflicts`, `providers`, `process-modules`, `process-node-submissions`,
`delivery-approvals`, `lifecycle-runs`, plus the four `createSaga3*Handlers()`
factories — `saga3-proposals`, `saga3-normalization`, `saga3-readiness`,
`saga3-diagnosis`). The saga3 factories require `DB_PATH`; set a tmp DB when
re-deriving.

**Eventual ownership split (ADR-020):**
- Platform tier: `project_*`, `epic_*`, `task_*`, `subtask_*`, `note_*`,
  `comment_*`, `template_*`, `tracker_*`, `search`, `activity_log`, `dashboard`,
  `export`/`import`, `repository_*`, `observation_*`, `provider_*`,
  `conflict_*`, `trace_*`, `artifact_*`, `workflow_*`, `lifecycle_run_*`,
  `episode_*`, `worker_*`, `verification_record`, `task_batch_update`.
- Capability tier (versioned platform Capability Packages): `worker_*`,
  `task_*`, `artifact_*`, `trace_*`, `verification_record`,
  `process_node_submit`, `conflict_*`.
- Module tier (discovery module contributions): `proposal_submit`,
  `normalization_*`, `readiness_*`, `diagnosis_*`.
- Module tier (formalization/development/delivery contributions):
  `process_module_*`, `process_run_*`, `process_lifecycle_get`,
  `delivery_approval_*`.

---

## 2. Persistence migrations requiring compatibility (10 functions)

**Source:** `src/db.ts` (runs `SCHEMA_SQL` from `src/schema.ts` then a hand-rolled
chain of idempotent `try { ALTER TABLE } catch {}` blocks + named migration
functions). One additional migration is imported from
`src/lifecycle/backfill-migration.ts`.

There is no `migrations/` dir, no `user_version` pragma, no framework (baseline
§"Where SQL lives"). Each migration is gated by a `sqlite_schema` /
`PRAGMA table_info` detection predicate and is a no-op on already-migrated DBs.

| # | Migration function | Location | What it adapts | Detection predicate |
|---|---|---|---|---|
| 1 | `migrateArtifactTypes` | `src/db.ts:316` | Widens `artifacts.type` CHECK to the full current enum (terminal value `'business_metric'`). Rebuilds the table preserving optional columns (`project_repository_id`, `evidence_status`) that may or may not exist on older DBs. | `artifacts` DDL lacks `'business_metric'` |
| 2 | `migrateTracesLinkType` | `src/db.ts:409` | Widens `artifact_traces.link_type` CHECK to add `'implements_spec'` (ADR-014). Existing link types are a subset. | `artifact_traces` DDL lacks `'implements_spec'` |
| 3 | `migrateVerificationOutcome` | `src/db.ts:460` | Widens `verification_evidence.outcome` CHECK to CGAD 4-valued verdict (`passed`/`failed`/`unknown`/`error`, REQ-008) and adds nullable `provider` column. Existing outcomes `{passed, failed}` are a subset. | `verification_evidence` DDL lacks `'unknown'` |
| 4 | `migrateVerificationExecution` | `src/db.ts:512` | Adds `execution_id` column + per-attempt uniqueness to `verification_evidence` (ADR-009 — evidence is immutable per execution attempt, not forever per task/AC/hash). | `execution_id` column absent |
| 5 | `migrateVerificationTargets` | `src/db.ts:571` | Restores canonical verification ownership from planning provenance (`tasks.verification_target_artifact_id`); deletes mismatched legacy `verified_by` edges while retaining evidence rows (ADR-009). | always (transactional UPDATE/DELETE) |
| 6 | `migrateRiskClass` (exported) | `src/db.ts:647` | Adds `declared_risk`/`derived_risk`/`policy_minimum`/`final_risk` columns to `tasks` (REQ-009 / CGAD §11), backfills `declared_risk` from legacy `priority` and `final_risk` from `declared_risk` (P15). | column absent (ALTER swallowed) |
| 7 | `migrateEpisodeTrack` (exported) | `src/db.ts:678` | Adds `track` column to `episode_workflows` (ADR-012 — `'formal'` vs `'fast-track'`), backfills from legacy `metadata.fast_track` flag. | column absent (ALTER swallowed) |
| 8 | `backfillWorkItemShadow` | `src/lifecycle/backfill-migration.ts` (imported at `src/db.ts:3`, called at `:56`) | Backfills the `task_work_items` shadow projection for legacy rows predating the work-item functional process managers (ADR-011). | internal to module |
| 9 | `migrateReviewInProgress` | `src/db.ts:105` | Adds `'review_in_progress'` to `tasks.status` CHECK (review workflow phase). Rebuilds `tasks` preserving all columns. | `tasks` DDL lacks `'review_in_progress'` |
| 10 | `migrateExecutionModeArtifactChange` | `src/db.ts:225` | Adds `'artifact_change'` to `tasks.execution_mode` CHECK (formalization artifact-mode tasks). Rebuilds `tasks` preserving all columns. | `tasks` DDL lacks `'artifact_change'` |

**Compatibility rule:** all migrations remain idempotent and additive until the
DB cutover phase. None may be removed until the new persistence owner (plan
§0.1.8) consolidates schema behind one SQL owner (baseline §"Cross-cutting
refactor seams" #4) and the integrator confirms no production DB predates the
oldest detection predicate.

---

## 3. Tables to preserve during migration (37 in `src/schema.ts`)

**Source:** `src/schema.ts` — single large `SCHEMA_SQL` (`CREATE TABLE IF NOT
EXISTS …`) applied by `getDb()` via `db.exec(SCHEMA_SQL)`. Canonical fresh-DB
schema (968 lines). Confirmed 37 `CREATE TABLE` statements.

**Core board / workflow (16):**
`projects`, `repositories`, `project_repositories`, `repository_checkouts`,
`epics`, `episode_workflows`, `tasks`, `worker_executions`, `subtasks`,
`task_dependencies`, `comments`, `templates`, `notes`, `activity_log`,
`artifacts`, `task_conflict_keys`.

**Verification / authority / lifecycle (7):**
`verification_evidence`, `trusted_providers`, `artifact_traces`,
`command_receipts`, `lifecycle_events`, `task_work_items`, `work_attempts`,
`human_requests`, `integration_intents`, `runtime_observations`. (10 — counted
from schema; the authority/observation cluster.)

**Saga 3 discovery cluster (11):**
`saga3_work_intents`, `saga3_raw_submissions`, `saga3_control_intents`,
`saga3_normalization_proposals`, `saga3_readiness_control_intents`,
`saga3_readiness_assessments`, `saga3_discovery_settlements`,
`saga3_discovery_outcome_certificates`, `saga3_discovery_diagnosis_control_intents`,
`saga3_discovery_diagnosis_reports`, `saga3_proposals`.

**Compatibility rule:** all 37 are preserved verbatim until cutover. Legacy rows
are marked and routed through adapters — never reinterpreted as new contracts
(plan §16.2). The Saga 3 discovery cluster migrates behind the discovery
module's new package contributions (ADR-020) and is the last to drop.

**Missing aggregates the refactor will add (NOT yet present — baseline
§"Missing aggregates"):** `protocol_state` / `ProtocolRun` / `ProtocolStepRun`,
`CallInstance`, scenario installation + scenario module lock tables,
`saga3_process_module_installations` (today an in-memory registry only).

---

## 4. Composition root seam — `composition/product-lifecycle-runtime.ts`

**Path:** `src/process-modules/composition/product-lifecycle-runtime.ts` (483 lines).

**What it is:** the manual composition root. Hard-wires 4 `GenericFlowExecutor`s,
the node-executor map, both built-in registries (modules + installations), the
kernel/external/human registries, `ProcessOutputPayloadRegistry`,
`LifecycleOrchestrator`, and the lifecycle adapter. Imports ~30 concrete
symbols (every module's process-module, schemas, ports, sqlite runtimes, all 10
sqlite repositories). Any new module/port forces an edit here (baseline
§"Composition — `composition/`").

**Cutover:** Wave 11. Replaced by injected `PackageRegistry`,
`CapabilityRegistry`, `ModuleToolRegistry`, `HandlerRegistry`, `SchemaRegistry`,
`GuardRegistry`, `ScenarioRegistry` (plan §14.4.2). The exit gate (plan
§14.4.7): installing a third synthetic module requires only package
registration, not edits to Runtime or a central catalog.

**Deletion gate:** plan §16.8 — do not cut Product Delivery to the new scenario
engine until all four current modules pass conformance tests.

---

## 5. Hard-coded Discovery workflow strings (Wave 6)

| File | Line | Content |
|---|---|---|
| `src/tools/saga3-args.ts` | 223 | `enriched.push('[Workflow: Read your stage tracker docs/discovery/project-<N>-discovery-stage.md, fix the field, verify checklist, retry.]')` |
| `src/tools/saga3-proposals.ts` | 43 | `_workflow_hint?: string;` (type field) |
| `src/tools/saga3-proposals.ts` | 176 | `_workflow_hint: '✅ Proposal accepted! Update your stage tracker: Read docs/discovery/project-<N>-discovery-stage.md, mark step 4c [x], set Current Step: 5. Then call worker_done with your task_id and execution_id.'` |

**Why frozen:** these strings are visible in MCP error responses and in skill
prompts; removing them without a replacement breaks the discovery worker's
step-advance guidance.

**Replacement:** per-module actionable error hint resources + per-module
workflow-doc resource references declared in the package manifest (ADR-020;
plan §5.3.8, §13.13). The hint becomes a contributed resource, not a hard-coded
literal.

**Deletion gate:** plan §13.13 — parameterize for arbitrary modules before the
discovery module migrates behind its package contributions.

---

## 6. `routeResolver` + cumulative-frame (Wave 7)

| File | Lines | Smell |
|---|---|---|
| `src/process-modules/domain/lifecycle.ts` | 69 | `routeResolver?: RouteResolver;` — a non-serializable function field on `LifecycleDefinition`. Documented dodge: serializes to `undefined`, contributes only a present/absent bit to the hash. |
| `src/process-modules/lifecycles/product-delivery-lifecycle.ts` | 405–409 | `routeResolver` attached via `Object.defineProperty({enumerable:false})` to dodge `canonicalJson`. |
| `src/process-modules/application/lifecycle-orchestrator.ts` | 239 | `definition.routeResolver` consumed by `routeProcessOutcome()` at stage-execution time. |
| `src/process-modules/application/lifecycle-router.ts` | (whole file, 91 lines) | `routeProcessOutcome` asks `routeResolver` first, then falls back to the static route table. |
| `src/process-modules/application/generic-flow-executor.ts` | (950 lines) | Mutable in-memory `NodeExecutionFrame` (productions/receipts maps) reconstructed each step — the "cumulative frame" that `routeResolver` reads. |

**Why frozen:** the cumulative-frame + `routeResolver` combination is the current
routing mechanism for Product Delivery. Removing it before the scenario package
(ADR-016) and durable envelopes (ADR-018) are in place breaks stage transitions.

**Replacement:** `LifecycleScenarioManifest` with a serializable declarative
predicate grammar (plan §6.5.1) or an explicit decision Process Module stage for
complex routing (plan §6.5.2). No executable closure in the manifest (plan
§6.4). Durable `ExecutionContextEnvelope` replaces the mutable frame (ADR-018).

**Deletion gate:** plan §16.8 — do not cut Product Delivery to the new scenario
engine until all four current modules pass conformance tests.

---

## 7. Built-in catalog + prefix resolver (Wave 3)

| File | Lines | Smell |
|---|---|---|
| `src/process-modules/modules/catalog.ts` | 14 | `createBuiltInProcessModuleRegistry()` — imports all four modules and constructs the singleton registry. |
| `src/process-modules/modules/installations.ts` | 40 | `createBuiltInProcessModuleInstallationRegistry()` — same pattern for installations. |
| `src/process-modules/application/execution-profile-resolver.ts` | 21, 33–37 | Imports `createBuiltInProcessModuleRegistry` as a module singleton; resolves profiles by exact `taskKind` then by `workIntentKind` prefix match (`taskKind.startsWith(profile.workIntentKind)`). |
| `src/process-modules/composition/product-lifecycle-runtime.ts` | (483 lines) | Both built-in registries wired here. |

**Why frozen:** the catalog + prefix resolver is how the dispatcher currently
maps a `task_kind` to a module + execution profile. Removing it before
`PackageRegistry` is injected (plan §14.4.1) breaks task dispatch.

**Replacement:** injected `PackageRegistry`, `CapabilityRegistry`,
`ModuleToolRegistry`, `HandlerRegistry`, `SchemaRegistry`, `GuardRegistry`,
`ScenarioRegistry` (plan §14.4.2). Handler factories bound through
`ProcessModulePlugin` at composition time (plan §14.4.3). Remove prefix and
first-profile resolution — resolve exact package, node, profile, and protocol
identities from the execution envelope (plan §14.4.5, §7.4).

**Deletion gate:** plan §14.4.7 exit gate — installing a third synthetic module
requires only package registration, not edits to Runtime or a central catalog.
The catalog + prefix resolver is deleted once that gate is met and the four
existing modules resolve via the injected registry.

---

## Cross-checks

- **Tool count:** 90 (matches the runtime `ALL_TOOLS` assembly; re-derived at
  frozen commit `fd26fd1`). Cross-check with W0-A3 at integrator checkpoint.
- **Migration count:** 10 (9 in `src/db.ts` + `backfillWorkItemShadow` imported
  from `src/lifecycle/backfill-migration.ts`). The W0-A8 task file listed 9 by
  name; this inventory adds `migrateVerificationExecution` (`src/db.ts:512`),
  which the task file did not enumerate but which exists and requires the same
  compatibility treatment.
- **Table count:** 37 `CREATE TABLE IF NOT EXISTS` in `src/schema.ts` (matches
  baseline §"`src/schema.ts` tables (37)").
- **Test runner coverage:** 35 files in `tests/process-modules/**/*.test.mjs`
  at frozen commit `fd26fd1` (baseline said 41; actual is 35 — see
  `tools/run-process-module-tests.mjs --list`). The stale hard-coded lists
  covered only 29.
