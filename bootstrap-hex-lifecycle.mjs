#!/usr/bin/env node
/**
 * Bootstrap a FRESH saga3 lifecycle DB + project/epic/repo for the HEX
 * Product Delivery lifecycle flow, configured for the GLM-4.7 cloud model.
 *
 * GLM-4.7 is routed globally via ~/.claude/settings.json
 * (ANTHROPIC_DEFAULT_OPUS_MODEL=glm-4.7, ANTHROPIC_BASE_URL=z.ai cloud). The
 * saga worker spawns `claude --model opus`, which claude resolves to glm-4.7
 * through settings.json. So episode_workflows needs active_provider='zai'
 * (default) and NO active_model override — the global settings win.
 *
 * Run: node bootstrap-hex-lifecycle.mjs
 * Then: see the printed orchestrate-cli command.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAGA_REPO_ROOT = 'D:/Разработка/saga-mcp';

// Fresh DB under tmp (isolated run — does not touch the real saga.db).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hex-glm-'));
const dbPath = path.join(tmp, 'saga.db');
const workspaceRoot = path.join(tmp, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });

// Set DB_PATH BEFORE importing getDb so the saga schema initializer runs
// against our fresh file (SCHEMA_SQL + all migrations).
process.env.DB_PATH = dbPath;
const { getDb, closeDb } = await import('./dist/db.js');

const PROJECT_NAME = 'Hex-Button-Autism-UI-GLM';
const PROJECT_DESC = 'React component library of hexagonal buttons optimized for autism spectrum users (GLM-4.7 lifecycle flow test).';
const EPIC_NAME = 'Hex Button Lifecycle (GLM-4.7)';

const db = getDb();

const tx = db.transaction(() => {
  const project = db.prepare(
    `INSERT INTO projects (name, description, status, tags) VALUES (?, ?, 'active', '[]') RETURNING *`,
  ).get(PROJECT_NAME, PROJECT_DESC);
  const projectId = project.id;

  const epic = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags)
     VALUES (?, ?, ?, 'planned', 'high', NULL, '[]') RETURNING *`,
  ).get(projectId, EPIC_NAME, PROJECT_DESC);
  const epicId = epic.id;

  const repo = db.prepare(
    `INSERT INTO repositories (name, remote_url, default_branch, metadata)
     VALUES (?, NULL, 'main', '{}') RETURNING *`,
  ).get('hex-ui-repo');
  const repoId = repo.id;

  db.prepare(
    `INSERT INTO project_repositories
       (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata)
     VALUES (?, ?, 'component', ?, 'dev', NULL, 'active', '{}')`,
  ).run(projectId, repoId, workspaceRoot);
  const projectRepoRow = db.prepare(
    `SELECT id FROM project_repositories WHERE project_id=? AND repository_id=?`,
  ).get(projectId, repoId);
  const projectRepoId = projectRepoRow.id;

  // episode_workflows: stage + GLM-4.7 model route.
  // active_provider='zai' (z.ai cloud) + active_model=null → worker spawns
  // `claude --model opus` → settings.json resolves opus→glm-4.7.
  // active_model_effort='high' for cloud reasoning quality.
  db.prepare(
    `INSERT INTO episode_workflows
       (epic_id, stage, track, baseline_artifact_id, baseline_hash, metadata, created_at, updated_at)
     VALUES (?, 'discovery', 'formal', NULL, NULL, ?, datetime('now'), datetime('now'))`,
  ).run(
    epicId,
    JSON.stringify({
      active_provider: 'zai',
      active_model: null,
      active_model_effort: 'high',
      active_model_limit: 2,
    }),
  );

  return { projectId, epicId, repoId, projectRepoId };
});

const result = tx();
closeDb();

// Patch hex-lifecycle-input.json: development.repositories[0].projectRepositoryId
// must point at the freshly-created project_repositories row. The committed
// input uses a placeholder (59); we overwrite it to the real id so the launch
// command needs no manual step.
const inputPath = path.join(SAGA_REPO_ROOT, 'hex-lifecycle-input.json');
const { readFileSync, writeFileSync } = await import('node:fs');
const inputJson = JSON.parse(readFileSync(inputPath, 'utf8'));
inputJson.development.repositories[0].projectRepositoryId = result.projectRepoId;
writeFileSync(inputPath, JSON.stringify(inputJson, null, 2));

console.log('=== Bootstrap complete (GLM-4.7 cloud) ===\n');
console.log(`Project:    ${result.projectId} (${PROJECT_NAME})`);
console.log(`Epic:       ${result.epicId} (${EPIC_NAME})`);
console.log(`Repository: ${result.repoId} (project_repositories.id=${result.projectRepoId})`);
console.log(`Workspace:  ${workspaceRoot}`);
console.log(`DB:         ${dbPath}`);
console.log(`Patched:    hex-lifecycle-input.json → projectRepositoryId=${result.projectRepoId}\n`);

console.log('=== Launch command (GLM-4.7 via global settings.json) ===\n');
console.log(`cd ${SAGA_REPO_ROOT}`);
console.log(`DB_PATH="${dbPath}" \\`);
console.log(`  SAGA_ORCHESTRATION_MODE=saga3-lifecycle \\`);
console.log(`  SAGA_PRODUCT_LIFECYCLE_COMPOSITION="${SAGA_REPO_ROOT}/hex-composition.mjs" \\`);
console.log(`  node dist/orchestrate-cli.js ${result.projectId} ${result.epicId} \\`);
console.log(`    --lifecycle-input=${SAGA_REPO_ROOT}/hex-lifecycle-input.json \\`);
console.log(`    --concurrency=1\n`);
