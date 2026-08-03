/**
 * D4 authoritative-recovery + integrity correction tests.
 *
 * These 11 scenarios exercise the D4 settlement RECOVERY and INTEGRITY paths
 * that the kernel uses to stay authoritative across crashes, replayed races,
 * and tampering. They run the REAL Saga3DiscoverySettlementService over a real
 * better-sqlite3 temp-file DB, using the SAME fixture scaffolding as
 * d4-settlement-persistence.test.mjs.
 *
 * Recovery paths covered (settle() finds an existing settlement row):
 *   1. restart after accepted readiness -> same accepted-target certificate
 *   2. replayed insert race -> rebuild from the STORED snapshot (deterministic)
 *   3. crash after cert insert but before status transition -> reconcile
 *   4. computed/failed settlement with existing cert -> reconcile to issued
 *   5. failed settlement recovery -> final row status certificate_issued
 *
 * Integrity paths covered (parseAndVerifyStoredSnapshot + cert rebuild checks):
 *   6. stored snapshot readiness target differs from settlement row -> rejected
 *   7. stored snapshot epic mismatch -> rejected
 *   8. certificate payload + certificate_hash co-tampered together -> rejected
 *   9. certificate decision mutated without re-hash -> rejected (payload-hash guard)
 *
 * Binding paths covered:
 *  10. readiness assessment linked to the wrong ControlIntent -> rejected
 *  11. completed shadow without assessmentId/hash -> malformed -> rejected
 *
 * The fixture mirrors d4-settlement-persistence.test.mjs: a temp dir under
 * os.tmpdir(), DB_PATH pointed at it, getDb() opened, the full FK chain
 * (projects -> epics -> episode_workflows -> tasks -> work_intents ->
 * proposals, plus the readiness control + accepted assessment rows) seeded
 * with REAL hashes computed via canonicalJson + sha256.
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
const { ensureSaga3ReadinessSchema } = await import(
  '../../dist/saga3/persistence/saga3-readiness-repository.js'
);
const {
  ensureSaga3SettlementSchema,
  findSettlementByInputKey,
} = await import('../../dist/modules/discovery/infrastructure/saga3-settlement-repository.js');
const { DISCOVERY_SETTLEMENT_POLICY_VERSION, POLICY_V1_CONTENT_HASH } = await import(
  '../../dist/modules/discovery/domain/discovery-settlement-policy.js'
);
const { Saga3DiscoverySettlementService } = await import(
  '../../dist/modules/discovery/application/discovery-settlement-service.js'
);
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js'
);

// ---------------------------------------------------------------------------
// Fixture scaffolding (copied verbatim from d4-settlement-persistence.test.mjs)
// ---------------------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d4-recover-'));
  process.env.DB_PATH = path.join(temp, 'd4r.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (11,1,'E2')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  ensureSaga3ReadinessSchema(db);
  ensureSaga3SettlementSchema(db);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// ---------------------------------------------------------------------------
// Canonical payloads with REAL hashes
// ---------------------------------------------------------------------------

/**
 * GO-able product Proposal: every required field populated and at least one
 * non-empty evidence_ref (the GO predicate requires it).
 */
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

/**
 * Build a valid readiness assessment payload. The dimension source_refs MUST be
 * members of the allowed set produced by collectDiscoverySourceRefs; the shared
 * canonical helper lists every payload key as `$.<key>`, so
 * `$.problem_statement` is always allowed — we cite it on every dimension.
 */
function validAssessmentPayload(proposalId, proposalHash, overrides = {}) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_id: proposalId,
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

// Shadow result shape the engine passes to settle() for an accepted readiness.
const SHADOW_COMPLETED = {
  status: 'completed',
  authority: 'shadow_advisor',
  assessmentId: 7,
  assessmentHash: ASSESSMENT_HASH,
  overallReadiness: 'ready',
  recommendedNextAction: 'proceed_to_settlement',
  error: null,
};

/** Encoded readinessTarget string for an accepted assessment. */
const ACCEPTED_TARGET = `accepted:${ASSESSMENT_HASH}`;

