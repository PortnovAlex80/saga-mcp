// P4 tests: Formalization settlement policy (deterministic, no DB).
//
// Uses a fake FormalizationArtifactGraphPort to drive the policy through all
// decision branches without touching SQLite. The SQLite-backed graph port is
// exercised at the bottom (TB-11 lifecycle-scoping regression) and in P6
// (E2E smoke against a real artifact store).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { ReferenceFormalizationSettlementPolicy, SqliteFormalizationArtifactGraph } = await import(
  '../../dist/modules/formalization/infrastructure/sqlite-formalization-kernel.js'
);
const { buildFormalizationCertificatePayload } = await import(
  '../../dist/modules/formalization/domain/formalization-kernel-ports.js'
);
const {
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
} = await import(
  '../../dist/modules/formalization/domain/formalization-schemas.js'
);
const { canonicalJson } = await import(
  '../../dist/shared/canonical-json.js'
);

// The lifecycle run the policy is asked to settle for (TB-11 scoping).
const LIFECYCLE_RUN_ID = 7;

// --- Fake graph port --------------------------------------------------------

function fakeGraph(overrides = {}) {
  const defaults = {
    prd: 1,
    frs: [10],
    nfrs: [11],
    rules: [],
    ucs: [20],
    acs: [30, 31],
    srs: 40,
    baselineHash: 'b'.repeat(64),
    baselineClean: true,
    baselineDirty: [],
    traceGap: null,
    tasksReady: true,
    blockingTaskIds: [],
  };
  const state = { ...defaults, ...overrides };
  // TB-11: record the exact (epicId, lifecycleRunId) the policy hands down so
  // tests can assert the gate is invoked with the CURRENT lifecycle run.
  state.areTasksReadyCalls = [];
  return {
    _state: state,
    readAcceptedArtifacts(_epicId) {
      return {
        prd: state.prd, frs: state.frs, nfrs: state.nfrs, rules: state.rules,
        ucs: state.ucs, acs: state.acs, srs: state.srs,
      };
    },
    readAcceptedArtifactsForLifecycle(_epicId, _lifecycleRunId) {
      // ADR-078 (K6): the fake surfaces lifecycle-scoped state so tests can
      // simulate dead-run exclusion; defaults mirror the epic-scoped view.
      return {
        prd: state.prd, frs: state.frs, nfrs: state.nfrs, rules: state.rules,
        ucs: state.ucs, acs: state.scopedAcs ?? state.acs, srs: state.srs,
      };
    },
    readAcceptanceBaselineHash(_epicId) {
      return { hash: state.baselineHash, clean: state.baselineClean, dirty: state.baselineDirty };
    },
    readAcceptanceBaselineHashForLifecycle(_epicId, _lifecycleRunId) {
      return {
        hash: state.scopedBaselineHash ?? state.baselineHash,
        clean: state.scopedBaselineClean ?? state.baselineClean,
        dirty: state.scopedBaselineDirty ?? state.baselineDirty,
      };
    },
    findFirstTraceabilityGap(_epicId) { return state.traceGap; },
    areTasksReady(epicId, lifecycleRunId) {
      state.areTasksReadyCalls.push([epicId, lifecycleRunId]);
      return { ready: state.tasksReady, blockingTaskIds: state.blockingTaskIds };
    },
    readOwningLifecycleRunId(_processRunId) { return LIFECYCLE_RUN_ID; },
  };
}

function makeBundle(overrides = {}) {
  const partial = {
    schemaVersion: 'factory.solution-contract-certificate.v1',
    formalizationEpicId: 100,
    prdArtifactId: 1, frArtifactIds: [10], nfrArtifactIds: [11],
    ruleArtifactIds: [], ucArtifactIds: [20], acArtifactIds: [30, 31],
    acceptanceBaselineHash: 'b'.repeat(64),
    srsArtifactId: 40,
    ...overrides,
  };
  const bundleHash = createHash('sha256').update(canonicalJson(partial)).digest('hex');
  return { ...partial, bundleHash };
}

