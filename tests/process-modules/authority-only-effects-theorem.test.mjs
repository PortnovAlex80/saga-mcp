// tests/process-modules/authority-only-effects-theorem.test.mjs
//
// K11 — the legacy failure class, captured as a negative theorem: operational
// selectors (process / node / task / latest / execution) must NOT be able to
// change an effect's SUBJECT. The subject is exactly the sealed
// AcceptedCandidateAuthority — nothing else in the database moves.
//
// The legacy formalization acceptance selected "the task's accepted
// artifacts" / "latest artifact of type X" — under that selector a NEWER
// artifact row in the same task (or a same-schema artifact from another
// node, or an equal-content row elsewhere) would silently become the
// accepted subject. This test seeds exactly those decoys and proves the
// authority-only effect leaves every one of them untouched while accepting
// ONLY the snapshot-listed artifact ids at their sealed hashes.
//
// Fixture mirrors formalization-accept-products-effect.test.mjs (the
// authority persistence chain: revision → candidate set → members → accepted
// final gate decision → applied decision head → sealed product material).

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createFormalizationAcceptProductsEffect } from '../../dist/modules/formalization/application/formalization-accept-products-effect.js';
import { computeAcceptanceDigest } from '../../dist/process-modules/application/post-acceptance-effects.js';
import { WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION } from '../../dist/process-modules/shared/workplace-production-snapshot.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const BUNDLE_SCHEMA = 'factory.formalization-product-bundle.v1';
const REPORT_SCHEMA = 'factory.formalization-reconciliation-report.v1';
const workplaceRef = {
  processRunId: 1,
  moduleRef: 'solution-formalization@1.0.0',
  productionCellId: 'define-product-contract',
  workKey: 'default',
};
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

function seedAuthority(db, payload) {
  const digest = sha256Hex(payload);
  const productRef = { schemaId: BUNDLE_SCHEMA, ref: 'product:snapshot', digest };
  db.prepare('INSERT INTO factory_workplace_production_revisions VALUES (?,?)')
    .run('revision:test', workplaceKey);
  db.prepare('INSERT INTO factory_candidate_sets VALUES (?,?,?)')
    .run('candidate-set:test', workplaceKey, 'revision:test');
  db.prepare('INSERT INTO factory_candidate_set_members VALUES (?,0,?,?,?)')
    .run('candidate-set:test', BUNDLE_SCHEMA, 'product:snapshot', digest);
  db.prepare('INSERT INTO factory_gate_decisions VALUES (?,?,?,?,?)')
    .run('decision:test', workplaceKey, 'candidate-set:test', 'final', 'accepted');
  db.prepare('INSERT INTO factory_workplace_gate_decision_heads VALUES (?,?)')
    .run(workplaceKey, 'decision:test');
  new SqliteSealedProductMaterialRepository(db).seal({ productRef, payload });
  const authority = {
    workplaceRef,
    candidateSetRef: 'candidate-set:test',
    productionRevisionRef: 'revision:test',
    acceptedProductRefs: [productRef],
    productSchema: BUNDLE_SCHEMA,
    gateDecisionKey: 'decision:test',
    productContractRef: null,
  };
  authority.acceptanceDigest = computeAcceptanceDigest(authority);
  return authority;
}

function effect(db) {
  const sealed = new SqliteSealedProductMaterialRepository(db);
  return createFormalizationAcceptProductsEffect(db, {
    assertPersisted(authority) {
      const candidate = db.prepare(
        'SELECT workplace_ref FROM factory_candidate_sets WHERE candidate_set_ref=?',
      ).get(authority.candidateSetRef);
      const decision = db.prepare(
        'SELECT verdict FROM factory_gate_decisions WHERE decision_key=?',
      ).get(authority.gateDecisionKey);
      const head = db.prepare(
        'SELECT decision_key FROM factory_workplace_gate_decision_heads WHERE workplace_ref=?',
      ).get(workplaceKey);
      if (!candidate || !decision || decision.verdict !== 'accepted'
        || !head || head.decision_key !== authority.gateDecisionKey) {
        throw new Error('AUTHORITY_PERSISTENCE_CHECK_FAILED');
      }
    },
    readSealedProduct: ref => sealed.readExact(ref),
  });
}

