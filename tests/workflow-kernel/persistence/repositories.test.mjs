/**
 * repositories.test.mjs - sole-writer repository behavior (WP-06, plan
 * phase EK-3): transactional event/evidence/obligation writes, CAS fences,
 * durable idempotency, the WorkIntent/ActivityAttempt role-contract pin,
 * the immutable PromptAssemblyReceipt evidence, the eventless transport
 * boundary, atomic rollback, and faithful rehydration from durable rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { openKernelDatabase } = await import('../../../dist/workflow-kernel/persistence/database.js');
const { KernelPersistenceSession } = await import('../../../dist/workflow-kernel/persistence/session.js');
const explorer = await import('../../../dist/workflow-kernel/domain/explorer.js');
const { COMMANDS } = await import('../../../dist/workflow-kernel/domain/universe.js');

const SEED = 20260825;

/** The explorer's external Input-authority evidence (same three kinds createWorld seeds). */
const externalInputs = [
  { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: 'checkplan' },
  { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: 'pve' },
  { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: 'pvf' },
];

function freshSession() {
  const dir = mkdtempSync(join(tmpdir(), 'ek-wp06-repos-'));
  const path = join(dir, 'kernel.sqlite');
  return { session: new KernelPersistenceSession(openKernelDatabase(path)), path, dir };
}

const repoOf = (session, aggregate) => ({
  FactoryRun: session.factoryRun,
  LifecycleRun: session.lifecycleRun,
  StageRun: session.stageRun,
  ProcessRun: session.processRun,
  NodeRun: session.nodeRun,
  Workplace: session.workplace,
  ActivityAttempt: session.activityAttempt,
  WorkItem: session.workItem,
  CognitionTransport: session.cognitionTransport,
}[aggregate]);

const aggregateOf = (command) => COMMANDS.find((entry) => entry.name === command).aggregate;

/** Replay a generated legal trace through the sole-writer repositories. */
function replayTrace(session, targetCommand) {
  const trace = explorer.generateLegalTrace(targetCommand, SEED);
  const outcomes = [];
  for (const step of trace.steps) {
    const repository = repoOf(session, aggregateOf(step.input.command));
    const options = { externalEvidence: externalInputs };
    if (step.input.command === 'activityAttempt.admitProviderRequest') {
      const counters = session.db
        .prepare('SELECT context_revision, next_request_ordinal FROM activity_attempt WHERE instance_id = ?')
        .get(step.input.instanceId);
      options.promptReceipt = {
        admission: 'admitted',
        requestOrdinal: counters.next_request_ordinal + 1,
        expectedContextRevision: counters.context_revision,
        digest: `receipt:${step.input.idempotencyKey}`,
      };
    }
    outcomes.push({ step: step.input, outcome: repository.applyCommand(step.input, options) });
  }
  return outcomes;
}

test('a generated legal conveyor trace commits through the repositories and rehydrates faithfully', () => {
  const { session, path } = freshSession();
  try {
    const outcomes = replayTrace(session, 'workplace.materialize');
    for (const { step, outcome } of outcomes) {
      assert.equal(outcome.committed, true, `${step.command} must commit (${outcome.reason ?? 'committed'})`);
    }
    const before = session.counts();
    const headBefore = session.workplace.loadHead(outcomes[outcomes.length - 1].step.instanceId);
    session.close();

    // Close, reopen, rehydrate: the durable world equals the committed world.
    const reopened = new KernelPersistenceSession(openKernelDatabase(path));
    try {
      const after = reopened.counts();
      assert.deepEqual(after, before, 'shared ledger counts survive close/reopen');
      assert.deepEqual(reopened.workplace.loadHead(headBefore.instanceId), headBefore, 'workplace head survives close/reopen');
      const world = reopened.hydrateWorld().world;
      assert.equal(world.events.length, before.events);
      assert.equal(world.obligations.length, before.obligations);
      assert.equal(world.sequence, outcomes.length);
      // Hydrated guard context carries the recorded evidence of every commit.
      const kinds = new Set(world.evidence.map((fact) => fact.kind));
      assert.ok(kinds.has('CapsuleIngressReceipt'), 'capsule evidence rehydrates');
      assert.ok(kinds.has('TransitionObligation'), 'obligation evidence rehydrates');
      assert.ok(kinds.has('WorkflowEvent'), 'event evidence rehydrates');
    } finally {
      reopened.close();
    }
  } finally {
    session.close();
  }
});

