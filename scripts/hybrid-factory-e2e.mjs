#!/usr/bin/env node
/**
 * Hybrid factory end-to-end: simulator for Discovery/Formalization/Delivery,
 * real GLM-5.2 for Development.
 *
 * This is the production-shaped proof that the Execution Routing architecture
 * mixes executors in ONE continuous factory run. The routing policy is the
 * single switch — everything else (sandbox setup, git init, lifecycle input,
 * audit) is identical to mock-factory-e2e, because the factory does not care
 * which executor runs: the route resolver freezes the decision at claim, the
 * runner reads the frozen executor_kind.
 *
 *   Discovery     (product-discovery)        → simulator  (default)
 *   Formalization (solution-formalization)   → simulator  (default)
 *   Development   (solution-development)     → real claude-cli + glm-5.2 (override)
 *   Delivery      (delivery-release)         → simulator  (default)
 *
 * Usage:
 *   node scripts/hybrid-factory-e2e.mjs
 *
 * Env:
 *   SAGA_KEEP_HYBRID_SANDBOX=1   retain the temp sandbox + DB for inspection
 *   SAGA_HYBRID_MODEL            override the Development model (default glm-5.2)
 *   SAGA_HYBRID_PROVIDER         override the Development provider (default zai)
 *   SAGA_HYBRID_EFFORT           override the Development effort (default medium)
 */

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const sandbox = mkdtempSync(join(tmpdir(), 'saga-hybrid-e2e-'));
const repositoryPath = join(sandbox, 'product');
const dbPath = join(sandbox, 'factory.sqlite');

// Routing policy: Development on real GLM, everything else on the simulator.
const hybridModel = process.env.SAGA_HYBRID_MODEL ?? 'glm-5.2';
const hybridProvider = process.env.SAGA_HYBRID_PROVIDER ?? 'zai';
const hybridEffort = process.env.SAGA_HYBRID_EFFORT ?? 'medium';

function git(args, cwd = repositoryPath) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

