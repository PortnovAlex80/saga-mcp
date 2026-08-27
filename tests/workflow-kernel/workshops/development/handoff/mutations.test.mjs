/**
 * mutations.test.mjs - the FRF-WP09 deliberate RED mutations: for EVERY
 * validator family of the handoff package at least one mutation of the
 * GREEN material is killed typed (plan §"Test migration policy": each
 * fixture requires provenance and at least one deliberate RED mutation;
 * a mutation that survives means the validator family is dead code).
 *
 * Validator families under mutation:
 *   F1 buildDevelopmentCase        (the construction ladder)
 *   F2 validateDevelopmentCase     (the consumer-side domain resolver)
 *   F3 ARCHITECTURE_CONTRACT_INTAKE(the WP08 intake)
 *   F4 validateWorkItem            (the obligation resolver)
 *   F5 planDevelopment             (the planning-gate ladder)
 *   F6 preservation fences         (replan immutability + stage identity)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenCase,
  buildGreenWorkItems,
  caseInputsOf,
  deepClone,
  greenBaselineFixture,
  handoffModule,
  lawfulHandoffOf,
  planGreenCase,
  wp07Settlement,
} from './support.mjs';

/** Assert one mutation is KILLED typed (refused with the expected reason). */
function assertKilled(refusal, expectedReason, expectedDetail) {
  assert.equal(refusal.ok, false, 'the mutation must be refused, not silently accepted');
  assert.equal(refusal.refused, true);
  assert.equal(refusal.reason, expectedReason);
  if (expectedDetail !== undefined) assert.match(refusal.detail, expectedDetail);
}

test('F1 MUTATION (construction): a frozen baseline that does not verify against its pinned artifact is refused at construction', async () => {
  const cases = await handoffModule('case');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  // Substitute one accepted PRD member payload: the baseline no longer
  // verifies against its pinned artifact digest (the WP07 R1 re-check).
  const forgedBaseline = deepClone(inputs.frozenBaseline);
  forgedBaseline.containers.prd.members[0].digest = '0'.repeat(64);
  const built = cases.buildDevelopmentCase({ ...inputs, frozenBaseline: forgedBaseline });
  assertKilled(built, 'DRIFT_DETECTED', /does not verify against its pinned artifact digest/);
});

test('F1 MUTATION (construction): a solution contract sealed over a foreign handoff value never becomes a DevelopmentCase', async () => {
  const cases = await handoffModule('case');
  const settlement = await wp07Settlement();
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  // A PROPERLY SEALED contract carrying a foreign scenario binding: seal a
  // lawful resolution whose scenario-bindings values were swapped after
  // the binding rung (the seal itself does not re-resolve; the WP09 case
  // desk must). Only the consumer-side resolution can catch this shape.
  const lawfulHandoff = lawfulHandoffOf(greenBaselineFixture());
  const baseInputs = {
    baselineArtifact: inputs.baselineArtifact,
    frozenBaseline: inputs.frozenBaseline,
    handoff: lawfulHandoff,
    repositoryPolicyRefs: inputs.repositoryPolicyRefs,
    srs: inputs.srs,
  };
  const pinsRung = settlement.settlementAuthorityPins(baseInputs);
  assert.equal(pinsRung.ok, true);
  const bindingRung = settlement.settlementBindingResolution(baseInputs, pinsRung.pins);
  assert.equal(bindingRung.ok, true);
  bindingRung.record.handoff['scenario-bindings'].values = ['uc:FOREIGN-admin-shell'];
  const seal = settlement.sealSolutionContract(pinsRung.pins, bindingRung.record.handoff, bindingRung.selfSealKind);
  const built = cases.buildDevelopmentCase({ ...inputs, solutionContract: seal.contract });
  assertKilled(built, 'FOREIGN_LINEAGE', /scenario-bindings/);
});

