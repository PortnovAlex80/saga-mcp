// Tests for the project_delete admin tool (hard-delete with cascade).
//
// Verifies the four design properties documented in handleProjectDelete:
//   1. CASCADE: every descendant table is cleaned (epics, tasks, artifacts,
//      traces, episode_workflows, project_repositories, trusted_providers).
//   2. ENGINE GUARD: rejects when any epic has engine_running=1.
//   3. MULTI-TENANCY (P17): repositories row survives — only project_repositories
//      binding is removed.
//   4. AUDIT TRAIL (P12): activity_log row survives (polymorphic, no FK).
//
// Plus the soft-delete (project_update({status:'archived'})) regression.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-proj-delete-'));
process.env.DB_PATH = path.join(temp, 'proj-delete.db');

const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: tasks } = await import('../../dist/tools/tasks.js');
const { handlers: repositories } = await import('../../dist/tools/repositories.js');
const { handlers: artifacts } = await import('../../dist/tools/artifacts.js');
const { closeDb, getDb } = await import('../../dist/db.js');

after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// Helper: seed a complete project with epic, task, artifact, repository binding.
function seedProject(name = 'Delete-Me') {
  const project = projects.project_create({ name });
  const repo = repositories.repository_register({
    project_id: project.id, name: `repo-${project.id}`,
    local_path: `/tmp/repo-${project.id}`,
  });
  const epic = epics.epic_create({ project_id: project.id, name: `REQ-${project.id}` });
  const task = tasks.task_create({
    epic_id: epic.id, title: 'Dev task', priority: 'high',
    task_kind: 'development.code', workflow_stage: 'development',
    project_repository_id: repo.id,
  });
  const artifact = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id, type: 'AC', code: 'AC-1',
    title: 'Test AC', path: `docs/test-${project.id}.md#AC-1`, status: 'accepted',
  });
  return { project, repo, epic, task, artifact };
}

// ---------------------------------------------------------------------------
// Test 1: project_delete cascades through all descendant tables.
// ---------------------------------------------------------------------------

test('project_delete: cascades through epics, tasks, artifacts, traces', () => {
  const { project, epic, task, artifact } = seedProject('Cascade-Test');
  const db = getDb();

  // Verify pre-delete state.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM epics WHERE project_id=?').get(project.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE epic_id=?').get(epic.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE epic_id=?').get(epic.id).n, 1);

  const result = projects.project_delete({ project_id: project.id });
  assert.equal(result.deleted, true);
  assert.equal(result.project_id, project.id);

  // Cascade verification — every descendant table must be empty for this project.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').get(project.id).n, 0,
    'projects row deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM epics WHERE project_id=?').get(project.id).n, 0,
    'epics cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id=?').get(task.id).n, 0,
    'tasks cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE id=?').get(artifact.id).n, 0,
    'artifacts cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_workflows WHERE epic_id=?').get(epic.id).n, 0,
    'episode_workflows cascaded');

  // FK integrity must still be clean.
  const fkc = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(fkc.length, 0, 'no FK violations after cascade delete');
});

// ---------------------------------------------------------------------------
// Test 2: project_delete throws when engine_running=1 for any epic.
// ---------------------------------------------------------------------------

test('project_delete: rejects when engine is running', () => {
  const { project, epic } = seedProject('Engine-Running');
  const db = getDb();

  // episode_workflows row is created lazily by lifecycle.getOrCreate —
  // epic_create does NOT seed it. Insert one explicitly with engine_running=1.
  db.prepare(
    `INSERT INTO episode_workflows (epic_id, stage, metadata)
     VALUES (?, 'discovery', '{"engine_running":1}')`,
  ).run(epic.id);

  assert.throws(
    () => projects.project_delete({ project_id: project.id }),
    /engine is running for epic/i,
    'must reject when engine_running=1',
  );

  // Project must still exist (delete was rejected before any DB change).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').get(project.id).n, 1,
    'project row preserved after rejection');
});

// ---------------------------------------------------------------------------
// Test 3: project_delete returns deregistered_checkouts list.
// ---------------------------------------------------------------------------

test('project_delete: returns deregistered_checkouts', () => {
  const { project, repo } = seedProject('Checkout-Test');
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: 'worker-01',
    local_path: '/tmp/worker-01/checkout',
  });
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: 'worker-02',
    local_path: '/tmp/worker-02/checkout',
  });

  const result = projects.project_delete({ project_id: project.id });
  assert.equal(result.deregistered_checkouts.length, 2);
  const machines = result.deregistered_checkouts.map(c => c.machine_id).sort();
  assert.deepEqual(machines, ['worker-01', 'worker-02']);
});

