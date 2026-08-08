#!/usr/bin/env node
/**
 * «Кнопка Сага» — чистый запуск завода с scripted workers.
 *
 * Создаёт чистую БД (через getDb — полная schema), копирует только capsules +
 * project/repo из исходной БД. Запускает orchestrate-cli через composition
 * override с ScriptedWorkerExecutor.
 *
 * Capsule replay: если для ячейки есть капсула — replay resolved at claim,
 * scripted worker не spawn'ится. Если miss — dispatcher → worker script.
 */
import { spawn, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const importPath = (p) => pathToFileURL(path.resolve(REPO_ROOT, p)).href;
const SRC_DB = path.join(REPO_ROOT, '.button-color-replay-e2e', 'factory.sqlite');

let KEEP_TEMP = false;
const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-button-'));
const dbPath = path.join(temp, 'button.db');
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath, { recursive: true });

console.log(`[button] temp: ${temp}`);

try {
  // 1. Git repo init
  writeFileSync(path.join(repoPath, 'README.md'), '# Button\n');
  execSync('git init && git config user.email t@t && git config user.name t && git add -A && git commit -m init',
    { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();

  // 2. Fresh DB through getDb (full schema initialization)
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(importPath('dist/db.js'));
  const db = getDb();

  // 3. Copy project + repo from source DB
  const srcDb = new Database(SRC_DB, { readonly: true });
  srcDb.pragma('wal_checkpoint(TRUNCATE)');

  // Project
  const srcProject = srcDb.prepare('SELECT * FROM projects WHERE id=1').get();
  db.prepare('INSERT INTO projects (id, name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(srcProject.id, srcProject.name, srcProject.description || 'Build a deterministic test harness.', 'active', '[]', '{}');

  // Epic
  db.prepare('INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)')
    .run(1, srcProject.id, 'Pipeline', 'planned', 'high');

  // Repository
  db.prepare('INSERT INTO repositories (id, name, default_branch, metadata) VALUES (?, ?, ?, ?)')
    .run(1, 'button-color-repo', 'main', '{}');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, srcProject.id, 1, 'component', repoPath, 'dev', 'active');

  // 4. Copy capsules — ensure schema first
  const { ensureReplayCapsuleSchema } = await import(importPath('dist/infrastructure/replay/sqlite-replay-capsule-repository.js'));
  ensureReplayCapsuleSchema(db);
  const capsules = srcDb.prepare('SELECT * FROM factory_replay_capsules').all();
  const insertCap = db.prepare(
    'INSERT OR IGNORE INTO factory_replay_capsules (capsule_ref, replay_key, project_id, source_execution_ref, source_candidate_set_ref, payload_hash, payload_snapshot, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  let copiedCaps = 0;
  for (const cap of capsules) {
    try {
      insertCap.run(
        cap.capsule_ref || `cap-${cap.replay_key.slice(0,12)}`, cap.replay_key, 1,
        cap.source_execution_ref, cap.source_candidate_set_ref,
        cap.payload_hash, cap.payload_snapshot, cap.created_at,
      );
      copiedCaps++;
    } catch (e) { /* skip duplicates */ }
  }
  console.log(`[button] copied ${copiedCaps}/${capsules.length} capsules`);
  srcDb.close();

  // 5. Create factory order + lifecycle input + launch directly in DB
  const { sha256Hex } = await import(importPath('dist/shared/canonical-json.js'));
  const { requestFactoryLaunch } = await import(importPath('dist/infrastructure/factory/sqlite-factory-launch-repository.js'));

  // Build lifecycle input (same shape as startProductLifecycleFromIdea)
  const { hashDevelopmentPolicy } = await import(importPath('dist/modules/development/domain/development-settlement-policy.js'));
  const { hashDeliveryDeferredProfile } = await import(importPath('dist/modules/delivery/domain/delivery-settlement-policy.js'));

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const deferredProfile = { schemaVersion: 'factory.delivery-deferred-profile.v1', reason: 'authorization-required', source: 'start-from-idea' };
  deferredProfile.profileHash = hashDeliveryDeferredProfile(deferredProfile);

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: { subject: 'mock-claude validation', context: 'e2e factory test', evidence: [], constraints: {} },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: 'button-color-repo', role: 'component' },
        integrationBranch: 'dev',
        expectedBaseCommit: baseCommit,
      }],
      policy: devPolicy,
    },
    delivery: { mode: 'deferred', policy: null, operatorAuthorization: null, deferredProfile },
  };

  const orderRef = `order-button-${Date.now()}`;
  db.prepare(`INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state) VALUES (?, 1, 1, 'idea_url', 'starting')`).run(orderRef);

  const launchRef = requestFactoryLaunch({
    orderRef, mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'button',
    idempotencyKey: `button-${randomUUID()}`,
    concurrency: 1,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
  console.log(`[button] launchRef: ${launchRef}`);
  closeDb();

  // 7. Run orchestrate-cli with composition override
  console.log('[button] starting orchestrate-cli...');
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
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: path.join(REPO_ROOT, 'tests', 'mock-claude', 'composition.mjs'),
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => process.stdout.write(c));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => process.stderr.write(c));

  // Hard timeout: 300s for full e2e (Discovery + Formalization + Development).
  const timeout = setTimeout(() => {
    console.error('\n[button] TIMEOUT — killing orchestrate-cli after 300s');
    try { child.kill('SIGTERM'); } catch {}
  }, 300000);

  const exitCode = await new Promise(resolve => child.once('close', (code) => {
    clearTimeout(timeout);
    resolve(code);
  }));
  console.log(`\n[button] orchestrate-cli exited: ${exitCode}`);

  // 8. Results
  const resultDb = new Database(dbPath, { readonly: true });
  const runs = resultDb.prepare('SELECT id, module_name, status, local_outcome FROM factory_process_runs ORDER BY id').all();
  console.log('\n=== PROCESS RUNS ===');
  runs.forEach(r => console.log(`  run ${r.id}: ${r.module_name} ${r.status} ${r.local_outcome || ''}`));

  const wps = resultDb.prepare('SELECT process_run_id, production_cell_id, kanban_phase, loop_state, terminal_reason, revision FROM factory_workplaces ORDER BY process_run_id, rowid').all();
  console.log(`\n=== WORKPLACES (${wps.length}) ===`);
  wps.forEach(w => console.log(`  pr=${w.process_run_id} ${w.production_cell_id} ${w.kanban_phase}/${w.loop_state} rev=${w.revision} ${w.terminal_reason || ''}`));

  const receipts = resultDb.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_kind='worker_done' AND accepted=1").get();
  console.log(`\nworker_done receipts: ${receipts.n}`);

  // Dump task metadata for debugging discovery.assess shape
  const allTasks = resultDb.prepare("SELECT id, title, task_kind, status, metadata FROM tasks ORDER BY id").all();
  console.log('\n=== TASK METADATA ===');
  console.log(`Total tasks: ${allTasks.length}`);
  for (const t of allTasks) {
    let m = {};
    try { m = JSON.parse(t.metadata || '{}'); } catch {}
    console.log(`task ${t.id} kind=${t.task_kind} status=${t.status} keys=[${Object.keys(m).join(',')}]`);
    if (m.process_node_input) {
      const inp = m.process_node_input;
      console.log(`  process_node_input top-keys=[${Object.keys(inp).join(',')}]`);
      if (inp.upstream) {
        console.log(`  upstream.schema=${inp.upstream.schema}`);
        if (inp.upstream.bindings?.items) {
          inp.upstream.bindings.items.forEach((it, i) => {
            console.log(`  upstream.items[${i}].products=${JSON.stringify(it.products)}`);
          });
        }
      } else {
        console.log(`  process_node_input (flat) = ${JSON.stringify(inp).slice(0, 300)}`);
      }
    }
  }
  resultDb.close();
} catch (err) {
  console.error('[button] FAILED:', err.stack || err.message);
  console.error(`[button] DB preserved at: ${dbPath}`);
  KEEP_TEMP = true;
  process.exit(1);
} finally {
  if (!KEEP_TEMP) rmSync(temp, { recursive: true, force: true });
}
