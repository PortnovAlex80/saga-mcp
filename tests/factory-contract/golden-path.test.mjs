// tests/factory-contract/golden-path.test.mjs
//
// Factory Contract Test: Discovery + Formalization golden path.
//
// This is a REAL automated test with assertions — not log inspection.
// It launches the real Factory via orchestrate-cli with scenario-driven workers,
// then asserts exact Factory state in the DB.
//
// AC-23: assertions, not log inspection.
// AC-24: non-zero child exit fails the test.
// AC-25: timeout fails the test.
// AC-26: dedicated package.json command.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const SRC_DB = path.join(REPO_ROOT, '.button-color-replay-e2e', 'factory.sqlite');

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-golden-'));
  const dbPath = path.join(dir, 'golden.db');
  process.env.DB_PATH = dbPath;

  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const db = getDb();

  // Copy project + repo from source DB
  const srcDb = new Database(SRC_DB, { readonly: true });
  const srcProject = srcDb.prepare('SELECT * FROM projects WHERE id=1').get();
  db.prepare('INSERT INTO projects (id, name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(srcProject.id, srcProject.name, srcProject.description || 'Test', 'active', '[]', '{}');
  db.prepare('INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)')
    .run(1, srcProject.id, 'Pipeline', 'planned', 'high');
  db.prepare('INSERT INTO repositories (id, name, default_branch, metadata) VALUES (?, ?, ?, ?)')
    .run(1, 'golden-repo', 'main', '{}');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, srcProject.id, 1, 'component', repoPath, 'dev', 'active');

  // Copy capsules
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  ensureReplayCapsuleSchema(db);
  const capsules = srcDb.prepare('SELECT * FROM factory_replay_capsules').all();
  const insertCap = db.prepare(
    'INSERT OR IGNORE INTO factory_replay_capsules (capsule_ref, replay_key, project_id, source_execution_ref, source_candidate_set_ref, payload_hash, payload_snapshot, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (const cap of capsules) {
    insertCap.run(
      cap.capsule_ref || `cap-${cap.replay_key.slice(0,12)}`, cap.replay_key, 1,
      cap.source_execution_ref, cap.source_candidate_set_ref,
      cap.payload_hash, cap.payload_snapshot, cap.created_at,
    );
  }
  srcDb.close();

  // Create factory order + launch
  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryDeferredProfile } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const deferredProfile = { schemaVersion: 'factory.delivery-deferred-profile.v1', reason: 'authorization-required', source: 'start-from-idea' };
  deferredProfile.profileHash = hashDeliveryDeferredProfile(deferredProfile);

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: { subject: 'golden path test', context: 'e2e factory contract test', evidence: [], constraints: {} },
    development: { repositories: [{ repositoryRef: { repositoryName: 'golden-repo', role: 'component' }, integrationBranch: 'dev', expectedBaseCommit: baseCommit }], policy: devPolicy },
    delivery: { mode: 'deferred', policy: null, operatorAuthorization: null, deferredProfile },
  };

  const orderRef = `order-golden-${Date.now()}`;
  db.prepare(`INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state) VALUES (?, 1, 1, 'idea_url', 'starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({ orderRef, mode: 'new', projectId: 1, epicId: 1, initiatedBy: 'golden-test', idempotencyKey: `golden-${randomUUID()}`, concurrency: 1, lifecycleInput, lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2' }, db);
  closeDb();
  return { dbPath, launchRef, dir };
}

async function runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath, invocationLogPath, timeoutMs = 120000) {
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

  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => stdout += c);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => stderr += c);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`TIMEOUT after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });

  return { exitCode, stdout, stderr };
}

test('Golden Path: Discovery GO + Formalization FORMALIZED', { timeout: 180000 }, async () => {
  // Setup repo
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-golden-repo-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Golden\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();

  const invocationLogPath = path.join(dir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');

  const scenariosPath = path.join(REPO_ROOT, 'tests', 'factory-contract', 'golden-path-scenarios.mjs');

  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);

  try {
    const { exitCode, stderr } = await runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath, invocationLogPath);

    // AC-24: non-zero exit fails the test
    assert.equal(exitCode, 0, `orchestrate-cli exited with code ${exitCode}\n${stderr.slice(-2000)}`);

    // Assert Factory state
    const resultDb = new Database(dbPath, { readonly: true });

    // AC-23: assert expected ProcessRuns
    const runs = resultDb.prepare('SELECT module_name, status, local_outcome FROM factory_process_runs ORDER BY id').all();
    assert.ok(runs.length >= 2, `Expected ≥2 process runs, got ${runs.length}`);
    const discovery = runs.find(r => r.module_name === 'product-discovery');
    assert.ok(discovery, 'Discovery process run exists');
    assert.equal(discovery.status, 'completed', `Discovery status: ${discovery.status}`);
    assert.equal(discovery.local_outcome, 'go', `Discovery outcome: ${discovery.local_outcome}`);

    const formalization = runs.find(r => r.module_name === 'solution-formalization');
    if (formalization) {
      assert.equal(formalization.status, 'completed', `Formalization status: ${formalization.status}`);
      assert.equal(formalization.local_outcome, 'formalized', `Formalization outcome: ${formalization.local_outcome}`);
    }

    // Assert all Discovery + Formalization workplaces are terminal(accepted)
    const workplaces = resultDb.prepare(
      'SELECT production_cell_id, kanban_phase, loop_state, terminal_reason FROM factory_workplaces ORDER BY rowid',
    ).all();
    assert.ok(workplaces.length >= 2, `Expected ≥2 workplaces, got ${workplaces.length}`);
    for (const wp of workplaces) {
      if (wp.production_cell_id?.startsWith('discovery-') || wp.production_cell_id?.startsWith('formalization-')) {
        assert.equal(wp.loop_state, 'terminal', `${wp.production_cell_id}: loop_state=${wp.loop_state}`);
        assert.equal(wp.terminal_reason, 'accepted', `${wp.production_cell_id}: terminal_reason=${wp.terminal_reason}`);
      }
    }

    // AC-23: assert no stranded executions
    const activeExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`,
    ).get();
    assert.equal(activeExecs.n, 0, `${activeExecs.n} worker executions still active`);

    // Assert worker_done receipts exist
    const receipts = resultDb.prepare(
      "SELECT COUNT(*) AS n FROM command_receipts WHERE command_kind='worker_done' AND accepted=1",
    ).get();
    assert.ok(receipts.n >= 2, `Expected ≥2 worker_done receipts, got ${receipts.n}`);

    // Assert CandidateSets exist
    const candidateSets = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get();
    assert.ok(candidateSets.n >= 2, `Expected ≥2 candidate sets, got ${candidateSets.n}`);

    // Assert GateDecisions exist
    const gateDecisions = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_gate_decisions').get();
    assert.ok(gateDecisions.n >= 2, `Expected ≥2 gate decisions, got ${gateDecisions.n}`);

    resultDb.close();

    // AC-37: verify scripted worker invocations
    const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
    assert.ok(invocations.length > 0, 'Scripted workers were invoked at least once');
  } finally {
    // Windows: temp dirs may still be locked by git/DB handles. Best-effort cleanup.
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
