import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const sandbox = mkdtempSync(join(tmpdir(), 'saga-factory-e2e-'));
const repositoryPath = join(sandbox, 'product');
const dbPath = join(sandbox, 'factory.sqlite');

function git(args, cwd = repositoryPath) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

try {
  mkdirSync(repositoryPath);
  git(['init', '-b', 'main']);
  writeFileSync(join(repositoryPath, 'README.md'), '# mock product\n');
  git(['add', '-A']);
  git(['-c', 'user.email=sim@example.test', '-c', 'user.name=Simulator', 'commit', '-m', 'initial']);
  git(['checkout', '-b', 'dev']);
  const baseCommit = git(['rev-parse', 'HEAD']);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'mock-factory','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'button-color','planned')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (1,'button-color-repo')").run();
  db.prepare(`INSERT INTO project_repositories
    (id,project_id,repository_id,role,local_path,integration_branch,status)
    VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES (1,'saga-deterministic-simulator','1.0.0','deterministic_evidence',
            'deterministic mock factory','full','mock-factory','active')`).run();

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
  const orderRef = `order-mock-${crypto.randomUUID()}`;
  const launchRef = `launch-mock-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO factory_orders
    (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
    VALUES (?,1,1,NULL,'existing_project','starting')`).run(orderRef);
  db.prepare(`INSERT INTO factory_launch_requests
    (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
     lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,concurrency,state)
    VALUES (?,?,'new',1,1,NULL,?,?,'mock-factory-e2e',?,2,'requested')`).run(
    launchRef,
    orderRef,
    JSON.stringify(lifecycleInput),
    lifecycleInput.schemaVersion,
    `mock-${crypto.randomUUID()}`,
  );
  db.close();

  const run = spawnSync(process.execPath, [join(root, 'dist', 'orchestrate-cli.js'), `--launch-ref=${launchRef}`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_SIM_SCENARIO: 'button-color',
      SAGA_CLAUDE_PATH: `node ${join(root, 'tools', 'claude-cli-simulator.mjs')}`,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: join(root, 'product-lifecycle-composition.mjs'),
      SAGA_ORCHESTRATION_LOG: join(sandbox, 'logs'),
    },
  });
  if (run.status !== 0) {
    throw new Error(`orchestrator failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
  }

  const audit = new Database(dbPath, { readonly: true });
  const lifecycle = audit.prepare(
    'SELECT id,status,current_stage_id,terminal_status FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1',
  ).get();
  const workplaces = audit.prepare(
    `SELECT production_cell_id,loop_state,terminal_reason,COUNT(*) AS count
       FROM factory_workplaces GROUP BY production_cell_id,loop_state,terminal_reason
       ORDER BY production_cell_id`,
  ).all();
  const candidateSets = audit.prepare('SELECT COUNT(*) AS count FROM factory_candidate_sets').get().count;
  const gateDecisions = audit.prepare('SELECT COUNT(*) AS count FROM factory_gate_decisions').get().count;
  const developmentOutput = audit.prepare(
    `SELECT status,local_outcome FROM factory_process_runs
      WHERE module_name='solution-development' ORDER BY id DESC LIMIT 1`,
  ).get();
  const unboundVerificationTasks = audit.prepare(
    `SELECT id FROM tasks
      WHERE task_kind='verification.ac'
        AND verification_target_artifact_id IS NULL`,
  ).all();
  const nonAcceptedWorkplaces = workplaces.filter(row =>
    row.loop_state !== 'terminal' || row.terminal_reason !== 'accepted');
  audit.close();

  if (
    !lifecycle
    || lifecycle.status !== 'completed'
    || lifecycle.terminal_status !== 'approval-required'
    || developmentOutput?.status !== 'completed'
    || developmentOutput?.local_outcome !== 'verified'
    || nonAcceptedWorkplaces.length > 0
    || unboundVerificationTasks.length > 0
  ) {
    throw new Error(
      `factory did not complete: ${JSON.stringify({ lifecycle, workplaces, unboundVerificationTasks })}\n`
      + `${run.stdout}\n${run.stderr}`,
    );
  }
  if (candidateSets < 1 || gateDecisions < 1) {
    throw new Error(`factory omitted provenance: ${JSON.stringify({ candidateSets, gateDecisions })}`);
  }
  process.stdout.write(`${JSON.stringify({
    lifecycle,
    development: developmentOutput,
    workplaces,
    candidateSets,
    gateDecisions,
  }, null, 2)}\n`);
} finally {
  if (process.env.SAGA_KEEP_MOCK_SANDBOX !== '1') {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  else process.stderr.write(`mock sandbox retained: ${sandbox}\n`);
}
