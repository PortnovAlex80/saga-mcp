/**
 * mutations.test.mjs - WP-10: the three MANDATORY EK-7 mutations, each
 * asserting the IDENTICAL normalized authoritative trace and terminal
 * proof against the live-projector baseline:
 *
 *   (a) delete all Kanban rows while work is running;
 *   (b) write false/stale Kanban rows while work is running;
 *   (c) stop the projector entirely, finish the work, then rebuild.
 *
 * The kernel's decisions are functions of canonical facts only, so no
 * board mutation can alter the committed trace; and the projection is a
 * pure function of those facts, so a full rebuild reconstructs the exact
 * final board in all three cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { conveyor, freshProjection, normalizedTrace, observingOptions, terminalProofs } from './support.mjs';

const { refreshProjection, rebuildProjection } = await import('../../../dist/workflow-kernel/projection/projector.js');

/** Drive the first cell to completion (mid-run), then the rest, with a hook between the phases. */
function driveRun(session, options, betweenPhases) {
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const descriptors = conveyor.cellsForTopology('independent');
  const cells = [];
  const cellA = conveyor.enterCell(session, descriptors[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runDesk(session, cellA, 'success', options);
  conveyor.settleCellNode(session, ids, cellA, options);
  cells.push(cellA);
  betweenPhases(session, ids);
  const cellB = conveyor.enterCell(session, descriptors[1], options);
  conveyor.admitCellIntent(session, cellB, conveyor.dependencyRowsOf(session), options);
  conveyor.runDesk(session, cellB, 'success', options);
  conveyor.settleCellNode(session, ids, cellB, options);
  cells.push(cellB);
  conveyor.settleSuccessLadder(session, ids, options);
  return { ids, cells };
}

test('baseline: the live projector board and the authoritative terminal state are captured', async () => {
  const baseline = await runBaseline();
  assert.ok(baseline.trace.length > 10, 'a substantive authoritative trace committed');
  assert.ok(baseline.proofs.some((proof) => proof.id === 'TerminalProof:run.success'), 'the run terminal proof committed');
  assert.equal(baseline.rows.length, 2);
  assert.ok(baseline.rows.every((row) => row.lane === 'terminal'));
});

test('mutation (a): deleting ALL Kanban rows while work is running leaves the trace, proofs and rebuilt board identical', async () => {
  const { open } = freshProjection('ek-wp10-mut-del-');
  const { session, store } = open();
  const options = observingOptions();

  const baseline = await runBaseline();
  let deletedMidRun = false;
  driveRun(session, options, (s) => {
    refreshProjection(s, store);
    assert.equal(store.count(), 2, 'the board is live before the deletion');
    store.deleteAll();
    deletedMidRun = store.isVacant();
    // Work keeps running with a vacant board: the next phase drives on.
  });
  assert.ok(deletedMidRun, 'all Kanban rows were deleted mid-run');

  // The authoritative trace and terminal proof are IDENTICAL to baseline.
  assert.deepEqual(normalizedTrace(session), baseline.trace);
  assert.deepEqual(terminalProofs(session), baseline.proofs);

  // Full rebuild reconstructs the exact final board.
  const written = rebuildProjection(session, store);
  assert.equal(written, 2);
  assert.deepEqual(store.all(), baseline.rows);
  session.close();
});

test('mutation (b): FALSE and STALE Kanban rows written mid-run change nothing and are replaced by the rebuild', async () => {
  const { open } = freshProjection('ek-wp10-mut-false-');
  const { session, store } = open();
  const options = observingOptions();

  const baseline = await runBaseline();
  driveRun(session, options, (s) => {
    refreshProjection(s, store);
    // False rows: forged lanes, a fabricated card for a nonexistent item,
    // stale sequences - written by raw SQL exactly as a corrupt writer would.
    s.db
      .prepare('UPDATE kanban_card SET lane = ?, payload_json = ?, projected_sequence = ? WHERE card_id = ?')
      .run('terminal', JSON.stringify({ forged: true, lie: 'this card is done' }), 1, 'card:a');
    s.db
      .prepare('INSERT INTO kanban_card (card_id, work_item_ref, lane, payload_json, projected_sequence) VALUES (?, ?, ?, ?, ?)')
      .run('card:ghost', 'ghost', 'in-progress', JSON.stringify({ forged: true }), 0);
    // A stale row: the real card b projected at an old sequence with an old lane.
    s.db
      .prepare('UPDATE kanban_card SET lane = ?, projected_sequence = ? WHERE card_id = ?')
      .run('todo', 1, 'card:b');
  });

  // The forged rows are really there and really false.
  const forged = store.all();
  assert.equal(forged.length, 3, 'the forged board holds a ghost card');
  assert.equal(store.byCardId('card:a').lane, 'terminal');
  assert.equal(store.byCardId('card:ghost').lane, 'in-progress');
  assert.ok(store.staleRows(session.hydrateWorld().world.sequence).length >= 1, 'stale rows are detectable for diagnosis');

  // The authoritative trace and terminal proof are IDENTICAL to baseline.
  assert.deepEqual(normalizedTrace(session), baseline.trace);
  assert.deepEqual(terminalProofs(session), baseline.proofs);

  // Full rebuild replaces every false/stale row with the derived truth.
  const written = rebuildProjection(session, store);
  assert.equal(written, 2);
  assert.deepEqual(store.all(), baseline.rows);
  assert.equal(store.byCardId('card:ghost'), undefined, 'the fabricated card is gone');
  session.close();
});

test('mutation (c): projector STOPPED for the whole run - finishing the work and rebuilding yields the identical board', async () => {
  const { open } = freshProjection('ek-wp10-mut-stop-');
  const { session, store } = open();
  const options = observingOptions();

  const baseline = await runBaseline();
  driveRun(session, options, () => {
    /* the projector is stopped: no projection at any phase */
  });
  assert.ok(store.isVacant(), 'the board stayed empty for the whole run');

  // The authoritative trace and terminal proof are IDENTICAL to baseline.
  assert.deepEqual(normalizedTrace(session), baseline.trace);
  assert.deepEqual(terminalProofs(session), baseline.proofs);

  // A late full rebuild reconstructs the complete final board from facts.
  const written = rebuildProjection(session, store);
  assert.equal(written, 2);
  assert.deepEqual(store.all(), baseline.rows);
  session.close();
});

/** The shared baseline (computed once; identical conveyor keys make every run byte-identical). */
let cachedBaseline;
async function runBaseline() {
  if (cachedBaseline === undefined) {
    const { open } = freshProjection('ek-wp10-mut-base-cache-');
    const { session, store } = open();
    const options = observingOptions();
    driveRun(session, options, (s) => refreshProjection(s, store));
    refreshProjection(session, store);
    cachedBaseline = { trace: normalizedTrace(session), proofs: terminalProofs(session), rows: store.all().map((row) => ({ ...row })) };
    session.close();
  }
  return cachedBaseline;
}
