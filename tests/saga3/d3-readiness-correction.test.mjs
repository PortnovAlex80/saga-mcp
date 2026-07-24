/**
 * D3 correction tests — the P0/P1 fixes the review mandated.
 *
 * These cover the contracts that the original D3 implementation got wrong:
 *   - durable rejected_by_kernel assessment (P0-2): the row survives with
 *     validation_errors, the advisor proposal is never silently discarded;
 *   - correct shadow matrix (P0-1): task-done-without-assessment → failed,
 *     never masked as not_run; rejected → failed;
 *   - engine isolation (P0-3): a throwing readiness phase cannot rewrite a
 *     successful discovery result;
 *   - non-empty source_refs grounding (P1-1);
 *   - strict Proposal target re-validation (P1-2): intent_id/epic/hash binding;
 *   - execution-independent idempotency (P1-3): same content, new execution →
 *     same row.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { buildExecutionContext } = await import('../../dist/saga3/authority/build-execution-context.js');
const { executionContextHash } = await import('../../dist/saga3/domain/execution-context.js');
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import('../../dist/saga3/domain/discovery-proposal.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);
const { ensureSaga3ReadinessSchema } = await import(
  '../../dist/saga3/persistence/saga3-readiness-repository.js'
);
const { canonicalJson } = await import('../../dist/saga3/persistence/saga3-normalization-repository.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d3-fix-'));
  process.env.DB_PATH = path.join(temp, 'fix.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  ensureSaga3ReadinessSchema(db);
  return { temp, db };
}
function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

const PROPOSAL_PAYLOAD = {
  problem_statement: 'the problem', observed_context: 'the context',
  stakeholders_or_actors: ['user'], assumptions: ['assumption'],
  unknowns: ['unknown'], risks: ['risk'], candidate_scope: 'scope',
  evidence_refs: ['artifact:req-1'], recommended_outcome: 'clarify', rationale: 'rationale',
};
const PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PROPOSAL_PAYLOAD)).digest('hex');

function validAssessment(proposalId = 50, hash = PROPOSAL_HASH, overrides = {}) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_id: proposalId, proposal_content_hash: hash,
    overall_readiness: 'ready', dimension_assessments: dims,
    blocking_gaps: [], non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement', confidence: 0.8,
    rationale: 'well grounded', ...overrides,
  };
}

/**
 * Build a live fixture (mirrors d3-readiness-handler.test buildLiveFixture).
 * proposalId defaults 50; intent 1, task 100 (product); intent 2, task 200
 * (advisor). executionId defaults 'advisor-exec'.
 */
