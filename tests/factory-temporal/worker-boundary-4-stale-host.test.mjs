// tests/factory-temporal/worker-boundary-4-stale-host.test.mjs
//
// ADR-048 worker boundary 4 of 4 — terminal execution identity wins over a
// stale host snapshot. (Split from the former single worker-boundary.test.mjs.)
//
// A WorkerExecution is durable 'exited' but a project-scoped host snapshot
// (lifecycle_execution_controls.engine_state) still claims the engine is
// 'running'. The durable exact execution identity must win for assignment
// completion: the Factory must not consider the stale host snapshot
// authoritative and must not block on the phantom running execution.
//
// This test uses the golden-path scenario (boundary-4 map = golden path) and
// injects the host-snapshot staleness by writing a stale
// lifecycle_execution_controls row (engine_state='running', phantom engine_pid)
// AFTER the first worker completes. explainFactoryLiveness must then classify
// the state from worker_executions.state (the durable authority), NOT from
// the stale host projection.

import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import { explainFactoryLiveness } from './lib/liveness-explainer.mjs';
import * as predicates from './lib/predicates.mjs';
import {
  provisionRepo, launchFactory, writeScenarioShim, preserveFailingFixture,
  bootstrapFreshDb,
} from './lib/worker-boundary-harness.mjs';