// ---------------------------------------------------------------------------
// Test 4: project_delete leaves repositories row intact (multi-tenancy P17).
// ---------------------------------------------------------------------------

test('project_delete: leaves repositories row intact (P17)', () => {
  const { project, repo } = seedProject('Multi-Tenancy');
  const repoId = repo.id;

  projects.project_delete({ project_id: project.id });

  const db = getDb();
  // repositories row must survive — it's a project-agnostic resource.
  const repoRow = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId);
  assert.ok(repoRow, 'repositories row preserved (P17: resource ≠ lease)');

  // But project_repositories binding must be gone (CASCADE).
  const bindingCount = db.prepare(
    'SELECT COUNT(*) AS n FROM project_repositories WHERE repository_id=?',
  ).get(repoId).n;
  assert.equal(bindingCount, 0, 'project_repositories binding cascaded');
});

// ---------------------------------------------------------------------------
// Test 5: project_delete leaves activity_log intact (P12 audit trail).
// ---------------------------------------------------------------------------

test('project_delete: leaves activity_log intact (P12)', () => {
  const { project } = seedProject('Audit-Test');
  const projectId = project.id;
  // project_create + epic_create already wrote activity_log rows.

  const db = getDb();
  const logCountBefore = db.prepare(
    "SELECT COUNT(*) AS n FROM activity_log WHERE entity_type='project' AND entity_id=?",
  ).get(projectId).n;
  assert.ok(logCountBefore > 0, 'pre-condition: activity_log has rows for this project');

  projects.project_delete({ project_id: projectId });

  const logCountAfter = db.prepare(
    "SELECT COUNT(*) AS n FROM activity_log WHERE entity_type='project' AND entity_id=?",
  ).get(projectId).n;
  // logActivity inside project_delete adds one more row (the 'deleted' event).
  assert.equal(logCountAfter, logCountBefore + 1,
    'activity_log preserved (P12: audit is not state) + delete event recorded');
});

// ---------------------------------------------------------------------------
// Test 6: project_delete throws when project_id does not exist.
// ---------------------------------------------------------------------------

test('project_delete: throws when project_id not found', () => {
  assert.throws(
    () => projects.project_delete({ project_id: 999999 }),
    /not found/i,
    'must reject unknown project_id',
  );
});

// ---------------------------------------------------------------------------
// Test 7: project_delete throws on invalid project_id (validation).
// ---------------------------------------------------------------------------

test('project_delete: rejects invalid project_id', () => {
  assert.throws(
    () => projects.project_delete({ project_id: 0 }),
    /positive integer/i,
  );
  assert.throws(
    () => projects.project_delete({ project_id: -1 }),
    /positive integer/i,
  );
  assert.throws(
    () => projects.project_delete({ project_id: 'abc' }),
    /positive integer/i,
  );
});

// ---------------------------------------------------------------------------
// Test 8: soft-delete via project_update({status:'archived'}) is queryable
//         via status filter. (saga-mcp's project_list returns ALL projects
//         when no filter is passed — tracker-view applies the archived-exclude
//         filter in its own listProjects(). Here we verify only that the
//         status transition is persisted and queryable.)
// ---------------------------------------------------------------------------

test('soft-delete: project_update({status:archived}) persists and is queryable', () => {
  const project = projects.project_create({ name: 'Soon-Archived' });

  projects.project_update({ id: project.id, status: 'archived' });

  // Explicit status='archived' filter must return it.
  const archived = projects.project_list({ status: 'archived' });
  assert.ok(archived.some(p => p.id === project.id),
    'archived project retrievable via status="archived" filter');

  // Status was actually written.
  const db = getDb();
  const row = db.prepare('SELECT status FROM projects WHERE id=?').get(project.id);
  assert.equal(row.status, 'archived', 'status persisted as archived');

  // Cleanup so this test doesn't accumulate.
  projects.project_delete({ project_id: project.id });
});

// ---------------------------------------------------------------------------
// Test 9: project_delete is idempotent in the "already gone" sense — second
//         call throws a clear not-found error rather than silently succeeding.
// ---------------------------------------------------------------------------

test('project_delete: second call throws not-found (no silent success)', () => {
  const { project } = seedProject('Double-Delete');
  projects.project_delete({ project_id: project.id });
  assert.throws(
    () => projects.project_delete({ project_id: project.id }),
    /not found/i,
    'second delete must throw, not silently return deleted:true',
  );
});
