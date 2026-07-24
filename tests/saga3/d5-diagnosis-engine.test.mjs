/**
 * D5 — Advisory Discovery Diagnosis ENGINE integration tests (matrix D1–D10).
 *
 * These tests exercise the engine's D5 diagnosis hook (Deliverable 1) at the
 * `OrchestrationRunResult` boundary. They assert the two decisive invariants:
 *
 *   I1 — D4 remains the ONLY authority. Diagnosis MUST NOT mutate
 *        outcome/outcomeAuthority/scopeCompleted/reason/finalStage.
 *   I5 — Diagnosis failure is isolated. A failed/invalid diagnosis leaves the
 *        D4 result COMPLETE and authoritative; only the advisory diagnosis
 *        section records the failure.
 *
 * Two harnesses are used (mirroring the D4 engine test split):
 *
 *   A. Fake-runtime harness (D1, D2, D3, D8, D9, D10, +backward-compat) — the
 *      same in-memory runtime + fake executor + fake readiness/settlement/
 *      diagnosis services pattern as d4-settlement-engine.test.mjs. These tests
 *      verify the engine's ELIGIBILITY logic (when does diagnosis run?) and its
 *      PROJECTION of the service result into the advisory diagnosis section,
 *      without a real DB. The fake diagnosis service returns canned
 *      `DiscoveryDiagnosisResult` values.
 *
 *   B. Real-SQLite + real-diagnosis-service harness (D4, D5, D6, D7) — a real
 *      better-sqlite3 temp-file DB seeded with the full D4 FK chain (projects →
 *      epics → tasks → work_intents → proposals → readiness → settlement →
 *      certificate), a fake ENGINE runtime that drives the recovery path and
 *      feeds the real certificate id/hash to the engine, and the REAL
 *      Saga3DiscoveryDiagnosisService wired into the engine (bound to its own
 *      real SQLite runtime port + a fake diagnosis worker executor). These
 *      tests verify the byte-identical D4 row snapshot (invariant I6 at the
 *      engine level) and the worker restart/resume idempotency (invariant I7).
 *
 *      Why a fake engine runtime + real diagnosis service? The engine's
 *      diagnosis hook calls `diagnosisService.diagnose({certificateId,
 *      certificateHash, ...})`. The diagnosis service then independently
 *      verifies the target against the real DB, runs its own worker lifecycle,
 *      and persists real report rows. The engine runtime only needs to drive
 *      the recovery path deterministically (returning state='done' + the
 *      proposal) and surface the certificate via a fake settlement service that
 *      reads the real certificate id/hash. This is exactly the contract: the
 *      engine supplies the certificate target; the diagnosis service owns the
 *      diagnosis tables. (Mirrors how d4-settlement-engine.test.mjs drives the
 *      recovery path with a fake runtime + fake settlement service.)
 *
 * Tests import from ../../dist/... so `npm run build` (tsc) must run first.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');

// ===========================================================================
// Harness A — fake runtime + fake services (D1, D2, D3, D8, D9, D10)
// ===========================================================================

function validPayload(outcome = 'go') {
  return {
    problem_statement: 'p', observed_context: 'c',
    stakeholders_or_actors: ['u'], assumptions: ['a'], unknowns: ['u'],
    risks: ['r'], candidate_scope: 's', evidence_refs: ['e'],
    recommended_outcome: outcome, rationale: 'because',
  };
}

function fullConfig() {
  return { dbPath: '/d', claudePath: 'claude', lmStudioUrl: 'http://x/v1' };
}
function fakeHost() {
  return {
    processId: 42,
    acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }),
    releaseEngineLock: () => {},
    workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat: (_ctx, _event, _msg) => {},
    scanRateLimitSignals: () => 0,
  };
}

function makeFakeReadinessService({ outcome = 'completed' } = {}) {
  return {
    async assess() {
      if (outcome === 'failed') {
        return {
          success: false, cycles: 5, error: 'advisor failed',
          shadow: {
            status: 'failed', authority: 'none',
            assessmentId: null, assessmentHash: null,
            overallReadiness: null, recommendedNextAction: null, error: 'advisor failed',
          },
        };
      }
      return {
        success: true, cycles: 7, error: null,
        shadow: {
          status: 'completed', authority: 'shadow_advisor',
          assessmentId: 99, assessmentHash: 'd'.repeat(64),
          overallReadiness: 'ready', recommendedNextAction: 'proceed_to_settlement', error: null,
        },
      };
    },
  };
}

function makeFakeSettlementService({ status = 'issued', decision = 'go', error = null } = {}) {
  const calls = [];
  return {
    calls,
    async settle(request) {
      calls.push(request);
      if (status === 'failed') {
        return {
          status: 'failed',
          settlementId: null, certificateId: null, certificateHash: null,
          policyVersion: null, policyHash: null,
          decision: null, reasonCodes: [], error: error ?? 'settlement infrastructure error',
        };
      }
      // issued
      return {
        status: 'issued',
        settlementId: 1, certificateId: 2, certificateHash: 'f'.repeat(64),
        policyVersion: 'saga3.discovery-settlement-policy.v1',
        policyHash: 'p'.repeat(64),
        decision,
        reasonCodes: decision === 'go' ? ['GO_READY_AND_GROUNDED']
          : decision === 'reject' ? ['REJECT_WORKER_AND_ADVISOR_AGREE']
          : ['CLARIFY_BLOCKING_GAPS'],
        error: null,
      };
    },
  };
}

/**
 * Fake diagnosis service. Returns a configurable `DiscoveryDiagnosisResult`
 * (the discriminated union the engine consumes) and records calls so tests can
 * assert the engine invoked it with the right certificate target. `throwError`
 * makes diagnose() throw — the engine must catch it and set diagnosis.status=
 * 'failed' WITHOUT touching the D4 result (invariant I5).
 */