try {
  mkdirSync(repositoryPath);
  git(['init', '-b', 'main']);
  writeFileSync(join(repositoryPath, 'README.md'), '# hybrid product\n');
  git(['add', '-A']);
  git(['-c', 'user.email=sim@example.test', '-c', 'user.name=Simulator', 'commit', '-m', 'initial']);
  git(['checkout', '-b', 'dev']);
  const baseCommit = git(['rev-parse', 'HEAD']);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'hybrid-factory','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'button-color','planned')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (1,'button-color-repo')").run();
  db.prepare(`INSERT INTO project_repositories
    (id,project_id,repository_id,role,local_path,integration_branch,status)
    VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES (1,'saga-deterministic-simulator','1.0.0','deterministic_evidence',
            'deterministic mock factory','full','hybrid-factory','active')`).run();

  // lifecycle_execution_controls carries the front-selected inference. The
  // routing policy overrides it ONLY for Development (explicit provider/model/
  // effort). For simulator stages it is irrelevant — the simulator ignores
  // model_route entirely (provider/model/effort = null).
  db.prepare(`INSERT INTO lifecycle_execution_controls
    (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
    VALUES (1,2,?,?,?,2)`).run(hybridProvider, hybridModel, hybridEffort);

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
  const orderRef = `order-hybrid-${crypto.randomUUID()}`;
  const launchRef = `launch-hybrid-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO factory_orders
    (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
    VALUES (?,1,1,NULL,'existing_project','starting')`).run(orderRef);
  db.prepare(`INSERT INTO factory_launch_requests
    (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
     lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,concurrency,state)
    VALUES (?,?,'new',1,1,NULL,?,?,'hybrid-factory-e2e',?,2,'requested')`).run(
    launchRef,
    orderRef,
    JSON.stringify(lifecycleInput),
    lifecycleInput.schemaVersion,
    `hybrid-${crypto.randomUUID()}`,
  );
  db.close();

  process.stdout.write(
    `[hybrid] Development → ${hybridProvider}/${hybridModel} (effort=${hybridEffort}); `
    + `Discovery/Formalization/Delivery → simulator\n`,
  );

  // The hybrid routing policy: Development on real claude-cli, everything else
  // on the deterministic simulator. This is the ONLY difference from
  // mock-factory-e2e — the architecture handles the rest.
  const routingPolicy = {
    version: '1',
    default: { executor: { kind: 'claude-cli-simulator' } },
    routes: [
      {
        match: { module: 'solution-development' },
        route: {
          executor: { kind: 'claude-cli' },
          provider: hybridProvider,
          model: hybridModel,
          effort: hybridEffort,
        },
      },
    ],
  };

  const run = spawnSync(process.execPath, [join(root, 'dist', 'orchestrate-cli.js'), `--launch-ref=${launchRef}`], {
    cwd: root,
    encoding: 'utf8',
    // Real GLM is slower than the simulator — allow up to 30 minutes.
    timeout: 1800_000,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_SIM_SCENARIO: 'button-color',
      SAGA_EXECUTION_ROUTES_JSON: JSON.stringify(routingPolicy),
      SAGA_SIMULATOR_PATH: `node ${join(root, 'tools', 'claude-cli-simulator.mjs')}`,
      // Legacy fallback (pre-v2); not reached for v2 claims, but kept so the
      // runner's last-resort path still points at the simulator.
      SAGA_CLAUDE_PATH: `node ${join(root, 'tools', 'claude-cli-simulator.mjs')}`,
      SAGA_REAL_CLAUDE_PATH: process.env.SAGA_REAL_CLAUDE_PATH ?? 'claude',
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
  const developmentOutput = audit.prepare(
    `SELECT status,local_outcome FROM factory_process_runs
      WHERE module_name='solution-development' ORDER BY id DESC LIMIT 1`,
  ).get();
  const nonAcceptedWorkplaces = audit.prepare(
    `SELECT production_cell_id, loop_state, terminal_reason
       FROM factory_workplaces
      WHERE NOT (loop_state='terminal' AND terminal_reason='accepted')`,
  ).all();
  const unboundVerificationTasks = audit.prepare(
    `SELECT id FROM tasks
      WHERE task_kind='verification.ac'
        AND verification_target_artifact_id IS NULL`,
  ).all();

  // Routing proof: verify the frozen executor_kind matches the policy per module.
  // Development executions must be claude-cli; all others must be simulator.
  const devExecutions = audit.prepare(
    `SELECT json_extract(metadata,'$.execution_context.executor_kind') AS kind
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
       JOIN factory_process_runs r ON r.id=json_extract(t.metadata,'$.process_run_id')
      WHERE r.module_name='solution-development'`,
  ).all();
  const nonDevExecutions = audit.prepare(
    `SELECT json_extract(metadata,'$.execution_context.executor_kind') AS kind,
            r.module_name AS module
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
       JOIN factory_process_runs r ON r.id=json_extract(t.metadata,'$.process_run_id')
      WHERE r.module_name!='solution-development'`,
  ).all();
  const devRouteMismatch = devExecutions.filter(e => e.kind !== 'claude-cli');
  const nonDevRouteMismatch = nonDevExecutions.filter(e => e.kind !== 'claude-cli-simulator');
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
      `hybrid factory did not complete: ${JSON.stringify({ lifecycle, developmentOutput, nonAcceptedWorkplaces, unboundVerificationTasks })}\n`
      + `${run.stdout}\n${run.stderr}`,
    );
  }
  if (devExecutions.length === 0) {
    throw new Error('ROUTING_PROOF_FAILED: no Development worker executions found');
  }
  if (devRouteMismatch.length > 0) {
    throw new Error(
      `ROUTING_PROOF_FAILED: expected Development executions on claude-cli, got: ${JSON.stringify(devRouteMismatch)}`,
    );
  }
  if (nonDevRouteMismatch.length > 0) {
    throw new Error(
      `ROUTING_PROOF_FAILED: expected non-Development executions on simulator, got: ${JSON.stringify(nonDevRouteMismatch)}`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    lifecycle,
    development: developmentOutput,
    routingProof: {
      developmentExecutions: devExecutions.length,
      developmentExecutor: 'claude-cli',
      nonDevelopmentExecutions: nonDevExecutions.length,
      nonDevelopmentExecutor: 'claude-cli-simulator',
    },
    nonAcceptedWorkplaces: nonAcceptedWorkplaces.length,
  }, null, 2)}\n`);
  process.stdout.write('\n✅ HYBRID FACTORY PASSED — Discovery/Formalization/Delivery on simulator, Development on real GLM.\n');
} finally {
  if (process.env.SAGA_KEEP_HYBRID_SANDBOX !== '1') {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else {
    process.stderr.write(`hybrid sandbox retained: ${sandbox}\n`);
  }
}
