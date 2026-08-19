// tests/architecture/panel-pause-wiring.test.mjs
//
// Panel wiring of the graceful-drain pause (docs/architecture/PAUSE-DESIGN.md):
//   T2 — ▶ (/api/factory/start resume) must releaseOperatorHolds(projectId)
//        BEFORE spawning. Today nothing releases them, so a resumed engine
//        claims 0 cards (the claim SQL honors factory_operator_holds) and
//        dies 'paused' after 3 empty streaks — the looks-started trap.
//   T4 — POST /api/factory/pause places exactly ONE project-scope hold
//        (reason 'panel-drain-pause'), is idempotent on a double-click, and
//        mutates NOTHING in worker_executions / tasks / factory_workplaces.
//   T5 — the board UI: ⏸ wired to /api/factory/pause, the hard-stop second
//        action keeps the legacy /api/factory/stop, the blind-live branch
//        enables the pause.
//
// Hermetic: temp DB + initShared; sagaApplication and engineSupervisor are
// stubs; no engine process is ever spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { initShared } from '../../tracker-view/shared.mjs';
import { createAdminEndpointsApi } from '../../tracker-view/admin-endpoints.mjs';
import { createBoardRenderApi } from '../../tracker-view/board-render.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-panelpause-'));
const DB_PATH = path.join(temp, 'panel.db');

let db;
test.before(() => {
  db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  // factory_process_runs lives in a lazy ensure-schema (clean-foundation rule
  // in db.ts), not in SCHEMA_SQL — needed for the workplace-hold flavor.
  ensureFactoryProcessRunSchema(db);
  initShared({ dbPath: DB_PATH, Database, workerLogRoots: [] });
});

test.after(() => {
  db?.close();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake HTTP plumbing for the admin endpoints (parseRequest reads the request
// stream; respondJson writes through writeHead/end).
// ---------------------------------------------------------------------------

function jsonRequest(fields) {
  return {
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(JSON.stringify(fields)));
      if (event === 'end') listener();
    },
  };
}

function callEndpoint(handler, fields) {
  return new Promise(resolve => {
    const captured = { code: null, body: null };
    const res = {
      writeHead(code, headers) { captured.code = code; captured.headers = headers; },
      end(body) {
        captured.body = body === undefined ? captured.body : JSON.parse(body);
        resolve(captured);
      },
    };
    handler(jsonRequest(fields), res);
  });
}

// ---------------------------------------------------------------------------
// Seeding — one resumable project (projects + epics + order + lifecycle run).
// ---------------------------------------------------------------------------

function seedResumableProject(label) {
  const projectId = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS next FROM projects').get().next);
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (?, ?, 'active')`)
    .run(projectId, `panel-${label}-${projectId}`);
  const epicId = projectId * 10;
  db.prepare(`INSERT INTO epics (id, project_id, name, status) VALUES (?, ?, ?, 'planned')`)
    .run(epicId, projectId, `epic-${label}`);
  const lifecycleRunId = projectId * 100;
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id, epic_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        status, entry_stage_id)
     VALUES (?, 'lf', '1', 'lf@1', 'd', '', '{}', 'h', ?, ?, 'op', ?,
             's', '{}', 'ih', 'paused', 'e')`,
  ).run(lifecycleRunId, projectId, epicId, `ik-${label}`);
  db.prepare(
    `INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state, lifecycle_run_id)
     VALUES (?, ?, ?, 'existing_project', 'provisioned', ?)`,
  ).run(`order-${label}`, projectId, epicId, lifecycleRunId);
  return { projectId, epicId, lifecycleRunId };
}

function activeHoldCount() {
  return db.prepare(
    'SELECT COUNT(*) AS c FROM factory_operator_holds WHERE released_at IS NULL',
  ).get().c;
}

function stubApplication(spawnRecorder) {
  return {
    startEngine(command) {
      spawnRecorder(command);
      return { pid: 4242, running: true };
    },
  };
}

// ---------------------------------------------------------------------------
// T2 — ▶ releases holds BEFORE spawning.
// ---------------------------------------------------------------------------

