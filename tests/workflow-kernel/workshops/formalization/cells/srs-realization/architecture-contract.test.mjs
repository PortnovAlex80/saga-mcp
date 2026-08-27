/**
 * architecture-contract.test.mjs - FRF-WP08 contract-validator family: the
 * sealed architecture contract's surface<->scenario closure, obligation
 * derivation, postFreeze seam exposure, desk-scope fence and digest fences
 * (killed mutation family: architecture contract validator).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cell,
  greenFixture,
  killFalseSurfaceClaim,
  killMissingComposition,
  killOwnerWrongKind,
  killScopeViolation,
  killStaleSrsRevisionPin,
  killTamperedCanonicalDigest,
  killTamperedObligations,
  killTamperedPostFreeze,
} from './support.mjs';

const assertRefused = (outcome, reason, detailPart) => {
  assert.equal(outcome.ok, false, `expected refusal, got ${JSON.stringify(outcome).slice(0, 220)}`);
  assert.equal(outcome.reason, reason);
  if (detailPart !== undefined) assert.ok(outcome.detail.includes(detailPart), `detail "${outcome.detail}" should mention "${detailPart}"`);
};

test('GREEN: the sealed contract validates and its digest verifies', () => {
  const g = greenFixture();
  const verdict = cell.validateArchitectureContract(g.contract, g.universe);
  assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 220));
  assert.equal(verdict.artifact.digest, g.contract.canonicalDigest);
});

test('GREEN: composition surfaces bind integration-or-composition obligations; infrastructure surfaces bind infrastructure obligations', () => {
  const g = greenFixture();
  const { integrationOrComposition, infrastructure } = g.contract.developmentObligations;
  assert.equal(integrationOrComposition.length, 14);
  assert.equal(infrastructure.length, 1);
  for (const binding of integrationOrComposition) {
    assert.equal(binding.obligationKind, 'integration-or-composition-obligation');
    assert.ok(binding.realizedScenarioRefs.length >= 1, 'each surface is cited with the scenarios it realizes');
    assert.ok(binding.definedByRealizationEntryRefs.length >= 1, 'each obligation is defined by realization entries');
  }
  assert.equal(infrastructure[0].surfaceRef, 'arch:elite-test-harness');
  assert.equal(infrastructure[0].obligationKind, 'infrastructure-obligation');
  assert.deepEqual([...infrastructure[0].realizedScenarioRefs].sort(), [...g.universe.idSets.ucScenarioIds].sort());
});

test('fail-closed: the contract validator refuses an unsupplied universe (the WP03 seam)', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(g.contract, undefined), 'MISSING_LINEAGE', 'fail-closed');
  const noSrsPin = { idSets: g.universe.idSets, revisionPins: { whatBaselineDigest: g.universe.revisionPins.whatBaselineDigest } };
  assertRefused(cell.validateArchitectureContract(g.contract, noSrsPin), 'MISSING_LINEAGE', 'srsRevisionDigest');
});

test('RED: a contract pinned to a stale SRS revision is STALE_LINEAGE', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(killStaleSrsRevisionPin(g), g.universe), 'STALE_LINEAGE', 'accepted revision');
});

test('RED: WHAT-side material inside the architecture contract is SCOPE_VIOLATION', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(killScopeViolation(g), g.universe), 'SCOPE_VIOLATION', 'WHAT-side material');
});

test('RED: a surface claiming a scenario whose realization does not cite it back is DRIFT_DETECTED', () => {
  const g = greenFixture();
  const parsed = cell.parseSrsRealizationDraft(killFalseSurfaceClaim(g));
  assert.equal(parsed.ok, true, 'the false claim parses; the closure catches it');
  const contract = { ...g.contract, realization: parsed.section };
  assertRefused(cell.validateArchitectureContract(contract, g.universe), 'DRIFT_DETECTED', 'bidirectional closure');
});

test('RED: a composition owner of the wrong surface kind is MALFORMED_PRODUCT', () => {
  const g = greenFixture();
  const parsed = cell.parseSrsRealizationDraft(killOwnerWrongKind(g));
  assert.equal(parsed.ok, true);
  const contract = { ...g.contract, realization: parsed.section };
  assertRefused(cell.validateArchitectureContract(contract, g.universe), 'MALFORMED_PRODUCT', 'composition owner');
});

test('RED: a declared surface realizing no scenario is FOREIGN_LINEAGE at contract level too', () => {
  const g = greenFixture();
  const parsed = cell.parseSrsRealizationDraft(killMissingComposition(g));
  const contract = { ...g.contract, realization: parsed.section };
  assertRefused(cell.validateArchitectureContract(contract, g.universe), 'FOREIGN_LINEAGE', 'realizes no scenario');
});

test('RED: a tampered developmentObligations block is DRIFT_DETECTED (obligations are derived, never authored)', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(killTamperedObligations(g), g.universe), 'DRIFT_DETECTED', 'developmentObligations');
});

test('RED: a tampered postFreeze block is DRIFT_DETECTED (the WP03 seam exposure is verified content)', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(killTamperedPostFreeze(g), g.universe), 'DRIFT_DETECTED', 'postFreeze');
});

test('RED: a tampered canonical digest is DRIFT_DETECTED', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract(killTamperedCanonicalDigest(g), g.universe), 'DRIFT_DETECTED', 'does not verify');
});

test('RED: a contract sealed by the wrong desk is SCOPE_VIOLATION', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract({ ...g.contract, deskId: 'settle-formalization' }, g.universe), 'SCOPE_VIOLATION', 'define-architecture-contract');
});

test('RED: a wrong contract schemaVersion is MALFORMED_PRODUCT', () => {
  const g = greenFixture();
  assertRefused(cell.validateArchitectureContract({ ...g.contract, schemaVersion: 'formalization.architecture-contract.v0' }, g.universe), 'MALFORMED_PRODUCT');
});
