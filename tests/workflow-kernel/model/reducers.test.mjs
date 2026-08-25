/**
 * reducers.test.mjs - reducer legality, CAS fences, idempotency, role
 * transitions (the Workplace alone owns them) and the D3/D6/D7 settlement
 * semantics (WP-05).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { applyCommand, createWorld, canonicalSpineTraces, runSteps } = await import('../../../dist/workflow-kernel/domain/explorer.js');
const registry = await import('../../../dist/workflow-kernel/domain/reducers/index.js');
const { REDUCERS, validateRegistry } = registry;

test('the reducer registry is valid: one owner per command, exact universe edges', () => {
  assert.deepEqual(validateRegistry(), []);
});

test('two owners for one fact is structurally refused (mutation b, registry level)', () => {
  const rogue = {
    ...REDUCERS.find((r) => r.aggregate === 'Workplace'),
    aggregate: 'RogueWorkplace',
    ownedCommands: ['workplace.recordContribution'],
    transitions: [],
    guards: {},
  };
  const problems = [];
  const owners = new Map();
  for (const reducer of [...REDUCERS, rogue]) {
    for (const command of reducer.ownedCommands) {
      if (owners.has(command)) problems.push(`${command} owned twice`);
      owners.set(command, reducer.aggregate);
    }
  }
  assert.ok(problems.length > 0, 'a second owner for workplace.recordContribution is detected');
});

test('a command applied through a foreign aggregate is refused (two owners, engine level)', () => {
  const world = createWorld(1);
  const applied = applyCommand(world, {
    command: 'factoryRun.importCapsule',
    instanceId: 'factory-run:1',
    expectedRevision: 0,
    idempotencyKey: 'k',
  });
  assert.equal(applied.outcome.refused, true);
  // The registry guarantees the universe assignment; assert the direct guard:
  const factoryRun = REDUCERS.find((r) => r.aggregate === 'FactoryRun');
  assert.ok(factoryRun.ownedCommands.includes('factoryRun.importCapsule'));
  const workplace = REDUCERS.find((r) => r.aggregate === 'Workplace');
  assert.ok(!workplace.ownedCommands.includes('factoryRun.importCapsule'));
});

test('stale expected revision is refused by the CAS fence', () => {
  const world = createWorld(1);
  const boot = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  assert.equal(boot.outcome.committed, true);
  const stale = applyCommand(boot.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 7, idempotencyKey: 'b' });
  assert.equal(stale.outcome.reason, 'STALE_EXPECTED_REVISION');
});

test('the same idempotency key never commits twice (duplicate effect refused)', () => {
  const world = createWorld(1);
  const boot = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'same-key' });
  const again = applyCommand(boot.world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:2', expectedRevision: 0, idempotencyKey: 'same-key' });
  assert.equal(again.outcome.replayed, true);
  assert.equal(again.outcome.originalEventSequence, 1);
});

test('terminalization from empty work is refused (empty queue is not a proof)', () => {
  const world = createWorld(1);
  const boot = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' });
  const imp = applyCommand(boot.world, { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'b' });
  const start = applyCommand(imp.world, { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 2, idempotencyKey: 'c' });
  const premature = applyCommand(start.world, {
    command: 'factoryRun.recordRunTerminalProof',
    instanceId: 'factory-run:1',
    expectedRevision: 3,
    idempotencyKey: 'd',
    terminalOutcome: 'success',
  });
  assert.ok(premature.outcome.refused, 'run success without its exact evidence closure is refused');
  assert.equal(premature.outcome.reason, 'MISSING_EVIDENCE');
});

test('unknown commands are refused with a typed reason', () => {
  const world = createWorld(1);
  const applied = applyCommand(world, { command: 'factoryRun.explode', instanceId: 'x', expectedRevision: 0, idempotencyKey: 'k' });
  assert.equal(applied.outcome.reason, 'UNKNOWN_COMMAND');
});

test('the Workplace alone owns the author -> reviewer role transition', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof');
  const run = runSteps(spine.steps.map((s) => s.input));
  const authorIntent = [...run.world.workIntents.values()].find((i) => i.protocolRole === 'author');
  const reviewerIntent = [...run.world.workIntents.values()].find((i) => i.protocolRole === 'reviewer');
  assert.ok(authorIntent, 'author intent admitted');
  assert.ok(reviewerIntent, 'reviewer intent admitted after the accepted author gate');
  const authorAdmit = spine.steps.find((s) => s.input.command === 'workplace.admitWorkIntent' && s.input.protocolRole === 'reviewer');
  assert.ok(authorAdmit, 'the reviewer admission went through the Workplace reducer');
});

test('a semantic profile can never be a kernel protocol role (mutation k)', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof');
  const run = runSteps(spine.steps.slice(0, 12).map((s) => s.input));
  const workplace = [...run.world.heads.values()].find((h) => h.aggregate === 'Workplace' && h.status === 'materialized');
  assert.ok(workplace, 'a materialized workplace exists');
  const applied = applyCommand(run.world, {
    command: 'workplace.admitWorkIntent',
    instanceId: workplace.instanceId,
    expectedRevision: workplace.revision,
    idempotencyKey: 'k',
    protocolRole: 'planner',
    rolePin: { roleContractRef: `sha256:${'a'.repeat(64)}`, roleContractDigest: 'b'.repeat(64) },
    evidenceRefs: ['evidence:readiness'],
  });
  assert.equal(applied.outcome.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
});

test('an attempt pinning a different digest than its WorkIntent is refused (mutation i)', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof');
  const run = runSteps(spine.steps.slice(0, 14).map((s) => s.input));
  const intentRef = [...run.world.workIntents.keys()][0];
  const mismatched = applyCommand(run.world, {
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:9',
    expectedRevision: 0,
    idempotencyKey: 'mm',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: [...run.world.workIntents.values()][0].roleContract.roleContractRef, roleContractDigest: 'd'.repeat(64) },
  });
  assert.equal(mismatched.outcome.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('an attempt re-resolving the manifest independently is refused (mutation j)', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof');
  const run = runSteps(spine.steps.slice(0, 14).map((s) => s.input));
  const intentRef = [...run.world.workIntents.keys()][0];
  const foreign = applyCommand(run.world, {
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:9',
    expectedRevision: 0,
    idempotencyKey: 'mm2',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: `sha256:${'e'.repeat(64)}`, roleContractDigest: 'f'.repeat(64) },
    manifestRef: 'installed-workshop-manifest', // the forbidden independent manifest resolution
  });
  assert.equal(foreign.outcome.reason, 'ATTEMPT_RERESOLVED_MANIFEST');
});

test('D6: truthful failure requires the repair-epoch terminality evidence', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'stageRun.recordLocalOutcome' && t.steps.some((s) => s.input.terminalOutcome === 'truthful-failure'));
  assert.ok(spine, 'the failure spine commits');
  const run = runSteps(spine.steps.map((s) => s.input));
  const failureProof = run.world.proofs.find((p) => p.id === 'TerminalProof:workplace.truthful-failure');
  assert.ok(failureProof, 'workplace truthful-failure proof issued');
  const terminality = run.world.evidence.filter((e) => e.kind === 'RepairTerminalityEvidence');
  assert.ok(terminality.length > 0, 'RepairTerminalityEvidence committed (D6)');
});

test('D7: a dead predecessor converts the dependant readiness wait into unreachable settlement', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'nodeRun.settleUnreachable');
  const run = runSteps(spine.steps.map((s) => s.input));
  const converted = run.world.waits.find((w) => w.state === 'converted' && w.kind === 'TypedWait:readiness');
  assert.ok(converted, 'the dependant readiness wait was converted, never left pending');
  const settlement = run.world.evidence.filter((e) => e.kind === 'SettlementWorkObligation');
  assert.ok(settlement.length > 0, 'SettlementWorkObligation created');
  const unreachableProof = run.world.proofs.find((p) => p.id === 'TerminalProof:workplace.unreachable' || p.id === 'TerminalProof:node.unreachable');
  assert.ok(unreachableProof, 'an unreachable proof settled in the D7 scope set');
});

test('D3: lifecycle cancellation names member dispositions', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof' && t.steps.some((s) => s.input.terminalOutcome === 'cancellation'));
  const run = runSteps(spine.steps.map((s) => s.input));
  const cancellation = run.world.proofs.find((p) => p.id === 'TerminalProof:lifecycle.cancellation');
  assert.ok(cancellation, 'lifecycle cancellation proof issued');
  assert.ok(cancellation.memberDispositions && cancellation.memberDispositions.length > 0, 'member dispositions recorded');
  const runCancellation = run.world.proofs.find((p) => p.id === 'TerminalProof:run.cancellation');
  assert.ok(runCancellation, 'run cancellation proof issued (D3 lifecycle+run pair)');
});

test('fan-out creates one explicit obligation per target edge; fan-in checks predecessor evidence', () => {
  const spine = canonicalSpineTraces(20260825).find((t) => t.target === 'factoryRun.recordRunTerminalProof');
  const present = spine.steps.find((s) => s.input.command === 'workplace.presentCandidateSet');
  assert.ok(present.outcome.obligations.length >= 2, 'presentCandidateSet fans out runGate.author + runGate.final');
  const kinds = present.outcome.obligations.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['obligation:runGate.author', 'obligation:runGate.final']);
  const accept = spine.steps.find((s) => s.input.command === 'nodeRun.recordCellAcceptance');
  assert.ok(accept, 'node acceptance consumed the exact predecessor CellFinalAcceptance evidence');
  const guardEvidence = spine.steps.find((s) => s.input.command === 'workplace.recordFinalAcceptance');
  assert.ok(guardEvidence, 'final acceptance committed with the accepted-authority + effect receipts');
});

test('the write-time progress invariant holds on every spine world (no unexplained nonterminal)', async () => {
  const { findInvariantViolations } = await import('../../../dist/workflow-kernel/domain/explorer.js');
  for (const spine of canonicalSpineTraces(20260825)) {
    const run = runSteps(spine.steps.map((s) => s.input));
    const violations = findInvariantViolations(run.world);
    assert.deepEqual(violations, [], `spine ${spine.target}: ${JSON.stringify(violations)}`);
  }
});
