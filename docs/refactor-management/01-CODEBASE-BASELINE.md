# 01 — Codebase Baseline (Pre-Wave-0 Reconnaissance)

> Snapshot taken 2026-07-28 from `agent/saga3-process-modules` branch.
> This is the "before" picture every wave builds on. Treat any drift from this
> as a signal, not a baseline.

## Repo orientation

- **Root:** `D:/Разработка/saga-mcp`
- **TypeScript** in `src/` (compiled to `dist/`); `.mjs` runtime glue at root and in `tracker-view/`, `tools/`, `skills/`.
- **Test framework:** Node.js built-in `node:test` (no Jest/Vitest). No separate test-runner config file.
- **package.json:** name `saga-mcp`, version `2.0.0`. Scripts: `build` (`tsc`), `test` (`tsc && node --test`), `test:process-modules[:a|:b]` (via `tools/run-process-module-tests.mjs`), `test:architecture`, `test:characterization`, `test:e2e`, `test:legacy:pipelines`, `mock:run`.

## `src/process-modules/` — the refactor's primary surface

### Domain layer — `domain/` (clean, mostly serializable)
| File | Purpose |
|---|---|
| `process-module.ts` (187) | Central contract: `ProcessModuleDefinition` + manifest types (identity, SchemaReference `{id:string}` only, outcomes, artifact types, policies, invariants, retry/recovery, ExecutionProfileDefinition, discriminated-union FlowDefinition with kinds lm/kernel/human/external/composite). |
| `lifecycle.ts` (87) | `LifecycleDefinition`, `StageBinding`, `TransitionTarget`, mapping expr types, **`routeResolver?: RouteResolver` — a non-serializable function field** (documented dodge: serializes to `undefined`, contributes only a present/absent bit to the hash). |
| `recovery.ts` (114) | Module-agnostic `RecoveryIssue`/`RecoveryFeedback` + schema-id constants. |

### Application layer — `application/`
| File | Smell (drives the refactor) |
|---|---|
| `execution-profile-resolver.ts` (94) | **Imports built-in catalog** as module singleton; **prefix + first-match** heuristics (`taskKind.split('.')[0]`, `executionProfiles[0]`). |
| `process-execution-workspace.ts` (433) | **Workspace-relative path literals** from profiles; board/task concepts (`epic_id`, `metadata`); real `node:fs` I/O; treats Markdown tracker as worker-maintained. |
| `generic-flow-executor.ts` (950) | **Mutable in-memory `NodeExecutionFrame`** (productions/receipts maps) reconstructed each step; `Map<string,NodeExecutor>`; receipt fields carry board/task/WorkIntent ids. |
| `node-executors/lm-node-executor.ts` (590) | `LmNodeExecutionPersistence` is a parameterized clone of the saga3 discovery projection — board/task/WorkIntent coupling in the SPI despite "agnostic" claims. |
| `node-executor.ts` (197) | SPI port leaks board/task vocab: `NodeProduction.bindings` keys (`proposalId`, `workIntentId`), `NodeExecutionReceipt` (`intentId`/`taskId`/`executionId`). |
| `lifecycle-orchestrator.ts` (653) | Wires many repos/registries; **definition hash silently drops function resolvers**; resolves installation at stage-execution time instead of pinning at LifecycleRun start. |
| `lifecycle-router.ts` (91) | `routeProcessOutcome` asks `routeResolver` first then static table; local `Set` for validation only. |
| `lifecycle-mapper.ts` (108) | JSON-path/literal/runtime mapping; hardened vs `__proto__`; local `Set` runtime-only. |
| `exact-candidate-acceptance.ts` | Common-gate acceptance wired directly into kernel executor — **artifact-specific physics inherited by non-artifact modules** (plan §13.23). |
| `generic-flow-engine-adapter.ts`, `legacy-engine-executor-adapter.ts`, `lifecycle-orchestration-engine-adapter.ts`, `process-module-runtime-engine.ts` | Adapter bridges to legacy `OrchestrationEngine`. |
| `process-module-executor.ts` | `ProcessModuleExecutor` SPI + `ProcessModuleRunResult`/`Installation` types (compatibility seam to preserve, then narrow). |
| `process-module-registry.ts`, `process-module-installation-registry.ts`, `process-output-payload-registry.ts` | Runtime registries; the last **reopens module-specific storage after completion** (plan §13.12). |
| `validate-process-module*.ts` | Descriptor/installation/result validators. |
| `external-adapter-registry.ts`, `human-interaction-registry.ts`, `kernel-handler-registry.ts` | Pluggable handler registries (all use `Map`). |

