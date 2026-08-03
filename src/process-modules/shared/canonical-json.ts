/**
 * Process-module-shared canonicalization + hashing utilities.
 *
 * Re-export of the canonical primitives from src/shared. The functions
 * themselves are pure (only node:crypto) and module-agnostic; they were born
 * inside the Discovery Edition but are useful to any Process Module that needs
 * deterministic JSON hashing (Formalization baseline hash, generic certificate
 * hash, NodeRun output hash, …).
 *
 * This module exists so that generic Process Module code (generic-flow-executor,
 * generic-flow-engine-adapter, …) imports the cross-cutting primitives from the
 * shared `src/shared` layer rather than reaching into a Pack. Both the generic
 * Process Module code and the Discovery Pack resolve to the same
 * byte-identical implementation in `src/shared/canonical-json.ts`.
 */

export { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
