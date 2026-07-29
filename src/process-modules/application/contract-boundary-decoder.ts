/**
 * W3-A7 — ContractBoundaryDecoder: decode + validate payloads at the Process
 * Module execution boundaries via the Wave 1 `ContractSchemaRegistry`.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md`
 *   §10, §7.4.2 (scenario handoff). Frozen input: `a415939`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every Process Module execution has FIVE boundaries where a payload crosses
 * from one trust/domain boundary into another (spec §7.4.2):
 *
 *   1. MODULE INPUT      — the input payload handed to `startProcessModule`
 *                           (must conform to the module's input contract).
 *   2. NODE INPUT        — the input handed to one node (must conform to the
 *                           node's `inputSchema`).
 *   3. NODE OUTPUT       — the production a node emits (must conform to the
 *                           node's output / production schema).
 *   4. MODULE COMPLETION — the terminal `ModuleCompletion` envelope a module
 *                           emits (must conform to the completion contract).
 *   5. SCENARIO HANDOFF  — the payload one module hands to the next across a
 *                           Lifecycle Scenario stage transition (must conform
 *                           to the handoff contract declared by the scenario).
 *
 * At each boundary the runtime MUST validate the payload against the contract
 * identified by a `ContractRef` BEFORE trusting it, and decode it from its
 * canonical-bytes form into the in-memory value downstream code consumes. This
 * file is the single chokepoint that does both, delegating the actual
 * encode/decode/validate to the Wave 1 `ContractSchemaRegistry`.
 *
 * ── Decode vs validate ─────────────────────────────────────────────────────
 *
 *   validateAtBoundary(ref, value, registry): ValidationResult
 *     — NON-throwing. Returns a Wave 1 `ValidationResult`. Use this at every
 *       boundary to decide trust without a try/catch.
 *
 *   decodeAtBoundary(ref, value, registry): unknown
 *     — THROWS on validation failure or unknown ref. Use this when the caller
 *       has already decided to accept the payload and wants the canonical
 *       in-memory form (it round-trips value → canonical bytes → decoded
 *       value, normalizing any non-canonical formatting). The throw carries
 *       the spec-mandated `CONTRACT_SCHEMA_UNKNOWN` token for unknown refs.
 *
 * `decodeAtBoundary` is defined as `decode(encode(value))`: it canonicalizes
 * the value through the codec so two payloads that are semantically equal but
 * textually different (key ordering, whitespace) decode to the SAME in-memory
 * object. This is what makes crash-resume byte-equality (§0.6.12) hold even
 * when the substrate round-trips JSON with different formatting.
 *
 * ── Layering ───────────────────────────────────────────────────────────────
 *
 * This file lives in `application/` and imports only the Wave 1 SPI barrel
 * (`domain/spi/index.js`). It owns NO state — the registry is passed in. It is
 * pure with respect to its inputs: same (ref, value, registry) → same output.
 * Wave 3 ships the decoder; Wave 5 wires it into the executor boundaries.
 */

import {
  CONTRACT_SCHEMA_UNKNOWN,
  type ContractRef,
  type ContractSchemaRegistry,
  type ValidationResult,
} from '../domain/spi/index.js';

// Re-export for downstream consumers (W3-A1/A2 import boundary vocab from here).
export {
  CONTRACT_SCHEMA_UNKNOWN,
  type ContractRef,
  type ContractSchemaRegistry,
  type ValidationResult,
  type ValidationError,
} from '../domain/spi/index.js';

// ---------------------------------------------------------------------------
// Boundary vocabulary (spec §7.4.2).
// ---------------------------------------------------------------------------

/**
 * The five Process Module execution boundaries where a payload must be
 * validated against a contract (spec §7.4.2). Lifted into a typed union so a
 * caller names the boundary explicitly — the decoder logs/branches on it.
 */
export type ContractBoundaryKind =
  | 'module-input'
  | 'node-input'
  | 'node-output'
  | 'module-completion'
  | 'scenario-handoff';

/**
 * Human-readable labels for each boundary kind, for error messages. Keeps the
 * decoder free of string literals scattered through branches.
 */
export const BOUNDARY_KIND_LABELS: Readonly<Record<ContractBoundaryKind, string>> =
  Object.freeze({
    'module-input': 'module input',
    'node-input': 'node input',
    'node-output': 'node output',
    'module-completion': 'module completion',
    'scenario-handoff': 'scenario handoff',
  });

/**
 * A boundary-qualified contract reference: the `ContractRef` PLUS the boundary
 * kind it is being checked at. The boundary kind is informational (the same
 * `ContractRef` may be checked at multiple boundaries); it enriches errors.
 */
