// tests/factory-temporal/lib/fresh-db.mjs
//
// Create a fresh temporary SQLite database with the canonical schema, a
// single project/epic/repository binding, and a factory launch ticket.
// NEVER touches .tracker.db or any production database.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = process.cwd();

/**
 * Create a bare git repository with one initial commit on the `dev` branch.
 * Returns { repoPath, baseCommit }.
 */
export function createTempGitRepo(label = 'temporal') {
  const dir = mkdtempSync(path.join(os.tmpdir(), `saga-${label}-repo-`));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), `# ${label}\n`);
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: `saga-${label}-fixture`, version: '1.0.0',
    scripts: { test: 'node test.js', start: 'node server.js' },
  }));
  writeFileSync(path.join(repoPath, 'test.js'), 'process.exit(0);\n');
  writeFileSync(path.join(repoPath, 'server.js'), [
    "const http=require('http');",
    "const port=Number(process.env.PORT);",
    "http.createServer((_q,r)=>r.end('ready')).listen(port,'127.0.0.1');",
  ].join('\n'));
  execSync(
    'git init && git config user.email t@t && git config user.name t '
    + '&& git add -A && git commit -m init && git branch -M dev',
    { cwd: repoPath, windowsHide: true, stdio: 'pipe' },
  );
  const baseCommit = execSync('git rev-parse HEAD', {
    cwd: repoPath, encoding: 'utf8', windowsHide: true,
  }).trim();
  return { repoPath, baseCommit, dir };
}

/**
 * Bootstrap a fresh saga SQLite database for one temporal scenario.
 *
 * NEVER mutates .tracker.db. Every call creates a new mkdtemp directory.
 *
 * @param {object} opts
 * @param {string} opts.repoPath - git repository local_path
 * @param {string} opts.baseCommit - expected base commit for desk provisioning
 * @param {number} [opts.concurrency=1] - operator concurrency
 * @param {number} [opts.modelConcurrency=1] - model concurrency limit
 * @param {string} [opts.label] - label for project name
 * @returns {Promise<{ dbPath: string, launchRef: string, dir: string }>}
 */
