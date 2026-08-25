/**
 * compiler.test.mjs - WP-17 role-contract compiler: correct digests, the
 * exact WorkIntent pin, frozen-schema validation, and fail-closed behavior
 * on every defect class. The strongest oracle is the FROZEN admission
 * validator's synthetic example (ROLE-CONTRACT-SPEC.md section 6 publishes
 * its digests): compiling it through THIS compiler must reproduce the
 * published constants byte-for-byte.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const compiler = await import('../../../dist/workflow-kernel/roles/compiler.js');
const fixtures = await import('../../../dist/workflow-kernel/roles/fixtures/index.js');
const digest = await import('../../../dist/workflow-kernel/domain/digest.js');
const validatorUrl = new URL('../../../docs/refactoring/event-kernel/specs/validate-role-contract.mjs', import.meta.url).href;
const validator = await import(validatorUrl);

/* Published frozen reference digests (ROLE-CONTRACT-SPEC.md section 6). */
const FROZEN_EXAMPLE_CONTRACT_DIGEST = '323d15a14284bd8418d6243565e598e1ff399644b3d1e9397d5686ad3bebb868';
const FROZEN_EXAMPLE_OPERATOR_DIGEST = 'ee494ea89bcf089a241181eeca0eb81ae485ecb2921a3c526c175e02562787d3';

/** The frozen validator's synthetic example, adapted to the compiler input. */
function syntheticExampleInput() {
  const example = validator.buildSyntheticExample();
  const binding = compiler.manifestBindingByLaunchKind(example.launch.launchKind);
  assert.notEqual(binding, undefined, 'the synthetic example launch kind is an installed manifest row');
  return {
    binding,
    content: example.contract,
    artifacts: {
      semanticProfileArtifact: example.artifacts.semanticProfileArtifact,
      protocolSkill: example.artifacts.protocolSkill,
      semanticSkill: example.artifacts.semanticSkill,
      executorRoutePolicyTable: example.artifacts.routePolicyTable,
      completionCommandSchema: example.artifacts.completionCommandSchema,
      trackerProjectionProfile: example.artifacts.trackerProfile,
      promptBudgetProfile: 'synthetic-prompt-budget-profile-stand-in (shape frozen by WP-16 part 3)',
    },
    example,
  };
}

/* ------------------------------------------------------------------ */
/* Digest correctness: the ONE canonical rule, the published constants */
/* ------------------------------------------------------------------ */

test('the frozen synthetic example compiles to the published contractDigest and pin', () => {
  const { binding, content, artifacts, example } = syntheticExampleInput();
  const out = compiler.compileRoleContract({ binding, content, artifacts });
  assert.equal(out.compiled, true, JSON.stringify(out.errors));
  assert.equal(out.pin.roleContractDigest, FROZEN_EXAMPLE_CONTRACT_DIGEST);
  assert.equal(out.pin.roleContractRef, `sha256:${FROZEN_EXAMPLE_CONTRACT_DIGEST}`);
  assert.equal(out.contract.contractDigest, FROZEN_EXAMPLE_CONTRACT_DIGEST);
  assert.equal(out.contract.roleContractRef, example.contract.roleContractRef);
});

test('the frozen synthetic certifier operator contract compiles to the published digest', () => {
  const example = validator.buildSyntheticExample();
  const binding = compiler.certifierOperatorBinding();
  assert.notEqual(binding, undefined, 'the D4 lifecycleOperator row is installed');
  const out = compiler.compileCertifierOperatorContract({ binding, content: example.certifierOperatorContract });
  assert.equal(out.compiled, true, JSON.stringify(out.errors));
  assert.equal(out.pin.roleContractDigest, FROZEN_EXAMPLE_OPERATOR_DIGEST);
  assert.equal(out.pin.roleContractRef, `sha256:${FROZEN_EXAMPLE_OPERATOR_DIGEST}`);
});

