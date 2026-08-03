# Module and Component Inventory (Supersedes v1)

Artifact ID: ART-PHASE0-MODULE-INVENTORY
Artifact Type: Module and Component Inventory
Phase: Phase Zero
Version: 2
Status: evidence-complete
Created From: Live source verification (git ls-files + targeted source reads), superseding v1 which contained stale paths from parent session context
Supersedes: ART-PHASE0-MODULE-INVENTORY v1 (stale saga3/ paths, stale composition root size, stale product-lifecycle-runtime structure)
Coverage: All runnable processes, entry points, composition roots, modules, persistence mechanisms. 1566 tracked files verified. Module identity, handler locations, and persistence mappings confirmed against live source.
Confidence: High — all structural claims verified via git ls-files + awk + targeted Read within this session.
Referenced Evidence: EVID-PHASE0-V2-001 through EVID-PHASE0-V2-052
Unresolved Questions: QUESTION-V2-001 (saga3/ remnant files: are they still reachable?), QUESTION-V2-002 (tracker-view.mjs internal structure — 5605 lines, not deeply inspected)
Known Contradictions: CONTRADICTION-V2-001 — v1 referenced `src/saga3/authority/authorize-saga-tool-call.ts`; the file moved to `src/shared/authority/authorize-tool-call.ts`. CONTRADICTION-V2-002 — v1 referenced `src/saga3/domain/discovery-settlement-policy.ts`; the file moved to `src/modules/discovery/domain/discovery-settlement-policy.ts`. CONTRADICTION-V2-003 — v1 described product-lifecycle-runtime.ts at 780 lines with inline module wiring; the file is now 616 lines with LEGO contract register functions. CONTRADICTION-V2-004 — v1 described a separate saga3/ bounded context with domain/application/persistence/authority subdirectories; saga3/ has been dissolved to 2 remnant files (169 total lines).
Downstream Dependencies: Phase 1 (Operational Purpose), Phase 2 (Maps), Phase 4 (Seam Map)

Revision Record:
- Previous: ART-PHASE0-MODULE-INVENTORY v1
- Superseding: ART-PHASE0-MODULE-INVENTORY v2 (this document)
- Exact findings that changed: (1) authorizeSagaToolCall location; (2) discovery settlement policy/service locations; (3) composition root structure (LEGO contract); (4) saga3/ dissolution status; (5) module registration seam exists
- New evidence: live `git ls-files` confirms saga3/ has 2 files; live source reads confirm `src/modules/<name>/index.ts` register functions; live `wc -l` confirms composition root is 616 lines
- Why v1 was incomplete: v1 was created from parent session context that predated the saga3 dissolution and LEGO contract refactoring (Waves 8/9/14)
- Downstream affected: All Phase 1+ artifacts must reference current paths, not saga3/ paths

---

## 1. Runnable Processes (E3)

| ID | Process | Entry | Transport | Evidence |
|---|---|---|---|---|
| PROC-001 | MCP Server | `src/index.ts:main()` | stdio (MCP) | EVID-V2-001: `StdioServerTransport`, `CallToolRequestSchema` |
| PROC-002 | Orchestrate CLI | `src/orchestrate-cli.ts:main()` | detached background | EVID-V2-002: `application.runEpisode` loop |
| PROC-003 | Tracker-view | `tracker-view/tracker-view.mjs` | HTTP :4321 | EVID-V2-003: `http.createServer` |
| PROC-004 | Docs-graph | `tracker-view/docs-graph/server.mjs` | HTTP :4322 | EVID-V2-004 |
| PROC-005 | Worker | spawned by ClaudeBoardRunner | stdin/stdout pipe | EVID-V2-005: `spawn(this.claudePath, args)` |

## 2. Composition Roots (E2)

| ID | Root | File | Lines | Evidence |
|---|---|---|---|---|
| ENTRY-001 | Saga Application selector | `src/app/composition-root.ts` | ~370 | EVID-V2-006: `createSaga2Application()` → `selectEngine()` → `createProductLifecycleRuntime()` |
| ENTRY-002 | Product Lifecycle Runtime | `src/app/product-lifecycle-runtime.ts` | 616 | EVID-V2-007: shared deps + 4 `register<Name>()` calls + orchestrator |
| ENTRY-003 | LEGO contract types | `src/modules/module-registration.ts` | 109 | EVID-V2-008: `ModuleRegistries`, `ModuleSharedDeps` |
| ENTRY-004 | Production install | `src/process-modules/installation/production-install.ts` | ~183 | EVID-V2-009: `installProductionModules()` |

