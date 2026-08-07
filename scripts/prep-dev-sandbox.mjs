#!/usr/bin/env node
/**
 * Prepares a Development-ready sandbox: runs the simulator through Discovery +
 * Formalization, stops when Development stage is reached. The resulting sandbox
 * has all formalization artifacts accepted and is ready for a real-model resume
 * that runs ONLY the Development stage.
 *
 * Usage:
 *   node scripts/prep-dev-sandbox.mjs [sandbox-root]
 *
 * Output (stdout, last line):
 *   SANDBOX_READY <path> <dbPath> <launchRef-for-resume>
 *
 * The sandbox is NOT deleted. To clean up: rm -rf <path>.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = resolve(process.env.SAGA_REAL_SMOKE_ROOT
  ?? process.argv[2]
  ?? join(tmpdir(), `saga-prep-dev-${crypto.randomUUID().slice(0, 8)}`));
const repositoryPath = join(root, 'product');
const dbPath = join(root, 'factory.sqlite');
mkdirSync(repositoryPath, { recursive: true });

function git(args, cwd = repositoryPath) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// --- bootstrap product repo ---
git(['init', '-b', 'main']);
writeFileSync(join(repositoryPath, 'README.md'), '# prep-dev product\n');
git(['add', '-A']);
git(['-c', 'user.email=sim@example.test', '-c', 'user.name=PrepDev', 'commit', '-m', 'initial']);
git(['checkout', '-b', 'dev']);
const baseCommit = git(['rev-parse', 'HEAD']);

// --- bootstrap DB ---
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'prep-dev','active')").run();
db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'button-color','planned')").run();
db.prepare("INSERT INTO repositories (id,name) VALUES (1,'button-color-repo')").run();
db.prepare(`INSERT INTO project_repositories
  (id,project_id,repository_id,role,local_path,integration_branch,status)
  VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
db.prepare(`INSERT INTO trusted_providers
  (project_id,name,version,category,trust_basis,determinism,scope,status)
  VALUES (1,'saga-deterministic-simulator','1.0.0','deterministic_evidence',
          'deterministic mock factory','full','button-color','active')`).run();
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
    subject: 'A static page with one button alternating between blue and red',
    context: { type: 'web-app', complexity: 'XS' },
    evidence: {},
    constraints: { maxFiles: 1 },
  },
  development: {
    repositories: [{
      repositoryRef: { repositoryName: 'button-color-repo', role: 'component' },
      integrationBranch: 'dev',
      expectedBaseCommit: baseCommit,
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

const orderRef = `order-prep-${crypto.randomUUID()}`;
const launchRef = `launch-prep-${crypto.randomUUID()}`;
db.prepare(`INSERT INTO factory_orders
  (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
  VALUES (?,1,1,NULL,'existing_project','starting')`).run(orderRef);
db.prepare(`INSERT INTO factory_launch_requests
  (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
   lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,concurrency,state)
  VALUES (?,?,'new',1,1,NULL,?,?,'prep-dev-sandbox',?,2,'requested')`).run(
  launchRef, orderRef,
  JSON.stringify(lifecycleInput),
  lifecycleInput.schemaVersion,
  `prep-${crypto.randomUUID()}`,
);
db.close();

process.stdout.write(`PREP: sandbox=${root}\n`);

// --- run simulator orchestrator (Discovery + Formalization + Development + Delivery) ---
// The simulator completes the full pipeline. We let it finish, then reset
// the Development + Delivery stages so the sandbox is at the Development entry.
const sagaRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const run = spawnSync(process.execPath, [join(sagaRoot, 'dist', 'orchestrate-cli.js'), `--launch-ref=${launchRef}`], {
  cwd: sagaRoot,
  encoding: 'utf8',
  timeout: 180_000,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    SAGA_SIM_SCENARIO: 'button-color',
    SAGA_CLAUDE_PATH: `node ${join(sagaRoot, 'tools', 'claude-cli-simulator.mjs')}`,
    SAGA_PRODUCT_LIFECYCLE_COMPOSITION: join(sagaRoot, 'product-lifecycle-composition.mjs'),
    SAGA_ORCHESTRATION_LOG: join(root, 'logs'),
  },
});
if (run.status !== 0) {
  process.stderr.write(`orchestrator failed (${run.status}):\n${run.stdout}\n${run.stderr}\n`);
  process.exit(1);
}

// --- reset to Development entry: clear Development + Delivery, keep Discovery + Formalization ---
const resetDb = new Database(dbPath);
resetDb.pragma('foreign_keys=OFF');
// Delete development + delivery process products
resetDb.prepare("DELETE FROM factory_process_products WHERE process_run_id IN (SELECT id FROM factory_process_runs WHERE module_name IN ('solution-development','delivery-release'))").run();
// Delete development + delivery workplaces
resetDb.prepare("DELETE FROM factory_candidate_set_members WHERE candidate_set_ref IN (SELECT candidate_set_ref FROM factory_candidate_sets WHERE workplace_ref LIKE '%/3/%' OR workplace_ref LIKE '%/4/%')").run();
resetDb.prepare("DELETE FROM factory_candidate_sets WHERE workplace_ref LIKE '%/3/%' OR workplace_ref LIKE '%/3/%' OR workplace_ref LIKE '%/4/%'").run();
resetDb.prepare("DELETE FROM factory_workplaces WHERE process_run_id IN (SELECT id FROM factory_process_runs WHERE module_name IN ('solution-development','delivery-release'))").run();
// Delete development + delivery node_runs
resetDb.prepare("DELETE FROM factory_node_runs WHERE process_run_id IN (SELECT id FROM factory_process_runs WHERE module_name IN ('solution-development','delivery-release'))").run();
// Delete development + delivery tasks
resetDb.prepare("DELETE FROM tasks WHERE workflow_stage IN ('development','delivery')").run();
resetDb.pragma('foreign_keys=ON');
// Delete development + delivery certificates first (FK target)
resetDb.prepare("DELETE FROM factory_process_outcome_certificates WHERE module_name IN ('solution-development','delivery-release')").run();
// Delete development + delivery process_runs
resetDb.prepare("DELETE FROM factory_process_runs WHERE module_name IN ('solution-development','delivery-release')").run();
// Reset lifecycle: back to solution-development stage, paused
resetDb.prepare("UPDATE factory_lifecycle_runs SET status='paused', current_stage_id='solution-development', terminal_status=NULL, error=NULL WHERE id=1").run();
resetDb.close();

// --- verify ---
const verifyDb = new Database(dbPath, { readonly: true });
const lifecycle = verifyDb.prepare('SELECT status,current_stage_id,terminal_status FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1').get();
const formalization = verifyDb.prepare("SELECT status,local_outcome FROM factory_process_runs WHERE module_name='solution-formalization' ORDER BY id DESC LIMIT 1").get();
const artifacts = verifyDb.prepare("SELECT type,status,COUNT(*) n FROM artifacts GROUP BY type,status ORDER BY type").all();
const cert = verifyDb.prepare("SELECT decision FROM factory_process_outcome_certificates WHERE module_name='solution-formalization' ORDER BY id DESC LIMIT 1").get();
verifyDb.close();

if (lifecycle.status !== 'paused' || lifecycle.current_stage_id !== 'solution-development') {
  process.stderr.write(`RESET FAILED: lifecycle=${JSON.stringify(lifecycle)}\n`);
  process.exit(1);
}
if (formalization.status !== 'completed' || formalization.local_outcome !== 'formalized') {
  process.stderr.write(`FORMALIZATION NOT COMPLETED: ${JSON.stringify(formalization)}\n`);
  process.exit(1);
}

process.stdout.write(`\nSANDBOX READY:\n`);
process.stdout.write(`  root:       ${root}\n`);
process.stdout.write(`  dbPath:     ${dbPath}\n`);
process.stdout.write(`  lifecycle:  ${lifecycle.status} @ ${lifecycle.current_stage_id}\n`);
process.stdout.write(`  formalization: ${formalization.local_outcome} (cert: ${cert.decision})\n`);
process.stdout.write(`  artifacts:  ${artifacts.map(a => `${a.type}(${a.n})`).join(' ')}\n`);
process.stdout.write(`\nTo resume on real model:\n`);
process.stdout.write(`  DB_PATH=${dbPath} node dist/orchestrate-cli.js --launch-ref=<resume-ref>\n`);
process.stdout.write(`\nSANDBOX_READY ${root} ${dbPath} ${launchRef}\n`);