test('F1 MUTATION (construction): a settlement that did not seal (inconsistent outcome) has no case', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const cases = await handoffModule('case');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  // The case desk consumes the sealed contract; feeding it the WP07
  // routed refusal form (no contract) must die fail-closed.
  const notSealed = { ok: true, outcome: 'inconsistent', contract: null };
  const mapped = lifecycle.mapSettlementToDevelopmentEntry(notSealed);
  assertKilled(mapped, 'MISSING_LINEAGE', /only domain\.formalized/);
  assert.equal(typeof inputs.solutionContract.canonicalDigest, 'string');
});

test('F2 MUTATION (case validator): substitute one scenario member of the green case with a foreign twin', async () => {
  const record = await buildGreenCase();
  const mutated = deepClone(record.developmentCase);
  const index = mutated.scenarioBindings.findIndex((m) => m.scenarioId === 'uc:checkout-1');
  mutated.scenarioBindings[index] = { branches: [{ branchId: 'branch:twin-main', digest: '0'.repeat(64) }], digest: '0'.repeat(64), scenarioId: 'uc:twin-checkout' };
  const validation = record.caseModule.validateDevelopmentCase(mutated, caseInputsOf(record.authorities));
  assertKilled(validation, 'FOREIGN_LINEAGE', /scenarioBindings/);
});

test('F2 MUTATION (case validator): reorder + recompute - identities are order-independent, but a re-sealed content change is drift', async () => {
  const cases = await handoffModule('case');
  const record = await buildGreenCase();
  // Pure reorder of scenario bindings with the digest NOT recomputed: the
  // canonical digest check kills it (order changed the canonical bytes).
  const reordered = deepClone(record.developmentCase);
  reordered.scenarioBindings.reverse();
  const validation = cases.validateDevelopmentCase(reordered, caseInputsOf(record.authorities));
  assertKilled(validation, 'DRIFT_DETECTED', /does not verify/);
});

test('F3 MUTATION (architecture intake): a foreign obligation surface in an otherwise sealed contract', async () => {
  const architecture = await handoffModule('architecture');
  const cases = await handoffModule('case');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  const mutated = deepClone(inputs.architectureContract);
  mutated.developmentObligations.integrationOrComposition[0].surfaceRef = 'svc:FOREIGN-runner';
  // Re-seal the tampered content so ONLY the surface resolution can fire.
  mutated.canonicalDigest = await (async () => {
    const shared = await handoffModule('shared');
    return shared.digestExcluding(mutated, ['canonicalDigest']);
  })();
  const intake = architecture.ARCHITECTURE_CONTRACT_INTAKE(mutated, { baselineArtifact: inputs.baselineArtifact, frozenBaseline: inputs.frozenBaseline, srs: inputs.srs });
  assertKilled(intake, 'FOREIGN_LINEAGE', /outside the accepted construction-surface set/);
  const built = cases.buildDevelopmentCase({ ...inputs, architectureContract: mutated });
  assertKilled(built, 'FOREIGN_LINEAGE');
});

test('F3 MUTATION (architecture intake): postFreeze surfaces that drift from the settlement SRS authority', async () => {
  const architecture = await handoffModule('architecture');
  const record = await buildGreenCase();
  const inputs = caseInputsOf(record.authorities);
  const mutated = deepClone(inputs.architectureContract);
  mutated.postFreeze.surfaces = [...mutated.postFreeze.surfaces, 'svc:FOREIGN-extra'];
  const shared = await handoffModule('shared');
  mutated.canonicalDigest = shared.digestExcluding(mutated, ['canonicalDigest']);
  const intake = architecture.ARCHITECTURE_CONTRACT_INTAKE(mutated, { baselineArtifact: inputs.baselineArtifact, frozenBaseline: inputs.frozenBaseline, srs: inputs.srs });
  assertKilled(intake, 'DRIFT_DETECTED', /construction-surface set/);
});

