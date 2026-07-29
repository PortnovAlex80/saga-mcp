# Wave 7 — Lifecycle Scenario Package & Runtime Frozen Spec
> Frozen on `174a757` (Wave 6 checkpoint). Plan §0.10 / Phase 8.

## 0. Key findings
- Wave 1 has `LifecycleScenarioManifest` (pure type, no routeResolver §6.4).
- Wave 2 has installation infrastructure (store/repo/registry).
- `lifecycle-orchestrator.ts` (653 lines) drives stages but resolves installation at stage-exec time (§13.11).
- `product-delivery-lifecycle.ts` has `routeResolver` function + `Object.defineProperty` dodge (§13.9).
- Cumulative-frame handoff persists all prior stage data each transition (§13.21).
- Plan §6.6-6.7: scenario installation resolves module selectors to exact InstalledProcessModule + writes scenario module lock; LifecycleRun pins both at start.

## 1. Lanes (8)

| Lane | Owns |
|---|---|
| **W7-A1** (SQL OWNER) | `installation/scenario-store.ts` + `sqlite-scenario-installation-repository.ts` (saga3_scenario_installations + saga3_scenario_module_locks tables) + EDIT db.ts |
| **W7-A2** | `application/scenario-module-lock.ts` (exact module-lock resolution: ModuleSelector → InstalledProcessModule at install time; StageRun/LifecycleRun pinning) |
| **W7-A3** | `application/scenario-compiler.ts` (validate scenario manifest: mappings type-check against module contracts, route table completeness, graph validation) |
| **W7-A4** | `application/scenario-router.ts` (declarative predicate routing, graph validation, terminal outcomes, explicit budgets — replaces routeResolver §6.4) |
| **W7-A5** | `application/scenario-stage-output.ts` (content-addressed public stage outputs, lifecycle variables, exact handoffs — replaces cumulative frame §13.21) |
| **W7-A6** | `application/scenario-runner.ts` (generic ScenarioInstaller + ScenarioRunner services — outside existing orchestrator hot files) |
| **W7-A7** | Tests: scenario invalidity/lock/replay/upgrade/branching/repeated-module/scaling |
| **W7-A8** | `application/legacy-scenario-adapter.ts` (explicit legacy Product Delivery scenario adapter + compatibility tests) |

## 2. Exit gate (§0.10.12)
1. Build green. 2. Scenario reorders+reuses modules without Runtime changes. 3. Pins complete lock at start. 4. Survives upgrades. 5. Stores each public output once (no cumulative frame). 6. No hidden executable routing. 7. Ratchet green. 8. Wave 0-6 regression green.

## 3. Anti-scope
- No `lifecycle-orchestrator.ts` rewrite (Wave 11 cutover). New ScenarioRunner is alongside.
- No removal of `routeResolver` or cumulative-frame (Wave 13).
- No module migration (Wave 8/9).