test('proof-issuing and wait-issuing traces persist terminal proofs and typed waits', () => {
  const { session } = freshSession();
  try {
    const outcomes = replayTrace(session, 'processRun.settleFailure');
    assert.ok(outcomes.every((entry) => entry.outcome.committed === true), 'settleFailure trace commits fully');
    const proofs = session.db.prepare('SELECT proof_kind FROM terminal_proof').all().map((row) => row.proof_kind);
    assert.ok(proofs.includes('TerminalProof:process.truthful-failure'), `truthful-failure proof persisted (${proofs.join(', ')})`);
  } finally {
    session.close();
  }

  // A fresh database for the second trace: generated traces reuse their
  // deterministic idempotency keys, and replaying them on one database is
  // the duplicate-key case covered by its own test above.
  const { session: stopSession } = freshSession();
  try {
    const stop = replayTrace(stopSession, 'factoryRun.requestStop');
    assert.ok(stop.every((entry) => entry.outcome.committed === true), 'requestStop trace commits fully');
    const waits = stopSession.db.prepare('SELECT kind, state FROM typed_wait').all();
    assert.ok(waits.some((row) => row.kind === 'TypedWait:policy-quota' && row.state === 'pending'), 'policy-quota wait persisted pending with its wake source');
  } finally {
    stopSession.close();
  }
});

test('sole writer: a repository refuses commands owned by another aggregate and writes nothing', () => {
  const { session } = freshSession();
  try {
    session.factoryRun.applyCommand({ command: 'factoryRun.bootstrap', instanceId: 'fr:1', expectedRevision: 0, idempotencyKey: 'a' });
    const before = session.counts();
    const outcome = session.workplace.applyCommand({ command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'b' });
    assert.equal(outcome.refused, true);
    assert.equal(outcome.reason, 'COMMAND_NOT_OWNED_BY_AGGREGATE');
    assert.deepEqual(session.counts(), before, 'no ledger rows from a foreign-owner command');
    assert.equal(session.db.prepare('SELECT COUNT (*) AS n FROM workplace').get().n, 0, 'no workplace head row');
  } finally {
    session.close();
  }
});

test('CAS fence: a stale expected revision on a legal edge is refused and writes nothing', () => {
  const { session } = freshSession();
  try {
    session.factoryRun.applyCommand({ command: 'factoryRun.bootstrap', instanceId: 'fr:1', expectedRevision: 0, idempotencyKey: 'a' });
    session.factoryRun.applyCommand({ command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'b' });
    session.factoryRun.applyCommand({ command: 'factoryRun.start', instanceId: 'fr:1', expectedRevision: 2, idempotencyKey: 'c' });
    const before = session.counts();
    const headBefore = session.factoryRun.loadHead('fr:1');
    const outcome = session.factoryRun.applyCommand({ command: 'factoryRun.requestStop', instanceId: 'fr:1', expectedRevision: 99, idempotencyKey: 'd' });
    assert.equal(outcome.refused, true);
    assert.equal(outcome.reason, 'STALE_EXPECTED_REVISION');
    assert.deepEqual(session.counts(), before);
    assert.deepEqual(session.factoryRun.loadHead('fr:1'), headBefore, 'the head did not move');
  } finally {
    session.close();
  }
});

