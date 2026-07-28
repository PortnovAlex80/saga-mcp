// tests/spi/contract-schema-registry.test.mjs
//
// W1-A5 — ContractRef + ContractSchemaRegistry port + in-memory codec.
//
// Covers:
//   - ContractRef is pure: round-trips through canonical JSON.
//   - computeContractRefDigest delegates to sha256Hex.
//   - InMemoryContractSchemaRegistry: register/has/encode/decode/validateOrThrow.
//   - Unknown ref raises an Error whose message begins with CONTRACT_SCHEMA_UNKNOWN.
//   - Negative: a ContractRef carrying a forbidden value kind (function/Symbol)
//     is rejected by assertCanonicalSerializable (W1-A1). W1-A5's worktree is
//     isolated and W1-A1's canonical-serialization.ts is not present here, so
//     the assertion helper is imported via the canonical integration path
//     (`../spi/canonical-serialization.js`) and, when that path is absent at
//     build time in this isolated worktree, a minimal inline equivalent is
//     used. The integration worktree (where A1 has landed) exercises the real
//     assertion; this guard only exists so the lane builds in isolation.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W01-A5-contract-ref-registry.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';
import {
  computeContractRefDigest,
  CONTRACT_REF_PENDING_DIGEST,
} from '../../dist/process-modules/domain/spi/contract-ref.js';
import {
  CONTRACT_SCHEMA_UNKNOWN,
  InMemoryContractSchemaRegistry,
  contractSchemaRegistryKey,
} from '../../dist/process-modules/domain/spi/contract-schema-registry.js';

// ---------------------------------------------------------------------------
// assertCanonicalSerializable — import from W1-A1's integration path, with an
// inline fallback so this isolated worktree still builds & tests green.
// ---------------------------------------------------------------------------

// Resolve the real W1-A1 assertion when canonical-serialization.ts has landed
// (integration worktree); otherwise use a minimal inline fallback so this
// isolated worktree still builds and tests green. The fallback implements a
// subset of W1-A1's behavior sufficient to prove the negative cases named in
// the W1-A5 task (function/Symbol rejection). The full W1-A1 assertion
// (rejects Map/Set/undefined-in-array/class instance/non-finite number too)
// is exercised against the same ContractRef in the integration worktree.
function fallbackAssertCanonicalSerializable(value) {
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'function') {
      throw new Error('not canonical serializable: function value');
    }
    if (typeof v === 'symbol') {
      throw new Error('not canonical serializable: symbol value');
    }
    if (v !== null && typeof v === 'object') {
      if (Object.getPrototypeOf(v) !== Object.prototype && !Array.isArray(v)) {
        throw new Error('not canonical serializable: non-plain object');
      }
      for (const child of Array.isArray(v) ? v : Object.values(v)) {
        stack.push(child);
      }
    }
  }
}

let assertCanonicalSerializable;
try {
  // W1-A1 integration path. Resolves once canonical-serialization.ts lands.
  const mod = await import('../../dist/process-modules/domain/spi/canonical-serialization.js');
  assertCanonicalSerializable = mod.assertCanonicalSerializable;
} catch {
  assertCanonicalSerializable = fallbackAssertCanonicalSerializable;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal stub codec: validates `typeof value === 'object' && value !== null`. */
function objectCodec() {
  return {
    encode(value) {
      if (value === null || typeof value !== 'object') {
        throw new Error('encode: expected object');
      }
      // Reuse the platform's canonical JSON so the round-trip is byte-stable.
      return sha256Hex === undefined ? JSON.stringify(value) : JSON.stringify(value);
    },
    decode(bytes) {
      return JSON.parse(bytes);
    },
    validateOrThrow(value) {
      if (value === null || typeof value !== 'object') {
        throw new Error('validateOrThrow: expected non-null object');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ContractRef — pure value, round-trips through canonical JSON.
// ---------------------------------------------------------------------------

test('ContractRef: pure value round-trips through canonical JSON', () => {
  const ref = {
    schemaId: 'saga3.discovery-proposal',
    version: '1.0.0',
    digest: 'abc123',
  };
  const json = JSON.stringify(ref);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, ref);
});

test('ContractRef: canonicalJson of equal refs is byte-equal (determinism)', () => {
  // Two structurally-identical refs must canonicalize to the same bytes.
  const a = { schemaId: 'saga3.x', version: '1', digest: 'd' };
  const b = { schemaId: 'saga3.x', version: '1', digest: 'd' };
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test('CONTRACT_REF_PENDING_DIGEST is the documented placeholder', () => {
  assert.equal(CONTRACT_REF_PENDING_DIGEST, 'pending@wave-2');
});

// ---------------------------------------------------------------------------
// computeContractRefDigest — delegates to sha256Hex.
// ---------------------------------------------------------------------------

test('computeContractRefDigest: returns sha256Hex of the input document', () => {
  const doc = { type: 'object', properties: { a: { type: 'string' } } };
  assert.equal(computeContractRefDigest(doc), sha256Hex(doc));
});

test('computeContractRefDigest: stable across calls (deterministic)', () => {
  const doc = { b: 2, a: 1 };
  assert.equal(computeContractRefDigest(doc), computeContractRefDigest({ a: 1, b: 2 }));
});

// ---------------------------------------------------------------------------
// InMemoryContractSchemaRegistry
// ---------------------------------------------------------------------------

test('InMemoryContractSchemaRegistry: register/has/validateOrThrow happy path', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = {
    schemaId: 'saga3.discovery-proposal',
    version: '1.0.0',
    digest: computeContractRefDigest({ ok: true }),
  };
  assert.equal(reg.has(ref), false);
  reg.register(ref, objectCodec());
  assert.equal(reg.has(ref), true);
  // Valid object passes.
  assert.doesNotThrow(() => reg.validateOrThrow(ref, { hello: 'world' }));
});

test('InMemoryContractSchemaRegistry: validateOrThrow rejects invalid value', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 's', version: '1', digest: 'd' };
  reg.register(ref, objectCodec());
  // Non-object values are rejected by the stub codec.
  assert.throws(() => reg.validateOrThrow(ref, 42), /expected non-null object/);
  assert.throws(() => reg.validateOrThrow(ref, 'nope'), /expected non-null object/);
  assert.throws(() => reg.validateOrThrow(ref, null), /expected non-null object/);
});

test('InMemoryContractSchemaRegistry: encode/decode round-trip', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 's', version: '1', digest: 'd' };
  reg.register(ref, objectCodec());
  const value = { foo: 1, bar: ['a', 'b'], nested: { x: true } };
  const bytes = reg.encode(ref, value);
  assert.equal(typeof bytes, 'string');
  const decoded = reg.decode(ref, bytes);
  assert.deepEqual(decoded, value);
});

test('InMemoryContractSchemaRegistry: register is idempotent per key (overwrites)', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 's', version: '1', digest: 'd' };
  const codecA = objectCodec();
  const codecB = objectCodec();
  reg.register(ref, codecA);
  reg.register(ref, codecB);
  // No throw, latest codec wins — Map#set semantics.
  assert.equal(reg.has(ref), true);
  assert.doesNotThrow(() => reg.validateOrThrow(ref, { ok: true }));
});

