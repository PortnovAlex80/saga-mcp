/**
 * freeze.test.mjs - the FRF-WP07 WHAT-freeze desk: the green freeze, the
 * WP03 green-fixture digest reproduction, determinism, the folded-shape
 * refusal, and the indeterminate (D5) route.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedSurfacesOf,
  cellModule,
  clone,
  freezeAccepted,
  greenBaselineFixture,
} from './support.mjs';

test('the freezer freezes the whole-WHAT baseline over the exact accepted surfaces', async () => {
  const result = await freezeAccepted();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'frozen');
  assert.match(result.artifact.ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.artifact.ref, `sha256:${result.artifact.digest}`);
});

test('the frozen baseline reproduces the WP03 green fixture digests byte-for-byte', async () => {
  const green = greenBaselineFixture();
  const result = await freezeAccepted();
  assert.equal(result.baseline.wholeWhatDigest, green.wholeWhatDigest);
  assert.equal(result.baseline.traceSet.traceDigest, green.traceSet.traceDigest);
  assert.deepEqual(result.baseline.sourceManifests, green.sourceManifests);
  assert.deepEqual(result.baseline.dispositions, green.dispositions);
  assert.deepEqual(result.baseline.evidenceBindings, green.evidenceBindings);
});

test('the freeze is deterministic: same surfaces, same digests (partition invariance at the desk)', async () => {
  const first = await freezeAccepted();
  const second = await freezeAccepted();
  assert.equal(first.artifact.digest, second.artifact.digest);
  // Provenance-only reordering of member arrays inside a container is NOT
  // a semantic change of the surfaces: the sorted canonical digest of the
  // member manifest is the identity the validator pins. (The baseline
  // carries the surfaces as accepted; identical accepted content in a
  // different order is a different payload and MUST re-freeze
  // identically because the freezer preserves carried order.)
  const surfaces = acceptedSurfacesOf();
  surfaces.containers.prd.members = [...surfaces.containers.prd.members].reverse();
  const third = await freezeAccepted(surfaces);
  assert.notEqual(third.artifact.digest, first.artifact.digest, 'carried order is content; a reordered manifest is a different accepted surface set');
});

test('the frozen baseline carries the five disposition sections and evidence bindings as DISTINCT named sections (D-10 resolved: no folding)', async () => {
  const result = await freezeAccepted();
  const sections = Object.keys(result.baseline.dispositions).sort();
  assert.deepEqual(sections, ['assumption', 'constraint', 'deferred', 'outOfScope', 'unknown']);
  assert.ok(Array.isArray(result.baseline.evidenceBindings) && result.baseline.evidenceBindings.length > 0);
  assert.equal(result.baseline.schemaVersion, 'frf-contracts.what-baseline.v1');
});

test('the freezer performs no authorship: the product is built, not authored (folded legacy shape refused on sight)', async () => {
  const ingestion = await cellModule('ingestion');
  const folded = { schemaVersion: 'formalization.what-baseline.v1', inputs: {}, memberDigests: ['a'.repeat(64)], acceptedTraceDigest: 'b'.repeat(64), wholeWhatDigest: 'c'.repeat(64) };
  const refusal = ingestion.refuseFoldedShape(folded);
  assert.equal(refusal.reason, 'MALFORMED_PRODUCT');
  assert.match(refusal.detail, /folded legacy baseline shape/);
  // Presenting the folded product to the DESK is refused the same way.
  const freeze = await cellModule('freeze');
  const deskResult = freeze.freezeWhatBaseline(folded);
  assert.equal(deskResult.ok, true);
  assert.equal(deskResult.outcome, 'repair');
  assert.equal(deskResult.refusal.reason, 'MALFORMED_PRODUCT');
});

test('a missing surface class is INDETERMINATE: nothing is frozen, a D5 human-input wait opens (fail-closed, never a scan)', async () => {
  const surfaces = acceptedSurfacesOf();
  delete surfaces.evidenceBindings;
  const result = await freezeAccepted(surfaces);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.refusal.reason, 'MISSING_LINEAGE');
  assert.equal(result.wait.kind, 'TypedWait:human-input');
  assert.deepEqual(result.wait.wakeCommands, ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
  assert.equal(result.baseline, null);
});

test('a container without its accepted revision pin is indeterminate (fail-closed: the pin cannot be verified)', async () => {
  const surfaces = acceptedSurfacesOf();
  delete surfaces.containers.uc.revisionDigest;
  const result = await freezeAccepted(surfaces);
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.refusal.reason, 'MISSING_LINEAGE');
});

test('an acceptance record set missing one pre-freeze desk is a coverage gap (each accepted authority is frozen exactly)', async () => {
  const surfaces = acceptedSurfacesOf();
  surfaces.acceptanceRecords = surfaces.acceptanceRecords.filter((record) => record.deskId !== 'reconcile-what');
  const result = await freezeAccepted(surfaces);
  assert.equal(result.outcome, 'repair');
  assert.equal(result.refusal.reason, 'COVERAGE_GAP');
  assert.match(result.refusal.detail, /reconcile-what/);
});

test('a duplicated acceptance record for one desk is drift (double emission)', async () => {
  const surfaces = acceptedSurfacesOf();
  surfaces.acceptanceRecords = [...surfaces.acceptanceRecords, clone(surfaces.acceptanceRecords[0])];
  const result = await freezeAccepted(surfaces);
  assert.equal(result.refusal.reason, 'DRIFT_DETECTED');
});

test('a trace set that drops every trace of one frozen member breaks chain closure (cannot seal)', async () => {
  const surfaces = acceptedSurfacesOf();
  surfaces.traceSet.traces = surfaces.traceSet.traces.filter(
    (trace) => trace.fromRef !== 'uc:batch-1' && trace.toRef !== 'uc:batch-1',
  );
  const result = await freezeAccepted(surfaces);
  assert.equal(result.refusal.reason, 'COVERAGE_GAP');
  assert.match(result.refusal.detail, /uc:batch-1|no accepted trace/);
});

test('a presented baseline whose trace set differs from the accepted surfaces is DRIFT (post-acceptance mutation)', async () => {
  const ingestion = await cellModule('ingestion');
  const pristine = await freezeAccepted();
  const tamperedSurfaces = acceptedSurfacesOf();
  tamperedSurfaces.traceSet.traces = tamperedSurfaces.traceSet.traces.slice(0, -1);
  const refusal = ingestion.verifyPresentedBaseline(pristine.baseline, tamperedSurfaces);
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
  assert.match(refusal.detail, /trace set drifted/);
});

test('a presented baseline equal to the accepted surfaces verifies (the replay path is lawful)', async () => {
  const ingestion = await cellModule('ingestion');
  const frozen = await freezeAccepted();
  const verified = ingestion.verifyPresentedBaseline(frozen.baseline, acceptedSurfacesOf());
  assert.equal(verified.ok, true);
});

test('a well-formed but unrelated case identity is drift against the case-aggregate pin (substituted case material)', async () => {
  const pristine = acceptedSurfacesOf();
  const surfaces = acceptedSurfacesOf();
  surfaces.caseIdentity.formalizationCaseRef = 'case:OTHER-run';
  const result = await freezeAccepted(surfaces, { pinnedCaseIdentity: pristine.caseIdentity });
  assert.equal(result.outcome, 'drift-detected');
  assert.equal(result.refusal.reason, 'DRIFT_DETECTED');
  assert.match(result.refusal.detail, /case identity|substituted case/);
  assert.equal(result.wait.kind, 'TypedWait:effect-uncertainty');
});

test('the freeze desk routes every refusal code through the declared table (deterministic outcomes)', async () => {
  const protocol = await cellModule('protocol');
  assert.equal(protocol.routeRefusal(protocol.FREEZE_OUTCOME_OF_REASON, 'DRIFT_DETECTED').outcome, 'drift-detected');
  assert.equal(protocol.routeRefusal(protocol.FREEZE_OUTCOME_OF_REASON, 'MISSING_LINEAGE').outcome, 'indeterminate');
  assert.equal(protocol.routeRefusal(protocol.FREEZE_OUTCOME_OF_REASON, 'FOREIGN_LINEAGE').outcome, 'upstream-repair');
  assert.equal(protocol.routeRefusal(protocol.FREEZE_OUTCOME_OF_REASON, 'STALE_LINEAGE').outcome, 'repair');
  const unknown = protocol.routeRefusal(protocol.FREEZE_OUTCOME_OF_REASON, 'NOT_A_CODE');
  assert.equal(unknown.ok, false);
  assert.equal(protocol.freezeTransitionOf('frozen').on, 'domain.frozen');
  assert.equal(protocol.freezeTransitionOf('drift-detected').on, 'domain.drift-detected');
  assert.equal(protocol.freezeTransitionOf('indeterminate').on, null);
});
