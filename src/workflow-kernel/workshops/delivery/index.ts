/**
 * workflow-kernel/workshops/delivery/index.ts - the WP-11L public surface:
 * the Delivery semantic package conversion (plan phase EK-8).
 *
 * REACHABILITY LAW: this workshop package is reachable ONLY from focused
 * tests (tests/workflow-kernel/workshops/delivery/**). No production
 * entrypoint imports it - WP-12/EK-8 performs the atomic production
 * cutover and, in the same change, deletes the legacy Delivery authority
 * paths listed in ./EK8-DELETION-SET.md of this directory.
 */

export * from './manifest.js';
export * from './bundle.js';
export * from './roles.js';
export * from './preflight.js';
export * from './packaging.js';
export * from './approval.js';
export * from './conveyor.js';
