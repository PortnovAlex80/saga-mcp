/**
 * workflow-kernel/composition/index.ts - the public surface of the ONE
 * production composition (EK-8, WP-12). The entrypoint of the package:
 * package.json main/bin route here, and nothing else in the tree owns a
 * production orchestration path.
 */

export * from './laws.js';
export * from './pins.js';
export * from './opencode-channel.js';
export * from './production.js';
export * from './console.js';
