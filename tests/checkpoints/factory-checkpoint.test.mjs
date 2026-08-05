import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { FactoryCheckpointService } from '../../dist/checkpoints/factory-checkpoint-service.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryNodeRunSchema } from '../../dist/process-modules/persistence/sqlite-node-run-repository.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-checkpoint-test-'));
  const repo = path.join(root, 'repo');
  const docs = path.join(repo, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, 'prd.md'), '# captured\n', 'utf8');
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
     VALUES (5,1,2,'PRD','PRD','docs/prd.md',4,'ignored-legacy-hash')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,
       idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,
       status,package_digest)
     VALUES (6,1,2,'m','1','m@1','idem','generic-flow','in','{}','input-hash','paused','pkg-hash')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_node_runs
      (id,process_run_id,node_id,node_kind,attempt,status,event,output_ref,
       output_schema,output_hash,output_bindings,execution_receipt)
     VALUES (7,6,'author','lm',1,'completed','runtime.completed','artifact:5',
       'test.product','product-hash','{}',?)`,
  ).run(JSON.stringify({
    kind: 'task-execution', executorKind: 'lm', intentId: 8, taskId: 9,
    executionId: 'old-execution', runtimeStatus: 'completed', replayed: false,
  }));
  db.close();
  return { root, repo, dbPath, store: path.join(root, 'store') };
}

test('online checkpoint captures DB and artifact bytes, verifies, and restores clone', async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const service = new FactoryCheckpointService();
  const manifest = await service.capture({
    dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2,
    createdBy: 'test', hmacKey: 'secret', signatureKeyId: 'test-key',
  });
  const manifestPath = path.join(f.store, 'manifests', `${manifest.payload.checkpointRef}.json`);
  assert.equal(service.verify(manifestPath, 'secret').digest, manifest.digest);
  const cloneDb = path.join(f.root, 'clone', 'clone.db');
  const cloneWorkspace = path.join(f.root, 'clone-workspace');
  service.restoreClone({ manifestPath, targetDbPath: cloneDb, targetWorkspace: cloneWorkspace, hmacKey: 'secret' });
  assert.equal(readFileSync(path.join(cloneWorkspace, 'repository-4', 'docs', 'prd.md'), 'utf8'), '# captured\n');
  const db = new Database(cloneDb, { readonly: true });
  assert.equal(db.prepare('SELECT mode FROM factory_runtime_mode WHERE singleton_id=1').pluck().get(), 'diagnostic_clone');
  assert.equal(db.prepare('SELECT local_path FROM project_repositories WHERE id=4').pluck().get(), path.join(cloneWorkspace, 'repository-4'));
  assert.notEqual(
    db.prepare('SELECT namespace_id FROM factory_database_identity WHERE singleton_id=1').pluck().get(),
    manifest.payload.sourceDbNamespace,
  );
  db.close();
});

test('checkpoint verification rejects object corruption', async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const service = new FactoryCheckpointService();
  const manifest = await service.capture({ dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2, createdBy: 'test' });
  const artifact = manifest.payload.objects.find(object => object.kind === 'artifact');
  assert.ok(artifact);
  writeFileSync(path.join(f.store, artifact.objectPath), 'corrupt', 'utf8');
  const manifestPath = path.join(f.store, 'manifests', `${manifest.payload.checkpointRef}.json`);
  assert.throws(() => service.verify(manifestPath), /CHECKPOINT_OBJECT_(MISSING_OR_TRUNCATED|DIGEST_MISMATCH)/);
});

test('test replay adoption is clone-only and creates a ready import directive', async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const service = new FactoryCheckpointService();
  const manifest = await service.capture({
    dbPath: f.dbPath, storageRoot: f.store, projectId: 1, epicId: 2,
    createdBy: 'test', hmacKey: 'secret',
  });
  const manifestPath = path.join(f.store, 'manifests', `${manifest.payload.checkpointRef}.json`);
  assert.throws(() => service.adopt({
    dbPath: f.dbPath, manifestPath, targetProjectId: 1, targetEpicId: 2,
    targetProcessRunId: 6, targetNodeId: 'author', sourceNodeRunId: 7,
    actor: 'test', reason: 'probe', hmacKey: 'secret', verificationProfile: 'test_replay',
  }), /REQUIRES_DIAGNOSTIC_CLONE/);

  const cloneDb = path.join(f.root, 'clone', 'clone.db');
  const cloneWorkspace = path.join(f.root, 'clone-workspace');
  service.restoreClone({ manifestPath, targetDbPath: cloneDb, targetWorkspace: cloneWorkspace, hmacKey: 'secret' });
  const adopted = service.adopt({
    dbPath: cloneDb, manifestPath, targetProjectId: 1, targetEpicId: 2,
    targetProcessRunId: 6, targetNodeId: 'author', sourceNodeRunId: 7,
    actor: 'test', reason: 'probe', hmacKey: 'secret', verificationProfile: 'test_replay',
  });
  assert.match(adopted.directiveRef, /^resume-directive-/);
  const replayed = service.adopt({
    dbPath: cloneDb, manifestPath, targetProjectId: 1, targetEpicId: 2,
    targetProcessRunId: 6, targetNodeId: 'author', sourceNodeRunId: 7,
    actor: 'test', reason: 'probe', hmacKey: 'secret', verificationProfile: 'test_replay',
  });
  assert.deepEqual(replayed, adopted);
  const db = new Database(cloneDb, { readonly: true });
  assert.equal(db.prepare('SELECT state FROM factory_resume_directives').pluck().get(), 'ready');
  assert.equal(db.prepare('SELECT verification_profile FROM factory_adoptions').pluck().get(), 'test_replay');
  db.close();
});