test('compile digests equal domain/digest contractDigestOf and the frozen validator, on identical inputs', () => {
  const { binding, content, artifacts } = syntheticExampleInput();
  const out = compiler.compileRoleContract({ binding, content, artifacts });
  assert.equal(out.compiled, true);
  assert.equal(out.pin.roleContractDigest, digest.contractDigestOf(out.contract));
  assert.equal(out.pin.roleContractDigest, validator.contractDigestOf(structuredClone(out.contract)));
});

test('fixture compilation is deterministic across rebuilds of the input', () => {
  const first = compiler.compileRoleContract(fixtures.buildPlannerFixture());
  const second = compiler.compileRoleContract(fixtures.buildPlannerFixture());
  assert.equal(first.compiled, true);
  assert.equal(second.compiled, true);
  assert.equal(first.pin.roleContractDigest, second.pin.roleContractDigest);
  assert.ok(digest.canonicalEquals(first.contract, second.contract));
});

/* ------------------------------------------------------------------ */
/* One valid contract per semantic profile                             */
/* ------------------------------------------------------------------ */

test('planner, implementer and reviewer fixtures compile green against their manifest rows', () => {
  const cases = [
    ['planner', fixtures.buildPlannerFixture, fixtures.plannerLaunchKind, 'planner'],
    ['implementer', fixtures.buildImplementerFixture, fixtures.implementerLaunchKind, 'implementer'],
    ['reviewer', fixtures.buildReviewerFixture, fixtures.reviewerLaunchKind, 'reviewer'],
  ];
  for (const [name, build, launchKind] of cases) {
    const input = build();
    assert.equal(input.binding.launchKind, launchKind);
    const out = compiler.compileRoleContract(input);
    assert.equal(out.compiled, true, `${name}: ${JSON.stringify(out.errors)}`);
    assert.equal(out.contract.protocolRole, input.binding.protocolRole);
    assert.equal(out.pin.roleContractRef, `sha256:${out.pin.roleContractDigest}`);
    // the pin is the exact WorkIntent pair (domain pinRoleContract agrees)
    assert.deepEqual(out.pin, digest.pinRoleContract(out.contract));
    assert.deepEqual(out.pin, {
      roleContractRef: out.contract.roleContractRef,
      roleContractDigest: out.contract.contractDigest,
    });
    // the artifact is schema-shaped: no pin-alias own property on it
    assert.equal('roleContractDigest' in out.contract, false);
    // each route table yields EXACTLY ONE rule for its launch kind
    assert.equal(
      compiler.countMatchingRouteRules(input.artifacts.executorRoutePolicyTable, {
        launchKind,
        protocolRole: input.binding.protocolRole,
        semanticProfile: input.binding.semanticProfile,
      }),
      1,
    );
  }
});

test('the three fixture digests are pairwise distinct', () => {
  const digests = [fixtures.buildPlannerFixture(), fixtures.buildImplementerFixture(), fixtures.buildReviewerFixture()]
    .map((input) => compiler.compileRoleContract(input).pin.roleContractDigest);
  assert.equal(new Set(digests).size, 3);
});

test('the D4 certifier operator fixture compiles green and is the certifier profile contract', () => {
  const input = fixtures.buildCertifierOperatorFixture();
  assert.equal(input.binding.bindingClass, 'lifecycleOperator');
  assert.equal(input.binding.semanticProfile, 'certifier');
  const out = compiler.compileCertifierOperatorContract(input);
  assert.equal(out.compiled, true, JSON.stringify(out.errors));
  assert.equal(out.contract.ownedCommand, 'lifecycleRun.verifyTerminalClaims');
  assert.equal(out.contract.ownerAggregate, 'LifecycleRun');
  assert.deepEqual(out.contract.evidenceObligations, ['obligation:verifyTerminalClaims']);
  assert.equal(out.pin.roleContractRef, `sha256:${out.pin.roleContractDigest}`);
});

