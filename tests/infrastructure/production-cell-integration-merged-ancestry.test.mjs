import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteProductionCellIntegration } from '../../dist/infrastructure/workplace/sqlite-production-cell-integration.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteManagedNodeSubmissionRepository } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// Stage-7 B2 — the forged-receipt path is dead.
//
// The git-integration effect must treat the REPOSITORY, not the
// tasks.integration_state column, as the authority on whether a merge
// happened (G3 dossier §7-E; the architect's §9 verdict, defect B). A dirtied
// 'merged' column — written by ANY writer, not specifically a worker; that is
// why these fixtures set the column directly and never touch the merge tools —
// must not be able to manufacture a factory receipt over a merge that never
// happened.
//
// Three theorems:
//   1. NEGATIVE (per the brief): forged 'merged' + a source that CANNOT merge
//      (conflicts with the integration head) → NOT succeeded, no
//      integrated_commit written.
//   2. LAUNDERING-KILLER: forged 'merged' + a cleanly mergeable source →
//      success is legitimate ONLY through a REAL factory merge: alreadyApplied
//      must be false and the ref must actually advance. (Pre-fix, this exact
//      world returned alreadyApplied:true over an unmoved ref — the receipt
//      over nothing.)
//   3. POSITIVE counterpart: a genuinely merged source short-circuits as
//      alreadyApplied:true through the ancestry test ALONE — idempotency
//      survives the fix.

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Build the template world of production-cell-integration-candidate-binding
 * .test.mjs test 1 (real git repo, sealed source product, author + reviewer
 * CandidateSets, accepted gate decision, authority head) with two knobs:
 *
 * @param devMode 'base'       — integration branch stays at the base commit
 *                               (the source merges cleanly);
 *               'divergent'   — the integration branch advances with a
 *                               conflicting commit (the source cannot merge);
 *               'premerged'   — the source is genuinely merged into the
 *                               integration branch before the effect runs.
 * @param taskIntegrationState what the tasks row claims (the column under
 *                               test — 'merged' here means FORGED unless the
 *                               git state says otherwise).
 */
