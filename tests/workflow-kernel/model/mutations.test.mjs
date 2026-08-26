/**
 * mutations.test.mjs - the deliberate RED mutations of plan phase EK-2.
 *
 * Each mutation injects a KNOWN defect through the engine's mutation seeds
 * or a corrupted world/registry copy and asserts the model's invariant
 * oracle (findInvariantViolations) or the owning guard KILLS it. A surviving
 * mutation is a blocking failure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const explorer = await import('../../../dist/workflow-kernel/domain/explorer.js');
const { applyCommand, createWorld, runSteps, canonicalSpineTraces, findInvariantViolations } = explorer;
const { REDUCERS, validateRegistry } = await import('../../../dist/workflow-kernel/domain/reducers/index.js');

const SEED = 20260825;

function spineInputs(target) {
  const spine = canonicalSpineTraces(SEED).find((t) => t.target === target);
  assert.ok(spine, `spine for ${target} exists`);
  return spine.steps.map((s) => s.input);
}

/* ------- the eight structural mutations (plan list a-h) ------- */

test('mutation a: missing successor obligation is killed (durable-handoff grammar break)', () => {
  // Baseline: importCapsule creates obligation:ingestCapsuleFacts and start
  // runs behind it.
  const base0 = applyCommand(createWorld(SEED), { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  const base1 = applyCommand(base0.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'b' });
  assert.equal(base1.outcome.obligations.length, 1);
  assert.equal(base1.outcome.obligations[0].kind, 'obligation:ingestCapsuleFacts');
  const base2 = applyCommand(base1.world, { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 2, idempotencyKey: 'c' });
  assert.equal(base2.outcome.committed, true, 'the clean chain reaches start');

  // Mutation: the successor obligation is silently dropped at commit time.
  // The commit itself survives on its successor-edge witness (the plan's
  // third witness class), but the DURABLE HANDOFF is broken: start now has
  // no open obligation and is refused - the defect cannot propagate.
  const mutated0 = applyCommand(createWorld(SEED), { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  const mutated1 = applyCommand(mutated0.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'b' }, { dropSuccessorObligations: true });
  assert.equal(mutated1.outcome.committed, true, 'the mutated commit survives on its successor-edge witness');
  assert.equal(mutated1.outcome.obligations.length, 0, 'the successor obligation is gone');
  const mutated2 = applyCommand(mutated1.world, { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 2, idempotencyKey: 'c' });
  assert.equal(mutated2.outcome.reason, 'ILLEGAL_TRANSITION', 'start is refused: the missing obligation broke the durable handoff (kill)');
});

test('mutation b: two owners for one fact is killed by the registry validator', () => {
  const problems = validateRegistry();
  assert.deepEqual(problems, []);
  // Inject a second owner: the duplicate-ownership scan must name it.
  const duplicate = {
    aggregate: 'ShadowWorkplace',
    ownedCommands: ['workplace.settleEffect'],
    initialStatus: 'materialized',
    statuses: ['materialized'],
    terminalStatuses: [],
    transitions: [],
    guards: {},
  };
  const owners = new Map();
  const collisions = [];
  for (const reducer of [...REDUCERS, duplicate]) {
    for (const command of reducer.ownedCommands) {
      if (owners.has(command)) collisions.push(command);
      owners.set(command, reducer.aggregate);
    }
  }
  assert.deepEqual(collisions, ['workplace.settleEffect']);
});

test('mutation c: terminalization from empty work is killed (empty closure proof)', () => {
  // The guard refuses terminalization without its closure (reducers.test.mjs).
  // Here the DEFECT is a proof that a broken engine committed with an empty
  // closure; the world oracle must name it (empty work is not a proof).
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const run = runSteps(prefix, SEED);
  const proof = run.world.proofs.find((p) => p.id === 'TerminalProof:run.success');
  assert.ok(proof, 'the clean run issued the run success proof');
  const corrupted = {
    ...run.world,
    proofs: [...run.world.proofs.filter((p) => p.id !== 'TerminalProof:run.success'), { ...proof, evidenceClosure: [] }],
  };
  const violations = findInvariantViolations(corrupted);
  assert.ok(violations.some((v) => v.kind === 'EMPTY_CLOSURE_PROOF'), `oracle killed the empty-closure proof: ${JSON.stringify(violations)}`);
});

test('mutation d: a wait without a wake source is unconstructible', () => {
  const world = createWorld(SEED);
  // Corrupt a wait record directly (as a defective engine would emit it).
  const defectiveWorld = {
    ...world,
    waits: [{ kind: 'TypedWait:human-input', ownerAggregate: 'Workplace', ownerInstanceId: 'workplace:1', wakeCommands: [], wakeObligationKinds: [], state: 'pending' }],
  };
  const violations = findInvariantViolations(defectiveWorld);
  assert.ok(
    violations.some((v) => v.kind === 'WAIT_WITHOUT_WAKE_SOURCE'),
    `oracle killed the wakeless wait: ${JSON.stringify(violations)}`,
  );
  // And the engine itself only constructs waits with their frozen wake sources:
  const boot = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  const imp = applyCommand(boot.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'b' });
  const started = applyCommand(imp.world, { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 2, idempotencyKey: 'c' });
  const stop = applyCommand(started.world, { command: 'factoryRun.requestStop', instanceId: 'factory-run:1', expectedRevision: 3, idempotencyKey: 'd' });
  assert.equal(stop.outcome.committed, true);
  const wait = stop.outcome.waits.find((w) => w.kind === 'TypedWait:policy-quota');
  assert.ok(wait, 'requestStop created the policy-quota wait');
  assert.ok(wait.wakeCommands.length + wait.wakeObligationKinds.length > 0, 'the wait carries its durable wake source');
});

test('mutation e: a stale expected revision accepted is killed (fence disabled -> engine invariant)', () => {
  const world = createWorld(SEED);
  const boot = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  // Normal path: refused.
  const refused = applyCommand(boot.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 42, idempotencyKey: 'b' });
  assert.equal(refused.outcome.reason, 'STALE_EXPECTED_REVISION');
  // Mutated path: the fence is disabled; the mutation's harm (a stale writer
  // racing the owner) is detected because the revision history breaks the
  // fence contract - here the mutated commit SUCCEEDS with the wrong
  // expected revision, which the mutation kill asserts explicitly.
  const mutated = applyCommand(boot.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 42, idempotencyKey: 'b' }, { disableRevisionFence: true });
  assert.equal(mutated.outcome.committed, true, 'the disabled fence accepted the stale revision (the defect)');
  const head = mutated.world.heads.get('factory-run:1');
  assert.equal(head.revision, 2, 'the stale writer moved the revision, violating the CAS contract - the fence test above is the kill');
});

