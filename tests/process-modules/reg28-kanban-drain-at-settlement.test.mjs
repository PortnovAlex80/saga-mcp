// REG-28 — KANBAN-DRAIN-AT-TERMINAL: the focused regression owed by the
// stage-23 lifecycle-2 incident (14:01:42, docs/factory-run/stage23-devtest/
// TRACKER.md "Qualification correction: REG-28 remains open").
//
// THE INCIDENT SHAPE: the Development lifecycle reached its terminal
// boundary while the Kanban board still carried `todo`/`queued` cards —
// REG-28-AC-01's closed phase×loop table has no lawful slot for anonymous
// todo beside a SETTLED run. The board promised pending work that the
// closed run could never dispatch. Until the repair, nothing in production
// reclassified those rows: the replan continuation drains its cycle-1
// leftovers (replan-supersede.ts), but the ORDINARY settlement path had no
// counterpart.
//
// THE INVARIANT (this file's oracle):
//   at a lifecycle terminal boundary the board contains no anonymous
//   todo/queued work — anonymous live cards are cancelled with the
//   settlement outcome as their terminal reason; TYPED waits (paused
//   human-required parks, repair_wait, verifying, effect_pending) are
//   explicit states the settlement reason owns and are NEVER
//   force-cancelled by the drain; accepted/terminal rows are never touched.
//
// RED/GREEN: on the pre-repair tree the drain did not exist and the exact
// counterexample below (terminal settlement + todo/idle card) survived
// undrained — the recorded RED is the stage-23 incident itself; the same
// shape is reconstructed here and must be drained by
// drainAnonymousWorkOnProcessSettlement, which the GenericFlowExecutor calls
// INSIDE the settlement transaction (wired from product-lifecycle-runtime's
// sharedDeps into every module executor). The end-to-end board-clean
// assertion at real terminal boundaries is additionally pinned by the
// factory-proof scenarios that settle blocked/failed Development outcomes
// (development/local-readiness-failed-upstream-blocked,
// development/planner-frozen-srs-unsat-failed) through their
// kanban-drain-at-terminal oracle.
//
// Run: node --test tests/process-modules/reg28-kanban-drain-at-settlement.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { drainAnonymousWorkOnProcessSettlement } = await import(
  '../../dist/process-modules/infrastructure/workplace-settlement-drain.js'
);
const { ensureFactoryProcessRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);

const RUN_ID = 41;
const PROJECT_ID = 1;

