import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSqliteProductionCellProjectionPersistence } from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { SCHEMA_SQL } from '../../dist/schema.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (1, 'stage', 'active')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name, status) VALUES (1, 1, 'REQ-001', 'planned')`).run();
  return db;
}

function insertAcceptedAc(db, title) {
  const info = db.prepare(
    `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status)
     VALUES (1, 1, 'AC', ?, ?, 'docs/ac.md', 'accepted')`,
  ).run(title.split(':')[0].trim(), title);
  return Number(info.lastInsertRowid);
}

function planInput(taskOverrides) {
  const objective = 'development-implementation/author: Fan out validated implementation items.';
  return {
    intent: {
      epicId: 1,
      kind: 'development.implementation',
      objective,
      authorityScope: {
        snapshot_ref: 'workplace/1/test@1/cell/key',
        scope: 'profile',
        allowed_tools: [],
        enforcement: 'runtime',
      },
      outputSchema: 'factory.development.implementation-result/1.0.0',
      tokenBudget: 0,
      retryBudget: 2,
    },
    task: {
      epicId: 1,
      projectId: 1,
      objective,
      taskKind: 'development.code',
      executionSkill: 'development-implementation-worker',
      reviewSkill: null,
      generationKey: 'gen-1',
      titlePrefix: 'development-implementation/author: ',
      ...taskOverrides,
    },
  };
}

function titleOf(db, taskId) {
  return db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId).title;
}

test('fan-out task title is the item subject, not the shared cell objective', () => {
  const db = createDb();
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const plan = persistence.ensureExecutionPlan(planInput({
    titleSubject: 'impl-physics-core (author)',
  }));
  assert.equal(titleOf(db, plan.taskId), 'impl-physics-core (author)');
});

test('verification.ac task title is derived from its frozen AC artifact', () => {
  const db = createDb();
  const acId = insertAcceptedAc(db, 'AC-3: Successful Docking Detection');
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const plan = persistence.ensureExecutionPlan(planInput({
    taskKind: 'verification.ac',
    workflowStage: 'verification',
    sourceArtifactIds: [acId],
    verificationTargetArtifactId: acId,
  }));
  assert.equal(titleOf(db, plan.taskId), 'verify AC-3: Successful Docking Detection');
});

test('without a subject the legacy prefix+truncate title is preserved byte-exact', () => {
  const db = createDb();
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const plan = persistence.ensureExecutionPlan(planInput());
  assert.equal(
    titleOf(db, plan.taskId),
    'development-implementation/author: Fan out validated implementation items.',
  );
});

test('re-projection with a titleSubject stays replay-safe and never rewrites the title', () => {
  const db = createDb();
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const first = persistence.ensureExecutionPlan(planInput());
  const legacyTitle = titleOf(db, first.taskId);
  const second = persistence.ensureExecutionPlan(planInput({
    titleSubject: 'impl-physics-core (author)',
  }));
  assert.equal(second.replayed, true);
  assert.equal(second.taskId, first.taskId);
  assert.equal(titleOf(db, second.taskId), legacyTitle);
});
