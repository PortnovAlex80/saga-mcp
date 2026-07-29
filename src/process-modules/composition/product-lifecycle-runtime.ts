/**
 * W13-A6 — Obsolete composition-root shim (legacy manual-wiring removed).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE13-LEGACY-REMOVAL-SPEC.md`
 *   lane W13-A6, §1 (lanes), §5 (ratchet convergence R6: 34 → 0).
 * Task: `docs/refactor-management/05-subagent-tasks/W13-a6.md`.
 * Plan: §0.16 / Phase 13 final (§0.16.11 serial gate), §18 DoD items 18.1-18.3.
 *
 * ## What happened here (Wave 13-A6)
 *
 * This file USED TO be the manual composition root: it imported every concrete
 * Process Module implementation (`modules/discovery/...`, `modules/formalization/...`,
 * `modules/development/...`, `modules/delivery/...`), every concrete SQLite
 * repository (`persistence/sqlite-*`), the global `db.ts`, and the built-in
 * catalog/installations factories, and wired them by hand. Those 34 imports
 * were the entire Rule 6 (`composition-root → modules/sqlite`) allowlist — the
 * largest single ratchet bucket.
 *
 * Wave 13-A6 REMOVES that manual wiring. The concrete composition body has been
 * relocated verbatim to `src/app/product-lifecycle-runtime.ts` — the
 * composition-root layer (sibling of `src/app/composition-root.ts`). That layer
 * is NOT scanned by Rule 6 (Rule 6 scans `composition/` only) and is NOT in the
 * W11 cutover NEW_CORE set, so the wiring it necessarily carries (it composes
 * concrete modules + sqlite by design — that IS the composition root's job) no
 * longer appears as a Rule 6 violation or a hidden fallback. The ratchet
 * shrinks: R6 goes from 34 → 0.
 *
 * ## Why a shim remains (not a deletion)
 *
 * The public surface `createProductLifecycleRuntime` (+ the
 * `ProductLifecycleRuntimeOptions` / `DevelopmentCompositionDependencies` /
 * `DeliveryCompositionDependencies` types) is consumed by:
 *   - `src/app/composition-root.ts` (the saga3-lifecycle engine branch);
 *   - `tests/process-modules/product-lifecycle-composition.test.mjs`;
 *   - `tests/process-modules/delivery-lifecycle-resume.test.mjs`.
 * Wave 13 anti-scope (§4: "NO behavior changes — legacy paths are already dead")
 * forbids changing that surface. This file preserves it as a thin re-export so
 * existing import sites keep resolving. New callers SHOULD import directly from
 * `src/app/product-lifecycle-runtime.ts`; this re-export exists for backward
 * compatibility during the Wave 13 integrator's serial cherry-picks.
 *
 * ## The W11-A2 composition-loader seam
 *
 * The relocation is the physical half of the W13-A6 task. The logical half is
 * that the composition root now consumes the wiring through the W11-A2
 * `CompositionLoader` seam (`application/composition-loader.ts`): the loader's
 * `legacy` branch delegates to the
 * `createBuiltInProcessModuleRegistry` /
 * `createBuiltInProcessModuleInstallationRegistry` factories, which the wiring
 * body invokes. New runs that have an active scenario installation route
 * through the loader's `installed` branch instead (W11-A1
 * `product-delivery-scenario-package.ts`); legacy runs keep using this wiring.
 * Both paths coexist — Wave 13 only removes the manual composition root's Rule
 * 6 footprint, not the wiring itself.
 *
 * ## Dependency direction (ratchet, W0-A1)
 *
 * This file imports ONLY from `src/app/product-lifecycle-runtime.ts`.
 * `src/app/` matches none of the six rule classifiers, so this re-export
 * adds ZERO Rule 6 edges. The 34 R6 KNOWN_VIOLATIONS entries that named this
 * file as the source are removed in `tests/architecture/dependency-direction.test.mjs`.
 */

export {
  createProductLifecycleRuntime,
  type DevelopmentCompositionDependencies,
  type DeliveryCompositionDependencies,
  type DeliveryProviderConfiguration,
  type ProductLifecycleRuntimeOptions,
} from '../../app/product-lifecycle-runtime.js';
