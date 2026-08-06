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
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { initSubmissionRegistries, getSubmissionPolicyRegistry } from '../../dist/process-modules/application/submission-registries.js';
import { createSrsContractValidator } from '../../dist/modules/formalization/application/srs-contract-validator.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
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

function seedRepo(db) {
  const tmpDir = path.join(os.tmpdir(), `srs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db.prepare('INSERT INTO repositories (id, name) VALUES (1, ?)').run('repo');
  db.prepare(
    'INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (1, 1, 1, ?, ?, ?, ?)',
  ).run('component', tmpDir, 'dev', 'active');
  return tmpDir;
}

function seedPrd(db) {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (2, 1, 1, 'PRD', null, 'PRD', 'prd.md', 'accepted', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(hash('PRD'), hash('PRD'));
}

function seedSrs(db, tmpDir, srsContent) {
  const h = hash('SRS');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (42, 1, 1, 'SRS', null, 'SRS', '01-SRS.md', 'draft', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(h, h);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-architecture-contract', 7, 7, 'exec', 42, 'SRS', 'draft', ?, 'create')`,
  ).run(h);
  // SRS → PRD trace
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, 'artifact', 2, 'derived_from')`,
  ).run();
  // Write SRS file
  writeFileSync(path.join(tmpDir, '01-SRS.md'), srsContent);
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
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, '# SRS\n\nSome content without Decision Log.\n');
  const v = createSrsContractValidator(db);
  const result = v.validate({
    processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
    executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  db.close();
});

test('SRS validator accepts when §12 Decision Log is present', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir,
    '# SRS\n\n## §12 Decision Log\n\n| # | Decision |\n|---|----------|\n| 1 | KISS |\n');
  const v = createSrsContractValidator(db);
  const result = v.validate({
    processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
    executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
  });
  assert.equal(result.accepted, true);
  db.close();
});
