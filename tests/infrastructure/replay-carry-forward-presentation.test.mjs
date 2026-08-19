// tests/infrastructure/replay-carry-forward-presentation.test.mjs
//
// B-004 cluster repair, DEFECT 4 (W-3) — carry-forward presentations must be
// replay-certifiable.
//
// The defect (PREVENTIVE-HUNT W-3): the gate records ANY presentation ref
// (sqlite-gate-repository.recordGatePresentation), including the kernel
// carry-forward presenter 'factory-carry-forward-presenter:...' — which by
// design has NO worker_executions row. Replay certification demands one
// (replay-presentation-authority.ts INNER JOIN worker_executions), so
// requireAcceptedCandidatePresentations throws
// REPLAY_CERTIFICATION_PRESENTATION_MISSING inside recordFinalAcceptanceAndCapture
// → FinalAcceptance never recorded → the B-004 livelock (defects 1-3).
//
// Proves, through the REAL seams (real recordGatePresentation, real authority
// lookups, real SqliteReplayCapsuleRepository.captureAcceptedExecution, real
// resolveReplayKeyMaterial/computeReplayKey):
//
//   CF1 a sealed carry-forward presentation is a FIRST-CLASS presentation
//       identity for replay certification when the accepted decision's subject
//       chain proves the carry-forward (deterministic presenter ref bound by
//       the sealed authorization + consumption rows);
//   CF2 the capsule capture binds to the carry-forward provenance: key
//       material derives from the sealed carry-forward's TARGET author task
//       via the REAL resolver, the payload carries a typed presentedBy marker,
//       and the capsule row cites the presenter ref as source execution;
//   CF3 fail-closed: a presenter-form ref WITHOUT the sealed consumption
//       binding is still REJECTED (no weakening of the worker-execution
//       requirement for presentations that are not proven kernel
//       carry-forwards);
//   CF4 fail-closed: an ordinary execution-shaped presentation with no
//       worker_executions row stays REJECTED exactly as before.
//
// BEFORE the fix this is RED on CF1 (REPLAY_CERTIFICATION_PRESENTATION_MISSING)
// and CF2 (REPLAY_CAPTURE_EXECUTION_NOT_FOUND: factory-carry-forward-presenter:...).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { SqliteReplayCapsuleRepository } from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { requireAcceptedCandidatePresentations } from '../../dist/infrastructure/replay/replay-presentation-authority.js';
import { resolveReplayKeyMaterial } from '../../dist/infrastructure/replay/replay-key-material.js';
import { computeReplayKey } from '../../dist/replay/replay-capsule.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const HEX64 = 'a'.repeat(64);
const HEX40 = 'b'.repeat(40);
const SCHEMA = 'factory.source-change-candidate.v1';

const WORKPLACE = 'workplace/9/solution-development@2.0.0/implement-work-items/item-1';
const CANDIDATE_SET = 'candidate-set/9/solution-development@2.0.0/implement-work-items/item-1/carry1';
const AUTHORIZATION_REF = `author-carry-forward:${sha('cf-authorization')}`;
const PRESENTER_REF = `factory-carry-forward-presenter:${AUTHORIZATION_REF}`;
const GATE_RUN_REF = `gate-run:carry-forward-author`;
const DECISION_KEY = `decision:carry-forward-author`;

/**
 * Given-world fixtures (established c5 style): the child-run workplace whose
 * author material was carried forward, the sealed carry-forward
// authorization + consumption, the accepted author gate decision with the
 * kernel presenter presentation, and the TARGET author task that anchors the
 * replay identity. The presentation row itself is written through the REAL
 * recordGatePresentation seam.
 */
