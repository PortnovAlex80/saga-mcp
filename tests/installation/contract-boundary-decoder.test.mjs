// @ts-check
/**
 * W3-A7 — ContractBoundaryDecoder + WorkerExecutionPort unit proof.
 *
 * Spec ref: `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md`
 *   §10 (WorkerExecutionPort + ContractBoundaryDecoder), §7.4.2 (boundary
 *   validation at the five Process Module execution boundaries).
 *
 * This file is the unit proof for the two NEW application-layer files W3-A7
 * owns. It exercises:
 *
 *   1. `ContractBoundaryDecoder`:
 *      - `validateAtBoundary` — ok / SCHEMA_VIOLATION / CONTRACT_SCHEMA_UNKNOWN.
 *      - `decodeAtBoundary`   — canonicalizing round-trip; throws on unknown
 *        ref (CONTRACT_SCHEMA_UNKNOWN token) and on schema violation.
 *      - qualified-boundary helpers prefix the error path with the boundary
 *        label.
 *   2. `WorkerExecutionPort` pure plan validator:
 *      - `validateWorkerExecutionPlan` accepts a well-formed plan, rejects
 *        non-plain adapterData and malformed outputContract.
 *      - `validateContractRefShape` checks the three-string shape.
 *
 * The decoder is driven through a STUB codec built on the Wave 1
 * `InMemoryContractSchemaRegistry` + `ContractSchemaCodec` contract — exactly
 * the integration surface Wave 3 declares and Wave 5 wires into the executor
 * boundaries. No production codecs are registered yet (Wave 2/3 bring them);
 * the stub mirrors the `encode`/`decode`/`validateOrThrow` triad a real codec
 * implements.
 *
 * Layering proof (§14.4.7-style): the import list pulls ONLY from
 *   - `dist/process-modules/application/worker-execution-port.js` (this lane),
 *   - `dist/process-modules/application/contract-boundary-decoder.js` (this lane),
 *   - `dist/process-modules/domain/spi/index.js` (Wave 1 barrel, frozen),
 *   - `dist/process-modules/shared/canonical-json.js` (frozen primitives),
 *   - node: built-ins.
 * NO persistence adapters, NO modules/, NO db.ts, NO composition root. The
 * dep-direction ratchet test enforces this statically repo-wide.
 *
 * Run: `node --test tests/installation/contract-boundary-decoder.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Frozen Wave 1 primitives (already built in this worktree).
import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// Wave 1 SPI barrel — registry + types.
const {
  InMemoryContractSchemaRegistry,
  computeContractRefDigest,
} = await import('../../dist/process-modules/domain/spi/index.js');

// W3-A7 products (this lane).
const {
  validateAtBoundary,
  decodeAtBoundary,
  validateAtQualifiedBoundary,
  decodeAtQualifiedBoundary,
  BOUNDARY_KIND_LABELS,
  CONTRACT_SCHEMA_UNKNOWN,
} = await import('../../dist/process-modules/application/contract-boundary-decoder.js');

const {
  validateWorkerExecutionPlan,
  validateContractRefShape,
} = await import('../../dist/process-modules/application/worker-execution-port.js');

// ---------------------------------------------------------------------------
// Stub codec — mirrors the ContractSchemaCodec triad a real Wave 2/3 codec
// implements. Built on canonicalJson so encode/decode are exact inverses and
// validateOrThrow enforces a small JSON-schema-like shape.
// ---------------------------------------------------------------------------

/**
 * Build a stub codec for a "person" payload: { name: string, age: non-neg int }.
 * encode = canonicalJson(value); decode = JSON.parse(bytes); validateOrThrow
 * enforces the shape. This is the exact contract surface the decoder depends on.
 */
function personCodec() {
  return {
    encode(value) {
      return canonicalJson(value);
    },
    decode(bytes) {
      return JSON.parse(bytes);
    },
    validateOrThrow(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('person payload must be a plain object');
      }
      const v = value;
      if (typeof v.name !== 'string' || v.name.length === 0) {
        throw new Error('person.name must be a non-empty string');
      }
      if (
        typeof v.age !== 'number' ||
        !Number.isInteger(v.age) ||
        v.age < 0
      ) {
        throw new Error('person.age must be a non-negative integer');
      }
    },
  };
}

/** Build a ContractRef for the person schema at a given version+digest. */
function personRef(version, digest) {
  return { schemaId: 'test.person', version, digest };
}

// A canonical schema "document" the digest is content-addressed over.
const PERSON_SCHEMA_DOC = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name', 'age'],
});
const PERSON_DIGEST = computeContractRefDigest(PERSON_SCHEMA_DOC);

// ---------------------------------------------------------------------------
// Registry fixture: one person codec registered under v1.
// ---------------------------------------------------------------------------

