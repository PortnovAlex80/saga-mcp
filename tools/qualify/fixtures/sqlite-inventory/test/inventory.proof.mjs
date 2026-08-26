/**
 * sqlite-inventory/test/inventory.test.mjs - unit verification (node:test):
 * real SQLite CRUD, constraint refusals, cross-connection durability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openInventory } from '../src/inventory.mjs';

test('sqlite CRUD works with ordered listing and typed refusals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-inventory-test-'));
  try {
    const inventory = openInventory(join(dir, 'inventory.sqlite'));
    assert.equal(inventory.add('AAA-001', 'bolts', 100) > 0, true);
    inventory.add('ZZZ-009', 'washers', 5);
    assert.deepEqual(inventory.list().map((item) => item.sku), ['AAA-001', 'ZZZ-009']);
    assert.deepEqual(inventory.adjust('ZZZ-009', -2), { quantity: 3 });
    assert.deepEqual(inventory.adjust('ZZZ-009', -10), { refused: 'negative-quantity' });
    assert.equal(inventory.remove('AAA-001'), true);
    inventory.close();
    /* durability: a NEW connection sees the same committed state. */
    const reopened = openInventory(join(dir, 'inventory.sqlite'));
    assert.deepEqual(reopened.list().map((item) => ({ ...item })), [{ id: 2, sku: 'ZZZ-009', name: 'washers', quantity: 3 }]);
    reopened.close();
  } finally {
    /* Windows: sqlite journal handles can outlive close(); cleanup is
       best-effort - the assertions above carry the test's signal. */
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  }
});
