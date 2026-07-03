// Unit tests for applyImpactCascade (SRS-004 §2b.5, AC-9).
//
// Pure unit test — no database. Verifies the postcondition
//   ∀ task, ∀ pid ∈ affectedProjectIds: 'impact:'+pid ∈ task.tags
// plus idempotency, preservation of existing tags, non-mutation of input, and
// defensive normalisation of the pid list. Run against the compiled JS in dist/.
//
// Usage:  node --test tests/planner-ac9/cascade.test.mjs
import { applyImpactCascade } from '../../dist/planner/cascade.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const mkTask = (id, tags = []) => ({ id, tags, title: `t${id}` });

test('stamps impact:<pid> on every task for each affected project', () => {
  const out = applyImpactCascade([mkTask(1), mkTask(2)], [7, 8]);
  assert.deepEqual(out[0].tags, ['impact:7', 'impact:8']);
  assert.deepEqual(out[1].tags, ['impact:7', 'impact:8']);
});

test('postcondition holds: ∀ task ∀ pid → impact:pid present', () => {
  const pids = [1, 2, 3];
  const tasks = [mkTask(10, ['role:worker']), mkTask(11), mkTask(12, ['impact:1'])];
  const out = applyImpactCascade(tasks, pids);
  for (const t of out) {
    for (const pid of pids) {
      assert.ok(t.tags.includes(`impact:${pid}`), `task ${t.id} missing impact:${pid}`);
    }
  }
});

test('preserves existing (non-impact) tags in order', () => {
  const out = applyImpactCascade([mkTask(1, ['role:worker', 'ac-9'])], [5]);
  assert.deepEqual(out[0].tags, ['role:worker', 'ac-9', 'impact:5']);
});

test('idempotent: already-stamped impact tag is not duplicated', () => {
  const out = applyImpactCascade([mkTask(1, ['impact:7', 'impact:8'])], [7, 8]);
  assert.deepEqual(out[0].tags, ['impact:7', 'impact:8']);
});

test('idempotent across repeated calls (cascade of cascade)', () => {
  const once = applyImpactCascade([mkTask(1)], [9]);
  const twice = applyImpactCascade(once, [9]);
  assert.deepEqual(twice[0].tags, ['impact:9']);
});

test('does NOT mutate input task objects or their tags arrays', () => {
  const task = mkTask(1, ['role:worker']);
  const snapshot = task.tags.slice();
  applyImpactCascade([task], [3]);
  // input task untouched
  assert.deepEqual(task.tags, snapshot);
  assert.equal(task.tags.length, 1);
});

test('returns new array (input array identity not reused)', () => {
  const tasks = [mkTask(1)];
  const out = applyImpactCascade(tasks, [1]);
  assert.notEqual(out, tasks);
  assert.notEqual(out[0], tasks[0]);
});

test('dedupes the affected-project list (order-preserving)', () => {
  const out = applyImpactCascade([mkTask(1)], [7, 7, 8, 7]);
  assert.deepEqual(out[0].tags, ['impact:7', 'impact:8']);
});

test('drops non-number / NaN pids defensively', () => {
  const out = applyImpactCascade([mkTask(1)], [7, 'x', NaN, 8, null, undefined, 9]);
  assert.deepEqual(out[0].tags, ['impact:7', 'impact:8', 'impact:9']);
});

test('empty affected-project list → tags unchanged (still a new array)', () => {
  const out = applyImpactCascade([mkTask(1, ['a'])], []);
  assert.deepEqual(out[0].tags, ['a']);
});

test('empty tasks list → empty result', () => {
  assert.deepEqual(applyImpactCascade([], [1, 2]), []);
});

test('task missing tags field is handled (treated as [])', () => {
  const out = applyImpactCascade([{ id: 1 }, { id: 2, tags: null }], [4]);
  assert.deepEqual(out[0].tags, ['impact:4']);
  assert.deepEqual(out[1].tags, ['impact:4']);
});
