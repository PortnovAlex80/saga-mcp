import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { createFormalizationAcceptProductsEffect } = await import(
  '../../dist/modules/formalization/application/formalization-accept-products-effect.js'
);
const { asWorkplaceRef, serializeWorkplaceRef } = await import(
  '../../dist/process-modules/domain/workplace/workplace-ref.js'
);

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
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL
    );
    CREATE TABLE factory_process_products (
      process_run_id INTEGER NOT NULL,
      node_id TEXT,
      schema_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      product_hash TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    );
    CREATE TABLE factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY,
      process_run_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL,
      content_hash TEXT
    );
  `);
  const workplaceRef = asWorkplaceRef({
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    productionCellId: 'formalization-product-contract',
    workKey: 'singleton',
  });
  const candidateSetRef = 'candidate-set:accepted';
  const presenterExecutionRef = 'execution:retry';
  const schema = 'factory.formalization-product-bundle.v1';
  const productRef = 'workplace:accepted-product';
  const digest = 'd'.repeat(64);
  const firstHash = '1'.repeat(64);
  const secondHash = '2'.repeat(64);
  const snapshot = {
    schemaVersion: 'factory.workplace-production-snapshot.v1',
    workplaceRef: serializeWorkplaceRef(workplaceRef),
    expectedSchemaRef: schema,
    presenterExecutionRef,
    contributingExecutionRefs: ['execution:first', presenterExecutionRef],
    artifacts: [
      {
        artifactId: 1,
        artifactType: 'PRD',
        artifactStatus: 'draft',
        contentHash: firstHash,
        operation: 'create',
        lastProducerExecutionRef: 'execution:first',
      },
      {
        artifactId: 2,
        artifactType: 'FR',
        artifactStatus: 'draft',
        contentHash: secondHash,
        operation: 'create',
        lastProducerExecutionRef: presenterExecutionRef,
      },
    ],
    traces: [],
  };
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    1, 'draft', firstHash, null, 'clean',
  );
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,NULL)').run(
    2, 'draft', driftSecond ? '9'.repeat(64) : secondHash, null, 'clean',
  );
  db.prepare('INSERT INTO factory_candidate_set_members VALUES (?,?,?,?,?)').run(
    candidateSetRef, 0, schema, productRef, digest,
  );
  db.prepare('INSERT INTO factory_process_products VALUES (?,?,?,?,?,?,?)').run(
    2, 'define-product-contract', schema, productRef, digest,
    JSON.stringify(snapshot), digest,
  );
  return {
    db,
    effect: createFormalizationAcceptProductsEffect(db),
    input: {
      workplaceRef,
      processRunId: 2,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      nodeId: 'define-product-contract',
      candidateSetRef,
      producerExecutionRef: presenterExecutionRef,
      expectedProductSchema: schema,
    },
  };
}

test('accepted Workplace snapshot projects artifacts contributed by recovered executions', () => {
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

test('accepted Workplace snapshot fails atomically when any artifact drifted', () => {
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

test('typed-submission acceptance keeps execution-scoped legacy projection', () => {
  const fx = fixture();
  try {
    fx.db.exec('DELETE FROM factory_process_products');
    fx.db.prepare(
      'INSERT INTO factory_managed_artifact_productions VALUES (?,?,?,?,?)',
    ).run(1, 2, 'execution:retry', 1, '1'.repeat(64));
    fx.effect.run(fx.input);
    assert.deepEqual(
      fx.db.prepare('SELECT id,status,accepted_hash FROM artifacts ORDER BY id').all(),
      [
        { id: 1, status: 'accepted', accepted_hash: '1'.repeat(64) },
        { id: 2, status: 'draft', accepted_hash: null },
      ],
    );
  } finally {
    fx.db.close();
  }
});