test('T2: ▶ on a hold-placed DB releases the project holds BEFORE spawning the engine', async () => {
  const seeded = seedResumableProject('t2-resume');
  // The pause flavor: one unreleased project-scope hold (panel pause) plus a
  // workplace hold from a CLI soft-stop — releaseOperatorHolds(projectId)
  // must clear BOTH before the spawn.
  db.prepare(
    `INSERT INTO factory_operator_holds (hold_ref, subject_kind, subject_ref, reason, created_by)
     VALUES ('hold-t2-project', 'project', ?, 'panel-drain-pause', 'panel')`,
  ).run(String(seeded.projectId));
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash, status)
     VALUES (?, ?, ?, 'test-module', '1.0.0', 'test-module@1.0.0', ?,
             'generic-flow', 'test.input.v1', '{}', ?, 'running')`,
  ).run(7000 + seeded.projectId, seeded.projectId, seeded.epicId,
    `ik-pr-t2-${seeded.projectId}`, 'b'.repeat(64));
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, active_reservation_ref, revision)
     VALUES (?, ?, 'm', 'c', 'i', 'in_progress', 'paused', 'author', NULL, 1)`,
  ).run(`wp-t2-${seeded.projectId}`, 7000 + seeded.projectId);
  db.prepare(
    `INSERT INTO factory_operator_holds (hold_ref, subject_kind, subject_ref, reason, created_by)
     VALUES ('hold-t2-workplace', 'workplace', ?, 'operator recall', 'cli')`,
  ).run(`wp-t2-${seeded.projectId}`);

  const spawns = [];
  const api = createAdminEndpointsApi({
    runtimeConfig: {},
    dbPath: DB_PATH,
    page: () => '',
    sagaApplication: stubApplication(() => {
      spawns.push({ activeHoldsAtSpawn: activeHoldCount() });
    }),
  });

  const response = await callEndpoint(api.handleFactoryStart, { project_id: seeded.projectId });

  assert.equal(response.body.ok, true,
    'T2: the resume start itself must succeed (stub engine)');
  assert.ok(Number(response.body.holds_released) >= 2,
    'T2: ▶ must report holds_released — today nothing releases them, so the engine resumes, claims 0 cards and dies \'paused\' after 3 empty streaks (the looks-started trap)');
  assert.equal(spawns.length, 1,
    'T2: exactly one engine spawn must happen on resume');
  assert.equal(spawns[0].activeHoldsAtSpawn, 0,
    'T2: at spawn time every operator hold of the project must ALREADY be released (release BEFORE spawn)');
  assert.equal(activeHoldCount(), 0,
    'T2: after ▶ no unreleased hold may remain for the project');
});

test('T2 control: ▶ when no holds exist spawns normally and reports holds_released=0', async () => {
  const seeded = seedResumableProject('t2-control');
  const spawns = [];
  const api = createAdminEndpointsApi({
    runtimeConfig: {},
    dbPath: DB_PATH,
    page: () => '',
    sagaApplication: stubApplication(() => spawns.push({})),
  });
  const response = await callEndpoint(api.handleFactoryStart, { project_id: seeded.projectId });
  assert.equal(response.body.ok, true, 'T2c: resume without holds must succeed');
  assert.equal(response.body.holds_released, 0,
    'T2c: with no holds placed ▶ must report zero released holds');
  assert.equal(spawns.length, 1, 'T2c: one spawn');
});

// ---------------------------------------------------------------------------
// T4 — the pause endpoint.
// ---------------------------------------------------------------------------

