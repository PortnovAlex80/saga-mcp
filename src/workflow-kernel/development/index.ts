/**
 * workflow-kernel/development/index.ts - the WP-08 public surface: the
 * Development/material vertical + capsule ingress (plan phase EK-5).
 *
 * REACHABILITY LAW (plan EK-5): this vertical is reachable ONLY from focused
 * tests (tests/workflow-kernel/development/**). No production entrypoint
 * imports it - WP-12/EK-8 performs the atomic production cutover and, in the
 * same change, deletes the legacy Development authority paths listed in
 * ./EK8-DELETION-SET.md of this directory.
 */

export * from './capsule.js';
export * from './role-contract-runtime.js';
export * from './admission-store.js';
export * from './envelope-assembly.js';
export * from './actors.js';
export * from './product-acceptance.js';
export * from './material-chain.js';