function makeFakeDiagnosisService({
  status = 'completed',
  summary = 'diagnosis summary',
  primaryCauses = ['C1'],
  blockingGaps = [],
  recommendedActions = ['A1'],
  error = null,
  throwError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async diagnose(request) {
      calls.push(request);
      if (throwError) {
        throw new Error(throwError);
      }
      if (status === 'failed' || status === 'paused') {
        return {
          status,
          authority: 'none',
          reportId: null,
          reportHash: null,
          target: { certificateId: request.certificateId, certificateHash: request.certificateHash },
          summary: null,
          primaryCauses: [],
          blockingGaps: [],
          recommendedActions: [],
          error: error ?? 'diagnosis failed',
        };
      }
      // completed
      return {
        status: 'completed',
        authority: 'advisory_diagnosis',
        reportId: 77,
        reportHash: 'r'.repeat(64),
        target: { certificateId: request.certificateId, certificateHash: request.certificateHash },
        summary,
        primaryCauses,
        blockingGaps,
        recommendedActions,
        error: null,
      };
    },
  };
}

function makeFakeRuntime({ proposalPayload = null, finalTaskStatus = 'done' }) {
  let intent = null;
  let task = null;
  let proposal = null;
  let nextId = 1;
  return {
    readEpicObjective: () => ({ name: 'e', description: 'discover' }),
    readOpenIntent: (_e, kind) => intent && intent.kind === kind && intent.status !== 'concluded' ? intent : null,
    createIntent(command) {
      intent = { id: nextId++, epic_id: command.epic_id, kind: command.kind, objective: command.objective,
        authority_scope: command.authority_scope, output_schema: command.output_schema,
        projected_task_id: null, status: 'open', created_at: 't' };
      return intent;
    },
    setProjectedTask: (i, t) => { intent.projected_task_id = t; },
    setIntentStatus: (i, exp, next) => { if (intent.status === exp) { intent.status = next; return true; } return false; },
    ensureProjectedTask() { if (!task) task = { id: 100, status: 'todo' }; return task.id; },
    readTaskState: () => task ? task.status : null,
    prepareIntentForExecution: () => ({ state: 'ready', intentStatus: 'open', taskStatus: 'todo' }),
    readWorkIntentForTask: () => null,
    readLatestProposal: () => proposal,
    readLatestRawSubmission: () => null,
    ensureNormalizationControl: () => ({ controlIntentId: 1, sourceSubmissionId: 1, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 100 }),
    setControlIntentStatus: () => true,
    ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: 'h', controlStatus: 'open', authorityIntentId: 2, authorityIntentStatus: 'open', taskId: 101 }),
    setReadinessControlStatus: () => true,
    readLatestReadinessAssessment: () => null,
    // D4 settlement port methods — fake services do not call these.
    readProposalForSettlement: () => null,
    readAcceptedReadinessAssessmentForProposal: () => null,
    findSettlementByInputKey: () => null,
    insertSettlement: () => ({ record: { id: 1 }, replayed: false }),
    markSettlementCertificateIssued: () => true,
    markSettlementFailed: () => {},
    insertCertificate: () => ({ record: { id: 2, certificate_hash: 'f'.repeat(64) }, replayed: false }),
    readCertificateForSettlement: () => null,
    _simulateWorkerTick() {
      if (proposalPayload && !proposal) {
        proposal = { id: 50, payload: proposalPayload, content_hash: 'h'.repeat(64), provenance: null };
      }
      if (task) task.status = finalTaskStatus;
    },
  };
}

function makeFakeExecutor(onPoll) {
  let stopped = false;
  return {
    start() {},
    status() {
      if (!stopped) onPoll();
      if (stopped) return null;
      return { id: 'fake-run', project_id: 1, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
    },
    setConcurrency() {},
    stop() { stopped = true; },
    dispose() {},
  };
}

/**
 * Run the engine on the fresh-run path with a configurable settlement decision
 * + diagnosis behaviour. Returns { result, settlement, diagnosis } so tests can
 * assert on the engine's top-level + diagnosis section + service call counts.
 */
async function runEngine({
  proposalPayload,
  settlementStatus,
  settlementDecision,
  readinessOutcome = 'completed',
  finalTaskStatus = 'done',
  diagnosisOptions = {},
  withDiagnosisService = true,
}) {
  const runtime = makeFakeRuntime({ proposalPayload, finalTaskStatus });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick());
  const readiness = makeFakeReadinessService({ outcome: readinessOutcome });
  const settlement = makeFakeSettlementService({ status: settlementStatus, decision: settlementDecision });
  const diagnosis = makeFakeDiagnosisService(diagnosisOptions);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
    readinessService: readiness, settlementService: settlement,
    diagnosisService: withDiagnosisService ? diagnosis : undefined,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  return { result, settlement, diagnosis };
}

// ---------------------------------------------------------------------------
// D1 — D4 GO + diagnosis completed keeps outcome go (I1, I2)
// ---------------------------------------------------------------------------

