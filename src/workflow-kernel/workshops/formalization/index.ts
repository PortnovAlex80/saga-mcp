/**
 * workflow-kernel/workshops/formalization/index.ts - the public surface
 * of the Formalization workshop semantic package (WP-11F installation;
 * FRF-WP11 semantic cutover: the installed desks route through the FRF
 * cells - WP04-09 - over the in-package WP03 contracts; the old products/
 * contribution desk validators died at the cutover).
 *
 * REACHABILITY LAW (FRF-WP11): this package is an INSTALLED production
 * surface. The ONE production composition
 * (src/workflow-kernel/composition/production.ts) imports its role
 * contracts; the kernel (domain/application/persistence/planning) never
 * imports it - workshop identity lives in installed manifests, never in
 * kernel conditionals.
 */

export * from './contracts/identity.js';
export * from './contracts/artifacts.js';
export * from './manifest.js';
export * from './ingress.js';
export * from './gates.js';
export * from './effects.js';
export * from './roles.js';
export * from './envelope.js';
export * from './actors.js';
export * from './driver.js';
