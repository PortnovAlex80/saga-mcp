// tests/factory-temporal/lifecycle-routing.test.mjs
//
// ADR-048 temporal conformance — ProcessRun → StageRun → LifecycleRun →
// LaunchRequest routing properties. These are L3/L4 temporal properties: they
// run the FULL canonical product-build lifecycle via scripted workers and then
// assert that the durable routing chain settled correctly on the resulting DB.
//
// Properties under test:
//   1. terminal-processrun-settles-stagerun
//      Every terminal ProcessRun (status='completed') must have a
//      corresponding completed StageRun with local_outcome set.
//   2. terminal-processrun-routes-lifecyclerun
//      A terminal ProcessRun must eventually route its LifecycleRun — either
//      advancing to the next stage or reaching terminal status. After the full
//      lifecycle completes, LifecycleRun.status='completed'.
//   3. terminal-lifecyclerun-settles-launchrequest
//      A terminal LifecycleRun must eventually settle its LaunchRequest
//      (state='completed').
//   4. unrouted-terminal-diagnosed
//      If a ProcessRun is terminal but the stage has NOT advanced (no
//      factory_process_transitions row), explainFactoryLiveness classifies the
//      state as waiting_expected / routing-pending — NOT stalled.
//
// Pattern mirrors foundation.test.mjs: spawn orchestrate-cli, wait for exit,
// open the DB readonly, assert. Uses bootstrapFreshDb (never .tracker.db or
// prod/), createRegistry()/cleanupRegistry(), and the transition-conformance
// scenarios as the scripted-worker scenario source.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const COMPOSITION_PATH = path.join(REPO_ROOT, 'tests', 'factory-temporal', 'lib', 'temporal-composition.mjs');
const SCENARIOS_PATH = path.join(REPO_ROOT, 'tests', 'factory-contract', 'transition-conformance-scenarios.mjs');

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import { createTempGitRepo, bootstrapFreshDb } from './lib/fresh-db.mjs';
import { explainFactoryLiveness } from './lib/liveness-explainer.mjs';
import * as predicates from './lib/predicates.mjs';

// ---------------------------------------------------------------------------
// Shared harness — boot a temp repo + fresh DB, run the full lifecycle, return
// { dbPath, launchRef, repoPath, invocationLogPath } after orchestrate-cli
// exits 0. Cleans up via the supplied registry.
// ---------------------------------------------------------------------------

async function runFullLifecycle(label, registry) {
  const { repoPath, baseCommit } = createTempGitRepo(label);
  const repoDir = path.dirname(repoPath);
  registry.trackDir(repoDir);

  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');

  const { dbPath, launchRef, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label,
  });
  registry.trackDir(dbDir);

  const child = spawn('node', [
    path.join(REPO_ROOT, 'dist', 'orchestrate-cli.js'),
    `--launch-ref=${launchRef}`,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_REPO_ROOT: REPO_ROOT,
      SAGA_BUTTON_REPO_PATH: repoPath,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: COMPOSITION_PATH,
      SAGA_SCENARIOS: SCENARIOS_PATH,
      SAGA_INVOCATION_LOG: invocationLogPath,
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registry.trackProcess(child, `orchestrate-cli[${label}]`);

  let stderr = '';
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`orchestrate-cli[${label}] TIMEOUT\n${stderr.slice(-3000)}`));
    }, 540000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });

  assert.equal(exitCode, 0, `orchestrate-cli[${label}] exited ${exitCode}\nSTDOUT:\n${stdout.slice(-5000)}\nSTDERR:\n${stderr.slice(-5000)}`);

  return { dbPath, launchRef, repoPath, invocationLogPath, stdout, stderr };
}

// ===========================================================================
// 1. terminal-processrun-settles-stagerun
//    Every completed ProcessRun must have a corresponding completed StageRun
//    with a non-null local_outcome. The routing contract: a terminal process
//    run settles its owning stage atomically.
// ===========================================================================