test('D5 engine: GO + diagnosis keeps outcome go', async () => {
  const { result, diagnosis } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'go',
    diagnosisOptions: { status: 'completed', summary: 'all clear', primaryCauses: [], recommendedActions: ['A1'] },
  });
  // I1: top-level D4 authority preserved.
  assert.equal(result.outcome, 'go');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.finalStage, 'discovery');
  // I2: diagnosis section advisory.
  assert.equal(result.diagnosis.status, 'completed');
  assert.equal(result.diagnosis.authority, 'advisory_diagnosis');
  assert.notEqual(result.diagnosis.authority, 'kernel_policy');
  assert.notEqual(result.diagnosis.authority, 'discovery_settlement_policy');
  assert.equal(result.diagnosis.reportId, 77);
  assert.equal(result.diagnosis.reportHash.length, 64);
  assert.equal(result.diagnosis.summary, 'all clear');
  assert.deepEqual(result.diagnosis.primaryCauses, []);
  assert.deepEqual(result.diagnosis.recommendedActions, ['A1']);
  assert.equal(result.diagnosis.error, null);
  // The engine invoked the diagnosis service with the exact certificate target.
  assert.equal(diagnosis.calls.length, 1);
  assert.equal(diagnosis.calls[0].certificateId, 2);
  assert.equal(diagnosis.calls[0].certificateHash, 'f'.repeat(64));
});

// ---------------------------------------------------------------------------
// D2 — D4 CLARIFY + diagnosis keeps outcome and surfaces causes (I1)
// ---------------------------------------------------------------------------

test('D5 engine: CLARIFY keeps outcome and surfaces causes', async () => {
  const { result } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'clarify',
    diagnosisOptions: {
      status: 'completed',
      summary: 'blocking gaps need clarification',
      primaryCauses: ['GAP_DATA_MODEL', 'GAP_BUDGET'],
      blockingGaps: ['GAP_DATA_MODEL'],
      recommendedActions: ['COLLECT_INFO'],
    },
  });
  // I1: clarify preserved.
  assert.equal(result.outcome, 'clarify');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  // Diagnosis surfaces the causes/gaps.
  assert.equal(result.diagnosis.status, 'completed');
  assert.equal(result.diagnosis.authority, 'advisory_diagnosis');
  assert.deepEqual(result.diagnosis.primaryCauses, ['GAP_DATA_MODEL', 'GAP_BUDGET']);
  assert.deepEqual(result.diagnosis.blockingGaps, ['GAP_DATA_MODEL']);
  assert.deepEqual(result.diagnosis.recommendedActions, ['COLLECT_INFO']);
});

// ---------------------------------------------------------------------------
// D3 — D4 REJECT + diagnosis keeps outcome (I1)
// ---------------------------------------------------------------------------

test('D5 engine: REJECT keeps outcome', async () => {
  const { result } = await runEngine({
    proposalPayload: validPayload('reject'),
    settlementStatus: 'issued', settlementDecision: 'reject',
    diagnosisOptions: {
      status: 'completed',
      summary: 'worker and advisor agree on reject',
      primaryCauses: ['FATAL_SCOPE_CONFLICT'],
      blockingGaps: ['FATAL_SCOPE_CONFLICT'],
      recommendedActions: ['REVISE_SCOPE'],
    },
  });
  assert.equal(result.outcome, 'reject');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.diagnosis.status, 'completed');
  assert.equal(result.diagnosis.authority, 'advisory_diagnosis');
  assert.deepEqual(result.diagnosis.blockingGaps, ['FATAL_SCOPE_CONFLICT']);
});

// ---------------------------------------------------------------------------
// D8 — no certificate: diagnosis.status not_run (§12)
// ---------------------------------------------------------------------------

test('D5 engine: no certificate diagnosis not_run', async () => {
  // Settlement FAILED → no certificate issued → diagnosis must be not_run and
  // the diagnosis service must NOT be invoked.
  const { result, diagnosis } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'failed',
    diagnosisOptions: { status: 'completed' },
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.outcomeAuthority, 'none');
  assert.equal(result.settlement.status, 'failed');
  assert.equal(result.diagnosis.status, 'not_run');
  assert.equal(result.diagnosis.authority, 'none');
  assert.equal(result.diagnosis.reportId, null);
  assert.equal(result.diagnosis.target.certificateId, null);
  assert.equal(result.diagnosis.target.certificateHash, null);
  assert.equal(diagnosis.calls.length, 0, 'diagnosis service must not be invoked without a certificate');
});

// ---------------------------------------------------------------------------
// D9 — report attempts outcome override: rejected; outcome unchanged (I1)
// ---------------------------------------------------------------------------

test('D5 engine: outcome override attempt rejected', async () => {
  // The fake diagnosis service returns 'completed' — but the engine must NOT
  // let any diagnosis value change the top-level outcome. We assert the D4
  // clarify outcome is preserved regardless of what the diagnosis says, AND
  // that the diagnosis authority never claims kernel authority. The payload-
  // level rejection of `override_decision` is covered by the validator pure
  // tests (B14); here we assert the engine boundary: diagnosis never overrides.
  const { result } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'clarify',
    diagnosisOptions: {
      status: 'completed',
      summary: 'worker tried to override to go',
      primaryCauses: [],
      recommendedActions: ['OVERRIDE_TO_GO'],
    },
  });
  // I1: clarify preserved; the diagnosis recommendation could not override it.
  assert.equal(result.outcome, 'clarify');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.diagnosis.status, 'completed');
  assert.equal(result.diagnosis.authority, 'advisory_diagnosis');
  // The diagnosis surfaces its recommendation but the outcome is unchanged.
  assert.deepEqual(result.diagnosis.recommendedActions, ['OVERRIDE_TO_GO']);
});

// ---------------------------------------------------------------------------
// D10 — finalStage stays discovery after diagnosis (I1)
// ---------------------------------------------------------------------------

