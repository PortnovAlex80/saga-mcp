// tests/architecture/adr087-tail-visibility.test.mjs
//
// ADR-087 REQUIRED COMPANION OBSERVABILITY (CC-GAP-3 follow-up):
//
//   "the worker-status API must expose local rows with semantic
//    state='exited', exit_code IS NULL, and a still-live PID (or expose them
//    through an adjacent endpoint); board blindLive and admin drain counts
//    must include that physical tail so Play/drain surfaces cannot claim an
//    empty host; tracker text must distinguish semantic `exited` from
//    physical process death."
//
// Three fences:
//   A — /api/workers/active (handleWorkersActive): the ADR-087 alive tail is
//       VISIBLE with birth-safe evidence and explicit distinguishing fields
//       (semantic_exited / state / exit_code / pid_alive / pid_identity);
//       physically-observed exits (exit_code set), dead PIDs, birth-mismatched
//       (PID-reused) tails and remote rows are NOT painted as live tails.
//   B — /api/factory/pause (handleFactoryPause): the admin drain counts
//       include the local physical tail (physical_tails) so the two-phase
//       drain line cannot claim an empty host.
//   C — source ratchets: board blindLive/labels + drain poll include tails
//       with the semantic-vs-physical distinction; tracker-view wires the
//       birth-token reader.
//
// Hermetic: temp DB + initShared; isProcessAlive/readBirthToken are stubs; no
// engine process is ever spawned or probed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { initShared } from '../../tracker-view/shared.mjs';
import { createLifecycleEndpointsApi } from '../../tracker-view/lifecycle-endpoints.mjs';
import { createAdminEndpointsApi } from '../../tracker-view/admin-endpoints.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-adr087-tails-'));

let db;
test.before(() => {
  const dbPath = path.join(temp, 'tails.db');
  db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  initShared({ dbPath, Database, workerLogRoots: [] });
});