test('K11/theorem: operational decoys cannot change the effect subject', () => {
  const db = database();

  // The SEALED authority material: one artifact (id 1) at hash hA.
  const hA = sha256Hex({ artifact: 'A' });
  const payload = {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: workplaceKey,
    expectedSchemaRef: BUNDLE_SCHEMA,
    artifacts: [{ artifactId: 1, contentHash: hA }],
    traces: [],
  };
  const authority = seedAuthority(db, payload);

  // The SUBJECT row.
  db.prepare(
    `INSERT INTO artifacts (id,status,content_hash,accepted_hash,drift_state)
     VALUES (1,'done',?,NULL,'clean')`,
  ).run(hA);

  // DECOYS — every row a legacy operational selector WOULD have caught:
  const hNewer = sha256Hex({ artifact: 'NEWER-SAME-TASK' });
  const hOtherNode = sha256Hex({ artifact: 'OTHER-NODE-SAME-SCHEMA' });
  db.prepare(
    `INSERT INTO artifacts (id,status,content_hash,accepted_hash,drift_state)
     VALUES (2,'done',?,NULL,'clean'),   -- newer row, same task/epic (latest-wins bait)
            (3,'done',?,NULL,'clean'),   -- same schema family, different node
            (4,'done',?  ,NULL,'clean')  -- EQUAL CONTENT to the subject, different row`,
  ).run(hNewer, hOtherNode, hA);

  const result = effect(db).run({ authority });
  assert.ok(!result, 'the authority-aligned subject succeeds (no typed outcome)');

  const rows = db.prepare(
    'SELECT id,status,accepted_hash,drift_state FROM artifacts ORDER BY id',
  ).all();
  assert.deepEqual(
    rows.map(r => [r.id, r.status, r.accepted_hash, r.drift_state]),
    [
      [1, 'accepted', hA, 'clean'], // the subject: accepted at the SEALED hash
      [2, 'done', null, 'clean'],   // newer-same-task decoy: untouched
      [3, 'done', null, 'clean'],   // other-node decoy: untouched
      [4, 'done', null, 'clean'],   // equal-content decoy: untouched — the
                                    // authority binds exact ids, not hashes
    ],
    'the effect moved EXACTLY the snapshot-listed artifact at its sealed hash',
  );
});

test('K11/theorem: a drifted subject row yields repair, never a decoy substitution', () => {
  const db = database();
  const hA = sha256Hex({ artifact: 'A' });
  const payload = {
    schemaVersion: WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION,
    workplaceRef: workplaceKey,
    expectedSchemaRef: BUNDLE_SCHEMA,
    artifacts: [{ artifactId: 1, contentHash: hA }],
    traces: [],
  };
  const authority = seedAuthority(db, payload);

  // The subject row DRIFTED (content hash no longer matches the seal)...
  db.prepare(
    `INSERT INTO artifacts (id,status,content_hash,accepted_hash,drift_state)
     VALUES (1,'done','drifted-hash',NULL,'clean')`,
  ).run();
  // ...and a perfect decoy exists elsewhere with the sealed hash: a
  // hash-scanning fallback would silently accept it instead.
  db.prepare(
    `INSERT INTO artifacts (id,status,content_hash,accepted_hash,drift_state)
     VALUES (9,'done',?,NULL,'clean')`,
  ).run(hA);

  const result = effect(db).run({ authority });
  assert.equal(result.outcome, 'repair_required',
    'a drifted subject routes to typed repair — never to a nearby row');
  assert.match(result.reason, /HASH_DRIFT/u);
  const rows = db.prepare(
    'SELECT id,status,accepted_hash FROM artifacts ORDER BY id',
  ).all();
  assert.deepEqual(
    rows.map(r => [r.id, r.status, r.accepted_hash]),
    [[1, 'done', null], [9, 'done', null]],
    'no row was accepted: the decoy with the right hash stayed untouched',
  );
});

test('K11/theorem: typed-report material is a no-op subject (nothing moves)', () => {
  const db = database();
  const reportPayload = { schemaVersion: REPORT_SCHEMA };
  const digest = sha256Hex(reportPayload);
  const productRef = { schemaId: REPORT_SCHEMA, ref: 'product:report', digest };
  db.prepare('INSERT INTO factory_workplace_production_revisions VALUES (?,?)')
    .run('revision:r', workplaceKey);
  db.prepare('INSERT INTO factory_candidate_sets VALUES (?,?,?)')
    .run('candidate-set:r', workplaceKey, 'revision:r');
  db.prepare('INSERT INTO factory_candidate_set_members VALUES (?,0,?,?,?)')
    .run('candidate-set:r', REPORT_SCHEMA, 'product:report', digest);
  db.prepare('INSERT INTO factory_gate_decisions VALUES (?,?,?,?,?)')
    .run('decision:r', workplaceKey, 'candidate-set:r', 'final', 'accepted');
  db.prepare('INSERT INTO factory_workplace_gate_decision_heads VALUES (?,?)')
    .run(workplaceKey, 'decision:r');
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef,
    payload: reportPayload,
  });
  const authority = {
    workplaceRef,
    candidateSetRef: 'candidate-set:r',
    productionRevisionRef: 'revision:r',
    acceptedProductRefs: [productRef],
    productSchema: REPORT_SCHEMA,
    gateDecisionKey: 'decision:r',
    productContractRef: null,
  };
  authority.acceptanceDigest = computeAcceptanceDigest(authority);

  const result = effect(db).run({ authority });
  assert.ok(!result, 'typed reports carry no artifact projection');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n,
    0,
    'no artifact row exists or moves for typed-report material',
  );
});
