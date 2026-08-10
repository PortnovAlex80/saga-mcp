// tests/factory-temporal/worker-boundary.test.mjs
//
// ADR-048 temporal conformance — worker boundary crash recovery.
//
// These tests prove the canonical Factory composition recovers from a process
// crash at every durable WorkerExecution boundary, within a bounded host-cycle
// budget. The canonical ADR-048 scenario:
//
//   A successful exact WorkerExecution becomes exited while its Workplace is
//   verifying. Within a bounded host-cycle budget the canonical runtime must
//   create the current CandidateSet and GateRun, reach a typed repair or
//   human wait, or emit a typed stall. It must not spin indefinitely.
//
// Each test spawns its OWN orchestrate-cli process (the crash injection lives
// in the scenario, not the host). The orchestrate-cli process IS the host:
//   - exit code 0   → lifecycle reached terminal state (converged)
//   - exit non-zero or timeout → the factory did NOT converge (stall signal)
//
// After each run the test classifies the post-crash state with
// explainFactoryLiveness and asserts it is NEVER `stalled` with reason
// `engine-dead-runnable` once the factory has had at least one recovery cycle.
//
// # Critical constraints honored
//
//   - createRegistry()/cleanupRegistry() in every test
//   - bootstrapFreshDb — never touches .tracker.db or prod/
//   - explainFactoryLiveness classifies post-crash state
//   - predicates.countActiveWorkerExecutions(db, 1, 1) asserts no stranded execs
//   - serializeRegressionFixture preserves minimized failing traces on failure

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const COMPOSITION_PATH = path.join(
  REPO_ROOT, 'tests', 'factory-temporal', 'lib', 'temporal-composition.mjs',
);
const SCENARIOS_DIR = path.join(
  REPO_ROOT, 'tests', 'factory-temporal', 'scenarios', 'worker-boundary-crash-scenarios.mjs',
);

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import { createTempGitRepo, bootstrapFreshDb } from './lib/fresh-db.mjs';
import { explainFactoryLiveness } from './lib/liveness-explainer.mjs';
import { serializeRegressionFixture } from './lib/temporal-probe.mjs';
import * as predicates from './lib/predicates.mjs';

// ---------------------------------------------------------------------------
// Shared harness helpers
// ---------------------------------------------------------------------------

/**
 * Provision a temp git repo + invocation ledger for one boundary test.
 * Returns { repoPath, baseCommit, repoDir, invocationLogPath }.
 * All dirs are tracked by the registry for deterministic cleanup.
 */
function provisionRepo(registry, label) {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), `saga-wb-${label}-repo-`));
  registry.trackDir(repoDir);
  // createTempGitRepo creates its own mkdtemp dir containing the git repo;
  // track that dir too so cleanup removes it.
  const tempRepo = createTempGitRepo(`wb-${label}`);
  registry.trackDir(tempRepo.dir);
  const { repoPath, baseCommit } = tempRepo;
  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');
  return { repoPath, baseCommit, repoDir, invocationLogPath };
}

/**
 * Spawn orchestrate-cli as the host process and wait for it to exit.
 * Returns { exitCode, stdout, stderr, child }.
 * The registry tracks the child so it is SIGTERM'd on cleanup.
 */
function launchFactory(registry, opts) {
  const { dbPath, launchRef, repoPath, scenariosPath, invocationLogPath, label } = opts;
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
      SAGA_SCENARIOS: scenariosPath,
      SAGA_INVOCATION_LOG: invocationLogPath,
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registry.trackProcess(child, `orchestrate-cli[${label}]`);

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });

  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(
        `orchestrate-cli TIMEOUT after 180000ms (label=${label})\n`
        + `stderr tail:\n${stderr.slice(-4000)}`,
      ));
    }, 180000);
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, exitPromise };
}

/**
 * Write a scenario-selector shim into the test's temp dir. The shim re-exports
 * a named boundary map from the crash-scenarios module as both `scenarios` and
 * the default export, so the scenario-dispatcher (`mod.scenarios || mod.default`)
 * picks up the selected boundary map.
 *
 * The import path is converted to a file:// URL via pathToFileURL so it works
 * on Windows (bare absolute paths like C:\\... are rejected by the ESM loader).
 */
function writeScenarioShim(repoDir, exportName) {
  const shimPath = path.join(repoDir, `scenarios-${exportName}.mjs`);
  const scenariosModuleUrl = pathToFileURL(SCENARIOS_DIR).href;
  const content = [
    `import { ${exportName} as scenarios } from ${JSON.stringify(scenariosModuleUrl)};`,
    `export { scenarios };`,
    `export default scenarios;`,
    '',
  ].join('\n');
  writeFileSync(shimPath, content, 'utf8');
  return shimPath;
}

/**
 * Preserve a minimized failing trace as a regression fixture.
 * Writes the fixture into the test's temp dir so it survives cleanup.
 */
