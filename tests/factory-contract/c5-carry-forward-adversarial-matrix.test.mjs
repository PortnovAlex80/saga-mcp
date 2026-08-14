// tests/factory-contract/c5-carry-forward-adversarial-matrix.test.mjs
//
// ADR-053 C5-04 — the adversarial carry-forward-safe regression matrix.
//
// C5 chain landed on this branch:
//   C5-01 (565b999): the accepted-authority head carries accepted_author_task_id.
//   C5-02 (62015eb): at author acceptance the head is bound to the CURRENT
//                    workplace task (via readExecutionReceipt / durable
//                    author-task projection) — NOT submission.task_id (origin)
//                    and NOT ORDER BY t.id DESC (recency).
//   C5-03 (38905a4): the git-integration consumer reads the task from the head
//                    (readAuthorTaskId), fail-closed, with no submission.task_id
//                    and no recency fallback.
//
// This matrix proves that chain is CARRY-FORWARD-SAFE by composing the two
// production APIs end-to-end — the ProductionCellCoordinator (the production
// acceptance API that writes the head) wired to the SqliteProductionCellIntegration
// (the production git-integration consumer that reads it) — under deliberately
// adversarial conditions. Each scenario isolates one pole of the pre-C5 defect
// space (submission.task_id / recency / absent head / stale head) and proves the
// current chain does NOT regress to it:
//
//   M1  integration task comes from the head, NOT submission.task_id
//       (origin submission.task_id=33 is a fully-valid integratable task that the
//        pre-C5-03 `JOIN tasks t ON t.id = s.task_id` WOULD have selected).
//
//   M2  a repair / re-accept cycle RE-BINDS the head to the now-current task;
//       the consumer follows the re-bind, never the stale first value.
//
//   M3  no head recorded at all → DENY (fail-closed) on BOTH integrate (throw)
//       and observe (blocked); the origin task is NOT mutated (no fallback).
//
//   M4  head exists but its task identity is NULL (pre-C5-02 wiring shape) → DENY
//       (fail-closed); the origin task is NOT mutated (no fallback).
//
//   M5  a newer-task decoy (highest id, same workplace, valid execution_mode) AND
//       an origin-submission decoy (task_id pointing elsewhere) do NOT divert —
//       the head's task wins over both recency and origin simultaneously.
//
// Authority/head/acceptance state is constructed EXCLUSIVELY via the production
// coordinator API (applyGateDecision writes the head atomically with the CAS
// transition, exactly as in production). The surrounding fixture rows (candidate
// sets, managed submissions, gate decisions, task rows) are the "given world" the
// consumer reads — they are NOT authority state and are set up via SQL, mirroring
// the existing C5-03 infrastructure test style.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteProductionCellIntegration } from '../../dist/infrastructure/workplace/sqlite-production-cell-integration.js';
import { SqliteManagedNodeSubmissionRepository } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const SCHEMA = 'factory.source-change-candidate.v1';
const REVIEW_SCHEMA = 'factory.development-review-verdict.v1';
const HEX64 = 'a'.repeat(64);

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Create a git repo with a base commit on `dev` and a candidate commit on a
 * saga candidate ref. Returns the SHAs the integration payload must reference.
 */
function makeGitRepo(marker) {
  const root = mkdtempSync(join(tmpdir(), `saga-c5-matrix-${marker}-`));
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Saga Test');
  git(root, 'config', 'user.email', 'saga@example.test');
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'candidate');
  writeFileSync(join(root, 'app.txt'), `candidate-${marker}\n`);
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'candidate');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
  git(root, 'update-ref', `refs/saga/candidates/${marker}`, sourceCommit);
  git(root, 'checkout', 'dev');
  return { root, base, sourceCommit, sourceTree };
}

/**
 * Build the in-memory world: schema, project/epic/repository rows, the
 * production coordinator (with its authority-head dependency), the integration
 * consumer, and a Workplace driven through the production lifecycle up to
 * (but not including) the author-gate acceptance. Returns every handle a
 * scenario needs. The authority head is NOT written here — each scenario writes
 * (or deliberately omits) it via the production coordinator API.
 */
