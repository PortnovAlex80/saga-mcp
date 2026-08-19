// tests/worker-names-display.test.mjs
//
// WORKER-NAMES-DESIGN.md — display layer (repair agent #7), second file of
// the RED-first pair (core contract: tests/architecture/worker-names.test.mjs).
//
// Pins every human-visibility surface of the design:
//   1. Worker prompt: «You are Forge, a single-use Saga CLI worker» — the
//      callsign in the SYSTEM part of the prompt, next to (never instead of)
//      the authority worker_id/execution_id lines.
//   2. Prompt heartbeat command: worker=Forge (the name the operator greps).
//   3. Runner heartbeat log line: worker=Forge instead of the UUID.
//   4. GET /api/workers/active: every worker object carries display_name
//      (legacy NULL rows fall back to hashName(worker_id)); worker_id stays.
//   5. core-view cell API: executions[] carry displayName.
//   6. Kanban board render: `@Forge` with the UUID as tooltip.
//   7. core-view timeline view source prefers displayName over the raw UUID.
//
// Hermetic: temp DBs, stubbed sagaApplication, no engine, no spawns, no
// network. The prompt builder is a pure function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryRecoveryCaseSchema } from '../dist/process-modules/persistence/sqlite-recovery-case-repository.js';
import { ensureFactoryExternalEffectLedgerSchema } from '../dist/process-modules/persistence/sqlite-external-effect-ledger.js';
import { hashName } from '../dist/worker-names.js';
import { buildPrompt, ClaudeBoardRunner } from '../tracker-view/claude-runner.mjs';
import { initShared } from '../tracker-view/shared.mjs';
import { createLifecycleEndpointsApi } from '../tracker-view/lifecycle-endpoints.mjs';
import { createBoardRenderApi } from '../tracker-view/board-render.mjs';
import { buildCell } from '../core-view/core-cell.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-wn-display-'));