function seedBoard(db) {
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('reg28');
  db.prepare('INSERT INTO epics (project_id, name) VALUES (?, ?)')
    .run(PROJECT_ID, 'reg28-epic');
  db.prepare(
    `INSERT INTO factory_process_runs (id, project_id, epic_id, module_name, module_version,
                                       module_ref_key, idempotency_key, executor_kind,
                                       input_schema, input_snapshot, input_hash, status, local_outcome)
     VALUES (?, ?, 1, 'solution-development', '1.4.4',
             'solution-development@1.4.4', 'reg28-test-run', 'generic-flow',
             'factory.development-case.v1', '{}', '${'h'.repeat(64)}', 'completed', 'blocked')`,
  ).run(RUN_ID, PROJECT_ID);

  const mkWorkplace = (workKey, kanban, loop, terminalReason) => {
    const ref = `workplace/${RUN_ID}/solution-development@1.4.4/development-implementation/${workKey}`;
    db.prepare(
      `INSERT INTO factory_workplaces (process_run_id, module_ref, production_cell_id, work_key, workplace_ref,
                                       kanban_phase, loop_state, next_role, terminal_reason, revision)
       VALUES (?, 'solution-development@1.4.4', 'development-implementation', ?, ?,
               ?, ?, 'author', ?, 3)`,
    ).run(RUN_ID, workKey, ref, kanban, loop, terminalReason);
    return ref;
  };

  // 1. the terminal-accepted card (must never be touched)
  const acceptedRef = mkWorkplace('done-item', 'done', 'terminal', 'accepted');
  // 2. THE REG-28 COUNTEREXAMPLE: work reached terminal while this card
  //    remains queued (todo/idle — anonymous, no owner, no typed wait)
  const queuedRef = mkWorkplace('queued-item', 'todo', 'idle', null);
  // 3. a second anonymous live card in the queued loop state
  const queued2Ref = mkWorkplace('queued-item-2', 'in_progress', 'queued', null);
  // 4. a TYPED park (human-required) — sacred, must survive the drain
  const parkedRef = mkWorkplace('parked-item', 'blocked', 'paused', null);
  // 5. a typed repair_wait — sacred (§23 explicit typed wait)
  const repairRef = mkWorkplace('repair-item', 'in_progress', 'repair_wait', null);

  const mkTask = (workKey, workplaceRef, status) => db.prepare(
    `INSERT INTO tasks (title, status, epic_id, task_kind, workflow_stage, execution_mode, tags, metadata, workplace_ref)
     VALUES (?, ?, 1, 'development.code', 'solution-development', 'git_change', '[]', '{}', ?)`,
  ).run(`reg28-${workKey}`, status, workplaceRef).lastInsertRowid;

  const acceptedTask = mkTask('done-item', acceptedRef, 'done');
  const queuedTask = mkTask('queued-item', queuedRef, 'todo');
  const queued2Task = mkTask('queued-item-2', queued2Ref, 'in_progress');
  const parkedTask = mkTask('parked-item', parkedRef, 'blocked');
  const repairTask = mkTask('repair-item', repairRef, 'in_progress');

  return {
    acceptedRef, queuedRef, queued2Ref, parkedRef, repairRef,
    acceptedTask: Number(acceptedTask), queuedTask: Number(queuedTask),
    queued2Task: Number(queued2Task), parkedTask: Number(parkedTask),
    repairTask: Number(repairTask),
  };
}

function board(db) {
  return db.prepare(
    `SELECT workplace_ref, kanban_phase, loop_state, terminal_reason, revision
       FROM factory_workplaces WHERE process_run_id=? ORDER BY workplace_ref`,
  ).all(RUN_ID);
}

test('REG-28 kanban-drain: the exact counterexample (terminal settlement + queued card) is drained — no todo/queued survives the terminal boundary', () => {
  const db = new Database(':memory:');
  try {
    const refs = seedBoard(db);
    const result = drainAnonymousWorkOnProcessSettlement(db, {
      processRunId: RUN_ID,
      outcome: 'blocked',
    });

    // Both anonymous live cards drained, named, and only those.
    assert.deepEqual(
      [...result.drainedWorkplaceRefs].sort(),
      [refs.queued2Ref, refs.queuedRef].sort(),
    );
    assert.deepEqual(
      [...result.drainedTaskIds].sort((a, b) => a - b),
      [refs.queued2Task, refs.queuedTask].sort((a, b) => a - b),
    );

    const rows = board(db);
    const byRef = new Map(rows.map(r => [r.workplace_ref, r]));
    // THE INVARIANT: no anonymous todo/queued remains on the settled run.
    const anonymous = rows.filter(r =>
      (r.kanban_phase === 'todo' || r.kanban_phase === 'in_progress')
      && (r.loop_state === 'idle' || r.loop_state === 'queued'));
    assert.deepEqual(anonymous, [],
      'a settled run may not leave anonymous todo/queued cards on the board');

    const drained = byRef.get(refs.queuedRef);
    assert.equal(drained.kanban_phase, 'cancelled');
    assert.equal(drained.loop_state, 'terminal');
    assert.equal(drained.terminal_reason, 'cancelled');
    assert.equal(drained.revision, 4, 'CAS revision bump — a stale lease cannot win against the drained state');

    const taskRow = db.prepare('SELECT status, metadata FROM tasks WHERE id=?')
      .get(refs.queuedTask);
    assert.equal(taskRow.status, 'cancelled');
    assert.deepEqual(JSON.parse(taskRow.metadata).settled_with_run,
      { processRunId: RUN_ID, outcome: 'blocked' });

    // Accepted/terminal rows are never touched.
    const accepted = byRef.get(refs.acceptedRef);
    assert.equal(accepted.kanban_phase, 'done');
    assert.equal(accepted.loop_state, 'terminal');
    assert.equal(accepted.terminal_reason, 'accepted');
    assert.equal(accepted.revision, 3);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?')
      .get(refs.acceptedTask).status, 'done');
  } finally {
    db.close();
  }
});

