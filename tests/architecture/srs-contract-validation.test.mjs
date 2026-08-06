/**
 * Regression test: SRS contract validator + policy registration.
 *
 * Verifies that define-architecture-contract is mode=required and the
 * validator catches structural gaps (missing §12, missing SRS→PRD trace)
 * before worker_done transitions the task.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { initSubmissionRegistries, getSubmissionPolicyRegistry } from '../../dist/process-modules/application/submission-registries.js';
import { createSrsContractValidator } from '../../dist/modules/formalization/application/srs-contract-validator.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      module_name TEXT NOT NULL, module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL, input_schema TEXT NOT NULL,
      input_snapshot TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL, node_id TEXT NOT NULL, intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL, artifact_type TEXT NOT NULL,
      artifact_status TEXT NOT NULL, content_hash TEXT, operation TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      product_key TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('p');
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('e');
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'sf', '1.0.0', 'sf@1', 'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  return db;
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

function seedSrsArtifact(db, srsPath, repoId) {
  const h = hash('SRS');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (42, 1, 1, 'SRS', null, 'SRS', ?, 'draft', ?, ?, 'clean', ?, 'file_backed', '[]', '{}')`,
  ).run(srsPath, h, h, repoId);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-architecture-contract', 7, 7, 'exec', 42, 'SRS', 'draft', ?, 'create')`,
  ).run(h);
}

function seedPrd(db) {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (2, 1, 1, 'PRD', null, 'PRD', 'prd.md', 'accepted', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(hash('PRD'), hash('PRD'));
}

test('SRS validator policy: define-architecture-contract is required', () => {
  const db = freshDb();
  initSubmissionRegistries(db);
  const registry = getSubmissionPolicyRegistry();
  const policy = registry.resolve('solution-formalization@1.0.0', 'define-architecture-contract');
  assert.ok(policy);
  assert.equal(policy.mode, 'required');
  assert.equal(policy.validatorId, 'formalization.srs-contract.v1');
  db.close();
});

test('SRS validator rejects when §12 Decision Log is missing', () => {
  const db = freshDb();
  // Create a temp dir as repo local_path
  const tmpDir = path.join(os.tmpdir(), `srs-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  // repositories master + project_repositories binding (FK chain)
  db.prepare('INSERT INTO repositories (id, name) VALUES (1, ?)').run('repo');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (1, 1, 1, ?, ?, ?, ?)').run('component', tmpDir, 'dev', 'active');
  seedPrd(db);
  const srsPath = '01-SRS.md';
  seedSrsArtifact(db, srsPath, 1);
  // SRS → PRD trace
  db.prepare('INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, ?, ?, ?)').run('artifact', 2, 'derived_from');
  // Write SRS WITHOUT §12
  writeFileSync(path.join(tmpDir, srsPath), '# SRS\n\nSome content without Decision Log.\n');

  const validator = createSrsContractValidator(db);
  const result = validator.validate({
    processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
    executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  db.close();
});

test('SRS validator accepts when §12 Decision Log is present', () => {
  const db = freshDb();
  const tmpDir = path.join(os.tmpdir(), `srs-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  // repositories master + project_repositories binding (FK chain)
  db.prepare('INSERT INTO repositories (id, name) VALUES (1, ?)').run('repo');
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (1, 1, 1, ?, ?, ?, ?)').run('component', tmpDir, 'dev', 'active');
  seedPrd(db);
  const srsPath = '01-SRS.md';
  seedSrsArtifact(db, srsPath, 1);
  db.prepare('INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, ?, ?, ?)').run('artifact', 2, 'derived_from');
  // Write SRS WITH §12
  writeFileSync(path.join(tmpDir, srsPath),
    '# SRS\n\n## §12 Decision Log\n\n| # | Decision |\n|---|----------|\n| 1 | KISS |\n');

  const validator = createSrsContractValidator(db);
  const result = validator.validate({
    processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
    executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
  });
  assert.equal(result.accepted, true);
  db.close();
});
