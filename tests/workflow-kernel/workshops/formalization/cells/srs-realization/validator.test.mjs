/**
 * validator.test.mjs - FRF-WP08 realization-section validator family:
 * every frozen UC scenario survives through the SRS realized scenarios,
 * realizedScenarioIds resolve against the frozen scenario id set, evidence
 * bindings resolve against the frozen set, digests verify, and the runtime
 * graph is connected (killed mutation family: realization validator).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cell,
  greenFixture,
  killCoverageGap,
  killDuplicateEntryId,
  killDuplicateRealization,
  killEntrypointNotParticipating,
  killForeignEvidence,
  killForeignScenario,
  killRemovedInputToControllerEdge,
  killRemovedStateToRendererEdge,
  killStaleBaselinePin,
  killTamperedRealizationDigest,
} from './support.mjs';

/** Parse a mutated draft and validate the SECTION against the green universe. */
function sectionVerdict(draftMutator) {
  const g = greenFixture();
  const parsed = cell.parseSrsRealizationDraft(draftMutator(g));
  if (!parsed.ok) return parsed;
  return cell.validateSrsRealization(parsed.section, g.universe);
}

const assertRefused = (outcome, reason, detailPart) => {
  assert.equal(outcome.ok, false, `expected refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
  assert.equal(outcome.reason, reason);
  if (detailPart !== undefined) assert.ok(outcome.detail.includes(detailPart), `detail "${outcome.detail}" should mention "${detailPart}"`);
};

test('GREEN: the Elite section validates against the frozen universe and seals its artifact', () => {
  const g = greenFixture();
  const verdict = cell.validateSrsRealization(g.section, g.universe);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.artifact.digest, g.section.realizationDigest);
  assert.equal(verdict.artifact.ref, `sha256:${g.section.realizationDigest}`);
});

test('GREEN: realizedScenarioIds equal the frozen scenario id set exactly', () => {
  const g = greenFixture();
  assert.deepEqual([...cell.realizedScenarioIdsOf(g.section)].sort(), [...g.universe.idSets.ucScenarioIds].sort());
});

test('fail-closed: a missing universe is a typed MISSING_LINEAGE refusal (the WP03 seam)', () => {
  const g = greenFixture();
  assertRefused(cell.validateSrsRealization(g.section, undefined), 'MISSING_LINEAGE', 'fail-closed');
  assertRefused(cell.validateSrsRealization(g.section, {}), 'MISSING_LINEAGE', 'ucScenarioIds');
  assertRefused(cell.validateSrsRealization(g.section, { idSets: { ucScenarioIds: ['uc:elite-interactive'] } }), 'MISSING_LINEAGE', 'evidenceBindingIds');
  assertRefused(
    cell.validateSrsRealization(g.section, { idSets: { ucScenarioIds: ['uc:elite-interactive'], evidenceBindingIds: ['ev:elite-browser-smoke'] } }),
    'MISSING_LINEAGE',
    'whatBaselineDigest',
  );
});

test('fail-closed: an empty frozen scenario set is refused (the validator never guesses the universe)', () => {
  const g = greenFixture();
  const emptyUniverse = { ...g.universe, idSets: { ...g.universe.idSets, ucScenarioIds: [] } };
  assertRefused(cell.validateSrsRealization(g.section, emptyUniverse), 'MISSING_LINEAGE', 'ucScenarioIds');
});

test('RED: a frozen scenario with no realization entry is COVERAGE_GAP', () => {
  const verdict = sectionVerdict(killCoverageGap);
  assertRefused(verdict, 'COVERAGE_GAP', 'uc:elite-batch');
});

test('RED: a realized scenario outside the frozen id set is FOREIGN_LINEAGE', () => {
  const verdict = sectionVerdict(killForeignScenario);
  assertRefused(verdict, 'FOREIGN_LINEAGE', 'uc:foreign-run-1');
});

test('RED: an evidence binding outside the frozen set is FOREIGN_LINEAGE', () => {
  const verdict = sectionVerdict(killForeignEvidence);
  assertRefused(verdict, 'FOREIGN_LINEAGE', 'ev:foreign-evidence-1');
});

test('RED: a scenario realized twice is refused (every frozen required UC exactly once)', () => {
  const verdict = sectionVerdict(killDuplicateRealization);
  assertRefused(verdict, 'MALFORMED_PRODUCT', 'realized more than once');
});

test('RED: a duplicated realization entry id is DRIFT_DETECTED', () => {
  const verdict = sectionVerdict(killDuplicateEntryId);
  assertRefused(verdict, 'DRIFT_DETECTED', 'appears more than once');
});

test('RED: a stale WHAT baseline pin is STALE_LINEAGE (the SRS derives from the frozen baseline only)', () => {
  const verdict = sectionVerdict(killStaleBaselinePin);
  assertRefused(verdict, 'STALE_LINEAGE', 'frozen baseline');
});

test('RED: a tampered realization digest is DRIFT_DETECTED', () => {
  const g = greenFixture();
  assertRefused(cell.validateSrsRealization(killTamperedRealizationDigest(g), g.universe), 'DRIFT_DETECTED', 'does not verify');
});

test('RED: removing the input-to-controller runtime edge leaves a disconnected graph (COVERAGE_GAP)', () => {
  const verdict = sectionVerdict(killRemovedInputToControllerEdge);
  assertRefused(verdict, 'COVERAGE_GAP', 'unreachable from the entrypoint');
});

test('RED: removing the state-to-renderer runtime edge leaves a disconnected graph (COVERAGE_GAP)', () => {
  const verdict = sectionVerdict(killRemovedStateToRendererEdge);
  assertRefused(verdict, 'COVERAGE_GAP', 'unreachable from the entrypoint');
});

test('RED: an entrypoint that is not a participating surface is a disconnected graph', () => {
  const verdict = sectionVerdict(killEntrypointNotParticipating);
  assertRefused(verdict, 'COVERAGE_GAP', 'entrypoint surface');
});

test('RED: a wrong schemaVersion on the section is MALFORMED_PRODUCT', () => {
  const g = greenFixture();
  assertRefused(cell.validateSrsRealization({ ...g.section, schemaVersion: 'formalization.srs-realization.v0' }, g.universe), 'MALFORMED_PRODUCT');
});
