/**
 * product-intent.test.mjs - FRF-WP04 focused suite for the
 * define-product-intent Production Cell:
 *   - the contract seam (unwired/indeterminate/re-pin kills BEFORE the
 *     real WP03 validator is wired);
 *   - the green path (the WP03 green member + the desk coverage law)
 *     through the REAL WP03 validator with the accepted-id-set universe;
 *   - the WP03 RED corpus (01..07) refused with the exact typed codes by
 *     the CELL gate - the UC-FOREIGN class fix demonstrated at the cell
 *     level (foreign source-claim refs -> FOREIGN_LINEAGE -> upstream-repair);
 *   - cell-level laws: desk coverage (scope claim without disposition /
 *     uncovered claim), duplicate members, bundle fence;
 *   - mutation kills: validator bypass (unwired seam), fence removal
 *     (declaration digest), validator swap (re-pin);
 *   - kernel composition: WP-17 role bindings resolve once; obligation
 *     and wait kinds are kernel-universe vocabulary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dist,
  installProductIntentWp03Seam,
  prdUniverseOf,
  greenPrdBundle,
  redSeeds,
} from './support.mjs';

const cellModule = () => dist('workflow-kernel/workshops/formalization/cells/product-intent/index.js');
const universe = prdUniverseOf();

/* The verdict the frozen routing table assigns to each typed refusal. */
const VERDICT_OF_REASON = {
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'human-wait',
  SCOPE_VIOLATION: 'terminal-reject',
};

/* ------------------------------------------------------------------ */
/* Seam-lifecycle laws in the INSTALLED wiring (FRF-WP11).             */
/* ------------------------------------------------------------------ */

test('the installed seam resolves ONLY the pinned in-package validator (a bypass never resolves)', async () => {
  const cell = await cellModule();
  const identity = await import('../../../../../dist/workflow-kernel/workshops/formalization/contracts/identity.js');
  const seam = cell.resolveProductIntentContract();
  assert.equal(seam.resolved, true, 'the installed package never runs an unwired seam');
  // The resolved port carries EXACTLY the pinned digest (the package
  // identity table - the successor of the pre-cutover unwired-seam kill:
  // a bypassed or swapped validator can never be the resolved port).
  assert.equal(seam.port.validatorDigest, identity.contractDigestOf('prd-intent-member'));
  assert.equal(seam.port.contractKind, 'frf-contracts.prd-intent-member.v1');
  // The resolved port IS the WP03 member behavior (fail-closed self-test).
  const refusedNull = seam.port.validateMember(null, universe);
  assert.equal(refusedNull.ok, false);
  assert.equal(refusedNull.reason, 'MALFORMED_PRODUCT');
});

test('the D5 human-input routing stays the declared wait of last resort (never a pass)', async () => {
  const cell = await cellModule();
  const routing = cell.obligationRoutingOf('human-wait');
  assert.equal(routing.obligationKind, 'obligation:requeueAfterHumanResolution');
  assert.equal(routing.wait.kind, 'TypedWait:human-input');
  assert.deepEqual(routing.wait.wakeCommands, ['workplace.resolveHumanResponse']);
});

test('mutation kill (validator swap): the seam is pinned - a second install with a different digest is refused', async () => {
  const cell = await cellModule();
  const swap = cell.installProductIntentContract({
    contractKind: 'frf-contracts.prd-intent-member.v1',
    validatorDigest: 'test-swap-attempt-validator',
    validateMember: () => ({ ok: true, digest: '0'.repeat(64), ref: 'sha256:' + '0'.repeat(64), kind: 'frf-contracts.prd-intent-member.v1' }),
  });
  assert.equal(swap.refused, true);
  assert.equal(swap.reason, 'CONTRACT_SEAM_REPINNED');
});

test('mutation kill (fence removal): a mutated declaration never verifies - PROVIDER_NOT_DECLARED', async () => {
  const cell = await cellModule();
  const intact = cell.declaredProductIntentCheckProvider();
  // Fence removal: same id/kind/validator, empty fence list.
  const fenceRemoved = { ...intact, fences: [], providerDigest: '0'.repeat(64) };
  const removed = cell.evaluateProductIntentGate(fenceRemoved, greenPrdBundle(), universe);
  assert.equal(removed.refused, true);
  assert.equal(removed.reason, 'PROVIDER_NOT_DECLARED');
  // An impostor provider id is refused identically.
  const impostor = { ...intact, providerId: 'frf-cell.not-installed.v1' };
  const impostorOutcome = cell.evaluateProductIntentGate(impostor, greenPrdBundle(), universe);
  assert.equal(impostorOutcome.refused, true);
  assert.equal(impostorOutcome.reason, 'PROVIDER_NOT_DECLARED');
});

