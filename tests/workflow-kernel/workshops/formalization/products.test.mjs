/**
 * products.test.mjs - the content-addressed product schemas and pure
 * validators of the Formalization workshop (WP-11F): desk-contract fences,
 * exact lineage, closed coverage, baseline drift and settlement authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthoredChain, buildHandoffCapsule, sha256 } from './support.mjs';

const products = () => import('../../../../dist/workflow-kernel/workshops/formalization/products.js');

test('every authored product validates against the folded accepted chain', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const a = chain.acceptedAt;
  assert.equal(p.validatePrdIntent(chain.prd.product, chain.accepted0).ok, true);
  assert.equal(p.validateUseCaseScenarios(chain.uc.product, a.prd).ok, true);
  assert.equal(p.validateSystemRequirements(chain.requirements.product, a.uc).ok, true);
  assert.equal(p.validateAcceptanceContract(chain.acceptance.product, a.requirements).ok, true);
  assert.equal(p.validateWhatReconciliation(chain.reconciliation.product, a.acceptance).ok, true);
  assert.equal(p.validateWhatBaseline(chain.baseline.product, chain.baseline.expected).ok, true);
  assert.equal(p.validateSrs(chain.srs.product, a.baseline).ok, true);
  assert.equal(p.validateSolutionContract(chain.solution.product, a.srs).ok, true);
});

test('artifacts are content-addressed and versioned', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  for (const entry of [chain.prd, chain.uc, chain.requirements, chain.acceptance, chain.reconciliation, chain.baseline, chain.srs, chain.solution]) {
    assert.match(entry.artifact.ref, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.artifact.ref, `sha256:${entry.artifact.digest}`);
    assert.equal(typeof entry.product.schemaVersion, 'string');
  }
});

test('define-product-intent fences: no final artifacts, dispositions exact', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  // The Cell must not produce final FR/NFR/RULE/UC/AC/SRS artifacts.
  const scoped = { ...chain.prd.product, requirements: [{ requirementId: 'FR-X' }] };
  assert.equal(p.validatePrdIntent(scoped, chain.accepted0).reason, 'SCOPE_VIOLATION');
  // Every intent member must have exactly one disposition.
  const missingDisposition = { ...chain.prd.product, dispositions: chain.prd.product.dispositions.slice(0, 3) };
  assert.equal(p.validatePrdIntent(missingDisposition, chain.accepted0).reason, 'COVERAGE_GAP');
  // deferred requires owner + reason.
  const deferred = { ...chain.prd.product, dispositions: chain.prd.product.dispositions.map((d) => d.memberId === 'PRD-M4' ? { ...d, disposition: 'deferred' } : d) };
  assert.equal(p.validatePrdIntent(deferred, chain.accepted0).reason, 'MALFORMED_PRODUCT');
  // A member deriving from a foreign source claim is refused.
  const foreign = { ...chain.prd.product, members: chain.prd.product.members.map((m) => m.memberId === 'PRD-M1' ? { ...m, sourceClaimRefs: ['SC-FOREIGN'] } : m) };
  assert.equal(p.validatePrdIntent(foreign, chain.accepted0).reason, 'FOREIGN_LINEAGE');
});

test('model-use-cases fences: actor kinds closed, PRD lineage exact', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  // An actorless scenario is refused.
  const actorless = { ...chain.uc.product, scenarios: chain.uc.product.scenarios.map((s) => ({ ...s, actorKind: 'robot' })) };
  assert.equal(p.validateUseCaseScenarios(actorless, chain.acceptedAt.prd).reason, 'MALFORMED_PRODUCT');
  // A UC deriving from a PRD member outside the accepted revision is refused.
  const foreign = { ...chain.uc.product, scenarios: chain.uc.product.scenarios.map((s) => s.scenarioId === 'UC-1' ? { ...s, prdIntentRefs: ['PRD-FOREIGN'] } : s) };
  assert.equal(p.validateUseCaseScenarios(foreign, chain.acceptedAt.prd).reason, 'FOREIGN_LINEAGE');
  // Every scenario_required PRD member must be covered by a UC.
  const pruned = { ...chain.uc.product, scenarios: chain.uc.product.scenarios.slice(0, 1) };
  const prunedOutcome = p.validateUseCaseScenarios(pruned, chain.acceptedAt.prd);
  assert.equal(prunedOutcome.reason, 'COVERAGE_GAP');
  assert.match(prunedOutcome.detail, /PRD-M3/);
});

test('derive-system-requirements fences: stale revisions refused, UC coverage closed', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const accepted = chain.acceptedAt.uc;
  // A stale pinned PRD revision is refused.
  const stale = { ...chain.requirements.product, prdRevisionRef: 'sha256:' + '0'.repeat(64) };
  assert.equal(p.validateSystemRequirements(stale, accepted).reason, 'STALE_LINEAGE');
  // A requirement deriving from a foreign UC scenario is refused.
  const foreign = { ...chain.requirements.product, requirements: chain.requirements.product.requirements.map((r) => r.requirementId === 'FR-1' ? { ...r, ucScenarioRefs: ['UC-FOREIGN'] } : r) };
  assert.equal(p.validateSystemRequirements(foreign, accepted).reason, 'FOREIGN_LINEAGE');
  // Every accepted UC must yield at least one observable behavior obligation.
  const pruned = { ...chain.requirements.product, requirements: chain.requirements.product.requirements.filter((r) => r.requirementId !== 'FR-3') };
  const prunedOutcome = p.validateSystemRequirements(pruned, accepted);
  assert.equal(prunedOutcome.reason, 'COVERAGE_GAP');
  assert.match(prunedOutcome.detail, /UC-2/);
});

test('define-acceptance-contract fences: WHAT-side only, terminal coverage closed', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const accepted = chain.acceptedAt.requirements;
  // Architecture allocation decisions are refused on the WHAT side.
  const arch = { ...chain.acceptance.product, participatingModules: ['http-gateway'] };
  assert.equal(p.validateAcceptanceContract(arch, accepted).reason, 'SCOPE_VIOLATION');
  // A criterion binding a foreign requirement is refused.
  const foreign = { ...chain.acceptance.product, criteria: chain.acceptance.product.criteria.map((c) => c.criterionId === 'AC-1' ? { ...c, requirementRefs: ['FR-FOREIGN'] } : c) };
  assert.equal(p.validateAcceptanceContract(foreign, accepted).reason, 'FOREIGN_LINEAGE');
  // Every required UC terminal result needs an end-to-end AC.
  const pruned = { ...chain.acceptance.product, criteria: chain.acceptance.product.criteria.filter((c) => c.criterionId !== 'AC-3') };
  const prunedOutcome = p.validateAcceptanceContract(pruned, accepted);
  assert.equal(prunedOutcome.reason, 'COVERAGE_GAP');
  assert.match(prunedOutcome.detail, /UC-2/);
});

test('reconcile-what: consistent verdict requires the closed chain', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const accepted = chain.acceptedAt.acceptance;
  // A dropped chain row is a coverage gap.
  const dropped = { ...chain.reconciliation.product, rows: chain.reconciliation.product.rows.slice(1) };
  const droppedOutcome = p.validateWhatReconciliation(dropped, accepted);
  assert.equal(droppedOutcome.reason, 'COVERAGE_GAP');
  assert.match(droppedOutcome.detail, /SC-1/);
  // A consistent verdict must not carry gaps.
  const inconsistent = { ...chain.reconciliation.product, gaps: [{ direction: 'forward', detail: 'gap' }] };
  assert.equal(p.validateWhatReconciliation(inconsistent, accepted).reason, 'MALFORMED_PRODUCT');
});

test('freeze-what-baseline: exact set equality, duplicates and drift refused', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  // A drifted input digest is refused.
  const drifted = { ...chain.baseline.product, inputs: { ...chain.baseline.product.inputs, prdRevisionDigest: 'f'.repeat(64) } };
  const driftedOutcome = p.validateWhatBaseline(drifted, chain.baseline.expected);
  assert.equal(driftedOutcome.reason, 'DRIFT_DETECTED');
  // An extra member digest is refused (exact set equality).
  const extra = { ...chain.baseline.product, memberDigests: [...chain.baseline.product.memberDigests, 'e'.repeat(64)] };
  assert.equal(p.validateWhatBaseline(extra, chain.baseline.expected).reason, 'DRIFT_DETECTED');
  // A duplicated member is refused at freeze time.
  const duplicateFreeze = p.freezeWhatBaseline({ ...chain.baseline.expected, memberDigests: [...chain.baseline.expected.memberDigests, chain.baseline.expected.memberDigests[0]] });
  assert.equal(duplicateFreeze.reason, 'DRIFT_DETECTED');
  // The whole-WHAT digest verifies over the exact accepted inputs.
  const refrozen = p.freezeWhatBaseline(chain.baseline.expected);
  assert.equal(refrozen.ok, true);
  assert.equal(refrozen.product.wholeWhatDigest, chain.baseline.product.wholeWhatDigest);
});

test('define-architecture-contract: scenario realization must be a connected runtime graph', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const accepted = chain.acceptedAt.baseline;
  // A stale pinned baseline is refused.
  const stale = { ...chain.srs.product, baselineRef: 'sha256:' + '0'.repeat(64) };
  assert.equal(p.validateSrs(stale, accepted).reason, 'STALE_LINEAGE');
  // A disconnected module is refused (a flat list of files is not connectivity).
  const disconnected = { ...chain.srs.product, scenarioRealizations: chain.srs.product.scenarioRealizations.map((r) => r.scenarioId === 'UC-2' ? { ...r, participatingModules: [...r.participatingModules, 'orphan-module'] } : r) };
  const disconnectedOutcome = p.validateSrs(disconnected, accepted);
  assert.equal(disconnectedOutcome.reason, 'COVERAGE_GAP');
  assert.match(disconnectedOutcome.detail, /orphan-module/);
  // A missing realization is a coverage gap.
  const missing = { ...chain.srs.product, scenarioRealizations: chain.srs.product.scenarioRealizations.slice(0, 1) };
  assert.equal(p.validateSrs(missing, accepted).reason, 'COVERAGE_GAP');
});

test('settle-formalization: exact references to BOTH authorities', async () => {
  const p = await products();
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const accepted = chain.acceptedAt.srs;
  // A stale SRS reference is refused.
  const stale = { ...chain.solution.product, srsRef: 'sha256:' + '0'.repeat(64) };
  assert.equal(p.validateSolutionContract(stale, accepted).reason, 'STALE_LINEAGE');
  // A drifted canonical digest is refused.
  const drifted = { ...chain.solution.product, canonicalDigest: '0'.repeat(64) };
  assert.equal(p.validateSolutionContract(drifted, accepted).reason, 'DRIFT_DETECTED');
  // The handoff requires typed non-empty values for every binding.
  const incomplete = p.settleSolutionContract(
    { revisionDigest: chain.acceptedAt.baseline.baseline.revisionDigest, wholeWhatDigest: chain.acceptedAt.baseline.baseline.wholeWhatDigest },
    { revisionDigest: accepted.srs.revisionDigest, realizedScenarioIds: ['UC-1', 'UC-2'] },
    {
      certificateRef: 'sha256:' + sha256('discovery-certificate'),
      prdIntentBindings: [],
      scenarioBindings: ['UC-1'],
      requirementBindings: ['FR-1'],
      acceptanceBindings: ['AC-1'],
      scenarioRealizationBindings: ['UC-1'],
      terminalClaimBindings: ['TC-1'],
      integrationObligations: ['seam:frontend-to-api'],
      repositoryPolicyBindings: ['policy:deterministic-responses'],
    },
  );
  assert.equal(incomplete.reason, 'MALFORMED_PRODUCT');
  assert.match(incomplete.detail, /prdIntentBindings/);
});
