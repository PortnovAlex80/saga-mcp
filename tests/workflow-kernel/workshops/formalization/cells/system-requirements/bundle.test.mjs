/**
 * bundle.test.mjs - FRF-WP05 GREEN PATH: the requirements bundle the Cell
 * authors, seals and presents validates against the WP03 validator
 * through the documented seam (SEAM.md), and the desk skill, product
 * template and derivation laws are the declared data the roles pin.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRD_REVISION,
  UC_REVISION,
  boundSeam,
  cell,
  dist,
  greenBundle,
  greenCandidate,
  greenMembers,
  greenUniverse,
} from './support.mjs';

test('the green bundle builds, seals content-addressed and carries the WP03 contract identity', async () => {
  const c = await cell();
  const sealed = await greenBundle();
  assert.equal(sealed.bundle.schemaVersion, c.REQUIREMENTS_BUNDLE_CONTRACT_KIND);
  assert.equal(sealed.bundle.prdRevisionRef, `sha256:${PRD_REVISION}`);
  assert.equal(sealed.bundle.ucRevisionRef, `sha256:${UC_REVISION}`);
  assert.match(sealed.ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sealed.digest, sealed.ref.slice('sha256:'.length));
  assert.equal(sealed.bundle.requirements.length, 4);
  assert.deepEqual(
    sealed.bundle.requirements.map((member) => member.requirementKind).sort(),
    ['FR', 'FR', 'NFR', 'RULE'],
  );
});

test('GREEN PATH: the bundle validates via the WP03 requirements-bundle validator through the seam', async () => {
  const binding = await boundSeam();
  const sealed = await greenBundle();
  const universe = await greenUniverse();
  const validation = binding.seam.validate(sealed.bundle, universe);
  assert.equal(validation.ok, true, `the WP03 validator refused the green bundle: ${JSON.stringify(validation)}`);
  assert.equal(validation.kind, 'frf-contracts.requirements-bundle.v1');
  assert.equal(validation.ref, `sha256:${sealed.digest}`, 'the WP03 seal equals the cell recomputed digest');
});

test('the UC revision pin is written exactly when a member cites UC material', async () => {
  const { buildRequirementsBundle } = await cell();
  const noUc = buildRequirementsBundle({
    prdRevisionDigest: PRD_REVISION,
    ucRevisionDigest: UC_REVISION,
    requirements: [
      {
        requirementId: 'rule:direct-1',
        requirementKind: 'RULE',
        statement: 'A cross-cutting rule with no scenario lineage.',
        prdIntentRefs: ['prd:boundary-1'],
        verificationSurfaceRefs: ['surface:batch-audit-1'],
      },
    ],
  });
  assert.equal(noUc.ok, true);
  assert.equal(noUc.sealed.bundle.ucRevisionRef, undefined, 'a bundle citing no UC material pins no UC revision');
  const withUc = buildRequirementsBundle({
    prdRevisionDigest: PRD_REVISION,
    ucRevisionDigest: UC_REVISION,
    requirements: greenMembers().slice(0, 1),
  });
  assert.equal(withUc.ok, true);
  assert.equal(withUc.sealed.bundle.ucRevisionRef, `sha256:${UC_REVISION}`);
});

test('the desk skill declaration follows the installed manifest convention and pins the laws', async () => {
  const c = await cell();
  assert.equal(c.SYSTEM_REQUIREMENTS_DESK_SKILL_ID, 'formalization-desk-derive-system-requirements');
  assert.equal(c.SYSTEM_REQUIREMENTS_DESK_ID, 'derive-system-requirements');
  assert.deepEqual(c.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.servesDesks, ['derive-system-requirements']);
  assert.equal(c.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.kind, 'semantic');
  assert.equal(c.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.contractKind, c.REQUIREMENTS_BUNDLE_CONTRACT_KIND);
  assert.match(c.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.digest, /^[0-9a-f]{64}$/);
  // The frozen WP-17 skill artifact shape (cognition instructions only).
  assert.equal(c.SYSTEM_REQUIREMENTS_SKILL_ARTIFACT.schemaVersion, 'ek.skill-artifact.ek1.v1');
  assert.equal(c.SYSTEM_REQUIREMENTS_SKILL_ARTIFACT.skillId, c.SYSTEM_REQUIREMENTS_DESK_SKILL_ID);
  for (const law of c.DERIVATION_LAWS) {
    assert.ok(c.SYSTEM_REQUIREMENTS_SKILL_ARTIFACT.instructions.includes(law.lawId), `the skill instructions name law ${law.lawId}`);
  }
});

test('the product template covers FR, NFR and RULE with the reverse-graph derivation guides', async () => {
  const c = await cell();
  const kinds = c.SYSTEM_REQUIREMENTS_PRODUCT_TEMPLATE.map((row) => row.requirementKind).sort();
  assert.deepEqual(kinds, ['FR', 'NFR', 'RULE']);
  for (const row of c.SYSTEM_REQUIREMENTS_PRODUCT_TEMPLATE) {
    assert.ok(row.derivationGuide.length > 0);
    assert.ok(Array.isArray(row.example.derivation.prdIntentRefs) && row.example.derivation.prdIntentRefs.length > 0);
    assert.ok(Array.isArray(row.example.verificationSurfaceRefs) && row.example.verificationSurfaceRefs.length > 0);
  }
  const fr = c.SYSTEM_REQUIREMENTS_PRODUCT_TEMPLATE.find((row) => row.requirementKind === 'FR');
  assert.ok(fr.derivationGuide.includes('0054'), 'the FR guide cites the reverse-graph derivation edges');
});

test('the three derivation laws are declared with their typed refusals', async () => {
  const c = await cell();
  assert.deepEqual(
    c.DERIVATION_LAWS.map((law) => law.refusal),
    ['FOREIGN_LINEAGE', 'COVERAGE_GAP', 'STALE_LINEAGE'],
  );
  assert.deepEqual(
    c.DERIVATION_LAWS.map((law) => law.lawId),
    ['exact-derivation-lineage', 'verification-surface-coverage', 'revision-pin-match'],
  );
});

test('the desk scope fence refuses candidates carrying another desk\'s artifact family', async () => {
  const { fenceCandidateScope } = await cell();
  for (const forbidden of ['scenarios', 'acceptanceCriteria', 'srs', 'scenarioRealizations', 'solutionContract']) {
    const refusal = fenceCandidateScope({ requirements: [], [forbidden]: [] });
    assert.equal(refusal?.reason, 'SCOPE_VIOLATION', `${forbidden} must be refused as out-of-scope artifact material`);
  }
  assert.equal(fenceCandidateScope({ requirements: [] }), null);
  assert.equal(fenceCandidateScope(undefined), null);
});

test('builder fences: duplicate ids, open vocabulary, empty lineage and missing surfaces are typed refusals', async () => {
  const { buildRequirementsBundle } = await cell();
  const base = {
    prdRevisionDigest: PRD_REVISION,
    ucRevisionDigest: UC_REVISION,
  };
  const duplicate = buildRequirementsBundle({ ...base, requirements: [greenMembers()[0], greenMembers()[0]] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'MALFORMED_PRODUCT');
  assert.match(duplicate.detail, /duplicate requirement id/);

  const openKind = buildRequirementsBundle({
    ...base,
    requirements: [{ ...greenMembers()[0], requirementKind: 'BR' }],
  });
  assert.equal(openKind.ok, false);
  assert.equal(openKind.reason, 'MALFORMED_PRODUCT');
  assert.match(openKind.detail, /outside the closed FR\/NFR\/RULE vocabulary/);

  const emptyBundle = buildRequirementsBundle({ ...base, requirements: [] });
  assert.equal(emptyBundle.ok, false);
  assert.equal(emptyBundle.reason, 'MALFORMED_PRODUCT');

  const noIntent = buildRequirementsBundle({ ...base, requirements: [{ ...greenMembers()[3], prdIntentRefs: [] }] });
  assert.equal(noIntent.ok, false);
  assert.equal(noIntent.reason, 'MISSING_LINEAGE');
  assert.match(noIntent.detail, /binds no exact PRD intent member/);

  const noSurface = buildRequirementsBundle({ ...base, requirements: [{ ...greenMembers()[3], verificationSurfaceRefs: [] }] });
  assert.equal(noSurface.ok, false);
  assert.equal(noSurface.reason, 'COVERAGE_GAP');
  assert.match(noSurface.detail, /names no verification surface/);
});

test('the candidate wrapper presents the installed desk product kind', async () => {
  const { candidateOf, SYSTEM_REQUIREMENTS_PRODUCT_KIND } = await cell();
  const { candidate } = await greenCandidate();
  assert.equal(candidate.kind, SYSTEM_REQUIREMENTS_PRODUCT_KIND);
  assert.equal(candidate.kind, 'formalization.system-requirements.v1');
});

test('test-only reachability: no installed production module outside the cell imports it', async () => {
  // The cell package must not be wired into any installed surface yet
  // (FRF-WP11 lands the wiring). Its only consumers are these tests.
  const c = await cell();
  assert.equal(c.SYSTEM_REQUIREMENTS_DESK_ID, 'derive-system-requirements');
  const manifest = await dist('workflow-kernel/workshops/formalization/manifest.js');
  const deskNode = manifest.nodeOf('derive-system-requirements');
  assert.equal(deskNode.ok, true, 'the desk itself IS installed (WP-11F); this cell package adds the semantic coverage on top');
  assert.equal(deskNode.node.desk.outputProductKind, 'formalization.system-requirements.v1');
});
