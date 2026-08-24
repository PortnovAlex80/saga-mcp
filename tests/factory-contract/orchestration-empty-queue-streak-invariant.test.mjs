// tests/factory-contract/orchestration-empty-queue-streak-invariant.test.mjs
//
// STAGE-23 (2026-08-24) — the Elite-9 incident, pinned twice.
//
// The incident (INC-1, 2026-08-24): the shared-core-foundation card failed
// terminally while its 8 dependents sat at kanban 'todo' / loop_state 'idle'.
// Idle workplaces are invisible to BOTH the claim gates (they require
// loop_state='queued') and the old empty-queue streak resets — so with
// dispatched=0, activeExecutions=0, humanPaused=0 and kernelProgress=0 the
// engine's bounded empty-queue streak lawfully counted to 3 and the factory
// STOPPED with real work remaining. ADR-047 Decision 5: the streak is lawful
// ONLY when NOTHING explains the pause. Non-terminal stage work IS an
// explanation.
//
// Fix a9a3f289 added the wait-nonterminal-work branch: while
// otherNonTerminalCount > 0 the streak resets and the engine waits. This
// suite pins the invariant on both levels:
//   (unit)      readCurrentStageWorkplaceState must COUNT idle/queued
//               workplaces into otherNonTerminalCount (the branch's input
//               signal) — not into kernelProgress or humanPaused;
//   (structural oracle, the development-terminal-exit-accounting pattern)
//               both src/orchestrate-cli.ts and dist/orchestrate-cli.js must
//               carry the branch that RESETS the streak on
//               otherNonTerminalCount > 0 — deleting the fix (or shipping a
//               dist built without it) turns this red.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { readCurrentStageWorkplaceState } from '../../dist/app/orchestration-idle-state.js';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';

// ---------------------------------------------------------------------------
// Unit — the branch's input signal.
// ---------------------------------------------------------------------------
test('idle and queued workplaces count into otherNonTerminalCount (the Elite-9 stop signal)', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryLifecycleRunSchema(db);
  db.pragma('foreign_keys=OFF');
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,package_digest)
     VALUES (9,1,1,'solution-development','1.4.4','solution-development@1.4.4','run-9','generic-flow',
             'factory.synthetic-input.v1','{}','h','running','h')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name, description,
        definition_snapshot, definition_hash, project_id, epic_id, initiated_by, idempotency_key,
        input_schema, input_snapshot, input_hash, status, entry_stage_id, current_stage_run_id,
        version, created_at, updated_at)
     VALUES (1,'product-delivery','1.0.0','ld:streak','d','d','{}','h',1,1,'test','idem-1',
             'factory.development-case.v1','{}','h','paused','initial-discovery',1,1,
             datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id, lifecycle_run_id, stage_id, attempt, ordinal, module_name, module_version,
        module_ref_key, binding_snapshot, binding_hash, input_schema, input_snapshot,
        input_hash, status, process_run_id)
     VALUES (1, 1, 'solution-development', 1, 1, 'solution-development', '1.4.4',
             'solution-development@1.4.4', '{}', 'h', 'factory.synthetic-input.v1', '{}', 'h',
             'paused', 9)`,
  ).run();
  const seed = (key, loopState) => db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,9,'solution-development@1.4.4','development-implementation',?,'todo',?,'author',0)`,
  ).run(`workplace/9/solution-development@1.4.4/development-implementation/${key}`, key, loopState);

  seed('idle-1', 'idle');
  seed('idle-2', 'idle');
  seed('queued-1', 'queued');

  const state = readCurrentStageWorkplaceState(db, 1);
  assert.equal(state.kernelProgressCount, 0,
    'idle/queued is NOT kernel-owned progress');
  assert.equal(state.humanPausedCount, 0,
    'idle/queued is NOT the human-paused boundary');
  assert.equal(state.otherNonTerminalCount, 3,
    'the Elite-9 shape: 3 non-terminal workplaces explain the pause — '
    + 'the streak must reset, never count');
  db.close();
});

// ---------------------------------------------------------------------------
// Structural oracle — the branch exists in src AND in the built dist.
// ---------------------------------------------------------------------------
const read = (p) => readFileSync(p, 'utf8');

test('the wait-nonterminal-work streak reset exists in src AND dist (a9a3f289 present)', () => {
  for (const file of ['src/orchestrate-cli.ts', 'dist/orchestrate-cli.js']) {
    const text = read(file);
    assert.ok(text.includes('wait-nonterminal-work'),
      `${file}: the engine phase mark of the ADR-047 Decision 5 branch is missing`);
    const at = text.indexOf('wait-nonterminal-work');
    const around = text.slice(Math.max(0, at - 900), at);
    assert.ok(around.includes('otherNonTerminalCount'),
      `${file}: the branch must be keyed on otherNonTerminalCount`);
    assert.ok(/emptyDispatchStreak\s*=\s*0/.test(around),
      `${file}: the branch must RESET the streak, not just log`);
  }
});
