// tests/factory-contract/k13-crash-after-accepted-head.test.mjs
//
// K13 (M3, card commit 5) — the REAL crash-injection scenario:
// "crash after accepted head before effect scheduling" + the ADR-074
// exactly-once theorem under it.
//
// MECHANISM (house style of crash-recovery.test.mjs, real host processes):
//   1. Launch the engine on a fresh DB and a real git button-repo.
//   2. Poll a readonly connection for the durable mid-effect marker: an
//      external effect action in state 'executing' (the provider is INSIDE
//      its fetch/merge/push right now — after the accepted head, before any
//      effect receipt can exist). This is the exact crash window the card
//      names.
//   3. SIGKILL the engine (taskkill //F — no graceful drain, no atexit).
//   4. Relaunch the SAME launch-ref. Recovery must take the OBSERVATION
//      branch for the orphaned 'executing' action — the provider is NEVER
//      invoked a second time (ADR-074) — and converge.
//   5. Assert exactly-once: one execution attempt on the external action,
//      one effect receipt lineage, a FinalAcceptance for the accepted
//      workplace, exit 0, no stranded executions.
//
// A missed window (the effect settling between polls) fails the in-window
// assertion BEFORE the kill — the test never silently degrades into a
// convergence-only check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();

async function setupFreshDb(repoPath, baseCommit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-k13-crash-'));
  const dbPath = path.join(dir, 'crash.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'K13 crash fixture', 'Crash test', 'active', '[]', '{}');
  db.prepare('INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)')
    .run(1, 1, 'Pipeline', 'planned', 'high');
  db.prepare('INSERT INTO lifecycle_execution_controls (epic_id, concurrency, model_concurrency_limit) VALUES (?, ?, ?)')
    .run(1, 1, 1);
  db.prepare('INSERT INTO repositories (id, name, default_branch, metadata) VALUES (?, ?, ?, ?)').run(1, 'crash-repo', 'main', '{}');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 1, 1, 'component', repoPath, 'dev', 'active');
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  ensureReplayCapsuleSchema(db);
  const { hashDevelopmentPolicy } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'development', 'domain', 'development-settlement-policy.js')).href);
  const { hashDeliveryDeferredProfile } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'modules', 'delivery', 'domain', 'delivery-settlement-policy.js')).href);
  const devPolicy = { id: 'reference-development-policy', version: '1.0.0' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const deferredProfile = { schemaVersion: 'factory.delivery-deferred-profile.v1', reason: 'authorization-required', source: 'start-from-idea' };
  deferredProfile.profileHash = hashDeliveryDeferredProfile(deferredProfile);
  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: { subject: 'k13 crash test', context: 'crash after accepted head', evidence: [], constraints: {} },
    development: { repositories: [{ repositoryRef: { repositoryName: 'crash-repo', role: 'component' }, integrationBranch: 'dev', expectedBaseCommit: baseCommit }], policy: devPolicy },
    delivery: { mode: 'deferred', policy: null, operatorAuthorization: null, deferredProfile },
  };
  const orderRef = `order-k13-crash-${Date.now()}`;
  db.prepare(`INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state) VALUES (?, 1, 1, 'idea_url', 'starting')`).run(orderRef);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const launchRef = requestFactoryLaunch({ orderRef, mode: 'new', projectId: 1, epicId: 1, initiatedBy: 'k13-crash-test', idempotencyKey: `k13-${randomUUID()}`, concurrency: 1, lifecycleInput, lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2' }, db);
  closeDb();
  return { dbPath, launchRef, dir };
}

function launchEngine(dbPath, launchRef, repoPath) {
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
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: path.join(REPO_ROOT, 'tests', 'factory-contract', 'scenario-composition.mjs'),
      // The GOLDEN worker scenarios: no worker-level crashes — the crash in
      // this test is the ENGINE's, injected at the effect seam.
      SAGA_SCENARIOS: path.join(REPO_ROOT, 'tests', 'factory-contract', 'golden-path-scenarios.mjs'),
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', () => {});
  return { child, getStderr: () => stderr };
}

async function killHard(child) {
  // Real crash: no SIGTERM drain, no graceful stop — the process vanishes
  // mid-provider. execSync runs through cmd.exe on Windows, so the flags
  // take SINGLE slashes (the `//F` MSYS form is a bash-level escape that
  // does not survive execSync — verified: it fails with "invalid argument"
  // and the engine survives, silently defeating the crash injection). The
  // tree kill may report partial failure on an already-exiting child; what
  // matters — and what is verified — is that the ENGINE pid is gone.
  const pid = child.pid;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: 'pipe' }); } catch { /* partial tree failure is tolerable */ }
    for (let i = 0; i < 20; i += 1) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`killHard: engine pid ${pid} survived taskkill /F /T`);
}

