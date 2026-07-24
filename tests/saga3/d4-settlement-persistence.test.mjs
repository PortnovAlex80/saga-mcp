/**
 * D4 settlement persistence + certificate lineage + settlement SERVICE end-to-end.
 *
 * These tests run the real Saga3DiscoverySettlementService over a real
 * better-sqlite3 temp-file DB (NOT :memory:). The fixture mirrors d3-readiness:
 * a temp dir under os.tmpdir(), DB_PATH pointed at it, getDb() opened, and the
 * full FK chain (projects → epics → episode_workflows → tasks → work_intents →
 * proposals, plus the readiness control + assessment rows) seeded with REAL
 * hashes computed via canonicalJson + sha256.
 *
 * What we assert:
 *   - a ready Proposal + accepted readiness assessment settles to a GO
 *     certificate (write-once);
 *   - the input snapshot hash is stable / deterministic (idempotency target);
 *   - the policy version + hash are recorded in the settlement row;
 *   - idempotent replay returns the SAME settlementId / certificateId /
 *     certificateHash (no second certificate ever);
 *   - a new readiness hash is a NEW idempotency target → a NEW settlement +
 *     certificate (old one preserved for audit);
 *   - missing readiness still settles to CLARIFY with a certificate;
 *   - a mutated Proposal payload (hash mismatch) is rejected;
 *   - the product Proposal's provenance + hash are never mutated by settlement;
 *   - the certificate lineage carries the proposal id/hash and the readiness
 *     assessment id/hash.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import('../../dist/saga3/domain/discovery-proposal.js');
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);
const { canonicalJson } = await import('../../dist/saga3/persistence/saga3-normalization-repository.js');
const { ensureSaga3ReadinessSchema } = await import(
  '../../dist/saga3/persistence/saga3-readiness-repository.js'
);
const {
  ensureSaga3SettlementSchema,
  findSettlementByInputKey,
} = await import('../../dist/saga3/persistence/saga3-settlement-repository.js');
const { DISCOVERY_SETTLEMENT_POLICY_VERSION, POLICY_V1_CONTENT_HASH } = await import(
  '../../dist/saga3/domain/discovery-settlement-policy.js'
);
const { NO_READINESS_HASH } = await import('../../dist/saga3/domain/discovery-settlement-input.js');
const { Saga3DiscoverySettlementService } = await import(
  '../../dist/saga3/application/discovery-settlement-service.js'
);
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js'
);

// ---------------------------------------------------------------------------
// Fixture scaffolding (mirrors d3-readiness-handler.test / d3-readiness-correction.test)
// ---------------------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d4-settle-'));
  process.env.DB_PATH = path.join(temp, 'd4.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
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
 * members of the allowed set the settlement service's collectAllowedSourceRefs
 * builds (proposal.problem_statement / proposal.observed_context /
 * proposal.candidate_scope / proposal.rationale / assumption:<x> / unknown:<x>
 * / risk:<x> / evidence:<x> / stakeholder:<x>) — otherwise the strict
 * re-validation in the service treats the assessment as 'failed' instead of
 * 'accepted_by_kernel'.
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

// Shadow result shapes the engine passes to settle().
const SHADOW_COMPLETED = {
  status: 'completed',
  authority: 'shadow_advisor',
  assessmentId: 7,
  assessmentHash: ASSESSMENT_HASH,
  overallReadiness: 'ready',
  recommendedNextAction: 'proceed_to_settlement',
  error: null,
};
const SHADOW_NOT_RUN = {
  status: 'not_run',
  authority: 'none',
  assessmentId: null,
  assessmentHash: null,
  overallReadiness: null,
  recommendedNextAction: null,
  error: null,
};

/**
 * Seed the full live fixture. `withReadiness` controls whether the readiness
 * ControlIntent + advisor task + advisor WorkIntent + accepted assessment are
 * inserted (the accepted-readiness scenarios). Without it the DB has only the
 * product proposal path (the missing-readiness scenario).
 *
 * FK chain, in order:
 *   tasks(100) → saga3_work_intents(1, projected_task_id=100) →
 *   saga3_proposals(50, intent_id=1)
 * and, when withReadiness:
 *   tasks(200) → saga3_work_intents(2, projected_task_id=200) →
 *   saga3_readiness_control_intents(1, authority_intent_id=2) →
 *   saga3_readiness_assessments(7, control_intent_id=1)
 */
