// Workshop fix (б) — the settlement workset builder must match accepted
// implementation products to task-graph items by the KERNEL-AUTHORITATIVE
// key (cell_input_item.key from the accepted author task's metadata), not
// by the LM-authored payload.workItemKey. In the killed runs (units epic-8
// cert#37, tips epic-5 cert#40) the re-hired worker stamped the 24-hex
// workplace work_key into payload.workItemKey: the strict byKey matcher
// found no product for the item, emitted the synthetic placeholder
// (taskId:0 / accepted-cell-product-missing) and settlement failed. Legacy
// products whose author task carries no cell_input_item keep the old
// payload-key fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { SqliteDevelopmentModuleStore } = await import(
  '../../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js'
);
const { sha256Hex } = await import('../../../dist/shared/canonical-json.js');

const PROCESS_RUN_ID = 5;
const ITEM_KEY = 'item/core';
const WORK_KEY = 'f'.repeat(24);
const COMMIT = 'a'.repeat(40);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_workplaces (
      workplace_ref      TEXT PRIMARY KEY,
      process_run_id     INTEGER NOT NULL,
      production_cell_id TEXT NOT NULL,
      loop_state         TEXT NOT NULL,
      terminal_reason    TEXT NOT NULL
    );
    CREATE TABLE factory_cell_final_acceptances (
      workplace_ref     TEXT NOT NULL,
      candidate_set_ref TEXT NOT NULL,
      gate_decision_key TEXT NOT NULL
    );
    CREATE TABLE factory_accepted_authority_head (
      workplace_ref                      TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref  TEXT NOT NULL,
      accepted_author_task_id            TEXT
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref     TEXT NOT NULL,
      role              TEXT NOT NULL,
      subject_candidate_set_ref TEXT
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      product_schema    TEXT NOT NULL,
      product_ref       TEXT NOT NULL
    );
    CREATE TABLE factory_managed_node_submissions (
      id               INTEGER PRIMARY KEY,
      process_run_id   INTEGER NOT NULL,
      task_id          INTEGER NOT NULL,
      execution_id     TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash     TEXT NOT NULL
    );
    CREATE TABLE factory_gate_decisions (
      decision_key              TEXT,
      gate_run_ref              TEXT,
      subject_candidate_set_ref TEXT,
      gate_phase                TEXT,
      verdict                   TEXT,
      assessment_candidate_set_refs TEXT
    );
    CREATE TABLE tasks (
      id           INTEGER PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      metadata     TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * Seed one ACCEPTED development-implementation workplace whose product
 * declares `payloadKey` in payload.workItemKey while the factory-projected
 * author task metadata declares `metadataItemKey` in cell_input_item.key.
 */
function seedAcceptedProduct(db, { workplaceRef, submissionId, taskId, payloadKey, metadataItemKey }) {
  const candidateSetRef = `candidate-set/${PROCESS_RUN_ID}/development-implementation/${taskId}/author`;
  const workplaceMetadata = {
    role: 'author',
    work_key: WORK_KEY,
    ...(metadataItemKey === undefined
      ? {}
      : { cell_input_item: { key: metadataItemKey, changeScopes: ['src/'] } }),
  };
  const payload = {
    workItemKey: payloadKey,
    terminalStatus: 'complete',
    source: { branch: 'task/implement', commitSha: COMMIT, workItemKey: payloadKey },
    snapshot: { commitSha: COMMIT, treeSha: 'b'.repeat(40), files: [] },
    repository: { projectRepositoryId: 1, integrationBranch: 'main', baseCommit: 'c'.repeat(40), name: 'repo' },
    buildProducts: [],
    reasonCodes: [],
  };
  db.prepare(`INSERT INTO factory_workplaces VALUES (?,?,?,?,?)`).run(
    workplaceRef, PROCESS_RUN_ID, 'development-implementation', 'terminal', 'accepted',
  );
  db.prepare(`INSERT INTO factory_accepted_authority_head VALUES (?,?,?)`).run(
    workplaceRef, candidateSetRef, String(taskId),
  );
  db.prepare(`INSERT INTO factory_candidate_sets (candidate_set_ref,workplace_ref,role)
              VALUES (?,?,?)`).run(
    candidateSetRef, workplaceRef, 'author',
  );
  db.prepare(`INSERT INTO factory_candidate_set_members VALUES (?,?,?)`).run(
    candidateSetRef,
    'factory.development-implementation-result.v1',
    `managed-node-submission:${submissionId}`,
  );
  db.prepare(`INSERT INTO factory_managed_node_submissions
              (id,process_run_id,task_id,execution_id,payload_snapshot,content_hash)
              VALUES (?,?,?,?,?,?)`).run(
    submissionId, PROCESS_RUN_ID, taskId, `exec-${taskId}`,
    JSON.stringify(payload), sha256Hex(payload),
  );
  db.prepare(`INSERT INTO tasks VALUES (?,?,?)`).run(
    taskId, workplaceRef, JSON.stringify(workplaceMetadata),
  );
}

function buildWorkset(db) {
  // TypeScript `private` is not a JS authority boundary (same pattern as
  // development-read-switch.test.mjs): exercise the builder directly.
  const store = Object.create(SqliteDevelopmentModuleStore.prototype);
  store.db = db;
  return store.buildImplementationWorkset(PROCESS_RUN_ID, {
    implementationItems: [{ key: ITEM_KEY, required: true }],
  });
}

test('workset builder matches a mis-keyed product by cell_input_item.key, ignoring payload.workItemKey', () => {
  const db = makeDb();
  try {
    // The killed-runs shape: payload carries the workplace work_key while the
    // accepted author task carries the real task-graph item key.
    seedAcceptedProduct(db, {
      workplaceRef: 'workplace/5/development-implementation/item/core',
      submissionId: 41,
      taskId: 101,
      payloadKey: WORK_KEY,
      metadataItemKey: ITEM_KEY,
    });
    const workset = buildWorkset(db);
    assert.ok(workset, 'workset must be built');
    assert.equal(workset.results.length, 1);
    const result = workset.results[0];
    assert.equal(result.key, ITEM_KEY);
    assert.equal(result.status, 'succeeded',
      'kernel-authoritative metadata key must bind the product to the item');
    assert.equal(result.taskId, 101, 'the accepted author task id is the execution coordinate');
    assert.equal(result.reviewedSourceCommit, COMMIT);
    assert.equal(workset.complete, true);
    assert.deepEqual(workset.blockingItemKeys, []);
  } finally {
    db.close();
  }
});

test('workset builder legacy fallback: no cell_input_item metadata keeps payload-key matching', () => {
  const db = makeDb();
  try {
    // Old data: the author task metadata carries no cell_input_item, so the
    // payload key is the only available key.
    seedAcceptedProduct(db, {
      workplaceRef: 'workplace/5/development-implementation/item/core',
      submissionId: 42,
      taskId: 102,
      payloadKey: ITEM_KEY,
      metadataItemKey: undefined,
    });
    const workset = buildWorkset(db);
    assert.equal(workset.results[0].status, 'succeeded',
      'legacy products without cell_input_item still bind by payload key');
    assert.equal(workset.results[0].taskId, 102);
  } finally {
    db.close();
  }
});

test('workset builder still emits the typed placeholder when no accepted product binds', () => {
  const db = makeDb();
  try {
    // Nothing seeded: the item has no accepted product at all.
    const workset = buildWorkset(db);
    const result = workset.results[0];
    assert.equal(result.status, 'blocked');
    assert.equal(result.taskId, 0);
    assert.deepEqual(result.reasonCodes, ['accepted-cell-product-missing']);
    assert.equal(workset.complete, false);
    assert.deepEqual(workset.blockingItemKeys, [ITEM_KEY]);
  } finally {
    db.close();
  }
});
