// tests/spi/production-envelope.test.mjs
//
// W1-A6 — Production envelope: ProductRef, LineageRef, NodeProductionEnvelope,
// ProcessModuleOutputEnvelope.
//
// Covers (spec §3 negative-test contract + §4 round-trip):
//   - Each type round-trips through canonical JSON (parse(canonicalJson(x)) deep-equals x).
//   - Positive: a valid instance passes validation.
//   - Negative: each type REJECTS function / Map / Set / undefined-in-array /
//     class-instance / Symbol / non-finite number in any field, plus invalid
//     enum values.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 9.
// Task: docs/refactor-management/05-subagent-tasks/W01-A6-production-completion-tool-assistance.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex, canonicalJson } from '../../dist/shared/canonical-json.js';
import {
  validateProductRef,
  validateLineageRef,
  validateNodeProductionEnvelope,
  validateProcessModuleOutputEnvelope,
  productionEnvelopeDigest,
} from '../../dist/process-modules/domain/spi/production-envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a validator returns ok:true for a valid value. */
async function assertValid(validator, value, label) {
  const res = await validator(value);
  assert.ok(res.ok, `${label}: expected ok, got errors: ${JSON.stringify(res.errors)}`);
  assert.equal(res.errors.length, 0, `${label}: expected zero errors`);
}

/** Assert a validator returns ok:false and reports at least one error. */
async function assertInvalid(validator, value, label) {
  const res = await validator(value);
  assert.ok(!res.ok, `${label}: expected NOT ok, but validator passed`);
  assert.ok(res.errors.length > 0, `${label}: expected at least one error`);
}

/** Round-trip through canonical JSON: parse(canonicalJson(x)) deep-equals x. */
function assertRoundTrip(value, label) {
  const json = canonicalJson(value);
  const reparsed = JSON.parse(json);
  assert.deepEqual(
    reparsed,
    value,
    `${label}: round-trip mismatch (canonicalJson produced ${json})`,
  );
  // Stability: hashing twice yields the same digest.
  assert.equal(sha256Hex(value), sha256Hex(reparsed), `${label}: hash stability`);
}

/** A canonical class instance (non-plain object) for negative tests. */
class BogusInstance {
  constructor() {
    this.field = 'value';
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validProductRef() {
  return { schemaId: 'factory.discovery-proposal.v1', ref: 'proposal:141', digest: 'abc123' };
}

function validLineageRef() {
  return { kind: 'node-run', ref: 'noderun:42' };
}

function validNodeProductionEnvelope() {
  return {
    schema: 'factory.discovery-proposal.v1',
    artifactRef: 'proposal:141',
    contentHash: 'deadbeef',
    bindings: { proposalId: 141, proposalHash: 'deadbeef' },
    schemaId: 'factory.node-production-envelope.v1',
    productRef: validProductRef(),
    lineage: [validLineageRef()],
  };
}

function validOutputEnvelope() {
  // Wave 8 BLOCKER 2: the envelope is a LEAF — no `completion` back-reference.
  // The model is a serializable tree (ModuleCompletion.outputEnvelope → this
  // envelope, one-directional).
  return {
    outcome: 'accepted',
    productions: [validNodeProductionEnvelope()],
    certificateRef: validProductRef(),
  };
}

// ---------------------------------------------------------------------------
// Forbidden value kinds to inject into each field.
// ---------------------------------------------------------------------------

const FORBIDDEN_VALUES = [
  { name: 'function', value: () => 42 },
  { name: 'Map', value: new Map([['k', 1]]) },
  { name: 'Set', value: new Set([1, 2]) },
  { name: 'undefined-in-array', value: [undefined] },
  { name: 'class-instance', value: new BogusInstance() },
  { name: 'Symbol', value: Symbol('s') },
  { name: 'NaN', value: NaN },
  { name: 'Infinity', value: Infinity },
];

// ---------------------------------------------------------------------------
// ProductRef
// ---------------------------------------------------------------------------

test('ProductRef: valid instance passes + round-trips', async () => {
  const v = validProductRef();
  await assertValid(validateProductRef, v, 'ProductRef valid');
  assertRoundTrip(v, 'ProductRef round-trip');
  const digest = productionEnvelopeDigest(v);
  assert.match(digest, /^[0-9a-f]{64}$/, 'digest is 64-char lowercase hex');
});

test('ProductRef: rejects each forbidden value kind in every field', async () => {
  for (const field of ['schemaId', 'ref', 'digest']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validProductRef();
      v[field] = value;
      await assertInvalid(validateProductRef, v, `ProductRef.${field} = ${name}`);
    }
  }
});

test('ProductRef: rejects missing/empty fields', async () => {
  await assertInvalid(validateProductRef, { ref: 'r', digest: 'd' }, 'ProductRef missing schemaId');
  await assertInvalid(validateProductRef, { schemaId: '', ref: 'r', digest: 'd' }, 'ProductRef empty schemaId');
  await assertInvalid(validateProductRef, { schemaId: 's', digest: 'd' }, 'ProductRef missing ref');
  await assertInvalid(validateProductRef, { schemaId: 's', ref: 'r' }, 'ProductRef missing digest');
  await assertInvalid(validateProductRef, null, 'ProductRef null');
  await assertInvalid(validateProductRef, [], 'ProductRef array');
});

// ---------------------------------------------------------------------------
// LineageRef
// ---------------------------------------------------------------------------

test('LineageRef: valid instance passes + round-trips', async () => {
  for (const kind of ['node-run', 'production', 'receipt']) {
    const v = { kind, ref: 'r:1' };
    await assertValid(validateLineageRef, v, `LineageRef kind=${kind}`);
    assertRoundTrip(v, `LineageRef kind=${kind} round-trip`);
  }
});

test('LineageRef: rejects each forbidden value kind in every field', async () => {
  for (const field of ['kind', 'ref']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validLineageRef();
      v[field] = value;
      await assertInvalid(validateLineageRef, v, `LineageRef.${field} = ${name}`);
    }
  }
});

