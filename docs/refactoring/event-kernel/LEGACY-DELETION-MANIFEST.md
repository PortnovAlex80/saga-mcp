# LEGACY-DELETION-MANIFEST — Event-Projected Kernel (EK-1 / WP-04)

- **Base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
- **Author:** WP-04 implementer (classification only — nothing is deleted by this document)
- **Plan:** `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md` (EK-1 "Deletion manifests", EK-7/EK-8/EK-10)
- **Precedent:** ADR-095 (complete removal of a stratum; ratchet-first, delete-don't-archive)
- **Method:** full directory sweep of `src/` (572 tracked files), `tracker-view/`, `scripts/`, `tools/`, `tests/` (510 test files), complete SQL DDL extraction from `src/schema.ts` (91 `CREATE TABLE` at statement position; the 92nd/93rd grep hits are a doc comment at `src/schema.ts:2172` and the `IF` token it contains) plus every lazily created table, every `ALTER TABLE` site, every trigger and the write endpoints of the tracker UI. Import analysis was executed (not assumed) for every RETAIN-AND-MOVE candidate in §G.

## How to read

- **Disposition vocabulary (exactly one per entry):**
  - `DELETE` — the entry is removed in the named phase and never reachable again. No forwarding facade, no archive copy.
  - `RETAIN-AND-MOVE` — a *pure contract file* moves to its canonical new-kernel package; the old path is deleted at EK-8. Only §G entries may carry this disposition, and only after the import analysis printed there.
  - `KEEP` — survives the cutover byte-identical (qualification evidence or still-valid tooling).
- **Phase:** the phase whose exit requires the entry to be gone. `EK-7` = projection/`tasks`-scheduling removal; `EK-8` = hard cutover + legacy purge; `EK-9` = deleted when the universal test engine's blocking replacement lands; `EK-10` = documentation purge.
- **Replacement:** the new-kernel path/command, or `none — obsolete`.
- Rows may group files **only** when they share directory, disposition, phase and replacement; every tracked file appears on exactly one row.

## A. Database schema — `src/schema.ts` (all 91 tables)

Policy: the new database protocol is greenfield (plan §"Fresh protocol only"). **Every old table is DELETE; no row, no DDL and no fixture of the old schema is adopted, migrated or dual-read.** The ADR-053 logical relations survive as *new* relations re-frozen by the EK-1 schema, not as these tables. Existing operator databases keep their files offline as incident evidence only.

### A.1 Kanban / project / task spine — the scheduling authority the kernel replaces

| Table (schema.ts line) | Current authority role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `projects` (54) | Operator project registry; every epic/task FK root | DELETE | EK-8 | `FactoryRun` + catalog relations (EK-1 schema freeze) |
| `repositories` (68) / `project_repositories` (78) / `repository_checkouts` (94) | Repository desk registry and checkout state | DELETE | EK-8 | catalog + `WorkIntent` evidence refs |
| `epics` (108) | Epic grouping of tasks | DELETE | EK-8 | `WorkItem` (immutable planning facts) |
| `episode_workflows` (142) | Old episode/stage/track state machine over epics | DELETE | EK-8 | none — obsolete (stage/track selection is not kernel authority) |
| `tasks` (155) | **The old scheduling authority: `tasks.status` drives claim/dependency decisions** (`src/lifecycle/work-assignment-core.ts` header admits it is a "legal writer of tasks.{status,assigned_to,current_execution_id}") | DELETE (mandatory) | **EK-7** (core reads removed; new schema has no `tasks` table or status triggers — plan EK-7) with old-protocol DDL removed at EK-8 | `WorkItem` (immutable) + `KanbanCard` (projection) + `TransitionObligation` |
| `worker_executions` (219) | Worker attempt/process facts — the table ADR-053 demoted from material authority | DELETE | EK-8 | `ActivityAttempt` (activity/provenance only) |
| `subtasks` (296) | Sub-card board rows | DELETE | EK-8 | `WorkItem` |
| `task_dependencies` (309) | Inferred blocking/unblocking graph read by `reevaluateDownstream` (`src/tools/tasks.ts:382`) | DELETE (mandatory: inferred dependency blocking/unblocking) | EK-7 | `WorkItemDependency` (immutable exact edge) + aggregate readiness |
| `comments` (318) / `notes` (339) / `templates` (328) | Operator annotations/templates on the board | DELETE | EK-8 | none — obsolete as authority (projection-only annotations may return as `KanbanCard` data) |
| `activity_log` (358) | Human-facing activity journal | DELETE | EK-8 | `WorkflowEvent` (append-only facts) + projection |
| `artifacts` (376) / `artifact_traces` (523) / `applies` (564) | Artifact store + lineage + AC application records | DELETE | EK-8 | content-addressed evidence refs on `WorkIntent`/`GateDecision` |
| `task_conflict_keys` (426) | Per-task conflict idempotency keys | DELETE | EK-8 | kernel command idempotency keys |
| `runtime_observations` (445) / `verification_evidence` (470) | Observation/verification evidence rows | DELETE | EK-8 | evidence refs on `ActivityAttempt` / `GateDecision` |
| `trusted_providers` (500) | Provider allow-list | DELETE | EK-8 | `providerModelLimitTableRef` in `PromptBudgetProfile` (EK-1 spec) |
| `factory_artifact_drift_events` (568) | Artifact drift detection ledger | DELETE | EK-8 | none — obsolete (exact evidence refs remove drift class) |
| `command_receipts` (688) | MCP command idempotency receipts | DELETE | EK-8 | kernel command idempotency (EK-2) |
| `lifecycle_events` (714) | Old lifecycle event log | DELETE | EK-8 | `WorkflowEvent` |
| `human_requests` (746) | Human input requests | DELETE | EK-8 | `TypedWait` (human-input wake source) |
| `integration_intents` (797) | Integration intent records | DELETE | EK-8 | `WorkIntent` |

### A.2 Work-intent / lifecycle control family

| Table | Current authority role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `factory_work_intents` (841) | Shared protocol entity binding intent → workplace (kept live by ADR-095) | DELETE | EK-8 | `WorkIntent` (re-frozen by EK-1; re-pins role-contract ref/digest) |
| `factory_execution_completion_products` (864) | Completion product records per execution | DELETE | EK-8 | `ActivityAttempt` evidence products |
| `factory_lifecycle_runs` (893) | Lifecycle run state | DELETE | EK-8 | `LifecycleRun` aggregate |
| `lifecycle_execution_controls` (933) | Pause/resume/concurrency control rows | DELETE | EK-8 | durable operator stop/resume commands + evidence (EK-4) |
| `supervision_locks` (976) | Cross-process supervision locks | DELETE | EK-8 | CAS lease + fence on obligations (EK-4) |

### A.3 ADR-053 Workplace family (logical chain retained, tables replaced)

| Table | Current authority role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `factory_workplaces` (1005) | Workplace loop channel (queued/leased/running/verifying/…) | DELETE | EK-8 | `Workplace` aggregate (author/reviewer roles only) |
| `factory_workplace_park_reasons` (1039) | Park reasons | DELETE | EK-8 | `TypedWait` (policy wait) |
| `factory_worker_stops` (1063) | Worker stop records | DELETE | EK-8 | operator commands + evidence |
| `factory_operator_holds` (1087) | Operator hold state | DELETE | EK-8 | `TypedWait` (operator hold) |
| `factory_workplace_graphs` (1101) / `factory_workplace_graph_items` (1114) / `factory_workplace_dependencies` (1130) | Mutable workplace dependency graph | DELETE (inferred dependency blocking/unblocking — mandatory) | EK-7 (reads) / EK-8 (DDL) | `WorkItemDependency` immutable edges |
| `factory_workplace_recovery_epochs` (1179) | Recovery epoch fencing | DELETE | EK-8 | obligation CAS lease/fence (EK-4) |
| `factory_scope_widening_events` (1219) | Scope widening ledger | DELETE | EK-8 | typed repair obligations |
| `factory_effective_desk_base_receipts` (1255) | Effective desk base receipts | DELETE | EK-8 | `WorkIntent` evidence refs |
| `factory_effect_attempts` (1305) | Post-acceptance effect attempt state | DELETE | EK-8 | `EffectReceipt` chain driven by obligations |
| `factory_cell_effect_receipts` (1340) | Idempotent effect receipts (ADR-053) | DELETE | EK-8 | `EffectReceipt` (new relation; pure contract moves — §G) |
| `factory_cell_effect_repair_issues` (1360) | Effect repair issues | DELETE | EK-8 | typed repair obligations |
| `factory_cell_final_acceptances` (1385) | Exact cell completion evidence (ADR-053) | DELETE | EK-8 | `CellFinalAcceptance` (new relation) |
| `factory_accepted_authority_head` (1433) | Accepted-material head (ADR-053; lazily `ALTER TABLE`s new columns — `sqlite-accepted-authority-head-repository.ts:56`) | DELETE | EK-8 | `WorkplaceProductionRevision` head revision on the `Workplace` aggregate |
| `factory_final_presentation_commitments` (1504) | Durable final presentation commitment | DELETE | EK-8 | `CandidateSet` → `GateDecision` chain |
| `factory_transition_obligations` (1533) | Durable transition obligations + leases/fences (+ lazy `ALTER TABLE` valve columns at `sqlite-transition-obligation-ledger.ts:173,177`) | DELETE | EK-8 | `TransitionObligation` (new relation, new consumer — §D.3) |
| `factory_workshop_binding_receipts` (1567) | Workshop binding receipts | DELETE | EK-8 | pinned `CanonicalRoleContract` ref+digest on `WorkIntent`/`ActivityAttempt` |
| `factory_workplace_contributions` (1601) | Workplace contribution records | DELETE | EK-8 | `ActivityAttempt` evidence |
| `factory_workplace_production_revisions` (1615) | Immutable accepted production revisions (ADR-053 core) | DELETE | EK-8 | `WorkplaceProductionRevision` (new relation; pure contract moves — §G) |
| `factory_sealed_product_materials` (1663) / `factory_sealed_product_aliases` (1671) | Sealed material store | DELETE | EK-8 | content-addressed material refs |
| `factory_candidate_sets` (1700) / `factory_candidate_set_members` (1734) | Author/reviewer presentation bound to one revision (ADR-053) | DELETE | EK-8 | `CandidateSet` (new relation; pure contract moves — §G) |
| `factory_execution_reservations` (1755) | Execution lease/reservation | DELETE | EK-8 | `ActivityAttempt` lease |
| `factory_gate_runs` (1774) | Gate run records | DELETE | EK-8 | `GateDecision` over exact `CandidateSet` + CheckPlan |
| `factory_gate_presentation_attempts` (1797) | Presentation attempts at the gate | DELETE | EK-8 | `CandidateSet` presentation |
| `factory_check_receipts` (1822) | Check receipts | DELETE | EK-8 | check evidence refs on `GateDecision` |
| `factory_gate_decisions` (1859) | Immutable gate decisions (ADR-053) | DELETE | EK-8 | `GateDecision` (new relation; pure contract moves — §G) |
| `factory_workplace_gate_decision_heads` (1894) | Current gate decision head | DELETE | EK-8 | `Workplace` aggregate head revision |
| `factory_gate_finding_set_chain` (1929) | Finding-trajectory chain (lazily created in `sqlite-gate-finding-set-chain.ts`) | DELETE | EK-8 | finding evidence refs on `GateDecision` |
| `factory_human_gate_resolutions` (2026-08-24, HUMAN-GATE-CONSOLE) | Operator accept/reject answers to `GATE_HUMAN_REQUIRED` parks — append-only, bytes-guarded (workplace + gate decision key + candidate-bytes subject binding + provider) | DELETE | EK-8 | `TypedWait:human-input`/`effect-uncertainty` + operator disposition receipts (D12) + the command-only projection console (WP-10/WP-11V) |

### A.4 Engine / launch / recovery family

| Table | Current authority role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `factory_database_identity` (1966) | Database identity marker | DELETE | EK-8 | `ProtocolMetadata` (exact protocol ID + schema fingerprint, EK-3) |
| `factory_orders` (1986) / `factory_order_runs` (2013) | Product order and run rows | DELETE | EK-8 | `FactoryRun` |
| `factory_continuation_authorizations` (2030) / `factory_continuation_prefix_stages` (2055) | Continuation/replan authorizations | DELETE | EK-8 | aggregate settlement + `TerminalProof` |
| `factory_production_adoption_decisions` (2068) | Adoption of prior production state | DELETE (mandatory: DB/state adoption) | EK-8 | none — obsolete (no adoption of pre-cutover state) |
| `factory_development_verification_adoptions` (2096) / `factory_authorized_verification_observations` (2115) | Verification adoption/observation rows | DELETE (adoption class) | EK-8 | verification evidence refs on `CellFinalAcceptance` |
| `factory_author_candidate_carry_forward_authorizations` (2133) / `_consumptions` (2159) / `_reauthorizations` (2176) | Author carry-forward ledger | DELETE | EK-8 | none — obsolete (provenance subsumed by `WorkItem`/`WorkIntent`) |
| `factory_launch_requests` (2304) / `factory_launch_controller_terms` (2352) / `factory_launch_controller_leases` (2372) | Launch admission and controller lease fencing | DELETE | EK-8 | launch admission + `PromptAssemblyReceipt` (WP-18) + obligation lease |
| `factory_engine_watchdog_events` (2387) | Watchdog event log | DELETE | EK-8 | watchdog observe-only via commands/`WorkflowEvent` (EK-4) |
| `factory_checkpoints` (2408) | Checkpoint snapshots for resume | DELETE | EK-8 | none — obsolete (crash recovery = durable obligations + waits, EK-4; no snapshots) |
| `factory_adoptions` (2427) | Checkpoint/DB adoption decisions (ADR-024) | DELETE (mandatory: DB adoption) | EK-8 | none — obsolete |
| `factory_resume_directives` (2451) | Resume directives | DELETE | EK-8 | obligation redrive (EK-4) |
| `factory_runtime_mode` (2472) | Runtime mode flag (old-vs-new style switch) | DELETE (mandatory: feature switch) | EK-8 | none — obsolete (exactly one production composition) |
| `factory_definition_compatibility_receipts` (2480) | Lifecycle-definition compatibility receipts | DELETE (mandatory: compatibility) | EK-8 | none — obsolete (installed manifest digest equality) |
| `factory_submission_validation_receipts` (2517) / `factory_submission_validation_rejections` (2552) | Submission validation evidence | DELETE | EK-8 | ingress validation evidence refs (public ingress, EK-5) |
| `factory_operator_recovery_authorizations` (2594) / `_consumptions` (2609) | Operator recovery ledger | DELETE | EK-8 | durable operator commands + evidence |
| `factory_worker_loss_resume_authorizations` (2632) / `_consumptions` (2648) | Worker-loss resume ledger | DELETE | EK-8 | obligation lease expiry + redrive (EK-4) |
| `factory_orphaned_launch_recovery_receipts` (2671) / `factory_automatic_spawn_recovery_receipts` (2697) | Launch/spawn recovery receipts | DELETE | EK-8 | obligation redrive with typed fault results |
| `factory_failed_gate_recovery_authorizations` (2722) / `_consumptions` (2744) | Failed-gate recovery ledger | DELETE | EK-8 | typed repair obligations |

### A.5 Lazily created tables (outside `src/schema.ts`)

All are created by repository constructors with `CREATE TABLE IF NOT EXISTS` (the ADR-095 F2 regrowth pattern) and all die with their owning repository at EK-8.

| Table | Owning site | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `factory_call_instances` | `src/process-modules/persistence/sqlite-call-instance-repository.ts` | DELETE | EK-8 | `ActivityAttempt` provenance |
| `factory_delivery_approval_requests` / `factory_delivery_approval_decisions` | `src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts` | DELETE | EK-8 | `TypedWait` (human approval wake source) + `EffectReceipt` |
| `factory_delivery_outputs` | `src/modules/delivery/infrastructure/delivery-persistence.ts` | DELETE | EK-8 | `EffectReceipt` (delivery effects) |
| `factory_development_outputs` / `factory_development_task_projections` | `src/modules/development/infrastructure/development-persistence.ts` | DELETE (task projection = board projection) | EK-7 | `WorkItem` + `KanbanCard` |
| `factory_documentation_bundles` | `src/modules/documentation/infrastructure/sqlite-documentation-output-repository.ts` | DELETE | EK-8 | effect evidence refs |
| `factory_external_effect_actions` / `factory_external_effect_events` | `src/process-modules/persistence/sqlite-external-effect-ledger.ts` | DELETE | EK-8 | `EffectReceipt` + obligations |
| `factory_formalization_acceptance_baselines` / `factory_formalization_solution_contracts` | `src/modules/formalization/infrastructure/formalization-persistence.ts` | DELETE | EK-8 | `WorkItem`/evidence refs |
| `factory_managed_artifact_productions` / `factory_managed_trace_productions` | `src/process-modules/persistence/sqlite-managed-production-ledger.ts` | DELETE | EK-8 | ingress receipts + `ActivityAttempt` evidence |
| `factory_managed_node_submissions` | `src/process-modules/persistence/sqlite-managed-node-submission-repository.ts` | DELETE | EK-8 | public ingress submissions |
| `factory_module_installations` / `factory_process_module_installations` | `src/process-modules/persistence/sqlite-process-module-installation-repository.ts`, `src/process-modules/installation/persistence/installation-repository.ts` | DELETE | EK-8 | installed workshop manifest catalog (content-addressed, EK-1 freeze) |
| `factory_node_runs` | `src/process-modules/persistence/sqlite-node-run-repository.ts` | DELETE | EK-8 | `NodeRun` aggregate |
| `factory_process_outcome_certificates` | `src/process-modules/persistence/sqlite-process-outcome-certificate-repository.ts` | DELETE | EK-8 | `TerminalProof` |
| `factory_process_products` | `src/process-modules/persistence/sqlite-process-product-repository.ts` | DELETE | EK-8 | content-addressed products + evidence refs |
| `factory_process_runs` | `src/process-modules/persistence/sqlite-process-run-repository.ts` | DELETE | EK-8 | `ProcessRun` aggregate |
| `factory_process_transitions` | `src/process-modules/persistence/sqlite-process-run-repository.ts` | DELETE | EK-8 | `WorkflowEvent` + `TransitionObligation` |
| `factory_protocol_runs` / `factory_protocol_step_runs` | `src/process-modules/persistence/sqlite-protocol-run-repository.ts` | DELETE | EK-8 | `ProcessRun` / `NodeRun` |
| `factory_reconciliation_records` | `src/infrastructure/workplace/sqlite-reconciliation-ledger.ts` | DELETE | EK-8 | obligation completion receipts |
| `factory_recovery_attempts` / `factory_recovery_cases` | `src/process-modules/persistence/sqlite-recovery-case-repository.ts` | DELETE | EK-8 | typed fault results on obligations (EK-4) |
| `factory_replan_mandates` | `src/infrastructure/workplace/sqlite-replan-mandate-ledger.ts` | DELETE | EK-8 | planning repair commands (EK-6) |
| `factory_replay_capsules` / `factory_replay_capsule_invalidations` | `src/infrastructure/replay/sqlite-replay-capsule-repository.ts` | DELETE | EK-8 | content-addressed Development capsule through public ingress (EK-5) |
| `factory_run_terminal_event_receipts` | engine runtime receipts | DELETE | EK-8 | `TerminalProof` |
| `factory_scenario_installations` / `factory_scenario_module_locks` | `src/process-modules/installation/persistence/sqlite-scenario-installation-repository.ts` | DELETE | EK-8 | test-hosting scenario universe (EK-9) — not production relations |
| `factory_stage_runs` | `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts` | DELETE | EK-8 | `StageRun` aggregate |

### A.6 Migration sediment — mandatory DELETE (old schema mutation)

| Entry | Site | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `factory_process_products__new` / `factory_process_products_new` rebuild tables | `src/process-modules/persistence/sqlite-process-product-repository-v2.ts:75`, `sqlite-process-product-repository.ts` | DELETE (mandatory: schema mutation) | EK-8 | none — obsolete (fresh declarative schema, EK-3) |
| `factory_replay_capsule_invalidations_new` rebuild table | `src/infrastructure/replay/sqlite-replay-capsule-repository.ts:128` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE worker_executions ADD COLUMN display_name` | `src/schema.ts:37` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE lifecycle_execution_controls ADD COLUMN model_concurrency_limit` | `src/schema.ts:46` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE factory_cell_final_acceptances …` | `src/infrastructure/workplace/sqlite-cell-final-acceptance.ts:81` | DELETE (mandatory) | EK-8 | new-schema `CellFinalAcceptance` |
| `ALTER TABLE factory_accepted_authority_head ADD COLUMN …` (dynamic) | `src/infrastructure/workplace/sqlite-accepted-authority-head-repository.ts:56` | DELETE (mandatory) | EK-8 | new-schema head |
| `ALTER TABLE …__v2 RENAME TO …` ledger rebuild | `src/modules/development/infrastructure/development-verification-ledger.ts:195` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE factory_process_products ADD COLUMN node_id` | `src/process-modules/persistence/sqlite-process-product-repository-v2.ts:75` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE factory_lifecycle_runs / factory_process_transitions ADD COLUMN …` | `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts:190,202` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE factory_process_runs ADD COLUMN …` (7 columns) | `src/process-modules/persistence/sqlite-process-run-repository.ts:113-141` | DELETE (mandatory) | EK-8 | none — obsolete |
| `ALTER TABLE factory_transition_obligations ADD COLUMN last_reason_key / reason_repeat_count` | `src/process-modules/persistence/sqlite-transition-obligation-ledger.ts:173,177` | DELETE (mandatory) | EK-8 | new `TransitionObligation` (reason valve re-specified by EK-1) |
| `SCHEMA_VERSION` ladder + `user_version` handshake + `FACTORY_SCHEMA_MIGRATION_UNSUPPORTED` branch | `src/db.ts:115-205` | DELETE (mandatory: old schema bootstrap/mutation) | EK-8 | `ProtocolMetadata` exact-identity open; any other DB fails `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` (EK-3) |
| 115 `CREATE TRIGGER` guards (91 in `src/schema.ts`, 24 lazily in the §A.5 repositories; 109 unique names — immutability/no-update/no-delete guards, e.g. `trg_factory_work_intents_contract_immutable` `src/schema.ts:4`) | `src/schema.ts` + 11 lazy sites | DELETE | EK-8 | append-only guards re-declared in the fresh schema (EK-3) |
| 188 `CREATE [UNIQUE] INDEX` statements (121 in `src/schema.ts`, 67 lazy) | `src/schema.ts` + lazy sites | DELETE | EK-8 | fresh-schema indexes (EK-3) |

## B. `src/` production file sweep (508 code files + 57 resource/content files + 7 package .md)

### B.1 Root orchestration surface — DELETE @ EK-8

| Path(s) | Current authority role | Phase | Replacement |
|---|---|---|---|
| `src/index.ts` | MCP entrypoint; registers all legacy tools (projects…settlement-debug) | EK-8 | new production entrypoint routing to the new kernel composition (WP-12); typed commands + `KanbanCard` read API |
| `src/db.ts` | Old DB bootstrap, `SCHEMA_VERSION`, `getDb` singleton | EK-8 | fresh-protocol bootstrap module (EK-3; `src/workflow-kernel/persistence`) |
| `src/schema.ts` | Entire old DDL (91 tables, triggers, indexes) | EK-8 | one declarative fresh schema + fingerprint (EK-3) |
| `src/types.ts` | `Task`/board types | EK-8 | `WorkItem`/`KanbanCard` types |
| `src/worker-executions.ts` | `worker_executions` writer: fences, phases, voiding | EK-8 | `ActivityAttempt` aggregate commands |
| `src/worker-names.ts` | Worker display-name derivation (legacy rows) | EK-8 | attempt provenance naming (new kernel) |
| `src/orchestrate-cli.ts` | Old orchestration CLI | EK-8 | new run CLI under the runbook (EK-10 `FACTORY-RUNBOOK.md`) |
| `src/checkpoint-cli.ts` | Checkpoint capture/restore CLI | EK-8 | none — obsolete (obligation recovery; no snapshots) |

### B.2 `src/app/**` (18 files) — engine host, start, continuation — DELETE @ EK-8

All 18 files (`automatic-pre-spawn-recovery.ts`, `composition-root.ts`, `dispatch-loop.ts`, `engine-start-adoption.ts`, `engine-start-lifecycle-burial.ts`, `factory-boot-revision.ts`, `factory-continuation.ts`, `factory-documentation-continuation.ts`, `factory-redevelopment.ts`, `factory-release-continuation.ts`, `factory-start.ts`, `launch-terminal-settlement.ts`, `operator-soft-stop.ts`, `orchestration-idle-state.ts`, `product-lifecycle-repository-bindings.ts`, `product-lifecycle-run-starter.ts`, `product-lifecycle-runtime.ts`, `start-product-lifecycle-from-idea.ts`) are the old production orchestration entry/composition. **`engine-start-adoption.ts` and `factory-boot-revision.ts` are the mandatory-DELETE DB-adoption and schema-bootstrap-mutation members of this family.** Replacement: new composition root + obligation driver + lifecycle/stage/process/node aggregates (WP-05/WP-07/WP-09; cutover WP-12).

### B.3 `src/lifecycle/**` (21 files) — old writers, work assignment, recovery — DELETE @ EK-8

| Path(s) | Current authority role | Phase | Replacement |
|---|---|---|---|
| `work-assignment-core.ts` | **Scheduling through `tasks.status`** — atomic claim of board rows (`findNextClaimable`, `skillForTask`), writer of `tasks.{status,assigned_to,current_execution_id}` | **EK-7** (scheduling authority) | obligation leasing over `TransitionObligation` + `ActivityAttempt` (EK-4) |
| `application-service.ts`, `atomic-release.ts`, `idempotency.ts`, `worker-done-receipt.ts`, `task-recovery-memory.ts`, `stuck-policy.ts`, `submission-validation-rejections.ts`, `task-history-readers.ts`, `repository-lock.ts`, `payload-hash.ts`, `docs-worktree.ts` | Old lifecycle writers/readers around executions and tasks | EK-8 | kernel commands/idempotency (EK-2), obligation redrive (EK-4), evidence refs |
| `domain/**` (9 files: `commands`, `decode`, `effects`, `events`, `evolve`, `ids`, `invariants`, `state`, `index`) | Pure old-lifecycle reducer (evolve) — pure code, old protocol | EK-8 | new aggregate reducers in `src/workflow-kernel/domain/**` (WP-05) |

### B.4 `src/tools/**` (26 files) — MCP tool surface — DELETE @ EK-8

| Path(s) | Current authority role | Phase | Replacement |
|---|---|---|---|
| `dispatcher.ts` | `worker_next`/`worker_done` claim loop; routes by module/cell/role/executionProfile with legacy model-route fallback; drives `reevaluateDownstream` | **EK-7** (scheduling through `tasks.status`) | obligation consumer + `ActivityAttempt` (EK-4); cognition transport (WP-18) |
| `tasks.ts` | Board CRUD + `computeFinalRisk` + **`reevaluateDownstream` inferred dependency blocking/unblocking** (`tasks.ts:382`) | **EK-7** (mandatory DELETE: inferred dependency blocking/unblocking) | `WorkItemDependency` readiness over authoritative predecessor evidence (EK-6) |
| `subtasks.ts`, `epics.ts`, `projects.ts`, `comments.ts`, `notes.ts`, `templates.ts`, `activity.ts`, `search.ts`, `dashboard.ts`, `export-import.ts`, `observations.ts`, `conflicts.ts` | Board/annotation tool surface | EK-8 | projection read API + typed operator commands (WP-10) |
| `lifecycle.ts`, `lifecycle-runs.ts`, `process-modules.ts`, `process-node-submissions.ts` | Old lifecycle/process MCP surface | EK-8 | aggregate commands + public ingress |
| `dispatcher.ts` helpers: `conveyor-runtime-helper.ts` | Bridge worker-protocol commands to `ConveyorRuntime` (park/reserve/release on board) | **EK-7** | Workplace/attempt commands |
| `products.ts` | `product_submit` ingress + managed completion products | EK-8 | public new-protocol ingress (EK-5) |
| `artifacts.ts`, `repositories.ts`, `providers.ts`, `delivery-approvals.ts`, `settlement-debug.ts`, `universal-desk-helper.ts` | Artifact/repo/provider/approval/debug tools | EK-8 | content-addressed evidence refs, catalog, `TypedWait` approvals, new diagnostics |

### B.5 `src/application/**` (27 files) — conveyor runtime, routing, ports — DELETE @ EK-8

`conveyor-runtime.ts` (the v4 "cutover authority" that still mirrors `tasks.status` as reverse projection), `saga-application.ts`, `final-presentation-closure.ts`, `call-correlation.ts`, `concurrent-launch-budget.ts`, `execution-tool-catalog.ts`, `module-conformance-runner.ts`, `package-describe.ts`, `pretooluse-projection.ts`, `scenario-compiler.ts`, `tool-contribution-installer.ts`, `actionable-tool-error.ts`, `progress/**`, `routing/**` (execution-route resolver with the legacy fallback the plan forbids), `ports/**` (10 port files incl. `worker-executor.ts`, `orchestration-engine.ts`, `board-projection.ts`). Replacement: `src/workflow-kernel/application/**` driver (WP-07), role-contract route policy (WP-17), context accountant (WP-18), projector read API (WP-10). The `ports/sql-database.ts` thin port is subsumed by the new persistence layer.

### B.6 `src/checkpoints/**` (5) — DELETE @ EK-8 (obsolete: snapshots replaced by obligations)

### B.7 `src/factory-e2e/**` (2) — DELETE @ EK-8 (old E2E harness → EK-9 test engine)

### B.8 `src/helpers/**` (6) — DELETE @ EK-8 (activity logger → `WorkflowEvent`; `sql-builder` → new repositories; `git` → delivery effect adapters)

### B.9 `src/infrastructure/**` (66 files) — DELETE @ EK-8, except the pure-contract move in §G

| Group | Files | Phase | Replacement |
|---|---|---|---|
| Workplace repositories (24) | `infrastructure/workplace/sqlite-*.ts`, `infrastructure/workplace/git-integration-effect.ts`, `infrastructure/workplace/workplace-conformance-harness.ts`, `infrastructure/workplace/workplace-park-reasons.ts` (candidate-set, gate, cell-final-acceptance, workplace-production-revision, accepted-authority-head, workplace, product, sealed-product-material, execution-reservation, final-presentation-commitment, gate-finding-set-chain, author-candidate-carry-forward, scope-widening-ledger, reconciliation-ledger, recovery-epoch-ledger, replan-mandate-ledger, accepted-candidate-authority, managed-completion-product, production-cell-integration, production-cell-projection-persistence, workplace-production-resolver, workplace-park-reasons, workplace-conformance-harness, git-integration-effect) | EK-8 | new sole-writer repositories under `src/workflow-kernel/persistence/**` (WP-06); pure domain contracts move per §G |
| Workers (7) | `infrastructure/workers/*.ts` (claude-board-worker-executor, claude-worker-executor-factory, claude-worker-launcher, effective-desk-base, pre-spawn-failure-policy, repository-desk-provisioner, worker-process-termination) | EK-8 | cognition transport + desk provisioning under the new composition (WP-12/WP-18). The `FACTORY_CLAUDE_BACKEND_FORBIDDEN` guard in `tracker-view/claude-runner.mjs` is operational law that must be re-implemented, not lost (see §H) |
| Verification (9) | `infrastructure/verification/*.ts` (check providers, readiness executors, substrate-retry, warrant-oracle-adapters) | EK-8 | WP-11 workshop CheckPlan providers under new package paths; warrant-oracle is the open CC-U2 residual (§I) |
| Replay (9) | `infrastructure/replay/*.ts` | EK-8 | content-addressed capsule ingress (EK-5) |
| Runtime/projections/engine/factory/persistence/process-modules/work/workspaces/delivery/conveyor/source-change (17) | `node-worker-host-runtime.ts`, `sqlite-board-projection-reader.ts`, `work-item-projector.ts`, `workplace-projector.ts`, `engine-administration.ts`, `sqlite-factory-launch-repository.ts`, `sqlite-factory-runtime-repositories.ts`, `brief-provisioning-ports.ts`/`delivery-ports.ts`/`git-machine-ports.ts`/`lifecycle-input-policy-validation.ts`, `sqlite-work-assignment-adapter.ts`, `worker-supervision-service.ts`, `sqlite-workspace-resolver.ts`, `local-git-tag-delivery-provider.ts`, `conveyor-adapters.ts`, `managed-source-change-candidate.ts` | EK-8 | new projector (WP-10), new repos (WP-06), delivery effects as idempotent workshop effects (WP-11L) |

### B.10 `src/modules/**` (83 files) — workshop adapters over the old kernel — DELETE @ EK-8

`discovery/**` (9), `formalization/**` (24), `development/**` (29), `delivery/**` (10), `documentation/**` (9, incl. `WORKSHOP.md` → §B.12), `module-registration.ts`, `shared/artifact-storage-kind.ts`. Current role: workshop application/domain/infrastructure bound to the old kernel ports and SQLite. Replacement: WP-11D/F/V/L semantic packages (input/output product schemas, pure contribution mappings, CheckPlans, idempotent effects, typed waits) under the new workshop interface frozen in EK-1. No old path survives as a facade.

### B.11 `src/process-modules/**` (286 files) — the process-module stratum — DELETE @ EK-8

| Group | Files (counts) | Phase | Replacement |
|---|---|---|---|
| `application/**` (69 + 3 node-executors + 1 handler) incl. `transition-obligation-integrator.ts`, `transition-obligation-reconciler.ts`, `gate-run-driver.ts`, `production-cell-coordinator.ts`, `standard-production-cell.ts`, `execution-profile-resolver.ts`, `lifecycle-orchestrator.ts` | Old orchestration engine: the **old transition reconciler** (`transition-obligation-reconciler.ts` — crash-recovery loop over the old ledger, incl. the reason-identity valve) and its **integrator** (five handoff kinds on the old substrate) | **EK-8** (mandatory: old transition reconcilers) | stateless obligation consumer/driver with typed waits and fault semantics (EK-4, WP-07); handoff grammar re-frozen by the EK-1 transition universe |
| `domain/**` (6 + spi 16 + workplace 18) | Old domain model incl. the pure ADR-053 files analyzed in §G; SPI (manifest-factory, module-manifest, node-protocol, …) | EK-8 | new kernel domain (WP-05) + new workshop SPI (EK-1); §G contracts move |
| `persistence/**` (32) | SQLite repositories for §A.5 tables | EK-8 | new sole-writer repositories (WP-06) |
| `installation/**` (21) | Package store/installer/resume-compatibility (ADR-077 fingerprints, drift classification) | EK-8 | installed workshop manifest catalog with content-addressed digests; no resume-compatibility with old packages |
| `lifecycles/**` (4) | Product build/delivery/documentation lifecycle definitions | EK-8 | lifecycle aggregates (EK-6) + workshop manifests |
| `modules/**` code (53: process-module definitions, package index/manifest/assistance/contributions/nodes/ports) | Workshop package wiring over old kernel | EK-8 | WP-11 packages |
| `modules/**` resources (61 content files, enumerated §B.12) | Installed skills/checklists/trackers/call-templates | DELETE @ EK-8 (content re-hosted) | semantic content re-hosted as installed-manifest skill/hook declarations by WP-11D/F/V/L (landed); **old src paths deleted at EK-8** |
| `infrastructure/workplace-settlement-drain.ts`, `shared/**` (2) | Settlement drain + shared snapshots | EK-8 | aggregate settlement (EK-6) |

### B.12 Workshop package resources and skills (61 content files: 55 under `package/resources/**` + 5 formalization `nodes/use-case/resources/**` + `src/modules/documentation/WORKSHOP.md`)

All files under `src/process-modules/modules/{discovery,formalization,development,documentation,delivery}/package/resources/**` and `.../formalization/package/nodes/use-case/resources/**`. Disposition **DELETE** @ EK-8 (content re-hosted — amendment 2026-08-26): they are workshop *semantics* (cognition instructions, checklists, trackers, call templates), which the plan preserves ("A skill contains cognition instructions only"); they are re-hosted as content-addressed manifest resources by the WP-11 packages with digests pinned by the `CanonicalRoleContract` (`protocolSkillRef`/`semanticSkillRef`). The old file paths are deleted at EK-8. `WORKSHOP.md` (documentation workshop design note) moves into the documentation workshop package resources or dies with WP-11 conversion — owner WP-11.

### B.13 `src/planner/**` (3: `cascade.ts`, `fast-track.ts`, `topology.ts`) — DELETE @ EK-8 (old AC-to-card planning → EK-6 planning from idea/scope/unknowns/claims; no blind one-AC-to-one-card conversion)

### B.14 `src/replay/replay-capsule.ts`, `src/runtime/**` (6), `src/observability/run-journal.ts`, `src/shared/**` (10 — except the §G move of `canonical-json.ts`), `src/validators/brief.ts`, `src/types/pdfkit.d.ts`, `src/worker/impact.ts` — DELETE @ EK-8

`runtime/orchestration-mode.ts` is an old/new-style switch (mandatory DELETE class); `shared/authority/**` (execution-context, build-execution-context, authorize-tool-call) is the role-resolution-by-execution-context machinery replaced by the pinned `CanonicalRoleContract` (WP-17); `shared/assign-one-card.ts` is board assignment (EK-7 class); `shared/work-intent.ts` types are re-frozen by EK-1.



### B.15 `src/workflow-kernel/**` — the NEW runtime landed by the EK waves — KEEP (the replacement itself)

Landed 2026-08-24..26 by WP-05..WP-11/WP-13. These files ARE the replacement
column of this manifest — the future-namespace tokens the prose above
referenced, now landed. KEEP; classified so V2 no-rot holds over the grown
tree (the EK-8 cutover deletes the OLD side, never this tree).

| Path(s) | Role | Phase | Replacement |
|---|---|---|---|
| `domain/**`, `persistence/**`, `application/**`, `context-envelope/**`, `roles/**`, `development/**`, `planning/**`, `projection/**`, `testing/**`, `workshops/**` | the new event-projected kernel packages (model, sole-writer repositories, obligation consumer/waits/faults, context accountant + pre-send admission, role compiler, Development vertical + capsule ingress, planning/settlement, Kanban projection, test actors/fault scheduler, converted workshops) | — (KEEP: this IS the replacement) | n/a — the replacement itself |
| `composition/**` | **the EK-8 production composition (WP-12, landed 2026-08-26)**: the ONE composition root — the entrypoint (`entry.ts`, successor of the deleted legacy src/index.ts), the operational-law re-implementation (`laws.ts`: `FACTORY_CLAUDE_BACKEND_FORBIDDEN` fail-closed executor resolution, the `~/.claude/settings.json` sha256 tripwire, the `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS` guard), the real opencode channel (`opencode-channel.ts`), the frozen production admission pins (`pins.ts`: `RUNNING_COUNTER_IDENTITY` pinned, limit table digest-verified), the composition (`production.ts`) and the command-only console (`console.ts`) | — (KEEP: the EK-8 cutover deliverable) | n/a — the production path itself |
## C. `tracker-view/` production UI (34 files) — DELETE @ EK-8 (projection rebuilt by WP-10)

| Path(s) | Current authority role | Phase | Replacement |
|---|---|---|---|
| `tracker-view.mjs` | UI server; **board-write endpoints**: `POST /api/project/archive`, `/api/project/delete`, `/api/admin/purge-all-projects`, `/api/factory/start|pause|stop`, `/api/factory/concurrency`, `/api/engine/concurrency`, `/api/model/set`, `/api/repository/register|bootstrap` | EK-8 (endpoint replacement prepared at EK-7 as command-only, test-only) | command-only operator API (typed domain commands) + Kanban read model (WP-10) |
| `admin-endpoints.mjs` | Admin passthrough writes (POST proxy) | EK-8 | typed admin commands |
| `lifecycle-endpoints.mjs` | **Direct `INSERT INTO tasks`** (`lifecycle-endpoints.mjs:268`) and worker observation endpoints | **EK-7** (direct board write) | typed `WorkItem`/planning commands; projection read |
| `board-render.mjs`, `artifact-render.mjs`, `artifact-presentation.mjs` | Board/artifact rendering off `tasks`/`artifacts` | EK-8 | `KanbanCard` projection rendering |
| `claude-runner.mjs` + `claude-runner.d.mts` | Worker spawn through the opencode shim; hosts the `FACTORY_CLAUDE_BACKEND_FORBIDDEN` fail-closed guard and `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS` tripwire behavior | EK-8 | WP-18 instrumented OpenCode transport; **the claude-CLI prohibition and the `~/.claude/settings.json` tripwire must be re-implemented in the new transport — operational law, not legacy** |
| human-gate-endpoints.mjs (post-base §C addition, 2026-08-24; deleted 2026-08-26 with the §C sweep — un-backticked because it joined after the manifest base and is absent from every tree now) | Operator answer surface for GATE_HUMAN_REQUIRED parks + open worker questions (GET /api/human-gates, POST /api/human-gates/resolve, /api/human-requests*) — the Elite-2 gap closure | EK-8 | typed waits + operator disposition commands + the projection console (WP-10/WP-11V; D12) |
| `engine-supervisor.mjs`, `product-delivery-composition.mjs`, `product-delivery-local-release-composition.mjs`, `product-idea-source.mjs`, `repeated-tool-loop.mjs`, `structured-context-hook.mjs`, `model-management.mjs`, `verification-accounting-endpoints.mjs`, `git-bootstrap.mjs`, `shared.mjs` | Engine host/UI services around the old runtime (incl. `/api/model/set` writer and verification-accounting writes) | EK-8 | new engine host + command API; `/api/model/set` becomes a typed operator command under the runbook |
| `lifecycle-pipeline/**` (4), `docs-graph/**` (11) | Pipeline view + docs graph tool | EK-8 | projection views over the new read API (WP-10); docs-graph is tooling, re-pointed or deleted by WP-10 owner decision |

## D. `scripts/` and `tools/` operational surface

| Path(s) | Role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `scripts/factory.mjs`, `factory-engine-spawn.mjs`, `factory-bootstrap*.mjs`, `factory-status.mjs`, `hex-composition.mjs`, `bootstrap-*` (7 stage/testbed bootstraps), `check-*.mjs`, `real-factory-smoke.mjs`, `restore-from-checkpoint.mjs`, `testbed-*.mjs` (6), `quality-summary.mjs`, `wasted-turns-metric.mjs`, `lib/**` — `scripts/lib/provision-sandbox-product.mjs` (agent-proxy sandbox provisioning helper) KEEP — restored 2026-08-26: its agent-proxy test and the opencode workspace-marker contract survive the cutover | Old factory operators/testbed drivers over the old schema and checkpoint restore | DELETE | EK-8 | new run drivers under the runbook (EK-11 kit commands); old testbed bootstraps have no successor |
| `tools/agent-proxy/**` | opencode shim (**the only legal worker transport today**) | KEEP | — (survives cutover as the transport WP-18 instruments; its README moves with it) |
| `tools/adr-closure-registry.mjs` (+test) | ADR registry validator (`npm run adr-closure:validate` — EK-0/EK-13 blocking) | KEEP | — | — |
| `tools/run-acceptance-matrix.mjs`, `tools/legacy-freeze.mjs`, `tools/dep-graph-scanner.mjs`, `tools/cgad-spec-lint.mjs`, `tools/validate-completion-evidence.mjs`, `tools/verification-manifest.mjs`, `tools/build-receipt.mjs`, `tools/cc-proof-hosting-registry.mjs` (+ their tests) | Blocking ratchet/gate tooling kept green through the refactor (EK-9 canonical aggregate commands) | KEEP (re-pinned to the new tree by their owners) | — | — |
| `tools/harvest-golden-corpus.mjs`, `tools/capture-run-snapshot.mjs`, `tools/saga-snapshot.mjs`, `tools/saga-status.mjs`, `tools/saga-reset-stage.mjs`, `tools/discovery-run.mjs`, `tools/run-watchdog.mjs`, `tools/run-process-module-tests.mjs`, `tools/run-full-suite.mjs`, `tools/incident/**` | Old-run operations/snapshot/watchdog over the old runtime | DELETE | EK-8 | new qualification/evidence drivers (EK-9/EK-11); watchdog semantics re-owned by the driver (EK-4) |
| `tools/module-authoring-kit/**`, `tools/scenario-authoring-kit/**` | Authoring kits for the OLD package/scenario formats | DELETE | EK-8 (after EK-9 scenario contract lands its own kit) | EK-9 scenario contract + new workshop manifest authoring |
| `product-lifecycle-composition.mjs`, `reset-saga-db.mjs`, `run-hex-lifecycle-diagnostic.mjs`, `factory-execution-routes.json`, `codexArchExecutorRateLimit`, `*-lifecycle-input.json` / `*-input.json` (root, 6), `test-fixtures/**` | Root-level old-run drivers, routing config and testbed lifecycle inputs over the deleted runtime (same class as the §F idea inputs; the EK-11 corpus carries its own capsules) — classified in the WP-12 cutover commit (the original sweep missed the unscoped root) | DELETE | EK-8 | none — obsolete (the EK-9 corpus + the EK-8 composition entrypoint own their successors) |

## E. Tests and fixtures (510 test files + fixture trees)

Classification rule: an old test survives only as an *invariant/property* test re-pinned to the new kernel by its owning WP; tests that mirror the old implementation or pin old-protocol fixtures are DELETE. Deletion executes **only after the EK-9 blocking replacement exists** (plan EK-8 bullet: "Delete compatibility fixtures, implementation-mirroring tests … only after their invariant/mutation replacement is blocking").

**EK-8 execution note (WP-12, 2026-08-26):** the blocking replacements exist — the kernel suites (`tests/workflow-kernel/**`, 725 tests), the 20-project corpus (`tests/project-corpus/**` + `tools/project-corpus/**`), the WP-13C mutation-coverage harness and the removal guards — so the hard cutover executes the old-surface deletions NOW. The new-world trees below joined after the manifest base and are classified KEEP so the post-cutover manifest reflects the survivor state:

| Path(s) | Role | Disposition | Phase |
|---|---|---|---|
| `tests/workflow-kernel/**` (post-base: the EK kernel suites) | The event-projected kernel's blocking suites — model, persistence, roles, engine, application, context envelope, development vertical, projection, workshops, composition | KEEP (the EK-9 replacement the split rule required) | — |
| `tests/project-corpus/**` (post-base: WP-13D) | The 20-project scripted corpus + elite-kit replay suites | KEEP (the EK-9 replacement) | — |

| Path(s) | Role | Disposition | Phase |
|---|---|---|---|
| `tests/fixtures/golden-corpus/**` (4 corpora: stage10/11 docking ×3, accessible-counter; product/document payloads) | **Qualification evidence** of the predecessor's accepted-material chain (ADR-053 closure matrix references) | **KEEP** — immutable evidence; never regenerated against the new schema; the EK-11 20-project corpus creates its own fresh fixtures | — |
| `tests/architecture/fixtures/**` | Helper fixtures of the architecture suite | KEEP (test fixtures; the suite itself was re-classified below at the EK-8 cutover) | — |
| `tests/factory-contract/**` (27 + 11 design docs), `tests/factory-model/**`, `tests/factory-temporal/**` (10+9), `tests/factory-proof/**` (24) | Contract/model/temporal/proof suites over the old composition | SPLIT: invariant/property tests re-targeted by WP-13A; implementation-mirroring scenario tests (golden-path scripted walks of old tools) DELETE | EK-9 |
| `tests/process-modules/**` (130) | Old stratum suites (incl. ADR-053 material-chain tests: candidate-set-seal, accepted-head-*, authority-commit-*, effect-exactly-once, c8-*) | SPLIT: material-chain invariants re-hosted against the new repositories (WP-06/WP-08); old-substrate wiring tests DELETE | EK-9 |
| `tests/infrastructure/**` (70 at base; the EK-era guard files enumerated here are carved out) — old repository/adapter tests; `tests/infrastructure/deletion-manifest-guard.test.mjs` (EK-1 stop-gate hosting) KEEP; `tests/infrastructure/ek-admission-validator.test.mjs` (EK-1 admission-spec validator wrapper) KEEP; `tests/infrastructure/ek-removal-guard.test.mjs` (WP-13C removal guards, post-cutover shape) KEEP; `tests/infrastructure/ek-mutation-coverage.test.mjs` (WP-13C kernel mutation coverage) KEEP; `tests/infrastructure/ek-evidence-kit-determinism.test.mjs` (WP-13C kit determinism) KEEP; `tests/infrastructure/acceptance-matrix-coverage.test.mjs` (CI-02 self-check) KEEP; `tests/infrastructure/cc-proof-hosting.test.mjs` (ADR-092 proof-hosting registry) KEEP; `tests/infrastructure/cc-proof-hosting-manifest.mjs` (ADR-092 manifest data) KEEP; `tests/infrastructure/ek-fixtures/**` (WP-13C committed kit fixture) KEEP ; `tests/infrastructure/ek-mutation-registry.mjs` (WP-13C mutation registry data) KEEP | SPLIT (invariant → new repos; mirroring → DELETE) — the carved EK-era guard register survives the cutover | EK-8 |
| `tests/execution/**` (20), `tests/dispatcher-race/**` (15), `tests/lifecycle/**` (15+14 fixture files), `tests/app/**` (15), `tests/tracker-view/**` (2) | Race/lifecycle/app-host tests over `tasks`/`worker_executions` scheduling | DELETE (implementation-mirroring of the deleted scheduling authority) | EK-9 |
| `tests/spi/**` (12), `tests/installation/**` (11+fixtures) | Old package SPI / installation resume-compatibility tests | DELETE (old package format) | EK-9 |
| `tests/checkpoints/**` (8) | Checkpoint snapshot/restore tests | DELETE (obsolete mechanism) | EK-8/EK-9 |
| `tests/characterization/**` (2 + 8 fixture files) | Old-behavior characterization snapshots (2026-07-28 failures) | DELETE (characterization of deleted behavior; historical evidence stays in git) | EK-9 |
| `tests/factory-evidence/**` (4 dirs + manifests) | Harvested workshop evidence snapshots | DELETE (amendment 2026-08-27, FRF-WP11: the pre-EK harvest was orphaned at the EK-8 purge - consumed by nothing; the successor plan's deletion manifest (formalization-frf DELETION-MANIFEST rows B1/B2) executed the deletion) | — |
| `tests/factory-e2e/**` (6), `tests/factory/**`, `tests/factory-cycle/**`, `tests/factory-cardinality/**`, `tests/matrix/**`, `tests/mock-claude/**`, `tests/routing/**`, `tests/runtime/**`, `tests/planner-ac9/**`, `tests/fast-track/**`, `tests/application/**`, `tests/agent-proxy/**`, `tests/replay/**`, `tests/scenario/**`, `tests/semantic-identity/**`, `tests/extensibility/**`, `tests/completeness/**`, `tests/modules/**`, `tests/discovery/**`, `tests/` root (9), `tests/brief-ac1/**` (2 — old artifact_create/brief-validator suites, never hosted, old tool surface) | Old-surface suites | SPLIT by the same rule; the dominant disposition per suite is DELETE of old-surface cases with invariant survivors re-hosted by EK-9; `tests/agent-proxy/**` (transport guard) KEEP | EK-9 |
| `tests/fixtures/synthetic-modules/**`, `tests/fixtures/synthetic-scenarios/**`, `tests/fixtures/engine-spawn-stub.mjs` | Old package/scenario format fixtures | DELETE (old format) | EK-9 |
| `tests/architecture/*.test.mjs` — 74 old-substrate ratchet files executed at the cutover; `tests/architecture/adr-closure-registry.test.mjs` (ADR registry hosting) KEEP; `tests/architecture/claude-shim-provider-retry.test.mjs` (opencode shim provider-retry proof) KEEP; `tests/architecture/conveyor-transition-diagnostics-doc.test.mjs` (diagnostics document ratchet) KEEP; `tests/architecture/no-claim-scope.test.mjs` (claim-scope law) KEEP; `tests/architecture/submission-validator-diagnostics.test.mjs` REMOVED at EK-13-closure (audit r3 finding 1: the LAST quarantine entry removed WITH its file — zero-quarantine law; blocking successors: the kernel capsule-ingress typed-refusal battery + check-diagnostic decode proofs in the workflow-kernel suites); `tests/architecture/kernel-admission-distance.test.mjs` (the ADR-082 genericity guard, re-pinned post-cutover) KEEP; `tests/architecture/ek8-cutover-structure.test.mjs` (the new post-cutover structure ratchet) KEEP | ADR-053 gate snapshots, dependency-direction allowlists, worker-boundary/supervision/replay/production-cell/conveyor ratchets over the DELETED runtime (their subjects are gone; re-pinning each against the kernel would duplicate the kernel suites) | DELETE (old-substrate ratchets; successors: the kernel material-chain/settlement suites prove the ADR-053 material authority; `dependency-direction` succeeds by the kernel dependency-direction law in the new structure ratchet; the worker/transport boundaries by `tests/workflow-kernel/context-envelope` + `composition` suites; the legacy-expansion freeze by legacy-zero L1) | EK-8 |

## F. Other production-adjacent trees

| Path(s) | Role | Disposition | Phase | Replacement |
|---|---|---|---|---|
| `skills/**` (28 md files across the agent-skills tree) | Agent-facing skills for the OLD flow (dispatch, tracker, worker protocol, planning-reviewer…) | DELETE per skill as its workflow dies; cognition-only content re-hosted as `semanticSkillRef` resources by WP-11/WP-17 | EK-8 | installed manifest skills pinned by role contracts |
| `agents/*.md` (6) | Old product-board agent briefs (analyst/architect/planner/product/worker/kickstart) | DELETE | EK-10 | new launch briefs from `CanonicalRoleContract` profiles |
| `modules-ext/**` (3 synthetic workshops + resources), `scenarios-ext/**` | Synthetic non-game workshop proof material (ADR-085) | KEEP through EK-8 as the synthetic-workshop precedent, then re-expressed as a new-interface synthetic workshop (EK-8 requirement) — old format DELETE | EK-8 | new workshop interface |
| `ideas/**` (2 md) | Old testbed idea inputs | DELETE | EK-8 | EK-11 project corpus capsules |
| `core-view/`, `workshop-designer/`, `tool-templates/` | Old UI experiment / designer tooling / stage-tracker templates | DELETE | EK-8 | WP-10 UI; new authoring kit |
| `.claude/skills/saga-mcp/SKILL.md` | Operator-side skill pointing at the old MCP surface | DELETE | EK-10 | new tool surface doc |

## G. ADR-053 material contracts — successor record (post-cutover amendment, 2026-08-26)

The plan permitted RETAIN-AND-MOVE **only** for pure contracts with one owner
and no import from a deleted runtime. Import analysis was verified 2026-08-24
on the base tree. **EK-8 amendment (WP-12, 2026-08-26): every §G contract was
re-frozen and re-implemented inside the new kernel by the WP-05..WP-08 waves
BEFORE the cutover — the canonical new package already carries each contract,
so no file move occurs; the pure predecessor files are DELETE @ EK-8 with the
landed successor named (no forwarding facade, no duplicate).** The one
remaining pre-cutover §G residual — three type-only imports among the §G
files themselves (candidate-set/gate → `spi/index.ts`, canonical-json →
`discovery-proposal.ts`) — dies with the files.

| File | Chain member | Successor in the new kernel (landed) | Verdict |
|---|---|---|---|
| `src/shared/canonical-json.ts` | canonical serialization/digest used by every contract below | `src/workflow-kernel/domain/digest.ts` (`canonicalJson`/`sha256OfCanonical`, the EK-1 re-free) | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/workplace-ref.ts` | Workplace identity (ADR-053 material coordinates) | `src/workflow-kernel/domain/types.ts` (kernel `Workplace` aggregate identity) + `src/workflow-kernel/development/material-chain.ts` | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/workplace-production-revision.ts` | `WorkplaceProductionRevision` — the accepted-material authority itself | `workplace.sealProductionRevision` in `src/workflow-kernel/domain/reducers/workplace.ts` (the accepted-material evidence kind + sole-writer repository) | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/candidate-set.ts` | `CandidateSet` (author/reviewer presentation bound to one revision) | `workplace.presentCandidateSet` reducer + `CandidateSet:author/reviewer` evidence kinds (kernel domain) | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/gate.ts` | `GateDecision` (decision over exact CandidateSet + CheckPlan) | `workplace.runAuthorGate`/`runFinalGate` reducers + `GateDecision:*` evidence kinds (kernel domain) | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/accepted-authority-head.ts` | accepted-authority head contract | `Workplace` aggregate head revision (`src/workflow-kernel/persistence/workplace-repository.ts`, sole-writer head) | SUPERSEDED — DELETE @ EK-8 |
| `src/process-modules/domain/workplace/check-diagnostic.ts` | gate finding/diagnostic contract | CheckPlan external-input evidence kinds (kernel domain + `workshops/*/checkplans.ts`) | SUPERSEDED — DELETE @ EK-8 |

Chain members with **no pure predecessor file** (the contract is re-frozen by the EK-1 schema, implemented fresh in WP-05/WP-06/WP-08):

- `EffectReceipt`: the only typed surfaces lived in `src/process-modules/application/post-acceptance-effects.ts` and in persistence/runtime files. **Failed the purity test → not RETAIN-AND-MOVE as a file**; the effect-receipt contract was re-frozen as obligation-driven effects (`workplace.settleEffect`, the sole EffectReceipt writer — R13) and the file is DELETE @ EK-8 with its §B.11 tree.
- `CellFinalAcceptance`: existed only as SQLite persistence (`src/infrastructure/workplace/sqlite-cell-final-acceptance.ts`). **Failed the purity test → DELETE @ EK-8**; the new relation lives in the fresh kernel schema (`workplace.recordFinalAcceptance`).
- `production-cell-reducer.ts` / `workplace-state.ts` were pure but encoded the **old loop protocol** (loop states + Kanban mirroring), not ADR-053 material contracts → DELETE @ EK-8, replaced by the new `Workplace` reducer (WP-05).

One-owner verification (historical): each §G file had exactly one defining module (verified by `grep -rln` over `src/` at the manifest base); their many importers (`factory-start.ts`, `products.ts`, repositories, check providers) were all classified DELETE above — importer death did not affect contract purity, and the kernel never imported any §G file (verified 2026-08-26 before the cutover: zero hits for §G paths under `src/workflow-kernel/**` and `tests/workflow-kernel/**`).

## H. Mandatory-DELETE classes (plan EK-1 checklist) — where they live in this manifest

| Plan-mandated class | Entries |
|---|---|
| Scheduling through `tasks.status` | §A.1 `tasks`, `task_dependencies`; §B.3 `work-assignment-core.ts`; §B.4 `dispatcher.ts`, `tasks.ts`, `conveyor-runtime-helper.ts`; §B.5 `conveyor-runtime.ts`; §C `lifecycle-endpoints.mjs` |
| Direct Workplace updates | §B.9 workplace repositories (direct SQLite writers), §C board-write endpoints |
| Inferred dependency blocking/unblocking | `reevaluateDownstream` (`src/tools/tasks.ts:382`); `factory_workplace_graphs/_items/_dependencies` (§A.3) |
| Old transition reconcilers | `transition-obligation-reconciler.ts` + `transition-obligation-integrator.ts` + `sqlite-transition-obligation-ledger.ts` (§B.11) |
| Old schema bootstrap/mutation | `src/db.ts` ladder; `src/schema.ts` bootstrap + 13 `ALTER TABLE` sites + `__new` rebuild tables (§A.6, §B.1) |
| DB adoption | `engine-start-adoption.ts`; `factory_adoptions`, `factory_production_adoption_decisions`, `factory_development_verification_adoptions` (§A.4); checkpoint restore (`src/checkpoints/**`, `scripts/restore-from-checkpoint.mjs`) |

**Operational law preserved through deletion (must be re-implemented, not lost):** the claude-CLI prohibition with fail-closed executor resolution (`tracker-view/claude-runner.mjs`) and the `~/.claude/settings.json` sha256 tripwire + `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS` (AGENTS.md directive) — carried into the WP-18 transport and the EK-10 runbook.

## I. Predecessor residuals — carried into EK-13, NOT deleted (from `docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md`)

1. Development demonstration residues (6 structural tokens) + delivery 2 (K4 crash-after-effect; restart idempotent-settlement) + documentation 10 fault/recovery families.
2. Nine low authority seams (ratchet-guarded; closure matrix).
3. CC-41 fault scheduler + CC-42 deterministic minimization (refused per protocol) — succeeded by EK-9 engine requirements.
4. CC-U2 warrant-oracle command authority (reserved ADR-093) — EK-8 amendment (WP-12, 2026-08-26): `src/infrastructure/verification/warrant-oracle-adapters.ts` could NOT survive the cutover (its import substrate — application ports, shared/canonical-json, local-runnability-check-provider — is DELETE-classified and its only consumers died with tests/infrastructure); it was deleted with its tree. `tools/cc-proof-hosting-registry.mjs` SURVIVES (KEEP, §D: it guards the acceptance matrix, not the old runtime). The open ADR-093 question is re-classified against the new kernel at EK-13: the fresh runtime exposes no warrant-oracle seam (readiness is CheckPlan external-input evidence).
5. EK-12 honest blocker: the OpenCode shim does not prove per-turn budget — prerequisite instrumented pre-send transport (WP-18).
6. ADR-096 gate item 1 PARTIAL (Development obligations 34/40).

## J. Counts

- Schema: **91** `CREATE TABLE` in `src/schema.ts` — 91 DELETE (5 at EK-7: `tasks`, `task_dependencies`, `factory_workplace_graphs`, `factory_workplace_graph_items`, `factory_workplace_dependencies`; 86 at EK-8) + **33** lazily created tables outside it (all DELETE @ EK-8; grep artifacts `IF`, `applies`, `carries` are comments, not tables) + **3** migration rebuild tables (`factory_process_products__new`, `factory_process_products_new`, `factory_replay_capsule_invalidations_new`) + 13 `ALTER TABLE` sites + 115 trigger guards (109 unique) + 188 index statements (all DELETE @ EK-8) = **127 table names classified, 0 unclassified**.
- `src/`: 572 tracked files at base = 7 §G code contracts + 61 §B.12 content files + 504 plain DELETE — **all 572 deleted @ EK-8** (the §G contracts and §B.12 content were re-frozen/re-hosted inside `src/workflow-kernel/**` by WP-05..WP-11 before the cutover; amendment 2026-08-26) + **504 DELETE** (of which 5 are EK-7-class scheduling-surface files: `work-assignment-core.ts`, `dispatcher.ts`, `tasks.ts`, `conveyor-runtime-helper.ts`, `conveyor-runtime.ts`; the rest EK-8). 0 unclassified, 0 both-DELETE-and-RETAIN.
- `tracker-view/`: 33 files DELETE @ EK-8 (`lifecycle-endpoints.mjs` carries the EK-7-class direct `INSERT INTO tasks` write; `tracker-view.mjs`/`admin-endpoints.mjs` carry the board-write endpoints replaced by command-only adapters at EK-7/EK-8).
- `scripts/` + `tools/`: §D classifies all 97 files — KEEP: `tools/agent-proxy/**` (the opencode transport), `tracker-view-ek/**` + `core-view-ek/**` (the new-kernel front clones — operator directive 2026-08-27; command-only console wrappers + readonly observer, no factory authority) and the blocking gate/ratchet tooling (adr-closure-registry, run-acceptance-matrix, legacy-freeze, dep-graph-scanner, cgad-spec-lint, validate-completion-evidence, verification-manifest, build-receipt, cc-proof-hosting-registry, with their tests); DELETE @ EK-8: the old factory/testbed drivers under `scripts/` (26 files + `lib/`), old-run operations (snapshot/status/reset/watchdog/discovery-run/run-process-module-tests/run-full-suite), and both old-format authoring kits.
- Tests/fixtures: 510 test files — **KEEP**: golden-corpus fixtures (4 corpora), architecture ratchet suite (80), factory-evidence snapshots, agent-proxy guard tests; **SPLIT** (invariant survivors re-hosted at EK-9): factory-contract/model/temporal/proof, process-modules, infrastructure, mixed suites; **DELETE @ EK-9**: execution/dispatcher-race/lifecycle/app/tracker-view scheduling mirrors, SPI/installation, checkpoints, characterization, synthetic-format fixtures. 0 unclassified.
- Nothing is both DELETE and RETAIN.
