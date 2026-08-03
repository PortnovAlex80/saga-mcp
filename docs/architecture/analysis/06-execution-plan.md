# 06 — Refactoring Execution Plan

> Phase 6. Characterization tests, seams, risk/value matrix, strangler fig roadmap, fitness functions, consolidated plan.

## 6.1 Characterization Test Plan

Before any code is moved, current behavior must be locked with tests. The
existing test suite (231 files, ~104k LOC) already covers most paths. The
gaps below need characterization tests BEFORE the corresponding refactoring
step.

| Priority | Path to characterize | Current coverage | Test to add | Guards refactoring step |
|---|---|---|---|---|
| **P0** | GenericFlowExecutor v2-only path (after v1 removal) | v1/v2 dual-write tested together | Characterization test that runs a Flow with ONLY v2 NodeRun rows and asserts correct walk + settlement | Step S2 (v1 removal) |
| **P0** | Discovery settlement with dynamic-import bridge removed | Bridge is transparent (delegates to same service) | Characterization test that imports `createDiscoveryKernelHandlers` directly (no dynamic import) and runs full D1-D5 flow | Step S4 (saga3 dissolution) |
| **P1** | Composition root with register(deps) pattern | Currently tested via `product-lifecycle-composition.test.mjs` | Add test that asserts each `register*Module()` returns correct handler count + executor type | Step S5 (composition slim-down) |
| **P1** | ManagedProductionLedger single-interface | Both copies are structurally identical | Test that asserts both modules accept the same shared interface instance | Step S3 (interface consolidation) |
| **P2** | tracker-view HTTP endpoints | Currently untested at HTTP level | Add supertest-style characterization for each `/api/*` endpoint | Step S7 (tracker-view split) |
| **P2** | ModuleCompletion serialization without type cycle | Currently uses `null as unknown as` | Test that round-trips a real ModuleCompletion through `JSON.stringify` + `JSON.parse` and asserts certificateRef is preserved | Step S6 (type cycle fix) |

## 6.2 Seam Map

A seam is a point where new code can be inserted without disturbing
surrounding code. The following seams are safe insertion points for the
strangler fig migration.

| Seam ID | Location | What can be inserted here | Evidence (current interface) |
|---|---|---|---|
| **SEAM-1** | `ProcessModuleInstallationRegistry.register()` | A new module's handlers + executor + human interactions | `product-lifecycle-runtime.ts:595-602` (already calls register per module) |
| **SEAM-2** | `KernelHandlerRegistry.registerAll()` | A module's kernel handlers map | `kernel-handler-registry.ts` (Map-based registry) |
| **SEAM-3** | `ProcessModuleRegistry.register()` | A module's ProcessModuleDefinition | `process-module-registry.ts:23-33` |
| **SEAM-4** | `productDeliveryLifecycle.stages[]` | A new stage binding in the lifecycle | `product-delivery-lifecycle.ts:302-487` |
| **SEAM-5** | `nodeExecutors` Map in composition root | A new NodeExecutor kind | `product-lifecycle-runtime.ts:480-497` |
| **SEAM-6** | `resolveOutputPayload` schema map | A new output payload resolver | `product-lifecycle-runtime.ts:613-622` |
| **SEAM-7** | `readResourceBlobs()` in production-install | New module manifest resources | `production-install.ts:63-78` |
| **SEAM-8** | `modules/<name>/package/manifest.ts` | A new module's package manifest | Pattern established by existing 4 modules |

These seams already exist. The refactoring does not need to create them —
it needs to formalize them as the ONLY insertion point (via fitness
functions).

## 6.3 Risk/Value Prioritization Matrix