function makeWorld(marker, { workKey = 'item' } = {}) {
  const { root, base, sourceCommit, sourceTree } = makeGitRepo(marker);

  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Match the C5-03 test: instantiate the managed-submission repository so any
  // construction-time schema/triggers it owns are present.
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

  const ref = asWorkplaceRef({
    processRunId: 22,
    moduleRef: 'module@1',
    productionCellId: 'cell',
    workKey,
  });
  const workplace = serializeWorkplaceRef(ref);

  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const authorityHeadRepo = new SqliteAcceptedAuthorityHeadRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo,
    now: () => new Date(),
  });
  const integration = new SqliteProductionCellIntegration(db, authorityHeadRepo);

  // Drive the production lifecycle: materialize → admit → lease → running → seal.
  coordinator.materializeCell({
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: ref.workKey,
  });
  coordinator.admitWork(ref);
  projectWorkerStarted(workplaceRepo, ref);
  coordinator.sealCandidateSet(ref);
  // Workplace is now in_progress/verifying — ready for an author-gate decision.

  return {
    root, db, ref, workplace, base, sourceCommit, sourceTree,
    workplaceRepo, authorityHeadRepo, coordinator, integration,
  };
}

/** Simulate the dispatcher's projected lease/start events (CAS transitions). */
function projectWorkerStarted(workplaceRepo, ref, reservationRef = 'execution:author') {
  const queued = workplaceRepo.read(ref);
  const leased = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(leased.applied, true);
  const started = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(started.applied, true);
}

/**
 * Insert a task row that is a fully-valid git-integration target for `workplace`
 * (execution_mode IN ('git_change','artifact_change'), project_repository_id=1).
 * This is the shape the pre-C5 consumer's `JOIN tasks t ON t.id = ...` would
 * resolve, so a decoy task created here WOULD have been selected by a fallback.
 */
function insertTask(db, { id, workplace, title = 'author', executionMode = 'artifact_change', integrationState = 'not_required' }) {
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
        integration_state,metadata)
     VALUES (?,1,?,'done',?, ?,1,?,'{"role":"author"}')`,
  ).run(id, title, workplace, executionMode, integrationState);
}

/**
 * Insert the full acceptance fixture chain for `authorSetRef`: a source-change
 * managed submission (carrying the git payload, with `originTaskId` as its
 * task_id — the ADVERSARIAL origin-process task), the author CandidateSet +
 * member, a reviewer CandidateSet + review-verdict submission, and the final
 * accepted gate decision. This is the "given world" the integration consumer
 * joins across; none of it is authority/head state.
 */
function insertAcceptanceChain(db, opts) {
  const {
    workplace, authorSetRef, sourceSubId, originTaskId,
    sourceCommit, sourceTree, base, marker, workKey,
  } = opts;

  const sourcePayload = {
    workItemKey: workKey,
    terminalStatus: 'complete',
    source: { branch: `refs/saga/candidates/${marker}`, commitSha: sourceCommit },
    snapshot: { commitSha: sourceCommit, treeSha: sourceTree },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: base },
  };
  const sourceDigest = sha(sourcePayload);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (91,22,'module@1','cell',1,?,'origin-author',?,?,?)`,
  ).run(originTaskId, SCHEMA, JSON.stringify(sourcePayload), sourceDigest);

  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,'revision/sha256:test-author','author',NULL,?,'seal:x',datetime('now'))`,
  ).run(authorSetRef, workplace, HEX64);

  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'carried-forward','candidate-set/origin-author')`,
  ).run(authorSetRef, SCHEMA, `managed-node-submission:${sourceSubId}`, sourceDigest);

  // Review verdict (approved) over the author set — required for a real merge.
  const reviewerSetRef = `${authorSetRef}:reviewer`;
  const reviewPayload = {
    verdict: 'approved',
    subject_candidate_set_ref: authorSetRef,
    findings: [],
  };
  const reviewDigest = sha(reviewPayload);
  const reviewSubId = sourceSubId + 1;
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (?,22,'module@1','cell',2,0,'reviewer',?,?,?)`,
  ).run(reviewSubId, REVIEW_SCHEMA, JSON.stringify(reviewPayload), reviewDigest);

  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,'revision/sha256:test-reviewer','reviewer',?,?,'seal:r',datetime('now'))`,
  ).run(reviewerSetRef, workplace, authorSetRef, HEX64);

  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'produced',NULL)`,
  ).run(reviewerSetRef, REVIEW_SCHEMA, `managed-node-submission:${reviewSubId}`, reviewDigest);

  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:final',?,'gate:final','run:final','final','transition:final',
        ?,?,'accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(
    workplace, authorSetRef, JSON.stringify([reviewerSetRef]),
    HEX64, HEX64, HEX64, HEX64,
  );

  return { sourceDigest, reviewerSetRef };
}

/** Drive the production coordinator's author-gate acceptance (writes the head). */
function acceptAuthor(db, coordinator, ref, { candidateSetRef, gateDecisionKey, authorTaskId }) {
  const expectedRevision = coordinator.readState(ref).revision;
  const gateRunRef = `gate-run:${gateDecisionKey}`;
  db.prepare(
    `INSERT INTO factory_gate_runs
       (gate_run_ref,workplace_ref,gate_phase,subject_candidate_set_ref,
        assessment_candidate_set_refs,check_plan_ref,check_plan_digest,
        expected_workplace_revision,gate_lease_ref,state)
     VALUES (?,?, 'author',?,'[]','plan',?,?,?,'decided')`,
  ).run(gateRunRef, serializeWorkplaceRef(ref), candidateSetRef, HEX64, expectedRevision, `lease:${gateDecisionKey}`);
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (?,?,?,?,'author',?,?,'[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(
    gateDecisionKey, serializeWorkplaceRef(ref), `gate:${gateDecisionKey}`, gateRunRef,
    `transition:${gateDecisionKey}`, candidateSetRef, HEX64, HEX64, HEX64, sha(gateDecisionKey),
  );
  coordinator.applyGateDecision(ref, {
    verdict: 'accepted',
    isFinal: false,
    acceptedCandidateSetRef: candidateSetRef,
    gateDecisionKey,
    acceptedAuthorTaskId: authorTaskId,
  });
}

/** Force the workplace back to in_progress/verifying (a repair cycle's return). */
function forceAuthorVerifying(workplaceRepo, ref, reservationRef) {
  const cur = workplaceRepo.read(ref);
  const forced = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: cur.revision,
    kanbanPhase: 'in_progress',
    loopState: 'verifying',
    nextRole: 'author',
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(forced.applied, true);
}

function integrationInput(w, authorSetRef) {
  return {
    workplaceRef: w.ref,
    processRunId: w.ref.processRunId,
    candidateSetRef: authorSetRef,
    expectedProductSchema: SCHEMA,
  };
}

function taskIntegrationState(db, id) {
  return db.prepare('SELECT integration_state FROM tasks WHERE id=?').get(id)?.integration_state;
}

function cleanup(w) {
  w.db.close();
  rmSync(w.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// M1 — carry-forward-safe: integration task comes from the HEAD, not
// submission.task_id. The origin submission's task (33) is a fully-valid
// integratable task that the pre-C5-03 consumer (`JOIN tasks t ON t.id =
// s.task_id`) WOULD have selected and mutated.
// ---------------------------------------------------------------------------