export async function bootstrapFreshDb(opts) {
  const {
    repoPath,
    baseCommit,
    concurrency = 1,
    modelConcurrency = 1,
    label = 'temporal',
  } = opts;

  const dir = mkdtempSync(path.join(os.tmpdir(), `saga-${label}-db-`));
  const dbPath = path.join(dir, 'temporal.db');
  process.env.DB_PATH = dbPath;

  const dbMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const replayMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js',
  )).href);
  const launchMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js',
  )).href);
  const policyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js',
  )).href);
  const deliveryPolicyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js',
  )).href);
  const shaMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'shared', 'canonical-json.js',
  )).href);

  const db = dbMod.getDb();
  db.prepare(
    `INSERT INTO projects (id,name,description,status,tags,metadata)
     VALUES (1,?,?,?,?,?)`,
  ).run(
    `Temporal ${label}`,
    `Temporal conformance test: ${label}`,
    'active',
    '[]',
    '{}',
  );
  db.prepare(
    `INSERT INTO epics (id,project_id,name,status,priority)
     VALUES (1,1,'Pipeline','planned','high')`,
  ).run();
  db.prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency)
     VALUES (1,?)`,
  ).run(concurrency);
  db.prepare(
    `INSERT INTO repositories (id,name,default_branch,metadata)
     VALUES (1,?,'dev','{}')`,
  ).run(`${label}-repo`);
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repoPath);

  // Trusted providers: deterministic-evidence preflight, authoritative-state
  // deployment, and the test verification check provider (9103).
  db.prepare(
    `INSERT INTO trusted_providers
       (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
     VALUES (9101,1,'deterministic_evidence','factory-contract-preflight',
             'temporal deterministic fixture','full','temporal','L0','1.0.0','active')`,
  ).run();
  db.prepare(
    `INSERT INTO trusted_providers
       (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
     VALUES (9102,1,'authoritative_state','factory-contract-deployment-state',
             'temporal authoritative fixture','partial','temporal','L4','1.0.0','active')`,
  ).run();
  db.prepare(
    `INSERT INTO trusted_providers
       (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
     VALUES (9103,1,'deterministic_evidence','development.verification-product-contract.v2',
             'temporal test verification provider','full','temporal','L0','2.0.0','active')`,
  ).run();

  replayMod.ensureReplayCapsuleSchema(db);

  // Build lifecycle input.
  const devPolicy = { id: 'reference-development-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = policyMod.hashDevelopmentPolicy(devPolicy);

  const releaseAction = {
    actionId: `temporal-${label}`,
    kind: 'deployment',
    target: `${label}-target`,
    desiredStateHash: shaMod.sha256Hex({ target: `${label}-target`, state: 'released-v1' }),
    payloadHash: shaMod.sha256Hex({ package: `${label}-v1` }),
    required: true,
  };
  const releasePolicy = {
    id: `${label}-release-policy`,
    version: '1.0.0',
    contentHash: '',
    channel: 'test',
    releaseVersion: '1.0.0',
    releaseTag: `${label}-v1`,
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = deliveryPolicyMod.hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: `temporal-${label}`,
    releasePolicyHash: releasePolicy.contentHash,
    candidateScope: { mode: 'lifecycle-output' },
  };
  const operatorAuthorization = {
    schema: 'factory.operator-release-grant.v1',
    ref: `${label}-grant:${shaMod.sha256Hex(grantBody)}`,
    hash: shaMod.sha256Hex(grantBody),
    ...grantBody,
  };

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: label,
      context: `temporal conformance scenario: ${label}`,
      evidence: [],
      constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: `${label}-repo`, role: 'component' },
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

  const orderRef = `order-${label}-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES (?,1,1,'idea_url','starting')`,
  ).run(orderRef);

  const launchRef = launchMod.requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: `temporal-${label}`,
    idempotencyKey: `${label}-${randomUUID()}`,
    concurrency,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);

  dbMod.closeDb();
  return { dbPath, launchRef, dir };
}

/**
 * Bootstrap a deferred-delivery database (no release authorization).
 * Used for Development-focused temporal scenarios that don't need Delivery.
 */
export async function bootstrapDeferredDb(opts) {
  const { repoPath, baseCommit, concurrency = 1, modelConcurrency = 1, label = 'temporal' } = opts;
  const dir = mkdtempSync(path.join(os.tmpdir(), `saga-${label}-db-`));
  const dbPath = path.join(dir, 'temporal.db');
  process.env.DB_PATH = dbPath;

  const dbMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const replayMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js',
  )).href);
  const launchMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js',
  )).href);
  const policyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js',
  )).href);
  const deliveryPolicyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js',
  )).href);

  const db = dbMod.getDb();
  db.prepare(
    `INSERT INTO projects (id,name,description,status,tags,metadata)
     VALUES (1,?,?,?,?,?)`,
  ).run(`Temporal ${label}`, `temporal deferred: ${label}`, 'active', '[]', '{}');
  db.prepare(
    `INSERT INTO epics (id,project_id,name,status,priority)
     VALUES (1,1,'Pipeline','planned','high')`,
  ).run();
  db.prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id,concurrency)
     VALUES (1,?)`,
  ).run(concurrency);
  db.prepare(
    `INSERT INTO repositories (id,name,default_branch,metadata)
     VALUES (1,?,'main','{}')`,
  ).run(`${label}-repo`);
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repoPath);
  db.prepare(
    `INSERT INTO trusted_providers
       (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
     VALUES (9103,1,'deterministic_evidence','development.verification-product-contract.v2',
             'temporal test verification provider','full','temporal','L0','2.0.0','active')`,
  ).run();
  replayMod.ensureReplayCapsuleSchema(db);

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = policyMod.hashDevelopmentPolicy(devPolicy);
  const deferredProfile = {
    schemaVersion: 'factory.delivery-deferred-profile.v1',
    reason: 'authorization-required',
    source: 'temporal-test',
  };
  deferredProfile.profileHash = deliveryPolicyMod.hashDeliveryDeferredProfile(deferredProfile);

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: label,
      context: `temporal deferred scenario: ${label}`,
      evidence: [],
      constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: `${label}-repo`, role: 'component' },
        integrationBranch: 'dev',
        expectedBaseCommit: baseCommit,
      }],
      policy: devPolicy,
    },
    delivery: { mode: 'deferred', policy: null, operatorAuthorization: null, deferredProfile },
  };

  const orderRef = `order-${label}-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES (?,1,1,'idea_url','starting')`,
  ).run(orderRef);
  const launchRef = launchMod.requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: `temporal-${label}`,
    idempotencyKey: `${label}-${randomUUID()}`,
    concurrency,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
  dbMod.closeDb();
  return { dbPath, launchRef, dir };
}
