// tests/factory-contract/golden-path.test.mjs
//
// Factory Contract golden path:
//   Run A: FRESH DB + ZERO capsules -> Idea -> released through scripted
//          physical workers and real Factory authority.
//   Run B: same semantic input -> compatible capsules replace worker inference;
//          new Workplaces/CandidateSets/Gates still run, scripted calls = ZERO.

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

async function buildLifecycleInput(baseCommit) {
  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryReleasePolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const { sha256Hex } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'shared', 'canonical-json.js')).href);

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
  return {
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
}

async function requestLaunch(dbPath, lifecycleInput, label) {
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const db = getDb();
  const orderRef = `order-${label}-${randomUUID()}`;
  db.prepare(`INSERT INTO factory_orders
              (order_ref,project_id,epic_id,source_kind,state)
              VALUES (?,1,1,'idea_url','starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'golden-test',
    idempotencyKey: `${label}-${randomUUID()}`,
    concurrency: 1,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
  closeDb();
  return launchRef;
}

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-golden-'));
  const dbPath = path.join(dir, 'golden.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
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
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9101,1,'deterministic_evidence','factory-contract-preflight',
            'factory contract deterministic fixture','full','factory-contract','L0','1.0.0','active')`).run();
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9102,1,'authoritative_state','factory-contract-deployment-state',
            'factory contract authoritative fixture','partial','factory-contract','L4','1.0.0','active')`).run();
  ensureReplayCapsuleSchema(db);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get().n,
    0,
    'Run A starts with zero replay capsules',
  );
  closeDb();
  const lifecycleInput = await buildLifecycleInput(baseCommit);
  const launchRef = await requestLaunch(dbPath, lifecycleInput, 'golden-a');
  return { dbPath, launchRef, lifecycleInput, dir };
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

function assertLifecycleOutcomes(db, runOffset = 0) {
  const runs = db.prepare(
    'SELECT id,module_name,status,local_outcome FROM factory_process_runs ORDER BY id',
  ).all().slice(runOffset);
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
}

test('Golden Path: cold Idea -> released, then replay -> released with zero scripted calls', { timeout: 540000 }, async () => {
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
  const { dbPath, launchRef, lifecycleInput, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);

  try {
    // ---------------- Run A: cold inference source ----------------
    const runA = await runOrchestrateCli(launchRef, dbPath, repoPath, scenariosPath, invocationLogPath);
    assert.equal(runA.exitCode, 0, `Run A orchestrate-cli exited ${runA.exitCode}\n${runA.stderr.slice(-5000)}`);

    let resultDb = new Database(dbPath, { readonly: true });
    assertLifecycleOutcomes(resultDb);
    const processRunsAfterA = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_process_runs').get().n;
    const workplacesAfterA = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_workplaces').get().n;
    const gatesAfterA = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_gate_decisions').get().n;
    const candidateSetsAfterA = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get().n;
    const capsulesAfterA = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get().n;
    assert.ok(workplacesAfterA >= 8, `expected full-lifecycle workplaces, got ${workplacesAfterA}`);
    assert.ok(gatesAfterA >= 8, `expected full-path GateDecisions, got ${gatesAfterA}`);
    assert.ok(candidateSetsAfterA >= 10, `expected full-path CandidateSets, got ${candidateSetsAfterA}`);
    assert.ok(capsulesAfterA > 0, 'cold Run A certifies replay capsules only after acceptance');
    assert.equal(
      resultDb.prepare(`SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`).get().n,
      0,
      'Run A leaves no stranded worker executions',
    );
    assert.ok(
      resultDb.prepare(`SELECT COUNT(*) AS n FROM factory_external_effect_actions WHERE module_ref LIKE 'delivery-release@%'`).get().n >= 1,
      'Run A Delivery used real external-effect ledger',
    );
    resultDb.close();

    const runAInvocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
    assert.ok(runAInvocations.length >= 10, `scripted workers invoked on cold path: ${runAInvocations.length}`);
    assert.ok(runAInvocations.some(i => i.key?.module === 'solution-development@1.0.0'), 'Run A Development used scripted physical workers');

    // ---------------- Run B: replay production source ----------------
    // Restore the exact repository desk base required by the captured Git
    // recipe. Preserve the Delivery marker so observe-before-mutate can prove
    // the desired external state already exists.
    execSync(`git checkout dev && git reset --hard ${baseCommit} && git clean -fd -e '.factory-contract-release-*'`, {
      cwd: repoPath, windowsHide: true, stdio: 'pipe',
    });
    for (const branch of execSync("git for-each-ref --format='%(refname:short)' refs/heads", {
      cwd: repoPath, encoding: 'utf8', windowsHide: true,
    }).trim().split(/\r?\n/).filter(Boolean)) {
      if (branch !== 'dev') {
        try { execSync(`git branch -D ${branch}`, { cwd: repoPath, windowsHide: true, stdio: 'pipe' }); } catch {}
      }
    }
    writeFileSync(invocationLogPath, '[]');
    const launchB = await requestLaunch(dbPath, lifecycleInput, 'golden-b');
    const runB = await runOrchestrateCli(launchB, dbPath, repoPath, scenariosPath, invocationLogPath);
    assert.equal(runB.exitCode, 0, `Run B orchestrate-cli exited ${runB.exitCode}\n${runB.stderr.slice(-5000)}`);

    resultDb = new Database(dbPath, { readonly: true });
    assertLifecycleOutcomes(resultDb, processRunsAfterA);
    const processRunsAfterB = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_process_runs').get().n;
    const workplacesAfterB = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_workplaces').get().n;
    const gatesAfterB = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_gate_decisions').get().n;
    assert.ok(processRunsAfterB >= processRunsAfterA + 4, 'Run B creates new ProcessRuns');
    assert.ok(workplacesAfterB > workplacesAfterA, 'Run B creates NEW Workplaces');
    assert.ok(gatesAfterB > gatesAfterA, 'Run B executes NEW current Gates');
    assert.equal(
      resultDb.prepare(`SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`).get().n,
      0,
      'Run B leaves no stranded worker executions',
    );
    resultDb.close();

    const runBInvocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
    assert.equal(runBInvocations.length, 0, 'compatible Run B replay invokes ZERO scripted workers');
  } finally {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