test('M1: integration binds the head task, not submission.task_id (origin process task)', () => {
  const w = makeWorld('m1');
  try {
    // The CURRENT workplace task — what the head will carry.
    const HEAD_TASK = 44;
    // The ORIGIN process's task — what submission.task_id records. A fully valid
    // integratable task the pre-C5 consumer would have fallen back to.
    const ORIGIN_TASK = 33;
    const authorSet = 'candidate-set/m1-author';

    insertTask(w.db, { id: HEAD_TASK, workplace: w.workplace });
    insertTask(w.db, { id: ORIGIN_TASK, workplace: w.workplace });
    insertAcceptanceChain(w.db, {
      workplace: w.workplace, authorSetRef: authorSet, sourceSubId: 91,
      originTaskId: ORIGIN_TASK, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
      base: w.base, marker: 'm1', workKey: w.ref.workKey,
    });

    // Production acceptance API writes the head with the CURRENT task (44).
    acceptAuthor(w.db, w.coordinator, w.ref, {
      candidateSetRef: authorSet,
      gateDecisionKey: 'gate-decision/m1-author',
      authorTaskId: String(HEAD_TASK),
    });

    const result = w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(result.outcome, 'succeeded');
    // The integration operated on the HEAD's task (44), NOT the submission's task (33).
    assert.equal(result.taskId, HEAD_TASK,
      'M1: integration binds the head task, not submission.task_id');
    assert.equal(taskIntegrationState(w.db, HEAD_TASK), 'merged');
    // The origin task is untouched — no fallback to submission.task_id occurred.
    assert.equal(taskIntegrationState(w.db, ORIGIN_TASK), 'not_required',
      'M1: origin submission task must NOT be mutated');
  } finally {
    cleanup(w);
  }
});

// ---------------------------------------------------------------------------
// M2 — repair / re-accept RE-BINDS the head. A first author acceptance binds
// task-A; a repair cycle returns the author and a second acceptance re-binds
// task-B. The consumer must follow the RE-BOUND head (task-B), never the stale
// first value (task-A).
// ---------------------------------------------------------------------------

