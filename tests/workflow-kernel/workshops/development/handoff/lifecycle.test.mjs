/**
 * lifecycle.test.mjs - the FRF-WP09 lifecycle mapping (the
 * settle-formalization -> development handoff edge) and the identity
 * preservation through replan / adoption / settlement / verification
 * (cr-03: same scenario identity and hash at every hop).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenCase,
  deepClone,
  greenWorkItemInputs,
  handoffModule,
  planGreenCase,
  buildGreenWorkItems,
} from './support.mjs';

test('LIFECYCLE: the settle-formalization -> development edge is the one frozen handoff (data)', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const edge = lifecycle.FORMALIZATION_TO_DEVELOPMENT_EDGE;
  assert.equal(edge.kind, 'lifecycle-handoff');
  assert.equal(edge.from.workshopId, 'workshop:solution-formalization');
  assert.equal(edge.from.nodeId, 'settle-formalization');
  assert.equal(edge.from.on, 'domain.formalized');
  assert.equal(edge.from.terminalNodeId, 'complete-formalized');
  assert.equal(edge.to.workshopId, 'workshop:development');
  assert.equal(edge.to.developmentEntryId, 'admit-development-case');
  assert.equal(edge.carries.length, 12, 'the edge carries exactly the twelve binding kinds');
});

test('LIFECYCLE: only the formalized settlement hands off; inconsistent/failed carry no Development material', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const inconsistent = lifecycle.mapSettlementToDevelopmentEntry({ contract: null, ok: true, outcome: 'inconsistent' });
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.reason, 'MISSING_LINEAGE');
  assert.match(inconsistent.detail, /only domain\.formalized/);
  const failed = lifecycle.mapSettlementToDevelopmentEntry({ contract: null, ok: true, outcome: 'failed' });
  assert.equal(failed.reason, 'MISSING_LINEAGE');
});

test('LIFECYCLE: the formalized settlement maps to the development entry', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const record = await buildGreenCase();
  const mapped = lifecycle.mapSettlementToDevelopmentEntry(record.authorities.settled);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.entry, 'admit-development-case');
});

test('BYTE-FOR-BYTE (edge/0015): every authoritative field of the sealed contract maps exactly onto the DevelopmentCase', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const record = await buildGreenCase();
  const handoff = lifecycle.lifecycleHandoffRecord(record.authorities.settled, record.developmentCase);
  assert.equal(handoff.ok, true);
  assert.equal(handoff.carried.length, 12);
  assert.deepEqual(handoff.carried, [...lifecycle.FORMALIZATION_TO_DEVELOPMENT_EDGE.carries]);
  assert.equal(handoff.solutionContractRef, record.developmentCase.solutionContractRef);
  assert.equal(handoff.handoffFingerprint, record.developmentCase.handoffFingerprint);
});

test('BYTE-FOR-BYTE RED: a contract field that does not map kills the handoff record', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const record = await buildGreenCase();
  // Mutate the contract's baseline pin -> the digest breaks AND the field
  // no longer maps: the byte-for-byte record refuses.
  const mutatedSettled = deepClone(record.authorities.settled);
  mutatedSettled.contract.wholeWhatDigest = '0'.repeat(64);
  const handoff = lifecycle.lifecycleHandoffRecord(mutatedSettled, record.developmentCase);
  assert.equal(handoff.ok, false);
  assert.equal(handoff.reason, 'DRIFT_DETECTED');
  assert.match(handoff.detail, /byte-for-byte/);
});

test('BYTE-FOR-BYTE RED: contract handoff values that do not resolve against the case domains are FOREIGN_LINEAGE', async () => {
  const lifecycle = await handoffModule('lifecycle');
  const record = await buildGreenCase();
  const mutatedSettled = deepClone(record.authorities.settled);
  mutatedSettled.contract.developmentHandoff['scenario-bindings'].values = ['uc:FOREIGN-admin-shell'];
  const handoff = lifecycle.lifecycleHandoffRecord(mutatedSettled, record.developmentCase);
  assert.equal(handoff.ok, false);
  assert.equal(handoff.reason, 'FOREIGN_LINEAGE');
  assert.match(handoff.detail, /scenario-bindings/);
});

test('PRESERVATION (cr-03): adoption, settlement and verification carry the exact same scenario identities and hashes', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, planned.plan);
  assert.equal(adoption.ok, true);
  const settlement = preservation.settleDevelopmentPlan(record.developmentCase, planned.plan, adoption.record);
  assert.equal(settlement.ok, true);
  const evidence = record.developmentCase.scenarioBindings.map((m) => ({ branches: m.branches, digest: m.digest, scenarioId: m.scenarioId }));
  const verification = preservation.verifyDevelopmentPlan(record.developmentCase, planned.plan, settlement.record, evidence);
  assert.equal(verification.ok, true);
  // Every stage record preserves the fingerprint and the scenario identities.
  for (const stageRecord of [adoption.record, settlement.record, verification.record]) {
    assert.equal(stageRecord.handoffFingerprint, record.developmentCase.handoffFingerprint);
    assert.deepEqual(stageRecord.scenarioIdentities, record.developmentCase.scenarioBindings
      .map((m) => ({ branches: m.branches, digest: m.digest, scenarioId: m.scenarioId }))
      .sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : 1)));
    assert.equal(preservation.identitiesPreserved(stageRecord, record.developmentCase), true);
  }
  // The stage digests chain (content-addressed, no clock).
  assert.equal(settlement.record.priorStageDigest, adoption.record.stageDigest);
  assert.equal(verification.record.priorStageDigest, settlement.record.stageDigest);
});

test('PRESERVATION (replan): bindings survive re-planning - survivors keep their identity, additions are lawful', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const next = await buildGreenWorkItems([
    ...greenWorkItemInputs(),
    { infrastructure: ['module:audit-log'], summary: 'added by the replan', workItemId: 'wi:added-by-replan' },
  ]);
  const replan = preservation.replanDevelopmentPlan(record.developmentCase, planned.plan, next);
  assert.equal(replan.ok, true);
  assert.deepEqual(replan.change, { added: ['wi:added-by-replan'], removed: [], retained: ['wi:batch', 'wi:checkout', 'wi:verify'] });
  // The replanned plan pins the same case identities.
  assert.equal(replan.plan.handoffFingerprint, record.developmentCase.handoffFingerprint);
  assert.equal(replan.plan.caseDigest, record.developmentCase.caseDigest);
});

test('PRESERVATION RED: a mutated surviving WorkItem is refused - identities are immutable per WorkItem', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  // wi:checkout silently gains a requirement binding: coverage stays
  // complete, so ONLY the immutability fence can catch it.
  const mutated = await buildGreenWorkItems(greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:checkout' ? { ...input, requirements: ['fr:cart-1', 'fr:batch-1'] } : input
  )));
  const replan = preservation.replanDevelopmentPlan(record.developmentCase, planned.plan, mutated);
  assert.equal(replan.ok, false);
  assert.equal(replan.reason, 'DRIFT_DETECTED');
  assert.match(replan.detail, /wi:checkout/);
  assert.match(replan.detail, /immutable/);
});

test('PRESERVATION RED: a replan may never drop scenario identities or coverage', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const dropping = await buildGreenWorkItems(greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:batch' ? { ...input, scenarioRealization: [] } : input
  )));
  const replan = preservation.replanDevelopmentPlan(record.developmentCase, planned.plan, dropping);
  assert.equal(replan.ok, false);
  assert.equal(replan.reason, 'COVERAGE_GAP');
  assert.match(replan.detail, /scenario-incomplete/);
});

test('PRESERVATION RED: adoption of a record with drifted identities is refused', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, planned.plan);
  assert.equal(adoption.ok, true);
  const drifted = deepClone(adoption.record);
  drifted.handoffFingerprint = '0'.repeat(64);
  const settlement = preservation.settleDevelopmentPlan(record.developmentCase, planned.plan, drifted);
  assert.equal(settlement.ok, false);
  assert.equal(settlement.reason, 'DRIFT_DETECTED');
  assert.match(settlement.detail, /cr-03/);
});

test('PRESERVATION RED: verification under a different hash is not verification of the same scenario', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, planned.plan);
  const settlement = preservation.settleDevelopmentPlan(record.developmentCase, planned.plan, adoption.record);
  const identities = record.developmentCase.scenarioBindings.map((m) => ({ branches: m.branches, digest: m.digest, scenarioId: m.scenarioId }));
  const drifted = identities.map((identity) => (identity.scenarioId === 'uc:batch-1' ? { ...identity, digest: 'b'.repeat(64) } : identity));
  const verification = preservation.verifyDevelopmentPlan(record.developmentCase, planned.plan, settlement.record, drifted);
  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'DRIFT_DETECTED');
  assert.match(verification.detail, /frozen scenario digest/);
});

test('PRESERVATION RED: verification must cover every handed-off scenario and no foreign one', async () => {
  const preservation = await handoffModule('preservation');
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, planned.plan);
  const settlement = preservation.settleDevelopmentPlan(record.developmentCase, planned.plan, adoption.record);
  const identities = record.developmentCase.scenarioBindings.map((m) => ({ branches: m.branches, digest: m.digest, scenarioId: m.scenarioId }));
  const partial = identities.filter((identity) => identity.scenarioId !== 'uc:batch-1');
  const v1 = preservation.verifyDevelopmentPlan(record.developmentCase, planned.plan, settlement.record, partial);
  assert.equal(v1.reason, 'COVERAGE_GAP');
  assert.match(v1.detail, /uc:batch-1/);
  const foreign = [...identities, { branches: [], digest: '0'.repeat(64), scenarioId: 'uc:FOREIGN-admin-shell' }];
  const v2 = preservation.verifyDevelopmentPlan(record.developmentCase, planned.plan, settlement.record, foreign);
  assert.equal(v2.reason, 'FOREIGN_LINEAGE');
  assert.match(v2.detail, /uc:FOREIGN-admin-shell/);
});

test('PRESERVATION RED: adoption re-runs the planning ladder - a scenario-incomplete plan is never adopted', async () => {
  const preservation = await handoffModule('preservation');
  const plan = await handoffModule('plan');
  const record = await buildGreenCase();
  const acOnly = await buildGreenWorkItems([
    { acceptance: ['ac:checkout-end-1', 'ac:batch-error-1'], requirements: ['fr:cart-1', 'fr:batch-1', 'nfr:retention-1', 'rule:audit-1'], summary: 'AC-only', workItemId: 'wi:ac-all' },
  ]);
  const planned = plan.planDevelopment(record.developmentCase, acOnly);
  assert.equal(planned.ok, false);
  // Even a forged plan record dies at adoption: the ladder re-runs.
  const forged = { caseDigest: record.developmentCase.caseDigest, handoffFingerprint: record.developmentCase.handoffFingerprint, planDigest: '0'.repeat(64), planId: 'plan:forged', schemaVersion: 'frf-development.plan.v1', workItems: acOnly };
  const adoption = preservation.adoptDevelopmentPlan(record.developmentCase, forged);
  assert.equal(adoption.ok, false);
  assert.equal(adoption.reason, 'COVERAGE_GAP');
  assert.match(adoption.detail, /scenario-incomplete/);
});
