// Machine-fill of the Development task-graph submit template.
//
// Regression coverage for the two planner bugs the machine-fill exists to fix:
//   1. AC-15 and AC-16 were dropped (the LM treated them as verification-only
//      and skipped implementation items).
//   2. The wrong projectRepositoryId was emitted.
//
// The pure builder under test reads DB state (accepted ACs + active repository
// bindings) and emits a COMPLETE proposal skeleton, so it can be exercised
// directly with an in-memory DB — no workspace materialization needed.

import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  buildDevelopmentTaskGraphSubmitCall,
  machineFillPlanningTemplate,
} from '../../dist/process-modules/application/process-execution-workspace.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedEpic(db) {
  db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
  const projectId = db.prepare("SELECT id FROM projects WHERE name='p'").get().id;
  db.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'e')").run(projectId);
  const epicId = db.prepare("SELECT id FROM epics WHERE name='e'").get().id;
  return { projectId, epicId };
}

function insertAc(db, projectId, epicId, code, status = 'accepted') {
  db.prepare(
    `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status)
     VALUES (?, ?, 'AC', ?, ?, ?, ?)`,
  ).run(projectId, epicId, code, `${code} title`, `docs/${code}.md`, status);
  return db.prepare('SELECT id FROM artifacts WHERE code=?').get(code).id;
}