test('M2: a repair/re-accept cycle RE-BINDS the head — consumer follows the now-current task, not the stale one', () => {
  const w = makeWorld('m2');
  try {
    const TASK_A = 501;
    const TASK_B = 502;
    const authorSet1 = 'candidate-set/m2-attempt-1';
    const authorSet2 = 'candidate-set/m2-attempt-2';

    insertTask(w.db, { id: TASK_A, workplace: w.workplace });
    insertTask(w.db, { id: TASK_B, workplace: w.workplace });
    // The current acceptance chain (attempt-2) is what the consumer integrates.
    // Its origin submission records task-A (the prior attempt's task) — the
    // adversarial pole the pre-C5 consumer would have fallen back to.
    insertAcceptanceChain(w.db, {
      workplace: w.workplace, authorSetRef: authorSet2, sourceSubId: 91,
      originTaskId: TASK_A, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
      base: w.base, marker: 'm2', workKey: w.ref.workKey,
    });

    // First author acceptance: head binds task-A (attempt-1).
    acceptAuthor(w.db, w.coordinator, w.ref, {
      candidateSetRef: authorSet1,
      gateDecisionKey: 'gate-decision/m2-rev-1',
      authorTaskId: String(TASK_A),
    });
    let head = w.authorityHeadRepo.read(w.workplace);
    assert.equal(head.acceptedAuthorTaskId, String(TASK_A));

    // Repair cycle returns the author to a fresh verifying visit.
    forceAuthorVerifying(w.workplaceRepo, w.ref, 'execution:repair-2');
    // Second acceptance: head RE-BINDS to task-B (attempt-2).
    acceptAuthor(w.db, w.coordinator, w.ref, {
      candidateSetRef: authorSet2,
      gateDecisionKey: 'gate-decision/m2-rev-3',
      authorTaskId: String(TASK_B),
    });
    head = w.authorityHeadRepo.read(w.workplace);
    assert.equal(head.acceptedAuthorTaskId, String(TASK_B),
      'M2: head re-bound to the now-current task');
    assert.equal(head.acceptedAuthorCandidateSetRef, authorSet2);

    // The consumer integrates the CURRENT candidate set and must read the
    // RE-BOUND head (task-B), not the stale first value (task-A).
    const result = w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet2));
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.taskId, TASK_B,
      'M2: consumer follows the re-bound head, not the stale task');
    assert.equal(taskIntegrationState(w.db, TASK_B), 'merged');
    assert.equal(taskIntegrationState(w.db, TASK_A), 'not_required',
      'M2: stale task-A must NOT be mutated');
  } finally {
    cleanup(w);
  }
});

// ---------------------------------------------------------------------------
// M3 — fail-closed (no head). No authority head has been recorded. The origin
// submission's task (33) EXISTS and is a fully-valid integratable target. The
// consumer MUST deny (throw on integrate / block on observe) rather than fall
// back to the origin task or the newest task.
// ---------------------------------------------------------------------------

test('M3: no authority head → DENY (fail-closed); no fallback to origin/recency task', () => {
  const w = makeWorld('m3');
  try {
    const ORIGIN_TASK = 33;
    const NEWEST_TASK = 999;
    const authorSet = 'candidate-set/m3-author';

    // Both the origin task and a newer task exist and are valid targets.
    insertTask(w.db, { id: ORIGIN_TASK, workplace: w.workplace });
    insertTask(w.db, { id: NEWEST_TASK, workplace: w.workplace });
    insertAcceptanceChain(w.db, {
      workplace: w.workplace, authorSetRef: authorSet, sourceSubId: 91,
      originTaskId: ORIGIN_TASK, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
      base: w.base, marker: 'm3', workKey: w.ref.workKey,
    });

    // NOTE: no coordinator acceptance — no authority head recorded at all.
    assert.equal(w.authorityHeadRepo.readAuthorTaskId(w.workplace), null);

    // Integrate path: fails closed (throws) — does NOT fall back.
    assert.throws(
      () => w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet)),
      (err) => {
        assert.match(err.message, /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/);
        assert.match(err.message, /accepted-authority head has no accepted author task/);
        return true;
      },
    );
    // Observe path: fails closed (blocked) — does NOT fall back.
    const observation = w.integration.observeAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(observation.outcome, 'blocked');
    assert.match(observation.reason, /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/);

    // Neither the origin task nor the newest task was mutated — no fallback.
    assert.equal(taskIntegrationState(w.db, ORIGIN_TASK), 'not_required');
    assert.equal(taskIntegrationState(w.db, NEWEST_TASK), 'not_required');
  } finally {
    cleanup(w);
  }
});