| Step | Risk | Value | Risk score (1-5) | Value score (1-5) | Priority |
|---|---|---|---|---|---|
| S1: Extract Wave comments to WAVE-LOG.md | Very low (comments only) | High (~30% context savings) | 1 | 5 | **P0** |
| S2: Remove dead v1 path from executor | Medium (behavioral change, but v1 is dead) | High (~400 lines removed) | 3 | 4 | **P0** |
| S3: Consolidate ManagedProductionLedger | Low (structural identity) | Medium (integrity) | 2 | 3 | **P1** |
| S4: Dissolve saga3/ into discovery hexagon | High (large file moves, dynamic import removal) | High (module autonomy) | 4 | 5 | **P1** |
| S5: Composition root → register(deps) | Medium (wiring change) | High (maintainability) | 3 | 4 | **P1** |
| S6: Fix type cycle at SPI | Medium (SPI change) | Medium (clean serialization) | 3 | 3 | **P2** |
| S7: Split tracker-view.mjs | Low (JavaScript, no behavioral change) | Medium (SRP) | 2 | 3 | **P2** |
| S8: Self-registration (modules register via manifest) | Medium (new mechanism) | High (linear scaling) | 3 | 4 | **P2** |

## 6.4 Strangler Fig Migration Roadmap

Each step is incremental, independently testable, and reversible. Old
code is retired step by step — never a single big-bang rewrite.

```mermaid
flowchart LR
    S1["S1: Wave comments → WAVE-LOG.md"] --> S2["S2: Remove v1 dead path"]
    S2 --> S3["S3: Consolidate shared interfaces"]
    S3 --> S4["S4: Dissolve saga3/ → discovery hexagon"]
    S4 --> S5["S5: Composition root → register(deps)"]
    S5 --> S6["S6: Fix type cycle"]
    S6 --> S7["S7: Split tracker-view.mjs"]
    S7 --> S8["S8: Self-registration via manifest"]
```

### Step S1: Extract Wave-archaeology comments (P0)

| Attribute | Value |
|---|---|
| **Risk** | Very low — comments only, no behavioral change |
| **Effort** | ~2 hours (mechanical extraction) |
| **Characterization test** | Existing tests must pass unchanged |
| **Fitness function** | `grep -c "Wave [0-9]\|FU-\|Slice [0-9]" src/**/*.ts` → trending to 0 |
| **Rollback** | `git revert` |

**Actions:**
1. Create `docs/architecture/WAVE-LOG.md`.
2. For each of the top 15 files: extract Wave/FU/Slice history comments into WAVE-LOG.
3. Leave behavioral documentation (JSDoc, inline explanations of WHY code does X).
4. Run full test suite — must be green.

### Step S2: Remove dead v1 path from GenericFlowExecutor (P0)

| Attribute | Value |
|---|---|
| **Risk** | Medium — must prove v1 is truly dead |
| **Effort** | ~4 hours |
| **Characterization test** | New test: run Flow with only v2 NodeRun rows, assert correct walk |
| **Fitness function** | `grep -c "isV2Run\|runHasV2Marker\|v2ChannelFor" generic-flow-executor.ts` → 0 |
| **Rollback** | `git revert` |

**Actions:**
1. Add characterization test for v2-only Flow execution.
2. Remove `v2ChannelFor()`, `runHasV2Marker()`, v1/v2 conditional branches.
3. Inline `assembleFrameFromDurableNodeRuns` as the sole frame builder.
4. Remove v1 `start`/`complete` calls (keep v2 `startV2`/`completeV2` as the only path, rename to `start`/`complete`).
5. Run full test suite + characterization tests.

### Step S3: Consolidate shared interfaces (P1)

| Attribute | Value |
|---|---|
| **Risk** | Low — structural identity |
| **Effort** | ~1 hour |
| **Characterization test** | Existing handler tests must pass |
| **Fitness function** | `grep -c "ManagedProductionLedger" src/process-modules/modules/*/` → exactly 0 (only in shared/) |
| **Rollback** | `git revert` |