test('D5 engine: finalStage unchanged', async () => {
  const { result } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'go',
    diagnosisOptions: { status: 'completed' },
  });
  assert.equal(result.finalStage, 'discovery');
  assert.equal(result.diagnosis.status, 'completed');
  // Diagnosis must not carry any field that could mutate the stage.
  assert.ok(!('finalStage' in result.diagnosis));
  assert.ok(!('transitionStage' in result.diagnosis));
});

// ---------------------------------------------------------------------------
// Extra: no diagnosisService wired → diagnosis not_run (backward compatible),
// mirroring the D4 no-settlementService backward-compat test.
// ---------------------------------------------------------------------------

test('D5 engine: no diagnosisService wired -> diagnosis not_run, backward compatible', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go') });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick());
  const readiness = makeFakeReadinessService({ outcome: 'completed' });
  const settlement = makeFakeSettlementService({ status: 'issued', decision: 'go' });
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
    readinessService: readiness, settlementService: settlement,
    // diagnosisService intentionally omitted.
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.settlement.status, 'issued');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.diagnosis.status, 'not_run');
  assert.equal(result.diagnosis.authority, 'none');
});

// ===========================================================================
// Harness B — real SQLite + real diagnosis service (D4, D5, D6, D7)
// ===========================================================================
//
// Strategy: a real better-sqlite3 temp-file DB seeded with the full D4 FK chain
// (settlement id 1 + outcome certificate id 1, decision go). A FAKE engine
// runtime drives the engine's RECOVERY path deterministically (returns
// state='done' + the seeded proposal), and a FAKE settlement service returns
// the real certificate id/hash. The REAL Saga3DiscoveryDiagnosisService is
// wired into the engine, bound to its own real SQLite runtime port + a fake
// diagnosis worker executor. So:
//   - the engine's diagnosis hook runs against the REAL service;
//   - the service verifies the REAL certificate, runs its REAL worker lifecycle,
//     and persists REAL report rows;
//   - D4 rows are REAL DB rows we can snapshot byte-for-byte (invariant I6).
//
// This mirrors how d4-settlement-engine.test.mjs drives the recovery path with a
// fake runtime + fake settlement service (runRecoveryEngine), but adds the real
// diagnosis service bound to the real DB for the diagnosis side.

const DB_DEPS = {};