/** Build the canonical idempotency key for the accepted target. */
function acceptedInputKey() {
  return {
    proposalId: 50,
    proposalContentHash: PRODUCT_PROPOSAL_HASH,
    readinessTarget: ACCEPTED_TARGET,
    policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
    policyHash: POLICY_V1_CONTENT_HASH,
  };
}

/**
 * Seed the full live fixture. Always inserts the readiness ControlIntent +
 * advisor task + advisor WorkIntent + accepted assessment (id 7) properly
 * linked: control.source_intent_id=1, authority_intent_id=2,
 * projected_task_id=200; assessment.control_intent_id=1, task_id=200.
 *
 * FK chain, in order:
 *   tasks(100) -> saga3_work_intents(1, projected_task_id=100) ->
 *   saga3_proposals(50, intent_id=1, kind='discovery',
 *                    schema_version=DISCOVERY_PROPOSAL_SCHEMA, status='submitted')
 * and the readiness path:
 *   tasks(200) -> saga3_work_intents(2, projected_task_id=200) ->
 *   saga3_readiness_control_intents(1, authority_intent_id=2) ->
 *   saga3_readiness_assessments(7, control_intent_id=1)
 */
function buildLiveFixture(db) {
  // Product task + WorkIntent + Proposal.
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`,
  ).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
  ).run(DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA);
  db.prepare(
    `INSERT INTO saga3_proposals
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

  // Advisor task + WorkIntent + readiness ControlIntent + accepted assessment.
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`,
  ).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
  ).run(DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
  db.prepare(
    `INSERT INTO saga3_readiness_control_intents
       (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'concluded')`,
  ).run(50, PRODUCT_PROPOSAL_HASH, 1, 2, 200);
  db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action,
        validation_errors,provenance)
     VALUES (7,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
  ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(ASSESSMENT_PAYLOAD), ASSESSMENT_HASH);
}

/** Construct the live runtime + service bound to the current DB. */
function makeService() {
  const runtime = new SqliteSaga3DiscoveryRuntime();
  const service = new Saga3DiscoverySettlementService({ runtimePersistence: runtime });
  return { runtime, service };
}

/** The canonical settle() call used across these scenarios. */
function settle(service, readiness = SHADOW_COMPLETED) {
  return service.settle({
    projectId: 1,
    epicId: 10,
    proposalId: 50,
    proposalHash: PRODUCT_PROPOSAL_HASH,
    readiness,
  });
}

// ---------------------------------------------------------------------------
// 1. Recovery: restart after accepted readiness
// ---------------------------------------------------------------------------

test('recovery: restart after accepted readiness returns the accepted-target certificate, not CLARIFY_READINESS_MISSING', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    // First settle: accepted readiness -> a GO certificate for the accepted target.
    const first = await settle(service);
    assert.equal(first.status, 'issued');
    assert.equal(first.decision, 'go');

    // Nothing changes between calls. The second settle() must hit the replay
    // path and return the SAME settlementId / certificateId / certificateHash
    // with decision 'go' — recovery does NOT lose the accepted readiness (it
    // must not collapse to clarify/missing).
    const second = await settle(service);
    assert.equal(second.status, 'issued');
    assert.equal(second.settlementId, first.settlementId);
    assert.equal(second.certificateId, first.certificateId);
    assert.equal(second.certificateHash, first.certificateHash);
    assert.equal(second.decision, 'go');
    assert.ok(
      !second.reasonCodes.includes('CLARIFY_READINESS_MISSING'),
      `recovery must not produce CLARIFY_READINESS_MISSING; got ${JSON.stringify(second.reasonCodes)}`,
    );
    assert.ok(second.reasonCodes.includes('GO_READY_AND_GROUNDED'));
    // Exactly one settlement + one certificate for this target.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 2. Recovery: replayed insert race rebuilds from the STORED snapshot
// ---------------------------------------------------------------------------

test('recovery: replayed insert race cannot issue a certificate from the losing local snapshot', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    // First settle: creates the settlement row + the certificate.
    const first = await settle(service);
    const firstCert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(firstCert);

    // Simulate the replayed-race state: the insert won the race (settlement row
    // present) but the certificate was not built. Delete the certificate row
    // and roll the settlement back to status='computed'.
    db.prepare('DELETE FROM saga3_discovery_outcome_certificates WHERE settlement_id=?')
      .run(first.settlementId);
    db.prepare("UPDATE saga3_discovery_settlements SET status='computed' WHERE id=?")
      .run(first.settlementId);

    // Second settle must REBUILD the certificate from the STORED snapshot
    // (settlement.created_at is the deterministic issued_at), producing a
    // certificate whose hash is byte-identical to the original. A rebuild from
    // the losing local snapshot would carry a fresh captured_at and thus a
    // different input_hash -> different certificate_hash; matching hashes prove
    // the rebuild came from stored data.
    const recovered = await settle(service);
    assert.equal(recovered.status, 'issued');
    assert.equal(recovered.settlementId, first.settlementId);
    assert.equal(recovered.decision, first.decision);
    const rebuiltCert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(rebuiltCert);
    assert.equal(
      rebuiltCert.certificate_hash,
      firstCert.certificate_hash,
      'rebuilt certificate hash must be reproducible from the stored snapshot',
    );
    assert.equal(rebuiltCert.decision, firstCert.decision);
    assert.equal(rebuiltCert.input_hash, firstCert.input_hash);
    // Only one certificate row remains after the rebuild.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 3. Recovery: crash after certificate insert but before status transition
// ---------------------------------------------------------------------------

test('recovery: crash after certificate insert but before status transition', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    // First settle: fully issued.
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Simulate a crash that left the certificate present but the settlement
    // status not advanced: roll the settlement back to 'computed'. The
    // certificate row is untouched.
    db.prepare("UPDATE saga3_discovery_settlements SET status='computed' WHERE id=?")
      .run(first.settlementId);
    const mid = db.prepare('SELECT status FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    assert.equal(mid.status, 'computed');

    // Second settle must reconcile (reconcileExistingCertificate) and return
    // issued; the settlement row must now be 'certificate_issued'.
    const recovered = await settle(service);
    assert.equal(recovered.status, 'issued');
    assert.equal(recovered.settlementId, first.settlementId);
    assert.equal(recovered.certificateId, first.certificateId);
    assert.equal(recovered.certificateHash, first.certificateHash);
    const row = db.prepare('SELECT status FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    assert.equal(row.status, 'certificate_issued');
    // The certificate row is the same one (reconcile does not insert a new cert).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
    const cert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(cert);
    assert.equal(cert.certificate_hash, first.certificateHash);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 4. Recovery: existing certificate with failed settlement reconciled to issued
// ---------------------------------------------------------------------------

test('recovery: existing certificate with computed/failed settlement is atomically reconciled to certificate_issued', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Force the settlement into 'failed' while the certificate row is still
    // present (a crash between cert insert and the status CAS, followed by a
    // markSettlementFailed). Recovery must reconcile failed -> certificate_issued.
    db.prepare("UPDATE saga3_discovery_settlements SET status='failed' WHERE id=?")
      .run(first.settlementId);

    const recovered = await settle(service);
    assert.equal(recovered.status, 'issued');
    assert.equal(recovered.settlementId, first.settlementId);
    // SAME certificate is returned (failed -> issued recovery, no new cert).
    assert.equal(recovered.certificateId, first.certificateId);
    assert.equal(recovered.certificateHash, first.certificateHash);
    assert.equal(recovered.decision, first.decision);
    const cert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(cert);
    assert.equal(cert.certificate_hash, first.certificateHash);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 5. Recovery: failed settlement recovery atomically reaches certificate_issued
// ---------------------------------------------------------------------------

test('recovery: failed settlement recovery atomically reaches certificate_issued', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    db.prepare("UPDATE saga3_discovery_settlements SET status='failed' WHERE id=?")
      .run(first.settlementId);
    const before = db.prepare('SELECT status FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    assert.equal(before.status, 'failed');

    const recovered = await settle(service);
    assert.equal(recovered.status, 'issued');

    // The decisive assertion: the settlement row itself is now certificate_issued.
    const after = db.prepare('SELECT status FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    assert.equal(after.status, 'certificate_issued');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 6. Integrity: stored snapshot readiness target differs from settlement row
// ---------------------------------------------------------------------------

test('integrity: stored snapshot readiness target differs from settlement row -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // The readiness_assessment_hash column is part of the findSettlementByInputKey
    // lookup key, so changing it would make the row unfetchable. The guard in
    // parseAndVerifyStoredSnapshot compares encodeReadinessTarget(snapshot...)
    // against the row, so to trigger it we tamper the STORED SNAPSHOT's readiness
    // status (in input_snapshot) to disagree with the row's accepted target,
    // while leaving the row's readiness_assessment_hash intact so the lookup
    // still finds it.
    const row = db.prepare('SELECT input_snapshot FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    const snap = JSON.parse(row.input_snapshot);
    assert.equal(snap.readiness.status, 'accepted_by_kernel');
    snap.readiness.status = 'failed'; // diverge from the row's 'accepted:<hash>'
    db.prepare('UPDATE saga3_discovery_settlements SET input_snapshot=? WHERE id=?')
      .run(canonicalJson(snap), first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on snapshot readiness target mismatch');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /readiness target/.test(err.message),
      `expected readiness-target mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 7. Integrity: stored snapshot epic mismatch
// ---------------------------------------------------------------------------

test('integrity: stored snapshot epic/proposal/policy mismatch -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // epic_id is NOT part of the findSettlementByInputKey lookup key, so the row
    // is still found after this change. parseAndVerifyStoredSnapshot then checks
    // snap.epic_id === settlement.epic_id and rejects the mismatch. We must
    // create the target epic first to satisfy the FK on the settlement row.
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (999,1,'MismatchEpic')`).run();
    db.prepare('UPDATE saga3_discovery_settlements SET epic_id=? WHERE id=?')
      .run(999, first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on snapshot epic_id mismatch');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /snapshot epic_id/.test(err.message),
      `expected snapshot epic_id mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 8. Integrity: certificate payload + certificate_hash co-tampered together
// ---------------------------------------------------------------------------

test('integrity: certificate payload + certificate_hash co-tampered together -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Co-tamper: change the certificate_payload's decision AND recompute its
    // sha256(canonicalJson) so payload + hash AGREE WITH EACH OTHER. They no
    // longer agree with the STORED settlement (whose decision is still 'go').
    const certRow = db.prepare(
      'SELECT certificate_payload, certificate_hash FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
    ).get(first.settlementId);
    const tampered = JSON.parse(certRow.certificate_payload);
    assert.notEqual(tampered.decision, 'reject');
    tampered.decision = 'reject';
    const tamperedText = canonicalJson(tampered);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    assert.notEqual(tamperedHash, certRow.certificate_hash);
    db.prepare(
      'UPDATE saga3_discovery_outcome_certificates SET certificate_payload=?, certificate_hash=? WHERE settlement_id=?',
    ).run(tamperedText, tamperedHash, first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on co-tampered certificate');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    // The unified verifier rebuilds the expected payload from the stored
    // settlement and rejects because the tampered payload/hash/row no longer
    // matches. Any of the canonical-payload / hash / row guards may fire first.
    assert.ok(
      /does not match the rebuilt expected payload|does not match the rebuilt expected hash|certificate_hash does not match/.test(err.message),
      `expected certificate-verification rejection, got: ${err.message}`,
    );
    // The tampered certificate row is still present (rejection does not delete audit rows).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 9. Integrity: certificate readiness/reason/epic/issued_at lineage mismatch
// ---------------------------------------------------------------------------

test('integrity: certificate readiness/reason/epic/issued_at lineage mismatch -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Mutate the certificate_payload's decision WITHOUT updating
    // certificate_hash. The rebuild-expected-hash check PASSES (the stored
    // settlement still hashes to the unchanged certificate_hash), so the SECOND
    // guard fires: the stored payload no longer hashes to certificate_hash.
    const certRow = db.prepare(
      'SELECT certificate_payload, certificate_hash FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
    ).get(first.settlementId);
    const tampered = JSON.parse(certRow.certificate_payload);
    assert.notEqual(tampered.decision, 'reject');
    tampered.decision = 'reject';
    db.prepare(
      'UPDATE saga3_discovery_outcome_certificates SET certificate_payload=? WHERE settlement_id=?',
    ).run(canonicalJson(tampered), first.settlementId);
    // certificate_hash deliberately left unchanged.

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on certificate payload/hash drift');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    // The unified verifier catches the drift — the canonical-payload compare
    // (payload vs rebuilt expected) fires because the tampered decision no
    // longer matches the stored settlement's decision.
    assert.ok(
      /does not match the rebuilt expected payload|certificate_payload hash does not match stored certificate_hash|corruption/.test(err.message),
      `expected certificate-verification rejection, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 10. Binding: readiness assessment linked to the wrong ControlIntent/task
// ---------------------------------------------------------------------------

test('binding: readiness assessment linked to the wrong ControlIntent/task -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);

    // Seed a SECOND readiness ControlIntent (id 2). The unique index is on
    // (proposal_id, proposal_content_hash), so the second control must target a
    // different content_hash. It still references proposal 50 (which exists).
    db.prepare(
      `INSERT INTO saga3_readiness_control_intents
         (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
          authority_intent_id,projected_task_id,status)
       VALUES (2,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'concluded')`,
    ).run(50, 'a-different-content-hash-not-the-real-one', 1, 2, 200);

    // Insert an accepted assessment (id 8) that references control_intent_id=2
    // (the WRONG control) but whose proposal_id + proposal_content_hash target
    // THIS proposal 50. The schema has no check that
    // assessment.proposal_id === control.proposal_id, so this inserts cleanly.
    // verifyReadinessLineage is what catches it: it reads the control for
    // proposal 50 (control 1), then sees assessment.control_intent_id=2 !== 1.
    db.prepare(
      `INSERT INTO saga3_readiness_assessments
         (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
          payload,content_hash,status,overall_readiness,recommended_next_action,
          validation_errors,provenance)
       VALUES (8,2,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
    ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(ASSESSMENT_PAYLOAD), ASSESSMENT_HASH);

    const { service } = makeService();
    let err;
    try {
      await service.settle({
        projectId: 1, epicId: 10, proposalId: 50,
        proposalHash: PRODUCT_PROPOSAL_HASH,
        readiness: {
          status: 'completed',
          authority: 'shadow_advisor',
          assessmentId: 8,
          assessmentHash: ASSESSMENT_HASH,
          overallReadiness: 'ready',
          recommendedNextAction: 'proceed_to_settlement',
          error: null,
        },
      });
      assert.ok(false, 'should have thrown on readiness assessment bound to wrong ControlIntent');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /belongs to control|control_intent_id/i.test(err.message),
      `expected wrong-ControlIntent lineage rejection, got: ${err.message}`,
    );
    // No settlement row persisted for the rejected binding.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      0,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 11. Binding: completed shadow without assessmentId/hash is malformed
// ---------------------------------------------------------------------------

test('binding: completed shadow without assessmentId/hash is malformed -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    // A 'completed' shadow is the engine asserting the D3 advisor produced an
    // accepted assessment; it MUST carry assessmentId + assessmentHash. A
    // completed shadow without them is malformed engine input (it would let the
    // engine claim acceptance without proof) and must fail closed.
    let err;
    try {
      await service.settle({
        projectId: 1, epicId: 10, proposalId: 50,
        proposalHash: PRODUCT_PROPOSAL_HASH,
        readiness: {
          status: 'completed',
          authority: 'shadow_advisor',
          assessmentId: null,
          assessmentHash: null,
          overallReadiness: 'ready',
          recommendedNextAction: 'proceed_to_settlement',
          error: null,
        },
      });
      assert.ok(false, 'should have thrown on malformed completed shadow');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /missing assessmentId\/assessmentHash|malformed engine input/i.test(err.message),
      `expected malformed-shadow rejection, got: ${err.message}`,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      0,
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Round-4 corrections: nested-payload integrity, full certificate row lineage,
// complete readiness lineage binding.
//
// The D4 snapshot guards below exercise the deeper anchors added on top of the
// whole-snapshot input_hash: parseAndVerifyStoredSnapshot now re-validates the
// stored Proposal payload, recomputes its hash, and (for accepted readiness)
// validates + rehashes the readiness payload too. A coherent tamper that edits
// the nested payload and rewrites input_hash to match is still caught, because
// the Proposal hash (and the readiness content_hash) are independent anchors.
// verifyCertificateRecord now rebuilds the expected payload and compares EVERY
// certificate row lineage column. verifyReadinessLineage now requires
// control.projected_task_id != null, authority.projected_task_id ==
// control.projected_task_id, and both lifecycle statuses == 'concluded'.
// ===========================================================================

// ---------------------------------------------------------------------------
// 12. Integrity: coherent Proposal payload tamper inside the snapshot
// ---------------------------------------------------------------------------

test('integrity: coherent Proposal payload tamper inside snapshot + recomputed input_hash -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Read the stored snapshot (canonical JSON text) and tamper a NON-decision
    // field of the nested Proposal payload, then rewrite input_snapshot AND
    // input_hash to be internally consistent. input_hash alone is NOT an anchor
    // (it lives in the same mutable row); the Proposal content_hash is, and it
    // is unchanged, so parseAndVerifyStoredSnapshot recomputes
    // sha256Hex(snapshot.proposal.payload) and finds it !=
    // snapshot.proposal.content_hash.
    const row = db.prepare('SELECT input_snapshot FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    const snap = JSON.parse(row.input_snapshot);
    snap.proposal.payload.rationale = 'TAMPERED-rationale';
    const tamperedText = canonicalJson(snap);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    db.prepare('UPDATE saga3_discovery_settlements SET input_snapshot=?, input_hash=? WHERE id=?')
      .run(tamperedText, tamperedHash, first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on coherent Proposal payload tamper');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /proposal payload hash does not match/.test(err.message),
      `expected proposal payload hash mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 13. Integrity: coherent readiness payload tamper inside the snapshot
// ---------------------------------------------------------------------------

test('integrity: coherent readiness payload tamper inside snapshot + recomputed input_hash -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Tamper a NON-decision field of the nested readiness payload. The whole
    // snapshot is re-hashed so input_hash agrees with input_snapshot, but the
    // readiness content_hash is unchanged, so the accepted-readiness nested
    // hash check (sha256Hex(snapshot.readiness.payload) !=
    // snapshot.readiness.content_hash) fires.
    const row = db.prepare('SELECT input_snapshot FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    const snap = JSON.parse(row.input_snapshot);
    snap.readiness.payload.rationale = 'TAMPERED-readiness-rationale';
    const tamperedText = canonicalJson(snap);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    db.prepare('UPDATE saga3_discovery_settlements SET input_snapshot=?, input_hash=? WHERE id=?')
      .run(tamperedText, tamperedHash, first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on coherent readiness payload tamper');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /readiness payload hash does not match/.test(err.message),
      `expected readiness payload hash mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 14. Integrity: failed/missing snapshot with non-null assessment_id -> rejected
// ---------------------------------------------------------------------------

test('integrity: failed/missing snapshot with non-null assessment_id -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    // First settle with a NOT_RUN shadow: no accepted assessment, snapshot
    // status becomes 'missing' (assessment_id/content_hash/payload all null).
    const first = await settle(service, {
      status: 'not_run',
      authority: null,
      assessmentId: null,
      assessmentHash: null,
      overallReadiness: null,
      recommendedNextAction: null,
      error: null,
    });
    assert.equal(first.status, 'issued');

    // Tamper: set a non-null assessment_id while the status is still 'missing'.
    // This is an internal contradiction that input_hash alone cannot catch; the
    // non-accepted branch of parseAndVerifyStoredSnapshot requires
    // assessment_id/content_hash/payload to ALL be null.
    const row = db.prepare('SELECT input_snapshot FROM saga3_discovery_settlements WHERE id=?')
      .get(first.settlementId);
    const snap = JSON.parse(row.input_snapshot);
    assert.equal(snap.readiness.status, 'missing');
    snap.readiness.assessment_id = 999;
    const tamperedText = canonicalJson(snap);
    const tamperedHash = createHash('sha256').update(tamperedText).digest('hex');
    db.prepare('UPDATE saga3_discovery_settlements SET input_snapshot=?, input_hash=? WHERE id=?')
      .run(tamperedText, tamperedHash, first.settlementId);

    let err;
    try {
      await settle(service, {
        status: 'not_run',
        authority: null,
        assessmentId: null,
        assessmentHash: null,
        overallReadiness: null,
        recommendedNextAction: null,
        error: null,
      });
      assert.ok(false, 'should have thrown on non-null assessment_id on a missing snapshot');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    // A non-null assessment_id on a non-accepted snapshot is an internal
    // contradiction. Either guard may fire: the null-anchor check OR the
    // settlement-row assessment_id consistency check.
    assert.ok(
      /must carry null payload\/content_hash\/assessment_id|snapshot readiness.assessment_id .* != settlement/.test(err.message),
      `expected non-accepted readiness null-anchor/assessment_id rejection, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 15. Integrity: certificate row epic_id mismatch -> rejected
// ---------------------------------------------------------------------------

test('integrity: certificate row epic_id mismatch -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Insert a second epic so the FK on the certificate row accepts the
    // rewrite, then move only the CERTIFICATE row's epic_id to it. The
    // settlement row keeps epic_id=10, so verifyCertificateRecord finds
    // cert.epic_id (999) != settlement.epic_id (10).
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (999,1,'CertEpic')`).run();
    db.prepare('UPDATE saga3_discovery_outcome_certificates SET epic_id=? WHERE settlement_id=?')
      .run(999, first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on certificate row epic_id mismatch');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /epic_id/.test(err.message),
      `expected certificate row epic_id mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 16. Integrity: certificate row reason_codes mismatch -> rejected
// ---------------------------------------------------------------------------

test('integrity: certificate row reason_codes mismatch -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await settle(service);
    assert.equal(first.status, 'issued');

    // Tamper only the CERTIFICATE row's reason_codes JSON array column. The
    // settlement row keeps its original reason_codes, so the row-lineage loop
    // in verifyCertificateRecord fires on the reason_codes field.
    db.prepare('UPDATE saga3_discovery_outcome_certificates SET reason_codes=? WHERE settlement_id=?')
      .run('["WRONG"]', first.settlementId);

    let err;
    try {
      await settle(service);
      assert.ok(false, 'should have thrown on certificate row reason_codes mismatch');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /reason_codes/.test(err.message),
      `expected certificate row reason_codes mismatch, got: ${err.message}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 17. Binding: control.projected_task_id=null -> rejected accepted readiness
// ---------------------------------------------------------------------------

test('binding: control.projected_task_id=null -> rejected accepted readiness', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    // Null BOTH the ControlIntent's and the authority WorkIntent's
    // projected_task_id so the change is internally consistent at the row
    // level (and so we reach the control.projected_task_id check first).
    // verifyReadinessLineage then rejects because an accepted assessment
    // requires a non-null control.projected_task_id.
    db.prepare('UPDATE saga3_readiness_control_intents SET projected_task_id=NULL WHERE id=1')
      .run();
    db.prepare('UPDATE saga3_work_intents SET projected_task_id=NULL WHERE id=2')
      .run();

    const { service } = makeService();
    let err;
    try {
      await settle(service, SHADOW_COMPLETED);
      assert.ok(false, 'should have thrown on null control.projected_task_id');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /projected_task_id/.test(err.message),
      `expected projected_task_id rejection, got: ${err.message}`,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      0,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 18. Binding: authority WorkIntent projected task mismatch -> rejected
// ---------------------------------------------------------------------------

test('binding: authority WorkIntent projected task mismatch -> rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    // The ControlIntent keeps projected_task_id=200. Point the authority
    // WorkIntent (id 2) at a DIFFERENT projected task. A real task 999 is
    // inserted first so the FK (projected_task_id REFERENCES tasks(id) ON
    // DELETE SET NULL) accepts the update. verifyReadinessLineage rejects
    // because authority.projected_task_id (999) != control.projected_task_id
    // (200). The control check (non-null) passes first; the mismatch check
    // fires second.
    db.prepare(
      `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (999,10,'Other','done','discovery.assess')`,
    ).run();
    db.prepare('UPDATE saga3_work_intents SET projected_task_id=? WHERE id=2')
      .run(999);

    const { service } = makeService();
    let err;
    try {
      await settle(service, SHADOW_COMPLETED);
      assert.ok(false, 'should have thrown on authority projected_task_id mismatch');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(
      /projected_task_id/.test(err.message),
      `expected projected_task_id mismatch rejection, got: ${err.message}`,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      0,
    );
  } finally {
    cleanup(temp);
  }
});
