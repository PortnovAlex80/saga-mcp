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
async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-crash-'));
  const dbPath = path.join(dir, 'crash.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'Crash recovery fixture', 'Crash test', 'active', '[]', '{}');
  db.prepare('INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)')
    .run(1, 1, 'Pipeline', 'planned', 'high');
  db.prepare('INSERT INTO lifecycle_execution_controls (epic_id, concurrency) VALUES (?, ?)')
    .run(1, 1);
  db.prepare('INSERT INTO repositories (id, name, default_branch, metadata) VALUES (?, ?, ?, ?)').run(1, 'crash-repo', 'main', '{}');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 1, 1, 'component', repoPath, 'dev', 'active');
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  ensureReplayCapsuleSchema(db);
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

test('AC-28/T10: crash recovery — worker exits without worker_done, Factory requeues', { timeout: 300000 }, async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-crash-repo-'));
  const repoPath = path.join(repoDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Crash\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  // The development phase desks off the integration branch; the converged
  // run reaches it, so the fixture must provide it (the pre-K1.1 test never
  // got past the discovery crash loop and the gap was invisible).
  execSync('git branch dev', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
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

    // ADR-048/ADR-053 retry semantics: with the one-shot crash scenario the
    // retry attempt re-submits the typed product from ITS OWN execution and
    // completes, so the whole lifecycle converges and the engine exits 0.
    // A healthy retry must NOT exhaust the recovery budget — zero epoch
    // rollovers. (Epoch coverage moved to T10b: persistent crash.)
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve('timeout');
      }, 240_000);
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, `orchestrate-cli converged after crash recovery (exit=${exitCode})\n${stderr.slice(-4000)}`);

    // The Factory should have handled the crash recovery. Discovery runs first
    // (with the crash scenario), so the discovery-proposal workplace should
    // show signs of crash recovery (repair_wait transitions).
    const resultDb = new Database(dbPath, { readonly: true });

    // Check the discovery-proposal workplace went through crash recovery
    const wps = resultDb.prepare(
      'SELECT production_cell_id, kanban_phase, loop_state, terminal_reason, revision, workplace_ref FROM factory_workplaces ORDER BY rowid',
    ).all();
    const proposalWp = wps.find(w => w.production_cell_id === 'discovery-proposal');
    assert.ok(proposalWp, 'discovery-proposal workplace exists');
    assert.notEqual(proposalWp.loop_state, 'running',
      `discovery-proposal is not stuck in running (crash recovery advanced the loop). loop=${proposalWp.loop_state}`);
    assert.notEqual(proposalWp.loop_state, 'paused',
      'ADR-075: a quality cell never parks for a human after budget exhaustion');
    assert.equal(proposalWp.loop_state, 'terminal',
      `one-shot crash recovers to terminal acceptance. loop=${proposalWp.loop_state}`);

    // Healthy retry: the budget was never exhausted — no epoch rollover.
    const epochs = resultDb.prepare(
      'SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?',
    ).get(proposalWp.workplace_ref);
    assert.equal(epochs.n, 0, `healthy retry must not roll recovery epochs. count=${epochs.n}`);
    const parkReasons = resultDb.prepare(
      'SELECT COUNT(*) AS n FROM factory_workplace_park_reasons WHERE workplace_ref=?',
    ).get(proposalWp.workplace_ref);
    assert.equal(parkReasons.n, 0, 'no human park reason for a requeue cell');

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

test('AC-28/T10b: persistent crash — budget rolls into recovery epochs, never parks (ADR-075)', { timeout: 180000 }, async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-crashb-repo-'));
  const repoPath = path.join(repoDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(repoPath + '/README.md', '# CrashB\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  execSync('git branch dev', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();

  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');

  // Shim selecting the persistent-crash scenario map.
  const scenariosModule = pathToFileURL(path.join(REPO_ROOT, 'tests', 'factory-contract', 'crash-scenarios.mjs')).href;
  const scenariosPath = path.join(repoDir, 'scenarios-persistent.mjs');
  writeFileSync(scenariosPath, [
    `import { persistentCrashScenarios as scenarios } from ${JSON.stringify(scenariosModule)};`,
    'export { scenarios };',
    'export default scenarios;',
    '',
  ].join('\n'), 'utf8');

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

    // Time-boxed: let the crash → lost → repair_wait → budget-exhaustion →
    // epoch-rollover sequence run, then stop the engine and assert the
    // ADR-075 no-human contract.
    await new Promise(resolve => setTimeout(resolve, 45_000));
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 20_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });

    const resultDb = new Database(dbPath, { readonly: true });
    const wps = resultDb.prepare(
      'SELECT production_cell_id, loop_state, workplace_ref FROM factory_workplaces ORDER BY rowid',
    ).all();
    const proposalWp = wps.find(w => w.production_cell_id === 'discovery-proposal');
    assert.ok(proposalWp, 'discovery-proposal workplace exists');
    assert.notEqual(proposalWp.loop_state, 'running',
      `persistent crash never leaves the workplace in running. loop=${proposalWp.loop_state}`);
    assert.notEqual(proposalWp.loop_state, 'paused',
      `ADR-075: persistent crash never parks for a human. loop=${proposalWp.loop_state}\n${stderr.slice(-2000)}`);

    const epochs = resultDb.prepare(
      'SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?',
    ).get(proposalWp.workplace_ref);
    assert.ok(epochs.n >= 1, `exhausted budget rolls into recovery epochs. count=${epochs.n}`);
    const parkReasons = resultDb.prepare(
      'SELECT COUNT(*) AS n FROM factory_workplace_park_reasons WHERE workplace_ref=?',
    ).get(proposalWp.workplace_ref);
    assert.equal(parkReasons.n, 0, 'no human park reason for a requeue cell');

    const activeExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`,
    ).get();
    assert.equal(activeExecs.n, 0, 'No stranded executions after stop');
    const lostExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state='lost'`,
    ).get();
    assert.ok(lostExecs.n >= 2, `persistent crash loses every attempt. count=${lostExecs.n}`);

    resultDb.close();
  } finally {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
});