function makeInput(overrides = {}) {
  const { bundle: bundleOverrides = {}, ...inputOverrides } = overrides;
  return {
    schemaVersion: FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
    formalizationEpicId: 100,
    discoveryCertificateRef: 'certificate:5',
    discoveryCertificateHash: 'd'.repeat(64),
    bundle: makeBundle(bundleOverrides),
    ...inputOverrides,
  };
}

function expectedInputHash(input) {
  // The policy uses canonicalJson; replicate via the same module.
  // Simpler: just assert it's a 64-char hex string and stable across calls.
  return input;
}

// --- Tests (policy, no DB) --------------------------------------------------

test('policy returns formalized when the contract graph is complete', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph(), makeInput(), LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'formalized');
  assert.deepEqual(result.reasonCodes, []);
  assert.match(result.rationale, /complete, traceable, baseline-frozen/);
  assert.match(result.inputHash, /^[0-9a-f]{64}$/);
});

test('policy returns clarification-required when PRD is missing', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ prd: null }),
    makeInput({ bundle: { prdArtifactId: null } }),
    LIFECYCLE_RUN_ID,
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('prd-missing'));
});

test('policy returns clarification-required when no AC artifacts exist', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ acs: [] }),
    makeInput({ bundle: { acArtifactIds: [] } }),
    LIFECYCLE_RUN_ID,
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('acceptance-empty'));
});

test('policy returns clarification-required when SRS is missing', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ srs: null }),
    makeInput({ bundle: { srsArtifactId: null } }),
    LIFECYCLE_RUN_ID,
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('srs-missing'));
});

test('policy returns inconsistent when baseline is dirty', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    baselineClean: false, baselineDirty: [30],
  }), makeInput(), LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('baseline-missing'));
});

test('policy returns inconsistent when baseline hash in input disagrees with graph', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ bundle: { acceptanceBaselineHash: 'z'.repeat(64) } });
  const result = policy.settle(fakeGraph(), input, LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('baseline-missing'));
  assert.match(result.rationale, /Baseline hash mismatch/);
});

test('policy fails closed when bundle ids do not equal the canonical graph', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ bundle: { frArtifactIds: [10, 999] } });
  const result = policy.settle(fakeGraph(), input, LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'failed');
  assert.ok(result.reasonCodes.includes('infrastructure-error'));
  assert.match(result.rationale, /exact canonical graph snapshot/);
});

test('policy returns inconsistent when there is a traceability gap', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    traceGap: {
      artifactType: 'UC', artifactId: 20,
      missingEdge: 'covers → FR',
      description: 'UC #20 has no covers trace to any FR.',
    },
  }), makeInput(), LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('traceability-gap'));
});

test('policy returns inconsistent when formalization tasks are not ready', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    tasksReady: false, blockingTaskIds: [55, 56],
  }), makeInput(), LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('tasks-not-ready'));
  assert.match(result.rationale, /#55, #56/);
});

test('policy returns failed when the settlement input schema is wrong', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ schemaVersion: 'bogus' });
  const result = policy.settle(fakeGraph(), input, LIFECYCLE_RUN_ID);
  assert.equal(result.decision, 'failed');
  assert.ok(result.reasonCodes.includes('infrastructure-error'));
});

test('policy is deterministic: same inputs → same inputHash + decision', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const g = fakeGraph();
  const input = makeInput();
  const a = policy.settle(g, input, LIFECYCLE_RUN_ID);
  const b = policy.settle(g, input, LIFECYCLE_RUN_ID);
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.decision, b.decision);
  assert.deepEqual(a.reasonCodes, b.reasonCodes);
});

