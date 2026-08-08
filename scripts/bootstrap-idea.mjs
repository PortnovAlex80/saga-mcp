#!/usr/bin/env node
/**
 * Parametric factory bootstrap — creates a fresh sandbox with a CUSTOM idea,
 * sets up the product repo + factory order, and prints the launch command.
 *
 * Usage: node bootstrap-idea.mjs <sandbox-name> <idea-text>
 *
 * The sandbox is created under .factory-sandboxes/<sandbox-name>/ with its own
 * git repo + SQLite DB. Multiple sandboxes can run concurrently (independent
 * DB paths).
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const sandboxName = process.argv[2];
const idea = process.argv[3];

if (!sandboxName || !idea) {
  process.stderr.write('Usage: node bootstrap-idea.mjs <sandbox-name> <idea-text>\n');
  process.exit(1);
}

const root = resolve(`.factory-sandboxes/${sandboxName}`);
const repositoryPath = join(root, 'product');
const dbPath = join(root, 'factory.sqlite');

if (existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(repositoryPath, { recursive: true });

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Saga Factory']);
git(['config', 'user.email', 'saga-factory@example.test']);
writeFileSync(join(repositoryPath, 'README.md'), `# ${sandboxName}\n`);
git(['add', '-A']);
git(['commit', '-m', 'chore: initialize product']);
git(['checkout', '-b', 'dev']);
const baseCommit = git(['rev-parse', 'HEAD']);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Import schema from dist
const { SCHEMA_SQL } = await import('../dist/schema.js');
const { sha256Hex } = await import('../dist/shared/canonical-json.js');
db.exec(SCHEMA_SQL);

// Apply migrations
const { rebuildFactoryOrdersWithoutColumnUniques, rebuildLaunchIdempotencyIndex } = await import('../dist/schema.js');
rebuildFactoryOrdersWithoutColumnUniques(db);
rebuildLaunchIdempotencyIndex(db);

const projectName = `factory-${sandboxName}`;
db.prepare("INSERT INTO projects (id,name,description,status) VALUES (1,?,'idea run','active')").run(projectName);
db.prepare("INSERT INTO epics (id,project_id,name,description,status,priority) VALUES (1,1,?,?, 'planned','high')").run('REQ-001', idea);
db.prepare("INSERT INTO repositories (id,name) VALUES (1,?)").run(`${sandboxName}-repo`);
db.prepare(`INSERT INTO project_repositories
  (id,project_id,repository_id,role,local_path,integration_branch,status)
  VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
db.prepare(`INSERT INTO trusted_providers
  (id,project_id,name,version,category,trust_basis,determinism,scope,status)
  VALUES (1,1,'saga-real-model-worker','1.0.0','deterministic_evidence',
          'real factory execution','partial','factory-smoke','active')`).run();
db.prepare(`INSERT INTO lifecycle_execution_controls
  (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
  VALUES (1,5,'zai','glm-5.2','medium',5)`).run();

const policyBase = { id: 'reference-development-policy', version: '1.0.0' };
const deferredBase = {
  schemaVersion: 'factory.delivery-deferred-profile.v1',
  reason: 'authorization-required',
  source: 'start-from-idea',
};
const lifecycleInput = {
  schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
  initiative: {
    subject: idea,
    context: { type: 'web-app', complexity: 'XS' },
    evidence: {},
    constraints: { staticFilesOnly: true, noDependencies: true },
  },
  development: {
    repositories: [{
      repositoryRef: { repositoryName: `${sandboxName}-repo`, role: 'component' },
      integrationBranch: 'dev',
      expectedBaseCommit: baseCommit,
    }],
    policy: { ...policyBase, contentHash: sha256Hex(policyBase) },
  },
  delivery: {
    mode: 'deferred', policy: null, operatorAuthorization: null,
    deferredProfile: { ...deferredBase, profileHash: sha256Hex(deferredBase) },
  },
};
const orderRef = `order-${crypto.randomUUID()}`;
const launchRef = `launch-${crypto.randomUUID()}`;
const idempotencyKey = `idea-${sandboxName}-${crypto.randomUUID()}`;
db.prepare(`INSERT INTO factory_orders
  (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
  VALUES (?,1,1,NULL,'existing_project','starting')`).run(orderRef);
db.prepare(`INSERT INTO factory_launch_requests
  (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
   lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,
   concurrency,state)
  VALUES (?,?,'new',1,1,NULL,?,?,'factory-idea',?,5,'requested')`).run(
  launchRef, orderRef,
  JSON.stringify(lifecycleInput), lifecycleInput.schemaVersion,
  idempotencyKey,
);
db.close();
process.stdout.write(`${JSON.stringify({ root, dbPath, launchRef, idea: idea.slice(0, 80) }, null, 2)}\n`);
