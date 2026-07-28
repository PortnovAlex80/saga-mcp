// tests/spi/canonical-serialization.test.mjs
//
// W1-A1 negative + positive tests for the canonical-serialization validator.
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md section 3
// (negative-test contract) + section 4 (round-trip contract).
// Task: docs/refactor-management/05-subagent-tasks/W01-A1-canonical-serialization.md.
//
// This test imports ONLY from dist/ (compiled output), matching the repo
// convention for .mjs tests. Run `npm run build` before running this test.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCanonicalSerializable,
  assertCanonicalSerializable,
  canonicalJsonOrThrow,
} from '../../dist/process-modules/domain/spi/canonical-serialization.js';
import {
  canonicalJson,
  sha256Hex,
} from '../../dist/process-modules/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A class used to build a real class instance for the negative tests. Defined
 * at module scope so its constructor name is stable ("Widget").
 */
class Widget {
  constructor(parts) {
    this.parts = parts;
  }
}

/**
 * Asserts that a value is REJECTED by the validator: `isCanonicalSerializable`
 * returns false AND `assertCanonicalSerializable` throws a
 * `CanonicalSerializationError` with a non-empty `path`.
 */
function assertRejected(value, label) {
  assert.equal(
    isCanonicalSerializable(value),
    false,
    `isCanonicalSerializable should be false for ${label}`,
  );
  let threw = null;
  try {
    assertCanonicalSerializable(value);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, `assertCanonicalSerializable should throw for ${label}`);
  assert.equal(
    threw.code,
    'CANONICAL_SERIALIZATION_INVALID',
    `thrown error code for ${label}: ${threw?.code}`,
  );
  assert.ok(
    typeof threw.path === 'string' && threw.path.length > 0 && threw.path.startsWith('$'),
    `thrown error path for ${label} must be a non-empty JSON-path starting with $: ${threw?.path}`,
  );
  assert.ok(
    typeof threw.reason === 'string' && threw.reason.length > 0,
    `thrown error reason for ${label} must be a non-empty string`,
  );
}

// ---------------------------------------------------------------------------
// Positive tests — acceptable values
// ---------------------------------------------------------------------------