async function loadRealDeps() {
  if (DB_DEPS.loaded) return DB_DEPS;
  DB_DEPS.loaded = true;
  DB_DEPS.closeDb = (await import('../../dist/db.js')).closeDb;
  DB_DEPS.getDb = (await import('../../dist/db.js')).getDb;
  DB_DEPS.DISCOVERY_PROPOSAL_SCHEMA = (await import('../../dist/saga3/domain/discovery-proposal.js')).DISCOVERY_PROPOSAL_SCHEMA;
  const wi = await import('../../dist/saga3/domain/work-intent.js');
  DB_DEPS.DISCOVERY_INTENT_KIND = wi.DISCOVERY_INTENT_KIND;
  DB_DEPS.DISCOVERY_READINESS_INTENT_KIND = wi.DISCOVERY_READINESS_INTENT_KIND;
  DB_DEPS.DISCOVERY_WORK_INTENT_SCHEMA = wi.DISCOVERY_WORK_INTENT_SCHEMA;
  const ra = await import('../../dist/saga3/domain/discovery-readiness-assessment.js');
  DB_DEPS.DISCOVERY_READINESS_ASSESSMENT_SCHEMA = ra.DISCOVERY_READINESS_ASSESSMENT_SCHEMA;
  DB_DEPS.READINESS_DIMENSIONS = ra.READINESS_DIMENSIONS;
  DB_DEPS.canonicalJson = (await import('../../dist/saga3/shared/discovery-canonical.js')).canonicalJson;
  DB_DEPS.ensureSaga3ReadinessSchema = (await import('../../dist/saga3/persistence/saga3-readiness-repository.js')).ensureSaga3ReadinessSchema;
  DB_DEPS.ensureSaga3SettlementSchema = (await import('../../dist/saga3/persistence/saga3-settlement-repository.js')).ensureSaga3SettlementSchema;
  DB_DEPS.ensureSaga3DiagnosisSchema = (await import('../../dist/saga3/persistence/saga3-diagnosis-repository.js')).ensureSaga3DiagnosisSchema;
  DB_DEPS.DISCOVERY_DIAGNOSIS_REPORT_SCHEMA = (await import('../../dist/saga3/domain/discovery-diagnosis-report.js')).DISCOVERY_DIAGNOSIS_REPORT_SCHEMA;
  DB_DEPS.validateDiagnosisReport = (await import('../../dist/saga3/domain/discovery-diagnosis-validator.js')).validateDiagnosisReport;
  DB_DEPS.buildDiagnosisCase = (await import('../../dist/saga3/domain/discovery-diagnosis-case.js')).buildDiagnosisCase;
  DB_DEPS.diagnosisCaseHash = (await import('../../dist/saga3/domain/discovery-diagnosis-case.js')).diagnosisCaseHash;
  DB_DEPS.SqliteSaga3DiscoveryRuntime = (await import('../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js')).SqliteSaga3DiscoveryRuntime;
  DB_DEPS.Saga3DiscoveryDiagnosisService = (await import('../../dist/saga3/application/discovery-diagnosis-service.js')).Saga3DiscoveryDiagnosisService;
  return DB_DEPS;
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

/**
 * Build the real-SQLite harness. Seeds the D4 FK chain + a GO certificate and
 * returns an env with runEngine/onWorkerPoll helpers, D4 snapshot helpers, and
 * diagnosis-table readers.
 */
async function realSqliteHarness() {
  const D = await loadRealDeps();
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-eng-'));
  process.env.DB_PATH = path.join(temp, 'd5eng.db');
  const db = D.getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();

  const PRODUCT_PROPOSAL_HASH = createHash('sha256').update(D.canonicalJson(PRODUCT_PROPOSAL_PAYLOAD)).digest('hex');
  const dims = {};
  for (const d of D.READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  const ASSESSMENT_PAYLOAD = {
    proposal_id: 50, proposal_content_hash: PRODUCT_PROPOSAL_HASH,
    overall_readiness: 'ready', dimension_assessments: dims,
    blocking_gaps: [], non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9, rationale: 'well grounded',
  };
  const ASSESSMENT_HASH = createHash('sha256').update(D.canonicalJson(ASSESSMENT_PAYLOAD)).digest('hex');
  const ACCEPTED_TARGET = `accepted:${ASSESSMENT_HASH}`;
  const SETTLEMENT_SNAPSHOT = {
    schema_version: 'saga3.discovery-settlement-input.v1',
    epic_id: 10,
    proposal: {
      id: 50, content_hash: PRODUCT_PROPOSAL_HASH, payload: PRODUCT_PROPOSAL_PAYLOAD,
      source_intent_id: 1, source_submission_id: null, normalization_proposal_id: null,
    },
    readiness: {
      status: 'accepted_by_kernel', assessment_id: 7,
      content_hash: ASSESSMENT_HASH, payload: ASSESSMENT_PAYLOAD,
    },
    policy: { version: 'saga3.settlement-policy.v1', content_hash: 'p'.repeat(64) },
    captured_at: '2026-07-24T00:00:00.000Z',
  };
  const SETTLEMENT_INPUT_HASH = createHash('sha256').update(D.canonicalJson(SETTLEMENT_SNAPSHOT)).digest('hex');
  const POLICY_HASH = 'p'.repeat(64);

  // Seed full D4 FK chain (settlement id 1 + outcome certificate id 1, go).
  D.ensureSaga3ReadinessSchema(db);
  D.ensureSaga3SettlementSchema(db);
  D.ensureSaga3DiagnosisSchema(db);
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
  ).run(D.DISCOVERY_INTENT_KIND, 'discover', '{}', D.DISCOVERY_WORK_INTENT_SCHEMA);
  db.prepare(
    `INSERT INTO saga3_proposals
       (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
     VALUES (50,1,100,'product-exec',?,?,?,?,?,?)`,
  ).run('discovery', D.DISCOVERY_PROPOSAL_SCHEMA, D.canonicalJson(PRODUCT_PROPOSAL_PAYLOAD), PRODUCT_PROPOSAL_HASH, 'submitted', '{}');
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
  ).run(D.DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', D.DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
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
  ).run(PRODUCT_PROPOSAL_HASH, D.canonicalJson(ASSESSMENT_PAYLOAD), ASSESSMENT_HASH);
  const certHash = createHash('sha256').update('cert-1-go').digest('hex');
  db.prepare(
    `INSERT INTO saga3_discovery_settlements
       (id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,
        readiness_assessment_hash,policy_version,policy_hash,input_snapshot,
        input_hash,decision,reason_codes,rationale,status)
     VALUES (1,10,50,?,7,?,'saga3.settlement-policy.v1',?,?,?,?,?,?,'certificate_issued')`,
  ).run(PRODUCT_PROPOSAL_HASH, ACCEPTED_TARGET, POLICY_HASH, D.canonicalJson(SETTLEMENT_SNAPSHOT), SETTLEMENT_INPUT_HASH, 'go', JSON.stringify(['GO_READY_AND_GROUNDED']), 'ready and grounded');
  db.prepare(
    `INSERT INTO saga3_discovery_outcome_certificates
       (id,settlement_id,epic_id,proposal_id,proposal_content_hash,
        readiness_assessment_id,readiness_assessment_hash,policy_version,
        policy_hash,decision,reason_codes,input_hash,certificate_payload,
        certificate_hash,issued_at)
     VALUES (1,1,10,50,?,7,?,'saga3.settlement-policy.v1',?,?,?,?,'{}',?,'2026-07-24T00:00:00.000Z')`,
  ).run(PRODUCT_PROPOSAL_HASH, ACCEPTED_TARGET, POLICY_HASH, 'go', JSON.stringify(['GO_READY_AND_GROUNDED']), SETTLEMENT_INPUT_HASH, certHash);

  const certId = 1;
  let workerSpawnCount = 0;

  // A fake settlement service that returns the seeded issued certificate, so
  // the engine's diagnosis eligibility (status='issued' + non-null cert) is
  // satisfied and the REAL diagnosis service receives the real cert target.
  const settlementService = {
    async settle() {
      return {
        status: 'issued',
        settlementId: 1, certificateId: certId, certificateHash: certHash,
        policyVersion: 'saga3.settlement-policy.v1', policyHash: POLICY_HASH,
        decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], error: null,
      };
    },
  };

  /**
   * Build a fake diagnosis worker executor. `onFirstPoll` runs once on the first
   * status() call: typically flips the diagnosis task to done + inserts a report
   * via the runtime port (mirroring what diagnosis_submit persists). After that
   * the executor reports a running status with no active workers, so the
   * service's terminal-detection loop sees task=done && !active → clean.
   */
  function makeDiagnosisExecutor(onFirstPoll) {
    let polled = false;
    let stopped = false;
    return {
      start() { workerSpawnCount++; },
      status(projectId) {
        if (!polled) {
          polled = true;
          onFirstPoll();
        }
        if (stopped) return null;
        return {
          id: 'fake-diag-run', project_id: projectId, concurrency: 1, status: 'running',
          active: [], completed: 1, failed: 0, claimed: 1,
        };
      },
      setConcurrency() {},
      stop() { stopped = true; },
      dispose() {},
    };
  }

  /**
   * A fake ENGINE runtime that drives the recovery path: readOpenIntent returns
   * a concluded product intent (so the engine skips intent creation), the
   * proposal is the seeded one, and prepareIntentForExecution returns 'done'
   * (so the engine takes the recovery path → settlement → diagnosis). The
   * recovery path's readiness control read returns a concluded control with the
   * accepted assessment, so the reconstructed shadow is 'completed'.
   */
  function makeFakeEngineRuntime() {
    const proposal = {
      id: 50, payload: PRODUCT_PROPOSAL_PAYLOAD, content_hash: PRODUCT_PROPOSAL_HASH, provenance: null,
    };
    const intent = {
      id: 1, epic_id: 10, kind: 'discovery', objective: 'discover',
      authority_scope: {}, output_schema: 'saga3.work-intent.discovery.v1',
      projected_task_id: 100, status: 'concluded', created_at: 't',
    };
    const acceptedAssessment = {
      id: 7, control_intent_id: 1, proposal_id: 50,
      proposal_content_hash: PRODUCT_PROPOSAL_HASH, task_id: 200, execution_id: 'advisor-exec',
      payload: ASSESSMENT_PAYLOAD, content_hash: ASSESSMENT_HASH,
      status: 'accepted_by_kernel', overall_readiness: 'ready',
      recommended_next_action: 'proceed_to_settlement', validation_errors: [], provenance: null, created_at: 't',
    };
    return {
      readEpicObjective: () => ({ name: 'e', description: 'discover' }),
      readOpenIntent: () => null, // concluded → engine skips createIntent via ensureProjectedTask
      createIntent: () => intent,
      setProjectedTask: () => {},
      setIntentStatus: () => true,
      ensureProjectedTask: () => 100,
      readTaskState: () => 'done',
      prepareIntentForExecution: () => ({ state: 'done', intentStatus: 'concluded', taskStatus: 'done' }),
      readWorkIntentForTask: () => null,
      readLatestProposal: () => proposal,
      readLatestRawSubmission: () => null,
      ensureNormalizationControl: () => ({ controlIntentId: 1, sourceSubmissionId: 1, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 100 }),
      setControlIntentStatus: () => true,
      ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: PRODUCT_PROPOSAL_HASH, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 200 }),
      setReadinessControlStatus: () => true,
      readLatestReadinessAssessment: () => acceptedAssessment,
      readReadinessControlForProposal: () => ({
        id: 1, epic_id: 10, kind: 'AssessDiscoveryReadiness', proposal_id: 50,
        proposal_content_hash: PRODUCT_PROPOSAL_HASH, source_intent_id: 1,
        authority_intent_id: 2, projected_task_id: 200, status: 'concluded', created_at: 't', updated_at: 't',
      }),
      readWorkIntent: (id) => ({ id, epic_id: 10, kind: 'discovery.assess', objective: 'assess', authority_scope: {}, output_schema: 'saga3.readiness-assessment.v1', token_budget: 0, retry_budget: 0, projected_task_id: 200, status: 'concluded', created_at: 't', updated_at: 't' }),
      // Settlement port methods (fake settlement service does not call these).
      readProposalForSettlement: () => null,
      findSettlementByInputKey: () => null,
      insertSettlement: () => ({ record: { id: 1, created_at: 't' }, replayed: false }),
      markSettlementFailed: () => {},
      readCertificateForSettlement: () => null,
      issueCertificateAtomically: () => ({ record: { id: 1, certificate_hash: certHash }, inserted: true }),
      reconcileExistingCertificate: () => ({ id: 1, certificate_hash: certHash }),
    };
  }

  function validGoReport(caseData) {
    return {
      schema_version: D.DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      target: {
        certificate_id: caseData.certificate.id,
        certificate_hash: caseData.certificate.hash,
        settlement_input_hash: caseData.certificate.settlement_input_hash,
        decision: 'go',
      },
      executive_summary: 'All GO conditions met; the decision is well-grounded.',
      cause_analysis: [],
      information_requests: [],
      recommended_actions: [{
        action_id: 'A1',
        action: 'proceed_with_monitoring',
        description: 'Proceed with the go decision; monitor residual risks.',
        resolves_cause_ids: [],
        source_refs: [`certificate:${caseData.certificate.id}`],
      }],
      residual_risks: [{
        risk: 'Market timing may shift before formalization.',
        source_refs: ['$.observed_context'],
      }],
      confidence: 0.85,
    };
  }

  function insertReport(control, report, status, validationErrors, execId) {
    const diagRuntime = new D.SqliteSaga3DiscoveryRuntime();
    diagRuntime.insertDiagnosisReportAtomically({
      controlIntentId: control.id,
      certificateId: certId,
      certificateHash: certHash,
      settlementInputHash: control.settlement_input_hash,
      decision: 'go',
      taskId: control.projected_task_id,
      executionId: execId,
      schemaVersion: D.DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      payload: report,
      expectedContentHash: createHash('sha256').update(D.canonicalJson(report)).digest('hex'),
      status,
      validationErrors,
      provenance: { worker_id: 'diag-worker', execution_id: execId },
    });
  }

  function submitValidGoReport(control, caseData) {
    const report = validGoReport(caseData);
    const validation = D.validateDiagnosisReport(report, caseData);
    assert.equal(validation.valid, true, `fixture report must be valid: ${validation.errors.join('; ')}`);
    insertReport(control, report, 'accepted_by_kernel', [], 'diag-exec-valid');
  }

  function submitInvalidReport(control, caseData) {
    const report = validGoReport(caseData);
    report.recommended_actions[0].source_refs = ['$.invented_field_not_in_allowlist'];
    const validation = D.validateDiagnosisReport(report, caseData);
    assert.equal(validation.valid, false, 'fixture: invented source ref must be invalid');
    insertReport(control, report, 'rejected_by_kernel', validation.errors, 'diag-exec-reject');
  }

  /**
   * Run the engine once. `onWorkerPoll(control, caseData)` is invoked on the
   * diagnosis worker's first status poll (after the control + task exist); it
   * should flip the diagnosis task to done and insert a report. If the worker
   * must NOT spawn (e.g. restart with an accepted report), set `noSpawn:true`
   * and onWorkerPoll throws if reached.
   */
  async function runEngine({ onWorkerPoll, crashingExecutor = false } = {}) {
    const diagRuntime = new D.SqliteSaga3DiscoveryRuntime();
    const diagnosisExecutorFactory = crashingExecutor
      ? () => ({
          start() { workerSpawnCount++; },
          status() { throw new Error('diagnosis worker substrate crashed'); },
          setConcurrency() {},
          stop() {},
          dispose() {},
        })
      : () => makeDiagnosisExecutor(() => {
          const control = diagRuntime.readDiagnosisControlForTarget(certId, certHash);
          if (!control) return; // control not created yet (target verify failed)
          const caseData = JSON.parse(control.diagnosis_case);
          db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
          onWorkerPoll(control, caseData);
        });
    const diagnosisService = new D.Saga3DiscoveryDiagnosisService({
      config: { dbPath: process.env.DB_PATH, claudePath: 'claude', lmStudioUrl: 'http://x/v1' },
      workerExecutorFactory: diagnosisExecutorFactory,
      host: {
        processId: 42,
        workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
      },
      runtimePersistence: diagRuntime,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      sleep: async () => {},
      pollMs: 0,
      maxRunSeconds: 60,
    });

    const engine = new Saga3DiscoveryEngine({
      config: { dbPath: process.env.DB_PATH, claudePath: 'claude', lmStudioUrl: 'http://x/v1' },
      workerExecutorFactory: () => makeDiagnosisExecutor(() => {}), // product worker; not used on recovery path
      persistence: {
        episodes: { currentStage: () => 'discovery' },
        workspaces: { resolve: () => ({ workspaceRoot: '/w' }) },
      },
      host: {
        processId: 42,
        acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }),
        releaseEngineLock: () => {},
        workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
        now: () => new Date('2026-07-24T00:00:00.000Z'),
        sleep: async () => {},
        heartbeat: () => {},
        scanRateLimitSignals: () => 0,
      },
      runtimePersistence: makeFakeEngineRuntime(),
      pollMs: 0,
      normalizationService: { async normalize() { return { cycles: 0, error: null }; } },
      readinessService: {
        async assess() {
          return {
            success: true, cycles: 0, error: null,
            shadow: {
              status: 'completed', authority: 'shadow_advisor',
              assessmentId: 7, assessmentHash: ASSESSMENT_HASH,
              overallReadiness: 'ready', recommendedNextAction: 'proceed_to_settlement', error: null,
            },
          };
        },
      },
      settlementService,
      diagnosisService,
    });
    return engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  }

  function seedPausedControl() {
    const rt = new D.SqliteSaga3DiscoveryRuntime();
    const cert = rt.readOutcomeCertificate(certId);
    const settlement = rt.readSettlement(cert.settlement_id);
    const proposal = rt.readProposalForSettlement(settlement.proposal_id);
    const assessment = rt.readReadinessAssessment(settlement.readiness_assessment_id);
    const caseData = D.buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: {
        status: 'accepted_by_kernel', assessment_id: assessment.id,
        hash: assessment.content_hash, payload: assessment.payload,
      },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    const caseHash = D.diagnosisCaseHash(caseData);
    const control = rt.ensureDiagnosisControl({
      epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
      settlementId: settlement.id, settlementInputHash: settlement.input_hash,
      sourceIntentId: proposal.intent_id,
      objective: 'pre-seeded paused control',
      diagnosisCase: D.canonicalJson(caseData),
      diagnosisCaseHash: caseHash,
      diagnosisContractVersion: 'saga3.discovery-diagnosis.v1',
    });
    db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET status=? WHERE id=?')
      .run('paused', control.controlIntentId);
    db.prepare('UPDATE saga3_work_intents SET status=? WHERE id=?')
      .run('paused', control.authorityIntentId);
    db.prepare('UPDATE tasks SET status=? WHERE id=?')
      .run('todo', control.taskId);
  }

  function snapshotD4() {
    const tables = [
      'saga3_proposals',
      'saga3_readiness_assessments',
      'saga3_discovery_settlements',
      'saga3_discovery_outcome_certificates',
    ];
    const snap = {};
    for (const t of tables) {
      snap[t] = JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    }
    return snap;
  }
  function assertD4Unchanged(before, label) {
    const after = snapshotD4();
    for (const t of Object.keys(before)) {
      assert.equal(after[t], before[t], `${label}: D4 table ${t} must not change`);
    }
  }
  function latestReportRow() {
    return db.prepare(
      `SELECT status, validation_errors FROM saga3_discovery_diagnosis_reports ORDER BY id DESC LIMIT 1`,
    ).get();
  }
  function reportRowCount() {
    return db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c;
  }
  function controlRowCount() {
    return db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c;
  }
  function spawnCount() { return workerSpawnCount; }

  function cleanup() {
    D.closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }

  return {
    runEngine, submitValidGoReport, submitInvalidReport, seedPausedControl,
    snapshotD4, assertD4Unchanged, latestReportRow, reportRowCount,
    controlRowCount, spawnCount, cleanup,
  };
}

