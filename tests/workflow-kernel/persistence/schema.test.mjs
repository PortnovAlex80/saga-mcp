/**
 * schema.test.mjs - the fresh bootstrap contains ONLY the approved schema
 * (exactly the 22 frozen relations), records the exact protocol identity,
 * and the append-only/CAS trigger guards hold (WP-06, plan phase EK-3).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const schema = await import('../../../dist/workflow-kernel/persistence/schema.js');
const { PROTOCOL_ID, SCHEMA_VERSION, SCHEMA_FINGERPRINT, SCHEMA_SQL, SCHEMA_TABLES, SCHEMA_OBJECT_NAMES, bootstrapFreshDatabase, schemaObjectInventory, readProtocolIdentity, owningAggregateOfTable } = schema;
const { UNIVERSE_SCHEMA_VERSION } = await import('../../../dist/workflow-kernel/domain/universe.js');

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ek-wp06-schema-'));
  const db = new Database(join(dir, 'kernel.sqlite'));
  bootstrapFreshDatabase(db);
  return { db, dir };
}

test('a fresh database contains only the approved schema (22 relations, exact object inventory)', () => {
  const { db } = freshDb();
  try {
    const inventory = schemaObjectInventory(db);
    assert.deepEqual(inventory.tables.sort(), [...SCHEMA_TABLES].sort(), 'exactly the 22 approved tables');
    assert.equal(inventory.views.length, 0, 'no views');
    const inventoryNames = [...inventory.tables, ...inventory.triggers, ...inventory.indices].sort();
    assert.deepEqual(inventoryNames, [...SCHEMA_OBJECT_NAMES].sort(), 'no extra and no missing schema object');
    assert.equal(inventory.tables.length, 22, 'exactly 22 physical relations');
  } finally {
    db.close();
  }
});

test('the 22 physical tables map 1:1 onto the frozen Target logical model relations', async () => {
  const budget = (await import('../../../docs/refactoring/event-kernel/specs/complexity-budget.json', { with: { type: 'json' } })).default;
  const relationNames = budget.kernelCompositionConvention.relationNames;
  assert.equal(relationNames.length, 22, 'the frozen universe declares exactly 22 relations');
  const physicalOfRelation = {
    ProtocolMetadata: 'protocol_metadata',
    FactoryRun: 'factory_run',
    LifecycleRun: 'lifecycle_run',
    StageRun: 'stage_run',
    ProcessRun: 'process_run',
    NodeRun: 'node_run',
    WorkItem: 'work_item',
    WorkItemDependency: 'work_item_dependency',
    Workplace: 'workplace',
    WorkIntent: 'workplace_work_intent',
    ActivityAttempt: 'activity_attempt',
    PromptAssemblyReceipt: 'activity_attempt_prompt_assembly_receipt',
    WorkplaceProductionRevision: 'workplace_production_revision',
    CandidateSet: 'workplace_candidate_set',
    GateDecision: 'workplace_gate_decision',
    EffectReceipt: 'workplace_effect_receipt',
    CellFinalAcceptance: 'workplace_cell_final_acceptance',
    WorkflowEvent: 'workflow_event',
    TransitionObligation: 'transition_obligation',
    TypedWait: 'typed_wait',
    TerminalProof: 'terminal_proof',
    KanbanCard: 'kanban_card',
  };
  const mapped = relationNames.map((relation) => physicalOfRelation[relation]);
  assert.deepEqual(mapped.sort(), [...SCHEMA_TABLES].sort(), 'each frozen relation has exactly one physical table');
  for (const [aggregate, prefix] of Object.entries(budget.lawfulRepositoryConvention.aggregateTablePrefixes)) {
    for (const table of SCHEMA_TABLES) {
      if (table.startsWith(`${prefix}_`) || table === prefix) {
        assert.equal(owningAggregateOfTable(table), aggregate, `${table} belongs to ${aggregate}`);
      }
    }
  }
  // Shared ledger tables belong to no aggregate (lawful for every repository).
  for (const table of ['workflow_event', 'transition_obligation', 'typed_wait', 'terminal_proof', 'protocol_metadata', 'kanban_card']) {
    assert.equal(owningAggregateOfTable(table), undefined, `${table} must belong to no aggregate`);
  }
});

test('protocol metadata records the exact protocol identity, immutably', () => {
  const { db } = freshDb();
  try {
    const identity = readProtocolIdentity(db);
    assert.deepEqual(identity, {
      protocol_id: PROTOCOL_ID,
      schema_version: SCHEMA_VERSION,
      schema_fingerprint: SCHEMA_FINGERPRINT,
      universe_version: UNIVERSE_SCHEMA_VERSION,
    });
    assert.equal(Number(db.pragma('user_version')[0].user_version), SCHEMA_VERSION);
    assert.throws(() => db.exec('UPDATE protocol_metadata SET schema_fingerprint = \'x\''), /EK_PROTOCOL_METADATA_IMMUTABLE/);
    assert.throws(() => db.exec('DELETE FROM protocol_metadata'), /EK_PROTOCOL_METADATA_IMMUTABLE/);
  } finally {
    db.close();
  }
});

test('the schema fingerprint is deterministic across fresh bootstraps', () => {
  const { db: a } = freshDb();
  const { db: b } = freshDb();
  try {
    assert.equal(readProtocolIdentity(a).schema_fingerprint, readProtocolIdentity(b).schema_fingerprint);
    assert.equal(readProtocolIdentity(a).schema_fingerprint, SCHEMA_FINGERPRINT);
  } finally {
    a.close();
    b.close();
  }
});

test('the bootstrap DDL is purely declarative creation (no alteration, no data statements)', () => {
  assert.equal(/\bALTER\s+TABLE\b/i.test(SCHEMA_SQL), false, 'no ALTER TABLE in the fresh bootstrap');
  assert.equal(/IF\s+NOT\s+EXISTS/i.test(SCHEMA_SQL), false, 'no conditional creation (the bootstrap runs on verified-empty databases only)');
  // Outside trigger definitions (the append-only guards) there is no DML at all:
  // the DDL creates schema only; the identity row is written by the bootstrap transaction.
  const withoutTriggersAndComments = SCHEMA_SQL.replace(/CREATE\s+TRIGGER[\s\S]*?END;/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|PRAGMA|ALTER)\b/i.test(withoutTriggersAndComments), false, 'no data or alteration statements outside trigger guards');
  assert.match(withoutTriggersAndComments.trim(), /^CREATE\s+TABLE\s+protocol_metadata/, 'the DDL opens with the protocol identity table');
});

test('append-only guards: immutable relations refuse UPDATE and DELETE (seeded rows)', () => {
  const { db } = freshDb();
  try {
    // Seed one immutable row per relation via the lawful writer path.
    db.exec(`
      INSERT INTO workplace (instance_id, aggregate, revision, status, terminal, last_sequence) VALUES ('w1', 'Workplace', 1, 'materialized', NULL, 1);
      INSERT INTO activity_attempt (instance_id, aggregate, revision, status, terminal, last_sequence, work_intent_ref, role_contract_ref, role_contract_digest) VALUES ('a1', 'ActivityAttempt', 1, 'created', NULL, 2, 'intent:1', 'sha256:aa', 'aa');
      INSERT INTO work_item (instance_id, aggregate, revision, status, terminal, last_sequence, planning_input_refs_json) VALUES ('wi1', 'WorkItem', 1, 'planned', NULL, 3, '[]');
      INSERT INTO work_item (instance_id, aggregate, revision, status, terminal, last_sequence) VALUES ('wi2', 'WorkItem', 1, 'planned', NULL, 4);
      INSERT INTO work_item_dependency (work_item_ref, depends_on_ref, created_sequence) VALUES ('wi1', 'wi2', 4);
      INSERT INTO workplace_work_intent (intent_ref, work_item_ref, workplace_instance_id, workplace_expected_revision, completion_command, protocol_role, role_contract_ref, role_contract_digest, input_evidence_refs_json, created_sequence)
        VALUES ('intent:1', 'wi1', 'w1', 1, 'activityAttempt.recordOutcome', 'author', 'sha256:aa', 'aa', '[]', 5);
      INSERT INTO workplace_production_revision (revision_ref, workplace_instance_id, payload_digest, created_sequence) VALUES ('pr:1', 'w1', 'd', 6);
      INSERT INTO workplace_candidate_set (candidate_ref, workplace_instance_id, presentation, payload_digest, created_sequence) VALUES ('cs:1', 'w1', 'author', 'd', 7);
      INSERT INTO workplace_gate_decision (decision_ref, workplace_instance_id, verdict, payload_digest, created_sequence) VALUES ('gd:1', 'w1', 'accepted', 'd', 8);
      INSERT INTO workplace_effect_receipt (receipt_ref, workplace_instance_id, outcome, payload_digest, created_sequence) VALUES ('er:1', 'w1', 'success', 'd', 9);
      INSERT INTO workplace_cell_final_acceptance (acceptance_ref, workplace_instance_id, acceptance_digest, payload_digest, created_sequence) VALUES ('cfa:1', 'w1', 'd', 'd', 10);
      INSERT INTO activity_attempt_prompt_assembly_receipt (receipt_ref, activity_attempt_instance_id, admission, request_ordinal, expected_context_revision, digest, payload_json, created_sequence)
        VALUES ('par:1', 'a1', 'admitted', 1, 0, 'd', '{}', 11);
      INSERT INTO workflow_event (sequence, idempotency_key, kind, source_owner, source_instance_id, source_revision, source_status, transition, evidence_refs_json, recorded_evidence_json)
        VALUES (1, 'k1', 'WorkflowEvent:workplace.materialized', 'Workplace', 'w1', 1, 'materialized', 'workplace.materialize', '[]', '[]');
      INSERT INTO terminal_proof (proof_kind, scope, owner_aggregate, owner_instance_id, evidence_closure_json, created_sequence)
        VALUES ('TerminalProof:cell.success', 'cell', 'Workplace', 'w1', '[]', 12);
    `);
    // Self-referential dependency edges are refused by CHECK.
    assert.throws(() => db.exec("INSERT INTO work_item_dependency (work_item_ref, depends_on_ref, created_sequence) VALUES ('wi1', 'wi1', 99)"), /CHECK/);
    const immutable = [
      ['work_item', 'planning_input_refs_json', "'[\"x\"]'", 'EK_WORK_ITEM_IMMUTABLE_PLANNING_FACT'],
      ['work_item_dependency', 'created_sequence', '99', 'EK_WORK_ITEM_DEPENDENCY_IMMUTABLE'],
      ['workplace_work_intent', 'role_contract_digest', "'bb'", 'EK_WORK_INTENT_IMMUTABLE'],
      ['workplace_production_revision', 'payload_digest', "'x'", 'EK_PRODUCTION_REVISION_IMMUTABLE'],
      ['workplace_candidate_set', 'payload_digest', "'x'", 'EK_CANDIDATE_SET_IMMUTABLE'],
      ['workplace_gate_decision', 'verdict', "'repair'", 'EK_GATE_DECISION_IMMUTABLE'],
      ['workplace_effect_receipt', 'outcome', "'repair'", 'EK_EFFECT_RECEIPT_IMMUTABLE'],
      ['workplace_cell_final_acceptance', 'acceptance_digest', "'x'", 'EK_CELL_FINAL_ACCEPTANCE_IMMUTABLE'],
      ['activity_attempt_prompt_assembly_receipt', 'digest', "'x'", 'EK_PROMPT_ASSEMBLY_RECEIPT_IMMUTABLE'],
      ['workflow_event', 'transition', "'x'", 'EK_WORKFLOW_EVENT_APPEND_ONLY'],
      ['terminal_proof', 'scope', "'x'", 'EK_TERMINAL_PROOF_APPEND_ONLY'],
    ];
    for (const [table, column, value, guard] of immutable) {
      assert.throws(() => db.exec(`UPDATE ${table} SET ${column} = ${value}`), new RegExp(guard), `UPDATE ${table} must hit ${guard}`);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), new RegExp(guard), `DELETE ${table} must hit ${guard}`);
    }
  } finally {
    db.close();
  }
});

test('CAS guards: aggregate heads advance exactly one revision; the attempt role pin is immutable', () => {
  const { db } = freshDb();
  try {
    db.exec("INSERT INTO workplace (instance_id, aggregate, revision, status, terminal, last_sequence) VALUES ('w1', 'Workplace', 1, 'materialized', NULL, 1)");
    db.exec("UPDATE workplace SET revision = 2, status = 'intent-admitted', last_sequence = 2 WHERE instance_id = 'w1' AND revision = 1");
    assert.throws(() => db.exec('UPDATE workplace SET revision = 4, last_sequence = 3 WHERE instance_id = \'w1\' AND revision = 2'), /EK_CAS_REVISION_FENCE/);
    assert.throws(() => db.exec('UPDATE workplace SET instance_id = \'w2\', revision = 3 WHERE instance_id = \'w1\' AND revision = 2'), /EK_CAS_REVISION_FENCE/);
    assert.throws(() => db.exec("DELETE FROM workplace WHERE instance_id = 'w1'"), /EK_AGGREGATE_HEAD_NOT_DELETABLE/);

    db.exec("INSERT INTO activity_attempt (instance_id, aggregate, revision, status, terminal, last_sequence, work_intent_ref, role_contract_ref, role_contract_digest) VALUES ('a1', 'ActivityAttempt', 1, 'created', NULL, 3, 'intent:1', 'sha256:aa', 'aa')");
    assert.throws(
      () => db.exec("UPDATE activity_attempt SET revision = 2, role_contract_digest = 'bb' WHERE instance_id = 'a1' AND revision = 1"),
      /EK_CAS_REVISION_FENCE_ATTEMPT_PIN_IMMUTABLE/,
    );
  } finally {
    db.close();
  }
});

test('obligation and wait guards: only the lawful monotone state transitions', () => {
  const { db } = freshDb();
  try {
    db.exec(`
      INSERT INTO transition_obligation (kind, source, source_instance_id, target, target_aggregate, target_instance_id, evidence_refs_json, state, idempotency_key)
        VALUES ('obligation:providerSend', 'activityAttempt.admitProviderRequest', 'a1', 'cognition.sendProviderRequest', 'CognitionTransport', 'cognition:transport', '[]', 'open', 'k#1');
      INSERT INTO typed_wait (kind, owner_aggregate, owner_instance_id, wake_commands_json, wake_obligation_kinds_json, state)
        VALUES ('TypedWait:human-input', 'Workplace', 'w1', '["workplace.resolveHumanResponse"]', '[]', 'pending');
    `);
    assert.throws(() => db.exec("UPDATE transition_obligation SET kind = 'obligation:runGate.author' WHERE id = 1"), /EK_OBLIGATION_OPEN_TO_COMPLETED_ONLY/);
    assert.throws(() => db.exec("DELETE FROM transition_obligation WHERE id = 1"), /EK_OBLIGATION_NOT_DELETABLE/);
    db.exec(`UPDATE transition_obligation SET state = 'completed', completion_evidence_ref = 'e:x', completed_by_key = 'k-done', completed_at_sequence = 2, completion_evidence_json = '[]' WHERE id = 1 AND state = 'open'`);
    assert.throws(() => db.exec("UPDATE transition_obligation SET state = 'open' WHERE id = 1"), /EK_OBLIGATION_OPEN_TO_COMPLETED_ONLY/, 'completion is final');

    assert.throws(() => db.exec("UPDATE typed_wait SET kind = 'TypedWait:readiness' WHERE id = 1"), /EK_WAIT_PENDING_TO_DISCHARGED_ONLY/);
    db.exec(`UPDATE typed_wait SET state = 'discharged', discharge_evidence_ref = 'e:y' WHERE id = 1 AND state = 'pending'`);
    assert.throws(() => db.exec("UPDATE typed_wait SET state = 'pending' WHERE id = 1"), /EK_WAIT_PENDING_TO_DISCHARGED_ONLY/, 'discharge is final');
    assert.throws(() => db.exec('DELETE FROM typed_wait WHERE id = 1'), /EK_WAIT_NOT_DELETABLE/);
  } finally {
    db.close();
  }
});
