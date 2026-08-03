import Database from 'better-sqlite3';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';
const ws = 'C:/Temp/autism-buttons-workspace';

if (!existsSync(path.join(ws, '.git'))) {
  mkdirSync(ws, { recursive: true });
  execSync('git init -b main', { cwd: ws });
  execSync('git config user.name Saga', { cwd: ws });
  execSync('git config user.email saga@local', { cwd: ws });
  writeFileSync(path.join(ws, 'README.md'), '# Autism Button Library\n');
  execSync('git add README.md && git commit -m init', { cwd: ws });
}
console.log('workspace ready:', ws);

const idea = 'React component library of hexagonal buttons optimized for autism spectrum users: reduced-motion support, predictable focus indicators, low-sensory color palettes, keyboard-first navigation, and screen-reader semantics. WCAG 2.2 for neurodivergent audiences.';

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const tx = db.transaction(() => {
  const project = db.prepare(
    'INSERT INTO projects (name, description, status, tags) VALUES (?, ?, ?, ?) RETURNING *',
  ).get('Autism-Button-Library-GLM', idea, 'active', '[]');

  const epic = db.prepare(
    'INSERT INTO epics (project_id, name, description, status, priority, tags) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
  ).get(project.id, 'Discovery Autism Buttons GLM-4.7', idea, 'planned', 'high', '[]');

  const repo = db.prepare(
    'INSERT INTO repositories (name, default_branch, metadata) VALUES (?, ?, ?) RETURNING *',
  ).get('autism-buttons', 'main', '{}');

  db.prepare(
    `INSERT INTO project_repositories
       (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(project.id, repo.id, 'primary', ws, 'main', 'active', '{}');

  db.prepare(
    `INSERT INTO episode_workflows
       (epic_id, stage, track, baseline_artifact_id, baseline_hash, metadata, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, datetime('now'), datetime('now'))`,
  ).run(
    epic.id,
    'discovery',
    'formal',
    JSON.stringify({
      active_provider: 'zai',
      active_model_effort: 'high',
      active_model_limit: 2,
    }),
  );

  return { projectId: project.id, epicId: epic.id };
});

const r = tx();
db.close();

console.log(`project: ${r.projectId} | epic: ${r.epicId}`);
console.log(`DB: ${DB_PATH}`);
console.log('');
console.log('Launch:');
console.log(`  $env:SAGA_ORCHESTRATION_MODE='saga3-discovery-generic'`);
console.log(`  $env:SAGA_REPO_ROOT='D:\\Разработка\\saga-mcp'`);
console.log(`  $env:SAGA_PACKAGE_STORE_DIR='C:\\Temp\\autism-buttons-pkg'`);
console.log(`  node dist/orchestrate-cli.js ${r.projectId} ${r.epicId} --concurrency=1`);