test('durable idempotency: a duplicate key cannot create a second fact (creation replay and mid-flow duplicate)', () => {
  const { session } = freshSession();
  try {
    session.factoryRun.applyCommand({ command: 'factoryRun.bootstrap', instanceId: 'fr:1', expectedRevision: 0, idempotencyKey: 'dup' });
    const before = session.counts();
    const replay = session.factoryRun.applyCommand({ command: 'factoryRun.bootstrap', instanceId: 'fr:2', expectedRevision: 0, idempotencyKey: 'dup' });
    assert.equal(replay.replayed, true, 'creation replay is detected');
    assert.equal(replay.originalEventSequence, 1);
    assert.deepEqual(session.counts(), before, 'the replay wrote nothing');
    assert.equal(session.factoryRun.loadHead('fr:2'), undefined, 'no second instance materialized');

    // A duplicate key on a command whose status edge no longer matches is
    // refused by the frozen engine legality; either way NO second fact rows.
    session.factoryRun.applyCommand({ command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'ic' });
    const mid = session.counts();
    const again = session.factoryRun.applyCommand({ command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'ic' });
    assert.ok(again.refused === true || again.replayed === true, 'a duplicate key never commits a second fact');
    assert.deepEqual(session.counts(), mid, 'the duplicate wrote nothing');
  } finally {
    session.close();
  }
});

test('the WorkIntent pins the exact CanonicalRoleContract reference and digest at creation', () => {
  const { session } = freshSession();
  try {
    replayTrace(session, 'workplace.materialize');
    const workplaceHead = session.workplace.loadHeads()[0];
    const pin = { roleContractRef: 'sha256:' + 'ab'.repeat(32), roleContractDigest: 'ab'.repeat(32) };
    const outcome = session.workplace.applyCommand({
      command: 'workplace.admitWorkIntent',
      instanceId: workplaceHead.instanceId,
      expectedRevision: workplaceHead.revision,
      idempotencyKey: 'wi-1',
      protocolRole: 'author',
      rolePin: pin,
      evidenceRefs: ['evidence:WorkItem#1'],
    });
    assert.equal(outcome.committed, true, outcome.reason ?? 'committed');
    const intent = session.workplace.loadWorkIntents().at(-1);
    assert.equal(intent.roleContract.roleContractRef, pin.roleContractRef);
    assert.equal(intent.roleContract.roleContractDigest, pin.roleContractDigest);
    assert.equal(intent.protocolRole, 'author');
    // The pin is immutable after creation (schema-level).
    assert.throws(
      () => session.db.exec(`UPDATE workplace_work_intent SET role_contract_digest = 'x' WHERE intent_ref = '${intent.intentRef}'`),
      /EK_WORK_INTENT_IMMUTABLE/,
    );
  } finally {
    session.close();
  }
});

test('ActivityAttempt copies the pin from its exact WorkIntent and refuses every mismatch', () => {
  const { session } = freshSession();
  try {
    replayTrace(session, 'workplace.materialize');
    const workplaceHead = session.workplace.loadHeads()[0];
    const pin = { roleContractRef: 'sha256:' + 'ab'.repeat(32), roleContractDigest: 'ab'.repeat(32) };
    session.workplace.applyCommand({
      command: 'workplace.admitWorkIntent',
      instanceId: workplaceHead.instanceId,
      expectedRevision: workplaceHead.revision,
      idempotencyKey: 'wi-1',
      protocolRole: 'author',
      rolePin: pin,
      evidenceRefs: ['evidence:WorkItem#1'],
    });
    const intent = session.workplace.loadWorkIntents().at(-1);

    const foreignDigest = session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: 'attempt:1', expectedRevision: 0, idempotencyKey: 'at-1',
      workIntentRef: intent.intentRef, rolePin: { ...pin, roleContractDigest: 'ff'.repeat(32) },
    });
    assert.equal(foreignDigest.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH', 'digest A paired with digest B is refused');
    const foreignRef = session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: 'attempt:1', expectedRevision: 0, idempotencyKey: 'at-2',
      workIntentRef: intent.intentRef, rolePin: { ...pin, roleContractRef: 'sha256:' + '00'.repeat(32) },
    });
    assert.equal(foreignRef.reason, 'ROLE_CONTRACT_REF_MISMATCH');
    const foreignIntent = session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: 'attempt:1', expectedRevision: 0, idempotencyKey: 'at-3',
      workIntentRef: 'evidence:WorkIntent#foreign', rolePin: pin,
    });
    assert.equal(foreignIntent.reason, 'FOREIGN_EVIDENCE_REF');
    assert.equal(session.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt').get().n, 0, 'no attempt row exists before a verified creation');

    const created = session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: 'attempt:1', expectedRevision: 0, idempotencyKey: 'at-4',
      workIntentRef: intent.intentRef, rolePin: pin,
    });
    assert.equal(created.committed, true);
    const storedPin = session.activityAttempt.loadRoleContractPin('attempt:1');
    assert.deepEqual(storedPin, { workIntentRef: intent.intentRef, roleContractRef: pin.roleContractRef, roleContractDigest: pin.roleContractDigest });
  } finally {
    session.close();
  }
});

