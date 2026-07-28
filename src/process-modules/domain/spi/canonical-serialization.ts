/**
 * W1-A1 — Canonical serialization validator (pure SPI helper).
 *
 * Plan section 3.5 / WAVE1-PURE-SPI-SPEC section 2: every persisted Process
 * Module manifest must be canonical-serializable — no functions, no Map/Set,
 * no class instances, no Symbol, no non-finite numbers, and no `undefined`
 * inside arrays. `undefined` as an OBJECT value is acceptable: it is dropped
 * by `JSON.stringify` / `canonicalJson` and therefore round-trips losslessly.
 *
 * This module is PURE: it imports only the frozen `canonicalJson` primitive
 * from `../shared/canonical-json.js` (which itself only imports `node:crypto`).
 * No classes, no I/O, no side effects. The error type is a plain data object
 * (not an Error subclass) so it is itself canonical-serializable and can cross
 * the module boundary in a `ValidationResult`.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md section 1
 * (row 1) + section 2 (validator behavior) + section 3 (negative-test contract).
 * Task: docs/refactor-management/05-subagent-tasks/W01-A1-canonical-serialization.md.
 */

import { canonicalJson } from '../../shared/canonical-json.js';

/**
 * Error shape returned by `assertCanonicalSerializable`. A plain data object
 * (not an Error subclass) so that it is itself canonical-serializable and can
 * be embedded in a `ValidationResult.errors[]` entry without re-triggering the
 * validator.
 *
 * Fields:
 *   - `code`: fixed discriminator `'CANONICAL_SERIALIZATION_INVALID'`.
 *   - `path`: JSON-path to the offending value (e.g. `$.foo[2].bar`). The root
 *     value is `$`. Always non-empty when thrown by `assertCanonicalSerializable`.
 *   - `reason`: human-readable description of which forbidden kind was found.
 */
export interface CanonicalSerializationError {
  readonly code: 'CANONICAL_SERIALIZATION_INVALID';
  readonly path: string;
  readonly reason: string;
}

/**
 * Returns `true` iff `value` (recursively) is canonical-serializable.
 *
 * ACCEPTABLE (returns true):
 *   - `null`, `boolean`, `string`, finite `number`.
 *   - plain objects (`{}`) whose own + nested values are themselves acceptable;
 *     `undefined` as an object VALUE is acceptable (dropped by canonicalJson).
 *   - arrays whose elements are themselves acceptable. NOTE: `undefined` INSIDE
 *     an array is NOT acceptable (it serializes to `null`, silently corrupting
 *     the value), so it is rejected.
 *
 * REJECTED (returns false):
 *   - functions, `Symbol` values, `Symbol` keys (caught by validators that use
 *     this helper via the object-key recursion below).
 *   - `Map`, `Set`.
 *   - class instances (any object whose `constructor` is neither `Object` nor
 *     `Array`).
 *   - non-finite numbers (`NaN`, `Infinity`, `-Infinity`).
 *   - `undefined` inside an array.
 *
 * Recursion descends into plain objects and arrays only. This function performs
 * no allocation beyond the boolean return and is safe to call on cyclic-free
 * canonical-shape data (manifest data is acyclic by construction).
 */
export function isCanonicalSerializable(value: unknown): boolean {
  return check(value, '$') === null;
}

/**
 * Throws a `CanonicalSerializationError` if `value` is NOT canonical-
 * serializable; otherwise returns `void`. The thrown error carries the
 * JSON-path to the offending value and a human-readable reason.
 *
 * The error is a plain data object with `code: 'CANONICAL_SERIALIZATION_INVALID'`
 * — callers that prefer to surface it inside a `ValidationResult` can do so
 * directly. To turn it into an `Error`, wrap: `throw { ...err, name, message }`
 * or use `canonicalJsonOrThrow` which never returns the error shape.
 */
export function assertCanonicalSerializable(value: unknown): void {
  const err = check(value, '$');
  if (err !== null) {
    throw err;
  }
}

/**
 * Asserts `value` is canonical-serializable, then returns `canonicalJson(value)`.
 * Convenience for validators that want "serialize or fail loudly" in one call.
 */