test('T4: POST /api/factory/pause places exactly ONE hold, idempotent, mutating nothing else', async () => {
  const seeded = seedResumableProject('t4-pause');
  db.prepare(
    `INSERT INTO tasks (epic_id, title, status) VALUES (?, 'queued-card', 'todo')`,
  ).run(seeded.epicId);
  const before = {
    workerExecutions: db.prepare('SELECT COUNT(*) AS c FROM worker_executions').get().c,
    tasks: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
    workplaces: db.prepare('SELECT COUNT(*) AS c FROM factory_workplaces').get().c,
    taskRows: db.prepare('SELECT id, status, assigned_to, current_execution_id FROM tasks').all(),
    controls: db.prepare('SELECT COUNT(*) AS c FROM lifecycle_execution_controls').get().c,
  };

  const api = createAdminEndpointsApi({
    runtimeConfig: {},
    dbPath: DB_PATH,
    page: () => '',
    sagaApplication: stubApplication(() => {
      throw new Error('T4: the pause endpoint must NEVER spawn or kill an engine');
    }),
    engineSupervisor: {
      sweepBeforeSpawn: () => {
        throw new Error('T4: the pause endpoint must never consult the engine supervisor');
      },
    },
  });

  assert.equal(typeof api.handleFactoryPause, 'function',
    'T4: the admin API must expose handleFactoryPause (POST /api/factory/pause)');

  // epic_id form — the panel speaks epic ids.
  const first = await callEndpoint(api.handleFactoryPause, { epic_id: seeded.epicId });
  assert.equal(first.code, 200,
    'T4: the pause endpoint must answer 200 for a known epic');
  assert.equal(first.body.ok, true,
    'T4: the pause endpoint must place the hold successfully');
  assert.equal(first.body.placed, true,
    'T4: the first pause click places the hold');

  const holds = db.prepare(
    `SELECT * FROM factory_operator_holds
      WHERE subject_kind='project' AND subject_ref=? AND released_at IS NULL`,
  ).all(String(seeded.projectId));
  assert.equal(holds.length, 1,
    'T4: exactly ONE hold row may exist after the pause click');
  assert.equal(holds[0].subject_kind, 'project',
    'T4: the pause hold must be project-scope (the exact row shape the claim predicate honors)');
  assert.equal(holds[0].subject_ref, String(seeded.projectId),
    'T4: the hold subject_ref must be the project id as text (claim-SQL shape)');
  assert.equal(holds[0].reason, 'panel-drain-pause',
    "T4: the hold reason must be 'panel-drain-pause'");

  // Double-click idempotence.
  const second = await callEndpoint(api.handleFactoryPause, { epic_id: seeded.epicId });
  assert.equal(second.body.ok, true, 'T4: the second (double-click) pause must succeed');
  assert.equal(second.body.placed, false,
    'T4: the double-click must NOT place a second hold');
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS c FROM factory_operator_holds
        WHERE subject_kind='project' AND subject_ref=? AND released_at IS NULL`,
    ).get(String(seeded.projectId)).c,
    1,
    'T4: still exactly one hold row after the double-click',
  );

  // Zero mutations outside the hold table.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_executions').get().c, before.workerExecutions,
    'T4: the pause must not touch worker_executions (no fence, no kill, no rewind)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, before.tasks,
    'T4: the pause must not touch tasks');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM factory_workplaces').get().c, before.workplaces,
    'T4: the pause must not touch factory_workplaces');
  assert.deepEqual(
    db.prepare('SELECT id, status, assigned_to, current_execution_id FROM tasks').all(),
    before.taskRows,
    'T4: no task row content may change',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM lifecycle_execution_controls').get().c, before.controls,
    'T4: the pause must not stamp lifecycle_execution_controls (the hold IS the durable fence)');
});

// ---------------------------------------------------------------------------
// T5 — board-render wiring (static truth: .mjs is live-without-build).
// ---------------------------------------------------------------------------

test('T5: board ⏸ wired to /api/factory/pause; hard-stop second action keeps the legacy /api/factory/stop', () => {
  const board = readFileSync('tracker-view/board-render.mjs', 'utf8');
  const view = readFileSync('tracker-view/tracker-view.mjs', 'utf8');
  const lifecycleEndpoints = readFileSync('tracker-view/lifecycle-endpoints.mjs', 'utf8');

  // (a) The ⏸ branch calls the graceful-drain endpoint.
  assert.ok(board.includes("fetch('/api/factory/pause'"),
    'T5: the ⏸ branch must call POST /api/factory/pause (graceful drain), not the killer');

  // (b) The hard-stop second action: separate button, confirm-gated, legacy endpoint.
  assert.ok(board.includes('agent-engine-hardstop'),
    'T5: a separate hard-stop button (agent-engine-hardstop) must exist as the drain backstop');
  assert.ok(board.includes('Остановить немедленно'),
    'T5: the hard-stop must stay confirm-gated ("Остановить немедленно?")');
  assert.ok(board.includes("fetch('/api/factory/stop'"),
    'T5: the hard-stop action must route to the EXISTING /api/factory/stop');
  assert.equal((board.match(/fetch\('\/api\/factory\/stop'/g) || []).length, 1,
    'T5: the legacy stop endpoint must be fetched exactly ONCE — owned by the hard-stop button, no longer by ⏸');

  // (c) Two-phase drain status lines.
  assert.ok(board.includes('дожидаемся'),
    "T5: the drain-mode status line '⏳ дожидаемся N воркеров' must exist (poll /api/workers/active)");
  assert.ok(board.includes('на паузе'),
    "T5: the drained status line 'на паузе (K карт в очереди)' must exist");

  // (d) The blind-live branch enables the pause (durable hold is engine-agnostic).
  assert.ok(!board.includes('пустышка'),
    'T5: the B-006 dead-button branch must be replaced by a live pause — the durable hold is engine-agnostic');
  assert.ok(board.includes('движок сам припаркуется после дожина; для убийства — CLI'),
    'T5: the blind-live branch must carry the caveat line about self-park vs CLI kill');

  // (e) Routing: pause → admin API; legacy stop routing unchanged.
  assert.ok(view.includes("'/api/factory/pause'") && view.includes('adminApi.handleFactoryPause'),
    'T5: tracker-view.mjs must route POST /api/factory/pause to adminApi.handleFactoryPause');
  assert.ok(view.includes("'/api/factory/stop'") && view.includes('lifecycleApi.handleEngineStop'),
    'T5: the legacy /api/factory/stop routing (lifecycleApi.handleEngineStop) must remain unchanged');
  assert.ok(lifecycleEndpoints.includes('function handleEngineStop'),
    'T5: the legacy handleEngineStop implementation must remain in place');
});

// ---------------------------------------------------------------------------
// UI smoke — the board template is LIVE-WITHOUT-BUILD: render it with stubbed
// deps and compile every <script> block, so a template-syntax break in the
// pause/drain handlers is caught by CI instead of by the operator's browser.
// ---------------------------------------------------------------------------

test('UI smoke: renderBoard emits syntactically valid scripts with the pause/hardstop handlers', async () => {
  const vm = await import('node:vm');
  const theme = {
    COLS: [], PROJECT_COLORS: ['#123456'], PRIO: {},
    TYPE_COLORS: {}, TYPE_LABEL: {}, STATUS_LABEL: {},
    STATUS_COLOR: {}, LINK_COLORS: {}, LINK_GLYPH: {},
  };
  const boardApi = createBoardRenderApi({
    RELOAD_SEC: 5,
    loadBoard: () => ({ epicById: { 1: { id: 1, name: 'Smoke Epic' } }, tasks: [] }),
    theme,
    modelApi: { ZAI_MODELS: [], LMSTUDIO_MODELS: [], LMSTUDIO_ONLINE: false },
    runtimeConfig: {},
  });
  const html = boardApi.renderBoard(1, [{ id: 1, name: 'smoke', color: '#123456', total: 0 }]);
  assert.ok(html.includes('agent-engine-toggle'), 'UI smoke: the engine toggle must render');
  assert.ok(html.includes('agent-engine-hardstop'),
    'UI smoke: the hard-stop button must render on the board');

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, 'UI smoke: the board page must emit at least one script');
  scripts.forEach((code, index) => {
    assert.doesNotThrow(
      () => new vm.Script(code, { filename: `board-script-${index}.js` }),
      `UI smoke: board script #${index} must compile (template syntax is live-without-build)`,
    );
  });
});
