/**
 * D5 controlled end-to-end REJECT smoke.
 *
 * Uses the real D4 settlement service to issue an authoritative REJECT
 * certificate, then the real D5 diagnosis service + atomic repository to accept
 * a diagnosis grounded in PASSED reject-branch conditions. Only the LM process
 * is replaced by a deterministic executor callback. This proves the complete
 * certificate -> case -> bounded worker -> submit -> validation -> projection
 * path and preserves the D4 rows byte-identically.
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
const {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  READINESS_DIMENSIONS,
} = await import('../../dist/saga3/domain/discovery-readiness-assessment.js');
const { canonicalJson } = await import('../../dist/saga3/shared/discovery-canonical.js');
const { ensureSaga3ReadinessSchema } = await import('../../dist/saga3/persistence/saga3-readiness-repository.js');
const { ensureSaga3SettlementSchema } = await import('../../dist/saga3/persistence/saga3-settlement-repository.js');
const { Saga3DiscoverySettlementService } = await import('../../dist/saga3/application/discovery-settlement-service.js');
const { Saga3DiscoveryDiagnosisService } = await import('../../dist/saga3/application/discovery-diagnosis-service.js');
const { SqliteSaga3DiscoveryRuntime } = await import('../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js');
const {
  fakeWorkAssignment,
  fakeIdGenerator,
  TEST_MACHINE_ID,
} = await import('./_conveyor-fakes.mjs');
const { DISCOVERY_DIAGNOSIS_REPORT_SCHEMA } = await import('../../dist/saga3/domain/discovery-diagnosis-report.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-reject-smoke-'));
  process.env.DB_PATH = path.join(temp, 'reject-smoke.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'Reject smoke')`).run();
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

function snapshotD4(db) {
  const tables = [
    'saga3_proposals',
    'saga3_readiness_assessments',
    'saga3_discovery_settlements',
    'saga3_discovery_outcome_certificates',
  ];
  return Object.fromEntries(tables.map(table => [
    table,
    JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()),
  ]));
}

function assertSnapshotEqual(db, before) {
  for (const [table, value] of Object.entries(before)) {
    assert.equal(
      JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()),
      value,
      `D5 must not mutate D4 table ${table}`,
    );
  }
}

test('D5 controlled smoke C: real D4 REJECT -> real D5 accepted diagnosis', async () => {
  const { temp, db } = fixture();
  try {
    const proposal = {
      problem_statement: 'The candidate scope violates a mandatory safety constraint.',
      observed_context: 'The constraint cannot be mitigated inside the proposed scope.',
      stakeholders_or_actors: ['safety owner'],
      assumptions: ['mandatory constraint is authoritative'],
      unknowns: [],
      risks: ['unsafe delivery'],
      candidate_scope: 'unsafe scope',
      evidence_refs: ['artifact:safety-constraint'],
      recommended_outcome: 'reject',
      rationale: 'The worker found a grounded blocking incompatibility.',
    };
    const proposalHash = createHash('sha256').update(canonicalJson(proposal)).digest('hex');
    const dimensions = {};
    for (const dimension of READINESS_DIMENSIONS) {
      dimensions[dimension] = {
        status: 'sufficient',
        rationale: 'The negative conclusion is grounded.',
        source_refs: ['$.problem_statement'],
      };
    }
    const assessment = {
      proposal_id: 50,
      proposal_content_hash: proposalHash,
      overall_readiness: 'not_ready',
      dimension_assessments: dimensions,
      blocking_gaps: [{
        code: 'SAFETY_CONSTRAINT',
        description: 'Mandatory safety constraint is incompatible with the proposed scope.',
        source_refs: ['$.problem_statement'],
      }],
      non_blocking_gaps: [],
      recommended_next_action: 'reject',
      confidence: 0.95,
      rationale: 'Worker and advisor agree on a grounded rejection.',
    };
    const assessmentHash = createHash('sha256').update(canonicalJson(assessment)).digest('hex');

    db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discover','done','discovery.work')`).run();
    db.prepare(
      `INSERT INTO saga3_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status)
       VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
    ).run(DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA);
    db.prepare(
      `INSERT INTO saga3_proposals
         (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
       VALUES (50,1,100,'product-exec','discovery',?,?,?,?,?)`,
    ).run(DISCOVERY_PROPOSAL_SCHEMA, canonicalJson(proposal), proposalHash, 'submitted', '{}');

    db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`).run();
    db.prepare(
      `INSERT INTO saga3_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status)
       VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
    ).run(DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
    db.prepare(
      `INSERT INTO saga3_readiness_control_intents
         (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,authority_intent_id,projected_task_id,status)
       VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?,'concluded')`,
    ).run(50, proposalHash, 1, 2, 200);
    db.prepare(
      `INSERT INTO saga3_readiness_assessments
         (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,payload,content_hash,status,
          overall_readiness,recommended_next_action,validation_errors,provenance)
       VALUES (7,1,50,?,200,'advisor-exec',?,?,'accepted_by_kernel','not_ready','reject','[]','{}')`,
    ).run(proposalHash, canonicalJson(assessment), assessmentHash);

    const runtime = new SqliteSaga3DiscoveryRuntime();
    const settlementService = new Saga3DiscoverySettlementService({ runtimePersistence: runtime });
    const settlement = await settlementService.settle({
      projectId: 1,
      epicId: 10,
      proposalId: 50,
      proposalHash,
      readiness: {
        status: 'completed', authority: 'shadow_advisor',
        assessmentId: 7, assessmentHash,
        overallReadiness: 'not_ready', recommendedNextAction: 'reject', error: null,
      },
    });
    assert.equal(settlement.status, 'issued');
    assert.equal(settlement.decision, 'reject');
    assert.deepEqual(settlement.reasonCodes, ['REJECT_WORKER_AND_ADVISOR_AGREE']);
    const before = snapshotD4(db);

    let starts = 0;
    let injected = false;
    const executor = {
      start() { starts += 1; },
      status(projectId) {
        if (!injected) {
          injected = true;
          const control = runtime.readDiagnosisControlForTarget(
            settlement.certificateId,
            settlement.certificateHash,
          );
          assert.ok(control, 'diagnosis control must exist before worker poll');
          const diagnosisCase = JSON.parse(control.diagnosis_case);
          const rejectGrounds = diagnosisCase.policy_trace
            .filter(node => node.branch === 'reject' && node.evaluation === 'passed' && node.contributed_to_decision)
            .map(node => node.condition_id);
          assert.ok(rejectGrounds.length >= 5, 'reject trace must contain passed supporting grounds');
          const report = {
            schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
            target: {
              certificate_id: settlement.certificateId,
              certificate_hash: settlement.certificateHash,
              settlement_input_hash: diagnosisCase.certificate.settlement_input_hash,
              decision: 'reject',
            },
            executive_summary: 'The kernel rejected the proposal because worker and advisor coherently agree on grounded blocking conditions.',
            cause_analysis: [{
              cause_id: 'REJECT-1',
              category: 'blocking_gap',
              description: 'A mandatory safety constraint blocks the proposed scope.',
              severity: 'blocking',
              reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
              cited_condition_ids: rejectGrounds,
              source_refs: ['certificate:' + settlement.certificateId, '$.problem_statement'],
            }],
            information_requests: [],
            recommended_actions: [{
              action_id: 'ACTION-1',
              action: 'revise_scope',
              description: 'Create a new scope that satisfies the mandatory safety constraint before repeating discovery.',
              resolves_cause_ids: ['REJECT-1'],
              source_refs: ['$.candidate_scope'],
            }],
            residual_risks: [],
            confidence: 0.95,
          };
          const submitted = runtime.submitDiagnosisReportAtomically({
            controlIntentId: control.id,
            executionId: 'reject-diagnosis-exec',
            payload: report,
            provenance: { worker_id: 'controlled-reject-worker', execution_id: 'reject-diagnosis-exec' },
          });
          assert.equal(submitted.record.status, 'accepted_by_kernel');
          db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
        }
        return {
          id: 'reject-diagnosis-run', project_id: projectId, concurrency: 1,
          status: 'running', active: [], completed: 1, failed: 0, claimed: 1,
        };
      },
      setConcurrency() {}, stop() {}, dispose() {},
    };
    const diagnosisService = new Saga3DiscoveryDiagnosisService({
      config: { dbPath: process.env.DB_PATH, claudePath: 'claude', lmStudioUrl: 'http://x/v1' },
      workerExecutorFactory: () => executor,
      host: { processId: 42, workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' } },
      runtimePersistence: runtime,
      workAssignment: fakeWorkAssignment(),
      idGenerator: fakeIdGenerator(),
      machineId: TEST_MACHINE_ID,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      sleep: async () => {}, pollMs: 0, maxRunSeconds: 60,
    });
    const result = await diagnosisService.diagnose({
      projectId: 1,
      epicId: 10,
      certificateId: settlement.certificateId,
      certificateHash: settlement.certificateHash,
      workspaceRoot: '/w',
      heartbeat: () => {},
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.authority, 'advisory_diagnosis');
    assert.deepEqual(result.blockingGaps, ['REJECT-1']);
    assert.equal(starts, 1);
    assertSnapshotEqual(db, before);

    const restart = await diagnosisService.diagnose({
      projectId: 1, epicId: 10,
      certificateId: settlement.certificateId,
      certificateHash: settlement.certificateHash,
      workspaceRoot: '/w', heartbeat: () => {},
    });
    assert.equal(restart.status, 'completed');
    assert.equal(restart.reportId, result.reportId);
    assert.equal(restart.reportHash, result.reportHash);
    assert.equal(starts, 1, 'restart must not respawn the controlled worker');
    assertSnapshotEqual(db, before);
  } finally {
    cleanup(temp);
  }
});
