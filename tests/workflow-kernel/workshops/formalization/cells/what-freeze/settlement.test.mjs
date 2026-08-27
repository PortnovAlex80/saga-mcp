/**
 * settlement.test.mjs - the FRF-WP07 settle desk: the settlement ladder,
 * the solution contract seal, and THE UC-FOREIGN KILL at the contract
 * level (ledger D-1 / reverse cr-02: every handoff binding resolves
 * against the FROZEN baseline's exact id sets; FOREIGN_LINEAGE refusal).
 * Mirrors the honest reproduction committed at WP01
 * (baseline/uc-foreign-reproduction.mjs): there, a contract whose EVERY
 * binding array was foreign validated {ok:true}; here it must die.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clone,
  cellModule,
  freezeAccepted,
  greenBaselineFixture,
  lawfulHandoffOf,
  repositoryPolicyRefsOf,
  settleFrozen,
  srsAuthorityOf,
} from './support.mjs';

test('the settlement ladder seals the solution contract over both exact authorities (3 content-addressed rungs)', async () => {
  const frozen = await freezeAccepted();
  const result = await settleFrozen(frozen);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'formalized');
  assert.equal(result.rung, 'sealed-contract');
  assert.equal(result.ladder.length, 3);
  for (const rung of result.ladder) assert.match(rung.ref, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.contract.canonicalDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.contract.whatBaselineRef, frozen.artifact.ref);
  assert.equal(result.contract.wholeWhatDigest, frozen.baseline.wholeWhatDigest);
});

test('the settled contract pins both authorities and validates through the binding-aware validator', async () => {
  const settlement = await cellModule('settlement');
  const frozen = await freezeAccepted();
  const settled = await settleFrozen(frozen);
  const validation = settlement.validateSolutionContract(
    settled.contract,
    frozen.baseline,
    frozen.artifact,
    srsAuthorityOf(),
    repositoryPolicyRefsOf(),
  );
  assert.equal(validation.ok, true);
  assert.equal(validation.artifact.ref, `sha256:${validation.artifact.digest}`);
});

test('RED SEED (foreign handoff binding): the UC-FOREIGN reproduction is killed - FOREIGN_LINEAGE, outcome inconsistent', async () => {
  const frozen = await freezeAccepted();
  const green = greenBaselineFixture();
  // The exact WP01 reproduction shape: a lawful eight-link chain plus a
  // contract whose EVERY binding array is foreign.
  const foreignHandoff = {
    ...lawfulHandoffOf(green),
    'prd-intent-bindings': ['prd:FOREIGN-admin-shell'],
    'scenario-bindings': ['uc:FOREIGN-admin-shell'],
    'requirement-bindings': ['fr:FOREIGN-never-derived'],
    'acceptance-bindings': ['ac:FOREIGN-never-accepted'],
    'scenario-realization-bindings': ['realization:FOREIGN'],
    'terminal-claim-bindings': ['terminal:FOREIGN'],
  };
  const result = await settleFrozen(frozen, { handoff: foreignHandoff });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'inconsistent');
  assert.equal(result.refusal.reason, 'FOREIGN_LINEAGE');
  assert.match(result.refusal.detail, /outside the exact frozen surface/);
  assert.equal(result.contract, null);
});

test('RED SEED (stripped bindings): all AC ids retained but UC/scenario bindings stripped is refused (cr-02)', async () => {
  const frozen = await freezeAccepted();
  const stripped = { ...lawfulHandoffOf() };
  delete stripped['scenario-bindings'];
  const result = await settleFrozen(frozen, { handoff: stripped });
  // The typed kill: the handoff is refused (the settle desk cannot seal a
  // contract over an incomplete handoff); the declared table routes the
  // missing-value class to domain.failed (infrastructure could not
  // produce an authoritative result from the supplied values).
  assert.equal(result.outcome, 'failed');
  assert.equal(result.refusal.reason, 'MISSING_LINEAGE');
  assert.match(result.refusal.detail, /missing typed required value\(s\): scenario-bindings/);
});

test('RED SEED (empty binding array): an AC-complete handoff with an empty scenario-realization array is refused', async () => {
  const frozen = await freezeAccepted();
  const emptied = { ...lawfulHandoffOf(), 'scenario-realization-bindings': [] };
  const result = await settleFrozen(frozen, { handoff: emptied });
  assert.equal(result.refusal.reason, 'MISSING_LINEAGE');
  assert.match(result.refusal.detail, /scenario-realization-bindings/);
});

test('the settler fence (A2): settlement never emits a contract it could not validate', async () => {
  const frozen = await freezeAccepted();
  const green = greenBaselineFixture();
  // A handoff valid at emission time but referencing a repository policy
  // ref the post-freeze authority does not carry.
  const handoff = { ...lawfulHandoffOf(green), 'repository-and-policy-bindings': ['repo:FOREIGN'] };
  const result = await settleFrozen(frozen, { handoff });
  assert.equal(result.outcome, 'inconsistent');
  assert.equal(result.refusal.reason, 'FOREIGN_LINEAGE');
  assert.equal(result.contract, null);
});

test('a forged or partially-substituted baseline at settlement is DRIFT (authority pins refuse it)', async () => {
  const frozen = await freezeAccepted();
  const forgedBaseline = clone(frozen.baseline);
  forgedBaseline.caseIdentity.formalizationCaseRef = 'case:FORGERY';
  const result = await settleFrozen(frozen, {});
  // (control: the lawful path still formalizes)
  assert.equal(result.outcome, 'formalized');
  const settlement = await cellModule('settlement');
  const refused = settlement.settleSolutionContract({
    frozenBaseline: forgedBaseline,
    baselineArtifact: frozen.artifact,
    srs: srsAuthorityOf(),
    repositoryPolicyRefs: repositoryPolicyRefsOf(),
    handoff: lawfulHandoffOf(greenBaselineFixture()),
  });
  assert.equal(refused.outcome, 'inconsistent');
  assert.equal(refused.refusal.reason, 'DRIFT_DETECTED');
  assert.match(refused.refusal.detail, /does not verify against its pinned artifact digest/);
});

test('a stale SRS revision pin is refused STALE_LINEAGE at settlement', async () => {
  const frozen = await freezeAccepted();
  const staleSrs = { ...srsAuthorityOf(), revisionDigest: '9'.repeat(64) };
  const handoff = { ...lawfulHandoffOf(greenBaselineFixture(), staleSrs), 'srs-reference-and-hash': ['1'.repeat(64)] };
  const result = await settleFrozen(frozen, { srs: staleSrs, handoff });
  assert.equal(result.outcome, 'inconsistent');
  assert.equal(result.refusal.reason, 'FOREIGN_LINEAGE');
  assert.match(result.refusal.detail, /srs-reference-and-hash/);
});

test('settlement resolves every kind against the FROZEN baseline\'s own resolvesAgainst declaration', async () => {
  const frozen = await freezeAccepted();
  const settled = await settleFrozen(frozen);
  const surface = frozen.baseline.developmentSurface.handoffBindingKinds;
  for (const [kind, record] of Object.entries(settled.contract.developmentHandoff)) {
    assert.deepEqual(record.resolvedAgainst, [...surface[kind].resolvesAgainst], kind);
  }
  // The self-seal kind carries sha256:<sealBase> (deterministic, never circular).
  assert.match(settled.contract.developmentHandoff['solution-contract'].values[0], /^sha256:[0-9a-f]{64}$/);
});

test('a tampered contract digest does not re-validate (the seal is binding)', async () => {
  const settlement = await cellModule('settlement');
  const frozen = await freezeAccepted();
  const settled = await settleFrozen(frozen);
  const tampered = clone(settled.contract);
  tampered.developmentHandoff['scenario-bindings'].values.push('uc:batch-1');
  const validation = settlement.validateSolutionContract(tampered, frozen.baseline, frozen.artifact, srsAuthorityOf(), repositoryPolicyRefsOf());
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'DRIFT_DETECTED');
  assert.match(validation.detail, /canonical solution-contract digest does not verify/);
});

test('settlement is deterministic: same authorities and handoff, same canonical digest', async () => {
  const frozen = await freezeAccepted();
  const first = await settleFrozen(frozen);
  const second = await settleFrozen(frozen);
  assert.equal(first.contract.canonicalDigest, second.contract.canonicalDigest);
});

test('the settle desk routes refusals through the declared table (formalized / inconsistent / failed)', async () => {
  const protocol = await cellModule('protocol');
  assert.equal(protocol.routeRefusal(protocol.SETTLE_OUTCOME_OF_REASON, 'FOREIGN_LINEAGE').outcome, 'inconsistent');
  assert.equal(protocol.routeRefusal(protocol.SETTLE_OUTCOME_OF_REASON, 'DRIFT_DETECTED').outcome, 'inconsistent');
  assert.equal(protocol.routeRefusal(protocol.SETTLE_OUTCOME_OF_REASON, 'MALFORMED_PRODUCT').outcome, 'failed');
  assert.equal(protocol.settleTransitionOf('formalized').on, 'domain.formalized');
  assert.equal(protocol.settleTransitionOf('inconsistent').on, 'domain.inconsistent');
  assert.equal(protocol.settleTransitionOf('failed').on, 'domain.failed');
});
