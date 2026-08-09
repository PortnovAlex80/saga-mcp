import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p1'),(2,'p2')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e1'),(2,1,'e2'),(3,2,'e3')").run();
  return db;
}

const insert = (db, id, projectId, epicId, parentId = null) => db.prepare(
  `INSERT INTO artifacts
     (id,project_id,epic_id,type,title,path,parent_artifact_id)
   VALUES (?,?,?,'PRD',?,?,?)`,
).run(id, projectId, epicId, `artifact-${id}`, `docs/${id}.md`, parentId);

test('artifact hierarchy rejects a fresh self-parent that SQLite FK would allow', () => {
  const db = fixture();
  assert.throws(
    () => insert(db, 1, 1, 1, 1),
    /artifact parent must be an existing artifact in the same project and epic/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0);
  db.close();
});

test('artifact hierarchy stays within one project and episode', () => {
  const db = fixture();
  insert(db, 1, 1, 1);
  assert.throws(() => insert(db, 2, 1, 2, 1), /same project and epic/);
  assert.throws(() => insert(db, 3, 2, 3, 1), /same project and epic/);
  db.close();
});

test('artifact hierarchy rejects update cycles and accepts a normal forest', () => {
  const db = fixture();
  insert(db, 1, 1, 1);
  insert(db, 2, 1, 1, 1);
  insert(db, 3, 1, 1, 2);
  assert.throws(
    () => db.prepare('UPDATE artifacts SET parent_artifact_id=? WHERE id=?').run(3, 1),
    /artifact parent would create a cycle/,
  );
  assert.throws(
    () => db.prepare('UPDATE artifacts SET parent_artifact_id=id WHERE id=2').run(),
    /artifact cannot be its own parent/,
  );
  assert.deepEqual(
    db.prepare('SELECT id,parent_artifact_id FROM artifacts ORDER BY id').all(),
    [
      { id: 1, parent_artifact_id: null },
      { id: 2, parent_artifact_id: 1 },
      { id: 3, parent_artifact_id: 2 },
    ],
  );
  db.close();
});
