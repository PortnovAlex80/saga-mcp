/**
 * parser.test.mjs - FRF-WP08 parser family: the deterministic,
 * closed-vocabulary parser of the SRS scenario-realization draft.
 *
 * GREEN: the Elite draft parses to a byte-stable section with a recomputed
 * canonical digest. RED seeds: unknown fields (a flat file list / an AC
 * decomposition substitute), open vocabularies, off-pattern ids, missing
 * fields, self-edges, empty citations, wrong versions - each refused typed
 * MALFORMED_PRODUCT (killed mutation family: parser).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cell,
  greenFixture,
  seedAcDecompositionSubstitute,
  seedFlatFileList,
  seedMissingField,
  seedMissingLineage,
  seedNoImplementationSurfaces,
  seedOffPatternId,
  seedOpenEvidenceKind,
  seedOpenSurfaceKind,
  seedSelfEdge,
  seedSuppliedDigest,
  seedWrongSchemaVersion,
} from './support.mjs';

const refuse = (outcome, detailPart) => {
  assert.equal(outcome.ok, false, `expected a refusal, got ${JSON.stringify(outcome).slice(0, 200)}`);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'MALFORMED_PRODUCT');
  if (detailPart !== undefined) assert.ok(outcome.detail.includes(detailPart), `detail "${outcome.detail}" should mention "${detailPart}"`);
};

test('GREEN: the Elite draft parses and the parse is deterministic (byte-stable)', () => {
  const g = greenFixture();
  const first = cell.parseSrsRealizationDraft(g.draft);
  const second = cell.parseSrsRealizationDraft(JSON.parse(JSON.stringify(g.draft)));
  assert.equal(first.ok, true);
  assert.deepEqual(first.section, second.section);
  assert.equal(first.section.realizationEntries.length, 4);
  assert.equal(first.section.surfaces.length, 15);
  assert.match(first.section.realizationDigest, /^[0-9a-f]{64}$/);
});

test('GREEN: the parsed digest is the recomputed canonical digest (never supplied by the draft)', () => {
  const g = greenFixture();
  const parsed = cell.parseSrsRealizationDraft(g.draft);
  const recomputed = cell.realizationDigestOf(parsed.section);
  assert.equal(parsed.section.realizationDigest, recomputed);
});

test('RED seed: a flat file list inside an entry is refused (unknown field, closed field set)', () => {
  refuse(cell.parseSrsRealizationDraft(seedFlatFileList(greenFixture())), 'unexpected field(s) files');
});

test('RED seed: an AC decomposition presented instead of the realization section is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedAcDecompositionSubstitute(greenFixture())), 'unexpected field(s) criteria');
});

test('RED seed: an open surface-kind vocabulary value is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedOpenSurfaceKind(greenFixture())), 'outside the closed vocabulary');
});

test('RED seed: an open evidence-kind vocabulary value is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedOpenEvidenceKind(greenFixture())), 'outside the closed vocabulary');
});

test('RED seed: an off-pattern surface id is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedOffPatternId(greenFixture())), 'closed identity pattern');
});

test('RED seed: a missing required field is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedMissingField(greenFixture())), 'missing required field(s) terminalResult');
});

test('RED seed: a self-edge in the runtime graph is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedSelfEdge(greenFixture())), 'two distinct surfaces');
});

test('RED seed: a realization citing no implementation surfaces is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedNoImplementationSurfaces(greenFixture())), 'at least one required implementation/integration surface');
});

test('RED seed: a wrong schema version is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedWrongSchemaVersion(greenFixture())), 'formalization.srs-realization.v1');
});

test('RED seed: a draft supplying its own realization digest is refused (the parser seals digests)', () => {
  refuse(cell.parseSrsRealizationDraft(seedSuppliedDigest(greenFixture())), 'unexpected field(s) realizationDigest');
});

test('RED seed: a missing lineage block is refused', () => {
  refuse(cell.parseSrsRealizationDraft(seedMissingLineage(greenFixture())), 'missing required field(s) lineage');
});

test('RED seed: a non-object draft is refused', () => {
  refuse(cell.parseSrsRealizationDraft(null), 'not an object');
  refuse(cell.parseSrsRealizationDraft('srs'), 'not an object');
});

test('RED seed: an empty realization section does not parse', () => {
  const g = greenFixture();
  refuse(cell.parseSrsRealizationDraft({ ...g.draft, realizationEntries: [] }), 'realizes at least one scenario');
  refuse(cell.parseSrsRealizationDraft({ ...g.draft, surfaces: [] }), 'declares at least one architecture surface');
});