test('admitProviderRequest persists its PromptAssemblyReceipt as immutable evidence in the same transaction', () => {
  const { session } = freshSession();
  try {
    replayTrace(session, 'workplace.materialize');
    const workplaceHead = session.workplace.loadHeads()[0];
    const pin = { roleContractRef: 'sha256:' + 'ab'.repeat(32), roleContractDigest: 'ab'.repeat(32) };
    session.workplace.applyCommand({
      command: 'workplace.admitWorkIntent', instanceId: workplaceHead.instanceId, expectedRevision: workplaceHead.revision,
      idempotencyKey: 'wi-1', protocolRole: 'author', rolePin: pin, evidenceRefs: ['evidence:WorkItem#1'],
    });
    const intent = session.workplace.loadWorkIntents().at(-1);
    session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: 'attempt:1', expectedRevision: 0, idempotencyKey: 'at-1',
      workIntentRef: intent.intentRef, rolePin: pin,
    });

    // Fail-closed: no receipt, no admission.
    const noReceipt = session.activityAttempt.applyCommand({
      command: 'activityAttempt.admitProviderRequest', instanceId: 'attempt:1', expectedRevision: 1, idempotencyKey: 'ad-1',
    });
    assert.equal(noReceipt.reason, 'MISSING_EVIDENCE');
    // The ordinal is the idempotency dimension: a stale ordinal is refused.
    const staleOrdinal = session.activityAttempt.applyCommand({
      command: 'activityAttempt.admitProviderRequest', instanceId: 'attempt:1', expectedRevision: 1, idempotencyKey: 'ad-2',
    }, { promptReceipt: { admission: 'admitted', requestOrdinal: 5, expectedContextRevision: 0, digest: 'd' } });
    assert.equal(staleOrdinal.reason, 'STALE_EXPECTED_REVISION');

    const admitted = session.activityAttempt.applyCommand({
      command: 'activityAttempt.admitProviderRequest', instanceId: 'attempt:1', expectedRevision: 1, idempotencyKey: 'ad-3',
    }, { promptReceipt: { admission: 'admitted', requestOrdinal: 1, expectedContextRevision: 0, digest: 'receipt-digest', payloadJson: '{"layers":[]}' } });
    assert.equal(admitted.committed, true, admitted.reason ?? 'committed');

    const receipt = session.db.prepare('SELECT receipt_ref, admission, request_ordinal, expected_context_revision, digest FROM activity_attempt_prompt_assembly_receipt').get();
    assert.deepEqual(receipt, { receipt_ref: 'prompt-receipt:attempt:1:1', admission: 'admitted', request_ordinal: 1, expected_context_revision: 0, digest: 'receipt-digest' });
    // A receipt may record admitted or refused - NEVER sent (schema-level law).
    assert.throws(
      () => session.db.exec("INSERT INTO activity_attempt_prompt_assembly_receipt (receipt_ref, activity_attempt_instance_id, admission, request_ordinal, expected_context_revision, digest, payload_json, created_sequence) VALUES ('x', 'attempt:1', 'sent', 2, 1, 'd', '{}', 99)"),
      /CHECK constraint failed: admission/,
    );
    // CAS counters advanced exactly once.
    const counters = session.db.prepare('SELECT context_revision, next_request_ordinal FROM activity_attempt WHERE instance_id = ?').get('attempt:1');
    assert.deepEqual(counters, { context_revision: 1, next_request_ordinal: 1 });
  } finally {
    session.close();
  }
});

