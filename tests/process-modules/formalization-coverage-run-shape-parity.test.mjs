/**
 * RUN-SHAPE PARITY BATTERY — the systematic answer to the ELITE-7 escape.
 *
 * Why this file exists: the ELITE-7 defect (register-carrying run, blind
 * formalization gates, unrepairable planner death) passed the whole
 * blocking matrix because every existing fixture seeded the
 * FormalizationCase INTO the checked task's own metadata — the FIRST
 * node's shape. Production never produces that shape for later nodes:
 * the case rides the ingress task only, every other node's frozen
 * process_node_input is its own stage envelope. Green tests proved the
 * wrong theorem (fixture-shape monoculture; the third instance of the
 * ADR-053 class after Elite-4 and CC-GAP-8 proof-hosting).
 *
 * Design rules of this battery (none of which the old fixtures followed):
 *
 *   P1 PRODUCER CENSUS — the node list is NOT hand-declared: it is derived
 *      from the production process-module definition (dist export). A new
 *      formalization node added tomorrow fails the census until it gets a
 *      shape row here. You cannot add a producer shape without a consumer
 *      test.
 *
 *   P2 ALL-NODE PARITY SWEEP — for EVERY work node of the module, with the
 *      case riding ONLY the ingress sibling task (the production shape),
 *      the coverage reader MUST resolve the same register. The ELITE-7
 *      defect is exactly one cell of this sweep (red on the pre-fix
 *      reader for every node past the ingress; proven red-by-construction
 *      by the sibling-case regression in formalization-constraint-
 *      coverage.test.mjs).
 *
 *   P3 ISOLATION — a case from a foreign process run never resolves for
 *      this run's gates (run-scoping is load-bearing: the sibling lookup
 *      must not become a cross-run oracle leak).
 *
 *   P4 REGISTERLESS GRANDFATHER — a run with NO case anywhere stays null
 *      (the ADR-088 legacy corpus condition), on every node.
 *
 * The GATE-level verdict table (omitted coverage -> FORMALIZATION_CONSTRAINT_
 * UNCOVERED, attached -> accepted) lives in formalization-constraint-
 * coverage.test.mjs; this battery owns the resolution invariants that make
 * that table reachable for every production input shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';
import { readConstraintCoverageRequirement } from '../../dist/modules/formalization/application/constraint-coverage.js';

const PROCESS_RUN_ID = 2;
const INGRESS_TASK_ID = 101;
const CHECKED_TASK_ID = 102;

// ---- P1: the census, derived from the production module --------------------

const flow = formalizationProcessModule.flow;
const workNodes = flow.nodes
  .filter(node => !node.id.startsWith('complete-') && !flow.terminalNodeIds?.includes(node.id))
  .map(node => node.id);

const INGRESS_NODE = flow.entryNodeId;

/**
 * Desk-input envelope per node — the PRODUCTION shapes the projection
 * persists as tasks.metadata.process_node_input. The ingress node gets the
 * FormalizationCase; every later node gets its own stage envelope (output
 * manifests / the acceptance-baseline snapshot). The envelope KINDS mirror
 * the transitions (see formalization-process-module.ts): the census below
 * asserts this table covers exactly the module's work nodes.
 */
const NODE_DESK_INPUT_SHAPES = {
  'define-product-contract': 'formalization-case',
  'model-use-cases': 'output-manifest',
  'define-acceptance-contract': 'output-manifest',
  'reconcile-what': 'output-manifest',
  'freeze-acceptance-baseline': 'output-manifest',
  'define-architecture-contract': 'acceptance-baseline-snapshot',
  'settle-formalization': 'output-manifest',
};

function deskInputFor(nodeId) {
  const shape = NODE_DESK_INPUT_SHAPES[nodeId];
  assert.ok(shape, `census miss: node '${nodeId}' has no desk-input shape row (P1)`);
  if (shape === 'formalization-case') return formalizationCase();
  if (shape === 'acceptance-baseline-snapshot') {
    return {
      schema: 'factory.acceptance-baseline-snapshot.v1',
      artifactRef: 'formalization-baseline:1',
    };
  }
  return {
    schema: 'factory.process-node-output-manifest.v1',
    producer: nodeId,
    artifacts: [],
  };
}

// ---- fixtures ---------------------------------------------------------------

function formalizationCase() {
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
      order_constraints: [
        { class: 'execution', text: 'npm install && npm start', evidence_ref: 'order.source_body' },
        { class: 'human', text: '60fps in Chrome', evidence_ref: 'order.source_body' },
      ],
    },
    initiativeSubject: 'run-shape parity battery',
    initiatedBy: 'operator',
  };
}

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
     VALUES (${PROCESS_RUN_ID}, 1, 'solution-formalization', '1.0.0', 'solution-formalization@1.0.0',
             'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  return db;
}

