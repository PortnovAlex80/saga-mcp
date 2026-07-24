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
const { canonicalJson } = await import('../../dist/saga3/persistence/saga3-normalization-repository.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);
const { ensureSaga3ReadinessSchema } = await import('../../dist/saga3/persistence/saga3-readiness-repository.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d3-handler-'));
  process.env.DB_PATH = path.join(temp, 'd3.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(
    `INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`,
  ).run();
  ensureSaga3ReadinessSchema(db);
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
  recommended_outcome: 'clarify',
  rationale: 'rationale',
};
// P1-2: compute the REAL hash so the strict target re-validation in the
// handler passes (it recomputes from payload and compares to the stored hash).
const PRODUCT_PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PRODUCT_PROPOSAL_PAYLOAD)).digest('hex');

function validAssessmentPayload(proposalId = 50, proposalHash = PRODUCT_PROPOSAL_HASH) {
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
    confidence: 0.8,
    rationale: 'well grounded',
  };
}

/**
 * Build a full live fixture: product WorkIntent+task+proposal, readiness
 * ControlIntent+authority WorkIntent+task+execution_context. Returns the
 * pieces a readiness_submit call needs.
 */
function buildLiveFixture(db, { epicId = 10, proposalId = 50, taskId = 100, advisorTaskId = 200, executionId = 'advisor-exec' } = {}) {
  // Product proposal row (the assessment target). intent_id=1, task_id=100.
  // NB: tasks first because saga3_work_intents.projected_task_id REFERENCES tasks(id).
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
     VALUES (50,1,100,'product-exec','discovery',?,?,?, 'submitted', '{}')`,
  ).run(DISCOVERY_PROPOSAL_SCHEMA, JSON.stringify(PRODUCT_PROPOSAL_PAYLOAD), PRODUCT_PROPOSAL_HASH);

  // Readiness authority WorkIntent. Advisor task must exist first (FK on
  // saga3_work_intents.projected_task_id REFERENCES tasks(id)).
  const advisorAuthority = {
    snapshot_ref: `proposal:${proposalId}:${PRODUCT_PROPOSAL_HASH.slice(0, 12)}`,
    scope: 'read-only shadow readiness assessment',
    allowed_tools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done'],
    enforcement: 'runtime',
  };
  // Advisor task.
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,task_kind,workflow_stage,execution_skill,
        execution_mode,generation_key,metadata,current_execution_id)
     VALUES (?,?,?,?, 'discovery.assess','discovery','saga-discovery-readiness-advisor',
        'tracker_only','assess-task',?,?)`,
  ).run(advisorTaskId, epicId, 'Assess', 'in_progress', JSON.stringify({ work_intent_id: 2 }), executionId);
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,?, 'open')`,
  ).run(
    DISCOVERY_READINESS_INTENT_KIND,
    'assess',
    JSON.stringify(advisorAuthority),
    DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    advisorTaskId,
  );
  // Readiness ControlIntent.
  db.prepare(
    `INSERT INTO saga3_readiness_control_intents
       (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'executing')`,
  ).run(proposalId, PRODUCT_PROPOSAL_HASH, 1, 2, advisorTaskId);

  // Execution context snapshot + worker_execution.
  const intent = {
    id: 2, epic_id: 10, kind: DISCOVERY_READINESS_INTENT_KIND,
    objective: 'assess', authority_scope: advisorAuthority,
    output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    token_budget: 0, retry_budget: 0, projected_task_id: advisorTaskId,
    status: 'executing', created_at: '2026-07-24T00:00:00.000Z',
  };
  const execution_context = buildExecutionContext({
    modelRoute: { model: 'advisor-model', provider: 'lmstudio', effort: null },
    workIntent: intent,
    capturedAt: '2026-07-24T00:00:00.000Z',
  });
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        state,phase,metadata)
     VALUES (?,?,1,10,?,?, 'm','running','executing',?)`,
  ).run(executionId, 'run-r', advisorTaskId, 'advisor-worker', JSON.stringify({
    execution_context,
    execution_context_hash: executionContextHash(execution_context),
  }));
  return { executionId, controlIntentId: 1, proposalId, advisorTaskId };
}

test('D3 handler: valid accepted assessment persisted with shadow provenance', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    const result = handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId,
      execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
      payload: validAssessmentPayload(),
    });
    assert.equal(result.status, 'accepted_by_kernel');
    assert.equal(result.replayed, false);
    assert.ok(result.assessment_id > 0);
    // Row persisted with accepted status + shadow provenance.
    const row = db.prepare('SELECT status, overall_readiness, recommended_next_action, provenance FROM saga3_readiness_assessments WHERE id=?').get(result.assessment_id);
    assert.equal(row.status, 'accepted_by_kernel');
    assert.equal(row.overall_readiness, 'ready');
    const prov = JSON.parse(row.provenance);
    assert.equal(prov.execution_id, 'advisor-exec');
    assert.equal(prov.worker_id, 'advisor-worker');
  } finally { cleanup(temp); }
});

