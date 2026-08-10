// tests/factory-contract/parallel-git-desk.test.mjs
//
// Factory Contract: parallel git_change Production Cells prove worktree isolation.
//
// This test exists because the golden-path test runs at concurrency=1, which
// masks a shared-checkout race: when Development dispatches ≥2 implementation
// items concurrently, scripted workers that share SAGA_BUTTON_REPO_PATH race
// on `git checkout -B` and orphan source commits →
// PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH.
//
// The fix: the scripted executor provisions the SAME per-task git worktree
// production uses (RepositoryDeskProvisioner). This test proves that fix by
// running the full lifecycle at concurrency=2 with two implementation items
// and asserting both source commits survive integration.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();

async function buildLifecycleInput(baseCommit) {
  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryReleasePolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const { sha256Hex } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'shared', 'canonical-json.js')).href);

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const releaseAction = {
    actionId: 'deploy-parallel-desk-test',
    kind: 'deployment',
    target: 'parallel-desk-test-target',
    desiredStateHash: sha256Hex({ target: 'parallel-desk-test-target', state: 'released-v1' }),
    payloadHash: sha256Hex({ package: 'parallel-desk-v1' }),
    required: true,
  };
  const releasePolicy = {
    id: 'parallel-desk-release-policy',
    version: '1.0.0',
    contentHash: '',
    channel: 'test',
    releaseVersion: '1.0.0',
    releaseTag: 'parallel-desk-v1',
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: 'parallel-desk-test',
    releasePolicyHash: releasePolicy.contentHash,
    candidateScope: { mode: 'lifecycle-output' },
  };
  const operatorAuthorization = {
    schema: 'factory.operator-release-grant.v1',
    ref: `parallel-desk-grant:${sha256Hex(grantBody)}`,
    hash: sha256Hex(grantBody),
    ...grantBody,
  };
  return {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: 'parallel git desk isolation test',
      context: 'two concurrent implementation workers in isolated worktrees',
      evidence: [],
      constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: 'parallel-repo', role: 'component' },
        integrationBranch: 'dev',
        expectedBaseCommit: baseCommit,
      }],
      policy: devPolicy,
    },
    delivery: {
      mode: 'authorized',
      policy: releasePolicy,
      operatorAuthorization,
      deferredProfile: null,
    },
  };
}

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-parallel-'));
  const dbPath = path.join(dir, 'parallel.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,description,status,tags,metadata)
              VALUES (1,'Parallel Desk Test','Worktree isolation under concurrency=2','active','[]','{}')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name,status,priority)
              VALUES (1,1,'Pipeline','planned','high')`).run();
  db.prepare(`INSERT INTO lifecycle_execution_controls
              (epic_id,concurrency,model_concurrency_limit)
              VALUES (1,2,2)`).run();
  db.prepare(`INSERT INTO repositories (id,name,default_branch,metadata)
              VALUES (1,'parallel-repo','dev','{}')`).run();
  db.prepare(`INSERT INTO project_repositories
              (id,project_id,repository_id,role,local_path,integration_branch,status)
              VALUES (1,1,1,'component',?,'dev','active')`).run(repoPath);
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9101,1,'deterministic_evidence','factory-contract-preflight',
            'factory contract deterministic fixture','full','factory-contract','L0','1.0.0','active')`).run();
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9102,1,'authoritative_state','factory-contract-deployment-state',
            'factory contract authoritative fixture','partial','factory-contract','L4','1.0.0','active')`).run();
  ensureReplayCapsuleSchema(db);
  closeDb();
  const lifecycleInput = await buildLifecycleInput(baseCommit);

  // CRITICAL DIFFERENCE from golden-path: concurrency=2 in the launch ticket.
  // This forces two implementation workers to run simultaneously, exercising
  // the per-task worktree isolation.
  process.env.DB_PATH = dbPath;
  const db2 = (await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href)).getDb();
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const orderRef = `order-parallel-${randomUUID()}`;
  db2.prepare(`INSERT INTO factory_orders
              (order_ref,project_id,epic_id,source_kind,state)
              VALUES (?,1,1,'idea_url','starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'parallel-desk-test',
    idempotencyKey: `parallel-${randomUUID()}`,
    concurrency: 2,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db2);
  (await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href)).closeDb();
  return { dbPath, launchRef, dir };
}

