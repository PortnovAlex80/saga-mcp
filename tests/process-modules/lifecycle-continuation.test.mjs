import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { canonicalJson, sha256Hex } = await import('../../dist/shared/canonical-json.js');
const { sliceLifecycleForContinuation } = await import(
  '../../dist/process-modules/domain/lifecycle-continuation.js'
);
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteLifecycleContinuationRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-continuation-repository.js'
);

function definition() {
  const moduleRef = { name: 'test-module', version: '1.0.0' };
  const stage = (id, outcomeRoutes) => ({
    id,
    displayName: id,
    moduleRef,
    inputMapping: { inherited: '$.stages.stage-one.value' },
    outputMapping: { value: '$.processOutcome.value' },
    outcomeRoutes,
    entryConditions: [],
    exitConditions: [],
  });
  return {
    identity: {
      name: 'three-stage',
      version: '1.0.0',
      displayName: 'Three Stage',
      description: 'Continuation fixture.',
    },
    entryStageId: 'stage-one',
    stages: [
      stage('stage-one', { done: { type: 'stage', stageId: 'stage-two' } }),
      stage('stage-two', { done: { type: 'stage', stageId: 'stage-three' } }),
      stage('stage-three', { done: { type: 'terminal', status: 'done' } }),
    ],
  };
}

test('continuation identity remains stable across continuation chains', () => {
  const first = sliceLifecycleForContinuation(definition(), 'stage-two');
  const second = sliceLifecycleForContinuation(first, 'stage-two');
  assert.equal(first.identity.name, 'three-stage-continuation');
  assert.equal(second.identity.name, 'three-stage-continuation');
  assert.equal(first.identity.displayName, 'Three Stage Continuation');
  assert.equal(second.identity.displayName, 'Three Stage Continuation');
});

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'p','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'e','planned')").run();
  const lifecycleRuns = new SqliteLifecycleRunRepository(db);
  const value = definition();
  const input = { source: 'exact' };
  const parent = lifecycleRuns.start({
    lifecycle: value.identity,
    definitionSnapshot: canonicalJson(value),
    definitionHash: sha256Hex(value),
    entryStageId: value.entryStageId,
    input: {
      schema: 'test.input.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    invocationContext: {
      projectId: 1,
      epicId: 1,
      initiatedBy: 'operator',
      idempotencyKey: 'parent',
    },
  }).record;
  const processInsert = db.prepare(
    `INSERT INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,
       idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,
       status,local_outcome,authority,completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
  );
  processInsert.run(
    1, 1, 1, 'test-module', '1.0.0', 'test-module@1.0.0',
    'stage-one', 'generic-flow', 'test.stage.v1', '{}', sha256Hex({}),
    'completed', 'done', 'test',
  );
  processInsert.run(
    2, 1, 1, 'test-module', '1.0.0', 'test-module@1.0.0',
    'stage-two', 'generic-flow', 'test.stage.v1', '{}', sha256Hex({}),
    'failed', null, null,
  );
  const frame = { value: 'certified-prefix' };
  const result = { code: 'done', value: 'certified-prefix' };
  const stageInsert = db.prepare(
    `INSERT INTO factory_stage_runs
      (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
       module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
       input_hash,status,process_run_id,local_outcome,authority,
       mapped_output_snapshot,result_snapshot,error,completed_at)
     VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  stageInsert.run(
    1, parent.id, 0, 'stage-one', 'test-module', '1.0.0',
    'test-module@1.0.0', '{}', sha256Hex({ binding: 1 }),
    'test.stage.v1', '{}', sha256Hex({}), 'completed', 1, 'done', 'test',
    canonicalJson(frame), canonicalJson(result), null, '2026-01-01T00:00:00Z',
  );
  stageInsert.run(
    2, parent.id, 1, 'stage-two', 'test-module', '1.0.0',
    'test-module@1.0.0', '{}', sha256Hex({ binding: 2 }),
    'test.stage.v1', '{}', sha256Hex({}), 'failed', 2, null, null,
    null, null, 'boom', '2026-01-01T00:00:01Z',
  );
  db.prepare(
    `INSERT INTO factory_process_transitions
      (lifecycle_run_id,from_stage_run_id,transition_key,outcome,target_type,
       target_stage_id,to_stage_run_id,handoff_snapshot,handoff_hash,decision_hash)
     VALUES (?,1,'one-to-two','done','stage','stage-two',2,?,?,?)`,
  ).run(parent.id, canonicalJson({}), sha256Hex({ handoff: 1 }), sha256Hex({ decision: 1 }));
  db.prepare(
    `UPDATE factory_lifecycle_runs
        SET status='failed',current_stage_id='stage-two',current_stage_run_id=2,
            terminal_status='failed',version=7,error='boom',completed_at=datetime('now')
      WHERE id=?`,
  ).run(parent.id);
  db.prepare(
    `INSERT INTO factory_orders
      (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
     VALUES ('order:1',1,1,?,'existing_project','start_failed')`,
  ).run(parent.id);
  return {
    db,
    parentId: parent.id,
    continuation: new SqliteLifecycleContinuationRepository(db, lifecycleRuns),
    lifecycleRuns,
  };
}