/* ------------------------------------------------------------------ */
/* Fail-closed compile paths                                           */
/* ------------------------------------------------------------------ */

test('an arbitrary contract field (extension bag) fails the compile through the frozen schema', () => {
  const out = compiler.compileRoleContract(fixtures.buildInvalidArbitraryFieldFixture());
  assert.equal(out.compiled, false);
  assert.ok(
    out.errors.includes('contract: additional property "metadata" is forbidden (closed shape; adding fields reopens EK-1)'),
    JSON.stringify(out.errors),
  );
});

test('a declared self-address that disagrees with the computed slot fingerprint fails the compile', () => {
  const input = fixtures.buildImplementerFixture();
  const tampered = { ...input, content: { ...input.content, contractDigest: '0'.repeat(64), roleContractRef: `sha256:${'0'.repeat(64)}` } };
  const out = compiler.compileRoleContract(tampered);
  assert.equal(out.compiled, false);
  assert.ok(out.errors.some((e) => e.startsWith('contract: declared contractDigest')), JSON.stringify(out.errors));
});

test('a protocolRole disagreement between the manifest row and the content fails the compile', () => {
  const input = fixtures.buildReviewerFixture(); // reviewer row
  const flipped = { ...input, content: { ...input.content, protocolRole: 'author' } };
  const out = compiler.compileRoleContract(flipped);
  assert.equal(out.compiled, false);
  assert.ok(
    out.errors.some((e) => e.includes('binds protocolRole "reviewer"')),
    JSON.stringify(out.errors),
  );
});

test('D4 structural exclusion: a certifier-profile contract cannot pass the Workplace compile path', () => {
  const input = fixtures.buildPlannerFixture();
  const certifierContent = {
    ...input.content,
  };
  const out = compiler.compileRoleContract({
    binding: input.binding, // a planner row
    content: certifierContent,
    artifacts: {
      ...input.artifacts,
      semanticProfileArtifact: {
        schemaVersion: 'ek.semantic-profile.ek1.v1',
        profileId: 'certifier',
        definitionSummary: 'Verifies terminal lifecycle claims (D4: not a Workplace protocol role).',
      },
    },
  });
  assert.equal(out.compiled, false);
  assert.ok(
    out.errors.some((e) => e.includes('requires profile "planner"') && e.includes('declares "certifier"')),
    JSON.stringify(out.errors),
  );
});

test('a tampered referenced artifact (digest no longer verifies) fails the compile', () => {
  const input = fixtures.buildImplementerFixture();
  const tamperedSkill = { ...input.artifacts.protocolSkill, instructions: 'quietly different instructions' };
  const out = compiler.compileRoleContract({ ...input, artifacts: { ...input.artifacts, protocolSkill: tamperedSkill } });
  assert.equal(out.compiled, false);
  assert.ok(out.errors.some((e) => e === 'contract.protocolSkill: paired digest does not verify'), JSON.stringify(out.errors));
  assert.ok(out.errors.some((e) => e === 'contract.protocolSkill: ref does not match artifact content address'), JSON.stringify(out.errors));
});

test('an executable route rule (code key) fails the compile through the frozen $def', () => {
  const input = fixtures.buildImplementerFixture();
  const withCode = {
    ...input.artifacts.executorRoutePolicyTable,
    rules: input.artifacts.executorRoutePolicyTable.rules.map((rule) => ({
      ...rule,
      route: { ...rule.route, code: 'module.exports = (ctx) => pickByStatus(ctx.task.status)' },
    })),
  };
  const out = compiler.compileRoleContract({ ...input, artifacts: { ...input.artifacts, executorRoutePolicyTable: withCode } });
  assert.equal(out.compiled, false);
  assert.ok(
    out.errors.some((e) => e.includes('contract.executorRoutePolicy') && e.includes('additional property "code" is forbidden')),
    JSON.stringify(out.errors),
  );
});

