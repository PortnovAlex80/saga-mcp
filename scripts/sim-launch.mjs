import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const policyBase = { id: 'reference-development-policy', version: '1.0.0' };
const policyHash = sha256Hex(policyBase);
const deferredBase = {
  schemaVersion: 'factory.delivery-deferred-profile.v1',
  reason: 'authorization-required',
  source: 'start-from-idea',
};
const profileHash = sha256Hex(deferredBase);

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
      expectedBaseCommit: 'f692189f33e2e85ab0bdd19ccaa0a2f268c800c7',
    }],
    policy: { id: 'reference-development-policy', version: '1.0.0', contentHash: policyHash },
  },
  delivery: {
    mode: 'deferred',
    policy: null,
    operatorAuthorization: null,
    deferredProfile: {
      schemaVersion: 'factory.delivery-deferred-profile.v1',
      reason: 'authorization-required',
      source: 'start-from-idea',
      profileHash: profileHash,
    },
  },
};

const lifecycleInputJson = JSON.stringify(lifecycleInput);
const db = new Database(process.env.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.prepare('DELETE FROM factory_launch_requests').run();
db.prepare('DELETE FROM factory_orders').run();
db.prepare("UPDATE tasks SET status='todo', assigned_to=NULL, current_execution_id=NULL").run();
db.prepare(`INSERT OR IGNORE INTO trusted_providers
  (project_id,name,version,category,trust_basis,determinism,scope,status)
  VALUES (1,'saga-deterministic-simulator','1.0.0','deterministic_evidence',
          'deterministic mock factory','full','mock-factory','active')`).run();

const orderRef = 'order-sim-' + crypto.randomUUID().slice(0,8);
const launchRef = 'launch-' + crypto.randomUUID();
db.prepare(`INSERT INTO factory_orders
  (order_ref, project_id, epic_id, lifecycle_run_id, source_kind, state)
  VALUES (?, ?, ?, NULL, 'existing_project', 'starting')`).run(orderRef, 1, 1);
db.prepare(`INSERT INTO factory_launch_requests
  (launch_ref, order_ref, mode, project_id, epic_id, lifecycle_run_id,
   lifecycle_input_json, lifecycle_input_schema, initiated_by,
   idempotency_key, concurrency, state)
  VALUES (?, ?, 'new', 1, 1, NULL, ?, ?, 'simulator', ?, 2, 'requested')`).run(
  launchRef, orderRef, lifecycleInputJson, 'factory.product-delivery-lifecycle-input.v2', 'sim-' + Date.now()
);
fs.writeFileSync('saga-launch-ref.txt', launchRef);
console.log('launchRef:', launchRef);
db.close();
