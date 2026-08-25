/**
 * products.test.mjs - WP-11D deliverable 1: the input/output product
 * schemas of the Discovery workshop - content-addressed, versioned, closed
 * field sets, deterministic typed validation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from './support.mjs';

const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');

const VALID_IDEA = {
  schemaVersion: 'ek.workshop-product.idea-intake.v1',
  ideaId: 'idea-1',
  statement: 'A service that does one thing well.',
  context: 'intake session',
  constraints: ['bounded'],
  outcomeWish: 'a brief',
  unknowns: [],
};

test('the product contracts are versioned, role-tagged data with closed field sets', () => {
  for (const contract of products.DISCOVERY_PRODUCT_CONTRACTS) {
    assert.match(contract.schemaVersion, /^ek\.workshop-product\.[a-z-]+\.v1$/);
    assert.ok(contract.fields.length > 0);
    assert.ok(['input', 'output'].includes(contract.role));
  }
  assert.equal(products.productContractOf('ek.workshop-product.idea-intake.v1').contractId, 'idea-intake');
  assert.equal(products.productContractOf('ek.workshop-product.brief.v1').contractId, 'brief');
  assert.equal(products.productContractOf('ek.workshop-product.intent.v1').contractId, 'intent');
  assert.equal(products.productContractOf('ek.workshop-product.foreign.v1'), undefined, 'an unknown version has no contract');
});

test('sealing is content-addressed under the ONE kernel digest rule; addresses verify', () => {
  const sealed = products.sealProduct(VALID_IDEA);
  assert.match(sealed.ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sealed.ref, `sha256:${sealed.digest}`);
  assert.equal(products.verifyProductAddress(sealed), true);
  // Any content change moves the address.
  const mutated = products.sealProduct({ ...VALID_IDEA, statement: 'A different idea entirely.' });
  assert.notEqual(mutated.ref, sealed.ref);
});

test('validation is deterministic and total over the closed field set', () => {
  assert.equal(products.validateProduct(VALID_IDEA).ok, true);
  assert.equal(products.validateProduct(products.sealProduct(VALID_IDEA).value).ok, true);
  // Determinism: same value, same verdict, twice.
  assert.deepEqual(products.validateProduct(VALID_IDEA), products.validateProduct(VALID_IDEA));
  // Total: null/array/missing-version are typed, never crashes.
  assert.equal(products.validateProduct(null).reason, 'WRONG_TYPE');
  assert.equal(products.validateProduct([]).reason, 'WRONG_TYPE');
  assert.equal(products.validateProduct({}).reason, 'MISSING_FIELD');
});

test('fence: a stale/foreign schema version is refused WRONG_VERSION (schema bypass, family 1)', () => {
  const stale = products.validateProduct({ ...VALID_IDEA, schemaVersion: 'ek.workshop-product.idea-intake.v0' });
  assert.equal(stale.refused, true);
  assert.equal(stale.reason, 'WRONG_VERSION');
  assert.match(stale.detail, /outside the installed contract corpus/);
});

test('fence: missing/thin/typed-wrong fields are refused naming the exact field', () => {
  const missing = products.validateProduct({ ...VALID_IDEA, statement: undefined });
  assert.equal(missing.reason, 'MISSING_FIELD');
  assert.equal(missing.field, 'statement');
  const thin = products.validateProduct({ ...VALID_IDEA, statement: 'too thin' });
  assert.equal(thin.reason, 'EMPTY_VALUE');
  assert.equal(thin.field, 'statement');
  const wrongType = products.validateProduct({ ...VALID_IDEA, constraints: 'not-an-array' });
  assert.equal(wrongType.reason, 'WRONG_TYPE');
  assert.equal(wrongType.field, 'constraints');
});

test('fence: enum and pattern fields are enforced (the decision fork and lineage refs)', () => {
  const badDecision = products.validateProduct({
    schemaVersion: 'ek.workshop-product.intent.v1',
    intentId: 'i-1',
    decision: 'maybe',
    rationale: 'a real rationale of decent length',
    briefRef: 'sha256:' + sha256('brief'),
    targetStageRoute: 'solution-formalization',
  });
  assert.equal(badDecision.reason, 'ENUM_VIOLATION');
  assert.equal(badDecision.field, 'decision');
  const badRef = products.validateProduct({
    schemaVersion: 'ek.workshop-product.intent.v1',
    intentId: 'i-1',
    decision: 'go',
    rationale: 'a real rationale of decent length',
    briefRef: 'not-an-address',
    targetStageRoute: 'solution-formalization',
  });
  assert.equal(badRef.reason, 'PATTERN_VIOLATION');
  assert.equal(badRef.field, 'briefRef');
});

test('fence: a sealed product whose declared address lies is refused ADDRESS_MISMATCH', () => {
  const sealed = products.sealProduct(VALID_IDEA);
  const lying = { ...sealed, digest: sha256('not-the-content') };
  const verdict = products.validateSealedProduct(lying);
  assert.equal(verdict.refused, true);
  assert.equal(verdict.reason, 'ADDRESS_MISMATCH');
});

test('the contract corpus itself is content-addressed (manifest pinning)', () => {
  for (const contract of products.DISCOVERY_PRODUCT_CONTRACTS) {
    assert.match(products.productContractRef(contract), /^sha256:[0-9a-f]{64}$/);
  }
});
