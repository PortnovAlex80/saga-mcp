import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createFormalizationAcceptProductsEffect } from '../../dist/modules/formalization/application/formalization-accept-products-effect.js';
import { computeAcceptanceDigest } from '../../dist/process-modules/application/post-acceptance-effects.js';
import { WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION } from '../../dist/process-modules/shared/workplace-production-snapshot.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';

const BUNDLE_SCHEMA = 'factory.formalization-product-bundle.v1';
const REPORT_SCHEMA = 'factory.formalization-reconciliation-report.v1';
const workplaceRef = { processRunId: 1, moduleRef: 'solution-formalization@1.0.0', productionCellId: 'define-product-contract', workKey: 'default' };
const workplaceKey = 'workplace/1/solution-formalization@1.0.0/define-product-contract/default';

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY,status TEXT NOT NULL,content_hash TEXT,accepted_hash TEXT,drift_state TEXT NOT NULL,updated_at TEXT);
    CREATE TABLE factory_workplace_production_revisions (revision_ref TEXT PRIMARY KEY,workplace_ref TEXT NOT NULL);
    CREATE TABLE factory_candidate_sets (candidate_set_ref TEXT PRIMARY KEY,workplace_ref TEXT NOT NULL,production_revision_ref TEXT NOT NULL);
    CREATE TABLE factory_candidate_set_members (candidate_set_ref TEXT NOT NULL,ordinal INTEGER NOT NULL,product_schema TEXT NOT NULL,product_ref TEXT NOT NULL,product_digest TEXT NOT NULL,PRIMARY KEY(candidate_set_ref,ordinal));
    CREATE TABLE factory_gate_decisions (decision_key TEXT PRIMARY KEY,workplace_ref TEXT NOT NULL,subject_candidate_set_ref TEXT NOT NULL,gate_phase TEXT NOT NULL,verdict TEXT NOT NULL);
    CREATE TABLE factory_workplace_gate_decision_heads (workplace_ref TEXT PRIMARY KEY,decision_key TEXT NOT NULL);
    CREATE TABLE factory_sealed_product_materials (schema_id TEXT NOT NULL,content_digest TEXT NOT NULL,payload_snapshot TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(schema_id,content_digest));
    CREATE TABLE factory_sealed_product_aliases (product_ref TEXT NOT NULL,schema_id TEXT NOT NULL,content_digest TEXT NOT NULL,PRIMARY KEY(product_ref,schema_id,content_digest),UNIQUE(product_ref,schema_id));
  `);
  return db;
}

function seedAuthority(db, { schemaId = BUNDLE_SCHEMA, ref = 'product:snapshot', payload, seal = true } = {}) {
  const digest = sha256Hex(payload);
  const productRef = { schemaId, ref, digest };
  const revision = 'revision:test';
  const candidate = 'candidate-set:test';
  const decision = 'decision:test';
  db.prepare('INSERT INTO factory_workplace_production_revisions VALUES (?,?)').run(revision, workplaceKey);
  db.prepare('INSERT INTO factory_candidate_sets VALUES (?,?,?)').run(candidate, workplaceKey, revision);
  db.prepare('INSERT INTO factory_candidate_set_members VALUES (?,0,?,?,?)').run(candidate, schemaId, ref, digest);
  db.prepare('INSERT INTO factory_gate_decisions VALUES (?,?,?,?,?)').run(decision, workplaceKey, candidate, 'final', 'accepted');
  db.prepare('INSERT INTO factory_workplace_gate_decision_heads VALUES (?,?)').run(workplaceKey, decision);
  if (seal) new SqliteSealedProductMaterialRepository(db).seal({ productRef, payload });
  const authority = {
    workplaceRef, candidateSetRef: candidate, productionRevisionRef: revision,
    acceptedProductRefs: [productRef], productSchema: schemaId,
    gateDecisionKey: decision, productContractRef: null,
  };
  authority.acceptanceDigest = computeAcceptanceDigest(authority);
  return { authority };
}

function snapshot(artifacts) {
  return {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: workplaceKey,
    expectedSchemaRef: BUNDLE_SCHEMA,
    artifacts,
    traces: [],
  };
}

function effect(db) {
  const sealed = new SqliteSealedProductMaterialRepository(db);
  return createFormalizationAcceptProductsEffect(db, {
    assertPersisted(authority) {
      const candidate = db.prepare('SELECT workplace_ref,production_revision_ref FROM factory_candidate_sets WHERE candidate_set_ref=?').get(authority.candidateSetRef);
      if (!candidate || candidate.workplace_ref !== workplaceKey || candidate.production_revision_ref !== authority.productionRevisionRef) throw new Error('AUTHORITY_CANDIDATE_REVISION_MISMATCH');
      const decision = db.prepare('SELECT workplace_ref,subject_candidate_set_ref,gate_phase,verdict FROM factory_gate_decisions WHERE decision_key=?').get(authority.gateDecisionKey);
      if (!decision || decision.workplace_ref !== workplaceKey || decision.subject_candidate_set_ref !== authority.candidateSetRef || decision.gate_phase !== 'final' || decision.verdict !== 'accepted') throw new Error('AUTHORITY_GATE_DECISION_MISMATCH');
      const head = db.prepare('SELECT decision_key FROM factory_workplace_gate_decision_heads WHERE workplace_ref=?').get(workplaceKey);
      if (!head || head.decision_key !== authority.gateDecisionKey) throw new Error('AUTHORITY_APPLIED_GATE_HEAD_MISMATCH');
      const members = db.prepare('SELECT product_schema AS schemaId,product_ref AS ref,product_digest AS digest FROM factory_candidate_set_members WHERE candidate_set_ref=? ORDER BY ordinal').all(authority.candidateSetRef);
      assert.deepEqual(members, authority.acceptedProductRefs);
    },
    readSealedProduct: ref => sealed.readExact(ref),
  });
}

test('accepts exactly the artifacts in sealed accepted material', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO artifacts VALUES (1,\'draft\',?,?,\'clean\',NULL)').run('1'.repeat(64), null);
    db.prepare('INSERT INTO artifacts VALUES (2,\'draft\',?,?,\'clean\',NULL)').run('2'.repeat(64), null);
    const input = seedAuthority(db, { payload: snapshot([
      { artifactId: 1, contentHash: '1'.repeat(64) },
      { artifactId: 2, contentHash: '2'.repeat(64) },
    ]) });
    effect(db).run(input);
    assert.deepEqual(db.prepare('SELECT id,status,accepted_hash FROM artifacts ORDER BY id').all(), [
      { id: 1, status: 'accepted', accepted_hash: '1'.repeat(64) },
      { id: 2, status: 'accepted', accepted_hash: '2'.repeat(64) },
    ]);
  } finally { db.close(); }
});

test('rejects mutable artifact drift and performs no partial mutation', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO artifacts VALUES (1,\'draft\',?,?,\'clean\',NULL)').run('1'.repeat(64), null);
    db.prepare('INSERT INTO artifacts VALUES (2,\'draft\',?,?,\'clean\',NULL)').run('9'.repeat(64), null);
    const input = seedAuthority(db, { payload: snapshot([
      { artifactId: 1, contentHash: '1'.repeat(64) },
      { artifactId: 2, contentHash: '2'.repeat(64) },
    ]) });
    assert.throws(() => effect(db).run(input), /HASH_DRIFT: artifact 2/);
    assert.equal(db.prepare('SELECT status FROM artifacts WHERE id=1').get().status, 'draft');
  } finally { db.close(); }
});

test('missing exact sealed alias fails closed', () => {
  const db = database();
  try {
    const input = seedAuthority(db, { payload: snapshot([]), seal: false });
    assert.throws(() => effect(db).run(input), /SEALED_PRODUCT_NOT_FOUND/);
  } finally { db.close(); }
});

test('self-consistent but nonexistent authority cannot mutate artifacts', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO artifacts VALUES (1,\'draft\',?,?,\'clean\',NULL)').run('1'.repeat(64), null);
    const payload = snapshot([{ artifactId: 1, contentHash: '1'.repeat(64) }]);
    const productRef = { schemaId: BUNDLE_SCHEMA, ref: 'forged:product', digest: sha256Hex(payload) };
    new SqliteSealedProductMaterialRepository(db).seal({ productRef, payload });
    const authority = { workplaceRef, candidateSetRef: 'candidate-set:missing', productionRevisionRef: 'revision:missing', acceptedProductRefs: [productRef], productSchema: BUNDLE_SCHEMA, gateDecisionKey: 'decision:missing', productContractRef: null };
    authority.acceptanceDigest = computeAcceptanceDigest(authority);
    assert.throws(() => effect(db).run({ authority }), /AUTHORITY_CANDIDATE_REVISION_MISMATCH/);
    assert.equal(db.prepare('SELECT status FROM artifacts WHERE id=1').get().status, 'draft');
  } finally { db.close(); }
});

test('typed reconciliation material is a no-op', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO artifacts VALUES (1,\'draft\',?,?,\'clean\',NULL)').run('a'.repeat(64), null);
    const input = seedAuthority(db, { schemaId: REPORT_SCHEMA, ref: 'report:1', payload: { schemaVersion: REPORT_SCHEMA, reconciledGaps: [], noOp: true } });
    effect(db).run(input);
    assert.equal(db.prepare('SELECT status FROM artifacts WHERE id=1').get().status, 'draft');
  } finally { db.close(); }
});

test('same semantic payload under different aliases has equivalent effect semantics', () => {
  const payload = { schemaVersion: REPORT_SCHEMA, reconciledGaps: [], noOp: true };
  for (const ref of ['managed-node-submission:1', 'process-product:1']) {
    const db = database();
    try {
      db.prepare('INSERT INTO artifacts VALUES (1,\'draft\',?,?,\'clean\',NULL)').run('a'.repeat(64), null);
      const input = seedAuthority(db, { schemaId: REPORT_SCHEMA, ref, payload: JSON.parse(canonicalJson(payload)) });
      assert.doesNotThrow(() => effect(db).run(input));
      assert.equal(db.prepare('SELECT status FROM artifacts WHERE id=1').get().status, 'draft');
    } finally { db.close(); }
  }
});
