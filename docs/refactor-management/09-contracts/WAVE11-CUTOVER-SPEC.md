# Wave 11 — Product Scenario Cutover Preparation Frozen Spec

> Frozen on latest Wave 10 checkpoint (TBD). Plan §0.14 / Phase 13 preparation only.

## 0. Objective (§0.14.11 serial gate)
All new Product Delivery and Campaign runs use installed scenarios. Old pinned runs still replay through explicit compatibility adapters. No legacy code is deleted in this wave.

## 1. Critical constraint (§0.14.10)
**Serial cutover**: one owner switches new runs to installed scenarios in a dedicated commit. No legacy code is deleted in that commit. This is the SINGLE integrator edit to the composition root — it wires the Wave 1-10 infrastructure into the live execution path.

## 2. Lanes (8)

| Lane | Owns |
|---|---|
| **W11-A1** | `installation/product-delivery-scenario-package.ts` (NEW): the installed Product Delivery Lifecycle Scenario package — wraps the W7-A8 legacy scenario adapter into an installable scenario using Wave 7 ScenarioInstaller. |
| **W11-A2** | `application/composition-loader.ts` (NEW): generic package + scenario composition loader. Loads installed packages + scenarios at startup instead of hard-coded catalog/installations. Replaces `createBuiltInProcessModuleRegistry`/`createBuiltInProcessModuleInstallationRegistry` for new runs. |
| **W11-A3** | `application/command-adapters.ts` (NEW): generic application command + result adapters. Wraps the existing `RunLifecycleScenarioCommand`/`LifecycleExecutionResult` to accept generic scope (project/epic become optional adapter fields, not mandatory — §13.22). |
| **W11-A4** | `orchestrate-cli-scenario-adapter.ts` + `src/tools/process-modules-scenario-adapter.ts` (NEW): CLI compatibility + scenario selection adapters. New runs select installed scenario; old runs still work via legacy path. |
| **W11-A5** | `application/legacy-run-inventory.ts` (NEW): legacy-run inventory, migration, rollback, and package-retention tooling. Records every compatibility-path use. Defines the retention condition required before Wave 13 removal. |
| **W11-A6** | `tests/execution/product-delivery-integration.test.mjs` (NEW): real Product Delivery integration tests — new runs use installed scenario, old pinned runs replay through adapters. |
| **W11-A7** | `tests/execution/campaign-coexistence.test.mjs` (NEW): Campaign integration + coexistence tests — Campaign scenario runs alongside Product Delivery without interference. |
| **W11-A8** | `tests/architecture/cutover-architecture-checks.test.mjs` (NEW): tightened architecture checks — new-core imports clean, compatibility-usage reporting. Verifies the cutover didn't introduce hidden fallbacks. |

## 3. The serial cutover commit (§0.14.10)
The integrator (this agent) makes ONE commit that switches new runs to installed scenarios:
- `composition/product-lifecycle-runtime.ts` gains a feature-detected path: if installed scenario exists → use ScenarioRunner; else → legacy path.
- `src/index.ts` gateway: if managed execution has installed scenario → route through new path.
- NO legacy code deleted. Both paths coexist.
- This is the ONLY hot-file edit in Wave 11 (C084).

## 4. Exit gate (§0.14.11)
1. All new Product Delivery runs use installed scenarios.
2. Old pinned runs still replay through explicit compatibility adapters.
3. Campaign runs coexist with Product Delivery.
4. Legacy-run inventory records every compatibility-path use.
5. Architecture checks show no hidden fallbacks in new-core.
6. Ratchet green. Wave 0-10 regression green.

## 5. Anti-scope
- NO legacy code deletion (Wave 13).
- NO NOT NULL enforcement on installation_id (Wave 13).
- NO removal of built-in catalog (Wave 13).
- The cutover is PREPARATION — both paths must coexist.