test('buildFormalizationCertificatePayload assembles the certificate envelope', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput();
  const result = policy.settle(fakeGraph(), input, LIFECYCLE_RUN_ID);
  const payload = buildFormalizationCertificatePayload(result, input.bundle, input);
  assert.equal(payload.decision, 'formalized');
  assert.equal(payload.discoveryCertificateRef, 'certificate:5');
  assert.equal(payload.bundleHash, input.bundle.bundleHash);
  assert.equal(payload.acceptanceBaselineHash, input.bundle.acceptanceBaselineHash);
  assert.equal(payload.schemaVersion, 'factory.solution-contract-certificate.generic.v1');
});

test('TB-11: policy threads the current lifecycle run id into the task gate', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const g = fakeGraph();
  policy.settle(g, makeInput(), 25);
  assert.deepEqual(g._state.areTasksReadyCalls, [[100, 25]]);
});

// --- SQLite graph port (TB-11 lifecycle scoping) -----------------------------
//
// Regression for the gate-poisoning bug: areTasksReady(epicId) used to join
// tasks to factory_workplaces across ALL lifecycle runs of the epic, so a
// workplace frozen by a DEAD previous run blocked the settlement of a NEW
// run. The gate must only see workplaces whose process_run_id belongs to a
// stage run of the CURRENT lifecycle run.

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);

function sqliteFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-formalization-settlement-'));
  process.env.DB_PATH = path.join(temp, 'settlement.db');
  const db = getDb();
  // factory_stage_runs is lazily created by the lifecycle-run repository —
  // constructing one ensures the ownership table exists in the temp DB.
  new SqliteLifecycleRunRepository(db);
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (100,1,'Formalization')`).run();
  return { temp, db };
}

function cleanupSqlite(fixture) {
  closeDb();
  rmSync(fixture.temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startProcessRun(db, idempotencyKey) {
  const repository = new SqliteProcessRunRepository(db);
  const { record } = repository.start({
    moduleRef: { name: 'solution-formalization', version: '1.0.0' },
    executorKind: 'generic-flow',
    input: {
      schema: 'factory.formalization-case.v1',
      payload: { formalizationEpicId: 100 },
      contentHash: createHash('sha256')
        .update(JSON.stringify({ formalizationEpicId: 100 }))
        .digest('hex'),
    },
    projectedStage: 'formalization',
    invocationContext: {
      projectId: 1,
      epicId: 100,
      initiatedBy: 'test',
      idempotencyKey,
    },
  });
  return record.id;
}

/** A lifecycle run over epic 100; status 'failed' emulates a DEAD run. */
function insertLifecycleRun(db, id, status) {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs (
       id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
       description, definition_snapshot, definition_hash, project_id, epic_id,
       initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
       entry_stage_id, status
     ) VALUES (?, 'product-delivery','1.0.0','product-delivery@1.0.0','Delivery','',
       '{}','${'f'.repeat(64)}',1,100,'test',?, 'factory.formalization-case.v1',
       '{}','${'e'.repeat(64)}','formalization',?)`,
  ).run(id, `idem-lr-${id}`, status);
}

function insertStageRun(db, lifecycleRunId, ordinal, processRunId) {
  db.prepare(
    `INSERT INTO factory_stage_runs (
       lifecycle_run_id, ordinal, stage_id, attempt, module_name, module_version,
       module_ref_key, binding_snapshot, binding_hash, input_schema, input_snapshot,
       input_hash, process_run_id, status
     ) VALUES (?,?, 'formalization',1,'solution-formalization','1.0.0',
       'solution-formalization@1.0.0','{}','${'b'.repeat(64)}',
       'factory.formalization-case.v1','{}','${'i'.repeat(64)}',?,'completed')`,
  ).run(lifecycleRunId, ordinal, processRunId);
}

function insertWorkplace(db, processRunId, workKey, loopState) {
  const workplaceRef = `workplace/${processRunId}/solution-formalization@1.0.0/${workKey}/singleton`;
  db.prepare(
    `INSERT INTO factory_workplaces (
       workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
       kanban_phase, loop_state, next_role, terminal_reason
     ) VALUES (?,?,?,?,?,?,?,?,'accepted')`,
  ).run(
    workplaceRef, processRunId, 'solution-formalization@1.0.0', workKey, workKey,
    loopState === 'terminal' ? 'done' : 'in_progress', loopState, 'author',
  );
  return workplaceRef;
}

