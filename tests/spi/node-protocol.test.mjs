// W1-A4 — NodeProtocolDefinition + flow-condition ratchet tests.
//
// Plan refs: §8.2 (NodeProtocol), §7.4.3 (ignored conditions), §8.2.11
// (unsupported retry semantics), §3.5 (canonical-serializable gate), §0.4.11
// (round-trip + negative contract), C065 (ratchet).
//
// These tests exercise the W1-A4 surface only:
//   - validateNodeProtocolDefinition (positive + every negative case from
//     spec §3).
//   - isSupportedFlowCondition (C065 ratchet seed).
//
// They import sibling modules (W1-A1 canonical-serialization, W1-A5
// contract-ref, W1-A6 tool-contribution) by their spec'd paths. If those
// lanes have not landed in this worktree, the dynamic import below fails with
// ERR_MODULE_NOT_FOUND — that is the EXPECTED unresolved-import result
// documented in the lane task. Integration (W1-A8 barrel + lane merge)
// resolves all paths.

import assert from 'node:assert/strict';
import test from 'node:test';

const { validateNodeProtocolDefinition, isSupportedFlowCondition } = await import(
  '../../dist/process-modules/domain/spi/node-protocol.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const STUB_CONTRACT_REF = Object.freeze({
  schemaId: 'factory.evidence.tool-receipt.v1',
  version: '1.0.0',
  digest: '0'.repeat(64),
});

function validStep(overrides = {}) {
  return {
    id: 'step-1',
    instructions: 'Do the thing.',
    resources: ['res://skill/x'],
    allowedTools: ['tool:write'],
    evidenceRequirements: [
      { category: 'tool-receipt', contractRef: STUB_CONTRACT_REF, required: true },
    ],
    ...overrides,
  };
}

function validProtocol(overrides = {}) {
  return {
    id: 'proto.formalization.srs.v1',
    version: '1.0.0',
    owningFlowNodeId: 'node-srs-author',
    entryStep: 'step-1',
    steps: [
      validStep(),
      validStep({ id: 'step-2', instructions: 'Self-review.' }),
    ],
    transitions: [
      { from: 'step-1', to: 'step-2', kind: 'linear' },
    ],
    nodeCompletionEvidence: [
      { category: 'artifact-reference', contractRef: STUB_CONTRACT_REF, required: true },
    ],
    recoveryEntrySteps: ['step-2'],
    retrySemantics: 'runtime-implemented-linear',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Positive: structural validator + canonical round-trip.
// ---------------------------------------------------------------------------

test('validateNodeProtocolDefinition: valid linear protocol passes', () => {
  const r = validateNodeProtocolDefinition(validProtocol());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('NodeProtocolDefinition round-trips through canonical JSON', () => {
  const p = validProtocol();
  const json = canonicalJson(p);
  const parsed = JSON.parse(json);
  // Structural round-trip: every declared field is preserved.
  assert.deepEqual(parsed, p);
  // Hash is stable across two runs (canonicalJson determinism).
  assert.equal(sha256Hex(p), sha256Hex(JSON.parse(json)));
});

test('validateNodeProtocolDefinition: runtime-implemented-backoff is supported', () => {
  const r = validateNodeProtocolDefinition(
    validProtocol({ retrySemantics: 'runtime-implemented-backoff' }),
  );
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Negative: every forbidden value kind from spec §3 must be REJECTED.
// ---------------------------------------------------------------------------

test('rejects function value in any field (steps[].instructions)', () => {
  const bad = validProtocol({
    steps: [validStep({ instructions: () => 'nope' })],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects Map in frozen resource list (steps[].resources)', () => {
  const bad = validProtocol({
    steps: [validStep({ resources: new Map([['k', 'v']]) })],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects Set in allowedTools', () => {
  const bad = validProtocol({
    steps: [validStep({ allowedTools: new Set(['tool:x']) })],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects undefined inside transitions array', () => {
  const bad = validProtocol({
    transitions: [
      { from: 'step-1', to: 'step-2', kind: 'linear' },
      undefined,
    ],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects class instance in nodeCompletionEvidence', () => {
  class Evil {}
  const bad = validProtocol({
    nodeCompletionEvidence: [
      { category: 'artifact-reference', contractRef: new Evil(), required: true },
    ],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects NaN in attempt-like numeric field (recoveryEntrySteps still string)', () => {
  // Inject NaN by mutating into a numeric field on a step.
  const bad = validProtocol({
    steps: [validStep({ instructions: NaN })],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

test('rejects Symbol anywhere in steps', () => {
  const bad = validProtocol({
    steps: [validStep({ id: Symbol('step') })],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'NODE_PROTOCOL_NOT_CANONICAL'));
});

// ---------------------------------------------------------------------------
// C065: retrySemantics: 'unsupported' MUST be rejected (plan §8.2.11).
// ---------------------------------------------------------------------------

test('C065: rejects retrySemantics: "unsupported"', () => {
  const bad = validProtocol({ retrySemantics: 'unsupported' });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_UNSUPPORTED_RETRY_SEMANTICS'),
    `expected UNSUPPORTED_RETRY_SEMANTICS error, got: ${JSON.stringify(r.errors)}`,
  );
});

test('C065: rejects unknown retrySemantics literal', () => {
  const bad = validProtocol({ retrySemantics: 'vendor-magic' });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_UNSUPPORTED_RETRY_SEMANTICS'),
  );
});

// ---------------------------------------------------------------------------
// Structural negatives: graph integrity.
// ---------------------------------------------------------------------------

test('rejects entryStep not in steps', () => {
  const bad = validProtocol({ entryStep: 'no-such-step' });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_ENTRY_STEP_MISSING'),
  );
});

test('rejects transition.to targeting nonexistent step', () => {
  const bad = validProtocol({
    transitions: [{ from: 'step-1', to: 'ghost', kind: 'linear' }],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_TRANSITION_TO_UNKNOWN'),
  );
});

test('rejects transition.from referencing nonexistent step', () => {
  const bad = validProtocol({
    transitions: [{ from: 'ghost', to: 'step-2', kind: 'linear' }],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_TRANSITION_FROM_UNKNOWN'),
  );
});

test('rejects duplicate step ids', () => {
  const bad = validProtocol({
    steps: [validStep(), validStep()],
  });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_DUPLICATE_STEP_ID'),
  );
});

test('rejects recoveryEntrySteps referencing unknown step', () => {
  const bad = validProtocol({ recoveryEntrySteps: ['step-2', 'ghost'] });
  const r = validateNodeProtocolDefinition(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.code === 'NODE_PROTOCOL_RECOVERY_ENTRY_UNKNOWN'),
  );
});

// ---------------------------------------------------------------------------
// C065 ratchet seed: isSupportedFlowCondition.
// ---------------------------------------------------------------------------

test('C065 ratchet: isSupportedFlowCondition(undefined) === true', () => {
  assert.equal(isSupportedFlowCondition(undefined), true);
});

test('C065 ratchet: isSupportedFlowCondition("opaque") === false', () => {
  assert.equal(isSupportedFlowCondition('some opaque string'), false);
});

test('C065 ratchet: isSupportedFlowCondition rejects empty string', () => {
  // Wave 1 is conservative: only `undefined` is supported. Even an empty
  // string is rejected — it's still an uninterpreted predicate.
  assert.equal(isSupportedFlowCondition(''), false);
});