test('the eventless transport send completes its obligation durably and replays after reopen', () => {
  const { session, path } = freshSession();
  let attemptInstanceId = 'attempt:1';
  try {
    const outcomes = replayTrace(session, 'workplace.materialize');
    const workplaceHead = session.workplace.loadHeads()[0];
    const pin = { roleContractRef: 'sha256:' + 'ab'.repeat(32), roleContractDigest: 'ab'.repeat(32) };
    session.workplace.applyCommand({
      command: 'workplace.admitWorkIntent', instanceId: workplaceHead.instanceId, expectedRevision: workplaceHead.revision,
      idempotencyKey: 'wi-1', protocolRole: 'author', rolePin: pin, evidenceRefs: ['evidence:WorkItem#1'],
    });
    const intent = session.workplace.loadWorkIntents().at(-1);
    session.activityAttempt.applyCommand({
      command: 'activityAttempt.create', instanceId: attemptInstanceId, expectedRevision: 0, idempotencyKey: 'at-1',
      workIntentRef: intent.intentRef, rolePin: pin,
    });
    session.activityAttempt.applyCommand({
      command: 'activityAttempt.admitProviderRequest', instanceId: attemptInstanceId, expectedRevision: 1, idempotencyKey: 'ad-1',
    }, { promptReceipt: { admission: 'admitted', requestOrdinal: 1, expectedContextRevision: 0, digest: 'd' } });

    const eventsBefore = session.counts().events;
    const send = session.cognitionTransport.applyCommand({
      command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', expectedRevision: 0, idempotencyKey: 'send-1',
    });
    assert.equal(send.committed, true, send.reason ?? 'committed');
    assert.equal(send.event, null, 'the transport boundary declares no WorkflowEvent (universe-faithful)');
    assert.equal(session.counts().events, eventsBefore, 'no event row for the eventless boundary');
    const completed = session.db.prepare("SELECT completed_by_key, completed_at_sequence, completion_evidence_ref FROM transition_obligation WHERE kind = 'obligation:providerSend' AND state = 'completed'").get();
    assert.equal(completed.completed_by_key, 'send-1', 'the send key is durable on the obligation completion');
    const sendSequence = completed.completed_at_sequence;
    const replay = session.cognitionTransport.applyCommand({
      command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', expectedRevision: 1, idempotencyKey: 'send-1',
    });
    assert.equal(replay.replayed, true, 'the same send key replays idempotently');
    assert.equal(replay.originalEventSequence, sendSequence);
    session.close();

    const reopened = new KernelPersistenceSession(openKernelDatabase(path));
    try {
      assert.deepEqual(reopened.cognitionTransport.loadHeads()[0], { aggregate: 'CognitionTransport', instanceId: 'cognition:transport', revision: 1, status: 'stateless' }, 'the transport cursor derives from completed obligations');
      const replayAfterReopen = reopened.cognitionTransport.applyCommand({
        command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', expectedRevision: 1, idempotencyKey: 'send-1',
      });
      assert.equal(replayAfterReopen.replayed, true, 'the send replay survives close/reopen');
      assert.equal(reopened.hydrateWorld().world.sequence, sendSequence, 'the global sequence advanced past the eventless commit');
    } finally {
      reopened.close();
    }
  } finally {
    session.close();
  }
});

