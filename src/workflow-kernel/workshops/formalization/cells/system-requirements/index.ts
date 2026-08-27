/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * index.ts - the public surface of the derive-system-requirements
 * Production Cell package (FRF-WP05).
 *
 * REACHABILITY LAW (test-only until FRF-WP11): nothing outside this
 * directory imports it; no installed manifest, driver or composition root
 * wires it yet. The coordinator lands the package wiring in FRF-WP11
 * (installed handler bindings) after WP04-WP10 close.
 *
 * PURITY: re-exports only; no behavior of its own.
 */

export * from './contract.js';
export * from './bundle.js';
export * from './protocol.js';
export * from './skill.js';
export * from './seam.js';
export * from './checkplan.js';
export * from './reviewer.js';
export * from './roles.js';
