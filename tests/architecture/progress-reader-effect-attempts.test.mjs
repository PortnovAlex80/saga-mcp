/**
 * Regression: the §23 progress reader must survive real factory_effect_attempts
 * rows. The reader's "latest idempotency key" lookup was born broken
 * (adbed860, 2026-08-18) with `ORDER BY id DESC` — factory_effect_attempts has
 * no `id` column (PK attempt_ref) — so the statement failed at PREPARE time and
 * findStalledScopes threw `no such column: id` on EVERY classification sweep
 * the moment a run held a nonterminal workplace and the attempts table
 * existed. The invariant designed to NAME exactly this stall stayed silent
 * through the live Elite-9 deadlock of 2026-08-24 (impl-shared-core
 * terminal-failed, 7 dependents idle forever, 132 swallowed errors).
 *
 * This suite pins the live-incident shape: with effect-attempt history seeded
 * and an idle workplace depending on a terminal-FAILED workplace, the reader
 * must classify without throwing and report the unsatisfied dependency edge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = mkdtempSync(path.join(os.tmpdir(), 'saga-progress-reader-'));
const dbPath = path.join(root, 'factory.sqlite');

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const {
  classifyFactoryProgress,
  findStalledScopes,
} = await import('../../dist/application/progress/sqlite-progress-reader.js');

const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
// The reader only SELECTs; the seed spans a deep FK chain
// (attempts → candidate_sets → production_revisions → …) that is irrelevant
// to the regression, so seed without FK enforcement.
db.pragma('foreign_keys = OFF');

const IDLE_WP = 'workplace/5/solution-development@1.4.4/development-implementation/idle1';
const FAILED_WP = 'workplace/5/solution-development@1.4.4/development-implementation/shared';

const insertWorkplace = db.prepare(
  `INSERT INTO factory_workplaces
     (workplace_ref, process_run_id, module_ref, production_cell_id,
      work_key, kanban_phase, loop_state, next_role, revision)
   VALUES (?, 5, 'solution-development@1.4.4', 'development-implementation',
           ?, ?, ?, 'author', 0)`,
);
insertWorkplace.run(IDLE_WP, 'impl-galaxy-core', 'todo', 'idle');
insertWorkplace.run(FAILED_WP, 'impl-shared-core', 'failed', 'terminal');
db.prepare(
  `UPDATE factory_workplaces SET terminal_reason='failed' WHERE workplace_ref=?`,
).run(FAILED_WP);

db.prepare(
  `INSERT INTO factory_workplace_graphs
     (graph_ref, process_run_id, module_ref, production_cell_id,
      graph_digest, item_count, edge_count, sealed_at)
   VALUES ('graph:5', 5, 'solution-development@1.4.4', 'development-implementation',
           'digest', 2, 1, '2026-08-24T14:23:55Z')`,
).run();
db.prepare(
  `INSERT INTO factory_workplace_dependencies (graph_ref, workplace_ref, depends_on_workplace_ref)
   VALUES ('graph:5', ?, ?)`,
).run(IDLE_WP, FAILED_WP);

// Real effect-attempt history on the failed workplace: two acceptance
// subjects, the latest carrying three attempts (the narrowed-surface repair
// loop shape from the live incident).
db.prepare(
  `INSERT INTO factory_candidate_sets
     (candidate_set_ref, workplace_ref, production_revision_ref, role,
      candidate_set_digest, seal_receipt_ref, sealed_at)
   VALUES ('cs:shared', ?, 'rev:1', 'author', 'digest', 'seal:1',
           '2026-08-24T15:40:18Z')`,
).run(FAILED_WP);
const insertAttempt = db.prepare(
  `INSERT INTO factory_effect_attempts
     (attempt_ref, workplace_ref, effect_id, effect_version, effect_digest,
      candidate_set_ref, gate_decision_key, idempotency_key, attempt_no, outcome, reason)
   VALUES (?, ?, 'git-integration', 1, 'd', 'cs:shared', 'gd', ?, ?, ?, ?)`,
);
insertAttempt.run('a1', FAILED_WP, 'key-alpha', 1, 'repair_required', 'surface narrowed');
insertAttempt.run('a2', FAILED_WP, 'key-alpha', 2, 'repair_required', 'surface narrowed');
insertAttempt.run('a3', FAILED_WP, 'key-beta', 1, 'repair_required', 'integration conflict');
insertAttempt.run('a4', FAILED_WP, 'key-beta', 2, 'repair_required', 'integration conflict');
insertAttempt.run('a5', FAILED_WP, 'key-beta', 3, 'repair_required', 'integration conflict');

test('the live-incident shape classifies without throwing (no phantom id column)', () => {
  // The engine calls findStalledScopes inside sweepProgressInvariant; the old
  // reader threw at prepare time before any row was even read.
  assert.doesNotThrow(() => findStalledScopes(db));

  const explanations = classifyFactoryProgress(db);
  const idle = explanations.find(e => e.scopeRef === IDLE_WP);
  assert.ok(idle, `idle workplace must be classified; got ${explanations.map(e => e.scopeRef).join(', ')}`);
  assert.equal(idle.classification, 'typed_wait');
  assert.match(idle.reason, /1 dependency edge/, 'the failed dependency must be named');
});

test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
