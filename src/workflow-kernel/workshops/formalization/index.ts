/**
 * workflow-kernel/workshops/formalization/index.ts - the WP-11F public
 * surface: the Formalization workshop semantic package on the new kernel
 * (plan phase EK-8 workshop conversion).
 *
 * REACHABILITY LAW (plan EK-8): this package is reachable ONLY from
 * focused tests (tests/workflow-kernel/workshops/formalization/**) until
 * WP-12 performs the atomic production cutover and, in the same change,
 * deletes the legacy Formalization authority paths listed in
 * ./EK8-DELETION-SET.md of this directory. No production entrypoint
 * imports it; the kernel (domain/application/persistence/planning) never
 * imports it - workshop identity lives in installed manifests, never in
 * kernel conditionals.
 */

export * from './products.js';
export * from './manifest.js';
export * from './ingress.js';
export * from './contribution.js';
export * from './gates.js';
export * from './effects.js';
export * from './roles.js';
export * from './envelope.js';
export * from './actors.js';
export * from './driver.js';
