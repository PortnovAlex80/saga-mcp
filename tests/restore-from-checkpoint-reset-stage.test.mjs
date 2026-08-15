import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryNodeRunSchema } from '../dist/process-modules/persistence/sqlite-node-run-repository.js';
import { ensureFactoryLifecycleRunSchema } from '../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { ensureManagedNodeSubmissionSchema } from '../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { resetStageRun } from '../scripts/restore-from-checkpoint.mjs';

// Abstract fixture — zero language content, two stages. The Development stage is
// seeded with a sealed author CandidateSet + immutable acceptances/gate decision
// (the real attempt counter + the FK/trigger blockers). The Formalization stage
// is seeded as accepted and must survive the reset untouched.
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-reset-stage-'));
  const dbPath = path.join(root, 'factory.sqlite');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryNodeRunSchema(db);
  ensureFactoryLifecycleRunSchema(db);
  ensureManagedNodeSubmissionSchema(db);

  // Core entities.
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (1,'r')").run();
  db.prepare(
    "INSERT INTO project_repositories (id,project_id,repository_id,local_path) VALUES (1,1,1,?)",
  ).run(path.join(root, 'repo'));

  // A preserved artifact (Formalization product) — must NOT be touched.
  db.prepare(
    `INSERT INTO artifacts (id,project_id,epic_id,type,title,path,content_hash,storage_kind)
     VALUES (500,1,1,'PRD','PRD','docs/prd.md','hash-prd','db_native')`,
  ).run();

  // Lifecycle run (status failed → reset path will clear it elsewhere; here we
  // only exercise resetStageRun directly).
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
      (id,project_id,epic_id,lifecycle_name,lifecycle_version,lifecycle_ref_key,
       display_name,description,definition_snapshot,definition_hash,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,
       entry_stage_id,current_stage_id)
     VALUES (1,1,1,'product-build','1.0','product-build@1.0',
       'Product Build','desc','{}','dh','tester',
       'idem-lc','in','{}','h','failed',
       'solution-development','solution-development')`,
  ).run();

  // ── Development stage (the reset target) ────────────────────────────────
  const devWp = 'workplace/10/solution-development@1.0.0/dev-cell/singleton';
  db.prepare(
    `INSERT INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,
       idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,
       status,package_digest)
     VALUES (10,1,1,'solution-development','1.0.0','solution-development@1.0.0',
       'idem-dev','generic-flow','in','{}','ih','failed','pkg')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_stage_runs
      (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
       module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
       input_hash,status,process_run_id)
     VALUES (10,1,2,'solution-development',1,'solution-development','1.0.0',
       'solution-development@1.0.0','{}','bh','in','{}','ih','failed',10)`,
  ).run();
  // Workplace stuck in repair_wait with revision>0 (the stuck state to reset).
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,10,'solution-development@1.0.0','dev-cell','singleton',
       'in_progress','repair_wait','author',5,NULL)`,
  ).run(devWp);
  // A development task linked to the workplace (via metadata) + an execution.
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,workflow_stage,current_execution_id,metadata)
     VALUES (100,1,'dev work','in_progress','development','dev-exec-1',?)`,
  ).run(JSON.stringify({ process_run_id: 10, workplace_ref: devWp }));
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('dev-exec-1','run-1',1,1,100,'worker-1','machine-1','exited','executing')`,
  ).run();
  // Immutable managed submission pinning the execution (must keep both as audit).
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
      (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
       schema_version,payload_snapshot,content_hash)
     VALUES (10,'solution-development@1.0.0','implement-work-items',901,100,
       'dev-exec-1','dev.product.v1','{}','dev-content-hash')`,
  ).run();
  // Sealed material model: revision → author CandidateSet (+member). THIS is the
  // attempt counter source.
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
      (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,
       material_digest,semantic_digest,sealed_at)
     VALUES ('rev-dev-1',?, '[{}]','["dev-exec-1"]','dev-exec-1','md','sd','2026-01-01')`,
  ).run(devWp);
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES ('cset-dev-author-1',?,'rev-dev-1','author','csd','seal:dev-exec-1:author','2026-01-01')`,
  ).run(devWp);
  db.prepare(
    `INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
     VALUES ('cset-dev-author-1',0,'dev.product.v1','product:dev-1','pd','produced')`,
  ).run();
  // Gate decision (immutable, trigger blocks delete) referenced by acceptance +
  // effect receipt via gate_decision_key RESTRICT.
  db.prepare(
    `INSERT INTO factory_gate_decisions
      (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
       subject_candidate_set_ref,verdict,check_plan_ref,check_plan_digest,
       decision_policy_ref,decision_policy_digest,installation_digest,decision_digest)
     VALUES ('gd-dev-1',?,'gate-1','gr-dev-1','author','tr-dev-1','cset-dev-author-1',
       'repair_required','cp','cpd','dp','dpd','id','dd')`,
  ).run(devWp);
  // Final acceptance + effect receipt: both RESTRICT-reference cset + gate_decision.
  db.prepare(
    `INSERT INTO factory_cell_final_acceptances
      (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
       acceptance_digest,accepted_at)
     VALUES ('fa-dev-1',?,'cset-dev-author-1','gd-dev-1','ad','2026-01-02')`,
  ).run(devWp);
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
      (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,gate_decision_key,
       provider_receipt_ref,provider_receipt_digest,receipt_digest)
     VALUES ('er-dev-1',?,'some-effect','cset-dev-author-1','gd-dev-1','prr','prd','rd')`,
  ).run(devWp);
  // Accepted-authority head (current accepted-author pointer).
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
      (workplace_ref,accepted_author_candidate_set_ref,accepted_author_gate_decision_key,
       revision,recorded_at)
     VALUES (?,'cset-dev-author-1','gd-dev-1',5,'2026-01-02')`,
  ).run(devWp);
  // Node run for the dev process run (forces resume to restart from entry).
  db.prepare(
    `INSERT INTO factory_node_runs (process_run_id,node_id,node_kind,attempt,status,event)
     VALUES (10,'implement-work-items','production-cell',1,'completed','runtime.paused')`,
  ).run();

  // ── Formalization stage (MUST be preserved) ─────────────────────────────
  const formWp = 'workplace/20/solution-formalization@1.0.0/form-cell/singleton';
  db.prepare(
    `INSERT INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,
       idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,
       status,package_digest)
     VALUES (20,1,1,'solution-formalization','1.0.0','solution-formalization@1.0.0',
       'idem-form','generic-flow','in','{}','ih','completed','pkg')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,20,'solution-formalization@1.0.0','form-cell','singleton',
       'done','terminal','author',1,'accepted')`,
  ).run(formWp);
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
      (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,
       material_digest,semantic_digest,sealed_at)
     VALUES ('rev-form-1',?,'[{}]','["form-exec"]','form-exec','md','sd','2026-01-01')`,
  ).run(formWp);
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES ('cset-form-author-1',?,'rev-form-1','author','csd','seal:form:author','2026-01-01')`,
  ).run(formWp);

  db.close();
  return { root, dbPath, devWp, formWp };
}

const count = (db, sql) => db.prepare(sql).get().n;

test('resetStageRun resets the stage (counter 0, idle) and preserves other stages', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  db.pragma('foreign_keys = ON');
  try {
    const devWpCond = "workplace_ref='workplace/10/solution-development@1.0.0/dev-cell/singleton'";
    const formWpCond = "workplace_ref='workplace/20/solution-formalization@1.0.0/form-cell/singleton'";

    // Pre-conditions.
    assert.equal(count(db, `SELECT count(*) n FROM factory_candidate_sets WHERE ${devWpCond}`), 1);
    assert.equal(count(db, `SELECT count(*) n FROM factory_cell_final_acceptances WHERE ${devWpCond}`), 1);

    // The reset must not throw (FK-safe order + trigger drop/recreate).
    assert.doesNotThrow(() => resetStageRun(db, 'solution-development'));

    // ── Development stage: reset to fresh ───────────────────────────────
    // Counter = sealed CandidateSets for the dev workplace → 0.
    assert.equal(count(db, `SELECT count(*) n FROM factory_candidate_sets WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_candidate_set_members WHERE candidate_set_ref NOT IN (SELECT candidate_set_ref FROM factory_candidate_sets)`), 0, 'no orphan members');
    assert.equal(count(db, `SELECT count(*) n FROM factory_gate_decisions WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_cell_final_acceptances WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_cell_effect_receipts WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_accepted_authority_head WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_workplace_production_revisions WHERE ${devWpCond}`), 0);
    assert.equal(count(db, `SELECT count(*) n FROM factory_node_runs WHERE process_run_id=10`), 0, 'node runs cleared so the stage re-runs from entry');
    // Workplace is idle, fresh revision.
    const wp = db.prepare(`SELECT loop_state,kanban_phase,next_role,revision,terminal_reason FROM factory_workplaces WHERE ${devWpCond}`).get();
    assert.equal(wp.loop_state, 'idle');
    assert.equal(wp.kanban_phase, 'todo');
    assert.equal(wp.next_role, 'author');
    assert.equal(wp.revision, 0);
    assert.equal(wp.terminal_reason, null);
    // Task reset to todo.
    const task = db.prepare('SELECT status,current_execution_id,assigned_to FROM tasks WHERE id=100').get();
    assert.equal(task.status, 'todo');
    assert.equal(task.current_execution_id, null);
    // ProcessRun + StageRun back to paused.
    assert.equal(db.prepare('SELECT status FROM factory_process_runs WHERE id=10').get().status, 'paused');
    assert.equal(db.prepare('SELECT status FROM factory_stage_runs WHERE process_run_id=10').get().status, 'paused');

    // ── Audit preservation ──────────────────────────────────────────────
    // The execution had a managed submission → both KEPT as audit.
    assert.equal(count(db, "SELECT count(*) n FROM worker_executions WHERE execution_id='dev-exec-1'"), 1);
    assert.equal(count(db, 'SELECT count(*) n FROM factory_managed_node_submissions WHERE process_run_id=10'), 1);

    // ── Formalization stage: untouched ──────────────────────────────────
    assert.equal(count(db, `SELECT count(*) n FROM factory_candidate_sets WHERE ${formWpCond}`), 1);
    const formWp = db.prepare(`SELECT loop_state,terminal_reason FROM factory_workplaces WHERE ${formWpCond}`).get();
    assert.equal(formWp.loop_state, 'terminal');
    assert.equal(formWp.terminal_reason, 'accepted');
    assert.equal(db.prepare('SELECT status FROM factory_process_runs WHERE id=20').get().status, 'completed');
    assert.equal(count(db, 'SELECT count(*) n FROM artifacts'), 1, 'artifact preserved');

    // ── Immutability triggers are restored and still block DELETE ───────
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_factory_gate_decisions_no_delete'").get(), 'gate_decisions trigger recreated');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_factory_cell_final_acceptances_no_delete'").get(), 'final_acceptances trigger recreated');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_factory_managed_node_submissions_no_delete'").get(), 'managed_node_submissions trigger intact');
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('resetStageRun is idempotent (re-run does not throw, stage stays reset)', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  db.pragma('foreign_keys = ON');
  try {
    assert.doesNotThrow(() => resetStageRun(db, 'solution-development'));
    // Second run on the already-reset DB: no CandidateSets to delete, no error.
    assert.doesNotThrow(() => resetStageRun(db, 'solution-development'));
    const devWpCond = "workplace_ref='workplace/10/solution-development@1.0.0/dev-cell/singleton'";
    assert.equal(count(db, `SELECT count(*) n FROM factory_candidate_sets WHERE ${devWpCond}`), 0);
    assert.equal(db.prepare(`SELECT revision FROM factory_workplaces WHERE ${devWpCond}`).get().revision, 0);
    // Triggers still present after the second run.
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_factory_workplace_production_revisions_no_delete'").get());
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('resetStageRun throws a clear error for an unknown stage name', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  try {
    assert.throws(() => resetStageRun(db, 'no-such-stage'), /no factory_process_runs found/);
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