test('a failed transaction leaves neither fact nor orphan obligation', () => {
  const { session } = freshSession();
  try {
    session.factoryRun.applyCommand({ command: 'factoryRun.bootstrap', instanceId: 'fr:1', expectedRevision: 0, idempotencyKey: 'a' });
    session.factoryRun.applyCommand({ command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'b' });
    const before = session.counts();
    const workItemsBefore = session.workItem.loadHeads().length;

    // planGraph whose dependency edge references a nonexistent WorkItem:
    // the FK fires mid-transaction and the WHOLE commit rolls back.
    assert.throws(
      () => session.workItem.applyCommand(
        {
          command: 'workItem.planGraph', instanceId: 'work-item:1', expectedRevision: 0, idempotencyKey: 'plan-1',
          evidenceRefs: ['evidence:TerminalLifecycleClaim#2', 'evidence:ConstructionSurface#2', 'evidence:TerminalClaimCoverage#2'],
        },
        { dependencyEdges: [{ workItemRef: 'work-item:1', dependsOnRef: 'work-item:ghost' }] },
      ),
      /FOREIGN KEY/,
    );
    assert.deepEqual(session.counts(), before, 'neither fact nor orphan obligation survived the rollback');
    assert.equal(session.workItem.loadHeads().length, workItemsBefore, 'no work item row');
    assert.equal(session.db.prepare("SELECT COUNT (*) AS n FROM transition_obligation WHERE idempotency_key LIKE 'plan-1%'").get().n, 0, 'no orphan obligations');

    // The same command with a valid edge set commits atomically (edge + head + event together).
    const committed = session.workItem.applyCommand(
      {
        command: 'workItem.planGraph', instanceId: 'work-item:1', expectedRevision: 0, idempotencyKey: 'plan-2',
        evidenceRefs: ['evidence:TerminalLifecycleClaim#2', 'evidence:ConstructionSurface#2', 'evidence:TerminalClaimCoverage#2'],
      },
      { dependencyEdges: [] },
    );
    assert.equal(committed.committed, true, committed.reason ?? 'committed');
    session.workItem.applyCommand(
      {
        command: 'workItem.planGraph', instanceId: 'work-item:2', expectedRevision: 0, idempotencyKey: 'plan-3',
        evidenceRefs: ['evidence:TerminalLifecycleClaim#2', 'evidence:ConstructionSurface#2', 'evidence:TerminalClaimCoverage#2'],
      },
      { dependencyEdges: [{ workItemRef: 'work-item:2', dependsOnRef: 'work-item:1' }] },
    );
    const edges = session.workItem.loadDependencies();
    assert.deepEqual(edges, [{ workItemRef: 'work-item:2', dependsOnRef: 'work-item:1', createdSequence: edges[0].createdSequence }]);
    // The immutable planning fact cannot be mutated afterwards.
    assert.throws(() => session.db.exec("UPDATE work_item SET status = 'done' WHERE instance_id = 'work-item:1'"), /EK_WORK_ITEM_IMMUTABLE_PLANNING_FACT/);
  } finally {
    session.close();
  }
});

test('external input evidence is a closed kind set (Input authority)', () => {
  const { session } = freshSession();
  try {
    session.factoryRun.applyCommand(
      { command: 'factoryRun.bootstrap', instanceId: 'fr:1', expectedRevision: 0, idempotencyKey: 'a' },
      { externalEvidence: [{ kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input' }] },
    );
    assert.throws(
      () => session.factoryRun.applyCommand(
        { command: 'factoryRun.importCapsule', instanceId: 'fr:1', expectedRevision: 1, idempotencyKey: 'b' },
        { externalEvidence: [{ kind: 'GateDecision:accepted', ref: 'evidence:bogus', producer: 'external-input' }] },
      ),
      /closed Input authority kinds/,
      'only the three external-input kinds may enter as world inputs',
    );
  } finally {
    session.close();
  }
});
