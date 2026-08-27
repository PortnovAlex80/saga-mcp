/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/shared.mjs -
 * the FRF-WP07 WHAT-freeze cell: shared typed-refusal surface and the
 * FRF-WP03 contract seam (INSTALLED wiring since the FRF-WP11 cutover).
 *
 * FRF-WP07 (plan phase FRF-7, "Replace the baseline and settlement
 * authority") owns the replacement whole-WHAT baseline, the exact
 * accepted-authority ingestion, persistence, settlement, the solution
 * contract, and the authority mutations. Since the FRF-WP11 cutover this
 * cell package is an INSTALLED package surface: the installed workshop
 * routes the freeze-what-baseline and settle-formalization desks through
 * it (the folded EK-8 baseline/settlement contracts died at the cutover).
 *
 * THE WP03 VALIDATOR SEAM (documented law of this cell):
 *   The cell does NOT re-implement the whole-WHAT baseline contract. It
 *   imports the FRF-WP03 typed validator and canonical digest helpers by
 *   exact relative path from the CANONICAL in-package contracts tree
 *   (FRF-WP11: the contracts moved to
 *   src/workflow-kernel/workshops/formalization/contracts/; the docs-tree
 *   copies are frozen byte-equal snapshots, removal-guarded - the
 *   pre-cutover relative docs/ import died at the cutover exactly as this
 *   seam documented it would):
 *     contracts/validators/
 *       what-baseline.mjs   (validateWhatBaseline, CONTRACT_KIND, vocabularies)
 *       common.mjs          (sha256OfCanonical, digestExcluding, ... - the
 *                            canonical rule byte-identical to
 *                            src/workflow-kernel/domain/digest.ts)
 *   The frozen output of this cell is a
 *   `frf-contracts.what-baseline.v1` payload that MUST seal via
 *   validateWhatBaseline(baseline, universe) with the exact accepted id
 *   sets carried by the transition (fail-closed; the freezer never scans,
 *   guesses or reselects). The blocking seam test
 *   (tests/.../cells/what-freeze/seam.test.mjs) pins both sides: contract
 *   identity equality and canonical digest parity with
 *   dist/workflow-kernel/domain/digest.js.
 *
 * PURITY: node:crypto (via the WP03 helpers) and pure functions only.
 * No session, no SQL, no clock, no network, no filesystem reads.
 */

/** The in-package canonical seam import sites (single import site for the whole cell). */
export const WP03_SEAM = Object.freeze({
  contractId: 'frf-contracts.what-baseline.v1',
  validatorPath: '../../contracts/validators/what-baseline.mjs',
  commonPath: '../../contracts/validators/common.mjs',
});

// The seam imports (single import site for the whole cell; imported as
// local bindings and re-exported for the rest of the cell).
import {
  validateWhatBaseline,
  CONTRACT_KIND,
  HANDOFF_BINDING_KINDS,
  WORK_ITEM_OBLIGATION_KINDS,
} from '../../contracts/validators/what-baseline.mjs';
import {
  canonicalJson,
  digestExcluding,
  findDuplicates,
  setIdentical,
  sha256OfCanonical,
} from '../../contracts/validators/common.mjs';

export {
  validateWhatBaseline,
  CONTRACT_KIND,
  HANDOFF_BINDING_KINDS,
  WORK_ITEM_OBLIGATION_KINDS,
  canonicalJson,
  digestExcluding,
  findDuplicates,
  setIdentical,
  sha256OfCanonical,
};

/* ------------------------------------------------------------------ */
/* Typed refusals (the closed seven-code kernel vocabulary)            */
/* ------------------------------------------------------------------ */

export const PRODUCT_REFUSAL_REASONS = Object.freeze([
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'FOREIGN_LINEAGE',
  'MALFORMED_PRODUCT',
  'MISSING_LINEAGE',
  'SCOPE_VIOLATION',
  'STALE_LINEAGE',
]);

export function refused(reason, detail) {
  if (!PRODUCT_REFUSAL_REASONS.includes(reason)) {
    throw new Error(`WHAT-FREEZE-REFUSAL-UNKNOWN: ${String(reason)} is outside the closed refusal vocabulary`);
  }
  return { detail, ok: false, reason, refused: true };
}

export function isRefused(value) {
  return value !== null && typeof value === 'object' && value.ok === false && value.refused === true;
}

/** Seal one content-addressed artifact: digest recomputed over canonical content. */
export function artifactOf(content) {
  const digest = sha256OfCanonical(content);
  return { content, digest, ref: `sha256:${digest}` };
}

/** True when two sorted string arrays are set-equal (order-independent). */
export function sameSet(a, b) {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
