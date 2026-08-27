/**
 * acceptance-cell.test.mjs - the define-acceptance-contract cell's green
 * path and installed-continuity laws (FRF-WP06):
 *   - the green bundle validates through the WP03 seam + closure checks;
 *   - the seam IS the WP03 validator (identity + digest pins);
 *   - the protocol/skill/provider pins match the INSTALLED workshop
 *     manifest (dist/) and the plan's target graph;
 *   - the gate routes typed refusals exactly like the installed gates.ts
 *     routing table (source-pinned, not import-copied);
 *   - the canonical digest rule equals the kernel dist digest rule.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirnameOf(import.meta.url), '..', '..', '..', '..', '..', '..');
const FIXTURES = join(dirnameOf(import.meta.url), 'fixtures');
const DOCS_CONTRACTS = join(ROOT, 'docs/refactoring/formalization-frf/contracts');
/** The FRF-WP11 canonical in-package contracts tree. */
const INSTALLED_CONTRACTS = join(ROOT, 'src/workflow-kernel/workshops/formalization/contracts');

function dirnameOf(url) {
  return join(fileURLToPath(url), '..');
}

/** Windows-safe dynamic module import for an absolute path. */
const moduleImport = (path) => import(pathToFileURL(path).href);
const cell = () => moduleImport(join(ROOT, 'src/workflow-kernel/workshops/formalization/cells/acceptance/index.mjs'));

const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inputs = () => load(join(FIXTURES, 'green/acceptance-universe-inputs.json'));
const greenBundle = () => load(join(FIXTURES, 'green/acceptance-bundle.json'));

