/**
 * served-crud/test/crud.test.mjs - unit verification (node:test, zero
 * dependencies): store CRUD semantics + write validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store.mjs';
import { validateItem } from '../src/server.mjs';

test('the store creates, updates, deletes with monotonic ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'served-crud-test-'));
  try {
    const store = createStore(join(dir, 'items.json'));
    const a = store.create({ title: 'a', done: false });
    const b = store.create({ title: 'b', done: true });
    assert.deepEqual([a.id, b.id], [1, 2]);
    assert.equal(store.update(b.id, { done: false }).done, false);
    assert.equal(store.remove(a.id), true);
    assert.deepEqual(store.list().map((item) => item.title), ['b']);
    const persisted = JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8'));
    assert.deepEqual(persisted.items.map((item) => item.id), [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the write surface rejects empty and oversized titles', () => {
  assert.equal(validateItem({ title: 'ok' }).valid, true);
  assert.equal(validateItem({ title: '  ' }).valid, false);
  assert.equal(validateItem({ title: 'x'.repeat(201) }).valid, false);
  assert.equal(validateItem({ title: 'ok', done: 'yes' }).valid, false);
});
