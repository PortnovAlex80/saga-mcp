/**
 * red-seeds.test.mjs - FRF-WP05 RED seeds: every derivation law has a
 * failing seed that the Cell's checks refuse with the EXACT typed refusal
 * and the WP03 validator (through the seam) refuses typed as well. The
 * committed FRF-WP03 red-seed corpus (fixtures 15-22) is replayed through
 * the Cell's gate: every seed is refused, never accepted.
 *
 * Seeds (one per law + the assignment's list):
 *   - foreign derivation refs          -> FOREIGN_LINEAGE (law L1)
 *   - missing verification surface     -> COVERAGE_GAP    (law L2)
 *   - stale revision pin               -> STALE_LINEAGE   (law L3)
 *   - open requirement-kind vocabulary -> MALFORMED_PRODUCT
 *   plus: foreign UC scenario, foreign verification surface, scenario-FR
 *   without branch lineage, cross-level branch citation, UC coverage gap.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRD_REVISION,
  UC_REVISION,
  WP03_REQ_RED_SEEDS,
  boundSeam,
  cell,
  greenBundle,
  greenMembers,
  greenUniverse,
  wp03DeskInput,
  wp03Fixture,
} from './support.mjs';

/** The cell gate entry point with the declared provider + bound seam. */
async function gateWithSeam() {
  const c = await cell();
  const declared = c.declaredSystemRequirementsProvider();
  assert.equal(declared.ok, true);
  const seam = await boundSeam();
  return { c, provider: declared.provider, seam };
}

/** Mutate one member of the green bundle (index 0 = the checkout FR). */
async function mutatedBundle(mutate) {
  const sealed = await greenBundle();
  const requirements = sealed.bundle.requirements.map((member, index) =>
    index === 0 ? mutate(structuredClone(member)) : structuredClone(member),
  );
  return { ...sealed.bundle, requirements };
}

async function assertRefused(mutated, expectedReason, expectedCheck) {
  const { c, provider, seam } = await gateWithSeam();
  const universe = await greenUniverse();
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: mutated }, universe, seam);
  assert.equal('refused' in outcome, false, `gate evaluation itself must decide: ${JSON.stringify(outcome)}`);
  assert.notEqual(outcome.verdict, 'accepted');
  const failing = outcome.results.find((result) => result.checkId === expectedCheck);
  assert.equal(failing.outcome, 'fail', `${expectedCheck} must fail`);
  assert.equal(failing.reason, expectedReason, `${expectedCheck} carries the typed law refusal`);
  // The WP03 validator (the typed-refusal authority) refuses the same
  // bundle typed as well.
  const validation = seam.seam.validate(mutated, universe);
  assert.equal(validation.ok, false, 'the WP03 validator must refuse the seed');
  return outcome;
}

/* ---------------- law L1: foreign derivation refs ---------------- */

test('RED seed: a foreign PRD intent ref is refused FOREIGN_LINEAGE by the check AND the WP03 validator', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, derivation: { ...member.derivation, prdIntentRefs: ['prd:ghost'] } }));
  const outcome = await assertRefused(mutated, 'FOREIGN_LINEAGE', 'system-requirements.check.derivation-lineage');
  assert.equal(outcome.verdict, 'upstream-repair', 'foreign lineage belongs to the owning upstream material');
});

test('RED seed: a foreign UC scenario ref is refused FOREIGN_LINEAGE', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, derivation: { ...member.derivation, ucScenarioRefs: ['uc:ghost'] } }));
  await assertRefused(mutated, 'FOREIGN_LINEAGE', 'system-requirements.check.derivation-lineage');
});

test('RED seed: a cross-level branch citation is refused FOREIGN_LINEAGE', async () => {
  // The checkout FR cites batch-main, a branch owned by uc:batch-1.
  const mutated = await mutatedBundle((member) => ({
    ...member,
    derivation: { ...member.derivation, ucTerminalBranchRefs: ['branch:batch-main'] },
  }));
  await assertRefused(mutated, 'FOREIGN_LINEAGE', 'system-requirements.check.derivation-lineage');
});

test('RED seed: a scenario-derived FR without terminal-branch lineage is refused MISSING_LINEAGE', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, derivation: { ...member.derivation, ucTerminalBranchRefs: [] } }));
  await assertRefused(mutated, 'MISSING_LINEAGE', 'system-requirements.check.derivation-lineage');
});

