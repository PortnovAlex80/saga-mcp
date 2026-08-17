// tests/infrastructure/lib/replay-binder-fixture.mjs
//
// Shared in-memory fixture for replay-binder tests (the K8 semantic-key
// theorem and the dispatch-routing tests). Seeds only the tables the REAL
// binder touches: the capsule schema, the process-run the key material
// reads, the reviewer authority chain, the worker execution whose metadata
// the binder freezes the claim into, and EMPTY stubs for the
// certification-sweep tables (so certifyAcceptedReplayCapsules is a no-op
// and ineligibility starts false).

import Database from 'better-sqlite3';

import { ensureReplayCapsuleSchema } from '../../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { ensureFactoryProcessRunSchema } from '../../../dist/process-modules/persistence/sqlite-process-run-repository.js';

export function freshDb() {
  const db = new Database(':memory:');
  // better-sqlite3 enables FK enforcement by default; the fixture seeds
  // partial rows without the referenced parents.
  db.pragma('foreign_keys = OFF');
  ensureReplayCapsuleSchema(db);
  ensureFactoryProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_gate_decision_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      accepted_author_task_id TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_candidate_set_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('produced','carried-forward')),
      source_candidate_set_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (candidate_set_ref, ordinal)
    );
    CREATE TABLE IF NOT EXISTS factory_workplaces (
      workplace_ref TEXT PRIMARY KEY,
      process_run_id INTEGER,
      loop_state TEXT,
      terminal_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_cell_final_acceptances (
      workplace_ref TEXT,
      gate_decision_key TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_gate_decisions (
      decision_key TEXT PRIMARY KEY,
      workplace_ref TEXT,
      subject_candidate_set_ref TEXT,
      assessment_candidate_set_refs TEXT,
      gate_run_ref TEXT,
      verdict TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_gate_presentation_attempts (
      gate_run_ref TEXT,
      replay_capsule_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS worker_executions (
      execution_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      epic_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      launcher TEXT NOT NULL DEFAULT 'claude_cli',
      state TEXT NOT NULL DEFAULT 'reserved',
      phase TEXT NOT NULL DEFAULT 'executing',
      pid INTEGER,
      reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      phase_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      workplace_ref TEXT,
      metadata TEXT
    );
  `);
  return db;
}

export function seedProcessRun(db, id, projectId, packageDigest) {
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?,?,'m','1.0.0','m@1.0.0',?,'generic-flow','in.v1','{}',
             '0000000000000000000000000000000000000000000000000000000000000000')`,
  ).run(id, projectId, `idem-${id}`);
  db.prepare('UPDATE factory_process_runs SET package_digest=? WHERE id=?')
    .run(packageDigest, id);
}

export function seedExecution(db, executionId, taskId, projectId) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, phase, metadata)
     VALUES (?,?,?,?,?,'w','m','executing',?)`,
  ).run(executionId, `run-${executionId}`, projectId, 1, taskId,
    JSON.stringify({
      execution_context: { selected_route: 'route-A' },
      execution_context_hash: 'seed',
    }));
}

export function makeTask(id, metadata, workplaceRef) {
  return {
    id,
    epic_id: 1,
    metadata: JSON.stringify(metadata),
    workplace_ref: workplaceRef ?? null,
  };
}

export function taskMetadata(processRunId, overrides = {}) {
  return {
    process_run_id: processRunId,
    process_node_id: 'node-produce',
    process_module_ref: 'm@1.0.0',
    production_cell_id: 'cell-x',
    work_key: 'work-1',
    semantic_input_digest: 'a'.repeat(64),
    ...overrides,
  };
}

export function insertCapsule(db, { capsuleRef, replayKey, projectId, payloadHash }) {
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(capsuleRef, replayKey, projectId, `exec-${capsuleRef}`, `cs-${capsuleRef}`,
    payloadHash, '{}');
}
