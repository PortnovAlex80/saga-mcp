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

// Wave 0A triage: the throw-based AUTHORITY_BINDING_INVALID check survives at
// 10 sites in src/lifecycle/work-assignment-core.ts (the narrower case: task
// HAS process_run_id + a broken work_intent_id). But this scenario — a task
// with work_intent_id:999 and NO process_run_id — is now caught EARLIER by the
// SQL-level authority gate `process_run_id IS NOT NULL` introduced in Phase 4
// (commit 1ce4514 refactor(workers): bind work execution exclusively to process
// node authority). findNextClaimable now returns null for any task lacking
// process_run_id, so worker_next returns { task: null } and NO exception is
// thrown. The equivalent regression test for the SQL gate itself lives at
// tests/architecture/work-assignment-contract.test.mjs:127-140
// ("assignTask returns null when the only card lacks process_run_id").
test('claim rejects task whose process_run_id authority binding is missing (returns null, no assignment)', () => {
  const { temp, db } = fixture();
  try {
    db.prepare(`INSERT INTO tasks
      (id,epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,execution_mode,generation_key,tags,metadata)
      VALUES (100,10,'D','todo','high','discovery.work','discovery','saga-discovery-worker','tracker_only','g','[]',?)`)
      .run(JSON.stringify({ work_intent_id: 999 }));
    // Wave 0A + commit 1ce4514: binding check relocated to SQL-level
    // process_run_id gate; the task lacks process_run_id so findNextClaimable
    // rejects it silently (returns null) — no exception, no assignment.
    const result = handlers.worker_next({
      worker_id: 'w', project_id: 1, epic_id: 10, machine_id: 'm', execution_id: 'exec-bad', run_id: 'r', task_ids: [100],
    });
    assert.equal(result.task, null, 'task without process_run_id must not be claimed');
    const task = db.prepare('SELECT status,assigned_to,current_execution_id FROM tasks WHERE id=100').get();
    assert.deepEqual(task, { status: 'todo', assigned_to: null, current_execution_id: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worker_executions').get().n, 0);
  } finally { cleanup(temp); }
});
