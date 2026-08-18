/** ProductionCellCoordinator state-machine tests (Conveyor v4, REG-13). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';

const REF = asWorkplaceRef({
  processRunId: 1,
  moduleRef: 'formalization@1.0.0',
  productionCellId: 'srs-author',
});

function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({ db, workplaceRepo, authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db), now: () => new Date() });
  const authorityCommit = new CommitAcceptedCandidate({ gateRepo, coordinator });
  return { db, workplaceRepo, gateRepo, coordinator, authorityCommit };
}

/** Simulate the canonical dispatcher's projected lease/start events. */
function projectWorkerStarted(workplaceRepo, ref, reservationRef = 'execution:test') {
  const queued = workplaceRepo.read(ref);
  assert.ok(queued);
  const leased = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase === 'review' ? 'review_in_progress' : queued.kanbanPhase,
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

function runningHarness() {
  const h = harness();
  h.coordinator.materializeCell({
    processRunId: 1,
    moduleRef: 'formalization@1.0.0',
    productionCellId: 'srs-author',
  });
  h.coordinator.admitWork(REF);
  projectWorkerStarted(h.workplaceRepo, REF);
  return h;
}

test('REG-13: materialize and admit create todo/idle then in_progress/queued', () => {
  const h = harness();
  const initial = h.coordinator.materializeCell({
    processRunId: 1,
    moduleRef: 'formalization@1.0.0',
    productionCellId: 'srs-author',
  });
  assert.equal(initial.kanbanPhase, 'todo');
  assert.equal(initial.loopState, 'idle');
  const admitted = h.coordinator.admitWork(REF);
  assert.equal(admitted.applied, true);
  assert.equal(admitted.state.kanbanPhase, 'in_progress');
  assert.equal(admitted.state.loopState, 'queued');
  h.db.close();
});

test('REG-13: coordinator has no worker-launch capability', () => {
  const h = harness();
  assert.equal('launchWorker' in h.coordinator, false);
  assert.equal('markWorkerLaunched' in h.coordinator, false);
  h.db.close();
});

test('REG-13: accepted final candidate reaches done/terminal', () => {
  const h = runningHarness();
  const verifying = h.coordinator.sealCandidateSet(REF);
  assert.equal(verifying.state.loopState, 'verifying');
  const final = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(final.state.kanbanPhase, 'done');
  assert.equal(final.state.loopState, 'terminal');
  assert.equal(final.state.terminalReason, 'accepted');
  assert.equal(h.coordinator.isTerminal(REF), true);
  h.db.close();
});

test('REG-13: accepted author candidate hands off to reviewer', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const review = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: false });
  assert.equal(review.state.kanbanPhase, 'review');
  assert.equal(review.state.loopState, 'queued');
  assert.equal(review.state.nextRole, 'reviewer');
  h.db.close();
});

test('REG-13: repair decision waits and requeues the declared role', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const waiting = h.coordinator.applyGateDecision(REF, {
    verdict: 'repair_required',
    isFinal: false,
    repairTargetRole: 'author',
  });
  assert.equal(waiting.state.loopState, 'repair_wait');
  assert.equal(waiting.state.kanbanPhase, 'in_progress');
  const queued = h.coordinator.requeue(REF, 'author');
  assert.equal(queued.state.loopState, 'queued');
  assert.equal(queued.state.nextRole, 'author');
  h.db.close();
});

test('REG-13: repair decision without a role is rejected', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  assert.throws(
    () => h.coordinator.applyGateDecision(REF, { verdict: 'repair_required', isFinal: false }),
    /repairTargetRole/,
  );
  h.db.close();
});

test('REG-13: human-required pauses a blocked workplace', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const blocked = h.coordinator.applyGateDecision(REF, { verdict: 'human_required', isFinal: false });
  assert.equal(blocked.state.kanbanPhase, 'blocked');
  assert.equal(blocked.state.loopState, 'paused');
  h.db.close();
});

test('REG-13: failed gate reaches failed/terminal', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const failed = h.coordinator.applyGateDecision(REF, { verdict: 'failed', isFinal: false });
  assert.equal(failed.state.kanbanPhase, 'failed');
  assert.equal(failed.state.loopState, 'terminal');
  assert.equal(failed.state.terminalReason, 'failed');
  h.db.close();
});

test('REG-13: worker crash keeps Kanban progress and can be retried', () => {
  const h = runningHarness();
  const waiting = h.coordinator.recordWorkerCrash(REF);
  assert.equal(waiting.state.kanbanPhase, 'in_progress');
  assert.equal(waiting.state.loopState, 'repair_wait');
  h.coordinator.requeue(REF, 'author');
  projectWorkerStarted(h.workplaceRepo, REF, 'execution:retry');
  h.coordinator.sealCandidateSet(REF);
  const final = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(final.state.terminalReason, 'accepted');
  h.db.close();
});

