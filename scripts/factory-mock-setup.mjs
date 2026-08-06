import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = path.resolve(import.meta.dirname, '..');
const dbPath = path.resolve(process.env.DB_PATH ?? path.join(root, '.factory-mock.db'));
const repositoryPath = path.resolve(process.env.SAGA_MOCK_REPOSITORY ?? path.join(root, 'sim-workspace'));
const expectedBaseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryPath,
  encoding: 'utf8',
}).trim();

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
db.prepare('INSERT INTO projects (id, name, status) VALUES (1, ?, ?)')
  .run('factory-mock', 'active');
db.prepare('INSERT INTO epics (id, project_id, name, status) VALUES (1, 1, ?, ?)')
  .run('button-color', 'planned');
db.prepare('INSERT INTO repositories (id, name) VALUES (1, ?)')
  .run('button-color-repo');
db.prepare(`INSERT INTO project_repositories
  (id, project_id, repository_id, role, local_path, integration_branch, status)
  VALUES (1, 1, 1, ?, ?, ?, ?)`)
  .run('component', repositoryPath, 'dev', 'active');

const policyBase = { id: 'reference-development-policy', version: '1.0.0' };
const deferredBase = {
  schemaVersion: 'factory.delivery-deferred-profile.v1',
  reason: 'authorization-required',
  source: 'start-from-idea',
};
const lifecycleInput = {
  schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
  initiative: {
    subject: 'Button color toggle: a static page with one button that alternates between blue and red on click',
    context: { type: 'web-app', complexity: 'XS' },
    evidence: {},
    constraints: { maxFiles: 1 },
  },
  development: {
    repositories: [{
      repositoryRef: { repositoryName: 'button-color-repo', role: 'component' },
      integrationBranch: 'dev',
      expectedBaseCommit,
    }],
    policy: { ...policyBase, contentHash: sha256Hex(policyBase) },
  },
  delivery: {
    mode: 'deferred',
    policy: null,
    operatorAuthorization: null,
    deferredProfile: { ...deferredBase, profileHash: sha256Hex(deferredBase) },
  },
};

const orderRef = `order-mock-${crypto.randomUUID()}`;
const launchRef = `launch-mock-${crypto.randomUUID()}`;
db.prepare(`INSERT INTO factory_orders
  (order_ref, project_id, epic_id, lifecycle_run_id, source_kind, state)
  VALUES (?, 1, 1, NULL, 'existing_project', 'starting')`).run(orderRef);
db.prepare(`INSERT INTO factory_launch_requests
  (launch_ref, order_ref, mode, project_id, epic_id, lifecycle_run_id,
   lifecycle_input_json, lifecycle_input_schema, initiated_by,
   idempotency_key, concurrency, state)
  VALUES (?, ?, 'new', 1, 1, NULL, ?, ?, 'factory-mock', ?, 2, 'requested')`).run(
  launchRef,
  orderRef,
  JSON.stringify(lifecycleInput),
  lifecycleInput.schemaVersion,
  `factory-mock-${crypto.randomUUID()}`,
);
db.close();

fs.writeFileSync(path.join(root, 'saga-launch-ref.txt'), launchRef);
console.log(JSON.stringify({ dbPath, repositoryPath, expectedBaseCommit, launchRef }, null, 2));