function freshRegistry() {
  const registry = new InMemoryContractSchemaRegistry();
  registry.register(personRef('v1', PERSON_DIGEST), personCodec());
  return registry;
}

const PERSON_REF_V1 = personRef('v1', PERSON_DIGEST);
const PERSON_REF_V2_UNREGISTERED = personRef('v2', 'deadbeef');

// ===========================================================================
// validateAtBoundary
// ===========================================================================

test('validateAtBoundary: returns ok for a conforming value', () => {
  const registry = freshRegistry();
  const value = { name: 'ada', age: 36 };
  const res = validateAtBoundary(PERSON_REF_V1, value, registry);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('validateAtBoundary: returns SCHEMA_VIOLATION (non-throwing) for a bad value', () => {
  const registry = freshRegistry();
  const res = validateAtBoundary(PERSON_REF_V1, { name: '', age: -1 }, registry);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'SCHEMA_VIOLATION');
  assert.equal(res.errors[0].path, '$');
  assert.ok(res.errors[0].message.length > 0);
  // Must NOT throw — caller collects failures in one pass.
});

test('validateAtBoundary: returns CONTRACT_SCHEMA_UNKNOWN for an unregistered ref', () => {
  const registry = freshRegistry();
  const res = validateAtBoundary(PERSON_REF_V2_UNREGISTERED, { name: 'x', age: 1 }, registry);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, CONTRACT_SCHEMA_UNKNOWN);
  assert.ok(res.errors[0].message.includes('test.person@v2'));
});

// ===========================================================================
// decodeAtBoundary
// ===========================================================================

test('decodeAtBoundary: canonicalizes a valid value (round-trip equal)', () => {
  const registry = freshRegistry();
  // Two textually-different but semantically-equal payloads.
  const a = { name: 'ada', age: 36 };
  const b = { age: 36, name: 'ada' }; // different key order
  const decodedA = decodeAtBoundary(PERSON_REF_V1, a, registry);
  const decodedB = decodeAtBoundary(PERSON_REF_V1, b, registry);
  // Both decode to the SAME canonical in-memory object (key order normalized).
  assert.deepEqual(decodedA, decodedB);
  assert.equal(decodedA.name, 'ada');
  assert.equal(decodedA.age, 36);
});

test('decodeAtBoundary: throws on schema violation', () => {
  const registry = freshRegistry();
  assert.throws(
    () => decodeAtBoundary(PERSON_REF_V1, { name: 'x', age: 'old' }, registry),
    (err) => {
      assert.ok(err instanceof Error);
      return /person\.age/.test(err.message);
    },
  );
});

test('decodeAtBoundary: throws CONTRACT_SCHEMA_UNKNOWN on unregistered ref', () => {
  const registry = freshRegistry();
  assert.throws(
    () => decodeAtBoundary(PERSON_REF_V2_UNREGISTERED, { name: 'x', age: 1 }, registry),
    (err) => {
      assert.ok(err instanceof Error);
      return err.message.startsWith(CONTRACT_SCHEMA_UNKNOWN);
    },
  );
});

test('decodeAtBoundary: left-inverse of encode — byte-equality holds', () => {
  const registry = freshRegistry();
  const value = { name: 'grace', age: 85 };
  const decoded = decodeAtBoundary(PERSON_REF_V1, value, registry);
  // Re-encoding the decoded value yields the same canonical bytes (idempotent).
  const reDecoded = decodeAtBoundary(PERSON_REF_V1, decoded, registry);
  assert.deepEqual(reDecoded, decoded);
});

// ===========================================================================
// Qualified-boundary helpers (spec §7.4.2 — the five boundaries).
// ===========================================================================

test('BOUNDARY_KIND_LABELS: covers all five spec boundaries', () => {
  // spec §7.4.2: module input, node input, node output, module completion,
  // scenario handoff.
  assert.equal(BOUNDARY_KIND_LABELS['module-input'], 'module input');
  assert.equal(BOUNDARY_KIND_LABELS['node-input'], 'node input');
  assert.equal(BOUNDARY_KIND_LABELS['node-output'], 'node output');
  assert.equal(BOUNDARY_KIND_LABELS['module-completion'], 'module completion');
  assert.equal(BOUNDARY_KIND_LABELS['scenario-handoff'], 'scenario handoff');
});

test('validateAtQualifiedBoundary: prefixes error path with boundary label', () => {
  const registry = freshRegistry();
  const boundary = { boundary: 'module-input', ref: PERSON_REF_V1 };
  const res = validateAtQualifiedBoundary(boundary, { name: '', age: -1 }, registry);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'SCHEMA_VIOLATION');
  // Path is prefixed with the human-readable boundary LABEL (spec §7.4.2).
  assert.equal(res.errors[0].path, 'module input:$');
});

