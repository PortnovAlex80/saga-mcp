// tests/infrastructure/author-carry-forward-sibling-merge.test.mjs
//
// PREVENTIVE-HUNT Layer 7, X-6 — "Sibling merge kills continuation".
//
// The normative parallel-desk story (CONVEYOR-MENTAL-MODEL §17, parallel
// workKeys): a sibling desk's successful integration advances the SHARED
// integration branch between the author seal and the continuation's
// carry-forward authorization. That advance is a legitimate merge — the sealed
// task branch still points at the sealed source commit and the new head is a
// DESCENDANT of the sealed base.
//
// The defect (carry-forward:401-413, :619-624, :443-455): every one of those
// lawful advances tripped a typed drift throw (AUTHOR_CARRY_FORWARD_GIT_
// IDENTITY_DRIFT / TARGET_BASE_DRIFT), the retry then hit IDEMPOTENCY_MISMATCH
// territory, and the continuation died permanently with no repair path.
//
// Proves, through the REAL seams (real temp git repo, real
// authorizeEligibleAuthorCandidateCarryForward, real SqliteAuthorCandidate-
// CarryForward.resolve, REAL git ancestry):
//
//   SM1 first authorization TOLERATES a sibling merge that advanced the
//       integration branch past the sealed base (no prior row): records the
//       authorization with the NEW head as expectedIntegrationHead — instead
//       of throwing AUTHOR_CARRY_FORWARD_GIT_IDENTITY_DRIFT;
//   SM2 a retry after a recorded authorization whose head legitimately moved
//       forward records a SUPERSEDING append-only authorization referencing
//       the predecessor (old row byte-intact) — instead of dying on
//       IDEMPOTENCY_MISMATCH / drift; a second advance chains onto the first
//       supersession;
//   SM3 fail-closed: a NON-descendant head (force-move/rebase of the
//       integration branch) still throws AUTHOR_CARRY_FORWARD_GIT_IDENTITY_
//       DRIFT — the gate is not weakened;
//   SM4 fail-closed: a force-moved sealed task branch still throws;
//   SM5 resolve() tolerates a head that advanced FORWARD past the sealed
//       expectation (a merge of our own/sibling material) — instead of
//       throwing AUTHOR_CARRY_FORWARD_TARGET_BASE_DRIFT;
//   SM6 fail-closed: resolve() still throws TARGET_BASE_DRIFT for a
//       NON-descendant head;
//   SM7 resolve() presents the SUPERSEDING authorization (the current
//       authority), not the stale predecessor.
//
// BEFORE the fix SM1/SM2/SM5/SM7 are RED on the drift/idempotency throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { asWorkplaceRef, serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { candidateSetDigestForRevision } from '../../dist/process-modules/domain/workplace/candidate-set.js';
import {
  authorizeEligibleAuthorCandidateCarryForward,
  REVIEW_SCHEMA_FAILURE_CODE,
  SqliteAuthorCandidateCarryForward,
} from '../../dist/infrastructure/workplace/sqlite-author-candidate-carry-forward.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const OUT_SCHEMA = 'factory.source-change-candidate.v1';
const REVIEW_SCHEMA = 'factory.development-review-verdict.v1';
const HEX64 = 'c'.repeat(64);
// The LITERAL historical parent error that classifies the failure boundary as
// REVIEW_SCHEMA_FAILURE_CODE (the includes() match in the authorize path).
const PARENT_ERROR =
  "review verdict contract expected exactly one 'factory.development-review-verdict.v1', received 0";
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo: dev at base B; sealed author branch 'task/7' at sourceCommit S. */
function makeGitRepo(marker) {
  const root = mkdtempSync(join(tmpdir(), `saga-x6-${marker}-`));
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Saga Test');
  git(root, 'config', 'user.email', 'saga@example.test');
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'task/7');
  writeFileSync(join(root, 'app.txt'), `author-${marker}\n`);
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'author');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
  git(root, 'checkout', 'dev');
  return { root, base, sourceCommit, sourceTree };
}