test('the green acceptance bundle validates through the WP03 seam + closure laws', async () => {
  const c = await cell();
  const built = c.acceptanceUniverseFrom(inputs());
  assert.equal(built.ok, true);
  const validation = c.validateAcceptanceBundle(greenBundle(), built.universe, inputs().requirementsBundle.requirements);
  assert.equal(validation.ok, true);
  assert.match(validation.artifact.ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(validation.artifact.ref, `sha256:${validation.artifact.digest}`);
});

test('the universe builder is fail-closed on every missing input material', async () => {
  const c = await cell();
  const base = inputs();
  for (const key of ['requirementsBundle', 'useCases', 'verifiableStatementIds']) {
    const broken = { ...base, [key]: undefined };
    const built = c.acceptanceUniverseFrom(broken);
    assert.equal(built.ok, false, `${key} must be required`);
    assert.equal(built.reason, 'MISSING_LINEAGE');
  }
  const noBranchMap = c.acceptanceUniverseFrom({ ...base, useCases: { scenarioIds: base.useCases.scenarioIds } });
  assert.equal(noBranchMap.ok, false);
  assert.match(noBranchMap.detail, /terminal-branch map/);
});

test('THE SEAM: the cell runs the actual in-package WP03 validator, not a copy', async () => {
  const c = await cell();
  // FRF-WP11: the canonical home is the in-package contracts tree (the
  // docs-tree copy is a frozen byte-equal snapshot; the seam imports
  // in-package, so the identity comparison resolves against THAT module).
  const wp03 = await moduleImport(join(INSTALLED_CONTRACTS, 'validators/ac-binding.mjs'));
  assert.equal(c.validateAcBinding, wp03.validateAcBinding, 'the seam must re-export the WP03 module function by identity');
  assert.equal(c.WP03_AC_BINDING_KIND, 'frf-contracts.ac-binding.v1');
  assert.equal(c.WP03_SEAM.adoptedContract, wp03.CONTRACT_KIND);
  // Digest pins: the adopted files must be byte-identical to the canonical
  // contracts AND their frozen docs snapshots (drift in either is red).
  const { createHash } = await import('node:crypto');
  for (const [pinKey, file] of [
    ['validatorSha256', 'validators/ac-binding.mjs'],
    ['commonSha256', 'validators/common.mjs'],
  ]) {
    const canonical = createHash('sha256').update(readFileSync(join(INSTALLED_CONTRACTS, file))).digest('hex');
    assert.equal(c.WP03_SEAM[pinKey], canonical, `${file} drifted from the seam pin; the frozen contract may only change through a new WP03 version`);
    const snapshot = createHash('sha256').update(readFileSync(join(DOCS_CONTRACTS, file))).digest('hex');
    assert.equal(snapshot, canonical, `${file}: the docs snapshot drifted from the canonical in-package contract`);
  }
});

test('THE SEAM: the frozen WP03 green fixture + accepted id-sets validate through the cell seam', async () => {
  const c = await cell();
  const universe = load(join(DOCS_CONTRACTS, 'fixtures/accepted-id-sets.json'));
  const fixture = load(join(DOCS_CONTRACTS, 'fixtures/green/ac-binding.json'));
  const validation = c.validateAcBinding(fixture, universe);
  assert.equal(validation.ok, true);
  assert.equal(validation.kind, 'frf-contracts.ac-binding.v1');
});

test('the protocol pins the installed manifest: node, product kind, and flow edges', async () => {
  const c = await cell();
  assert.equal(c.ACCEPTANCE_CELL_NODE_ID, 'define-acceptance-contract');
  assert.equal(c.ACCEPTANCE_CELL_FLOW.predecessor, 'derive-system-requirements');
  assert.equal(c.ACCEPTANCE_CELL_FLOW.acceptedTransition.on, 'domain.accepted');
  assert.equal(c.ACCEPTANCE_CELL_FLOW.acceptedTransition.to, 'reconcile-what');
  assert.equal(c.ACCEPTANCE_CELL_FLOW.failedTransition.to, 'complete-failed');
  const manifest = await moduleImport(join(ROOT, 'dist/workflow-kernel/workshops/formalization/manifest.js'));
  const installed = manifest.installedWorkshopManifest();
  const node = installed.flow.nodes.find((entry) => entry.id === 'define-acceptance-contract');
  assert.notEqual(node, undefined);
  assert.equal(node.kind, 'production-cell');
  assert.equal(node.desk.outputProductKind, c.ACCEPTANCE_CELL_PRODUCT_KIND);
  // The cell's declared flow edges exist verbatim in the installed edge table.
  const edge = (from, on) => installed.flow.edges.some((entry) => entry.from === from && entry.on === on);
  assert.equal(edge('derive-system-requirements', 'domain.accepted'), true, 'the accepted predecessor edge exists');
  assert.equal(edge('define-acceptance-contract', 'domain.accepted'), true);
  assert.equal(edge('define-acceptance-contract', 'domain.failed'), true);
});

test('the cell skill declaration equals the installed manifest skill row of this desk', async () => {
  const c = await cell();
  const manifest = await moduleImport(join(ROOT, 'dist/workflow-kernel/workshops/formalization/manifest.js'));
  const installed = manifest.installedWorkshopManifest();
  const row = installed.skills.find((entry) => entry.servesDesks.includes('define-acceptance-contract') && entry.kind === 'semantic');
  assert.notEqual(row, undefined);
  const declaration = c.acceptanceSkillDeclaration();
  assert.equal(declaration.skillId, row.skillId);
  assert.equal(declaration.kind, row.kind);
  assert.equal(declaration.digest, row.digest, 'the cell skill digest must equal the installed manifest row digest');
  assert.ok(c.ACCEPTANCE_SKILL_CHECKLIST.some((item) => item.lawId === 'ac-2' && item.law.includes('BOTH')));
});

test('the CheckPlan evidence fact has the kernel Input-authority shape', async () => {
  const c = await cell();
  const fact = c.acceptanceCheckPlanEvidence();
  assert.deepEqual(Object.keys(fact).sort(), ['kind', 'payloadDigest', 'producer', 'ref']);
  assert.equal(fact.kind, 'CheckPlan');
  assert.equal(fact.producer, 'external-input');
  assert.equal(fact.ref, `evidence:CheckPlan#${c.ACCEPTANCE_CHECK_PROVIDER.providerId}`);
  assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    c.acceptanceProviderDigest(),
    c.acceptanceProviderDigest(),
    'the provider digest is deterministic',
  );
  assert.ok(c.ACCEPTANCE_CHECK_PLAN.length >= 5, 'the CheckPlan enumerates every check family');
});

