// tests/process-modules/protocol-run-persistence.test.mjs
//
// W4-A1 — ProtocolRun persistence (SQL OWNER for saga3_protocol_runs +
// saga3_protocol_step_runs this wave).
//
// Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md §2.
// Task: docs/refactor-management/05-subagent-tasks/W04-a1.md.
//
// Coverage (per task "Verify" + §2 + §0.7.11):
//   - Schema: both tables + the partial UNIQUE active index + the step-ledger
//     UNIQUE(protocol_run_id, step_id, attempt) exist after the repo ctor.
//   - Schema: idempotent — constructing twice does not throw.
//   - startProtocol: writes a row with status 'active', currentStep = entryStep;
//     the partial UNIQUE index blocks a second active row for the same pair.
//   - advanceStep: moves currentStep, opens a step row (pending→in_progress),
//     resumes a paused protocol to active, and reuses an open step attempt.
//   - advanceStep: a completed step cannot be re-advanced at the same attempt
//     (re-opening requires a higher attempt — repeat/retry).
//   - completeStep: requires a non-empty evidenceJson (§8.4 / C026 — required
//     evidence cannot be skipped); flips pending/in_progress → completed and
//     stamps completed_at + evidence_json.
//   - completeStep: cannot complete a terminal/absent step row.
//   - readActiveProtocol: returns the active row, or null. Crash-resume entry.
//   - readByExactStep: returns the step row for an exact triple, or null.
//   - pauseProtocol / resumeProtocol: active↔paused round trip; pause of a
//     non-active row is a no-op (null).
//   - listSteps: chronological order (attempt, id).
//   - Crash-resume (§0.7.11): after reopen, readActiveProtocol().currentStep is
//     the exact last-advanced step.
//   - Persistence: tables survive DB reopen (dual-placement idempotency).
//
// ISOLATION NOTE: W4-A1 is the single SQL owner. This test constructs
// SqliteProtocolRunRepository directly, which runs ensureSaga3ProtocolRunSchema
// (fresh-DB path). The dual-placement in src/db.ts is exercised by the
// "persists across DB reopen" test via getDb()/closeDb(). FK enforcement is
// disabled for the temp DB (no saga3_process_runs parent row is created).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProtocolRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-protocol-run-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function freshDb(prefix = 'saga-w4a1-') {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DB_PATH = path.join(temp, 'protocol.db');
  const db = getDb();
  // saga3_protocol_runs REFERENCES saga3_process_runs; we test the protocol
  // layer in isolation (no parent row), so disable FK enforcement.
  db.pragma('foreign_keys = OFF');
  return { db, temp, previous };
}

function cleanup(temp, previous) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previous;
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function indexNames(db, table) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
    .all(table)
    .map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Schema tests.
// ---------------------------------------------------------------------------

test('schema: creates saga3_protocol_runs + saga3_protocol_step_runs after ctor', () => {
  const ctx = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteProtocolRunRepository(ctx.db);

    const runCols = new Set(tableColumns(ctx.db, 'saga3_protocol_runs'));
    assert.ok(runCols.has('id'));
    assert.ok(runCols.has('process_run_id'));
    assert.ok(runCols.has('node_run_id'));
    assert.ok(runCols.has('node_protocol_id'));
    assert.ok(runCols.has('node_protocol_version'));
    assert.ok(runCols.has('entry_step'));
    assert.ok(runCols.has('current_step'));
    assert.ok(runCols.has('status'));
    assert.ok(runCols.has('attempt'));
    assert.ok(runCols.has('created_at'));
    assert.ok(runCols.has('updated_at'));
    assert.ok(runCols.has('completed_at'));

    const stepCols = new Set(tableColumns(ctx.db, 'saga3_protocol_step_runs'));
    assert.ok(stepCols.has('id'));
    assert.ok(stepCols.has('protocol_run_id'));
    assert.ok(stepCols.has('step_id'));
    assert.ok(stepCols.has('attempt'));
    assert.ok(stepCols.has('status'));
    assert.ok(stepCols.has('evidence_json'));
    assert.ok(stepCols.has('completed_at'));
    assert.ok(stepCols.has('created_at'));

    const runIdx = indexNames(ctx.db, 'saga3_protocol_runs');
    assert.ok(
      runIdx.includes('idx_saga3_protocol_runs_active'),
      'partial UNIQUE active index must exist',
    );
    const stepIdx = indexNames(ctx.db, 'saga3_protocol_step_runs');
    assert.ok(
      stepIdx.includes('idx_saga3_protocol_step_runs_protocol'),
      'step protocol index must exist',
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('schema: ensureSaga3ProtocolRunSchema is idempotent (ctor twice does not throw)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    assert.doesNotThrow(() => {
      // Re-instantiate — runs ensureSaga3ProtocolRunSchema again.
      // eslint-disable-next-line no-new
      new SqliteProtocolRunRepository(ctx.db);
    });
    // Start works after double-init.
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.gather',
      nodeProtocolVersion: '1.0.0',
      entryStep: 'collect',
    });
    assert.equal(run.status, 'active');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// startProtocol + active uniqueness.