function seedTask(db, id, nodeId, process_node_input) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (?, 1, ?, 'in_progress', ?)`,
  ).run(id, nodeId, JSON.stringify({
    process_run_id: PROCESS_RUN_ID,
    process_node_id: nodeId,
    process_module_ref: 'solution-formalization@1.0.0',
    process_node_input,
  }));
}

/** The production shape: the case rides the INGRESS sibling, not this node. */
function seedRun(db, checkedNodeId) {
  seedTask(db, INGRESS_TASK_ID, INGRESS_NODE, formalizationCase());
  seedTask(db, CHECKED_TASK_ID, checkedNodeId, deskInputFor(checkedNodeId));
  return CHECKED_TASK_ID;
}

// ---- P1: producer census ----------------------------------------------------

test('P1 census: every work node of the production module has a shape row (and vice versa)', () => {
  const declared = Object.keys(NODE_DESK_INPUT_SHAPES);
  const missing = workNodes.filter(node => !declared.includes(node));
  const stale = declared.filter(node => !workNodes.includes(node));
  assert.deepEqual(missing, [],
    'new formalization node(s) without a desk-input shape row — add the row and the parity sweep covers it');
  assert.deepEqual(stale, [],
    'shape rows for nodes the module no longer declares — remove them');
  assert.equal(NODE_DESK_INPUT_SHAPES[INGRESS_NODE], 'formalization-case',
    'the ingress node is the one shape whose desk input IS the case (P2 depends on it)');
});

// ---- P2: all-node parity sweep ----------------------------------------------

test('P2 parity: the register resolves for EVERY work node through the ingress sibling (production shape)', () => {
  assert.ok(workNodes.length >= 5, 'census unexpectedly small — module definition drifted?');
  for (const nodeId of workNodes) {
    const db = freshDb();
    const taskId = seedRun(db, nodeId);
    const requirement = readConstraintCoverageRequirement(db, taskId, PROCESS_RUN_ID);
    assert.notEqual(requirement, null,
      `node '${nodeId}': the coverage reader must see the run's register (ELITE-7 class blindness)`);
    assert.deepEqual(requirement.constraintIds, ['ord-c-001', 'ord-c-002'],
      `node '${nodeId}': same register as every other node — one run, one register`);
    db.close();
  }
});

test('P2 ingress: the node whose own desk input IS the case still resolves (unchanged path)', () => {
  const db = freshDb();
  const taskId = seedRun(db, INGRESS_NODE);
  assert.equal(taskId, CHECKED_TASK_ID);
  // The checked task IS the case carrier here — the direct path.
  const requirement = readConstraintCoverageRequirement(db, CHECKED_TASK_ID, PROCESS_RUN_ID);
  assert.notEqual(requirement, null);
  assert.deepEqual(requirement.constraintIds, ['ord-c-001', 'ord-c-002']);
  db.close();
});

// Nodes whose register visibility depends SOLELY on run-scoped resolution
// (the ingress node carries the case in its own desk input — isolation and
// grandfather states are not producible for it by construction).
const RESOLUTION_DEPENDENT_NODES = workNodes.filter(node => node !== INGRESS_NODE);

// ---- P3: run isolation ------------------------------------------------------

test('P3 isolation: a case pinned to a FOREIGN process run never resolves here', () => {
  for (const nodeId of RESOLUTION_DEPENDENT_NODES) {
    const db = freshDb();
    seedTask(db, INGRESS_TASK_ID, INGRESS_NODE, formalizationCase());
    // The sibling's metadata belongs to a DIFFERENT process run.
    db.prepare(`UPDATE tasks SET metadata = replace(metadata, '"process_run_id":${PROCESS_RUN_ID}', '"process_run_id":99') WHERE id=?`)
      .run(INGRESS_TASK_ID);
    seedTask(db, CHECKED_TASK_ID, nodeId, deskInputFor(nodeId));
    assert.equal(readConstraintCoverageRequirement(db, CHECKED_TASK_ID, PROCESS_RUN_ID), null,
      `node '${nodeId}': a foreign run's case must not resolve (cross-run oracle leak)`);
    db.close();
  }
});

// ---- P4: registerless grandfather ------------------------------------------

test('P4 grandfather: a run with no case anywhere stays null on every node', () => {
  for (const nodeId of RESOLUTION_DEPENDENT_NODES) {
    const db = freshDb();
    seedTask(db, CHECKED_TASK_ID, nodeId, deskInputFor(nodeId));
    assert.equal(readConstraintCoverageRequirement(db, CHECKED_TASK_ID, PROCESS_RUN_ID), null,
      `node '${nodeId}': no case in the run — the ADR-088 registerless grandfather`);
    db.close();
  }
});
