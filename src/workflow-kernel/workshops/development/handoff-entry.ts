/**
 * workflow-kernel/workshops/development/handoff-entry.ts - the FRF-WP09
 * lifecycle handoff edge on the Development workshop's public surface
 * (FRF-WP11 wiring): the ONE edge settle-formalization
 * --domain.formalized--> complete-formalized hands off, the
 * DevelopmentCase entry it settles into, and the byte-for-byte record
 * law the mapping enforces.
 *
 * The runtime modules are the FRF-WP09 .mjs desks beside this file
 * (mirrored into dist by the build's copy step); this module is the
 * typed composition point the workshop exports, so the Development
 * entry is addressable from the workshop surface (the Formalization
 * driver settles the case here at run settlement).
 *
 * PURITY: re-exports only. No I/O, no session, no clock.
 */

export { FORMALIZATION_TO_DEVELOPMENT_EDGE, mapSettlementToDevelopmentEntry, lifecycleHandoffRecord } from './handoff/lifecycle.mjs';
export { DEVELOPMENT_CASE_KIND, DEVELOPMENT_CASE_ENTRY_ID, buildDevelopmentCase, validateDevelopmentCase } from './handoff/case.mjs';
