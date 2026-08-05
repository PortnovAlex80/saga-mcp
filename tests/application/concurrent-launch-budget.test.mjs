/**
 * ConcurrentLaunchBudget tests (Conveyor v4, step 2.5).
 *
 * Target contract: REG-10-AC-05 (single global concurrency budget).
 *
 * Covers:
 *   - capacity enforcement (at most N concurrent slots).
 *   - acquire returns immediately when slots are free.
 *   - acquire blocks when full, unblocks on release (FIFO).
 *   - available/inUse reporting.
 *   - double-release rejected.
 *   - negative/zero capacity rejected at construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConcurrentLaunchBudget } from '../../dist/application/concurrent-launch-budget.js';

test('REG-10-AC-05: capacity=N allows N immediate acquires', async () => {
  const budget = new ConcurrentLaunchBudget(3);
  await budget.acquire();
  await budget.acquire();
  await budget.acquire();
  assert.equal(budget.inUse(), 3);
  assert.equal(budget.available(), 0);
  budget.release();
  budget.release();
  budget.release();
  assert.equal(budget.inUse(), 0);
});

test('REG-10-AC-05: acquire blocks when full, unblocks on release', async () => {
  const budget = new ConcurrentLaunchBudget(1);
  await budget.acquire(); // fills the only slot
  let unblocked = false;
  const pending = budget.acquire().then(() => { unblocked = true; });
  // Not yet unblocked (release has not happened).
  assert.equal(unblocked, false);
  budget.release();
  await pending;
  assert.equal(unblocked, true);
  assert.equal(budget.inUse(), 1);
  budget.release();
});

test('REG-10-AC-05: FIFO waiter order', async () => {
  const budget = new ConcurrentLaunchBudget(1);
  await budget.acquire();
  const order = [];
  const w1 = budget.acquire().then(() => order.push(1));
  const w2 = budget.acquire().then(() => order.push(2));
  const w3 = budget.acquire().then(() => order.push(3));
  // Free one slot at a time — each release unblocks the next FIFO waiter.
  budget.release();
  await new Promise(r => setImmediate(r));
  budget.release();
  await new Promise(r => setImmediate(r));
  budget.release();
  await Promise.all([w1, w2, w3]);
  // Waiters served in the order they arrived.
  assert.deepEqual(order, [1, 2, 3]);
  // After all three waiters resolved + the original slot, active = 1 (the
  // last waiter holds the slot). One release cleans up.
  budget.release();
});

test('REG-10: available/inUse reporting', async () => {
  const budget = new ConcurrentLaunchBudget(5);
  assert.equal(budget.available(), 5);
  assert.equal(budget.inUse(), 0);
  await budget.acquire();
  await budget.acquire();
  assert.equal(budget.available(), 3);
  assert.equal(budget.inUse(), 2);
  budget.release();
  assert.equal(budget.available(), 4);
  assert.equal(budget.inUse(), 1);
  budget.release();
});

test('REG-10: double-release rejected', async () => {
  const budget = new ConcurrentLaunchBudget(1);
  await budget.acquire();
  budget.release();
  assert.throws(() => budget.release(), /double release/);
});

test('REG-10: zero/negative capacity rejected at construction', () => {
  assert.throws(() => new ConcurrentLaunchBudget(0), /positive integer/);
  assert.throws(() => new ConcurrentLaunchBudget(-1), /positive integer/);
  assert.throws(() => new ConcurrentLaunchBudget(1.5), /positive integer/);
});

test('REG-10: cap getter exposes the configured capacity', () => {
  const budget = new ConcurrentLaunchBudget(7);
  assert.equal(budget.cap, 7);
});
