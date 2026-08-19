import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryLifecycleRunSchema } from
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { ensureFactoryProcessRunSchema } from
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { buryDeadLifecycleObligations } from
  '../../dist/app/engine-start-lifecycle-burial.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Lifecycle/stage-run and process-run tables are created lazily by their
  // repositories (foreign_keys=ON makes their cross-FKs enforced).
  ensureFactoryLifecycleRunSchema(db);
  ensureFactoryProcessRunSchema(db);
  return db;
}

function seedProject(db, id) {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, `project-${id}`);
}

function seedProcessRun(db, { id, projectId = 1 }) {
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?, ?, 'module', '1.0.0', 'module@1.0.0', ?, 'generic-flow', '{}', '{}', 'h')`,
  ).run(id, projectId, `idem-run-${id}`);
}

function seedLifecycleRun(db, { id, projectId = 1, terminalStatus = null }) {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        entry_stage_id, terminal_status)
     VALUES (?, ?, '1.0.0', 'lifecycle', ?, '{}', '{}', 'h',
             ?, 'test', ?, '{}', '{}', 'h', 'stage-1', ?)`,
  ).run(id, `lifecycle-${id}`, `lifecycle-${id}`, projectId, `idem-${id}`, terminalStatus);
}

function seedStageRun(db, { id, lifecycleRunId, processRunId }) {
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id, lifecycle_run_id, ordinal, stage_id, attempt, module_name,
        module_version, module_ref_key, binding_snapshot, binding_hash,
        input_schema, input_snapshot, input_hash, process_run_id)
     VALUES (?, ?, ?, 'stage-1', 1, 'module', '1.0.0', 'module', '{}', 'h',
             '{}', '{}', 'h', ?)`,
  ).run(id, lifecycleRunId, id, processRunId);
}

function seedWorkplace(db, { ref, processRunId, loopState, reservation = null }) {
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, active_reservation_ref,
        created_at, updated_at)
     VALUES (?, ?, 'm@1', 'cell', 'singleton', 'in_progress', ?, 'reviewer', 6, ?,
             datetime('now'), datetime('now'))`,
  ).run(ref, processRunId, loopState, reservation);
}

function seedObligation(db, {
  key, subjectRef, sourceRef, state = 'pending', leaseOwner = null, leaseFence = null,
}) {
  db.prepare(
    `INSERT INTO factory_transition_obligations
       (obligation_key, source_kind, source_ref, source_digest, subject_ref,
        handoff_kind, owner_capability, fence, state, lease_owner, lease_fence)
     VALUES (?, 'gate-accepted', ?, 'd', ?, 'run-effects',
             'production-cell-node-executor', 0, ?, ?, ?)`,
  ).run(key, sourceRef, subjectRef, state, leaseOwner, leaseFence);
}

function obligation(db, key) {
  return db.prepare(
    'SELECT state, last_error, lease_owner, lease_fence FROM factory_transition_obligations WHERE obligation_key=?',
  ).get(key);
}

function workplace(db, ref) {
  return db.prepare(
    'SELECT kanban_phase, loop_state, terminal_reason, active_reservation_ref, active_recovery_case_ref FROM factory_workplaces WHERE workplace_ref=?',
  ).get(ref);
}

test('buried: dead lifecycle open obligations (workplace, candidate-set, process-run subjects) fail with LIFECYCLE_TERMINAL', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProcessRun(db, { id: 4 });
    seedLifecycleRun(db, { id: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedObligation(db, {
      key: 'obl:pending-workplace',
      subjectRef: 'workplace/4/solution-formalization@1.0.0/formalization-use-cases/singleton',
      sourceRef: 'decision:gate-run:abc',
    });
    seedObligation(db, {
      key: 'obl:in-progress',
      subjectRef: 'process-run:4',
      sourceRef: 'final-acceptance:workplace/4/m@1/cell/singleton:candidate-set/4/m@1/cell/singleton/hash/author',
      state: 'in_progress',
      leaseOwner: 'reconciler:stale',
      leaseFence: 5,
    });
    seedObligation(db, {
      key: 'obl:candidate-set-subject',
      subjectRef: 'candidate-set/4/m@1/cell/singleton/hash/author',
      sourceRef: 'candidate-set-sealed:candidate-set/4/m@1/cell/singleton/hash/author',
    });

    const result = buryDeadLifecycleObligations(db);
    assert.equal(result.buried, 3);
    assert.deepEqual(result.lifecycleRuns, [1]);

    for (const key of ['obl:pending-workplace', 'obl:in-progress', 'obl:candidate-set-subject']) {
      const row = obligation(db, key);
      assert.equal(row.state, 'failed', key);
      assert.equal(row.last_error, 'LIFECYCLE_TERMINAL: lifecycle-run:1', key);
      assert.equal(row.lease_owner, null, key);
    }
    // Monotonic fence: a stale in-flight lease holder is provably stale after burial.
    assert.equal(obligation(db, 'obl:in-progress').lease_fence, 6);
  } finally {
    db.close();
  }
});