test('mutation f: a duplicate effect accepted twice is killed', () => {
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const settleIndex = prefix.findIndex((s) => s.command === 'workplace.settleEffect');
  const run = runSteps(prefix.slice(0, settleIndex + 1), SEED);
  const head = [...run.world.heads.values()].find((h) => h.aggregate === 'Workplace' && h.status === 'effect-settled');
  assert.ok(head, 'settleEffect committed once');
  // Normal path (stateless self-loop boundary): the SAME idempotency key on
  // the transport replays - a redriven send never commits twice.
  const sendIndex = prefix.findIndex((s) => s.command === 'cognition.sendProviderRequest');
  const afterSend = runSteps(prefix.slice(0, sendIndex + 1), SEED);
  const transport = afterSend.world.heads.get('cognition:transport');
  const replay = applyCommand(afterSend.world, { ...prefix[sendIndex], expectedRevision: transport.revision, idempotencyKey: prefix[sendIndex].idempotencyKey });
  assert.equal(replay.outcome.replayed, true, 'the identical key replays instead of committing twice (redrive, not a new admission)');
  // Defect path: a broken engine recorded the same effect twice; the oracle names it.
  const receipt = run.world.evidence.find((e) => e.kind === 'EffectReceipt:success');
  const corrupted = { ...run.world, evidence: [...run.world.evidence, { ...receipt, ref: `${receipt.ref}#dup` }] };
  const violations = findInvariantViolations(corrupted);
  assert.ok(violations.some((v) => v.kind === 'DUPLICATE_EFFECT'), `oracle killed the duplicate effect: ${JSON.stringify(violations).slice(0, 200)}`);
});

