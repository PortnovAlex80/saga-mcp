/**
 * CC-GAP-3 blocking regression — ADR-087 receipt-authoritative terminal drain.
 *
 * CONVEYOR-MENTAL-MODEL §23 synchronization edge:
 *
 *   | OS worker exits | terminalize the exact WorkerExecution; host status is
 *   |                 | observation only |
 *
 * The diagnosed gap: the engine loop can break on a TERMINAL lifecycle result
 * while a receipt-backed WorkerExecution is still durably `running` — in the
 * dead-PID form (lost close callback / Windows stdio teardown / wait-poll
 * deferral) AND in the alive-PID form (a live receipt-backed closer lawfully
 * kept by the stuck policy, after which a terminal epic has no future engine
 * to run another sweep). A terminal run then exits with a phantom `running`
 * execution nobody will ever observe.
 *
 * ADR-087 (Option B: receipt-authoritative settlement) closes the boundary:
 *   1. a short BOUNDED natural-drain courtesy — judged purely on durable
 *      active-row state; no executor registry, no runner stop, no kill;
 *   2. the ORDINARY supervision reconcile (dead-PID receipt rows converge on
 *      `exited`, never `lost`; the sweep emits their worker.exit);
 *   3. every remaining active execution WITH an accepted
 *      worker_done/presentation_close receipt is settled to SEMANTIC `exited`
 *      through the EXISTING fenced atomic release (which re-verifies the
 *      receipt at write time) EVEN IF THE PID IS STILL ALIVE — the process is
 *      never killed; exit_code stays null for the late-close backfill; only
 *      the durable terminal-write CAS winner emits worker.exit, stating
 *      whether the PID was alive (physical-tail truthfulness);
 *   4. a final active recount fails CLOSED: a non-receipt, unverifiable or
 *      failed residual raises a typed TerminalWorkerSettlementError so the
 *      launch/engine exit cannot be presented as clean operational success.
 *
 * Workplace authority is respected throughout (ADR-053/061): a receipt-backed
 * release converges on `exited`, preserves the task projection, and sends no
 * worker-lost to a Workplace already owned by its GateRun. `state='exited'`
 * is protocol completion; physical death requires exit_code or the explicit
 * pid_alive/physical_exit_observed observation fields.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';
import { SqliteExecutionRuntimeRepository } from '../../dist/infrastructure/persistence/sqlite-factory-runtime-repositories.js';
import {
  startWorkerSupervision,
  settleWorkerExecutionsAtTerminalRun,
  TerminalWorkerSettlementError,
} from '../../dist/infrastructure/work/worker-supervision-service.js';
import { markExecutionExited, closeRuntimeDbCache } from '../../dist/worker-executions.js';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..');

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-ccgap3-'));
process.env.DB_PATH = path.join(temp, 'ccgap3.db');
// Route the observation journal to a per-test file so the worker.exit
// emission can be asserted exactly (run-journal is write-only; tests read
// the file post-mortem, the sanctioned consumer pattern).
const journalPath = path.join(temp, 'factory-run-journal.jsonl');
const previousJournalEnv = process.env.SAGA_RUN_JOURNAL;
process.env.SAGA_RUN_JOURNAL = journalPath;
const previousDrainEnv = process.env.SAGA_TERMINAL_DRAIN_MS;

test.after(() => {
  if (previousJournalEnv === undefined) delete process.env.SAGA_RUN_JOURNAL;
  else process.env.SAGA_RUN_JOURNAL = previousJournalEnv;
  if (previousDrainEnv === undefined) delete process.env.SAGA_TERMINAL_DRAIN_MS;
  else process.env.SAGA_TERMINAL_DRAIN_MS = previousDrainEnv;
  closeRuntimeDbCache();
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

/** Parse the run journal (observation-only projection; post-mortem reader). */
function readJournalEvents() {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(event => event !== null);
}

function workerExitsFor(executionId) {
  return readJournalEvents().filter(
    event => event.kind === 'worker.exit' && event.execution_id === executionId,
  );
}

/** Stamp process_run_id onto a task — the saga4 authority gate. */
function stampProcessRun(taskId, processRunId = 1) {
  const db = getDb();
  const row = db.prepare(
    `SELECT t.metadata,t.epic_id,e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?`,
  ).get(taskId);
  db.prepare(
    `INSERT OR IGNORE INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
       executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'test-module','1.0.0','test-module@1.0.0',?,
             'generic-flow','test.input.v1','{}',?,'running')`,
  ).run(processRunId, row.project_id, row.epic_id, `test-process:${processRunId}`, 'a'.repeat(64));
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  meta.process_run_id = processRunId;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), taskId);
}