export function canonicalJsonOrThrow(value: unknown): string {
  assertCanonicalSerializable(value);
  return canonicalJson(value);
}

// ---------------------------------------------------------------------------
// Internal: recursive checker. Returns the offending CanonicalSerializationError
// or `null` if the value is clean. Path is a JSON-path string rooted at `$`.
// ---------------------------------------------------------------------------

function check(value: unknown, path: string): CanonicalSerializationError | null {
  // Primitives: undefined is acceptable ONLY at the root or as an object value
  // (the object-value case is handled by the object branch, which skips this
  // function for undefined entries). At the root, `canonicalJson(undefined)`
  // returns `undefined` (the JS token, not a string) — but the SPI validators
  // never feed a bare `undefined` here; they feed manifest objects. We treat a
  // bare `undefined` argument as acceptable to keep the helper total; the only
  // place `undefined` is REJECTED is inside an array (handled in array branch).
  if (value === undefined) return null;
  if (value === null) return null;

  const type = typeof value;

  if (type === 'function') {
    return { code: 'CANONICAL_SERIALIZATION_INVALID', path, reason: 'function is not serializable' };
  }
  if (type === 'symbol') {
    return { code: 'CANONICAL_SERIALIZATION_INVALID', path, reason: 'Symbol value is not serializable' };
  }
  if (type === 'number' && !Number.isFinite(value as number)) {
    return {
      code: 'CANONICAL_SERIALIZATION_INVALID',
      path,
      reason: `non-finite number (${String(value)}) is not serializable`,
    };
  }
  // string / boolean / finite number: acceptable.
  if (type !== 'object') return null;

  // Now `value` is a non-null object. Reject Map / Set explicitly first (they
  // are also class instances, but the contract names them and we want a clear
  // reason string).
  if (value instanceof Map) {
    return { code: 'CANONICAL_SERIALIZATION_INVALID', path, reason: 'Map is not serializable' };
  }
  if (value instanceof Set) {
    return { code: 'CANONICAL_SERIALIZATION_INVALID', path, reason: 'Set is not serializable' };
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const element = (value as unknown[])[i];
      // undefined INSIDE an array is rejected: JSON.stringify turns it into null,
      // silently corrupting the value.
      if (element === undefined) {
        return {
          code: 'CANONICAL_SERIALIZATION_INVALID',
          path: `${path}[${i}]`,
          reason: 'undefined inside an array is not serializable (would coerce to null)',
        };
      }
      const childErr = check(element, `${path}[${i}]`);
      if (childErr !== null) return childErr;
    }
    return null;
  }

  // Plain-object detection: a literal `{}` has constructor === Object. A class
  // instance has constructor === <UserClass>. We must also be careful that
  // objects created via Object.create(null) have undefined constructor — those
  // are treated as plain (they are dictionary-style and serialize normally).
  const ctor = (value as { constructor?: unknown }).constructor;
  if (ctor !== undefined && ctor !== Object && ctor !== Array) {
    const name = (ctor as { name?: string }).name ?? '<anonymous>';
    return {
      code: 'CANONICAL_SERIALIZATION_INVALID',
      path,
      reason: `class instance (${name}) is not serializable`,
    };
  }

  // Plain object: recurse into own enumerable string-keyed values. Symbol keys
  // are invisible to canonicalJson (it iterates Object.keys), so a Symbol KEY
  // would be silently dropped rather than corrupt the output; but the contract
  // explicitly requires Symbol keys to be REJECTED, so scan for them.
  const obj = value as Record<PropertyKey, unknown>;
  const keys = Object.keys(obj); // string keys only
  for (const key of keys) {
    const childPath = `${path}.${key}`;
    const childErr = check(obj[key], childPath);
    if (childErr !== null) return childErr;
  }
  // Reject Symbol-keyed properties (they are invisible to canonicalJson and
  // indicate a value that does not round-trip through JSON).
  const symbolKeys = Object.getOwnPropertySymbols(obj);
  if (symbolKeys.length > 0) {
    return {
      code: 'CANONICAL_SERIALIZATION_INVALID',
      path,
      reason: `Symbol key (${String(symbolKeys[0])}) is not serializable`,
    };
  }

  return null;
}
