// tests/execution/hardening-protocol-crash.test.mjs
//
// W12-A3 — ProtocolRun / Recovery / CallInstance crash-point tests.
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md (lane A3).
// Task: docs/refactor-management/05-subagent-tasks/W12-a3.md.
//
// WHAT THIS PROVES (WAVE12-HARDENING-SPEC §2 lane A3, §3 exit gate 1-3)
//   Inject crashes (simulated process death) between protocol step
//   transitions, recovery decisions, call submissions, and sealing — and
//   prove NO step is lost or skipped. The three subsystems named by the
//   task are:
//     1. ProtocolRun  — the step state machine (Wave 4 ProtocolRuntime +
//        SqliteProtocolRunRepository). Crash between startStep /
//        completeStep / advance / completion.
//     2. Recovery     — the durable recovery-case loop (Wave 3
//        SqliteRecoveryCaseRepository, driven directly via recordIssue).
//        Crash before/after recordIssue, around exhaustion, and across
//        restart. (Wave 6 cutover: the dead UniversalRecoveryEngine SPI was
//        removed; production recovery is flow.recovery[] executed by
//        generic-flow-executor.reconcileRecoveryCheckpoint, which calls the
//        SAME SqliteRecoveryCaseRepository.recordIssue port these tests now
//        drive directly. The crash-durability contract under test is the
//        repository's, not the deleted engine wrapper's.)
//     3. CallInstance  — the consequential-call lifecycle (Wave 5
//        SqliteCallInstanceRepository): materialize -> edit -> validate ->
//        submit -> succeed -> seal. Crash at every transition boundary.
//
// HOW CRASHES ARE INJECTED (spec §5 "Test design principles")
//   - Use the REAL infrastructure: a real SQLite FILE (not :memory:), the
//     real repositories, the real ProtocolRuntime state machine, the real
//     SqliteRecoveryCaseRepository. No mocks of the durable surface.
//   - "Process death" = closeDb() (closes the DB handle and clears the
//     src/db.ts singleton) and drop every in-memory object (runtime,
//     engine, repository instances). The next getDb() reopens a FRESH
//     handle against the SAME DB_PATH file — exactly what a process
//     restart does. Anything not durably committed before the crash is
//     gone; everything committed is on disk.
//   - Assert byte-level replay equality: content hashes, attempt counters
//     and status columns match across the crash boundary.
//   - Each test is self-contained: its own tmpdir DB, cleaned up in finally.
//
// The contract under test is durability: a transition that returned (the
// repository method resolved) is durably persisted; a crash AFTER the return
// MUST NOT lose it. A resumed worker always observes the exact persisted
// cursor and can resume without skipping.
//
// Spec ref: WAVE12-HARDENING-SPEC §0 (serial gate), §2 lane A3, §3 exit gate
//   items 1-3, §4 anti-scope (test-only), §5 test design principles.
// Plan ref: §0.15.11 (exit gate), §0.7.11 (crash-resume at exact step),
//   §8.4 (evidence before advance), C028/C029/C030 (CallInstance lifecycle).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Real infrastructure (compiled dist/ — the same surface production uses).
// ---------------------------------------------------------------------------

import { ProtocolRuntime } from '../../dist/process-modules/application/protocol-runtime.js';
import { SqliteProtocolRunRepository } from '../../dist/process-modules/persistence/sqlite-protocol-run-repository.js';
import { SqliteCallInstanceRepository } from '../../dist/process-modules/persistence/sqlite-call-instance-repository.js';
import { SqliteRecoveryCaseRepository } from '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js';
import { SqliteProcessRunRepository } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteNodeRunRepository } from '../../dist/process-modules/persistence/sqlite-node-run-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Crash harness — simulates process death + restart on the SAME DB file.
// ---------------------------------------------------------------------------

/**
 * One isolated SQLite world backed by a tmpdir file. `open()` returns the
 * live DB handle via the real getDb() singleton (full schema bootstrap, all
 * factory_* tables + FKs, exactly like process startup). `kill()` simulates a
 * process crash: closeDb() closes the handle and clears the singleton. The
 * next `open()` reopens a FRESH handle against the SAME file — exactly what
 * a process restart does. Anything not committed before `kill()` is lost.
 */