// ---------------------------------------------------------------------------
// M4 — fail-closed (head present, task identity NULL). The head is recorded
// (the C1 author-candidate pointer exists) but its accepted_author_task_id is
// NULL — the pre-C5-02 wiring shape. The consumer MUST deny even though the
// C1 pointer and the origin task both exist.
// ---------------------------------------------------------------------------

test('M4: head present but task identity NULL → DENY (fail-closed); no fallback to origin task', () => {
  const w = makeWorld('m4');
  try {
    const ORIGIN_TASK = 33;
    const authorSet = 'candidate-set/m4-author';

    insertTask(w.db, { id: ORIGIN_TASK, workplace: w.workplace });
    insertAcceptanceChain(w.db, {
      workplace: w.workplace, authorSetRef: authorSet, sourceSubId: 91,
      originTaskId: ORIGIN_TASK, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
      base: w.base, marker: 'm4', workKey: w.ref.workKey,
    });

    // Production acceptance API writes the head with the C1 pointer but a NULL
    // task identity (acceptedAuthorTaskId omitted — the pre-C5-02 shape).
    acceptAuthor(w.db, w.coordinator, w.ref, {
      candidateSetRef: authorSet,
      gateDecisionKey: 'gate-decision/m4-author',
      // acceptedAuthorTaskId intentionally omitted → head records NULL.
    });
    const head = w.authorityHeadRepo.read(w.workplace);
    assert.ok(head, 'C1 pointer is recorded');
    assert.equal(head.acceptedAuthorTaskId, null, 'task identity is NULL (pre-C5-02 shape)');

    // Integrate path: fails closed (throws).
    assert.throws(
      () => w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet)),
      /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/,
    );
    // Observe path: fails closed (blocked).
    const observation = w.integration.observeAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(observation.outcome, 'blocked');
    assert.match(observation.reason, /PRODUCTION_CELL_INTEGRATION_TASK_MISSING/);

    // The origin task is NOT mutated — no fallback despite a valid target existing.
    assert.equal(taskIntegrationState(w.db, ORIGIN_TASK), 'not_required');
  } finally {
    cleanup(w);
  }
});

// ---------------------------------------------------------------------------
// M5 — decoy diversion resistance. The head binds task 44. TWO adversarial
// decoys are present simultaneously:
//   (a) a NEWER task 999 (highest id, same workplace, valid execution_mode) —
//       the recency pole (`ORDER BY t.id DESC LIMIT 1`); AND
//   (b) the origin submission's task_id=33 — the origin pole.
// Neither diverts the binding: the integration still binds the head's task 44.
// ---------------------------------------------------------------------------

test('M5: a newer-task decoy and an origin-submission decoy do NOT divert the head binding', () => {
  const w = makeWorld('m5');
  try {
    const HEAD_TASK = 44;
    const ORIGIN_TASK = 33;
    const NEWEST_DECOY = 999;
    const authorSet = 'candidate-set/m5-author';

    insertTask(w.db, { id: HEAD_TASK, workplace: w.workplace });
    insertTask(w.db, { id: ORIGIN_TASK, workplace: w.workplace });
    // The decoy is a fully-valid integratable task with the HIGHEST id for this
    // workplace. A recency consumer (`ORDER BY t.id DESC`) would pick this one.
    insertTask(w.db, { id: NEWEST_DECOY, workplace: w.workplace, title: 'recency-decoy' });
    insertAcceptanceChain(w.db, {
      workplace: w.workplace, authorSetRef: authorSet, sourceSubId: 91,
      originTaskId: ORIGIN_TASK, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
      base: w.base, marker: 'm5', workKey: w.ref.workKey,
    });

    acceptAuthor(w.db, w.coordinator, w.ref, {
      candidateSetRef: authorSet,
      gateDecisionKey: 'gate-decision/m5-author',
      authorTaskId: String(HEAD_TASK),
    });

    const result = w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.taskId, HEAD_TASK,
      'M5: head task wins over both the recency decoy (999) and the origin task (33)');
    assert.equal(taskIntegrationState(w.db, HEAD_TASK), 'merged');
    assert.equal(taskIntegrationState(w.db, NEWEST_DECOY), 'not_required',
      'M5: recency decoy must NOT be mutated');
    assert.equal(taskIntegrationState(w.db, ORIGIN_TASK), 'not_required',
      'M5: origin task must NOT be mutated');
  } finally {
    cleanup(w);
  }
});
