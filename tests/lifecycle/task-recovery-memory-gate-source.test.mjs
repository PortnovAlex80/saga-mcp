// tests/lifecycle/task-recovery-memory-gate-source.test.mjs
//
// STAGE-23 (2026-08-24) — the third durable source of the episodic task
// memory: production-cell GATE rejections.
//
// The five-agent feedback-loop investigation (operator-directed) proved the
// Development workshop's author/final gate rejections never entered the
// task-recovery-memory bridge: its two sources (RECOVERY:-comments,
// worker_done preflight rejections) never fire on the development path
// (preflight mode:'none'; nobody writes RECOVERY: comments). Workers saw only
// the LATEST rejection sheet (recovery-feedback.json — a channel that is
// cleared whenever the decision head moves on) and no accumulated trajectory:
// no attempt ordinal, no previous failures. History-dependent gate rules —
// the IMPLEMENTATION_CLAIM_NARROWED monotonicity check names the file surface
// "claimed by a prior submission" — were impossible to satisfy from memory:
// 19 attempts, 5 recovery epochs, one terminal-failed workplace.
//
// This suite pins the fix: repair_required gate decisions for the task's
// workplace+role become attempt_history entries with the decoded finding
// text, the claim-time materializer writes them (attempt_count>0 → the
// episodic prompt block fires, currentFeedback>0), and the scoping is exact
// (role-matched, workplace-matched, fail-soft on missing tables).

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  TASK_RECOVERY_MEMORY_SCHEMA,
  buildTaskRecoveryMemory,
  materializeTaskRecoveryMemory,
} from '../../dist/lifecycle/task-recovery-memory.js';
import { SCHEMA_SQL } from '../../dist/schema.js';

const WP = 'workplace/9/solution-development@1.4.4/development-implementation/testkey';
const FINDING = 'development.implementation-claim-monotonicity.v1:IMPLEMENTATION_CLAIM_NARROWED::The claimed file surface NARROWED: [tests/combat/combat.test.js] was claimed by a prior submission';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.pragma('foreign_keys=OFF');
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  return db;
}

function seedTask(db, { id = 21, role = 'author', workplaceRef = WP } = {}) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, workplace_ref, execution_mode, metadata)
     VALUES (?, 1, 'card', 'todo', ?, 'git_change', ?)`,
  ).run(id, workplaceRef, JSON.stringify({
    role,
    workplace_ref: workplaceRef,
    process_run_id: 9,
  }));
}

function seedGateDecision(
  db,
  { key, role = 'author', verdict = 'repair_required', at = '2026-08-24 10:00:00', findings = [FINDING], workplaceRef = WP },
) {
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key, workplace_ref, gate_ref, gate_run_ref, gate_phase, transition_ref,
        subject_candidate_set_ref, assessment_candidate_set_refs, verdict, repair_target_role,
        check_plan_ref, check_plan_digest, decision_policy_ref, decision_policy_digest,
        check_receipt_refs, installation_digest, accepted_output_bindings, decision_digest, decided_at)
     VALUES (?,?,'gate:4:author',?,'author',?,
             ?,'[]',?,?,'plan','h','policy','h','[]','h','[]',?,?)`,
  ).run(key, workplaceRef, `gate-run:${key}`, `transition:${key}`, `cs:${key}`,
    verdict, role, `digest:${key}`, at);
  if (findings !== null) {
    db.prepare(
      `INSERT INTO factory_gate_finding_set_chain
         (workplace_ref, gate_ref, repair_target_role, check_plan_digest, gate_decision_key,
          finding_set_digest, finding_count, fatal_finding_count, finding_keys, fatal_finding_keys, created_at)
       VALUES (?,'gate:4:author',?,'h',?,'h',?,?,?,'[]',?)`,
    ).run(workplaceRef, role, key, findings.length, 0, JSON.stringify(findings), at);
  }
}

