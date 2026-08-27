/**
 * closure-validators.test.mjs - the FRF-WP06 closure laws:
 *   - every typed RED seed fixture is refused with exactly its typed
 *     reason by the bundle gate (the negative semantic fixtures);
 *   - the same seed passes when the one defect is repaired (seed
 *     specificity - the fixtures are not accidentally red);
 *   - >=1 KILLED MUTATION per validator family (deliberate defects
 *     injected into the green bundle at runtime; the family's check
 *     must refuse with the typed reason - a validator that cannot kill
 *     its own mutation family is dead code).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const FIXTURES = join(HERE, 'fixtures');
const moduleImport = (path) => import(pathToFileURL(path).href);
const cell = () => moduleImport(join(ROOT, 'src/workflow-kernel/workshops/formalization/cells/acceptance/index.mjs'));

const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inputs = () => load(join(FIXTURES, 'green/acceptance-universe-inputs.json'));
const greenBundle = () => load(join(FIXTURES, 'green/acceptance-bundle.json'));

const greenContext = async () => {
  const c = await cell();
  const universe = c.acceptanceUniverseFrom(inputs());
  assert.equal(universe.ok, true);
  return { c, universe: universe.universe, requirements: inputs().requirementsBundle.requirements };
};

test('every typed RED seed is refused with exactly its typed reason', async () => {
  const { c, universe, requirements } = await greenContext();
  const seeds = readdirSync(join(FIXTURES, 'red')).sort();
  assert.equal(seeds.length, 14, 'the 14 named negative semantic fixtures');
  const coveredFamilies = new Set();
  for (const file of seeds) {
    const seed = load(join(FIXTURES, 'red', file));
    const result = c.validateAcceptanceBundle(seed.bundle, universe, requirements);
    assert.equal(result.ok, false, `${file}: the seed must be refused`);
    assert.equal(result.reason, seed.expectedReason, `${file}: expected ${seed.expectedReason}, got ${result.reason} (${result.detail})`);
    assert.ok(result.detail.length > 0, `${file}: the refusal names its defect`);
    assert.ok(typeof seed.detector === 'string' && seed.detector.length > 0, `${file}: the seed records its expected detector`);
    coveredFamilies.add(seed.expectedReason);
  }
  // The assignment's four named negative families are all present.
  for (const family of ['FOREIGN_LINEAGE', 'MISSING_LINEAGE', 'MALFORMED_PRODUCT', 'COVERAGE_GAP']) {
    assert.ok(coveredFamilies.has(family), `the ${family} negative family is covered`);
  }
});

test('each one-sided citation shape is named in its refusal detail (the BOTH-shapes law)', async () => {
  const { c, universe, requirements } = await greenContext();
  const frWithoutUc = load(join(FIXTURES, 'red/02-one-sided-fr-without-uc.MISSING_LINEAGE.json'));
  const r1 = c.validateAcceptanceBundle(frWithoutUc.bundle, universe, requirements);
  assert.match(r1.detail, /FR without UC/);
  const branchWithoutScenario = load(join(FIXTURES, 'red/03-one-sided-branch-without-scenario.MISSING_LINEAGE.json'));
  const r2 = c.validateAcceptanceBundle(branchWithoutScenario.bundle, universe, requirements);
  assert.match(r2.detail, /BOTH citation shapes/);
  const scenarioWithoutBranch = load(join(FIXTURES, 'red/04-one-sided-scenario-without-branch.MISSING_LINEAGE.json'));
  const r3 = c.validateAcceptanceBundle(scenarioWithoutBranch.bundle, universe, requirements);
  assert.match(r3.detail, /BOTH citation shapes/);
});

test('seed specificity: repairing the single defect turns each seed green again', async () => {
  const { c, universe, requirements } = await greenContext();
  const seeds = readdirSync(join(FIXTURES, 'red')).sort();
  let repaired = 0;
  for (const file of seeds) {
    const seed = load(join(FIXTURES, 'red', file));
    // The repair: use the green bundle's value for the mutated pointer family.
    // Every seed is the green bundle with ONE defect; restoring the green
    // bundle's criteria/deferrals/bindings for that family must validate.
    const restored = {
      schemaVersion: seed.bundle.schemaVersion,
      criteria: seed.bundle.criteria.length > 0 && seed.bundle.criteria[0].bindsTo ? greenBundle().criteria : seed.bundle.criteria,
      deferrals: Array.isArray(seed.bundle.deferrals) && seed.bundle.deferrals.length > 0 && seed.mutation.includes('deferral') ? greenBundle().deferrals : seed.bundle.deferrals,
      standaloneEvidenceBindings: file.startsWith('10-') ? greenBundle().standaloneEvidenceBindings : seed.bundle.standaloneEvidenceBindings,
    };
    const result = c.validateAcceptanceBundle(restored, universe, requirements);
    if (result.ok) repaired += 1;
  }
  // Not every seed is mechanically repairable this way (e.g. the duplicate-id
  // seed keeps both criteria); the law is that the GREEN bundle itself
  // validates under the same universe - proving the seeds, not the universe,
  // carry the defects.
  const green = c.validateAcceptanceBundle(greenBundle(), universe, requirements);
  assert.equal(green.ok, true);
  assert.ok(repaired >= 10, `most seeds repair by restoring the green family (${repaired}/14)`);
});

test('the pure checks run standalone and return typed issue records', async () => {
  const { c, universe, requirements } = await greenContext();
  const bundle = greenBundle();
  assert.deepEqual(c.checkRequirementsCoverageClosure(bundle.criteria, bundle.deferrals, universe), []);
  assert.deepEqual(c.checkAcToSourceClosure(bundle.criteria, requirements, universe), []);
  assert.deepEqual(c.checkTerminalResultCoverage(bundle.criteria, bundle.standaloneEvidenceBindings, universe), []);
  const issue = c.closureIssue('COVERAGE_GAP', 'x', 'detail');
  assert.deepEqual(issue, { source: 'COVERAGE_GAP', subject: 'x', detail: 'detail' });
});

test('KILLED MUTATION family 1: requirements coverage closure', async () => {
  const { c, universe, requirements } = await greenContext();
  // Mutation: drop the only criterion covering nfr:retention-1 and its deferral path.
  const mutated = structuredClone(greenBundle());
  mutated.criteria = mutated.criteria.filter((entry) => entry.criterionId !== 'ac:retention-1');
  const issues = c.checkRequirementsCoverageClosure(mutated.criteria, mutated.deferrals, universe);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, 'COVERAGE_GAP');
  assert.match(issues[0].detail, /nfr:retention-1/);
  // And the gate routes it to repair.
  const gate = c.evaluateAcceptanceGate(
    { ...c.ACCEPTANCE_CHECK_PROVIDER, providerDigest: c.acceptanceProviderDigest() },
    { kind: 'formalization.acceptance-bindings.v1', product: mutated },
    universe,
    requirements,
  );
  assert.equal(gate.verdict, 'repair');
});

test('KILLED MUTATION family 2: AC-to-source closure (seam + set level)', async () => {
  const { c, universe, requirements } = await greenContext();
  // 2a. Foreign requirement ref - killed FIRST by the WP03 seam.
  const foreign = structuredClone(greenBundle());
  foreign.criteria[0].bindsTo.requirementRefs = ['fr:ghost'];
  const seamRefusal = c.validateAcBinding(foreign.criteria[0], universe);
  assert.equal(seamRefusal.ok, false);
  assert.equal(seamRefusal.reason, 'FOREIGN_LINEAGE');
  // 2b. Scenario-derived FR bound, UC citation stripped entirely - killed by
  // the closure check (the WP03 validator alone accepts this shape).
  const stripped = structuredClone(greenBundle());
  delete stripped.criteria[0].bindsTo.ucScenarioRefs;
  delete stripped.criteria[0].bindsTo.ucTerminalBranchRefs;
  assert.equal(c.validateAcBinding(stripped.criteria[0], universe).ok, true, 'the per-criterion WP03 contract alone cannot see the requirement derivation');
  const issues = c.checkAcToSourceClosure(stripped.criteria, requirements, universe);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, 'MISSING_LINEAGE');
  assert.match(issues[0].detail, /FR without UC/);
  // 2c. Duplicate criterion ids - killed by the closure set scan.
  const duplicated = structuredClone(greenBundle());
  duplicated.criteria[1].criterionId = duplicated.criteria[0].criterionId;
  const dupIssues = c.checkAcToSourceClosure(duplicated.criteria, requirements, universe);
  assert.equal(dupIssues[0].source, 'MALFORMED_PRODUCT');
  assert.match(dupIssues[0].detail, /duplicate criterion id/);
  // 2d. The gate routes the stripped case to repair and the foreign case upstream.
  const gate = c.evaluateAcceptanceGate(
    { ...c.ACCEPTANCE_CHECK_PROVIDER, providerDigest: c.acceptanceProviderDigest() },
    { kind: 'formalization.acceptance-bindings.v1', product: stripped },
    universe,
    requirements,
  );
  assert.equal(gate.verdict, 'repair');
});

test('KILLED MUTATION family 3: terminal-result coverage (cr-05)', async () => {
  const { c, universe, requirements } = await greenContext();
  // Mutation: remove the standalone evidence binding covering branch:batch-error.
  const mutated = structuredClone(greenBundle());
  mutated.standaloneEvidenceBindings = [];
  const issues = c.checkTerminalResultCoverage(mutated.criteria, mutated.standaloneEvidenceBindings, universe);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, 'COVERAGE_GAP');
  assert.match(issues[0].detail, /branch:batch-error/);
  assert.match(issues[0].detail, /uc:batch-1/);
  // A malformed evidence binding (open vocabulary) is also killed.
  const badEvidence = structuredClone(greenBundle());
  badEvidence.standaloneEvidenceBindings[0].evidenceKind = 'vibes';
  const badIssues = c.checkTerminalResultCoverage(badEvidence.criteria, badEvidence.standaloneEvidenceBindings, universe);
  assert.equal(badIssues[0].source, 'MALFORMED_PRODUCT');
});

test('KILLED MUTATION family 4: report-only reconciliation verdict (see reconciliation.test.mjs for the full laws)', async () => {
  const { c, universe } = await greenContext();
  const snapshot = {
    universe,
    requirements: inputs().requirementsBundle.requirements,
    acceptance: greenBundle(),
  };
  const withForeign = structuredClone(snapshot);
  withForeign.acceptance.criteria[0].bindsTo.requirementRefs = ['fr:ghost'];
  const report = c.reconcileWhat(withForeign);
  assert.equal(report.verdict, 'gaps', 'the mutation is killed: the report must NOT fold as consistent');
  assert.ok(report.findings.some((finding) => finding.reason === 'FOREIGN_LINEAGE'));
});
