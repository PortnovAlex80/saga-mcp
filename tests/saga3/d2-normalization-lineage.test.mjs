import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { buildExecutionContext } = await import(
  '../../dist/saga3/authority/build-execution-context.js'
);
const { executionContextHash } = await import(
  '../../dist/saga3/domain/execution-context.js'
);
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_NORMALIZATION_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import(
  '../../dist/saga3/domain/discovery-proposal.js'
);
const { DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA } = await import(
  '../../dist/saga3/domain/discovery-normalization-proposal.js'
);
const {
  ensureSaga3NormalizationSchema,
  insertRawSubmission,
} = await import('../../dist/saga3/persistence/saga3-normalization-repository.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d2-lineage-'));
  process.env.DB_PATH = path.join(temp, 'lineage.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(
    `INSERT INTO episode_workflows (epic_id,stage,metadata)
     VALUES (10,'discovery','{}')`,
  ).run();
  ensureSaga3NormalizationSchema(db);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('normalized canonical Proposal keeps source product task/execution and nests normalizer provenance', async () => {
  const { temp, db } = fixture();
  try {
    const productAuthority = {
      snapshot_ref: 'episode:10',
      scope: 'discovery',
      allowed_tools: ['proposal_submit', 'worker_done'],
      enforcement: 'runtime',
    };
    db.prepare(
      `INSERT INTO tasks
         (id,epic_id,title,status,task_kind,workflow_stage,generation_key,metadata)
       VALUES (100,10,'Discovery','done','discovery.work','discovery','source-task',?)`,
    ).run(JSON.stringify({ work_intent_id: 1 }));
    db.prepare(
      `INSERT INTO saga3_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,
          token_budget,retry_budget,projected_task_id,status)
       VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
    ).run(
      DISCOVERY_INTENT_KIND,
      'discover',
      JSON.stringify(productAuthority),
      DISCOVERY_WORK_INTENT_SCHEMA,
    );

    const sourcePayload = {
      problem_statement: 'source problem',
      problem: 'conflicting alias',
      observed_context: 'source context',
      stakeholders_or_actors: ['actor'],
      assumptions: [],
      unknowns: ['unknown'],
      risks: ['risk'],
      candidate_scope: 'scope',
      evidence_refs: ['artifact:1'],
      recommended_outcome: 'clarify',
      rationale: 'source rationale',
    };
    const sourceProvenance = {
      model: 'product-model',
      provider: 'lmstudio',
      effort: 'high',
      worker_id: 'product-worker',
      execution_id: 'product-exec',
      submitted_at: '2026-07-24T00:00:00.000Z',
    };
    const raw = insertRawSubmission(db, {
      intentId: 1,
      taskId: 100,
      executionId: 'product-exec',
      kind: DISCOVERY_INTENT_KIND,
      schemaVersion: DISCOVERY_PROPOSAL_SCHEMA,
      rawPayload: JSON.stringify(sourcePayload),
      parsedPayload: sourcePayload,
      status: 'normalization_required',
      normalizationTrace: ['direct_object'],
      validationErrors: [],
      aliasConflicts: ['problem_statement<->problem'],
      allowedEvidenceRefs: ['artifact:1'],
      provenance: sourceProvenance,
    }).record;

    const normalizerAuthority = {
      snapshot_ref: `raw-submission:${raw.id}`,
      scope: 'normalize immutable discovery response',
      allowed_tools: ['task_get', 'normalization_get', 'normalization_submit', 'worker_done'],
      enforcement: 'runtime',
    };
    db.prepare(
      `INSERT INTO tasks
         (id,epic_id,title,status,task_kind,workflow_stage,execution_skill,
          execution_mode,generation_key,metadata,current_execution_id)
       VALUES (200,10,'Normalize','in_progress','discovery.normalize','discovery',
          'saga-discovery-normalizer','tracker_only','normalize-task',?,?)`,
    ).run(JSON.stringify({ work_intent_id: 2 }), 'normalizer-exec');
    db.prepare(
      `INSERT INTO saga3_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,
          token_budget,retry_budget,projected_task_id,status)
       VALUES (2,10,?,?,?,?,0,0,200,'executing')`,
    ).run(
      DISCOVERY_NORMALIZATION_INTENT_KIND,
      'normalize source',
      JSON.stringify(normalizerAuthority),
      DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
    );
    db.prepare(
      `INSERT INTO saga3_control_intents
         (id,epic_id,kind,question,source_submission_id,authority_intent_id,
          projected_task_id,status)
       VALUES (20,10,'NormalizeDiscoveryProposal','normalize',?,2,200,'executing')`,
    ).run(raw.id);

    const normalizerIntent = {
      id: 2,
      epic_id: 10,
      kind: DISCOVERY_NORMALIZATION_INTENT_KIND,
      objective: 'normalize source',
      authority_scope: normalizerAuthority,
      output_schema: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
      token_budget: 0,
      retry_budget: 0,
      projected_task_id: 200,
      status: 'executing',
      created_at: '2026-07-24T00:01:00.000Z',
    };
    const execution_context = buildExecutionContext({
      modelRoute: { model: 'normalizer-model', provider: 'zai', effort: 'medium' },
      workIntent: normalizerIntent,
      capturedAt: '2026-07-24T00:01:00.000Z',
    });
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          state,phase,metadata)
       VALUES ('normalizer-exec','run-n',1,10,200,'normalizer-worker','m',
          'running','executing',?)`,
    ).run(JSON.stringify({
      execution_context,
      execution_context_hash: executionContextHash(execution_context),
    }));

    const normalizedPayload = {
      problem_statement: 'source problem',
      observed_context: 'source context',
      stakeholders_or_actors: ['actor'],
      assumptions: [],
      unknowns: ['unknown'],
      risks: ['risk'],
      candidate_scope: 'scope',
      evidence_refs: ['artifact:1'],
      recommended_outcome: 'clarify',
      rationale: 'source rationale',
    };
    const source_field_map = Object.fromEntries(
      Object.keys(normalizedPayload).map(field => [field, [`$.${field}`]]),
    );
    const { createSaga3NormalizationHandlers } = await import(
      '../../dist/tools/saga3-normalization.js'
    );
    const { handlers } = createSaga3NormalizationHandlers({
      db: () => db,
      now: () => new Date('2026-07-24T00:02:00.000Z'),
    });
    const result = handlers.normalization_submit({
      control_intent_id: 20,
      source_submission_id: raw.id,
      execution_id: 'normalizer-exec',
      schema_version: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
      payload: {
        source_submission_id: raw.id,
        source_raw_hash: raw.raw_hash,
        normalized_payload: normalizedPayload,
        source_field_map,
        notes: [],
      },
    });

    const canonical = db.prepare(
      `SELECT task_id,execution_id,provenance,source_submission_id,
              normalization_proposal_id
         FROM saga3_proposals WHERE id=?`,
    ).get(result.proposal_id);
    const provenance = JSON.parse(canonical.provenance);
    assert.equal(canonical.task_id, 100);
    assert.equal(canonical.execution_id, 'product-exec');
    assert.equal(provenance.execution_id, 'product-exec');
    assert.equal(provenance.worker_id, 'product-worker');
    assert.equal(provenance.normalization_mode, 'lm_transformation');
    assert.equal(provenance.source_submission_id, raw.id);
    assert.equal(provenance.normalization_proposal_id, result.normalization_proposal_id);
    assert.equal(provenance.normalizer.execution_id, 'normalizer-exec');
    assert.equal(provenance.normalizer.worker_id, 'normalizer-worker');
    assert.equal(canonical.source_submission_id, raw.id);
    assert.equal(canonical.normalization_proposal_id, result.normalization_proposal_id);

    const transform = db.prepare(
      `SELECT task_id,execution_id FROM saga3_normalization_proposals WHERE id=?`,
    ).get(result.normalization_proposal_id);
    assert.equal(transform.task_id, 200);
    assert.equal(transform.execution_id, 'normalizer-exec');
  } finally {
    cleanup(temp);
  }
});