test.after(() => {
  db?.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// --- fixtures --------------------------------------------------------------

/**
 * Stub process world: PIDs 4242 (running worker), 5151 (ADR-087 tail, birth
 * token tok-tail), 5152 (token-less tail), 6262 (dead tail PID), 7373 (a
 * PID reused by a FOREIGN process: alive but live token mismatches).
 */
const ALIVE = new Set([4242, 5151, 5152, 7373, process.pid]);
const TOKENS = new Map([[5151, 'tok-tail'], [7373, 'tok-reused-foreign']]);
const isProcessAliveStub = (pid) => pid !== null && ALIVE.has(pid);
const readBirthTokenStub = (pid) => (TOKENS.has(pid) ? TOKENS.get(pid) : null);

function insertExecution(executionId, overrides = {}) {
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
       state, phase, pid, process_birth_token, started_at, exit_code)
     VALUES (?, 'run-t', 1, 1, ?, ?, ?, ?, 'executing', ?, ?, datetime('now'), ?)`,
  ).run(
    executionId,
    overrides.task_id ?? 1,
    overrides.worker_id ?? `w-${executionId}`,
    overrides.machine_id ?? os.hostname(),
    overrides.state ?? 'running',
    overrides.pid ?? null,
    overrides.token ?? null,
    overrides.exit_code ?? null,
  );
}

function insertAcceptedReceipt(executionId) {
  db.prepare(
    `INSERT INTO command_receipts
      (command_id, command_kind, actor_kind, actor_id, execution_id, task_id,
       payload_hash, accepted, rejection_code, result_json, reply_json)
     VALUES (?, 'worker_done', 'managed_execution', NULL, ?, 1, 'h', 1, NULL, '{}', '{}')`,
  ).run(`rcpt-${executionId}`, executionId);
}

function callWorkersActive(api, projectId = 1) {
  let status = null;
  let body = null;
  const res = {
    writeHead(code) { status = code; },
    end(payload) { body = payload; },
  };
  api.handleWorkersActive({}, res, new URL(`http://x/api/workers/active?project_id=${projectId}`));
  assert.equal(status, 200, body);
  return JSON.parse(body);
}

// --- A: /api/workers/active tail visibility --------------------------------

test('A: /api/workers/active exposes the ADR-087 alive tail with birth-safe evidence and semantic/physical distinction', () => {
  insertExecution('exec-run-live', { pid: 4242, state: 'running' });
  insertExecution('exec-tail-alive', { pid: 5151, token: 'tok-tail', state: 'exited' });
  insertAcceptedReceipt('exec-tail-alive');
  insertExecution('exec-tail-tokenless', { pid: 5152, state: 'exited' });
  insertExecution('exec-tail-dead-pid', { pid: 6262, state: 'exited' });
  insertExecution('exec-tail-pid-reused', { pid: 7373, token: 'tok-ours-dead', state: 'exited' });
  insertExecution('exec-tail-remote', { pid: 5151, token: 'tok-tail', state: 'exited', machine_id: 'other-host' });
  insertExecution('exec-exit-observed', { pid: 4242, state: 'exited', exit_code: 0 });

  const api = createLifecycleEndpointsApi({
    sagaApplication: {},
    repositoryHandlers: {},
    workerLogRoots: [],
    isProcessAlive: isProcessAliveStub,
    readBirthToken: readBirthTokenStub,
  });

  const json = callWorkersActive(api);
  assert.equal(json.ok, true);
  const byExec = new Map(json.workers.map(w => [w.execution_id, w]));

  // The ordinary running worker is unchanged.
  const running = byExec.get('exec-run-live');
  assert.ok(running, 'the running worker is listed');
  assert.equal(running.semantic_exited, false);
  assert.equal(running.state, 'running');
  assert.equal(running.pid_alive, true);
  assert.equal(running.pid_identity, null, 'ordinary rows keep the historical bare-PID filter');

  // THE TAIL: semantically exited, physically alive, birth-verified.
  const tail = byExec.get('exec-tail-alive');
  assert.ok(tail, 'the ADR-087 alive tail (state=exited, exit_code null, live PID) IS listed');
  assert.equal(tail.state, 'exited', 'semantic protocol completion is stated');
  assert.equal(tail.exit_code, null, 'physical exit NOT observed — no code fabricated');
  assert.equal(tail.semantic_exited, true, 'explicit semantic-completion flag');
  assert.equal(tail.pid_alive, true, 'the local PID is still alive');
  assert.equal(tail.pid_identity, 'birth_token_verified',
    'birth-safe evidence: the live birth token matches the stored one');
  assert.equal(tail.accepted_receipt, true,
    'the tail carries its receipt authority (worker_done accepted)');
  assert.equal(tail.physical_exit_observed, false);
  assert.equal(json.physical_tails, 2,
    'summary count: the birth-verified tail AND the token-less tail (both alive + semantically exited)');

  // A token-less tail is still visible, but explicitly NOT identity-proven.
  const tokenless = byExec.get('exec-tail-tokenless');
  assert.ok(tokenless, 'a token-less alive tail stays visible (operator must see it)');
  assert.equal(tokenless.pid_identity, 'pid_only_unverified',
    'bare-PID liveness is labeled, never claimed as birth-safe');

  // NOT painted as live tails: dead PID, PID reuse (birth mismatch), remote
  // machine, and physically-observed exits (exit_code present).
  assert.equal(byExec.get('exec-tail-dead-pid'), undefined,
    'a dead PID is not a live tail');
  assert.equal(byExec.get('exec-tail-pid-reused'), undefined,
    'birth mismatch (PID reused by a foreign process) is not our tail');
  assert.equal(byExec.get('exec-tail-remote'), undefined,
    'remote-host rows are not probed/claimed from here');
  assert.equal(byExec.get('exec-exit-observed'), undefined,
    'an exit WITH observed exit_code is physical death — not a live tail at all');
});

// --- B: admin drain counts include the local tail ---------------------------

function callPause(api, fields) {
  return new Promise(resolve => {
    const captured = { code: null, body: null };
    const res = {
      writeHead(code) { captured.code = code; },
      end(body) { captured.body = body === undefined ? captured.body : JSON.parse(body); resolve(captured); },
    };
    const req = {
      headers: { 'content-type': 'application/json' },
      on(event, listener) {
        if (event === 'data') listener(Buffer.from(JSON.stringify(fields)));
        if (event === 'end') listener();
      },
    };
    api.handleFactoryPause(req, res);
  });
}

test('B: /api/factory/pause drain counts include the local ADR-087 tail (physical_tails)', async () => {
  const projectId = 2;
  const epicId = 20;
  db.prepare(`INSERT INTO projects (id, name) VALUES (?, 'adr087-tails')`).run(projectId);
  db.prepare(`INSERT INTO epics (id, project_id, name) VALUES (?, ?, 'e')`).run(epicId, projectId);

  insertExecution('exec-p2-running', { pid: 4242, state: 'running', task_id: 21 });
  db.prepare(`UPDATE worker_executions SET project_id=?, epic_id=? WHERE execution_id='exec-p2-running'`).run(projectId, epicId);
  insertExecution('exec-p2-tail', { pid: 5151, token: 'tok-tail', state: 'exited', task_id: 22 });
  db.prepare(`UPDATE worker_executions SET project_id=?, epic_id=? WHERE execution_id='exec-p2-tail'`).run(projectId, epicId);
  insertExecution('exec-p2-remote-tail', { pid: 5151, state: 'exited', machine_id: 'other-host', task_id: 23 });
  db.prepare(`UPDATE worker_executions SET project_id=?, epic_id=? WHERE execution_id='exec-p2-remote-tail'`).run(projectId, epicId);
  insertExecution('exec-p2-observed', { pid: 4242, state: 'exited', exit_code: 0, task_id: 24 });
  db.prepare(`UPDATE worker_executions SET project_id=?, epic_id=? WHERE execution_id='exec-p2-observed'`).run(projectId, epicId);

  const api = createAdminEndpointsApi({
    runtimeConfig: {},
    dbPath: path.join(temp, 'tails.db'),
    page: () => '',
    sagaApplication: {
      startEngine: () => { throw new Error('B: pause must never spawn an engine'); },
    },
    engineSupervisor: {
      sweepBeforeSpawn: () => { throw new Error('B: pause must never consult the engine supervisor'); },
    },
  });

  const pause = await callPause(api, { epic_id: epicId });
  assert.equal(pause.code, 200, JSON.stringify(pause.body));
  assert.equal(pause.body.ok, true);
  assert.equal(pause.body.placed, true, 'the durable hold is placed (pause contract unchanged)');
  assert.equal(pause.body.active_workers, 1,
    'active_workers still counts only reserved/running/cancel_requested');
  assert.equal(pause.body.physical_tails, 1,
    'the LOCAL ADR-087 tail is included in the drain counts (exited + exit_code null + this host)');
  assert.ok(pause.body.note.includes('physical_tails=1'),
    'the note names the tail count so the drain line cannot claim an empty host');
  assert.ok(pause.body.note.includes('exit_code=null'),
    'the note states that physical exit was not observed');
});

// --- C: board/admin/endpoint wiring ratchets (source truth) -----------------

test('C: board blindLive/labels and drain poll include tails with the semantic-vs-physical distinction', () => {
  const board = readFileSync(path.join('tracker-view', 'board-render.mjs'), 'utf8');
  // blindLive decomposition keeps semantic completion OUT of the worker count
  // while the tails are counted separately and labeled.
  assert.ok(board.includes('x.semantic_exited !== true'),
    'blindLive counts real workers via the explicit semantic_exited flag');
  assert.ok(board.includes('x.semantic_exited === true'),
    'the tail population is counted explicitly (never silently merged)');
  assert.ok(board.includes('wj.physical_tails'),
    'the board consumes the endpoint summary count physical_tails');
  assert.ok(board.includes('живые хвосты ADR-087'),
    'the status label names the ADR-087 physical tails');
  assert.ok(board.includes('state=exited') && board.includes('exit_code=null'),
    'the label distinguishes semantic completion (state=exited) from physical death (exit_code)');
  assert.ok(board.includes('хост не пуст'),
    'the labels never claim an empty host while tails are alive');
  // The drain poll: tails keep the two-phase line waiting.
  assert.ok(board.includes('(d.active_workers ?? 0) + (d.physical_tails ?? 0)'),
    'the drain seed count includes physical_tails from the pause response');
  assert.ok(board.includes('активных воркеров нет · живые хвосты ADR-087'),
    'the drain line has a distinct tails-only state (no premature "на паузе")');

  const endpoints = readFileSync(path.join('tracker-view', 'lifecycle-endpoints.mjs'), 'utf8');
  assert.ok(endpoints.includes("we.state='exited' AND we.exit_code IS NULL"),
    'the status SQL selects exactly the ADR-087 tail shape (exited + unobserved exit)');
  assert.ok(endpoints.includes("'birth_token_verified'") && endpoints.includes("'pid_only_unverified'"),
    'birth-safe liveness evidence is labeled per tail');
  assert.ok(endpoints.includes('physical_tails'),
    'the response carries the physical_tails summary count');

  const admin = readFileSync(path.join('tracker-view', 'admin-endpoints.mjs'), 'utf8');
  assert.ok(admin.includes('physical_tails'),
    'the admin pause response carries physical_tails');

  const view = readFileSync(path.join('tracker-view', 'tracker-view.mjs'), 'utf8');
  assert.ok(view.includes('readBirthToken: readProcessBirthToken'),
    'tracker-view wires the real birth-token reader into the status API');
});