**Actions:**
1. Create `src/process-modules/shared/managed-production.ts` with the canonical `ManagedProductionLedger` interface + record types.
2. Update `development-kernel-ports.ts` and `formalization-kernel-ports.ts` to re-export from shared.
3. Update `sqlite-managed-production-ledger.ts` to import from shared.
4. Run full test suite.

### Step S4: Dissolve saga3/ into discovery hexagon (P1)

| Attribute | Value |
|---|---|
| **Risk** | High — large physical moves, dynamic import removal |
| **Effort** | ~8 hours |
| **Characterization test** | D1-D5 flow test without dynamic import |
| **Fitness function** | `find src/saga3 -name '*.ts'` → 0 files; `grep -r "saga3/" src/process-modules/modules/discovery/` → 0 |
| **Rollback** | `git revert` (large diff but mechanical) |

**Actions:**
1. Move `saga3/domain/discovery-*.ts` → `modules/discovery/domain/`.
2. Move `saga3/application/discovery-*.ts` → `modules/discovery/application/`.
3. Move `saga3/persistence/sqlite-saga3-discovery-runtime.ts` → `modules/discovery/infrastructure/`.
4. Move `saga3/authority/` → `shared/authority/`.
5. Move `saga3/shared/discovery-canonical.ts` → `shared/canonical-json.ts` (consolidate with existing re-export).
6. Delete `createLegacySettlementBridge` and the dynamic import.
7. Update all import paths.
8. Run dependency-direction ratchet — must stay at 0 violations.
9. Run full test suite.

### Step S5: Composition root → register(deps) (P1)

| Attribute | Value |
|---|---|
| **Risk** | Medium — wiring change |
| **Effort** | ~4 hours |
| **Characterization test** | `product-lifecycle-composition.test.mjs` must pass |
| **Fitness function** | `wc -l src/app/product-lifecycle-runtime.ts` → < 150 |
| **Rollback** | `git revert` |

**Actions:**
1. Create `modules/discovery/index.ts` with `registerDiscoveryModule(registry, sharedDeps)`.
2. Repeat for formalization, development, delivery.
3. Replace 780-line composition body with 4 `register*Module()` calls.
4. Fix `as any` cast with proper typed registration.
5. Run full test suite.

### Step S6: Fix type cycle at SPI level (P2)

| Attribute | Value |
|---|---|
| **Risk** | Medium — SPI type change |
| **Effort** | ~3 hours |
| **Characterization test** | ModuleCompletion round-trip serialization test |
| **Fitness function** | `grep -c "as unknown as ModuleCompletion" src/` → 0 |
| **Rollback** | `git revert` |

### Step S7: Split tracker-view.mjs (P2)

| Attribute | Value |
|---|---|
| **Risk** | Low — JavaScript, no behavioral change |
| **Effort** | ~6 hours |
| **Characterization test** | HTTP endpoint characterization (new) |
| **Fitness function** | `wc -l tracker-view/*.mjs` → each file < 1200 lines |

### Step S8: Self-registration via manifest (P2)

| Attribute | Value |
|---|---|
| **Risk** | Medium — new mechanism |
| **Effort** | ~4 hours |
| **Characterization test** | Add a test module via manifest only (no composition root change) |
| **Fitness function** | Adding a module requires 0 changes outside `modules/<name>/` |

---

## 6.5 Fitness Functions

Automated checks that enforce architectural rules going forward. These
extend the existing ratchet tests.

