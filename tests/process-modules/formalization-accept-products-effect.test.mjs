import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { createFormalizationAcceptProductsEffect } = await import(
  '../../dist/modules/formalization/application/formalization-accept-products-effect.js'
);
const { sha256Hex, canonicalJson } = await import(
  '../../dist/shared/canonical-json.js'
);
const { WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION } = await import(
  '../../dist/process-modules/shared/workplace-production-snapshot.js'
);

// ADR-053 / conveyor-v4.3 — accepted products are immutable Workplace
// production snapshots persisted in factory_process_products. The formalization
// effect resolves the produced artifact rows by reading the pinned snapshot
// payload (not by parsing the product ref). The product ref is
// `workplace:<module>:<node>:<snapshotHash>`.
const BUNDLE_SCHEMA = 'factory.formalization-product-bundle.v1';
const MODULE_REF = 'solution-formalization@1.0.0';
const NODE_ID = 'define-product-contract';

function buildSnapshot(artifacts) {
  return {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: `workplace:${MODULE_REF}:${NODE_ID}`,
    expectedSchemaRef: BUNDLE_SCHEMA,
    artifacts,
    traces: [],
  };
}

function fixture({ driftSecond = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      content_hash TEXT,
      accepted_hash TEXT,
      drift_state TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE factory_process_products (
      id INTEGER PRIMARY KEY,
      process_run_id INTEGER NOT NULL,
      product_kind TEXT NOT NULL,
      product_key TEXT NOT NULL,
      schema_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      product_hash TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      node_id TEXT
    );
  `);
  const firstHash = '1'.repeat(64);
  const secondHash = '2'.repeat(64);
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    1, 'draft', firstHash, null, 'clean',
  );
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    2, 'draft', driftSecond ? '9'.repeat(64) : secondHash, null, 'clean',
  );

  // Build the Workplace production snapshot carrying both artifact ids.
  const snapshot = buildSnapshot([
    { artifactId: 1, artifactType: 'PRD', artifactStatus: 'draft', contentHash: firstHash, operation: 'create' },
    { artifactId: 2, artifactType: 'FR', artifactStatus: 'draft', contentHash: secondHash, operation: 'create' },
  ]);
  const contentHash = sha256Hex(snapshot);
  const payloadSnapshot = canonicalJson(snapshot);
  const artifactRef = `workplace:${MODULE_REF}:${NODE_ID}:${contentHash}`;
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, product_key, schema_id, artifact_ref,
        product_hash, payload_snapshot, payload_hash, node_id)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    BUNDLE_SCHEMA, artifactRef, BUNDLE_SCHEMA, artifactRef,
    contentHash, payloadSnapshot, contentHash, NODE_ID,
  );

  const effect = createFormalizationAcceptProductsEffect(db);
  const input = {
    authority: {
      acceptedProductRefs: [
        { schemaId: BUNDLE_SCHEMA, ref: artifactRef, digest: contentHash },
      ],
    },
  };
  return { db, effect, input };
}

test('snapshot payload projects artifacts (B-4: ref points at pinned snapshot)', () => {
  const fx = fixture();
  try {
    fx.effect.run(fx.input);
    assert.deepEqual(
      fx.db.prepare('SELECT id,status,accepted_hash,content_hash FROM artifacts ORDER BY id').all(),
      [
        { id: 1, status: 'accepted', accepted_hash: '1'.repeat(64), content_hash: '1'.repeat(64) },
        { id: 2, status: 'accepted', accepted_hash: '2'.repeat(64), content_hash: '2'.repeat(64) },
      ],
    );
  } finally {
    fx.db.close();
  }
});

test('accepts by table content_hash even when the snapshot hash differs (benign whole-file drift)', () => {
  // driftSecond: the artifacts row for id=2 carries content_hash '9'*64, while
  // the pinned snapshot says '2'*64. With artifactDiskHash hashing the whole
  // file (anchor stripped), shared-file anchors legitimately evolve together,
  // so the effect accepts the artifact's CURRENT table hash, not the snapshot's.
  const fx = fixture({ driftSecond: true });
  try {
    fx.effect.run(fx.input);
    assert.deepEqual(
      fx.db.prepare('SELECT id,status,accepted_hash,content_hash FROM artifacts ORDER BY id').all(),
      [
        { id: 1, status: 'accepted', accepted_hash: '1'.repeat(64), content_hash: '1'.repeat(64) },
        { id: 2, status: 'accepted', accepted_hash: '9'.repeat(64), content_hash: '9'.repeat(64) },
      ],
    );
  } finally {
    fx.db.close();
  }
});

test('fails closed when an artifact row has no content_hash', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, content_hash TEXT, accepted_hash TEXT, drift_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE factory_process_products (id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL, product_kind TEXT NOT NULL, product_key TEXT NOT NULL, schema_id TEXT NOT NULL, artifact_ref TEXT NOT NULL, product_hash TEXT NOT NULL, payload_snapshot TEXT NOT NULL, payload_hash TEXT NOT NULL, node_id TEXT);
  `);
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(1, 'draft', null, null, 'clean');
  const snapshot = buildSnapshot([{ artifactId: 1, artifactType: 'PRD', artifactStatus: 'draft', contentHash: 'c'.repeat(64), operation: 'create' }]);
  const contentHash = sha256Hex(snapshot);
  const payloadSnapshot = canonicalJson(snapshot);
  const artifactRef = `workplace:${MODULE_REF}:${NODE_ID}:${contentHash}`;
  db.prepare(`INSERT INTO factory_process_products (process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash, payload_snapshot, payload_hash, node_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(BUNDLE_SCHEMA, artifactRef, BUNDLE_SCHEMA, artifactRef, contentHash, payloadSnapshot, contentHash, NODE_ID);
  const effect = createFormalizationAcceptProductsEffect(db);
  try {
    assert.throws(
      () => effect.run({ authority: { acceptedProductRefs: [{ schemaId: BUNDLE_SCHEMA, ref: artifactRef, digest: contentHash }] } }),
      /FORMALIZATION_ACCEPTANCE_HASH_MISSING: artifact 1/,
    );
  } finally {
    db.close();
  }
});

test('effect fails closed when the pinned product row is missing', () => {
  const fx = fixture();
  try {
    const missingInput = {
      authority: {
        acceptedProductRefs: [
          { schemaId: BUNDLE_SCHEMA, ref: 'workplace:missing:node:' + 'a'.repeat(64), digest: 'a'.repeat(64) },
        ],
      },
    };
    assert.throws(
      () => fx.effect.run(missingInput),
      /FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_FOUND/,
    );
  } finally {
    fx.db.close();
  }
});

test('effect fails closed when the pinned payload is not a workplace snapshot', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, content_hash TEXT, accepted_hash TEXT, drift_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE factory_process_products (id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL, product_kind TEXT NOT NULL, product_key TEXT NOT NULL, schema_id TEXT NOT NULL, artifact_ref TEXT NOT NULL, product_hash TEXT NOT NULL, payload_snapshot TEXT NOT NULL, payload_hash TEXT NOT NULL, node_id TEXT);
  `);
  const notSnapshot = JSON.stringify({ hello: 'world' });
  const contentHash = sha256Hex({ hello: 'world' });
  const artifactRef = `workplace:${MODULE_REF}:${NODE_ID}:${contentHash}`;
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash, payload_snapshot, payload_hash, node_id)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(BUNDLE_SCHEMA, artifactRef, BUNDLE_SCHEMA, artifactRef, contentHash, notSnapshot, contentHash, NODE_ID);
  const effect = createFormalizationAcceptProductsEffect(db);
  try {
    assert.throws(
      () => effect.run({
        authority: {
          acceptedProductRefs: [{ schemaId: BUNDLE_SCHEMA, ref: artifactRef, digest: contentHash }],
        },
      }),
      /FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_SNAPSHOT/,
    );
  } finally {
    db.close();
  }
});