function makeWorld() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  db.pragma('foreign_keys=OFF');
  try {

  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,package_digest)
     VALUES (9,1,1,'solution-development','2.0.0','solution-development@2.0.0','run-9','generic-flow',
             'factory.synthetic-input.v1','{}',?,?,?)`,
  ).run(HEX64, 'running', HEX64);

  // The TARGET (child-run) workplace, terminal(accepted).
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,terminal_reason)
     VALUES (?,9,'solution-development@2.0.0','implement-work-items','item-1',
             'done','terminal','author',7,'accepted')`,
  ).run(WORKPLACE);

  // The carried-forward candidate set + member (origin carried-forward).
  const productPayload = {
    workItemKey: 'item-1',
    terminalStatus: 'complete',
    source: { branch: 'refs/saga/candidates/cf', commitSha: HEX40 },
    snapshot: { commitSha: HEX40, treeSha: HEX40 },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: HEX40 },
  };
  const productDigest = sha(productPayload);
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: { schemaId: SCHEMA, ref: `managed-node-submission:91`, digest: productDigest },
    payload: productPayload,
  });
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
       (revision_ref,workplace_ref,parent_revision_ref,members,
        contributing_execution_refs,presenter_ref,material_digest,semantic_digest,sealed_at)
     VALUES (?,?,NULL,'[]','[]',?,?,?,datetime('now'))`,
  ).run(`revision:${CANDIDATE_SET}`, WORKPLACE, `presenter:${CANDIDATE_SET}`, HEX64, HEX64);
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'author',NULL,?,'seal:cf',datetime('now'))`,
  ).run(CANDIDATE_SET, WORKPLACE, `revision:${CANDIDATE_SET}`, HEX64);
  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'carried-forward','candidate-set/8/source')`,
  ).run(CANDIDATE_SET, SCHEMA, 'managed-node-submission:91', productDigest);

  // The TARGET author task — the replay identity anchor for the carried
  // material (the same metadata shape SqliteAuthorCandidateCarryForward.resolve
  // validates before presenting).
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (11,1,'development.author','carry',?,'${SCHEMA}','executing',21)`,
  ).run(JSON.stringify({ enforcement: 'runtime', allowed_tools: [], scope: 'carry', snapshot_ref: 'snapshot' }));
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,task_kind,execution_mode,metadata)
     VALUES (21,1,'carry-author','done',?,'development.work','tracker_only',?)`,
  ).run(WORKPLACE, JSON.stringify({
    process_run_id: 9,
    process_module_ref: 'solution-development@2.0.0',
    process_node_id: 'implement-work-items',
    production_cell_id: 'implement-work-items',
    work_key: 'item-1',
    workplace_ref: WORKPLACE,
    role: 'author',
    work_intent_id: 11,
    semantic_input_digest: HEX64,
    cell_input_item: { id: 'item-1', value: 'carry me' },
  }));

  // The sealed carry-forward authorization + its consumption binding the
  // deterministic presenter ref to THIS target candidate set.
  db.prepare(
    `INSERT INTO factory_author_candidate_carry_forward_authorizations
       (authorization_ref,continuation_ref,source_lifecycle_run_id,source_process_run_id,
        source_workplace_ref,source_candidate_set_ref,source_candidate_set_digest,
        source_gate_decision_key,source_gate_decision_digest,source_product_schema,
        source_product_ref,source_product_digest,semantic_input_digest,item_snapshot_hash,
        project_repository_id,integration_branch,base_commit,source_commit,source_tree,
        eligible_failure_code,evidence_snapshot,evidence_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    AUTHORIZATION_REF,            // authorization_ref
    'continuation:cf',            // continuation_ref
    8,                            // source_lifecycle_run_id
    8,                            // source_process_run_id
    'workplace/8/source',         // source_workplace_ref
    'candidate-set/8/source',     // source_candidate_set_ref
    HEX64,                        // source_candidate_set_digest
    'decision:source-author',     // source_gate_decision_key
    HEX64,                        // source_gate_decision_digest
    SCHEMA,                       // source_product_schema
    'managed-node-submission:90', // source_product_ref
    productDigest,                // source_product_digest
    HEX64,                        // semantic_input_digest
    sha({ id: 'item-1' }),        // item_snapshot_hash
    1,                            // project_repository_id
    'dev',                        // integration_branch
    HEX40,                        // base_commit
    HEX40,                        // source_commit
    HEX40,                        // source_tree
    'review-output-schema-mismatch', // eligible_failure_code
    JSON.stringify({ schemaVersion: 'test' }), // evidence_snapshot
    sha('evidence'),              // evidence_digest
  );
  db.prepare(
    `INSERT INTO factory_author_candidate_carry_forward_consumptions
       (authorization_ref,target_process_run_id,target_workplace_ref,
        target_candidate_set_ref,presenter_ref)
     VALUES (?,9,?,?,?)`,
  ).run(AUTHORIZATION_REF, WORKPLACE, CANDIDATE_SET, PRESENTER_REF);

  // The accepted author gate decision + the kernel presentation (REAL seam).
  const gateRepo = new SqliteGateRepository(db);
  gateRepo.createGateRun({
    gateRunRef: GATE_RUN_REF,
    workplaceRef: {
      processRunId: 9,
      moduleRef: 'solution-development@2.0.0',
      productionCellId: 'implement-work-items',
      workKey: 'item-1',
    },
    gatePhase: 'author',
    subjectCandidateSetRef: CANDIDATE_SET,
    assessmentCandidateSetRefs: [],
    checkPlanRef: 'plan',
    checkPlanDigest: HEX64,
    expectedWorkplaceRevision: 6,
    gateLeaseRef: 'lease:cf',
  });
  gateRepo.setGateRunState(GATE_RUN_REF, 'terminal');
  gateRepo.recordGatePresentation(GATE_RUN_REF, PRESENTER_REF);
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (?,?,'gate:cf',?,'author','transition:cf',?,'[]','accepted',
        'plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(DECISION_KEY, WORKPLACE, GATE_RUN_REF, CANDIDATE_SET, HEX64, HEX64, HEX64, sha(DECISION_KEY));

  // The accepted-authority head binding the decision (the no-review author
  // gate IS the final phase decision for this cell).
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
       (workplace_ref,accepted_author_candidate_set_ref,accepted_author_gate_decision_key,
        revision,recorded_at,accepted_author_task_id)
     VALUES (?,?,?,?,datetime('now'),?)`,
  ).run(WORKPLACE, CANDIDATE_SET, DECISION_KEY, 7, '21');

    return { db, productDigest };
  } catch (fixtureError) {
    throw new Error(`fixture: ${fixtureError.message}`);
  }
}

// ===========================================================================
// CF1 — the sealed carry-forward presentation is a first-class presentation.
// ===========================================================================
test('CF1: requireAcceptedCandidatePresentations accepts the kernel carry-forward presenter with sealed provenance', () => {
  const { db } = makeWorld();
  try {
    const presentations = requireAcceptedCandidatePresentations(db, {
      workplaceRef: WORKPLACE,
      finalDecisionKey: DECISION_KEY,
      finalSubjectCandidateSetRef: CANDIDATE_SET,
      candidateSetRef: CANDIDATE_SET,
    });
    assert.ok(presentations.length >= 1,
      'CF1/W-3: the carry-forward presentation must certify — the kernel '
      + 'presenter is a first-class presentation identity');
    assert.equal(presentations[0].presentationRef, PRESENTER_REF);
  } finally {
    db.close();
  }
});

// ===========================================================================
// CF2 — the capsule binds to the carry-forward provenance.
// ===========================================================================
test('CF2: captureAcceptedExecution derives key material from the sealed carry-forward target task', () => {
  const { db } = makeWorld();
  try {
    const presentations = requireAcceptedCandidatePresentations(db, {
      workplaceRef: WORKPLACE,
      finalDecisionKey: DECISION_KEY,
      finalSubjectCandidateSetRef: CANDIDATE_SET,
      candidateSetRef: CANDIDATE_SET,
    });
    const repo = new SqliteReplayCapsuleRepository(db);
    const capsule = repo.captureAcceptedExecution({
      executionRef: PRESENTER_REF,
      candidateSetRef: CANDIDATE_SET,
      expectedReplayBinding: presentations[0],
    });
    assert.ok(capsule, 'CF2/W-3: capture succeeds for a kernel-presented candidate');

    // The replay identity is the REAL resolver + hasher over the TARGET task
    // (the workplace the carry-forward presented into) — not invented here.
    const targetTask = db.prepare('SELECT * FROM tasks WHERE id=21').get();
    const keyMaterial = resolveReplayKeyMaterial(db, targetTask, 'author');
    assert.ok(keyMaterial, 'the target author task yields real key material');
    const expectedReplayKey = computeReplayKey(keyMaterial);
    assert.equal(capsule.replayKey, expectedReplayKey,
      'the capsule replay key derives from the sealed carry-forward target identity');

    const payload = capsule.payload;
    assert.equal(payload.presentedBy, 'factory-carry-forward-presenter:',
      'the payload carries the typed kernel-presenter marker');
    assert.equal(capsule.sourceExecutionRef, PRESENTER_REF,
      'the capsule cites the presenter ref as its source execution provenance');
    assert.equal(payload.typedProducts.length, 1,
      'the carried product material resolved into the capsule');
    assert.equal(payload.typedProducts[0].contentHash, db.prepare(
      'SELECT product_digest FROM factory_candidate_set_members WHERE candidate_set_ref=?',
    ).get(CANDIDATE_SET).product_digest);
  } finally {
    db.close();
  }
});

// ===========================================================================
// CF3 — fail-closed: presenter FORM alone is not authority.
// ===========================================================================
test('CF3: a presenter-form ref without the sealed consumption binding stays REJECTED', () => {
  const { db } = makeWorld();
  try {
    const rogue = `factory-carry-forward-presenter:author-carry-forward:${sha('never-authorized')}`;
    const gateRepo = new SqliteGateRepository(db);
    gateRepo.createGateRun({
      gateRunRef: 'gate-run:rogue',
      workplaceRef: {
        processRunId: 9, moduleRef: 'solution-development@2.0.0',
        productionCellId: 'implement-work-items', workKey: 'item-1',
      },
      gatePhase: 'author',
      subjectCandidateSetRef: CANDIDATE_SET,
      assessmentCandidateSetRefs: [],
      checkPlanRef: 'plan',
      checkPlanDigest: HEX64,
      expectedWorkplaceRevision: 6,
      gateLeaseRef: 'lease:rogue',
    });
    gateRepo.recordGatePresentation('gate-run:rogue', rogue);
    // The rogue decision is NOT accepted for the subject — bind it to the
    // same workplace/subject so the presentation lookup would find it if the
    // predicate were weakened to form-matching alone.
    db.prepare(
      `INSERT INTO factory_gate_decisions
         (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
          subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
          check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
          check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
       VALUES ('decision:rogue',?,'gate:rogue','gate-run:rogue','author','transition:rogue',
          ?,'[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
    ).run(WORKPLACE, CANDIDATE_SET, HEX64, HEX64, HEX64, sha('decision:rogue'));
    // For subject==finalSubject the authority head's decision key is what the
    // lookup actually resolves — rebind it to the rogue decision so the rogue
    // presentation is the one under certification.
    db.prepare(
      `UPDATE factory_accepted_authority_head
          SET accepted_author_gate_decision_key='decision:rogue'
        WHERE workplace_ref=?`,
    ).run(WORKPLACE);

    assert.throws(
      () => requireAcceptedCandidatePresentations(db, {
        workplaceRef: WORKPLACE,
        finalDecisionKey: 'decision:rogue',
        finalSubjectCandidateSetRef: CANDIDATE_SET,
        candidateSetRef: CANDIDATE_SET,
      }),
      /REPLAY_CERTIFICATION_PRESENTATION_MISSING/,
      'CF3: presenter FORM without the sealed authorization+consumption chain must stay rejected',
    );
  } finally {
    db.close();
  }
});

