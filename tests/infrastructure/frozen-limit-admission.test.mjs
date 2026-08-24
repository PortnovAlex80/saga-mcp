/**
 * C-4 (stage-11 PREVENTIVE-HUNT Layer 6) + STAGE-23 one-entry law
 * (operator directive 2026-08-24): admission is grouped by the FROZEN model
 * of each in-flight execution, and the ONLY ceiling is the panel concurrency
 * field (lifecycle_execution_controls.concurrency). The per-model catalog
 * limit and the model_concurrency_limit column were a mistake and are gone:
 * switching a model never changes the ceiling, and the anti-stacking bound
 * for EVERY model — known or not — is the single field. Fallback: absent
 * field => 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = mkdtempSync(path.join(os.tmpdir(), 'saga-frozen-admission-'));
const dbPath = path.join(root, 'factory.sqlite');
process.env.DB_PATH = dbPath;

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { closeDb, getDb } = await import('../../dist/db.js');
const {
  SqliteEpisodeRuntimeRepository,
} = await import('../../dist/infrastructure/persistence/sqlite-factory-runtime-repositories.js');
const { distributeQueuedTasks } = await import('../../dist/app/dispatch-loop.js');

const seed = new Database(dbPath);
seed.exec(SCHEMA_SQL);
seed.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
seed.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,1,'e7'),(8,1,'e8'),(9,1,'e9'),(10,1,'e10')").run();
seed.close();
const repository = new SqliteEpisodeRuntimeRepository();

function setControls(epicId, { concurrency = 5, model = 'glm-4.7', provider = 'zai' } = {}) {
  getDb().prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency,model_provider,model_name,model_effort)
     VALUES (?,?,?,?,?)
     ON CONFLICT(epic_id) DO UPDATE SET
       concurrency=excluded.concurrency,
       model_provider=excluded.model_provider,
       model_name=excluded.model_name`,
  ).run(epicId, concurrency, provider, model, 'high');
}

let execSeq = 0;
function insertActiveExecution(epicId, frozenModel) {
  execSeq += 1;
  const metadata = frozenModel === undefined
    ? '{}'
    : JSON.stringify({
      execution_context: {
        model_route: { provider: 'zai', model: frozenModel, effort: 'high' },
      },
    });
  getDb().prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata)
     VALUES (?,?,1,?,?,?,?, 'running','executing',?)`,
  ).run(`e-${epicId}-${execSeq}`, 'r', epicId, execSeq, `w${execSeq}`, 'host', metadata);
}

test('the single field binds: 8 frozen workers block the 9th spawn under ceiling 8', () => {
  // Epic 7: 8 workers frozen on glm-4.7; the field says 8 — no 9th slot.
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  insertActiveExecution(7, 'glm-4.7');
  setControls(7, { concurrency: 8, model: 'glm-4.7' });

  const admission = repository.readConcurrencyAdmission(7);
  assert.equal(admission.activeExecutions, 8);
  assert.equal(admission.requestedModel, 'glm-4.7');
  assert.deepEqual(admission.activeByModel, { 'glm-4.7': 8 });
  assert.equal(admission.requestedModelLimit, 8,
    'one-entry law: the reported per-model bound IS the field');
  assert.equal(admission.modelSlotsAvailable, false,
    '8 frozen executions leave no slot under the single ceiling 8');
});

test('per-model anti-stacking admits exactly up to the single field, regardless of catalog', () => {
  // Epic 8: mixed in-flight models; the field (5) is the only bound.
  insertActiveExecution(8, 'glm-5.2');
  insertActiveExecution(8, 'glm-4.7');
  setControls(8, { concurrency: 5, model: 'glm-4.7' });

  const first = repository.readConcurrencyAdmission(8);
  assert.deepEqual(first.activeByModel, { 'glm-5.2': 1, 'glm-4.7': 1 });
  assert.equal(first.requestedModelLimit, 5);
  assert.equal(first.modelSlotsAvailable, true);

  insertActiveExecution(8, 'glm-4.7');
  insertActiveExecution(8, 'glm-4.7');
  insertActiveExecution(8, 'glm-4.7');
  insertActiveExecution(8, 'glm-4.7');
  const second = repository.readConcurrencyAdmission(8);
  assert.deepEqual(second.activeByModel, { 'glm-5.2': 1, 'glm-4.7': 5 });
  assert.equal(second.modelSlotsAvailable, false,
    '5 glm-4.7 executions exhaust the single ceiling 5 (no catalog arithmetic)');
});

test('an unknown requested model is bounded by the same single field', () => {
  // Epic 9: a model that is NOT in the catalog — same bound, no special case.
  insertActiveExecution(9, 'glm-9.9');
  setControls(9, { concurrency: 3, model: 'glm-9.9' });

  const first = repository.readConcurrencyAdmission(9);
  assert.equal(first.requestedModelLimit, 3,
    'unknown or not — the bound is the field');
  assert.equal(first.modelSlotsAvailable, true);

  insertActiveExecution(9, 'glm-9.9');
  insertActiveExecution(9, 'glm-9.9');
  const second = repository.readConcurrencyAdmission(9);
  assert.equal(second.modelSlotsAvailable, false,
    '3 actives exhaust the field ceiling 3');
});

test('legacy executions without an execution context count under the unfrozen bucket and against the field', () => {
  // Epic 10: one pre-D1.1 execution with no execution_context in metadata.
  insertActiveExecution(10, undefined);
  setControls(10, { concurrency: 4, model: 'glm-4.7' });

  const admission = repository.readConcurrencyAdmission(10);
  assert.deepEqual(admission.activeByModel, { '(unfrozen)': 1 });
  assert.equal(admission.requestedModel, 'glm-4.7');
  assert.equal(admission.modelSlotsAvailable, true,
    'the unfrozen bucket never consumes per-model slots; the field still counts the execution (active=1 < 4)');
});

// --- Consumer wiring: the dispatch loop must treat modelSlotsAvailable=false
// as a normal capacity condition (no spawn), not an error.
function makeIdGenerator() {
  let n = 0;
  return { newId: () => `id-${++n}`, newTypedId: prefix => `${prefix}-${++n}` };
}

test('dispatch loop refuses to spawn when the frozen-limit aggregation blocks admission', async () => {
  const spawns = [];
  const factory = () => {
    spawns.push(1);
    return {
      start() {
        return { id: 'run', project_id: 42, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
      },
      stop() {},
      status() { return { id: 'run', project_id: 42, concurrency: 1, status: 'completed', active: [], completed: 1, failed: 0, claimed: 1 }; },
      setConcurrency() {},
      dispose() {},
    };
  };
  let cards = 2;
  const dispatched = await distributeQueuedTasks({
    projectId: 42,
    epicId: 7,
    // Live ceiling would allow the spawn: 0 active < effective 4. ONLY the
    // frozen-limit aggregation (a mid-run rewrite scenario) blocks it.
    readConcurrencyAdmission: () => ({
      operatorConcurrency: 4,
      modelConcurrencyLimit: 4,
      effectiveConcurrency: 4,
      activeExecutions: 0,
      requestedModel: 'glm-4.7',
      activeByModel: { 'glm-4.7': 2 },
      requestedModelLimit: 2,
      modelSlotsAvailable: false,
    }),
    workerExecutorFactory: factory,
    workAssignment: {
      assignTask() {
        if (cards === 0) return null;
        cards -= 1;
        return {
          taskId: 1000 + cards, epicId: 7, projectId: 42, status: 'in_progress', skill: 'saga-worker',
          workerExecutionId: `exec-${cards}`, fenceToken: `exec-${cards}`, runId: 'r', workerId: `w${cards}`,
          machineId: 'test-host', repository: null, executionContext: null,
        };
      },
      countClaimable: () => cards,
      releaseAssignment: () => {},
    },
    idGenerator: makeIdGenerator(),
    machineId: 'test-host',
    pollMs: 1,
    factoryContext: {
      projectId: 42, epicId: 7, workspaceRoot: '/tmp/ws', dbPath: '/tmp/db.sqlite',
      sagaEntry: '/tmp/entry', sagaSkillRoot: '/tmp/skills', claudePath: 'node',
      lmStudioUrl: 'http://localhost:1234',
    },
  });
  assert.equal(dispatched, 0, 'a frozen-limit-blocked admission spawns nothing');
  assert.equal(spawns.length, 0, 'the executor factory is never invoked');
});

test.after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