test('LineageRef: rejects invalid enum value for kind', async () => {
  const v = validLineageRef();
  v.kind = 'not-a-real-kind';
  await assertInvalid(validateLineageRef, v, 'LineageRef invalid kind enum');
});

test('LineageRef: rejects missing/empty fields', async () => {
  await assertInvalid(validateLineageRef, { ref: 'r' }, 'LineageRef missing kind');
  await assertInvalid(validateLineageRef, { kind: 'node-run' }, 'LineageRef missing ref');
});

// ---------------------------------------------------------------------------
// NodeProductionEnvelope
// ---------------------------------------------------------------------------

test('NodeProductionEnvelope: valid instance passes + round-trips', async () => {
  const v = validNodeProductionEnvelope();
  await assertValid(validateNodeProductionEnvelope, v, 'NodeProductionEnvelope valid');
  assertRoundTrip(v, 'NodeProductionEnvelope round-trip');
});

test('NodeProductionEnvelope: rejects each forbidden value kind in scalar fields', async () => {
  for (const field of ['schema', 'artifactRef', 'contentHash', 'schemaId']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validNodeProductionEnvelope();
      v[field] = value;
      await assertInvalid(validateNodeProductionEnvelope, v, `NodeProductionEnvelope.${field} = ${name}`);
    }
  }
});

test('NodeProductionEnvelope: rejects each forbidden value kind in bindings', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validNodeProductionEnvelope();
    v.bindings = { injected: value };
    await assertInvalid(validateNodeProductionEnvelope, v, `NodeProductionEnvelope.bindings injected ${name}`);
  }
});

test('NodeProductionEnvelope: rejects each forbidden value kind in productRef', async () => {
  const v = validNodeProductionEnvelope();
  v.productRef = () => 1;
  await assertInvalid(validateNodeProductionEnvelope, v, 'NodeProductionEnvelope.productRef function');
});

test('NodeProductionEnvelope: rejects each forbidden value kind in lineage elements', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validNodeProductionEnvelope();
    v.lineage = [value];
    await assertInvalid(validateNodeProductionEnvelope, v, `NodeProductionEnvelope.lineage[0] ${name}`);
  }
});

test('NodeProductionEnvelope: rejects non-array lineage', async () => {
  const v = validNodeProductionEnvelope();
  v.lineage = 'not-an-array';
  await assertInvalid(validateNodeProductionEnvelope, v, 'NodeProductionEnvelope non-array lineage');
});

