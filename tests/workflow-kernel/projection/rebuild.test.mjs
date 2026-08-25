/**
 * rebuild.test.mjs - WP-10: full projection REBUILD from canonical facts.
 *
 * Any card state is reconstructable from the event/evidence ledger through
 * the repositories' read surfaces: from an empty store, from a reopened
 * database session (fresh page, no in-memory state), and incrementally at
 * every stage of a run - always identical to the live projection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { conveyor, freshProjection, observingOptions } from './support.mjs';

const { refreshProjection, rebuildProjection } = await import('../../../dist/workflow-kernel/projection/projector.js');

test('rebuild from an empty store equals the live projection at every stage of the run', async () => {
  const { open } = freshProjection('ek-wp10-rebuild-stages-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);

  const assertRebuildEqualsLive = () => {
    refreshProjection(session, store);
    const live = store.all();
    store.deleteAll();
    assert.ok(store.isVacant());
    const written = rebuildProjection(session, store);
    assert.equal(written, live.length, 'the rebuild writes exactly the live card count');
    assert.deepEqual(store.all(), live, 'the rebuilt board is identical to the live board');
  };

  // Stage 1: planned only (todo board).
  assertRebuildEqualsLive();

  // Stage 2: first cell entered (one in-progress card).
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  assertRebuildEqualsLive();

  // Stage 3: intent admitted + one cognition attempt (pins and receipts on the card).
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellA.workplace, 'author', options.authorPin, options);
  assertRebuildEqualsLive();

  // Stage 4: the full run to terminal proofs.
  conveyor.runDesk(session, cellA, 'success', options);
  conveyor.settleCellNode(session, ids, cellA, options);
  const cellB = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[1], options);
  conveyor.admitCellIntent(session, cellB, conveyor.dependencyRowsOf(session), options);
  conveyor.runDesk(session, cellB, 'success', options);
  conveyor.settleCellNode(session, ids, cellB, options);
  conveyor.settleSuccessLadder(session, ids, options);
  assertRebuildEqualsLive();
  session.close();
});

test('a REOPENED session (fresh page, no memory) reconstructs the identical board from durable facts', async () => {
  const db = freshProjection('ek-wp10-rebuild-reopen-');
  const options = observingOptions();

  // Session one: drive work and project.
  const first = db.open();
  const ids = conveyor.bootstrapVertical(first.session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(first.session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(first.session, cellA, conveyor.dependencyRowsOf(first.session), options);
  conveyor.runAttempt(first.session, cellA.workplace, 'author', options.authorPin, options);
  refreshProjection(first.session, first.store);
  const before = first.store.all();
  first.session.close();

  // Session two: a brand-new store over the reopened database rebuilds.
  const second = db.open();
  const rebuilt = rebuildProjection(second.session, second.store);
  assert.equal(rebuilt, before.length);
  assert.deepEqual(second.store.all(), before, 'the reopened-page board is identical to the closed-page board');
  second.session.close();
});

test('a projection-only database write never touches canonical tables (board writes are confined to kanban_card)', async () => {
  const { open } = freshProjection('ek-wp10-rebuild-confinement-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const beforeCounts = session.counts();

  refreshProjection(session, store);
  store.deleteAll();
  rebuildProjection(session, store);
  store.deleteAll();

  const afterCounts = session.counts();
  assert.deepEqual(afterCounts, beforeCounts, 'projection writes/deletes leave the shared ledger untouched');
  assert.equal(store.count(), 0);
  session.close();
});