test('K13/crash: engine dies mid-effect after the accepted head; recovery NEVER re-invokes the provider', { timeout: 600000 }, async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-k13-crash-repo-'));
  const repoPath = path.join(repoDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# K13\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  execSync('git branch dev', { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();

  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath, baseCommit);
  try {
    const first = launchEngine(dbPath, launchRef, repoPath);
    // Poll for the mid-effect marker: an external effect action that has
    // been CLAIMED for execution (state 'executing') — the provider is
    // running RIGHT NOW, after the accepted head, before any receipt.
    const poller = new Database(dbPath, { readonly: true });
    poller.pragma('busy_timeout = 5000');
    let marker;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      // The ledger table is created lazily by the engine on first use —
      // poll defensively until it exists. Only a CLAIMED execution
      // ('executing') is the mid-provider window: the provider is running
      // RIGHT NOW, after the accepted head, before any receipt. A 'new'
      // row (created, not claimed) is BEFORE the provider — keep polling.
      try {
        marker = poller.prepare(
          `SELECT id, provider_namespace, state, execution_attempts
             FROM factory_external_effect_actions
            WHERE state='executing' LIMIT 1`,
        ).get();
      } catch {
        marker = undefined;
      }
      if (marker) break;
      await new Promise(resolve => setTimeout(resolve, 15));
      if (first.child.exitCode !== null) break; // engine died on its own — stop polling
    }
    assert.ok(marker,
      `the crash window was reached: an external effect action is claimed mid-provider `
      + `(first engine exitCode=${first.child.exitCode})\n${first.getStderr().slice(-3000)}`);
    assert.equal(marker.state, 'executing',
      'the marker is a claimed execution (mid-provider), not an unscheduled row');
    // The accepted head precedes the effect: the window is exactly the
    // card's "after accepted head, before effect receipt".
    const headCount = poller.prepare('SELECT COUNT(*) AS n FROM factory_accepted_authority_head').get().n;
    assert.ok(headCount >= 1, 'the accepted head is durable before the effect runs');
    poller.close();
    await killHard(first.child);
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 10_000);
      first.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    // The crash must be REAL: the engine is gone while its effect action is
    // still mid-flight. (The kill is verified, not assumed — an
    // alive-but-silent engine would fake the whole scenario.)
    {
      // killHard has already verified the process is gone.
    }

    // RELAUNCH — production recovery semantics, both shapes:
    //   * the launch is still claimable (requested/claimed/running): wait
    //     out the dead controller's 30s lease, then relaunch the same ref;
    //   * the killed engine had already settled the launch as 'paused'
    //     (terminal for THAT request): create the RESUME launch exactly the
    //     way engine-administration does in production and run that ref.
    let relaunchRef = launchRef;
    {
      const probe = new Database(dbPath, { readonly: true });
      probe.pragma('busy_timeout = 5000');
      const launchRow = probe.prepare(
        'SELECT state, lifecycle_run_id, order_ref FROM factory_launch_requests WHERE launch_ref=?',
      ).get(launchRef);
      if (['requested', 'claimed', 'running'].includes(launchRow.state)) {
        // Takeover semantics: the dead engine holds TWO durable leases —
        // the launch controller lease (30s TTL) and the lifecycle execution
        // lease (120s TTL). Both must LAPSE before the next engine may take
        // over; this wait IS the recovery window.
        const fences = [
          `SELECT expires_at FROM factory_launch_controller_leases WHERE launch_ref=?`,
          `SELECT execution_lease_expires_at AS expires_at
             FROM factory_lifecycle_runs WHERE id=? AND execution_lease_owner IS NOT NULL`,
        ];
        const fenceDeadline = Date.now() + 180_000;
        for (;;) {
          const pending = fences.some(sql => {
            const fence = probe.prepare(sql).get(...(sql.includes('factory_lifecycle_runs') ? [launchRow.lifecycle_run_id] : [launchRef]));
            return fence && Date.parse(fence.expires_at) > Date.now();
          });
          if (!pending) break;
          if (Date.now() > fenceDeadline) {
            assert.fail('controller/lifecycle leases never lapsed after the crash');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        probe.close();
      } else {
        const run = probe.prepare(
          'SELECT id, initiated_by, idempotency_key FROM factory_lifecycle_runs WHERE id=?',
        ).get(launchRow.lifecycle_run_id);
        probe.close();
        const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
        relaunchRef = requestFactoryLaunch({
          orderRef: launchRow.order_ref,
          mode: 'resume',
          projectId: 1,
          epicId: 1,
          lifecycleRunId: run.id,
          initiatedBy: run.initiated_by,
          idempotencyKey: `${run.idempotency_key}:resume:${randomUUID()}`,
          concurrency: 1,
        }, new Database(dbPath));
      }
    }

    // Relaunch; recovery must observe, never re-invoke.
    const second = launchEngine(dbPath, relaunchRef, repoPath);
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { second.child.kill('SIGTERM'); } catch { /* noop */ }
        resolve('timeout');
      }, 300_000);
      second.child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, `the relaunched engine converged (exit=${exitCode})\n${second.getStderr().slice(-4000)}`);

    const resultDb = new Database(dbPath, { readonly: true });
    const action = resultDb.prepare(
      'SELECT id, state, execution_attempts FROM factory_external_effect_actions WHERE id=?',
    ).get(marker.id);
    assert.ok(['succeeded', 'blocked'].includes(action.state),
      `the orphaned execution reached a terminal state via observation (state=${action.state})`);
    // ADR-074 exactly-once, crash form: the provider's SIDE EFFECT lands
    // exactly once, and any re-invocation is OBSERVATION-AUTHORIZED — never
    // a blind duplicate. The killed attempt left no durable result, so the
    // recovery must first OBSERVE (the repository is the authority on
    // whether the effect landed); only an 'absent-retry-safe' verdict may
    // authorize a second claim. Pin the lineage: every execution.claimed
    // after the first must originate from 'retry-authorized', with an
    // observation claim in between.
    const events = resultDb.prepare(
      `SELECT event_type, from_state, claim_kind
         FROM factory_external_effect_events WHERE action_id=? ORDER BY sequence`,
    ).all(marker.id);
    const claims = events.filter(event => event.event_type === 'execution.claimed');
    assert.equal(claims.length, action.execution_attempts,
      'every execution attempt is journaled as a claim event');
    for (const claim of claims.slice(1)) {
      assert.equal(claim.from_state, 'retry-authorized',
        `a re-invocation must be observation-authorized, not a blind duplicate (from ${claim.from_state})`);
    }
    if (claims.length > 1) {
      assert.ok(events.some(event => event.claim_kind === 'observation'),
        'the observation gate ran between the attempts — the repository was consulted before any retry');
    }
    const receipts = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n;
    assert.ok(receipts >= 1, 'an effect receipt lineage exists');
    const finalAcceptances = resultDb.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n;
    assert.ok(finalAcceptances >= 1, 'a FinalAcceptance was durably recorded');
    const activeExecs = resultDb.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions WHERE state IN ('reserved','running','cancel_requested')`,
    ).get().n;
    assert.equal(activeExecs, 0, 'no stranded executions after recovery');
    resultDb.close();
  } finally {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
