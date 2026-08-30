// The Kanban board is a PROJECTION: every column is derived from the event
// log, dynamic fan-out becomes one card per spawned child, and the only board
// write is the operator decision at a human gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-board-projection-'));
process.env.DB_PATH = path.join(dir, 'board.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { board, operatorQueue } = await import('../dist/kernel/board.js');
const { projectRun } = await import('../dist/kernel/projection.js');
const { resolveHumanGate } = await import('../dist/operator.js');

const db = getDb();

const cardsOf = (data) => data.columns.flatMap((column) => column.cards);
const cardFor = (data, nodeId) => cardsOf(data).find((card) => card.node_id === nodeId);

test('a finished run paints every node into the done column', () => {
  const run = runGraph(db, JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text: 'идея' } }] } },
      shape: { type: 'template', parameters: { template: 'бриф: {{text}}' } },
    },
    connections: { source: { main: [[{ node: 'shape' }]] } },
  }), { name: 'board-happy' });
  assert.equal(run.status, 'success');

  const data = board(db, { run_id: run.runId });
  assert.equal(cardsOf(data).length, 2, 'one card per node');
  assert.equal(cardFor(data, 'shape').status, 'done');
  assert.equal(cardFor(data, 'shape').materials, 1);
  assert.equal(data.totals.done, 2);
});

test('dynamic fan-out becomes one card per spawned child, titled from its item', () => {
  const run = runGraph(db, JSON.stringify({
    nodes: {
      plan: {
        type: 'emit',
        parameters: {
          items: [
            { json: { title: 'T1 вёрстка', text: 'a' } },
            { json: { title: 'T2 стили', text: 'b' } },
          ],
        },
      },
      tasks: {
        type: 'split',
        parameters: { child: { type: 'template', parameters: { template: 'готово {{title}}' } } },
      },
      merge: { type: 'join', parameters: {} },
    },
    connections: {
      plan: { main: [[{ node: 'tasks' }]] },
      tasks: { main: [[{ node: 'merge' }]] },
    },
  }), { name: 'board-fanout' });
  assert.equal(run.status, 'success');

  const data = board(db, { run_id: run.runId });
  const children = cardsOf(data).filter((card) => card.parent === 'tasks');
  assert.equal(children.length, 2, 'each spawned worker is its own card');
  assert.deepEqual(children.map((card) => card.title).sort(), ['T1 вёрстка', 'T2 стили']);
  assert.ok(children.every((card) => card.status === 'done'));
});

test('a human gate is a blocked card carrying its reasons and the only allowed action', () => {
  const run = runGraph(db, JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text: 'без маркера' } }] } },
      quality: {
        type: 'gate',
        parameters: {
          checks: [{ op: 'contains', field: 'text', value: 'МАРКЕР' }],
          max_repairs: 0,
          repair_target: 'source',
          title: 'Приёмка брифа',
        },
      },
    },
    connections: { source: { main: [[{ node: 'quality' }]] } },
  }), { name: 'board-blocked' });
  assert.equal(run.stop, 'waiting');

  const data = board(db, { run_id: run.runId });
  const gate = cardFor(data, 'quality');
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.title, 'Приёмка брифа', 'the gate declaration names its card');
  assert.equal(gate.action, 'operator_decision', 'the ONE write a card may carry');
  assert.match(gate.reasons.join(' '), /МАРКЕР/);

  assert.ok(operatorQueue(db).some((card) => card.run_id === run.runId));

  // The decision is an ordinary event; the column follows the kernel, not the UI.
  resolveHumanGate(db, run.runId, 'quality', 'reject', 'не подходит');
  assert.equal(resumeRun(db, run.runId).status, 'error');
  assert.equal(cardFor(board(db, { run_id: run.runId }), 'quality').status, 'failed');
});

test('the projection never invents a column: every card status comes from the log', () => {
  const runs = db.prepare('SELECT id FROM runs').all();
  const allowed = new Set(['todo', 'in_progress', 'review', 'blocked', 'done', 'failed']);
  for (const { id } of runs) {
    for (const node of projectRun(db, id).nodes) {
      assert.ok(allowed.has(node.status), `unknown status ${node.status}`);
    }
  }
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