/** A sibling desk's successful integration: merge commit on dev over `over`. */
function siblingMerge(root, marker, over) {
  git(root, 'checkout', '-b', `sib/${marker}`, over);
  writeFileSync(join(root, `sibling-${marker}.txt`), `sibling ${marker}\n`);
  git(root, 'add', `sibling-${marker}.txt`);
  git(root, 'commit', '-m', `sibling ${marker}`);
  git(root, 'checkout', 'dev');
  git(root, 'merge', '--no-ff', '-m', `integrate sibling ${marker}`, `sib/${marker}`);
  return git(root, 'rev-parse', 'HEAD');
}

/** Force-move dev to an unrelated root commit (non-descendant of everything). */
function forceMoveDev(root, marker) {
  const unrelated = execFileSync('git', [
    '-C', root, 'commit-tree', EMPTY_TREE, '-m', `unrelated ${marker}`,
  ], { encoding: 'utf8', env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@x.test',
    GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: 'x@x.test',
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
  } }).trim();
  git(root, 'update-ref', 'refs/heads/dev', unrelated);
  return unrelated;
}

/**
 * The full authorize() "given world" for the REVIEW_SCHEMA failure boundary:
 * failed parent lifecycle/stage/process rows, the continuation, the source
 * workplace at review_in_progress/verifying/reviewer, the author CandidateSet
 * (real digest), the accepted-authority head, author+reviewer tasks and
 * intents, the wrong-schema reviewer submission, the author managed submission
 * carrying the git identity, and the accepted author gate decision.
 */
