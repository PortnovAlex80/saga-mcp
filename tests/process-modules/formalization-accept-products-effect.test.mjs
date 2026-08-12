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
    presenterExecutionRef: 'worker-execution:test',
    contributingExecutionRefs: ['worker-execution:test'],
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
    { artifactId: 1, artifactType: 'PRD', artifactStatus: 'draft', contentHash: firstHash, operation: 'create', lastProducerExecutionRef: 'worker-execution:test' },
    { artifactId: 2, artifactType: 'FR', artifactStatus: 'draft', contentHash: secondHash, operation: 'create', lastProducerExecutionRef: 'worker-execution:test' },
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

test('authority projection fails atomically when any artifact drifted', () => {
  const fx = fixture({ driftSecond: true });
  try {
    assert.throws(
      () => fx.effect.run(fx.input),
      /FORMALIZATION_ACCEPTANCE_CONTENT_DRIFT: artifact 2/,
    );
    assert.deepEqual(
      fx.db.prepare('SELECT id,status,accepted_hash FROM artifacts ORDER BY id').all(),
      [
        { id: 1, status: 'draft', accepted_hash: null },
        { id: 2, status: 'draft', accepted_hash: null },
      ],
    );
  } finally {
    fx.db.close();
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