// ===========================================================================
// CF4 — fail-closed: ordinary presentations still require a worker execution.
// ===========================================================================
test('CF4: an ordinary execution-shaped presentation with no worker_executions row stays REJECTED', () => {
  const { db } = makeWorld();
  try {
    const gateRepo = new SqliteGateRepository(db);
    gateRepo.createGateRun({
      gateRunRef: 'gate-run:phantom',
      workplaceRef: {
        processRunId: 9, moduleRef: 'solution-development@2.0.0',
        productionCellId: 'implement-work-items', workKey: 'item-1',
      },
      gatePhase: 'author',
      subjectCandidateSetRef: CANDIDATE_SET,
      assessmentCandidateSetRefs: [],
      checkPlanRef: 'plan',
      checkPlanDigest: HEX64,
      expectedWorkplaceRevision: 6,
      gateLeaseRef: 'lease:phantom',
    });
    gateRepo.recordGatePresentation('gate-run:phantom', 'exec-phantom-1');
    db.prepare(
      `INSERT INTO factory_gate_decisions
         (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
          subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
          check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
          check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
       VALUES ('decision:phantom',?,'gate:phantom','gate-run:phantom','author','transition:phantom',
          ?,'[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
    ).run(WORKPLACE, CANDIDATE_SET, HEX64, HEX64, HEX64, sha('decision:phantom'));
    db.prepare(
      `UPDATE factory_accepted_authority_head
          SET accepted_author_gate_decision_key='decision:phantom'
        WHERE workplace_ref=?`,
    ).run(WORKPLACE);

    assert.throws(
      () => requireAcceptedCandidatePresentations(db, {
        workplaceRef: WORKPLACE,
        finalDecisionKey: 'decision:phantom',
        finalSubjectCandidateSetRef: CANDIDATE_SET,
        candidateSetRef: CANDIDATE_SET,
      }),
      /REPLAY_CERTIFICATION_PRESENTATION_MISSING/,
      'CF4: the worker-execution requirement for ordinary presentations is unchanged',
    );
  } finally {
    db.close();
  }
});
