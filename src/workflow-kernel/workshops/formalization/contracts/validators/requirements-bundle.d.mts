/**
 * contracts/validators/requirements-bundle.d.mts - the TypeScript
 * declaration of the FRF-WP03 requirements-bundle validator (FRF-WP11
 * canonical home; the docs-tree copy is a frozen byte-equal snapshot).
 */

export declare const CONTRACT_KIND = 'frf-contracts.requirements-bundle.v1';

export declare function validateRequirementsBundle(
  bundle: unknown,
  universe: unknown,
): { ok: true; kind: string; digest: string; ref: string; payload: unknown } | { ok: false; refused: true; reason: string; detail: string };

export { REFUSAL_REASONS } from './common.mjs';