/**
 * Build the EXACT durable state of the diagnosed path: worker_done was
 * ACCEPTED (the receipt stands), the Workplace advanced to the kernel-owned
 * `verifying` state — but the close observation was lost, so the execution
 * row is still `running` in phase `finishing`.
 *
 * `pid` selects the physical tail: 999999 is a provably dead PID (the
 * reaper's probe returns false); `process.pid` is THIS test process — an
 * ALIVE PID the settlement must settle WITHOUT killing (if the factory
 * killed it, this test process would die and the run go red).
 */
function createReceiptBackedOrphan(projectId, epicId, { pid = 999999 } = {}) {
  const task = tasks.task_create({ epic_id: epicId, title: 'receipt-backed orphan' });
  stampProcessRun(task.id);
  const claimed = dispatcher.worker_next({
    worker_id: 'orphan-worker',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: `exec-ccgap3-${task.id}`,
    run_id: 'ccgap3-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task, 'worker_next must claim the card to fence the execution');

  const db = getDb();
  const workplace = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(task.id);
  assert.ok(workplace?.workplace_ref, 'claim materialized the Workplace binding');

  // Accepted worker_done receipt — the durable semantic-completion authority.
  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,actor_id,task_id,execution_id,
        payload_hash,accepted,result_json,reply_json)
     VALUES (?, 'worker_done', 'managed_execution', NULL, ?, ?,
             'ccgap3-done', 1, '{}', '{}')`,
  ).run(`cmd-ccgap3-done-${task.id}`, task.id, `exec-ccgap3-${task.id}`);

  // worker_done moved the Workplace to kernel-owned verifying (the gate owns
  // the next transition — the OS process is no longer needed).
  db.prepare(
    `UPDATE factory_workplaces SET loop_state='verifying',revision=revision+1
      WHERE workplace_ref=?`,
  ).run(workplace.workplace_ref);

  // The lost close observation: the row is still `running`/`finishing`.
  // Birth token stays NULL (a bare row the kill path can never verify-kill).
  db.prepare(
    `UPDATE worker_executions
        SET state='running', phase='finishing', pid=?,
            started_at=datetime('now'), phase_updated_at=datetime('now')
      WHERE execution_id=?`,
  ).run(pid, `exec-ccgap3-${task.id}`);

  return { taskId: task.id, executionId: `exec-ccgap3-${task.id}`, workplaceRef: workplace.workplace_ref };
}

/**
 * An active execution WITHOUT any receipt: the residual the fail-closed
 * branch exists for. Alive own PID + owned in-progress fence, so the ordinary
 * reconcile lawfully KEEPs it (no fabricated completion is allowed).
 */
function createNoReceiptActive(projectId, epicId) {
  const task = tasks.task_create({ epic_id: epicId, title: 'no-receipt residual' });
  stampProcessRun(task.id);
  const claimed = dispatcher.worker_next({
    worker_id: 'residual-worker',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: `exec-ccgap3-residual-${task.id}`,
    run_id: 'ccgap3-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task, 'worker_next must claim the card to fence the execution');
  dbMarkRunning(`exec-ccgap3-residual-${task.id}`, process.pid);
  return { taskId: task.id, executionId: `exec-ccgap3-residual-${task.id}` };
}

function dbMarkRunning(executionId, pid) {
  getDb().prepare(
    `UPDATE worker_executions
        SET state='running', phase='executing', pid=?,
            started_at=datetime('now'), phase_updated_at=datetime('now')
      WHERE execution_id=?`,
  ).run(pid, executionId);
}

function activeCount(projectId, epicId) {
  return getDb().prepare(
    `SELECT COUNT(*) AS n FROM worker_executions
      WHERE project_id=? AND epic_id=?
        AND state IN ('reserved','running','cancel_requested')`,
  ).get(projectId, epicId).n;
}

function makeScope() {
  const p = projects.project_create({ name: `ccgap3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  const e = epics.epic_create({ project_id: p.id, name: 'CC-GAP-3 epic' });
  return { projectId: p.id, epicId: e.id };
}

test('dead-PID form: ordinary reconcile converges a receipt row to exited with exactly one truthful worker.exit', () => {
  const { projectId, epicId } = makeScope();
  const orphan = createReceiptBackedOrphan(projectId, epicId, { pid: 999999 });
  const db = getDb();

  // Precondition — the durable gap state this regression exists for.
  const before = db.prepare(
    'SELECT state, phase FROM worker_executions WHERE execution_id=?',
  ).get(orphan.executionId);
  assert.equal(before.state, 'running');
  assert.equal(before.phase, 'finishing');

  // The ordinary supervision reconcile chain the ADR-087 terminal boundary
  // runs as its phase 2 (the handle's startup sweep drives it here).
  const handle = startWorkerSupervision({
    executionRuntime: new SqliteExecutionRuntimeRepository(),
    projectId,
    epicId,
    intervalMs: 60_000,
    log: () => {},
  });

  try {
    // THE INVARIANT, durable half: after the terminal boundary the exact
    // execution converged to the receipt-backed terminal `exited` — never
    // `lost` — leaving no active execution for this diagnosed row.
    const settled = db.prepare(
      'SELECT state, exit_code, last_error FROM worker_executions WHERE execution_id=?',
    ).get(orphan.executionId);
    assert.equal(settled.state, 'exited',
      'receipt-backed dead-pid execution converged on the close-callback terminal');
    assert.equal(settled.last_error, null,
      'a receipt-backed exit is not an error');

    // Workplace authority respected: the kernel-owned verifying state and the
    // accepted receipt are untouched; only the physical fence was cleared.
    assert.equal(
      db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?')
        .get(orphan.workplaceRef).loop_state,
      'verifying',
      'no worker-lost was sent to a Workplace owned by its GateRun',
    );
    assert.equal(
      db.prepare('SELECT current_execution_id FROM tasks WHERE id=?')
        .get(orphan.taskId).current_execution_id,
      null,
      'the stale task fence was cleared by the atomic release',
    );
    assert.equal(
      db.prepare(
        `SELECT accepted FROM command_receipts
          WHERE execution_id=? AND command_kind='worker_done'`,
      ).get(orphan.executionId).accepted,
      1,
      'the accepted worker_done receipt remains the authority',
    );

    // THE INVARIANT, observation half: worker.exit was emitted EXACTLY ONCE
    // for the exact execution, with the ADR-087 physical-tail fields —
    // `exited` is semantic completion, the dead PID is stated explicitly and
    // exit_code stays null (no OS close event was ever observed).
    const forThisExecution = workerExitsFor(orphan.executionId);
    assert.equal(forThisExecution.length, 1,
      `exactly one worker.exit for ${orphan.executionId} (got ${forThisExecution.length})`);
    assert.ok(forThisExecution[0].data.worker_done_received === true,
      'the sweep-side worker.exit records the durable receipt authority');
    assert.equal(forThisExecution[0].data.pid_alive, false,
      'the dead-PID observation states the PID was not alive');
    assert.equal(forThisExecution[0].data.exit_code, null,
      'no exit code was fabricated');
    assert.equal(forThisExecution[0].data.physical_exit_observed, false,
      'no physical OS close was observed');

    // Idempotency: a repeated sweep converges nothing new and does NOT
    // double-emit the observation.
    handle.reconcileOnce();
    assert.equal(
      db.prepare('SELECT state FROM worker_executions WHERE execution_id=?')
        .get(orphan.executionId).state,
      'exited',
    );
    assert.equal(workerExitsFor(orphan.executionId).length, 1,
      'the second settlement did not emit a second worker.exit (exactly-once)');
  } finally {
    handle.stop();
  }
});

test('ADR-087 alive-PID form: receipt settlement converges to semantic exited with NO kill, exactly-once worker.exit, late backfill, idempotency', async () => {
  const { projectId, epicId } = makeScope();
  // The Elite-6 shape: an ALIVE PID (this very test process — if the
  // settlement killed it, this test would die) holding an accepted receipt.
  const orphan = createReceiptBackedOrphan(projectId, epicId, { pid: process.pid });
  const db = getDb();

  const handle = startWorkerSupervision({
    executionRuntime: new SqliteExecutionRuntimeRepository(),
    projectId,
    epicId,
    intervalMs: 60_000,
    log: () => {},
  });

  try {
    // Precondition: the alive receipt-backed closer is durably running and
    // the ordinary reconcile lawfully KEEPs it (receipt-close grace).
    assert.equal(db.prepare('SELECT state FROM worker_executions WHERE execution_id=?')
      .get(orphan.executionId).state, 'running');
    assert.equal(process.kill(process.pid, 0), true, 'the alive PID is this test process');

    const summary = await settleWorkerExecutionsAtTerminalRun(handle, {
      projectId,
      epicId,
      db,
      drainMs: 120,
      log: () => {},
    });

    // The drain is a COURTESY only: the alive closer never terminalized
    // naturally, so the settlement (phase 3) owns the convergence.
    assert.equal(summary.activeBeforeDrain, 1);
    assert.equal(summary.drainedToZero, false,
      'the alive-PID form does not converge during the natural drain');
    assert.equal(summary.settled.length, 1);
    assert.equal(summary.settled[0].executionId, orphan.executionId);
    assert.equal(summary.settled[0].pidAlive, true,
      'the settlement probed and recorded the alive PID');
    assert.equal(summary.settled[0].emittedWorkerExit, true,
      'the settlement won the durable CAS and owns the worker.exit emission');
    assert.equal(summary.activeRemaining, 0,
      'final active recount: zero active executions in the launch scope');

    // Semantic completion: `exited` WITHOUT physical death. The process was
    // NOT killed (this test process is the PID and is still running), the
    // exit code stays null until a real close is observed, and no error is
    // fabricated.
    const settled = db.prepare(
      'SELECT state, exit_code, last_error FROM worker_executions WHERE execution_id=?',
    ).get(orphan.executionId);
    assert.equal(settled.state, 'exited',
      'receipt-authoritative settlement converged the alive-PID row to semantic exited');
    assert.equal(settled.exit_code, null,
      'exit_code stays null — no OS close was observed');
    assert.equal(settled.last_error, null);
    assert.equal(process.kill(process.pid, 0), true,
      'NO KILL: the alive PID (this test process) survived the settlement');

    // Workplace authority respected; fence cleared with preserved projection.
    assert.equal(
      db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?')
        .get(orphan.workplaceRef).loop_state,
      'verifying',
    );
    assert.equal(
      db.prepare('SELECT current_execution_id FROM tasks WHERE id=?')
        .get(orphan.taskId).current_execution_id,
      null,
    );

    // Exactly-once worker.exit with explicit alive/physical-tail fields.
    const exits = workerExitsFor(orphan.executionId);
    assert.equal(exits.length, 1, `exactly one worker.exit (got ${exits.length})`);
    assert.equal(exits[0].data.pid_alive, true,
      'the observation states the PID was STILL ALIVE at settlement');
    assert.equal(exits[0].data.exit_code, null);
    assert.equal(exits[0].data.physical_exit_observed, false);
    assert.equal(exits[0].data.outcome, 'receipt_authoritative_settlement');

    // Late close backfill WITHOUT duplicate: the runner's close callback
    // finally arrives (exit code 0). It loses the terminal CAS, may only
    // enrich exit_code, and must not emit a second worker.exit.
    const lateOutcome = markExecutionExited(process.env.DB_PATH, orphan.executionId, 0);
    assert.equal(lateOutcome.terminalized, false,
      'the late close lost the durable terminal write');
    const backfilled = db.prepare(
      'SELECT state, exit_code FROM worker_executions WHERE execution_id=?',
    ).get(orphan.executionId);
    assert.equal(backfilled.state, 'exited', 'the standing terminal is authoritative');
    assert.equal(backfilled.exit_code, 0,
      'the late close backfilled the real exit code');
    assert.equal(workerExitsFor(orphan.executionId).length, 1,
      'the late close did not duplicate worker.exit');

    // Idempotency: a repeated terminal settlement over the converged scope
    // changes nothing and emits nothing.
    const again = await settleWorkerExecutionsAtTerminalRun(handle, {
      projectId, epicId, db, drainMs: 10, log: () => {},
    });
    assert.equal(again.settled.length, 0);
    assert.equal(again.activeRemaining, 0);
    assert.equal(workerExitsFor(orphan.executionId).length, 1,
      'the repeated settlement emitted nothing new');
    assert.equal(
      db.prepare('SELECT state, exit_code FROM worker_executions WHERE execution_id=?')
        .get(orphan.executionId).exit_code,
      0,
      'the backfilled exit code was not overwritten',
    );
  } finally {
    handle.stop();
  }
});

test('ADR-087 fail-closed: a no-receipt active residual raises the typed settlement failure and is never fabricated complete', async () => {
  const { projectId, epicId } = makeScope();
  const residual = createNoReceiptActive(projectId, epicId);
  const db = getDb();

  const handle = startWorkerSupervision({
    executionRuntime: new SqliteExecutionRuntimeRepository(),
    projectId,
    epicId,
    intervalMs: 60_000,
    log: () => {},
  });

  try {
    const startedAt = Date.now();
    await assert.rejects(
      settleWorkerExecutionsAtTerminalRun(handle, {
        projectId, epicId, db, drainMs: 200, log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof TerminalWorkerSettlementError,
          `typed failure (got ${error?.constructor?.name})`);
        assert.equal(error.code, 'RESIDUAL_ACTIVE_EXECUTIONS');
        assert.ok(error.message.includes(residual.executionId),
          'the residual execution is named in the failure');
        const named = error.residuals.find(r => r.executionId === residual.executionId);
        assert.ok(named, 'the residual is itemized');
        assert.equal(named.code, 'NO_ACCEPTED_RECEIPT');
        return true;
      },
    );
    // BOUNDED wait: the natural-drain courtesy waited the configured window
    // (>= the drain budget) and no longer (well under any unbounded stall).
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 190, `drain window honored (elapsed ${elapsed}ms)`);
    assert.ok(elapsed < 5_000, `drain window bounded (elapsed ${elapsed}ms)`);

    // Fail-closed means NO fabricated completion: the no-receipt row is
    // untouched — still active, no terminal, no observation.
    const row = db.prepare(
      'SELECT state, exit_code FROM worker_executions WHERE execution_id=?',
    ).get(residual.executionId);
    assert.equal(row.state, 'running',
      'a non-receipt residual is never terminally fabricated');
    assert.equal(workerExitsFor(residual.executionId).length, 0,
      'no worker.exit was invented for the residual');
    assert.equal(activeCount(projectId, epicId), 1,
      'the residual remains truthfully accounted as active');
  } finally {
    handle.stop();
  }
});

