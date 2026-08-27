/**
 * products.test.mjs - the installed semantic dispatch of the Formalization
 * workshop (FRF-WP11 cutover shape): every desk's authored bundle gates
 * GREEN through the installed cells (evaluateProductGate ->
 * cells/dispatch.mjs -> the WP03 contracts at their in-package canonical
 * home), and the desk-contract fences - scope violations, exact lineage,
 * closed coverage, baseline drift, settlement authority - kill through
 * the SAME mutation materializers the FRF scenario corpus proves (the
 * old products.ts validators died at the cutover; this suite re-points
 * their oracle at the new-flow equivalent with the corpus's own seeds).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthoredChain, SOURCE_CLAIM_IDS, CONSTRAINT_IDS, TERMINAL_CLAIM_IDS } from './support.mjs';

const gates = () => import('../../../../dist/workflow-kernel/workshops/formalization/gates.js');
const manifest = () => import('../../../../dist/workflow-kernel/workshops/formalization/manifest.js');
const dispatch = () => import('../../../../dist/workflow-kernel/workshops/formalization/cells/dispatch.mjs');

const DESK_ORDER = [
  'define-product-intent',
  'model-use-cases',
  'derive-system-requirements',
  'define-acceptance-contract',
  'reconcile-what',
  'freeze-what-baseline',
  'define-architecture-contract',
  'settle-formalization',
];

/** The chain state seeded from the capsule universe. */
async function seedChain() {
  return (await dispatch()).acceptedChainOfHandoff({
    digest: 'd'.repeat(64),
    sourceClaimIds: SOURCE_CLAIM_IDS,
    constraintIds: CONSTRAINT_IDS,
    terminalClaimIds: TERMINAL_CLAIM_IDS,
  });
}

/**
 * Drive the authored chain up to (not including) one desk; returns the
 * accepted chain at that desk's entry (fail-loud on any earlier refusal).
 */
async function chainThrough(deskId, chain = undefined) {
  const authored = (chain ?? (await buildAuthoredChain())).authored;
  const g = await gates();
  const m = await manifest();
  const d = await dispatch();
  let accepted = await seedChain();
  for (const desk of DESK_ORDER) {
    if (desk === deskId) break;
    const provider = m.checkProviderOfDesk(desk);
    assert.equal(provider.ok, true, `${desk} provider`);
    const outcome = g.evaluateProductGate(provider.provider, authored[desk].candidate, accepted);
    assert.equal(outcome.verdict, 'accepted', `${desk} green seed: ${JSON.stringify(outcome.issues ?? outcome)}`);
    accepted = d.foldDeskAcceptance(accepted, desk, outcome.fold);
  }
  return { accepted, authored };
}

import { authoredOf } from './support.mjs';

/** Gate one desk's (possibly mutated) authored candidate against the chain at its entry. */
async function gateDesk(deskId, mutate) {
  const chain = await buildAuthoredChain();
  if (mutate !== undefined) {
    mutate(chain);
    chain.authored = authoredOf(chain); // mutations may reassign; the candidates re-bind
  }
  const { accepted, authored } = await chainThrough(deskId, chain);
  const provider = (await manifest()).checkProviderOfDesk(deskId);
  return (await gates()).evaluateProductGate(provider.provider, chain.authored[deskId].candidate ?? authored[deskId].candidate, accepted);
}

test('every authored bundle gates GREEN through the installed cells (the full chain)', async () => {
  const { accepted } = await chainThrough(null);
  assert.ok(accepted.solution, 'the chain folded through every desk to the sealed solution contract');
  assert.equal(accepted.solution.contract.schemaVersion, 'frf-contracts.solution-contract.v1');
});

test('define-product-intent fences: no final artifacts, dispositions exact, foreign claims refused', async () => {
  // The Cell must not produce final FR/NFR/RULE/UC/AC/SRS content (the WP03 scope fence).
  const scoped = await gateDesk('define-product-intent', (chain) => { chain.prd.product.requirements = [{ requirementId: 'fr:smuggled' }]; });
  assert.equal(scoped.verdict, 'terminal-reject');
  assert.equal(scoped.issues[0].source, 'SCOPE_VIOLATION');
  // A member deriving from a foreign source claim is refused (the universe kill).
  const foreign = await gateDesk('define-product-intent', (chain) => { chain.prd.product.members[0].sourceClaimRefs = ['claim:FOREIGN']; });
  assert.equal(foreign.verdict, 'upstream-repair');
  assert.equal(foreign.issues[0].source, 'FOREIGN_LINEAGE');
  // An accepted scope item with no member and no disposition is a coverage gap
  // (prd:scope-2 is the only member citing claim:scope-2).
  const uncovered = await gateDesk('define-product-intent', (chain) => { chain.prd.product.members = chain.prd.product.members.filter((m) => m.memberId !== 'prd:scope-2'); });
  assert.equal(uncovered.verdict, 'repair');
  assert.equal(uncovered.issues[0].source, 'COVERAGE_GAP');
});

