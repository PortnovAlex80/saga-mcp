/**
 * use-cases.test.mjs - FRF-WP04 focused suite for the model-use-cases
 * Production Cell:
 *   - the contract seam (unwired/indeterminate/re-pin kills BEFORE the
 *     real WP03 validator is wired);
 *   - the green path over the REAL WP03 validator with the accepted PRD
 *     universe taken from the upstream define-product-intent cell's
 *     accepted output fold (cross-desk lineage, built live in this
 *     suite through the upstream cell's gate);
 *   - the WP03 RED corpus (08..14) refused with the exact typed codes by
 *     the CELL gate (foreign PRD refs, cross-level branch citations,
 *     open actor/evidence vocabularies, actorless scenarios, dangling
 *     material flows, two main branches, scope violations);
 *   - the UC coverage fence (a scenario_required member with no scenario);
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
  installUcWp03Seam,
  prdUniverseOf,
  greenPrdBundle,
  greenUcBundle,
  redSeeds,
} from './support.mjs';

const prdCell = () => dist('workflow-kernel/workshops/formalization/cells/product-intent/index.js');
const ucCell = () => dist('workflow-kernel/workshops/formalization/cells/use-cases/index.js');

/** Build the upstream accepted intent set LIVE through the upstream cell's gate. */
async function upstreamAcceptedSet() {
  const { cell } = await installProductIntentWp03Seam();
  const provider = cell.declaredProductIntentCheckProvider();
  const outcome = cell.evaluateProductIntentGate(provider, greenPrdBundle(), prdUniverseOf());
  assert.equal(outcome.verdict, 'accepted', JSON.stringify(outcome));
  return outcome.acceptedSet;
}

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
/* Mutation kills that MUST run before the real seam is wired.          */
/* ------------------------------------------------------------------ */

test('mutation kill (validator bypass): an unwired seam refuses fail-closed - never a silent pass', async () => {
  const cell = await ucCell();
  cell.resetUcScenarioContractSeamForTests();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const outcome = cell.evaluateUcGate(provider, greenUcBundle(), upstream);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'CONTRACT_SEAM_UNWIRED');
  assert.match(outcome.detail, /fail-closed/);
  assert.equal('verdict' in outcome, false);
});

test('an indeterminate validator reason routes to the D5 human-input wait (never a pass)', async () => {
  const cell = await ucCell();
  cell.resetUcScenarioContractSeamForTests();
  const fake = cell.installUcScenarioContract({
    contractKind: 'frf-contracts.uc-scenario-member.v1',
    validatorDigest: 'test-fake-indeterminate-uc-validator',
    validateScenario: () => ({ ok: false, refused: true, reason: 'INDETERMINATE_MODEL_GUARD', detail: 'fake indeterminate disposition' }),
  });
  assert.equal(fake.installed, true);
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const outcome = cell.evaluateUcGate(provider, greenUcBundle(), upstream);
  assert.equal(outcome.verdict, 'human-wait');
  assert.equal(outcome.issues[0].source, 'INDETERMINATE:INDETERMINATE_MODEL_GUARD');
  const routing = cell.obligationRoutingOf('human-wait');
  assert.equal(routing.obligationKind, 'obligation:requeueAfterHumanResolution');
  assert.equal(routing.wait.kind, 'TypedWait:human-input');
  assert.deepEqual(routing.wait.wakeCommands, ['workplace.resolveHumanResponse']);
});

test('mutation kill (validator swap): the seam is pinned - a second install with a different digest is refused', async () => {
  const cell = await ucCell();
  const swap = cell.installUcScenarioContract({
    contractKind: 'frf-contracts.uc-scenario-member.v1',
    validatorDigest: 'test-swap-attempt-uc-validator',
    validateScenario: () => ({ ok: true, digest: '0'.repeat(64), ref: 'sha256:' + '0'.repeat(64), kind: 'frf-contracts.uc-scenario-member.v1' }),
  });
  assert.equal(swap.refused, true);
  assert.equal(swap.reason, 'CONTRACT_SEAM_REPINNED');
});

