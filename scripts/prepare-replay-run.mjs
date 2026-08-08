#!/usr/bin/env node
/**
 * Prepare a clean replay-test DB: copy the completed accessible-counter
 * project, strip all execution state (tasks, workplaces, lifecycle runs, etc.),
 but KEEP the replay capsules. Then a fresh factory start should hit capsules
 for all compatible worker invocations and produce ZERO LLM calls.
 *
 * Usage: node prepare-replay-run.mjs
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const sandboxName = process.argv[2] ?? 'replay-proof';
const srcDb = '.real-factory-smoke/factory.sqlite';
const sandboxRoot = `.factory-sandboxes/${sandboxName}`;
const dstDb = `${sandboxRoot}/factory.sqlite`;

// Copy the completed Run A DB
if (existsSync(sandboxRoot)) {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
mkdirSync(sandboxRoot, { recursive: true });
mkdirSync(`${sandboxRoot}/product`, { recursive: true });
copyFileSync(srcDb, dstDb);
copyFileSync(srcDb, dstDb);

const db = new Database(dstDb);
db.pragma('foreign_keys = OFF');

// Count capsules BEFORE stripping
const capsBefore = db.prepare('SELECT count(*) as n FROM factory_replay_capsules').get().n;
console.log('capsules before strip:', capsBefore);

// Strip ALL execution state. Keep: projects, epics, repositories,
// project_repositories, trusted_providers, lifecycle_execution_controls,
// factory_replay_capsules.
const tablesToStrip = [
  'tasks',
  'worker_executions',
  'command_receipts',
  'factory_workplaces',
  'factory_candidate_sets',
  'factory_candidate_set_members',
  'factory_gate_decisions',
  'factory_gate_runs',
  'factory_process_runs',
  'factory_lifecycle_runs',
  'factory_node_runs',
  'factory_managed_node_submissions',
  'factory_managed_artifact_productions',
  'factory_process_products',
  'factory_raw_submissions',
  'factory_work_intents',
  'factory_proposals',
  'factory_readiness_control_intents',
  'factory_readiness_assessments',
  'factory_normalization_proposals',
  'factory_discovery_diagnosis_control_intents',
  'factory_discovery_diagnosis_reports',
  'factory_discovery_settlements',
  'factory_discovery_outcome_certificates',
  'factory_checkpoints',
  'factory_adoptions',
  'factory_resume_directives',
  'factory_orders',
  'factory_launch_requests',
  'artifacts',
  'comments',
  'notes',
  'subtasks',
];

for (const table of tablesToStrip) {
  try {
    db.prepare(`DELETE FROM ${table}`).run();
  } catch {
    // Table may not exist or have FK issues — skip
  }
}

// Verify capsules survived
const capsAfter = db.prepare('SELECT count(*) as n FROM factory_replay_capsules').get().n;
console.log('capsules after strip:', capsAfter);

// Re-init the product repo to a clean state
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const repoPath = `${sandboxRoot}/product`;
function git(args) {
  const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
// Re-init the repo fresh
try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
mkdirSync(repoPath, { recursive: true });
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Saga Factory']);
git(['config', 'user.email', 'saga-factory@example.test']);
writeFileSync(`${repoPath}/README.md`, '# Replay Proof Target\n');
git(['add', '-A']);
git(['commit', '-m', 'chore: initialize product']);
git(['checkout', '-b', 'dev']);
const baseCommit = git(['rev-parse', 'HEAD']);
console.log('fresh repo baseCommit:', baseCommit);

// Re-insert the project + epic + repo (they were preserved by not being in
// the strip list, but let's verify)
const project = db.prepare('SELECT id, name FROM projects WHERE id=1').get();
const epic = db.prepare('SELECT id, name FROM epics WHERE id=1').get();
console.log('project:', project, 'epic:', epic);

// Update the repository local_path to the new sandbox
db.prepare('UPDATE project_repositories SET local_path=? WHERE id=1').run(
  path.resolve(repoPath),
);

// Create the factory order + launch request with the SAME lifecycle input
// that produced the capsules (to get matching semantic keys).
// We need to reconstruct the lifecycle input. Read the original idea from
// the project description.
import crypto from 'node:crypto';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const policyBase = { id: 'reference-development-policy', version: '1.0.0' };
const deferredBase = {
  schemaVersion: 'factory.delivery-deferred-profile.v1',
  reason: 'authorization-required',
  source: 'start-from-idea',
};
const lifecycleInput = {
  schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
  initiative: {
    subject: project.name === 'real-factory-glm52'
      ? 'Build a small accessible static counter page with increment, decrement and reset controls, keyboard operation, visible focus and a live announced value.'
      : project.name,
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

const orderRef = `order-replay-${crypto.randomUUID()}`;
const launchRef = `launch-replay-${crypto.randomUUID()}`;
const idempotencyKey = `replay-proof-${crypto.randomUUID()}`;

db.prepare(
  `INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
   VALUES (?,1,1,NULL,'existing_project','starting')`,
).run(orderRef);
db.prepare(
  `INSERT INTO factory_launch_requests
     (launch_ref,order_ref,mode,project_id,epic_id,
      lifecycle_input_json,lifecycle_input_schema,
      initiated_by,idempotency_key,concurrency,state)
   VALUES (?,?,'new',1,1,?,?, 'replay-proof', ?, 5, 'requested')`,
).run(
  launchRef, orderRef,
  JSON.stringify(lifecycleInput), lifecycleInput.schemaVersion,
  idempotencyKey,
);

db.pragma('foreign_keys = ON');
db.close();

process.stdout.write(`${JSON.stringify({
  launchRef, dbPath: dstDb, capsules: capsAfter,
}, null, 2)}\n`);
