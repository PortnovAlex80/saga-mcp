/**
 * D4 settlement persistence + certificate lineage + settlement SERVICE end-to-end.
 *
 * CORRECTED for the D4 settlement contract revision. The four contract changes
 * this test file reflects:
 *
 *   1. The saga3_proposals row must carry kind/schema_version/status columns and
 *      the project_id (resolved via epic → project) must match the request; the
 *      service does EXACT target binding (kind==='discovery',
 *      schema_version===DISCOVERY_PROPOSAL_SCHEMA, status==='submitted',
 *      epic_id===request.epicId, project_id===request.projectId).
 *   2. Readiness is read by EXACT assessment id (readReadinessAssessment(id)),
 *      NOT "latest accepted for proposal". settle() is called with
 *      readiness.assessmentId pointing at the seeded assessment.
 *   3. The idempotency key uses the ENCODED readinessTarget string
 *      ('accepted:<hash>' | 'missing' | 'failed' | 'paused'), not a
 *      readinessAssessmentHash column.
 *   4. The settle() result is a DISCRIMINATED UNION on `status`. When 'issued',
 *      decision / certificateId / certificateHash are non-null.
 *
 * These tests run the real Saga3DiscoverySettlementService over a real
 * better-sqlite3 temp-file DB. The fixture mirrors d3-readiness: a temp dir
 * under os.tmpdir(), DB_PATH pointed at it, getDb() opened, and the full FK
 * chain (projects → epics → episode_workflows → tasks → work_intents →
 * proposals, plus the readiness control + assessment rows) seeded with REAL
 * hashes computed via canonicalJson + sha256.
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
const { canonicalJson } = await import('../../dist/saga3/shared/discovery-canonical.js');
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
const { Saga3DiscoverySettlementService, SettlementValidationError } = await import(
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
  // An extra epic (11) under the same project, used by the cross-epic rejection test.
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
 * non-empty evidence_ref (the GO predicate requires it now, independent of the
 * advisor's evidence_grounding verdict).
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
 * members of the allowed set produced by collectDiscoverySourceRefs
 * (`proposal:<id>` / `$.<field>` / `$.evidence_refs[<i>]` + the literal evidence
 * string / `raw:<id>` / `normalization:<id>`). The shared canonical helper now
 * lists every payload key as `$.<key>`, so `$.problem_statement` is always
 * allowed — we cite it on every dimension.
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

// Shadow result shapes the engine passes to settle(). These mirror
// ReadinessShadowResult (status, authority, assessmentId, assessmentHash,
// overallReadiness, recommendedNextAction, error).
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
const SHADOW_FAILED = {
  status: 'failed',
  authority: 'shadow_advisor',
  assessmentId: null,
  assessmentHash: null,
  overallReadiness: null,
  recommendedNextAction: null,
  error: 'advisor crashed',
};

/** Encoded readinessTarget string for an accepted assessment. */
const ACCEPTED_TARGET = `accepted:${ASSESSMENT_HASH}`;

/** Build the canonical idempotency key for a given encoded readiness target. */
function inputKey(readinessTarget) {
  return {
    proposalId: 50,
    proposalContentHash: PRODUCT_PROPOSAL_HASH,
    readinessTarget,
    policyVersion: DISCOVERY_SETTLEMENT_POLICY_VERSION,
    policyHash: POLICY_V1_CONTENT_HASH,
  };
}

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
 *
 * The saga3_proposals INSERT carries the kind/schema_version/status columns the
 * corrected contract reads; 10 columns vs 10 placeholders (verified by the
 * prepared-statement bind).
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
  // Columns (10): id, intent_id, task_id, execution_id, kind, schema_version,
  //               payload, content_hash, status, provenance.
  // Placeholders (10): one per non-literal column.
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

/** Insert a second accepted assessment (id `id`, hash computed from `payload`). */
function insertAcceptedAssessment(db, id, payload, hash) {
  db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action,
        validation_errors,provenance)
     VALUES (?,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
  ).run(id, PRODUCT_PROPOSAL_HASH, canonicalJson(payload), hash);
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
    // Discriminated union: issued carries the non-null identity/decision fields.
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
    const { service } = makeService();
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    // Idempotency key uses readinessTarget: 'accepted:<hash>'.
    const settlement = findSettlementByInputKey(db, inputKey(ACCEPTED_TARGET));
    assert.ok(settlement, 'settlement row must exist for the input key');
    assert.match(settlement.input_hash, /^[0-9a-f]{64}$/);
    // Re-read and confirm the hash is byte-stable across reads.
    const again = findSettlementByInputKey(db, inputKey(ACCEPTED_TARGET));
    assert.equal(again.input_hash, settlement.input_hash);
  } finally {
    cleanup(temp);
  }
});