test('mutation kill (fence removal): a mutated declaration never verifies - PROVIDER_NOT_DECLARED', async () => {
  // Wire the REAL WP03 UC seam from here on.
  const cell = await ucCell();
  cell.resetUcScenarioContractSeamForTests();
  await installUcWp03Seam();
  const upstream = await upstreamAcceptedSet();
  const intact = cell.declaredUcCheckProvider();
  const fenceRemoved = { ...intact, fences: [], providerDigest: '0'.repeat(64) };
  const removed = cell.evaluateUcGate(fenceRemoved, greenUcBundle(), upstream);
  assert.equal(removed.refused, true);
  assert.equal(removed.reason, 'PROVIDER_NOT_DECLARED');
  const impostor = { ...intact, providerId: 'frf-cell.not-installed.v1' };
  const impostorOutcome = cell.evaluateUcGate(impostor, greenUcBundle(), upstream);
  assert.equal(impostorOutcome.refused, true);
  assert.equal(impostorOutcome.reason, 'PROVIDER_NOT_DECLARED');
});

test('no upstream accepted intent set supplied is a typed UPSTREAM_NOT_SUPPLIED refusal', async () => {
  const cell = await ucCell();
  const provider = cell.declaredUcCheckProvider();
  const outcome = cell.evaluateUcGate(provider, greenUcBundle(), undefined);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'UPSTREAM_NOT_SUPPLIED');
  assert.match(outcome.detail, /never guesses the accepted universe/);
});

/* ------------------------------------------------------------------ */
/* The green path through the REAL WP03 validator.                     */
/* ------------------------------------------------------------------ */

test('green path: the cell gate accepts the UC bundle against the upstream cell\'s accepted output fold', async () => {
  const { cell } = await installUcWp03Seam();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const outcome = cell.evaluateUcGate(provider, greenUcBundle(), upstream);
  assert.equal(outcome.verdict, 'accepted', JSON.stringify(outcome));
  assert.match(outcome.productRef, /^sha256:[0-9a-f]{64}$/);
  // The downstream fold: scenarios, branch ids at their OWN level, coverage.
  assert.deepEqual(outcome.acceptedSet.scenarioIds, ['uc:checkout-1', 'uc:batch-1']);
  assert.deepEqual(outcome.acceptedSet.branchIdsByScenario['uc:checkout-1'], ['branch:checkout-main', 'branch:checkout-alt']);
  assert.deepEqual(outcome.acceptedSet.branchIdsByScenario['uc:batch-1'], ['branch:batch-main', 'branch:batch-error']);
  assert.deepEqual(outcome.acceptedSet.coveredPrdMemberIds, ['prd:boundary-1', 'prd:outcome-1', 'prd:terminal-1']);
  // Determinism.
  const again = cell.evaluateUcGate(provider, greenUcBundle(), upstream);
  assert.equal(again.productRef, outcome.productRef);
  // Reviewer.
  const review = cell.reviewUcGate(outcome);
  assert.equal(review.verdict, 'accept');
  assert.equal(review.productRef, outcome.productRef);
});

test('the CheckPlan evidence fact is the gate-guard input shape and the plan is deterministic', async () => {
  const cell = await ucCell();
  const plan = cell.ucCheckPlan();
  assert.equal(plan.schemaVersion, 'frf-cell.check-plan.v1');
  assert.equal(plan.nodeId, 'model-use-cases');
  assert.equal(plan.deterministic, true);
  assert.equal(plan.provider.validator, 'wp03:validateUcScenarioMember');
  assert.ok(plan.provider.fences.includes('requirementRefs'));
  const fact = cell.ucCheckPlanEvidence();
  assert.equal(fact.kind, 'CheckPlan');
  assert.equal(fact.producer, 'external-input');
  assert.equal(fact.ref, `evidence:CheckPlan#${plan.provider.providerId}`);
  assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ */
/* The WP03 RED corpus, refused by the CELL gate with the exact codes.  */
/* ------------------------------------------------------------------ */

test('RED corpus: every WP03 uc RED seed is refused by the cell gate with its exact typed code and verdict', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const seeds = redSeeds('uc');
  assert.equal(seeds.length, 7);
  for (const seed of seeds) {
    const bundle = { schemaVersion: 'frf-cell.uc-scenarios.v1', scenarios: [seed.member] };
    const outcome = cell.evaluateUcGate(provider, bundle, upstream);
    assert.equal('refused' in outcome, false, `${seed.file}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.verdict, VERDICT_OF_REASON[seed.reason], `${seed.file}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.issues[0].source, seed.reason, `${seed.file}: ${JSON.stringify(outcome)}`);
  }
});

test('RED seed (cross-desk lineage): a foreign PRD intent ref is refused FOREIGN_LINEAGE and routed upstream-repair', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const foreign = structuredClone(greenUcBundle());
  foreign.scenarios[0] = { ...foreign.scenarios[0], prdIntentRefs: ['prd:not-a-member'] };
  const outcome = cell.evaluateUcGate(provider, foreign, upstream);
  assert.equal(outcome.verdict, 'upstream-repair');
  assert.equal(outcome.issues[0].source, 'FOREIGN_LINEAGE');
  assert.match(outcome.issues[0].detail, /outside the exact accepted id set/);
  const review = cell.reviewUcGate(outcome);
  assert.equal(review.verdict, 'repair');
  assert.equal(review.obligationRouting.obligationKind, 'obligation:routeUpstreamRepair');
});