test('released: ALL non-terminal workplaces of a dead lifecycle go terminal', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProcessRun(db, { id: 4 });
    seedLifecycleRun(db, { id: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedWorkplace(db, {
      ref: 'workplace/4/m@1/cell/effect',
      processRunId: 4,
      loopState: 'effect_pending',
      reservation: 'worker-execution:dead-1',
    });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/verify', processRunId: 4, loopState: 'verifying' });
    seedWorkplace(db, {
      ref: 'workplace/4/m@1/cell/repair',
      processRunId: 4,
      loopState: 'repair_wait',
      reservation: 'worker-execution:worker-owned',
    });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/paused', processRunId: 4, loopState: 'paused' });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/queued', processRunId: 4, loopState: 'queued' });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/idle', processRunId: 4, loopState: 'idle' });

    const result = buryDeadLifecycleObligations(db);
    // ALL non-terminal workplaces of a dead lifecycle are orphans: the lifecycle
    // will never produce another runEpisode, so nobody — not the reaper, not
    // the executor, not the repair path, not the human — will ever drive the
    // next transition. An orphaned repair_wait or queued also starves the
    // dispatcher's shouldYieldToKernel for the entire epic.
    assert.equal(result.workplacesReleased, 6);

    const effect = workplace(db, 'workplace/4/m@1/cell/effect');
    assert.equal(effect.kanban_phase, 'failed');
    assert.equal(effect.loop_state, 'terminal');
    assert.equal(effect.terminal_reason, 'failed');
    assert.equal(effect.active_reservation_ref, null);

    const verify = workplace(db, 'workplace/4/m@1/cell/verify');
    assert.equal(verify.kanban_phase, 'failed');
    assert.equal(verify.loop_state, 'terminal');

    const repair = workplace(db, 'workplace/4/m@1/cell/repair');
    assert.equal(repair.loop_state, 'terminal');
    assert.equal(repair.terminal_reason, 'failed');
    assert.equal(repair.active_reservation_ref, null);

    // paused of a DEAD lifecycle is terminal too — the human decision will
    // never be consumed by a lifecycle that is already terminally failed.
    const paused = workplace(db, 'workplace/4/m@1/cell/paused');
    assert.equal(paused.loop_state, 'terminal');
    assert.equal(paused.terminal_reason, 'failed');

    // queued and idle — nobody will ever hire or admit for a dead lifecycle
    const queued = workplace(db, 'workplace/4/m@1/cell/queued');
    assert.equal(queued.loop_state, 'terminal');
    assert.equal(queued.terminal_reason, 'failed');

    const idleWp = workplace(db, 'workplace/4/m@1/cell/idle');
    assert.equal(idleWp.loop_state, 'terminal');
    assert.equal(idleWp.terminal_reason, 'failed');
  } finally {
    db.close();
  }
});

