#!/usr/bin/env node
/**
 * Saga4 smoke bootstrap — fresh DB + project/epic/repo + assemble the Product
 * Delivery Lifecycle input for a bare idea (deferred delivery). Prints the
 * exact orchestrate-cli command to launch the lifecycle.
 *
 * Run:  node bootstrap-saga4-smoke.mjs
 * Then: run the printed command.
 */
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? path.resolve('./saga-smoke.db');
const WS = 'C:/Temp/saga4-smoke-workspace';

// Fresh DB.
if (existsSync(DB_PATH)) {
  try { rmSync(DB_PATH); } catch {}
  for (const ext of ['-shm', '-wal']) {
    try { rmSync(DB_PATH + ext); } catch {}
  }
}
process.env.DB_PATH = DB_PATH;

// Bootstrap the schema (getDb initialises SCHEMA_SQL + migrations).
const { getDb } = await import('../../dist/db.js');

// Init a git workspace for the target repository (real HEAD, like production).
if (!existsSync(path.join(WS, '.git'))) {
  mkdirSync(WS, { recursive: true });
  execSync('git init -b main', { cwd: WS });
  execSync('git config user.name Saga', { cwd: WS });
  execSync('git config user.email saga@local', { cwd: WS });
  writeFileSync(path.join(WS, 'README.md'), '# Saga4 Smoke Target\n');
  execSync('git add README.md && git commit -m init', { cwd: WS });
}

const db = getDb();
db.pragma('foreign_keys = ON');

const idea = 'React component library of hexagonal buttons optimized for autism spectrum users: reduced-motion support, predictable focus indicators, low-sensory color palettes, keyboard-first navigation, and screen-reader semantics. WCAG 2.2 for neurodivergent audiences.';

const { projectId, epicId } = (() => {
  const tx = db.transaction(() => {
    const project = db.prepare(
      `INSERT INTO projects (name, description, status, tags) VALUES (?, ?, 'active', '[]') RETURNING *`,
    ).get('Saga4-Smoke', idea);
    const epic = db.prepare(
      `INSERT INTO epics (project_id, name, description, status, priority, tags)
       VALUES (?, ?, ?, 'planned', 'high', '[]') RETURNING *`,
    ).get(project.id, 'REQ-001-Smoke', idea);
    const repo = db.prepare(
      `INSERT INTO repositories (name, default_branch, metadata) VALUES (?, 'main', '{}') RETURNING *`,
    ).get('smoke');
    db.prepare(
      `INSERT INTO project_repositories
         (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata)
       VALUES (?, ?, 'primary', ?, 'main', NULL, 'active', '{}')`,
    ).run(project.id, repo.id, WS);
    return { projectId: project.id, epicId: epic.id };
  });
  return tx();
})();

// Assemble the lifecycle input (deferred delivery, real repo HEAD).
const { assembleProductLifecycleInput } = await import(
  '../../dist/app/start-product-lifecycle-from-idea.js'
);
const input = assembleProductLifecycleInput({ projectId, epicId, idea, db });
const inputJson = JSON.stringify(input);

console.log(`\n[saga4-smoke] DB ready: ${DB_PATH}`);
console.log(`[saga4-smoke] project=${projectId} epic=${epicId} workspace=${WS}`);
console.log(`[saga4-smoke] lifecycle input assembled (deferred delivery).\n`);
console.log('Run the lifecycle with:\n');
const cwd = process.cwd().replace(/\\/g, '/');
const env = [
  `DB_PATH="${DB_PATH.replace(/\\/g, '/')}"`,
  `SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./hex-composition.mjs`,
  `SAGA_PRODUCT_LIFECYCLE_INPUT_JSON='${inputJson.replace(/'/g, `'\\''`)}'`,
].join(' ');
console.log(`${env} node dist/orchestrate-cli.js ${projectId} ${epicId} --concurrency=1\n`);
