# STATE_MATRIX — Durable state machines, owners, terminals, and liveness classification

- **Base:** `12d46037` (production citations frozen at `586871ad`, still
  line-valid — GRAPH_RECONCILIATION header).
- **Model:** the mapped system is an extended LTS of DURABLE database-backed
  aggregates (00 contract §3), NOT a finite automaton: content-addressed
  material has unbounded digests and the same abstract state may materialize
  unbounded concrete rows. `tasks.status`, board columns, controller labels,
  host snapshots and log activity are PROJECTIONS/telemetry — never authority
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1071-1091`).
- **Liveness classes (CONVEYOR §23 progress-obligation invariant,
  `:1125-1152`):** `live-owner`, `runnable-command`, `typed-wait`,
  `transition-due`, else `stalled` / `inconsistent-state`.

## 1. Machine matrix

| id | Machine / durable aggregate | Authoritative owner | States / terminals (map resolution) | CAS / fence / monotonicity | Liveness class when nonterminal | Evidence |
|---|---|---|---|---|---|---|
| SM-1 | LaunchRequest (launch ticket) | launch repository: `requested → claimed → running → paused \| completed \| failed` | terminal statuses write-once | single-use CAS claim; acknowledged only by durable lifecycle start receipt | `transition-due` (claimed → run exists) | `src/app/product-lifecycle-run-starter.ts:79-184`; `src/infrastructure/factory/sqlite-factory-launch-repository.ts:289-322`; reverse `STATE-LAUNCH-CLAIM` |
| SM-2 | LifecycleRun / StageRun | lifecycle repository + stage-transition journal | running; terminals: `runnable-local` (build only), `released`, `approval-required`, `delivery-blocked` (delivery only), `development-blocked`, `formalization-inconsistent`, `failed` | lease-CAS `completeStage`; terminal stamped write-once; fenced obligation `in_progress` before route | `transition-due` (settled outcome → route) | `src/process-modules/lifecycles/product-delivery-lifecycle.ts:479-484`; reverse `R-RELEASED-TERMINAL`, dep-01; forward terminals e39-e41, e50-e53 |
| SM-3 | ProcessRun | ProcessRun repository: `created → preparing → running → paused \| settling → terminal` | local outcome + authority fields write-once (`generic-flow-executor.ts:325-408`; `process-run.ts:144-183`) | definition/package pin; input hash | `runnable-command` (next node) | reverse `OUTC-DELIVERY-RELEASED`; `STATE-PROCESSRUN-PINNED-REPLAY` |
| SM-4 | NodeRun (flow cursor) | generic flow executor + NodeRun repository | `running → completed \| failed`; crash-window accounting | durable cursor; seeded step budget (`generic-flow-executor.ts:603-679,958-972`) | `runnable-command` | reverse `AUDIT-NODERUN-V2-DURABLE`, dep-27 |
| SM-5 | Workplace (production cell instance) | Production Cell reducer over Kanban phase, loop state, role, revision | loop states: `idle → queued → leased/running → verifying → repair_wait \| effect_pending \| paused(human) → terminal(accepted \| failed)` | revision/fence CAS; terminal monotonicity; WorkplaceRef {processRunId, moduleRef, productionCellId, workKey} deterministic (`CONVEYOR-MENTAL-MODEL.md:1077-1089`) | `live-owner` (lease) / `typed-wait` (dependency/backoff/human) | forward `cell.*` nodes; `production-cell-node-executor.ts:477-534` |
| SM-6 | WorkerExecution / reservation | execution repository: fenced attempt | `claimed/running → exited(terminal)`; liveness ≠ log silence (Sign 010, `GUARDRAILS.md:93-98`) | assignment CAS + fence + lease; host/PID/process-birth identity reconcile | `live-owner` | `src/worker-executions.ts`; `tracker-view/claude-runner.mjs` |
| SM-7 | CandidateSet | immutable `absent → sealed` QC handoff | sealed once per role+revision; identity never includes execution provenance (ADR-053) | content digest over Workplace production revision | n/a (immutable once sealed) | reverse `STATE-CELL-FINAL-ACCEPTANCE` prerequisites; `CONVEYOR-MENTAL-MODEL.md:147-173` |
| SM-8 | GateRun / GateDecision | gate driver + immutable decision ledger | one applicable typed decision per subject/revision; verdicts `accepted \| repair_required \| human_required \| failed` | append-only; stale-fence submission impossible | `runnable-command` (obligation re-drive) | `production-cell-node-executor.ts:1137-1254`; CONVEYOR §6 `:191-239` |
| SM-9 | ExternalEffect / EffectAttempt (incl. delivery ledger, git-integration) | effect ledger + provider observation protocol | attempts: `claimed → succeeded \| failed \| blocked \| uncertain`; observation `matched \| mismatched \| unknown \| error` | deterministic actionKey; observe-before-execute; effectively-once | `typed-wait` (reconcile unknown) | `src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts:455-608`; `src/infrastructure/workplace/git-integration-effect.ts:57-182`; reverse `EFFECT-LEDGER-IDEMPOTENT` |
| SM-10 | Human approval (delivery inbox) | immutable approval inbox + MCP decide tool | `not-required \| pending \| approved \| denied \| expired`; pending → run paused, settles `approval-required` | decision rows immutable; bound to candidate+preflight+policy hashes | `typed-wait` (human) — the ONLY lawful human waits: release approval, blocked post-acceptance effects, spawn breakage (`CONVEYOR-MENTAL-MODEL.md:1606`) | `src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts:43,73`; reverse `HUMAN-APPROVAL-DECISION`, dep-13/14 |
| SM-11 | Recovery epochs / budgets (ADR-075) | executor epoch machine | `attempt → epoch-exhausted → rollover+backoff (1–15 min) → … → total-cap → terminal failed`; convergence waiver (strict-subset keys) is NOT charged | append-only `factory_workplace_recovery_epochs`; totalAttempts default 30 | `typed-wait` (backoff with wake source) | `production-cell-node-executor.ts:783-916`; forward e72-e78 |
| SM-12 | Replay capsule archive | capture at CellFinalAcceptance + lazy sweep at exit | certified `absent → captured`; rejected attempts never certified | certification consumes CellFinalAcceptance, never raw accepted verdict | n/a | `product-lifecycle-runtime.ts:374`; `orchestrate-cli.ts:704`; CONVEYOR §12 |
| SM-13 | Verification ledger (criterion keys, CC-GAP-8) | opens atomically with task-graph product | per-key `proposed → pending → executed/waived/terminal-*`; triggers reject UPDATE/DELETE; terminal-route facts never discharge | append-only; never reopens legacy graphs | `transition-due` at settlement | `src/modules/development/infrastructure/development-verification-ledger.ts:1-29`; `sqlite-development-settlement-state.ts:142-152` |
| SM-14 | **Task projection (Kanban `tasks`) — the task-shadow seam (P0)** | projection owner: runtime persistence | projection ONLY (CONVEYOR §19: card is a projection, never authority) — but the crash-attempt accounting port `readTaskForWorkplace` selects `ORDER BY id DESC LIMIT 1`, so in a singleton workplace with author+reviewer task rows the NEWEST (reviewer) task SHADOWS the author's task for: (a) `rawAttemptCounters` recovery-budget counting, (b) `resolveScopeWidening` bindings | no fence; selection by recency — the exact anti-pattern ADR-053 forbids | during Elite-8 the counter read CLEAN executions of the shadowed task through 15 deaths → budget never engaged (rollover table empty); parking became a race, won at 3× the limit | `src/app/product-lifecycle-runtime.ts:587-593`; `production-cell-node-executor.ts:2317-2337,2424-2463`; `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:80-86`; `docs/factory-map/03_DEVELOPMENT.md:580-601` |
| SM-15 | Engine host / watchdog | engine supervisor (panel) | host states: alive, freeze-detected (`freeze_detected`/`restart_attempted` durable BEFORE stop), `failed_watchdog` after budget | heartbeat ≤5 s; sweep 30 s; backoff 1→5→15 min; duplicate engines blocked by sweep-before-spawn | `live-owner` (supervisor owns restart) | `tracker-view/engine-supervisor.mjs:208-232`; forward e82-e83 |
| SM-16 | Launch settlement / order leaf | launch settlement projection | exit 0 (operational terminal, ANY verdict) / exit 1 (failed or drain failure) / exit 2 (paused) / `failed_watchdog` | exit code ≠ product success (no engine classifier); terminal record is the only verdict authority | `transition-due` | `src/orchestrate-cli.ts:740-774`; `src/app/launch-terminal-settlement.ts:52,87` |

## 2. Cross-machine synchronization edges (necessary, not local)

From CONVEYOR §23 (`CONVEYOR-MENTAL-MODEL.md:1104-1123`) — each row is a
REQUIRED hand-off; missing any of them is the "legal-but-stalled" failure
class (ADR-048; Sign 015 `GUARDRAILS.md:128-133`):

launch-claimed→run-bound; stage-selected→StageRun/ProcessRun-bound;
cell-reached→workplaces-sealed; queued-eligible→reservation+execution;
worker-done→verify+seal; os-exit→execution-terminalized; verifying→CandidateSet
+GateRun; gate-accepted-with-effect→EffectAttempt (stay `effect_pending`);
cell-final→CellFinalAcceptance+terminal; obligations-complete→NodeRun advance;
process-terminal→settle+route; lifecycle-terminal→launch settle + order leaf.

Fenced obligation re-drive inside every `runEpisode`
(`product-lifecycle-runtime.ts:1088,1245`) + ADR-087 terminal drain +
`factory.obligation-reconciler` (forward e88) carry these.

## 3. Workplace loop-state table (forward u3 closure)

`idle → queued → leased/running → verifying → repair_wait | effect_pending |
paused(human) | terminal(accepted|failed)` with transitions guarded inside
`ProductionCellNodeExecutor` reconcile branches
(`production-cell-node-executor.ts:646` onward; full walk in
`docs/factory-map/FORWARD_GRAPH.md:130-163`). The authoritative per-edge CAS
lives in ProductionCellCoordinator/SqliteWorkplaceRepository (forward u3
records the map cites-but-does-not-enumerate; this reconciliation keeps that
boundary honest rather than inventing edges).

## 4. Terminal inventory (consolidated)

- Lifecycle business terminals (SM-2): 7 (see GRAPH_RECONCILIATION §3 roots).
- Workplace: `terminal(accepted)` (CellFinalAcceptance), `terminal(failed)`
  (budget/cap/scope-refusal/final-verdict), `paused(human_required)`.
- Launch/engine (SM-16): exit 0/1/2, `failed_watchdog`.
- Every terminal is write-once + receipt-backed; `terminal_status`,
  `stage_outcome`, `product_outcome` are SEPARATED channels (CC-GAP-2,
  verified live at Elite-7 terminal: `docs/factory-run/stage21-elite7/RUN-TRACKER.md:94-100`).

## 5. Known state-machine defects and residuals (open, honest)

1. **SM-14 task-shadow (P0, confirmed)** — see row. No CI counterexample
   exists; every unit test stubs the port (R3 open).
2. **Epic-scoped material accumulation** — Formalization settlement
   `readAcceptedArtifacts` epic-scoped, not lifecycle-scoped (TB-11 closed
   only `areTasksReady`): a baseline of a new run can mix material of dead
   runs (`CONVEYOR-MENTAL-MODEL.md:1603`).
3. **Newest-wins capsule binder** — on a third lifecycle of the same
   Workplace the binder may select run N−2's capsule against run N−1's frozen
   baseline → `FINAL_PRESENTATION_FENCE_MISMATCH` park without
   invalidate/Regenerate path (`CONVEYOR-MENTAL-MODEL.md:1604`).
4. **Resume compatibility ignores implementation digests**
   (`resume-compatibility-policy.ts`) — rewritten handlers can classify
   `compatible` (`CONVEYOR-MENTAL-MODEL.md:1605`).
5. **Budget semantics split** — descriptor says review budget counts rounds
   reason-blind; executor implements finding-trajectory waiver/charge split;
   treat §15's separation mechanism as PARTIALLY landed
   (`docs/factory-map/03_DEVELOPMENT.md:807-814`).
