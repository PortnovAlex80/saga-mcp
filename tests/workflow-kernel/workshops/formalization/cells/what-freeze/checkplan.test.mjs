/**
 * checkplan.test.mjs - the FRF-WP07 CheckPlan and semantic gates: the
 * deterministic routing (drift => human-wait via DRIFT_DETECTED outcome;
 * indeterminate => D5), the first-match evaluator, and the content-
 * addressed CheckPlan rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedSurfacesOf,
  cellModule,
  freezeAccepted,
} from './support.mjs';

test('the CheckPlan rows are content-addressed and stable', async () => {
  const checkplan = await cellModule('checkplan');
  const rows = checkplan.whatFreezeCheckPlanRows();
  assert.ok(rows.length >= 8);
  for (const row of rows) {
    assert.match(row.contentRef, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.contentRef, `sha256:${row.digest}`);
    assert.ok(['machine', 'operator'].includes(row.evaluator));
  }
  const again = checkplan.whatFreezeCheckPlanRows();
  assert.deepEqual(again, rows, 'the CheckPlan is deterministic data');
  const evidence = checkplan.whatFreezeCheckPlanEvidence();
  assert.equal(evidence.length, rows.length);
  for (const fact of evidence) {
    assert.equal(fact.kind, 'CheckPlan');
    assert.equal(fact.producer, 'external-input');
  }
});

test('exactly one operator-only check exists: the freeze-drift disposition (the machine cannot observe the human decision)', async () => {
  const checkplan = await cellModule('checkplan');
  const operatorRows = checkplan.whatFreezeCheckPlanRows().filter((row) => row.evaluator === 'operator');
  assert.deepEqual(operatorRows.map((row) => row.checkId), ['what-freeze.check.drift-disposition']);
  const driftGate = checkplan.whatFreezeGateDeclarations().find((gate) => gate.gateId === checkplan.FREEZE_DRIFT_GATE_ID);
  assert.equal(driftGate.waitOn.waitKind, 'TypedWait:effect-uncertainty');
  const evaluation = checkplan.evaluateWhatFreezeGate(driftGate, [{ checkId: 'what-freeze.check.drift-disposition', outcome: 'operator-only' }]);
  assert.equal(evaluation.decided, true);
  assert.equal(evaluation.verdict, 'human-wait');
});

test('the evaluator is first-match and fail-closed: unknown checks and undecided sets are typed refusals', async () => {
  const checkplan = await cellModule('checkplan');
  const gate = checkplan.whatFreezeGateDeclarations().find((entry) => entry.gateId === checkplan.FREEZE_FINAL_GATE_ID);
  const unknown = checkplan.evaluateWhatFreezeGate(gate, [{ checkId: 'what-freeze.check.not-declared', outcome: 'pass' }]);
  assert.equal(unknown.refused, true);
  assert.equal(unknown.code, 'GATE_UNKNOWN_CHECK');
  const pass = checkplan.evaluateWhatFreezeGate(gate, [{ checkId: 'what-freeze.check.wp03-validator', outcome: 'pass' }]);
  assert.equal(pass.verdict, 'accepted');
  const fail = checkplan.evaluateWhatFreezeGate(gate, [{ checkId: 'what-freeze.check.wp03-validator', outcome: 'fail' }]);
  assert.equal(fail.verdict, 'repair');
});

test('deterministic routing: drift => human-wait (D12); indeterminate => human-wait (D5)', async () => {
  const checkplan = await cellModule('checkplan');
  const gates = new Map(checkplan.whatFreezeGateDeclarations().map((gate) => [gate.gateId, gate]));
  // Drift: the duplicate-digest seed routes to the exact-authority check failing.
  const surfaces = acceptedSurfacesOf();
  surfaces.containers.fr.members[1].digest = surfaces.containers.fr.members[0].digest;
  const driftResult = await freezeAccepted(surfaces);
  const driftChecks = checkplan.machineChecksOfFreezeResult(driftResult);
  const driftEvaluation = checkplan.evaluateWhatFreezeGate(gates.get(checkplan.FREEZE_AUTHOR_GATE_ID), driftChecks);
  assert.equal(driftEvaluation.verdict, 'human-wait');
  // Indeterminate: the missing-surface seed routes to the carry check failing.
  const indeterminateSurfaces = acceptedSurfacesOf();
  delete indeterminateSurfaces.dispositions;
  const indeterminateResult = await freezeAccepted(indeterminateSurfaces);
  const indeterminateChecks = checkplan.machineChecksOfFreezeResult(indeterminateResult);
  assert.deepEqual(indeterminateChecks, [{ checkId: 'what-freeze.check.surfaces-carried', outcome: 'fail' }]);
  const indeterminateEvaluation = checkplan.evaluateWhatFreezeGate(gates.get(checkplan.FREEZE_AUTHOR_GATE_ID), indeterminateChecks);
  assert.equal(indeterminateEvaluation.verdict, 'human-wait');
  // Green: all machine checks pass.
  const frozen = await freezeAccepted();
  const greenChecks = checkplan.machineChecksOfFreezeResult(frozen);
  assert.deepEqual(greenChecks.map((row) => row.outcome), ['pass', 'pass', 'pass', 'pass', 'pass']);
  const finalGate = gates.get(checkplan.FREEZE_FINAL_GATE_ID);
  assert.equal(checkplan.evaluateWhatFreezeGate(finalGate, [{ checkId: 'what-freeze.check.wp03-validator', outcome: 'pass' }]).verdict, 'accepted');
});

test('the no-folding drift routes to its own check row (F-8 has a first detector, not a generic fail)', async () => {
  const checkplan = await cellModule('checkplan');
  const gates = new Map(checkplan.whatFreezeGateDeclarations().map((gate) => [gate.gateId, gate]));
  const foldedLikeResult = {
    ok: true,
    outcome: 'drift-detected',
    refusal: { reason: 'DRIFT_DETECTED', detail: "accepted constraint disposition(s) [x] did not survive into the baseline's own constraint section (folding that loses the plan's distinct disposition sections is refused; F-8)" },
  };
  const checks = checkplan.machineChecksOfFreezeResult(foldedLikeResult);
  assert.deepEqual(checks, [{ checkId: 'what-freeze.check.no-folding', outcome: 'fail' }]);
  const evaluation = checkplan.evaluateWhatFreezeGate(gates.get(checkplan.FREEZE_AUTHOR_GATE_ID), checks);
  assert.equal(evaluation.verdict, 'human-wait');
});

test('the settlement gate routes the UC-FOREIGN kill to upstream-repair, authority forgery to terminal-reject', async () => {
  const checkplan = await cellModule('checkplan');
  const gates = new Map(checkplan.whatFreezeGateDeclarations().map((gate) => [gate.gateId, gate]));
  const settleGate = gates.get(checkplan.SETTLE_FINAL_GATE_ID);
  const foreign = checkplan.evaluateWhatFreezeGate(settleGate, [{ checkId: 'what-freeze.check.settlement-binding-resolution', outcome: 'fail' }]);
  assert.equal(foreign.verdict, 'upstream-repair');
  const forged = checkplan.evaluateWhatFreezeGate(settleGate, [{ checkId: 'what-freeze.check.settlement-authority-pins', outcome: 'fail' }]);
  assert.equal(forged.verdict, 'terminal-reject');
  const lawful = checkplan.evaluateWhatFreezeGate(settleGate, [{ checkId: 'what-freeze.check.settlement-binding-resolution', outcome: 'pass' }]);
  assert.equal(lawful.verdict, 'accepted');
});

test('the verdict vocabulary is the kernel frozen five', async () => {
  const checkplan = await cellModule('checkplan');
  assert.deepEqual([...checkplan.WHAT_FREEZE_VERDICTS], ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']);
  for (const gate of checkplan.whatFreezeGateDeclarations()) {
    assert.deepEqual([...gate.verdictVocabulary], [...checkplan.WHAT_FREEZE_VERDICTS]);
  }
});