### Composition — `composition/` (single file, no separate root)
| File | Smell |
|---|---|
| `product-lifecycle-runtime.ts` (483) | **The manual composition root.** Hard-wires 4 `GenericFlowExecutor`s, node-executor map, both built-in registries, kernel/external/human registries, `ProcessOutputPayloadRegistry`, `LifecycleOrchestrator`, lifecycle adapter. Imports ~30 concrete symbols (every module's process-module, schemas, ports, sqlite runtimes, all 10 sqlite repositories). Any new module/port forces an edit here. |

### Lifecycles — `lifecycles/` (single file)
| File | Smell |
|---|---|
| `product-delivery-lifecycle.ts` (435) | **Direct imports of concrete module schema/policy/ref symbols** from all 4 modules. **`routeResolver` attached via `Object.defineProperty({enumerable:false})`** to dodge canonicalJson. Product-specific validation baked in. |

### Modules — `modules/` (4 production packages)
| Package | identity | Largest files | Smell |
|---|---|---|---|
| `discovery/` | `product-discovery@3.0.0` kind `discovery` | `discovery-process-module.ts` (302), `discovery-installation.ts` (933) | Global skill literals (`saga-discovery-worker` etc.); workspace path literals (`tool-templates/discovery/*`); **reaches into `src/saga3/domain/`** — not self-contained. |
| `formalization/` | `solution-formalization@1.0.0` | `formalization-installation.ts` (1899), `sqlite-formalization-kernel.ts` (457), `formalization-process-module.ts` (406), `legacy-formalization-process-adapter.ts` (270) | Global skill literals (`saga-product`, `saga-analyst`). |
| `development/` | `solution-development@1.0.0` | `sqlite-development-runtime.ts` (1598), `development-installation.ts` (1112), `development-settlement-policy.ts` (930) | Global skill literal (`saga-planner`). |
| `delivery/` | `delivery-release@1.0.0` | `sqlite-delivery-runtime.ts` (839), `delivery-installation.ts` (892), `delivery-settlement-policy.ts` (946), `sqlite-delivery-approval-inbox.ts` (387) | — |

Plus `modules/catalog.ts` (14 lines, `createBuiltInProcessModuleRegistry`) and `modules/installations.ts` (40 lines, `createBuiltInProcessModuleInstallationRegistry`).

### Persistence — `persistence/` (NO migration files here; DDL embedded in each sqlite adapter)
Port + sqlite pairs:
- ProcessRun: `process-run.ts` / `process-run-repository.ts` / `sqlite-process-run-repository.ts` (`saga3_process_runs`)
- NodeRun: `node-run.ts` / `sqlite-node-run-repository.ts` (`saga3_node_runs`)
- LifecycleRun + StageRun: `lifecycle-run.ts` / `-repository.ts` / `sqlite-lifecycle-run-repository.ts` (`saga3_lifecycle_runs`, `saga3_stage_runs`; StageRun has no standalone file)
- ProcessOutcomeCertificate, RecoveryCase, ExternalEffectLedger — each port + sqlite.
- Standalone stores (no separate port file): `sqlite-exact-candidate-acceptance.ts`, `sqlite-managed-node-submission-repository.ts`, `sqlite-managed-production-ledger.ts` (the closest thing to a "prototype package/installation store with digests" — keyed by processRunId/moduleRef/nodeId/intentId/taskId/executionId, tracks `ManagedArtifactProductionRecord` with `contentHash`), `sqlite-process-product-repository.ts`.

### Shared — `shared/`
- `canonical-json.ts` — 17-line **re-export shim** of `canonicalJson`/`sha256Hex` from `../../saga3/shared/discovery-canonical.js`. The canonical-hashing primitive actually lives in the legacy saga3 tree.

## Platform runner, hooks, MCP gateway

### `tracker-view/claude-runner.mjs` (832) — `ClaudeBoardRunner`
- **Skill resolution:** `sagaSkillRoot` injected from `host.workerPaths.sagaSkillRoot`, set in `src/app/composition-root.ts:454` to `process.cwd()+'/skills'`. Falls back to `saga-worker/SKILL.md` if semantic skill file absent.
- **Module/semantic assembly** (`buildPrompt`): when a Process Module profile resolves, inlines **two skills as separate fenced sections** — `saga-process-module-worker-protocol` (universal physics) then the domain role skill. `effectiveSemanticSkill = profile.semanticSkill ?? assignment.skill ?? \`saga-${role}\``.
- **Author vs reviewer selection** (`roleFromTask`): reads `task.tags` JSON for `role:<value>`; else `'reviewer'` if `assignment.skill==='saga-reviewer'`, else `'developer'`. **No separate author/reviewer skill mechanism** beyond role tag + status + profile.semanticSkill — reviewer skill can be overwritten by author semantic skill (plan §13.18).
- **Built-in tools granted** (`launch`): from frozen `execution_context.authority.allowed_saga_tools` plus **hard-coded non-saga builtin set** `['Bash','Read','Write','Edit','Glob','Grep','MultiEdit','Task']` — **grants fixed Claude built-ins even when profile declares narrower** (plan §13.17).
- **Model routing:** frozen `assignment.execution_context.model_route` first, else `getActiveModel(epicId)`.
- **MCP config:** writes per-PID and per-execution tmp JSON launching `node <sagaEntry>` as `saga` stdio MCP child with `DB_PATH`, `TRACKER_AUTOSTART=0`, `SAGA_MANAGED_EXECUTION=1`, `SAGA_EXECUTION_ID`/`SAGA_TASK_ID`/`SAGA_WORKER_ID`.

### `tracker-reminder.mjs` (root, 56) — PostToolUse hook
- Real Claude Code PostToolUse hook (wired by `claude-runner.mjs:599–606` only when a process workspace is present).
- **Parses Markdown** — but only the exact env-bound `SAGA_PROCESS_TRACKER_PATH`; deliberately never scans `docs/`. Regex-extracts current step + checkbox lines.
- Injects `{"additionalContext":"<reminder>"}` with file path, current step, completed steps, next unchecked step, checklist paths. **Not PreToolUse, not a context-blocker.** Generic reminder only (plan §13.5).

### `src/index.ts` (299) — MCP gateway entry
- Single `Server` (`@modelcontextprotocol/sdk`) named `'tracker'` over `StdioServerTransport`. Auto-spawns `tracker-view` (4321) and `docs-graph/server.mjs` (4322) detached.
- **Tool registration:** `ALL_TOOLS` (concat of every `definitions` export from `src/tools/*.ts` + four `createSaga3*Handlers()` factories) + matching `ALL_HANDLERS`.
- **Dispatch** (`CallToolRequestSchema`): handler lookup → `authorizeSagaToolCall({toolName, db})` (single runtime enforcement point, fail-closed for managed execs) → handler. Errors normalized by `friendlyError()`.
- **Identity guard:** `assertManagedExecutionIdentity` validates `SAGA_MANAGED_EXECUTION`/`SAGA_EXECUTION_ID` pairing.

### `src/tools/saga3-args.ts` (226)
- Centralized actionable-error helpers (`actionableError`, `argInt`, `argStr`) + `SAGA3_TOOL_CALL_SHAPES`/`SAGA3_ARG_SOURCES`/`PAYLOAD_FIELD_SOURCES` registries for the four saga3 MCP handlers.
- **Hard-coded Discovery tracker workflow:** `enrichPayloadErrors` (line ~223) appends `'[Workflow: Read your stage tracker docs/discovery/project-<N>-discovery-stage.md, ...]'`; `src/tools/saga3-proposals.ts:176` has the matching `_workflow_hint`. Cannot serve arbitrary module tools (plan §13.13).

### Other hooks
- **Only one hook file** repo-wide: `tracker-reminder.mjs`. No PreToolUse/UserPromptSubmit/Stop hook scripts.

## Persistence & migrations

### Where SQL lives — **decentralized across ~14 locations**
1. `src/schema.ts` — `SCHEMA_SQL`, single large `CREATE TABLE IF NOT EXISTS …` template (968 lines) applied by `getDb()` via `db.exec(SCHEMA_SQL)`. Canonical fresh-DB schema.
2. `src/db.ts` — runs `SCHEMA_SQL` then a **hand-rolled chain of idempotent `try { ALTER TABLE } catch {}` blocks** + named migration functions: `migrateArtifactTypes`, `migrateTracesLinkType`, `migrateVerificationOutcome`, `migrateRiskClass`, `migrateEpisodeTrack`, `backfillWorkItemShadow` (from `src/lifecycle/backfill-migration.ts`), `migrateReviewInProgress`, `migrateVerificationTargets`, `migrateExecutionModeArtifactChange`.
3. **Scattered `CREATE TABLE IF NOT EXISTS saga3_*`** in: `sqlite-lifecycle-run-repository.ts`, `sqlite-node-run-repository.ts`, `sqlite-process-run-repository.ts`, `sqlite-process-outcome-certificate-repository.ts`, `sqlite-recovery-case-repository.ts`, `sqlite-managed-node-submission-repository.ts`, `sqlite-managed-production-ledger.ts`, `sqlite-external-effect-ledger.ts`, `sqlite-exact-candidate-acceptance.ts`, `modules/{delivery,development,formalization}/*-persistence.ts` + `sqlite-*-runtime.ts`, `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts`.

**No `migrations/` dir, no `user_version` pragma, no framework.** Each repo calls its own `ensure…Schema(db)` lazily on first use; `sqlite-lifecycle-run-repository.ts` imports/calls `ensureSaga3ProcessRunSchema` — implicit, order-dependent chain.

### `saga3_process_module_installations` — **does NOT exist**
Installations are an **in-memory registry** only (`process-module-installation-registry.ts`, `modules/installations.ts`, per-module `*-installation.ts`). Exercised only by `tests/process-modules/process-module-installation.test.mjs`.

### `src/schema.ts` tables (37)
`projects`, `repositories`, `project_repositories`, `repository_checkouts`, `epics`, `episode_workflows`, `tasks`, `worker_executions`, `subtasks`, `task_dependencies`, `comments`, `templates`, `notes`, `activity_log`, `artifacts`, `task_conflict_keys`, `runtime_observations`, `verification_evidence`, `trusted_providers`, `artifact_traces`, `command_receipts`, `lifecycle_events`, `task_work_items`, `work_attempts`, `human_requests`, `integration_intents`, and the Saga 3 discovery cluster: `saga3_work_intents`, `saga3_raw_submissions`, `saga3_control_intents`, `saga3_normalization_proposals`, `saga3_readiness_control_intents`, `saga3_readiness_assessments`, `saga3_discovery_settlements`, `saga3_discovery_outcome_certificates`, `saga3_discovery_diagnosis_control_intents`, `saga3_discovery_diagnosis_reports`, `saga3_proposals`.

### Missing aggregates (to be added by the refactor)
- **No protocol state tables** (`protocol_state`, `ProtocolRun`, `ProtocolStepRun`).
- **No call instance tables** (`CallInstance`).
- **No scenario installation / scenario module lock tables.**

## Tests

### Architecture / boundary tests (handpicked, NOT repository-wide)
- `tests/architecture/saga2-boundaries.test.mjs` — scans **exactly 21 hard-coded files** in `requiredFiles` (lines 9–31): pre-process-modules era. Asserts existence + stage-transition anchors + sqlite-saga2 anchors + claude-runner invariants. **Notably absent from the list: every `src/process-modules/**`, `src/saga3/**`, `src/lifecycle/**`, `src/worker-executions.ts`.**
- `tests/process-modules/process-module-boundaries.test.mjs` — asserts process-module core doesn't import discovery/formalization semantics; modules don't import each other; every profile asset path resolves. Siloed, not repo-wide.
- `tests/saga3/d{3,4,5}-architecture-boundary.test.mjs` — D3/D4/D5 purity guards.

### Characterization tests
- `tests/characterization/saga2-runtime-contracts.test.mjs` — Phase-B ports-and-adapters contract: env precedence, `Saga2Engine` ports, PID-lock/heartbeat/rate-limit, `createSagaApplication` engine selection, etc. Load-bearing — keep green.
- `tests/product-workflow.test.mjs` — full discovery→…→completed characterization (>1000 chars, asserted by arch test).
- `tests/e2e-pipeline.test.mjs`, `tests/track-pipeline.test.mjs` — driven by `tests/mock-claude.mjs`.

### Process-module tests — `tests/process-modules/` (41 files)
- **Default `npm test` discovers them via `node --test`.** Dedicated runner `tools/run-process-module-tests.mjs` splits into groups `a` (17) and `b` (12) — **stale: covers only 29 of 41 files**; other 12 run only via default discovery.
- Runner: `spawnSync(process.execPath, ['--test','--test-concurrency=1', ...files])` per group, sequential, `cwd: root`. Accepts `a`/`b`/`all`.

### Test fixtures
- `tests/lifecycle/fixtures/*.json` (15) — hand-built board states.
- `tests/completeness/fixtures/metadata-{no-running,running}.json`.
- `tests/dispatcher-race/project.txt` — legacy project-name fallback.
- `tests/planner-ac9/.tmp-ac9-pipeline.db*` — **leftover SQLite DB+WAL+SHM checked in** (hygiene).
- `tests/mock-claude.mjs` + `tests/MOCK-CLAUDE.md` — synthetic claude worker subprocess.
- **No synthetic "process-module" or "scenario" fixture directory** — tests construct in-memory registries/DBs per-test.

## Hygiene flags (non-load-bearing, note for Wave 0)
- Checked-in `tests/planner-ac9/.tmp-ac9-pipeline.db*` (3 files).
- Numerous `epic3*-run.log` / `orchestrate-*.log` at repo root.

## Cross-cutting refactor seams (highest-leverage targets)

1. **Catalog coupling** concentrated in `execution-profile-resolver.ts`, `composition/product-lifecycle-runtime.ts`, `modules/catalog.ts`, `modules/installations.ts` — the four seams to break for pluggable modules.
2. **Non-serializable function fields** in exactly two places: `domain/lifecycle.ts` (`routeResolver`) + `lifecycles/product-delivery-lifecycle.ts` (`defineProperty` dodge). Same fix.
3. **Board/task/WorkIntent vocab leak** through `node-executor.ts` SPI → `generic-flow-executor.ts` → `lm-node-executor.ts` → `process-execution-workspace.ts` — clean as a vertical slice.
4. **Decentralized schema** (~14 ad-hoc `ensure…Schema` writers vs one `schema.ts`) — Wave-by-wave consolidation behind one SQL owner.
5. **Hard-coded Discovery workflow strings** in `saga3-args.ts:223` + `saga3-proposals.ts:176` — parameterize for arbitrary modules.
6. **Architecture test blind spot:** `saga2-boundaries.test.mjs` predates `src/process-modules/**` — Wave 0 must add repository-wide dependency enforcement.
7. **`shared/canonical-json.ts` is a shim** into legacy `src/saga3/`; `modules/discovery/` also reaches back into `src/saga3/domain/` — process-modules not yet self-contained.
