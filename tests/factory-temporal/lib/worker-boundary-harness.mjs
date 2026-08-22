// tests/factory-temporal/lib/worker-boundary-harness.mjs
//
// Shared harness for the four worker-boundary crash-recovery tests
// (ADR-048 temporal conformance). Split out of the former single
// worker-boundary.test.mjs so each boundary is an independent FILE —
// a failing boundary is re-run in ~one host budget (~3 min), not the
// whole four-test file (~12+ min), and one boundary's failure can no
// longer hide behind another's timeout.
//
// Host budget note: the 180s wall-clock budget is REAL waiting (the
// dispatcher must notice the dead worker and requeue within its recovery
// window) — it is not computation. Under a live factory sharing the host
// (CPU/API contention) the budget can be widened for a diagnostic re-run
// without touching code: SAGA_WB_HOST_BUDGET_MS=300000 node --test ...

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTempGitRepo, bootstrapFreshDb } from './fresh-db.mjs';
import { explainFactoryLiveness } from './liveness-explainer.mjs';
import { serializeRegressionFixture } from './temporal-probe.mjs';

export const REPO_ROOT = process.cwd();
export const COMPOSITION_PATH = path.join(
  REPO_ROOT, 'tests', 'factory-temporal', 'lib', 'temporal-composition.mjs',
);
export const SCENARIOS_DIR = path.join(
  REPO_ROOT, 'tests', 'factory-temporal', 'scenarios', 'worker-boundary-crash-scenarios.mjs',
);

export const HOST_BUDGET_MS = Number(process.env.SAGA_WB_HOST_BUDGET_MS ?? 180000);

/**
 * Provision a temp git repo + invocation ledger for one boundary test.
 * Returns { repoPath, baseCommit, repoDir, invocationLogPath }.
 * All dirs are tracked by the registry for deterministic cleanup.
 */
export function provisionRepo(registry, label) {
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
 * Returns { child, exitPromise }; exitPromise resolves { exitCode, stdout,
 * stderr }. The registry tracks the child so it is SIGTERM'd on cleanup.
 */
export function launchFactory(registry, opts) {
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
        `orchestrate-cli TIMEOUT after ${HOST_BUDGET_MS}ms (label=${label})\n`
        + `stderr tail:\n${stderr.slice(-4000)}`,
      ));
    }, HOST_BUDGET_MS);
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
export function writeScenarioShim(repoDir, exportName) {
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
export function preserveFailingFixture(registry, repoDir, dbPath, failingPredicate, trace) {
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
export function assertNotFatallyStalled(dbPath, label, trace) {
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

export { bootstrapFreshDb };
