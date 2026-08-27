/**
 * gate.test.mjs - FRF-WP05 CheckPlan and gate: the declared deterministic
 * provider (digest-verified against the installed manifest row), the
 * content-addressed CheckPlan rows, the GREEN gate path, the D5 human
 * wait on an INDETERMINATE wp03 validation (unbound or tampered seam),
 * and the KILLED MUTATIONS:
 *   m1 validator bypass   - a result set omitting the wp03-validation row
 *                           is refused (GATE_CHECK_MISSING), never accepted;
 *   m2 impostor provider  - a tampered provider declaration never gates;
 *   m3 impostor validator - a module that always returns ok fails the
 *                           seam self-test and human-waits (never accepts);
 *   m4 unknown check      - an undeclared check id is refused typed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { WP03_VALIDATOR_PATH, cell, dist, boundSeam, greenBundle, greenUniverse } from './support.mjs';

async function greenGateContext() {
  const c = await cell();
  const declared = c.declaredSystemRequirementsProvider();
  assert.equal(declared.ok, true);
  const seam = await boundSeam();
  const sealed = await greenBundle();
  const universe = await greenUniverse();
  return { c, provider: declared.provider, seam, sealed, universe };
}

test('the declared provider derives from the INSTALLED manifest row and recomputes its digest', async () => {
  const c = await cell();
  const declared = c.declaredSystemRequirementsProvider();
  assert.equal(declared.ok, true);
  assert.equal(declared.provider.providerId, 'formalization.requirements-structure.v1');
  assert.equal(declared.provider.nodeId, 'derive-system-requirements');
  assert.equal(declared.provider.productKind, 'formalization.system-requirements.v1');
  assert.equal(declared.provider.validator, 'wp03:validateRequirementsBundle');
  assert.equal(declared.provider.wp03ContractKind, c.REQUIREMENTS_BUNDLE_CONTRACT_KIND);
  const manifest = await dist('workflow-kernel/workshops/formalization/manifest.js');
  const installed = manifest.checkProviderOfDesk('derive-system-requirements');
  assert.equal(installed.ok, true);
  assert.equal(installed.provider.providerId, declared.provider.providerId, 'the cell provider IS the installed desk provider, extended not substituted');
});

test('MUTATION m2 (killed): a tampered provider declaration never gates', async () => {
  const { c, seam, sealed, universe } = await greenGateContext();
  const declared = c.declaredSystemRequirementsProvider();
  assert.equal(declared.ok, true);
  const tampered = { ...declared.provider, productKind: 'formalization.uc-scenarios.v1' };
  const outcome = c.gateSystemRequirementsCandidate(tampered, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  assert.equal('refused' in outcome, true, 'the impostor provider is refused before any check runs');
  assert.match(outcome.detail, /does not verify against the cell's declared provider/);
  const tamperedDigest = { ...declared.provider, providerDigest: 'f'.repeat(64) };
  const digestOutcome = c.gateSystemRequirementsCandidate(tamperedDigest, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  assert.equal('refused' in digestOutcome, true);
});

test('the CheckPlan rows are content-addressed and closed over the six declared checks', async () => {
  const c = await cell();
  const rows = c.systemRequirementsCheckPlanRows();
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((row) => row.checkId),
    [...c.SYSTEM_REQUIREMENTS_CHECK_IDS],
  );
  for (const row of rows) {
    assert.equal(row.gate, c.SYSTEM_REQUIREMENTS_FINAL_GATE_ID);
    assert.equal(row.evaluator, 'machine');
    assert.match(row.contentRef, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.contentRef, `sha256:${row.digest}`);
  }
  const evidence = c.systemRequirementsCheckPlanEvidence();
  assert.equal(evidence.length, 6);
  for (const fact of evidence) {
    assert.equal(fact.kind, 'CheckPlan');
    assert.equal(fact.producer, 'external-input');
    assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
  }
});

test('GREEN PATH: the gate accepts the green bundle through the bound seam', async () => {
  const { c, provider, seam, sealed, universe } = await greenGateContext();
  const run = c.runSystemRequirementsChecks({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  assert.equal(run.ok, true);
  assert.deepEqual(run.issues, []);
  for (const result of run.results) {
    assert.equal(result.outcome, 'pass', `${result.checkId}: ${result.detail}`);
  }
  const gate = c.systemRequirementsGateDeclaration();
  const evaluation = c.evaluateSystemRequirementsGate(gate, run.results);
  assert.equal(evaluation.refused, undefined);
  assert.equal(evaluation.verdict, 'accepted');
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  assert.equal(outcome.verdict, 'accepted');
});

test('D5 HUMAN WAIT: an unbound seam makes the wp03 validation INDETERMINATE and the gate human-waits', async () => {
  const { c, provider, sealed, universe } = await greenGateContext();
  const run = c.runSystemRequirementsChecks({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, undefined);
  const wp03 = run.results.find((result) => result.checkId === 'system-requirements.check.wp03-validation');
  assert.equal(wp03.outcome, 'indeterminate');
  assert.match(wp03.detail, /not bound at this composition root/);
  const gate = c.systemRequirementsGateDeclaration();
  const evaluation = c.evaluateSystemRequirementsGate(gate, run.results);
  assert.equal(evaluation.verdict, 'human-wait', 'the indeterminate validation routes to the D5 human wait, never to accepted');
  assert.equal(gate.waitOn.waitKind, 'TypedWait:human-input');
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, undefined);
  assert.equal(outcome.verdict, 'human-wait');
  // The reviewer NEVER accepts on an indeterminate validation either.
  const review = c.reviewRequirementsBundle({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, undefined);
  assert.equal(review.disposition, 'human-wait');
  assert.deepEqual(review.wait.wakeCommands, ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
});

test('the D5 wait kind is the frozen TypedWait:human-input of the kernel registry', async () => {
  const universe = await dist('workflow-kernel/domain/universe.js');
  assert.ok(universe.WAIT_KINDS.includes('TypedWait:human-input'));
  const waits = universe.WAITS.filter((entry) => entry.kind === 'TypedWait:human-input');
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0].wakeCommands, ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
});

test('MUTATION m3 (killed): an imposter validator module fails the seam self-test and human-waits', async () => {
  const { c, provider, sealed, universe } = await greenGateContext();
  // The imposter: right CONTRACT_KIND, but it seals everything - including
  // garbage - and never refuses.
  const imposter = {
    CONTRACT_KIND: c.REQUIREMENTS_BUNDLE_CONTRACT_KIND,
    validateRequirementsBundle: () => ({ ok: true, digest: '0'.repeat(64), kind: c.REQUIREMENTS_BUNDLE_CONTRACT_KIND, ref: `sha256:${'0'.repeat(64)}` }),
  };
  const binding = c.bindWp03RequirementsValidator(imposter);
  assert.equal(binding.bound, false);
  assert.equal(binding.reason, 'SEAM_SELF_TEST_FAILED');
  // The null-refusal half of the self-test is the killer: the imposter
  // returns ok for null.
  const alwaysOk = {
    CONTRACT_KIND: c.REQUIREMENTS_BUNDLE_CONTRACT_KIND,
    validateRequirementsBundle: () => ({ ok: true, digest: '0'.repeat(64), kind: c.REQUIREMENTS_BUNDLE_CONTRACT_KIND, ref: `sha256:${'0'.repeat(64)}` }),
  };
  assert.equal(c.bindWp03RequirementsValidator(alwaysOk).bound, false);
  // A wrong contract kind is never bound (the REAL docs validator with a
  // forged contract identity).
  const realModule = await import(`file:///${WP03_VALIDATOR_PATH.replace(/\\/g, '/')}`);
  const wrongKindBinding = c.bindWp03RequirementsValidator({ ...realModule, CONTRACT_KIND: 'frf-contracts.something-else.v1' });
  assert.equal(wrongKindBinding.bound, false);
  assert.equal(wrongKindBinding.reason, 'SEAM_CONTRACT_KIND_MISMATCH');
  // And the refused binding still human-waits through the gate (never accepts).
  const outcome = c.gateSystemRequirementsCandidate(provider, { kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, binding);
  assert.equal(outcome.verdict, 'human-wait');
});

test('MUTATION m1 (killed): the validator bypass - a result set omitting the wp03-validation row is refused', async () => {
  const { c, seam, sealed, universe } = await greenGateContext();
  const gate = c.systemRequirementsGateDeclaration();
  const run = c.runSystemRequirementsChecks({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  // The bypass attempt: present every OTHER check as passing and silently
  // drop the wp03-validation row (the host "forgot" to run the validator).
  const bypassed = run.results.filter((result) => result.checkId !== 'system-requirements.check.wp03-validation');
  assert.equal(bypassed.length, 5);
  const evaluation = c.evaluateSystemRequirementsGate(gate, bypassed);
  assert.equal(evaluation.refused, true, 'the bypass is refused, never accepted');
  assert.equal(evaluation.code, 'GATE_CHECK_MISSING');
  assert.match(evaluation.detail, /validator-bypass fence/);
  // Dropping a DIFFERENT check is refused just the same.
  const droppedLaw = run.results.filter((result) => result.checkId !== 'system-requirements.check.derivation-lineage');
  const evaluation2 = c.evaluateSystemRequirementsGate(gate, droppedLaw);
  assert.equal(evaluation2.code, 'GATE_CHECK_MISSING');

  // The forged-pass variant: an injected row claiming wp03 pass is not
  // reachable without the seam actually sealing (the runner recomputes
  // results deterministically); the evaluator's rule table only accepts
  // the runner's rows, and an all-pass hand-forged set still has to name
  // the same declared checks - a forged indeterminate-free set over a
  // REFUSING bundle cannot be produced by the runner.
  const refusingBundle = { ...sealed.bundle, prdRevisionRef: `sha256:${'f'.repeat(64)}` };
  const refusingRun = c.runSystemRequirementsChecks({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: refusingBundle }, universe, seam);
  const wp03Row = refusingRun.results.find((result) => result.checkId === 'system-requirements.check.wp03-validation');
  assert.equal(wp03Row.outcome, 'fail');
  assert.equal(wp03Row.reason, 'STALE_LINEAGE');
  const refusingEvaluation = c.evaluateSystemRequirementsGate(gate, refusingRun.results);
  assert.equal(refusingEvaluation.verdict, 'repair');
});

test('MUTATION m4 (killed): an undeclared check id fed to the gate is refused typed', async () => {
  const { c, seam, sealed, universe } = await greenGateContext();
  const gate = c.systemRequirementsGateDeclaration();
  const run = c.runSystemRequirementsChecks({ kind: c.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: sealed.bundle }, universe, seam);
  const forged = [...run.results, { checkId: 'system-requirements.check.trust-me', outcome: 'pass', detail: 'forged' }];
  const evaluation = c.evaluateSystemRequirementsGate(gate, forged);
  assert.equal(evaluation.refused, true);
  assert.equal(evaluation.code, 'GATE_UNKNOWN_CHECK');
});

test('the gate verdict vocabulary is the kernel frozen five', async () => {
  const c = await cell();
  const gate = c.systemRequirementsGateDeclaration();
  assert.deepEqual([...gate.verdictVocabulary].sort(), ['accepted', 'human-wait', 'repair', 'terminal-reject', 'upstream-repair']);
  assert.equal(gate.command, 'workplace.runFinalGate');
  assert.deepEqual(gate.requiredEvidenceKinds, ['CheckPlan']);
});