function makeWorld({ devMode, taskIntegrationState, workKey }) {
  const root = mkdtempSync(join(tmpdir(), 'saga-integration-ancestry-'));
  const db = new Database(':memory:');

  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Saga Test');
  git(root, 'config', 'user.email', 'saga@example.test');
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'candidate');
  writeFileSync(join(root, 'app.txt'), 'candidate\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'candidate');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
  git(root, 'update-ref', 'refs/saga/candidates/exact', sourceCommit);
  git(root, 'checkout', 'dev');
  if (devMode === 'divergent') {
    writeFileSync(join(root, 'app.txt'), 'divergent\n');
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-m', 'divergent');
  } else if (devMode === 'premerged') {
    git(root, 'merge', '--no-ff', '-m', 'premerge', sourceCommit);
  }
  const devHeadBefore = git(root, 'rev-parse', 'HEAD');

  db.exec(SCHEMA_SQL);
  new SqliteManagedNodeSubmissionRepository(db);
  db.pragma('foreign_keys=OFF');
  db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
  db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
  db.prepare(`INSERT INTO repositories(id,name) VALUES (1,'r')`).run();
  db.prepare(
    `INSERT INTO project_repositories
      (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(root);
  const workplace = `workplace/22/module@1/cell/${workKey}`;
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role,revision)
     VALUES (?,22,'module@1','cell',?,'review_in_progress','effect_pending','reviewer',9)`,
  ).run(workplace, workKey);
  db.prepare(
    `INSERT INTO tasks
      (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
       integration_state,metadata)
     VALUES (44,1,'author','done',?,'artifact_change',1,?,'{"role":"author"}')`,
  ).run(workplace, taskIntegrationState);

  const sourcePayload = {
    workItemKey: workKey, terminalStatus: 'complete',
    source: { branch: 'refs/saga/candidates/exact', commitSha: sourceCommit },
    snapshot: { commitSha: sourceCommit, treeSha: sourceTree },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: base },
  };
  const sourceDigest = sha256Hex(sourcePayload);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
      (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
       schema_version,payload_snapshot,content_hash)
     VALUES (91,11,'old@1','cell',1,33,'old-author',
             'factory.source-change-candidate.v1',?,?)`,
  ).run(JSON.stringify(sourcePayload), sourceDigest);
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: {
      schemaId: 'factory.source-change-candidate.v1',
      ref: 'managed-node-submission:91',
      digest: sourceDigest,
    },
    payload: sourcePayload,
  });

  const authorSet = `candidate-set/current-author-${workKey}`;
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'author',NULL,?,'seal:x',datetime('now'))`,
  ).run(authorSet, workplace, `revision/sha256:${workKey}`, 'a'.repeat(64));
  db.prepare(
    `INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
       origin,source_candidate_set_ref)
     VALUES (?,0,'factory.source-change-candidate.v1','managed-node-submission:91',?,
             'carried-forward','candidate-set/old-author')`,
  ).run(authorSet, sourceDigest);

  const reviewPayload = {
    verdict: 'approved', subject_candidate_set_ref: authorSet, findings: [],
  };
  const reviewDigest = sha256Hex(reviewPayload);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
      (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
       schema_version,payload_snapshot,content_hash)
     VALUES (92,22,'module@1','cell',2,45,'reviewer',
             'factory.development-review-verdict.v1',?,?)`,
  ).run(JSON.stringify(reviewPayload), reviewDigest);
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: {
      schemaId: 'factory.development-review-verdict.v1',
      ref: 'managed-node-submission:92',
      digest: reviewDigest,
    },
    payload: reviewPayload,
  });
  const reviewerSet = `candidate-set/current-reviewer-${workKey}`;
  db.prepare(
    `INSERT INTO factory_candidate_sets
      (candidate_set_ref,workplace_ref,production_revision_ref,role,
       subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'reviewer',?,?,'seal:r',datetime('now'))`,
  ).run(reviewerSet, workplace, `revision/sha256:r-${workKey}`, authorSet, 'b'.repeat(64));
  db.prepare(
    `INSERT INTO factory_candidate_set_members
      (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,origin,source_candidate_set_ref)
     VALUES (?,0,'factory.development-review-verdict.v1','managed-node-submission:92',?,'produced',NULL)`,
  ).run(reviewerSet, reviewDigest);
  db.prepare(
    `INSERT INTO factory_gate_decisions
      (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
       subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
       check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
       check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:final',?,'gate:final','run:final','final','transition:final',
             ?,?,'accepted','plan','${'c'.repeat(64)}','policy','${'d'.repeat(64)}',
             '[]','${'e'.repeat(64)}','[]','${'f'.repeat(64)}')`,
  ).run(workplace, authorSet, JSON.stringify([reviewerSet]));
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
      (workplace_ref, accepted_author_candidate_set_ref,
       accepted_author_gate_decision_key, revision, recorded_at,
       accepted_author_task_id)
     VALUES (?,?,?,?,datetime('now'),?)`,
  ).run(workplace, authorSet, 'decision:final', 9, '44');

  const integration = new SqliteProductionCellIntegration(
    db,
    new SqliteAcceptedAuthorityHeadRepository(db),
  );
  const input = {
    workplaceRef: { processRunId: 22, moduleRef: 'module@1', productionCellId: 'cell', workKey },
    processRunId: 22,
    candidateSetRef: authorSet,
    gateDecisionKey: 'decision:final',
    expectedProductSchema: 'factory.source-change-candidate.v1',
    acceptedProductRefs: [{
      schemaId: 'factory.source-change-candidate.v1',
      ref: 'managed-node-submission:91',
      digest: sourceDigest,
    }],
  };
  return { root, db, integration, input, base, sourceCommit, devHeadBefore };
}