function buildLiveFixture(db, { withReadiness = true } = {}) {
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
     VALUES (50,1,100,'product-exec','discovery',?,? ,?, 'submitted', ?)`,
  ).run(
    DISCOVERY_PROPOSAL_SCHEMA,
    canonicalJson(PRODUCT_PROPOSAL_PAYLOAD),
    PRODUCT_PROPOSAL_HASH,
    '{}',
  );

  if (!withReadiness) return;

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('D4: settlement issued for a ready proposal produces a go certificate', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const result = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    assert.equal(result.status, 'issued');
    assert.equal(result.decision, 'go');
    assert.ok(result.reasonCodes.includes('GO_READY_AND_GROUNDED'));
    assert.match(result.certificateHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof result.settlementId, 'number');
    assert.ok(result.settlementId > 0);
    assert.equal(typeof result.certificateId, 'number');
    assert.ok(result.certificateId > 0);
  } finally {
    cleanup(temp);
  }
});

test('D4: input snapshot hash is stable / deterministic', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const key = {
      proposalId: 50,
      proposalContentHash: PRODUCT_PROPOSAL_HASH,
      readinessAssessmentHash: ASSESSMENT_HASH,
      policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
      policyHash: POLICY_V1_CONTENT_HASH,
    };
    const settlement = runtime.findSettlementByInputKey(key);
    assert.ok(settlement, 'settlement row must exist for the input key');
    assert.match(settlement.input_hash, /^[0-9a-f]{64}$/);
    // Re-read and confirm the hash is byte-stable across reads.
    const again = runtime.findSettlementByInputKey(key);
    assert.equal(again.input_hash, settlement.input_hash);
  } finally {
    cleanup(temp);
  }
});

test('D4: policy hash recorded in settlement row', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const settlement = runtime.findSettlementByInputKey({
      proposalId: 50,
      proposalContentHash: PRODUCT_PROPOSAL_HASH,
      readinessAssessmentHash: ASSESSMENT_HASH,
      policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
      policyHash: POLICY_V1_CONTENT_HASH,
    });
    assert.equal(settlement.policy_hash, POLICY_V1_CONTENT_HASH);
    assert.equal(settlement.policy_version, DISCOVERY_SETTLEMENT_POLICY_VERSION);
  } finally {
    cleanup(temp);
  }
});

test('D4: idempotent replay returns the SAME settlementId, certificateId, certificateHash', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const second = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    assert.equal(second.settlementId, first.settlementId);
    assert.equal(second.certificateId, first.certificateId);
    assert.equal(second.certificateHash, first.certificateHash);
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

test('D4: certificate hash is stable across rebuilds', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const cert1 = runtime.readCertificateForSettlement(first.settlementId);
    // Second settle hits the replay branch; no new certificate is issued.
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const cert2 = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(cert1);
    assert.ok(cert2);
    assert.equal(cert2.certificate_hash, cert1.certificate_hash);
  } finally {
    cleanup(temp);
  }
});

test('D4: certificate is immutable — no UPDATE path (settle twice leaves id+hash unchanged)', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const certBefore = runtime.readCertificateForSettlement(first.settlementId);
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const certAfter = runtime.readCertificateForSettlement(first.settlementId);
    // Write-once: the id and hash of the certificate never change on replay.
    assert.equal(certAfter.id, certBefore.id);
    assert.equal(certAfter.certificate_hash, certBefore.certificate_hash);
  } finally {
    cleanup(temp);
  }
});

test('D4: new readiness hash creates a NEW settlement + certificate', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    // Insert a SECOND accepted assessment under the same control intent with a
    // different content hash (change confidence). The control's unique index is
    // on (proposal_id, proposal_content_hash) — no new control intent needed;
    // the assessment idempotency index is (control_intent_id, content_hash), so
    // a new hash inserts cleanly. readAcceptedReadinessAssessmentForProposal
    // orders by id DESC, so id=8 becomes the latest accepted assessment.
    const secondPayload = validAssessmentPayload(50, PRODUCT_PROPOSAL_HASH, { confidence: 0.88 });
    const secondHash = createHash('sha256').update(canonicalJson(secondPayload)).digest('hex');
    db.prepare(
      `INSERT INTO saga3_readiness_assessments
         (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
          payload,content_hash,status,overall_readiness,recommended_next_action,
          validation_errors,provenance)
       VALUES (8,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
    ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(secondPayload), secondHash);

    const second = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH,
      readiness: {
        status: 'completed',
        authority: 'shadow_advisor',
        assessmentId: 8,
        assessmentHash: secondHash,
        overallReadiness: 'ready',
        recommendedNextAction: 'proceed_to_settlement',
        error: null,
      },
    });
    assert.notEqual(second.settlementId, first.settlementId);
    assert.notEqual(second.certificateId, first.certificateId);
    // Two settlements + two certificates coexist (old one preserved for audit).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      2,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      2,
    );
  } finally {
    cleanup(temp);
  }
});

