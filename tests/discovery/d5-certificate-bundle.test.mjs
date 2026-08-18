/**
 * D5 — verifyDiscoveryCertificateBundle focused tamper tests (P0-3).
 *
 * verifyDiscoveryCertificateBundle is the SINGLE source of truth for "is this
 * DiscoveryOutcomeCertificate authoritative". It consolidates the FULL D4
 * verification discipline and is now called by BOTH D4 (settlement service,
 * wrapped) and D5 (diagnosis service, directly). These tests exercise every
 * tamper the bundle must reject:
 *
 *   B1 — corrupted certificate_payload (payload/hash no longer agree with rebuild)
 *   B2 — certificate_hash mismatch (expected hash != stored hash)
 *   B3 — settlement not certificate_issued (computed/failed with a cert attached)
 *   B4 — reason-code mismatch between cert and settlement
 *   B5 — settlement.input_hash tamper (recomputed snapshot hash != row)
 *   B6 — snapshot policy-replay disagreement (decision mutated, snapshot intact)
 *   B7 — readiness-assessment-id drift (snapshot.assessment_id != settlement row)
 *   B8 — malformed snapshot readiness (accepted without payload)
 *   B9 — happy path: a clean D4-issued certificate verifies + returns the bundle
 *
 * The fixture settles a REAL proposal via the real FactoryDiscoverySettlementService
 * (so the starting certificate is legitimate), then mutates rows in place and
 * asserts the bundle verifier throws CertificateBundleError with a precise
 * message. Mirrors the d4-settlement-recovery harness.
 *
 * Tests import from ../../dist/... so `npm run build` (tsc) must run first.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import('../../dist/modules/discovery/domain/discovery-proposal.js');
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/shared/work-intent.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/modules/discovery/domain/discovery-readiness-assessment.js'
);
const { canonicalJson } = await import('../../dist/shared/canonical-json.js');
const { ensureFactoryReadinessSchema } = await import(
  '../../dist/modules/discovery/infrastructure/discovery-readiness-repository.js'
);
const { ensureFactorySettlementSchema } = await import(
  '../../dist/modules/discovery/infrastructure/discovery-settlement-repository.js'
);
const {
  discoverySettlementPolicyV1,
} = await import('../../dist/modules/discovery/domain/discovery-settlement-policy.js');
const { FactoryDiscoverySettlementService } = await import(
  '../../dist/modules/discovery/application/discovery-settlement-service.js'
);
const {
  verifyDiscoveryCertificateBundle,
  CertificateBundleError,
} = await import('../../dist/modules/discovery/application/discovery-certificate-bundle.js');
const { SqliteFactoryDiscoveryRuntime } = await import(
  '../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js'
);

// ---------------------------------------------------------------------------
// Fixture scaffolding (mirrors d4-settlement-recovery.test.mjs)
// ---------------------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-d5-bundle-'));
  process.env.DB_PATH = path.join(temp, 'd5b.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  ensureFactoryReadinessSchema(db);
  ensureFactorySettlementSchema(db);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

const PRODUCT_PROPOSAL_PAYLOAD = {
  problem_statement: 'the problem',
  observed_context: 'the context',
  stakeholders_or_actors: ['user'],
  assumptions: ['assumption'],
  unknowns: ['unknown'],
  risks: ['risk'],
  candidate_scope: 'scope',
  evidence_refs: ['artifact:req-1'],
  recommended_outcome: 'go',
  rationale: 'rationale',
};
const PRODUCT_PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PRODUCT_PROPOSAL_PAYLOAD)).digest('hex');

function validAssessmentPayload(proposalId, proposalHash, overrides = {}) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dims,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'well grounded',
    ...overrides,
  };
}

const ASSESSMENT_PAYLOAD = validAssessmentPayload(50, PRODUCT_PROPOSAL_HASH);
const ASSESSMENT_HASH = createHash('sha256').update(canonicalJson(ASSESSMENT_PAYLOAD)).digest('hex');

const SHADOW_COMPLETED = {
  status: 'completed',
  authority: 'shadow_advisor',
  assessmentId: 7,
  assessmentHash: ASSESSMENT_HASH,
  overallReadiness: 'ready',
  recommendedNextAction: 'proceed_to_settlement',
  error: null,
};

function buildLiveFixture(db) {
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
  ).run(DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA);
  db.prepare(
    `INSERT INTO factory_proposals
       (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
     VALUES (50,1,100,'product-exec',?,?,?,?,?,?)`,
  ).run(
    'discovery',
    DISCOVERY_PROPOSAL_SCHEMA,
    canonicalJson(PRODUCT_PROPOSAL_PAYLOAD),
    PRODUCT_PROPOSAL_HASH,
    'submitted',
    '{}',
  );

  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
  ).run(DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
  db.prepare(
    `INSERT INTO factory_readiness_control_intents
       (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'concluded')`,
  ).run(50, PRODUCT_PROPOSAL_HASH, 1, 2, 200);
  db.prepare(
    `INSERT INTO factory_readiness_assessments
       (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action,
        validation_errors,provenance)
     VALUES (7,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
  ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(ASSESSMENT_PAYLOAD), ASSESSMENT_HASH);
}

function makeRuntime() {
  return new SqliteFactoryDiscoveryRuntime();
}
function makeService() {
  const runtime = makeRuntime();
  return new FactoryDiscoverySettlementService({ runtimePersistence: runtime });
}

/**
 * Settle once and return the issued settlementId + certificateId + certificateHash,
 * plus the runtime for follow-up reads.
 */
