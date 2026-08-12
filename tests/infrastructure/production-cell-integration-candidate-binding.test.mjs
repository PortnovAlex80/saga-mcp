import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteProductionCellIntegration } from '../../dist/infrastructure/workplace/sqlite-production-cell-integration.js';
import { SqliteManagedNodeSubmissionRepository } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
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

    const authorSet = 'candidate-set/current-author';
    db.prepare(
      `INSERT INTO factory_candidate_sets
        (candidate_set_ref,workplace_ref,producer_execution_ref,production_revision_ref,role,
         subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,'factory-carry-forward-presenter:x',?,'author',NULL,?,'seal:x',datetime('now'))`,
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
    const reviewerSet = 'candidate-set/current-reviewer';
    db.prepare(
      `INSERT INTO factory_candidate_sets
        (candidate_set_ref,workplace_ref,producer_execution_ref,production_revision_ref,role,
         subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
       VALUES (?,?,'reviewer',?,'reviewer',?,?,'seal:r',datetime('now'))`,
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

    // The canonical checkout is deliberately contaminated. Integration must
    // operate on Git objects and update the target ref by CAS, not checkout or
    // merge through these working-directory bytes.
    writeFileSync(join(root, 'untracked-worker-leak.txt'), 'must remain unrelated\n');

    let result;
    try {
      result = new SqliteProductionCellIntegration(db).integrateAcceptedWorkplace({
        workplaceRef: { processRunId: 22, moduleRef: 'module@1', productionCellId: 'cell', workKey: 'item' },
        processRunId: 22,
        candidateSetRef: authorSet,
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