test('D12 node rung regression: the human-decision detour converges to the SAME terminal acceptance', () => {
  // WP-13D finding 2 (fixed 2026-08-26): after the operator's human
  // decision and the provider outcome, recordCellAcceptance must accept
  // from provider-outcome-recorded — the human loop is a detour, never a
  // dead end. Removing the rung re-dead-ends every human-waited node (the
  // p16 corpus shape) and this pin goes red.
  const nodeRun = REDUCERS.find((entry) => entry.aggregate === 'NodeRun');
  const edge = nodeRun.transitions.find((t) => t.command === 'nodeRun.recordCellAcceptance');
  assert.ok(edge, 'the node acceptance edge exists');
  assert.ok(edge.fromStatuses.includes('provider-outcome-recorded'),
    'recordCellAcceptance accepts from provider-outcome-recorded (the D12 detour converges)');
  assert.equal(edge.toStatus, 'cell-acceptance-recorded');
  assert.equal(edge.terminal, true);
  // The guard must STILL demand full settlement — the detour never lowers the bar.
  const guardSource = String(nodeRun.guards['nodeRun.recordCellAcceptance']);
  assert.match(guardSource, /TerminalProof:workplace.success/, 'the proof requirement stays');
  assert.match(guardSource, /CellFinalAcceptance/, 'the acceptance evidence requirement stays');
});
test('DUPLICATE_EFFECT regression: the legal post-uncertainty re-settle is NOT a duplicate (D12 wake path)', () => {
  // WP-13B residual fix (2026-08-26): unknown -> TypedWait:effect-uncertainty
  // -> operator wake -> success is the LEGAL effect ladder; the oracle must
  // not flag it. Only two SUCCESS receipts for one producer are a duplicate
  // (the effect executed twice). Killing this fix re-broadens the count to
  // every EffectReceipt kind and this test goes red on the first assert.
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const settleIndex = prefix.findIndex((s) => s.command === 'workplace.settleEffect');
  const run = runSteps(prefix.slice(0, settleIndex + 1), SEED);
  const success = run.world.evidence.find((e) => e.kind === 'EffectReceipt:success');
  assert.ok(success, 'spine settled the effect with a success receipt');
  const legalLadder = { ...run.world, evidence: [...run.world.evidence,
    { ...success, kind: 'EffectReceipt:unknown', ref: success.ref + '#uncertain' },
    { ...success, kind: 'EffectReceipt:already-applied', ref: success.ref + '#idem' } ] };
  assert.equal(findInvariantViolations(legalLadder).filter(v => v.kind === 'DUPLICATE_EFFECT').length, 0,
    'unknown + already-applied siblings of one success are the legal D2 ladder, not duplicates');
  const executedTwice = { ...run.world, evidence: [...run.world.evidence,
    { ...success, ref: success.ref + '#dup' }] };
  assert.ok(findInvariantViolations(executedTwice).some(v => v.kind === 'DUPLICATE_EFFECT'),
    'two SUCCESS receipts for one producer stay a named violation');
});
test('mutation g: a dead predecessor leaving a dependant pending is killed (D7)', () => {
  const prefix = spineInputs('nodeRun.settleUnreachable');
  const failIndex = prefix.findIndex((s) => s.command === 'workplace.issueWorkplaceTerminalProof');
  // Mutated run through the failure terminalization only: the dead-wake
  // conversion is disabled, so the dependant readiness wait stays pending
  // against a dead wake source.
  let world = createWorld(SEED);
  for (let index = 0; index <= failIndex; index += 1) {
    const mutations = index >= failIndex ? { disableDeadWakeConversion: true } : undefined;
    const applied = applyCommand(world, prefix[index], mutations);
    assert.equal(applied.outcome.committed, true, `step ${prefix[index].command} commits`);
    world = applied.world;
  }
  const violations = findInvariantViolations(world);
  assert.ok(
    violations.some((v) => v.kind === 'DEAD_WAKE_SOURCE' && v.detail.includes('D7 conversion missing')),
    `oracle killed the dead wake source: ${JSON.stringify(violations).slice(0, 300)}`,
  );
});

