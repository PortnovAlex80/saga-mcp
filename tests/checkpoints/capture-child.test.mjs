// tests/checkpoints/capture-child.test.mjs
//
// Antifreeze layer B4 — checkpoint capture isolated in a ONE-SHOT CHILD
// process (src/checkpoints/capture-cli.ts + capture-spawn.ts). Same-process
// capture (engine main connection + capture connection on one event loop)
// could deadlock forever under a write-lock collision (TB-2 class); here the
// capture connection only exists in a disposable child:
//
//   1. CLI contract: real spawn on a temp DB → exit 0, ONE stdout line with
//      the manifest digest, manifest + COMPLETE marker + objects in the
//      store, signature verified, include-logs/reason/created-by honored;
//   2. parent path (captureCheckpointViaChild): resolves with the ref from
//      the store pointer; works with and without epic scope; HMAC key
//      travels via env (SAGA_CAPTURE_HMAC_KEY), not argv;
//   3. failure isolation: broken DB → child exits 1, the helper REJECTS (the
//      engine cycle catches and logs — non-fatal there), no hang;
//   4. timeout: a fake slow child is SIGKILLed and the parent does not wait
//      forever;
//   5. SAGA_CHECKPOINT_CHILD=0 → the legacy in-process path still works
//      through the same entry point (captureCheckpointIsolated).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { FactoryCheckpointService } from '../../dist/checkpoints/factory-checkpoint-service.js';
import { captureCheckpointIsolated, captureCheckpointViaChild } from '../../dist/checkpoints/capture-spawn.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryNodeRunSchema } from '../../dist/process-modules/persistence/sqlite-node-run-repository.js';

const ROOT = path.resolve('.');
const CAPTURE_CLI = path.join(ROOT, 'dist', 'checkpoints', 'capture-cli.js');

function fixture(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `saga-capture-child-${name}-`));
  const repo = path.join(root, 'repo');
  const docs = path.join(repo, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, 'prd.md'), '# captured by child\n', 'utf8');
  const dbPath = path.join(root, 'saga.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryNodeRunSchema(db);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (3,'r')").run();
  db.prepare(
    "INSERT INTO project_repositories (id,project_id,repository_id,local_path) VALUES (4,1,3,?)",
  ).run(repo);
  db.prepare(
    `INSERT INTO artifacts
      (id,project_id,epic_id,type,title,path,project_repository_id,content_hash)
     VALUES (5,1,2,'PRD','PRD','docs/prd.md',4,NULL)`,
  ).run();
  db.close();
  return { root, dbPath, store: path.join(root, 'store') };
}

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CAPTURE_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// --- 1. CLI contract ---------------------------------------------------------

test('capture CLI: real spawn → exit 0, one stdout digest line, store objects, signature', () => {
  const f = fixture('cli');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const run = runCli([
    '--db', f.dbPath,
    '--store', f.store,
    '--project', '1',
    '--epic', '2',
    '--created-by', 'capture-child-test',
    '--reason', 'child-contract',
    '--include-logs',
    '--hmac-key', 'secret',
    '--signature-key-id', 'cli-test-key',
  ]);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  // Exactly ONE stdout line carrying the manifest digest.
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.ok, true);
  assert.match(receipt.checkpoint, /^checkpoint-1-2-\d+-[0-9a-f-]+$/);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);

  const manifestPath = path.join(f.store, 'manifests', `${receipt.checkpoint}.json`);
  assert.ok(existsSync(manifestPath));
  assert.ok(existsSync(`${manifestPath}.COMPLETE`));
  const service = new FactoryCheckpointService();
  const manifest = service.verify(manifestPath, 'secret');
  assert.equal(manifest.digest, receipt.digest);
  assert.equal(manifest.payload.createdBy, 'capture-child-test (child-contract)');
  assert.equal(manifest.payload.security.logsIncluded, true);
  assert.equal(manifest.payload.security.signatureKeyId, 'cli-test-key');
  assert.ok(manifest.signature, 'manifest is HMAC-signed');
  // Physical objects really landed in the store (db backup + artifact file).
  const dbObject = manifest.payload.objects.find(object => object.kind === 'database');
  assert.ok(dbObject && existsSync(path.join(f.store, dbObject.objectPath.replaceAll('\\', '/'))));
  const artifactObject = manifest.payload.objects.find(object => object.kind === 'artifact');
  assert.ok(artifactObject && existsSync(path.join(f.store, artifactObject.objectPath.replaceAll('\\', '/'))));
  assert.equal(
    existsSync(path.join(f.store, 'latest-1-2')),
    true,
    'store pointer for the (project, epic) scope',
  );
});

