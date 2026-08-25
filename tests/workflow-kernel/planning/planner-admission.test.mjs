/**
 * planner-admission.test.mjs - the profile-blind attempt admission law
 * (WP-09, plan phase EK-6): planner attempts get the EXACT same positive
 * finite context-budget and role-contract admission rules as every other
 * semantic profile. No planner special-casing exists anywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { admitAttempt } = await import('../../../dist/workflow-kernel/planning/planner-admission.js');
const { installRoleContracts, roleContractPinOf } = await import('../../../dist/workflow-kernel/roles/resolver.js');
const { compileRoleContract } = await import('../../../dist/workflow-kernel/roles/compiler.js');
const fixtures = await import('../../../dist/workflow-kernel/roles/fixtures/index.js');

const compile = (builder) => {
  const outcome = compileRoleContract(builder());
  assert.equal(outcome.compiled, true, `fixture compiles: ${JSON.stringify(outcome).slice(0, 200)}`);
  return outcome.contract;
};

const installedSet = () => {
  const contracts = [fixtures.buildPlannerFixture, fixtures.buildImplementerFixture, fixtures.buildReviewerFixture].map((builder) => compile(builder));
  const installed = installRoleContracts(contracts);
  assert.equal(installed.installed, true);
  return { set: installed.set, byProfile: { planner: contracts[0], implementer: contracts[1], reviewer: contracts[2] } };
};

const counters = { nextRequestOrdinal: 0, cumulativeInputTokens: 0 };
const envelopeOf = (tokens) => ({
  providerModel: 'synthetic-provider/synthetic-model-plan',
  requestInputTokens: tokens,
  envelopeDigest: 'sha256:' + 'a'.repeat(64),
});
const LIMITS = {
  providerContextLimitTokens: 200000,
  reservedOutputTokens: 16000,
  providerOverheadReserveTokens: 2000,
  safetyMarginTokens: 2000,
  maxTotalInputTokens: 120000,
  maxCumulativeSessionInputTokens: 400000,
  maxProviderRequests: 20,
};

test('planner, implementer and reviewer attempts admit through the identical path with identical budget rules', () => {
  const { set, byProfile } = installedSet();
  const results = ['planner', 'implementer', 'reviewer'].map((profile) =>
    admitAttempt(set, {
      profile,
      limits: LIMITS,
      counters,
      envelope: envelopeOf(5000),
      rolePin: roleContractPinOf(byProfile[profile]),
    }),
  );
  for (const result of results) {
    assert.deepEqual(
      { admitted: result.admitted, requestOrdinal: result.requestOrdinal ?? null, admissionPath: result.admissionPath ?? null },
      { admitted: true, requestOrdinal: 1, admissionPath: 'application/admission.evaluateEnvelope+roles/resolver.resolveRoleContract' },
      'every profile admits identically (same ordinal, same path)',
    );
  }
  // Swapping the profile cannot change the outcome: the ONLY difference the
  // admission records is the receipt's profile field.
  const plannerFirst = admitAttempt(set, { profile: 'planner', limits: LIMITS, counters, envelope: envelopeOf(5000), rolePin: roleContractPinOf(byProfile.planner) });
  const plannerAsImplementer = admitAttempt(set, { profile: 'implementer', limits: LIMITS, counters, envelope: envelopeOf(5000), rolePin: roleContractPinOf(byProfile.planner) });
  assert.equal(JSON.stringify({ ...plannerFirst, profile: null, roleContractRef: null }), JSON.stringify({ ...plannerAsImplementer, profile: null, roleContractRef: null }));
});

test('a planner envelope over the effective limit is refused EXACTLY like an implementer envelope (no planner relief)', () => {
  const { set, byProfile } = installedSet();
  for (const profile of ['planner', 'implementer', 'reviewer']) {
    const refused = admitAttempt(set, {
      profile,
      limits: LIMITS,
      counters,
      envelope: envelopeOf(999999),
      rolePin: roleContractPinOf(byProfile[profile]),
    });
    assert.equal(refused.refused, true);
    assert.equal(refused.stage, 'envelope');
    assert.match(refused.refusal.detail, /REQUEST_OVER_TOTAL_LIMIT/);
  }
});

test('planner limits are positive-finite fail-closed: zero, missing and infinite never pass', () => {
  const { set, byProfile } = installedSet();
  const pin = roleContractPinOf(byProfile.planner);
  const zero = { ...LIMITS, maxProviderRequests: 0 };
  assert.equal(admitAttempt(set, { profile: 'planner', limits: zero, counters, envelope: envelopeOf(100), rolePin: pin }).stage, 'limits');
  const missing = { ...LIMITS };
  delete missing.maxCumulativeSessionInputTokens;
  assert.equal(admitAttempt(set, { profile: 'planner', limits: missing, counters, envelope: envelopeOf(100), rolePin: pin }).stage, 'limits');
  const infinite = { ...LIMITS, maxTotalInputTokens: Number.POSITIVE_INFINITY };
  assert.equal(admitAttempt(set, { profile: 'planner', limits: infinite, counters, envelope: envelopeOf(100), rolePin: pin }).stage, 'limits');
  const cumulativeBlown = admitAttempt(set, {
    profile: 'planner',
    limits: LIMITS,
    counters: { nextRequestOrdinal: 19, cumulativeInputTokens: 399000 },
    envelope: envelopeOf(5000),
    rolePin: pin,
  });
  assert.equal(cumulativeBlown.stage, 'envelope');
  assert.match(cumulativeBlown.refusal.detail, /CUMULATIVE_OVER_LIMIT/);
});

test('the role-contract admission rules are identical for the planner pin: unknown ref and bad digest fail closed', () => {
  const { set, byProfile } = installedSet();
  const pin = roleContractPinOf(byProfile.planner);
  const outsideSet = admitAttempt(set, { profile: 'planner', limits: LIMITS, counters, envelope: envelopeOf(100), rolePin: { roleContractRef: 'sha256:' + '0'.repeat(64), roleContractDigest: pin.roleContractDigest } });
  assert.equal(outsideSet.stage, 'role-contract');
  assert.equal(outsideSet.refusal.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  const badDigest = admitAttempt(set, { profile: 'planner', limits: LIMITS, counters, envelope: envelopeOf(100), rolePin: { roleContractRef: pin.roleContractRef, roleContractDigest: 'f'.repeat(64) } });
  assert.equal(badDigest.stage, 'role-contract');
  assert.equal(badDigest.refusal.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('structural: the admission module contains no profile-keyed branch (no planner special-casing)', () => {
  // Scan CODE, not prose (comments stripped - the WP-07 structure discipline).
  const source = readFileSync(fileURLToPath(new URL('../../../dist/workflow-kernel/planning/planner-admission.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.equal(/profile\s*===/.test(source), false, 'no equality branch on the profile');
  assert.equal(/switch\s*\(\s*(input\.)?profile/.test(source), false, 'no switch on the profile');
  assert.equal(/plannerBudget|plannerLimits|plannerTable/.test(source), false, 'no planner budget table');
  // The shared rules are the ONLY rules: the module reuses the exact same
  // three functions every other semantic profile goes through.
  assert.match(source, /validateLimits/);
  assert.match(source, /evaluateEnvelope/);
  assert.match(source, /resolveRoleContract/);
});
