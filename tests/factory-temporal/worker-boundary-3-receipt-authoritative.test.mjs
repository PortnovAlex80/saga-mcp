// tests/factory-temporal/worker-boundary-3-receipt-authoritative.test.mjs
//
// ADR-048 worker boundary 3 of 4 — exit AFTER worker_done (the durable
// receipt is authoritative). (Split from the former single
// worker-boundary.test.mjs.)
//
// The worker calls worker_done (durably accepted into command_receipts), then
// the process exits. The durable receipt must be authoritative: the next
// cycle must NOT redo the work. The finalizer classifies this as
// semanticCompletion=true because the accepted worker_done receipt exists.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import * as predicates from './lib/predicates.mjs';
import {
  provisionRepo, launchFactory, writeScenarioShim, preserveFailingFixture,
  assertNotFatallyStalled, bootstrapFreshDb,
} from './lib/worker-boundary-harness.mjs';

test('worker-boundary 3: exit-after-worker-done — durable receipt is authoritative, no redo', { timeout: Number(process.env.SAGA_WB_HOST_BUDGET_MS ?? 180000) + 20000 }, async () => {
  const registry = createRegistry();
  const label = 'wb3-exit-post-done';
  const { repoPath, baseCommit, repoDir, invocationLogPath } = provisionRepo(registry, label);

  // Shim that selects the boundary-3 scenario map.
  const shimPath = writeScenarioShim(repoDir, 'workerBoundary3Scenarios');

  let dbPath, dbDir, launchRef;
  try {
    const boot = await bootstrapFreshDb({ repoPath, baseCommit, label });
    dbPath = boot.dbPath;
    dbDir = boot.dir;
    launchRef = boot.launchRef;
    registry.trackDir(dbDir);

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
      `orchestrate-cli exited ${exitCode} (expected 0 = converged)\n${stderr.slice(-5000)}`);

    const resultDb = new Database(dbPath, { readonly: true });
    try {
      // The worker_done receipt must exist and be accepted. This is the
      // authoritative record that proves semantic completion.
      const acceptedDone = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM command_receipts
          WHERE command_kind='worker_done' AND accepted=1`,
      ).get().n;
      assert.ok(acceptedDone >= 1,
        `at least 1 accepted worker_done receipt (got ${acceptedDone})`);

      // The discovery-proposal cell must have been invoked EXACTLY ONCE.
      // Because worker_done was durably accepted before the process exited,
      // the Factory must NOT have requeued it.
      const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
      const proposalInvocations = invocations.filter(
        i => i.keyStr && i.keyStr.includes('produce-proposal/author'),
      );
      assert.equal(proposalInvocations.length, 1,
        `produce-proposal invoked exactly ONCE (receipt-authoritative, no redo); `
        + `got ${proposalInvocations.length}`);

      // Exactly one proposal product (no duplicate from a redo).
      const proposalProducts = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
          WHERE schema_version='factory.discovery-proposal.v1'`,
      ).get().n;
      assert.equal(proposalProducts, 1,
        `exactly 1 proposal product (no redo); got ${proposalProducts}`);

      // The execution that called worker_done must NOT be 'lost' across the
      // ENTIRE run. In a full lifecycle with repair loops, OTHER workers may
      // crash and become 'lost' — that's the repair path working. What we
      // assert here is that at least ONE execution reached 'exited' with a
      // receipt (the durable receipt was authoritative for at least one worker).
      const exitedWithReceipt = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM worker_executions WHERE state='exited' AND exit_code=0`,
      ).get().n;
      assert.ok(exitedWithReceipt >= 1,
        `at least 1 execution exited cleanly with exit_code=0 (receipt was authoritative); got ${exitedWithReceipt}`);

      // No stranded active executions.
      const active = predicates.countActiveWorkerExecutions(resultDb, 1, 1);
      assert.equal(active, 0,
        `no active worker executions after terminal (got ${active})`);
    } finally {
      resultDb.close();
    }

    assertNotFatallyStalled(dbPath, label, []);
  } catch (error) {
    preserveFailingFixture(registry, repoDir, dbPath, error.message, []);
    throw error;
  } finally {
    await cleanupRegistry(registry);
  }
});
