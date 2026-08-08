// tests/factory-contract/golden-path.test.mjs
//
// Factory Contract golden path: a FRESH DB with ZERO replay capsules runs
// Idea -> Discovery -> Formalization -> Development -> Delivery using scripted
// physical workers through the real WorkerExecutorFactory port.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-golden-'));
  const dbPath = path.join(dir, 'golden.db');
  process.env.DB_PATH = dbPath;

  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryReleasePolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const { sha256Hex } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'shared', 'canonical-json.js')).href);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);

  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,description,status,tags,metadata)
              VALUES (1,'Factory Contract Golden','Cold deterministic factory test','active','[]','{}')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name,status,priority)
              VALUES (1,1,'Pipeline','planned','high')`).run();
  db.prepare(`INSERT INTO repositories (id,name,default_branch,metadata)
              VALUES (1,'golden-repo','dev','{}')`).run();
  db.prepare(`INSERT INTO project_repositories
              (id,project_id,repository_id,role,local_path,integration_branch,status)
              VALUES (1,1,1,'component',?,'dev','active')`).run(repoPath);

  // Delivery resolves provider trust from the real registry. These are test
  // provider implementations injected through the normal Delivery ports.
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9101,1,'deterministic_evidence','factory-contract-preflight',
            'factory contract deterministic fixture','full','factory-contract','L0','1.0.0','active')`).run();
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9102,1,'authoritative_state','factory-contract-deployment-state',
            'factory contract authoritative fixture','partial','factory-contract','L4','1.0.0','active')`).run();

  ensureReplayCapsuleSchema(db);
  const capsuleCount = db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get();
  assert.equal(capsuleCount.n, 0, 'Run A starts with zero replay capsules');

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);

  const releaseAction = {
    actionId: 'deploy-factory-contract',
    kind: 'deployment',
    target: 'factory-contract-test-target',
    desiredStateHash: sha256Hex({ target: 'factory-contract-test-target', state: 'released-v1' }),
    payloadHash: sha256Hex({ package: 'factory-contract-v1' }),
    required: true,
  };
  const releasePolicy = {
    id: 'factory-contract-release-policy',
    version: '1.0.0',
    contentHash: '',
    channel: 'test',
    releaseVersion: '1.0.0',
    releaseTag: 'factory-contract-v1',
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: 'factory-contract-test',
    releasePolicyHash: releasePolicy.contentHash,
    candidateScope: { mode: 'lifecycle-output' },
  };
  const operatorAuthorization = {
    schema: 'factory.operator-release-grant.v1',
    ref: `factory-contract-grant:${sha256Hex(grantBody)}`,
    hash: sha256Hex(grantBody),
    ...grantBody,
  };

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: 'golden path test',
      context: 'cold end-to-end Factory Contract test',
      evidence: [],
      constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: 'golden-repo', role: 'component' },
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

  const orderRef = `order-golden-${Date.now()}`;
  db.prepare(`INSERT INTO factory_orders
              (order_ref,project_id,epic_id,source_kind,state)
              VALUES (?,1,1,'idea_url','starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'golden-test',
    idempotencyKey: `golden-${randomUUID()}`,
    concurrency: 1,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
  closeDb();
  return { dbPath, launchRef, dir };
}

async function runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath, invocationLogPath, timeoutMs = 240000) {
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
      reject(new Error(`TIMEOUT after ${timeoutMs}ms\n${stderr.slice(-3000)}`));
    }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

test('Golden Path: cold Idea -> released uses real Factory authority without LLM/network', { timeout: 300000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-golden-repo-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Golden\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init && git branch -M dev', {
    cwd: repoPath, windowsHide: true, stdio: 'pipe',
  });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();
  const invocationLogPath = path.join(dir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');
  const scenariosPath = path.join(REPO_ROOT, 'tests', 'factory-contract', 'golden-path-scenarios.mjs');
  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);

  try {
    const { exitCode, stderr } = await runOrchestrateCli(
      launchRef, dbPath, repoPath, scenariosPath, invocationLogPath,
    );
    assert.equal(exitCode, 0, `orchestrate-cli exited ${exitCode}\n${stderr.slice(-5000)}`);

    const resultDb = new Database(dbPath, { readonly: true });
    const runs = resultDb.prepare(
      'SELECT module_name,status,local_outcome FROM factory_process_runs ORDER BY id',
    ).all();
    const expected = new Map([
      ['product-discovery', 'go'],
      ['solution-formalization', 'formalized'],
      ['solution-development', 'verified'],
      ['delivery-release', 'released'],
    ]);
    for (const [moduleName, outcome] of expected) {
      const run = runs.find(row => row.module_name === moduleName);
      assert.ok(run, `${moduleName} ProcessRun exists`);
      assert.equal(run.status, 'completed', `${moduleName} status`);
      assert.equal(run.local_outcome, outcome, `${moduleName} outcome`);
    }

    const workplaces = resultDb.prepare(
      'SELECT production_cell_id,kanban_phase,loop_state,terminal_reason FROM factory_workplaces ORDER BY rowid',
    ).all();
    assert.ok(workplaces.length >= 8, `expected full-lifecycle workplaces, got ${workplaces.length}`);
    for (const wp of workplaces) {
      assert.equal(wp.loop_state, 'terminal', `${wp.production_cell_id}: loop_state`);
      assert.equal(wp.terminal_reason, 'accepted', `${wp.production_cell_id}: terminal_reason`);
    }

    const activeExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`,
    ).get();
    assert.equal(activeExecs.n, 0, 'no stranded worker executions');

    const workerDone = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts
        WHERE command_kind='worker_done' AND accepted=1`,
    ).get();
    assert.ok(workerDone.n >= 10, `expected full-path worker_done receipts, got ${workerDone.n}`);

    const candidateSets = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get();
    const gates = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_gate_decisions').get();
    assert.ok(candidateSets.n >= 10, `expected full-path CandidateSets, got ${candidateSets.n}`);
    assert.ok(gates.n >= 8, `expected full-path GateDecisions, got ${gates.n}`);

    const capsules = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get();
    assert.ok(capsules.n > 0, 'cold Run A certifies replay capsules only after acceptance');

    const deliveryEffects = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM factory_external_effect_actions
        WHERE module_ref LIKE 'delivery-release@%'`,
    ).get();
    assert.ok(deliveryEffects.n >= 1, 'Delivery used real external-effect ledger');
    resultDb.close();

    const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
    assert.ok(invocations.length >= 10, `scripted workers invoked on cold path: ${invocations.length}`);
    assert.ok(invocations.some(i => i.key?.module === 'solution-development@1.0.0'), 'Development used scripted physical workers');
  } finally {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