test.after(() => {
  // Windows: AV/indexer can hold a temp file briefly — bounded retries.
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// Prompt fixture (worker-prompt-assembly.test.mjs shape).
// ---------------------------------------------------------------------------

const skillDir = mkdtempSync(path.join(temp, 'skills'));
for (const name of ['protocol-skill', 'semantic-skill', 'reviewer-skill']) {
  writeFileSync(path.join(skillDir, `${name}.md`), `MARKER:${name}\nDo the work.\n`);
}
const launchSpec = {
  installationId: 'inst-wn',
  role: { protocolSkill: 'protocol-skill', semanticSkill: 'semantic-skill', reviewSkill: 'reviewer-skill' },
  allowedToolIds: ['Bash', 'Read', 'Write', 'Edit'],
  resolveSkill: (name) => path.join(skillDir, `${name}.md`),
};

function makePrompt(displayName) {
  const task = {
    id: 77, status: 'in_progress', task_kind: 'development.implement',
    workflow_stage: 'solution-development', execution_mode: 'git_change', tags: '[]',
  };
  return buildPrompt({
    assignment: {
      execution_id: 'exec-wn-0001', skill: 'semantic-skill',
      repository: { name: 'widgets' }, task,
    },
    project: { id: 3, name: 'Widgets' },
    workerId: 'worker-uuid-77',
    displayName,
    workspaceRoot: 'C:/tmp/wn-workspace',
    sagaSkillRoot: 'C:/NOT-A-GLOBAL-ROOT',
    resolvedProfile: null,
    processWorkspace: null,
    launchSpec,
  });
}

// ---------------------------------------------------------------------------
// 1–2. The worker knows its own name; the UUID stays authoritative.
// ---------------------------------------------------------------------------

test('prompt: "You are Forge, a single-use Saga CLI worker" + display_name line + named heartbeat', () => {
  const prompt = makePrompt('Forge');
  assert.ok(prompt.includes('You are Forge, a single-use Saga CLI worker.'),
    'the callsign must open the system part of the prompt');
  assert.ok(prompt.includes('display_name=Forge'),
    'the identity block must carry display_name next to worker_id');
  assert.ok(prompt.includes('worker_id=worker-uuid-77'),
    'the authority worker_id line must remain');
  assert.ok(prompt.includes('execution_id=exec-wn-0001'),
    'the authority execution_id line must remain');
  assert.ok(/worker=Forge project=3 task=77 CLAIMED started/.test(prompt),
    'the prompt heartbeat command must use worker=Forge');
  assert.ok(!/worker=worker-uuid-77/.test(prompt),
    'the UUID must not leak into the heartbeat command');
});

test('prompt: without a display_name the legacy opening line is preserved byte-for-byte', () => {
  const prompt = makePrompt(null);
  assert.ok(prompt.includes('You are a single-use Saga CLI worker.'));
  assert.ok(!prompt.includes('display_name='));
  assert.ok(prompt.includes('worker=worker-uuid-77 project=3 task=77 CLAIMED started'),
    'legacy heartbeat command keeps the worker_id');
});

// ---------------------------------------------------------------------------
// 3. Runner heartbeat log: worker=Forge.
// ---------------------------------------------------------------------------

test('heartbeat log line: worker=<callsign>, not the UUID', () => {
  const heartbeatLog = path.join(temp, 'worker-heartbeat.log');
  const runner = new ClaudeBoardRunner({
    heartbeatLog,
    dbPath: path.join(temp, 'unused.db'),
    sagaEntry: 'dist/index.js',
    spawn: () => { throw new Error('no spawn in this test'); },
  });
  runner.heartbeat(
    { projectId: 3, projectName: 'Widgets' },
    { workerId: 'worker-uuid-77', displayName: 'Forge', taskId: 77, child: { pid: 4242 } },
    'STARTED',
    'claude -p task_id=77',
  );
  const line = readFileSync(heartbeatLog, 'utf8');
  assert.match(line, /worker=Forge /, 'heartbeat must name the worker');
  assert.doesNotMatch(line, /worker=worker-uuid-77/, 'heartbeat must not print the UUID');
  assert.match(line, /pid=4242/, 'pid stays for correlation');
});

// ---------------------------------------------------------------------------
// 4. /api/workers/active carries display_name (with legacy fallback).
// ---------------------------------------------------------------------------

test('handleWorkersActive: display_name on every worker; legacy rows fall back to hashName', () => {
  const dbPath = path.join(temp, 'active.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
       state,phase,pid,display_name,started_at,log_path)
     VALUES ('exec-live-1','r',1,1,101,'worker-uuid-a',?, 'running','executing',4242,'Forge',
             datetime('now'), ?)`,
  ).run(os.hostname(), path.join(temp, 'gone.jsonl'));
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
       state,phase,pid,started_at)
     VALUES ('exec-live-2','r',1,1,102,'worker-uuid-b',?, 'running','executing',4243,
             datetime('now'))`,
  ).run(os.hostname());
  db.close();

  initShared({ dbPath, Database, workerLogRoots: [] });
  const api = createLifecycleEndpointsApi({
    sagaApplication: {},
    repositoryHandlers: {},
    workerLogRoots: [],
    isProcessAlive: () => true,
  });

  let status = null;
  let body = null;
  const res = {
    writeHead(code) { status = code; },
    end(payload) { body = payload; },
  };
  api.handleWorkersActive({}, res, new URL('http://x/api/workers/active?project_id=1'));
  assert.equal(status, 200, body);
  const json = JSON.parse(body);
  assert.equal(json.ok, true);
  const byExec = new Map(json.workers.map(w => [w.execution_id, w]));
  assert.equal(byExec.get('exec-live-1').display_name, 'Forge');
  assert.equal(byExec.get('exec-live-1').worker_id, 'worker-uuid-a');
  assert.equal(byExec.get('exec-live-2').display_name, hashName('worker-uuid-b'),
    'legacy NULL row reads through the hashName fallback');
  assert.equal(byExec.get('exec-live-2').worker_id, 'worker-uuid-b');
});

// ---------------------------------------------------------------------------
// 5. core-view cell API: executions carry displayName.
// ---------------------------------------------------------------------------

test('buildCell: executions carry displayName next to workerId', () => {
  const dbPath = path.join(temp, 'cell.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  // Lazy ensure-schemas (db.ts clean-foundation rule): buildCell joins the
  // process-run, recovery-case and external-effect tables.
  ensureFactoryProcessRunSchema(db);
  ensureFactoryRecoveryCaseSchema(db);
  ensureFactoryExternalEffectLedgerSchema(db);
  db.prepare(
    "INSERT INTO projects (id,name) VALUES (1,'wn-cell')",
  ).run();
  db.prepare(
    "INSERT INTO epics (id,project_id,name) VALUES (1,1,'WN Epic')",
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,
       idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (1,1,1,'solution-development','1.4.4','ref','ik','generic-flow','s','{}','h','running')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role)
     VALUES ('workplace/1/dev/cell/author',1,'solution-development@1.4.4',
             'cell','author','in_progress','running','author')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,workplace_ref)
     VALUES (201,1,'Write the docs','in_progress','workplace/1/dev/cell/author')`,
  ).run();
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
       state,phase,pid,display_name,started_at)
     VALUES ('exec-cell-1','r',1,1,201,'worker-uuid-c','m','running','executing',4244,'Quill',
             datetime('now'))`,
  ).run();
  const cell = buildCell(db, { workplaceRef: 'workplace/1/dev/cell/author' });
  assert.equal(cell.ok, true);
  const exec = cell.executions.find(e => e.executionId === 'exec-cell-1');
  assert.ok(exec, 'execution is listed');
  assert.equal(exec.displayName, 'Quill');
  assert.equal(exec.workerId, 'worker-uuid-c', 'UUID stays alongside the name');
  db.close();
});