/* ------------------------------------------------------------------ */
/* The green path through the REAL WP03 validator.                     */
/* ------------------------------------------------------------------ */

test('green path: the cell gate accepts the green bundle over the real WP03 validator and folds the accepted intent set', async () => {
  const { cell } = await installProductIntentWp03Seam();
  const provider = cell.declaredProductIntentCheckProvider();
  const outcome = cell.evaluateProductIntentGate(provider, greenPrdBundle(), universe);
  assert.equal(outcome.verdict, 'accepted', JSON.stringify(outcome));
  assert.match(outcome.productRef, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(outcome.acceptedSet.prdMemberIds, [
    'prd:outcome-1', 'prd:boundary-1', 'prd:constraint-1', 'prd:scope-2', 'prd:terminal-1', 'prd:unknown-1',
  ]);
  assert.deepEqual(outcome.acceptedSet.scenarioRequiredMemberIds, ['prd:outcome-1', 'prd:boundary-1', 'prd:terminal-1']);
  assert.equal(outcome.acceptedSet.memberDigests.length, 6);
  assert.match(outcome.acceptedSet.revisionDigest, /^[0-9a-f]{64}$/);
  // Determinism: the same bundle yields the identical product ref.
  const again = cell.evaluateProductIntentGate(provider, greenPrdBundle(), universe);
  assert.equal(again.productRef, outcome.productRef);
  // Reviewer: an accepted gate is reviewed 'accept'.
  const review = cell.reviewProductIntentGate(outcome);
  assert.equal(review.verdict, 'accept');
  assert.equal(review.productRef, outcome.productRef);
});

test('the CheckPlan evidence fact is the gate-guard input shape and the plan is deterministic', async () => {
  const cell = await cellModule();
  const plan = cell.productIntentCheckPlan();
  assert.equal(plan.schemaVersion, 'frf-cell.check-plan.v1');
  assert.equal(plan.nodeId, 'define-product-intent');
  assert.equal(plan.deterministic, true);
  assert.equal(plan.provider.validator, 'wp03:validatePrdIntentMember');
  assert.ok(plan.provider.fences.includes('requirements'));
  const fact = cell.productIntentCheckPlanEvidence();
  assert.equal(fact.kind, 'CheckPlan');
  assert.equal(fact.producer, 'external-input');
  assert.equal(fact.ref, `evidence:CheckPlan#${plan.provider.providerId}`);
  assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ */
/* The WP03 RED corpus, refused by the CELL gate with the exact codes.  */
/* ------------------------------------------------------------------ */

test('RED corpus: every WP03 prd RED seed is refused by the cell gate with its exact typed code and verdict', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const seeds = redSeeds('prd');
  assert.equal(seeds.length, 7);
  for (const seed of seeds) {
    const bundle = { schemaVersion: 'frf-cell.product-intent.v1', brief: 'red seed bundle', members: [seed.member] };
    const outcome = cell.evaluateProductIntentGate(provider, bundle, universe);
    assert.equal('refused' in outcome, false, `${seed.file}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.verdict, VERDICT_OF_REASON[seed.reason], `${seed.file}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.issues[0].source, seed.reason, `${seed.file}: ${JSON.stringify(outcome)}`);
  }
});

test('RED seed (UC-FOREIGN class at cell level): a foreign source-claim ref is refused FOREIGN_LINEAGE and routed upstream-repair', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const foreign = structuredClone(greenPrdBundle());
  foreign.members[0] = { ...foreign.members[0], sourceClaimRefs: ['claim:not-in-handoff'] };
  const outcome = cell.evaluateProductIntentGate(provider, foreign, universe);
  assert.equal(outcome.verdict, 'upstream-repair');
  assert.equal(outcome.issues[0].source, 'FOREIGN_LINEAGE');
  assert.match(outcome.issues[0].detail, /outside the exact accepted id set/);
  // The reviewer turns it into a repair verdict with the typed feedback and
  // the kernel routes it as obligation:routeUpstreamRepair (never a widen).
  const review = cell.reviewProductIntentGate(outcome);
  assert.equal(review.verdict, 'repair');
  assert.equal(review.obligationRouting.obligationKind, 'obligation:routeUpstreamRepair');
});

test('RED seed (coverage): a scope claim member without a disposition is refused COVERAGE_GAP', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const bundle = structuredClone(greenPrdBundle());
  const { disposition, ...withoutDisposition } = bundle.members[0];
  assert.notEqual(disposition, undefined);
  bundle.members[0] = withoutDisposition;
  const outcome = cell.evaluateProductIntentGate(provider, bundle, universe);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'COVERAGE_GAP');
  assert.match(outcome.issues[0].detail, /no required disposition/);
});

