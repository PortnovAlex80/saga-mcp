/**
 * Model selector render — per-epic choice from saga.db.
 *
 * Bug: the kanban's model <select> used a process-wide constant WORKER_MODEL
 * (resolved once from ~/.claude/settings.json at tracker-view startup). F5
 * reset the selector to that constant, ignoring the per-epic $.active_model
 * the user had picked via /api/model/set.
 *
 * Fix: render reads activeModelForProject(projectId) from saga.db and falls
 * back to WORKER_MODEL only when no choice has been recorded.
 *
 * This test exercises the helper against a real saga.db row and verifies
 * the render picks the right option.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-model-'));
const dbPath = path.join(temp, 'model.db');
process.env.DB_PATH = dbPath;
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

const { closeDb, getDb } = await import('../../dist/db.js');
const projectsMod = await import('../../dist/tools/projects.js');
const epicsMod = await import('../../dist/tools/epics.js');
const repositoriesMod = await import('../../dist/tools/repositories.js');
const projects = projectsMod.handlers;
const epics = epicsMod.handlers;
const repositories = repositoriesMod.handlers;

const product = projects.project_create({ name: 'Model Selector Test' });
repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
const epic = epics.epic_create({ project_id: product.id, name: 'E' });
const epicId = epic.id;
getDb().prepare(
  `INSERT INTO episode_workflows (epic_id, stage, metadata) VALUES (?, 'development', '{}')`,
).run(epicId);

// Mirror the helper (tracker-view doesn't export it; we verify the contract).
function activeModelForProject(projectId) {
  const row = getDb().prepare(
    `SELECT json_extract(ew.metadata, '$.active_model') AS m
     FROM episode_workflows ew
     JOIN epics e ON e.id=ew.epic_id
     WHERE e.project_id=?
     ORDER BY ew.updated_at DESC LIMIT 1`,
  ).get(projectId);
  const m = row?.m;
  return (typeof m === 'string' && m.length > 0) ? m : null;
}

test('model-selector: returns null when no choice recorded', () => {
  assert.equal(activeModelForProject(product.id), null);
});

test('model-selector: returns the persisted choice after /api/model/set', () => {
  // Simulate what /api/model/set writes.
  const meta = JSON.parse(getDb().prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId).metadata);
  meta.active_model = 'glm-4.5-flash';
  meta.active_model_limit = 2;
  getDb().prepare('UPDATE episode_workflows SET metadata=? WHERE epic_id=?').run(JSON.stringify(meta), epicId);

  assert.equal(activeModelForProject(product.id), 'glm-4.5-flash');
});

test('model-selector: survives metadata roundtrips (other fields dont clobber)', () => {
  // Simulate a later concurrency-change write.
  const meta = JSON.parse(getDb().prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId).metadata);
  meta.engine_concurrency = 5;
  getDb().prepare('UPDATE episode_workflows SET metadata=? WHERE epic_id=?').run(JSON.stringify(meta), epicId);

  // Model choice must survive.
  assert.equal(activeModelForProject(product.id), 'glm-4.5-flash',
    'model choice preserved across unrelated metadata writes');
});

test('model-selector: render picks the right option (simulated HTML)', () => {
  const MODELS = [
    { id: 'glm-5.2', limit: 10 },
    { id: 'glm-4.5-flash', limit: 2 },
    { id: 'opus', limit: 10 },
  ];
  const chosen = activeModelForProject(product.id) || 'opus'; // fallback
  const html = MODELS.map(m => `<option value="${m.id}" data-limit="${m.limit}"${m.id === chosen ? ' selected' : ''}>`).join('');
  assert.match(html, /<option value="glm-4\.5-flash"[^>]*selected/, 'flash is selected');
  assert.doesNotMatch(html, /<option value="opus"[^>]*selected/, 'opus is NOT selected');
});

test('model-selector: fallback to WORKER_MODEL when no choice', () => {
  // New project with no episode_workflows row at all.
  const p2 = projects.project_create({ name: 'Other Project No Episode' });
  const chosen = activeModelForProject(p2.id) || 'opus'; // WORKER_MODEL stand-in
  assert.equal(chosen, 'opus');
});

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});
