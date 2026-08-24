import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = mkdtempSync(path.join(os.tmpdir(), 'saga-concurrency-admission-'));
const dbPath = path.join(root, 'factory.sqlite');
process.env.DB_PATH = dbPath;

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { closeDb, getDb } = await import('../../dist/db.js');
const {
  SqliteEpisodeRuntimeRepository,
} = await import('../../dist/infrastructure/persistence/sqlite-factory-runtime-repositories.js');

const seed = new Database(dbPath);
seed.exec(SCHEMA_SQL);
seed.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
seed.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,1,'e7'),(8,1,'e8')").run();
seed.close();
const repository = new SqliteEpisodeRuntimeRepository();

test('concurrency admission is min(operator, exact model quota) and counts durable active executions', () => {
  getDb().prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
     VALUES (7,5,'zai','glm-4.7','high',2)`,
  ).run();
  getDb().prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES
       ('e-running','r',1,7,1,'w1','host','running','executing'),
       ('e-reserved','r',1,7,2,'w2','host','reserved','reviewing'),
       ('e-terminal','r',1,7,3,'w3','host','exited','finishing')`,
  ).run();

  assert.deepEqual(repository.readConcurrencyAdmission(7), {
    operatorConcurrency: 5,
    modelConcurrencyLimit: 2,
    effectiveConcurrency: 2,
    activeExecutions: 2,
    // One-entry law (2026-08-24): the panel field is the single ceiling; the
    // anti-stack bound for every model is that same ceiling.
    requestedModel: 'glm-4.7',
    activeByModel: { '(unfrozen)': 2 },
    requestedModelLimit: 2,
    modelSlotsAvailable: true,
  });
});

test('concurrency admission fails closed for a missing policy row', () => {
  assert.throws(
    () => repository.readConcurrencyAdmission(99),
    /CONCURRENCY_POLICY_MISSING/,
  );
});

test('concurrency admission fails closed when operator or model policy is missing', () => {
  getDb().prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
     VALUES (8,NULL,'zai','glm-4.7','high',NULL)`,
  ).run();
  assert.throws(() => repository.readConcurrencyAdmission(8), /CONCURRENCY_POLICY_INVALID/);
});

test.after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
