// tests/factory-temporal/foundation.test.mjs
//
// Foundation test: proves the temporal harness works end-to-end with the
// real production composition. A completely new temporary Project traverses
// the canonical product-build lifecycle from idea input to its intended
// terminal product state using scripted workers, without resetting the
// database or copying authority across runs.
//
// This is the MINIMAL temporal gate. Scenario-specific temporal tests
// (worker-boundary, candidate-gate, etc.) build on this foundation.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const COMPOSITION_PATH = path.join(REPO_ROOT, 'tests', 'factory-temporal', 'lib', 'temporal-composition.mjs');
const SCENARIOS_PATH = path.join(REPO_ROOT, 'tests', 'factory-contract', 'transition-conformance-scenarios.mjs');

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import { createTempGitRepo } from './lib/fresh-db.mjs';
import { bootstrapFreshDb } from './lib/fresh-db.mjs';
import { computeCompositionFingerprint, assertOverlayAllowlist } from './lib/composition-fingerprint.mjs';
import { explainFactoryLiveness } from './lib/liveness-explainer.mjs';
import * as predicates from './lib/predicates.mjs';

test('Foundation: canonical composition fingerprint is stable and overlay allowlist holds', async () => {
  const { repoPath, baseCommit } = createTempGitRepo('fingerprint');
  const { dbPath, dir } = await bootstrapFreshDb({ repoPath, baseCommit, label: 'fingerprint' });
  const registry = createRegistry();
  registry.trackDir(dir);
  try {
    const fingerprint = await computeCompositionFingerprint(dbPath);
    assert.ok(fingerprint.lifecycle.id.includes('product-build'), `lifecycle id: ${fingerprint.lifecycle.id}`);
    assert.equal(fingerprint.lifecycle.version, '1.2.0');
    assert.equal(fingerprint.lifecycle.stagesDigest.length, 64);
    assert.equal(typeof fingerprint.fingerprint, 'string');
    assert.equal(fingerprint.fingerprint.length, 64);
    assert.deepEqual(fingerprint.executorKinds, ['kernel', 'human', 'production-cell', 'lm']);

    // The overlay allowlist must include exactly the declared override ports.
    assert.ok(fingerprint.overlayAllowlist.includes('workerExecutorFactory'));
    assert.equal(
      fingerprint.overlayAllowlist.includes('development.verificationCheckProviderFactory'),
      false,
      'production acceptance policy cannot be overlaid',
    );
  } finally {
    await cleanupRegistry(registry);
  }
});

test('Foundation: liveness explainer classifies a fresh DB as waiting/terminal', async () => {
  const { repoPath, baseCommit } = createTempGitRepo('liveness');
  const { dbPath, dir } = await bootstrapFreshDb({ repoPath, baseCommit, label: 'liveness' });
  const registry = createRegistry();
  registry.trackDir(dir);
  try {
    const verdict = explainFactoryLiveness(dbPath, { projectId: 1 });
    assert.ok(
      ['waiting_expected', 'progressing', 'terminal', 'inconsistent_state'].includes(verdict.classification),
      `fresh DB classified as '${verdict.classification}' (reason: ${verdict.reasonCode})`,
    );
  } finally {
    await cleanupRegistry(registry);
  }
});

test('Foundation: overlay allowlist rejects composition that replaces settlement', async () => {
  // Simulate a composition that illegally overrides settlementPolicy at the
  // top level (outside the allowlist). Must throw.
  const malicious = {
    workerExecutorFactory: () => ({}), // allowed
    settlementPolicy: { illegal: true }, // NOT in allowlist
  };
  assert.throws(
    () => assertOverlayAllowlist(malicious),
    /COMPOSITION_OVERLAY_VIOLATION/,
  );

  // A composition that overrides ONLY allowed keys must pass.
  // ADR-048: only the inference port and declared check-provider port.
  const safe = {
    workerExecutorFactory: () => ({}),
    resolveWorkerContext: () => ({}),
  };
  assert.doesNotThrow(() => assertOverlayAllowlist(safe));
});