test('RED seed (cross-level branch citation): a material flow citing a branch of another scenario/level is refused', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const crossLevel = structuredClone(greenUcBundle());
  // The checkout alternate flow cites the BATCH error branch: a branch id
  // that exists, but in another scenario (a cross-level citation).
  crossLevel.scenarios[0] = {
    ...crossLevel.scenarios[0],
    alternateFlows: [{ ...crossLevel.scenarios[0].alternateFlows[0], branchId: 'branch:batch-error' }],
  };
  const outcome = cell.evaluateUcGate(provider, crossLevel, upstream);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'MALFORMED_PRODUCT');
  assert.match(outcome.issues[0].detail, /cross-level citation/);
});

test('RED seed (open vocabularies): open actor kinds and evidence kinds are refused MALFORMED_PRODUCT', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const openActor = structuredClone(greenUcBundle());
  openActor.scenarios[0] = { ...openActor.scenarios[0], actorKind: 'ai_agent' };
  const actorOutcome = cell.evaluateUcGate(provider, openActor, upstream);
  assert.equal(actorOutcome.verdict, 'repair');
  assert.equal(actorOutcome.issues[0].source, 'MALFORMED_PRODUCT');
  assert.match(actorOutcome.issues[0].detail, /closed five-kind vocabulary/);

  const openEvidence = structuredClone(greenUcBundle());
  openEvidence.scenarios[0] = { ...openEvidence.scenarios[0], evidenceKindRefs: ['vibe-check'] };
  const evidenceOutcome = cell.evaluateUcGate(provider, openEvidence, upstream);
  assert.equal(evidenceOutcome.verdict, 'repair');
  assert.equal(evidenceOutcome.issues[0].source, 'MALFORMED_PRODUCT');
  assert.match(evidenceOutcome.issues[0].detail, /closed four-value vocabulary/);
});

/* ------------------------------------------------------------------ */
/* The UC coverage fence and bundle laws.                              */
/* ------------------------------------------------------------------ */

test('RED seed (UC coverage fence): a scenario_required upstream member covered by no scenario is refused COVERAGE_GAP', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const pruned = structuredClone(greenUcBundle());
  pruned.scenarios = pruned.scenarios.filter((scenario) => scenario.scenarioId !== 'uc:batch-1');
  const outcome = cell.evaluateUcGate(provider, pruned, upstream);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'COVERAGE_GAP');
  assert.match(outcome.issues[0].detail, /prd:boundary-1 is covered by no UC scenario/);
});

test('duplicate scenario ids are refused MALFORMED_PRODUCT (substitution or double emission)', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const bundle = structuredClone(greenUcBundle());
  bundle.scenarios.push(structuredClone(bundle.scenarios[0]));
  const outcome = cell.evaluateUcGate(provider, bundle, upstream);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'MALFORMED_PRODUCT');
  assert.match(outcome.issues[0].detail, /duplicate/);
});

test('the bundle fence refuses pre-existing-FR requirements with SCOPE_VIOLATION (terminal-reject)', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const fenced = { ...greenUcBundle(), requirementRefs: ['FR-1'] };
  const outcome = cell.evaluateUcGate(provider, fenced, upstream);
  assert.equal(outcome.verdict, 'terminal-reject');
  assert.equal(outcome.issues[0].source, 'SCOPE_VIOLATION');
  assert.match(outcome.issues[0].detail, /must not require a pre-existing FR/);
});

test('a wrong product kind is a fail-closed PRODUCT_KIND_MISMATCH refusal', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const outcome = cell.evaluateUcGate(provider, { schemaVersion: 'frf-cell.product-intent.v1', members: [] }, upstream);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'PRODUCT_KIND_MISMATCH');
});

