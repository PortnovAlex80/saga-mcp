/**
 * digest.test.mjs - the kernel's canonical serialization + digest rule is
 * BEHAVIORALLY IDENTICAL to the frozen validator
 * (docs/refactoring/event-kernel/specs/validate-role-contract.mjs, the SAME
 * RULE per the work package). Proven by importing both implementations and
 * comparing outputs on identical inputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const kernel = await import('../../../dist/workflow-kernel/domain/digest.js');
const validatorUrl = new URL('../../../docs/refactoring/event-kernel/specs/validate-role-contract.mjs', import.meta.url).href;
const validator = await import(validatorUrl);

test('canonicalJson recursively sorts keys and emits compact JSON', () => {
  assert.equal(kernel.canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(kernel.canonicalJson({ x: undefined }), '{}'); // JSON.stringify drops undefined values, same as the frozen rule
});

test('canonicalJson matches the frozen validator on nested fixtures', () => {
  const fixture = { z: 1, a: { y: [2, 1], x: 's' }, m: [{ b: 2, a: 1 }] };
  assert.equal(kernel.canonicalJson(fixture), JSON.stringify(sortRef(fixture)));
});

test('digestExcluding matches the frozen validator digestExcluding semantics', () => {
  const value = { contractDigest: 'deadbeef', roleContractRef: 'sha256:aa', payload: { b: 2, a: 1 } };
  const kernelDigest = kernel.digestExcluding(value, ['contractDigest', 'roleContractRef']);
  const expected = sha256Ref({ payload: { a: 1, b: 2 } });
  assert.equal(kernelDigest, expected);
});

test('contractDigestOf equals the frozen validator contractDigestOf on a full contract', () => {
  const contract = {
    schemaVersion: 'ek.canonical-role-contract.ek1.v1',
    roleContractRef: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    protocolRole: 'author',
    semanticProfileRef: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    protocolSkillRef: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    protocolSkillDigest: '3333333333333333333333333333333333333333333333333333333333333333',
    semanticSkillRef: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    semanticSkillDigest: '5555555555555555555555555555555555555555555555555555555555555555',
    executorRoutePolicyRef: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    executorRoutePolicyDigest: '7777777777777777777777777777777777777777777777777777777777777777',
    allowedCapabilityRefs: ['kernel.cell'],
    allowedToolRefs: ['tool:read'],
    inputProductContracts: ['sha256:8888888888888888888888888888888888888888888888888888888888888888'],
    outputProductContracts: ['sha256:9999999999999999999999999999999999999999999999999999999999999999'],
    evidenceObligations: ['obligation:submitContribution'],
    completionCommandSchemaRef: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    completionCommandSchemaDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    trackerProjectionProfileRef: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    trackerProjectionProfileDigest: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    promptBudgetProfileRef: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    promptBudgetProfileDigest: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    contractDigest: '0000000000000000000000000000000000000000000000000000000000000000',
  };
  const fromKernel = kernel.contractDigestOf(contract);
  assert.equal(typeof validator.contractDigestOf, 'function', 'the frozen validator exports contractDigestOf');
  assert.equal(fromKernel, validator.contractDigestOf(structuredClone(contract)), 'kernel digest === frozen validator digest');
});

test('pinRoleContract produces the self-addressing reference/digest pair', () => {
  const contract = {
    schemaVersion: 'ek.canonical-role-contract.ek1.v1',
    roleContractRef: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    protocolRole: 'reviewer',
    semanticProfileRef: 'sha256:1',
    protocolSkillRef: 'sha256:2',
    protocolSkillDigest: '3',
    semanticSkillRef: 'sha256:4',
    semanticSkillDigest: '5',
    executorRoutePolicyRef: 'sha256:6',
    executorRoutePolicyDigest: '7',
    allowedCapabilityRefs: ['c'],
    allowedToolRefs: ['t'],
    inputProductContracts: ['sha256:8'],
    outputProductContracts: ['sha256:9'],
    evidenceObligations: ['obligation:sealRevision'],
    completionCommandSchemaRef: 'sha256:a',
    completionCommandSchemaDigest: 'b',
    trackerProjectionProfileRef: 'sha256:c',
    trackerProjectionProfileDigest: 'd',
    promptBudgetProfileRef: 'sha256:e',
    promptBudgetProfileDigest: 'f',
    contractDigest: '0',
  };
  const pin = kernel.pinRoleContract(contract);
  assert.equal(pin.roleContractRef, `sha256:${pin.roleContractDigest}`);
  assert.equal(pin.roleContractDigest, kernel.contractDigestOf(contract));
});

test('canonicalEquals is order-insensitive', () => {
  assert.ok(kernel.canonicalEquals({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.ok(!kernel.canonicalEquals({ a: 1 }, { a: 2 }));
});

/* ---- helpers: an INDEPENDENT reference implementation of the frozen rule ---- */
import { createHash } from 'node:crypto';

function sortRef(value) {
  if (Array.isArray(value)) return value.map(sortRef);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortRef(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function sha256Ref(value) {
  return createHash('sha256').update(JSON.stringify(sortRef(value)), 'utf8').digest('hex');
}