test('NodeProductionEnvelope: rejects invalid lineage kind enum', async () => {
  const v = validNodeProductionEnvelope();
  v.lineage = [{ kind: 'bogus', ref: 'r' }];
  await assertInvalid(validateNodeProductionEnvelope, v, 'NodeProductionEnvelope invalid lineage kind');
});

test('NodeProductionEnvelope: rejects missing/empty fields', async () => {
  for (const field of ['schema', 'artifactRef', 'contentHash', 'schemaId', 'productRef', 'lineage', 'bindings']) {
    const v = validNodeProductionEnvelope();
    delete v[field];
    await assertInvalid(validateNodeProductionEnvelope, v, `NodeProductionEnvelope missing ${field}`);
  }
});

// ---------------------------------------------------------------------------
// ProcessModuleOutputEnvelope
// ---------------------------------------------------------------------------

test('ProcessModuleOutputEnvelope: valid instance passes + round-trips', async () => {
  const v = validOutputEnvelope();
  await assertValid(validateProcessModuleOutputEnvelope, v, 'ProcessModuleOutputEnvelope valid');
  assertRoundTrip(v, 'ProcessModuleOutputEnvelope round-trip');
});

test('ProcessModuleOutputEnvelope: valid without optional certificateRef', async () => {
  const v = validOutputEnvelope();
  delete v.certificateRef;
  await assertValid(validateProcessModuleOutputEnvelope, v, 'ProcessModuleOutputEnvelope no cert');
});

test('ProcessModuleOutputEnvelope: rejects each forbidden value kind in outcome', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validOutputEnvelope();
    v.outcome = value;
    await assertInvalid(validateProcessModuleOutputEnvelope, v, `ProcessModuleOutputEnvelope.outcome = ${name}`);
  }
});

test('ProcessModuleOutputEnvelope: rejects each forbidden value kind in productions elements', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validOutputEnvelope();
    v.productions = [value];
    await assertInvalid(validateProcessModuleOutputEnvelope, v, `ProcessModuleOutputEnvelope.productions[0] ${name}`);
  }
});

test('ProcessModuleOutputEnvelope: rejects non-array productions', async () => {
  const v = validOutputEnvelope();
  v.productions = {};
  await assertInvalid(validateProcessModuleOutputEnvelope, v, 'ProcessModuleOutputEnvelope non-array productions');
});

test('ProcessModuleOutputEnvelope: rejects each forbidden value kind in certificateRef', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validOutputEnvelope();
    v.certificateRef = value;
    await assertInvalid(validateProcessModuleOutputEnvelope, v, `ProcessModuleOutputEnvelope.certificateRef = ${name}`);
  }
});

test('ProcessModuleOutputEnvelope: rejects a forbidden value anywhere in the envelope (canonical check)', async () => {
  // Wave 8 BLOCKER 2: the cyclic `completion` field was removed. This test now
  // exercises the canonical-serializability guard (a function value anywhere
  // in the envelope is rejected) rather than a completion-specific rule.
  const v = validOutputEnvelope();
  v.outcome = 'accepted';
  v.completion = () => 1;
  await assertInvalid(validateProcessModuleOutputEnvelope, v, 'ProcessModuleOutputEnvelope function value (canonical)');
});

test('ProcessModuleOutputEnvelope: rejects missing/empty outcome', async () => {
  const v1 = validOutputEnvelope();
  delete v1.outcome;
  await assertInvalid(validateProcessModuleOutputEnvelope, v1, 'ProcessModuleOutputEnvelope missing outcome');
  const v2 = validOutputEnvelope();
  v2.outcome = '';
  await assertInvalid(validateProcessModuleOutputEnvelope, v2, 'ProcessModuleOutputEnvelope empty outcome');
});

test('ProcessModuleOutputEnvelope: leaf shape — extra keys are ignored, no completion required (Wave 8 BLOCKER 2)', async () => {
  // The envelope is a LEAF: it does not require a `completion` field, and the
  // validator does not inspect any `completion` key (the cyclic field was
  // removed). An envelope without completion is valid.
  const v = validOutputEnvelope();
  await assertValid(validateProcessModuleOutputEnvelope, v, 'ProcessModuleOutputEnvelope no completion (leaf)');
});