test('RED seed (desk coverage law): an accepted Discovery claim realized by no member is refused COVERAGE_GAP', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const bundle = structuredClone(greenPrdBundle());
  // prd:scope-2 is the only member realizing claim:scope-2; drop it.
  bundle.members = bundle.members.filter((member) => member.memberId !== 'prd:scope-2');
  const outcome = cell.evaluateProductIntentGate(provider, bundle, universe);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'COVERAGE_GAP');
  assert.match(outcome.issues[0].detail, /claim:scope-2/);
});

/* ------------------------------------------------------------------ */
/* Cell-level bundle laws.                                             */
/* ------------------------------------------------------------------ */

test('duplicate member ids are refused MALFORMED_PRODUCT (substitution or double emission)', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const bundle = structuredClone(greenPrdBundle());
  bundle.members.push(structuredClone(bundle.members[0]));
  const outcome = cell.evaluateProductIntentGate(provider, bundle, universe);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'MALFORMED_PRODUCT');
  assert.match(outcome.issues[0].detail, /duplicate/);
});

test('the bundle fence refuses final-requirements content with SCOPE_VIOLATION (terminal-reject)', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const fenced = { ...greenPrdBundle(), requirements: [{ fr: 'FR-1 The service exposes /healthz.' }] };
  const outcome = cell.evaluateProductIntentGate(provider, fenced, universe);
  assert.equal(outcome.verdict, 'terminal-reject');
  assert.equal(outcome.issues[0].source, 'SCOPE_VIOLATION');
  assert.match(outcome.issues[0].detail, /must not produce final requirements content/);
});

test('a wrong product kind is a fail-closed PRODUCT_KIND_MISMATCH refusal', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const outcome = cell.evaluateProductIntentGate(provider, { schemaVersion: 'frf-cell.uc-scenarios.v1', scenarios: [] }, universe);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'PRODUCT_KIND_MISMATCH');
});

/* ------------------------------------------------------------------ */
/* Protocol, template, reviewer refusals.                              */
/* ------------------------------------------------------------------ */

test('the protocol seeds member drafts from capsule intents; drafts are not products and are refused by the gate', async () => {
  const cell = await cellModule();
  const protocol = cell.productIntentProtocol();
  assert.equal(protocol.nodeId, 'define-product-intent');
  assert.deepEqual(protocol.input.kinds, ['brief', 'discovery-capsule.intents']);
  assert.equal(protocol.output.contractKind, 'frf-contracts.prd-intent-member.v1');
  assert.deepEqual(protocol.declaredTransitions, [
    { on: 'domain.accepted', to: 'model-use-cases' },
    { on: 'domain.failed', to: 'complete-failed' },
  ]);
  const drafts = cell.memberDraftsOfCapsuleIntents({
    brief: 'b',
    capsuleIntents: [{ intentId: 'outcome-1', statement: 'Shoppers complete checkout.', sourceClaimRefs: ['claim:outcome-1'] }],
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].memberId, 'prd:outcome-1');
  assert.equal(drafts[0].disposition, null);
  const provider = cell.declaredProductIntentCheckProvider();
  const draftBundle = { schemaVersion: 'frf-cell.product-intent.v1', brief: 'b', members: drafts };
  const outcome = cell.evaluateProductIntentGate(provider, draftBundle, universe);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'MALFORMED_PRODUCT');
});