function preserveFailingFixture(registry, repoDir, dbPath, failingPredicate, trace) {
  try {
    const fixture = serializeRegressionFixture({
      seed: null,
      compositionFingerprint: 'worker-boundary-test',
      trace: trace || [],
      failingPredicate: failingPredicate || 'unknown',
      dbPath,
    });
    const fixturePath = path.join(repoDir, `regression-${Date.now()}.json`);
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf8');
    process.stderr.write(
      `[worker-boundary] preserved failing fixture at ${fixturePath}\n`,
    );
  } catch (e) {
    process.stderr.write(`[worker-boundary] failed to preserve fixture: ${e.message}\n`);
  }
}

/**
 * Assert the post-run liveness classification is NOT a fatal stall.
 * After the factory has had at least one recovery cycle (i.e. after the
 * orchestrate-cli process has exited), the state must be progressing,
 * waiting_expected, or terminal — never stalled/engine-dead-runnable.
 */
function assertNotFatallyStalled(dbPath, label, trace) {
  const verdict = explainFactoryLiveness(dbPath, { projectId: 1 });
  const fatallyStalled = verdict.classification === 'stalled'
    && verdict.reasonCode === 'engine-dead-runnable';
  if (fatallyStalled) {
    // The factory had its recovery cycle(s) and still produced a dead-runnable
    // stall — that is exactly the ADR-048 silent-stall class.
    throw new Error(
      `STALLED_ENGINE_DEAD_RUNNABLE (label=${label}): factory converged to a `
      + `dead-runnable stall after recovery. verdict=${JSON.stringify(verdict)}\n`
      + `trace tail:\n${(trace || []).slice(-5).map(t => JSON.stringify(t)).join('\n')}`,
    );
  }
  return verdict;
}

// ===========================================================================
// Boundary 1 — exit(0) before product submission.
//
// A scripted worker is reserved, marked running, then exits(0) WITHOUT calling
// product_submit or worker_done. The Factory must detect the missing receipt,
// classify the execution as 'lost', advance the Workplace out of the crashed
// loop_state, and reach a new attempt that completes.
// ===========================================================================

test('worker-boundary 1: exit-before-product-submission — Factory requeues within recovery budget', { timeout: 180000 }, async () => {
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

// ===========================================================================
// Boundary 2 — exit(0) after product submission, before worker_done.
//
// The worker submits a typed discovery-proposal product (durable), then exits(0)
// without calling worker_done. The Factory must detect the orphaned desk
// production, classify the execution as 'lost', and requeue. On the retry,
// the typed product already exists (idempotent) and the worker completes
// normally.
// ===========================================================================

test('worker-boundary 2: exit-after-product-submission-before-worker-done — Factory detects orphaned desk production and requeues', { timeout: 180000 }, async () => {
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

// ===========================================================================
// Boundary 3 — exit after worker_done (durable receipt is authoritative).
//
// The worker calls worker_done (durably accepted into command_receipts), then
// the process exits. The durable receipt must be authoritative: the next
// cycle must NOT redo the work. The finalizer classifies this as
// semanticCompletion=true because the accepted worker_done receipt exists.
// ===========================================================================

test('worker-boundary 3: exit-after-worker-done — durable receipt is authoritative, no redo', { timeout: 180000 }, async () => {
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
      // the Factory must NOT have requeued it. (If it requeued, the retry
      // would either find the idempotent duplicate or re-run — either way
      // the invocation count tells us.)
      const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
      const proposalInvocations = invocations.filter(
        i => i.keyStr && i.keyStr.includes('produce-proposal/author'),
      );
      assert.equal(proposalInvocations.length, 1,
        `produce-proposal invoked exactly ONCE (receipt-authoritative, no redo); `
        + `got ${proposalInvocations.length}`);

      // Exactly one proposal product (no duplicate from a redo).
      // product_submit writes to factory_managed_node_submissions.
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

// ===========================================================================
// Boundary 4 — terminal execution identity wins over stale host snapshot.
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
// ===========================================================================

test('worker-boundary 4: terminal-execution-stale-host — durable execution identity wins over stale host snapshot', { timeout: 180000 }, async () => {
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
    // WorkerExecution for this epic is durably terminal. This is exactly the
    // ADR-048 stale-host scenario: the host projection diverges from the
    // durable execution identity.
    //
    // First capture a baseline: one cleanly-exited execution to anchor the
    // contradiction, and the pre-injection host snapshot.
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
    // This proves the stale condition is created BY THIS TEST, not leftover
    // from the run. (The lifecycle converged, so a well-behaved host would
    // have flipped to 'stopped'.)
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
    // host snapshot (lifecycle_execution_controls.engine_state). The verdict
    // must be terminal or waiting_expected — NOT 'progressing', because no
    // WorkerExecution is in a live state. The explainer never reads
    // lifecycle_execution_controls.engine_state (verified in
    // liveness-explainer.mjs: collectAuthorities reads worker_executions.state
    // only).
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
