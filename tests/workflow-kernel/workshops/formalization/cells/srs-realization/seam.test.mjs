/**
 * seam.test.mjs - FRF-WP08: the WP03 VALIDATOR SEAM, documented and pinned.
 *
 * The seam (frozen by FRF-WP03 and now OWNED by this cell):
 *   1. The what-baseline schema declares three postFreeze.srs.* resolution
 *      surfaces (postFreeze.srs.realizationEntryIds / revisionDigest /
 *      surfaces). This cell's contract exposes EXACTLY those three named
 *      surfaces, verified against its own section content.
 *   2. The baseline's developmentSurface maps the SRS-dependent handoff
 *      binding kinds and WorkItem obligation kinds onto those surfaces;
 *      this cell materializes them (realization entry ids, surface ids,
 *      the accepted SRS revision digest).
 *   3. The trace grammar rule srs-derived-from-frozen-what-baseline (noted
 *      WP07/WP08-owned in WP03) is this cell's lineage rule, enforced by
 *      the STALE_LINEAGE baseline pin fence.
 *   4. Every validator is fail-closed on the accepted universe (MISSING
 *      LINEAGE, never a guess).
 *   5. The surface-kind vocabulary is exactly the reverse graph's
 *      composition + infrastructure obligation families.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { cell, docsPath, greenFixture } from './support.mjs';

const baselineSchema = JSON.parse(readFileSync(docsPath('refactoring/formalization-frf/contracts/schemas/what-baseline.schema.json'), 'utf8'));
const greenBaseline = JSON.parse(readFileSync(docsPath('refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json'), 'utf8'));
const reverseGraph = JSON.parse(readFileSync(docsPath('refactoring/formalization-frf/graphs/reverse/reverse-graph.json'), 'utf8'));

test('SEAM 1: the cell exposes exactly the three postFreeze.srs.* surfaces the WP03 schema declares', () => {
  const enumSurfaces = baselineSchema.$defs.handoffSurfaceEntry.properties.resolvesAgainst.items.enum
    .filter((surface) => surface.startsWith('postFreeze.srs.'));
  assert.deepEqual([...enumSurfaces].sort(), [...cell.POST_FREEZE_SRS_SURFACES].sort());
  const g = greenFixture();
  assert.deepEqual(Object.keys(g.contract.postFreeze).sort(), ['realizationEntryIds', 'revisionDigest', 'surfaces']);
});

test('SEAM 2: the baseline maps the SRS-dependent binding/obligation kinds onto the surfaces this cell materializes', () => {
  const handoff = greenBaseline.developmentSurface.handoffBindingKinds;
  assert.deepEqual([...handoff['scenario-realization-bindings'].resolvesAgainst], ['postFreeze.srs.realizationEntryIds']);
  assert.deepEqual([...handoff['srs-reference-and-hash'].resolvesAgainst], ['postFreeze.srs.revisionDigest']);
  assert.deepEqual([...handoff['integration-and-construction-obligations'].resolvesAgainst].sort(), ['postFreeze.srs.realizationEntryIds', 'postFreeze.srs.surfaces']);
  const obligations = greenBaseline.developmentSurface.workItemObligationKinds;
  assert.deepEqual([...obligations['scenario-realization-obligation'].resolvesAgainst], ['postFreeze.srs.realizationEntryIds']);
  assert.deepEqual([...obligations['integration-or-composition-obligation'].resolvesAgainst], ['postFreeze.srs.realizationEntryIds']);
  assert.deepEqual([...obligations['infrastructure-obligation'].resolvesAgainst], ['postFreeze.srs.surfaces']);

  // And this cell's contract actually materializes those surfaces with the
  // exact accepted content (validated by the contract validator).
  const g = greenFixture();
  assert.deepEqual(
    [...g.contract.postFreeze.realizationEntryIds].sort(),
    [...g.contract.realization.realizationEntries.map((entry) => entry.realizationEntryId)].sort(),
  );
  assert.deepEqual(
    [...g.contract.postFreeze.surfaces].sort(),
    [...g.contract.realization.surfaces.map((surface) => surface.surfaceId)].sort(),
  );
  assert.equal(g.contract.postFreeze.revisionDigest, g.universe.revisionPins.srsRevisionDigest);
});

test('SEAM 3: the trace rule srs-derived-from-frozen-what-baseline is the WP03 grammar entry and this cell pins it', () => {
  const traceKinds = baselineSchema.$defs.traceRecord.properties.kind.enum;
  assert.ok(traceKinds.includes(cell.SRS_TRACE_RULE));
  const g = greenFixture();
  assert.equal(g.contract.lineage.traceRule, cell.SRS_TRACE_RULE);
  assert.equal(g.contract.realization.lineage.traceRule, cell.SRS_TRACE_RULE);
  assert.equal(g.contract.lineage.baselineRef, `sha256:${g.universe.revisionPins.whatBaselineDigest}`);
});

test('SEAM 4: every validator of the cell is fail-closed on the accepted universe (MISSING_LINEAGE, never a guess)', () => {
  const g = greenFixture();
  for (const validator of [cell.validateSrsRealization, cell.validateArchitectureContract]) {
    const subject = validator === cell.validateSrsRealization ? g.section : g.contract;
    const refusal = validator(subject, undefined);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.reason, 'MISSING_LINEAGE');
    assert.ok(refusal.detail.includes('fail-closed'), refusal.detail);
  }
});

test('SEAM 5: the surface-kind vocabulary is exactly the reverse graph composition + infrastructure obligation families', () => {
  const nodeKinds = Object.keys(reverseGraph.vocabularies.nodeKinds);
  assert.ok(nodeKinds.includes('composition-obligation'));
  assert.ok(nodeKinds.includes('construction-obligation'));
  const obligationKinds = Object.keys(reverseGraph.vocabularies.workItemObligationKinds.values);
  assert.deepEqual([...cell.ARCHITECTURE_SURFACE_KINDS].sort(), ['composition', 'infrastructure']);
  assert.deepEqual([...cell.CONTRACT_OBLIGATION_KINDS].sort(), ['infrastructure-obligation', 'integration-or-composition-obligation']);
  for (const kind of cell.CONTRACT_OBLIGATION_KINDS) {
    assert.ok(obligationKinds.includes(kind), `obligation kind ${kind} must be a reverse-graph WorkItem obligation kind`);
  }
  const { integrationOrComposition, infrastructure } = greenFixture().contract.developmentObligations;
  assert.ok(integrationOrComposition.length > 0 && infrastructure.length > 0);
});

test('SEAM: the evidence-kind vocabulary is the WP03 frozen four', () => {
  const evidenceKinds = baselineSchema.$defs.evidenceBindingRecord.properties.evidenceKind.enum;
  assert.deepEqual([...cell.REALIZATION_EVIDENCE_KINDS].sort(), [...evidenceKinds].sort());
});

test('SEAM: the id pattern is the WP03 frozen identity shape', () => {
  const pattern = baselineSchema.$defs.idDigestMember.properties.memberId.pattern;
  assert.equal(cell.ID_PATTERN.source, pattern);
  assert.ok(cell.ID_PATTERN.test('arch:elite-browser-bootstrap'));
  assert.ok(cell.ID_PATTERN.test('realization:elite-interactive'));
  assert.ok(!cell.ID_PATTERN.test('srs-realization:elite'), 'hyphenated prefixes are outside the frozen pattern');
});
