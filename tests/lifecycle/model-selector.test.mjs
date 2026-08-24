/**
 * Model selector and model-cap policy use lifecycle_execution_controls and the
 * one compiled Factory model catalog. Retired episode_workflows metadata is not
 * an execution-policy authority.
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
const {
  FACTORY_CLOUD_MODELS,
  factoryModelProfile,
} = await import('../../dist/runtime/factory-model-profiles.js');
const projects = projectsMod.handlers;
const epics = epicsMod.handlers;
const repositories = repositoriesMod.handlers;

const product = projects.project_create({ name: 'Model Selector Test' });
repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
const epic = epics.epic_create({ project_id: product.id, name: 'E' });
const epicId = epic.id;
function activeModelForProject(projectId) {
  const row = getDb().prepare(
    `SELECT c.model_name AS m
     FROM lifecycle_execution_controls c
     JOIN epics e ON e.id=c.epic_id
     WHERE e.project_id=?
     ORDER BY c.updated_at DESC LIMIT 1`,
  ).get(projectId);
  const m = row?.m;
  return (typeof m === 'string' && m.length > 0) ? m : null;
}

test('model-selector: returns null when no choice recorded', () => {
  assert.equal(activeModelForProject(product.id), null);
});

test('model-selector: returns the persisted choice after /api/model/set', () => {
  const profile = factoryModelProfile('glm-4.7');
  getDb().prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency,model_provider,model_name,model_effort)
     VALUES (?,?,?,?,?)`,
  ).run(epicId, 2, profile.provider, profile.id, profile.effort);

  assert.equal(activeModelForProject(product.id), 'glm-4.7');
});

test('model-selector: survives an unrelated concurrency update', () => {
  getDb().prepare(
    `UPDATE lifecycle_execution_controls SET concurrency=1 WHERE epic_id=?`,
  ).run(epicId);
  assert.equal(activeModelForProject(product.id), 'glm-4.7',
    'model choice preserved across unrelated control writes');
});

test('model-selector: render picks the right option (simulated HTML)', () => {
  const chosen = activeModelForProject(product.id) || 'opus'; // fallback
  const html = FACTORY_CLOUD_MODELS.map(m => `<option value="${m.id}" data-limit="${m.limit}"${m.id === chosen ? ' selected' : ''}>`).join('');
  assert.match(html, /<option value="glm-4\.7"[^>]*selected/, 'glm-4.7 is selected');
  assert.doesNotMatch(html, /<option value="opus"[^>]*selected/, 'opus is NOT selected');
});

test('model-selector: canonical GLM-4.7 limit is exactly 2', () => {
  assert.equal(factoryModelProfile('glm-4.7').limit, 2);
  assert.equal(FACTORY_CLOUD_MODELS.filter(model => model.id === 'glm-4.7').length, 1);
});

test('model-selector: fallback to WORKER_MODEL when no choice', () => {
  // New project with no lifecycle_execution_controls row at all.
  const p2 = projects.project_create({ name: 'Other Project No Episode' });
  const chosen = activeModelForProject(p2.id) || 'opus'; // WORKER_MODEL stand-in
  assert.equal(chosen, 'opus');
});

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});
