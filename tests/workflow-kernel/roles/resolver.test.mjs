/**
 * resolver.test.mjs - WP-17 consumer port: ONE resolution path from a
 * WorkIntent's pinned reference/digest pair to the contract; every
 * mismatch fails closed; the installed set is closed and verified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const compiler = await import('../../../dist/workflow-kernel/roles/compiler.js');
const fixtures = await import('../../../dist/workflow-kernel/roles/fixtures/index.js');
const resolver = await import('../../../dist/workflow-kernel/roles/resolver.js');
const digest = await import('../../../dist/workflow-kernel/domain/digest.js');

/** Compile the three Workplace profile fixtures. */
function compiledFixtures() {
  return [fixtures.buildPlannerFixture(), fixtures.buildImplementerFixture(), fixtures.buildReviewerFixture()]
    .map((input) => compiler.compileRoleContract(input));
}

test('resolution round-trips: compile -> install -> pin -> contract', () => {
  const outs = compiledFixtures();
  assert.ok(outs.every((o) => o.compiled));
  const inst = resolver.installRoleContracts(outs.map((o) => o.contract));
  assert.equal(inst.installed, true);
  assert.equal(inst.set.count, 3);
  for (const out of outs) {
    const res = resolver.resolveRoleContract(inst.set, out.pin);
    assert.equal(res.resolved, true);
    assert.ok(digest.canonicalEquals(res.contract, out.contract));
    assert.equal(res.contract.roleContractRef, out.pin.roleContractRef);
    assert.equal(res.contract.contractDigest, out.pin.roleContractDigest);
    // the pin a WorkIntent carries is exactly roleContractPinOf
    assert.deepEqual(resolver.roleContractPinOf(out.contract), out.pin);
  }
});

test('a flipped digest char fails closed with ROLE_CONTRACT_DIGEST_MISMATCH', () => {
  const outs = compiledFixtures();
  const inst = resolver.installRoleContracts(outs.map((o) => o.contract));
  assert.equal(inst.installed, true);
  const good = outs[0].pin.roleContractDigest;
  const flipped = (good.slice(0, -1) === '0' ? '1' : '0') + good.slice(1); // first hex char flipped
  const res = resolver.resolveRoleContract(inst.set, {
    roleContractRef: outs[0].pin.roleContractRef,
    roleContractDigest: flipped,
  });
  assert.equal(res.resolved, undefined);
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
  assert.ok(typeof res.detail === 'string' && res.detail.length > 0);
});

test('an unknown content address fails closed with ROLE_CONTRACT_REF_MISMATCH (no substitute)', () => {
  const outs = compiledFixtures();
  const inst = resolver.installRoleContracts(outs.map((o) => o.contract));
  assert.equal(inst.installed, true);
  const unknown = `sha256:${'ab'.repeat(32)}`;
  const res = resolver.resolveRoleContract(inst.set, {
    roleContractRef: unknown,
    roleContractDigest: 'ab'.repeat(32),
  });
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.ok(res.detail.includes('closed installed set'));
});

test('a cross pin (ref of one contract, digest of another) fails closed, never returns the other contract', () => {
  const outs = compiledFixtures();
  const inst = resolver.installRoleContracts(outs.map((o) => o.contract));
  assert.equal(inst.installed, true);
  const res = resolver.resolveRoleContract(inst.set, {
    roleContractRef: outs[0].pin.roleContractRef,
    roleContractDigest: outs[1].pin.roleContractDigest,
  });
  assert.equal(res.resolved, undefined);
  assert.equal(res.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('a malformed pinned ref fails closed', () => {
  const outs = compiledFixtures();
  const inst = resolver.installRoleContracts(outs.map((o) => o.contract));
  assert.equal(inst.installed, true);
  for (const bad of ['', 'sha256:', 'not-a-ref', `sha256:${'A'.repeat(64)}`, `sha256:${'0'.repeat(63)}`]) {
    const res = resolver.resolveRoleContract(inst.set, { roleContractRef: bad, roleContractDigest: '0'.repeat(64) });
    assert.equal(res.refused, true, `ref ${JSON.stringify(bad)} must be refused`);
    assert.equal(res.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  }
});

test('install verifies self-addressing: a tampered stored digest is refused', () => {
  const out = compiler.compileRoleContract(fixtures.buildImplementerFixture());
  assert.equal(out.compiled, true);
  const tampered = { ...out.contract, contractDigest: 'e'.repeat(64) };
  const inst = resolver.installRoleContracts([tampered]);
  assert.equal(inst.installed, undefined);
  assert.equal(inst.refused, true);
  assert.equal(inst.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('install refuses a drifted derived ref (ref not equal to sha256:digest)', () => {
  const out = compiler.compileRoleContract(fixtures.buildReviewerFixture());
  assert.equal(out.compiled, true);
  const drifted = { ...out.contract, roleContractRef: `sha256:${'f'.repeat(64)}` };
  const inst = resolver.installRoleContracts([drifted]);
  assert.equal(inst.refused, true);
  assert.equal(inst.reason, 'ROLE_CONTRACT_REF_MISMATCH');
});

test('install refuses two values sharing one content address (zero duplicate binding)', () => {
  const out = compiler.compileRoleContract(fixtures.buildPlannerFixture());
  assert.equal(out.compiled, true);
  const inst = resolver.installRoleContracts([out.contract, structuredClone(out.contract)]);
  assert.equal(inst.refused, true);
  assert.equal(inst.reason, 'UNIVERSE_VIOLATION');
  assert.ok(inst.detail.includes('zero duplicate binding'));
});

test('resolution over an empty installed set refuses (the closed set is the only corpus)', () => {
  const inst = resolver.installRoleContracts([]);
  assert.equal(inst.installed, true);
  assert.equal(inst.set.count, 0);
  const pin = { roleContractRef: `sha256:${'0'.repeat(64)}`, roleContractDigest: '0'.repeat(64) };
  const res = resolver.resolveRoleContract(inst.set, pin);
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'ROLE_CONTRACT_REF_MISMATCH');
});

test('a tampered copy inside the set is caught at resolve time as well as install time', () => {
  const out = compiler.compileRoleContract(fixtures.buildPlannerFixture());
  assert.equal(out.compiled, true);
  // Build the set through the public install API, then mutate the STORED
  // value through the exposed byRef index (simulating storage corruption):
  // the resolve path must still fail closed, not serve the tampered value.
  const inst = resolver.installRoleContracts([out.contract]);
  assert.equal(inst.installed, true);
  const stored = inst.set.byRef.get(out.pin.roleContractRef);
  stored.allowedToolRefs = ['evil:tool'];
  const res = resolver.resolveRoleContract(inst.set, out.pin);
  assert.equal(res.refused, true, 'a tampered stored value must not resolve');
  assert.equal(res.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('the D4 certifier operator contract verifies under the same pin discipline', () => {
  const out = compiler.compileCertifierOperatorContract(fixtures.buildCertifierOperatorFixture());
  assert.equal(out.compiled, true);
  assert.equal(out.pin.roleContractRef, out.contract.operatorContractRef);
  assert.equal(out.pin.roleContractDigest, out.contract.contractDigest);
  assert.equal(out.pin.roleContractDigest, digest.digestExcluding(out.contract, ['contractDigest', 'operatorContractRef']));
});
