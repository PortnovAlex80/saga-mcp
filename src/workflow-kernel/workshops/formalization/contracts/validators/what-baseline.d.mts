/**
 * contracts/validators/what-baseline.d.mts - the TypeScript declaration
 * of the FRF-WP03 whole-WHAT baseline validator (FRF-WP11 canonical
 * home; the docs-tree copy is a frozen byte-equal snapshot).
 */

export declare const CONTRACT_KIND = 'frf-contracts.what-baseline.v1';
export declare const HANDOFF_BINDING_KINDS: readonly string[];
export declare const WORK_ITEM_OBLIGATION_KINDS: readonly string[];

export declare function validateWhatBaseline(
  baseline: unknown,
  universe: unknown,
): { ok: true; kind: string; digest: string; ref: string; payload: unknown } | { ok: false; refused: true; reason: string; detail: string };

export { REFUSAL_REASONS } from './common.mjs';
