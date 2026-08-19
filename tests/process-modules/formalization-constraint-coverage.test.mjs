/**
 * AC-drift remedy, network 2 (structure): the requirement-coverage ratchet.
 *
 * Even with an honest brief (network 1), the AC graph can still drop the
 * order's constraints: the stage-11 SRS "restored" docker/TS into HOW
 * sections while every AC ignored them, and the graph only checks edges
 * downward. The ratchet is the reverse diff:
 *
 *   register IDs − union(covered_constraint_ids of all ACs) − waived = ∅
 *
 * Enforced at the worker_done boundary (acceptance validator) and again in
 * the reconciliation phase (final catch-all), and frozen into the acceptance
 * baseline payload as coveredConstraints.
 *
 * Retro-compatibility: no register -> empty diff -> green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  buildContractSnapshot,
  findContractGap,
  constraintCoverageGapIds,
  constraintCoverageGapIdList,
} from '../../dist/modules/formalization/application/formalization-contract-analysis.js';
import { createAcceptanceContractValidator } from '../../dist/modules/formalization/application/acceptance-contract-validator.js';
import { createFormalizationContractValidator } from '../../dist/modules/formalization/application/formalization-contract-validator.js';
import {
  createFormalizationProductionCellKernelHandlers,
  FORMALIZATION_KERNEL_HANDLER_IDS,
} from '../../dist/modules/formalization/application/formalization-production-cell-installation.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

// ---- pure findContractGap coverage mode ------------------------------------

const emptyGraph = {
  readOutgoingArtifactTraces: () => [],
  readArtifactsByIds: () => [],
};

function acSnapshot(id, metadata) {
  return {
    id,
    projectId: 1,
    epicId: 1,
    type: 'AC',
    code: `AC-${id}`,
    status: 'accepted',
    contentHash: hash(`ac-${id}`),
    acceptedHash: hash(`ac-${id}`),
    driftState: 'clean',
    tags: '[]',
    metadata,
  };
}

test('findContractGap reports uncovered register IDs not covered and not waived', () => {
  const snapshot = buildContractSnapshot(emptyGraph, [
    acSnapshot(30, { covered_constraint_ids: ['ord-c-001'] }),
  ]);
  const gap = findContractGap(snapshot, {
    coverage: {
      constraintIds: ['ord-c-001', 'ord-c-002', 'ord-c-003'],
      waivedIds: ['ord-c-003'],
    },
  });
  assert.ok(gap);
  assert.ok(gap.includes('ord-c-002'));
  assert.ok(!gap.includes('ord-c-001'));
  assert.ok(!gap.includes('ord-c-003'));
});

test('findContractGap passes when every ID is covered or waived', () => {
  const snapshot = buildContractSnapshot(emptyGraph, [
    acSnapshot(30, { covered_constraint_ids: ['ord-c-001', 'ord-c-002'] }),
    acSnapshot(31, { covered_constraint_ids: [] }),
  ]);
  const gap = findContractGap(snapshot, {
    coverage: {
      constraintIds: ['ord-c-001', 'ord-c-002', 'ord-c-003'],
      waivedIds: ['ord-c-003'],
    },
  });
  assert.equal(gap, null);
});

test('coverage across multiple ACs is the union of their covered ids', () => {
  const snapshot = buildContractSnapshot(emptyGraph, [
    acSnapshot(30, { covered_constraint_ids: ['ord-c-001'] }),
    acSnapshot(31, { covered_constraint_ids: ['ord-c-002'] }),
  ]);
  assert.deepEqual(
    constraintCoverageGapIdList(snapshot, {
      constraintIds: ['ord-c-001', 'ord-c-002'],
      waivedIds: [],
    }),
    [],
  );
  assert.deepEqual(
    constraintCoverageGapIdList(snapshot, {
      constraintIds: ['ord-c-001', 'ord-c-002', 'ord-c-003'],
      waivedIds: [],
    }),
    ['ord-c-003'],
  );
});

test('no coverage requirement -> no constraint gap (retro-compat in the pure diff)', () => {
  const snapshot = buildContractSnapshot(emptyGraph, [acSnapshot(30, {})]);
  assert.equal(findContractGap(snapshot, { coverage: { constraintIds: [], waivedIds: [] } }), null);
  assert.equal(constraintCoverageGapIds(snapshot, { constraintIds: [], waivedIds: [] }).length, 0);
});

// ---- worker_done acceptance validator with the coverage ratchet ------------

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

const ORDER_CONSTRAINTS = [
  { class: 'execution', text: 'one-command `docker compose up`', evidence_ref: 'order.source_body' },
  { class: 'material', text: 'TypeScript backend', evidence_ref: 'order.source_body' },
  { class: 'human', text: 'Chrome client feel', evidence_ref: 'order.source_body' },
];

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
      order_constraints: ORDER_CONSTRAINTS,
    },
    initiativeSubject: 'docking slice',
    initiatedBy: 'operator',
  };
}

function seedTask(db, metadata) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (5, 1, 'define acceptance contract', 'in_progress', ?)`,
  ).run(JSON.stringify(metadata));
}

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
     VALUES (2, 'solution-formalization@1.0.0', 'define-acceptance-contract',
             5, 5, 'exec-test', ?, ?, 'draft', 'h', 'create')`,
  ).run(artifactId, type);
}

function seedTrace(db, sourceId, targetId, linkType = 'derived_from') {
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (?, 'artifact', ?, ?)`,
  ).run(sourceId, targetId, linkType);
}

/** Complete acceptance contract: brief→PRD→FR→UC→AC edges all present. */
function seedCompleteAcceptanceContract(db, { briefMetadata, acMetadata }) {
  seedArtifact(db, 1, 'brief', 'BRIEF-1', briefMetadata ?? {});
  seedArtifact(db, 2, 'PRD', 'PRD', {});
  seedArtifact(db, 3, 'FR', 'FR-1', {});
  seedArtifact(db, 26, 'UC', 'UC-1', {});
  seedArtifact(db, 29, 'AC', 'AC-1', acMetadata ?? {});
  seedTrace(db, 2, 1); // PRD → brief root
  seedTrace(db, 3, 2); // FR → PRD
  seedTrace(db, 26, 2); // UC → PRD
  seedTrace(db, 26, 3, 'covers'); // UC → FR
  seedTrace(db, 29, 3); // AC → FR
  seedTrace(db, 29, 26); // AC → UC
  seedManagedProduction(db, 1, 'brief');
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
  seedManagedProduction(db, 26, 'UC');
  seedManagedProduction(db, 29, 'AC');
}