function makeWorld(marker) {
  const repo = makeGitRepo(marker);
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryLifecycleRunSchema(db);
  ensureManagedNodeSubmissionSchema(db);
  db.pragma('foreign_keys=OFF');

  db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
  db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repo.root);

  const sourceRef = asWorkplaceRef({
    processRunId: 8,
    moduleRef: 'module@1',
    productionCellId: 'cell',
    workKey: 'item-1',
  });
  const SOURCE_WORKPLACE = serializeWorkplaceRef(sourceRef);

  // Parent run chain: lifecycle 5 -> stage (solution-development) -> process 8.
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,idempotency_key,
        input_schema,input_snapshot,input_hash,status,entry_stage_id,current_stage_id,error)
     VALUES (5,'l','1','l:x','d','x','{}','h1',1,1,'tester','idem-5','s','{}','h2',
             'failed','solution-development','solution-development',?)`,
  ).run(PARENT_ERROR);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,error)
     VALUES (8,1,1,'m','1','module@1','idem-8','generic-flow','s','{}','h3','failed',?)`,
  ).run(PARENT_ERROR);
  db.prepare(
    `INSERT INTO factory_stage_runs
       (lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,module_ref_key,
        binding_snapshot,binding_hash,input_schema,input_snapshot,input_hash,status,
        process_run_id,error)
     VALUES (5,0,'solution-development',0,'m','1','module@1','{}','hb','s','{}','hi',
             'failed',8,?)`,
  ).run(PARENT_ERROR);

  db.prepare(
    `INSERT INTO factory_orders(order_ref,project_id,epic_id,source_kind,state)
     VALUES ('order:x',1,1,'idea_url','completed')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_continuation_authorizations
       (authorization_ref,schema_id,order_ref,parent_lifecycle_run_id,resume_stage_id,
        expected_parent_version,expected_parent_error,parent_definition_hash,parent_input_hash,
        prefix_snapshot,prefix_hash,child_definition_snapshot,child_definition_hash,
        child_idempotency_key,external_baseline_snapshot,external_baseline_hash,actor_id,
        reason,state)
     VALUES ('continuation:cf1','v1','order:x',5,'solution-development',1,?,'dh','ih',
             '{}','ph','{}','cdh','child-idem','{}','ebh','tester','test','authorized')`,
  ).run(PARENT_ERROR);

  // Source workplace sealed at the review boundary (the review-schema failure
  // story: reviewer ran, submitted the wrong schema, no reviewer set exists).
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,8,'module@1','cell','item-1','review_in_progress','verifying','reviewer',3)`,
  ).run(SOURCE_WORKPLACE);

  // Author CandidateSet with the REAL digest.
  const productionRevisionRef = 'revision/sha256:x6';
  const authorSetDigest = candidateSetDigestForRevision({
    workplaceRef: SOURCE_WORKPLACE,
    productionRevisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
  });
  const authorSetRef = `candidate-set/x6-${marker}-author`;
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'author',NULL,?,'seal:x6',datetime('now'))`,
  ).run(authorSetRef, SOURCE_WORKPLACE, productionRevisionRef, authorSetDigest);

  // Author managed submission carrying the git identity.
  const item = { id: 'item-1', value: `carry ${marker}` };
  const authorPayload = {
    workItemKey: 'item-1',
    terminalStatus: 'complete',
    source: { branch: 'task/7', commitSha: repo.sourceCommit, workItemKey: 'item-1' },
    snapshot: { commitSha: repo.sourceCommit, treeSha: repo.sourceTree },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: repo.base },
  };
  const authorDigest = sha(authorPayload);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (91,8,'module@1','cell',21,11,'exec-author',?,?,?)`,
  ).run(OUT_SCHEMA, JSON.stringify(authorPayload), authorDigest);

  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'produced',NULL)`,
  ).run(authorSetRef, OUT_SCHEMA, 'managed-node-submission:91', authorDigest);

  // Author + reviewer tasks/intents.
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (21,1,'development.author','a','{}',?,'executing',11)`,
  ).run(OUT_SCHEMA);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
        integration_state,metadata)
     VALUES (11,1,'author','done',?,'git_change',1,'not_required',?)`,
  ).run(SOURCE_WORKPLACE, JSON.stringify({
    role: 'author',
    work_intent_id: 21,
    semantic_input_digest: HEX64,
    cell_input_item: item,
  }));
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (22,1,'development.review','r','{}',?,'executing',12)`,
  ).run(REVIEW_SCHEMA);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
        integration_state,metadata)
     VALUES (12,1,'reviewer','done',?,'tracker_only',1,'not_required',?)`,
  ).run(SOURCE_WORKPLACE, JSON.stringify({ role: 'reviewer', work_intent_id: 22 }));

  // The wrong-schema reviewer submission (proves the failure boundary).
  const wrongPayload = { verdict: 'approve', subject: authorSetRef };
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (92,8,'module@1','cell',22,12,'exec-reviewer','factory.wrong.v1',?,?)`,
  ).run(JSON.stringify(wrongPayload), sha(wrongPayload));

  // Accepted author gate decision + accepted-authority head binding task 11.
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:x6-author',?,'gate:x6','run:x6','author','transition:x6',
        ?,'[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(SOURCE_WORKPLACE, authorSetRef, HEX64, HEX64, HEX64, sha('decision:x6-author'));
  db.prepare(
    `INSERT INTO factory_accepted_authority_head
       (workplace_ref,accepted_author_candidate_set_ref,accepted_author_gate_decision_key,
        revision,recorded_at,accepted_author_task_id)
     VALUES (?,?,?,3,datetime('now'),'11')`,
  ).run(SOURCE_WORKPLACE, authorSetRef, 'decision:x6-author');

  return {
    repo, db, item, authorSetRef, authorSetDigest, authorDigest,
    sourceRef, SOURCE_WORKPLACE,
    authorize: () => authorizeEligibleAuthorCandidateCarryForward(db, {
      continuationRef: 'continuation:cf1',
      parentLifecycleRunId: 5,
    }),
  };
}

/** Mark the continuation consumed with child lifecycle 6 / child process 9. */
function consumeContinuation(db) {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,idempotency_key,
        input_schema,input_snapshot,input_hash,status,entry_stage_id)
     VALUES (6,'l','1','l:c','d','x','{}','h1',1,1,'tester','idem-6','s','{}','h2',
             'running','solution-development')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (9,1,1,'m','1','module@1','idem-9','generic-flow','s','{}','h3','running')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,module_ref_key,
        binding_snapshot,binding_hash,input_schema,input_snapshot,input_hash,status,
        process_run_id)
     VALUES (6,0,'solution-development',0,'m','1','module@1','{}','hb','s','{}','hi',
             'running',9)`,
  ).run();
  db.prepare(
    `UPDATE factory_continuation_authorizations
        SET state='consumed',child_lifecycle_run_id=6,consumed_at=datetime('now')
      WHERE authorization_ref='continuation:cf1'`,
  ).run();
}