function insertRepo(db, projectId, integrationBranch = 'dev', localPath = null) {
  db.prepare(
    `INSERT INTO repositories (name, default_branch) VALUES (?, 'main')`,
  ).run(`repo-${projectId}`);
  const repoId = db.prepare('SELECT id FROM repositories ORDER BY id DESC LIMIT 1').get().id;
  db.prepare(
    `INSERT INTO project_repositories (project_id, repository_id, integration_branch, local_path, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).run(projectId, repoId, integrationBranch, localPath);
  return db.prepare(
    'SELECT id FROM project_repositories WHERE project_id=? ORDER BY id DESC LIMIT 1',
  ).get(projectId).id;
}

test('machine-fill emits one implementation AND one verification item for every accepted AC including AC-15/AC-16', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  const repoId = insertRepo(db, projectId);
  // 16 ACs — the regression only surfaced once codes crossed into double digits.
  for (let i = 1; i <= 16; i++) {
    insertAc(db, projectId, epicId, `AC-${i}`);
  }

  const result = buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId);
  assert.ok(result, 'expected a filled submit call');

  // Bug #1: AC-15 and AC-16 must each have an implementation item, not be
  // skipped as verification-only.
  const implIds = result.arguments.payload.implementationItems.flatMap(
    (item) => item.acceptanceCriterionIds,
  );
  const verifyIds = result.arguments.payload.verificationItems.flatMap(
    (item) => item.acceptanceCriterionIds,
  );
  assert.equal(implIds.length, 16, 'one implementation item per accepted AC');
  assert.equal(verifyIds.length, 16, 'one verification item per accepted AC (T-014)');

  const ac15 = db.prepare("SELECT id FROM artifacts WHERE code='AC-15'").get().id;
  const ac16 = db.prepare("SELECT id FROM artifacts WHERE code='AC-16'").get().id;
  assert.ok(implIds.includes(ac15), 'AC-15 has an implementation item');
  assert.ok(implIds.includes(ac16), 'AC-16 has an implementation item');
  assert.ok(verifyIds.includes(ac15), 'AC-15 has a verification item');
  assert.ok(verifyIds.includes(ac16), 'AC-16 has a verification item');
});

test('machine-fill uses the REAL repository id from the DB (Bug #2)', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  const repoId = insertRepo(db, projectId);
  insertAc(db, projectId, epicId, 'AC-1');

  const result = buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId);
  const impl = result.arguments.payload.implementationItems[0];
  const verify = result.arguments.payload.verificationItems[0];
  const target = result.arguments.payload.integrationTargets[0];

  assert.equal(impl.projectRepositoryId, repoId, 'implementation item repo id');
  assert.equal(verify.projectRepositoryId, repoId, 'verification item repo id');
  assert.equal(target.projectRepositoryId, repoId, 'integration target repo id');
});

test('machine-fill natural-sorts AC codes so AC-2 precedes AC-10', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  insertRepo(db, projectId);
  // Insert out of numeric order to prove the sort is not row-id based.
  insertAc(db, projectId, epicId, 'AC-10');
  insertAc(db, projectId, epicId, 'AC-2');
  insertAc(db, projectId, epicId, 'AC-1');

  const result = buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId);
  const implKeys = result.arguments.payload.implementationItems.map((i) => i.key);
  assert.deepEqual(
    implKeys,
    ['impl-ac-ac-1', 'impl-ac-ac-2', 'impl-ac-ac-10'],
    'lexical sort would put AC-10 before AC-2',
  );
});

test('machine-fill wires every verification item to its implementation dependency', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  insertRepo(db, projectId);
  insertAc(db, projectId, epicId, 'AC-1');
  insertAc(db, projectId, epicId, 'AC-2');

  const { arguments: { payload } } = buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId);
  for (const verify of payload.verificationItems) {
    assert.equal(verify.kind, 'verification');
    assert.equal(verify.taskKind, 'verification.ac');
    assert.equal(verify.executionSkill, 'saga-verifier');
    assert.equal(verify.executionMode, 'read_only_evidence');
    assert.equal(verify.acceptanceCriterionIds.length, 1, 'exactly one AC per verification item');
    assert.equal(verify.dependsOnKeys.length, 1, 'verification depends on its implementation item');
    const impl = payload.implementationItems.find(
      (i) => i.acceptanceCriterionIds[0] === verify.acceptanceCriterionIds[0],
    );
    assert.ok(impl, 'implementation item exists for the same AC');
    assert.deepEqual(verify.dependsOnKeys, [impl.key]);
    assert.equal(verify.projectRepositoryId, impl.projectRepositoryId);
  }
});

test('machine-fill integration target carries the real branch and implementation keys only', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  insertRepo(db, projectId, 'integration');
  insertAc(db, projectId, epicId, 'AC-1');

  const { arguments: { payload } } = buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId);
  const target = payload.integrationTargets[0];
  assert.equal(target.targetBranch, 'integration', 'branch copied verbatim from DB');
  assert.equal(
    target.sourceWorkItemKeys.length,
    payload.implementationItems.length,
    'only implementation keys feed the integration target',
  );
  for (const key of target.sourceWorkItemKeys) {
    const isImpl = payload.implementationItems.some((i) => i.key === key);
    const isVerify = payload.verificationItems.some((v) => v.key === key);
    assert.ok(isImpl, `integration source key ${key} is an implementation item`);
    assert.ok(!isVerify, `integration source key ${key} is NOT a verification item`);
  }
});

test('machine-fill returns null when no accepted ACs or no active repositories are bound', () => {
  // Case 1: no repo, no AC.
  {
    const db = makeDb();
    const { projectId, epicId } = seedEpic(db);
    assert.equal(buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId), null);
  }
  // Case 2: accepted AC but no active repository.
  {
    const db = makeDb();
    const { projectId, epicId } = seedEpic(db);
    insertAc(db, projectId, epicId, 'AC-1');
    assert.equal(buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId), null);
  }
  // Case 3: repo but only DRAFT ACs (none accepted).
  {
    const db = makeDb();
    const { projectId, epicId } = seedEpic(db);
    insertRepo(db, projectId);
    insertAc(db, projectId, epicId, 'AC-DRAFT', 'draft');
    assert.equal(buildDevelopmentTaskGraphSubmitCall(db, projectId, epicId), null);
  }
});

test('machineFillPlanningTemplate only fires for development modules with the task-graph call template', () => {
  const db = makeDb();
  const { projectId, epicId } = seedEpic(db);
  insertRepo(db, projectId);
  insertAc(db, projectId, epicId, 'AC-1');

  const devModule = { identity: { kind: 'development' } };
  const otherModule = { identity: { kind: 'formalization' } };
  const taskGraphProfile = {
    callTemplates: ['x/task-graph-submit-call-template.json'],
  };
  const otherProfile = { callTemplates: ['x/something-else.json'] };

  // Non-development module: never fires regardless of profile.
  assert.equal(
    machineFillPlanningTemplate(
      { module: otherModule, profile: taskGraphProfile, projectId, epicId },
      '/nonexistent-dir',
      true,
    ),
    null,
  );
  // Development module but profile lacks the task-graph template.
  assert.equal(
    machineFillPlanningTemplate(
      { module: devModule, profile: otherProfile, projectId, epicId },
      '/nonexistent-dir',
      true,
    ),
    null,
  );
  // Carry-over / replay guard: must not write when overwriteFreshPlaceholder is false.
  assert.equal(
    machineFillPlanningTemplate(
      { module: devModule, profile: taskGraphProfile, projectId, epicId },
      '/nonexistent-dir',
      false,
    ),
    null,
  );
});