// ---------------------------------------------------------------------------
// D4 — diagnosis worker failure does not break D4 result (I5) — real service
// ---------------------------------------------------------------------------

test('D5 engine: worker failure does not break D4 result', async () => {
  // Real diagnosis service whose worker substrate CRASHES. The engine must
  // catch the resulting failed result and keep the D4 result authoritative.
  const env = await realSqliteHarness();
  try {
    const before = env.snapshotD4();
    const result = await env.runEngine({ crashingExecutor: true });
    // I5: D4 result stays COMPLETE and authoritative.
    assert.equal(result.outcome, 'go');
    assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
    assert.equal(result.reason, 'completed');
    assert.equal(result.scopeCompleted, true);
    assert.equal(result.finalStage, 'discovery');
    assert.equal(result.lastError, null, 'D4 clean closure: lastError must stay null');
    // I6: D4 rows byte-identical.
    env.assertD4Unchanged(before, 'D4 worker crash');
    // The diagnosis section records the failure.
    assert.equal(result.diagnosis.status, 'failed');
    assert.equal(result.diagnosis.authority, 'none');
    assert.equal(result.diagnosis.reportId, null);
    assert.ok(result.diagnosis.error.includes('crashed'), `error must surface the crash; got '${result.diagnosis.error}'`);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D5 — invalid payload: durable rejected_by_kernel report; D4 result unchanged
// ---------------------------------------------------------------------------

test('D5 engine: invalid payload durable rejected', async () => {
  const env = await realSqliteHarness();
  try {
    const before = env.snapshotD4();
    // Worker submits a report citing an INVENTED source ref — the service
    // persists it as rejected_by_kernel and returns status='failed'.
    const result = await env.runEngine({
      onWorkerPoll: (control, caseData) => env.submitInvalidReport(control, caseData),
    });
    // I5: D4 result stays authoritative.
    assert.equal(result.outcome, 'go');
    assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
    assert.equal(result.reason, 'completed');
    assert.equal(result.scopeCompleted, true);
    // I6: D4 rows byte-identical.
    env.assertD4Unchanged(before, 'D5 invalid payload');
    // Diagnosis failed; the rejected report is DURABLE.
    assert.equal(result.diagnosis.status, 'failed');
    assert.equal(result.diagnosis.authority, 'none');
    const reportRow = env.latestReportRow();
    assert.equal(reportRow.status, 'rejected_by_kernel');
    const errors = JSON.parse(reportRow.validation_errors);
    assert.ok(errors.length > 0, 'rejected report must carry non-empty validation_errors');
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D6 — accepted diagnosis exists on restart: worker NOT respawned (I7)
// ---------------------------------------------------------------------------

test('D5 engine: accepted no respawn', async () => {
  const env = await realSqliteHarness();
  try {
    // First run: the diagnosis worker submits a valid report; it is accepted.
    const first = await env.runEngine({
      onWorkerPoll: (control, caseData) => env.submitValidGoReport(control, caseData),
    });
    assert.equal(first.diagnosis.status, 'completed');
    assert.equal(first.diagnosis.authority, 'advisory_diagnosis');
    const firstReportId = first.diagnosis.reportId;
    const firstReportHash = first.diagnosis.reportHash;
    const firstSpawnCount = env.spawnCount();
    assert.ok(firstSpawnCount >= 1, 'first run must spawn the worker');

    // Restart: an accepted report already exists. The engine must reuse it
    // WITHOUT spawning a second worker, and return the SAME reportId/reportHash.
    const second = await env.runEngine({
      onWorkerPoll: () => { throw new Error('worker must NOT spawn on restart with accepted report'); },
    });
    assert.equal(second.diagnosis.status, 'completed');
    assert.equal(second.diagnosis.reportId, firstReportId, 'restart must reuse the same reportId');
    assert.equal(second.diagnosis.reportHash, firstReportHash, 'restart must reuse the same reportHash');
    // I7: spawn count did not increase.
    assert.equal(env.spawnCount(), firstSpawnCount, 'no second worker spawn when an accepted report exists');
    // Exactly one report row.
    assert.equal(env.reportRowCount(), 1);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D7 — paused diagnosis resumed: worker resumed EXACTLY once (I7)
// ---------------------------------------------------------------------------

test('D5 engine: paused resume once', async () => {
  const env = await realSqliteHarness();
  try {
    // Seed a pre-existing diagnosis control in 'paused' state with NO accepted
    // report (simulating a prior interrupted run). The service must RESUME it
    // (same ControlIntent) rather than creating a new one.
    env.seedPausedControl();
    const result = await env.runEngine({
      onWorkerPoll: (control, caseData) => env.submitValidGoReport(control, caseData),
    });
    assert.equal(result.diagnosis.status, 'completed');
    // I7: exactly one ControlIntent for this target (no second control created).
    assert.equal(env.controlRowCount(), 1, 'paused control must be reused, not duplicated');
    // The worker was resumed exactly once.
    assert.equal(env.spawnCount(), 1, 'paused diagnosis resumed exactly once');
    assert.equal(env.reportRowCount(), 1);
  } finally {
    env.cleanup();
  }
});
