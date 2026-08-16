// tests/app/operator-soft-stop-process.test.mjs
//
// Operator SOFT-STOP protocol — the parts that touch REAL OS processes and
// the operator CLI:
//
//   1. Guarded TREE-kill of a throwaway spawned child (node -e long-running)
//      with death verification, using the persisted PID + birth token only.
//   2. Killing an already-dead PID is a guarded no-op.
//   3. CLI smoke: `scripts/factory.mjs stop <db> --project N --dry-run` lists
//      the plan without writing; `unpark <db> --project N` releases holds.
//
// Nothing here touches .factory-testbed/factory.sqlite — everything runs on
// throwaway temp databases and throwaway child processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { killWorkerTree } from '../../dist/app/operator-soft-stop.js';
import { isProcessAlive, markExecutionRunning, readProcessBirthToken } from '../../dist/worker-executions.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-softstop-proc-'));
const dbPath = path.join(temp, 'proc.db');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freshDb(dbFile) {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR IGNORE INTO projects (id,name) VALUES (1,'proc-test')").run();
  db.prepare("INSERT OR IGNORE INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  db.prepare("INSERT OR IGNORE INTO tasks (id,epic_id,title,status) VALUES (1,1,'t','in_progress')").run();
  return db;
}

/** Spawn a throwaway long-running node child and wait for its pid to be alive. */
function spawnThrowaway() {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true },
  );
  // Wait (bounded) until the OS reports the pid alive.
  const deadline = Date.now() + 5000;
  while (!isProcessAlive(child.pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!isProcessAlive(child.pid)) throw new Error('throwaway child failed to start');
  return child;
}

test.after(() => {
  // Windows can EPERM on temp-file removal while WAL sidecars settle; the
  // directory lives under the OS tmpdir, so best-effort cleanup is enough.
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch { /* best effort */ }
});

test('guarded tree-kill kills a real child by persisted pid and verifies death', () => {
  const db = freshDb(dbPath);
  const child = spawnThrowaway();
  try {
    const token = readProcessBirthToken(child.pid);
    assert.ok(token, 'birth token readable for the live child');
    // Persist the hire exactly like markExecutionRunning does (pid + token).
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
       VALUES ('exec-kill','r',1,1,1,'w',?, 'reserved','executing')`,
    ).run(os.hostname());
    markExecutionRunning(dbPath, 'exec-kill', child.pid, token, path.join(temp, 'log.txt'), new Date().toISOString());
    // The stop fence must land before the kill phase (protocol invariant).
    db.prepare(
      `UPDATE worker_executions SET state='terminated', voided_at=datetime('now'),
              stop_fence=stop_fence+1 WHERE execution_id='exec-kill'`,
    ).run();

    const outcome = killWorkerTree(db, 'exec-kill');
    assert.equal(outcome.kind, 'killed');
    assert.equal(outcome.pid, child.pid);
    // Death verification: the pid is gone (allow the OS a beat to reap it).
    const deadline = Date.now() + 5000;
    while (isProcessAlive(child.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(isProcessAlive(child.pid), false, 'child tree is dead');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    db.close();
  }
});

test('killing an already-dead pid is a guarded no-op', () => {
  const db = freshDb(dbPath);
  const child = spawnThrowaway();
  const token = readProcessBirthToken(child.pid);
  try {
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,
          pid, process_birth_token, voided_at, stop_fence)
       VALUES ('exec-dead','r',1,1,1,'w',?,'terminated','executing', ?, ?, datetime('now'), 1)`,
    ).run(os.hostname(), child.pid, token);
    // Kill the child OUT of band first.
    process.kill(child.pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (isProcessAlive(child.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    const outcome = killWorkerTree(db, 'exec-dead');
    assert.equal(outcome.kind, 'already_dead');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    db.close();
  }
});

// ---------------------------------------------------------------------------
// CLI smoke.
// ---------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'factory.mjs'), ...args],
    { encoding: 'utf8', cwd: repoRoot, timeout: 60_000 },
  );
}

function seedCliDb(db) {
  // A hired execution with a workplace, mirroring the adapter's hire shape.
  db.prepare("INSERT INTO tasks (id,epic_id,title,status,workplace_ref,current_execution_id,assigned_to,metadata) "
    + "VALUES (2,1,'cli card','in_progress','workplace/1/test-module@1.0.0/default/task-2','exec-cli','w-cli',?)")
    .run(JSON.stringify({ process_run_id: 1, workplace_ref: 'workplace/1/test-module@1.0.0/default/task-2' }));
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, active_reservation_ref)
     VALUES ('workplace/1/test-module@1.0.0/default/task-2', 1, 'test-module@1.0.0', 'default', 'task-2',
             'in_progress', 'running', 'author', 2, 'exec-cli')`,
  ).run();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('exec-cli','r',1,1,2,'w-cli',?,'running','executing')`,
  ).run(os.hostname());
}

function cliDbPath(name) {
  return path.join(temp, name);
}

test('CLI: stop --dry-run lists the plan and writes nothing', () => {
  const dbFile = cliDbPath('cli-dryrun.db');
  const db = freshDb(dbFile);
  seedCliDb(db);
  db.close();
  const result = runCli(['stop', dbFile, '--project', '1', '--dry-run']);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /stop\(dry-run\)/);
  assert.match(result.stdout, /exec-cli/);
  assert.match(result.stdout, /action=rewind/);
  const check = new Database(dbFile, { readonly: true });
  assert.equal(
    check.prepare('SELECT COUNT(*) AS n FROM factory_worker_stops').get().n,
    0,
    'dry-run writes no stop rows',
  );
  check.close();
});

test('CLI: scope validation refuses stop without --project/--all and unpark without --project', () => {
  const dbFile = cliDbPath('cli-scope.db');
  const db = freshDb(dbFile);
  db.close();
  const noScope = runCli(['stop', dbFile]);
  assert.notEqual(noScope.status, 0);
  assert.match(noScope.stderr, /exactly one scope is required/);

  const bothScopes = runCli(['stop', dbFile, '--project', '1', '--all']);
  assert.notEqual(bothScopes.status, 0);
  assert.match(bothScopes.stderr, /exactly one scope is required/);

  const unparkNoProject = runCli(['unpark', dbFile]);
  assert.notEqual(unparkNoProject.status, 0);
  assert.match(unparkNoProject.stderr, /--project/);
});

test('CLI: unpark releases zero holds on an unheld project (idempotent smoke)', () => {
  const dbFile = cliDbPath('cli-unpark.db');
  const db = freshDb(dbFile);
  db.close();
  const result = runCli(['unpark', dbFile, '--project', '1']);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /0 hold\(s\) released/);
});