test('lifecycle-routing: terminal ProcessRun settles its StageRun (status + local_outcome)', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  try {
    const { dbPath } = await runFullLifecycle('route-settle-stagerun', registry);

    const db = new Database(dbPath, { readonly: true });
    try {
      // Every completed ProcessRun must be joined to a completed StageRun with
      // a non-null local_outcome. A terminal process run whose stage never
      // settled is a routing bug.
      const unsettled = db.prepare(
        `SELECT pr.id AS process_run_id, pr.module_name, sr.id AS stage_run_id,
                sr.status AS stage_status, sr.local_outcome
           FROM factory_process_runs pr
           JOIN factory_stage_runs sr ON sr.process_run_id = pr.id
          WHERE pr.status = 'completed'
            AND (sr.status <> 'completed' OR sr.local_outcome IS NULL)`,
      ).all();

      assert.equal(unsettled.length, 0,
        `terminal ProcessRuns with unsettled StageRuns: ${
          JSON.stringify(unsettled, null, 2)}`);

      // Positive form: at least the three canonical stages settled.
      const settled = db.prepare(
        `SELECT pr.module_name, sr.status, sr.local_outcome
           FROM factory_process_runs pr
           JOIN factory_stage_runs sr ON sr.process_run_id = pr.id
          WHERE pr.status = 'completed'
            AND sr.status = 'completed'
            AND sr.local_outcome IS NOT NULL
          ORDER BY pr.id`,
      ).all();
      assert.ok(settled.length >= 3, `expected >=3 settled stage runs, got ${settled.length}`);
      for (const row of settled) {
        assert.equal(row.status, 'completed');
        assert.ok(row.local_outcome, `${row.module_name} local_outcome set`);
      }

      // A pause message describes a resumable intermediate state.  It must not
      // survive successful settlement, otherwise the board renders a healthy
      // completed workshop with a stale red incident marker.
      const completedWithStaleErrors = db.prepare(
        `SELECT id,module_name,error
           FROM factory_process_runs
          WHERE status='completed' AND error IS NOT NULL`,
      ).all();
      assert.deepEqual(completedWithStaleErrors, [],
        `completed ProcessRuns retained stale diagnostics: ${
          JSON.stringify(completedWithStaleErrors, null, 2)}`);
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ===========================================================================
// 2. terminal-processrun-routes-lifecyclerun
//    A terminal ProcessRun must eventually route its LifecycleRun. After the
//    full lifecycle completes, LifecycleRun.status='completed'. Every terminal
//    stage's process outcome is journaled into factory_process_transitions, and
//    the final transition reaches a terminal target.
// ===========================================================================

test('lifecycle-routing: terminal ProcessRun routes LifecycleRun to completed', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  try {
    const { dbPath } = await runFullLifecycle('route-lifecyclerun', registry);

    const db = new Database(dbPath, { readonly: true });
    try {
      // The LifecycleRun reached terminal status 'completed'.
      const lifecycle = predicates.readLifecycleRun(db, 1);
      assert.ok(lifecycle, 'LifecycleRun exists for project 1');
      assert.equal(
        lifecycle.status, 'completed',
        `LifecycleRun status='${lifecycle.status}', expected 'completed'`,
      );

      // There must be a terminal transition (target_type='terminal') — the
      // router's durable signal that the lifecycle reached its end.
      const terminalTransition = db.prepare(
        `SELECT transition_key, outcome, terminal_status
           FROM factory_process_transitions
          WHERE lifecycle_run_id = ?
            AND target_type = 'terminal'
          ORDER BY id DESC LIMIT 1`,
      ).get(lifecycle.id);
      assert.ok(terminalTransition,
        'a terminal factory_process_transitions row must exist for a completed LifecycleRun');
      assert.ok(terminalTransition.terminal_status,
        'terminal transition must carry a non-empty terminal_status');

      // Every completed ProcessRun bound to this lifecycle must have a
      // transition row advancing FROM its stage — i.e. the router consumed the
      // terminal outcome. (The LAST stage's transition is the terminal one.)
      const unrouted = db.prepare(
        `SELECT pr.id AS process_run_id, pr.module_name, sr.id AS stage_run_id
           FROM factory_process_runs pr
           JOIN factory_stage_runs sr ON sr.process_run_id = pr.id
          WHERE sr.lifecycle_run_id = ?
            AND pr.status = 'completed'
            AND NOT EXISTS (
              SELECT 1 FROM factory_process_transitions tr
               WHERE tr.from_stage_run_id = sr.id)`,
      ).all(lifecycle.id);
      assert.equal(unrouted.length, 0,
        `completed ProcessRuns with no outbound transition: ${
          JSON.stringify(unrouted, null, 2)}`);
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ===========================================================================
// 3. terminal-lifecyclerun-settles-launchrequest
//    A terminal LifecycleRun must eventually settle its LaunchRequest
//    (factory_launch_requests.state='completed').
// ===========================================================================

test('lifecycle-routing: terminal LifecycleRun settles LaunchRequest to completed', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  try {
    const { dbPath, launchRef } = await runFullLifecycle('route-launchreq', registry);

    const db = new Database(dbPath, { readonly: true });
    try {
      const launch = db.prepare(
        `SELECT launch_ref, state, lifecycle_run_id, error, completed_at
           FROM factory_launch_requests WHERE launch_ref = ?`,
      ).get(launchRef);
      assert.ok(launch, `LaunchRequest ${launchRef} exists`);
      assert.equal(
        launch.state, 'completed',
        `LaunchRequest state='${launch.state}', expected 'completed'`
          + (launch.error ? ` (error: ${launch.error})` : ''),
      );
      assert.ok(launch.lifecycle_run_id,
        'LaunchRequest must be bound to a LifecycleRun after completion');
      assert.ok(launch.completed_at,
        'LaunchRequest.completed_at must be set for a settled launch');

      // Cross-check: the bound LifecycleRun is itself terminal.
      const lifecycle = db.prepare(
        `SELECT id, status FROM factory_lifecycle_runs WHERE id = ?`,
      ).get(launch.lifecycle_run_id);
      assert.ok(lifecycle, 'bound LifecycleRun exists');
      assert.ok(
        ['completed', 'failed', 'cancelled'].includes(lifecycle.status),
        `bound LifecycleRun status='${lifecycle.status}' must be terminal`,
      );
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ===========================================================================
// 4. unrouted-terminal-diagnosed
//    If a ProcessRun is terminal but the stage has NOT advanced (no
//    factory_process_transitions row for that stage), explainFactoryLiveness
//    must classify this as waiting_expected / routing-pending — the router
//    still owes a row — NOT stalled. This is the diagnostic contract that lets
//    an operator distinguish "wait for the router" from "the engine is dead".
//
// Approach: run the full lifecycle to a terminal state, then open a COPY of the
// DB (readonly source, writeable mirror), delete the terminal transition row
// to simulate an unrouted terminal ProcessRun, and assert the explainer
// classifies the synthetic unrouted state as waiting_expected / routing-pending.
// The original DB is untouched (we copy by file).
// ===========================================================================

test('lifecycle-routing: unrouted terminal ProcessRun diagnosed as waiting_expected / routing-pending (not stalled)', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  try {
    const { dbPath } = await runFullLifecycle('route-unrouted-diag', registry);

    // Snapshot the completed DB into a writeable mirror so we can synthesize
    // the unrouted-terminal state without corrupting the original artifact.
    const mirrorDir = mkdtempSync(path.join(os.tmpdir(), 'saga-temporal-unrouted-mirror-'));
    registry.trackDir(mirrorDir);
    const mirrorDbPath = path.join(mirrorDir, 'unrouted.db');
    // Never copy a live/recent SQLite database as a lone main-file byte copy:
    // committed pages may still reside in the WAL. The backup API gives this
    // synthetic-fault test one transactionally consistent source snapshot.
    const source = new Database(dbPath, { readonly: true });
    try {
      await source.backup(mirrorDbPath);
    } finally {
      source.close();
    }

    const mirror = new Database(mirrorDbPath);
    try {
      // Sanity: confirm the source lifecycle exists and has a terminal
      // transition before we synthesize the unrouted state. The lifecycle
      // status may be 'completed' or still 'running' (if the factory exits
      // before the terminal transition is journaled — which is itself the
      // routing-pending scenario under test).
      const lifecycleBefore = predicates.readLifecycleRun(mirror, 1);
      assert.ok(lifecycleBefore, 'LifecycleRun exists in mirror');

      const terminalBefore = mirror.prepare(
        `SELECT transition_key FROM factory_process_transitions
          WHERE lifecycle_run_id = ? AND target_type = 'terminal'`,
      ).get(lifecycleBefore.id);
      // The source fixture must be a proven completed lifecycle before we
      // remove one routing fact. Otherwise the test would conflate a real
      // inconsistent Worker/Workplace state with the synthetic routing window
      // and incorrectly whitelist that incident as expected progress.
      assert.ok(
        terminalBefore,
        'completed source fixture has no terminal transition; refusing to synthesize from an inconsistent run',
      );

      // Synthesize the unrouted state: remove the router's terminal transition
      // row so the lifecycle is terminal from the status column's perspective
      // but the router has NOT journaled the terminal transition yet.
      const deleted = mirror.prepare(
        `DELETE FROM factory_process_transitions
          WHERE lifecycle_run_id = ? AND target_type = 'terminal'`,
      ).run(lifecycleBefore.id);
      assert.ok(deleted.changes >= 1, 'removed the terminal transition row');

      // Re-open the explainer against the mirror and assert the diagnosis.
      // The lifecycle status is 'completed' but no terminal transition row
      // remains — the router owes a row — so the explainer must classify this
      // as waiting_expected / routing-pending, NOT stalled.
      const verdict = explainFactoryLiveness(mirrorDbPath, { projectId: 1 });
      assert.equal(
        verdict.classification, 'waiting_expected',
        `expected waiting_expected for unrouted terminal, got '${verdict.classification}'`
          + ` (reason: ${verdict.reasonCode})`,
      );
      assert.equal(
        verdict.reasonCode, 'routing-pending',
        `expected reasonCode 'routing-pending', got '${verdict.reasonCode}'`,
      );
      assert.notEqual(
        verdict.classification, 'stalled',
        'an unrouted terminal must NOT be misdiagnosed as stalled',
      );
    } finally {
      mirror.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});