const BRIEF_WITH_WAIVER = {
  constraint_dispositions: {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': { disposition: 'accepted' },
    'ord-c-003': { disposition: 'waived', reason: 'human check deferred to operator' },
  },
};

const INPUT = {
  processRunId: 2,
  moduleRef: 'solution-formalization@1.0.0',
  nodeId: 'define-acceptance-contract',
  executionId: 'exec-test',
  taskId: 5,
  epicId: 1,
  projectId: 1,
};

test('acceptance validator rejects uncovered constraint with FORMALIZATION_CONSTRAINT_UNCOVERED', () => {
  const db = freshDb();
  seedTask(db, { process_node_input: formalizationCase() });
  seedCompleteAcceptanceContract(db, {
    briefMetadata: BRIEF_WITH_WAIVER,
    acMetadata: {}, // no covered_constraint_ids anywhere
  });
  const result = createAcceptanceContractValidator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNCOVERED');
  assert.equal(result.gaps.length, 2); // ord-c-001, ord-c-002 (003 waived)
  assert.ok(result.gaps.every(gap => gap.missing.relation === 'covers_constraint'));
  assert.ok(result.gaps.some(gap => gap.artifactCode === 'ord-c-001'));
  assert.ok(result.gaps.some(gap => gap.message.includes('docker compose up')));
});

