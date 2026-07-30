// End-to-end integration: prepareProcessExecutionWorkspace must OVERWRITE the
// freshly-materialized placeholder task-graph template with a DB-backed
// complete proposal skeleton when the module is Development and the DB has
// accepted ACs + an active repository binding.
//
// The machine-fill directly addresses the two planner bugs:
//   1. AC-15 and AC-16 were dropped (the LM treated them as verification-only
//      and skipped implementation items).
//   2. The wrong projectRepositoryId was emitted.
//
// getDb() caches a process-wide singleton, so the workspace materializer runs
// in a child process (fixtures/machine-fill-child.mjs) with its own DB_PATH to
// keep DB state hermetic.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';

const CHILD_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'machine-fill-child.mjs',
);

function makeTempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-machiefill-e2e-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return { dir, dbPath, db };
}

function seed(db) {
  db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
  const projectId = db.prepare("SELECT id FROM projects WHERE name='p'").get().id;
  db.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'e')").run(projectId);
  const epicId = db.prepare("SELECT id FROM epics WHERE name='e'").get().id;
  db.prepare("INSERT INTO repositories (name, default_branch) VALUES ('r','main')").run();
  const repoId = db.prepare('SELECT id FROM repositories ORDER BY id DESC LIMIT 1').get().id;
  db.prepare(
    `INSERT INTO project_repositories (project_id, repository_id, integration_branch, status)
     VALUES (?, ?, 'dev', 'active')`,
  ).run(projectId, repoId);
  const prId = db.prepare(
    'SELECT id FROM project_repositories WHERE project_id=? ORDER BY id DESC LIMIT 1',
  ).get(projectId).id;
  // 16 accepted ACs, including AC-15 and AC-16 (the double-digit tail that the
  // LM historically dropped).
  for (let i = 1; i <= 16; i++) {
    db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status)
       VALUES (?, ?, 'AC', ?, ?, ?, 'accepted')`,
    ).run(projectId, epicId, 'AC-' + i, 'AC-' + i + ' title', 'docs/ac' + i + '.md');
  }
  return { projectId, epicId, prId };
}

function runChild(mode, dbPath, workspaceRoot, projectId, epicId) {
  return spawnSync(process.execPath, [CHILD_SCRIPT, mode, workspaceRoot, String(projectId), String(epicId)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PATH: dbPath,
    },
    windowsHide: true,
  });
}

test('prepareProcessExecutionWorkspace replaces the placeholder template with a complete DB-backed skeleton', () => {
  const { dir, dbPath, db } = makeTempDb();
  let workspaceRoot;
  try {
    const { projectId, epicId, prId } = seed(db);
    db.close();

    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'saga-ws-'));
    const r = runChild('fresh', dbPath, workspaceRoot, projectId, epicId);
    assert.equal(r.status, 0, 'child failed: ' + (r.stderr || r.stdout));
    const call = JSON.parse(r.stdout);

    // No FILL_ placeholders survived.
    const serialized = JSON.stringify(call);
    assert.ok(!serialized.includes('FILL_'), 'placeholder token survived the machine-fill');

    // Bug #1: AC-15 and AC-16 have implementation AND verification items.
    assert.equal(call.arguments.payload.implementationItems.length, 16, 'one impl per AC');
    assert.equal(call.arguments.payload.verificationItems.length, 16, 'one verify per AC');

    // Bug #2: the REAL repository id from the DB, not a placeholder.
    for (const item of call.arguments.payload.implementationItems) {
      assert.equal(item.projectRepositoryId, prId, 'impl item repo id is the real DB id');
    }
    for (const item of call.arguments.payload.verificationItems) {
      assert.equal(item.projectRepositoryId, prId, 'verify item repo id is the real DB id');
    }
    assert.equal(call.arguments.payload.integrationTargets[0].projectRepositoryId, prId);
    assert.equal(call.arguments.payload.integrationTargets[0].targetBranch, 'dev');
  } finally {
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    if (workspaceRoot) {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* */ }
    }
  }
});

test('prepareProcessExecutionWorkspace preserves a carry-over draft and does NOT machine-fill it', () => {
  const { dir, dbPath, db } = makeTempDb();
  let workspaceRoot;
  try {
    const { projectId, epicId } = seed(db);
    db.close();

    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'saga-ws-co-'));
    const r = runChild('carry', dbPath, workspaceRoot, projectId, epicId);
    assert.equal(r.status, 0, 'child failed: ' + (r.stderr || r.stdout));
    const call = JSON.parse(r.stdout);
    assert.equal(call.preserved_carry_over, true, 'carry-over draft must be preserved');
    assert.equal(call.machine_filled, false, 'machine-fill must not clobber a carry-over draft');
    assert.equal(call.implementationItems, undefined, 'no DB skeleton was written over the draft');
  } finally {
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    if (workspaceRoot) {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* */ }
    }
  }
});
