import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { migrateFactorySchemaV3ToV4 } = await import('../../dist/schema.js');

test('v3 to v4 migration preserves Workplace rows and adds effect_pending atomically', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_workplaces (
      workplace_ref TEXT PRIMARY KEY,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      production_cell_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      kanban_phase TEXT NOT NULL CHECK (kanban_phase IN ('todo','in_progress','review','review_in_progress','blocked','done','failed','cancelled')),
      loop_state TEXT NOT NULL CHECK (loop_state IN ('idle','queued','leased','running','verifying','repair_wait','paused','terminal')),
      next_role TEXT NOT NULL CHECK (next_role IN ('author','reviewer')),
      terminal_reason TEXT CHECK (terminal_reason IN ('accepted','failed','cancelled') OR terminal_reason IS NULL),
      revision INTEGER NOT NULL DEFAULT 0,
      active_reservation_ref TEXT,
      active_gate_ref TEXT,
      active_recovery_case_ref TEXT,
      desk_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO factory_workplaces VALUES
      ('workplace/1/test@1/cell/key',1,'test@1','cell','key','todo','idle','author',NULL,4,NULL,NULL,NULL,'desk:1','2026-01-01','2026-01-02');
    PRAGMA user_version=3;
  `);

  const before = db.prepare('SELECT * FROM factory_workplaces').get();
  migrateFactorySchemaV3ToV4(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.deepEqual(db.prepare('SELECT * FROM factory_workplaces').get(), before);
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='factory_workplaces'").get().sql,
    /effect_pending/,
  );
  db.prepare(
    "UPDATE factory_workplaces SET loop_state='effect_pending' WHERE workplace_ref=?",
  ).run(before.workplace_ref);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  migrateFactorySchemaV3ToV4(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  db.close();
});