test('acceptance validator accepts when covered ∪ waived = register', () => {
  const db = freshDb();
  seedTask(db, { process_node_input: formalizationCase() });
  seedCompleteAcceptanceContract(db, {
    briefMetadata: BRIEF_WITH_WAIVER,
    acMetadata: { covered_constraint_ids: ['ord-c-001', 'ord-c-002'] },
  });
  const result = createAcceptanceContractValidator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('acceptance validator ignores invalid waiver (no reason) for coverage purposes', () => {
  const db = freshDb();
  seedTask(db, { process_node_input: formalizationCase() });
  seedCompleteAcceptanceContract(db, {
    briefMetadata: {
      constraint_dispositions: {
        'ord-c-001': { disposition: 'accepted' },
        'ord-c-002': { disposition: 'accepted' },
        'ord-c-003': { disposition: 'waived' }, // no reason -> NOT a valid waiver
      },
    },
    acMetadata: { covered_constraint_ids: ['ord-c-001', 'ord-c-002'] },
  });
  const result = createAcceptanceContractValidator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNCOVERED');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].artifactCode, 'ord-c-003');
});

test('acceptance validator without a register stays green (retro-compat)', () => {
  const db = freshDb();
  const noRegisterCase = formalizationCase();
  delete noRegisterCase.discoveryProposalPayload.order_constraints;
  seedTask(db, { process_node_input: noRegisterCase });
  seedCompleteAcceptanceContract(db, { acMetadata: {} });
  const result = createAcceptanceContractValidator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('reconciliation validator enforces the same coverage diff (final catch-all)', () => {
  const db = freshDb();
  seedTask(db, { process_node_input: formalizationCase() });
  seedCompleteAcceptanceContract(db, {
    briefMetadata: BRIEF_WITH_WAIVER,
    acMetadata: {},
  });
  const validator = createFormalizationContractValidator(
    db,
    'formalization.reconciliation.v1',
    'reconcile-what',
    { product: true, useCases: true, acceptance: true, coverage: true },
  );
  const result = validator.validate({ ...INPUT, nodeId: 'reconcile-what' });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNCOVERED');
  assert.equal(result.gaps.length, 2);
});

// ---- baseline freezer freezes coveredConstraints into the payload ----------

test('baseline freezer carries AC covered_constraint_ids into payload.coveredConstraints', () => {
  const frozen = [];
  const deps = {
    graph: {
      readAcceptedArtifactsForLifecycle: () => ({
        prd: 2, frs: [3], nfrs: [], rules: [], ucs: [26], acs: [29], srs: 40,
      }),
      readAcceptanceBaselineHashForLifecycle: () => ({
        hash: 'b'.repeat(64), clean: true, dirty: [],
      }),
      readArtifactsByIds: (ids) => ids.map((id) => ({
        id,
        projectId: 1,
        epicId: 1,
        type: id === 29 ? 'AC' : 'PRD',
        code: id === 29 ? 'AC-1' : 'PRD',
        status: 'accepted',
        contentHash: hash(`artifact-${id}`),
        acceptedHash: hash(`artifact-${id}`),
        driftState: 'clean',
        tags: '[]',
        metadata: id === 29 ? { covered_constraint_ids: ['ord-c-001'] } : {},
      })),
      readOwningLifecycleRunId: () => 7,
    },
    baselineRepository: {
      freeze: (payload) => {
        frozen.push(payload);
        return {
          replayed: false,
          record: {
            artifactRef: `baseline:${payload.baselineHash.slice(0, 12)}`,
            baselineHash: payload.baselineHash,
            snapshotHash: payload.baselineHash,
            payload,
          },
        };
      },
      readByProcessRun: () => null,
    },
    solutionContractRepository: {
      persist: () => { throw new Error('not expected in this test'); },
    },
    settlementPolicy: { settle: () => { throw new Error('not expected'); } },
    certificateRepository: { issue: () => { throw new Error('not expected'); } },
    readArtifactContent: (id) => (id === 29
      ? '## AC-1 Docking slice\n\nThe docking slice works end to end.\n'
      : 'x'.repeat(10)),
  };
  const handlers = createFormalizationProductionCellKernelHandlers(deps);
  const result = handlers[FORMALIZATION_KERNEL_HANDLER_IDS.freezeBaseline]({
    projectId: 1,
    epicId: 1,
    processRunId: 2,
    input: { artifactRef: 'a', contentHash: 'c' },
    frame: { runInput: formalizationCase() },
    heartbeat: () => {},
    initiatedBy: 'operator',
    node: { id: 'freeze-acceptance-baseline' },
  });
  assert.equal(result.event, 'frozen');
  assert.equal(frozen.length, 1);
  assert.deepEqual(frozen[0].coveredConstraints, { 'AC-1': ['ord-c-001'] });
});

test('baseline payload omits coveredConstraints when no AC carries any (retro-compat)', () => {
  const frozen = [];
  const deps = {
    graph: {
      readAcceptedArtifactsForLifecycle: () => ({
        prd: 2, frs: [3], nfrs: [], rules: [], ucs: [26], acs: [29], srs: 40,
      }),
      readAcceptanceBaselineHashForLifecycle: () => ({
        hash: 'b'.repeat(64), clean: true, dirty: [],
      }),
      readArtifactsByIds: (ids) => ids.map((id) => ({
        id,
        projectId: 1,
        epicId: 1,
        type: id === 29 ? 'AC' : 'PRD',
        code: id === 29 ? 'AC-1' : 'PRD',
        status: 'accepted',
        contentHash: hash(`artifact-${id}`),
        acceptedHash: hash(`artifact-${id}`),
        driftState: 'clean',
        tags: '[]',
        metadata: {},
      })),
      readOwningLifecycleRunId: () => 7,
    },
    baselineRepository: {
      freeze: (payload) => {
        frozen.push(payload);
        return {
          replayed: false,
          record: {
            artifactRef: `baseline:${payload.baselineHash.slice(0, 12)}`,
            baselineHash: payload.baselineHash,
            snapshotHash: payload.baselineHash,
            payload,
          },
        };
      },
      readByProcessRun: () => null,
    },
    solutionContractRepository: { persist: () => {} },
    settlementPolicy: { settle: () => { throw new Error('not expected'); } },
    certificateRepository: { issue: () => { throw new Error('not expected'); } },
    readArtifactContent: (id) => (id === 29
      ? '## AC-1 Docking slice\n\nThe docking slice works end to end.\n'
      : 'x'.repeat(10)),
  };
  const handlers = createFormalizationProductionCellKernelHandlers(deps);
  const result = handlers[FORMALIZATION_KERNEL_HANDLER_IDS.freezeBaseline]({
    projectId: 1,
    epicId: 1,
    processRunId: 2,
    input: { artifactRef: 'a', contentHash: 'c' },
    frame: { runInput: formalizationCase() },
    heartbeat: () => {},
    initiatedBy: 'operator',
    node: { id: 'freeze-acceptance-baseline' },
  });
  assert.equal(result.event, 'frozen');
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].coveredConstraints, undefined);
});
