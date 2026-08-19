// tests/restore-from-checkpoint-reset-hygiene.test.mjs
//
// PREVENTIVE-HUNT Layer 2 + Layer 5 repair — R-D4 + S-3 + S-4/S-5 + S-6:
// the operator stage-reset tool must be hygienic on REAL factory DB shapes.
//
//   R-D4 — resetStage deletes the sealed material a replay capsule certifies
//   but never touches factory_replay_capsules: the next claim in the reset
//   workplace REPLAYS the exact production the operator reset the stage to
//   regenerate. The reset must mark the affected capsules INVALID
//   (append-only evidence, typed reason 'stage-reset') — capsule rows are
//   evidence and are never deleted.
//
//   S-3 — the reset's DELETE scope missed the FK children of the tables it
//   deletes (gate decision heads — the "current repair authority", gate
//   presentation attempts, effect attempts, final presentation commitments,
//   execution completion products, worker stops). With FK enforcement on,
//   the reset ABORTS on real factory DBs; with it off it orphans them. The
//   reset must delete children in dependency order and prove
//   `PRAGMA foreign_key_check` clean.
//
//   S-4/S-5 — the immutability-trigger drop list was wrong (stale
//   trg_factory_adoptions_no_delete; missing the *_immutable_delete triggers
//   of the tables actually deleted), so its "defended" paths ABORT.
//
//   S-6 — the reset drops CandidateSets (the attempt counter) but recovery
//   epoch baselines survive with HIGHER counters → attempts-in-epoch
//   (counter − baseline) goes negative → ADR-075 budget math misfires. The
//   epochs table is append-only (no UPDATE/DELETE triggers); re-baselining
//   must APPEND a new epoch row snapshotting the CURRENT post-reset
//   counters — the same write path recordRecoveryEpoch uses.
//
// Seeds a real-shape factory DB (the FK children + immutability triggers +
// epoch baselines + a replay capsule for the reset stage AND for a preserved
// stage) and drives the REAL resetStageRun seam.

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
import { ensureReplayCapsuleSchema } from '../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { resetStageRun } from '../scripts/restore-from-checkpoint.mjs';

const DEV_WP = 'workplace/10/solution-development@1.0.0/dev-cell/singleton';
const FORM_WP = 'workplace/20/solution-formalization@1.0.0/form-cell/singleton';