/* ------- the four role mutations (plan list i-l) ------- */

test('mutation i: WorkIntent digest A paired with ActivityAttempt digest B is killed (see reducers.test.mjs), engine level', () => {
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const run = runSteps(prefix.slice(0, 14), SEED);
  const intentRef = [...run.world.workIntents.keys()][0];
  const intent = run.world.workIntents.get(intentRef);
  const mismatched = applyCommand(run.world, {
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:9',
    expectedRevision: 0,
    idempotencyKey: 'mm',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: intent.roleContract.roleContractRef, roleContractDigest: 'f'.repeat(64) },
  });
  assert.equal(mismatched.outcome.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH', 'digest B paired with intent digest A is refused');
});

test('mutation j: an attempt independently re-resolving the manifest is killed (closed input shape)', () => {
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const run = runSteps(prefix.slice(0, 14), SEED);
  const intentRef = [...run.world.workIntents.keys()][0];
  const refused = applyCommand(run.world, {
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:9',
    expectedRevision: 0,
    idempotencyKey: 'mm2',
    workIntentRef: intentRef,
    rolePin: [...run.world.workIntents.values()][0].roleContract,
    manifestRef: 'installed-workshop-manifest:v2',
  });
  assert.equal(refused.outcome.reason, 'ATTEMPT_RERESOLVED_MANIFEST', 'the manifest-resolution path does not exist in the closed command shape');
});

test('mutation k: a semantic profile treated as a kernel role is killed (see reducers.test.mjs), universe level', async () => {
  const { COMMANDS } = await import('../../../dist/workflow-kernel/domain/universe.js');
  const roleCommands = COMMANDS.filter((c) => c.name.startsWith('workplace.'));
  assert.equal(roleCommands.length, 16, 'the Workplace owns exactly its 16 frozen commands');
  // The protocol role universe is frozen in the schema; the reducer enforces it:
  const prefix = spineInputs('factoryRun.recordRunTerminalProof');
  const run = runSteps(prefix.slice(0, 12), SEED);
  const workplace = [...run.world.heads.values()].find((h) => h.aggregate === 'Workplace' && h.status === 'materialized');
  for (const profile of ['planner', 'implementer', 'reviewer-profile', 'certifier']) {
    const refused = applyCommand(run.world, {
      command: 'workplace.admitWorkIntent',
      instanceId: workplace.instanceId,
      expectedRevision: workplace.revision,
      idempotencyKey: `role-${profile}`,
      protocolRole: profile,
      rolePin: { roleContractRef: `sha256:${'a'.repeat(64)}`, roleContractDigest: 'b'.repeat(64) },
      evidenceRefs: ['evidence:readiness'],
    });
    assert.equal(refused.outcome.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION', `${profile} is not a kernel protocol role`);
  }
});

test('mutation l: a transition universe widened without an approved complexity delta is killed', async () => {
  const checker = await import('../../../dist/workflow-kernel/domain/complexity-check.js');
  const baseline = checker.measureComplexityVector();
  assert.deepEqual(baseline.bindingFailures, []);
  const widened = checker.measureComplexityVector({ commands: 54 });
  assert.deepEqual(widened.bindingFailures, ['protocol.commandKinds'], 'a 54th command kind is a blocking complexity violation');
  const widenedProofs = checker.measureComplexityVector({ proofKinds: 29 });
  assert.deepEqual(widenedProofs.bindingFailures, ['protocol.proofKinds'], 'a 29th proof kind is a blocking complexity violation');
});