test('D3 handler: exact replay is idempotent (same content hash → same row, replayed=true)', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    const payload = validAssessmentPayload();
    const first = handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload,
    });
    const second = handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload,
    });
    assert.equal(first.assessment_id, second.assessment_id);
    assert.equal(second.replayed, true);
    // Only one row.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 1);
  } finally { cleanup(temp); }
});

test('D3 handler: wrong task execution rejected (execution bound to a different task than the control)', async () => {
  const { temp, db } = fixture();
  try {
    // Bind the execution to a DIFFERENT task than the control's projected task.
    // This is caught by the strict execution-context reader (the snapshot's
    // task_id no longer matches the worker_executions row) — the binding gate
    // never gets a valid authority, so the call is rejected before persistence.
    const ctx = buildLiveFixture(db, { advisorTaskId: 200 });
    db.prepare('UPDATE worker_executions SET task_id=999 WHERE execution_id=?').run(ctx.executionId);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessmentPayload(),
    }), /AUTHORITY_CONTEXT_INVALID|task/);
  } finally { cleanup(temp); }
});

test('D3 handler: dead execution rejected', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    db.prepare("UPDATE worker_executions SET state='exited' WHERE execution_id=?").run(ctx.executionId);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessmentPayload(),
    }), /is not live/);
  } finally { cleanup(temp); }
});

test('D3 handler: authority mismatch (execution bound to a different WorkIntent) rejected', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    // Rebind the execution_context snapshot to a different work_intent_id.
    const execRow = db.prepare('SELECT metadata FROM worker_executions WHERE execution_id=?').get(ctx.executionId);
    const meta = JSON.parse(execRow.metadata);
    meta.execution_context.work_intent_id = 999;
    // authority_hash must be recomputed or the strict reader rejects it — so we
    // also null the authority to force AUTHORITY_CONTEXT_INVALID instead.
    meta.execution_context.authority = null;
    db.prepare('UPDATE worker_executions SET metadata=? WHERE execution_id=?').run(JSON.stringify(meta), ctx.executionId);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessmentPayload(),
    }), /AUTHORITY_CONTEXT_INVALID|has no Saga 3 authority/);
  } finally { cleanup(temp); }
});

test('D3 handler: changed proposal content_hash rejected (immutable target binding)', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    // Mutate the product proposal's content_hash AFTER the ControlIntent was
    // created for the old hash. The strict target re-validation (P1-2) catches
    // this because the recomputed hash no longer matches the stored hash, and
    // neither matches the ControlIntent's target. Throw before persistence.
    db.prepare('UPDATE saga3_proposals SET content_hash=? WHERE id=50').run('d'.repeat(64));
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessmentPayload(),
    }), /Proposal target integrity check failed.*content_hash/);
    // No assessment row must be persisted for an integrity violation.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 0);
  } finally { cleanup(temp); }
});

test('D3 handler: assessment lineage stays separate from product Proposal provenance', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: validAssessmentPayload(),
    });
    // The product Proposal row must NOT have been touched by the advisor.
    const product = db.prepare('SELECT execution_id, provenance FROM saga3_proposals WHERE id=50').get();
    assert.equal(product.execution_id, 'product-exec');
    // Its provenance stays the empty '{}' we set — advisor never wrote into it.
    assert.equal(product.provenance, '{}');
    // The advisor identity lives ONLY in the assessment row.
    const assessment = db.prepare('SELECT execution_id, provenance FROM saga3_readiness_assessments ORDER BY id DESC LIMIT 1').get();
    assert.equal(assessment.execution_id, 'advisor-exec');
    assert.equal(JSON.parse(assessment.provenance).execution_id, 'advisor-exec');
  } finally { cleanup(temp); }
});

test('D3 handler: readiness_get returns allowed_source_refs (anti-invent-evidence contract)', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    const out = handlers.readiness_get({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
    });
    assert.equal(out.proposal_id, 50);
    assert.equal(out.proposal_content_hash, PRODUCT_PROPOSAL_HASH);
    // Must include the evidence literal + the proposal field paths + lineage id.
    assert.ok(out.allowed_source_refs.includes('artifact:req-1'));
    assert.ok(out.allowed_source_refs.includes('$.problem_statement'));
    assert.ok(out.allowed_source_refs.includes('proposal:50'));
    assert.equal(out.output_schema, DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
  } finally { cleanup(temp); }
});

test('D3 handler: schema_version mismatch rejected', async () => {
  const { temp, db } = fixture();
  try {
    const ctx = buildLiveFixture(db);
    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => db });
    assert.throws(() => handlers.readiness_submit({
      control_intent_id: ctx.controlIntentId, execution_id: ctx.executionId,
      schema_version: 'bogus.v1', payload: validAssessmentPayload(),
    }), /schema_version mismatch/);
  } finally { cleanup(temp); }
});