// ---------------------------------------------------------------------------
// 6. Kanban render: `@Forge` with the UUID as tooltip.
// ---------------------------------------------------------------------------

test('renderBoard: claimed card shows @<callsign> with the UUID tooltip', () => {
  const dbPath = path.join(temp, 'board.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
       state,phase,display_name)
     VALUES ('exec-board-1','r',1,1,301,'worker-uuid-d','m','reserved','executing','Lathe')`,
  ).run();
  db.close();

  initShared({ dbPath, Database, workerLogRoots: [] });
  const theme = {
    COLS: [
      { key: 'todo', label: 'Backlog' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'review', label: 'Review (queue)' },
      { key: 'review_in_progress', label: 'Reviewing' },
      { key: 'done', label: 'Done' },
      { key: 'blocked', label: 'Blocked' },
    ],
    PROJECT_COLORS: ['#123456'], PRIO: { medium: '#f1c40f' },
    TYPE_COLORS: {}, TYPE_LABEL: {}, STATUS_LABEL: {},
    STATUS_COLOR: {}, LINK_COLORS: {}, LINK_GLYPH: {},
  };
  const boardApi = createBoardRenderApi({
    RELOAD_SEC: 5,
    loadBoard: () => ({
      epicById: { 1: { id: 1, name: 'WN Epic' } },
      tasks: [{
        id: 301, epic_id: 1, status: 'in_progress', priority: 'medium',
        assigned_to: 'worker-uuid-d', current_execution_id: 'exec-board-1',
        tags: '[]', metadata: '{}', title: 'Machine the part',
      }],
    }),
    theme,
    modelApi: { ZAI_MODELS: [], LMSTUDIO_MODELS: [], LMSTUDIO_ONLINE: false },
    runtimeConfig: {},
  });
  const html = boardApi.renderBoard(1, [{ id: 1, name: 'wn', color: '#123456', total: 1 }]);
  assert.ok(html.includes('@Lathe'), 'kanban card shows the @callsign');
  assert.ok(/title="worker-uuid-d"/.test(html),
    'the UUID rides along as the tooltip');
});

// ---------------------------------------------------------------------------
// 7. core-view timeline view: prefers the callsign over the raw UUID.
// ---------------------------------------------------------------------------

test('cell.js timeline renders the callsign with the UUID fallback', () => {
  const src = readFileSync(
    path.resolve('core-view/public/views/cell.js'), 'utf8',
  );
  assert.ok(/displayName/.test(src),
    'the timeline row must consult displayName');
  assert.ok(/workerId/.test(src),
    'the raw workerId remains the fallback');
});