async function issueCleanCertificate(db) {
  buildLiveFixture(db);
  const service = makeService();
  const result = await service.settle({
    projectId: 1, epicId: 10, proposalId: 50,
    proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
  });
  assert.equal(result.status, 'issued');
  return {
    settlementId: result.settlementId,
    certificateId: result.certificateId,
    certificateHash: result.certificateHash,
  };
}

/** Assert that fn() throws CertificateBundleError whose message matches /re/. */
function assertBundleError(fn, re, label) {
  let err;
  try {
    fn();
    assert.fail(`${label}: expected verifyDiscoveryCertificateBundle to throw`);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof CertificateBundleError, `${label}: expected CertificateBundleError, got ${err && err.name}`);
  assert.ok(
    re.test(err.message),
    `${label}: expected message to match ${re}, got: ${err.message}`,
  );
}

// ---------------------------------------------------------------------------
// B9 — happy path: a clean D4-issued certificate verifies + returns the bundle
// ---------------------------------------------------------------------------

test('bundle: clean D4-issued certificate verifies and returns the full bundle', async () => {
  const { temp, db } = fixture();
  try {
    const { certificateId, certificateHash } = await issueCleanCertificate(db);
    const rt = makeRuntime();
    const bundle = verifyDiscoveryCertificateBundle(
      rt, certificateId, certificateHash, discoverySettlementPolicyV1,
    );
    assert.equal(bundle.certificate.id, certificateId);
    assert.equal(bundle.certificate.certificate_hash, certificateHash);
    assert.equal(bundle.settlement.status, 'certificate_issued');
    assert.equal(bundle.snapshot.epic_id, 10);
    assert.equal(bundle.snapshot.proposal.id, 50);
    assert.equal(bundle.proposal.id, 50);
    assert.equal(bundle.proposalHash, PRODUCT_PROPOSAL_HASH);
    assert.equal(bundle.policyDecision.decision, 'go');
    // Accepted readiness => the bundle carries the verified assessment.
    assert.ok(bundle.readinessAssessment, 'accepted readiness must surface the assessment');
    assert.equal(bundle.readinessAssessment.id, 7);
    assert.equal(bundle.readinessAssessment.content_hash, ASSESSMENT_HASH);
    // inputHash recomputed from the snapshot equals the settlement row.
    assert.equal(bundle.inputHash, bundle.settlement.input_hash);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B1 — corrupted certificate_payload
// ---------------------------------------------------------------------------

test('bundle: corrupted certificate_payload is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { certificateId, certificateHash } = await issueCleanCertificate(db);
    // Tamper the persisted certificate_payload to something the rebuild will
    // not match. The stored certificate_hash is left intact, so the rebuild-
    // expected-hash check would pass if not for the canonical-payload compare.
    db.prepare('UPDATE factory_discovery_outcome_certificates SET certificate_payload=? WHERE id=?')
      .run(canonicalJson({ tampered: true, injected: 'attacker' }), certificateId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /does not match the rebuilt expected payload|certificate_hash does not match/,
      'B1 corrupted payload',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B2 — certificate_hash mismatch (expected hash != stored hash)
// ---------------------------------------------------------------------------

test('bundle: certificate_hash mismatch is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { certificateId } = await issueCleanCertificate(db);
    const rt = makeRuntime();
    // Pass a wrong expected hash; the bundle must reject before touching rows.
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, '0'.repeat(64), discoverySettlementPolicyV1),
      /hash mismatch/,
      'B2 hash mismatch',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B3 — settlement not certificate_issued
// ---------------------------------------------------------------------------

test('bundle: certificate on a non-issued settlement is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // Roll the settlement back to 'computed' while the certificate row is still
    // present (a crash left a cert attached to a non-issued settlement). The
    // bundle must reject: a certificate on a non-issued settlement is NOT
    // authoritative.
    db.prepare("UPDATE factory_discovery_settlements SET status='computed' WHERE id=?")
      .run(settlementId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /is not 'certificate_issued'|not authoritative/,
      'B3 non-issued settlement',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B4 — reason-code mismatch between cert and settlement
// ---------------------------------------------------------------------------

test('bundle: reason-code mismatch between cert and settlement is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // Tamper ONLY the certificate row's reason_codes JSON array. The settlement
    // row keeps its original reason_codes, so the settlement/cert reason-code
    // consistency check fires.
    db.prepare('UPDATE factory_discovery_outcome_certificates SET reason_codes=? WHERE id=?')
      .run(JSON.stringify(['WRONG_CODE']), certificateId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /reason_codes/,
      'B4 reason-code mismatch',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B5 — settlement.input_hash tamper (recomputed snapshot hash != row)
// ---------------------------------------------------------------------------

test('bundle: tampered settlement.input_hash is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // Flip the settlement row's input_hash to a wrong value. The snapshot is
    // unchanged, so recomputing buildSettlementInputHash(snapshot) != row.
    db.prepare('UPDATE factory_discovery_settlements SET input_hash=? WHERE id=?')
      .run('f'.repeat(64), settlementId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /input_hash|recomputed snapshot hash/,
      'B5 input_hash tamper',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B6 — snapshot policy-replay disagreement (snapshot mutated to a decision the
// policy cannot produce from it, while the settlement row keeps the original
// decision). The snapshot is the only thing changed; the settlement row's
// decision/reason_codes/rationale stay as D4 wrote them. We tamper the nested
// proposal payload's recommended_outcome AND re-derive input_hash on BOTH the
// settlement and certificate rows so the cert/settlement consistency + the
// snapshot hash check pass, leaving the policy-replay check to fire (the replay
// over the tampered snapshot produces a different decision than the row).
// ---------------------------------------------------------------------------

test('bundle: snapshot policy-replay disagreement is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // The policy-replay check (parseAndVerifyStoredSnapshotShared step f) can
    // ONLY be reached when every hash-anchored check above it passes. The
    // snapshot's proposal/readiness payloads are independently anchored by
    // their content hashes, and the snapshot itself is anchored by input_hash —
    // so a snapshot-only tamper that changes the replayed decision always trips
    // one of those hash checks first (which is exactly the defence we want).
    //
    // The only way to reach the replay check with a disagreement is to tamper
    // the STORED DECISION on the rows while leaving the snapshot intact, so the
    // snapshot replays to its original 'go' but the row now claims 'reject'. To
    // keep the cert/settlement decision consistency check (step 2) from firing
    // first, we flip BOTH the settlement row's decision AND the certificate
    // row's decision (and their reason codes) to the same tampered value, so
    // the two rows still agree with each other — but neither agrees with the
    // intact snapshot's replay.
    db.prepare(
      "UPDATE factory_discovery_settlements SET decision='reject', reason_codes=?, rationale=? WHERE id=?",
    ).run(JSON.stringify(['REJECT_WORKER_AND_ADVISOR_AGREE']), 'tampered', settlementId);
    db.prepare(
      "UPDATE factory_discovery_outcome_certificates SET decision='reject', reason_codes=? WHERE id=?",
    ).run(JSON.stringify(['REJECT_WORKER_AND_ADVISOR_AGREE']), certificateId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /decision\/reason_codes\/rationale do not match a policy replay/,
      'B6 policy-replay disagreement',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B7 — readiness-assessment-id drift (snapshot.assessment_id != settlement row)
// ---------------------------------------------------------------------------

test('bundle: readiness-assessment-id drift is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // Tamper the STORED SNAPSHOT's readiness.assessment_id so it disagrees with
    // the settlement row's readiness_assessment_id. Keep the snapshot's
    // readiness status + content_hash intact so the encoded-target check passes,
    // and re-derive input_hash on BOTH rows so the snapshot-hash + cert/settlement
    // consistency checks pass, isolating the assessment_id consistency check.
    const row = db.prepare('SELECT input_snapshot FROM factory_discovery_settlements WHERE id=?')
      .get(settlementId);
    const snap = JSON.parse(row.input_snapshot);
    assert.equal(snap.readiness.status, 'accepted_by_kernel');
    assert.equal(snap.readiness.assessment_id, 7);
    snap.readiness.assessment_id = 999; // drift from the settlement row's id
    const tamperedText = canonicalJson(snap);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    db.prepare('UPDATE factory_discovery_settlements SET input_snapshot=?, input_hash=? WHERE id=?')
      .run(tamperedText, tamperedHash, settlementId);
    db.prepare('UPDATE factory_discovery_outcome_certificates SET input_hash=? WHERE id=?')
      .run(tamperedHash, certificateId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /readiness.assessment_id|assessment_id/,
      'B7 assessment-id drift',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B8 — malformed snapshot readiness (accepted without payload)
// ---------------------------------------------------------------------------

test('bundle: accepted snapshot readiness without payload is rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { settlementId, certificateId, certificateHash } = await issueCleanCertificate(db);
    // Tamper the snapshot to claim accepted_by_kernel but null out the payload.
    // The accepted-readiness null-anchor check requires payload/id/hash ALL
    // non-null; nulling the payload trips it. Re-derive input_hash on BOTH rows
    // so the snapshot-hash + cert/settlement consistency checks pass, isolating
    // the null-anchor check.
    const row = db.prepare('SELECT input_snapshot FROM factory_discovery_settlements WHERE id=?')
      .get(settlementId);
    const snap = JSON.parse(row.input_snapshot);
    assert.equal(snap.readiness.status, 'accepted_by_kernel');
    snap.readiness.payload = null; // accepted without payload -> malformed
    const tamperedText = canonicalJson(snap);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    db.prepare('UPDATE factory_discovery_settlements SET input_snapshot=?, input_hash=? WHERE id=?')
      .run(tamperedText, tamperedHash, settlementId);
    db.prepare('UPDATE factory_discovery_outcome_certificates SET input_hash=? WHERE id=?')
      .run(tamperedHash, certificateId);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, certificateId, certificateHash, discoverySettlementPolicyV1),
      /accepted_by_kernel must carry non-null payload\/id\/hash/,
      'B8 accepted without payload',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// B10 — missing certificate is rejected (defence in depth)
// ---------------------------------------------------------------------------

test('bundle: missing certificate is rejected', async () => {
  const { temp, db } = fixture();
  try {
    await issueCleanCertificate(db);
    const rt = makeRuntime();
    assertBundleError(
      () => verifyDiscoveryCertificateBundle(rt, 99999, '0'.repeat(64), discoverySettlementPolicyV1),
      /certificate .* not found/,
      'B10 missing certificate',
    );
  } finally {
    cleanup(temp);
  }
});
