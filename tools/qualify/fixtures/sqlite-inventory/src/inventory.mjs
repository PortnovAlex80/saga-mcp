/**
 * sqlite-inventory/src/inventory.mjs - the SQLite inventory application's
 * storage engine (plan EK-11 P13): a real SQLite database via node:sqlite
 * (DatabaseSync, the node builtin - zero npm dependencies), with a fixed
 * schema and deterministic CRUD. The durability class of this product IS
 * SQLite: data survives process restarts by construction.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 'sqlite-inventory.v1';

export function openInventory(dbFile) {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS schema_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0)
    );
  `);
  db.prepare('INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)').run('schema', SCHEMA_VERSION);
  return {
    schemaVersion: () => db.prepare('SELECT value FROM schema_info WHERE key = ?').get('schema').value,
    add: (sku, name, quantity) => {
      const result = db.prepare('INSERT INTO items (sku, name, quantity) VALUES (?, ?, ?)').run(sku, name, quantity);
      return Number(result.lastInsertRowid);
    },
    list: () => db.prepare('SELECT id, sku, name, quantity FROM items ORDER BY sku').all(),
    get: (sku) => db.prepare('SELECT id, sku, name, quantity FROM items WHERE sku = ?').get(sku) ?? null,
    adjust: (sku, delta) => {
      const item = db.prepare('SELECT id, quantity FROM items WHERE sku = ?').get(sku);
      if (item === undefined) return null;
      const next = Number(item.quantity) + delta;
      if (next < 0) return { refused: 'negative-quantity' };
      db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(next, item.id);
      return { quantity: next };
    },
    remove: (sku) => db.prepare('DELETE FROM items WHERE sku = ?').run(sku).changes > 0,
    close: () => db.close(),
  };
}
