/**
 * ingestion.test.mjs - the FRF-WP07 authority-mutation RED seeds at the
 * ingestion fence: the substituted member, the folded section, and the
 * duplicate digest (plan §"Required semantic mutations": "Substitute
 * material from a newer execution, another run, or another PRD",
 * "Freeze only AC members and omit accepted UC or requirements",
 * "Mutate accepted material after reconciliation"; forward finding F-8 /
 * ledger D-10 for the fold). Every seed is KILLED deterministically by
 * the FIRST detector: the exact-authority assertion, the no-folding law,
 * or the FRF-WP03 validator's duplicate/drift fences.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedIdSetsFixture,
  acceptedSurfacesOf,
  cellModule,
  clone,
  freezeAccepted,
} from './support.mjs';

/** Re-seal a tampered baseline so ONLY the exact-authority fence can kill it. */
async function reseal(baseline) {
  const shared = await cellModule('shared');
  baseline.wholeWhatDigest = shared.digestExcluding(baseline, ['wholeWhatDigest']);
  return baseline;
}

test('RED SEED (substituted member): same id, different content digest, every digest recomputed - still killed', async () => {
  const ingestion = await cellModule('ingestion');
  const frozen = await freezeAccepted();
  const tampered = clone(frozen.baseline);
  // Substitute one PRD member's payload digest with a well-formed foreign
  // digest and RECOMPUTE all container-level and whole-WHAT digests so no
  // naive digest check fires - only the exact-authority pin can see it.
  tampered.containers.prd.members[0].digest = 'f'.repeat(64);
  await reseal(tampered);
  const refusal = ingestion.verifyPresentedBaseline(tampered, acceptedSurfacesOf());
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
  assert.match(refusal.detail, /substituted member payload is refused/);
});

test('RED SEED (substituted member via surfaces): a well-formed foreign member swapped into the accepted manifest is refused', async () => {
  const surfaces = acceptedSurfacesOf();
  // Swap one UC scenario for a semantically well-formed foreign scenario
  // from "another run": fresh id, fresh digests, branches intact (no
  // duplicate-digest shortcut). The frozen member universe refuses the
  // cross-run substitution: the accepted trace/evidence surfaces still
  // cite the original scenario id.
  const foreign = clone(surfaces.containers.uc.members[1]);
  foreign.scenarioId = 'uc:FOREIGN-run-9';
  foreign.digest = 'a1'.padEnd(64, 'b');
  foreign.branches = foreign.branches.map((branch, index) => ({ ...branch, branchId: branch.branchId, digest: (index === 0 ? 'c2' : 'c3').padEnd(64, 'd') }));
  surfaces.containers.uc.members[0] = foreign;
  const result = await freezeAccepted(surfaces);
  assert.equal(result.refusal.ok, false);
  assert.equal(result.refusal.reason, 'FOREIGN_LINEAGE');
  assert.match(result.refusal.detail, /outside the frozen member universe|outside the exact accepted/);
});

test('RED SEED (folded section): the disposition records folded AWAY (sections emptied) are refused (F-8)', async () => {
  const ingestion = await cellModule('ingestion');
  const frozen = await freezeAccepted();
  const folded = clone(frozen.baseline);
  // Fold = LOSS: the constraint and deferred records vanish from their
  // named sections (the legacy fold's shape - their semantics were never
  // carried anywhere else). Re-seal so only the no-folding law can kill.
  folded.dispositions.constraint = [];
  folded.dispositions.deferred = [];
  await reseal(folded);
  const refusal = ingestion.verifyPresentedBaseline(folded, acceptedSurfacesOf());
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
  assert.match(refusal.detail, /did not survive into the baseline's own|folding/i);
});

test('RED SEED (folded section, evidence): folding the evidence-method bindings into the trace set is refused', async () => {
  const ingestion = await cellModule('ingestion');
  const frozen = await freezeAccepted();
  const folded = clone(frozen.baseline);
  folded.evidenceBindings = folded.evidenceBindings.slice(0, 1);
  await reseal(folded);
  const refusal = ingestion.verifyPresentedBaseline(folded, acceptedSurfacesOf());
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
  assert.match(refusal.detail, /evidence-method bindings/);
});

test('RED SEED (duplicate digest): two accepted members sharing one content digest are double emission, refused DRIFT_DETECTED', async () => {
  const surfaces = acceptedSurfacesOf();
  // The accepted manifest itself was corrupted: a substituted or
  // double-emitted artifact carries another member's digest.
  surfaces.containers.fr.members[1].digest = surfaces.containers.fr.members[0].digest;
  const result = await freezeAccepted(surfaces);
  assert.equal(result.outcome, 'drift-detected');
  assert.equal(result.refusal.reason, 'DRIFT_DETECTED');
  assert.match(result.refusal.detail, /digest\(s\).*appear more than once|substituted or emitted twice/);
  assert.equal(result.wait.kind, 'TypedWait:effect-uncertainty');
});

test('RED SEED (stale container revision): a container revision that is not the accepted pin is refused STALE_LINEAGE', async () => {
  const ingestion = await cellModule('ingestion');
  const frozen = await freezeAccepted();
  const tampered = clone(frozen.baseline);
  tampered.containers.ac.revisionDigest = 'e'.repeat(64);
  await reseal(tampered);
  const refusal = ingestion.verifyPresentedBaseline(tampered, acceptedSurfacesOf());
  assert.equal(refusal.reason, 'STALE_LINEAGE');
  assert.match(refusal.detail, /accepted revision/);
});

test('the accepted-id-sets fixture universe equals the universe the cell derives from the surfaces', async () => {
  const ingestion = await cellModule('ingestion');
  const fixture = acceptedIdSetsFixture();
  const derived = ingestion.universeOfSurfaces(acceptedSurfacesOf());
  assert.equal(derived.ok, true);
  // The what-baseline-relevant sets: the WP03 validator's required id
  // sets + the branch map (the fixture also carries other contracts'
  // sets: briefRefs, verifiableStatementIds, verificationSurfaceIds).
  const baselineSets = [
    'sourceClaimIds', 'sourceConstraintIds', 'terminalClaimIds',
    'prdMemberIds', 'ucScenarioIds', 'frIds', 'nfrIds', 'ruleIds',
    'criterionIds', 'evidenceBindingIds',
  ];
  for (const setName of baselineSets) {
    assert.deepEqual([...derived.universe.idSets[setName]].sort(), [...fixture.idSets[setName]].sort(), setName);
  }
  assert.deepEqual(derived.universe.caseIdentity, fixture.caseIdentity);
  assert.deepEqual(Object.keys(derived.universe.revisionPins).sort(), Object.keys(fixture.revisionPins).sort());
});

test('the ingestion carries no scan path: every lookup is over the supplied surfaces (structural law)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../../../../../src/workflow-kernel/workshops/formalization/cells/what-freeze/ingestion.mjs', import.meta.url),
    'utf8',
  )
    // Judge CODE, not prose: strip comments before scanning (repo pattern).
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const scanLike = /latest|byStatus|byLifecycle|byEpic|byChronology|maxId|reparse|SELECT\b/i;
  assert.equal(scanLike.test(source), false, 'the ingestion must contain no scan/reselection vocabulary');
});