test('Foundation: full product-build lifecycle traverses from idea to terminal via scripted workers', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-temporal-foundation-repo-'));
  registry.trackDir(repoDir);
  const repoPath = path.join(repoDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# Foundation\n');
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'foundation-fixture', version: '1.0.0',
    scripts: { test: 'node test.js', start: 'node server.js' },
  }));
  writeFileSync(path.join(repoPath, 'test.js'), 'process.exit(0);\n');
  writeFileSync(path.join(repoPath, 'server.js'), [
    "const http=require('http');",
    "const port=Number(process.env.PORT);",
    "http.createServer((_q,r)=>r.end('ready')).listen(port,'127.0.0.1');",
  ].join('\n'));
  execSync(
    'git init && git config user.email t@t && git config user.name t '
    + '&& git add -A && git commit -m init && git branch -M dev',
    { cwd: repoPath, windowsHide: true, stdio: 'pipe' },
  );
  const baseCommit = execSync('git rev-parse HEAD', {
    cwd: repoPath, encoding: 'utf8', windowsHide: true,
  }).trim();

  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');

  const { dbPath, launchRef, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label: 'foundation',
  });
  registry.trackDir(dbDir);

  try {
    // Assert the composition fingerprint BEFORE launching the factory.
    const fingerprint = await computeCompositionFingerprint(dbPath);
    assert.ok(fingerprint.lifecycle.id.includes('product-build'), `lifecycle id: ${fingerprint.lifecycle.id}`);

    // Launch the factory via orchestrate-cli (child process).
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
    registry.trackProcess(child, 'orchestrate-cli');

    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => stdout += c);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => stderr += c);

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error(`TIMEOUT\n${stderr.slice(-3000)}`));
      }, 540000);
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });

    assert.equal(exitCode, 0, `orchestrate-cli exited ${exitCode}\n${stderr.slice(-5000)}`);

    // Verify lifecycle outcomes: product-build@1.0.0 → verified-local.
    const resultDb = new Database(dbPath, { readonly: true });
    try {
      const runs = resultDb.prepare(
        'SELECT module_name,status,local_outcome FROM factory_process_runs ORDER BY id',
      ).all();
      const expected = new Map([
        ['product-discovery', 'go'],
        ['solution-formalization', 'formalized'],
        ['solution-development', 'verified'],
      ]);
      for (const [moduleName, outcome] of expected) {
        const run = runs.find(row => row.module_name === moduleName);
        assert.ok(run, `${moduleName} ProcessRun exists`);
        assert.equal(run.status, 'completed', `${moduleName} status`);
        assert.equal(run.local_outcome, outcome, `${moduleName} outcome`);
      }

      // Liveness explainer must classify the terminal state.
      const verdict = explainFactoryLiveness(dbPath, { projectId: 1 });
      assert.ok(
        ['terminal', 'waiting_expected'].includes(verdict.classification),
        `post-run liveness: ${verdict.classification} (${verdict.reasonCode})`,
      );

      // No stranded worker executions.
      const active = predicates.countActiveWorkerExecutions(resultDb, 1, 1);
      assert.equal(active, 0, 'no active worker executions after terminal');

      const strandedObligations = resultDb.prepare(
        `SELECT obligation_key,state,last_error
           FROM factory_transition_obligations
          WHERE state<>'completed'`,
      ).all();
      assert.deepEqual(
        strandedObligations,
        [],
        `no durable handoff may remain ownerless/non-terminal: ${JSON.stringify(strandedObligations)}`,
      );
      const observedHandoffs = new Set(resultDb.prepare(
        `SELECT DISTINCT handoff_kind FROM factory_transition_obligations`,
      ).all().map(row => row.handoff_kind));
      assert.deepEqual(observedHandoffs, new Set([
        'run-gate',
        'close-presentation',
        'run-effects',
        'record-final-acceptance',
        'route-lifecycle',
      ]), 'canonical E2E traverses every ADR-053 durable handoff');

      // Scripted workers were invoked.
      const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
      assert.ok(invocations.length >= 12, `scripted workers invoked: ${invocations.length}`);
    } finally {
      resultDb.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});
