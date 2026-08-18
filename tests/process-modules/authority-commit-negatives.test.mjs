// tests/process-modules/authority-commit-negatives.test.mjs
//
// K12 commit 2 — forged and mismatched proof negatives (ADR-081 §2).
//
// THEOREM (currently RED): the acceptance commit site must verify the
// persisted proof BEFORE mutating. A command whose gate reference is
// forged, addresses another CandidateSet, reflects a non-accepted decision,
// a non-terminal run, a receiptless run, or an unfrozen check plan fails
// with a typed AUTHORITY_COMMIT_* error and ZERO mutation (workplace state,
// authority head, and gate tables untouched).
//
// Today the coordinator's accepted branch performs the transition and
// writes the authority head from caller-supplied references WITHOUT any
// verification — every negative below currently sails through. This test
// freezes the defect; K12 commit 3 (the CommitAcceptedCandidate service)
// greens it by making the verified path the only path.
//
// The POSITIVE control (a fully seeded, valid proof) must keep passing at
// every step of the cutover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';

const HEX64 = 'a'.repeat(64);
const ref = asWorkplaceRef({
  processRunId: 1,
  moduleRef: 'solution-formalization@1.0.0',
  productionCellId: 'define-product-contract',
  workKey: 'default',
});
const workplaceKey = serializeWorkplaceRef(ref);

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const authorityHeadRepo = new SqliteAcceptedAuthorityHeadRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo,
    now: () => new Date(),
  });

  // Drive to in_progress/verifying — the author-gate decision point.
  coordinator.materializeCell({
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: ref.workKey,
  });
  coordinator.admitWork(ref);
  const queued = workplaceRepo.read(ref);
  const leased = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: 'execution:author',
  });
  assert.equal(leased.applied, true);
  const started = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: 'execution:author',
  });
  assert.equal(started.applied, true);
  coordinator.sealCandidateSet(ref);
  const gateRepo = new SqliteGateRepository(db);
  const authorityCommit = new CommitAcceptedCandidate({ gateRepo, coordinator });
  activeDb = db;
  return { db, workplaceRepo, authorityHeadRepo, coordinator, gateRepo, authorityCommit };
}

function snapshot(db) {
  return JSON.stringify({
    workplace: db.prepare(
      'SELECT revision,kanban_phase,loop_state,next_role FROM factory_workplaces WHERE workplace_ref=?',
    ).get(workplaceKey),
    head: db.prepare(
      'SELECT * FROM factory_accepted_authority_head WHERE workplace_ref=?',
    ).get(workplaceKey),
    decisions: db.prepare('SELECT COUNT(*) AS n FROM factory_gate_decisions').get().n,
    runs: db.prepare('SELECT COUNT(*) AS n FROM factory_gate_runs').get().n,
  });
}

/** Seed a gate run + accepted final-phase decision (the persisted proof). */
function seedProof(db, options, workplaceRepo) {
  const current = workplaceRepo.read(ref);
  return seedProofAtRevision(db, current.revision, options);
}

