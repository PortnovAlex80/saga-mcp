# Phase 0 — Coverage and Unresolved Regions Statement

## What was covered

| Coverage Type | Status | Evidence |
|---|---|---|
| **Inventory** | ✅ Complete | 347 .ts files under src/ enumerated; all subdirectories mapped |
| **Structural** | ✅ Complete | Full directory tree; per-directory file counts; module layering audited |
| **Executable topology** | ✅ Complete | 5 processes traced from entry point → composition root → modules → state stores |
| **Reachable-path** | ✅ Complete (static) | All 4 LEGO register functions traced; composition root wiring mapped to instruction-level |
| **Scenario coverage** | ❌ Not in Phase 0 | Deferred to Phase 2 (scenario-component matrix) |
| **State ownership** | ❌ Not in Phase 0 | Deferred to Phase 2 |
| **Data-flow** | ❌ Not in Phase 0 | Deferred to Phase 2 |
| **Rule extraction** | ❌ Not in Phase 0 | Deferred to Phase 3 |
| **Algorithm coverage** | ❌ Not in Phase 0 | Deferred to Phase 5 |
| **Cross-cutting constraint** | ❌ Not in Phase 0 | Deferred to Phase 5.5 |
| **Unresolved semantic** | ⚠️ 2 regions identified | See below |

## What was only inventoried (not semantically understood)

1. **`src/process-modules/modules/*/package/resources/` (embedded skills, checklists, templates)** — 39 .md files + 11 .json files. These are packaged assets (SKILL.md prompt definitions, JSON call-templates). Inventoried but not semantically analyzed — they are prompt-engineering content, not source code.

2. **`src/process-modules/modules/formalization/formalization-installation.ts` (2062 lines)** — the single largest source file. Inventoried as the #1 file by line count. Phase 0 did NOT read it line-by-line. It appeared in the pre-migration analysis as a known installation orchestrator; its post-migration role is confirmed (consumed by `registerFormalization`) but its internal structure was not re-audited.

3. **`src/process-modules/persistence/` (~30 sqlite-*.ts files)** — inventoried as the persistence layer. Not individually read; their contracts are inferred from the register functions that construct them.

## What was inferred (not directly observed)

1. **Production runtime behavior** — Evidence Level E5 maximum (tests pass). No Evidence Level E6 (runtime logs/traces/telemetry) was available or consulted. Whether the tested paths represent the main runtime workload is **unknown**.

2. **WorkplaceProductPort adoption** — inferred as "wired but unconsumed" from grep evidence. No module's register function reads `sharedDeps.workplaceProductPort`; no kernel handler calls its methods. This is E1 (statically referenced) but NOT E3 (reachable from a production execution path that exercises it).

3. **`src/engines/saga3-*-engine.ts` production status** — confirmed unreachable from `selectEngine` (E2-E3 negative: the branches were removed in the saga4 cutover). Still reachable from direct test construction (E5). Production status: **retired but not deleted** (fossil candidate for Phase 8).

## What remains unresolved

1. **`tests/saga3/` directory (24 files)** — test-side migration residue. The source-side `src/saga3/` was eliminated, but the test folder retains the old name. Whether these tests are characterization tests (still valid, just poorly named) or dead tests (testing removed code) is **unresolved** until Phase 2 maps scenario-to-component coverage.

2. **`canonical-json.ts` duplication** — exists in both `src/shared/canonical-json.ts` and `src/process-modules/shared/canonical-json.ts`. The latter re-exports the former. Whether this is a legitimate dependency-inversion boundary (avoiding `process-modules` → `shared` imports of saga3 code) or an unnecessary indirection is **unresolved** until Phase 4 (seam map).

3. **Two composition surfaces** — `src/app/product-lifecycle-runtime.ts` (617 lines, the LEGO body) and `src/process-modules/composition/product-lifecycle-runtime.ts` (70-line shim, re-export for back-compat). Whether the shim is still needed (who imports it) is **unresolved** until the executable topology is refined in Phase 1.

4. **Module DDD-layer asymmetry** — `src/modules/discovery/` has `domain/ + application/ + infrastructure/`. The other 3 modules have ONLY `infrastructure/`. Their domain logic and application services still live in `src/process-modules/modules/*/`. Whether this is a deliberate "move-as-you-touch" strategy or an incomplete migration is **unresolved** until Phase 8 (relocation map).

## Which conclusions depend on unavailable evidence

- **Whether the 4-desk unification is architecturally safe** depends on runtime evidence (E6) that the four submit paths (`saga3_proposals`, `saga3_managed_artifact_productions`, `saga3_managed_node_submissions`, kernel-only delivery) produce byte-identical product shapes. The pre-migration analysis proved this statically (E0-E2); it has NOT been observed at runtime.
- **Whether the LEGO contract actually reduces cognitive load** depends on stakeholder evidence (developer experience). Not measurable from code alone.

## Evidence-level summary for key findings

| Finding | Evidence Level | Basis |
|---|---|---|
| saga3/ directory eliminated | E0 | `ls src/saga3/` → not found |
| 4 register functions wired | E2 | Read in product-lifecycle-runtime.ts:436-439 |
| 347 .ts files under src/ | E0 | `find` enumeration |
| 5 processes identified | E3 | Traced from package.json entry points |
| WorkplaceProductPort has no consumers | E1 | grep: defined + injected, no callers |
| 3220 tests pass | E5 | `npm test` |
| Production behavior of any path | — | E6 unavailable; not claimed |