/** The CHILD author task that resolve() validates the target contract against. */
function insertChildTask(w) {
  const childRef = asWorkplaceRef({
    processRunId: 9,
    moduleRef: 'module@1',
    productionCellId: 'cell',
    workKey: 'item-1',
  });
  const childWorkplace = serializeWorkplaceRef(childRef);
  dbInsertChildTask(w.db, childWorkplace, w.item);
  return { childRef, childWorkplace };
}

function dbInsertChildTask(db, childWorkplace, item) {
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (29,1,'development.author','a','{}',?,'executing',31)`,
  ).run(OUT_SCHEMA);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
        integration_state,metadata)
     VALUES (31,1,'child-author','todo',?,'git_change',1,'not_required',?)`,
  ).run(childWorkplace, JSON.stringify({
    role: 'author',
    work_intent_id: 29,
    semantic_input_digest: sha(`child:${item.id}`),
    cell_input_item: item,
  }));
}

function authorizationRow(db, ref) {
  return db.prepare(
    `SELECT authorization_ref,continuation_ref,evidence_snapshot,evidence_digest,
            eligible_failure_code,authorized_at
       FROM factory_author_candidate_carry_forward_authorizations
      WHERE authorization_ref=?`,
  ).get(ref);
}

function reauthorizationRows(db) {
  return db.prepare(
    `SELECT * FROM factory_author_candidate_carry_forward_reauthorizations
      ORDER BY supersede_ordinal`,
  ).all();
}

function evidenceHead(row) {
  return JSON.parse(row.evidence_snapshot).expectedIntegrationHead;
}

function cleanup(w) {
  w.db.close();
  rmSync(w.repo.root, { recursive: true, force: true });
}

