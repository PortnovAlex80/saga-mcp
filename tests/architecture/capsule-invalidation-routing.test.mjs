// tests/architecture/capsule-invalidation-routing.test.mjs
//
// BLINDSIGHT F4 (persistence layer, PREVENTIVE-HUNT «Слепота по слоям»):
// `factory_replay_capsule_invalidations` records SIX typed reasons
// (payload-conflict, package-changed, acceptance-superseded,
// restart-required, refused, stage-reset), but the only runtime consumer
// collapsed them into `hasInvalidation()` — a boolean EXISTS. A capsule
// killed by a payload CONFLICT (the replay pipeline produced divergent
// payloads for one semantic key — corruption evidence) took exactly the same
// silent-miss route as a capsule obsoleted by a routine package change
// (invalidate + rebuild). The typed reason was written durably and dropped
// at the decision boundary.
//
// This suite pins the honest repair: the claim-side binder READS the typed
// invalidation evidence (readInvalidationsForCapsule), CLASSIFIES it
// (integrity-suspect vs obsolete), and DELIVERS the typed classification
// into the bound execution context (context.replay.invalidation) so the
// spawn decision point sees WHY the capsule was refused. Integrity-suspect
// evidence is additionally journaled loudly (operator escalation), while
// obsolete-class evidence keeps the normal invalidate+rebuild route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';

const { ensureFactoryProcessRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const {
  ensureReplayCapsuleSchema,
  SqliteReplayCapsuleRepository,
} = await import('../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js');
const { computeReplayKey } = await import('../../dist/replay/replay-capsule.js');
const {
  bindReplayToClaim,
  classifyCapsuleInvalidations,
} = await import('../../dist/infrastructure/replay/replay-claim-binder.js');

/** The exact replay key the binder computes for the seeded task binding. */
function seededReplayKey() {
  return computeReplayKey({
    projectId: 1,
    moduleRef: 'm@1.0.0',
    nodeId: 'node-1',
    productionCellId: 'cell-1',
    workKey: 'work-1',
    role: 'author',
    packageDigest: 'pkg-digest-1',
    semanticInputDigest: 'sem-1',
    subjectProductionDigest: null,
  });
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureReplayCapsuleSchema(db);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status, package_digest)
     VALUES (1, 1, 'm', '1.0.0', 'm@1.0.0', 'k', 'generic-flow', 's', '{}',
        'h', 'running', 'pkg-digest-1')`,
  ).run();
  return db;
}

function seedTask(db, { id = 11, workplaceRef = null } = {}) {
  const metadata = {
    process_run_id: 1,
    process_node_id: 'node-1',
    process_module_ref: 'm@1.0.0',
    production_cell_id: 'cell-1',
    work_key: 'work-1',
    semantic_input_digest: 'sem-1',
  };
  db.prepare(
    `INSERT INTO tasks
       (id, epic_id, title, status, assigned_to, workplace_ref, metadata)
     VALUES (?, 1, 't', 'in_progress', 'w', ?, ?)`,
  ).run(id, workplaceRef, JSON.stringify(metadata));
  return { id, epic_id: 1, metadata: JSON.stringify(metadata), workplace_ref: workplaceRef };
}

function seedExecution(db, executionId) {
  const context = { spawn: { mode: 'test' } };
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, metadata)
     VALUES (?, 'run', 1, 1, 11, 'w', 'machine', 'test', 'running', 'executing', ?)`,
  ).run(executionId, JSON.stringify({ execution_context: context }));
}

test('F4 unit: classification splits integrity-suspect corruption from normal obsolescence', () => {
  const base = {
    capsuleRef: 'replay-capsule:k:h1',
    observedDigest: null,
    expectedDigest: null,
    lifecycleRunId: null,
    authorityRef: 'replay-claim:exec-1',
    successorCapsuleRef: null,
    recordedAt: '2026-08-18T00:00:00Z',
  };

  // payload-conflict alone -> integrity-suspect (divergent payloads for one
  // semantic key = the replay pipeline itself is inconsistent).
  const conflict = classifyCapsuleInvalidations([
    { ...base, reason: 'payload-conflict' },
  ]);
  assert.equal(conflict.classification, 'integrity-suspect');
  assert.equal(conflict.reason, 'payload-conflict');

  // 'refused' (an authority explicitly refused certification) is also
  // integrity-suspect — not routine obsolescence.
  const refused = classifyCapsuleInvalidations([
    { ...base, reason: 'refused' },
  ]);
  assert.equal(refused.classification, 'integrity-suspect');
  assert.equal(refused.reason, 'refused');

  // Routine obsolescence reasons -> the normal invalidate+rebuild class.
  for (const reason of ['package-changed', 'acceptance-superseded', 'restart-required', 'stage-reset']) {
    const obsolete = classifyCapsuleInvalidations([{ ...base, reason }]);
    assert.equal(obsolete.classification, 'obsolete', `${reason} is normal obsolescence`);
    assert.equal(obsolete.reason, reason);
  }

  // A conflict row DOMINATES obsolescence rows: even when a capsule carries
  // both classes of evidence, the escalation class wins (fail-closed).
  const mixed = classifyCapsuleInvalidations([
    { ...base, reason: 'stage-reset' },
    { ...base, reason: 'payload-conflict' },
  ]);
  assert.equal(mixed.classification, 'integrity-suspect');
  assert.equal(mixed.reason, 'payload-conflict');

  // No evidence -> null (the caller keeps the plain hit path).
  assert.equal(classifyCapsuleInvalidations([]), null);
});

