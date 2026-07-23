import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/dispatcher.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-binding-'));
  process.env.DB_PATH = path.join(temp, 'db.sqlite');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  return { temp, db };
}
function cleanup(temp) { closeDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.DB_PATH; }

test('claim rejects Saga 3 task whose WorkIntent binding is missing and rolls back task claim', () => {
  const { temp, db } = fixture();
  try {
    db.prepare(`INSERT INTO tasks
      (id,epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,execution_mode,generation_key,tags,metadata)
      VALUES (100,10,'D','todo','high','discovery.work','discovery','saga-discovery-worker','tracker_only','g','[]',?)`)
      .run(JSON.stringify({ work_intent_id: 999 }));
    assert.throws(() => handlers.worker_next({
      worker_id: 'w', project_id: 1, epic_id: 10, machine_id: 'm', execution_id: 'exec-bad', run_id: 'r', task_ids: [100],
    }), /AUTHORITY_BINDING_INVALID/);
    const task = db.prepare('SELECT status,assigned_to,current_execution_id FROM tasks WHERE id=100').get();
    assert.deepEqual(task, { status: 'todo', assigned_to: null, current_execution_id: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worker_executions').get().n, 0);
  } finally { cleanup(temp); }
});
