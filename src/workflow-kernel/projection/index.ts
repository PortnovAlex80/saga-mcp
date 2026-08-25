/**
 * workflow-kernel/projection/index.ts - the projection package barrel
 * (WP-10, plan phase EK-7).
 *
 * Composition note: this package is the Kanban/tools/hooks/operator-UI
 * PROJECTION over the event/evidence kernel. It owns no workflow decision:
 * every lane is a human view derived from authoritative facts, every UI
 * action is a typed command against the frozen universe, and the card
 * store is disposable by construction. Production reachability stays
 * TEST-ONLY until WP-12 performs the production cutover.
 */

export * from './cards.js';
export * from './store.js';
export * from './projector.js';
export * from './adapters.js';
export * from './context.js';
export * from './fences.js';
