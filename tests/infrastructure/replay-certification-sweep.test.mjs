// tests/infrastructure/replay-certification-sweep.test.mjs
//
// PREVENTIVE-HUNT Layer 2 repair — R-D2 + R-C6 + R-E1: the certification
// fallback sweep must be able to see its own failures.
//
//   R-D2 (fatal widening / inherited precondition): the sweep's workplace
//   selection was gated on JOIN factory_cell_final_acceptances — the exact
//   row the FAILED primary capture path never wrote. A workplace whose direct
//   post-terminal capture crashed was therefore invisible to the fallback
//   too: nothing ever certified, nothing ever alarmed.
//
//   R-C6 (silent drift absorption): a decision candidate-set ref with no
//   factory_candidate_sets row was a completely silent `continue` — not even
//   stderr. Post-reset / partial-crash states produce exactly these rows.
//
//   R-E1 (reason-blind counters): the sweep produced no counts, so "0
//   capsules needed" and "0 of 12 workplaces certified because every capture
//   failed" were indistinguishable in the journal.
//
// Proves, through the REAL seams (real resolveReplayKeyMaterial +
// computeReplayKey stamped into the execution envelope exactly like
// bindReplayToClaim, real SqliteGateRepository.recordGatePresentation, real
// SqliteReplayCapsuleRepository.captureAcceptedExecution, real completeness
// proof):
//
//   SW1 a terminal-accepted workplace WITHOUT a cfa row (the R-D2 crash
//       window) is CONSIDERED and CERTIFIED by the sweep;
//   SW2 the sweep returns + the caller can log a summary
//       {considered, certified, failed, skipped:{reason:count}};
//   SW3 a decision candidate-set ref with no candidate row is a COUNTED,
//       LOGGED skip (candidate-set-missing), never silent;
//   SW4 re-running the sweep is idempotent: already-certified material is a
//       counted skip, not a re-capture;
//   SW5 a workplace whose capture genuinely fails counts as failed (the
//       summary distinguishes it from "nothing to do").
//
// BEFORE the fix this suite is RED on SW1/SW2 (sweep returns undefined,
// certifies nothing — the cfa JOIN excludes the crash-window workplace) and
// on SW3/SW4/SW5 (no counters exist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { certifyAcceptedReplayCapsules } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { ensureReplayCapsuleSchema } from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { resolveReplayKeyMaterial } from '../../dist/infrastructure/replay/replay-key-material.js';
import { computeReplayKey } from '../../dist/replay/replay-capsule.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const HEX64 = 'a'.repeat(64);
const HEX40 = 'b'.repeat(40);
const SCHEMA = 'factory.source-change-candidate.v1';

/**
 * One terminal-accepted workplace of process run 9 (project 1) whose accepted
 * author material is fully sealable, but whose DIRECT capture failed — there
 * is NO factory_cell_final_acceptances row (the crash window R-D2 describes).
 * `variant` tweaks one aspect per scenario:
 *   - 'certifiable' (default): complete, certifiable material
 *   - 'missing-candidate-set': the decision subject has no candidate row
 *   - 'capture-fails': the candidate set has no members (capture throws)
 */
