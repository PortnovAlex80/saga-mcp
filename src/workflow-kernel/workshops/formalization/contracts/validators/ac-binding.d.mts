/**
 * contracts/validators/ac-binding.d.mts - the TypeScript declaration of
 * the FRF-WP03 AC-binding validator (FRF-WP11 canonical home; the
 * docs-tree copy is a frozen byte-equal snapshot).
 */

export declare const CONTRACT_KIND = 'frf-contracts.ac-binding.v1';

export declare function validateAcBinding(
  criterion: unknown,
  universe: unknown,
): { ok: true; kind: string; digest: string; ref: string; payload: unknown } | { ok: false; refused: true; reason: string; detail: string };

export { REFUSAL_REASONS } from './common.mjs';
