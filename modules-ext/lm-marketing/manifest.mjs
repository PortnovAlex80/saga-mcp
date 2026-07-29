// @ts-check
/**
 * W10-A1 — lm-marketing central manifest envelope.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 *
 * This is the CENTRAL manifest for the Marketing LM Process Module package. It
 * wraps the pure {@link lmMarketingModule} definition and declares the pinned
 * resources, handlers, and contracts the module depends on. It is the single
 * object an installer hands to the Wave 2 content-addressed package store (or
 * the Wave 11 composition cutover).
 *
 * The manifest is PURE DATA — no functions, no factories, no class instances
 * (plan §3.5). It is validated by `validateProcessModuleManifest` at module
 * load; a structural regression throws synchronously and fails the load —
 * exactly the W9-A1 discovery manifest pattern.
 *
 * The file imports ONLY the public process-module SPI from the compiled `dist/`
 * runtime surface — it never imports `src/index.ts`, `modules/catalog.ts`,
 * `tracker-view/`, the composition root, or any existing built-in module. That
 * import discipline IS the §0.13.10 proof.
 *
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').ProcessModuleManifest} ProcessModuleManifest
 */

import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import {
  lmMarketingModule,
  LM_MARKETING_MODULE_REF,
} from './definition.mjs';
import {
  marketingResourceIndex,
  marketingHandlerRefs,
  marketingInputContractRef,
  marketingOutputContractRef,
} from './contributions.mjs';

// ---------------------------------------------------------------------------
// Manifest format + runtime identity.
// ---------------------------------------------------------------------------

/**
 * Format version of THIS manifest envelope. `'1'` signals the envelope wraps a
 * real ProcessModuleDefinition that populates `resourceIndex` / `handlerRefs`
 * (mirrors the W8/W9 built-in packages). It is distinct from the W0-A7
 * fixture's `'0.1.0'` data-only envelope.
 */
export const LM_MARKETING_MANIFEST_FORMAT_VERSION = '1';

/**
 * Runtime API compatibility range this package requires. The package was
 * authored against the saga 3.x process-module SPI; it is valid for any 3.x
 * runtime. The `<4.0.0` upper bound reserves room for the 4.x cutover.
 */
export const LM_MARKETING_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

// ---------------------------------------------------------------------------
// Central manifest (validated at module load).
// ---------------------------------------------------------------------------

/**
 * The central, validated ProcessModuleManifest for the Marketing LM package.
 *
 * Validation runs at module load: `validateProcessModuleManifest` enforces both
 * canonical serializability (plan §3.5) and structural completeness (required
 * fields present, `logicalId`s unique, `resourceIndex` kinds known). A
 * regression throws synchronously.
 *
 * @type {ProcessModuleManifest}
 */
export const marketingPackageManifest = (() => {
  const manifest = {
    manifestFormatVersion: LM_MARKETING_MANIFEST_FORMAT_VERSION,
    definition: lmMarketingModule,
    resourceIndex: marketingResourceIndex,
    handlerRefs: marketingHandlerRefs,
    inputContractRef: marketingInputContractRef,
    outputContractRef: marketingOutputContractRef,
    runtimeCompatibilityRange: LM_MARKETING_RUNTIME_COMPATIBILITY_RANGE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(`lm-marketing package manifest failed validation:\n${rendered}`);
  }
  return Object.freeze(manifest);
})();

/**
 * Re-run the SPI validator on the manifest (for conformance tests).
 * @returns {{ ok: boolean; errors: readonly { code: string; path: string; message: string }[] }}
 */
export function validateMarketingPackageManifest() {
  return validateProcessModuleManifest(marketingPackageManifest);
}

export { LM_MARKETING_MODULE_REF };
