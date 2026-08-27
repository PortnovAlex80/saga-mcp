/**
 * persistence.test.mjs - the FRF-WP07 immutable kernel-evidence ledger
 * and the typed waits (D5/D12 vocabulary ONLY, asserted against the
 * frozen kernel registry in dist).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedSurfacesOf,
  cellModule,
  clone,
  distModule,
  freezeAccepted,
  greenBaselineFixture,
  settleFrozen,
} from './support.mjs';

test('the frozen baseline is an immutable kernel evidence product: submit once, replay already-applied', async () => {
  const persistence = await cellModule('persistence');
  const frozen = await freezeAccepted();
  const ledger = new persistence.KernelEvidenceLedger();
  const caseRef = frozen.baseline.caseIdentity.formalizationCaseRef;
  const first = ledger.submit('KernelEvidence:what-baseline', caseRef, frozen.artifact);
  assert.equal(first.outcome, 'success');
  const replay = ledger.submit('KernelEvidence:what-baseline', caseRef, frozen.artifact);
  assert.equal(replay.outcome, 'already-applied');
  assert.equal(replay.receiptDigest, first.receiptDigest);
});

test('a SECOND, different baseline under the same case identity is refused DRIFT_DETECTED (no update path exists)', async () => {
  const persistence = await cellModule('persistence');
  const frozen = await freezeAccepted();
  const ledger = new persistence.KernelEvidenceLedger();
  const caseRef = frozen.baseline.caseIdentity.formalizationCaseRef;
  assert.equal(ledger.submit('KernelEvidence:what-baseline', caseRef, frozen.artifact).outcome, 'success');
  const other = clone(frozen.artifact);
  other.content = clone(frozen.baseline);
  other.content.caseIdentity.formalizationCaseRef = 'case:OTHER';
  const shared = await cellModule('shared');
  other.digest = shared.sha256OfCanonical(other.content);
  other.ref = `sha256:${other.digest}`;
  const refusal = ledger.submit('KernelEvidence:what-baseline', caseRef, other);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
  assert.match(refusal.detail, /already sealed|immutable/);
});

test('the settled solution contract submits as immutable evidence too (different kind, same case)', async () => {
  const persistence = await cellModule('persistence');
  const frozen = await freezeAccepted();
  const settled = await settleFrozen(frozen);
  const ledger = new persistence.KernelEvidenceLedger();
  const caseRef = frozen.baseline.caseIdentity.formalizationCaseRef;
  assert.equal(ledger.submit('KernelEvidence:solution-contract', caseRef, settled.artifact).outcome, 'success');
  assert.equal(ledger.submit('KernelEvidence:solution-contract', caseRef, settled.artifact).outcome, 'already-applied');
});

test('an evidence kind outside the desk vocabulary is refused (closed set)', async () => {
  const persistence = await cellModule('persistence');
  const frozen = await freezeAccepted();
  const ledger = new persistence.KernelEvidenceLedger();
  const refusal = ledger.submit('KernelEvidence:acceptance-only-baseline', 'case:x', frozen.artifact);
  assert.equal(refusal.reason, 'SCOPE_VIOLATION');
});

test('a non-content-addressed artifact is refused (the digest must verify)', async () => {
  const persistence = await cellModule('persistence');
  const ledger = new persistence.KernelEvidenceLedger();
  const refusal = ledger.submit('KernelEvidence:what-baseline', 'case:x', { ref: 'sha256:' + '0'.repeat(64), digest: 'f'.repeat(64), content: { a: 1 } });
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
});

test('the freeze-drift wait uses D12 vocabulary ONLY and matches the frozen kernel registry', async () => {
  const persistence = await cellModule('persistence');
  const universe = await distModule('workflow-kernel/domain/universe');
  const registryWait = universe.WAITS.find((wait) => wait.kind === 'TypedWait:effect-uncertainty');
  const driftWait = persistence.freezeDriftWaitOf('ab'.repeat(32));
  assert.equal(driftWait.kind, 'TypedWait:effect-uncertainty');
  assert.equal(driftWait.disposition, 'operator-disposition-command-required');
  assert.deepEqual(driftWait.wakeCommands, [...registryWait.wakeCommands]);
  assert.deepEqual(driftWait.wakeCommands, [...persistence.TYPED_WAIT_REGISTRY['TypedWait:effect-uncertainty'].wakeCommands]);
});

test('D12: the drift decision wakes ONLY on the operator disposition receipt; an automatic redrive is refused', async () => {
  const persistence = await cellModule('persistence');
  const driftWait = persistence.freezeDriftWaitOf('cd'.repeat(32));
  // No receipt at all (the automatic redrive attempt).
  const autoRedrive = persistence.resolveFreezeDriftDecision(driftWait);
  assert.equal(autoRedrive.reason, 'MISSING_LINEAGE');
  assert.match(autoRedrive.detail, /operator disposition receipt/);
  // A receipt from a command outside the frozen wake vocabulary.
  const wrongCommand = persistence.resolveFreezeDriftDecision(driftWait, { command: 'workplace.settleEffect', decision: 'confirm-inconsistent', driftEvidenceDigest: driftWait.driftEvidenceDigest });
  assert.equal(wrongCommand.reason, 'MALFORMED_PRODUCT');
  // A receipt naming a DIFFERENT drift (a recycled disposition).
  const recycled = persistence.resolveFreezeDriftDecision(driftWait, { command: 'workplace.resolveHumanResponse', decision: 'confirm-inconsistent', driftEvidenceDigest: 'ef'.repeat(32) });
  assert.equal(recycled.reason, 'DRIFT_DETECTED');
});

test('D12: the lawful dispositions are exactly resume-upstream-repair and confirm-inconsistent', async () => {
  const persistence = await cellModule('persistence');
  const driftWait = persistence.freezeDriftWaitOf('cd'.repeat(32));
  const resume = persistence.resolveFreezeDriftDecision(driftWait, { command: 'workplace.resolveHumanResponse', decision: 'resume-upstream-repair', driftEvidenceDigest: driftWait.driftEvidenceDigest });
  assert.equal(resume.decision, 'resume-upstream-repair');
  assert.equal(resume.transition, null);
  assert.match(resume.note, /new immutable upstream revision/);
  const confirm = persistence.resolveFreezeDriftDecision(driftWait, { command: 'workplace.resolveHumanResponse', decision: 'confirm-inconsistent', driftEvidenceDigest: driftWait.driftEvidenceDigest });
  assert.equal(confirm.decision, 'confirm-inconsistent');
  assert.equal(confirm.transition, 'domain.drift-detected');
  const invented = persistence.resolveFreezeDriftDecision(driftWait, { command: 'workplace.resolveHumanResponse', decision: 'force-freeze-anyway', driftEvidenceDigest: driftWait.driftEvidenceDigest });
  assert.equal(invented.reason, 'MALFORMED_PRODUCT');
});

test('the indeterminate wait uses D5 vocabulary ONLY and matches the frozen kernel registry', async () => {
  const persistence = await cellModule('persistence');
  const universe = await distModule('workflow-kernel/domain/universe');
  const registryWait = universe.WAITS.find((wait) => wait.kind === 'TypedWait:human-input');
  const wait = persistence.indeterminateWaitOf('no accepted evidenceBindings surface was carried');
  assert.equal(wait.kind, 'TypedWait:human-input');
  assert.equal(wait.disposition, 'wake-source-completion');
  assert.deepEqual(wait.wakeCommands, [...registryWait.wakeCommands]);
  const wake = persistence.dischargeIndeterminateWait(wait, { command: 'nodeRun.recordHumanDecision', evidenceRef: 'evidence:accepted-surface#1' });
  assert.equal(wake.ok, true);
  assert.match(wake.dischargeEvidence, /^WakeDischarge:human-response-command#/);
  const wrongWake = persistence.dischargeIndeterminateWait(wait, { command: 'workplace.runFinalGate' });
  assert.equal(wrongWake.reason, 'MALFORMED_PRODUCT');
  const evidenceless = persistence.dischargeIndeterminateWait(wait, { command: 'workplace.resolveHumanResponse' });
  assert.equal(evidenceless.reason, 'MISSING_LINEAGE');
});

test('the drift wait carries the exact drift evidence digest of the desk refusal (binding, not opinion)', async () => {
  const surfaces = acceptedSurfacesOf();
  surfaces.containers.fr.members[1].digest = surfaces.containers.fr.members[0].digest;
  const frozen = await freezeAccepted(surfaces);
  assert.equal(frozen.outcome, 'drift-detected');
  const persistence = await cellModule('persistence');
  const wait = persistence.freezeDriftWaitOf(frozen.wait.driftEvidenceDigest);
  const receipt = persistence.resolveFreezeDriftDecision(wait, { command: 'workplace.resolveHumanResponse', decision: 'confirm-inconsistent', driftEvidenceDigest: wait.driftEvidenceDigest });
  assert.equal(receipt.ok, true);
});

test('the green fixture baseline still freezes under this ledger identity (regression oracle)', async () => {
  const persistence = await cellModule('persistence');
  const frozen = await freezeAccepted();
  const ledger = new persistence.KernelEvidenceLedger();
  const receipt = ledger.submit('KernelEvidence:what-baseline', greenBaselineFixture().caseIdentity.formalizationCaseRef, frozen.artifact);
  assert.equal(receipt.outcome, 'success');
  assert.match(receipt.receiptDigest, /^receipt:KernelEvidence:what-baseline:[0-9a-f]{64}$/);
});