test('model-use-cases fences: actor kinds closed, PRD lineage exact, coverage closed', async () => {
  const actorless = await gateDesk('model-use-cases', (chain) => { chain.uc.product.scenarios[0].actorKind = 'robot'; });
  assert.equal(actorless.verdict, 'repair');
  assert.equal(actorless.issues[0].source, 'MALFORMED_PRODUCT');
  const foreign = await gateDesk('model-use-cases', (chain) => { chain.uc.product.scenarios[0].prdIntentRefs = ['prd:FOREIGN']; });
  assert.equal(foreign.verdict, 'upstream-repair');
  assert.equal(foreign.issues[0].source, 'FOREIGN_LINEAGE');
  // A scenario_required PRD member covered by no scenario is a coverage gap.
  const pruned = await gateDesk('model-use-cases', (chain) => { chain.uc.product.scenarios = chain.uc.product.scenarios.filter((s) => s.scenarioId !== 'uc:batch-1'); });
  assert.equal(pruned.verdict, 'repair');
  assert.match(`${pruned.issues[0].source}: ${pruned.issues[0].detail}`, /COVERAGE_GAP|MISSING_LINEAGE/);
});

test('derive-system-requirements fences: stale revisions refused, UC coverage closed, foreign lineage upstream', async () => {
  // A requirement deriving from a foreign UC scenario/branch is refused upstream.
  const foreign = await gateDesk('derive-system-requirements', (chain) => { chain.requirements.product[0].ucScenarioRefs = ['uc:FOREIGN']; });
  assert.equal(foreign.verdict, 'upstream-repair');
  assert.equal(foreign.issues[0].source, 'FOREIGN_LINEAGE');
  // Pruning the batch FR leaves the batch scenario with no obligation.
  const pruned = await gateDesk('derive-system-requirements', (chain) => { chain.requirements.product = chain.requirements.product.filter((r) => r.requirementId !== 'fr:batch-1'); });
  assert.equal(pruned.verdict, 'repair');
  assert.match(`${pruned.issues[0].source}: ${pruned.issues[0].detail}`, /COVERAGE_GAP|MISSING_LINEAGE/);
  // A verification surface outside the accepted set is foreign.
  const foreignSurface = await gateDesk('derive-system-requirements', (chain) => { chain.requirements.deskInput.verificationSurfaceIds = ['surface:FOREIGN']; });
  assert.equal(foreignSurface.verdict, 'upstream-repair');
});

test('define-acceptance-contract fences: WHAT-side only, terminal coverage closed, both citation shapes', async () => {
  // Architecture allocation decisions are refused on the WHAT side.
  const arch = await gateDesk('define-acceptance-contract', (chain) => { chain.acceptance.product.participatingModules = ['svc:cart-api']; });
  assert.equal(arch.verdict, 'terminal-reject');
  assert.equal(arch.issues[0].source, 'SCOPE_VIOLATION');
  // A criterion binding a foreign requirement is refused.
  const foreign = await gateDesk('define-acceptance-contract', (chain) => { chain.acceptance.product.criteria[0].bindsTo.requirementRefs = ['fr:FOREIGN']; });
  assert.equal(foreign.verdict, 'upstream-repair');
  assert.equal(foreign.issues[0].source, 'FOREIGN_LINEAGE');
  // Stripping the terminal-branch binding of a scenario-facing AC is the killed mutation.
  const stripped = await gateDesk('define-acceptance-contract', (chain) => { chain.acceptance.product.criteria[0].bindsTo.ucTerminalBranchRefs = []; });
  assert.equal(stripped.verdict, 'repair');
  assert.match(`${stripped.issues[0].source}: ${stripped.issues[0].detail}`, /MISSING_LINEAGE|MALFORMED_PRODUCT/);
});

test('reconcile-what: the verdict is COMPUTED from the actual chain (never hardcoded consistent)', async () => {
  const m = await manifest();
  const g = await gates();
  // A green chain reconciles consistent.
  const { accepted } = await chainThrough('reconcile-what');
  const provider = m.checkProviderOfDesk('reconcile-what');
  const green = g.evaluateProductGate(provider.provider, { kind: 'formalization.what-reconciliation.v1' }, accepted);
  assert.equal(green.verdict, 'accepted');
  assert.equal(green.fold.report.verdict, 'consistent');
  // A DRIFTED snapshot yields verdict 'gaps' with the named finding - the
  // verdict is COMPUTED by the report-only reconciler, never trusted from
  // input (the acceptance cell's reconcileWhat takes no verdict parameter).
  const acceptance = await import('../../../../dist/workflow-kernel/workshops/formalization/cells/acceptance/index.mjs');
  const atReconcile = await chainThrough('reconcile-what');
  const snapshot = {
    universe: atReconcile.accepted.acceptance.universe,
    requirements: atReconcile.accepted.requirements.sealed.bundle.requirements,
    acceptance: {
      criteria: atReconcile.accepted.acceptance.bundle.criteria,
      deferrals: atReconcile.accepted.acceptance.bundle.deferrals,
      standaloneEvidenceBindings: [], // the drift: the audit evidence binding vanished
    },
    prd: { memberIds: [...atReconcile.accepted.prd.acceptedSet.prdMemberIds], scenarioRequiredMemberIds: [...atReconcile.accepted.prd.acceptedSet.scenarioRequiredMemberIds] },
    useCases: { scenarioIds: [...atReconcile.accepted.useCases.acceptedSet.scenarioIds], branchIdsByScenario: { ...atReconcile.accepted.useCases.acceptedSet.branchIdsByScenario } },
  };
  const drifted = acceptance.reconcileWhat(snapshot);
  assert.equal(drifted.verdict, 'gaps', 'the computed verdict over a drifted chain is gaps');
  assert.ok(drifted.findings.length > 0, 'the gaps verdict enumerates its typed findings');
});

