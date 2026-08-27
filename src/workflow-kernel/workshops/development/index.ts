/**
 * workflow-kernel/workshops/development/index.ts - the WP-11V public
 * surface: the converted Development workshop package (plan phase EK-8
 * workshop conversion, test-only until the WP-12 cutover).
 *
 * The package is the workshop SEMANTIC INTERFACE as data over the frozen
 * kernel: installation manifest + product schemas + pure contribution
 * mappings + CheckPlans and semantic gates + idempotent effects + typed
 * D5/D12 waits (including the Elite-2 readiness-certification human gate)
 * + the real CanonicalRoleContract bindings with exact role-universe
 * equality and the pre-cutover dispatcher/runner/tracker digest consensus
 * + the staged runbook driving the whole scenario through the WP-07
 * obligation consumer and WP-09-style durable bindings, building on the
 * WP-08 vertical by import only.
 *
 * REACHABILITY: like the WP-08 vertical, this package is reachable ONLY
 * from focused tests (tests/workflow-kernel/workshops/development/** and
 * .../synthetic/**); WP-12/EK-8 performs the production cutover.
 */

// FRF-WP09/WP11: the lifecycle handoff edge surface - the DevelopmentCase
// entry the Formalization settlement settles into (the formalization
// driver consumes this at run settlement; the planning desks in handoff/
// plan + workitem consume the case's scenario obligations).
export * from './handoff-entry.js';
export * from './installation.js';
export * from './manifest.js';
export * from './products.js';
export * from './mappings.js';
export * from './checkplans.js';
export * from './bindings.js';
export * from './waits.js';
export * from './effects.js';
export * from './runbook.js';