test('continuation creates one immutable child suffix and inherits prefix without child StageRuns', () => {
  const { db, parentId, continuation, lifecycleRuns } = setup();
  const parentBefore = lifecycleRuns.read(parentId);
  const authorized = continuation.authorize({
    orderRef: 'order:1',
    parentLifecycleRunId: parentId,
    resumeStageId: 'stage-two',
    expectedParentError: 'boom',
    actorId: 'operator',
    reason: 'typed recovery',
    externalBaselineSnapshot: { head: 'abc' },
  });
  assert.equal(authorized.state, 'authorized');
  assert.equal(authorized.childDefinition.entryStageId, 'stage-two');
  assert.deepEqual(
    authorized.childDefinition.stages.map(stage => stage.id),
    ['stage-two', 'stage-three'],
  );
  assert.deepEqual(
    authorized.childDefinition.inheritedStages.map(stage => stage.id),
    ['stage-one'],
  );

  const consumed = continuation.consume(authorized.authorizationRef);
  assert.equal(consumed.state, 'consumed');
  assert.equal(lifecycleRuns.listStageRuns(consumed.childLifecycleRunId).length, 0);
  const child = lifecycleRuns.read(consumed.childLifecycleRunId);
  assert.equal(child.currentStageId, 'stage-two');
  const childInput = JSON.parse(child.inputSnapshot);
  assert.equal(childInput.source, 'exact');
  assert.equal(childInput.continuation.authorizationRef, authorized.authorizationRef);
  assert.equal(childInput.continuation.externalBaseline.head, 'abc');
  assert.equal(
    continuation.readInheritedStageFrame(consumed.childLifecycleRunId)['stage-one'].value,
    'certified-prefix',
  );
  assert.deepEqual(lifecycleRuns.read(parentId), parentBefore);

  const replay = continuation.consume(authorized.authorizationRef);
  assert.equal(replay.childLifecycleRunId, consumed.childLifecycleRunId);
  assert.equal(replay.replayed, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_order_runs').get().n,
    2,
  );
  db.close();
});

test('continuation fails closed on parent drift and routes back into inherited prefix', () => {
  const { db, parentId, continuation } = setup();
  const authorized = continuation.authorize({
    orderRef: 'order:1',
    parentLifecycleRunId: parentId,
    resumeStageId: 'stage-two',
    expectedParentError: 'boom',
    actorId: 'operator',
    reason: 'typed recovery',
  });
  db.prepare('UPDATE factory_lifecycle_runs SET version=version+1 WHERE id=?').run(parentId);
  assert.throws(
    () => continuation.consume(authorized.authorizationRef),
    /CONTINUATION_PARENT_DRIFT/,
  );

  const invalid = definition();
  invalid.stages[1].outcomeRoutes.done = { type: 'stage', stageId: 'stage-one' };
  assert.throws(
    () => sliceLifecycleForContinuation(invalid, 'stage-two'),
    /CONTINUATION_ROUTE_REENTERS_PREFIX/,
  );
  db.close();
});