function insertTask(db, workplaceRef, integrationState) {
  const info = db.prepare(
    `INSERT INTO tasks (
       epic_id, title, status, workplace_ref, task_kind, workflow_stage,
       execution_mode, integration_state
     ) VALUES (100, ?, 'done', ?, 'product', 'formalization', 'git_change', ?)`,
  ).run(`formalization task for ${workplaceRef}`, workplaceRef, integrationState);
  return Number(info.lastInsertRowid);
}

/**
 * The TB-11 canonical shape: one epic, two lifecycle runs.
 *   - DEAD run 2 (process run 1): workplace frozen in effect_pending, its task
 *     unmerged — exactly the poison that used to block the new run.
 *   - LIVE run 25 (process run 2): all workplaces terminal + merged.
 */
function twoLifecycleRunsFixture() {
  const fixture = sqliteFixture();
  insertLifecycleRun(fixture.db, 2, 'failed');
  const deadProcessRunId = startProcessRun(fixture.db, 'settlement-dead-run');
  insertStageRun(fixture.db, 2, 0, deadProcessRunId);
  const deadWorkplaceRef = insertWorkplace(fixture.db, deadProcessRunId, 'formalization-use-cases', 'effect_pending');
  insertTask(fixture.db, deadWorkplaceRef, 'pending');

  insertLifecycleRun(fixture.db, 25, 'running');
  const liveProcessRunId = startProcessRun(fixture.db, 'settlement-live-run');
  insertStageRun(fixture.db, 25, 0, liveProcessRunId);
  const liveWorkplaceRefs = [
    insertWorkplace(fixture.db, liveProcessRunId, 'formalization-use-cases', 'terminal'),
    insertWorkplace(fixture.db, liveProcessRunId, 'formalization-architecture', 'terminal'),
  ];
  const liveTaskIds = liveWorkplaceRefs.map(ref => insertTask(fixture.db, ref, 'merged'));
  return { fixture, deadProcessRunId, liveProcessRunId, liveTaskIds };
}

test('TB-11: gate ignores workplaces of a dead previous lifecycle run', () => {
  const { fixture, liveTaskIds } = twoLifecycleRunsFixture();
  try {
    const graph = new SqliteFormalizationArtifactGraph(fixture.db);
    const verdict = graph.areTasksReady(100, 25);
    assert.equal(verdict.ready, true);
    assert.deepEqual(verdict.blockingTaskIds, []);
    // Sanity: the dead run's task is still visible epic-wide — it must simply
    // not be gateable for the CURRENT run.
    const deadTasks = fixture.db.prepare(
      `SELECT COUNT(*) AS n FROM tasks t
         JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
        WHERE t.epic_id=100 AND t.workflow_stage='formalization'
          AND w.loop_state != 'terminal'`,
    ).get();
    assert.equal(deadTasks.n, 1);
    assert.equal(liveTaskIds.length, 2);
  } finally {
    cleanupSqlite(fixture);
  }
});

test('TB-11: gate blocks when the CURRENT lifecycle run workplace is non-terminal', () => {
  const { fixture, liveProcessRunId } = twoLifecycleRunsFixture();
  try {
    const stuckRef = insertWorkplace(fixture.db, liveProcessRunId, 'formalization-reconciliation', 'effect_pending');
    const stuckTaskId = insertTask(fixture.db, stuckRef, 'pending');
    const graph = new SqliteFormalizationArtifactGraph(fixture.db);
    const verdict = graph.areTasksReady(100, 25);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.blockingTaskIds, [stuckTaskId]);
  } finally {
    cleanupSqlite(fixture);
  }
});

