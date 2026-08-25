/**
 * receipt.test.mjs - the PromptAssemblyReceipt protocol: closed decision
 * vocabulary (never `sent`), normalized layer digests, deterministic
 * omission order, content-addressed digest and structural immutability
 * (WP-18).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { conformingEnvelope, envelope } from './support.mjs';

function admittedFields(overrides = {}) {
  return {
    decision: 'admitted',
    attemptRef: 'attempt:r-1',
    requestOrdinal: 3,
    contextRevision: 2,
    profileRef: 'content://prompt-budget-profiles/test',
    profileDigest: `sha256:${'c'.repeat(64)}`,
    counterIdentity: { ...envelope.RUNNING_COUNTER_IDENTITY },
    limitTableRef: 'content://provider-model-limit-tables/x',
    limitTableDigest: `sha256:${'d'.repeat(64)}`,
    providerRoutePin: { provider: 'zai', model: 'glm-5.2', version: 'catalog-2026-08-24' },
    layerNames: ['initial-prompt-frame', 'protocol-skill'],
    layerDigests: [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`],
    layerTokenCounts: [3, 4],
    requestInputTokens: 7,
    serializedRequestBytes: 120,
    cumulativeInputTokensAfter: 4107,
    limitChecks: [{ limit: 'maxStaticTokens', value: 7, pass: true }],
    omissions: ['recovery-history'],
    externalReferences: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Closed vocabulary                                                   */
/* ------------------------------------------------------------------ */

test('decision is exactly admitted|refused - "sent" is structurally rejected', () => {
  assert.throws(() => envelope.sealReceipt(admittedFields({ decision: 'sent' })), /never "sent"/);
  assert.throws(() => envelope.sealReceipt(admittedFields({ decision: 'delivered' })), /never "delivered"/);
  // the two legal values seal
  assert.equal(envelope.sealReceipt(admittedFields()).decision, 'admitted');
  const refused = envelope.sealReceipt(admittedFields({
    decision: 'refused',
    violation: 'MAX_STATIC_TOKENS_EXCEEDED',
    violationDetail: 'static 41 > 40',
    rejectedEnvelopeDigest: `sha256:${'e'.repeat(64)}`,
  }));
  assert.equal(refused.decision, 'refused');
});

test('an admitted receipt never carries violation/rejectedEnvelopeDigest; a refused one must', () => {
  assert.throws(() => envelope.sealReceipt(admittedFields({ violation: 'MAX_PROMPT_BYTES_EXCEEDED' })), /no violation/);
  assert.throws(() => envelope.sealReceipt(admittedFields({ rejectedEnvelopeDigest: `sha256:${'e'.repeat(64)}` })), /no rejectedEnvelopeDigest/);
  assert.throws(() => envelope.sealReceipt(admittedFields({ decision: 'refused' })), /must record the typed violation/);
  assert.throws(() => envelope.sealReceipt(admittedFields({
    decision: 'refused',
    violation: 'MAX_PROMPT_BYTES_EXCEEDED',
  })), /rejected-envelope digest/);
});

test('omissions may contain only optional layers, in no other place', () => {
  assert.throws(() => envelope.sealReceipt(admittedFields({ omissions: ['protocol-skill'] })), /only optional layers/);
  assert.throws(() => envelope.sealReceipt(admittedFields({ omissions: ['mystery-layer'] })), /only optional layers/);
});

/* ------------------------------------------------------------------ */
/* Immutability (append-only evidence)                                 */
/* ------------------------------------------------------------------ */

test('a sealed receipt is deep-frozen: every mutation attempt throws', () => {
  const receipt = envelope.sealReceipt(admittedFields());
  assert.throws(() => { receipt.requestOrdinal = 99; }, TypeError);
  assert.throws(() => { receipt.limitChecks[0].pass = false; }, TypeError);
  assert.throws(() => { receipt.limitChecks.push({ limit: 'x', value: 1, pass: true }); }, TypeError);
  assert.throws(() => { receipt.layerNames[0] = 'protocol-skill'; }, TypeError);
  assert.throws(() => { receipt.externalReferences.push({ ref: 'content://x', digest: `sha256:${'0'.repeat(64)}`, summary: '' }); }, TypeError);
});

/* ------------------------------------------------------------------ */
/* Digests and content addressing                                      */
/* ------------------------------------------------------------------ */

test('the receipt digest is deterministic and content-addressed', () => {
  const a = envelope.sealReceipt(admittedFields());
  const b = envelope.sealReceipt(admittedFields());
  assert.equal(a.digest, b.digest);
  assert.equal(a.receiptRef, `sha256:${a.digest}`);
  // any field change moves the digest
  for (const mutate of [
    (f) => ({ ...f, requestOrdinal: 4 }),
    (f) => ({ ...f, requestInputTokens: 8 }),
    (f) => ({ ...f, contextRevision: 3 }),
    (f) => ({ ...f, layerTokenCounts: [3, 5] }),
    (f) => ({ ...f, omissions: ['hook-context'] }),
  ]) {
    const changed = envelope.sealReceipt(mutate(admittedFields()));
    assert.notEqual(changed.digest, a.digest);
  }
});

test('layer digests are over NORMALIZED layer bytes in the FIXED layer order', () => {
  const shuffled = { layers: [...conformingEnvelope().layers].reverse() };
  const normalizedA = envelope.normalizeEnvelopeLayers(conformingEnvelope().layers);
  const normalizedB = envelope.normalizeEnvelopeLayers(shuffled.layers);
  assert.equal(normalizedA.ok, true);
  assert.equal(normalizedB.ok, true);
  // input order does not matter: normalization restores the fixed order
  assert.deepEqual(normalizedB.ordered.map((l) => l.layer), normalizedA.ordered.map((l) => l.layer));
  assert.deepEqual(normalizedB.ordered.map((l) => envelope.layerDigestOf(l)), normalizedA.ordered.map((l) => envelope.layerDigestOf(l)));
  // the serialization is a pure function of the ordered layers
  assert.equal(envelope.serializeEnvelopeLayers(normalizedA.ordered), envelope.serializeEnvelopeLayers(normalizedB.ordered));
});

test('the layer digest identifies the material, not the slot (pin-comparable across machines)', () => {
  const same = { layer: 'protocol-skill', content: 'the pinned skill bytes' };
  const otherSlot = { layer: 'semantic-skill', content: 'the pinned skill bytes' };
  assert.equal(envelope.layerDigestOf(same), envelope.layerDigestOf(otherSlot));
  const different = { layer: 'protocol-skill', content: 'different skill bytes' };
  assert.notEqual(envelope.layerDigestOf(same), envelope.layerDigestOf(different));
});

test('the domain reference shape maps 1:1 onto the frozen PromptAssemblyReceiptReference', () => {
  const receipt = envelope.sealReceipt(admittedFields());
  const reference = envelope.toReceiptReference(receipt);
  assert.deepEqual(reference, {
    receiptRef: receipt.receiptRef,
    admission: 'admitted',
    requestOrdinal: 3,
    expectedContextRevision: 2,
    digest: receipt.digest,
  });
});

test('the deterministic optional omission order is the fixed layer order restricted to optional layers', () => {
  assert.deepEqual(envelope.optionalLayerOmissionOrder(), [
    'task-projection',
    'workspace-summary',
    'recovery-history',
    'hook-context',
    'tool-results',
    'large-product-refs',
    'desk-reference',
    'patch-pointer',
  ]);
});
