/**
 * scenario.test.mjs - WP-11D deliverable 8: ONE full Discovery run through
 * public commands, from the operator's idea (content-addressed intake) to
 * the accepted products (CellFinalAcceptance + the durable handoff to the
 * next stage), plus the typed-wait scenarios (decision fork D5, effect
 * uncertainty D12) and the idempotent re-drive convergence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, discoveryConfig, authorScript, reviewerScript, sha256 } from './support.mjs';

const driver = await import('../../../../dist/workflow-kernel/workshops/discovery/driver.js');
const contributions = await import('../../../../dist/workflow-kernel/workshops/discovery/contributions.js');

async function boot(overrides = {}, options = {}) {
  const session = await (await freshDatabase()).open();
  const staged = await discoveryConfig(session, overrides);
  const run = await driver.driveDiscoveryWorkshop(staged.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    ...options,
  });
  return { session, ...staged, run };
}

test('the full run: idea intake -> accepted products -> the durable handoff', async (t) => {
  const { session, run, idea, brief, intent } = await boot();
  t.after(() => session.close());
  const refused = run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  assert.deepEqual(refused, [], `no step may refuse: ${JSON.stringify(refused, null, 2)}`);
  assert.equal(run.blockedAt, undefined);

  const world = session.hydrateWorld().world;
  // The workplace/cell/node/process/stage terminal proofs issued.
  const proofs = new Set(world.proofs.map((proof) => proof.id));
  for (const kind of [
    'TerminalProof:workplace.success',
    'TerminalProof:cell.success',
    'TerminalProof:node.success',
    'TerminalProof:process.success',
    'TerminalProof:stage.success',
  ]) {
    assert.ok(proofs.has(kind), `${kind} issued`);
  }
  assert.equal(world.heads.get('workplace:1')?.terminal, 'TerminalProof:workplace.success');

  // The ADR-053 material chain: the PRODUCTION REVISION is the authority.
  const revisions = session.db.prepare('SELECT workplace_instance_id, payload_digest FROM workplace_production_revision ORDER BY created_sequence').all();
  assert.equal(revisions.length, 2, 'one author revision (the brief) + one reviewer revision (the intent)');
  assert.deepEqual(revisions.map((row) => row.workplace_instance_id), ['workplace:1', 'workplace:1']);
  assert.ok(revisions.every((row) => /^[0-9a-f]{64}$/.test(row.payload_digest)), 'each revision row embeds a payload digest');
  // The chain order: revision -> candidates -> gate, twice, then acceptance.
  const order = session.db.prepare("SELECT 'revision' AS kind, created_sequence FROM workplace_production_revision UNION ALL SELECT 'candidate', created_sequence FROM workplace_candidate_set UNION ALL SELECT 'gate', created_sequence FROM workplace_gate_decision UNION ALL SELECT 'acceptance', created_sequence FROM workplace_cell_final_acceptance ORDER BY created_sequence").all().map((row) => row.kind);
  assert.deepEqual(order, ['revision', 'candidate', 'candidate', 'gate', 'revision', 'candidate', 'candidate', 'gate', 'acceptance']);
  const acceptance = session.db.prepare('SELECT workplace_instance_id, acceptance_digest FROM workplace_cell_final_acceptance').all();
  assert.equal(acceptance.length, 1);
  assert.match(acceptance[0].acceptance_digest, /^[0-9a-f]{64}$/, 'D11: the acceptance embeds its digest');
  const gates = session.db.prepare('SELECT verdict FROM workplace_gate_decision ORDER BY created_sequence').all().map((row) => row.verdict);
  assert.deepEqual(gates, ['accepted', 'accepted'], 'both semantic gates accepted (declared CheckPlans green)');

  // D10: the idea unknowns opened their obligations (idea conservation).
  const unknownObligation = world.obligations.find((entry) => entry.kind === 'obligation:openUnknownObligation');
  assert.ok(unknownObligation, 'workItem.planGraph opened the unknown obligation');

  // The effect settled over the VERIFIED products.
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'));

  // The durable handoff: the routed solution-formalization obligation is OPEN.
  const handoff = world.obligations.find((entry) => entry.kind === 'obligation:enterStage.solution-formalization');
  assert.ok(handoff, 'the next stage obligation exists');
  assert.equal(handoff.state, 'open');
  assert.equal(handoff.target, 'stageRun.create');
  assert.equal(world.heads.get('lifecycle-run:1')?.status, 'outcome-routed', 'the lifecycle routed and continues (not terminal)');

  // PromptAssemblyReceipts: one admitted request per attempt, durable.
  const receipts = session.db.prepare('SELECT activity_attempt_instance_id, admission, request_ordinal FROM activity_attempt_prompt_assembly_receipt ORDER BY created_sequence').all();
  assert.deepEqual(receipts, [
    { activity_attempt_instance_id: 'activity-attempt:1', admission: 'admitted', request_ordinal: 1 },
    { activity_attempt_instance_id: 'activity-attempt:2', admission: 'admitted', request_ordinal: 1 },
  ]);
  void idea;
});

test('exact author/reviewer identity: intents pin the resolved slots; attempts copy the SAME pin', async (t) => {
  const { session, config, runtime, authorLaunchKind, reviewerLaunchKind } = await boot();
  t.after(() => session.close());
  const intents = [...session.hydrateWorld().world.workIntents.values()];
  const authorIntent = intents.find((intent) => intent.protocolRole === 'author');
  const reviewerIntent = intents.find((intent) => intent.protocolRole === 'reviewer');
  assert.ok(authorIntent && reviewerIntent);
  assert.notEqual(authorIntent.roleContract.roleContractDigest, reviewerIntent.roleContract.roleContractDigest);
  assert.equal(authorIntent.roleContract.roleContractRef, runtime.slotOf(authorLaunchKind).pin.roleContractRef);
  assert.equal(reviewerIntent.roleContract.roleContractRef, runtime.slotOf(reviewerLaunchKind).pin.roleContractRef);
  // The durable rows and the attempts carry the same pins.
  const rows = session.db.prepare('SELECT protocol_role, role_contract_ref, role_contract_digest FROM workplace_work_intent').all();
  assert.equal(rows.length, 2);
  const attempts = session.db.prepare('SELECT instance_id, work_intent_ref, role_contract_digest FROM activity_attempt ORDER BY instance_id').all();
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    const intent = intents.find((entry) => entry.intentRef === attempt.work_intent_ref);
    assert.ok(intent, `attempt ${attempt.instance_id} binds its exact WorkIntent`);
    assert.equal(attempt.role_contract_digest, intent.roleContract.roleContractDigest);
  }
  void config;
});

test('the run is idempotent: a full re-drive converges without duplicate facts', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  const first = await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript() });
  assert.equal(first.blockedAt, undefined, JSON.stringify(first.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped')));
  const eventsAfterFirst = session.hydrateWorld().world.events.length;
  const second = await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript() });
  assert.equal(second.blockedAt, undefined);
  const world = session.hydrateWorld().world;
  assert.equal(world.events.length, eventsAfterFirst, 'no duplicate WorkflowEvents on re-drive');
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_production_revision').get().n, 2);
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n, 1);
});

test('the decision fork: a needs-human intent routes to the typed human wait (D5)', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  const forkIntent = { ...staged.intent };
  // Rebuild the intent product with the needs-human decision.
  const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');
  const fork = products.sealProduct(contributions.draftIntentFromBrief(staged.brief, 'needs-human', 'The retention window is an operator call; the decision fork opens.'));
  void forkIntent;
  const run = await driver.driveDiscoveryWorkshop(
    { ...staged.config, intent: fork, verifyProducts: staged.config.verifyProducts },
    { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'final-gate' },
  );
  assert.equal(run.blockedAt, undefined, JSON.stringify(run.steps));
  let world = session.hydrateWorld().world;
  const wait = world.waits.find((entry) => entry.kind === 'TypedWait:human-input');
  assert.ok(wait, 'the needs-human verdict created the typed wait');
  assert.equal(wait.state, 'pending');
  assert.deepEqual([...wait.wakeCommands], ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
  assert.ok(world.evidence.some((fact) => fact.kind === 'GateDecision:human-wait'));
  // No effect runs while the operator has not decided (fail-closed): no
  // runEffects obligation was created by the human-wait verdict edge.
  assert.equal(world.obligations.some((entry) => entry.kind === 'obligation:runEffects'), false);
  assert.equal(world.evidence.some((fact) => fact.kind.startsWith('EffectReceipt:')), false);

  // The operator decides through the PUBLIC command path (D5 wake discharge).
  const scenario = driver.decisionForkWaitScenario(staged.config);
  assert.equal(scenario.enter.status, 'committed', JSON.stringify(scenario.enter));
  assert.equal(scenario.resolve.status, 'committed', JSON.stringify(scenario.resolve));
  world = session.hydrateWorld().world;
  assert.equal(world.waits.find((entry) => entry.kind === 'TypedWait:human-input')?.state, 'discharged');
  assert.ok(world.evidence.some((fact) => fact.kind === 'WakeDischarge:human-response-command'));
  // After the operator decision, the workplace re-staffs lawfully (author edge).
  const requeue = session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1',
    expectedRevision: session.hydrateWorld().world.heads.get('workplace:1')?.revision ?? 0,
    idempotencyKey: 'fork:readmit-author', protocolRole: 'author',
    rolePin: staged.config.roles.slotOf(staged.authorLaunchKind).pin,
    evidenceRefs: ['work-item:1'],
  });
  assert.equal(requeue.refused, undefined, `re-staffing after the decision is lawful: ${JSON.stringify(requeue)}`);
});

test('D12: an uncertain effect commits the typed wait; the operator disposition resolves and resumes', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  const run = await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'final-gate' });
  assert.equal(run.blockedAt, undefined, JSON.stringify(run.steps));
  const uncertain = driver.settleEffectUncertain(staged.config);
  assert.equal(uncertain.status, 'committed', JSON.stringify(uncertain));
  let world = session.hydrateWorld().world;
  const wait = world.waits.find((entry) => entry.kind === 'TypedWait:effect-uncertainty');
  assert.equal(wait?.state, 'pending');
  assert.deepEqual([...wait.wakeCommands], ['workplace.resolveHumanResponse'], 'the ONLY wake is the operator disposition (D12)');
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:unknown'));
  assert.equal(world.heads.get('workplace:1')?.status, 'effect-uncertainty-waited');
  // No success receipt while uncertain (never an automatic duplicate send).
  assert.equal(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false);

  const scenario = driver.operatorDispositionResume(staged.config);
  assert.equal(scenario.operatorDisposition.status, 'committed', JSON.stringify(scenario.operatorDisposition));
  assert.equal(scenario.resume.status, 'committed', JSON.stringify(scenario.resume));
  world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), 'the effect resumed to success after the disposition');
  assert.equal(world.waits.find((entry) => entry.kind === 'TypedWait:effect-uncertainty')?.state, 'discharged');
});

test('a failing product verification blocks the effect: no invented success receipt', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session, { expectVerificationFail: true });
  const run = await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript() });
  assert.equal(run.blockedAt, 'settle-effect');
  const settle = run.steps.find((step) => step.step === 'settle-effect');
  assert.equal(settle.result.status, 'acceptance-refused');
  const world = session.hydrateWorld().world;
  assert.equal(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false);
  assert.equal(world.heads.get('workplace:1')?.terminal, undefined, 'no acceptance without the verified products');
});

test('a lineage-broken contribution blocks the run BEFORE the spine moves (pure fence)', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');
  const staged = await discoveryConfig(session);
  const foreignBrief = products.sealProduct({ ...staged.brief.value, ideaRef: 'sha256:' + sha256('foreign-idea') });
  const run = await driver.driveDiscoveryWorkshop(
    { ...staged.config, brief: foreignBrief },
    { authorScript: authorScript(), reviewerScript: reviewerScript() },
  );
  assert.equal(run.blockedAt, 'author-contribution-mapping');
  assert.equal(run.steps[0].result.status, 'acceptance-refused');
  assert.equal(run.steps[0].result.reason, 'LINEAGE_BREAK');
  const headsAfter = session.hydrateWorld().world.heads;
  assert.equal(headsAfter.has('workplace:1'), false, 'no production cell was ever staffed');
  assert.equal(headsAfter.has('lifecycle-run:1'), false, 'nothing but the ingress exists');
});
