/**
 * protocol.test.mjs - FRF-WP05 desk protocol: the input surfaces (accepted
 * PRD intent members + accepted UC scenarios, supplied as accepted-id
 * sets), the fail-closed universe derivation and the declared protocol
 * rows of the derive-system-requirements Cell.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cell, greenDeskInput } from './support.mjs';

test('the desk protocol declares exactly the two upstream surfaces and the bundle output', async () => {
  const c = await cell();
  assert.equal(c.SYSTEM_REQUIREMENTS_PROTOCOL.deskId, 'derive-system-requirements');
  const inputs = c.SYSTEM_REQUIREMENTS_PROTOCOL.surfaces.filter((surface) => surface.role === 'input');
  assert.deepEqual(
    inputs.map((surface) => surface.contractKind).sort(),
    ['frf-contracts.prd-intent-member.v1', 'frf-contracts.uc-scenario-member.v1'],
  );
});

test('deriveAcceptedUniverse builds the WP03 universe from the supplied desk input', async () => {
  const { deriveAcceptedUniverse } = await cell();
  const outcome = deriveAcceptedUniverse(greenDeskInput());
  assert.equal(outcome.ok, true);
  const { idSets, revisionPins } = outcome.universe;
  assert.deepEqual(idSets.prdMemberIds, greenDeskInput().prd.memberIds);
  assert.deepEqual(idSets.ucScenarioIds, greenDeskInput().useCases.scenarioIds);
  assert.deepEqual(idSets.ucBranchIdsByScenario['uc:checkout-1'], ['branch:checkout-alt', 'branch:checkout-main']);
  assert.deepEqual(idSets.sourceConstraintIds, ['constraint:retention-1']);
  assert.deepEqual(idSets.verificationSurfaceIds, ['surface:batch-audit-1', 'surface:test-suite-1']);
  assert.equal(revisionPins.prd, greenDeskInput().prd.revisionDigest);
  assert.equal(revisionPins.uc, greenDeskInput().useCases.revisionDigest);
});

test('fail-closed: a missing or empty accepted set is a typed MISSING_LINEAGE refusal, never a guess', async () => {
  const { deriveAcceptedUniverse } = await cell();
  const noPrd = deriveAcceptedUniverse({ ...greenDeskInput(), prd: { revisionDigest: 'a'.repeat(64), memberIds: [] } });
  assert.equal(noPrd.ok, false);
  assert.equal(noPrd.reason, 'MISSING_LINEAGE');
  assert.match(noPrd.detail, /no accepted PRD intent-member set/);

  const noUc = deriveAcceptedUniverse({ ...greenDeskInput(), useCases: { ...greenDeskInput().useCases, scenarioIds: [] } });
  assert.equal(noUc.ok, false);
  assert.equal(noUc.reason, 'MISSING_LINEAGE');
  assert.match(noUc.detail, /no accepted UC scenario set/);

  const noSurfaces = deriveAcceptedUniverse({ ...greenDeskInput(), verificationSurfaceIds: [] });
  assert.equal(noSurfaces.ok, false);
  assert.equal(noSurfaces.reason, 'MISSING_LINEAGE');
  assert.match(noSurfaces.detail, /no accepted verification-surface set/);

  const noPrdPin = deriveAcceptedUniverse({ ...greenDeskInput(), prd: { ...greenDeskInput().prd, revisionDigest: 'not-a-digest' } });
  assert.equal(noPrdPin.ok, false);
  assert.equal(noPrdPin.reason, 'MISSING_LINEAGE');
  assert.match(noPrdPin.detail, /no accepted PRD revision digest/);

  const noBranches = deriveAcceptedUniverse({
    ...greenDeskInput(),
    useCases: { ...greenDeskInput().useCases, branchIdsByScenario: { 'uc:batch-1': ['branch:batch-main'] } },
  });
  assert.equal(noBranches.ok, false);
  assert.equal(noBranches.reason, 'MISSING_LINEAGE');
  assert.match(noBranches.detail, /uc:checkout-1.*declares no terminal-branch id set/);
});