test('TB-11: current run without formalization tasks fails closed with no blockers', () => {
  const { fixture } = twoLifecycleRunsFixture();
  try {
    fixture.db.prepare(`DELETE FROM tasks WHERE epic_id=100`).run();
    const graph = new SqliteFormalizationArtifactGraph(fixture.db);
    const verdict = graph.areTasksReady(100, 25);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.blockingTaskIds, []);
  } finally {
    cleanupSqlite(fixture);
  }
});

test('TB-11: readOwningLifecycleRunId resolves the exact lifecycle run of a process run', () => {
  const { fixture, deadProcessRunId, liveProcessRunId } = twoLifecycleRunsFixture();
  try {
    const graph = new SqliteFormalizationArtifactGraph(fixture.db);
    assert.equal(graph.readOwningLifecycleRunId(deadProcessRunId), 2);
    assert.equal(graph.readOwningLifecycleRunId(liveProcessRunId), 25);
    assert.equal(graph.readOwningLifecycleRunId(999999), null);
  } finally {
    cleanupSqlite(fixture);
  }
});

test('TB-11: end-to-end — settlement over the live run is formalized despite the dead-run poison', () => {
  const { fixture } = twoLifecycleRunsFixture();
  try {
    const graph = new SqliteFormalizationArtifactGraph(fixture.db);
    // Minimal accepted contract on the epic so the policy reaches the task gate.
    // Trace targets must exist as artifact rows: the edge check joins the
    // target artifact and asserts its type (brief root, NFR, ...).
    const artifact = (type, artifactId) => fixture.db.prepare(
      `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status,
         content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (?, 1, 100, ?, ?, ?, ?, 'accepted', '${'a'.repeat(64)}', '${'a'.repeat(64)}',
         'clean', '[]', '{}')`,
    ).run(artifactId, type, `${type}-${artifactId}`, `${type}-${artifactId}`, `docs/${type}-${artifactId}.md`);
    const trace = (sourceId, targetId, linkType) => fixture.db.prepare(
      `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type)
       VALUES (?, 'artifact', ?, ?)`,
    ).run(sourceId, targetId, linkType);
    artifact('brief', 50);
    artifact('PRD', 1);
    artifact('FR', 10);
    artifact('FR', 11);
    artifact('NFR', 12);
    artifact('UC', 20);
    artifact('AC', 30);
    artifact('AC', 31);
    artifact('SRS', 40);
    trace(1, 50, 'derived_from');        // PRD → brief
    trace(40, 1, 'derived_from');        // SRS → PRD
    trace(20, 1, 'derived_from');        // UC → PRD
    trace(20, 10, 'covers');             // UC → FR
    trace(30, 10, 'derived_from');       // AC → FR
    trace(30, 20, 'derived_from');       // AC → UC
    trace(31, 12, 'derived_from');       // AC → NFR

    const baselineHash = graph.readAcceptanceBaselineHash(100).hash;
    const bundleBody = {
      schemaVersion: 'factory.solution-contract-certificate.v1',
      formalizationEpicId: 100,
      prdArtifactId: 1,
      frArtifactIds: [10, 11],
      nfrArtifactIds: [12],
      ruleArtifactIds: [],
      ucArtifactIds: [20],
      acArtifactIds: [30, 31],
      acceptanceBaselineHash: baselineHash,
      srsArtifactId: 40,
    };
    const bundle = {
      ...bundleBody,
      bundleHash: createHash('sha256').update(canonicalJson(bundleBody)).digest('hex'),
    };
    const input = {
      schemaVersion: FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
      formalizationEpicId: 100,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      bundle,
    };
    const policy = new ReferenceFormalizationSettlementPolicy();
    const result = policy.settle(graph, input, 25);
    assert.equal(result.decision, 'formalized');
    // And the SAME epic under the dead run must NOT be ready (its own
    // effect_pending workplace blocks it) — scoping works in both directions.
    const deadVerdict = graph.areTasksReady(100, 2);
    assert.equal(deadVerdict.ready, false);
    assert.ok(deadVerdict.blockingTaskIds.length > 0);
  } finally {
    cleanupSqlite(fixture);
  }
});
