// tests/app/human-gate-resolution.test.mjs
//
// HUMAN-GATE-CONSOLE service contract (docs/architecture/HUMAN-GATE-CONSOLE.md):
//   - listPendingHumanGateParks: only blocked/paused GATE_HUMAN_REQUIRED
//     parks, with the parsed gate decision key, per-check outcomes, and the
//     runnability subject binding from the unknown receipt;
//   - resolveHumanGate: append-only resolution row + canonical
//     repair-requeued resume in one transaction; reject requires feedback;
//     double-resolve is a typed no-go (the park is gone);
//   - the console's own surface: the park list disappears after resolve;
//   - consultHumanGateResolution bytes guard (the provider-side authority).

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  ensureHumanGateResolutionSchema,
  listPendingHumanGateParks,
  resolveHumanGate,
  consultHumanGateResolution,
} from '../../dist/app/human-gate-resolution.js';

const WORKPLACE = 'workplace/9/solution-development/development-readiness-certification/singleton';
const DECISION_KEY = 'decision:gate-run:' + '3'.repeat(64);
const RECEIPT_RUN = 'gate-run:' + '3'.repeat(64);
const SUBJECT_BINDING = `local-readiness-subject:${'a'.repeat(64)}:${'b'.repeat(40)}:${'c'.repeat(40)}`;

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      epic_id INTEGER
    );
  `);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('Elite 2');
  db.prepare('INSERT INTO factory_process_runs (id, project_id, epic_id) VALUES (9, 1, NULL)').run();
  // The park reason the workplace points at (GATE_HUMAN_REQUIRED).
  const parkId = db.prepare(
    `INSERT INTO factory_workplace_park_reasons (workplace_ref, reason_code, message, evidence_refs)
     VALUES (?, 'GATE_HUMAN_REQUIRED', ?, '[]')`,
  ).run(
    WORKPLACE,
    `Gate 'gate:9:final' returned human_required: check outcomes are indeterminate. `
      + `Resolve manually (decision ${DECISION_KEY}).`,
  ).lastInsertRowid;
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, active_recovery_case_ref)
     VALUES (?, 9, 'solution-development', 'development-readiness-certification', 'singleton',
        'blocked', 'paused', 'author', 7, ?)`,
  ).run(WORKPLACE, `workplace-park-reason:${parkId}`);
  // The human_required decision + its receipts (monotonicity passed,
  // runnability unknown with the bytes binding in evidence).
  const monoRef = `receipt:${RECEIPT_RUN}:0:development.readiness-profile-monotonicity.v1`;
  const runRef = `receipt:${RECEIPT_RUN}:1:factory.local-runnability.v1`;
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key, workplace_ref, gate_ref, gate_run_ref, gate_phase, transition_ref,
        subject_candidate_set_ref, assessment_candidate_set_refs, verdict, repair_target_role,
        check_plan_ref, check_plan_digest, decision_policy_ref, decision_policy_digest,
        check_receipt_refs, installation_digest, decision_digest, decided_at)
     VALUES (?, ?, 'gate:9:final', ?, 'final', 't', 'cs', '[]', 'human_required', NULL,
        'plan', 'd', 'policy', 'd', ?, 'i', '${'0'.repeat(64)}', datetime('now'))`,
  ).run(DECISION_KEY, WORKPLACE, RECEIPT_RUN, JSON.stringify([monoRef, runRef]));
  const ins = db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
        assessment_candidate_set_refs, provider_id, provider_version, provider_digest,
        environment_ref, outcome, evidence_refs, receipt_digest)
     VALUES (?, ?, 'cs', '[]', ?, '1', 'd', NULL, ?, ?, 'rd')`,
  );
  ins.run(monoRef, RECEIPT_RUN, 'development.readiness-profile-monotonicity.v1', 'passed', '[]');
  ins.run(runRef, RECEIPT_RUN, 'factory.local-runnability.v1', 'unknown',
    JSON.stringify([SUBJECT_BINDING]));
  ensureHumanGateResolutionSchema(db);
  return db;
}