test('RED seed: a foreign source constraint is refused FOREIGN_LINEAGE', async () => {
  const sealed = await greenBundle();
  const mutated = {
    ...sealed.bundle,
    requirements: sealed.bundle.requirements.map((member) =>
      member.requirementId === 'nfr:retention-1'
        ? { ...member, derivation: { ...member.derivation, sourceConstraintRefs: ['constraint:ghost'] } }
        : member,
    ),
  };
  await assertRefused(mutated, 'FOREIGN_LINEAGE', 'system-requirements.check.derivation-lineage');
});

/* ---------------- law L2: verification-surface coverage ---------------- */

test('RED seed: a requirement with no verification surface is refused COVERAGE_GAP', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, verificationSurfaceRefs: [] }));
  const outcome = await assertRefused(mutated, 'COVERAGE_GAP', 'system-requirements.check.verification-surface-coverage');
  assert.equal(outcome.verdict, 'repair', 'a missing verification surface repairs the author desk');
});

test('RED seed: a foreign verification surface is refused FOREIGN_LINEAGE', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, verificationSurfaceRefs: ['surface:ghost'] }));
  await assertRefused(mutated, 'FOREIGN_LINEAGE', 'system-requirements.check.verification-surface-coverage');
});

/* ---------------- law L3: revision pins ---------------- */

test('RED seed: a stale PRD revision pin is refused STALE_LINEAGE', async () => {
  const sealed = await greenBundle();
  const mutated = { ...sealed.bundle, prdRevisionRef: `sha256:${'f'.repeat(64)}` };
  const outcome = await assertRefused(mutated, 'STALE_LINEAGE', 'system-requirements.check.revision-pins');
  assert.equal(outcome.verdict, 'repair');
});

test('RED seed: a stale UC revision pin (UC material cited) is refused STALE_LINEAGE', async () => {
  const sealed = await greenBundle();
  const mutated = { ...sealed.bundle, ucRevisionRef: `sha256:${'f'.repeat(64)}` };
  await assertRefused(mutated, 'STALE_LINEAGE', 'system-requirements.check.revision-pins');
});

test('RED seed: a deleted UC pin while citing UC material is refused STALE_LINEAGE', async () => {
  const sealed = await greenBundle();
  const mutated = { ...sealed.bundle };
  delete mutated.ucRevisionRef;
  await assertRefused(mutated, 'STALE_LINEAGE', 'system-requirements.check.revision-pins');
});

/* ---------------- open vocabulary ---------------- */

test('RED seed: an open requirement-kind vocabulary entry is refused MALFORMED_PRODUCT', async () => {
  const mutated = await mutatedBundle((member) => ({ ...member, requirementKind: 'BR' }));
  const outcome = await assertRefused(mutated, 'MALFORMED_PRODUCT', 'system-requirements.check.requirement-kind-vocabulary');
  assert.equal(outcome.verdict, 'repair');
});

/* ---------------- coverage gap of the UC set ---------------- */

test('RED seed: an accepted UC scenario producing no obligation is refused COVERAGE_GAP by the WP03 validator', async () => {
  const sealed = await greenBundle();
  // Drop the batch FR: uc:batch-1 produces no obligation (WP03 cr-06).
  const mutated = {
    ...sealed.bundle,
    requirements: sealed.bundle.requirements.filter((member) => member.requirementId !== 'fr:batch-1'),
  };
  const { c, provider, seam } = await gateWithSeam();
  const universe = await greenUniverse();
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: mutated }, universe, seam);
  assert.notEqual(outcome.verdict, 'accepted');
  const wp03 = outcome.results.find((result) => result.checkId === 'system-requirements.check.wp03-validation');
  assert.equal(wp03.outcome, 'fail');
  assert.equal(wp03.reason, 'COVERAGE_GAP', 'the per-UC obligation coverage is the WP03 validator\'s law (cr-06)');
  const direct = seam.seam.validate(mutated, universe);
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'COVERAGE_GAP');
});

/* ---------------- scope violations ---------------- */

test('RED seed: a candidate of another desk\'s product kind never reaches the checks\' accept rule', async () => {
  const { c, provider, seam } = await gateWithSeam();
  const universe = await greenUniverse();
  const sealed = await greenBundle();
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: 'formalization.uc-scenarios.v1', product: sealed.bundle }, universe, seam);
  assert.notEqual(outcome.verdict, 'accepted');
  const kindCheck = outcome.results.find((result) => result.checkId === 'system-requirements.check.product-kind');
  assert.equal(kindCheck.outcome, 'fail');
  assert.equal(kindCheck.reason, 'MALFORMED_PRODUCT');
});