test('forged merged column + unmergeable source: no success, no integrated_commit (the negative theorem)', () => {
  // tasks.integration_state claims 'merged' — dirtied by an arbitrary writer,
  // NOT via any merge tool (the point: the defect must not depend on the
  // grant). The integration branch has advanced with a CONFLICTING commit, so
  // the source factually cannot be merged. Pre-fix, the state disjunct
  // short-circuited BEFORE any git test and returned succeeded with a factory
  // receipt over a merge that never happened.
  const world = makeWorld({ devMode: 'divergent', taskIntegrationState: 'merged', workKey: 'neg' });
  try {
    const result = world.integration.integrateAcceptedWorkplace(world.input);
    assert.notEqual(result.outcome, 'succeeded',
      'a forged merged column must not produce outcome succeeded');
    assert.equal(result.outcome, 'repair_required');
    assert.match(result.reason, /PRODUCTION_CELL_INTEGRATION_CONFLICT/);
    const task = world.db
      .prepare('SELECT integration_state, integrated_commit FROM tasks WHERE id=44').get();
    assert.equal(task.integrated_commit, null,
      'the effect must NOT stamp integrated_commit from a column claim');
    assert.equal(task.integration_state, 'conflict',
      'the honest physical verdict replaces the forged column');
    // The ref is unmoved — no receipt-worthy event occurred.
    assert.equal(git(world.root, 'rev-parse', 'HEAD'), world.devHeadBefore);
  } finally {
    world.db.close();
    rmSync(world.root, { recursive: true, force: true });
  }
});

test('forged merged column + cleanly mergeable source: success only through a REAL factory merge', () => {
  // The laundering shape of G3 §7-E: column says merged, repository never
  // merged, but the source WOULD merge cleanly. Pre-fix this returned
  // alreadyApplied:true with beforeHead===afterHead — a durable factory
  // receipt over an unmoved ref. Post-fix, success is legitimate ONLY because
  // the factory itself performs the merge: alreadyApplied must be false and
  // the ref must actually advance.
  const world = makeWorld({ devMode: 'base', taskIntegrationState: 'merged', workKey: 'launder' });
  try {
    const result = world.integration.integrateAcceptedWorkplace(world.input);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.alreadyApplied, false,
      'alreadyApplied:true requires ancestry — a column claim proves nothing');
    assert.equal(result.beforeHead, world.devHeadBefore);
    assert.notEqual(result.afterHead, world.devHeadBefore,
      'a real merge commit must be created; the ref must actually advance');
    // The physical postconditions that make the receipt TRUE:
    assert.equal(git(world.root, 'merge-base', '--is-ancestor', world.sourceCommit, 'dev'), '');
    assert.equal(git(world.root, 'rev-parse', 'dev'), result.afterHead);
    const task = world.db
      .prepare('SELECT integration_state, integrated_commit FROM tasks WHERE id=44').get();
    assert.equal(task.integrated_commit, result.afterHead,
      'integrated_commit is the factory-executed merge commit, not the column claim');
    assert.equal(task.integration_state, 'merged');
  } finally {
    world.db.close();
    rmSync(world.root, { recursive: true, force: true });
  }
});

test('genuinely merged source short-circuits as alreadyApplied through ancestry alone (idempotency survives)', () => {
  // The property most at risk from the fix: a source that IS an ancestor of
  // the integration head must still short-circuit WITHOUT performing a second
  // merge — now through the git test alone. The column here is honestly
  // 'pending'; it must neither help nor block.
  const world = makeWorld({ devMode: 'premerged', taskIntegrationState: 'pending', workKey: 'idem' });
  try {
    const result = world.integration.integrateAcceptedWorkplace(world.input);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.alreadyApplied, true,
      'an ancestor source is the complete idempotency proof');
    assert.equal(result.beforeHead, world.devHeadBefore);
    assert.equal(result.afterHead, world.devHeadBefore,
      'no second merge commit — the ref is unmoved');
    const task = world.db
      .prepare('SELECT integration_state, integrated_commit FROM tasks WHERE id=44').get();
    assert.equal(task.integration_state, 'merged');
    assert.equal(task.integrated_commit, world.devHeadBefore);
    assert.equal(git(world.root, 'rev-parse', 'dev'), world.devHeadBefore);
  } finally {
    world.db.close();
    rmSync(world.root, { recursive: true, force: true });
  }
});
