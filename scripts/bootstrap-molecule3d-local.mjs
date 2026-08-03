#!/usr/bin/env node
/**
 * Bootstrap a fresh Discovery project for the LOCAL MODEL test (qwen3.6-35b).
 * Same subject as epic 44 (Molecule3D) but a separate project/epic so the
 * two runs can be compared cloud-vs-local without cross-contamination.
 *
 * Usage: node bootstrap-molecule3d-local.mjs
 */
import Database from 'better-sqlite3';

const DB_PATH = 'C:/Users/user/.zcode/saga.db';
const REPO_PATH = 'D:/Разработка/saga-mcp';

const PROJECT_NAME = 'Molecule3D-School-LocalModel';
const PROJECT_DESC = `Веб-приложение для школьников: отрисовка 3D-модели молекулы по вводимой химической формуле (например H2O, CH4, C2H6O). Цель Discovery: определить реальную пользовательскую и бизнес-проблему (кто школьники, какие у них трудности с химией); вероятных пользователей и стейкхолдеров (ученики средних/старших классов, учителя); минимальный полезный product scope (какие молекулы поддержать, какой уровень интерактивности — вращение/зум, нужны ли аннотации атомов); существующие инструменты и системные границы (Three.js / molstar / 3Dmol.js, что уже есть); ключевые допущения и неизвестные (разбор формулы в структуру, производительность в браузере на слабых устройствах); evidence, необходимую до реализации; основные технические риски (производительность WebGL на школьных ноутбуках, точность геометрии молекул); должна ли идея proceeded, clarified или rejected. Фокус MVP: качественная 3D-визуализация молекулы + корректный парсинг простой формулы.`;

const EPIC_NAME = 'Molecule3D Discovery (Local Model)';
const EPIC_DESC = PROJECT_DESC;

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const existing = db.prepare("SELECT id, status FROM projects WHERE name = ? AND status = 'active'").get(PROJECT_NAME);
if (existing) {
  console.error(`ERROR: active project '${PROJECT_NAME}' already exists: id=${existing.id}. Archive it first.`);
  process.exit(1);
}

const tx = db.transaction(() => {
  const project = db.prepare(
    "INSERT INTO projects (name, description, status, tags) VALUES (?, ?, 'active', '[]') RETURNING *"
  ).get(PROJECT_NAME, PROJECT_DESC);
  const projectId = project.id;

  const epic = db.prepare(
    "INSERT INTO epics (project_id, name, description, status, priority, branch, tags) VALUES (?, ?, ?, 'planned', 'high', NULL, '[]') RETURNING *"
  ).get(projectId, EPIC_NAME, EPIC_DESC);
  const epicId = epic.id;

  const repo = db.prepare(
    "INSERT INTO repositories (name, remote_url, default_branch, metadata) VALUES (?, NULL, 'saga3-discovery', '{}') RETURNING *"
  ).get('saga-mcp');
  const repoId = repo.id;

  db.prepare(
    `INSERT INTO project_repositories (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata)
     VALUES (?, ?, 'component', ?, 'saga3-discovery', NULL, 'active', '{}')`
  ).run(projectId, repoId, REPO_PATH);

  // track is NOT NULL on write — must be 'formal', not NULL.
  db.prepare(
    `INSERT OR IGNORE INTO episode_workflows (epic_id, stage, track, baseline_artifact_id, baseline_hash, metadata, created_at, updated_at)
     VALUES (?, 'discovery', 'formal', NULL, NULL, '{}', datetime('now'), datetime('now'))`
  ).run(epicId);

  return { projectId, epicId, repoId };
});

const result = tx();
db.close();

console.log('=== Bootstrap complete ===');
console.log(`Project:    ${result.projectId} (${PROJECT_NAME})`);
console.log(`Epic:       ${result.epicId} (${EPIC_NAME})`);
console.log(`Repository: ${result.repoId}`);
console.log('');
console.log(`Before launch: load qwen3.6-35b-a3b@q8_k_xl in LM Studio, then run:`);
console.log(`  cd ${REPO_PATH}`);
console.log(`  DB_PATH="${DB_PATH}" SAGA_ORCHESTRATION_MODE=saga3-discovery-generic \\`);
console.log(`    node dist/orchestrate-cli.js ${result.projectId} ${result.epicId} --concurrency=1`);
