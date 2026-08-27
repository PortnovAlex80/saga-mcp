/**
 * contracts/validators/uc-scenario-member.d.mts - the TypeScript
 * declaration of the FRF-WP03 UC scenario-member validator (FRF-WP11
 * canonical home; the docs-tree copy is a frozen byte-equal snapshot).
 */

export declare const CONTRACT_KIND = 'frf-contracts.uc-scenario-member.v1';

export declare function validateUcScenarioMember(
  scenario: unknown,
  universe: unknown,
): { ok: true; kind: string; digest: string; ref: string; payload: unknown } | { ok: false; refused: true; reason: string; detail: string };

export { REFUSAL_REASONS } from './common.mjs';
