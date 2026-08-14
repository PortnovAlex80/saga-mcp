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

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

test('integration consumes the exact current CandidateSet even when its managed product was carried from another process', () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-candidate-integration-'));
  const db = new Database(':memory:');
  try {
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

    db.exec(SCHEMA_SQL);
    new SqliteManagedNodeSubmissionRepository(db);
    // This adapter fixture intentionally supplies only the tables participating
    // in CandidateSet/Git integration; upstream lifecycle rows are irrelevant.
    db.pragma('foreign_keys=OFF');
    db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
    db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
    db.prepare(`INSERT INTO repositories(id,name) VALUES (1,'r')`).run();
    db.prepare(
      `INSERT INTO project_repositories
        (id,project_id,repository_id,role,local_path,integration_branch,status)
       VALUES (1,1,1,'component',?,'dev','active')`,
    ).run(root);
    const workplace = 'workplace/22/module@1/cell/item';
    db.prepare(
      `INSERT INTO factory_workplaces
        (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
         kanban_phase,loop_state,next_role,revision)
       VALUES (?,22,'module@1','cell','item','review_in_progress','effect_pending','reviewer',9)`,
    ).run(workplace);
    db.prepare(
      `INSERT INTO tasks
        (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
         integration_state,metadata)
       VALUES (44,1,'author','done',?,'artifact_change',1,'not_required','{"role":"author"}')`,
    ).run(workplace);

    const sourcePayload = {
      workItemKey: 'item', terminalStatus: 'complete',
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

    const authorSet = 'candidate-set/current-author';
    db.prepare(
      `INSERT INTO factory_candidate_sets
        (candidate_set_ref,workplace_ref,production_revision_ref,role,
         subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,?,'author',NULL,?,'seal:x',datetime('now'))`,
    ).run(authorSet, workplace, 'revision/sha256:test-author', 'a'.repeat(64));
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
    const reviewerSet = 'candidate-set/current-reviewer';
    db.prepare(
      `INSERT INTO factory_candidate_sets
        (candidate_set_ref,workplace_ref,production_revision_ref,role,
         subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,?,'reviewer',?,?,'seal:r',datetime('now'))`,
    ).run(reviewerSet, workplace, 'revision/sha256:test-reviewer', authorSet, 'b'.repeat(64));
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

    // ADR-053 C5-02 — at final author acceptance the coordinator records the
    // accepted-authority head atomically with the gate-accept CAS transition.
    // The head carries the CURRENT workplace task identity
    // (`accepted_author_task_id` = 44), which the C5-03 git integration reads
    // as the SOLE task authority — NOT the carried-forward submission's
    // task_id (33, the origin process's task).
    db.prepare(
      `INSERT INTO factory_accepted_authority_head
        (workplace_ref, accepted_author_candidate_set_ref,
         accepted_author_gate_decision_key, revision, recorded_at,
         accepted_author_task_id)
       VALUES (?,?,?,?,datetime('now'),?)`,
    ).run(workplace, authorSet, 'decision:final', 9, '44');

    // The canonical checkout is deliberately contaminated. Integration must
    // operate on Git objects and update the target ref by CAS, not checkout or
    // merge through these working-directory bytes.
    writeFileSync(join(root, 'untracked-worker-leak.txt'), 'must remain unrelated\n');

    let result;
    try {
      result = new SqliteProductionCellIntegration(
        db,
        new SqliteAcceptedAuthorityHeadRepository(db),
      ).integrateAcceptedWorkplace({
        workplaceRef: { processRunId: 22, moduleRef: 'module@1', productionCellId: 'cell', workKey: 'item' },
        processRunId: 22,
        candidateSetRef: authorSet,
        gateDecisionKey: 'decision:final',
        expectedProductSchema: 'factory.source-change-candidate.v1',
      });
    } catch (error) {
      throw new Error(`integration fixture failed: ${error?.message ?? error}`, { cause: error });
    }
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.sourceCommit, sourceCommit);
    assert.equal(result.sourceTree, sourceTree);
    assert.equal(git(root, 'merge-base', '--is-ancestor', sourceCommit, 'dev'), '');
    assert.equal(git(root, 'status', '--short'), '?? untracked-worker-leak.txt');
    assert.equal(db.prepare('SELECT integration_state FROM tasks WHERE id=44').get().integration_state, 'merged');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration fails closed when the accepted-authority head has no task identity, even though the origin submission task exists', () => {
  // ADR-053 C5-03 — the canonical consumer must NOT fall back to the origin
  // submission's task (s.task_id) or to recency when the accepted-authority
  // head is absent / has no task identity. It fails closed (deny) instead of
  // guessing. This is the carry-forward-safe consumer pole.
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    new SqliteManagedNodeSubmissionRepository(db);
    db.pragma('foreign_keys=OFF');
    db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
    db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
    db.prepare(`INSERT INTO repositories(id,name) VALUES (1,'r')`).run();
    db.prepare(
      `INSERT INTO project_repositories
        (id,project_id,repository_id,role,local_path,integration_branch,status)
       VALUES (1,1,1,'component','.','dev','active')`,
    ).run();
    const workplace = 'workplace/22/module@1/cell/item-failclosed';
    db.prepare(
      `INSERT INTO factory_workplaces
        (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
         kanban_phase,loop_state,next_role,revision)
       VALUES (?,22,'module@1','cell','item-failclosed','review_in_progress','effect_pending','reviewer',3)`,
    ).run(workplace);
    // The ORIGIN submission's task (33) EXISTS and is a fully valid integratable
    // task. With the pre-C5-03 consumer (`JOIN tasks t ON t.id = s.task_id`) this
    // row WOULD have been selected as the integration target. The authority head
    // is intentionally ABSENT, so the consumer MUST fail closed rather than fall
    // back to this origin task.
    db.prepare(
      `INSERT INTO tasks
        (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
         integration_state,metadata)
       VALUES (33,1,'origin','done',?,'artifact_change',1,'not_required','{"role":"author"}')`,
    ).run(workplace);
    const sourcePayload = {
      workItemKey: 'item-failclosed', terminalStatus: 'complete',
      source: { branch: 'refs/saga/candidates/origin', commitSha: 'deadbeef' },
      snapshot: { commitSha: 'deadbeef', treeSha: 'cafebabe' },
      repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: 'base' },
    };
    const sourceDigest = sha256Hex(sourcePayload);
    db.prepare(
      `INSERT INTO factory_managed_node_submissions
        (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
         schema_version,payload_snapshot,content_hash)
       VALUES (91,11,'old@1','cell',1,33,'old-author',
               'factory.source-change-candidate.v1',?,?)`,
    ).run(JSON.stringify(sourcePayload), sourceDigest);
    const authorSet = 'candidate-set/origin-author';
    db.prepare(
      `INSERT INTO factory_candidate_sets
        (candidate_set_ref,workplace_ref,production_revision_ref,role,
         subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,?,'author',NULL,?,'seal:x',datetime('now'))`,
    ).run(authorSet, workplace, 'revision/sha256:origin', 'a'.repeat(64));
    db.prepare(
      `INSERT INTO factory_candidate_set_members
        (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
         origin,source_candidate_set_ref)
       VALUES (?,0,'factory.source-change-candidate.v1','managed-node-submission:91',?,
               'carried-forward','candidate-set/old-author')`,
    ).run(authorSet, sourceDigest);
    // NOTE: no factory_accepted_authority_head row — task identity unbound.

    const integration = new SqliteProductionCellIntegration(
      db,
      new SqliteAcceptedAuthorityHeadRepository(db),
    );
    const input = {
      workplaceRef: { processRunId: 22, moduleRef: 'module@1', productionCellId: 'cell', workKey: 'item-failclosed' },
      processRunId: 22,
      candidateSetRef: authorSet,
      gateDecisionKey: 'decision:missing-authority-head',
      expectedProductSchema: 'factory.source-change-candidate.v1',
    };

    // Integrate path: fails closed (throws) — does NOT fall back to origin task 33.
    assert.throws(
      () => integration.integrateAcceptedWorkplace(input),
      (err) => {
        assert.match(err.message, /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/);
        assert.match(err.message, /accepted-authority head has no accepted author task/);
        return true;
      },
    );
    // Observe path: fails closed (blocked) — does NOT fall back either.
    const observation = integration.observeAcceptedWorkplace(input);
    assert.equal(observation.outcome, 'blocked');
    assert.match(observation.reason, /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/);

    // The origin submission's task (33) is NOT mutated — no fallback occurred.
    assert.equal(
      db.prepare('SELECT integration_state FROM tasks WHERE id=33').get().integration_state,
      'not_required',
    );
  } finally {
    db.close();
  }
});