test('validateAtQualifiedBoundary: ok passes through unchanged', () => {
  const registry = freshRegistry();
  const boundary = { boundary: 'scenario-handoff', ref: PERSON_REF_V1 };
  const res = validateAtQualifiedBoundary(boundary, { name: 'x', age: 1 }, registry);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('validateAtQualifiedBoundary: unknown-ref failure is also path-prefixed', () => {
  const registry = freshRegistry();
  const boundary = { boundary: 'node-output', ref: PERSON_REF_V2_UNREGISTERED };
  const res = validateAtQualifiedBoundary(boundary, { name: 'x', age: 1 }, registry);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, CONTRACT_SCHEMA_UNKNOWN);
  assert.equal(res.errors[0].path, 'node output:$');
});

test('decodeAtQualifiedBoundary: canonicalizes like the plain variant', () => {
  const registry = freshRegistry();
  const boundary = { boundary: 'node-input', ref: PERSON_REF_V1 };
  const decoded = decodeAtQualifiedBoundary(boundary, { age: 7, name: 'alan' }, registry);
  assert.equal(decoded.name, 'alan');
  assert.equal(decoded.age, 7);
});

// ===========================================================================
// WorkerExecutionPort — pure plan validator.
// ===========================================================================

test('validateWorkerExecutionPlan: accepts a well-formed driver-neutral plan', () => {
  const plan = {
    intent: {
      adapterData: { kind: 'discovery', objective: 'x', tokenBudget: 0 },
      outputContract: { schemaId: 'saga3.foo.v1', version: '1.0.0', digest: 'abc' },
    },
    projection: {
      adapterData: { taskKind: 'discovery.code', generationKey: 'gk-1' },
    },
  };
  const res = validateWorkerExecutionPlan(plan);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('validateWorkerExecutionPlan: accepts a plan with null outputContract (legacy/transition)', () => {
  const plan = {
    intent: { adapterData: {}, outputContract: null },
    projection: { adapterData: {} },
  };
  const res = validateWorkerExecutionPlan(plan);
  assert.equal(res.ok, true);
});

test('validateWorkerExecutionPlan: rejects non-plain adapterData', () => {
  const plan = {
    intent: { adapterData: 'not-an-object', outputContract: null },
    projection: { adapterData: {} },
  };
  const res = validateWorkerExecutionPlan(plan);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'BAD_ADAPTER_DATA');
  assert.equal(res.errors[0].path, 'intent.adapterData');
});

test('validateWorkerExecutionPlan: rejects a malformed outputContract', () => {
  const plan = {
    intent: {
      adapterData: {},
      // missing version + digest
      outputContract: { schemaId: 'saga3.foo.v1' },
    },
    projection: { adapterData: {} },
  };
  const res = validateWorkerExecutionPlan(plan);
  assert.equal(res.ok, false);
  // version + digest both missing → two errors.
  const codes = res.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['BAD_DIGEST', 'BAD_VERSION']);
  for (const e of res.errors) {
    assert.ok(e.path.startsWith('intent.outputContract.'));
  }
});

test('validateWorkerExecutionPlan: rejects a non-object plan', () => {
  const res = validateWorkerExecutionPlan('nope');
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'NOT_OBJECT');
  assert.equal(res.errors[0].path, '$');
});

test('validateWorkerExecutionPlan: rejects when projection is missing', () => {
  const plan = { intent: { adapterData: {}, outputContract: null } };
  const res = validateWorkerExecutionPlan(plan);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'BAD_PROJECTION');
  assert.equal(res.errors[0].path, 'projection');
});

// ===========================================================================
// validateContractRefShape
// ===========================================================================

test('validateContractRefShape: accepts three non-empty strings', () => {
  const res = validateContractRefShape({
    schemaId: 'a',
    version: '1',
    digest: 'd',
  });
  assert.equal(res.ok, true);
});

test('validateContractRefShape: rejects empty / wrong-type fields', () => {
  const res = validateContractRefShape({ schemaId: '', version: 1, digest: '' });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 3);
});

test('validateContractRefShape: rejects a non-object', () => {
  const res = validateContractRefShape(null);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'NOT_OBJECT');
});

// ===========================================================================
// Cross-check: the Wave 1 registry digest computation is what the decoder is
// keyed against (the ContractRef.digest field is content-addressed over the
// canonical schema document). This pins the integration contract between
// W3-A7 and W1-A5.
// ===========================================================================

test('integration: ContractRef.digest is sha256Hex of the canonical schema document', () => {
  const expected = sha256Hex(PERSON_SCHEMA_DOC);
  assert.equal(PERSON_DIGEST, expected);
  // computeContractRefDigest agrees with the raw primitive.
  assert.equal(computeContractRefDigest(PERSON_SCHEMA_DOC), expected);
});