/* ------------------------------------------------------------------ */
/* Protocol, template, reviewer refusals.                              */
/* ------------------------------------------------------------------ */

test('the protocol seeds scenario drafts per scenario_required upstream member; drafts are refused by the gate', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const protocol = cell.ucCellProtocol();
  assert.equal(protocol.nodeId, 'model-use-cases');
  assert.deepEqual(protocol.input.kinds, ['brief', 'discovery-capsule.intents', 'upstream.accepted-intent-set']);
  assert.equal(protocol.output.contractKind, 'frf-contracts.uc-scenario-member.v1');
  assert.deepEqual(protocol.declaredTransitions, [
    { on: 'domain.accepted', to: 'derive-system-requirements' },
    { on: 'domain.failed', to: 'complete-failed' },
  ]);
  const drafts = cell.scenarioDraftsOfAcceptedIntents(upstream);
  assert.deepEqual(drafts.map((draft) => draft.seededFromPrdMemberId), upstream.scenarioRequiredMemberIds);
  assert.deepEqual(drafts[0].prdIntentRefs, ['prd:outcome-1']);
  assert.equal(drafts[0].actorKind, null);
  const provider = cell.declaredUcCheckProvider();
  const draftBundle = { schemaVersion: 'frf-cell.uc-scenarios.v1', scenarios: drafts };
  const outcome = cell.evaluateUcGate(provider, draftBundle, upstream);
  assert.equal(outcome.verdict, 'repair');
  assert.equal(outcome.issues[0].source, 'MALFORMED_PRODUCT');
});

test('the product template carries the closed vocabularies for authoring only', async () => {
  const cell = await ucCell();
  const template = cell.ucScenarioMemberTemplate();
  assert.equal(template.contractKind, 'frf-contracts.uc-scenario-member.v1');
  assert.deepEqual([...template.vocabularies.actorKinds].sort(), [
    'external_system', 'human', 'operator', 'scheduler_or_clock', 'sensor_or_environment',
  ]);
  assert.deepEqual([...template.vocabularies.evidenceKinds].sort(), [
    'audit', 'independent-agent-review', 'monitoring', 'test',
  ]);
  assert.deepEqual([...template.vocabularies.branchKinds].sort(), ['alternate', 'error', 'main']);
  assert.equal(template.example.actorKind, 'human');
});

test('the reviewer refuses to review a refused gate (nothing to review) and repairs non-accepted outcomes', async () => {
  const cell = await ucCell();
  const upstream = await upstreamAcceptedSet();
  const provider = cell.declaredUcCheckProvider();
  const refused = cell.evaluateUcGate(provider, { schemaVersion: 'wrong' }, upstream);
  const reviewOfRefused = cell.reviewUcGate(refused);
  assert.equal(reviewOfRefused.refused, true);
  assert.equal(reviewOfRefused.reason, 'GATE_REFUSED_NOTHING_TO_REVIEW');
  const actorless = structuredClone(greenUcBundle());
  delete actorless.scenarios[0].actorKind;
  const actorlessOutcome = cell.evaluateUcGate(provider, actorless, upstream);
  const repairReview = cell.reviewUcGate(actorlessOutcome);
  assert.equal(repairReview.verdict, 'repair');
  assert.equal(repairReview.obligationRouting.obligationKind, 'obligation:requeueRepair');
});

/* ------------------------------------------------------------------ */
/* Kernel composition: WP-17 roles, obligation/wait vocabulary.         */
/* ------------------------------------------------------------------ */

test('the cell role bindings resolve ONCE through the kernel WP-17 resolver (no second resolution path)', async () => {
  const cell = await ucCell();
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const workshopRoles = await dist('workflow-kernel/workshops/formalization/roles.js');
  const bindings = cell.ucRoleBindings();
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
  const first = runtime.resolveOnce(bindings[1].launchKind);
  const second = runtime.resolveOnce(bindings[1].launchKind);
  assert.equal(first.resolved, true);
  assert.equal(second.resolved, true);
  assert.equal(runtime.resolutionCount, 1);
  assert.equal(first.slot.pin, second.slot.pin);
  const skillDeclarations = cell.ucSkillDeclarations();
  assert.equal(skillDeclarations.length, 2);
  for (const skill of skillDeclarations) {
    assert.match(skill.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(skill.servesDesks, ['model-use-cases']);
  }
});

test('the verdict routings use kernel-universe obligation kinds and the D5 wait kind', async () => {
  const cell = await ucCell();
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