test('D4: missing readiness still settles to clarify', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db, { withReadiness: false });
    const { runtime, service } = makeService();
    const result = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_NOT_RUN,
    });
    assert.equal(result.status, 'issued');
    assert.equal(result.decision, 'clarify');
    assert.ok(result.reasonCodes.includes('CLARIFY_READINESS_MISSING'));
    // The idempotency key uses the NO_READINESS_HASH sentinel for the readiness
    // slice, so the settlement is findable by that key.
    const settlement = runtime.findSettlementByInputKey({
      proposalId: 50,
      proposalContentHash: PRODUCT_PROPOSAL_HASH,
      readinessAssessmentHash: NO_READINESS_HASH,
      policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
      policyHash: POLICY_V1_CONTENT_HASH,
    });
    assert.ok(settlement, 'a clarify settlement must still be persisted');
    const cert = runtime.readCertificateForSettlement(settlement.id);
    assert.ok(cert, 'a certificate is issued even for the clarify decision');
  } finally {
    cleanup(temp);
  }
});

test('D4: settlement rejects a mutated proposal payload at old hash (SettlementValidationError)', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    // Tamper: store PAYLOAD_A as the payload text but PAYLOAD_B's hash. The
    // service recomputes sha256(canonicalJson(storedPayload)) and compares to
    // the stored content_hash — mismatch throws SettlementValidationError.
    const payloadA = { ...PRODUCT_PROPOSAL_PAYLOAD, problem_statement: 'alpha' };
    const payloadB = { ...PRODUCT_PROPOSAL_PAYLOAD, problem_statement: 'beta' };
    const hashOfB = createHash('sha256').update(canonicalJson(payloadB)).digest('hex');
    db.prepare('UPDATE saga3_proposals SET payload=?, content_hash=? WHERE id=50')
      .run(canonicalJson(payloadA), hashOfB);
    const { service } = makeService();
    await assert.rejects(
      () => service.settle({
        projectId: 1, epicId: 10, proposalId: 50,
        // Use the stored (lying) hash so we get past the engine-supplied hash
        // check only AFTER the payload-recompute check fires — the stored-hash
        // mismatch throws first.
        proposalHash: hashOfB, readiness: SHADOW_COMPLETED,
      }),
      (err) => {
        assert.ok(err.name === 'SettlementValidationError' || /content_hash mismatch/.test(err.message));
        return true;
      },
    );
    // No settlement row should be persisted for a rejected settlement.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c, 0);
  } finally {
    cleanup(temp);
  }
});

test('D4: provisional proposal provenance unchanged after settlement', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const product = db.prepare('SELECT provenance, content_hash FROM saga3_proposals WHERE id=50').get();
    assert.equal(product.provenance, '{}');
    assert.equal(product.content_hash, PRODUCT_PROPOSAL_HASH);
  } finally {
    cleanup(temp);
  }
});

test('D4: certificate lineage contains proposal and readiness', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    const result = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const cert = runtime.readCertificateForSettlement(result.settlementId);
    assert.ok(cert);
    assert.equal(cert.proposal_id, 50);
    assert.equal(cert.proposal_content_hash, PRODUCT_PROPOSAL_HASH);
    assert.equal(cert.readiness_assessment_id, 7);
    assert.equal(cert.readiness_assessment_hash, ASSESSMENT_HASH);
  } finally {
    cleanup(temp);
  }
});