## 3. Module Registration (LEGO Contract) (E2)

The composition root delegates per-module wiring to four `register<Name>()` functions:

| Module | Register File | Lines | Registers | Evidence |
|---|---|---|---|---|
| Discovery | `src/modules/discovery/index.ts` | 90 | kernel handlers, executor, module def + installation | EVID-V2-010 |
| Formalization | `src/modules/formalization/index.ts` | 112 | kernel handlers, executor, module def + installation | EVID-V2-011 |
| Development | `src/modules/development/index.ts` | 130 | kernel handlers, executor, module def + installation | EVID-V2-012 |
| Delivery | `src/modules/delivery/index.ts` | 196 | kernel handlers, human interactions, executor, module def + installation | EVID-V2-013 |

The composition root (`product-lifecycle-runtime.ts:436-439`) calls:
```typescript
registerDiscovery(registries, sharedDeps);
registerFormalization(registries, sharedDeps);
registerDevelopment(registries, sharedDeps, options.development ?? {});
registerDelivery(registries, sharedDeps, options.delivery);
```

## 4. Module Source Trees (E1)

Each module has content split across two trees:

**NEW tree** (`src/modules/<name>/`) — registration + domain + application + infrastructure:
Contains the register function, the module's domain types, application services, and SQLite infrastructure adapters. This is the tree the LEGO contract imports from.

**WAVE-ERA tree** (`src/process-modules/modules/<name>/`) — process module definition + installation + kernel handlers + package:
Contains the `ProcessModuleDefinition` data, the `create<Name>KernelHandlers()` function, the package manifest, and the declared resources (skills, templates, checklists).

**QUESTION-V2-003:** Why do these two trees coexist? The new tree owns registration + domain + infrastructure; the wave-era tree owns process-module definitions + kernel handlers + packages. Is this an intentional separation (definition vs. runtime wiring) or an incomplete migration?

## 5. saga3/ Dissolution Status (E0)

| File | Lines | Imports from | QUESTION |
|---|---|---|---|
| `src/saga3/domain/proposal.ts` | 68 | Unknown — needs verification | V2-001: still reachable? |
| `src/saga3/application/assign-one-card.ts` | 101 | Unknown — needs verification | V2-001: still reachable? |

All other former saga3/ content has moved:
- Authority: `src/shared/authority/authorize-tool-call.ts`, `src/shared/authority/execution-context.ts`, `src/shared/authority/build-execution-context.ts`
- Discovery domain: `src/modules/discovery/domain/*`
- Discovery application: `src/modules/discovery/application/*`
- Discovery infrastructure: `src/modules/discovery/infrastructure/*`
- Canonical JSON: `src/process-modules/shared/canonical-json.ts` (re-exports from `src/saga3/shared/discovery-canonical.js` — needs verification if this re-export still points to saga3/shared or has been redirected)

## 6. Authority Gateway (E2 — verified on MCP call path)

| Component | Current Location | Evidence |
|---|---|---|
| `authorizeSagaToolCall` | `src/shared/authority/authorize-tool-call.ts` | EVID-V2-014: imported in `index.ts` as `from './shared/authority/authorize-tool-call.js'` |
| `visibleSagaToolNames` | Same file | EVID-V2-015: imported in `index.ts` |
| `buildExecutionContext` | `src/shared/authority/build-execution-context.ts` | EVID-V2-016 |
| `executionContextHash` | `src/shared/authority/execution-context.ts` | EVID-V2-017 |

## 7. Persistence (E4)

40 SQLite tables in `src/schema.ts`. Same table inventory as v1 — verified unchanged.

## 8. MCP Tool Surface (E1)

27 tool definition files under `src/tools/`. Authority gateway intercepts every call in `index.ts` CallToolRequestSchema handler.

## 9. Package Store (E4)

198 files under `.saga/package-store/` — content-addressed immutable module packages.

## 10. Configuration (E4)

Same as v1 — all env vars verified unchanged.
