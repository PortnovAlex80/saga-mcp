/**
 * case.test.mjs - the FRF-WP09 DevelopmentCase: the green construction
 * from the WP03/WP07 frozen fixtures through the WP08 architecture
 * contract, the twelve binding domains, and THE CONSUMER-SIDE UC-FOREIGN
 * KILL (audit defect D-1..D-4, reverse cr-02): a DevelopmentCase built
 * over foreign/unrelated bindings is refused typed, never constructed,
 * never planned.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenCase,
  caseInputsOf,
  deepClone,
  greenBaselineFixture,
  handoffModule,
  repositoryPolicyRefsOf,
  srsAuthorityOf,
} from './support.mjs';

test('GREEN PATH: the full DevelopmentCase builds from the WP03/WP07 frozen fixtures through the WP08 contract', async () => {
  const record = await buildGreenCase();
  const devCase = record.developmentCase;
  assert.equal(devCase.schemaVersion, 'frf-development.case.v1');
  assert.match(devCase.caseDigest, /^[0-9a-f]{64}$/);
  assert.match(devCase.handoffFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(devCase.artifact ?? record.built.artifact.ref, `sha256:${record.built.artifact.digest}`);
  // The lifecycle block is the canonical handoff edge.
  assert.equal(devCase.lifecycle.sourceNodeId, 'settle-formalization');
  assert.equal(devCase.lifecycle.on, 'domain.formalized');
  assert.equal(devCase.lifecycle.sourceTerminalNodeId, 'complete-formalized');
  assert.equal(devCase.lifecycle.developmentEntryId, 'admit-development-case');
});

test('GREEN PATH: ALL TWELVE binding domains are populated FROM the frozen baseline\'s exact id sets', async () => {
  const record = await buildGreenCase();
  const devCase = record.developmentCase;
  const green = greenBaselineFixture();
  // 1. what-baseline-reference-and-hash
  assert.equal(devCase.baselineRef, record.authorities.frozen.artifact.ref);
  assert.equal(devCase.baselineDigest, green.wholeWhatDigest);
  // 2. srs-reference-and-hash
  assert.equal(devCase.srsDigest, srsAuthorityOf().revisionDigest);
  assert.equal(devCase.srsRef, `sha256:${srsAuthorityOf().revisionDigest}`);
  // 3. formalization-certificate
  assert.deepEqual(devCase.certificateRef, green.caseIdentity);
  // 4. solution-contract
  assert.equal(devCase.solutionContractRef, `sha256:${record.authorities.settled.contract.canonicalDigest}`);
  // 5. prd-intent-bindings: the exact frozen member set with digests
  assert.deepEqual(devCase.prdIntentBindings.map((m) => m.memberId).sort(), green.containers.prd.members.map((m) => m.memberId).sort());
  // 6. scenario-bindings: the exact frozen scenario set WITH branches and digests
  assert.deepEqual(
    devCase.scenarioBindings.map((m) => ({ id: m.scenarioId, branches: m.branches.map((b) => b.branchId).sort() })),
    green.containers.uc.members.map((m) => ({ id: m.scenarioId, branches: m.branches.map((b) => b.branchId).sort() })),
  );
  for (const binding of devCase.scenarioBindings) {
    const frozen = green.containers.uc.members.find((m) => m.scenarioId === binding.scenarioId);
    assert.equal(binding.digest, frozen.digest, 'the frozen scenario digest is carried verbatim (cr-03)');
  }
  // 7. requirement-bindings: FR/NFR/RULE exact sets with digests
  for (const family of ['fr', 'nfr', 'rule']) {
    assert.deepEqual(devCase.requirementBindings[family].map((m) => m.memberId).sort(), green.containers[family].members.map((m) => m.memberId).sort());
  }
  // 8. acceptance-bindings: the exact frozen criterion set with digests
  assert.deepEqual(devCase.acceptanceBindings.map((m) => m.criterionId).sort(), green.containers.ac.members.map((m) => m.criterionId).sort());
  // 9. scenario-realization-bindings: the accepted SRS realization entries
  assert.deepEqual(devCase.scenarioRealizationBindings.map((m) => m.realizationEntryId).sort(), [...srsAuthorityOf().realizationEntryIds].sort());
  // 10. terminal-claim-bindings: the frozen terminal-claim manifest
  assert.deepEqual(devCase.terminalClaimBindings.map((m) => m.claimId).sort(), [...green.sourceManifests.terminalClaims.ids].sort());
  // 11. integration-and-construction-obligations: typed from the architecture contract
  assert.deepEqual(devCase.integrationObligations.integrationOrComposition.map((o) => o.surfaceRef), ['svc:cart-api']);
  assert.deepEqual(devCase.integrationObligations.infrastructure.map((o) => o.surfaceRef).sort(), ['module:audit-log', 'svc:batch-runner']);
  // 12. repository-and-policy-bindings: the post-freeze refs
  assert.deepEqual(devCase.repositoryPolicyBindings.map((m) => m.ref), repositoryPolicyRefsOf());
});

test('GREEN PATH: the consumer-side validator accepts the constructed case and reproduces its artifact', async () => {
  const record = await buildGreenCase();
  const validation = record.caseModule.validateDevelopmentCase(record.developmentCase, caseInputsOf(record.authorities));
  assert.equal(validation.ok, true);
  assert.equal(validation.artifact.ref, record.built.artifact.ref);
});

test('GREEN PATH: the realization index carries the planning-gate surface (entrypoints, edges, owners, terminals, evidence)', async () => {
  const record = await buildGreenCase();
  const entries = record.developmentCase.realizationIndex.entries;
  assert.equal(entries.length, 2);
  const checkout = entries.find((e) => e.realizationEntryId === 'realization:uc-checkout-1');
  assert.equal(checkout.scenarioRef, 'uc:checkout-1');
  assert.equal(checkout.entrypointSurfaceRef, 'svc:cart-api');
  assert.equal(checkout.compositionOwnerSurfaceRef, 'svc:cart-api');
  assert.equal(checkout.terminalResult, 'terminal:checkout-rendered');
  assert.deepEqual(checkout.evidenceBinding, { evidenceBindingRef: 'ev:test-1', evidenceKind: 'test' });
});

test('RED SEED (consumer UC-FOREIGN kill): a DevelopmentCase built over foreign scenario bindings is refused typed, never planned', async () => {
  const record = await buildGreenCase();
  const foreign = deepClone(record.developmentCase);
  foreign.scenarioBindings.push({
    branches: [{ branchId: 'branch:foreign-main', digest: '0'.repeat(64) }],
    digest: '0'.repeat(64),
    scenarioId: 'uc:FOREIGN-admin-shell',
  });
  const validation = record.caseModule.validateDevelopmentCase(foreign, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'FOREIGN_LINEAGE');
  assert.match(validation.detail, /uc:FOREIGN-admin-shell/);
  assert.match(validation.detail, /consumer-side UC-FOREIGN kill/);
});

test('RED SEED (foreign across the other domains): every domain resolves against its exact frozen set', async () => {
  const record = await buildGreenCase();
  const cases = await handoffModule('case');
  const seeds = [
    { domain: 'prdIntentBindings', mutate: (c) => c.prdIntentBindings.push({ digest: '0'.repeat(64), memberId: 'prd:FOREIGN-scope' }) },
    { domain: 'requirementBindings', mutate: (c) => c.requirementBindings.fr.push({ digest: '0'.repeat(64), memberId: 'fr:FOREIGN-never-derived' }) },
    { domain: 'acceptanceBindings', mutate: (c) => c.acceptanceBindings.push({ criterionId: 'ac:FOREIGN-never-accepted', digest: '0'.repeat(64) }) },
    { domain: 'scenarioRealizationBindings', mutate: (c) => c.scenarioRealizationBindings.push({ realizationEntryId: 'realization:FOREIGN', scenarioRef: 'uc:checkout-1' }) },
    { domain: 'terminalClaimBindings', mutate: (c) => c.terminalClaimBindings.push({ claimId: 'terminal:FOREIGN' }) },
    { domain: 'repositoryPolicyBindings', mutate: (c) => c.repositoryPolicyBindings.push({ ref: 'repo:FOREIGN' }) },
    { domain: 'integrationObligations', mutate: (c) => c.integrationObligations.infrastructure.push({ definedByRealizationEntryRefs: ['realization:uc-batch-1'], realizedScenarioRefs: ['uc:batch-1'], surfaceRef: 'svc:FOREIGN-runner' }) },
  ];
  for (const seed of seeds) {
    const mutated = deepClone(record.developmentCase);
    seed.mutate(mutated);
    const validation = cases.validateDevelopmentCase(mutated, caseInputsOf(record.authorities));
    assert.equal(validation.ok, false, `the ${seed.domain} foreign seed must be refused`);
    assert.equal(validation.reason, 'FOREIGN_LINEAGE', `the ${seed.domain} foreign seed is a typed FOREIGN_LINEAGE refusal`);
  }
});

test('RED SEED (stripped scenarios with all AC ids retained): the case is refused before planning (edge/0021, ledger D-2)', async () => {
  const record = await buildGreenCase();
  const stripped = deepClone(record.developmentCase);
  stripped.scenarioBindings = [];
  const validation = record.caseModule.validateDevelopmentCase(stripped, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'MISSING_LINEAGE');
  assert.match(validation.detail, /no scenario bindings/);
});

test('RED SEED (stripped realization bindings): DevelopmentCase rejects missing realization bindings (edge/0026)', async () => {
  const record = await buildGreenCase();
  const stripped = deepClone(record.developmentCase);
  stripped.scenarioRealizationBindings = [];
  const validation = record.caseModule.validateDevelopmentCase(stripped, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'MISSING_LINEAGE');
  assert.match(validation.detail, /no scenario realization bindings/);
});

test('RED SEED (incomplete binding domains): a dropped member of a populated domain is a coverage kill, not silent', async () => {
  const record = await buildGreenCase();
  const cases = await handoffModule('case');
  const dropScenario = deepClone(record.developmentCase);
  dropScenario.scenarioBindings = dropScenario.scenarioBindings.filter((m) => m.scenarioId !== 'uc:batch-1');
  const v1 = cases.validateDevelopmentCase(dropScenario, caseInputsOf(record.authorities));
  assert.equal(v1.ok, false);
  assert.equal(v1.reason, 'COVERAGE_GAP');
  assert.match(v1.detail, /uc:batch-1/);
  assert.match(v1.detail, /no accepted UC disappears/);

  const dropRequirement = deepClone(record.developmentCase);
  dropRequirement.requirementBindings.rule = [];
  const v2 = cases.validateDevelopmentCase(dropRequirement, caseInputsOf(record.authorities));
  assert.equal(v2.ok, false);
  assert.equal(v2.reason, 'COVERAGE_GAP');
  assert.match(v2.detail, /rule:audit-1/);

  const dropTerminal = deepClone(record.developmentCase);
  dropTerminal.terminalClaimBindings = dropTerminal.terminalClaimBindings.filter((m) => m.claimId !== 'terminal:delivered-1');
  const v3 = cases.validateDevelopmentCase(dropTerminal, caseInputsOf(record.authorities));
  assert.equal(v3.ok, false);
  assert.equal(v3.reason, 'COVERAGE_GAP');
  assert.match(v3.detail, /terminal-claim bindings are a typed required value/);
});

test('RED SEED (stale baseline digest): the case pins the exact frozen authority or dies', async () => {
  const record = await buildGreenCase();
  const stale = deepClone(record.developmentCase);
  stale.baselineDigest = 'a'.repeat(64);
  const validation = record.caseModule.validateDevelopmentCase(stale, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'STALE_LINEAGE');
  assert.match(validation.detail, /whole-WHAT baseline/);
});

test('RED SEED (drifted scenario digest): same id but a different hash is not the same scenario (cr-03)', async () => {
  const record = await buildGreenCase();
  const drifted = deepClone(record.developmentCase);
  drifted.scenarioBindings = drifted.scenarioBindings.map((m) => (m.scenarioId === 'uc:checkout-1' ? { ...m, digest: 'c'.repeat(64) } : m));
  const validation = record.caseModule.validateDevelopmentCase(drifted, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'DRIFT_DETECTED');
  assert.match(validation.detail, /same identity AND hash/);
});

test('RED SEED (tampered seal): the case digest and handoff fingerprint are recomputed, never trusted', async () => {
  const record = await buildGreenCase();
  const cases = await handoffModule('case');
  const tampered = deepClone(record.developmentCase);
  tampered.caseDigest = 'd'.repeat(64);
  const v1 = cases.validateDevelopmentCase(tampered, caseInputsOf(record.authorities));
  assert.equal(v1.reason, 'DRIFT_DETECTED');

  const tamperedFingerprint = deepClone(record.developmentCase);
  tamperedFingerprint.handoffFingerprint = 'e'.repeat(64);
  const v2 = cases.validateDevelopmentCase(tamperedFingerprint, caseInputsOf(record.authorities));
  assert.equal(v2.reason, 'DRIFT_DETECTED');
  assert.match(v2.detail, /handoff fingerprint/);
});

test('RED SEED (forged solution-contract reference): the case references the sealed contract by its canonical digest', async () => {
  const record = await buildGreenCase();
  const forged = deepClone(record.developmentCase);
  forged.solutionContractRef = `sha256:${'f'.repeat(64)}`;
  const validation = record.caseModule.validateDevelopmentCase(forged, caseInputsOf(record.authorities));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'STALE_LINEAGE');
  assert.match(validation.detail, /canonical digest/);
});

test('RED SEED (construction over a stale architecture contract): mismatched pins never enter the case', async () => {
  const cases = await handoffModule('case');
  const architecture = await handoffModule('architecture');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  // A contract sealed over ANOTHER SRS revision: stale pin at the intake.
  const staleContract = deepClone(inputs.architectureContract);
  staleContract.lineage.srsRevisionDigest = '9'.repeat(64);
  const intake = architecture.ARCHITECTURE_CONTRACT_INTAKE(staleContract, { baselineArtifact: inputs.baselineArtifact, frozenBaseline: inputs.frozenBaseline, srs: inputs.srs });
  assert.equal(intake.ok, false);
  assert.equal(intake.reason, 'STALE_LINEAGE');
  // And the case desk refuses it too (the intake is the case desk's rung).
  const built = cases.buildDevelopmentCase({ ...inputs, architectureContract: staleContract });
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'STALE_LINEAGE');
});

test('RED SEED (tampered architecture contract): the canonical digest is recomputed at the intake', async () => {
  const architecture = await handoffModule('architecture');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  const tampered = deepClone(inputs.architectureContract);
  tampered.developmentObligations.infrastructure.push({
    definedByRealizationEntryRefs: ['realization:uc-batch-1'],
    realizedScenarioRefs: ['uc:batch-1'],
    surfaceRef: 'svc:batch-runner',
  });
  const intake = architecture.ARCHITECTURE_CONTRACT_INTAKE(tampered, { baselineArtifact: inputs.baselineArtifact, frozenBaseline: inputs.frozenBaseline, srs: inputs.srs });
  assert.equal(intake.ok, false);
  assert.equal(intake.reason, 'DRIFT_DETECTED');
  assert.match(intake.detail, /canonical architecture-contract digest/);
});

test('RED SEED (fail-closed desk): a missing authority input is refused, never guessed', async () => {
  const cases = await handoffModule('case');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  for (const inputClass of ['architectureContract', 'baselineArtifact', 'frozenBaseline', 'repositoryPolicyRefs', 'solutionContract', 'srs']) {
    const partial = { ...inputs };
    delete partial[inputClass];
    const built = cases.buildDevelopmentCase(partial);
    assert.equal(built.ok, false, `a case built without ${inputClass} must be refused`);
    assert.equal(built.reason, 'MISSING_LINEAGE');
    assert.match(built.detail, new RegExp(inputClass));
  }
});

test('LAW (determinism): two constructions over the same authorities are byte-identical', async () => {
  const first = await buildGreenCase();
  const second = await buildGreenCase();
  assert.equal(first.developmentCase.caseDigest, second.developmentCase.caseDigest);
  assert.equal(first.developmentCase.handoffFingerprint, second.developmentCase.handoffFingerprint);
  assert.deepEqual(first.developmentCase.scenarioBindings, second.developmentCase.scenarioBindings);
});