test('capture CLI: missing required flag → exit 1 with a stderr message', () => {
  const f = fixture('missing');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const run = runCli(['--db', f.dbPath, '--store', f.store]); // --project omitted
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--project/);
});

// --- 2. parent spawn path ------------------------------------------------------

test('captureCheckpointViaChild: resolves with the ref from the store pointer', async () => {
  const f = fixture('parent');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = await captureCheckpointViaChild({
    dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2,
    createdBy: 'parent-path-test',
    hmacKey: 'k', signatureKeyId: 'env:TEST',
  });
  assert.match(result.checkpointRef, /^checkpoint-1-2-\d+-/);
  const manifestPath = path.join(f.store, 'manifests', `${result.checkpointRef}.json`);
  const manifest = new FactoryCheckpointService().verify(manifestPath, 'k');
  assert.equal(manifest.payload.security.signatureKeyId, 'env:TEST');
  assert.equal(manifest.payload.createdBy, 'parent-path-test');
});

test('captureCheckpointViaChild: epic-less (project-wide) scope writes latest-<p>-all', async () => {
  const f = fixture('noepic');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = await captureCheckpointViaChild({
    dbPath: f.dbPath, storageRoot: f.store, projectId: 1, createdBy: 'parent-noepic',
  });
  assert.match(result.checkpointRef, /^checkpoint-1-all-\d+-/);
  assert.ok(existsSync(path.join(f.store, 'latest-1-all')));
});

// --- 3. failure isolation --------------------------------------------------------

test('broken DB: child exits 1, parent helper rejects, nothing hangs', async () => {
  const f = fixture('broken');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const garbageDb = path.join(f.root, 'garbage.db');
  writeFileSync(garbageDb, 'this is not a sqlite database at all\n', 'utf8');
  // Child contract: exit 1 + stderr.
  const run = runCli(['--db', garbageDb, '--store', f.store, '--project', '1']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.trim().length > 0, 'failure reason on stderr');
  // Parent contract: typed rejection the engine cycle catches and logs.
  await assert.rejects(
    captureCheckpointViaChild({
      dbPath: garbageDb, storageRoot: f.store, projectId: 1, createdBy: 'broken-test',
    }),
    /CHECKPOINT_CHILD_FAILED: exit code 1/,
  );
});

// --- 4. timeout -------------------------------------------------------------------

test('timeout: fake slow child is killed and the parent does not wait forever', async () => {
  const f = fixture('timeout');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  const slowChild = path.join(f.root, 'slow-child.mjs');
  // Sleeps on a 10-minute timer — a wedged "capture" that never exits alone.
  writeFileSync(slowChild, 'setTimeout(() => {}, 10 * 60 * 1000);\n', 'utf8');
  const startedAt = Date.now();
  await assert.rejects(
    captureCheckpointViaChild(
      { dbPath: f.dbPath, storageRoot: f.store, projectId: 1, createdBy: 'timeout-test' },
      { script: slowChild, timeoutMs: 800 },
    ),
    /CHECKPOINT_CHILD_TIMEOUT/,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 15_000, `parent returned promptly (elapsed ${elapsed}ms)`);
});

// --- 5. env kill-switch -----------------------------------------------------------

test('SAGA_CHECKPOINT_CHILD=0 → legacy in-process path via the same entry point', async () => {
  const f = fixture('inproc');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  process.env.SAGA_CHECKPOINT_CHILD = '0';
  try {
    const outcome = await captureCheckpointIsolated({
      dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2,
      createdBy: 'in-process-test',
    });
    assert.equal(outcome.mode, 'in-process');
    assert.match(outcome.checkpointRef, /^checkpoint-1-2-\d+-/);
    assert.ok(outcome.manifest, 'the in-process path still yields the manifest object');
    assert.ok(existsSync(path.join(f.store, 'manifests', `${outcome.checkpointRef}.json`)));
    assert.ok(readdirSync(path.join(f.store, 'objects', 'sha256')).length > 0);
  } finally {
    delete process.env.SAGA_CHECKPOINT_CHILD;
  }
});

test('default (no env override) routes through the child path', async () => {
  const f = fixture('default');
  test.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.notEqual(process.env.SAGA_CHECKPOINT_CHILD, '0');
  const outcome = await captureCheckpointIsolated({
    dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2,
    createdBy: 'default-child-test',
  });
  assert.equal(outcome.mode, 'child');
  assert.match(outcome.checkpointRef, /^checkpoint-1-2-\d+-/);
  assert.ok(existsSync(path.join(f.store, 'manifests', `${outcome.checkpointRef}.json`)));
});
