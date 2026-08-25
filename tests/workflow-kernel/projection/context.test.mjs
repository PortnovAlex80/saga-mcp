/**
 * context.test.mjs - WP-10: tools and hooks receive EXACT context from
 * authoritative commands, never by reverse-reading the board.
 *
 * The context builder is fed only a target command (+optional instance);
 * everything it returns - obligation kind, evidence refs, expected
 * revision, pinned contract, receipt references - comes from the hydrated
 * ledger and the owning repositories' readers. Forging the board between
 * two calls cannot change the returned context.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { conveyor, freshProjection, observingOptions } from './support.mjs';

const { toolContextForCommand, hookAdditionalContextForCommand } = await import('../../../dist/workflow-kernel/projection/context.js');
const { refreshProjection } = await import('../../../dist/workflow-kernel/projection/projector.js');

test('the tool context of a claim lane names the exact obligation, evidence refs and pinned contract', async () => {
  const { open } = freshProjection('ek-wp10-ctx-claim-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellA.workplace, 'author', options.authorPin, options);
  refreshProjection(session, store);

  // The frontier lane of the author desk: contribution (a cross-aggregate
  // lane the caller pins to the workplace - the context names the exact row).
  const context = toolContextForCommand(session, 'workplace.recordContribution', { instanceId: cellA.workplace });
  assert.equal(context.command, 'workplace.recordContribution');
  assert.ok(context.obligation !== null, 'the exact frontier obligation is named');
  assert.equal(context.obligation.kind, 'obligation:submitContribution');
  assert.equal(context.targetInstanceId, cellA.workplace);

  // The hook variant is a bounded, JSON-serializable additionalContext object.
  const hook = hookAdditionalContextForCommand(session, 'workplace.recordContribution', { instanceId: cellA.workplace });
  assert.equal(hook.kind, 'ek-hook-context');
  assert.equal(hook.obligationKind, 'obligation:submitContribution');
  assert.deepEqual(JSON.parse(JSON.stringify(hook)), hook, 'the hook context is plain JSON');

  // A pinned attempt context carries the WP-17 pin and WP-18 receipt refs.
  const attemptContext = toolContextForCommand(session, 'activityAttempt.recordOutcome', { instanceId: attemptOf(session, cellA.workplace) });
  assert.ok(attemptContext.pinnedRoleContract !== null, 'the pinned contract is displayed');
  assert.equal(attemptContext.pinnedRoleContract.roleContractDigest, options.authorPin.roleContractDigest);
  assert.ok(attemptContext.promptReceiptRefs.length >= 1, 'the committed prompt receipts are referenced');
  session.close();
});

test('forging the whole board cannot alter the tool context (commands are the only source)', async () => {
  const { open } = freshProjection('ek-wp10-ctx-forge-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  refreshProjection(session, store);

  const before = toolContextForCommand(session, 'workplace.recordContribution', { instanceId: cellA.workplace });

  // Forge the board: every row a lie.
  session.db
    .prepare('UPDATE kanban_card SET lane = ?, payload_json = ?, projected_sequence = ?')
    .run('terminal', JSON.stringify({ forged: true }), 0);

  const after = toolContextForCommand(session, 'workplace.recordContribution', { instanceId: cellA.workplace });
  assert.deepEqual(after, before, 'the tool context is byte-identical with a fully forged board');
  assert.equal(after.targetInstanceId, cellA.workplace, 'the target instance still resolves from durable facts');
  session.close();
});

test('an empty-but-honest context is returned when no lane and no instance exist', async () => {
  const { open } = freshProjection('ek-wp10-ctx-empty-');
  const { session } = open();
  const options = observingOptions();
  conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);

  const context = toolContextForCommand(session, 'workplace.runFinalGate');
  assert.equal(context.obligation, null);
  assert.equal(context.targetInstanceId, '');
  assert.deepEqual(context.evidenceRefs, []);
  assert.equal(context.pinnedRoleContract, null);
  session.close();
});

/** The bound attempt of a workplace's author intent (durable pin join). */
function attemptOf(session, workplace) {
  const world = session.hydrateWorld().world;
  const intent = [...world.workIntents.values()].find((entry) => entry.workplaceInstanceId === workplace && entry.protocolRole === 'author');
  const attempt = [...world.heads.values()].find((head) => head.aggregate === 'ActivityAttempt' && session.activityAttempt.loadRoleContractPin(head.instanceId)?.workIntentRef === intent.intentRef);
  return attempt.instanceId;
}
