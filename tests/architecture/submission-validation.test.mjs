/**
 * Regression test: submission validation gate rejects incomplete acceptance contract.
 *
 * This test proves the shift-left fix works: when a worker calls worker_done
 * for `define-acceptance-contract` with AC artifacts that are missing the
 * mandatory derived_from → FR/NFR edge, the submission validator rejects
 * BEFORE the task transitions. The worker receives structured gaps and stays
 * as the execution owner.
 *
 * Before this fix, the gap was discovered only by the post-hoc resolver
 * (resolve-acceptance-contract), AFTER the expensive worker execution had
 * already ended — causing a repair-loop that exhausted the recovery budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { initSubmissionRegistries } from '../../dist/process-modules/application/submission-registries.js';
import { getSubmissionPolicyRegistry } from '../../dist/process-modules/application/submission-registries.js';
import { createAcceptanceContractValidator } from '../../dist/modules/formalization/application/acceptance-contract-validator.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Ensure lazy module tables exist (factory_managed_artifact_productions,
  // factory_process_runs). These are created lazily by repo constructors in
  // production; tests create them directly via the schema function.
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      input_snapshot TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_status TEXT NOT NULL,
      content_hash TEXT,
      operation TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'p')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e')`).run();
  // factory_process_runs row for the FK on managed_artifact_productions
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'solution-formalization', '1.0.0', 'solution-formalization@1.0.0',
             'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  return db;
}

function seedArtifact(db, type, code, id) {
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  // Brief root (inserted once, idempotent)
  db.prepare(
    `INSERT OR IGNORE INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (1, 1, 1, 'brief', 'BRIEF-1', 'Brief', 'docs/brief.md', 'accepted', ?, ?, 'clean', 'db_native', '[]', '{}')`,
  ).run(hash('brief'), hash('brief'));
  const artifactHash = hash(`${type}-${code}-${id}`);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (?, 1, 1, ?, ?, ?, 'docs/x.md', 'accepted', ?, ?, 'clean', 'file_backed', '[]', '{}')`,
  ).run(id, type, code, `${type}-${code}`, artifactHash, artifactHash);
}

function seedManagedProduction(db, artifactId, type) {
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'solution-formalization@1.0.0', 'define-acceptance-contract',
             5, 5, 'exec-test', ?, ?, 'draft', 'h', 'create')`,
  ).run(artifactId, type ?? (artifactId >= 29 ? 'AC' : 'FR'));
}

test('submission validator rejects AC without FR/NFR edge with structured gaps', () => {
  const db = freshDb();
  // Seed: PRD (id=2), FR (id=3), UC (id=26), AC (id=29) with traces:
  // AC-1 → UC (ok) but AC-1 has NO FR/NFR edge (the gap).
  seedArtifact(db, 'PRD', 'PRD', 2);
  seedArtifact(db, 'FR', 'FR-1', 3);
  seedArtifact(db, 'UC', 'UC-1', 26);
  seedArtifact(db, 'AC', 'AC-1', 29);
  // PRD → brief (root edge, required by findContractGap)
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (2, 'artifact', 1, 'derived_from')`).run();
  // AC → UC trace (exists)
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (29, 'artifact', 26, 'derived_from')`).run();
  // AC → FR trace MISSING (the gap)
  // Register productions for ALL contract artifacts (PRD, FR, UC, AC)
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
  seedManagedProduction(db, 26, 'UC');
  seedManagedProduction(db, 29, 'AC');

  const validator = createAcceptanceContractValidator(db);
  const result = validator.validate({
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'define-acceptance-contract',
    executionId: 'exec-test',
    taskId: 5,
    epicId: 1,
    projectId: 1,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_ACCEPTANCE_INCOMPLETE');
  assert.ok(result.gaps.length > 0, 'must have at least one gap');
  const gap = result.gaps[0];
  assert.equal(gap.artifactType, 'AC');
  assert.equal(gap.missing.relation, 'derived_from');
  assert.ok(gap.missing.requiredTargetTypes.includes('FR'));
  assert.ok(gap.missing.requiredTargetTypes.includes('NFR'));
  db.close();
});

test('submission validator accepts AC with complete FR + UC edges', () => {
  const db = freshDb();
  seedArtifact(db, 'PRD', 'PRD', 2);
  seedArtifact(db, 'FR', 'FR-1', 3);
  seedArtifact(db, 'UC', 'UC-1', 26);
  seedArtifact(db, 'AC', 'AC-1', 29);
  // PRD → brief (root edge)
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (2, 'artifact', 1, 'derived_from')`).run();
  // UC → PRD (derived_from) + UC → FR (covers) — required by findContractGap useCases check
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (26, 'artifact', 2, 'derived_from')`).run();
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (26, 'artifact', 3, 'covers')`).run();
  // Complete traces: AC → FR + AC → UC
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (29, 'artifact', 3, 'derived_from')`).run();
  db.prepare(`INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (29, 'artifact', 26, 'derived_from')`).run();
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
  seedManagedProduction(db, 26, 'UC');
  seedManagedProduction(db, 29, 'AC');

  const validator = createAcceptanceContractValidator(db);
  const result = validator.validate({
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'define-acceptance-contract',
    executionId: 'exec-test',
    taskId: 5,
    epicId: 1,
    projectId: 1,
  });

  assert.equal(result.accepted, true);
  assert.ok(result.receipt.artifactIds.includes(29));
  assert.ok(result.receipt.validatedSetDigest);
  db.close();
});

test('policy registry: define-acceptance-contract is required, others unsupported', () => {
  const db = freshDb();
  initSubmissionRegistries(db);
  const registry = getSubmissionPolicyRegistry();
  assert.ok(registry, 'registry must be initialized');

  const acceptancePolicy = registry.resolve('solution-formalization@1.0.0', 'define-acceptance-contract');
  assert.ok(acceptancePolicy);
  assert.equal(acceptancePolicy.mode, 'required');

  const productPolicy = registry.resolve('solution-formalization@1.0.0', 'define-product-contract');
  assert.ok(productPolicy);
  assert.equal(productPolicy.mode, 'required');
  assert.equal(productPolicy.requireManagedProduction, true);

  const reconciliationPolicy = registry.resolve('solution-formalization@1.0.0', 'reconcile-what');
  assert.ok(reconciliationPolicy);
  assert.equal(reconciliationPolicy.mode, 'required');
  assert.equal(reconciliationPolicy.requireManagedProduction, false);

  const discoveryPolicy = registry.resolve('product-discovery@3.0.2', 'produce-proposal');
  assert.ok(discoveryPolicy);
  assert.equal(discoveryPolicy.mode, 'none');
  db.close();
});