// ===========================================================================
// BLINDSIGHT C3 — eligible_failure_code is loaded from the DB row and thrown
// away in resolve(): the directive delivered the carried material but never
// the REASON the parent died, so the continuation child could not know what
// boundary failed. resolve() must deliver the typed code + the parent error.
// ===========================================================================
test('C3: resolve() delivers eligibleFailureCode and the parent failure error to the child', () => {
  const w = makeWorld('c3-code');
  try {
    const authorized = w.authorize();
    assert.ok(authorized);
    consumeContinuation(w.db);
    const { childRef } = insertChildTask(w);

    const port = new SqliteAuthorCandidateCarryForward(w.db);
    const directive = port.resolve({
      processRunId: 9,
      workplaceRef: childRef,
      semanticInputDigest: sha(`child:${w.item.id}`),
      itemSnapshotHash: sha(w.item),
      expectedProductSchemas: [OUT_SCHEMA],
    });
    assert.ok(directive, 'fixture: the directive must resolve');
    assert.equal(directive.eligibleFailureCode, REVIEW_SCHEMA_FAILURE_CODE,
      'C3: the typed parent failure code must ride the directive');
    assert.equal(directive.parentFailureError, PARENT_ERROR,
      'C3: the exact parent error text must ride the directive');
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM1 — first authorization tolerates a sibling merge (no prior row).
// ===========================================================================
test('SM1: sibling-merged integration head is authorized, not drifted (first authorization)', () => {
  const w = makeWorld('sm1');
  try {
    const siblingHead = siblingMerge(w.repo.root, 'sm1', w.repo.base);
    assert.notEqual(siblingHead, w.repo.base, 'fixture: dev must have advanced');

    const result = w.authorize();
    assert.ok(result, 'SM1: sibling-merged head must authorize (legitimate parallel-desk merge)');
    assert.equal(result.replayed, false);
    const row = authorizationRow(w.db, result.authorizationRef);
    assert.ok(row, 'authorization row recorded');
    assert.equal(evidenceHead(row), siblingHead,
      'the authorization seals the NEW head as expectedIntegrationHead');
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM2 — retry after a recorded authorization whose head moved forward records
// a SUPERSEDING append-only row; a second advance chains. No IDEMPOTENCY death.
// ===========================================================================
test('SM2: retry with advanced head records a superseding authorization chaining the predecessor', () => {
  const w = makeWorld('sm2');
  try {
    const first = w.authorize();
    assert.ok(first);
    assert.equal(first.replayed, false);
    const firstRowBefore = authorizationRow(w.db, first.authorizationRef);

    // Exact retry, unchanged head: idempotent replay (byte-identical evidence).
    const replay = w.authorize();
    assert.equal(replay.authorizationRef, first.authorizationRef);
    assert.equal(replay.replayed, true);

    // The sibling desk integrates between the first authorization and the retry.
    const siblingHead = siblingMerge(w.repo.root, 'sm2', w.repo.base);
    const second = w.authorize();
    assert.ok(second, 'SM2: retry with legitimately advanced head must re-authorize');
    assert.equal(second.replayed, false);
    assert.notEqual(second.authorizationRef, first.authorizationRef,
      'the superseding authorization has a NEW identity');

    // The predecessor row is byte-intact (append-only, immutable).
    const firstRowAfter = authorizationRow(w.db, first.authorizationRef);
    assert.deepEqual(firstRowAfter, firstRowBefore,
      'the predecessor authorization row must remain byte-intact');

    // The superseding row references the predecessor and the new head.
    const reauths = reauthorizationRows(w.db);
    assert.equal(reauths.length, 1, 'exactly one superseding row');
    assert.equal(reauths[0].predecessor_authorization_ref, first.authorizationRef,
      'the superseding row references the predecessor');
    assert.equal(reauths[0].supersede_ordinal, 1);
    assert.equal(evidenceHead(reauths[0]), siblingHead,
      'the superseding row seals the NEW expectedIntegrationHead');

    // A second sibling advance chains onto the first supersession.
    const siblingHead2 = siblingMerge(w.repo.root, 'sm2b', siblingHead);
    const third = w.authorize();
    assert.ok(third);
    assert.notEqual(third.authorizationRef, second.authorizationRef);
    const chained = reauthorizationRows(w.db);
    assert.equal(chained.length, 2);
    assert.equal(chained[1].predecessor_authorization_ref, second.authorizationRef,
      'the second supersession chains onto the first');
    assert.equal(evidenceHead(chained[1]), siblingHead2);
    assert.equal(chained[1].supersede_ordinal, 2);
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM3 — fail-closed: a NON-descendant head (force-move/rebase) still drifts.
// ===========================================================================
test('SM3: non-descendant integration head still fails closed with GIT_IDENTITY_DRIFT', () => {
  const w = makeWorld('sm3');
  try {
    forceMoveDev(w.repo.root, 'sm3');
    assert.throws(
      () => w.authorize(),
      /AUTHOR_CARRY_FORWARD_GIT_IDENTITY_DRIFT/,
      'SM3: a force-moved/rebased integration branch is real drift — the gate must hold',
    );
    assert.equal(reauthorizationRows(w.db).length, 0, 'no row recorded on drift');
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM4 — fail-closed: the sealed task branch itself moved.
// ===========================================================================
test('SM4: force-moved sealed task branch still fails closed with GIT_IDENTITY_DRIFT', () => {
  const w = makeWorld('sm4');
  try {
    // Move the sealed task branch off the sealed source commit.
    git(w.repo.root, 'branch', '-f', 'task/7', w.repo.base);
    assert.throws(
      () => w.authorize(),
      /AUTHOR_CARRY_FORWARD_GIT_IDENTITY_DRIFT/,
      'SM4: the sealed task branch must still point at the sealed source commit',
    );
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM5 — resolve() tolerates a head that advanced FORWARD past the expectation.
// ===========================================================================
test('SM5: resolve tolerates forward-advanced integration head (merge of our own branch)', () => {
  const w = makeWorld('sm5');
  try {
    const authorized = w.authorize();
    assert.ok(authorized);
    consumeContinuation(w.db);
    const { childRef } = insertChildTask(w);

    // The sibling desk merges after the authorization was sealed.
    const siblingHead = siblingMerge(w.repo.root, 'sm5', w.repo.base);
    const port = new SqliteAuthorCandidateCarryForward(w.db);
    const directive = port.resolve({
      processRunId: 9,
      workplaceRef: childRef,
      semanticInputDigest: sha(`child:${w.item.id}`),
      itemSnapshotHash: sha(w.item),
      expectedProductSchemas: [OUT_SCHEMA],
    });
    assert.ok(directive, 'SM5: a forward-advanced head must NOT kill the presentation');
    assert.equal(directive.authorizationRef, authorized.authorizationRef);
    assert.equal(directive.sourceCandidateSetRef, w.authorSetRef);
    void siblingHead;
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM6 — fail-closed: resolve() still throws TARGET_BASE_DRIFT for a
// non-descendant head.
// ===========================================================================
test('SM6: resolve still fails closed on non-descendant head with TARGET_BASE_DRIFT', () => {
  const w = makeWorld('sm6');
  try {
    assert.ok(w.authorize());
    consumeContinuation(w.db);
    const { childRef } = insertChildTask(w);
    forceMoveDev(w.repo.root, 'sm6');
    const port = new SqliteAuthorCandidateCarryForward(w.db);
    assert.throws(
      () => port.resolve({
        processRunId: 9,
        workplaceRef: childRef,
        semanticInputDigest: sha(`child:${w.item.id}`),
        itemSnapshotHash: sha(w.item),
        expectedProductSchemas: [OUT_SCHEMA],
      }),
      /AUTHOR_CARRY_FORWARD_TARGET_BASE_DRIFT/,
      'SM6: a force-moved integration branch is still a typed error at resolve time',
    );
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// SM7 — resolve() presents the SUPERSEDING authorization (current authority).
// ===========================================================================
test('SM7: resolve presents the superseding authorization, not the stale predecessor', () => {
  const w = makeWorld('sm7');
  try {
    const first = w.authorize();
    assert.ok(first);
    const siblingHead = siblingMerge(w.repo.root, 'sm7', w.repo.base);
    const second = w.authorize();
    assert.ok(second);
    assert.notEqual(second.authorizationRef, first.authorizationRef);

    consumeContinuation(w.db);
    const { childRef } = insertChildTask(w);

    // Another sibling merge AFTER the supersession — resolve must still work
    // (the superseding head is an ancestor of the current head).
    siblingMerge(w.repo.root, 'sm7b', siblingHead);

    const port = new SqliteAuthorCandidateCarryForward(w.db);
    const directive = port.resolve({
      processRunId: 9,
      workplaceRef: childRef,
      semanticInputDigest: sha(`child:${w.item.id}`),
      itemSnapshotHash: sha(w.item),
      expectedProductSchemas: [OUT_SCHEMA],
    });
    assert.ok(directive, 'SM7: resolve must present under the sibling-merge norm');
    assert.equal(directive.authorizationRef, second.authorizationRef,
      'the CURRENT authority (superseding row) is presented');
    assert.equal(
      directive.presenterRef,
      `factory-carry-forward-presenter:${second.authorizationRef}`,
    );
  } finally {
    cleanup(w);
  }
});