export interface BoundaryContractRef {
  readonly boundary: ContractBoundaryKind;
  readonly ref: ContractRef;
}

// ---------------------------------------------------------------------------
// Core operations.
// ---------------------------------------------------------------------------

/**
 * Validate `value` against the contract identified by `ref`, using `registry`.
 * NON-throwing: returns a Wave 1 `ValidationResult`.
 *
 * Three outcomes:
 *   - `{ ok: true,  errors: [] }`                          — value conforms.
 *   - `{ ok: false, errors: [{CONTRACT_SCHEMA_UNKNOWN}] }` — no codec registered
 *                                                            for `ref`.
 *   - `{ ok: false, errors: [{SCHEMA_VIOLATION, …}] }`     — codec rejected.
 *
 * The `CONTRACT_SCHEMA_UNKNOWN` outcome is reported as a validation failure
 * (not a throw) so a caller can collect all boundary failures in one pass
 * without a try/catch around each. The error `code` is the spec-mandated
 * literal token; `message` carries the underlying detail.
 */
export function validateAtBoundary(
  ref: ContractRef,
  value: unknown,
  registry: ContractSchemaRegistry,
): ValidationResult {
  if (!registry.has(ref)) {
    return {
      ok: false,
      errors: [
        {
          code: CONTRACT_SCHEMA_UNKNOWN,
          path: '$',
          message:
            `no codec registered for ${ref.schemaId}@${ref.version} ` +
            `(digest=${ref.digest})`,
        },
      ],
    };
  }
  try {
    registry.validateOrThrow(ref, value);
  } catch (e) {
    return {
      ok: false,
      errors: [
        {
          code: 'SCHEMA_VIOLATION',
          path: '$',
          message: (e as Error).message,
        },
      ],
    };
  }
  return { ok: true, errors: [] };
}

/**
 * Decode `value` at the boundary identified by `ref`, using `registry`.
 *
 * Round-trips the value through the codec (`decode(encode(value))`) so the
 * returned object is the CANONICAL in-memory form: two semantically-equal
 * payloads with different textual formatting decode to the SAME object. This
 * is what guarantees crash-resume byte-equality (§0.6.12) across substrates
 * that round-trip JSON differently.
 *
 * THROWS on:
 *   - unknown ref — `Error` whose `message` starts with
 *     `CONTRACT_SCHEMA_UNKNOWN` (the registry raises it; the spec mandates the
 *     token). Callers that prefer non-throwing semantics should call
 *     `validateAtBoundary` first.
 *   - schema violation — `Error` whose `message` carries the codec's detail.
 *
 * Use this when the caller has already decided to accept the payload (e.g.
 * after `validateAtBoundary` returned ok) and wants the normalized value.
 */
export function decodeAtBoundary(
  ref: ContractRef,
  value: unknown,
  registry: ContractSchemaRegistry,
): unknown {
  // validateOrThrow raises CONTRACT_SCHEMA_UNKNOWN for unknown refs and the
  // codec's own error for shape violations. Running it first gives a clear
  // failure BEFORE we attempt encode (which may also throw, but less
  // informatively for some codecs).
  registry.validateOrThrow(ref, value);
  const canonicalBytes = registry.encode(ref, value);
  return registry.decode(ref, canonicalBytes);
}

// ---------------------------------------------------------------------------
// Convenience: boundary-qualified helpers.
// ---------------------------------------------------------------------------

/**
 * Validate `value` at a qualified boundary (`BoundaryContractRef`). Same
 * semantics as `validateAtBoundary`, but the error `path` is prefixed with the
 * boundary label so a multi-boundary validation report reads cleanly.
 *
 * Example: validating a module-input payload that violates its contract
 * produces an error at path `module-input:$` instead of bare `$`.
 */
export function validateAtQualifiedBoundary(
  boundary: BoundaryContractRef,
  value: unknown,
  registry: ContractSchemaRegistry,
): ValidationResult {
  const base = validateAtBoundary(boundary.ref, value, registry);
  if (base.ok) return base;
  const label = BOUNDARY_KIND_LABELS[boundary.boundary];
  return {
    ok: false,
    errors: base.errors.map((e) => ({
      code: e.code,
      path: e.path === '$' ? `${label}:$` : `${label}:${e.path}`,
      message: e.message,
    })),
  };
}

/**
 * Decode `value` at a qualified boundary. Thin wrapper over
 * `decodeAtBoundary`; the boundary kind is informational (it does not change
 * decoding, which depends only on `ref`).
 */
export function decodeAtQualifiedBoundary(
  boundary: BoundaryContractRef,
  value: unknown,
  registry: ContractSchemaRegistry,
): unknown {
  return decodeAtBoundary(boundary.ref, value, registry);
}