test('isCanonicalSerializable: null, booleans, strings, finite numbers are serializable', () => {
  assert.equal(isCanonicalSerializable(null), true);
  assert.equal(isCanonicalSerializable(true), true);
  assert.equal(isCanonicalSerializable(false), true);
  assert.equal(isCanonicalSerializable(''), true);
  assert.equal(isCanonicalSerializable('hello'), true);
  assert.equal(isCanonicalSerializable(0), true);
  assert.equal(isCanonicalSerializable(-1), true);
  assert.equal(isCanonicalSerializable(3.14), true);
  assert.equal(isCanonicalSerializable(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isCanonicalSerializable(Number.MIN_SAFE_INTEGER), true);
});

test('isCanonicalSerializable: empty plain object and empty array are serializable', () => {
  assert.equal(isCanonicalSerializable({}), true);
  assert.equal(isCanonicalSerializable([]), true);
});

test('isCanonicalSerializable: plain object with nested arrays, scalars, null passes', () => {
  const value = {
    a: 'string',
    b: 42,
    c: true,
    d: null,
    e: [1, 'two', false, null, { nested: 'deep' }],
    f: { inner: { deeper: [1, 2, 3] } },
  };
  assert.equal(isCanonicalSerializable(value), true);
  // Does not throw.
  assert.doesNotThrow(() => assertCanonicalSerializable(value));
});

test('isCanonicalSerializable: undefined as an OBJECT value is acceptable (per SPI spec §1 row 1)', () => {
  // The SPI spec (WAVE1-PURE-SPI-SPEC §1 row 1 + W01-A1 "What to build")
  // explicitly carves out undefined-as-OBJECT-value as ACCEPTABLE: it must not
  // be rejected by the validator. The validator's behavioral contract here is
  // unambiguous (accept it). The exact canonical-JSON string produced by the
  // frozen primitive for such a value is the frozen primitive's concern, not
  // this lane's — see the escalated finding in the W1-A1 return report.
  const value = { present: 'yes', absent: undefined, nested: { alsoAbsent: undefined } };
  assert.equal(isCanonicalSerializable(value), true);
  assert.doesNotThrow(() => assertCanonicalSerializable(value));
  // The task file's positive-test requirement: canonicalJsonOrThrow returns the
  // SAME string as canonicalJson for valid input (delegation, not reimplementation).
  assert.equal(canonicalJsonOrThrow(value), canonicalJson(value));
});

test('assertCanonicalSerializable: does not throw for a valid manifest-shaped value', () => {
  const manifest = {
    manifestFormatVersion: '1.0.0',
    identity: { name: 'demo', version: '0.1.0' },
    stageBindings: [{ stageId: 'discovery', moduleId: 'demo' }],
    terminalStatuses: ['completed', 'cancelled'],
  };
  assert.doesNotThrow(() => assertCanonicalSerializable(manifest));
});

// ---------------------------------------------------------------------------
// Negative tests — every forbidden kind must be REJECTED.
// Spec WAVE1-PURE-SPI-SPEC section 3 + W01-A1 "Negative tests".
// ---------------------------------------------------------------------------

test('REJECT: function in a field', () => {
  assertRejected({ handler: () => 1 }, 'function value in field');
  assertRejected({ nested: { fn: function named() { return 2; } } }, 'nested function value');
  assertRejected([1, () => 3], 'function inside array');
  // Bare function at root is also rejected.
  assertRejected(function root() { return 1; }, 'bare function at root');
});

test('REJECT: Map', () => {
  assertRejected(new Map(), 'empty Map');
  assertRejected({ entries: new Map([['k', 'v']]) }, 'Map in field');
  assertRejected([1, new Map()], 'Map inside array');
});

test('REJECT: Set', () => {
  assertRejected(new Set(), 'empty Set');
  assertRejected({ items: new Set([1, 2, 3]) }, 'Set in field');
  assertRejected([new Set()], 'Set inside array');
});

test('REJECT: undefined inside an array', () => {
  assertRejected([1, undefined, 3], 'undefined inside array (middle)');
  assertRejected([undefined], 'undefined as only array element');
  assertRejected({ list: [1, undefined] }, 'undefined inside nested array');
  // Path must point at the offending index.
  let threw = null;
  try {
    assertCanonicalSerializable(['ok', undefined]);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw.path, '$[1]');
});

test('REJECT: class instance (not plain object / plain array)', () => {
  assertRejected(new Widget(['a', 'b']), 'class instance in field');
  assertRejected({ nested: { widget: new Widget([]) } }, 'nested class instance');
  assertRejected([new Widget([])], 'class instance inside array');
  // Path must point at the instance.
  let threw = null;
  try {
    assertCanonicalSerializable({ w: new Widget([]) });
  } catch (err) {
    threw = err;
  }
  assert.equal(threw.path, '$.w');
  assert.ok(threw.reason.includes('Widget'), `reason should name the class: ${threw.reason}`);
});

test('REJECT: NaN', () => {
  assertRejected(NaN, 'bare NaN');
  assertRejected({ score: NaN }, 'NaN in field');
  assertRejected([1, NaN], 'NaN inside array');
});

test('REJECT: Infinity', () => {
  assertRejected(Infinity, 'bare Infinity');
  assertRejected({ ratio: Infinity }, 'Infinity in field');
  assertRejected([Infinity], 'Infinity inside array');
});

test('REJECT: -Infinity', () => {
  assertRejected(-Infinity, 'bare -Infinity');
  assertRejected({ ratio: -Infinity }, '-Infinity in field');
  assertRejected([-Infinity], '-Infinity inside array');
});

test('REJECT: Symbol value', () => {
  assertRejected(Symbol('s'), 'bare Symbol');
  assertRejected({ tag: Symbol('tag') }, 'Symbol value in field');
  assertRejected([Symbol('x')], 'Symbol value inside array');
});

test('REJECT: Symbol key', () => {
  // A Symbol-keyed property is invisible to canonicalJson (Object.keys skips
  // it), so the contract requires the validator to reject it explicitly.
  const sym = Symbol('hidden');
  const obj = { ok: 1 };
  obj[sym] = 'secret';
  assertRejected(obj, 'object with a Symbol key');
});

// ---------------------------------------------------------------------------
// canonicalJsonOrThrow contract
// ---------------------------------------------------------------------------

test('canonicalJsonOrThrow: equals canonicalJson for valid input', () => {
  const value = { b: 2, a: 1, c: [3, 2, 1], d: { z: 'z', y: 'y' } };
  assert.equal(canonicalJsonOrThrow(value), canonicalJson(value));
  // Keys are sorted lexically (frozen primitive behavior, exercised here so the
  // validator is proven to delegate, not reimplement).
  assert.equal(canonicalJsonOrThrow(value), '{"a":1,"b":2,"c":[3,2,1],"d":{"y":"y","z":"z"}}');
});

test('canonicalJsonOrThrow: throws CanonicalSerializationError for invalid input', () => {
  let threw = null;
  try {
    canonicalJsonOrThrow({ bad: () => 1 });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  assert.equal(threw.code, 'CANONICAL_SERIALIZATION_INVALID');
  assert.equal(threw.path, '$.bad');
});

test('sha256Hex: stable across runs for the same input (round-trip determinism)', () => {
  const value = { a: 1, b: [2, 3], c: 'four' };
  const h1 = sha256Hex(value);
  const h2 = sha256Hex(value);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64, 'sha256Hex must be 64 lowercase-hex chars');
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Error shape contract — other lanes import CanonicalSerializationError.
// ---------------------------------------------------------------------------

test('CanonicalSerializationError shape: { code, path, reason } with literal code', () => {
  let threw = null;
  try {
    assertCanonicalSerializable({ x: new Map() });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'must throw');
  // Exact shape contract other lanes depend on.
  assert.equal(threw.code, 'CANONICAL_SERIALIZATION_INVALID');
  assert.equal(typeof threw.path, 'string');
  assert.ok(threw.path.length > 0);
  assert.equal(typeof threw.reason, 'string');
  assert.ok(threw.reason.length > 0);
  // No extra enumerable fields beyond the contract.
  assert.deepEqual(Object.keys(threw).sort(), ['code', 'path', 'reason']);
});
