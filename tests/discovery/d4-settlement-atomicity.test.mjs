/**
 * D4 — atomic certificate-issuance transaction integrity (correction 4).
 *
 * Tests the BEGIN IMMEDIATE atomicity of issueCertificateAtomically directly
 * against the repository: a failure injected AFTER the certificate insert but
 * BEFORE the settlement status transition must roll back the WHOLE transaction
 * (certificate absent, settlement NOT certificate_issued).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { canonicalJson } = await import('../../dist/modules/discovery/infrastructure/discovery-normalization-repository.js');
const { sha256Hex } = await import('../../dist/shared/canonical-json.js');
const { ensureFactorySettlementSchema, insertSettlement, findSettlementByInputKey, readCertificateForSettlement } = await import('../../dist/modules/discovery/infrastructure/discovery-settlement-repository.js');
const { DISCOVERY_SETTLEMENT_POLICY_VERSION, POLICY_V1_CONTENT_HASH } = await import('../../dist/modules/discovery/domain/discovery-settlement-policy.js');
const { DISCOVERY_SETTLEMENT_INPUT_SCHEMA } = await import('../../dist/modules/discovery/domain/discovery-settlement-input.js');
const { buildOutcomeCertificatePayload, hashOutcomeCertificate } = await import('../../dist/modules/discovery/domain/discovery-outcome-certificate.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-d4-atomic-'));
  process.env.DB_PATH = path.join(temp, 'd4-atomic.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  // Minimal FK chain so the certificate row (which REFERENCES factory_proposals +
  // epics) can be inserted: a task + work_intent + proposal 50.
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'D','done','discovery.work')`).run();
  db.prepare(`INSERT INTO factory_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (1,10,'discovery','o','{}','factory.work-intent.discovery.v1',0,0,100,'concluded')`).run();
  db.prepare(`INSERT INTO factory_proposals (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance) VALUES (50,1,100,'exec','discovery','factory.discovery-proposal.v1','{}','${'a'.repeat(64)}','submitted','{}')`).run();
  ensureFactorySettlementSchema(db);
  return { temp, db };
}
function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// Seed a settlement in 'computed' state for the atomic-issuance tests.
function seedComputedSettlement(db) {
  const snapshot = {
    schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
    epic_id: 10,
    proposal: { id: 50, content_hash: 'a'.repeat(64), payload: { problem_statement:'p', observed_context:'c', stakeholders_or_actors:['s'], assumptions:['a'], unknowns:['u'], risks:['r'], candidate_scope:'s', evidence_refs:['e'], recommended_outcome:'go', rationale:'r' }, source_intent_id: 1, source_submission_id: null, normalization_proposal_id: null },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, content_hash: 'b'.repeat(64), payload: null },
    policy: { version: DISCOVERY_SETTLEMENT_POLICY_VERSION, content_hash: POLICY_V1_CONTENT_HASH },
    captured_at: '2026-07-24T00:00:00.000Z',
  };
  const { record } = insertSettlement(db, {
    epicId: 10,
    key: { proposalId: 50, proposalContentHash: 'a'.repeat(64), readinessTarget: 'accepted:' + 'b'.repeat(64), policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION, policyHash: POLICY_V1_CONTENT_HASH },
    readinessAssessmentId: 7,
    inputSnapshot: snapshot,
    decision: 'go',
    reasonCodes: ['GO_READY_AND_GROUNDED'],
    rationale: 'ready',
  });
  return { record, snapshotText: canonicalJson(snapshot), rationale: 'ready' };
}

test('atomic issuance: transaction failure after certificate insert rolls back (no cert, settlement not issued)', async () => {
  const { temp, db } = fixture();
  try {
    const { record: settlement, snapshotText, rationale } = seedComputedSettlement(db);
    // Build a valid expected certificate payload + hash.
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: 10,
      proposalId: 50,
      proposalContentHash: 'a'.repeat(64),
      readinessStatus: 'accepted_by_kernel',
      readinessAssessmentId: 7,
      readinessContentHash: 'b'.repeat(64),
      decision: { decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'], rationale: '', policy_version: DISCOVERY_SETTLEMENT_POLICY_VERSION, policy_hash: POLICY_V1_CONTENT_HASH },
      settlementInputHash: settlement.input_hash,
      issuedAt: settlement.created_at,
    });
    const expectedHash = hashOutcomeCertificate(certPayload);

    // INJECT a failure: monkey-patch the db so that the settlement status UPDATE
    // (step 4 of issueCertificateAtomically) throws. We do this by temporarily
    // wrapping db.prepare to reject the status-transition UPDATE specifically.
    const realPrepare = db.prepare.bind(db);
    let blockStatusTransition = true;
    db.prepare = (sql) => {
      if (blockStatusTransition && /SET status='certificate_issued'/.test(sql)) {
        // Return a statement whose .run() throws — simulates a crash mid-tx.
        return { run() { throw new Error('INJECTED tx failure before status transition'); }, get() { throw new Error('INJECTED'); }, all() { throw new Error('INJECTED'); } };
      }
      return realPrepare(sql);
    };

    let threw = false;
    try {
      // Call issueCertificateAtomically directly via the repo import is not
      // possible (it is wrapped in the adapter). Instead, exercise the same
      // BEGIN IMMEDIATE path by replicating the call through the adapter port.
      // We import the runtime adapter, which delegates to issueCertificateAtomically.
      const { SqliteFactoryDiscoveryRuntime } = await import('../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js');
      const rt = new SqliteFactoryDiscoveryRuntime();
      rt.issueCertificateAtomically({
        settlementId: settlement.id,
        epicId: 10,
        proposalId: 50,
        proposalContentHash: 'a'.repeat(64),
        readinessAssessmentId: 7,
        readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
        policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
        policyHash: POLICY_V1_CONTENT_HASH,
        decision: 'go',
        reasonCodes: ['GO_READY_AND_GROUNDED'],
        inputHash: settlement.input_hash,
        certificatePayload: certPayload,
        expectedCertificateHash: expectedHash,
        issuedAt: settlement.created_at,
        inputSnapshotText: snapshotText,
        rationale,
      });
    } catch (e) {
      threw = true;
      assert.match(e.message, /INJECTED tx failure/);
    }
    // Restore the real prepare so the post-rollback reads work.
    db.prepare = realPrepare;
    blockStatusTransition = false;
    assert.ok(threw, 'issueCertificateAtomically should have thrown on injected failure');

    // CRITICAL: the transaction must have rolled back. The certificate row must
    // be ABSENT, and the settlement must NOT be certificate_issued.
    const cert = readCertificateForSettlement(db, settlement.id);
    assert.equal(cert, null, 'certificate row must be absent after tx rollback');
    const s = db.prepare('SELECT status FROM factory_discovery_settlements WHERE id=?').get(settlement.id);
    assert.equal(s.status, 'computed', 'settlement must stay computed after tx rollback');
  } finally {
    cleanup(temp);
  }
});

test('atomic issuance: successful commit leaves certificate + certificate_issued', async () => {
  const { temp, db } = fixture();
  try {
    const { record: settlement, snapshotText, rationale } = seedComputedSettlement(db);
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
      readinessStatus: 'accepted_by_kernel', readinessAssessmentId: 7, readinessContentHash: 'b'.repeat(64),
      decision: { decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'], rationale: '', policy_version: DISCOVERY_SETTLEMENT_POLICY_VERSION, policy_hash: POLICY_V1_CONTENT_HASH },
      settlementInputHash: settlement.input_hash, issuedAt: settlement.created_at,
    });
    const expectedHash = hashOutcomeCertificate(certPayload);
    const { SqliteFactoryDiscoveryRuntime } = await import('../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js');
    const rt = new SqliteFactoryDiscoveryRuntime();
    const { record, inserted } = rt.issueCertificateAtomically({
      settlementId: settlement.id, epicId: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
      readinessAssessmentId: 7, readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
      policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION, policyHash: POLICY_V1_CONTENT_HASH,
      decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], inputHash: settlement.input_hash,
      certificatePayload: certPayload, expectedCertificateHash: expectedHash, issuedAt: settlement.created_at,
      inputSnapshotText: snapshotText, rationale,
    });
    assert.ok(inserted);
    assert.equal(record.certificate_hash, expectedHash);
    assert.equal(record.issued_at, settlement.created_at);
    const s = db.prepare('SELECT status FROM factory_discovery_settlements WHERE id=?').get(settlement.id);
    assert.equal(s.status, 'certificate_issued');
  } finally {
    cleanup(temp);
  }
});

test('atomic issuance: settlement.input_snapshot changed (input_hash left) -> certificate NOT inserted, settlement stays computed', async () => {
  const { temp, db } = fixture();
  try {
    const { record: settlement, snapshotText, rationale } = seedComputedSettlement(db);
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
      readinessStatus: 'accepted_by_kernel', readinessAssessmentId: 7, readinessContentHash: 'b'.repeat(64),
      decision: { decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'], rationale: '', policy_version: DISCOVERY_SETTLEMENT_POLICY_VERSION, policy_hash: POLICY_V1_CONTENT_HASH },
      settlementInputHash: settlement.input_hash, issuedAt: settlement.created_at,
    });
    const expectedHash = hashOutcomeCertificate(certPayload);
    // TOCTOU: another writer changes input_snapshot AFTER service validation
    // but BEFORE BEGIN IMMEDIATE, leaving input_hash unchanged.
    db.prepare('UPDATE factory_discovery_settlements SET input_snapshot=? WHERE id=?')
      .run('{"tampered":true}', settlement.id);
    const { SqliteFactoryDiscoveryRuntime } = await import('../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js');
    const rt = new SqliteFactoryDiscoveryRuntime();
    let threw = false;
    try {
      rt.issueCertificateAtomically({
        settlementId: settlement.id, epicId: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
        readinessAssessmentId: 7, readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
        policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION, policyHash: POLICY_V1_CONTENT_HASH,
        decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], inputHash: settlement.input_hash,
        certificatePayload: certPayload, expectedCertificateHash: expectedHash, issuedAt: settlement.created_at,
        inputSnapshotText: snapshotText, rationale,
      });
    } catch (e) {
      threw = true;
      assert.match(e.message, /input_snapshot does not match|input_snapshot hash does not match/i);
    }
    assert.ok(threw, 'atomic issuance must reject a tampered input_snapshot');
    // Certificate must NOT have been inserted; settlement stays computed.
    const cert = readCertificateForSettlement(db, settlement.id);
    assert.equal(cert, null);
    const s = db.prepare('SELECT status FROM factory_discovery_settlements WHERE id=?').get(settlement.id);
    assert.equal(s.status, 'computed');
  } finally {
    cleanup(temp);
  }
});

test('atomic reconcile: settlement.rationale changed -> reconcile rejected, status stays computed', async () => {
  const { temp, db } = fixture();
  try {
    const { record: settlement, snapshotText, rationale } = seedComputedSettlement(db);
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
      readinessStatus: 'accepted_by_kernel', readinessAssessmentId: 7, readinessContentHash: 'b'.repeat(64),
      decision: { decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'], rationale: '', policy_version: DISCOVERY_SETTLEMENT_POLICY_VERSION, policy_hash: POLICY_V1_CONTENT_HASH },
      settlementInputHash: settlement.input_hash, issuedAt: settlement.created_at,
    });
    const expectedHash = hashOutcomeCertificate(certPayload);
    const { SqliteFactoryDiscoveryRuntime } = await import('../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js');
    const rt = new SqliteFactoryDiscoveryRuntime();
    // First: issue the certificate successfully.
    rt.issueCertificateAtomically({
      settlementId: settlement.id, epicId: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
      readinessAssessmentId: 7, readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
      policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION, policyHash: POLICY_V1_CONTENT_HASH,
      decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], inputHash: settlement.input_hash,
      certificatePayload: certPayload, expectedCertificateHash: expectedHash, issuedAt: settlement.created_at,
      inputSnapshotText: snapshotText, rationale,
    });
    // Simulate a crash: reset settlement to 'computed' (cert still present).
    db.prepare("UPDATE factory_discovery_settlements SET status='computed' WHERE id=?").run(settlement.id);
    // TOCTOU: change rationale before the reconcile tx.
    db.prepare('UPDATE factory_discovery_settlements SET rationale=? WHERE id=?').run('TAMPERED', settlement.id);
    let threw = false;
    try {
      rt.reconcileExistingCertificate({
        settlementId: settlement.id, epicId: 10, proposalId: 50, proposalContentHash: 'a'.repeat(64),
        readinessAssessmentId: 7, readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
        policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION, policyHash: POLICY_V1_CONTENT_HASH,
        decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], inputHash: settlement.input_hash,
        certificatePayload: certPayload, expectedCertificateHash: expectedHash, issuedAt: settlement.created_at,
        inputSnapshotText: snapshotText, rationale,
      });
    } catch (e) {
      threw = true;
      assert.match(e.message, /rationale/i);
    }
    assert.ok(threw, 'reconcile must reject a tampered rationale');
    // Settlement must stay computed (reconcile rolled back).
    const s = db.prepare('SELECT status FROM factory_discovery_settlements WHERE id=?').get(settlement.id);
    assert.equal(s.status, 'computed');
  } finally {
    cleanup(temp);
  }
});