function makeWorld({ variant = 'certifiable', workplaceKey = 'item-1' } = {}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureReplayCapsuleSchema(db);
  db.pragma('foreign_keys=OFF');

  const WORKPLACE = `workplace/9/solution-development@2.0.0/implement-work-items/${workplaceKey}`;
  const CANDIDATE_SET = `candidate-set/9/solution-development@2.0.0/implement-work-items/${workplaceKey}/author1`;
  const GATE_RUN_REF = `gate-run:${workplaceKey}-author`;
  const DECISION_KEY = `decision:${workplaceKey}-author`;
  const EXECUTION_ID = `exec-${workplaceKey}-author-1`;

  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,package_digest)
     VALUES (9,1,1,'solution-development','2.0.0','solution-development@2.0.0','run-9','generic-flow',
             'factory.synthetic-input.v1','{}',?, 'running', ?)`,
  ).run(HEX64, HEX64);

  // Terminal-accepted workplace. NO cfa row — the direct capture failed.
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,9,'solution-development@2.0.0','implement-work-items',?,
             'done','terminal','author',7,'accepted')`,
  ).run(WORKPLACE, workplaceKey);

  // The author task — the replay identity anchor (same metadata shape the
  // conveyor freezes at planning; the REAL resolver reads exactly these).
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,workplace_ref,execution_mode,metadata)
     VALUES (21,1,'author','done',?, 'tracker_only', ?)`,
  ).run(WORKPLACE, JSON.stringify({
    process_run_id: 9,
    process_module_ref: 'solution-development@2.0.0',
    process_node_id: 'implement-work-items',
    production_cell_id: 'implement-work-items',
    work_key: workplaceKey,
    workplace_ref: WORKPLACE,
    role: 'author',
    semantic_input_digest: HEX64,
    cell_input_item: { id: workplaceKey, value: 'produce me' },
  }));

  // The presentation worker execution. Its envelope carries the frozen replay
  // binding exactly as bindReplayToClaim writes it at claim time — key
  // material resolved through the REAL resolver, capsule_ref null (a miss).
  const task = db.prepare('SELECT * FROM tasks WHERE id=21').get();
  const keyMaterial = resolveReplayKeyMaterial(db, task, 'author');
  assert.ok(keyMaterial, 'fixture: the author task must yield real key material');
  const replayKey = computeReplayKey(keyMaterial);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata)
     VALUES (?,?,?,?,?,'w','m','exited','executing',?)`,
  ).run(EXECUTION_ID, `run-${EXECUTION_ID}`, 1, 1, 21, JSON.stringify({
    execution_context: {
      selected_route: 'route-A',
      replay: {
        key: replayKey,
        key_material: keyMaterial,
        capsule_ref: null,
        capsule_payload_hash: null,
      },
    },
    execution_context_hash: 'seed',
  }));

  // Sealed author material: revision → candidate set → member → sealed
  // product (a typed non-snapshot product, so no artifacts/traces needed).
  const productPayload = {
    workItemKey: workplaceKey,
    terminalStatus: 'complete',
    source: { branch: `refs/saga/candidates/${workplaceKey}`, commitSha: HEX40 },
    snapshot: { commitSha: HEX40, treeSha: HEX40 },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: HEX40 },
  };
  const productDigest = sha(productPayload);
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: { schemaId: SCHEMA, ref: `managed-node-submission:91-${workplaceKey}`, digest: productDigest },
    payload: productPayload,
  });
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
       (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,
        material_digest,semantic_digest,sealed_at)
     VALUES (?,?,'[]','[]',?,?,?,datetime('now'))`,
  ).run(`revision:${CANDIDATE_SET}`, WORKPLACE, `presenter:${CANDIDATE_SET}`, HEX64, HEX64);

  if (variant !== 'missing-candidate-set') {
    db.prepare(
      `INSERT INTO factory_candidate_sets
         (candidate_set_ref,workplace_ref,production_revision_ref,role,
          candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,?,'author',?,'seal:sweep',datetime('now'))`,
    ).run(CANDIDATE_SET, WORKPLACE, `revision:${CANDIDATE_SET}`, HEX64);
    if (variant !== 'capture-fails') {
      db.prepare(
        `INSERT INTO factory_candidate_set_members
           (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin)
         VALUES (?,0,?,?,?,'produced')`,
      ).run(CANDIDATE_SET, SCHEMA, `managed-node-submission:91-${workplaceKey}`, productDigest);
    }
  }

  // The accepted author gate decision + the worker presentation (REAL seams —
  // recordGatePresentation copies the execution's replay binding).
  const gateRepo = new SqliteGateRepository(db);
  gateRepo.createGateRun({
    gateRunRef: GATE_RUN_REF,
    workplaceRef: {
      processRunId: 9,
      moduleRef: 'solution-development@2.0.0',
      productionCellId: 'implement-work-items',
      workKey: workplaceKey,
    },
    gatePhase: 'author',
    subjectCandidateSetRef: CANDIDATE_SET,
    assessmentCandidateSetRefs: [],
    checkPlanRef: 'plan',
    checkPlanDigest: HEX64,
    expectedWorkplaceRevision: 6,
    gateLeaseRef: `lease:${workplaceKey}`,
  });
  gateRepo.setGateRunState(GATE_RUN_REF, 'terminal');
  gateRepo.recordGatePresentation(GATE_RUN_REF, EXECUTION_ID);
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (?,?,'gate:sweep',?,'author','transition:sweep',?,'[]','accepted',
        'plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(DECISION_KEY, WORKPLACE, GATE_RUN_REF, CANDIDATE_SET, HEX64, HEX64, HEX64, sha(DECISION_KEY));

  // The accepted-authority head binding the accepted author decision (the
  // no-review author gate IS the final phase decision for this cell).
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
       (workplace_ref,accepted_author_candidate_set_ref,accepted_author_gate_decision_key,
        revision,recorded_at,accepted_author_task_id)
     VALUES (?,?,?,?,datetime('now'),'21')`,
  ).run(WORKPLACE, CANDIDATE_SET, DECISION_KEY, 7);

  return { db, WORKPLACE, CANDIDATE_SET, EXECUTION_ID, replayKey };
}