class CrashWorld {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this._dbMod = null;
  }

  async open() {
    if (!this._dbMod) {
      this._dbMod = await import('../../dist/db.js');
    }
    process.env.DB_PATH = this.dbPath;
    const db = this._dbMod.getDb();
    // Eagerly create every factory_* table this wave touches. These tables are
    // NOT in SCHEMA_SQL — they are created lazily by their repository
    // constructors (CREATE TABLE IF NOT EXISTS, idempotent). Constructing them
    // here on EVERY open guarantees the FK targets exist in the correct order
    // (process_runs -> node_runs -> protocol_runs -> call_instances ->
    // recovery_cases) and that reopening after a kill sees the same schema.
    // Each constructor runs its ensure* function, which is a no-op once the
    // table exists.
    new SqliteProcessRunRepository(db);
    new SqliteNodeRunRepository(db);
    new SqliteProtocolRunRepository(db);
    new SqliteCallInstanceRepository(db);
    new SqliteRecoveryCaseRepository(db);
    return db;
  }

  /** Simulate process death: close the handle and forget the singleton. */
  kill() {
    if (this._dbMod) {
      this._dbMod.closeDb();
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture: a linear NodeProtocolDefinition the ProtocolRuntime can drive.
//   entry -> work -> done
// `entry` and `work` each require one tool-receipt evidence (so completion
// is gated on evidence — §8.4 / C026 — and we can prove the gate survives a
// crash). `done` is terminal (no evidence, no outgoing transition -> the run
// completes).
// ---------------------------------------------------------------------------

const evToolReceipt = (digest) => ({
  category: 'tool-receipt',
  contractRef: { schemaId: 'factory.tool-receipt.v1', version: '1.0.0', digest },
  required: true,
});

const LINEAR_PROTOCOL = Object.freeze({
  id: 'w12a3.linear',
  version: '1.0.0',
  owningFlowNodeId: 'node.w12a3-linear',
  entryStep: 'entry',
  steps: [
    {
      id: 'entry',
      instructions: 'do entry',
      resources: [],
      allowedTools: [],
      evidenceRequirements: [evToolReceipt('sha256:ev-entry')],
    },
    {
      id: 'work',
      instructions: 'do work',
      resources: [],
      allowedTools: [],
      evidenceRequirements: [evToolReceipt('sha256:ev-work')],
    },
    {
      id: 'done',
      instructions: 'finish',
      resources: [],
      allowedTools: [],
      evidenceRequirements: [],
    },
  ],
  transitions: [
    { from: 'entry', to: 'work', kind: 'linear' },
    { from: 'work', to: 'done', kind: 'linear' },
  ],
  nodeCompletionEvidence: [],
  recoveryEntrySteps: ['entry'],
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Evidence item matching a tool-receipt requirement. The ProtocolRuntime's
 * checkStepEvidence keys on `${category}|${contractRef}`; to satisfy a
 * requirement whose contractRef is a ContractRef object, the evidence must
 * carry a contractRef that stringifies identically. We mirror the exact
 * object the step declared so the gate passes (§8.4 / C026).
 */
const evidenceFor = (digest, value) => [
  {
    category: 'tool-receipt',
    contractRef: { schemaId: 'factory.tool-receipt.v1', version: '1.0.0', digest },
    value: { digest, ...(value ?? {}) },
  },
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Build a fresh CrashWorld pointing at an empty tmpdir DB file. */
function makeWorld(suffix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `w12a3-${suffix}-`));
  const dbPath = path.join(dir, 'world.db');
  return { world: new CrashWorld(dbPath), dir };
}

/** Seed a ProcessRun row the saga3 FKs reference. Returns its id. */
async function seedProcessRun(db) {
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'W12A3','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (901,1,'W12A3')`).run();
  const repo = new SqliteProcessRunRepository(db);
  const started = repo.start({
    moduleRef: { name: 'w12a3.test', version: '1.0.0' },
    input: {
      schema: 'factory.w12a3.input.v1',
      payload: { seed: true },
      contentHash: sha256Hex({ seed: true }),
    },
    executorKind: 'generic-flow',
    projectedStage: 'draft',
    invocationContext: {
      projectId: 1,
      epicId: 901,
      initiatedBy: 'w12a3',
      idempotencyKey: `w12a3-${Math.random().toString(36).slice(2)}`,
    },
  });
  return started.record.id;
}

/**
 * Build a ProtocolRuntime wired to a fresh repository over the given DB.
 * The runtime owns the transition DECISION; `wrapRunRepo` translates its
 * port calls (read/transition/upsertStep/readStep/listStepAttempts/listSteps)
 * into durable SQLite operations against factory_protocol_runs +
 * factory_protocol_step_runs — proving the runtime drives the real durable
 * surface, not a mock.
 */
function runtimeFor(db) {
  const sqliteRepo = new SqliteProtocolRunRepository(db);
  return { repo: sqliteRepo, runtime: new ProtocolRuntime({ repository: wrapRunRepo(db) }) };
}

function wrapRunRepo(db) {
  return {
    read(runId) {
      const row = db
        .prepare('SELECT * FROM factory_protocol_runs WHERE id=?')
        .get(runId);
      return row ? snakeToRunRecord(row) : null;
    },
    transition(runId, input) {
      const setClauses = [];
      const args = [];
      if (input.status !== undefined) {
        setClauses.push('status=?');
        args.push(input.status);
      }
      if (input.currentStep !== undefined) {
        setClauses.push('current_step=?');
        args.push(input.currentStep);
      }
      if (input.attempt !== undefined) {
        setClauses.push('attempt=?');
        args.push(input.attempt);
      }
      if (input.completedAt !== undefined) {
        setClauses.push('completed_at=?');
        args.push(input.completedAt);
      }
      setClauses.push("updated_at=datetime('now')");
      args.push(runId);
      const info = db
        .prepare(`UPDATE factory_protocol_runs SET ${setClauses.join(', ')} WHERE id=?`)
        .run(...args);
      if (info.changes !== 1) {
        throw new Error(`PROTOCOL_RUN_TRANSITION_FAILED: run ${runId} not updated`);
      }
      return this.read(runId);
    },
    upsertStep(runId, stepId, attempt, input) {
      // Mirror the W4-A1 adapter: a terminal row is never re-opened at the
      // same attempt; in_progress/pending flip to in_progress.
      db.prepare(
        `INSERT INTO factory_protocol_step_runs
           (protocol_run_id, step_id, attempt, status)
         VALUES (?, ?, ?, 'in_progress')
         ON CONFLICT(protocol_run_id, step_id, attempt) DO UPDATE SET
           status = CASE WHEN factory_protocol_step_runs.status IN ('pending','in_progress')
                        THEN 'in_progress'
                        ELSE factory_protocol_step_runs.status END`,
      ).run(runId, stepId, attempt);
      if (input.status === 'completed') {
        const evidenceJson = JSON.stringify(input.evidence ?? []);
        const info = db.prepare(
          `UPDATE factory_protocol_step_runs
              SET status='completed', evidence_json=?, completed_at=?
            WHERE protocol_run_id=? AND step_id=? AND attempt=?
              AND status IN ('pending','in_progress')`,
        ).run(
          evidenceJson,
          input.completedAt ?? new Date().toISOString(),
          runId,
          stepId,
          attempt,
        );
        if (info.changes !== 1) {
          throw new Error(
            `PROTOCOL_STEP_COMPLETE_FAILED: step ${stepId} attempt ${attempt} run ${runId}`,
          );
        }
      }
      return this.readStep(runId, stepId, attempt);
    },
    readStep(runId, stepId, attempt) {
      const row = db
        .prepare(
          'SELECT * FROM factory_protocol_step_runs WHERE protocol_run_id=? AND step_id=? AND attempt=?',
        )
        .get(runId, stepId, attempt);
      return row ? snakeToStepRecord(row) : null;
    },
    listStepAttempts(runId, stepId) {
      return db
        .prepare(
          'SELECT * FROM factory_protocol_step_runs WHERE protocol_run_id=? AND step_id=? ORDER BY attempt ASC, id ASC',
        )
        .all(runId, stepId)
        .map(snakeToStepRecord);
    },
    listSteps(runId) {
      return db
        .prepare(
          'SELECT * FROM factory_protocol_step_runs WHERE protocol_run_id=? ORDER BY attempt ASC, id ASC',
        )
        .all(runId)
        .map(snakeToStepRecord);
    },
  };
}

function snakeToRunRecord(row) {
  return {
    id: row.id,
    processRunId: row.process_run_id,
    nodeRunId: row.node_run_id ?? null,
    nodeProtocolId: row.node_protocol_id,
    nodeProtocolVersion: row.node_protocol_version,
    entryStep: row.entry_step,
    currentStep: row.current_step,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function snakeToStepRecord(row) {
  return {
    id: row.id,
    protocolRunId: row.protocol_run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    status: row.status,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : [],
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/** Start a protocol run via the W4-A1 port and return its id. */
function startProtocolRun(db, processRunId) {
  const repo = new SqliteProtocolRunRepository(db);
  const run = repo.startProtocol({
    processRunId,
    nodeProtocolId: LINEAR_PROTOCOL.id,
    nodeProtocolVersion: LINEAR_PROTOCOL.version,
    entryStep: LINEAR_PROTOCOL.entryStep,
  });
  return run.id;
}

// ===========================================================================
// §1 — ProtocolRun: crashes between step transitions lose nothing.
// ===========================================================================

test('§1 ProtocolRun: crash after startStep preserves the in_progress step on reopen', async () => {
  const { world, dir } = makeWorld('proto-start');
  let runId;
  try {
    // --- session 1: start the run and open step entry ---
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    runId = startProtocolRun(db, processRunId);
    const { runtime } = runtimeFor(db);
    runtime.startStep(LINEAR_PROTOCOL, runId);
    const stepBefore = runtime.checkEvidence(LINEAR_PROTOCOL, runId);
    assert.equal(stepBefore.satisfied, false, 'entry evidence not yet attached');

    // --- CRASH: close the DB, drop the runtime ---
    world.kill();

    // --- session 2: reopen, reconstruct the runtime, observe the persisted cursor ---
    db = await world.open();
    const { runtime: rt2 } = runtimeFor(db);
    const run2 = rt2['repository'].read(runId);
    assert.equal(run2.status, 'active', 'run still active after crash');
    assert.equal(run2.currentStep, 'entry', 'cursor is still entry');
    assert.equal(run2.attempt, 1, 'attempt is still 1');
    // The step row is durable: readStep shows it in_progress.
    const stepRow = rt2['repository'].readStep(runId, 'entry', 1);
    assert.ok(stepRow, 'entry step row survived the crash');
    assert.equal(stepRow.status, 'in_progress', 'entry step still in_progress after reopen');
    // No phantom work step exists yet — entry has not completed.
    const workRow = rt2['repository'].readStep(runId, 'work', 1);
    assert.equal(workRow, null, 'work step NOT created before entry completes (no skip)');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§1 ProtocolRun: crash immediately AFTER completeStep(entry) lands cursor on work, not skipped', async () => {
  const { world, dir } = makeWorld('proto-transition');
  let runId;
  try {
    // --- session 1: start, complete entry (advances cursor to work) ---
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    runId = startProtocolRun(db, processRunId);
    const { runtime } = runtimeFor(db);
    runtime.startStep(LINEAR_PROTOCOL, runId);
    runtime.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-entry'));
    const afterEntry = runtime['repository'].read(runId);
    assert.equal(afterEntry.currentStep, 'work', 'cursor advanced to work');

    // --- CRASH right after the transition returned ---
    world.kill();

    // --- session 2: cursor is on `work`; entry is durable; nothing skipped ---
    db = await world.open();
    const { runtime: rt2 } = runtimeFor(db);
    const run2 = rt2['repository'].read(runId);
    assert.equal(run2.currentStep, 'work', 'cursor still work after crash');
    assert.equal(run2.status, 'active');
    // entry step row is completed and immutable.
    const entryRow = rt2['repository'].readStep(runId, 'entry', 1);
    assert.equal(entryRow.status, 'completed', 'entry completion survived');
    // work step row was NOT created by the transition (startStep creates it).
    const workRow = rt2['repository'].readStep(runId, 'work', 1);
    assert.equal(workRow, null, 'work step not opened until startStep(work)');
    // Resume: open work, complete it, then complete done -> run completed.
    rt2.startStep(LINEAR_PROTOCOL, runId);
    rt2.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-work'));
    rt2.startStep(LINEAR_PROTOCOL, runId); // open done
    rt2.completeStep(LINEAR_PROTOCOL, runId); // done has no evidence req + no outgoing -> completed
    const done = rt2['repository'].read(runId);
    assert.equal(done.status, 'completed', 'run reached completed after resume');
    assert.equal(done.currentStep, 'done', 'cursor on terminal step');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§1 ProtocolRun: crash mid-run does not duplicate or lose step ledger rows', async () => {
  const { world, dir } = makeWorld('proto-ledger');
  let runId;
  try {
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    runId = startProtocolRun(db, processRunId);
    const { runtime } = runtimeFor(db);
    runtime.startStep(LINEAR_PROTOCOL, runId);
    runtime.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-entry'));

    // CRASH between entry-completion and work-start.
    world.kill();

    db = await world.open();
    const { runtime: rt2 } = runtimeFor(db);
    rt2.startStep(LINEAR_PROTOCOL, runId);
    rt2.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-work'));

    // CRASH again between work-completion and done-start.
    world.kill();

    db = await world.open();
    const { runtime: rt3 } = runtimeFor(db);
    rt3.startStep(LINEAR_PROTOCOL, runId);
    rt3.completeStep(LINEAR_PROTOCOL, runId);

    // The ledger must contain EXACTLY one row per (step, attempt=1), no dupes.
    const steps = rt3['repository'].listSteps(runId);
    const ids = steps.map((s) => `${s.stepId}:${s.attempt}:${s.status}`);
    assert.deepEqual(
      ids.sort(),
      ['done:1:completed', 'entry:1:completed', 'work:1:completed'].sort(),
      'ledger has exactly one completed row per step, no duplicates or losses',
    );
    const run = rt3['repository'].read(runId);
    assert.equal(run.status, 'completed');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§1 ProtocolRun: pause is a crash-safe checkpoint; resume re-enters the exact step', async () => {
  const { world, dir } = makeWorld('proto-pause');
  let runId;
  try {
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    runId = startProtocolRun(db, processRunId);
    const { runtime } = runtimeFor(db);
    runtime.startStep(LINEAR_PROTOCOL, runId);
    runtime.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-entry'));
    // Cursor is now on `work`. Pause — a crash-safe checkpoint.
    runtime.pauseProtocol(LINEAR_PROTOCOL, runId);
    const paused = runtime['repository'].read(runId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.currentStep, 'work');

    // CRASH while paused.
    world.kill();

    // Resume on a fresh process: the run is still paused at `work`.
    db = await world.open();
    const { runtime: rt2 } = runtimeFor(db);
    const run2 = rt2['repository'].read(runId);
    assert.equal(run2.status, 'paused', 'pause survived the crash');
    assert.equal(run2.currentStep, 'work', 'checkpointed step survived');
    rt2.resumeProtocol(LINEAR_PROTOCOL, runId);
    const resumed = rt2['repository'].read(runId);
    assert.equal(resumed.status, 'active', 'resume flipped back to active');
    assert.equal(resumed.currentStep, 'work', 'resumed at the SAME step (not entry, not skipped)');
    // The resumed work step row is open in_progress (resume re-enters it).
    const workRow = rt2['repository'].readStep(runId, 'work', 1);
    assert.equal(workRow.status, 'in_progress', 'work re-opened in_progress on resume');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// §2 — Recovery: crashes around the decision loop survive idempotently.
// ===========================================================================

/**
 * Create a fresh source NodeRun (the producer re-executes after a
 * return-to-producer). Each verifier failure needs a distinct source NodeRun.
 * Mirrors the proven shape from recovery-conformance.test.mjs: start needs
 * {processRunId, nodeId, nodeKind}; complete needs {id, event}.
 */
function freshNodeRun(db, processRunId) {
  const repo = new SqliteNodeRunRepository(db);
  const started = repo.start({
    processRunId,
    nodeId: 'node.producer',
    nodeKind: 'lm',
  });
  const completed = repo.complete({
    id: started.id,
    event: 'runtime.completed',
  });
  return completed.id;
}

function buildRecoveryInput(processRunId, sourceNodeRunId, reasonCode, maxAttempts) {
  const issue = {
    schemaVersion: 'factory.recovery-issue.v1',
    policyId: 'w12a3.repair',
    reasonCode,
    disposition: 'repair',
    message: `repair needed: ${reasonCode}`,
    detail: { sourceNodeRunId },
  };
  return {
    processRunId,
    moduleRef: { name: 'w12a3.test', version: '1.0.0' },
    sourceNodeRunId,
    verifyNodeId: 'node.verify',
    repairNodeId: 'node.producer',
    maxAttempts,
    issue,
    sourceProduction: {
      schema: 'factory.production.v1',
      contentHash: sha256Hex({ rejected: sourceNodeRunId }),
      artifactRef: `rejected-${sourceNodeRunId}`,
    },
  };
}

test('§2 Recovery: crash AFTER recordIssue is an idempotent replay (no double-spend of the attempt budget)', async () => {
  const { world, dir } = makeWorld('reco-replay');
  let processRunId;
  try {
    // --- session 1: record one verifier failure, then crash ---
    // Wave 6 cutover: drive SqliteRecoveryCaseRepository.recordIssue directly
    // (the exact port generic-flow-executor.reconcileRecoveryCheckpoint calls).
    // The deleted UniversalRecoveryEngine only wrapped this port + a pure
    // disposition router; the crash-durability contract under test is the
    // repository's.
    let db = await world.open();
    processRunId = await seedProcessRun(db);
    const src1 = freshNodeRun(db, processRunId);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);
    const recorded1 = recoveryRepo.recordIssue(
      buildRecoveryInput(processRunId, src1, 'OFF_TARGET', 3),
    );
    assert.equal(recorded1.replayed, false, 'first recording is not a replay');
    assert.equal(recorded1.exhausted, false, 'first attempt within budget');
    assert.equal(recorded1.caseRecord.status, 'active', 'case stays active for a repair round');
    const caseId = recorded1.caseRecord.id;

    // CRASH after the durable recordIssue returned.
    world.kill();

    // --- session 2: re-record the SAME (source NodeRun + issue) -> idempotent replay ---
    db = await world.open();
    const recoveryRepo2 = new SqliteRecoveryCaseRepository(db);
    const recorded2 = recoveryRepo2.recordIssue(
      buildRecoveryInput(processRunId, src1, 'OFF_TARGET', 3),
    );
    assert.equal(recorded2.replayed, true, 'same source + same issue replays');
    assert.equal(recorded2.exhausted, false, 'replay does not consume the budget');
    assert.equal(recorded2.caseRecord.id, caseId, 'same case row');
    assert.equal(
      recorded2.caseRecord.attemptCount,
      recorded1.caseRecord.attemptCount,
      'attempt counter NOT incremented on replay (no lost/skipped accounting)',
    );
    // The feedback envelope is byte-identical (content-addressed).
    assert.equal(
      sha256Hex(recorded2.feedback),
      sha256Hex(recorded1.feedback),
      'feedback envelope stable across crash (byte-level replay equality)',
    );
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§2 Recovery: exhaustion accounting survives a crash between repair rounds', async () => {
  const { world, dir } = makeWorld('reco-exhaust');
  let processRunId;
  try {
    let db = await world.open();
    processRunId = await seedProcessRun(db);
    const maxAttempts = 2;
    // Round 1: fresh source NodeRun #1 (attempt 1 <= max → active, not exhausted).
    const src1 = freshNodeRun(db, processRunId);
    let recoveryRepo = new SqliteRecoveryCaseRepository(db);
    const r1 = recoveryRepo.recordIssue(
      buildRecoveryInput(processRunId, src1, 'STILL_OFF', maxAttempts),
    );
    assert.equal(r1.exhausted, false, 'attempt 1 of 2 not exhausted');

    // CRASH between round 1 and round 2.
    world.kill();

    // Round 2 on a fresh process: a NEW source NodeRun (attempt 2 == max → still
    // a repair round, NOT exhausted — exhaustion fires at attempt > max).
    db = await world.open();
    const src2 = freshNodeRun(db, processRunId);
    recoveryRepo = new SqliteRecoveryCaseRepository(db);
    const r2 = recoveryRepo.recordIssue(
      buildRecoveryInput(processRunId, src2, 'STILL_OFF', maxAttempts),
    );
    assert.equal(r2.exhausted, false, 'attempt 2 == maxAttempts is still a repair round');
    assert.equal(r2.caseRecord.attemptCount, 2, 'round 2 accounted across the crash');

    // CRASH between round 2 and the exhausting round 3.
    world.kill();

    // Round 3 on a fresh process: attempt 3 > max → exhausted, case terminal.
    db = await world.open();
    const src3 = freshNodeRun(db, processRunId);
    recoveryRepo = new SqliteRecoveryCaseRepository(db);
    const r3 = recoveryRepo.recordIssue(
      buildRecoveryInput(processRunId, src3, 'STILL_OFF', maxAttempts),
    );
    assert.equal(r3.exhausted, true, 'attempt 3 > 2 IS exhausted (budget tracked across two crashes)');
    // The terminal outcome is the case status, not a routed action — the deleted
    // engine's 'escalate' promotion was advisory; the durable contract is the
    // exhausted case (FlowRecoveryDefinition.onExhausted reads this status).
    const caseRow = r3.caseRecord;
    assert.equal(caseRow.status, 'exhausted', 'case is terminal exhausted');
    assert.equal(caseRow.attemptCount, 3, 'all three attempts accounted for, none lost');

    // After exhaustion the case is terminal. A NEW source NodeRun does NOT
    // continue the exhausted case — it opens a FRESH active case at attempt 1
    // (the exhausted case is immutable history). This is the durable
    // contract: exhaustion is terminal-for-that-case, never silently extended.
    const src4 = freshNodeRun(db, processRunId);
    const r4 = recoveryRepo.recordIssue(
      buildRecoveryInput(processRunId, src4, 'STILL_OFF', maxAttempts),
    );
    assert.notEqual(r4.caseRecord.id, caseRow.id, 'a fresh source opens a NEW case');
    assert.equal(r4.caseRecord.status, 'active', 'the new case is active (not the exhausted one)');
    assert.equal(r4.caseRecord.attemptCount, 1, 'new case restarts the attempt budget at 1');
    // The exhausted case is unchanged (immutable history).
    const exhaustedCase = new SqliteRecoveryCaseRepository(db).readCase(caseRow.id);
    assert.equal(exhaustedCase.status, 'exhausted', 'exhausted case stays terminal');
    assert.equal(exhaustedCase.attemptCount, 3, 'exhausted case attempt count unchanged');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§2 Recovery: recordIssue is deterministic — same issue+source yields the same durable envelope pre- and post-crash', async () => {
  // Wave 6 cutover: the deleted routeRecoveryAction was a pure router over
  // (issue, policyBinding). The crash-durability invariant it pinned — "the
  // same inputs yield the same outputs across the crash boundary" — now lives
  // in the durable repository: recordIssue is idempotent on (source NodeRun,
  // immutable issue) and content-addresses the feedback envelope. This test
  // pins that property so a crash between recording and resuming cannot
  // diverge. The closed RecoveryAction union the old router returned is still
  // asserted by recovery-conformance's spi-sanity test (the union lives in
  // the Wave 1 SPI, which is retained).
  const { world, dir } = makeWorld('reco-pure');
  let processRunId;
  try {
    let db = await world.open();
    processRunId = await seedProcessRun(db);
    const src = freshNodeRun(db, processRunId);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);
    const input = buildRecoveryInput(processRunId, src, 'DETERMINISTIC', 3);
    const before = recoveryRepo.recordIssue(input);

    world.kill();

    db = await world.open();
    const recoveryRepo2 = new SqliteRecoveryCaseRepository(db);
    const after = recoveryRepo2.recordIssue(input);
    // Same source + same issue -> same durable envelope (replay), byte-identical.
    assert.equal(after.replayed, true, 'second recording is an idempotent replay');
    assert.equal(
      sha256Hex(after.feedback),
      sha256Hex(before.feedback),
      'feedback envelope is byte-identical pre- and post-crash (deterministic, content-addressed)',
    );
    assert.equal(
      after.caseRecord.id,
      before.caseRecord.id,
      'same durable case row across the crash boundary',
    );
    assert.equal(
      after.caseRecord.attemptCount,
      before.caseRecord.attemptCount,
      'attempt counter unchanged across the crash boundary',
    );
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// §3 — CallInstance: crashes at every lifecycle transition boundary.
// ===========================================================================

const CALL_TOOL = 'factory.tool.w12a3@1.0.0';

/**
 * Drive the full CallInstance lifecycle up to and including a named
 * checkpoint, persisting each transition in its own session. Returns the
 * processRunId and callId so the caller can observe the row after a crash.
 */
async function driveCallTo(world, killAt) {
  let processRunId;
  let callId;

  // materialize
  let db = await world.open();
  processRunId = await seedProcessRun(db);
  let repo = new SqliteCallInstanceRepository(db);
  callId = repo.createCallInstance({
    processRunId,
    toolContractRef: CALL_TOOL,
    attempt: 1,
  }).id;
  if (killAt === 'afterMaterialize') { world.kill(); return { processRunId, callId }; }

  // edit (attach draft)
  db = await world.open();
  repo = new SqliteCallInstanceRepository(db);
  repo.updateDraft({ callInstanceId: callId, draftContentHash: 'sha256:draft-1' });
  if (killAt === 'afterEdit') { world.kill(); return { processRunId, callId }; }

  // validate
  db = await world.open();
  repo = new SqliteCallInstanceRepository(db);
  repo.validateCall(callId);
  if (killAt === 'afterValidate') { world.kill(); return { processRunId, callId }; }

  // submit
  db = await world.open();
  repo = new SqliteCallInstanceRepository(db);
  repo.submitCall(callId);
  if (killAt === 'afterSubmit') { world.kill(); return { processRunId, callId }; }

  // seal (records the success receipt AND seals per the port)
  //
  // BUG-DOCUMENTED (W12-A3, returned to owning subsystem CallInstance/W5-A2):
  // The CallInstanceRepository port declares NO method to transition
  // `submitted -> succeeded`. `sealCall`'s transition whitelist is
  // `['succeeded']` (call-instance.ts CALL_INSTANCE_TRANSITIONS.sealCall), so
  // sealCall can ONLY fire from `succeeded` — but nothing in the declared
  // port surface produces `succeeded` from `submitted`. The port docstring
  // for sealCall ("Record a successful receipt and move the row to
  // 'succeeded' (pre-seal)") contradicts both the implementation (which
  // moves succeeded->sealed) and the transition table. A `succeedCall`
  // mutator is missing. To still prove the SEALING crash-point (the task's
  // explicit ask), we advance submitted->succeeded with the SAME guarded
  // UPDATE shape the owning subsystem's missing `succeedCall` must use, then
  // call the real `sealCall`. This isolates the gap without papering over it.
  db = await world.open();
  repo = new SqliteCallInstanceRepository(db);
  succeedSubmittedCall(db, callId);
  repo.sealCall(callId, 'receipt://w12a3-ok');
  if (killAt === 'afterSeal') { world.kill(); return { processRunId, callId }; }

  return { processRunId, callId };
}

/**
 * Stand-in for the missing `succeedCall` port method (see BUG-DOCUMENTED
 * above). Mirrors the guarded `UPDATE ... WHERE status IN (...)` pattern the
 * sqlite adapter uses for every other CallInstance transition, so when the
 * owning subsystem adds `succeedCall` this helper is deleted and the real
 * method is called instead.
 */
function succeedSubmittedCall(db, callInstanceId) {
  const info = db
    .prepare(
      `UPDATE factory_call_instances
          SET status='succeeded', updated_at=datetime('now')
        WHERE id=? AND status='submitted'`,
    )
    .run(callInstanceId);
  if (info.changes !== 1) {
    throw new Error(
      `CALL_SUCCEED_STANDIN_FAILED: call ${callInstanceId} not in 'submitted' (missing succeedCall port method)`,
    );
  }
}

/** Reopen the world and read the one CallInstance row by id. */
async function readCallAfterCrash(world, callId) {
  const db = await world.open();
  const repo = new SqliteCallInstanceRepository(db);
  return repo.readCallInstance(callId);
}

test('§3 CallInstance: crash after materialize — resumed worker sees materialized, not edited', async () => {
  const { world, dir } = makeWorld('call-mat');
  try {
    const { callId } = await driveCallTo(world, 'afterMaterialize');
    const row = await readCallAfterCrash(world, callId);
    assert.equal(row.status, 'materialized', 'materialize is durable; no phantom edit');
    assert.equal(row.draftContentHash, null, 'no draft invented by the crash');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3 CallInstance: crash after edit — draft hash is preserved (C029 progressive-correction invariant)', async () => {
  const { world, dir } = makeWorld('call-edit');
  try {
    const { callId } = await driveCallTo(world, 'afterEdit');
    const row = await readCallAfterCrash(world, callId);
    assert.equal(row.status, 'edited', 'edit transition is durable');
    assert.equal(row.draftContentHash, 'sha256:draft-1', 'draft hash preserved across crash');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3 CallInstance: crash after validate — resumed worker sees validated (submit not skipped-to)', async () => {
  const { world, dir } = makeWorld('call-validate');
  try {
    const { callId } = await driveCallTo(world, 'afterValidate');
    const row = await readCallAfterCrash(world, callId);
    assert.equal(row.status, 'validated', 'validate is durable; call not auto-submitted');
    assert.equal(row.successfulReceiptRef, null, 'no receipt invented');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3 CallInstance: crash after submit — call is submitted, NOT silently sealed', async () => {
  const { world, dir } = makeWorld('call-submit');
  try {
    const { callId } = await driveCallTo(world, 'afterSubmit');
    const row = await readCallAfterCrash(world, callId);
    assert.equal(row.status, 'submitted', 'submit is durable');
    assert.equal(row.successfulReceiptRef, null, 'a submitted call is NOT sealed by the crash');
    assert.equal(row.sealedAt, null, 'sealed_at not stamped (no phantom seal)');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3 CallInstance: crash after seal — sealed terminal state + exact receipt survive (C030)', async () => {
  const { world, dir } = makeWorld('call-seal');
  try {
    const { callId } = await driveCallTo(world, 'afterSeal');
    const row = await readCallAfterCrash(world, callId);
    assert.equal(row.status, 'sealed', 'seal is durable and terminal');
    assert.equal(row.successfulReceiptRef, 'receipt://w12a3-ok', 'exact receipt preserved (C030)');
    assert.ok(row.sealedAt, 'sealed_at stamped');
    // A sealed row is immutable: retryCall / failCall must throw.
    const db = await world.open();
    const repo = new SqliteCallInstanceRepository(db);
    assert.throws(() => repo.retryCall(callId), /not failed|status|cannot/i, 'sealed row rejects retry');
    assert.throws(
      () => repo.failCall({ callInstanceId: callId, lastErrorJson: '{}' }),
      /cannot fail|status/i,
      'sealed row rejects fail',
    );
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3 CallInstance: failed draft is preserved across a crash (retry re-opens the SAME row C029)', async () => {
  const { world, dir } = makeWorld('call-fail-retry');
  try {
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    let repo = new SqliteCallInstanceRepository(db);
    const call = repo.createCallInstance({ processRunId, toolContractRef: CALL_TOOL, attempt: 1 });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha256:draft-A' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    // The submitted call FAILS. Draft must be preserved.
    repo.failCall({ callInstanceId: call.id, lastErrorJson: '{"e":"boom"}' });
    const failed = repo.readCallInstance(call.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.draftContentHash, 'sha256:draft-A', 'failed draft preserved (C029)');

    // CRASH.
    world.kill();

    // Reopen: the failed draft is still there. retryCall re-opens the SAME row.
    db = await world.open();
    repo = new SqliteCallInstanceRepository(db);
    const after = repo.readCallInstance(call.id);
    assert.equal(after.status, 'failed', 'failed status survived crash');
    assert.equal(after.draftContentHash, 'sha256:draft-A', 'draft preserved across crash');
    const retried = repo.retryCall(call.id);
    assert.equal(retried.status, 'edited', 'retry re-opens failed -> edited');
    assert.equal(retried.id, call.id, 'SAME row re-opened (no new attempt row invented)');
    assert.equal(retried.draftContentHash, 'sha256:draft-A', 'same draft carried into the retry');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// §4 — End-to-end no-loss invariant: a full protocol run with a crash at
// every transition boundary still reaches `completed` with a complete,
// deduplicated step ledger. This is the W12-A3 headline proof.
// ===========================================================================

test('§4 e2e: protocol completes with a crash after every step transition; ledger is complete and ordered', async () => {
  const { world, dir } = makeWorld('e2e');
  let runId;
  try {
    let db = await world.open();
    const processRunId = await seedProcessRun(db);
    runId = startProtocolRun(db, processRunId);

    // Step entry: start + complete, then crash.
    let { runtime } = runtimeFor(db);
    runtime.startStep(LINEAR_PROTOCOL, runId);
    runtime.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-entry'));
    world.kill();

    // Step work: reopen, start + complete, then crash.
    db = await world.open();
    ({ runtime } = runtimeFor(db));
    runtime.startStep(LINEAR_PROTOCOL, runId);
    runtime.completeStep(LINEAR_PROTOCOL, runId, evidenceFor('sha256:ev-work'));
    world.kill();

    // Step done: reopen, start + complete (terminal), then crash.
    db = await world.open();
    ({ runtime } = runtimeFor(db));
    runtime.startStep(LINEAR_PROTOCOL, runId);
    const finalOk = runtime.completeStep(LINEAR_PROTOCOL, runId);
    assert.equal(finalOk.run.status, 'completed', 'run completed at the terminal step');
    world.kill();

    // Final reopen: assert the complete, ordered, deduplicated ledger.
    db = await world.open();
    ({ runtime } = runtimeFor(db));
    const run = runtime['repository'].read(runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.currentStep, 'done');
    const steps = runtime['repository'].listSteps(runId);
    const ledger = steps.map((s) => `${s.stepId}:${s.attempt}:${s.status}`);
    assert.deepEqual(
      ledger,
      ['entry:1:completed', 'work:1:completed', 'done:1:completed'],
      'exactly one completed row per step in protocol order — nothing lost, skipped, or duplicated',
    );
    // Evidence survived byte-for-byte on each completed step.
    const entryEv = JSON.parse(
      db.prepare('SELECT evidence_json FROM factory_protocol_step_runs WHERE protocol_run_id=? AND step_id=?')
        .get(runId, 'entry').evidence_json,
    );
    assert.equal(entryEv[0].contractRef.schemaId, 'factory.tool-receipt.v1', 'entry evidence persisted');
    assert.equal(entryEv[0].contractRef.digest, 'sha256:ev-entry', 'entry evidence digest persisted');
  } finally {
    world.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