test('the reviewer contract: same-provider recheck, fail-closed route resolution', async () => {
  const c = await cell();
  assert.equal(c.ACCEPTANCE_REVIEWER_ROUTE.policy, 'same-provider-recheck');
  const route = c.reviewerRouteOf('formalization.implementation.reviewer');
  assert.equal(route.ok, true);
  assert.equal(route.route.desk, 'define-acceptance-contract');
  const refused = c.reviewerRouteOf('formalization.implementation.author');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'ROLE_NOT_BOUND');
  assert.ok(c.ACCEPTANCE_REVIEWER_CHECKLIST.some((duty) => duty.dutyId === 'rev-4'));
});

test('the role bindings: two launch kinds, closed kernel universe, one resolution each', async () => {
  const c = await cell();
  assert.deepEqual(c.KERNEL_PROTOCOL_ROLE_UNIVERSE, ['author', 'reviewer']);
  assert.equal(c.ACCEPTANCE_ROLE_BINDINGS.length, 2);
  for (const binding of c.ACCEPTANCE_ROLE_BINDINGS) {
    assert.equal(binding.servesDesk, 'define-acceptance-contract');
    assert.ok(c.KERNEL_PROTOCOL_ROLE_UNIVERSE.includes(binding.protocolRole));
    const resolved = c.roleBindingOf(binding.launchKind);
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.binding, binding);
  }
  const unknown = c.roleBindingOf('formalization.implementation.planner');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'ROLE_NOT_BOUND');
});

test('the template enumerates the WP03 contract fields and the closed vocabularies', async () => {
  const c = await cell();
  const schema = load(join(DOCS_CONTRACTS, 'schemas/ac-binding.schema.json'));
  const templateKeys = Object.keys(c.ACCEPTANCE_BUNDLE_TEMPLATE).sort();
  assert.deepEqual(templateKeys, ['criteria', 'deferrals', 'schemaVersion', 'standaloneEvidenceBindings']);
  assert.deepEqual(
    Object.keys(c.AC_BINDING_TEMPLATE).sort(),
    Object.keys(schema.properties).sort(),
    'the criterion template covers exactly the WP03 ac-binding schema properties',
  );
  assert.deepEqual(
    Object.keys(c.ACCEPTANCE_BUNDLE_TEMPLATE.criteria[0].bindsTo).sort(),
    Object.keys(schema.properties.bindsTo.properties).sort(),
  );
  const evidenceEnum = schema.properties.evidence.properties.evidenceKind.enum;
  for (const kind of evidenceEnum) assert.ok(c.AC_BINDING_TEMPLATE.evidence.evidenceKind.includes(kind));
  assert.deepEqual(c.EVIDENCE_KINDS, [...evidenceEnum].sort());
  assert.ok(Object.isFrozen(c.ACCEPTANCE_BUNDLE_TEMPLATE));
  assert.ok(c.renderTemplateGuide().includes('BOTH the UC scenario AND the terminal-branch citation'));
  assert.deepEqual(c.TEMPLATE_FORBIDDEN_KEYS, ['files', 'moduleAllocation', 'participatingModules']);
});

