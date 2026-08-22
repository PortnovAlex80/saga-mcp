// tests/factory-temporal/worker-boundary-1-exit-pre-submit.test.mjs
//
// ADR-048 worker boundary 1 of 4 — exit(0) BEFORE product submission.
// (Split from the former single worker-boundary.test.mjs; shared harness
// in lib/worker-boundary-harness.mjs. The four boundaries are independent
// FILES so a failing one is re-run alone within its own host budget.)
//
// A scripted worker is reserved, marked running, then exits(0) WITHOUT calling
// product_submit or worker_done. The Factory must detect the missing receipt,
// classify the execution as 'lost', advance the Workplace out of the crashed
// loop_state, and reach a new attempt that completes.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import * as predicates from './lib/predicates.mjs';
import {
  SCENARIOS_DIR, provisionRepo, launchFactory, preserveFailingFixture,
  assertNotFatallyStalled, bootstrapFreshDb,
} from './lib/worker-boundary-harness.mjs';

test('worker-boundary 1: exit-before-product-submission — Factory requeues within recovery budget', { timeout: Number(process.env.SAGA_WB_HOST_BUDGET_MS ?? 180000) + 20000 }, async () => {
  const registry = createRegistry();
  const label = 'wb1-exit-pre-submit';
  const { repoPath, baseCommit, repoDir, invocationLogPath } = provisionRepo(registry, label);

  let dbPath, dbDir, launchRef;
  try {
    const boot = await bootstrapFreshDb({ repoPath, baseCommit, label });
    dbPath = boot.dbPath;
    dbDir = boot.dir;
    launchRef = boot.launchRef;
    registry.trackDir(dbDir);

    const { exitPromise } = launchFactory(registry, {
      dbPath, launchRef, repoPath,
      scenariosPath: SCENARIOS_DIR, invocationLogPath, label,
    });

    const { exitCode, stderr } = await exitPromise;

    // A converged factory exits 0. If it exited non-zero or timed out, capture
    // the failing trace before asserting.
    if (exitCode !== 0) {
      preserveFailingFixture(registry, repoDir, dbPath,
        'orchestrate-cli-exit-nonzero', []);
    }
    assert.equal(exitCode, 0,
      `orchestrate-cli exited ${exitCode} (expected 0 = converged)\n${stderr.slice(-5000)}`);

    const resultDb = new Database(dbPath, { readonly: true });
    try {
      // The discovery-proposal workplace must NOT be stuck in 'running'.
      const proposalWp = resultDb.prepare(
        `SELECT workplace_ref, loop_state, revision, terminal_reason
           FROM factory_workplaces
          WHERE production_cell_id='discovery-proposal' LIMIT 1`,
      ).get();
      assert.ok(proposalWp, 'discovery-proposal workplace exists');
      assert.notEqual(proposalWp.loop_state, 'running',
        `workplace escaped crashed 'running' state (loop=${proposalWp.loop_state})`);

      // At least one 'lost' execution proves the crash was detected and
      // durably recorded.
      const lostCount = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM worker_executions WHERE state='lost'`,
      ).get().n;
      assert.ok(lostCount >= 1,
        `at least 1 'lost' execution from boundary-1 crash (got ${lostCount})`);

      // No stranded active executions after recovery.
      const active = predicates.countActiveWorkerExecutions(resultDb, 1, 1);
      assert.equal(active, 0,
        `no active worker executions after recovery (got ${active})`);

      // The retry attempt must have happened — the invocation ledger records
      // >=2 invocations of the produce-proposal cell (crash + recovery).
      const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
      const proposalInvocations = invocations.filter(
        i => i.keyStr && i.keyStr.includes('produce-proposal/author'),
      );
      assert.ok(proposalInvocations.length >= 2,
        `produce-proposal invoked >=2 times (crash + recovery); got ${proposalInvocations.length}`);
    } finally {
      resultDb.close();
    }

    // Liveness must not be a fatal stall.
    assertNotFatallyStalled(dbPath, label, []);
  } catch (error) {
    preserveFailingFixture(registry, repoDir, dbPath, error.message, []);
    throw error;
  } finally {
    await cleanupRegistry(registry);
  }
});
