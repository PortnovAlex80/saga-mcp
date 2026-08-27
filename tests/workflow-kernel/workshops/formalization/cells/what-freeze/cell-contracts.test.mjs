/**
 * cell-contracts.test.mjs - the FRF-WP07 cell's declared contracts: the
 * reviewer verdict fences, the role bindings and skill ids cross-checked
 * against the INSTALLED manifest (dist), and the template shape law.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cellModule,
  clone,
  distModule,
  freezeAccepted,
  greenBaselineFixture,
  settleFrozen,
} from './support.mjs';

test('the reviewer verdict binds its exact artifact; a foreign ref is FOREIGN_LINEAGE', async () => {
  const reviewer = await cellModule('reviewer');
  const frozen = await freezeAccepted();
  const lawful = { verdict: 'accepted', artifactRef: frozen.artifact.ref, wholeWhatDigest: frozen.baseline.wholeWhatDigest, issues: [] };
  assert.equal(reviewer.validateBaselineReview(lawful, frozen.artifact).ok, true);
  const foreign = { ...lawful, artifactRef: 'sha256:' + '1'.repeat(64) };
  assert.equal(reviewer.validateBaselineReview(foreign, frozen.artifact).reason, 'FOREIGN_LINEAGE');
});

test('a verdict over partially-substituted content (right ref, wrong whole-WHAT digest) is DRIFT', async () => {
  const reviewer = await cellModule('reviewer');
  const frozen = await freezeAccepted();
  const drifted = { verdict: 'accepted', artifactRef: frozen.artifact.ref, wholeWhatDigest: 'f'.repeat(64), issues: [] };
  assert.equal(reviewer.validateBaselineReview(drifted, frozen.artifact).reason, 'DRIFT_DETECTED');
});

test('verdict monotonicity: no prose-only rejections, no conditioned acceptances, typed issues only', async () => {
  const reviewer = await cellModule('reviewer');
  const frozen = await freezeAccepted();
  const base = { verdict: 'rejected', artifactRef: frozen.artifact.ref, wholeWhatDigest: frozen.baseline.wholeWhatDigest };
  const proseOnly = reviewer.validateBaselineReview({ ...base, issues: [] }, frozen.artifact);
  assert.equal(proseOnly.reason, 'MALFORMED_PRODUCT');
  const conditioned = reviewer.validateBaselineReview({ ...base, verdict: 'accepted', issues: [{ reason: 'COVERAGE_GAP', detail: 'x' }] }, frozen.artifact);
  assert.equal(conditioned.reason, 'MALFORMED_PRODUCT');
  const untyped = reviewer.validateBaselineReview({ ...base, issues: [{ severity: 'high' }] }, frozen.artifact);
  assert.equal(untyped.reason, 'MALFORMED_PRODUCT');
  const lawfulRejection = reviewer.validateBaselineReview({ ...base, issues: [{ reason: 'DRIFT_DETECTED', detail: 'substituted member payload' }] }, frozen.artifact);
  assert.equal(lawfulRejection.ok, true);
  assert.equal(lawfulRejection.verdict, 'rejected');
});

test('the settlement review binds the canonical digest', async () => {
  const reviewer = await cellModule('reviewer');
  const frozen = await freezeAccepted();
  const settled = await settleFrozen(frozen);
  const lawful = { verdict: 'accepted', artifactRef: settled.artifact.ref, canonicalDigest: settled.contract.canonicalDigest, issues: [] };
  assert.equal(reviewer.validateSettlementReview(lawful, settled.artifact).ok, true);
  const unbound = { verdict: 'accepted', artifactRef: settled.artifact.ref, canonicalDigest: '0'.repeat(64), issues: [] };
  assert.equal(reviewer.validateSettlementReview(unbound, settled.artifact).reason, 'DRIFT_DETECTED');
});

test('the role bindings resolve against the INSTALLED manifest: launch kinds, desks, providers, effects', async () => {
  const roles = await cellModule('desk-bindings');
  const manifest = await distModule('workflow-kernel/workshops/formalization/manifest');
  const installed = manifest.installedWorkshopManifest();
  for (const binding of roles.whatFreezeDeskRoleBindings()) {
    const roleBinding = installed.roleBindings.find((entry) => entry.launchKind === binding.launchKind);
    assert.ok(roleBinding !== undefined, `launch kind ${binding.launchKind} must be an installed role binding`);
    assert.equal(roleBinding.protocolRole, binding.protocolRole);
    const node = installed.flow.nodes.find((entry) => entry.id === binding.nodeId);
    assert.ok(node?.desk !== undefined, `node ${binding.nodeId} must be an installed desk`);
    assert.equal(node.kind, binding.nodeKind);
    assert.equal(node.desk.checkProviderId, binding.checkProviderId);
    assert.equal(node.desk.effectId, binding.effectId);
    assert.equal(node.desk.operatorStaffed, binding.operatorStaffed);
    assert.ok(binding.protocolRole === 'author' || binding.protocolRole === 'reviewer');
  }
  // The cell binds a SUBSET of the installed launch kinds (the reviewer
  // kind; the kernel desks author nothing) and never an unknown kind.
  const cellKinds = new Set(roles.whatFreezeDeskRoleBindings().map((binding) => binding.launchKind));
  const installedKinds = new Set(installed.roleBindings.map((entry) => entry.launchKind));
  for (const kind of cellKinds) assert.ok(installedKinds.has(kind), `launch kind ${kind} must be an installed role binding`);
  assert.equal(cellKinds.size, 1);
  // Fail-closed node lookup.
  const unknown = roles.roleBindingOfNode('settle-everything');
  assert.equal(unknown.ok, false);
});

test('the desk role bindings declare NO authoring actor for the kernel products (deterministic builders)', async () => {
  const roles = await cellModule('desk-bindings');
  for (const binding of roles.whatFreezeDeskRoleBindings()) {
    assert.match(binding.productSource, /deterministic-(builder|settler)/);
    assert.equal(binding.protocolRole, 'reviewer');
  }
});

test('the skill ids follow the installed manifest convention and the digests are content-addressed', async () => {
  const skill = await cellModule('skill');
  const manifest = await distModule('workflow-kernel/workshops/formalization/manifest');
  const installed = manifest.installedWorkshopManifest();
  const installedIds = new Set(installed.skills.map((entry) => entry.skillId));
  for (const declaration of skill.whatFreezeSkillDeclarations()) {
    assert.ok(installedIds.has(declaration.skillId), `skill ${declaration.skillId} must follow the installed per-desk convention`);
    assert.equal(declaration.digest, (await cellModule('shared')).sha256OfCanonical(declaration.content));
    assert.ok(declaration.servesDesks.length === 1);
  }
});

test('the template declares every WP03 section; a folded draft cannot even render', async () => {
  const template = await cellModule('template');
  const rendered = template.freezeTemplate(greenBaselineFixture().caseIdentity);
  assert.match(rendered.digest, /^[0-9a-f]{64}$/);
  assert.ok(template.TEMPLATE_SECTIONS.length === 19);
  const check = template.checkTemplateShape(rendered.template);
  assert.equal(check.ok, true);
  // A draft with the dispositions folded away is refused structurally.
  const folded = clone(rendered.template);
  delete folded.dispositions;
  const foldedRefusal = template.checkTemplateShape(folded);
  assert.equal(foldedRefusal.reason, 'MALFORMED_PRODUCT');
  assert.match(foldedRefusal.detail, /dispositions\./);
  // The legacy folded shape is refused on sight.
  const legacy = template.checkTemplateShape({ schemaVersion: 'formalization.what-baseline.v1', memberDigests: [], acceptedTraceDigest: 'x' });
  assert.equal(legacy.reason, 'MALFORMED_PRODUCT');
  assert.match(legacy.detail, /fold slot/);
  // A missing evidence-bindings section is refused too.
  const noEvidence = clone(rendered.template);
  delete noEvidence.evidenceBindings;
  assert.equal(template.checkTemplateShape(noEvidence).reason, 'MALFORMED_PRODUCT');
  // The real frozen baseline passes the shape check.
  const frozen = await freezeAccepted();
  assert.equal(template.checkTemplateShape(frozen.baseline).ok, true);
});

test('the protocol transitions equal the installed manifest edges for the two kernel desks', async () => {
  const protocol = await cellModule('protocol');
  const manifest = await distModule('workflow-kernel/workshops/formalization/manifest');
  const installed = manifest.installedWorkshopManifest();
  const installedEdges = installed.flow.edges
    .filter((edge) => edge.from === protocol.FREEZE_NODE_ID || edge.from === protocol.SETTLE_NODE_ID)
    .map((edge) => `${edge.from}--${edge.on}-->${edge.to}`).sort();
  const cellEdges = [...protocol.FREEZE_TRANSITIONS, ...protocol.SETTLE_TRANSITIONS]
    .map((edge) => `${edge.from}--${edge.on}-->${edge.to}`).sort();
  assert.deepEqual(cellEdges, installedEdges);
});

test('the cell is TEST-ONLY REACHABLE: no dist artifact and no production entrypoint imports it', async () => {
  const { existsSync } = await import('node:fs');
  const { findImporters } = await import('../../../../support/import-scan.mjs');
  const path = await import('node:path');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..', '..');
  // Nothing compiled: the cell is source-live until the WP11 integration.
  assert.equal(existsSync(path.join(repoRoot, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells')), false);
  const offenders = findImporters(
    [
      { dir: path.join(repoRoot, 'src'), extensions: ['.ts', '.mjs'] },
      { dir: path.join(repoRoot, 'tools'), extensions: ['.mjs'] },
    ],
    'src/workflow-kernel/workshops/formalization/cells/what-freeze',
  );
  // Only the cell's own modules may reference it.
  for (const offender of offenders) {
    assert.ok(
      offender.replaceAll('\\', '/').includes('cells/what-freeze'),
      `a production path imports the WHAT-freeze cell outside the cell itself: ${offender}`,
    );
  }
});