async function runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath, timeoutMs = 240000) {
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
      SAGA_CONCURRENCY: '2',
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
      reject(new Error(`TIMEOUT after ${timeoutMs}ms\n${stderr.slice(-3000)}`));
    }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

test('Parallel git_change Production Cells: concurrency=2 worktree isolation', { timeout: 300000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-parallel-repo-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Parallel Desk\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init && git branch -M dev', {
    cwd: repoPath, windowsHide: true, stdio: 'pipe',
  });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();
  const scenariosPath = path.join(REPO_ROOT, 'tests', 'factory-contract', 'golden-path-scenarios.mjs');
  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);

  try {
    const result = await runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath);
    assert.equal(result.exitCode, 0, `orchestrate-cli exited ${result.exitCode}\n${result.stderr.slice(-5000)}`);

    const db = new Database(dbPath, { readonly: true });

    // Lifecycle must reach 'released' — proving Development integrated BOTH
    // implementation items without PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH.
    const lifecycle = db.prepare('SELECT status,terminal_status,error FROM factory_lifecycle_runs LIMIT 1').get();
    assert.equal(
      `${lifecycle.status}/${lifecycle.terminal_status}`,
      'completed/released',
      `Lifecycle did not reach released. error=${lifecycle.error}\n${result.stderr.slice(-8000)}`,
    );
    assert.ok(
      !lifecycle.error || !lifecycle.error.includes('PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH'),
      `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH must NOT occur with per-task worktree isolation. error=${lifecycle.error}`,
    );

    // Both implementation tasks must be done + merged.
    const implTasks = db.prepare(
      `SELECT id,status,integration_state,integrated_commit FROM tasks
        WHERE task_kind='development.code' ORDER BY id`,
    ).all();
    assert.ok(implTasks.length >= 2, `expected ≥2 implementation tasks, got ${implTasks.length}`);
    for (const t of implTasks) {
      assert.equal(t.status, 'done', `impl task ${t.id} status=${t.status}`);
      assert.equal(t.integration_state, 'merged', `impl task ${t.id} integration_state=${t.integration_state}`);
      assert.ok(t.integrated_commit, `impl task ${t.id} has no integrated_commit`);
    }

    // The integration branch (dev) must have advanced past the base — proving
    // both source commits were merged via the post-acceptance integration effect.
    const devHead = execSync('git rev-parse refs/heads/dev', {
      cwd: repoPath, encoding: 'utf8', windowsHide: true,
    }).trim();
    assert.notEqual(devHead, baseCommit, 'dev branch did not advance — integration did not happen');

    // Per-task worktree directories must exist (the factory provisioned them).
    // The worktrees live at <repoRoot>/.worktrees/task-<id>.
    const worktreesDir = path.join(repoPath, '.worktrees');
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(worktreesDir), `worktrees dir not created: ${worktreesDir}`);

    // The dev branch history must contain BOTH implementation commit messages.
    const log = execSync('git log --oneline dev', {
      cwd: repoPath, encoding: 'utf8', windowsHide: true,
    });
    const implCommits = log.split('\n').filter(l => l.includes('factory-contract: implement'));
    assert.ok(implCommits.length >= 2, `expected ≥2 implementation commits in dev log, got ${implCommits.length}\n${log}`);

    db.close();

    process.stderr.write(`\n[parallel-git-desk] PASS: ${implTasks.length} impl tasks merged, dev advanced, no source mismatch\n`);
  } finally {
    // Clean up worktrees before removing the repo dir.
    try {
      execSync('git worktree prune', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
    } catch {}
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