test('typed-submission report (reconciliation) is skipped — no artifacts touched', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, content_hash TEXT, accepted_hash TEXT, drift_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL, module_ref TEXT NOT NULL, node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL, task_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      schema_version TEXT NOT NULL, payload_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL, submitted_at TEXT NOT NULL
    );
  `);
  // A draft artifact that must NOT be accepted (the report carries no artifacts).
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(1, 'draft', 'a'.repeat(64), null, 'clean');
  // A reconciliation report payload — NOT a Workplace production snapshot.
  const reportPayload = JSON.stringify({
    schemaVersion: 'factory.formalization-reconciliation-report.v1',
    reconciledGaps: [],
    noOp: true,
  });
  const reportHash = sha256Hex({ report: true });
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, schema_version, payload_snapshot, content_hash, submitted_at)
     VALUES (1, ?, 'formalization-reconciliation', 1, 9, 'worker-execution:test', ?, ?, ?, datetime('now'))`,
  ).run(MODULE_REF, 'factory.formalization-reconciliation-report.v1', reportPayload, reportHash);
  const effect = createFormalizationAcceptProductsEffect(db);
  try {
    // Must not throw, must not touch the artifact.
    effect.run({
      authority: {
        acceptedProductRefs: [
          { schemaId: 'factory.formalization-reconciliation-report.v1', ref: 'managed-node-submission:1', digest: reportHash },
        ],
      },
    });
    const row = db.prepare('SELECT status,accepted_hash FROM artifacts WHERE id=1').get();
    assert.equal(row.status, 'draft');
    assert.equal(row.accepted_hash, null);
  } finally {
    db.close();
  }
});

test('typed-submission with a missing pinned row fails closed', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY, status TEXT NOT NULL, content_hash TEXT, accepted_hash TEXT, drift_state TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE factory_managed_node_submissions (id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL, module_ref TEXT NOT NULL, node_id TEXT NOT NULL, intent_id INTEGER NOT NULL, task_id INTEGER NOT NULL, execution_id TEXT NOT NULL, schema_version TEXT NOT NULL, payload_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL, submitted_at TEXT NOT NULL);
  `);
  const effect = createFormalizationAcceptProductsEffect(db);
  try {
    assert.throws(
      () => effect.run({
        authority: {
          acceptedProductRefs: [
            { schemaId: 'factory.formalization-reconciliation-report.v1', ref: 'managed-node-submission:999', digest: 'b'.repeat(64) },
          ],
        },
      }),
      /FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_FOUND/,
    );
  } finally {
    db.close();
  }
});