test('continuation appends a corrected suffix after an exact terminal blocked stage', () => {
  const { db, parentId, continuation, lifecycleRuns } = setup();
  db.prepare(
    `UPDATE factory_process_runs
        SET status='completed',local_outcome='blocked',authority='test-policy',
            error='blocked-proof' WHERE id=2`,
  ).run();
  db.prepare(
    `UPDATE factory_stage_runs
        SET status='completed',local_outcome='blocked',authority='test-policy',
            error='blocked-proof' WHERE id=2`,
  ).run();
  db.prepare(
    `UPDATE factory_lifecycle_runs
        SET status='completed',current_stage_id=NULL,terminal_status='stage-blocked',
            version=8,error=NULL WHERE id=?`,
  ).run(parentId);

  const authorized = continuation.authorize({
    orderRef: 'order:1',
    parentLifecycleRunId: parentId,
    resumeStageId: 'stage-two',
    expectedParentError: 'TERMINAL_OUTCOME:stage-blocked',
    actorId: 'operator',
    reason: 'correct a proven settlement projection defect',
  });
  const child = continuation.consume(authorized.authorizationRef);
  assert.equal(lifecycleRuns.read(parentId).terminalStatus, 'stage-blocked');
  assert.equal(lifecycleRuns.read(child.childLifecycleRunId).currentStageId, 'stage-two');
  assert.deepEqual(
    authorized.childDefinition.inheritedStages.map(stage => stage.id),
    ['stage-one'],
  );
  db.close();
});

test('continuation chains from the failed active leaf and preserves the verified ancestor prefix', () => {
  const { db, parentId, continuation, lifecycleRuns } = setup();
  const first = continuation.authorize({
    orderRef: 'order:1',
    parentLifecycleRunId: parentId,
    resumeStageId: 'stage-two',
    expectedParentError: 'boom',
    actorId: 'operator',
    reason: 'first typed recovery',
    externalBaselineSnapshot: { head: 'base-1' },
  });
  const child = continuation.consume(first.authorizationRef);
  db.prepare(
    `UPDATE factory_lifecycle_runs
        SET status='failed',current_stage_id='stage-two',terminal_status='failed',
            version=3,error='review-contract-mismatch',completed_at=datetime('now')
      WHERE id=?`,
  ).run(child.childLifecycleRunId);
  const childBefore = lifecycleRuns.read(child.childLifecycleRunId);

  assert.throws(
    () => continuation.authorize({
      orderRef: 'order:1',
      parentLifecycleRunId: parentId,
      resumeStageId: 'stage-two',
      expectedParentError: 'boom',
      actorId: 'operator',
      reason: 'must not fork from an ancestor',
    }),
    /CONTINUATION_PARENT_NOT_ACTIVE_LEAF/,
  );

  const second = continuation.authorize({
    orderRef: 'order:1',
    parentLifecycleRunId: child.childLifecycleRunId,
    resumeStageId: 'stage-two',
    expectedParentError: 'review-contract-mismatch',
    actorId: 'operator',
    reason: 'second typed recovery',
    externalBaselineSnapshot: { head: 'base-2' },
  });
  assert.deepEqual(
    second.childDefinition.inheritedStages.map(stage => stage.id),
    ['stage-one'],
  );
  assert.deepEqual(
    second.childDefinition.stages.map(stage => stage.id),
    ['stage-two', 'stage-three'],
  );
  const grandchild = continuation.consume(second.authorizationRef);
  const grandchildRun = lifecycleRuns.read(grandchild.childLifecycleRunId);
  const grandchildInput = JSON.parse(grandchildRun.inputSnapshot);
  assert.equal(grandchildInput.source, 'exact');
  assert.equal(grandchildInput.continuation.authorizationRef, second.authorizationRef);
  assert.equal(grandchildInput.continuation.parentLifecycleRunId, child.childLifecycleRunId);
  assert.equal(grandchildInput.continuation.externalBaseline.head, 'base-2');
  assert.equal(
    continuation.readInheritedStageFrame(grandchild.childLifecycleRunId)['stage-one'].value,
    'certified-prefix',
  );
  assert.deepEqual(lifecycleRuns.read(child.childLifecycleRunId), childBefore);
  assert.deepEqual(
    db.prepare(
      `SELECT lifecycle_run_id,ordinal,parent_lifecycle_run_id,kind
         FROM factory_order_runs WHERE order_ref='order:1' ORDER BY ordinal`,
    ).all(),
    [
      { lifecycle_run_id: parentId, ordinal: 0, parent_lifecycle_run_id: null, kind: 'root' },
      { lifecycle_run_id: child.childLifecycleRunId, ordinal: 1, parent_lifecycle_run_id: parentId, kind: 'continuation' },
      { lifecycle_run_id: grandchild.childLifecycleRunId, ordinal: 2, parent_lifecycle_run_id: child.childLifecycleRunId, kind: 'continuation' },
    ],
  );
  db.close();
});