test('untouched: live lifecycle (and prefix-adjacent process runs) stay open', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    for (const pid of [4, 9, 40]) seedProcessRun(db, { id: pid });
    seedLifecycleRun(db, { id: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedLifecycleRun(db, { id: 2, terminalStatus: null });
    seedStageRun(db, { id: 2, lifecycleRunId: 2, processRunId: 9 });
    seedLifecycleRun(db, { id: 3, terminalStatus: null });
    seedStageRun(db, { id: 3, lifecycleRunId: 3, processRunId: 40 });
    seedObligation(db, {
      key: 'obl:live',
      subjectRef: 'workplace/9/m@1/cell/singleton',
      sourceRef: 'decision:gate-run:live',
    });
    // Prefix boundary: pid 40 must not match dead pid 4.
    seedObligation(db, {
      key: 'obl:live-prefix-40',
      subjectRef: 'workplace/40/m@1/cell/singleton',
      sourceRef: 'decision:gate-run:40',
    });
    seedWorkplace(db, { ref: 'workplace/9/m@1/cell/singleton', processRunId: 9, loopState: 'effect_pending' });
    seedWorkplace(db, { ref: 'workplace/40/m@1/cell/singleton', processRunId: 40, loopState: 'verifying' });

    const result = buryDeadLifecycleObligations(db);
    assert.deepEqual(result.lifecycleRuns, [1]);
    assert.equal(result.buried, 0);
    assert.equal(result.workplacesReleased, 0);

    assert.equal(obligation(db, 'obl:live').state, 'pending');
    assert.equal(obligation(db, 'obl:live-prefix-40').state, 'pending');
    assert.equal(workplace(db, 'workplace/9/m@1/cell/singleton').loop_state, 'effect_pending');
    assert.equal(workplace(db, 'workplace/40/m@1/cell/singleton').loop_state, 'verifying');
  } finally {
    db.close();
  }
});

test('scoped: projectId filter buries only the scoped dead lifecycle', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProject(db, 2);
    seedProcessRun(db, { id: 4, projectId: 1 });
    seedProcessRun(db, { id: 7, projectId: 2 });
    seedLifecycleRun(db, { id: 1, projectId: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedLifecycleRun(db, { id: 2, projectId: 2, terminalStatus: 'failed' });
    seedStageRun(db, { id: 2, lifecycleRunId: 2, processRunId: 7 });
    seedObligation(db, { key: 'obl:p1', subjectRef: 'workplace/4/m@1/cell/a', sourceRef: 'decision:gate-run:p1' });
    seedObligation(db, { key: 'obl:p2', subjectRef: 'workplace/7/m@1/cell/b', sourceRef: 'decision:gate-run:p2' });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/a', processRunId: 4, loopState: 'effect_pending' });
    seedWorkplace(db, { ref: 'workplace/7/m@1/cell/b', processRunId: 7, loopState: 'effect_pending' });

    const result = buryDeadLifecycleObligations(db, { projectId: 1 });
    assert.deepEqual(result.lifecycleRuns, [1]);
    assert.equal(result.buried, 1);
    assert.equal(result.workplacesReleased, 1);
    assert.equal(obligation(db, 'obl:p2').state, 'pending');
    assert.equal(workplace(db, 'workplace/7/m@1/cell/b').loop_state, 'effect_pending');
  } finally {
    db.close();
  }
});