test('D4: policy hash recorded in settlement row', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const settlement = findSettlementByInputKey(db, inputKey(ACCEPTED_TARGET));
    assert.ok(settlement);
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

test('D4: certificate is immutable — settle twice leaves id+hash unchanged', async () => {
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
    // different content hash (change confidence). A new hash is a new assessment
    // idempotency target (idx on (control_intent_id, content_hash)) so it
    // inserts cleanly. The settlement reads the EXACT id the engine supplies, so
    // id=8 becomes the new target for this run.
    const secondPayload = validAssessmentPayload(50, PRODUCT_PROPOSAL_HASH, { confidence: 0.88 });
    const secondHash = createHash('sha256').update(canonicalJson(secondPayload)).digest('hex');
    insertAcceptedAssessment(db, 8, secondPayload, secondHash);

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
    // The idempotency key for a missing assessment uses readinessTarget='missing'.
    const settlement = findSettlementByInputKey(db, inputKey('missing'));
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
    // The certificate stores the ENCODED readiness target
    // ('accepted:<hash>'), not the bare assessment hash.
    assert.equal(cert.readiness_assessment_hash, ACCEPTED_TARGET);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// NEW tests for the D4 settlement contract correction
// ---------------------------------------------------------------------------

test('D4 correction: GO with empty evidence_refs produces clarify / CLARIFY_EVIDENCE_INSUFFICIENT', async () => {
  const { temp, db } = fixture();
  try {
    // Proposal with NO evidence — the GO predicate requires at least one
    // non-empty evidence_ref (manifest.go.proposal_evidence_min = 1), even when
    // the advisor's evidence_grounding dimension is 'sufficient'.
    const emptyEvidencePayload = { ...PRODUCT_PROPOSAL_PAYLOAD, evidence_refs: [] };
    const emptyEvidenceHash = createHash('sha256').update(canonicalJson(emptyEvidencePayload)).digest('hex');
    buildLiveFixture(db, { withReadiness: false });
    db.prepare('UPDATE saga3_proposals SET payload=?, content_hash=? WHERE id=50')
      .run(canonicalJson(emptyEvidencePayload), emptyEvidenceHash);
    // Seed an accepted assessment bound to THIS proposal hash, then read it by id 7.
    const assessment = validAssessmentPayload(50, emptyEvidenceHash);
    const assessmentHash = createHash('sha256').update(canonicalJson(assessment)).digest('hex');
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
    ).run(50, emptyEvidenceHash, 1, 2, 200);
    db.prepare(
      `INSERT INTO saga3_readiness_assessments
         (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
          payload,content_hash,status,overall_readiness,recommended_next_action,
          validation_errors,provenance)
       VALUES (7,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
    ).run(emptyEvidenceHash, canonicalJson(assessment), assessmentHash);

    const { service } = makeService();
    const result = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: emptyEvidenceHash,
      readiness: {
        status: 'completed',
        authority: 'shadow_advisor',
        assessmentId: 7,
        assessmentHash,
        overallReadiness: 'ready',
        recommendedNextAction: 'proceed_to_settlement',
        error: null,
      },
    });
    assert.equal(result.status, 'issued');
    assert.equal(result.decision, 'clarify');
    assert.ok(
      result.reasonCodes.includes('CLARIFY_EVIDENCE_INSUFFICIENT'),
      `expected CLARIFY_EVIDENCE_INSUFFICIENT in ${JSON.stringify(result.reasonCodes)}`,
    );
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: cross-epic proposal is rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    // The proposal belongs to epic 10; request epicId 11 -> the EXACT target
    // binding must reject.
    await assert.rejects(
      () => service.settle({
        projectId: 1, epicId: 11, proposalId: 50,
        proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
      }),
      (err) => {
        assert.ok(
          err.name === 'SettlementValidationError' || /belongs to epic/.test(err.message),
          `unexpected error: ${err.message}`,
        );
        return true;
      },
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c, 0);
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: wrong proposal kind/schema/status is rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    // Flip the proposal status to 'superseded'. The service rejects any status
    // other than 'submitted'.
    db.prepare('UPDATE saga3_proposals SET status=? WHERE id=50').run('superseded');
    const { service } = makeService();
    await assert.rejects(
      () => service.settle({
        projectId: 1, epicId: 10, proposalId: 50,
        proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
      }),
      (err) => {
        assert.ok(
          err.name === 'SettlementValidationError' || /status/.test(err.message),
          `unexpected error: ${err.message}`,
        );
        return true;
      },
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c, 0);
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: missing then failed readiness produce DIFFERENT settlements', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db, { withReadiness: false });
    const { service } = makeService();
    // First settle: shadow status 'not_run' -> snapshot 'missing', target 'missing'.
    const missing = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_NOT_RUN,
    });
    // Second settle: shadow status 'failed' -> snapshot 'failed', target 'failed'.
    // These are DISTINCT idempotency buckets, so a NEW settlement + certificate
    // must be produced (they never collapse).
    const failed = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_FAILED,
    });
    assert.notEqual(failed.settlementId, missing.settlementId);
    assert.notEqual(failed.certificateId, missing.certificateId);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      2,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      2,
    );
    // The two settlements carry the distinct reason codes too.
    const missingRow = findSettlementByInputKey(db, inputKey('missing'));
    const failedRow = findSettlementByInputKey(db, inputKey('failed'));
    assert.ok(missingRow && failedRow);
    assert.ok(missingRow.reason_codes.includes('CLARIFY_READINESS_MISSING'));
    assert.ok(failedRow.reason_codes.includes('CLARIFY_READINESS_FAILED'));
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: computed settlement crash before certificate -> deterministic recovery', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    // Settle once to produce a baseline issued certificate; capture its hash.
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    const firstCert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(firstCert);

    // Simulate a crash AFTER the settlement row was persisted but BEFORE the
    // certificate was issued: delete the certificate row and roll the settlement
    // back to status='computed' (the in-between state). The next settle() call
    // must deterministically REBUILD the certificate from the STORED snapshot +
    // decision, producing the SAME decision (and a byte-identical certificate,
    // because issued_at is derived from the settlement created_at).
    db.prepare('DELETE FROM saga3_discovery_outcome_certificates WHERE settlement_id=?')
      .run(first.settlementId);
    db.prepare("UPDATE saga3_discovery_settlements SET status='computed' WHERE id=?")
      .run(first.settlementId);

    const recovered = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    assert.equal(recovered.status, 'issued');
    assert.equal(recovered.settlementId, first.settlementId);
    assert.equal(recovered.decision, first.decision);
    assert.deepEqual(recovered.reasonCodes, first.reasonCodes);
    // The rebuilt certificate is byte-identical: certificate_hash is computed
    // over the payload (whose issued_at is the settlement's stable created_at),
    // NOT over the row id. The table uses AUTOINCREMENT, so the rebuilt row may
    // carry a different id — the hash is the "same certificate" proof.
    const rebuiltCert = runtime.readCertificateForSettlement(first.settlementId);
    assert.ok(rebuiltCert);
    assert.equal(rebuiltCert.certificate_hash, firstCert.certificate_hash);
    assert.equal(rebuiltCert.decision, firstCert.decision);
    assert.equal(rebuiltCert.input_hash, firstCert.input_hash);
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: existing certificate payload tampering is rejected', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { runtime, service } = makeService();
    const first = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    // Tamper the persisted certificate payload in place. The next settle() hits
    // the replay branch; verifyExistingCertificate recomputes the hash from the
    // (now tampered) payload and compares to the stored certificate_hash —
    // mismatch throws SettlementValidationError.
    const tamperedPayload = { tampered: true, injected: 'attacker' };
    db.prepare('UPDATE saga3_discovery_outcome_certificates SET certificate_payload=? WHERE settlement_id=?')
      .run(canonicalJson(tamperedPayload), first.settlementId);
    await assert.rejects(
      () => service.settle({
        projectId: 1, epicId: 10, proposalId: 50,
        proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
      }),
      (err) => {
        assert.ok(
          err.name === 'SettlementValidationError' || /certificate_hash does not match/.test(err.message),
          `unexpected error: ${err.message}`,
        );
        return true;
      },
    );
    // The tampered certificate row itself is still present (rejection does not
    // delete audit rows).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

test('D4 correction: recovery uses the STORED readiness status, not the current shadow', async () => {
  const { temp, db } = fixture();
  try {
    buildLiveFixture(db);
    const { service } = makeService();
    // First settle: shadow reports a COMPLETED accepted assessment -> snapshot
    // 'accepted_by_kernel', decision 'go', certificate stored.
    const accepted = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    assert.equal(accepted.decision, 'go');

    // Simulate a crash after the settlement row was committed but before the
    // certificate was issued (delete the cert + reset status to 'computed').
    db.prepare('DELETE FROM saga3_discovery_outcome_certificates WHERE settlement_id=?')
      .run(accepted.settlementId);
    db.prepare("UPDATE saga3_discovery_settlements SET status='computed' WHERE id=?")
      .run(accepted.settlementId);

    // Re-settle with the SAME readiness target (accepted:<hash>). The replay
    // path rebuilds the certificate from the STORED snapshot + decision — never
    // from the current live readiness state. The rebuilt cert carries the
    // STORED accepted decision ('go'), not a fresh computation.
    const replayed = await service.settle({
      projectId: 1, epicId: 10, proposalId: 50,
      proposalHash: PRODUCT_PROPOSAL_HASH, readiness: SHADOW_COMPLETED,
    });
    assert.equal(replayed.status, 'issued');
    assert.equal(replayed.settlementId, accepted.settlementId);
    // The STORED accepted-state decision is what is surfaced.
    assert.equal(replayed.decision, 'go');
    assert.ok(replayed.reasonCodes.includes('GO_READY_AND_GROUNDED'));
    // The rebuilt certificate is byte-identical (issued_at = settlement created_at).
    assert.equal(replayed.certificateHash, accepted.certificateHash);
    // No second settlement was created (the idempotency key matched).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_settlements').get().c,
      1,
    );
    // Exactly one certificate now (the rebuilt one).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_outcome_certificates').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});
