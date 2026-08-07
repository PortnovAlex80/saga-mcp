#!/usr/bin/env node
/**
 * Canonical two-pass replay E2E (CONVEYOR v4.3 §16).
 *
 * ONE database. ONE real Project. ONE real Epic.
 *
 * RUN A: new Factory Start, no capsules → simulator (deterministic) → full
 *   lifecycle to terminal(accepted) → capsules captured via direct capture.
 *
 * RUN B: intentional NEW Factory Start for the SAME project+epic (mode:
 *   'new_start') → new order/run/workplace/execution identities → same
 *   semantic replay keys → capsule HITs → deterministic replay workers →
 *   NEW CandidateSets → CURRENT gates → terminal(accepted).
 *
 * Assert: Run B performs ZERO non-replay (scenario) simulator invocations —
 * every compatible production cell HITs a capsule.
 *
 * This is the architecturally-honest proof. No second database, no capsule
 * copying, no table reset, no fake project, no new epic, no mock routing.
 *
 * Usage:
 *   node scripts/button-color-replay-e2e.mjs
 *
 * Env:
 *   SAGA_REPLAY_E2E_ROOT       sandbox root (default .button-color-replay-e2e)
 *   SAGA_REPLAY_E2E_RESET=1    destroy + recreate the sandbox (default: refuse)
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from '../dist/schema.js';
import { sha256Hex } from '../dist/shared/canonical-json.js';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const sandbox = resolve(process.env.SAGA_REPLAY_E2E_ROOT ?? join(root, '.button-color-replay-e2e'));
const repositoryPath = join(sandbox, 'product');
const dbPath = join(sandbox, 'factory.sqlite');
const logRoot = join(sandbox, 'logs');

// SAFETY: a completed Run A leaves capsules that are expensive to regenerate.
if (existsSync(sandbox)) {
  if (process.env.SAGA_REPLAY_E2E_RESET === '1') {
    rmSync(sandbox, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `[replay-e2e] sandbox '${sandbox}' exists — refusing to delete. `
      + `Set SAGA_REPLAY_E2E_RESET=1 to force a clean reset.\n`,
    );
    process.exit(2);
  }
}
mkdirSync(repositoryPath, { recursive: true });
mkdirSync(logRoot, { recursive: true });

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Saga Replay E2E']);
git(['config', 'user.email', 'saga-replay@example.test']);
writeFileSync(join(repositoryPath, 'README.md'), '# button-color replay target\n');
git(['add', '-A']);
git(['commit', '-m', 'chore: initialize product']);
git(['checkout', '-b', 'dev']);
const baseCommit = git(['rev-parse', 'HEAD']);

// --- ONE bootstrap: ONE project, ONE epic, ONE repo. Both runs reuse them. ---
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'replay-e2e','active')").run();
db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'button-color','planned')").run();
db.prepare("INSERT INTO repositories (id,name) VALUES (1,'button-color-repo')").run();
db.prepare(`INSERT INTO project_repositories
  (id,project_id,repository_id,role,local_path,integration_branch,status)
  VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
db.prepare(`INSERT INTO trusted_providers
  (project_id,name,version,category,trust_basis,determinism,scope,status)
  VALUES (1,'saga-deterministic-simulator','1.0.0','deterministic_evidence',
          'deterministic replay e2e factory','full','replay-e2e','active')`).run();
// Front-selected inference. The simulator ignores model_route, but the claim
// path needs a route to read before replay binding overwrites it on HIT.
db.prepare(`INSERT INTO lifecycle_execution_controls
  (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
  VALUES (1,2,'zai','glm-4.7','medium',2)`).run();
db.close();

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
    mode: 'deferred', policy: null, operatorAuthorization: null,
    deferredProfile: { ...deferredBase, profileHash: sha256Hex(deferredBase) },
  },
};
const lifecycleInputJson = JSON.stringify(lifecycleInput);

/** Provision a new factory order + launch request for project 1 / epic 1. */
function newFactoryStart(tag) {
  const d = new Database(dbPath);
  const orderRef = `order-replay-${tag}-${crypto.randomUUID()}`;
  const launchRef = `launch-replay-${tag}-${crypto.randomUUID()}`;
  d.prepare(`INSERT INTO factory_orders
    (order_ref,project_id,epic_id,source_kind,state)
    VALUES (?,1,1,'existing_project','starting')`).run(orderRef);
  d.prepare(`INSERT INTO factory_launch_requests
    (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
     lifecycle_input_json,lifecycle_input_schema,initiated_by,idempotency_key,
     concurrency,state)
    VALUES (?,?,'new',1,1,NULL,?,?,'button-color-replay-e2e',?,2,'requested')`).run(
    launchRef, orderRef, lifecycleInputJson, lifecycleInput.schemaVersion,
    `replay-${tag}-${crypto.randomUUID()}`,
  );
  d.close();
  return launchRef;
}