// ---------------------------------------------------------------------------

test('startProtocol: writes an active row with currentStep = entryStep', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 7,
      nodeRunId: 42,
      nodeProtocolId: 'proto.decide',
      nodeProtocolVersion: '2.1.0',
      entryStep: 'gather',
    });
    assert.equal(run.processRunId, 7);
    assert.equal(run.nodeRunId, 42);
    assert.equal(run.nodeProtocolId, 'proto.decide');
    assert.equal(run.nodeProtocolVersion, '2.1.0');
    assert.equal(run.entryStep, 'gather');
    assert.equal(run.currentStep, 'gather');
    assert.equal(run.status, 'active');
    assert.equal(run.attempt, 1);
    assert.equal(run.completedAt, null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('startProtocol: partial UNIQUE index blocks a second active row for the same pair', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    // A second ACTIVE row for the same (processRunId, nodeProtocolId) must be
    // rejected by the partial UNIQUE index.
    assert.throws(
      () => repo.startProtocol({
        processRunId: 1,
        nodeProtocolId: 'proto.x',
        nodeProtocolVersion: '1.0.0',
        entryStep: 's1',
      }),
      /UNIQUE/i,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('startProtocol: a different protocol id for the same run coexists (active)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    assert.doesNotThrow(() => repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.y',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    }));
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// advanceStep + step ledger.
// ---------------------------------------------------------------------------

test('advanceStep: moves currentStep and opens a step row (pending→in_progress)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    const advanced = repo.advanceStep({
      protocolRunId: run.id,
      stepId: 's2',
    });
    assert.equal(advanced.currentStep, 's2');
    assert.equal(advanced.status, 'active');

    const step = repo.readByExactStep(run.id, 's2', 1);
    assert.ok(step, 'step row must exist after advance');
    assert.equal(step.status, 'in_progress');
    assert.equal(step.attempt, 1);
    assert.equal(step.evidenceJson, null);
    assert.equal(step.completedAt, null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('advanceStep: reuses an open (pending/in_progress) step attempt at the same number', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    // Advancing the same still-open step should reuse attempt 1, not bump.
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    const steps = repo.listSteps(run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].attempt, 1);
    assert.equal(steps[0].status, 'in_progress');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('advanceStep: an EXPLICIT closed attempt cannot be re-advanced; omitted attempt opens a fresh one', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: '{"receipt":"r1"}',
    });
    // Re-advancing the EXPLICIT completed attempt must throw — the caller must
    // pass a higher attempt (or omit it) to re-open (repeat/retry).
    assert.throws(
      () => repo.advanceStep({ protocolRunId: run.id, stepId: 's1', attempt: 1 }),
      /PROTOCOL_STEP_ALREADY_CLOSED/,
    );
    // Omitting the attempt opens a FRESH attempt (the natural retry path).
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    const step2 = repo.readByExactStep(run.id, 's1', 2);
    assert.ok(step2);
    assert.equal(step2.status, 'in_progress');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('advanceStep: rejects an unknown protocol id', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    assert.throws(
      () => repo.advanceStep({ protocolRunId: 999, stepId: 's1' }),
      /PROTOCOL_RUN_MISSING/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('advanceStep: cannot advance a completed protocol', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    // Force the protocol terminal via raw SQL (the runtime owns terminal
    // transitions; the repository only needs to REFUSE to advance them).
    ctx.db.prepare(
      `UPDATE saga3_protocol_runs SET status='completed', completed_at=datetime('now') WHERE id=?`,
    ).run(run.id);
    assert.throws(
      () => repo.advanceStep({ protocolRunId: run.id, stepId: 's2' }),
      /PROTOCOL_RUN_NOT_ADVANCEABLE/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// completeStep + evidence enforcement.
// ---------------------------------------------------------------------------

test('completeStep: requires non-empty evidenceJson (§8.4 / C026)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    assert.throws(
      () => repo.completeStep({
        protocolRunId: run.id,
        stepId: 's1',
        evidenceJson: '',
      }),
      /PROTOCOL_EVIDENCE_REQUIRED/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('completeStep: flips pending/in_progress → completed and stamps evidence', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    const evidence = '{"category":"tool-receipt","hash":"abc"}';
    const step = repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: evidence,
    });
    assert.equal(step.status, 'completed');
    assert.equal(step.evidenceJson, evidence);
    assert.ok(step.completedAt, 'completed_at must be set');

    const reread = repo.readByExactStep(run.id, 's1', 1);
    assert.equal(reread.status, 'completed');
    assert.equal(reread.evidenceJson, evidence);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('completeStep: cannot complete a terminal/absent step row', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    // No step row created yet → completeStep must report the step is not open.
    assert.throws(
      () => repo.completeStep({
        protocolRunId: run.id,
        stepId: 's1',
        evidenceJson: '{"r":1}',
      }),
      /PROTOCOL_STEP_NOT_OPEN/,
    );
    // Now open + complete it, then try to complete the same attempt again.
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: '{"r":1}',
    });
    // Omitted attempt + no open attempt → NOT_OPEN (there is nothing to close).
    assert.throws(
      () => repo.completeStep({
        protocolRunId: run.id,
        stepId: 's1',
        evidenceJson: '{"r":2}',
      }),
      /PROTOCOL_STEP_NOT_OPEN/,
    );
    // EXPLICIT closed attempt → ALREADY_CLOSED.
    assert.throws(
      () => repo.completeStep({
        protocolRunId: run.id,
        stepId: 's1',
        attempt: 1,
        evidenceJson: '{"r":2}',
      }),
      /PROTOCOL_STEP_ALREADY_CLOSED/,
    );
    // An explicit unknown attempt must report missing.
    assert.throws(
      () => repo.completeStep({
        protocolRunId: run.id,
        stepId: 's1',
        attempt: 77,
        evidenceJson: '{"r":3}',
      }),
      /PROTOCOL_STEP_MISSING/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// readActiveProtocol + crash-resume.
// ---------------------------------------------------------------------------

test('readActiveProtocol: returns the active row or null', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    assert.equal(repo.readActiveProtocol(1, 'proto.x'), null);
    repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    const active = repo.readActiveProtocol(1, 'proto.x');
    assert.ok(active);
    assert.equal(active.status, 'active');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('crash-resume (§0.7.11): readActiveProtocol().currentStep is the exact last-advanced step', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: '{"r":1}',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's2' });
    // Simulate a crash: no further writes. On restart the runtime reads the
    // active protocol and resumes at currentStep.
    const resumed = repo.readActiveProtocol(1, 'proto.x');
    assert.ok(resumed);
    assert.equal(resumed.currentStep, 's2');
    // The exact last step row is recoverable by triple.
    const lastStep = repo.readByExactStep(resumed.id, 's2', 1);
    assert.ok(lastStep);
    assert.equal(lastStep.status, 'in_progress');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// pause / resume.
// ---------------------------------------------------------------------------

test('pauseProtocol / resumeProtocol: active↔paused round trip', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    const paused = repo.pauseProtocol(1, 'proto.x');
    assert.ok(paused);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.id, run.id);
    // Active read no longer sees it.
    assert.equal(repo.readActiveProtocol(1, 'proto.x'), null);

    const resumed = repo.resumeProtocol(1, 'proto.x');
    assert.ok(resumed);
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.id, run.id);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('pauseProtocol: returns null when there is no active protocol', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    assert.equal(repo.pauseProtocol(1, 'proto.x'), null);
    assert.equal(repo.resumeProtocol(1, 'proto.x'), null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('resumeProtocol: returns null when the protocol is not paused', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    // Active (not paused) → resume is a no-op null.
    assert.equal(repo.resumeProtocol(1, 'proto.x'), null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('advanceStep: a paused protocol resumes to active when advanced', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.pauseProtocol(1, 'proto.x');
    const advanced = repo.advanceStep({ protocolRunId: run.id, stepId: 's2' });
    assert.equal(advanced.status, 'active');
    assert.equal(advanced.currentStep, 's2');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// listSteps.
// ---------------------------------------------------------------------------

test('listSteps: returns rows in (attempt, id) order', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    const run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: '{"r":1}',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's2' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's2',
      evidenceJson: '{"r":2}',
    });
    // Retry step s1 at attempt 2.
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1', attempt: 2 });

    const steps = repo.listSteps(run.id);
    assert.equal(steps.length, 3);
    // attempt 1 rows first (by id), then attempt 2.
    assert.equal(steps[0].stepId, 's1');
    assert.equal(steps[0].attempt, 1);
    assert.equal(steps[1].stepId, 's2');
    assert.equal(steps[1].attempt, 1);
    assert.equal(steps[2].stepId, 's1');
    assert.equal(steps[2].attempt, 2);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// Persistence across DB reopen (dual-placement idempotency).
// ---------------------------------------------------------------------------

test('persistence: protocol + step rows survive DB reopen', () => {
  const ctx = freshDb();
  let run;
  try {
    const repo = new SqliteProtocolRunRepository(ctx.db);
    run = repo.startProtocol({
      processRunId: 1,
      nodeProtocolId: 'proto.x',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
    });
    repo.advanceStep({ protocolRunId: run.id, stepId: 's1' });
    repo.completeStep({
      protocolRunId: run.id,
      stepId: 's1',
      evidenceJson: '{"r":1}',
    });
    closeDb();
    // Reopen: getDb() runs the dual-placement in src/db.ts (guarded on
    // saga3_process_runs existing) — it must be a no-op for our tables.
    const db2 = getDb();
    db2.pragma('foreign_keys = OFF');
    const repo2 = new SqliteProtocolRunRepository(db2);
    const active = repo2.readActiveProtocol(1, 'proto.x');
    assert.ok(active);
    assert.equal(active.id, run.id);
    assert.equal(active.currentStep, 's1');
    const step = repo2.readByExactStep(run.id, 's1', 1);
    assert.ok(step);
    assert.equal(step.status, 'completed');
    assert.equal(step.evidenceJson, '{"r":1}');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});
