/**
 * D3 index-migration tests (P0 fix, second review round).
 *
 * The original D3 (9895532) created the readiness-assessment idempotency index
 * as UNIQUE(control_intent_id, execution_id, content_hash). The correction
 * requires UNIQUE(control_intent_id, content_hash) (independent of execution).
 * CREATE UNIQUE INDEX IF NOT EXISTS is a NO-OP when an index of the SAME NAME
 * already exists — even if its columns differ — so on a pre-correction DB the
 * old index would survive and ON CONFLICT(control_intent_id, content_hash)
 * would throw. ensureSaga3ReadinessSchema must rebuild the index, deduping
 * existing rows deterministically. These tests reproduce the upgrade path.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { buildExecutionContext } = await import('../../dist/saga3/authority/build-execution-context.js');
const { executionContextHash } = await import('../../dist/saga3/domain/execution-context.js');
const {
  DISCOVERY_READINESS_INTENT_KIND,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);
const { canonicalJson } = await import('../../dist/saga3/persistence/saga3-normalization-repository.js');
const { createHash } = await import('node:crypto');

function freshFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d3-mig-'));
  process.env.DB_PATH = path.join(temp, 'mig.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  return { temp, db };
}
function hardClose(temp) {
  try { closeDb(); } catch { /* already closed */ }
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

const PROPOSAL_HASH = createHash('sha256').update(canonicalJson({
  problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: ['user'],
  assumptions: ['a'], unknowns: ['u'], risks: ['r'], candidate_scope: 's',
  evidence_refs: ['e'], recommended_outcome: 'clarify', rationale: 'r',
})).digest('hex');

test('P0 migration: execution-scoped index rebuilt to content-scoped; cross-exec replay works', async () => {
  const { temp, db } = freshFixture();
  try {
    // Close the production handle and tamper: install the ORIGINAL 3-column index.
    closeDb();
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(process.env.DB_PATH);
    rawDb.exec('DROP INDEX IF EXISTS idx_saga3_readiness_assessment_idempotency');
    rawDb.exec(
      `CREATE UNIQUE INDEX idx_saga3_readiness_assessment_idempotency
         ON saga3_readiness_assessments(control_intent_id, execution_id, content_hash)`,
    );
    let cols = rawDb.prepare(`PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')`).all().map(r => r.name);
    assert.deepEqual(cols, ['control_intent_id', 'execution_id', 'content_hash'],
      'pre-migration index must be the execution-scoped original');
    rawDb.close();

    // Reopen through getDb (production path) and run the migration.
    const migDb = getDb();
    const { ensureSaga3ReadinessSchema } = await import('../../dist/saga3/persistence/saga3-readiness-repository.js');
    ensureSaga3ReadinessSchema(migDb);

    cols = migDb.prepare(`PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')`).all().map(r => r.name);
    assert.deepEqual(cols, ['control_intent_id', 'content_hash'],
      'post-migration index must be content-scoped (independent of execution)');

    // Idempotent re-migration leaves the correct index in place.
    ensureSaga3ReadinessSchema(migDb);
    cols = migDb.prepare(`PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')`).all().map(r => r.name);
    assert.deepEqual(cols, ['control_intent_id', 'content_hash']);

    // Exercise ON CONFLICT across two executions: same content from exec A,
    // then replay from exec B must reuse the row.
    // Minimal live fixture on the migrated DB — with a real, valid Proposal
    // payload whose hash matches (the strict target re-validation requires it).
    const PROPOSAL_PAYLOAD = {
      problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: ['user'],
      assumptions: ['a'], unknowns: ['u'], risks: ['r'], candidate_scope: 's',
      evidence_refs: ['e'], recommended_outcome: 'clarify', rationale: 'r',
    };
    const REAL_HASH = createHash('sha256').update(canonicalJson(PROPOSAL_PAYLOAD)).digest('hex');
    migDb.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'D','done','discovery.work')`).run();
    migDb.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (1,10,'discovery','o','{}','s',0,0,100,'concluded')`).run();
    migDb.prepare(`INSERT INTO saga3_proposals (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance) VALUES (50,1,100,'product-exec','discovery','sv',?,?, 'submitted','{}')`)
      .run(JSON.stringify(PROPOSAL_PAYLOAD), REAL_HASH);
    const aa = { snapshot_ref: 'p', scope: 'x', allowed_tools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done'], enforcement: 'runtime' };
    migDb.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind,workflow_stage,execution_skill,execution_mode,generation_key,metadata,current_execution_id) VALUES (200,10,'A','in_progress','discovery.assess','discovery','saga-discovery-readiness-advisor','tracker_only','at',?,?)`)
      .run(JSON.stringify({ work_intent_id: 2 }), 'migr-exec-a');
    migDb.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (2,10,?,?,?,?,0,0,200,'open')`)
      .run(DISCOVERY_READINESS_INTENT_KIND, 'assess', JSON.stringify(aa), DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
    migDb.prepare(`INSERT INTO saga3_readiness_control_intents (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,authority_intent_id,projected_task_id,status) VALUES (1,10,'AssessDiscoveryReadiness',50,?,1,2,200,'executing')`).run(REAL_HASH);
    const intent = { id: 2, epic_id: 10, kind: DISCOVERY_READINESS_INTENT_KIND, objective: 'assess', authority_scope: aa, output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, token_budget: 0, retry_budget: 0, projected_task_id: 200, status: 'executing', created_at: 't' };
    const ecA = buildExecutionContext({ modelRoute: { model: 'm', provider: 'lmstudio', effort: null }, workIntent: intent, capturedAt: 't' });
    migDb.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata) VALUES ('migr-exec-a','ra',1,10,200,'wa','m','running','executing',?)`)
      .run(JSON.stringify({ execution_context: ecA, execution_context_hash: executionContextHash(ecA) }));

    const { createSaga3ReadinessHandlers } = await import('../../dist/tools/saga3-readiness.js');
    const { handlers } = createSaga3ReadinessHandlers({ db: () => migDb });
    const dims = {};
    for (const d of READINESS_DIMENSIONS) dims[d] = { status: 'sufficient', rationale: 'g', source_refs: ['$.problem_statement'] };
    const payload = { proposal_id: 50, proposal_content_hash: REAL_HASH, overall_readiness: 'ready', dimension_assessments: dims, blocking_gaps: [], non_blocking_gaps: [], recommended_next_action: 'proceed_to_settlement', confidence: 0.8, rationale: 'ok' };

    const first = handlers.readiness_submit({ control_intent_id: 1, execution_id: 'migr-exec-a', schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload });
    assert.equal(first.status, 'accepted_by_kernel');

    // Retire exec-a (one-active-task unique), add exec-b, replay same content.
    migDb.prepare("UPDATE worker_executions SET state='exited' WHERE execution_id='migr-exec-a'").run();
    const ecB = buildExecutionContext({ modelRoute: { model: 'm', provider: 'lmstudio', effort: null }, workIntent: intent, capturedAt: 't' });
    migDb.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata) VALUES ('migr-exec-b','rb',1,10,200,'wb','m','running','executing',?)`)
      .run(JSON.stringify({ execution_context: ecB, execution_context_hash: executionContextHash(ecB) }));
    migDb.prepare('UPDATE tasks SET current_execution_id=? WHERE id=200').run('migr-exec-b');

    const second = handlers.readiness_submit({ control_intent_id: 1, execution_id: 'migr-exec-b', schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload });
    assert.equal(second.assessment_id, first.assessment_id, 'cross-exec replay reuses the row');
    assert.equal(second.replayed, true);
    assert.equal(migDb.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 1);
  } finally { hardClose(temp); }
});