test('F4 binder: the typed invalidation classification is DELIVERED into the bound execution context', () => {
  const db = fixture();
  const task = seedTask(db);
  seedExecution(db, 'exec-conflict');

  const capsuleRef = 'replay-capsule:key:hash-a';
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?, ?, 1, 'exec-source', 'candidate-set/A', ?, '{}')`,
  ).run(capsuleRef, seededReplayKey(), 'a'.repeat(64));

  const repo = new SqliteReplayCapsuleRepository(db);
  repo.recordInvalidation({
    capsuleRef,
    reason: 'payload-conflict',
    observedDigest: 'a'.repeat(64),
    expectedDigest: 'b'.repeat(64),
    authorityRef: 'replay-claim:earlier-exec',
  });

  const binding = bindReplayToClaim(db, {
    task,
    executionId: 'exec-conflict',
    role: 'author',
  });
  assert.ok(binding, 'binding resolves');
  assert.equal(binding.capsuleRef, null, 'the conflicted capsule stays ineligible (fail-closed miss)');

  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get('exec-conflict');
  const bound = JSON.parse(row.metadata);
  assert.ok(bound.execution_context.replay, 'replay context is bound');
  const invalidation = bound.execution_context.replay.invalidation;
  assert.ok(invalidation, 'the typed invalidation is DELIVERED to the decision point');
  assert.equal(invalidation.capsuleRef, capsuleRef);
  assert.equal(invalidation.reason, 'payload-conflict');
  assert.equal(invalidation.classification, 'integrity-suspect');
  assert.equal(invalidation.observedDigest, 'a'.repeat(64));
  assert.equal(invalidation.expectedDigest, 'b'.repeat(64));

  db.close();
});

test('F4 binder: an obsolete-class invalidation routes as a typed invalidate+rebuild miss', () => {
  const db = fixture();
  const task = seedTask(db);
  seedExecution(db, 'exec-obsolete');

  const capsuleRef = 'replay-capsule:key:hash-b';
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?, ?, 1, 'exec-source', 'candidate-set/A', ?, '{}')`,
  ).run(capsuleRef, seededReplayKey(), 'c'.repeat(64));

  const repo = new SqliteReplayCapsuleRepository(db);
  repo.recordInvalidation({
    capsuleRef,
    reason: 'package-changed',
    observedDigest: 'new-pkg',
    expectedDigest: 'old-pkg',
    authorityRef: 'module-installation:m@1.0.0:new-pkg',
  });

  const binding = bindReplayToClaim(db, {
    task,
    executionId: 'exec-obsolete',
    role: 'author',
  });
  assert.equal(binding.capsuleRef, null, 'obsolete capsule is a miss — regeneration follows');

  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get('exec-obsolete');
  const bound = JSON.parse(row.metadata);
  const invalidation = bound.execution_context.replay.invalidation;
  assert.ok(invalidation, 'the reason is delivered here too — the miss is TYPED, not silent');
  assert.equal(invalidation.reason, 'package-changed');
  assert.equal(invalidation.classification, 'obsolete');

  db.close();
});

test('F4 binder: a clean capsule hit carries NO invalidation field (unchanged happy path)', () => {
  const db = fixture();
  const task = seedTask(db);
  seedExecution(db, 'exec-clean');

  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?, ?, 1, 'exec-source', 'candidate-set/A', ?, '{}')`,
  ).run('replay-capsule:key:hash-clean', seededReplayKey(), 'd'.repeat(64));

  const binding = bindReplayToClaim(db, {
    task,
    executionId: 'exec-clean',
    role: 'author',
  });
  assert.equal(binding.capsuleRef, 'replay-capsule:key:hash-clean', 'clean capsule still hits');

  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get('exec-clean');
  const bound = JSON.parse(row.metadata);
  assert.equal(
    bound.execution_context.replay.invalidation,
    undefined,
    'no invalidation evidence -> no invalidation field (no fabricated reasons)',
  );

  db.close();
});