// ---------------------------------------------------------------------------
// ADR-053 C5-02 — bind the CURRENT workplace task at final author acceptance.
// The accepted-authority head's accepted_author_task_id is the carry-forward-
// safe task authority: sourced from the worker-execution→task binding at the
// acceptance site (see production-cell-node-executor.test.mjs for the source
// selection), and threaded verbatim through applyGateDecision → record().
// These tests prove the coordinator plumbing: the task id passed to
// applyGateDecision is the task id written on the head, and a repair-cycle
// re-acceptance re-binds it (never a stale value).
// ---------------------------------------------------------------------------

function headRow(db) {
  return db.prepare(
    `SELECT accepted_author_candidate_set_ref AS cs,
            accepted_author_gate_decision_key AS gd,
            revision, accepted_author_task_id AS task
       FROM factory_accepted_authority_head
      ORDER BY workplace_ref LIMIT 1`,
  ).get();
}

function recordAcceptedAuthorDecision(h, candidateSetRef, suffix) {
  const expectedWorkplaceRevision = h.workplaceRepo.read(REF).revision;
  const gateRunRef = `gate-run/${suffix}`;
  const decisionKey = `gate-decision/${suffix}`;
  // K13 — the subject CandidateSet chain the head's byte-identity resolves
  // through (idempotent; one workplace per fixture). The production revision
  // parent row satisfies the FK (this fixture keeps foreign_keys ON), and its
  // material_digest is derived per ref — revisions are UNIQUE(workplace,
  // material_digest), so a shared digest would silently swallow the second
  // attempt's revision (INSERT OR IGNORE) and break the chain FK.
  const chainDigest = createHash('sha256').update(candidateSetRef).digest('hex');
  h.db.prepare(
    `INSERT OR IGNORE INTO factory_workplace_production_revisions
       (revision_ref, workplace_ref, parent_revision_ref, members,
        contributing_execution_refs, presenter_ref, material_digest,
        semantic_digest, sealed_at)
     VALUES (?, (SELECT workplace_ref FROM factory_workplaces LIMIT 1), NULL, '[]', '[]', ?, ?, ?, ?)`,
  ).run(`revision/${candidateSetRef}`, `presenter/${candidateSetRef}`, chainDigest, chainDigest, '2026-08-18T00:00:00Z');
  h.db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_sets
       (candidate_set_ref, workplace_ref, production_revision_ref, role,
        subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
     VALUES (?, (SELECT workplace_ref FROM factory_workplaces LIMIT 1), ?, 'author', NULL, ?, ?, ?)`,
  ).run(candidateSetRef, `revision/${candidateSetRef}`, chainDigest, `seal/${candidateSetRef}`, '2026-08-18T00:00:00Z');
  h.db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_set_members
       (candidate_set_ref, ordinal, product_schema, product_ref,
        product_digest, origin, source_candidate_set_ref)
     VALUES (?, 0, 'factory.product.v1', ?, ?, 'produced', NULL)`,
  ).run(candidateSetRef, `product/${candidateSetRef}`, 'c'.repeat(64));
  h.gateRepo.createGateRun({
    gateRunRef,
    workplaceRef: REF,
    gatePhase: 'author',
    subjectCandidateSetRef: candidateSetRef,
    assessmentCandidateSetRefs: [],
    checkPlanRef: 'plan/author',
    checkPlanDigest: 'd'.repeat(64),
    expectedWorkplaceRevision,
    gateLeaseRef: `lease/${suffix}`,
  });
  const body = {
    workplaceRef: REF,
    gateRef: 'gate/author',
    gateRunRef,
    gatePhase: 'author',
    transitionRef: `transition/${suffix}`,
    subjectCandidateSetRef: candidateSetRef,
    assessmentCandidateSetRefs: [],
    verdict: 'accepted',
    repairTargetRole: null,
    checkPlanRef: 'plan/author',
    checkPlanDigest: 'd'.repeat(64),
    decisionPolicyRef: 'policy/author',
    decisionPolicyDigest: 'p'.repeat(64),
    checkReceiptRefs: [],
    installationDigest: 'i'.repeat(64),
    decisionKey,
    acceptedOutputBindings: [],
    recoveryIssueRef: null,
  };
  h.gateRepo.recordDecision({
    ...body,
    decisionDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
  // ADR-081 (K12): the acceptance commit now requires the FULL proof —
  // a terminal run with at least one recorded receipt.
  h.gateRepo.setGateRunState(gateRunRef, 'terminal');
  h.gateRepo.recordCheckReceipt({
    checkReceiptRef: `receipt/${suffix}`,
    checkRunRef: gateRunRef,
    subjectCandidateSetRef: candidateSetRef,
    assessmentCandidateSetRefs: [],
    check: { providerId: 'check.x', version: '1.0.0', providerDigest: 'c'.repeat(64) },
    environmentRef: null,
    outcome: 'passed',
    evidenceRefs: [],
    receiptDigest: 'r'.repeat(64),
  });
  return decisionKey;
}

/** Force the workplace back to in_progress/verifying (author) via direct CAS,
 * simulating a repair cycle returning the author to a fresh acceptance visit. */
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

test('ADR-053 C5-02: author acceptance writes the current workplace task id onto the authority head', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const decisionKey = recordAcceptedAuthorDecision(h, 'candidate-set/attempt-1', 'author/accepted/rev-1');
  h.authorityCommit.commit({
    workplaceRef: REF,
    gateDecisionKey: decisionKey,
    acceptedCandidateSetRef: 'candidate-set/attempt-1',
    acceptedAuthorTaskId: 'task-42',
    expectedRevision: h.workplaceRepo.read(REF).revision,
    isFinal: false,
  });
  const head = headRow(h.db);
  assert.ok(head, 'C5-02: authority head must be recorded on author acceptance');
  assert.equal(head.cs, 'candidate-set/attempt-1');
  assert.equal(head.gd, 'gate-decision/author/accepted/rev-1');
  // The head carries the CURRENT workplace task bound at acceptance.
  assert.equal(head.task, 'task-42');
  h.db.close();
});

test('ADR-053 C5-02: a repair-cycle re-acceptance re-binds the head task identity to the now-current task', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const firstDecisionKey = recordAcceptedAuthorDecision(h, 'candidate-set/attempt-1', 'author/accepted/rev-1');
  // First author acceptance (with-review): head records the first task.
  h.authorityCommit.commit({
    workplaceRef: REF,
    gateDecisionKey: firstDecisionKey,
    acceptedCandidateSetRef: 'candidate-set/attempt-1',
    acceptedAuthorTaskId: 'task-A',
    expectedRevision: h.workplaceRepo.read(REF).revision,
    isFinal: false,
  });
  let head = headRow(h.db);
  assert.equal(head.cs, 'candidate-set/attempt-1');
  assert.equal(head.task, 'task-A');
  const firstRevision = head.revision;

  // A repair cycle returns the author to verifying and a NEW author CandidateSet
  // is accepted. The head must re-bind to the now-current task — not stay stale.
  forceAuthorVerifying(h.workplaceRepo, REF, 'execution:repair-2');
  const secondDecisionKey = recordAcceptedAuthorDecision(h, 'candidate-set/attempt-2', 'author/accepted/rev-3');
  h.authorityCommit.commit({
    workplaceRef: REF,
    gateDecisionKey: secondDecisionKey,
    acceptedCandidateSetRef: 'candidate-set/attempt-2',
    acceptedAuthorTaskId: 'task-B',
    expectedRevision: h.workplaceRepo.read(REF).revision,
    isFinal: false,
  });
  head = headRow(h.db);
  assert.equal(head.cs, 'candidate-set/attempt-2', 'C1 pointer re-binds to the new accepted set');
  assert.ok(head.revision > firstRevision, 'head was re-recorded at the new acceptance revision');
  // Task identity re-binds to the now-current task, NOT the stale first task.
  assert.equal(head.task, 'task-B');
  h.db.close();
});