function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-reset-hygiene-'));
  const dbPath = path.join(root, 'factory.sqlite');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryNodeRunSchema(db);
  ensureFactoryLifecycleRunSchema(db);
  ensureManagedNodeSubmissionSchema(db);
  ensureReplayCapsuleSchema(db);

  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (1,'r')").run();
  db.prepare(
    "INSERT INTO project_repositories (id,project_id,repository_id,local_path) VALUES (1,1,1,?)",
  ).run(path.join(root, 'repo'));
  db.prepare(
    `INSERT INTO artifacts (id,project_id,epic_id,type,title,path,content_hash,storage_kind)
     VALUES (500,1,1,'PRD','PRD','docs/prd.md','hash-prd','db_native')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
      (id,project_id,epic_id,lifecycle_name,lifecycle_version,lifecycle_ref_key,
       display_name,description,definition_snapshot,definition_hash,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,
       entry_stage_id,current_stage_id)
     VALUES (1,1,1,'product-build','1.0','product-build@1.0',
       'Product Build','desc','{}','dh','tester','idem-lc','in','{}','h','failed',
       'solution-development','solution-development')`,
  ).run();

  // ── Development stage (the reset target) ────────────────────────────────
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
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,10,'solution-development@1.0.0','dev-cell','singleton',
       'in_progress','repair_wait','author',5,NULL)`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,workflow_stage,current_execution_id,metadata)
     VALUES (100,1,'dev work','in_progress','development','dev-exec-1',?)`,
  ).run(JSON.stringify({ process_run_id: 10, workplace_ref: DEV_WP }));
  // exec-1: PINNED by a managed submission (kept as audit, non-terminal).
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('dev-exec-1','run-1',1,1,100,'worker-1','machine-1','exited','executing')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
      (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
       schema_version,payload_snapshot,content_hash)
     VALUES (10,'solution-development@1.0.0','implement-work-items',901,100,
       'dev-exec-1','dev.product.v1','{}','dev-content-hash')`,
  ).run();
  // exec-2: UNPINNED and terminal (deleted by the reset — the orphan risk).
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('dev-exec-2','run-2',1,1,100,'worker-2','machine-2','terminated','executing')`,
  ).run();
  // FK children of the unpinned execution (audit rows the reset must clear
  // in dependency order — commitments/completion products are immutable).
  db.prepare(
    `INSERT INTO factory_work_intents
      (id,epic_id,kind,objective,authority_scope,output_schema,status)
     VALUES (800,1,'development.author','work','{}','dev.product.v1','executing')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_final_presentation_commitments
      (commitment_ref,workplace_ref,work_intent_id,task_id,execution_id,role,
       product_schema,product_ref,product_digest,contract_digest)
     VALUES ('fpc-dev-1',?,800,100,'dev-exec-2','author','dev.product.v1','product:dev-2','pd','cd')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_execution_completion_products
      (execution_id,work_intent_id,workplace_ref,schema_id,product_ref,product_digest,worker_done_command_id)
     VALUES ('dev-exec-2',800,?,'dev.product.v1','product:dev-2','pd','wdc-1')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_worker_stops
      (stop_ref,worker_execution_ref,workplace_ref,project_id,reason,phase)
     VALUES ('stop-dev-1','dev-exec-2',?,1,'operator','reaped')`,
  ).run(DEV_WP);

  // Sealed material model (the attempt counter source).
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
      (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,
       material_digest,semantic_digest,sealed_at)
     VALUES ('rev-dev-1',?, '[{}]','["dev-exec-1"]','dev-exec-1','md','sd','2026-01-01')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES ('cset-dev-author-1',?,'rev-dev-1','author','csd','seal:dev-exec-1:author','2026-01-01')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
     VALUES ('cset-dev-author-1',0,'dev.product.v1','product:dev-1','pd','produced')`,
  ).run();

  // Gate run + presentation attempt (FK child of the gate run) + accepted
  // decision + decision HEAD (the "current repair authority" pointer).
  db.prepare(
    `INSERT INTO factory_gate_runs
      (gate_run_ref,workplace_ref,gate_phase,subject_candidate_set_ref,
       assessment_candidate_set_refs,check_plan_ref,check_plan_digest,
       expected_workplace_revision,gate_lease_ref,state)
     VALUES ('gr-dev-1',?,'author','cset-dev-author-1','[]','cp','cpd',4,'lease-dev','terminal')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_gate_presentation_attempts
      (gate_run_ref,presentation_ref)
     VALUES ('gr-dev-1','dev-exec-1')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_gate_decisions
      (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
       subject_candidate_set_ref,verdict,check_plan_ref,check_plan_digest,
       decision_policy_ref,decision_policy_digest,installation_digest,decision_digest)
     VALUES ('gd-dev-1',?,'gate-1','gr-dev-1','author','tr-dev-1','cset-dev-author-1',
       'repair_required','cp','cpd','dp','dpd','id','dd')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_workplace_gate_decision_heads
      (workplace_ref,decision_key,expected_workplace_revision)
     VALUES (?,'gd-dev-1',5)`,
  ).run(DEV_WP);

  // Immutable acceptances referencing cset + decision (FK/trigger blockers).
  db.prepare(
    `INSERT INTO factory_cell_final_acceptances
      (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
       acceptance_digest,accepted_at)
     VALUES ('fa-dev-1',?,'cset-dev-author-1','gd-dev-1','ad','2026-01-02')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
      (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,gate_decision_key,
       provider_receipt_ref,provider_receipt_digest,receipt_digest)
     VALUES ('er-dev-1',?,'some-effect','cset-dev-author-1','gd-dev-1','prr','prd','rd')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_cell_effect_repair_issues
      (effect_repair_ref,workplace_ref,effect_id,effect_version,effect_digest,candidate_set_ref,
       production_revision_ref,gate_decision_key,gate_decision_digest,
       acceptance_digest,expected_workplace_revision,resulting_workplace_revision,
       issue_snapshot,issue_digest,receipt_digest)
     VALUES ('repair-dev-1',?,'some-effect','1.0.0','ed','cset-dev-author-1','rev-dev-1',
       'gd-dev-1','dd','ad',4,5,'{}','rid','rrd')`,
  ).run(DEV_WP);
  // Effect attempt — FK child of the candidate set, immutable (trigger).
  db.prepare(
    `INSERT INTO factory_effect_attempts
      (attempt_ref,workplace_ref,effect_id,effect_version,effect_digest,candidate_set_ref,
       gate_decision_key,idempotency_key,attempt_no,outcome)
     VALUES ('ea-dev-1',?,'some-effect','1.0.0','ed','cset-dev-author-1',
       'gd-dev-1','idem-ea-1',1,'repair_required')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
      (workplace_ref,accepted_author_candidate_set_ref,accepted_author_gate_decision_key,
       revision,recorded_at)
     VALUES (?,'cset-dev-author-1','gd-dev-1',5,'2026-01-02')`,
  ).run(DEV_WP);
  db.prepare(
    `INSERT INTO factory_node_runs (process_run_id,node_id,node_kind,attempt,status,event)
     VALUES (10,'implement-work-items','production-cell',1,'completed','runtime.paused')`,
  ).run();

  // Recovery-epoch baselines ABOVE the post-reset counters (the S-6 trap:
  // reset drops the counter to 0, these rows say "2 already spent").
  db.prepare(
    `INSERT INTO factory_workplace_recovery_epochs
      (workplace_ref,role,epoch,baseline_rejected_sets,baseline_terminal_executions,
       baseline_effect_repairs,exhausted_attempts,max_attempts,total_attempts_cap,last_diagnosis)
     VALUES (?,'author',1,2,1,1,3,3,30,'diagnosis-old'),
            (?,'reviewer',1,1,0,0,1,3,30,'diagnosis-old')`,
  ).run(DEV_WP, DEV_WP);

  // Replay capsules: one bound to the reset stage's sealed material, one
  // bound to the PRESERVED stage (must NOT be invalidated).
  db.prepare(
    `INSERT INTO factory_replay_capsules
      (capsule_ref,replay_key,project_id,source_execution_ref,
       source_candidate_set_ref,payload_hash,payload_snapshot)
     VALUES ('cap-dev-1','rk-dev',1,'dev-exec-1','cset-dev-author-1','ph-dev','{}')`,
  ).run();

  // ── Formalization stage (MUST be preserved, incl. its capsule) ──────────
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
  ).run(FORM_WP);
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
      (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,
       material_digest,semantic_digest,sealed_at)
     VALUES ('rev-form-1',?,'[{}]','["form-exec"]','form-exec','md','sd','2026-01-01')`,
  ).run(FORM_WP);
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES ('cset-form-author-1',?,'rev-form-1','author','csd','seal:form:author','2026-01-01')`,
  ).run(FORM_WP);
  db.prepare(
    `INSERT INTO factory_replay_capsules
      (capsule_ref,replay_key,project_id,source_execution_ref,
       source_candidate_set_ref,payload_hash,payload_snapshot)
     VALUES ('cap-form-1','rk-form',1,'form-exec','cset-form-author-1','ph-form','{}')`,
  ).run();

  db.close();
  return { root, dbPath };
}

const fkViolations = (db) => db.prepare('PRAGMA foreign_key_check').all();

test('R-D4: resetStageRun invalidates the reset stage\'s capsules (append-only evidence, rows kept)', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  db.pragma('foreign_keys = ON');
  try {
    resetStageRun(db, 'solution-development');

    // The reset stage's capsule got typed invalidation evidence.
    const devInvalidations = db.prepare(
      `SELECT reason FROM factory_replay_capsule_invalidations WHERE capsule_ref='cap-dev-1'`,
    ).all();
    assert.equal(devInvalidations.length, 1,
      'R-D4: the capsule bound to the reset stage\'s sealed material must carry invalidation evidence');
    assert.equal(devInvalidations[0].reason, 'stage-reset');

    // Evidence, not deletion: the capsule row itself survives.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM factory_replay_capsules WHERE capsule_ref='cap-dev-1'").get().n,
      1,
      'R-D4: capsule rows are evidence — invalidation appends, never deletes',
    );

    // Stage isolation: the preserved stage's capsule stays eligible.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM factory_replay_capsule_invalidations WHERE capsule_ref='cap-form-1'").get().n,
      0,
      'R-D4: capsules of preserved stages must NOT be invalidated',
    );

    // Idempotent: a second reset does not duplicate the evidence row.
    resetStageRun(db, 'solution-development');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM factory_replay_capsule_invalidations WHERE capsule_ref='cap-dev-1'").get().n,
      1,
    );
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('S-3: resetStageRun leaves NO FK orphans and completes on real DB shapes (children in dependency order)', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  db.pragma('foreign_keys = ON');
  try {
    // The whole point: on the pre-fix script this throws (FK RESTRICT /
    // immutability trigger ABORT) because the FK children and the real
    // trigger names were out of scope.
    resetStageRun(db, 'solution-development');

    const violations = fkViolations(db);
    assert.deepEqual(violations, [],
      `S-3: foreign_key_check must be clean after reset — got ${JSON.stringify(violations)}`);

    // The FK children of the deleted rows are gone (not orphaned).
    for (const [table, sql] of [
      ['factory_workplace_gate_decision_heads', `SELECT COUNT(*) n FROM factory_workplace_gate_decision_heads WHERE workplace_ref='${DEV_WP}'`],
      ['factory_gate_presentation_attempts', "SELECT COUNT(*) n FROM factory_gate_presentation_attempts WHERE gate_run_ref='gr-dev-1'"],
      ['factory_effect_attempts', `SELECT COUNT(*) n FROM factory_effect_attempts WHERE workplace_ref='${DEV_WP}'`],
      ['factory_final_presentation_commitments', "SELECT COUNT(*) n FROM factory_final_presentation_commitments WHERE execution_id='dev-exec-2'"],
      ['factory_execution_completion_products', "SELECT COUNT(*) n FROM factory_execution_completion_products WHERE execution_id='dev-exec-2'"],
      ['factory_worker_stops', "SELECT COUNT(*) n FROM factory_worker_stops WHERE worker_execution_ref='dev-exec-2'"],
    ]) {
      assert.equal(db.prepare(sql).get().n, 0, `S-3: ${table} rows for reset-scope parents must be deleted, not orphaned`);
    }
    // The pinned execution and its audit children survive.
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM worker_executions WHERE execution_id='dev-exec-1'").get().n,
      1, 'pinned execution kept as audit',
    );
    // Immutability triggers restored.
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_factory_effect_attempts_no_delete'").get(),
      'S-4/S-5: effect-attempt immutability trigger recreated after reset',
    );
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('S-6: resetStageRun re-baselines recovery epochs so attempts-in-epoch cannot go negative', () => {
  const f = buildFixture();
  const db = new Database(f.dbPath);
  db.pragma('foreign_keys = ON');
  try {
    resetStageRun(db, 'solution-development');

    // A NEW append-only epoch row per (workplace, role) whose stale baseline
    // exceeded the post-reset counters.
    const author = db.prepare(
      `SELECT epoch,baseline_rejected_sets,baseline_terminal_executions,baseline_effect_repairs
         FROM factory_workplace_recovery_epochs
        WHERE workplace_ref=? AND role='author' ORDER BY epoch DESC LIMIT 1`,
    ).get(DEV_WP);
    assert.equal(author.epoch, 2, 'S-6: the re-baseline is a NEW append-only epoch row');
    assert.equal(author.baseline_rejected_sets, 0,
      'S-6: baseline snapshots the post-reset counter (csets/decisions were deleted)');
    assert.equal(author.baseline_terminal_executions, 0,
      'S-6: post-reset terminal executions for the workplace task are 0 (the terminal exec was deleted)');
    assert.equal(author.baseline_effect_repairs, 0);

    const reviewer = db.prepare(
      `SELECT epoch,baseline_rejected_sets FROM factory_workplace_recovery_epochs
        WHERE workplace_ref=? AND role='reviewer' ORDER BY epoch DESC LIMIT 1`,
    ).get(DEV_WP);
    assert.equal(reviewer.epoch, 2, 'each affected (workplace, role) gets its own re-baseline row');
    assert.equal(reviewer.baseline_rejected_sets, 0);

    // The pre-existing epoch rows remain as audit (append-only semantics).
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?`).get(DEV_WP).n,
      4,
      'S-6: original epoch rows survive as immutable audit',
    );

    // Idempotent: a second reset does not append another re-baseline when
    // the latest baseline already equals the current counters.
    resetStageRun(db, 'solution-development');
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?`).get(DEV_WP).n,
      4,
      'S-6: re-baselining is idempotent — no epoch-row spam on repeated resets',
    );
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