test('malformed inputs become typed compile errors, never crashes', () => {
  assert.equal(compiler.compileRoleContract(null).compiled, false);
  assert.equal(compiler.compileRoleContract(undefined).compiled, false);
  assert.equal(compiler.compileRoleContract({}).compiled, false);
  const partial = compiler.compileRoleContract({
    binding: fixtures.buildPlannerFixture().binding,
    content: { schemaVersion: 'ek.canonical-role-contract.ek1.v1' },
    artifacts: {},
  });
  assert.equal(partial.compiled, false);
  assert.ok(partial.errors.some((e) => e.includes('missing required property')), JSON.stringify(partial.errors));
  assert.ok(partial.errors.some((e) => e.includes('referenced artifact was not provided')), JSON.stringify(partial.errors));
  assert.equal(compiler.compileCertifierOperatorContract(null).compiled, false);
});

test('manifest row lookup is a closed set: an unknown launch kind has no row', () => {
  assert.equal(compiler.manifestBindingByLaunchKind('development.planning.author') !== undefined, true);
  assert.equal(compiler.manifestBindingByLaunchKind('no.such.launchKind.author'), undefined);
});

/* ------------------------------------------------------------------ */
/* Behavioral agreement with the frozen admission validator            */
/* ------------------------------------------------------------------ */

test('compiler verdicts agree with the frozen validator checkExample (green and both RED mutations)', async () => {
  // GREEN: the untouched example passes both.
  const { binding, content, artifacts, example } = syntheticExampleInput();
  assert.deepEqual(validator.checkExample(await frozenSchemaDoc(), example), []);
  assert.equal(compiler.compileRoleContract({ binding, content, artifacts }).compiled, true);

  // RED M3: arbitrary contract field - both must go red.
  const m3 = validator.buildSyntheticExample();
  m3.contract.metadata = { note: 'extension bag' };
  const frozenM3 = validator.checkExample(await frozenSchemaDoc(), m3);
  assert.ok(frozenM3.length > 0 && frozenM3[0].includes('additional property "metadata" is forbidden'));
  const mineM3 = compiler.compileRoleContract({
    binding,
    content: m3.contract,
    artifacts,
  });
  assert.equal(mineM3.compiled, false);
  assert.ok(mineM3.errors.includes(frozenM3[0].replace(/^example\.contract:/, 'contract:')));

  // RED M4: executable route rule - both must go red.
  const m4 = validator.buildSyntheticExample();
  m4.artifacts.routePolicyTable.rules[0].route.code = 'module.exports = (ctx) => pickByStatus(ctx.task.status)';
  const frozenM4 = validator.checkExample(await frozenSchemaDoc(), m4);
  assert.ok(frozenM4.length > 0 && frozenM4[0].includes('additional property "code" is forbidden'));
  const mineM4 = compiler.compileRoleContract({
    binding,
    content: m4.contract,
    artifacts: {
      semanticProfileArtifact: m4.artifacts.semanticProfileArtifact,
      protocolSkill: m4.artifacts.protocolSkill,
      semanticSkill: m4.artifacts.semanticSkill,
      executorRoutePolicyTable: m4.artifacts.routePolicyTable,
      completionCommandSchema: m4.artifacts.completionCommandSchema,
      trackerProjectionProfile: m4.artifacts.trackerProfile,
      promptBudgetProfile: 'synthetic-prompt-budget-profile-stand-in (shape frozen by WP-16 part 3)',
    },
  });
  assert.equal(mineM4.compiled, false);
  assert.ok(mineM4.errors.some((e) => e.includes('additional property "code" is forbidden')));
});

/* the schema document for the frozen validator's checkExample signature */
async function frozenSchemaDoc() {
  const { loadFrozenRoleContractSchema } = await import('../../../dist/workflow-kernel/roles/frozen-docs.js');
  return loadFrozenRoleContractSchema();
}