test('idempotent: repeated burial passes converge to no-ops', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProcessRun(db, { id: 4 });
    seedLifecycleRun(db, { id: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedObligation(db, { key: 'obl:pending-workplace', subjectRef: 'workplace/4/m@1/cell/singleton', sourceRef: 'decision:gate-run:abc' });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/singleton', processRunId: 4, loopState: 'effect_pending' });

    const first = buryDeadLifecycleObligations(db);
    assert.equal(first.buried, 1);
    assert.equal(first.workplacesReleased, 1);

    const second = buryDeadLifecycleObligations(db);
    assert.equal(second.buried, 0);
    assert.equal(second.workplacesReleased, 0);
    assert.equal(obligation(db, 'obl:pending-workplace').last_error, 'LIFECYCLE_TERMINAL: lifecycle-run:1');
    assert.equal(workplace(db, 'workplace/4/m@1/cell/singleton').loop_state, 'terminal');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// BLINDSIGHT Lifecycle F7 — "Burial abandon не несёт причину (LOW/MED)".
//
// The burial abandon reason named WHICH lifecycle died
// (LIFECYCLE_TERMINAL: lifecycle-run:<id>) but never WHY it failed: the
// durable lifecycle failure reason (factory_lifecycle_runs.error) is written
// by the terminal transition and then dropped at the burial boundary. The
// abandoned obligation, the released workplaces and the boot log all carry
// zero typed cause. The fix routes the typed failure code into the durable
// burial records and the log.
// ---------------------------------------------------------------------------
function seedLifecycleRunWithError(db, { id, projectId = 1, error }) {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        entry_stage_id, terminal_status, error)
     VALUES (?, ?, '1.0.0', 'lifecycle', ?, '{}', '{}', 'h',
             ?, 'test', ?, '{}', '{}', 'h', 'stage-1', 'failed', ?)`,
  ).run(id, `lifecycle-${id}`, `lifecycle-${id}`, projectId, `idem-${id}`, error);
}

test('F7: burial abandon and released workplaces carry the typed lifecycle failure reason', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProcessRun(db, { id: 4 });
    seedLifecycleRunWithError(db, {
      id: 1,
      error: 'LIFECYCLE_STAGE_FAILED: stage formalization exhausted recovery (case 12)',
    });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedObligation(db, {
      key: 'obl:typed',
      subjectRef: 'workplace/4/m@1/cell/singleton',
      sourceRef: 'decision:gate-run:abc',
    });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/singleton', processRunId: 4, loopState: 'effect_pending' });

    const result = buryDeadLifecycleObligations(db);
    assert.equal(result.buried, 1);

    // Durable obligation record: the abandon carries the typed WHY.
    const row = obligation(db, 'obl:typed');
    assert.equal(row.state, 'failed');
    assert.match(
      row.last_error,
      /^LIFECYCLE_TERMINAL: lifecycle-run:1 failure=LIFECYCLE_STAGE_FAILED/,
      'DEFECT F7: the abandon said which lifecycle died but not why it failed',
    );
    assert.match(row.last_error, /stage formalization exhausted recovery/);

    // Durable workplace burial record: an append-only park-reason row plus a
    // live pointer on the released workplace.
    const parkReason = db.prepare(
      'SELECT id, reason_code, message FROM factory_workplace_park_reasons WHERE workplace_ref=?',
    ).get('workplace/4/m@1/cell/singleton');
    assert.ok(parkReason, 'the buried workplace has an append-only reason row');
    assert.equal(parkReason.reason_code, 'LIFECYCLE_BURIED');
    assert.match(parkReason.message, /LIFECYCLE_STAGE_FAILED/,
      'the typed lifecycle failure rides along');
    assert.match(parkReason.message, /lifecycle-run:1/);
    const released = workplace(db, 'workplace/4/m@1/cell/singleton');
    assert.equal(released.loop_state, 'terminal');
    assert.equal(
      released.active_recovery_case_ref,
      `workplace-park-reason:${parkReason.id}`,
      'the buried workplace points at its durable burial reason',
    );

    // The result carries the typed failure for programmatic log consumers.
    assert.equal(result.details[0].lifecycleFailureCode, 'LIFECYCLE_STAGE_FAILED');
    assert.equal(result.details[0].lifecycleRunId, 1);
  } finally {
    db.close();
  }
});

test('F7b: an error-less dead lifecycle keeps the legacy provenance-only reason', () => {
  const db = fresh();
  try {
    seedProject(db, 1);
    seedProcessRun(db, { id: 4 });
    seedLifecycleRun(db, { id: 1, terminalStatus: 'failed' });
    seedStageRun(db, { id: 1, lifecycleRunId: 1, processRunId: 4 });
    seedObligation(db, {
      key: 'obl:no-error',
      subjectRef: 'workplace/4/m@1/cell/singleton',
      sourceRef: 'decision:gate-run:abc',
    });
    seedWorkplace(db, { ref: 'workplace/4/m@1/cell/singleton', processRunId: 4, loopState: 'verifying' });

    const result = buryDeadLifecycleObligations(db);
    assert.equal(result.buried, 1);
    assert.equal(
      obligation(db, 'obl:no-error').last_error,
      'LIFECYCLE_TERMINAL: lifecycle-run:1',
      'no persisted failure → the reason stays the legacy provenance shape',
    );
    assert.equal(result.details[0].lifecycleFailureCode, null);
  } finally {
    db.close();
  }
});