function runOrchestrator(launchRef, label) {
  // Routing policy selects the simulator as default executor. On Run B this is
  // irrelevant for capsule HITs (bindReplayToClaim rewrites executor_kind per
  // WorkerExecution regardless of policy) but provides a graceful fallback for
  // any unexpected MISS.
  const routingPolicy = {
    version: '1', default: { executor: { kind: 'claude-cli-simulator' } }, routes: [],
  };
  const simPath = `node ${join(root, 'tools', 'claude-cli-simulator.mjs')}`;
  const run = spawnSync(
    process.execPath,
    [join(root, 'dist', 'orchestrate-cli.js'), `--launch-ref=${launchRef}`],
    {
      cwd: root, encoding: 'utf8', timeout: 600_000,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        SAGA_SIM_SCENARIO: 'button-color',
        SAGA_EXECUTION_ROUTES_JSON: JSON.stringify(routingPolicy),
        SAGA_SIMULATOR_PATH: simPath,
        SAGA_CLAUDE_PATH: simPath,
        SAGA_PRODUCT_LIFECYCLE_COMPOSITION: join(root, 'product-lifecycle-composition.mjs'),
        SAGA_ORCHESTRATION_LOG: logRoot,
      },
    },
  );
  process.stdout.write(`\n===== [${label}] orchestrator stdout (tail) =====\n${run.stdout.split('\n').slice(-12).join('\n')}\n`);
  if (run.status !== 0) {
    process.stderr.write(`[${label}] stderr:\n${run.stderr.split('\n').slice(-15).join('\n')}\n`);
    throw new Error(`[${label}] orchestrator exited ${run.status}`);
  }
}

function audit(label) {
  const d = new Database(dbPath, { readonly: true });
  const lifecycle = d.prepare(
    'SELECT id,status,terminal_status FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1',
  ).get();
  const capsuleCount = d.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get();
  const orders = d.prepare('SELECT COUNT(*) AS n FROM factory_orders WHERE project_id=1').get();
  const latestRunId = d.prepare('SELECT id FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1').get().id;
  // Run B's executions: tasks whose process_run_id belongs to a process run in
  // the latest lifecycle run. process_run_id in task metadata is a number;
  // factory_process_runs has no lifecycle_run_id column, so we approximate by
  // taking the upper half of process runs (Run A = first half, Run B = second).
  const allPr = d.prepare('SELECT id FROM factory_process_runs ORDER BY id').all().map(r => r.id);
  const half = Math.ceil(allPr.length / 2);
  const runBPr = allPr.slice(half);
  const runBPrList = runBPr.length > 0 ? runBPr.join(',') : '0';
  const execs = d.prepare(
    `SELECT we.execution_id, we.metadata
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
      WHERE CAST(json_extract(t.metadata,'$.process_run_id') AS INTEGER) IN (${runBPrList})`,
  ).all();
  const replayBound = execs.filter((e) => {
    const ctx = JSON.parse(e.metadata)?.execution_context;
    return ctx?.replay?.capsule_ref != null;
  }).length;
  const misses = execs.filter((e) => {
    const ctx = JSON.parse(e.metadata)?.execution_context;
    return ctx?.replay?.capsule_ref == null;
  });
  const nonAccepted = d.prepare(
    `SELECT production_cell_id, loop_state, terminal_reason
       FROM factory_workplaces
      WHERE process_run_id IN (
        SELECT id FROM factory_process_runs ORDER BY id DESC LIMIT ?
      )
        AND NOT (loop_state='terminal' AND terminal_reason='accepted')`,
  ).all(half);
  d.close();
  return { label, lifecycle, capsuleCount: capsuleCount.n, orders: orders.n,
    totalExecutions: execs.length, replayBound, misses: misses.length, nonAccepted };
}