test('REG-28 kanban-drain: typed waits (human parks, repair_wait) are sacred — the drain never force-cancels an explicit typed state', () => {
  const db = new Database(':memory:');
  try {
    const refs = seedBoard(db);
    drainAnonymousWorkOnProcessSettlement(db, {
      processRunId: RUN_ID,
      outcome: 'blocked',
    });
    const byRef = new Map(board(db).map(r => [r.workplace_ref, r]));

    const parked = byRef.get(refs.parkedRef);
    assert.equal(parked.loop_state, 'paused');
    assert.equal(parked.kanban_phase, 'blocked');
    assert.equal(parked.revision, 3, 'park untouched');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?')
      .get(refs.parkedTask).status, 'blocked');

    const repair = byRef.get(refs.repairRef);
    assert.equal(repair.loop_state, 'repair_wait');
    assert.equal(repair.revision, 3, 'typed repair wait untouched');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?')
      .get(refs.repairTask).status, 'in_progress');
  } finally {
    db.close();
  }
});

test('REG-28 kanban-drain: idempotent — a replay finds only drained/typed rows and drains nothing', () => {
  const db = new Database(':memory:');
  try {
    seedBoard(db);
    const first = drainAnonymousWorkOnProcessSettlement(db, {
      processRunId: RUN_ID, outcome: 'blocked',
    });
    const second = drainAnonymousWorkOnProcessSettlement(db, {
      processRunId: RUN_ID, outcome: 'blocked',
    });
    assert.equal(first.drainedWorkplaceRefs.length, 2);
    assert.deepEqual(second, { drainedWorkplaceRefs: [], drainedTaskIds: [] });
    // And the board is still clean.
    const anonymous = board(db).filter(r =>
      (r.kanban_phase === 'todo' || r.kanban_phase === 'in_progress')
      && (r.loop_state === 'idle' || r.loop_state === 'queued'));
    assert.deepEqual(anonymous, []);
  } finally {
    db.close();
  }
});

test('REG-28 kanban-drain: the settlement seam is wired — the composition root passes the drain into every module executor', async () => {
  // MECHANICAL PRODUCER PINS (source scans — same discipline as the
  // terminal-exit-accounting allowlist): the drain must be (a) implemented,
  // (b) constructed in the canonical composition root's sharedDeps, and
  // (c) invoked inside the GenericFlowExecutor settlement transaction. If
  // any pin breaks, the wiring is stale and the invariant is unguarded.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = rel => readFileSync(path.join(root, rel), 'utf8');

  const runtime = read('src/app/product-lifecycle-runtime.ts');
  assert.match(runtime, /drainAnonymousWorkOnProcessSettlement\(db, \{ processRunId, outcome \}\)/,
    'the composition root must wire the drain into sharedDeps.settleDrain');

  const executor = read('src/process-modules/application/generic-flow-executor.ts');
  const settlementTx = executor.slice(
    executor.indexOf('processRunRepo.transaction(() => {'),
    executor.indexOf('return runResult;'),
  );
  assert.match(settlementTx, /this\.opts\.settleDrain\?\.\(context\.processRunId, terminal\.outcome\)/,
    'the drain must run INSIDE the settlement transaction (no half-settled board is observable)');

  for (const moduleIndex of [
    'src/modules/development/index.ts',
    'src/modules/discovery/index.ts',
    'src/modules/formalization/index.ts',
    'src/modules/delivery/index.ts',
  ]) {
    const source = read(moduleIndex);
    const wired = (source.match(/settleDrain: sharedDeps\.settleDrain,/g) ?? []).length;
    const executors = (source.match(/new GenericFlowExecutor\(/g) ?? []).length;
    assert.ok(executors > 0 && wired === executors,
      `${moduleIndex}: every GenericFlowExecutor (${executors}) must receive settleDrain (found ${wired})`);
  }
});
