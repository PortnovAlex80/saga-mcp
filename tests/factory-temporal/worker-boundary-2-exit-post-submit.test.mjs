// tests/factory-temporal/worker-boundary-2-exit-post-submit.test.mjs
//
// ADR-048 worker boundary 2 of 4 — exit(0) AFTER product submission,
// BEFORE worker_done. (Split from the former single worker-boundary.test.mjs.)
//
// The worker submits a typed discovery-proposal product (durable), then exits(0)
// without calling worker_done. The Factory must detect the orphaned desk
// production, classify the execution as 'lost', and requeue. On the retry,
// the typed product already exists (idempotent) and the worker completes
// normally.

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

test('worker-boundary 2: exit-after-product-submission-before-worker-done — Factory detects orphaned desk production and requeues', { timeout: Number(process.env.SAGA_WB_HOST_BUDGET_MS ?? 180000) + 20000 }, async () => {
  const registry = createRegistry();
  const label = 'wb2-exit-post-submit';
  const { repoPath, baseCommit, repoDir, invocationLogPath } = provisionRepo(registry, label);

  // This test uses the boundary-2 scenario map. The scenario dispatcher loads
  // whatever SAGA_SCENARIOS points at and reads the `scenarios` export. We
  // write a shim that re-exports the named boundary-2 map as the default.
  const shimPath = writeScenarioShim(repoDir, 'workerBoundary2Scenarios');

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
      // The typed product was submitted on attempt 1 (before the crash). It
      // must be present even though worker_done was never called for that
      // execution — durable production survives execution replacement.
      // product_submit writes to factory_managed_node_submissions. Each
      // execution creates its own immutable submission — so the retry (attempt 2)
      // may produce a second submission. What matters is that the orphaned
      // attempt-1 submission SURVIVED the crash (>= 1), not that it was the
      // only one.
      const proposalProducts = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
          WHERE schema_version='factory.discovery-proposal.v1'`,
      ).get().n;
      assert.ok(proposalProducts >= 1,
        `orphaned discovery-proposal product survived the crash (got ${proposalProducts})`);

      // At least one 'lost' execution proves the orphan was detected.
      const lostCount = resultDb.prepare(
        `SELECT COUNT(*) AS n FROM worker_executions WHERE state='lost'`,
      ).get().n;
      assert.ok(lostCount >= 1,
        `at least 1 'lost' execution from boundary-2 crash (got ${lostCount})`);

      // No stranded active executions.
      const active = predicates.countActiveWorkerExecutions(resultDb, 1, 1);
      assert.equal(active, 0,
        `no active worker executions after recovery (got ${active})`);

      // >=2 invocations of produce-proposal (crash + recovery).
      const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
      const proposalInvocations = invocations.filter(
        i => i.keyStr && i.keyStr.includes('produce-proposal/author'),
      );
      assert.ok(proposalInvocations.length >= 2,
        `produce-proposal invoked >=2 times (crash + recovery); got ${proposalInvocations.length}`);
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