function buildLiveFixture(db, { executionId = 'advisor-exec', proposalId = 50, advisorTaskId = 200, epicId = 10 } = {}) {
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,?,'Discovery','done','discovery.work')`).run(epicId);
  db.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (1,?,?,?,?,?,?,?,100,'concluded')`)
    .run(epicId, DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA, 0, 0);
  db.prepare(`INSERT INTO saga3_proposals (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance) VALUES (50,1,100,'product-exec','discovery',?,?,?,'submitted','{}')`)
    .run(DISCOVERY_PROPOSAL_SCHEMA, JSON.stringify(PROPOSAL_PAYLOAD), PROPOSAL_HASH);

  const advisorAuthority = {
    snapshot_ref: `proposal:${proposalId}:${PROPOSAL_HASH.slice(0, 12)}`,
    scope: 'read-only shadow readiness assessment',
    allowed_tools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done'],
    enforcement: 'runtime',
  };
  // All values via placeholders to avoid mixed-literal column-count pitfalls.
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind,workflow_stage,execution_skill,execution_mode,generation_key,metadata,current_execution_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(advisorTaskId, epicId, 'Assess', 'in_progress',
      'discovery.assess', 'discovery', 'saga-discovery-readiness-advisor',
      'tracker_only', 'assess-task', JSON.stringify({ work_intent_id: 2 }), executionId);
  db.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (2,?,?,?,?,?,?,?,?,'open')`)
    .run(epicId, DISCOVERY_READINESS_INTENT_KIND, 'assess', JSON.stringify(advisorAuthority), DISCOVERY_READINESS_ASSESSMENT_SCHEMA, 0, 0, advisorTaskId);
  db.prepare(`INSERT INTO saga3_readiness_control_intents (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,authority_intent_id,projected_task_id,status) VALUES (1,?,'AssessDiscoveryReadiness',?,?,?,?,?,'executing')`)
    .run(epicId, proposalId, PROPOSAL_HASH, 1, 2, advisorTaskId);

  const intent = {
    id: 2, epic_id: epicId, kind: DISCOVERY_READINESS_INTENT_KIND,
    objective: 'assess', authority_scope: advisorAuthority,
    output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    token_budget: 0, retry_budget: 0, projected_task_id: advisorTaskId,
    status: 'executing', created_at: '2026-07-24T00:00:00.000Z',
  };
  const execution_context = buildExecutionContext({
    modelRoute: { model: 'advisor-model', provider: 'lmstudio', effort: null },
    workIntent: intent, capturedAt: '2026-07-24T00:00:00.000Z',
  });
  db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(executionId, 'run-r', 1, epicId, advisorTaskId, 'advisor-worker', 'm', 'running', 'executing', JSON.stringify({
      execution_context, execution_context_hash: executionContextHash(execution_context),
    }));
  return { executionId, controlIntentId: 1, proposalId, advisorTaskId };
}

// ---------------------------------------------------------------------------
// P0-2: durable rejected_by_kernel
// ---------------------------------------------------------------------------

test('P0-2: rejected assessment is durable — row persisted with rejected_by_kernel + validation_errors', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    // Invent an evidence ref not in the allowed set.
    const bad = validAssessment();
    bad.dimension_assessments.problem_clarity.source_refs = ['$.problem_statement', 'invented:ref:9'];
    const result = handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: bad,
    });
    // The handler returns a structured rejection, NOT a throw.
    assert.equal(result.status, 'rejected_by_kernel');
    assert.ok(result.validation_errors.some(e => e.includes('invented:ref:9')));
    // The row IS persisted (durable), not discarded.
    const row = db.prepare('SELECT status, validation_errors, overall_readiness FROM saga3_readiness_assessments WHERE id=?').get(result.assessment_id);
    assert.equal(row.status, 'rejected_by_kernel');
    assert.equal(row.overall_readiness, null);
    const errs = JSON.parse(row.validation_errors);
    assert.ok(errs.some(e => e.includes('invented:ref:9')));
  } finally { cleanup(temp); }
});

test('P0-2: rejected assessment is observable in the shadow matrix (service)', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    const bad = validAssessment();
    bad.dimension_assessments.problem_clarity.source_refs = ['invented:ref'];
    handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: bad,
    });
    // The service's shadowFrom must report failed (not not_run) for a rejected
    // assessment, with the assessmentId and rejection error.
    const { Saga3DiscoveryReadinessService } = await import('../../dist/saga3/application/discovery-readiness-service.js');
    const fakeRt = {
      ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: PROPOSAL_HASH, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 200 }),
      prepareIntentForExecution: () => ({ state: 'done', intentStatus: 'concluded', taskStatus: 'done' }),
      setIntentStatus: () => true, setReadinessControlStatus: () => true,
      readLatestReadinessAssessment: (cid) => {
        const row = db.prepare('SELECT * FROM saga3_readiness_assessments WHERE control_intent_id=? ORDER BY id DESC LIMIT 1').get(cid);
        if (!row) return null;
        return {
          id: row.id, control_intent_id: row.control_intent_id, proposal_id: row.proposal_id,
          proposal_content_hash: row.proposal_content_hash, task_id: row.task_id, execution_id: row.execution_id,
          payload: JSON.parse(row.payload), content_hash: row.content_hash, status: row.status,
          overall_readiness: row.overall_readiness, recommended_next_action: row.recommended_next_action,
          validation_errors: JSON.parse(row.validation_errors ?? '[]'), provenance: null, created_at: row.created_at,
        };
      },
    };
    const svc = new Saga3DiscoveryReadinessService({
      config: { dbPath: '/d', claudePath: 'c', lmStudioUrl: 'http://x/v1' },
      workerExecutorFactory: () => ({}), host: { workerPaths: {} }, runtimePersistence: fakeRt,
    });
    const out = await svc.assess({ projectId: 1, epicId: 10, proposalId: 50, proposalContentHash: PROPOSAL_HASH, sourceIntentId: 1, objective: 'o', workspaceRoot: '/w', heartbeat: () => {} });
    assert.equal(out.shadow.status, 'failed');
    assert.equal(out.shadow.authority, 'none');
    assert.ok(out.shadow.assessmentId > 0);
    assert.match(out.shadow.error, /assessment rejected/);
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// P0-1: shadow matrix — task done without accepted assessment → failed
// ---------------------------------------------------------------------------

test('P0-1: advisor task done + no assessment → readiness.failed (never not_run)', async () => {
  const { Saga3DiscoveryReadinessService } = await import('../../dist/saga3/application/discovery-readiness-service.js');
  const svc = new Saga3DiscoveryReadinessService({
    config: { dbPath: '/d', claudePath: 'c', lmStudioUrl: 'http://x/v1' },
    workerExecutorFactory: () => ({}), host: { workerPaths: {} },
    runtimePersistence: {
      // ensureReadinessControl succeeds; task already done; NO assessment row.
      ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: PROPOSAL_HASH, controlStatus: 'executing', authorityIntentId: 2, authorityIntentStatus: 'executing', taskId: 200 }),
      prepareIntentForExecution: () => ({ state: 'done', intentStatus: 'executing', taskStatus: 'done' }),
      setIntentStatus: () => true, setReadinessControlStatus: () => true,
      readLatestReadinessAssessment: () => null,
    },
  });
  const out = await svc.assess({ projectId: 1, epicId: 10, proposalId: 50, proposalContentHash: PROPOSAL_HASH, sourceIntentId: 1, objective: 'o', workspaceRoot: '/w', heartbeat: () => {} });
  assert.equal(out.shadow.status, 'failed', 'task done with no assessment must be failed, not not_run');
  assert.ok(out.shadow.error);
});

test('P0-1: accepted assessment → readiness.completed; verdict carried', async () => {
  const { Saga3DiscoveryReadinessService } = await import('../../dist/saga3/application/discovery-readiness-service.js');
  const svc = new Saga3DiscoveryReadinessService({
    config: { dbPath: '/d', claudePath: 'c', lmStudioUrl: 'http://x/v1' },
    workerExecutorFactory: () => ({}), host: { workerPaths: {} },
    runtimePersistence: {
      ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: PROPOSAL_HASH, controlStatus: 'executing', authorityIntentId: 2, authorityIntentStatus: 'executing', taskId: 200 }),
      prepareIntentForExecution: () => ({ state: 'done', intentStatus: 'executing', taskStatus: 'done' }),
      setIntentStatus: () => true, setReadinessControlStatus: () => true,
      readLatestReadinessAssessment: () => ({
        id: 7, control_intent_id: 1, proposal_id: 50, proposal_content_hash: PROPOSAL_HASH,
        task_id: 200, execution_id: 'e', payload: {}, content_hash: 'h',
        status: 'accepted_by_kernel', overall_readiness: 'ready',
        recommended_next_action: 'proceed_to_settlement',
        validation_errors: [], provenance: null, created_at: 't',
      }),
    },
  });
  const out = await svc.assess({ projectId: 1, epicId: 10, proposalId: 50, proposalContentHash: PROPOSAL_HASH, sourceIntentId: 1, objective: 'o', workspaceRoot: '/w', heartbeat: () => {} });
  assert.equal(out.shadow.status, 'completed');
  assert.equal(out.shadow.authority, 'shadow_advisor');
  assert.equal(out.shadow.overallReadiness, 'ready');
});

// ---------------------------------------------------------------------------
// P0-3: engine isolation — a throwing readiness phase must not fail discovery
// ---------------------------------------------------------------------------

test('P0-3: readiness service throws → discovery result preserved, readiness.failed', async () => {
  const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');
  // Reuse the d1-engine fakes minimally: discovery must complete cleanly.
  const validPayload = PROPOSAL_PAYLOAD;
  let proposal = null;
  let task = null;
  const runtime = {
    readEpicObjective: () => ({ name: 'e', description: 'd' }),
    readOpenIntent: (_e, kind) => null,
    createIntent(c) { return { id: 1, epic_id: c.epic_id, kind: c.kind, objective: c.objective, authority_scope: c.authority_scope, output_schema: c.output_schema, projected_task_id: null, status: 'open', created_at: 't' }; },
    setProjectedTask: () => {},
    setIntentStatus: () => true,
    ensureProjectedTask() { task = { id: 100, status: 'todo' }; return 100; },
    readTaskState: () => task ? task.status : null,
    prepareIntentForExecution: () => ({ state: 'ready', intentStatus: 'open', taskStatus: 'todo' }),
    readWorkIntentForTask: () => null,
    readLatestProposal: () => proposal,
    readLatestRawSubmission: () => null,
    ensureNormalizationControl: () => ({ controlIntentId: 1, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 100 }),
    setControlIntentStatus: () => true,
    ensureReadinessControl: () => { throw new Error('readiness persistence exploded'); },
    setReadinessControlStatus: () => true,
    readLatestReadinessAssessment: () => null,
    _tick() {
      if (!proposal) { proposal = { id: 50, payload: validPayload, content_hash: PROPOSAL_HASH, provenance: null }; }
      if (task) task.status = 'done';
    },
  };
  let executorStopped = false;
  const executor = {
    start() {}, status() { if (!executorStopped) runtime._tick(); return { status: 'running', active: [] }; },
    stop() { executorStopped = true; }, dispose() {}, setConcurrency() {},
  };
  const throwingReadiness = { assess: async () => { throw new Error('boom'); } };
  const engine = new Saga3DiscoveryEngine({
    config: { dbPath: '/d', claudePath: 'c', lmStudioUrl: 'http://x/v1' },
    workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: { acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }), releaseEngineLock: () => {}, workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' }, heartbeat: () => {} },
    runtimePersistence: runtime, pollMs: 0, readinessService: throwingReadiness,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  // Discovery succeeded — NOT rewritten to failed.
  assert.equal(result.outcome, 'clarify');
  assert.equal(result.outcomeAuthority, 'worker_proposal');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.reason, 'completed');
  // Readiness reported the failure separately.
  assert.equal(result.readiness.status, 'failed');
  assert.equal(result.readiness.error, 'boom');
});

// ---------------------------------------------------------------------------
// P1-1: non-empty source_refs
// ---------------------------------------------------------------------------

test('P1-1: empty dimension source_refs rejected (grounding required)', async () => {
  const { validateReadinessAssessment } = await import('../../dist/saga3/domain/discovery-readiness-assessment.js');
  const a = validAssessment();
  a.dimension_assessments.problem_clarity.source_refs = [];
  const r = validateReadinessAssessment(a, 50, PROPOSAL_HASH, ['$.problem_statement']);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('problem_clarity.source_refs must cite at least one source')));
});

test('P1-1: empty gap source_refs rejected', async () => {
  const { validateReadinessAssessment } = await import('../../dist/saga3/domain/discovery-readiness-assessment.js');
  const a = validAssessment();
  a.blocking_gaps = [{ code: 'G1', description: 'gap', source_refs: [] }];
  const r = validateReadinessAssessment(a, 50, PROPOSAL_HASH, ['$.unknowns']);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('blocking_gaps[0].source_refs must cite at least one source')));
});

// ---------------------------------------------------------------------------
// P1-2: strict Proposal target re-validation (intent_id / epic / hash binding)
// ---------------------------------------------------------------------------

test('P1-2: proposal intent_id mismatch rejected', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    // Create an intent 999 (in epic 10) so the FK on source_intent_id is
    // satisfiable, then point the ControlIntent at it — diverging from the
    // Proposal's intent_id (1). The handler must reject (target integrity).
    db.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,status) VALUES (999,10,'discovery','other','{}','s',0,0,'concluded')`).run();
    db.prepare('UPDATE saga3_readiness_control_intents SET source_intent_id=999 WHERE id=1').run();
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessment(),
    }), /target integrity check failed.*intent_id/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 0);
  } finally { cleanup(temp); }
});

