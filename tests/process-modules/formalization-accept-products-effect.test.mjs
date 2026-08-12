import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { createFormalizationAcceptProductsEffect } = await import(
  '../../dist/modules/formalization/application/formalization-accept-products-effect.js'
);

// ADR-053 B-4/B-5 — the formalization effect consumes ONLY authority.acceptedProductRefs.
// Each product's ref is `artifact:<id>` and digest is the content hash. No
// factory_process_products join, no payload_snapshot, no processRunId/nodeId/schema.
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
  `);
  const firstHash = '1'.repeat(64);
  const secondHash = '2'.repeat(64);
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    1, 'draft', firstHash, null, 'clean',
  );
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    2, 'draft', driftSecond ? '9'.repeat(64) : secondHash, null, 'clean',
  );
  const effect = createFormalizationAcceptProductsEffect(db);
  const input = {
    authority: {
      acceptedProductRefs: [
        { schemaId: 'factory.formalization-product-bundle.v1', ref: 'artifact:1', digest: firstHash },
        { schemaId: 'factory.formalization-product-bundle.v1', ref: 'artifact:2', digest: secondHash },
      ],
    },
  };
  return { db, effect, input };
}

test('authority.acceptedProductRefs projects artifacts (B-4: no execution join)', () => {
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

test('authority rejects a product ref that is not an artifact reference', () => {
  const fx = fixture();
  try {
    const badInput = {
      authority: {
        acceptedProductRefs: [
          { schemaId: 's', ref: 'not-an-artifact-ref', digest: '1'.repeat(64) },
        ],
      },
    };
    assert.throws(
      () => fx.effect.run(badInput),
      /FORMALIZATION_ACCEPTANCE_PRODUCT_REF_INVALID/,
    );
  } finally {
    fx.db.close();
  }
});