test('gate rejections become episodic memory with decoded finding text', () => {
  const db = makeDb();
  seedTask(db);
  seedGateDecision(db, { key: 'decision:gate-run:a', at: '2026-08-24 10:00:00' });
  seedGateDecision(db, { key: 'decision:gate-run:b', at: '2026-08-24 11:00:00', findings: ['scope.v1:PATH_OUTSIDE::Git paths [src/shared/utils.js] are outside frozen changeScopes'] });
  try {
    const snapshot = buildTaskRecoveryMemory(db, 21);
    assert.equal(snapshot.schema, TASK_RECOVERY_MEMORY_SCHEMA);
    assert.equal(snapshot.attempt_count, 2, 'both gate rejections count as attempts');
    assert.equal(snapshot.attempt_history[0].kind, 'gate_rejection');
    assert.equal(snapshot.attempt_history[0].source_ref, 'gate-decision:decision:gate-run:a');
    assert.match(snapshot.attempt_history[0].recovery_summary, /The claimed file surface NARROWED/,
      'the summary carries the human-readable finding text (after the last ::)');
    assert.match(snapshot.attempt_history[1].recovery_summary, /outside frozen changeScopes/);
    assert.ok(snapshot.previous_failures.length === 2);
  } finally {
    db.close();
  }
});

test('role and workplace scoping is exact — no reviewer noise, no cross-workplace leaks', () => {
  const db = makeDb();
  seedTask(db, { id: 21, role: 'author' });
  seedTask(db, { id: 22, role: 'reviewer' });
  seedGateDecision(db, { key: 'decision:author-1', role: 'author' });
  seedGateDecision(db, { key: 'decision:reviewer-1', role: 'reviewer', verdict: 'repair_required' });
  seedGateDecision(db, { key: 'decision:other-wp', workplaceRef: 'workplace/9/.../other' });
  try {
    const author = buildTaskRecoveryMemory(db, 21);
    assert.equal(author.attempt_count, 1, 'only the author-role decision reaches the author card');
    assert.equal(author.attempt_history[0].source_ref, 'gate-decision:decision:author-1');
    const reviewer = buildTaskRecoveryMemory(db, 22);
    assert.equal(reviewer.attempt_count, 1);
    assert.equal(reviewer.attempt_history[0].source_ref, 'gate-decision:decision:reviewer-1');
  } finally {
    db.close();
  }
});

test('claim-time materialization writes the memory keys and the machine hint', () => {
  const db = makeDb();
  seedTask(db);
  seedGateDecision(db, { key: 'decision:gate-run:a' });
  try {
    const result = materializeTaskRecoveryMemory(db, 21);
    assert.equal(result.changed, true);
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=21').get().metadata);
    assert.equal(metadata.recovery_memory_schema, TASK_RECOVERY_MEMORY_SCHEMA);
    assert.equal(metadata.attempt_count, 1);
    assert.equal(metadata.previous_failures.length, 1);
    assert.match(metadata.previous_failures[0], /NARROWED/);
    assert.match(metadata.hint, /\[task-recovery-memory\].*1 previous attempt/,
      'the episodic prompt block fires now — currentFeedback will be > 0');
    // Idempotent: re-materialization is stable.
    assert.equal(materializeTaskRecoveryMemory(db, 21).changed, false);
  } finally {
    db.close();
  }
});

test('gate entries interleave with RECOVERY comments in durable time order', () => {
  const db = makeDb();
  seedTask(db);
  seedGateDecision(db, { key: 'decision:late', at: '2026-08-24 12:00:00' });
  db.prepare(
    `INSERT INTO comments (task_id, author, content, created_at)
     VALUES (21, 'w', 'RECOVERY: verifier reflection after round one', '2026-08-24 09:00:00')`,
  ).run();
  try {
    const snapshot = buildTaskRecoveryMemory(db, 21);
    assert.equal(snapshot.attempt_count, 2);
    assert.equal(snapshot.attempt_history[0].kind, 'recovery_note');
    assert.equal(snapshot.attempt_history[1].kind, 'gate_rejection');
  } finally {
    db.close();
  }
});

test('fail-soft: a database without the gate tables degrades to the other sources', () => {
  const db = makeDb();
  seedTask(db);
  db.exec('DROP TABLE factory_gate_finding_set_chain');
  db.exec('DROP TABLE factory_gate_decisions');
  try {
    const snapshot = buildTaskRecoveryMemory(db, 21);
    assert.equal(snapshot.attempt_count, 0, 'no gate tables → no entries, no throw');
  } finally {
    db.close();
  }
});
