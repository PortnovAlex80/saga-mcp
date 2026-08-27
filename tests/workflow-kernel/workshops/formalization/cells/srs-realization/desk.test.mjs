/**
 * desk.test.mjs - FRF-WP08: the define-architecture-contract desk binding
 * (the SIBLING PATTERN): the cell's declaration must verify against the
 * INSTALLED workshop manifest (node, product kind, check provider, skills,
 * role bindings), its CheckPlan evidence must be byte-identical to the
 * sibling gate module's fact for the same provider, and the verdict
 * routing must be the workshop's frozen table (killed mutation family:
 * desk binding).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cell, gates, greenFixture, manifest } from './support.mjs';

test('GREEN: the desk declaration verifies against the INSTALLED manifest', () => {
  const declaration = cell.srsRealizationDeskDeclaration();
  assert.equal(declaration.ok, true, JSON.stringify(declaration).slice(0, 220));
  const d = declaration.declaration;
  assert.equal(d.deskId, 'define-architecture-contract');
  assert.equal(d.nodeKind, 'production-cell');
  assert.equal(d.outputProductKind, 'formalization.srs.v1');
  assert.equal(d.checkProvider.providerId, 'formalization.srs-structure.v1');
  assert.equal(d.checkProvider.validator, 'validateSrs');
  assert.equal(d.checkProvider.nodeId, 'define-architecture-contract');
  assert.equal(d.protocolSkillId, manifest.PROTOCOL_SKILL_ID);
  assert.equal(d.semanticSkillId, 'formalization-desk-define-architecture-contract');
  assert.deepEqual(d.inputContractKinds, ['frf-contracts.what-baseline.v1', 'formalization.srs-realization.v1']);
  assert.deepEqual([...d.obligationKinds].sort(), ['infrastructure-obligation', 'integration-or-composition-obligation']);
});

test('GREEN: the installed manifest itself declares the semantic skill and provider the cell binds', () => {
  const installed = manifest.installedWorkshopManifest();
  const skill = installed.skills.find((entry) => entry.skillId === 'formalization-desk-define-architecture-contract');
  assert.ok(skill, 'the installed manifest declares the desk semantic skill');
  assert.deepEqual(skill.servesDesks, ['define-architecture-contract']);
  const provider = manifest.checkProviderOfDesk('define-architecture-contract');
  assert.equal(provider.ok, true);
  assert.equal(provider.provider.providerId, 'formalization.srs-structure.v1');
  assert.equal(provider.provider.providerDigest, cell.srsRealizationDeskDeclaration().declaration.checkProvider.providerDigest);
});

test('GREEN: the CheckPlan evidence is the SIBLING gate module fact (byte-identical, one check surface)', () => {
  const own = cell.srsRealizationCheckPlanEvidence();
  assert.equal(own.refused, undefined, JSON.stringify(own).slice(0, 220));
  const sibling = gates.checkPlanEvidenceFor(cell.srsRealizationDeskDeclaration().declaration.checkProvider);
  assert.deepEqual(own, sibling);
  assert.equal(own.kind, 'CheckPlan');
  assert.equal(own.ref, 'evidence:CheckPlan#formalization.srs-structure.v1');
  assert.equal(own.producer, 'external-input');
  assert.match(own.payloadDigest, /^[0-9a-f]{64}$/);
});

test('GREEN: the desk role bindings are exactly the installed manifest launch kinds', () => {
  const d = cell.srsRealizationDeskDeclaration().declaration;
  assert.deepEqual(
    d.roleBindings.map((binding) => `${binding.launchKind}:${binding.protocolRole}:${binding.semanticProfile}`).sort(),
    ['formalization.implementation.author:author:implementer', 'formalization.implementation.reviewer:reviewer:reviewer'],
  );
  assert.deepEqual(
    d.roleBindings,
    manifest.FORMALIZATION_ROLE_BINDINGS.map((binding) => ({ ...binding })),
  );
});

test('GREEN: the verdict routing is the workshop frozen table', () => {
  assert.deepEqual(
    { ...cell.DESK_VERDICT_OF_REASON },
    {
      MALFORMED_PRODUCT: 'repair',
      MISSING_LINEAGE: 'repair',
      STALE_LINEAGE: 'repair',
      COVERAGE_GAP: 'repair',
      FOREIGN_LINEAGE: 'upstream-repair',
      DRIFT_DETECTED: 'human-wait',
      SCOPE_VIOLATION: 'terminal-reject',
    },
  );
});

test('GREEN: the desk author path is pure and idempotent (same draft, same sealed bytes)', () => {
  const g = greenFixture();
  const first = cell.authorArchitectureContract(g.draft, g.universe);
  const second = cell.authorArchitectureContract(JSON.parse(JSON.stringify(g.draft)), cell.eliteUniverse());
  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(first.product, second.product);
  assert.equal(first.product.deskId, 'define-architecture-contract');
  assert.equal(first.product.lineage.traceRule, 'srs-derived-from-frozen-what-baseline');
  assert.equal(first.product.lineage.baselineRef, `sha256:${g.universe.revisionPins.whatBaselineDigest}`);
});

test('RED: the desk author path refuses an unsupplied SRS revision pin (fail-closed)', () => {
  const g = greenFixture();
  const noSrsPin = { idSets: g.universe.idSets, revisionPins: { whatBaselineDigest: g.universe.revisionPins.whatBaselineDigest } };
  const outcome = cell.authorArchitectureContract(g.draft, noSrsPin);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'MISSING_LINEAGE');
  assert.ok(outcome.detail.includes('srsRevisionDigest'));
});

test('GREEN: the desk semantic skill digest is deterministic content addressing', () => {
  assert.equal(cell.semanticSkillDigestOfDesk(), cell.semanticSkillDigestOfDesk());
  assert.match(cell.semanticSkillDigestOfDesk(), /^[0-9a-f]{64}$/);
});