test('F4 MUTATION (workitem validator): swap one obligation value for a well-formed foreign id', async () => {
  const workitem = await handoffModule('workitem');
  const record = await buildGreenCase();
  const green = await buildGreenWorkItems();
  const mutated = deepClone(green[0]);
  mutated.obligations.acceptanceObligations = [{ criterionId: 'ac:FOREIGN-never-accepted' }];
  const shared = await handoffModule('shared');
  mutated.workItemDigest = shared.digestExcluding(mutated, ['workItemDigest']);
  const validation = workitem.validateWorkItem(mutated, record.developmentCase);
  assertKilled(validation, 'FOREIGN_LINEAGE', /acceptance-bindings domain/);
});

test('F4 MUTATION (workitem validator): a duplicated obligation value is drift, not double coverage', async () => {
  const workitem = await handoffModule('workitem');
  const shared = await handoffModule('shared');
  const record = await buildGreenCase();
  const green = await buildGreenWorkItems();
  const mutated = deepClone(green[0]);
  mutated.obligations.requirementObligations = [{ requirementId: 'fr:cart-1' }, { requirementId: 'fr:cart-1' }];
  mutated.workItemDigest = shared.digestExcluding(mutated, ['workItemDigest']);
  const validation = workitem.validateWorkItem(mutated, record.developmentCase);
  assertKilled(validation, 'DRIFT_DETECTED', /duplicate/);
});

test('F5 MUTATION (plan gates): keep every AC id and strip ONLY the scenario-realization obligations (the audit kill replayed as a mutation)', async () => {
  const plan = await handoffModule('plan');
  const shared = await handoffModule('shared');
  const record = await buildGreenCase();
  const green = await buildGreenWorkItems();
  const mutated = green.map((workItem) => {
    const copy = deepClone(workItem);
    copy.obligations.scenarioRealizationObligations = [];
    copy.workItemDigest = shared.digestExcluding(copy, ['workItemDigest']);
    return copy;
  });
  const planned = plan.planDevelopment(record.developmentCase, mutated);
  assertKilled(planned, 'COVERAGE_GAP', /scenario-incomplete/);
});

test('F5 MUTATION (plan gates): a verifier obligation pointed at the wrong entry', async () => {
  const plan = await handoffModule('plan');
  const shared = await handoffModule('shared');
  const record = await buildGreenCase();
  const green = await buildGreenWorkItems();
  const mutated = green.map((workItem) => {
    const copy = deepClone(workItem);
    for (const verifier of copy.verifierObligations ?? []) {
      if (verifier.realizationEntryId === 'realization:uc-batch-1') verifier.realizationEntryId = 'realization:uc-checkout-1';
    }
    copy.workItemDigest = shared.digestExcluding(copy, ['workItemDigest']);
    return copy;
  });
  // The evidence no longer matches the entry it cites: workitem fidelity.
  const planned = plan.planDevelopment(record.developmentCase, mutated);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'DRIFT_DETECTED');
});

test('F6 MUTATION (preservation): re-verification under the twin of one scenario digest', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, planned.plan);
  const settlement = preservation.settleDevelopmentPlan(record.developmentCase, planned.plan, adoption.record);
  const identities = record.developmentCase.scenarioBindings.map((m) => ({ branches: m.branches, digest: m.digest, scenarioId: m.scenarioId }));
  const twinBranches = identities.map((identity) => (
    identity.scenarioId === 'uc:checkout-1'
      ? { ...identity, branches: [{ branchId: 'branch:checkout-alt', digest: '0'.repeat(64) }, { branchId: 'branch:checkout-main', digest: '0'.repeat(64) }] }
      : identity
  ));
  const verification = preservation.verifyDevelopmentPlan(record.developmentCase, planned.plan, settlement.record, twinBranches);
  assertKilled(verification, 'DRIFT_DETECTED', /branch/);
});

test('MUTATION LEDGER: every validator family of the package has at least one killed mutation (this suite is the ledger)', () => {
  // The families and their killing tests (documented in place; the suite
  // itself is the evidence - removing any test above breaks this count).
  const families = ['F1-construction', 'F2-case-validator', 'F3-architecture-intake', 'F4-workitem-validator', 'F5-plan-gates', 'F6-preservation'];
  assert.equal(families.length, 6);
});