test('ADR-053 C5-02: acceptance without a resolvable task leaves the head task identity null (C1 pointer still recorded)', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const decisionKey = recordAcceptedAuthorDecision(h, 'candidate-set/1', '1');
  h.authorityCommit.commit({
    workplaceRef: REF,
    gateDecisionKey: decisionKey,
    acceptedCandidateSetRef: 'candidate-set/1',
    // acceptedAuthorTaskId omitted: the acceptance site could not resolve a task.
    expectedRevision: h.workplaceRepo.read(REF).revision,
    isFinal: false,
  });
  const head = headRow(h.db);
  assert.ok(head);
  assert.equal(head.cs, 'candidate-set/1');
  assert.equal(head.task, null);
  h.db.close();
});

test('ADR-053 B-6: stale GateDecision rolls back the Workplace CAS and never advances applied head', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const decisionKey = recordAcceptedAuthorDecision(h, 'candidate-set/stale', 'stale');

  const sealed = h.workplaceRepo.read(REF);
  const concurrent = h.workplaceRepo.applyTransition({
    workplaceRef: REF,
    expectedRevision: sealed.revision,
    kanbanPhase: sealed.kanbanPhase,
    loopState: sealed.loopState,
    nextRole: sealed.nextRole,
    terminalReason: sealed.terminalReason,
    activeGateRef: 'gate/concurrent-owner',
  });
  assert.equal(concurrent.applied, true);
  const before = h.workplaceRepo.read(REF);

  assert.throws(
    () => h.authorityCommit.commit({
      workplaceRef: REF,
      gateDecisionKey: decisionKey,
      acceptedCandidateSetRef: 'candidate-set/stale',
      expectedRevision: before.revision,
      isFinal: false,
    }),
    /AUTHORITY_COMMIT_REVISION_STALE|GATE_DECISION_HEAD_AUTHORITY_MISMATCH/,
  );
  assert.deepEqual(h.workplaceRepo.read(REF), before, 'failed authority check rolls back CAS');
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_gate_decision_heads').get().n,
    0,
  );
  h.db.close();
});
