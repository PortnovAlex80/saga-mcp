#!/usr/bin/env node

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = resolve(process.env.SAGA_REAL_SMOKE_ROOT ?? '.real-factory-smoke');
const repositoryPath = join(root, 'product');
const dbPath = join(root, 'factory.sqlite');
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(repositoryPath, { recursive: true });

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Saga Real Smoke']);
git(['config', 'user.email', 'saga-real@example.test']);
writeFileSync(join(repositoryPath, 'README.md'), '# Real factory smoke target\n');
git(['add', '-A']);
git(['commit', '-m', 'chore: initialize product']);
git(['checkout', '-b', 'dev']);
const baseCommit = git(['rev-parse', 'HEAD']);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'real-factory-glm52','active')").run();
db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'accessible-counter','planned')").run();
db.prepare("INSERT INTO repositories (id,name) VALUES (1,'accessible-counter-repo')").run();
db.prepare(`INSERT INTO project_repositories
  (id,project_id,repository_id,role,local_path,integration_branch,status)
  VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
db.prepare(`INSERT INTO trusted_providers
  (id,project_id,name,version,category,trust_basis,determinism,scope,status)
  VALUES (1,1,'saga-real-model-worker','1.0.0','deterministic_evidence',
          'real factory smoke execution','partial','factory-smoke','active')`).run();
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
    subject: 'Build a small accessible static counter page with increment, decrement and reset controls, keyboard operation, visible focus and a live announced value.',
    context: { type: 'web-app', complexity: 'XS' },
    evidence: {},
    constraints: { staticFilesOnly: true, noDependencies: true },
  },
  development: {
    repositories: [{
      repositoryRef: { repositoryName: 'accessible-counter-repo', role: 'component' },
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
const orderRef = `order-real-${crypto.randomUUID()}`;
const launchRef = `launch-real-${crypto.randomUUID()}`;
db.prepare(`INSERT INTO factory_orders
  (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
  VALUES (?,1,1,NULL,'existing_project','starting')`).run(orderRef);
db.prepare(`INSERT INTO factory_launch_requests
  (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
   lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,
   concurrency,state)
  VALUES (?,?,'new',1,1,NULL,?,?,'real-factory-smoke',?,5,'requested')`).run(
  launchRef,
  orderRef,
  JSON.stringify(lifecycleInput),
  lifecycleInput.schemaVersion,
  `real-${crypto.randomUUID()}`,
);
db.close();
process.stdout.write(`${JSON.stringify({ root, repositoryPath, dbPath, launchRef }, null, 2)}\n`);