test('the product template carries the closed vocabularies for authoring only', async () => {
  const cell = await cellModule();
  const template = cell.productIntentMemberTemplate();
  assert.equal(template.contractKind, 'frf-contracts.prd-intent-member.v1');
  assert.deepEqual([...template.vocabularies.memberKinds].sort(), [
    'actor-stakeholder', 'assumption-unknown', 'constraint', 'outcome', 'scope-exclusion', 'system-boundary', 'terminal-claim',
  ]);
  assert.deepEqual([...template.vocabularies.dispositions].sort(), [
    'deferred', 'direct_requirement', 'out_of_scope', 'scenario_required',
  ]);
  assert.equal(template.example.disposition.disposition, 'scenario_required');
});

test('the reviewer refuses to review a refused gate (nothing to review) and repairs non-accepted outcomes', async () => {
  const cell = await cellModule();
  const provider = cell.declaredProductIntentCheckProvider();
  const refused = cell.evaluateProductIntentGate(provider, { schemaVersion: 'wrong' }, universe);
  const reviewOfRefused = cell.reviewProductIntentGate(refused);
  assert.equal(reviewOfRefused.refused, true);
  assert.equal(reviewOfRefused.reason, 'GATE_REFUSED_NOTHING_TO_REVIEW');
  const fenced = cell.evaluateProductIntentGate(provider, { ...greenPrdBundle(), brief: '' }, universe);
  const repairReview = cell.reviewProductIntentGate(fenced);
  assert.equal(repairReview.verdict, 'repair');
  assert.equal(repairReview.obligationRouting.obligationKind, 'obligation:requeueRepair');
});

/* ------------------------------------------------------------------ */
/* Kernel composition: WP-17 roles, obligation/wait vocabulary.         */
/* ------------------------------------------------------------------ */

test('the cell role bindings resolve ONCE through the kernel WP-17 resolver (no second resolution path)', async () => {
  const cell = await cellModule();
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const workshopRoles = await dist('workflow-kernel/workshops/formalization/roles.js');
  const bindings = cell.productIntentRoleBindings();
  assert.deepEqual(bindings.map((binding) => binding.launchKind), [
    'formalization.implementation.author',
    'formalization.implementation.reviewer',
  ]);
  const author = compiler.compileRoleContract(workshopRoles.buildFormalizationAuthorFixture());
  const reviewer = compiler.compileRoleContract(workshopRoles.buildFormalizationReviewerFixture());
  assert.equal(author.compiled, true);
  assert.equal(reviewer.compiled, true);
  const runtime = new workshopRoles.FormalizationRoleRuntime([
    { launchKind: bindings[0].launchKind, contract: author.contract },
    { launchKind: bindings[1].launchKind, contract: reviewer.contract },
  ]);
  const first = runtime.resolveOnce(bindings[0].launchKind);
  const second = runtime.resolveOnce(bindings[0].launchKind);
  assert.equal(first.resolved, true);
  assert.equal(second.resolved, true);
  assert.equal(runtime.resolutionCount, 1);
  assert.equal(first.slot.pin, second.slot.pin);
  const skillDeclarations = cell.productIntentSkillDeclarations();
  assert.equal(skillDeclarations.length, 2);
  for (const skill of skillDeclarations) {
    assert.match(skill.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(skill.servesDesks, ['define-product-intent']);
  }
});

test('the verdict routings use kernel-universe obligation kinds and the D5 wait kind', async () => {
  const cell = await cellModule();
  const universeModule = await dist('workflow-kernel/domain/universe.js');
  const obligationKinds = new Set(universeModule.OBLIGATION_KINDS);
  const evidenceKinds = new Set(universeModule.EVIDENCE_KINDS);
  for (const verdict of ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']) {
    const routing = cell.obligationRoutingOf(verdict);
    if (routing.obligationKind !== null) {
      assert.equal(obligationKinds.has(routing.obligationKind), true, `${routing.obligationKind} must be kernel vocabulary`);
    }
    if (routing.wait !== null) {
      assert.equal(evidenceKinds.has(routing.wait.kind), true, `${routing.wait.kind} must be kernel vocabulary`);
    }
  }
  assert.deepEqual(cell.obligationRoutingOf('terminal-reject'), { verdict: 'terminal-reject', obligationKind: null, wait: null });
});
