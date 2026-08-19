/**
 * AC-drift remedy, network 1 (reaction): the product-contract author MUST
 * dispose every constraint-register ID in the brief's metadata.
 *
 * Forensic ground truth (stage 11): the author SAW all three requirements
 * (they rode the discovery proposal payload into the spawn prompt) and
 * rewrote the order without them. The defect is "no obligation to react",
 * not "content not delivered". This gate makes the reaction mandatory:
 * register IDs minus brief dispositions must be empty, else
 * FORMALIZATION_CONSTRAINT_UNDISPOSED with one typed per-ID SubmissionGap
 * (relation: covers_constraint) through the existing recovery-feedback path.
 *
 * Retro-compatibility: no register in the case -> empty diff -> accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createFormalizationContractValidator } from '../../dist/modules/formalization/application/formalization-contract-validator.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
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

const hash = (s) => createHash('sha256').update(s).digest('hex');

function seedArtifact(db, id, type, code, metadata = {}) {
  const h = hash(`${type}-${code}-${id}`);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (?, 1, 1, ?, ?, ?, 'docs/x.md', 'accepted', ?, ?, 'clean', 'file_backed', '[]', ?)`,
  ).run(id, type, code, code, h, h, JSON.stringify(metadata));
}

function seedManagedProduction(db, artifactId, type) {
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'solution-formalization@1.0.0', 'define-product-contract',
             5, 5, 'exec-test', ?, ?, 'draft', 'h', 'create')`,
  ).run(artifactId, type);
}

const ORDER_CONSTRAINTS = [
  { class: 'execution', text: 'one-command `docker compose up`', evidence_ref: 'order.source_body' },
  { class: 'material', text: 'TypeScript backend', evidence_ref: 'order.source_body' },
  { class: 'human', text: 'Chrome client feel', evidence_ref: 'order.source_body' },
];

function formalizationCase(orderConstraints) {
  return {
    schemaVersion: FORMALIZATION_CASE_SCHEMA,
    discoveryEpicId: 1,
    formalizationEpicId: 1,
    discoveryCertificateRef: 'certificate:1',
    discoveryCertificateHash: 'a'.repeat(64),
    discoveryOutcome: 'go',
    discoveryProposalRef: 'proposal:1',
    discoveryProposalHash: 'b'.repeat(64),
    discoveryProposalPayload: {
      problem_statement: 'p',
      observed_context: 'o',
      stakeholders_or_actors: ['a'],
      assumptions: [],
      unknowns: [],
      risks: [],
      candidate_scope: 's',
      evidence_refs: ['e'],
      recommended_outcome: 'go',
      rationale: 'r',
      ...(orderConstraints === undefined
        ? {}
        : { order_constraints: orderConstraints }),
    },
    initiativeSubject: 'docking slice',
    initiatedBy: 'operator',
  };
}

function seedTask(db, processNodeInput) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (5, 1, 'author brief+PRD', 'in_progress', ?)`,
  ).run(JSON.stringify({ process_node_input: processNodeInput }));
}

function seedCompleteProductContract(db, briefMetadata) {
  seedArtifact(db, 1, 'brief', 'BRIEF-1', briefMetadata);
  seedArtifact(db, 2, 'PRD', 'PRD', {});
  seedArtifact(db, 3, 'FR', 'FR-1', {});
  // PRD → brief root edge (required by findContractGap product mode)
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (2, 'artifact', 1, 'derived_from')`,
  ).run();
  // FR → PRD
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (3, 'artifact', 2, 'derived_from')`,
  ).run();
  seedManagedProduction(db, 1, 'brief');
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
}

function validator(db) {
  return createFormalizationContractValidator(
    db,
    'formalization.product-contract.v1',
    'define-product-contract',
    { product: true, constraintDispositions: true },
  );
}

const INPUT = {
  processRunId: 2,
  moduleRef: 'solution-formalization@1.0.0',
  nodeId: 'define-product-contract',
  executionId: 'exec-test',
  taskId: 5,
  epicId: 1,
  projectId: 1,
};

test('undisposed constraint ID rejects with FORMALIZATION_CONSTRAINT_UNDISPOSED and a per-ID gap', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'waived', reason: 'plain JS accepted for slice' },
      // ord-c-003 NOT disposed — the gap
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 1);
  const gap = result.gaps[0];
  assert.equal(gap.missing.relation, 'covers_constraint');
  assert.ok(gap.message.includes('ord-c-003'));
  assert.ok(gap.message.includes('Chrome client feel'));
});

test('every ID disposed (accepted or waived+reason) accepts with a receipt', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'waived', reason: 'operator deferred the human check' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
  assert.ok(result.receipt.validatedAt);
});

test('waived disposition without a reason is a gap (waiver requires reason)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'waived' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.ok(result.gaps.some(gap => gap.message.includes('ord-c-003')
    && gap.message.includes('reason')));
});

test('unknown disposition enum value is a gap', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'maybe' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
});

test('no register in the case accepts (retro-compat: empty diff is green)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(undefined));
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('case with empty order_constraints array accepts (no register)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase([]));
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('missing task metadata / missing process_node_input accepts (retro-compat)', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (5, 1, 'author brief+PRD', 'in_progress', '{}')`,
  ).run();
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('register present but brief artifact absent rejects every ID', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  // No brief at all: the product contract is structurally incomplete anyway,
  // but the disposition gate must not silently pass on a missing brief.
  seedArtifact(db, 2, 'PRD', 'PRD', {});
  seedArtifact(db, 3, 'FR', 'FR-1', {});
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 3);
});

test('constraint diff runs alongside the structural product gap (both reported)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  // Complete product contract but no dispositions at all.
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 3);
  assert.ok(result.gaps.every(gap => gap.missing.relation === 'covers_constraint'));
});
