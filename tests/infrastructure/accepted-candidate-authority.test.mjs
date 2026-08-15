import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { assertPersistedAcceptedCandidateAuthority } from '../../dist/infrastructure/workplace/sqlite-accepted-candidate-authority.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { computeAcceptanceDigest } from '../../dist/process-modules/application/post-acceptance-effects.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const ref = { processRunId: 7, moduleRef: 'module@1', productionCellId: 'cell', workKey: 'item' };
const workplace = 'workplace/7/module@1/cell/item';

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.pragma('foreign_keys=OFF');
  const payload = { exact: 'material' };
  const product = { schemaId: 'schema/with/slash', ref: 'submission:17', digest: sha256Hex(payload) };
  db.prepare(`INSERT INTO factory_workplace_production_revisions
    (revision_ref,workplace_ref,parent_revision_ref,members,contributing_execution_refs,presenter_ref,
     material_digest,semantic_digest,sealed_at)
    VALUES ('revision:7',?,NULL,'[]','[]','exec:a','${'a'.repeat(64)}','${'b'.repeat(64)}',datetime('now'))`).run(workplace);
  db.prepare(`INSERT INTO factory_candidate_sets
    (candidate_set_ref,workplace_ref,production_revision_ref,role,candidate_set_digest,seal_receipt_ref,sealed_at)
    VALUES ('candidate:7',?,'revision:7','author','${'c'.repeat(64)}','seal:7',datetime('now'))`).run(workplace);
  db.prepare(`INSERT INTO factory_candidate_set_members
    (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
    VALUES ('candidate:7',0,?,?,?,'produced')`).run(product.schemaId, product.ref, product.digest);
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,subject_candidate_set_ref,
     assessment_candidate_set_refs,verdict,check_plan_ref,check_plan_digest,decision_policy_ref,
     decision_policy_digest,check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
    VALUES ('decision:7',?,'gate:7','run:7','final','transition:7','candidate:7','[]','accepted',
      'plan','${'d'.repeat(64)}','policy','${'e'.repeat(64)}','[]','${'f'.repeat(64)}',?,'${'1'.repeat(64)}')`).run(
    workplace,
    JSON.stringify([{ binding: 'primary-output', productRefs: [product], productContractRef: null }]),
  );
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads
    (workplace_ref,decision_key,expected_workplace_revision) VALUES (?,'decision:7',1)`).run(workplace);
  new SqliteSealedProductMaterialRepository(db).seal({ productRef: product, payload });
  const authority = {
    workplaceRef: ref, candidateSetRef: 'candidate:7', productionRevisionRef: 'revision:7',
    acceptedProductRefs: [product], productSchema: product.schemaId,
    gateDecisionKey: 'decision:7', productContractRef: null,
  };
  authority.acceptanceDigest = computeAcceptanceDigest(authority);
  return { db, authority, product };
}

test('trusted authority loader binds candidate, revision, exact members and accepted gate', () => {
  const { db, authority } = fixture();
  try { assert.doesNotThrow(() => assertPersistedAcceptedCandidateAuthority(db, authority)); }
  finally { db.close(); }
});

test('self-consistent forged coordinates fail before an effect can act', () => {
  const { db, authority } = fixture();
  try {
    const forged = { ...authority, gateDecisionKey: 'decision:missing' };
    forged.acceptanceDigest = computeAcceptanceDigest(forged);
    assert.throws(() => assertPersistedAcceptedCandidateAuthority(db, forged), /AUTHORITY_GATE_DECISION_MISMATCH/);
  } finally { db.close(); }
});

test('an accepted author-phase decision cannot substitute the final authority', () => {
  const { db, authority } = fixture();
  try {
    db.prepare(`INSERT INTO factory_gate_decisions
      (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,subject_candidate_set_ref,
       assessment_candidate_set_refs,verdict,check_plan_ref,check_plan_digest,decision_policy_ref,
       decision_policy_digest,check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
      VALUES ('decision:author',?,'gate:author','run:author','author','transition:author','candidate:7','[]','accepted',
        'plan','${'d'.repeat(64)}','policy','${'e'.repeat(64)}','[]','${'f'.repeat(64)}','[]','${'2'.repeat(64)}')`).run(workplace);
    const forged = { ...authority, gateDecisionKey: 'decision:author' };
    forged.acceptanceDigest = computeAcceptanceDigest(forged);
    assert.throws(() => assertPersistedAcceptedCandidateAuthority(db, forged), /AUTHORITY_GATE_DECISION_MISMATCH/);
  } finally { db.close(); }
});

test('product schema is bound to the exact accepted member set', () => {
  const { db, authority } = fixture();
  try {
    const forged = { ...authority, productSchema: 'schema/other' };
    forged.acceptanceDigest = computeAcceptanceDigest(forged);
    assert.throws(
      () => assertPersistedAcceptedCandidateAuthority(db, forged),
      /AUTHORITY_PRODUCT_SCHEMA_MISMATCH/,
    );
  } finally { db.close(); }
});

test('another valid CandidateSet schema cannot replace the Gate-bound primary output', () => {
  const { db, authority } = fixture();
  try {
    const other = { schemaId: 'schema/other', ref: 'submission:18', digest: sha256Hex({ other: true }) };
    db.prepare(`INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
      VALUES ('candidate:7',1,?,?,?,'produced')`).run(other.schemaId, other.ref, other.digest);
    const forged = {
      ...authority, acceptedProductRefs: [other], productSchema: other.schemaId,
    };
    forged.acceptanceDigest = computeAcceptanceDigest(forged);
    assert.throws(
      () => assertPersistedAcceptedCandidateAuthority(db, forged),
      /AUTHORITY_ACCEPTED_OUTPUT_BINDING_MISMATCH/,
    );
  } finally { db.close(); }
});

test('product schema cannot select another member while retaining the exact Gate-bound refs', () => {
  const { db, authority } = fixture();
  try {
    const other = { schemaId: 'schema/other', ref: 'submission:18', digest: sha256Hex({ other: true }) };
    db.prepare(`INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
      VALUES ('candidate:7',1,?,?,?,'produced')`).run(other.schemaId, other.ref, other.digest);
    const forged = { ...authority, productSchema: other.schemaId };
    forged.acceptanceDigest = computeAcceptanceDigest(forged);
    assert.throws(
      () => assertPersistedAcceptedCandidateAuthority(db, forged),
      /AUTHORITY_ACCEPTED_OUTPUT_BINDING_MISMATCH/,
    );
  } finally { db.close(); }
});

test('sealed product aliases and payloads are append-only exact authority', () => {
  const { db, product } = fixture();
  try {
    assert.throws(() => db.prepare('UPDATE factory_sealed_product_aliases SET content_digest=?').run('9'.repeat(64)), /factory_sealed_product_aliases are immutable/);
    assert.throws(() => db.prepare('DELETE FROM factory_sealed_product_materials').run(), /factory_sealed_product_materials are immutable/);
    assert.deepEqual(new SqliteSealedProductMaterialRepository(db).readExact(product), { exact: 'material' });
  } finally { db.close(); }
});
