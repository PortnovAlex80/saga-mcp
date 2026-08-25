/**
 * workflow-kernel/workshops/discovery/index.ts - the WP-11D public surface:
 * the Discovery workshop converted to the workshop semantic interface on
 * the new kernel (plan phase EK-8 workshop conversion package).
 *
 * REACHABILITY LAW: this package is reachable ONLY from focused tests
 * (tests/workflow-kernel/workshops/discovery/**). No production
 * entrypoint imports it - WP-12 performs the atomic production cutover
 * and, in the same change, deletes the legacy Discovery authority paths
 * listed in ./EK8-CUTOVER-NOTES.md of this directory.
 */

export * from './products.js';
export * from './installed-manifest.js';
export * from './checkplans.js';
export * from './waits.js';
export * from './idea-intake.js';
export * from './contributions.js';
export * from './role-bindings.js';
export * from './cognition.js';
export * from './admission-store.js';
export * from './driver.js';