test('ADR-087 drain window: valid env honored, invalid env fails closed as a typed config error', async () => {
  const { projectId, epicId } = makeScope();
  const db = getDb();
  const handle = startWorkerSupervision({
    executionRuntime: new SqliteExecutionRuntimeRepository(),
    projectId,
    epicId,
    intervalMs: 60_000,
    log: () => {},
  });

  try {
    // Empty scope + default drain: converges immediately, zero wait.
    const fast = await settleWorkerExecutionsAtTerminalRun(handle, {
      projectId, epicId, db, log: () => {},
    });
    assert.equal(fast.activeBeforeDrain, 0);
    assert.equal(fast.activeRemaining, 0);
    assert.equal(fast.drainMs, 5_000, 'default drain window');

    // Valid env value is honored (zero window via env).
    process.env.SAGA_TERMINAL_DRAIN_MS = '0';
    const zero = await settleWorkerExecutionsAtTerminalRun(handle, {
      projectId, epicId, db, log: () => {},
    });
    assert.equal(zero.drainMs, 0, 'SAGA_TERMINAL_DRAIN_MS=0 honored');
    delete process.env.SAGA_TERMINAL_DRAIN_MS;

    // Invalid env values fail CLOSED with the typed config error — never a
    // silent default that would let a terminal launch exit "clean" on a typo.
    // Values ABOVE the ADR-087 five-second courtesy cap are equally invalid:
    // the window is a courtesy whose correctness never depends on it, so a
    // longer wait would only delay every terminal engine exit.
    for (const invalid of ['not-a-number', '-5', '2.5', '5001', '60000']) {
      process.env.SAGA_TERMINAL_DRAIN_MS = invalid;
      await assert.rejects(
        settleWorkerExecutionsAtTerminalRun(handle, { projectId, epicId, db, log: () => {} }),
        (error) => {
          assert.ok(error instanceof TerminalWorkerSettlementError);
          assert.equal(error.code, 'INVALID_DRAIN_WINDOW');
          assert.ok(error.message.includes(invalid),
            `the raw value ${invalid} is named`);
          return true;
        },
      );
      delete process.env.SAGA_TERMINAL_DRAIN_MS;
    }
    assert.equal(process.env.SAGA_TERMINAL_DRAIN_MS, undefined);

    // The cap applies to the EXPLICIT option too, and the boundary itself is
    // legal: exactly 5000ms is the ADR maximum, 5001ms is rejected.
    const atCap = await settleWorkerExecutionsAtTerminalRun(handle, {
      projectId, epicId, db, drainMs: 5_000, log: () => {},
    });
    assert.equal(atCap.drainMs, 5_000, 'drainMs=5000 is the legal ADR-087 maximum');
    await assert.rejects(
      settleWorkerExecutionsAtTerminalRun(handle, {
        projectId, epicId, db, drainMs: 5_001, log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof TerminalWorkerSettlementError);
        assert.equal(error.code, 'INVALID_DRAIN_WINDOW');
        assert.ok(error.message.includes('5000'),
          'the rejection names the ADR-087 cap');
        return true;
      },
    );
  } finally {
    handle.stop();
  }
});