test('RED seed: a candidate carrying acceptance material is terminal-rejected (scope fence)', async () => {
  const { c, provider, seam } = await gateWithSeam();
  const universe = await greenUniverse();
  const sealed = await greenBundle();
  const outcome = c.gateSystemRequirementsCandidate(
    provider,
    { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: { ...sealed.bundle, acceptanceCriteria: [{ criterionId: 'AC-X' }] } },
    universe,
    seam,
  );
  assert.equal(outcome.verdict, 'terminal-reject', 'another desk\'s artifact family is out of the Cell\'s scope');
});

/* ---------------- the committed FRF-WP03 red-seed corpus ---------------- */

test('every committed WP03 requirements red seed is refused by the Cell gate with the frozen typed code', async () => {
  const { c, provider, seam } = await gateWithSeam();
  const derived = c.deriveAcceptedUniverse(wp03DeskInput());
  assert.equal(derived.ok, true);
  for (const seed of WP03_REQ_RED_SEEDS) {
    const payload = wp03Fixture(seed.fileName);
    const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: payload }, derived.universe, seam);
    assert.equal('refused' in outcome, false, `${seed.fileName}: the gate decides`);
    assert.notEqual(outcome.verdict, 'accepted', `${seed.fileName}: the red seed must not be accepted`);
    assert.ok(['repair', 'upstream-repair'].includes(outcome.verdict), `${seed.fileName}: verdict ${outcome.verdict} is a repair route`);
    const reasons = outcome.results.filter((result) => result.outcome === 'fail').map((result) => result.reason);
    assert.ok(reasons.includes(seed.code), `${seed.fileName}: the typed refusal ${seed.code} appears among the failing checks (got ${JSON.stringify(reasons)})`);
    const direct = seam.seam.validate(payload, derived.universe);
    assert.equal(direct.ok, false, `${seed.fileName}: the WP03 validator refuses`);
    assert.equal(direct.reason, seed.code, `${seed.fileName}: the WP03 refusal code equals the frozen filename code`);
  }
});

test('the committed WP03 green requirements bundle is accepted by the Cell gate', async () => {
  const { c, provider, seam } = await gateWithSeam();
  const derived = c.deriveAcceptedUniverse(wp03DeskInput());
  const payload = wp03Fixture('green/requirements-bundle.json');
  const validation = seam.seam.validate(payload, derived.universe);
  assert.equal(validation.ok, true);
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: payload }, derived.universe, seam);
  assert.equal(outcome.verdict, 'accepted');
});

/* ---------------- reviewer routing over the seeds ---------------- */

test('the reviewer routes the seeds: repair for author defects, upstream-repair for foreign lineage', async () => {
  const c = await cell();
  const seam = await boundSeam();
  const universe = await greenUniverse();
  const sealed = await greenBundle();

  const stale = c.reviewRequirementsBundle(
    { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: { ...sealed.bundle, prdRevisionRef: `sha256:${'f'.repeat(64)}` } },
    universe,
    seam,
  );
  assert.equal(stale.disposition, 'repair');

  const foreign = c.reviewRequirementsBundle(
    {
      kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND,
      product: await mutatedBundle((member) => ({ ...member, derivation: { ...member.derivation, prdIntentRefs: ['prd:ghost'] } })),
    },
    universe,
    seam,
  );
  assert.equal(foreign.disposition, 'upstream-repair');
  assert.ok(foreign.issues.length > 0);
});

test('the reviewer accepts the green bundle with the sealed product ref', async () => {
  const c = await cell();
  const seam = await boundSeam();
  const universe = await greenUniverse();
  const sealed = await greenBundle();
  const review = c.reviewRequirementsBundle({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  assert.equal(review.disposition, 'accept');
  assert.equal(review.productRef, sealed.ref);
  assert.deepEqual(review.issues, []);
});

/* ---------------- fixture self-check ---------------- */

test('the seed corpus names the pinned revision digests of the green fixtures', async () => {
  const sealed = await greenBundle();
  const members = greenMembers();
  assert.equal(members.length, sealed.bundle.requirements.length);
  assert.equal(sealed.bundle.prdRevisionRef, `sha256:${PRD_REVISION}`);
  assert.equal(sealed.bundle.ucRevisionRef, `sha256:${UC_REVISION}`);
});
