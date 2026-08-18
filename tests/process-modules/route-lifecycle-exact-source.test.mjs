// tests/process-modules/route-lifecycle-exact-source.test.mjs
//
// K13 (M3, card commit 4) — "settle by exact source and postcondition":
// no generic status change can prove effect or routing completion.
//
// WHAT THIS PROVES:
//   1. EXACT SOURCE (routing): routing is durable iff the lifecycle moved
//      past the settled ProcessRun's stage run(s), quantified over ALL of
//      them — never a sampled row. (factory_stage_runs.process_run_id is
//      UNIQUE, so the legal shape is 1:1 and the pre-K13 .get() was
//      equivalent for it; the quantifier + the typed empty case make the
//      invariant explicit instead of incidental — and hold if the
//      cardinality ever widens.)
//   2. GENERIC STATUS SETTLES NOTHING: a bare Workplace status write
//      (loop_state='terminal', terminal_reason='accepted') satisfies NO
//      handoff postcondition, and a non-terminal lifecycle status write
//      satisfies no routing. Terminal lifecycle states remain valid routing
//      facts — they are durable monotonic states with a typed writer (the
//      orchestrator), unlike Workplace status columns.
//
// WHO EXTENDS THIS: routing receipts get an exact durable identity of their
// own in a later release (the alias residue is reported); until then the
// quantifier + terminal-state disjunct is the honest bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { readTransitionHandoffPostcondition } from '../../dist/process-modules/application/transition-handoff-postconditions.js';

const WP = 'workplace/1/m@1.0.0/cell/work-1';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  ensureFactoryLifecycleRunSchema(db);
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
        idempotency_key,input_schema,input_snapshot,input_hash,status,
        entry_stage_id,current_stage_id,current_stage_run_id)
     VALUES ('product-delivery','1.0.0','key','Run','run','{}','h',1,NULL,'test',
             'idem-1','{}','{}','ih','running','stage-a','stage-b',NULL)`,
  ).run();
  return db;
}

function stageRun(db, { id, lifecycleRunId = 1, processRunId = 7 }) {
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
        module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
        input_hash,status,process_run_id)
     VALUES (?,?,?,?,1,'mod','1.0.0','k','{}','bh','{}','{}','ih','completed',?)`,
  ).run(id, lifecycleRunId, id, `stage-${id}`, processRunId);
}

const routeObligation = () => ({
  obligationKey: `${WP}:route-lifecycle:process-settled:process-run:7`,
  sourceKind: 'process-settled',
  sourceRef: 'process-run:7',
  sourceDigest: 'd'.repeat(64),
  subjectRef: WP,
  handoffKind: 'route-lifecycle',
  ownerCapability: 'lifecycle-orchestrator',
  fence: 1,
  leaseFence: null,
  state: 'in_progress',
  attempt: 1,
  leaseOwner: 'test',
  leaseExpiresAt: null,
  completionReceipt: null,
  resultDigest: null,
  lastError: null,
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:00:00Z',
});

test('K13/route-exact-source: pinned on the source\'s stage run means NOT routed; moved past means routed', () => {
  const db = fixture();
  stageRun(db, { id: 1 });
  // The lifecycle is still ON the settled ProcessRun's stage run: routing
  // past it has not happened.
  db.prepare('UPDATE factory_lifecycle_runs SET current_stage_run_id=1 WHERE id=1').run();
  assert.equal(readTransitionHandoffPostcondition(db, routeObligation()).satisfied, false,
    'current pinned on the source\'s stage run is not a routing receipt');

  // Moved past the source's stage run: now, and only now, routed.
  db.prepare('UPDATE factory_lifecycle_runs SET current_stage_run_id=2 WHERE id=1').run();
  assert.equal(readTransitionHandoffPostcondition(db, routeObligation()).satisfied, true);
  db.close();
});

test('K13/route-exact-source: a terminal lifecycle is a durable routing fact; paused never is', () => {
  const db = fixture();
  stageRun(db, { id: 1 });
  for (const [status, expected] of [['completed', true], ['failed', true], ['cancelled', true], ['paused', false], ['running', false]]) {
    db.prepare('UPDATE factory_lifecycle_runs SET status=?, current_stage_run_id=1 WHERE id=1').run(status);
    assert.equal(
      readTransitionHandoffPostcondition(db, routeObligation()).satisfied,
      expected,
      `lifecycle status '${status}' ${expected ? 'is' : 'is NOT'} a routing fact`,
    );
  }
  db.close();
});

test('K13/route-exact-source: no stage runs for the source is NOT routed (never vacuously satisfied)', () => {
  const db = fixture();
  stageRun(db, { id: 1, processRunId: 99 });
  assert.equal(readTransitionHandoffPostcondition(db, routeObligation()).satisfied, false,
    'another process\'s stage run must not satisfy this obligation');
  db.close();
});

test('K13/generic-status: a bare Workplace status write settles NOTHING', () => {
  const db = fixture();
  // The most dishonest possible write: loop_state 'terminal', reason
  // 'accepted', directly on the Workplace row — the exact shape a generic
  // status settlement would rely on.
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,7,'m@1.0.0','cell','work-1','in_progress','terminal','author',9,'accepted')`,
  ).run(WP);
  for (const handoffKind of ['run-effects', 'record-final-acceptance', 'route-lifecycle']) {
    const obligation = { ...routeObligation(), handoffKind, sourceRef: handoffKind === 'route-lifecycle' ? 'process-run:7' : 'decision:A' };
    const postcondition = readTransitionHandoffPostcondition(db, obligation);
    assert.equal(postcondition.satisfied, false,
      `a Workplace status write must not settle ${handoffKind}: ${postcondition.reason}`);
  }
  // Even the lifecycle status write settles nothing while non-terminal.
  stageRun(db, { id: 1 });
  db.prepare("UPDATE factory_lifecycle_runs SET status='running', current_stage_run_id=1 WHERE id=1").run();
  assert.equal(readTransitionHandoffPostcondition(db, routeObligation()).satisfied, false);
  db.close();
});
