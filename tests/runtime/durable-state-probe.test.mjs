// tests/runtime/durable-state-probe.test.mjs
//
// Antifreeze layer B2 (TB-2 freeze class, docs/testing/WORKSHOP-BUGS.md):
// the engine wait loop used to poll durable state through the SHARED main
// connection (getDb(), busy_timeout=5000). Under write contention that
// connection busy-spins ON THE MAIN THREAD — and when the lock holder is an
// async path of the same process, the spin is eternal. The probe moves those
// polls to a dedicated READONLY connection:
//
//   * a WAL reader never waits for the single writer slot — under an external
//     BEGIN IMMEDIATE holder the probe must return FAST (<300ms) with the
//     correct committed answer (test 2);
//   * commits made by OTHER connections are visible to the probe (WAL
//     snapshot isolation is per-connection, a fresh read sees fresh commits —
//     test 1: terminal state fixed by another connection is seen);
//   * when a read genuinely cannot proceed (rollback-journal EXCLUSIVE lock),
//     the probe's 250ms timeout turns it into `false`/`-1` — NEVER a throw,
//     NEVER a 5s spin (test 3);
//   * unknown counts are -1 and callers treat non-zero as "still active".
//
// The SQL statements exercised here are the EXACT statements the engine loop
// previously ran inline (src/orchestrate-cli.ts): isExecutionDurableTerminal,
// shouldYieldToKernel (factory_workplaces JOIN factory_process_runs), and the
// paused-loop active-execution COUNT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  ensureFactoryProcessRunSchema,
} from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import {
  createDurableStateProbe,
} from '../../dist/runtime/durable-state-probe.js';

function makeDb(journalMode = 'WAL') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-probe-'));
  const dbPath = path.join(dir, 'probe.db');
  const writer = new Database(dbPath);
  writer.pragma(`journal_mode = ${journalMode}`);
  writer.pragma('foreign_keys = ON');
  writer.pragma('busy_timeout = 5000');
  writer.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(writer);
  return { dir, dbPath, writer };
}

function insertExecution(db, executionId, state, projectId = 1, epicId = 1) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase)
     VALUES (?, 'run', ?, ?, 100, 'w', 'm', ?, 'executing')`,
  ).run(executionId, projectId, epicId, state);
}

test('probe sees terminal state committed by ANOTHER connection (WAL visibility)', () => {
  const { dir, dbPath, writer } = makeDb();
  try {
    const other = new Database(dbPath);
    other.pragma('busy_timeout = 5000');
    insertExecution(writer, 'exec-visible', 'running');
    const probe = createDurableStateProbe(dbPath);
    try {
      assert.equal(probe.isExecutionDurableTerminal('exec-visible'), false);
      assert.equal(probe.countActiveExecutions(1, 1), 1);
      // Another connection (NOT the probe, NOT the original writer) fixes the
      // durable terminal state and commits.
      other.prepare(
        `UPDATE worker_executions SET state='exited' WHERE execution_id=?`,
      ).run('exec-visible');
      assert.equal(probe.isExecutionDurableTerminal('exec-visible'), true);
      assert.equal(probe.countActiveExecutions(1, 1), 0);
    } finally {
      probe.close();
      other.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe returns in <300ms with the correct answer under an external write-lock holder', () => {
  const { dir, dbPath, writer } = makeDb();
  try {
    insertExecution(writer, 'exec-locked', 'running');
    const holder = new Database(dbPath);
    holder.pragma('busy_timeout = 5000');
    const probe = createDurableStateProbe(dbPath);
    try {
      // External write-lock holder: BEGIN IMMEDIATE + a write acquires the
      // single WAL writer slot. A WAL READER is not blocked by this.
      holder.exec('BEGIN IMMEDIATE');
      holder.prepare(
        `UPDATE worker_executions SET state='terminated' WHERE execution_id='exec-locked'`,
      ).run();
      const started = Date.now();
      // Uncommitted 'terminated' must NOT be visible; committed 'running'
      // must be. And the read must not wait for the holder.
      const terminal = probe.isExecutionDurableTerminal('exec-locked');
      const elapsed = Date.now() - started;
      assert.equal(terminal, false);
      assert.equal(probe.countActiveExecutions(1, 1), 1);
      assert.ok(
        elapsed < 300,
        `probe read under write-lock holder took ${elapsed}ms (expected <300ms)`,
      );
      holder.exec('ROLLBACK');
    } finally {
      probe.close();
      holder.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe fails closed (false/-1, never throws) when the read is genuinely blocked', () => {
  // Rollback-journal mode + BEGIN EXCLUSIVE blocks even readers — the ONLY
  // case where a probe read can wait. The probe's 250ms timeout must turn it
  // into `false` / `-1` instead of a busy-spin or a throw.
  const { dir, dbPath, writer } = makeDb('DELETE');
  try {
    insertExecution(writer, 'exec-blocked', 'exited');
    const holder = new Database(dbPath);
    holder.pragma('busy_timeout = 5000');
    const probe = createDurableStateProbe(dbPath);
    try {
      // Sanity: the terminal state IS visible without the exclusive lock.
      assert.equal(probe.isExecutionDurableTerminal('exec-blocked'), true);
      holder.exec('BEGIN EXCLUSIVE');
      const started = Date.now();
      const terminal = probe.isExecutionDurableTerminal('exec-blocked');
      const elapsed = Date.now() - started;
      // Fail closed: unknown → false (next poll retries).
      assert.equal(terminal, false);
      // Bounded: ~250ms busy handler + slack, NOT the 5s freeze class.
      assert.ok(elapsed < 900, `blocked probe read took ${elapsed}ms (expected <900ms)`);
      assert.equal(probe.countActiveExecutions(1, 1), -1);
      assert.equal(probe.isKernelWorkPending(1), false);
      holder.exec('ROLLBACK');
      // Self-heal: after the lock is released the probe reconnects and
      // returns the true answer again.
      assert.equal(probe.isExecutionDurableTerminal('exec-blocked'), true);
    } finally {
      probe.close();
      holder.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isKernelWorkPending detects a live kernel-owned workplace and ignores other scopes', () => {
  const { dir, dbPath, writer } = makeDb();
  try {
    writer.prepare(`INSERT INTO projects (name) VALUES ('p')`).run();
    writer.prepare(
      `INSERT INTO factory_process_runs
         (project_id, epic_id, module_name, module_version, module_ref_key,
          idempotency_key, executor_kind, input_schema, input_snapshot,
          input_hash, status)
       VALUES (1, 7, 'm', 'v', 'm@v', 'idem', 'module-adapter', 'x', '{}',
               'hash', 'running')`,
    ).run();
    const runId = writer.prepare(
      'SELECT id FROM factory_process_runs LIMIT 1',
    ).get().id;
    writer.prepare(
      `INSERT INTO factory_workplaces
         (workplace_ref, process_run_id, module_ref, production_cell_id,
          work_key, kanban_phase, loop_state, next_role)
       VALUES (?, ?, 'm@v', 'cell', 'wk', 'todo', 'repair_wait', 'author')`,
    ).run(`workplace/${runId}/m@v/cell/wk`, runId);
    const probe = createDurableStateProbe(dbPath);
    try {
      assert.equal(probe.isKernelWorkPending(7), true);
      assert.equal(probe.isKernelWorkPending(999), false);
    } finally {
      probe.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
