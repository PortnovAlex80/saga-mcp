/**
 * mutations.test.mjs - FRF-WP08: the pinned mutation FAMILIES of the SRS
 * scenario-realization cell, each KILLED by a payload-level RED seed in
 * this suite (GREEN pin). The deliberate SOURCE-mutation demonstrations run
 * via red-demos.mjs (one per family, restored after each run) and are
 * asserted to exist by name at the bottom of this file.
 *
 * Families (one killed mutation each, minimum):
 *   parser                    - the deterministic closed-vocabulary parser
 *   realization-validator     - the SRS realization section validator
 *   contract-validator        - the architecture contract surface closure
 *                               (the two NAMED Elite kills live here)
 *   desk-binding              - the manifest-verified desk + CheckPlan seam
 *   seam                      - the WP03 fail-closed universe seam
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cell,
  greenFixture,
  killCoverageGap,
  killMissingComposition,
  killMissingEntrypoint,
  killMissingImplementationSurface,
  killFalseSurfaceClaim,
  killForeignScenario,
  killForeignEvidence,
  killRemovedCompositionOwner,
  killStaleBaselinePin,
  killTamperedCanonicalDigest,
  killTamperedObligations,
  killTamperedPostFreeze,
  killTamperedRealizationDigest,
  seedOpenSurfaceKind,
} from './support.mjs';

const FAMILY_KILLS = {
  parser: [
    ['open-surface-kind', () => cell.parseSrsRealizationDraft(seedOpenSurfaceKind(greenFixture()))],
  ],
  'realization-validator': [
    ['coverage-gap', () => cell.authorArchitectureContract(killCoverageGap(greenFixture()), greenFixture().universe)],
    ['foreign-scenario', () => cell.authorArchitectureContract(killForeignScenario(greenFixture()), greenFixture().universe)],
    ['foreign-evidence', () => cell.authorArchitectureContract(killForeignEvidence(greenFixture()), greenFixture().universe)],
    ['stale-baseline-pin', () => cell.authorArchitectureContract(killStaleBaselinePin(greenFixture()), greenFixture().universe)],
    ['tampered-realization-digest', () => cell.validateSrsRealization(killTamperedRealizationDigest(greenFixture()), greenFixture().universe)],
  ],
  'contract-validator': [
    ['ELITE missing-entrypoint', () => cell.authorArchitectureContract(killMissingEntrypoint(greenFixture()), greenFixture().universe)],
    ['ELITE missing-entrypoint (implementation surface)', () => cell.authorArchitectureContract(killMissingImplementationSurface(greenFixture()), greenFixture().universe)],
    ['ELITE missing-composition', () => cell.authorArchitectureContract(killMissingComposition(greenFixture()), greenFixture().universe)],
    ['removed-composition-owner', () => cell.authorArchitectureContract(killRemovedCompositionOwner(greenFixture()), greenFixture().universe)],
    ['false-surface-claim', () => cell.validateArchitectureContract(withRealization(greenFixture(), killFalseSurfaceClaim), greenFixture().universe)],
    ['tampered-obligations', () => cell.validateArchitectureContract(killTamperedObligations(greenFixture()), greenFixture().universe)],
    ['tampered-postfreeze', () => cell.validateArchitectureContract(killTamperedPostFreeze(greenFixture()), greenFixture().universe)],
    ['tampered-canonical-digest', () => cell.validateArchitectureContract(killTamperedCanonicalDigest(greenFixture()), greenFixture().universe)],
  ],
  'desk-binding': [
    ['stale-srs-pin-refused-by-desk', () => cell.authorArchitectureContract(greenFixture().draft, { idSets: greenFixture().universe.idSets, revisionPins: { whatBaselineDigest: greenFixture().universe.revisionPins.whatBaselineDigest } })],
  ],
  seam: [
    ['universe-omitted-section', () => cell.validateSrsRealization(greenFixture().section, undefined)],
    ['universe-omitted-contract', () => cell.validateArchitectureContract(greenFixture().contract, undefined)],
  ],
};

function withRealization(g, draftMutator) {
  const parsed = cell.parseSrsRealizationDraft(draftMutator(g));
  assert.equal(parsed.ok, true);
  return { ...g.contract, realization: parsed.section };
}

test('every validator family has at least one KILLED mutation (the family registry)', () => {
  const families = Object.keys(FAMILY_KILLS);
  assert.deepEqual(families.sort(), ['contract-validator', 'desk-binding', 'parser', 'realization-validator', 'seam']);
  let totalKills = 0;
  for (const [family, kills] of Object.entries(FAMILY_KILLS)) {
    assert.ok(kills.length >= 1, `${family} must kill at least one mutation`);
    for (const [name, run] of kills) {
      const outcome = run();
      totalKills += 1;
      assert.equal(outcome.ok, false, `${family}/${name} SURVIVED - a kill mutation must be refused`);
      assert.equal(outcome.refused, true, `${family}/${name} must be a typed refusal, never a silent pass`);
      assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 0, `${family}/${name} carries a typed reason`);
      assert.ok(outcome.detail.length > 0, `${family}/${name} carries a refusal detail`);
    }
  }
  assert.ok(totalKills >= 17, `expected at least 17 pinned kills, got ${totalKills}`);
});

test('the two NAMED Elite kills are pinned with their exact typed codes', () => {
  const entrypoint = cell.authorArchitectureContract(killMissingEntrypoint(greenFixture()), greenFixture().universe);
  assert.equal(entrypoint.reason, 'COVERAGE_GAP', 'missing-entrypoint => typed COVERAGE_GAP refusal, never silent');
  const composition = cell.authorArchitectureContract(killMissingComposition(greenFixture()), greenFixture().universe);
  assert.equal(composition.reason, 'FOREIGN_LINEAGE', 'missing-composition => typed FOREIGN_LINEAGE refusal');
});

test('the source-mutation demonstrations exist, one per family (red-demos.mjs registry sync)', () => {
  const redDemosPath = join(dirname(fileURLToPath(import.meta.url)), 'red-demos.mjs');
  assert.ok(existsSync(redDemosPath), 'red-demos.mjs must exist next to this suite');
  const source = readFileSync(redDemosPath, 'utf8');
  const expectedMutations = [
    'parser-closed-vocabulary-fence',
    'realization-coverage-fence',
    'contract-missing-entrypoint-fence',
    'contract-missing-composition-fence',
    'desk-checkplan-seam-fence',
    'seam-fail-closed-fence',
  ];
  for (const name of expectedMutations) {
    assert.ok(source.includes(`'${name}'`), `red-demos.mjs must declare the ${name} demonstration`);
  }
});