test('list: only GATE_HUMAN_REQUIRED parks surface, with decision context', () => {
  const db = buildDb();
  // A non-gate park (budget) and a non-paused workplace must NOT surface.
  const otherPark = db.prepare(
    `INSERT INTO factory_workplace_park_reasons (workplace_ref, reason_code, message)
     VALUES ('workplace/9/x/y/z', 'RECOVERY_BUDGET_EXHAUSTED', 'budget')`,
  ).lastInsertRowid;
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, active_recovery_case_ref)
     VALUES ('workplace/9/x/y/z', 9, 'm', 'c', 'w', 'blocked', 'paused', 'author', 1, ?)`,
  ).run(`workplace-park-reason:${otherPark}`);
  const gates = listPendingHumanGateParks(db);
  assert.equal(gates.length, 1);
  const gate = gates[0];
  assert.equal(gate.workplaceRef, WORKPLACE);
  assert.equal(gate.projectName, 'Elite 2');
  assert.equal(gate.gateDecisionKey, DECISION_KEY);
  assert.deepEqual(gate.checks.map(c => `${c.providerId.split('.').pop()}:${c.outcome}`), [
    'v1:passed', // monotonicity (provider id tail is its schema-ish name)
    'v1:unknown',
  ]);
  assert.equal(gate.subjectBinding, SUBJECT_BINDING);
});

test('resolve ACCEPT: append-only row + canonical repair-requeued resume', () => {
  const db = buildDb();
  const result = resolveHumanGate(db, {
    workplaceRef: WORKPLACE, decision: 'accept', actorId: 'op',
  });
  assert.ok(result.resolutionId >= 1);
  const row = db.prepare(
    'SELECT * FROM factory_human_gate_resolutions WHERE id=?',
  ).get(result.resolutionId);
  assert.equal(row.resolution, 'accept');
  assert.equal(row.gate_decision_key, DECISION_KEY);
  assert.equal(row.subject_binding, SUBJECT_BINDING);
  assert.equal(row.actor_id, 'op');
  const w = db.prepare(
    'SELECT kanban_phase, loop_state, next_role, revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(WORKPLACE);
  assert.deepEqual(
    [w.kanban_phase, w.loop_state, w.next_role, w.revision],
    ['in_progress', 'queued', 'author', 8],
    'paused → queued via repair-requeued, revision+1',
  );
  assert.ok(db.prepare(
    `SELECT COUNT(*) AS n FROM activity_log WHERE action='human-gate-resolved'`,
  ).get().n >= 1);
  // The console no longer lists it.
  assert.equal(listPendingHumanGateParks(db).length, 0);
});

test('resolve REJECT requires feedback; with feedback it records verbatim', () => {
  const db = buildDb();
  assert.throws(
    () => resolveHumanGate(db, { workplaceRef: WORKPLACE, decision: 'reject', actorId: 'op' }),
    /HUMAN_GATE_FEEDBACK_REQUIRED/,
  );
  resolveHumanGate(db, {
    workplaceRef: WORKPLACE, decision: 'reject',
    feedback: '  карта без зума бесполезна  ', actorId: 'op',
  });
  const row = db.prepare(
    'SELECT resolution, feedback FROM factory_human_gate_resolutions ORDER BY id DESC LIMIT 1',
  ).get();
  assert.equal(row.resolution, 'reject');
  assert.equal(row.feedback, 'карта без зума бесполезна');
});

test('resolve is one-shot: the answered park is gone (typed no-go)', () => {
  const db = buildDb();
  resolveHumanGate(db, { workplaceRef: WORKPLACE, decision: 'accept', actorId: 'op' });
  assert.throws(
    () => resolveHumanGate(db, { workplaceRef: WORKPLACE, decision: 'accept', actorId: 'op' }),
    /HUMAN_GATE_PARK_NOT_FOUND/,
  );
  // And the append-only fence rejects edits.
  assert.throws(
    () => db.prepare('UPDATE factory_human_gate_resolutions SET resolution=? WHERE id=1').run('reject'),
    /append-only/,
  );
});

test('consult: latest row wins, bytes guard blocks other-bytes conversions', () => {
  const db = buildDb();
  assert.equal(
    consultHumanGateResolution(db, WORKPLACE, 'factory.local-runnability.v1', SUBJECT_BINDING),
    null,
    'no row yet → no conversion (1.15 behavior)',
  );
  resolveHumanGate(db, { workplaceRef: WORKPLACE, decision: 'accept', actorId: 'op' });
  assert.equal(
    consultHumanGateResolution(db, WORKPLACE, 'factory.local-runnability.v1', 'other-binding'),
    null,
    'bytes mismatch → no conversion',
  );
  const hit = consultHumanGateResolution(
    db, WORKPLACE, 'factory.local-runnability.v1', SUBJECT_BINDING);
  assert.equal(hit.resolution, 'accept');
  assert.equal(hit.actorId, 'op');
});