function seedProofAtRevision(db, expectedWorkplaceRevision, {
  decisionKey = 'decision:proof',
  subject = 'candidate-set:subject',
  verdict = 'accepted',
  runState = 'terminal',
  withReceipt = true,
  planDigest = HEX64,
} = {}) {
  const gateRunRef = `gate-run:${decisionKey}`;
  // K13 — the subject CandidateSet chain the head's byte-identity resolves
  // through (decision subject -> candidate set -> ordered members). The
  // subject varies per proof; the chain rows are idempotent.
  db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_sets
       (candidate_set_ref, workplace_ref, production_revision_ref, role,
        subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
     VALUES (?, ?, ?, 'author', NULL, ?, ?, ?)`,
  ).run(subject, workplaceKey, `revision:${subject}`, HEX64, `seal:${subject}`, '2026-08-18T00:00:00Z');
  db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_set_members
       (candidate_set_ref, ordinal, product_schema, product_ref,
        product_digest, origin, source_candidate_set_ref)
     VALUES (?, 0, 'factory.product.v1', ?, ?, 'produced', NULL)`,
  ).run(subject, `product:${subject}`, HEX64);
  db.prepare(
    `INSERT INTO factory_gate_runs
       (gate_run_ref,workplace_ref,gate_phase,subject_candidate_set_ref,
        assessment_candidate_set_refs,check_plan_ref,check_plan_digest,
        expected_workplace_revision,gate_lease_ref,state)
     VALUES (?,?,?,?, '[]', 'plan', ?, ?, ?, ?)`,
  ).run(gateRunRef, workplaceKey, 'final', subject, planDigest,
    expectedWorkplaceRevision, `lease:${decisionKey}`, runState);
  const receiptRefs = withReceipt ? JSON.stringify([`receipt:${decisionKey}`]) : '[]';
  // 17 columns; 12 placeholders; literals: 'final','[]','plan','policy','[]'.
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (:dk,:wp,:gate,:run,'final',:tr,:subj,'[]',:verdict,
             'plan',:planDigest,'policy',:policyDigest,
             :receiptRefs,:install,'[]',:dd)`,
  ).run({
    dk: decisionKey,
    wp: workplaceKey,
    gate: `gate:${decisionKey}`,
    run: gateRunRef,
    tr: `transition:${decisionKey}`,
    subj: subject,
    verdict,
    planDigest,
    policyDigest: HEX64,
    receiptRefs,
    install: HEX64,
    dd: `digest:${decisionKey}`,
  });
  if (withReceipt) {
    // The real CheckReceipt shape: provider triple + subject binding + outcome.
    // (Decisions are TRIGGER-immutable: the receipt refs ship in the INSERT.)
    db.prepare(
      `INSERT INTO factory_check_receipts
         (check_receipt_ref,check_run_ref,subject_candidate_set_ref,
          assessment_candidate_set_refs,provider_id,provider_version,
          provider_digest,environment_ref,outcome,evidence_refs,
          receipt_digest,created_at)
       VALUES (?,?,?, '[]', 'check.x', '1.0.0', ?, NULL, 'passed', '[]', ?, datetime('now'))`,
    ).run(`receipt:${decisionKey}`, gateRunRef, subject, HEX64, `receipt-digest:${decisionKey}`);
  }
}

function attemptAccept(authorityCommit, { gateDecisionKey, candidateSetRef }) {
  return authorityCommit.commit({
    workplaceRef: ref,
    gateDecisionKey,
    acceptedCandidateSetRef: candidateSetRef,
    acceptedAuthorTaskId: '41',
    expectedRevision: currentRevision(),
    isFinal: true,
    effectRequired: false,
  });
}

let activeDb = null;
function currentRevision() {
  const row = activeDb.prepare(
    'SELECT revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey);
  return row.revision;
}

// ---------------------------------------------------------------------------
// The negatives matrix — each must fail closed with zero mutation.
// ---------------------------------------------------------------------------

const NEGATIVES = [
  {
    name: 'forged gate reference (no persisted decision)',
    seed: () => {},
    command: () => ({ gateDecisionKey: 'decision:forged', candidateSetRef: 'candidate-set:subject' }),
  },
  {
    name: 'decision for ANOTHER CandidateSet',
    seed: (db, repo) => seedProof(db, { subject: 'candidate-set:OTHER' }, repo),
    command: () => ({ gateDecisionKey: 'decision:proof', candidateSetRef: 'candidate-set:subject' }),
  },
  {
    name: 'non-accepted decision verdict',
    seed: (db, repo) => seedProof(db, { verdict: 'repair_required' }, repo),
    command: () => ({ gateDecisionKey: 'decision:proof', candidateSetRef: 'candidate-set:subject' }),
  },
  {
    name: 'non-terminal gate run (decided without terminal receipts)',
    seed: (db, repo) => seedProof(db, { runState: 'decided', withReceipt: false }, repo),
    command: () => ({ gateDecisionKey: 'decision:proof', candidateSetRef: 'candidate-set:subject' }),
  },
  {
    name: 'terminal run with ZERO check receipts',
    seed: (db, repo) => seedProof(db, { withReceipt: false }, repo),
    command: () => ({ gateDecisionKey: 'decision:proof', candidateSetRef: 'candidate-set:subject' }),
  },
  {
    name: 'unfrozen check plan (empty plan digest)',
    seed: (db, repo) => seedProof(db, { planDigest: '' }, repo),
    command: () => ({ gateDecisionKey: 'decision:proof', candidateSetRef: 'candidate-set:subject' }),
  },
];

for (const negative of NEGATIVES) {
  test(`K12/negative (RED until the service lands): ${negative.name} fails closed with zero mutation`, () => {
    const { db, authorityCommit, workplaceRepo } = fixture();
    negative.seed(db, workplaceRepo);
    const before = snapshot(db);

    assert.throws(
      () => attemptAccept(authorityCommit, negative.command()),
      /AUTHORITY_COMMIT_|GATE_PROOF|GATE_DECISION_HEAD_AUTHORITY_MISMATCH/u,
      'the acceptance commit site must verify the persisted proof',
    );

    assert.equal(snapshot(db), before,
      'a rejected proof mutates NOTHING — no transition, no head, no decision writes');
  });
}

// ---------------------------------------------------------------------------
// Positive control — a fully seeded valid proof commits (and must keep
// committing through the service after the cutover).
// ---------------------------------------------------------------------------

test('K12/positive control: a valid persisted proof commits the acceptance', () => {
  const { db, authorityCommit, workplaceRepo } = fixture();
  seedProof(db, {}, workplaceRepo);
  const result = attemptAccept(authorityCommit, {
    gateDecisionKey: 'decision:proof',
    candidateSetRef: 'candidate-set:subject',
  });
  assert.ok(result);
  const head = db.prepare(
    'SELECT accepted_author_candidate_set_ref FROM factory_accepted_authority_head WHERE workplace_ref=?',
  ).get(workplaceKey);
  assert.equal(head.accepted_author_candidate_set_ref, 'candidate-set:subject');
  const state = db.prepare(
    'SELECT loop_state,terminal_reason FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey);
  assert.equal(state.loop_state, 'terminal');
  assert.equal(state.terminal_reason, 'accepted');
});


test('K12/capability removal: the coordinator rejects direct accepted-truth commits', () => {
  const { coordinator, workplaceRepo, db } = fixture();
  seedProof(db, {}, workplaceRepo);
  assert.throws(
    () => coordinator.applyGateDecision(ref, {
      verdict: 'accepted',
      isFinal: true,
      acceptedCandidateSetRef: 'candidate-set:subject',
      gateDecisionKey: 'decision:proof',
      acceptedAuthorTaskId: '41',
    }),
    /GATE_PROOF_VERIFICATION_REQUIRED/u,
    'ADR-081: callers cannot supply accepted material truth directly',
  );
});


test('K12/negative: an author-phase decision cannot authorize a FINAL acceptance commit', () => {
  const { db, authorityCommit } = fixture();
  // Author-phase proof (the with-review handoff shape) presented for a
  // no-review FINAL acceptance - the phase must match the acceptance kind.
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:author-phase',?,?,?,'author',?,
             'candidate-set:subject','[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(
    workplaceKey, 'gate:author-phase', 'gate-run:author-phase', 'transition:author-phase',
    HEX64, HEX64, HEX64, 'digest:author-phase',
  );
  const before = snapshot(db);
  assert.throws(
    () => authorityCommit.commit({
      workplaceRef: ref,
      gateDecisionKey: 'decision:author-phase',
      acceptedCandidateSetRef: 'candidate-set:subject',
      expectedRevision: currentRevision(),
      isFinal: true,
    }),
    /AUTHORITY_COMMIT_DECISION_PHASE_MISMATCH/u,
  );
  assert.equal(snapshot(db), before);
});
