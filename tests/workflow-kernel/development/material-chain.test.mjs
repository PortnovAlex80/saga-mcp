/**
 * material-chain.test.mjs - WP-08 deliverable 2: the ADR-053 material chain
 * through the new commands/events/obligations ONLY, from capsule ingress to
 * CellFinalAcceptance and the run terminal proof, with exact
 * author/reviewer/repair identity, revision binding, typed repair routing
 * and the human-wait public-command scenarios.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freshDatabase, roleRuntime, sharedTransport, taskManifest, authorScript, reviewerScript,
  buildCapsuleFixture, productVerifier, LINEAGE, CAPSULE_BYTES, sha256,
} from './support.mjs';

const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');
const chain = await import('../../../dist/workflow-kernel/development/material-chain.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');

async function boot({ finalGateVerdict, stopAfter, reviewerVerdict } = {}) {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(imported.imported, true);
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  // Resolve the role contracts ONCE (the driver and every consumer reuse these slots).
  const authorSlot = runtime.resolveOnce(authorLaunchKind);
  const reviewerSlot = runtime.resolveOnce(reviewerLaunchKind);
  assert.equal(authorSlot.resolved && reviewerSlot.resolved, true);
  const task = await taskManifest();
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2', 'activity-attempt:3'] });
  const config = {
    session,
    roles: runtime,
    authorLaunchKind,
    reviewerLaunchKind,
    transport,
    taskSummary: 'Build the simple-server product against the acceptance contract',
    requiredInfo: task,
    verifyProduct: await productVerifier(),
    externalEvidence: chain.externalInputEvidence('sha256:' + sha256('product-evidence'), true),
  };
  const run = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript(reviewerVerdict ?? 'accepted'),
    ...(finalGateVerdict !== undefined ? { finalGateVerdict } : {}),
    ...(stopAfter !== undefined ? { stopAfter } : {}),
  });
  return { session, config, run, capsule };
}

test('the full vertical: capsule -> material chain -> CellFinalAcceptance -> run terminal proof', async () => {
  const { session, run } = await boot();
  const refusedSteps = run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  assert.deepEqual(refusedSteps, [], `no step may refuse: ${JSON.stringify(refusedSteps, null, 2)}`);
  assert.equal(run.blockedAt, undefined);

  const world = session.hydrateWorld().world;
  // The terminal proofs of every scope issued.
  const proofKinds = new Set(world.proofs.map((proof) => proof.id));
  for (const kind of [
    'TerminalProof:cell.success',
    'TerminalProof:workplace.success',
    'TerminalProof:node.success',
    'TerminalProof:process.success',
    'TerminalProof:stage.success',
    'TerminalProof:lifecycle.success',
    'TerminalProof:run.success',
  ]) {
    assert.ok(proofKinds.has(kind), `${kind} issued`);
  }
  assert.equal(world.heads.get('workplace:1')?.terminal, 'TerminalProof:workplace.success');
  assert.equal(world.heads.get('factory-run:1')?.status, 'terminal');

  // The ADR-053 material chain rows: the production revision is the authority.
  const revisions = session.db.prepare('SELECT workplace_instance_id, payload_digest FROM workplace_production_revision ORDER BY created_sequence').all();
  assert.equal(revisions.length, 2, 'one author revision + one reviewer revision');
  for (const revision of revisions) {
    assert.equal(revision.workplace_instance_id, 'workplace:1', 'revisions bind the Workplace (accepted material authority)');
  }
  // presentCandidateSet records BOTH the author and reviewer candidate rows
  // per presentation (the universe's two evidence kinds).
  const candidates = session.db.prepare('SELECT presentation FROM workplace_candidate_set ORDER BY created_sequence').all().map((row) => row.presentation);
  assert.deepEqual(candidates, ['author', 'reviewer', 'author', 'reviewer']);
  const gates = session.db.prepare('SELECT verdict FROM workplace_gate_decision ORDER BY created_sequence').all().map((row) => row.verdict);
  assert.deepEqual(gates, ['accepted', 'accepted']);
  const acceptance = session.db.prepare('SELECT workplace_instance_id, acceptance_digest FROM workplace_cell_final_acceptance').all();
  assert.equal(acceptance.length, 1);
  assert.equal(acceptance[0].workplace_instance_id, 'workplace:1');
  assert.match(acceptance[0].acceptance_digest, /^[0-9a-f]{64}$/, 'D11: the acceptance embeds its digest');

  // The effect settled over the VERIFIED product.
  const effectKinds = world.evidence.filter((fact) => fact.kind.startsWith('EffectReceipt:')).map((fact) => fact.kind);
  assert.ok(effectKinds.includes('EffectReceipt:success'));

  // PromptAssemblyReceipts: one admitted request per attempt, durable.
  const receipts = session.db.prepare('SELECT activity_attempt_instance_id, admission, request_ordinal FROM activity_attempt_prompt_assembly_receipt ORDER BY created_sequence').all();
  assert.deepEqual(receipts, [
    { activity_attempt_instance_id: 'activity-attempt:1', admission: 'admitted', request_ordinal: 1 },
    { activity_attempt_instance_id: 'activity-attempt:2', admission: 'admitted', request_ordinal: 1 },
  ]);
  session.close();
});

test('exact author/reviewer identity and revision binding (ADR-053)', async () => {
  const { session, config, run } = await boot();
  // Happy-path precondition: the vertical must have reached the terminal proof
  // with NO honest refusal. When a load-flaked product verification makes the
  // kernel fail-closed (settle refused -> final acceptance lawfully absent),
  // the refusal verdict must be surfaced verbatim - never a bare array diff
  // (observed once under full-matrix load, 2026-08-27, kit 16a849a1).
  const blockedStep = run.steps.find((entry) => entry.result.status === 'refused' || entry.result.status === 'actor-refused' || entry.result.status === 'acceptance-refused');
  assert.equal(run.blockedAt, undefined, `the vertical blocked at ${run.blockedAt}: ${JSON.stringify(blockedStep?.result)}`);
  // WorkIntents: the author and reviewer pins differ; the attempt pins EQUAL their intent pins.
  const intents = [...session.hydrateWorld().world.workIntents.values()];
  const authorIntent = intents.find((intent) => intent.protocolRole === 'author');
  const reviewerIntent = intents.find((intent) => intent.protocolRole === 'reviewer');
  assert.ok(authorIntent && reviewerIntent);
  assert.notEqual(authorIntent.roleContract.roleContractDigest, reviewerIntent.roleContract.roleContractDigest, 'author and reviewer identities are exact and separate');
  const authorSlot = config.roles.slotOf(config.authorLaunchKind);
  const reviewerSlot = config.roles.slotOf(config.reviewerLaunchKind);
  assert.equal(authorIntent.roleContract.roleContractRef, authorSlot.pin.roleContractRef);
  assert.equal(reviewerIntent.roleContract.roleContractRef, reviewerSlot.pin.roleContractRef);
  // The durable intent rows carry the same pins as the runtime slots.
  const rows = session.db.prepare('SELECT intent_ref, protocol_role, role_contract_ref, role_contract_digest, workplace_instance_id FROM workplace_work_intent').all();
  assert.equal(rows.length, 2);
  const authorRow = rows.find((row) => row.protocol_role === 'author');
  assert.equal(authorRow.role_contract_ref, authorSlot.pin.roleContractRef);
  assert.equal(authorRow.role_contract_digest, authorSlot.pin.roleContractDigest);
  // The attempt rows copied the SAME pins from their exact intents.
  const attempts = session.db.prepare('SELECT instance_id, work_intent_ref, role_contract_ref, role_contract_digest FROM activity_attempt ORDER BY instance_id').all();
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    const intent = intents.find((entry) => entry.intentRef === attempt.work_intent_ref);
    assert.ok(intent, `attempt ${attempt.instance_id} binds its exact WorkIntent`);
    assert.equal(attempt.role_contract_ref, intent.roleContract.roleContractRef);
    assert.equal(attempt.role_contract_digest, intent.roleContract.roleContractDigest);
  }
  // Revision binding: every revision/candidate/gate/acceptance row binds workplace:1,
  // and the material chain order is revision -> candidates -> gates -> acceptance.
  const order = session.db.prepare("SELECT 'revision' AS kind, created_sequence FROM workplace_production_revision UNION ALL SELECT 'candidate', created_sequence FROM workplace_candidate_set UNION ALL SELECT 'gate', created_sequence FROM workplace_gate_decision UNION ALL SELECT 'acceptance', created_sequence FROM workplace_cell_final_acceptance ORDER BY created_sequence").all().map((row) => row.kind);
  assert.deepEqual(order, ['revision', 'candidate', 'candidate', 'gate', 'revision', 'candidate', 'candidate', 'gate', 'acceptance']);
  session.close();
});

test('the vertical is idempotent: re-drive converges without duplicate facts', async () => {
  const db = freshDatabase();
  const sessionA = await db.open();
  const capsule = await buildCapsuleFixture();
  assert.equal(ingress.ingestCapsule(sessionA, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  runtime.resolveOnce(authorLaunchKind);
  runtime.resolveOnce(reviewerLaunchKind);
  const task = await taskManifest();
  const { transport } = await sharedTransport(sessionA, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const config = {
    session: sessionA, roles: runtime, authorLaunchKind, reviewerLaunchKind, transport,
    taskSummary: 'idempotent re-drive', requiredInfo: task,
    verifyProduct: await productVerifier(),
    externalEvidence: chain.externalInputEvidence('sha256:' + sha256('idem'), true),
  };
  const first = await chain.driveDevelopmentVertical(config, { authorScript: await authorScript(), reviewerScript: await reviewerScript() });
  assert.equal(first.blockedAt, undefined, JSON.stringify(first.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped')));
  const eventsAfterFirst = sessionA.hydrateWorld().world.events.length;
  // Re-drive the SAME database: everything skips/replays, nothing duplicates.
  const second = await chain.driveDevelopmentVertical(config, { authorScript: await authorScript(), reviewerScript: await reviewerScript() });
  assert.equal(second.blockedAt, undefined);
  const world = sessionA.hydrateWorld().world;
  assert.equal(world.events.length, eventsAfterFirst, 'no duplicate WorkflowEvents on re-drive');
  assert.equal(sessionA.db.prepare('SELECT COUNT(*) AS n FROM workplace_production_revision').get().n, 2);
  assert.equal(sessionA.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n, 1);
  sessionA.close();
});

test('out-of-scope defects route to typed upstream repair; Development never widens silently', async () => {
  const { session, config } = await boot({ finalGateVerdict: 'upstream-repair' });
  const routing = chain.upstreamRepairRouting(config);
  assert.equal(routing.routed, true, routing.detail);
  assert.equal(routing.widened, false, 'no widenAuthorityScope event may exist');
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'GateDecision:upstream-repair'));
  const obligation = world.obligations.find((entry) => entry.kind === 'obligation:routeUpstreamRepair');
  assert.equal(obligation?.target, 'processRun.settle', 'the typed repair obligation targets the owning upstream aggregate');
  // Development itself is untouched: no widened scope, no silent requeue.
  assert.equal(world.events.filter((event) => event.transition === 'workplace.widenAuthorityScope').length, 0);
  session.close();
});

test('the repair loop re-staffs the SAME Workplace with the AUTHOR identity (R18 + ADR-053)', async (t) => {
  const { session, config } = await boot({ stopAfter: 'author-present-candidates' });
  t.after(() => session.close());
  // A repair verdict from the author gate (the reviewer found a defect).
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === 'obligation:runGate.author');
  assert.ok(frontier, 'runGate.author obligation open');
  const repairGate = consumer.consumeClaim(session, frontier.claim, { gateVerdict: 'repair' }, { externalEvidence: config.externalEvidence });
  assert.equal(repairGate.status, 'committed');
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'GateDecision:repair'));

  // Enter the repair wait (RecoveryIssue + requeueRepair obligation).
  const enter = chain.enterRepairWait(config);
  assert.equal(enter.status, 'committed', JSON.stringify(enter));
  assert.ok(session.hydrateWorld().world.evidence.some((fact) => fact.kind === 'RecoveryIssue'));

  // Requeue: re-admit the AUTHOR identity - the same pin, same Workplace.
  const requeue = chain.requeueRepairAsAuthor(config);
  assert.equal(requeue.status, 'committed', JSON.stringify(requeue));
  const intents = [...session.hydrateWorld().world.workIntents.values()].filter((intent) => intent.protocolRole === 'author');
  assert.equal(intents.length, 2, 'the repair re-admission added a second author intent');
  const authorSlot = config.roles.slotOf(config.authorLaunchKind);
  for (const intent of intents) {
    assert.equal(intent.roleContract.roleContractRef, authorSlot.pin.roleContractRef, 'repair identity preserved: the SAME author pin');
    assert.equal(intent.workplaceInstanceId, 'workplace:1', 'same Workplace re-staffed');
  }
  const repairAttempt = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:3',
    expectedRevision: 0,
    idempotencyKey: 'repair:attempt',
    workIntentRef: intents[intents.length - 1].intentRef,
    rolePin: intents[intents.length - 1].roleContract,
  });
  assert.equal(repairAttempt.refused, undefined, `the repair attempt pins the SAME identity: ${JSON.stringify(repairAttempt)}`);
});

test('runtime human-wait scenarios run through the public command path (typed waits, D12)', async (t) => {
  const { session, config } = await boot({ finalGateVerdict: 'human-wait', stopAfter: 'final-gate' });
  t.after(() => session.close());
  // The gate verdict created a pending TypedWait:human-input with its exact wake source.
  let waits = session.hydrateWorld().world.waits.filter((wait) => wait.kind === 'TypedWait:human-input' && wait.state === 'pending');
  assert.equal(waits.length, 1);
  assert.deepEqual([...waits[0].wakeCommands], ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);

  const scenario = chain.humanWaitScenario(config);
  assert.equal(scenario.enter.status, 'committed', JSON.stringify(scenario.enter));
  assert.equal(scenario.resolve.status, 'committed', JSON.stringify(scenario.resolve));
  waits = session.hydrateWorld().world.waits.filter((wait) => wait.kind === 'TypedWait:human-input');
  assert.equal(waits[0].state, 'discharged', 'the human-input wait is discharged by the operator command (D5 wake discharge)');
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'WakeDischarge:human-response-command'));
});

test('D12: an uncertain effect commits the typed wait; the operator disposition resolves the lawful human-waited loop', async (t) => {
  // Part A: the uncertain settle commits TypedWait:effect-uncertainty with
  // the operator wake source (never an automatic duplicate send).
  const a = await boot({ stopAfter: 'final-gate' });
  t.after(() => a.session.close());
  const uncertainty = chain.effectUncertaintyScenario(a.config);
  assert.equal(uncertainty.uncertain.status, 'committed', JSON.stringify(uncertainty.uncertain));
  let world = a.session.hydrateWorld().world;
  const wait = world.waits.find((entry) => entry.kind === 'TypedWait:effect-uncertainty');
  assert.equal(wait?.state, 'pending');
  assert.deepEqual([...wait.wakeCommands], ['workplace.resolveHumanResponse'], 'the ONLY wake is the operator disposition command (D12)');
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:unknown'));
  // REDUCER GAP (documented in material-chain.ts): the frozen Workplace
  // reducer has no outgoing edge from 'effect-uncertainty-waited', so the
  // resume cannot lawfully run there. The wait stays pending for the
  // operator; nothing auto-duplicates the send.
  assert.equal(a.session.hydrateWorld().world.heads.get('workplace:1')?.status, 'effect-uncertainty-waited');

  // Part B: the resolvable operator-disposition loop (the lawful
  // 'effect-human-waited' edge): settle human-wait -> operator resolve -> resume.
  const b = await boot({ stopAfter: 'final-gate' });
  t.after(() => b.session.close());
  const disposition = chain.operatorDispositionScenario(b.config);
  assert.equal(disposition.humanWait.status, 'committed', JSON.stringify(disposition.humanWait));
  assert.equal(disposition.resolve.status, 'committed', JSON.stringify(disposition.resolve));
  assert.equal(disposition.resume.status, 'committed', JSON.stringify(disposition.resume));
  world = b.session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'));
  assert.equal(world.waits.filter((entry) => entry.kind === 'TypedWait:human-input' && entry.state === 'pending').length, 0, 'the human-input wait is discharged');
});

test('a failing product verification blocks the effect: no invented success receipt', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  runtime.resolveOnce(authorLaunchKind);
  runtime.resolveOnce(reviewerLaunchKind);
  const task = await taskManifest();
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const config = {
    session, roles: runtime, authorLaunchKind, reviewerLaunchKind, transport,
    taskSummary: 'failing verification', requiredInfo: task,
    verifyProduct: async () => ({ ok: false, detail: 'MISSING_INTEGRATION_SURFACE: public/app.js absent', digest: 'sha256:' + sha256('fail') }),
    externalEvidence: chain.externalInputEvidence('sha256:' + sha256('fail'), false),
  };
  const run = await chain.driveDevelopmentVertical(config, { authorScript: await authorScript(), reviewerScript: await reviewerScript() });
  assert.equal(run.blockedAt, 'settle-effect');
  const settle = run.steps.find((step) => step.step === 'settle-effect');
  assert.equal(settle.result.status, 'acceptance-refused');
  assert.match(settle.result.detail, /MISSING_INTEGRATION_SURFACE/);
  const world = session.hydrateWorld().world;
  assert.equal(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false, 'no success receipt may exist');
  assert.equal(world.heads.get('workplace:1')?.terminal, undefined, 'no acceptance without the verified product');
  session.close();
});
