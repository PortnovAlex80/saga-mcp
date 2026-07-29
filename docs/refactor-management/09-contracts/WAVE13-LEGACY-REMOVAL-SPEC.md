# Wave 13 — Final Legacy Removal Frozen Spec

> Frozen on latest Wave 12 checkpoint (TBD). Plan §0.16 / Phase 13 final + Phase 15.
> **This is the FINAL wave.** After Wave 13, the refactor is complete.

## 0. Serial precondition (§0.16.2)
The retention policy (W11-A5 `evaluatePackageRetentionCondition`) MUST prove that no supported active or replayable run requires each target compatibility path. Each removal is serial (§0.16.11): cherry-pick ONE cleanup → rerun replay + architecture gate → repeat.

## 1. Lanes (8) — serial cleanup groups

| Lane | Owns (removes) |
|---|---|
| **W13-A1** | Central built-in catalog + task-kind resolution removal. `modules/catalog.ts`, `modules/installations.ts` → deleted. `execution-profile-resolver.ts` catalog import → removed (prefix/first-match gone). |
| **W13-A2** | Global skill, template, tracker, workspace special-case removal. `process-execution-workspace.ts` global-skill-root paths → removed. `tracker-reminder.mjs` → deleted (replaced by W5-A5 structured hook). |
| **W13-A3** | `routeResolver`, product-specific lifecycle policy, output payload registry removal. `domain/lifecycle.ts` `routeResolver` field → deleted. `product-delivery-lifecycle.ts` `Object.defineProperty` dodge → deleted. `ProcessOutputPayloadRegistry` → deleted. |
| **W13-A4** | Latest-execution, process-scope, metadata, chain-binding fallback removal. `generic-flow-executor.ts` `restoreFrame()` legacy path → removed (v2 only). `listArtifactsForNodeInEpic` fallback → removed. |
| **W13-A5** | Old hook, stale workflow hint, textual actionable-error removal. `src/tools/saga3-args.ts` hard-coded Discovery workflow strings → removed (W6-A5 ActionableToolError replaces). `src/tools/saga3-proposals.ts` workflow hint → parameterized. |
| **W13-A6** | Obsolete composition-root, CLI branch, product runtime wiring removal. `composition/product-lifecycle-runtime.ts` legacy manual-wiring → replaced by W11-A2 composition loader. |
| **W13-A7** | Obsolete adapter, table, migration, retained-package cleanup under single persistence owner. Drop unused tables/columns ONLY after retention proof + data migration. |
| **W13-A8** | Final dependency, dead-code, package isolation, replay, end-to-end verification. The DEFINITION OF DONE proof (plan §18). |

## 2. Exit gate / Definition of Done (§0.16.12 / §18)
1. **§18.1** A new Process Module Package installs without editing Runtime, runner, catalog, or another module.
2. **§18.2** A new Lifecycle Scenario Package installs without editing Runtime or module packages.
3. **§18.3** Runtime core contains NO imports from concrete module/scenario implementations.
4. **§18.4** Modules contain NO imports from other module implementations or Runtime adapters.
5. **§18.5** Every active run is pinned to immutable scenario + module package bytes.
6. **§18.6** Every module boundary passes a complete immutable output envelope + exact lineage.
7. **§18.7** Restart/recovery use durable receipts/products, not latest-execution/metadata fallback.
8. **§18.8** Tracker + agent assistance generated from authoritative protocol state.
9. **§18.9** Module-specific tools/skills/templates/checklists/guards/errors ship with owning package.
10. **§18.10** Product Delivery + Campaign both complete through the same Runtime.
11. **§18.11** Full scenarios complete repeatedly without manual DB/metadata/tracker/artifact edits.
12. **§18.12** Any node may reject with structured feedback → declared repair target via same recovery.
13. **Repository-wide dependency checks**: no forbidden new-core imports, hidden fallbacks, global module resources, hard-coded module composition, or unsupported legacy paths.
14. **Ratchet**: `KNOWN_VIOLATIONS` → 0 (all allowlisted edges fixed + removed).
15. **Wave 0-12 regression**: all green.

## 3. Serial integration (§0.16.11)
The integrator cherry-picks cleanup commits ONE AT A TIME and reruns replay + architecture gate after every removal. If ANY gate fails, the removal is reverted and the issue documented. The ratchet MUST shrink: each removal fixes an allowlisted edge and removes its `KNOWN_VIOLATIONS` entry.

## 4. Anti-scope
- NO new features — this wave ONLY removes legacy code.
- NO behavior changes — legacy paths are already dead (no active/replayable runs use them per retention proof).
- Each removal is preceded by the retention proof for that specific path.
- Tables/columns dropped ONLY after data migration + retention proof.

## 5. The ratchet convergence (§0.16.12 final gate)
Starting from 74 allowlisted edges (current), Wave 13 target is **0 remaining violations**:
- R1 (1 edge): delivery→development schema import → removed when delivery is self-contained
- R2 (29 edges): module→persistence/cross-tree → removed when modules use injected ports
- R3 (9 edges): lifecycle→module-impl → removed when lifecycle uses contract refs only
- R4 (1 edge): execution-profile-resolver→catalog → removed when resolver uses PackageRegistry
- R6 (34 edges): composition-root→modules/sqlite → removed when composition loader replaces manual wiring

Total: 74 → 0.