const capsuleCount = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules').get().n;

// ===========================================================================
// SW1 + SW2 — the cfa-less crash-window workplace certifies; counts returned.
// ===========================================================================
test('SW1/R-D2: the sweep certifies a terminal-accepted workplace with NO cfa row and reports counts', () => {
  const world = makeWorld();
  const { db } = world;
  try {
    assert.equal(capsuleCount(db), 0, 'precondition: nothing certified yet');
    const summary = certifyAcceptedReplayCapsules(db, 1);

    // SW1 — the crash-window workplace is no longer invisible.
    assert.equal(capsuleCount(db), 1,
      'R-D2: a terminal-accepted workplace whose direct capture failed (no cfa row) '
      + 'must be certified by the fallback sweep');

    // SW2 — the sweep returns an observable summary (R-E1).
    assert.ok(summary && typeof summary === 'object',
      'R-E1: the sweep must return a summary — "0 needed" vs "0 of N failed" must be distinguishable');
    assert.equal(summary.considered, 1);
    assert.equal(summary.certified, 1);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.skipped, {});

    // The captured capsule binds the REAL semantic key of the author task.
    const row = db.prepare('SELECT replay_key, source_candidate_set_ref FROM factory_replay_capsules').get();
    assert.equal(row.replay_key, world.replayKey);
    assert.equal(row.source_candidate_set_ref, world.CANDIDATE_SET);
  } finally {
    db.close();
  }
});

// ===========================================================================
// SW3 — missing candidate-set row: counted, logged skip — never silent (R-C6).
// ===========================================================================
test('SW3/R-C6: a decision candidate ref with no candidate row is a counted skip, not a silent continue', () => {
  const world = makeWorld({ variant: 'missing-candidate-set' });
  const { db } = world;
  try {
    const summary = certifyAcceptedReplayCapsules(db, 1);
    assert.equal(capsuleCount(db), 0, 'nothing is certifiable when the candidate row is gone');
    assert.equal(summary.considered, 1);
    assert.equal(summary.certified, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped['candidate-set-missing'], 1,
      'R-C6: the missing candidate-set row must appear as a counted skip reason');
  } finally {
    db.close();
  }
});

// ===========================================================================
// SW4 — idempotency: already-certified material skips by count.
// ===========================================================================
test('SW4: re-running the sweep is idempotent (already-certified is a counted skip)', () => {
  const world = makeWorld();
  const { db } = world;
  try {
    const first = certifyAcceptedReplayCapsules(db, 1);
    assert.equal(first.certified, 1);
    const second = certifyAcceptedReplayCapsules(db, 1);
    assert.equal(capsuleCount(db), 1, 'no duplicate capsule rows');
    assert.equal(second.considered, 1);
    assert.equal(second.certified, 0);
    assert.equal(second.failed, 0);
    assert.equal(second.skipped['already-certified'], 1,
      'the exact sealed material already has a capsule — a counted skip, not a re-capture');
  } finally {
    db.close();
  }
});

// ===========================================================================
// SW5 — a genuinely failing capture counts as failed (R-E1: not "0 needed").
// ===========================================================================
test('SW5/R-E1: a workplace whose capture fails is counted as failed', () => {
  const world = makeWorld({ variant: 'capture-fails' });
  const { db } = world;
  try {
    const summary = certifyAcceptedReplayCapsules(db, 1);
    assert.equal(capsuleCount(db), 0);
    assert.equal(summary.considered, 1);
    assert.equal(summary.certified, 0);
    assert.equal(summary.failed, 1,
      'R-E1: a failed certification is a countable outcome — distinguishable from "nothing to do"');
  } finally {
    db.close();
  }
});