test('freeze-what-baseline: exact set equality, duplicates and drift refused, folded legacy shape refused on sight', async () => {
  // A substituted member digest (the same id carrying another member's digest) is drift.
  const substituted = await gateDesk('freeze-what-baseline', (chain) => {
    const members = chain.baseline.surfaces.containers.uc.members;
    members[0] = { ...members[0], digest: members[members.length - 1].digest };
  });
  assert.equal(substituted.verdict, 'human-wait');
  assert.equal(substituted.issues[0].source, 'DRIFT_DETECTED');
  // The folded legacy shape (the NFR members folded into the FR container) is refused on sight.
  const folded = await gateDesk('freeze-what-baseline', (chain) => {
    chain.baseline.surfaces.containers = {
      ...chain.baseline.surfaces.containers,
      fr: { ...chain.baseline.surfaces.containers.fr, members: [...chain.baseline.surfaces.containers.fr.members, ...chain.baseline.surfaces.containers.nfr.members] },
    };
  });
  assert.notEqual(folded.verdict, 'accepted');
  // An omitted surfaces class (the dispositions surface) is indeterminate (D5), never a guess.
  const indeterminate = await gateDesk('freeze-what-baseline', (chain) => { delete chain.baseline.surfaces.dispositions; });
  assert.equal(indeterminate.verdict, 'human-wait');
  // The frozen baseline is deterministic: the same surfaces freeze the same whole-WHAT digest.
  const green = await gateDesk('freeze-what-baseline');
  assert.equal(green.verdict, 'accepted');
  const material = await import('./support.mjs').then((s) => s.corpusMaterial());
  assert.equal(green.fold.baseline.wholeWhatDigest, material.greenBaselineFixture().wholeWhatDigest);
});

test('define-architecture-contract: scenario realization must be a connected runtime graph', async () => {
  // Removing the entrypoint surface (the Elite missing-entrypoint kill) is refused.
  const noEntrypoint = await gateDesk('define-architecture-contract', (chain) => {
    chain.srs.product.realizationEntries[0] = {
      ...chain.srs.product.realizationEntries[0],
      participatingSurfaceRefs: ['module:audit-log'],
      runtimeEdges: [{ fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:checkout-rendered' }],
    };
    chain.srs.product.surfaces = chain.srs.product.surfaces.filter((surface) => surface.surfaceId !== 'svc:cart-api');
  });
  assert.equal(noEntrypoint.verdict, 'repair');
  assert.match(`${noEntrypoint.issues[0].source}: ${noEntrypoint.issues[0].detail}`, /COVERAGE_GAP|MISSING_LINEAGE|entrypoint|surface/i);
  // A guessed SRS revision pin is refused fail-closed.
  const guessed = await gateDesk('define-architecture-contract', (chain) => { chain.srs.deskInput.srsRevisionDigest = 'not-a-digest'; });
  assert.equal(guittedRefusal(guessed), true);
});

test('settle-formalization: exact references to BOTH authorities; foreign handoff bindings refused (the UC-FOREIGN kill)', async () => {
  // A handoff kind citing a value outside the exact frozen surface is FOREIGN (cr-02).
  const foreign = await gateDesk('settle-formalization', (chain) => { chain.solution.product['requirement-bindings'] = ['fr:FOREIGN']; });
  assert.equal(foreign.verdict, 'terminal-reject');
  assert.match(`${foreign.issues[0].source}: ${foreign.issues[0].detail}`, /FOREIGN_LINEAGE|MISSING_LINEAGE/);
  // Stripping the scenario bindings while retaining the AC ids is refused (D-2/D-17).
  const stripped = await gateDesk('settle-formalization', (chain) => { delete chain.solution.product['scenario-bindings']; });
  assert.equal(stripped.verdict, 'terminal-reject');
  assert.match(`${stripped.issues[0].source}: ${stripped.issues[0].detail}`, /MISSING_LINEAGE/);
  // The lawful twelve-kind handoff seals over both authorities.
  const green = await gateDesk('settle-formalization');
  assert.equal(green.verdict, 'accepted');
  assert.equal(green.fold.contract.schemaVersion, 'frf-contracts.solution-contract.v1');
});

function guittedRefusal(outcome) {
  return outcome.refused === true || (outcome.issues ?? []).some((issue) => issue.source === 'MISSING_LINEAGE');
}
