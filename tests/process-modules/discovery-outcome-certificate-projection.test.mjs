// P3b tests: Discovery outcome certificate projection.
//
// Verifies the projection reads Discovery D4 certificates and re-shapes them
// into the generic ProcessOutcomeCertificate WITHOUT copying data into the
// generic table. The discovery table remains the source of truth.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  DiscoveryOutcomeCertificateProjection,
  DISCOVERY_GENERIC_CERTIFICATE_SCHEMA_VERSION,
} = await import(
  '../../dist/process-modules/modules/discovery/discovery-outcome-certificate-projection.js'
);
const {
  SqliteProcessOutcomeCertificateRepository,
} = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);

const P64 = 'p'.repeat(64);
const Y64 = 'y'.repeat(64);
const I64 = 'i'.repeat(64);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-discproj-'));
  process.env.DB_PATH = path.join(temp, 'proj.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,execution_mode,generation_key,tags,metadata)
              VALUES (1,10,'D','done','high','discovery.work','discovery','saga-discovery-worker','tracker_only','g','[]','{}')`).run();
  db.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,status)
              VALUES (1,10,'discovery','obj','{}','saga3.discovery-proposal.v1','concluded')`).run();
  db.prepare(`INSERT INTO saga3_proposals
    (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
    VALUES (1,1,1,'exec-1','discovery','saga3.discovery-proposal.v1','{}',?,'superseded','{}')`)
    .run(P64);
  db.prepare(`INSERT INTO saga3_discovery_settlements
    (id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,readiness_assessment_hash,
     policy_version,policy_hash,input_snapshot,input_hash,decision,reason_codes,rationale,status,created_at)
    VALUES (1,10,1,?,NULL,'none','1.0.0',?, '{}',?, 'go','[]','ok','certificate_issued','2026-01-01')`)
    .run(P64, Y64, I64);
  const payload = {
    schemaVersion: 'saga3.discovery-outcome-certificate.v1',
    decision: 'go', reasonCodes: [], rationale: 'good',
    certificateId: 1, settlementId: 1, proposalId: 1,
  };
  const certHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  db.prepare(`INSERT INTO saga3_discovery_outcome_certificates
    (id,settlement_id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,
     readiness_assessment_hash,policy_version,policy_hash,decision,reason_codes,input_hash,
     certificate_payload,certificate_hash,issued_at)
    VALUES (1,1,10,1,?,NULL,'none','1.0.0',?, 'go','[]',?, ?,?, '2026-01-01')`)
    .run(P64, Y64, I64, JSON.stringify(payload), certHash);
  return { temp, db };
}
function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('projection reads a discovery certificate and reshapes it to the generic shape', () => {
  const { temp, db } = fixture();
  try {
    const proj = new DiscoveryOutcomeCertificateProjection(db);
    const cert = proj.read(1, 1);
    assert.ok(cert);
    assert.equal(cert.moduleRefKey, 'product-discovery@3.0.1');
    assert.equal(cert.decision, 'go');
    assert.equal(cert.schemaVersion, DISCOVERY_GENERIC_CERTIFICATE_SCHEMA_VERSION);
    assert.equal(cert.authority, 'discovery_settlement_policy');
    assert.equal(cert.certificateHash.length, 64);
    assert.equal(cert.processRunId, -1, 'projection uses negative id namespace');
    assert.equal(cert.epicId, 10);
    assert.equal(cert.projectId, 1);
    // The payload preserves the discovery certificate's data verbatim.
    assert.equal(cert.certificatePayload.decision, 'go');
    assert.equal((cert.certificatePayload.payload).settlementId, 1);
  } finally { cleanup(temp); }
});

test('projection read returns null for an unknown certificate id', () => {
  const { temp, db } = fixture();
  try {
    const proj = new DiscoveryOutcomeCertificateProjection(db);
    assert.equal(proj.read(99999, 1), null);
  } finally { cleanup(temp); }
});

test('projection readByEpic returns the latest discovery certificate for an epic', () => {
  const { temp, db } = fixture();
  try {
    const proj = new DiscoveryOutcomeCertificateProjection(db);
    const cert = proj.readByEpic(10, 1);
    assert.ok(cert);
    assert.equal(cert.id, 1);
    // Epic with no certificate returns null.
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (99,1,'Empty')`).run();
    assert.equal(proj.readByEpic(99, 1), null);
  } finally { cleanup(temp); }
});

test('projection does NOT write to the generic certificate table', () => {
  // The whole point of P3b: discovery certificates are projected, never copied.
  // After reading through the projection, the generic table must still be empty.
  const { temp, db } = fixture();
  try {
    const proj = new DiscoveryOutcomeCertificateProjection(db);
    proj.read(1, 1);
    proj.readByEpic(10, 1);
    const genericRepo = new SqliteProcessOutcomeCertificateRepository(db);
    assert.equal(genericRepo.list(1, null).length, 0);
  } finally { cleanup(temp); }
});
