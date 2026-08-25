/**
 * approval.test.mjs - WP-11L: the release-approval bridge - the legacy
 * inbox semantics (immutable, candidate/preflight/policy-bound decisions)
 * on the typed D5/D12 vocabulary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVerifiedBundle, operatorStores } from './support.mjs';

const approval = await import('../../../../dist/workflow-kernel/workshops/delivery/approval.js');
const preflight = await import('../../../../dist/workflow-kernel/workshops/delivery/preflight.js');
const manifest = await import('../../../../dist/workflow-kernel/workshops/delivery/manifest.js');

const TRIPLE = () => ({
  candidateDigest: 'a'.repeat(64),
  preflightDigest: 'b'.repeat(64),
  policyDigest: 'c'.repeat(64),
});

test('the approval request is candidate/preflight/policy-bound and idempotent', () => {
  const stores = operatorStores();
  const first = approval.ensureApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x1', TRIPLE(), 'release-conveyor');
  assert.equal(first.ensured, true);
  assert.equal(first.created, true);
  const replay = approval.ensureApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x1', TRIPLE(), 'release-conveyor');
  assert.equal(replay.ensured, true);
  assert.equal(replay.created, false);
  assert.equal(approval.readApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x1')?.state, 'open');
});

test('refusal: APPROVAL_REQUEST_REPLAY_MISMATCH - a different triple never re-binds a request', () => {
  const stores = operatorStores();
  approval.ensureApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x2', TRIPLE(), 'release-conveyor');
  const drifted = approval.ensureApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x2', {
    candidateDigest: 'f'.repeat(64),
    preflightDigest: 'b'.repeat(64),
    policyDigest: 'c'.repeat(64),
  }, 'release-conveyor');
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'APPROVAL_REQUEST_REPLAY_MISMATCH');
});

test('the decision records immutably and binds the exact triple', () => {
  const stores = operatorStores();
  const request = 'delivery-release-approval:x3';
  approval.ensureApprovalRequest(stores.inboxRoot, request, TRIPLE(), 'release-conveyor');
  const recorded = approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request,
    status: 'approved',
    decidedBy: 'release-operator-one',
    rationale: 'preflight green',
    providerId: 'operator-release-1',
  });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.decision.binding.candidateDigest, 'a'.repeat(64));
  assert.match(recorded.decision.decisionRef, /^delivery-approval:delivery-release-approval:x3:[0-9a-f]{64}$/);
  // The request row flipped to decided exactly once.
  assert.equal(approval.readApprovalRequest(stores.inboxRoot, request)?.state, 'decided');
  // The identical decision replays (never a second record).
  const replay = approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request,
    status: 'approved',
    decidedBy: 'release-operator-one',
    rationale: 'preflight green',
    providerId: 'operator-release-1',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.decisionDigest, recorded.decision.decisionDigest);
});

test('refusal: APPROVAL_DECISION_IMMUTABLE - a different decision for one request never re-writes', () => {
  const stores = operatorStores();
  const request = 'delivery-release-approval:x4';
  approval.ensureApprovalRequest(stores.inboxRoot, request, TRIPLE(), 'release-conveyor');
  approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request, status: 'approved', decidedBy: 'op', rationale: 'first', providerId: 'operator-release-1',
  });
  const mutated = approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request, status: 'denied', decidedBy: 'op', rationale: 'first', providerId: 'operator-release-1',
  });
  assert.equal(mutated.refused, true);
  assert.equal(mutated.reason, 'APPROVAL_DECISION_IMMUTABLE');
  // The recorded decision is unchanged.
  assert.equal(approval.readApprovalDecision(stores.inboxRoot, request)?.status, 'approved');
});

test('refusal: APPROVAL_PROVIDER_NOT_DECLARED - an anonymous/foreign identity never decides', () => {
  const stores = operatorStores();
  const request = 'delivery-release-approval:x5';
  approval.ensureApprovalRequest(stores.inboxRoot, request, TRIPLE(), 'release-conveyor');
  const foreign = approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request, status: 'approved', decidedBy: 'someone', rationale: 'r', providerId: 'registry-bot',
  });
  assert.equal(foreign.refused, true);
  assert.equal(foreign.reason, 'APPROVAL_PROVIDER_NOT_DECLARED');
  assert.match(foreign.detail, /authorized-decision/);
});

test('refusal: required-field refusals are typed (id, decidedBy, rationale, request)', () => {
  const stores = operatorStores();
  assert.equal(approval.recordApprovalDecision(stores.inboxRoot, { requestId: ' ', status: 'approved', decidedBy: 'x', rationale: 'y', providerId: 'operator-release-1' }).reason, 'APPROVAL_REQUEST_ID_REQUIRED');
  approval.ensureApprovalRequest(stores.inboxRoot, 'delivery-release-approval:x6', TRIPLE(), 'rc');
  assert.equal(approval.recordApprovalDecision(stores.inboxRoot, { requestId: 'delivery-release-approval:x6', status: 'approved', decidedBy: '', rationale: 'y', providerId: 'operator-release-1' }).reason, 'APPROVAL_DECIDED_BY_REQUIRED');
  assert.equal(approval.recordApprovalDecision(stores.inboxRoot, { requestId: 'delivery-release-approval:x6', status: 'approved', decidedBy: 'x', rationale: ' ', providerId: 'operator-release-1' }).reason, 'APPROVAL_RATIONALE_REQUIRED');
  assert.equal(approval.recordApprovalDecision(stores.inboxRoot, { requestId: 'delivery-release-approval:missing', status: 'approved', decidedBy: 'x', rationale: 'y', providerId: 'operator-release-1' }).reason, 'APPROVAL_REQUEST_NOT_FOUND');
});

test('the pause vocabulary is EXACTLY the frozen D5/D12 wait kinds and wake sources', () => {
  assert.equal(approval.RELEASE_APPROVAL_WAIT_KIND, 'TypedWait:human-input');
  assert.deepEqual([...approval.RELEASE_APPROVAL_WAKE_COMMANDS], ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
  assert.equal(approval.RELEASE_APPROVAL_DISCHARGE_EVIDENCE, 'WakeDischarge:human-response-command');
});

test('the operator disposition command carries the immutable decision evidence', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const run = preflight.runPreflight(bundle);
  const request = 'delivery-release-approval:x7';
  approval.ensureApprovalRequest(stores.inboxRoot, request, {
    candidateDigest: run.candidateDigest,
    preflightDigest: run.preflightDigest,
    policyDigest: run.policyDigest,
  }, 'rc');
  const decision = approval.recordApprovalDecision(stores.inboxRoot, {
    requestId: request, status: 'approved', decidedBy: 'release-operator-one', rationale: 'green', providerId: 'operator-release-1',
  });
  const disposition = approval.operatorDispositionOf(decision.decision);
  assert.equal(disposition.command, 'workplace.resolveHumanResponse', 'the D12 operator disposition command is the wake source');
  assert.deepEqual([...disposition.evidenceRefs], [decision.decision.decisionRef]);
  assert.equal(disposition.operatorDispositionRef, decision.decision.decisionRef);
  void manifest;
});