test('P1-2: control/execution epic mismatch rejected', async () => {
  const { temp, db } = fixture();
  try {
    // Build the execution under a different epic than the control.
    const ctx = buildLiveFixture(db, { epicId: 10 });
    // Move only the worker_execution to epic 11, leaving the control at epic 10.
    db.prepare('UPDATE worker_executions SET epic_id=11 WHERE execution_id=?').run(ctx.executionId);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessment(),
    }), /target integrity check failed.*epic/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 0);
  } finally { cleanup(temp); }
});

test('P1-2: corrupted proposal payload (hash mismatch) rejected', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    // Tamper with the payload WITHOUT updating the hash → recomputed hash differs.
    db.prepare('UPDATE saga3_proposals SET payload=? WHERE id=50').run(JSON.stringify({ ...PROPOSAL_PAYLOAD, problem_statement: 'tampered' }));
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessment(),
    }), /target integrity check failed.*content_hash mismatch/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 0);
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// P1-3: execution-independent idempotency
// ---------------------------------------------------------------------------

test('P1-3: same assessment content, new execution_id → same row (no duplicate)', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db, { executionId: 'exec-one' });
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers: h1 } = createSaga3ReadinessHandlers({ db: () => db });
    const payload = validAssessment();
    const first = h1.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: 'exec-one',
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload,
    });
    assert.equal(first.status, 'accepted_by_kernel');

    // A restart with a DIFFERENT execution_id but the same content must reuse
    // the row (idempotency is by content, not execution).
    // Rebuild a live binding for the new execution on the same control/task.
    // First retire the prior execution: idx_worker_executions_one_active_task
    // forbids two active rows for the same task.
    db.prepare("UPDATE worker_executions SET state='exited' WHERE execution_id='exec-one'").run();
    const advisorAuthority = {
      snapshot_ref: `proposal:50:${PROPOSAL_HASH.slice(0, 12)}`,
      scope: 'read-only shadow readiness assessment',
      allowed_tools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done'],
      enforcement: 'runtime',
    };
    const intent = {
      id: 2, epic_id: 10, kind: DISCOVERY_READINESS_INTENT_KIND, objective: 'assess',
      authority_scope: advisorAuthority, output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
      token_budget: 0, retry_budget: 0, projected_task_id: 200, status: 'executing', created_at: 't',
    };
    const execution_context = buildExecutionContext({
      modelRoute: { model: 'advisor-model', provider: 'lmstudio', effort: null },
      workIntent: intent, capturedAt: 't',
    });
    db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata) VALUES ('exec-two','r2',1,10,200,'w2','m','running','executing',?)`)
      .run(JSON.stringify({ execution_context, execution_context_hash: executionContextHash(execution_context) }));
    db.prepare('UPDATE tasks SET current_execution_id=? WHERE id=200').run('exec-two');

    const second = h1.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: 'exec-two',
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload,
    });
    assert.equal(second.assessment_id, first.assessment_id, 'same content → same row');
    assert.equal(second.replayed, true);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 1);
  } finally { cleanup(temp); }
});