test('the gate: accepted green, typed routing, fail-closed provider verification', async () => {
  const c = await cell();
  const built = c.acceptanceUniverseFrom(inputs());
  const requirements = inputs().requirementsBundle.requirements;
  const provider = {
    ...c.ACCEPTANCE_CHECK_PROVIDER,
    providerDigest: c.acceptanceProviderDigest(),
  };
  const accepted = c.evaluateAcceptanceGate(provider, { kind: 'formalization.acceptance-bindings.v1', product: greenBundle() }, built.universe, requirements);
  assert.equal(accepted.verdict, 'accepted');
  assert.deepEqual(accepted.issues, []);
  assert.match(accepted.productRef, /^sha256:[0-9a-f]{64}$/);

  const foreign = structuredClone(greenBundle());
  foreign.criteria[0].bindsTo.requirementRefs = ['fr:ghost'];
  const upstream = c.evaluateAcceptanceGate(provider, { kind: 'formalization.acceptance-bindings.v1', product: foreign }, built.universe, requirements);
  assert.equal(upstream.verdict, 'upstream-repair');

  const scope = { ...greenBundle(), files: ['src/x.ts'] };
  const terminal = c.evaluateAcceptanceGate(provider, { kind: 'formalization.acceptance-bindings.v1', product: scope }, built.universe, requirements);
  assert.equal(terminal.verdict, 'terminal-reject');

  const uncovered = structuredClone(greenBundle());
  uncovered.criteria = uncovered.criteria.filter((entry) => entry.criterionId !== 'ac:retention-1');
  const repair = c.evaluateAcceptanceGate(provider, { kind: 'formalization.acceptance-bindings.v1', product: uncovered }, built.universe, requirements);
  assert.equal(repair.verdict, 'repair');

  const impostor = c.evaluateAcceptanceGate({ ...provider, providerDigest: '0'.repeat(64) }, { kind: 'formalization.acceptance-bindings.v1', product: greenBundle() }, built.universe, requirements);
  assert.equal(impostor.refused, true);
  assert.equal(impostor.reason, 'PROVIDER_NOT_DECLARED');

  const wrongKind = c.evaluateAcceptanceGate(provider, { kind: 'formalization.prd-intent.v1', product: greenBundle() }, built.universe, requirements);
  assert.equal(wrongKind.refused, true);
  assert.equal(wrongKind.reason, 'PROVIDER_NOT_DECLARED');
});

test('the reason-to-verdict routing is pinned to the frozen kernel table (the cells own the routing since FRF-WP11)', async () => {
  const c = await cell();
  // The installed gate surface (gates.ts) delegates verdict routing to the
  // cells; the FROZEN table below is the pre-cutover gates.ts routing that
  // the cutover preserved verbatim (test-owned literal - never derived
  // from the cell under test).
  const FROZEN_ROUTING = {
    MALFORMED_PRODUCT: 'repair',
    MISSING_LINEAGE: 'repair',
    STALE_LINEAGE: 'repair',
    COVERAGE_GAP: 'repair',
    FOREIGN_LINEAGE: 'upstream-repair',
    DRIFT_DETECTED: 'human-wait',
    SCOPE_VIOLATION: 'terminal-reject',
  };
  assert.deepEqual(c.VERDICT_OF_REASON, FROZEN_ROUTING);
  assert.deepEqual(Object.keys(c.VERDICT_OF_REASON).sort(), [...c.REFUSAL_REASONS].sort());
});

test('the canonical digest rule equals the kernel dist digest rule (continuity)', async () => {
  const c = await cell();
  const wp03 = await moduleImport(join(DOCS_CONTRACTS, 'validators/common.mjs'));
  const kernel = await moduleImport(join(ROOT, 'dist/workflow-kernel/domain/digest.js'));
  const payload = { b: 2, a: [3, { z: 'x', y: 1 }] };
  assert.equal(wp03.sha256OfCanonical(payload), kernel.sha256OfCanonical(payload));
  const skillDigest = (await moduleImport(join(ROOT, 'src/workflow-kernel/workshops/formalization/cells/acceptance/skill.mjs'))).acceptanceSkillDeclaration().digest;
  assert.equal(skillDigest, kernel.sha256OfCanonical({ skillId: 'formalization-desk-define-acceptance-contract', kind: 'semantic', desk: 'define-acceptance-contract' }));
});