test('ADR-087 wiring and mutation ratchets (source)', async () => {
  const cli = readFileSync(path.join(REPO_ROOT, 'src', 'orchestrate-cli.ts'), 'utf8');
  assert.ok(
    cli.includes('settleWorkerExecutionsAtTerminalRun('),
    'orchestrate-cli invokes the ADR-087 terminal settlement',
  );
  assert.ok(
    cli.includes('terminalSettlementFailure'),
    'the engine terminal boundary carries the typed settlement failure into the launch settlement',
  );
  assert.ok(
    cli.includes("journalEvent('terminal_settlement.failed'"),
    'the typed settlement failure is journalled as run-journal evidence (not only the generic engine.exit reason)',
  );
  assert.ok(
    cli.includes('residuals: typed'),
    'the journalled evidence itemizes the typed residual summary (code + per-execution residuals)',
  );

  const service = readFileSync(
    path.join(REPO_ROOT, 'src', 'infrastructure', 'work', 'worker-supervision-service.ts'),
    'utf8',
  );
  assert.ok(
    service.includes("journalEvent('worker.exit'"),
    'the supervision sweep emits worker.exit for sweep-converged exits',
  );
  assert.ok(
    service.includes('MAX_TERMINAL_DRAIN_MS = 5_000'),
    'mutation guard: the ADR-087 five-second courtesy cap constant is present',
  );
  assert.ok(
    service.includes('value > MAX_TERMINAL_DRAIN_MS'),
    'mutation guard: explicit/env drain values above the cap are rejected (removing the check goes red)',
  );

  // Mutation ratchet over the settlement itself: it MUST settle through the
  // existing fenced atomic release (in-write receipt re-verification) and
  // MUST NOT kill or stop anything (no executor registry, no runner stop).
  const settleStart = service.indexOf('export async function settleWorkerExecutionsAtTerminalRun');
  assert.ok(settleStart >= 0, 'settleWorkerExecutionsAtTerminalRun is exported');
  const settleBody = service.slice(settleStart);
  assert.ok(
    settleBody.includes('releaseExecutionAtomically'),
    'mutation guard: settlement uses the existing fenced atomic release (removing it goes red)',
  );
  assert.ok(
    settleBody.includes('accepted_receipt !== 1'),
    'mutation guard: the no-receipt fail-closed gate is present',
  );
  assert.ok(
    settleBody.includes('STILL_ACTIVE'),
    'mutation guard: the final active recount residual code is present',
  );
  assert.ok(
    !settleBody.includes('killVerified'),
    'mutation guard: the settlement never kills (ADR-087 Option B)',
  );
  assert.ok(
    !/\.stop\(\)/.test(settleBody),
    'mutation guard: the settlement never stops a runner (no Option A registry)',
  );

  // The runner must keep gating its own worker.exit on WINNING the durable
  // terminal write, so sweep-first orders cannot double-emit.
  const runner = readFileSync(path.join(REPO_ROOT, 'tracker-view', 'claude-runner.mjs'), 'utf8');
  assert.ok(
    runner.includes('closeWonTerminalWrite'),
    'the runner emits worker.exit only when its markExited write terminalized the row',
  );

  // The ADR itself is part of the owned change set.
  assert.ok(
    existsSync(path.join(REPO_ROOT, 'docs', 'architecture', 'decisions', '087-receipt-authoritative-terminal-drain.md')),
    'ADR-087 is present in the repository',
  );
});