test('P0 migration: duplicates collapsed deterministically (keep accepted > rejected > submitted)', async () => {
  const { temp } = freshFixture();
  try {
    closeDb();
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(process.env.DB_PATH);
    rawDb.exec('DROP INDEX IF EXISTS idx_saga3_readiness_assessment_idempotency');
    rawDb.exec(
      `CREATE UNIQUE INDEX idx_saga3_readiness_assessment_idempotency
         ON saga3_readiness_assessments(control_intent_id, execution_id, content_hash)`,
    );
    // Seed three rows for the same (control_intent_id, content_hash), different
    // executions + statuses — the old index permitted this.
    const ch = '0'.repeat(64);
    // FK anchors: control intent + minimal proposal/intent rows.
    rawDb.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'D','done','discovery.work')`).run();
    rawDb.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (1,10,'discovery','o','{}','s',0,0,100,'concluded')`).run();
    rawDb.prepare(`INSERT INTO saga3_proposals (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance) VALUES (50,1,100,'e','discovery','sv','{}',?,'submitted','{}')`).run(ch);
    rawDb.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'A','done','discovery.assess')`).run();
    rawDb.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (2,10,'discovery.assess','o','{}','s',0,0,200,'concluded')`).run();
    rawDb.prepare(`INSERT INTO saga3_readiness_control_intents (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,authority_intent_id,projected_task_id,status) VALUES (1,10,'AssessDiscoveryReadiness',50,?,1,2,200,'concluded')`).run(ch);
    const baseRow = (status, exec) => [1, 50, ch, 200, exec, '{}', ch, status, null, null, '[]', '{}'];
    rawDb.prepare(`INSERT INTO saga3_readiness_assessments (control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,payload,content_hash,status,overall_readiness,recommended_next_action,validation_errors,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...baseRow('submitted', 'exec-x'));
    rawDb.prepare(`INSERT INTO saga3_readiness_assessments (control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,payload,content_hash,status,overall_readiness,recommended_next_action,validation_errors,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...baseRow('rejected_by_kernel', 'exec-y'));
    rawDb.prepare(`INSERT INTO saga3_readiness_assessments (control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,payload,content_hash,status,overall_readiness,recommended_next_action,validation_errors,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...baseRow('accepted_by_kernel', 'exec-z'));
    assert.equal(rawDb.prepare('SELECT COUNT(*) c FROM saga3_readiness_assessments').get().c, 3);
    rawDb.close();

    // Migration through the production path.
    const migDb = getDb();
    const { ensureSaga3ReadinessSchema } = await import('../../dist/saga3/persistence/saga3-readiness-repository.js');
    ensureSaga3ReadinessSchema(migDb);

    const survivors = migDb.prepare('SELECT status, execution_id FROM saga3_readiness_assessments').all();
    assert.equal(survivors.length, 1, 'duplicates collapsed to one row');
    assert.equal(survivors[0].status, 'accepted_by_kernel', 'kept the strongest status');
    assert.equal(survivors[0].execution_id, 'exec-z', 'kept the accepted execution');
    const cols = migDb.prepare(`PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')`).all().map(r => r.name);
    assert.deepEqual(cols, ['control_intent_id', 'content_hash']);
  } finally { hardClose(temp); }
});

test('P0 migration: fresh DB (no prior index) gets the correct content-scoped index directly', async () => {
  const { temp, db } = freshFixture();
  try {
    const { ensureSaga3ReadinessSchema } = await import('../../dist/saga3/persistence/saga3-readiness-repository.js');
    ensureSaga3ReadinessSchema(db);
    const cols = db.prepare(`PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')`).all().map(r => r.name);
    assert.deepEqual(cols, ['control_intent_id', 'content_hash']);
  } finally { hardClose(temp); }
});