| Fitness function | Type | Enforcement | New? |
|---|---|---|---|
| **FF-1: No Wave-archaeology in source** | Source lint | `grep -cE "Wave [0-9]\|FU-[A-D]\|Slice [0-9]" src/**/*.ts` ≤ threshold (trending to 0) | **New** |
| **FF-2: No saga3/ imports from modules** | Source lint | `grep -r "from.*saga3" src/process-modules/modules/` → 0 | **New** (strengthens existing) |
| **FF-3: Module self-containment** | Source lint | For each `modules/<name>/index.ts`, all imports from within `modules/<name>/` or `shared/` or `domain/` — never from another module or saga3/ | **New** |
| **FF-4: Composition root size** | Metric | `wc -l product-lifecycle-runtime.ts` < 150 | **New** |
| **FF-5: No `as unknown as`** | Source lint | `grep -r "as unknown as" src/process-modules/` → 0 | **New** |
| **FF-6: No dead v1 path** | Source lint | `grep -c "isV2Run\|v1Channel\|runHasV2Marker" generic-flow-executor.ts` → 0 | **New** |
| **FF-7: Existing: dependency-direction ratchet** | Dependency graph | `KNOWN_VIOLATIONS.length <= 0` | Existing |
| **FF-8: Existing: no execution-scoped lookup** | Source lint | Banned identifiers absent from `src/process-modules/` | Existing |
| **FF-9: Existing: no magic-bindings read** | Source lint | Banned certificate key dereference from bindings bags | Existing |
| **FF-10: Existing: single-writer invariant** | Source lint | Only allowlisted modules write `tasks.{status,...}` | Existing |

---

## 6.6 Consolidated Refactoring Execution Plan

| Phase | Steps | Total effort | Risk | Gate criterion |
|---|---|---|---|---|
| **Phase A: Cleanup** | S1 (Wave comments) + S2 (v1 removal) | ~6 hours | Low-Medium | All tests green; FF-1, FF-6 pass |
| **Phase B: Module autonomy** | S3 (shared interfaces) + S4 (saga3 dissolution) | ~9 hours | Medium-High | All tests green; FF-2, FF-3 pass; ratchet at 0 |
| **Phase C: Composition** | S5 (register(deps)) + S6 (type cycle) | ~7 hours | Medium | All tests green; FF-4, FF-5 pass |
| **Phase D: UI** | S7 (tracker-view split) | ~6 hours | Low | All tests green; HTTP characterization passes |
| **Phase E: Scaling** | S8 (self-registration) | ~4 hours | Medium | New module added with 0 composition changes |

### Checkpoints for continuous validation

After EACH step:
1. `npm run build` — TypeScript strict compilation passes.
2. `npm test` — All 231 test files green.
3. `npm run test:architecture` — All ratchet + race + boundary tests green.
4. `npm run cgad-lint -- <test-db>` — Lint runs without crash.
5. New fitness functions (FF-1 through FF-6) pass.
6. Manual smoke: `DB_PATH=./smoke.db node dist/index.js` starts cleanly.

After each PHASE:
7. Full end-to-end lifecycle run with mock-claude (`SAGA_CLAUDE_PATH="node tests/mock-claude.mjs" node dist/orchestrate-cli.js`).
8. Dependency-direction ratchet baseline did not increase.
9. No new `as any` or `as unknown as` introduced.

### Estimated total effort

| Phase | Effort | Context savings |
|---|---|---|
| A: Cleanup | ~6 hours | ~30% context reduction across system |
| B: Module autonomy | ~9 hours | Discovery module understandable in isolation |
| C: Composition | ~7 hours | Composition root readable in one glance |
| D: UI | ~6 hours | tracker-view maintainable |
| E: Scaling | ~4 hours | Linear module addition |
| **Total** | **~32 hours** | **~40-50% context cost reduction for agents** |

### What this plan does NOT do

- Does NOT change the SQLite single-process model (stakeholder decision needed).
- Does NOT add multi-host orchestration (future, requires ADR).
- Does NOT change the authority gateway or CGAD enforcement (already correct).
- Does NOT change the 4-module lifecycle (discovery → formalization → development → delivery).
- Does NOT add real-LM integration tests (requires CI infrastructure with API access).
- Does NOT change the MCP protocol surface (tools are stable).

The plan is purely **physical reorganization + dead code removal**. The
behavioral architecture (CGAD, conveyor model, pure policies, ratchets)
is already correct and does not change.
