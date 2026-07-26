/**
 * Process-module-shared canonicalization + hashing utilities.
 *
 * Re-export of the canonical primitives from saga3/shared. The functions
 * themselves are pure (only node:crypto) and module-agnostic; they were born
 * inside the Discovery Edition but are useful to any Process Module that needs
 * deterministic JSON hashing (Formalization baseline hash, generic certificate
 * hash, NodeRun output hash, …).
 *
 * This module exists so that generic Process Module code (generic-flow-executor,
 * generic-flow-engine-adapter, …) does NOT import from `saga3/*` — that would
 * cross the Pack/Core boundary the wrong way. Discovery Pack imports the same
 * primitives from its own saga3/shared; both resolve to the same byte-identical
 * implementation.
 */

export { canonicalJson, sha256Hex } from '../../saga3/shared/discovery-canonical.js';
