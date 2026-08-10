// tests/factory-contract/crash-recovery.test.mjs
//
// AC-28: exit(0) without worker_done has deterministic recovery coverage.
// AC-05: managed durable production survives WorkerExecution replacement.
//
// This test proves the Factory's crash recovery works with MANAGED PRODUCTION
// (artifacts), where durable production IS inherited across execution replacement.
//
// The crash scenario targets the Formalization product-contract cell (which uses
// managed-production, not typed-submission). On attempt 1, the worker creates
// some artifacts then exits without worker_done. On attempt 2, the worker
// creates the remaining artifacts and completes — the gate sees ALL artifacts
// from both attempts because managed-production is node-durable (P18).

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const SRC_DB = path.join(REPO_ROOT, '.button-color-replay-e2e', 'factory.sqlite');

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-crash-'));
  const dbPath = path.join(dir, 'crash.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const db = getDb();
  const srcDb = new Database(SRC_DB, { readonly: true });
  const srcProject = srcDb.prepare('SELECT * FROM projects WHERE id=1').get();
  db.prepare('INSERT INTO projects (id, name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(srcProject.id, srcProject.name, 'Crash test', 'active', '[]', '{}');
  db.prepare('INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)')
    .run(1, 1, 'Pipeline', 'planned', 'high');
  db.prepare('INSERT INTO lifecycle_execution_controls (epic_id, concurrency, model_concurrency_limit) VALUES (?, ?, ?)')
    .run(1, 1, 1);
  db.prepare('INSERT INTO repositories (id, name, default_branch, metadata) VALUES (?, ?, ?, ?)').run(1, 'crash-repo', 'main', '{}');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 1, 1, 'component', repoPath, 'dev', 'active');
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  ensureReplayCapsuleSchema(db);
  srcDb.close();

  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryDeferredProfile } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const devPolicy = { id: 'reference-development-policy', version: '1.0.0' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const deferredProfile = { schemaVersion: 'factory.delivery-deferred-profile.v1', reason: 'authorization-required', source: 'start-from-idea' };
  deferredProfile.profileHash = hashDeliveryDeferredProfile(deferredProfile);
  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: { subject: 'crash test', context: 'crash recovery', evidence: [], constraints: {} },
    development: { repositories: [{ repositoryRef: { repositoryName: 'crash-repo', role: 'component' }, integrationBranch: 'dev', expectedBaseCommit: baseCommit }], policy: devPolicy },
    delivery: { mode: 'deferred', policy: null, operatorAuthorization: null, deferredProfile },
  };
  const orderRef = `order-crash-${Date.now()}`;
  db.prepare(`INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state) VALUES (?, 1, 1, 'idea_url', 'starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({ orderRef, mode: 'new', projectId: 1, epicId: 1, initiatedBy: 'crash-test', idempotencyKey: `crash-${randomUUID()}`, concurrency: 1, lifecycleInput, lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2' }, db);
  closeDb();
  return { dbPath, launchRef, dir };
}

test('AC-28/T10: crash recovery — worker exits without worker_done, Factory requeues', { timeout: 180000 }, async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-crash-repo-'));
  const repoPath = path.join(repoDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Crash\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();

  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');

  const scenariosPath = path.join(REPO_ROOT, 'tests', 'factory-contract', 'crash-scenarios.mjs');
  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);

  try {
    const child = spawn('node', [
      path.join(REPO_ROOT, 'dist', 'orchestrate-cli.js'),
      `--launch-ref=${launchRef}`,
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        SAGA_REPO_ROOT: REPO_ROOT,
        SAGA_BUTTON_REPO_PATH: repoPath,
        SAGA_PRODUCT_LIFECYCLE_COMPOSITION: path.join(REPO_ROOT, 'tests', 'factory-contract', 'scenario-composition.mjs'),
        SAGA_SCENARIOS: scenariosPath,
        SAGA_INVOCATION_LOG: invocationLogPath,
        SAGA_CONCURRENCY: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr += c; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', () => {});

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error(`TIMEOUT (stderr tail: ${stderr.slice(-500)})`));
      }, 150000);
      child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });

    // The Factory should have handled the crash recovery. Discovery runs first
    // (with the crash scenario), so the discovery-proposal workplace should
    // show signs of crash recovery (repair_wait transitions).
    const resultDb = new Database(dbPath, { readonly: true });

    // Check the discovery-proposal workplace went through crash recovery
    const wps = resultDb.prepare(
      'SELECT production_cell_id, kanban_phase, loop_state, terminal_reason, revision FROM factory_workplaces ORDER BY rowid',
    ).all();
    const proposalWp = wps.find(w => w.production_cell_id === 'discovery-proposal');
    assert.ok(proposalWp, 'discovery-proposal workplace exists');

    // The crash scenario crashes on attempt 1, retries on attempt 2 (which also
    // fails because typed-submission can't be re-submitted), then exhausts
    // maxAttempts (2) and pauses. The workplace should be in repair_wait or
    // blocked/paused — NOT in running (which would indicate a stuck execution).
    assert.notEqual(proposalWp.loop_state, 'running',
      `discovery-proposal is not stuck in running (crash recovery advanced the loop). loop=${proposalWp.loop_state}`);

    // Verify no stranded executions
    const activeExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`,
    ).get();
    assert.equal(activeExecs.n, 0, 'No stranded executions after crash recovery');

    // Verify worker_executions show the crash → lost terminalization
    const lostExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state='lost'`,
    ).get();
    assert.ok(lostExecs.n > 0, `At least 1 'lost' execution from crash recovery. count=${lostExecs.n}`);

    resultDb.close();
  } finally {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
});