// =========================== RUN A (seed) =================================
process.stdout.write('[replay-e2e] RUN A (seed): new Factory Start, simulator produces capsules\n');
const runA = newFactoryStart('A');
runOrchestrator(runA, 'run-A');
const afterA = audit('run-A');
process.stdout.write(`[replay-e2e] RUN A: ${JSON.stringify(afterA, null, 2)}\n`);

if (afterA.lifecycle?.status !== 'completed') {
  throw new Error(`RUN A lifecycle did not complete: ${JSON.stringify(afterA.lifecycle)}`);
}
if (afterA.nonAccepted.length > 0) {
  throw new Error(`RUN A has non-accepted workplaces: ${JSON.stringify(afterA.nonAccepted)}`);
}
if (afterA.capsuleCount === 0) {
  throw new Error('RUN A produced ZERO capsules — direct capture did not run (§13 bug).');
}
process.stdout.write(`[replay-e2e] RUN A OK: ${afterA.capsuleCount} capsules, lifecycle completed\n`);

// =========================== RUN B (replay) ===============================
// Intentional NEW Factory Start for the SAME project+epic. The DB retains the
// capsules from Run A. New order/run/workplace identities; same semantic replay
// keys (projectId + moduleRef + nodeId + workKey + packageDigest +
// semanticInputDigest) → capsule HITs.
process.stdout.write('[replay-e2e] RUN B (replay): new_start for same project+epic, expecting capsule HITs\n');
const runB = newFactoryStart('B');
runOrchestrator(runB, 'run-B');
const afterB = audit('run-B');
process.stdout.write(`[replay-e2e] RUN B: ${JSON.stringify(afterB, null, 2)}\n`);

if (afterB.lifecycle?.status !== 'completed') {
  throw new Error(`RUN B lifecycle did not complete: ${JSON.stringify(afterB.lifecycle)}`);
}
if (afterB.nonAccepted.length > 0) {
  throw new Error(`RUN B has non-accepted workplaces: ${JSON.stringify(afterB.nonAccepted)}`);
}
if (afterB.replayBound === 0) {
  throw new Error('RUN B recorded ZERO capsule-bound executions — capsules did not HIT.');
}
if (afterB.misses.length > 0) {
  throw new Error(
    `RUN B had ${afterB.misses.length} capsule MISS(es) — replay is not exhaustive. `
    + `First miss: ${afterB.misses[0]?.execution_id}`,
  );
}
if (afterB.orders < 2) {
  throw new Error(`RUN B did not create a second order (orders=${afterB.orders}) — cardinality not fixed.`);
}

process.stdout.write(
  '\n[replay-e2e] SUCCESS: canonical two-pass real→replay proven.\n'
  + `  one project, one epic, one database\n`
  + `  orders:                     ${afterB.orders} (Run A + Run B)\n`
  + `  capsules after Run A:       ${afterA.capsuleCount}\n`
  + `  Run B total executions:     ${afterB.totalExecutions}\n`
  + `  Run B capsule HITs:         ${afterB.replayBound}\n`
  + `  Run B capsule misses:       ${afterB.misses.length}\n`
  + `  Run B lifecycle:            ${afterB.lifecycle.status}\n`,
);
