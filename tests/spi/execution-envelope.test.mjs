// W1-A4 — ExecutionContextEnvelope tests.
//
// Plan refs: §7.7 (envelope), §7.7.1-7.7.6 (fields), §13.16 + C061
// (driver-neutrality), §3.5 (canonical-serializable gate), §0.4.11
// (round-trip + negative contract).
//
// These tests exercise the W1-A4 surface only:
//   - ExecutionContextEnvelope structural shape.
//   - canonical-serializability of the envelope (delegated to W1-A1's
//     `assertCanonicalSerializable`, imported by spec'd path).
//   - round-trip through canonical JSON.
//   - the driver-neutrality guard (C061): board/task/epic/WorkIntent IDs are
//     NOT base fields and are flagged by findForbiddenDriverNeutralKeys.
//
// Sibling imports resolve at integration. If W1-A1 (canonical-serialization)
// or W1-A6 (production-envelope for ProductRef) have not landed in this
// worktree, the dynamic imports below fail with ERR_MODULE_NOT_FOUND — that
// is the EXPECTED unresolved-import result documented in the lane task.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  findForbiddenDriverNeutralKeys,
  FORBIDDEN_DRIVER_NEUTRAL_KEYS,
} = await import(
  '../../dist/process-modules/domain/spi/execution-envelope.js'
);
const { assertCanonicalSerializable } = await import(
  '../../dist/process-modules/domain/spi/canonical-serialization.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Fixtures (plain-data stand-ins for sibling-owned types).
// ---------------------------------------------------------------------------

const PACKAGE_REF = Object.freeze({
  name: 'formalization',
  version: '1.0.0',
  digest: 'a'.repeat(64),
});

const NODE_REF = Object.freeze({
  nodeId: 'node-srs-author',
  flowId: 'flow.formalization.v1',
  flowVersion: '1.0.0',
});

const PRODUCT_REF = Object.freeze({
  schemaId: 'factory.srs.v1',
  ref: 'srs/REQ-001/SRS.md',
  digest: 'b'.repeat(64),
});

function validEnvelope(overrides = {}) {
  return {
    processRunId: 42,
    nodeRunId: 7,
    attempt: 1,
    executionId: 'exec-017',
    packageRef: PACKAGE_REF,
    nodeRef: NODE_REF,
    frozenAuthority: Object.freeze({ installationId: 9 }),
    immutableRunInput: Object.freeze({ problem: 'P' }),
    upstreamProducts: [PRODUCT_REF],
    scenarioId: 'scenario.product-delivery.v1',
    stageId: 'formalization',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Positive: shape + round-trip + canonical-serializable.
// ---------------------------------------------------------------------------

test('ExecutionContextEnvelope: valid envelope is canonical-serializable', () => {
  const env = validEnvelope();
  assert.doesNotThrow(() => assertCanonicalSerializable(env));
});

test('ExecutionContextEnvelope: valid envelope round-trips through canonical JSON', () => {
  const env = validEnvelope();
  const json = canonicalJson(env);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, env);
  assert.equal(sha256Hex(env), sha256Hex(JSON.parse(json)));
});

test('ExecutionContextEnvelope: minimal envelope (no optional fields) round-trips', () => {
  const minimal = {
    processRunId: 1,
    nodeRunId: 1,
    attempt: 1,
    executionId: 'exec-1',
    packageRef: PACKAGE_REF,
    nodeRef: NODE_REF,
    frozenAuthority: {},
    immutableRunInput: null,
    upstreamProducts: [],
  };
  assert.doesNotThrow(() => assertCanonicalSerializable(minimal));
  const json = canonicalJson(minimal);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, minimal);
});

// ---------------------------------------------------------------------------
// Negative: forbidden value kinds inside envelope fields. The
// canonical-serializable gate (W1-A1) is the persistence-boundary guard; an
// envelope carrying any of these MUST be rejected before persistence.
// ---------------------------------------------------------------------------

test('rejects function inside frozenAuthority', () => {
  const bad = validEnvelope({
    frozenAuthority: { leak: () => 'nope' },
  });
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects Map inside frozenAuthority', () => {
  const bad = validEnvelope({
    frozenAuthority: { m: new Map() },
  });
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects Set inside upstreamProducts', () => {
  const bad = validEnvelope({
    upstreamProducts: new Set([PRODUCT_REF]),
  });
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects undefined inside upstreamProducts array', () => {
  const bad = validEnvelope({
    upstreamProducts: [PRODUCT_REF, undefined],
  });
  // canonicalJson silently drops undefined array elements; the
  // canonical-serializable gate is what catches this BEFORE persistence.
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects Symbol inside immutableRunInput', () => {
  const bad = validEnvelope({
    immutableRunInput: { tag: Symbol('nope') },
  });
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects NaN in processRunId', () => {
  const bad = validEnvelope({ processRunId: NaN });
  assert.throws(() => assertCanonicalSerializable(bad));
});

test('rejects class instance inside frozenAuthority', () => {
  class Evil {}
  const bad = validEnvelope({
    frozenAuthority: { inst: new Evil() },
  });
  assert.throws(() => assertCanonicalSerializable(bad));
});

// ---------------------------------------------------------------------------
// C061 driver-neutrality guard.
// ---------------------------------------------------------------------------

test('C061: forbidden driver-neutral keys list is non-empty', () => {
  assert.ok(FORBIDDEN_DRIVER_NEUTRAL_KEYS.length > 0);
  // Sanity: the specific keys named in the plan are listed.
  for (const k of ['taskId', 'epicId', 'projectId', 'workIntentId', 'boardId']) {
    assert.ok(FORBIDDEN_DRIVER_NEUTRAL_KEYS.includes(k), `missing ${k}`);
  }
});

test('C061: clean envelope has no forbidden keys', () => {
  const env = validEnvelope();
  assert.deepEqual(findForbiddenDriverNeutralKeys(env), []);
});

test('C061: detects taskId on envelope root', () => {
  const bad = { ...validEnvelope(), taskId: 17 };
  const found = findForbiddenDriverNeutralKeys(bad);
  assert.deepEqual(found, ['taskId']);
});

test('C061: detects forbidden key nested in frozenAuthority', () => {
  const bad = validEnvelope({
    frozenAuthority: { epicId: 5, ok: 'fine' },
  });
  const found = findForbiddenDriverNeutralKeys(bad);
  assert.deepEqual(found, ['frozenAuthority.epicId']);
});

test('C061: detects multiple forbidden keys at once', () => {
  const bad = {
    ...validEnvelope(),
    taskId: 17,
    projectId: 3,
    frozenAuthority: { workIntentId: 'w1', boardId: 'b' },
  };
  const found = findForbiddenDriverNeutralKeys(bad);
  assert.ok(found.includes('taskId'));
  assert.ok(found.includes('projectId'));
  assert.ok(found.includes('frozenAuthority.workIntentId'));
  assert.ok(found.includes('frozenAuthority.boardId'));
  assert.equal(found.length, 4);
});

test('C061: guard ignores non-object input', () => {
  assert.deepEqual(findForbiddenDriverNeutralKeys(null), []);
  assert.deepEqual(findForbiddenDriverNeutralKeys(undefined), []);
  assert.deepEqual(findForbiddenDriverNeutralKeys('string'), []);
  assert.deepEqual(findForbiddenDriverNeutralKeys(42), []);
});