test('worker-boundary 4: terminal-execution-stale-host — durable execution identity wins over stale host snapshot', { timeout: Number(process.env.SAGA_WB_HOST_BUDGET_MS ?? 180000) + 20000 }, async () => {
  const registry = createRegistry();
  const label = 'wb4-stale-host';
  const { repoPath, baseCommit, repoDir, invocationLogPath } = provisionRepo(registry, label);

  // Shim that selects the boundary-4 scenario map (golden path for the
  // scenario; the host staleness is injected post-hoc).
  const shimPath = writeScenarioShim(repoDir, 'workerBoundary4Scenarios');

  let dbPath, dbDir, launchRef;
  try {
    const boot = await bootstrapFreshDb({ repoPath, baseCommit, label });
    dbPath = boot.dbPath;
    dbDir = boot.dir;
    launchRef = boot.launchRef;
    registry.trackDir(dbDir);

    // Launch the factory. The golden-path workers complete normally; every
    // WorkerExecution transitions reserved → running → exited durably.
    const { exitPromise } = launchFactory(registry, {
      dbPath, launchRef, repoPath,
      scenariosPath: shimPath, invocationLogPath, label,
    });

    const { exitCode, stderr } = await exitPromise;

    if (exitCode !== 0) {
      preserveFailingFixture(registry, repoDir, dbPath,
        'orchestrate-cli-exit-nonzero', []);
    }
    assert.equal(exitCode, 0,
      `orchestrate-cli exited ${exitCode} (golden-path base must converge)\n${stderr.slice(-5000)}`);

    // INJECT THE STALE-HOST CONDITION.
    //
    // The host projection of engine state lives in
    // lifecycle_execution_controls.engine_state (CHECK IN
    // ('running','stopped','unknown'), keyed by epic_id — see src/schema.ts).
    // bootstrapFreshDb inserts a row for epic_id=1 with the default 'stopped'.
    //
    // We simulate a crashed/orphaned host: the engine_state snapshot still
    // claims 'running' with a live-looking engine_pid, EVEN THOUGH every
    // WorkerExecution for this epic is durably terminal.
    let preInjectionHostState = null;
    let exitedExecId = null;
    const baselineDb = new Database(dbPath, { readonly: true });
    try {
      const exitedExec = baselineDb.prepare(
        `SELECT execution_id, state, exit_code, task_id
           FROM worker_executions
          WHERE state='exited' AND exit_code=0
          ORDER BY rowid LIMIT 1`,
      ).get();
      assert.ok(exitedExec, 'at least one cleanly-exited execution to anchor the stale-host contradiction');
      exitedExecId = exitedExec.execution_id;

      const host = baselineDb.prepare(
        `SELECT epic_id, engine_state, engine_pid
           FROM lifecycle_execution_controls WHERE epic_id=1`,
      ).get();
      assert.ok(host, 'lifecycle_execution_controls row exists for epic_id=1 (bootstrap creates it)');
      preInjectionHostState = host;
    } finally {
      baselineDb.close();
    }

    // Sanity: before injection the host snapshot is NOT already 'running'.
    assert.notEqual(preInjectionHostState.engine_state, 'running',
      `pre-injection host engine_state is not already 'running' `
      + `(got '${preInjectionHostState.engine_state}') — the stale condition is created by this test`);

    // Now write the stale host snapshot: claim the engine is still running
    // with a phantom pid, while the durable WorkerExecution is exited.
    const injectDb = new Database(dbPath);
    try {
      const phantomPid = 99999;
      const changes = injectDb.prepare(
        `UPDATE lifecycle_execution_controls
            SET engine_state='running', engine_pid=?, updated_at=datetime('now')
          WHERE epic_id=1`,
      ).run(phantomPid);
      assert.equal(changes.changes, 1,
        'exactly one lifecycle_execution_controls row updated to the stale running snapshot');
    } finally {
      injectDb.close();
    }

    // Verify the stale host snapshot is durably visible to a readonly reader.
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const staleHost = verifyDb.prepare(
        `SELECT engine_state, engine_pid FROM lifecycle_execution_controls WHERE epic_id=1`,
      ).get();
      assert.equal(staleHost.engine_state, 'running',
        'stale host snapshot claims engine_state=running (injection persisted)');
      assert.equal(staleHost.engine_pid, 99999,
        'stale host snapshot carries the phantom engine_pid');

      // And the anchor execution is STILL durably exited — we did not touch
      // the durable authority, only the host projection.
      const anchor = verifyDb.prepare(
        `SELECT state, exit_code FROM worker_executions WHERE execution_id=?`,
      ).get(exitedExecId);
      assert.equal(anchor.state, 'exited',
        `anchor execution ${exitedExecId} remains durably 'exited' under the stale host snapshot`);
      assert.equal(anchor.exit_code, 0,
        'anchor execution remains cleanly exited (exit_code=0)');
    } finally {
      verifyDb.close();
    }

    // THE INVARIANT: explainFactoryLiveness must classify the state from the
    // DURABLE execution identity (worker_executions.state), NOT from the stale
    // host snapshot (lifecycle_execution_controls.engine_state).
    const verdict = explainFactoryLiveness(dbPath, { projectId: 1 });
    assert.notEqual(verdict.classification, 'progressing',
      `durable identity wins over stale host snapshot: classification must NOT be 'progressing' `
      + `(stale host claims engine_state='running' but every WorkerExecution is terminal); `
      + `got classification='${verdict.classification}' reasonCode='${verdict.reasonCode}'`);
    assert.ok(
      ['terminal', 'waiting_expected'].includes(verdict.classification),
      `post-convergence liveness must be terminal or waiting_expected under a stale host snapshot; `
      + `got classification='${verdict.classification}' reasonCode='${verdict.reasonCode}'`,
    );

    const resultDb = new Database(dbPath, { readonly: true });
    try {
      // Every WorkerExecution for the discovery-proposal task must be in a
      // terminal state (exited/lost/terminated) — none 'running'.
      const runningExecs = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM worker_executions
          WHERE state IN ('reserved','running','cancel_requested')`,
      ).get().n;
      assert.equal(runningExecs, 0,
        `no phantom 'running' executions after convergence (durable identity won); `
        + `got ${runningExecs}`);

      // No stranded active executions.
      const active = predicates.countActiveWorkerExecutions(resultDb, 1, 1);
      assert.equal(active, 0,
        `no active worker executions (durable terminal state is authoritative); `
        + `got ${active}`);

      // At least one accepted worker_done receipt proves the work was
      // durably completed — the stale host claim cannot undo it.
      const acceptedDone = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM command_receipts
          WHERE command_kind='worker_done' AND accepted=1`,
      ).get().n;
      assert.ok(acceptedDone >= 1,
        `accepted worker_done receipt(s) exist (durable authority); got ${acceptedDone}`);
    } finally {
      resultDb.close();
    }
  } catch (error) {
    preserveFailingFixture(registry, repoDir, dbPath, error.message, []);
    throw error;
  } finally {
    await cleanupRegistry(registry);
  }
});
