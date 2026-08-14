import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import {
  activateProductionCellRoleTask,
} from '../../dist/lifecycle/work-assignment-core.js';

function setup(allowedTools, metadata = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      metadata TEXT NOT NULL,
      workplace_ref TEXT,
      status TEXT NOT NULL,
      assigned_to TEXT,
      current_execution_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE factory_work_intents (
      id INTEGER PRIMARY KEY,
      authority_scope TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO tasks(id,metadata,status)
     VALUES (1,?,'done')`,
  ).run(JSON.stringify(metadata));
  db.prepare(
    `INSERT INTO factory_work_intents(id,authority_scope)
     VALUES (7,?)`,
  ).run(JSON.stringify({
    snapshot_ref: 'workplace/1/formalization/cell/default',
    scope: 'profile',
    allowed_tools: allowedTools,
    enforcement: 'runtime',
  }));
  return db;
}

function activate(db, overrides = {}) {
  activateProductionCellRoleTask(db, {
    taskId: 1,
    intentId: 7,
    workplaceRef: 'workplace/1/formalization/cell/default',
    role: 'author',
    executionProfileId: 'profile',
    ...overrides,
  });
  const row = db.prepare('SELECT metadata,status FROM tasks WHERE id=1').get();
  return {
    metadata: JSON.parse(row.metadata),
    status: row.status,
  };
}

test('activation keeps physical ingress out of disposable task metadata', () => {
  const db = setup(['artifact_create', 'artifact_update', 'trace_add', 'worker_done']);
  try {
    const result = activate(db);
    assert.equal(result.metadata.product_source, undefined);
    assert.equal(result.status, 'todo');
  } finally {
    db.close();
  }
});

test('typed WorkIntent activation also keeps ingress out of task metadata', () => {
  const db = setup(['product_submit', 'worker_done']);
  try {
    const result = activate(db);
    assert.equal(result.metadata.product_source, undefined);
  } finally {
    db.close();
  }
});

test('reviewer activation cannot inherit an obsolete task ingress projection', () => {
  const db = setup(
    ['candidate_read', 'product_read', 'product_submit', 'worker_done'],
    {},
  );
  try {
    const result = activate(db, { role: 'reviewer' });
    assert.equal(result.metadata.product_source, undefined);
    assert.equal(result.status, 'review');
  } finally {
    db.close();
  }
});

test('production composition derives ingress only from the frozen WorkIntent', () => {
  const source = readFileSync(
    new URL('../../src/app/product-lifecycle-runtime.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /productionIngressModeFromAuthorityScope/);
  assert.doesNotMatch(source, /productSource|product_source|requireTypedSubmission/);
});

test('structured hook tells the worker to use the exact tracker instead of forbidding it', () => {
  const source = readFileSync(
    new URL('../../tracker-view/structured-context-hook.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /Do not parse Markdown trackers/);
  assert.match(source, /Read only the exact tracker path they provide/);
  assert.match(source, /do not discover trackers by scanning docs or guessing paths/);
});