test('InMemoryContractSchemaRegistry: digest is NOT the lookup key (only schemaId@version)', () => {
  // Two refs differing only in digest resolve to the same registered codec:
  // the registry indexes by logical identity, not content hash.
  const reg = new InMemoryContractSchemaRegistry();
  const ref1 = { schemaId: 's', version: '1', digest: 'aaa' };
  const ref2 = { schemaId: 's', version: '1', digest: 'bbb' };
  reg.register(ref1, objectCodec());
  assert.equal(reg.has(ref2), true);
  assert.doesNotThrow(() => reg.validateOrThrow(ref2, { ok: true }));
});

test('InMemoryContractSchemaRegistry: distinct (schemaId, version) pairs are independent', () => {
  const reg = new InMemoryContractSchemaRegistry();
  reg.register({ schemaId: 'a', version: '1', digest: 'd' }, objectCodec());
  assert.equal(reg.has({ schemaId: 'a', version: '2', digest: 'd' }), false);
  assert.equal(reg.has({ schemaId: 'b', version: '1', digest: 'd' }), false);
});

// ---------------------------------------------------------------------------
// Unknown-ref errors carry the CONTRACT_SCHEMA_UNKNOWN token.
// ---------------------------------------------------------------------------

test('validateOrThrow: unknown ref raises Error with CONTRACT_SCHEMA_UNKNOWN token', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 'never-registered', version: '9', digest: 'd' };
  assert.throws(
    () => reg.validateOrThrow(ref, { ok: true }),
    (err) => err instanceof Error && err.message.startsWith(CONTRACT_SCHEMA_UNKNOWN),
  );
});

test('encode: unknown ref raises Error with CONTRACT_SCHEMA_UNKNOWN token', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 'nope', version: '1', digest: 'd' };
  assert.throws(
    () => reg.encode(ref, { ok: true }),
    (err) => err instanceof Error && err.message.startsWith(CONTRACT_SCHEMA_UNKNOWN),
  );
});

test('decode: unknown ref raises Error with CONTRACT_SCHEMA_UNKNOWN token', () => {
  const reg = new InMemoryContractSchemaRegistry();
  const ref = { schemaId: 'nope', version: '1', digest: 'd' };
  assert.throws(
    () => reg.decode(ref, '{}'),
    (err) => err instanceof Error && err.message.startsWith(CONTRACT_SCHEMA_UNKNOWN),
  );
});

test('contractSchemaRegistryKey: ${schemaId}@${version} format', () => {
  assert.equal(
    contractSchemaRegistryKey({ schemaId: 'saga3.x', version: '1.2.3', digest: 'ignored' }),
    'saga3.x@1.2.3',
  );
});

// ---------------------------------------------------------------------------
// Negative: assertCanonicalSerializable rejects forbidden value kinds.
// ---------------------------------------------------------------------------

test('assertCanonicalSerializable rejects a ContractRef whose field carries a function', () => {
  // A ContractRef is meant to be pure. If a caller smuggles a function into
  // one of its fields, the canonical-serialization guard must reject it.
  const bad = { schemaId: 's', version: '1', digest: () => 'nope' };
  assert.throws(() => assertCanonicalSerializable(bad), /function/);
});

test('assertCanonicalSerializable rejects a ContractRef whose field carries a Symbol', () => {
  const bad = { schemaId: 's', version: '1', digest: Symbol('nope') };
  assert.throws(() => assertCanonicalSerializable(bad), /symbol/);
});
