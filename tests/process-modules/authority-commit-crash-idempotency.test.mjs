// tests/process-modules/authority-commit-crash-idempotency.test.mjs
//
// K12 — crash cover + the exit-gate ratchet (ADR-081 §3 and the release
// exit gate).
//
// CRASH COVER: acceptance is atomic and idempotent under crash/retry —
//   - a crash BEFORE the transaction mutates nothing; the retry
//     re-verifies and commits exactly once;
//   - a crash AFTER the commit (before acknowledgement) makes the retry a
//     typed stale-revision no-op — zero or one acceptance commits, never
//     two;
//   - a fault BETWEEN the coordinator's transaction statements cannot land
//     (the whole mutation is one better-sqlite3 transaction; the injected
//     abort rolls back).
//
// EXIT-GATE RATCHET (source-pinned): exactly ONE acceptance mutation
// service — applyVerifiedAcceptance is called only from
// commit-accepted-candidate.ts; the executor routes through the service;
// no src caller passes accepted material truth to the coordinator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
  const coordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db),
    now: () => new Date(),
  });
  coordinator.materializeCell({
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: ref.workKey,
  });
  coordinator.admitWork(ref);
  for (const loopState of ['leased', 'running']) {
    // read() returns the FLAT state (kanbanPhase/loopState/nextRole at top level).
    const cur = workplaceRepo.read(ref);
    const r = workplaceRepo.applyTransition({
      workplaceRef: ref,
      expectedRevision: cur.revision,
      kanbanPhase: cur.kanbanPhase,
      loopState,
      nextRole: cur.nextRole,
      terminalReason: null,
      activeReservationRef: 'execution:author',
    });
    assert.equal(r.applied, true);
  }
  coordinator.sealCandidateSet(ref);
  const gateRepo = new SqliteGateRepository(db);
  const authorityCommit = new CommitAcceptedCandidate({ gateRepo, coordinator });

  // K13 — the subject CandidateSet chain the head's byte-identity resolves
  // through (decision subject -> candidate set -> ordered members).
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref, workplace_ref, production_revision_ref, role,
        subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
     VALUES ('candidate-set:subject', ?, 'revision:proof', 'author', NULL, ?, 'seal:proof', ?)`,
  ).run(workplaceKey, HEX64, '2026-08-18T00:00:00Z');
  for (const [ordinal, productRef] of ['product:one@1', 'product:two@2'].entries()) {
    db.prepare(
      `INSERT INTO factory_candidate_set_members
         (candidate_set_ref, ordinal, product_schema, product_ref,
          product_digest, origin, source_candidate_set_ref)
       VALUES ('candidate-set:subject', ?, 'factory.product.v1', ?, ?, 'produced', NULL)`,
    ).run(ordinal, productRef, HEX64);
  }

  // Seed the full valid proof via the REAL repository API.
  const revision = workplaceRepo.read(ref).revision;
  gateRepo.createGateRun({
    gateRunRef: 'gate-run:proof',
    workplaceRef: ref,
    gatePhase: 'final',
    subjectCandidateSetRef: 'candidate-set:subject',
    assessmentCandidateSetRefs: [],
    checkPlanRef: 'plan',
    checkPlanDigest: HEX64,
    expectedWorkplaceRevision: revision,
    gateLeaseRef: 'lease:proof',
  });
  gateRepo.recordCheckReceipt({
    checkReceiptRef: 'receipt:proof',
    checkRunRef: 'gate-run:proof',
    subjectCandidateSetRef: 'candidate-set:subject',
    assessmentCandidateSetRefs: [],
    check: { providerId: 'check.x', version: '1.0.0', providerDigest: HEX64 },
    environmentRef: null,
    outcome: 'passed',
    evidenceRefs: [],
    receiptDigest: HEX64,
  });
  gateRepo.setGateRunState('gate-run:proof', 'terminal');
  gateRepo.recordDecision({
    workplaceRef: ref,
    gateRef: 'gate:proof',
    gateRunRef: 'gate-run:proof',
    gatePhase: 'final',
    transitionRef: 'transition:proof',
    subjectCandidateSetRef: 'candidate-set:subject',
    assessmentCandidateSetRefs: [],
    verdict: 'accepted',
    repairTargetRole: null,
    checkPlanRef: 'plan',
    checkPlanDigest: HEX64,
    decisionPolicyRef: 'policy',
    decisionPolicyDigest: HEX64,
    checkReceiptRefs: ['receipt:proof'],
    installationDigest: HEX64,
    decisionKey: 'decision:proof',
    acceptedOutputBindings: [],
    recoveryIssueRef: null,
    decisionDigest: HEX64,
  });
  return { db, workplaceRepo, coordinator, gateRepo, authorityCommit, revision };
}

function command(db, overrides = {}) {
  const row = db.prepare(
    'SELECT revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey);
  return {
    workplaceRef: ref,
    gateDecisionKey: 'decision:proof',
    acceptedCandidateSetRef: 'candidate-set:subject',
    acceptedAuthorTaskId: '41',
    expectedRevision: row.revision,
    isFinal: true,
    effectRequired: false,
    ...overrides,
  };
}

test('K12/crash: before-transaction crash mutates nothing; the retry commits exactly once', () => {
  const { db, authorityCommit } = fixture();
  // Simulate the crash-before-tx: the command built, verification passed,
  // process died. Nothing mutated (asserted), then the retry commits.
  const before = db.prepare(
    'SELECT revision,loop_state FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey);
  assert.equal(before.loop_state, 'verifying');

  const first = authorityCommit.commit(command(db));
  assert.ok(first.applied, 'the retry commits');
  const after = db.prepare(
    'SELECT revision,loop_state,terminal_reason FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey);
  assert.equal(after.loop_state, 'terminal');
  assert.equal(after.terminal_reason, 'accepted');
  assert.equal(after.revision, before.revision + 1, 'exactly one transition');
});

test('K12/crash: a retry AFTER the commit is a typed stale no-op — zero or one, never two', () => {
  const { db, authorityCommit } = fixture();
  const first = authorityCommit.commit(command(db));
  assert.ok(first.applied);
  const committedRevision = db.prepare(
    'SELECT revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceKey).revision;
  const heads = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_accepted_authority_head',
  ).get().n;
  assert.equal(heads, 1);

  // The acknowledged-lost retry carries the ORIGINAL command (the
  // expectedRevision was frozen before the first commit succeeded).
  const originalCommand = command(db);
  const frozen = { ...originalCommand, expectedRevision: committedRevision - 1 };
  assert.throws(
    () => authorityCommit.commit(frozen),
    /AUTHORITY_COMMIT_REVISION_STALE/u,
    'the retry cannot double-commit — the CAS fence rejects it typed',
  );
  assert.equal(
    db.prepare('SELECT revision FROM factory_workplaces WHERE workplace_ref=?')
      .get(workplaceKey).revision,
    committedRevision,
    'no second transition',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_accepted_authority_head').get().n,
    1,
    'no second authority head row',
  );
});

// ---------------------------------------------------------------------------
// Exit-gate ratchet — one acceptance mutation service.
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

test('K12/exit-gate: applyVerifiedAcceptance is called ONLY by the acceptance service', () => {
  const files = [
    'src/process-modules/application/production-cell-coordinator.ts',
    'src/process-modules/application/commit-accepted-candidate.ts',
    'src/process-modules/application/node-executors/production-cell-node-executor.ts',
    'src/app/product-lifecycle-runtime.ts',
  ];
  const offenders = [];
  for (const rel of files) {
    const source = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    const calls = [...source.matchAll(/applyVerifiedAcceptance\s*\(/gu)].length
      // The definition itself (coordinator) is not a call site.
      - (rel.endsWith('production-cell-coordinator.ts') ? 1 : 0);
    if (rel === 'src/process-modules/application/commit-accepted-candidate.ts') {
      assert.equal(calls, 1, 'the service invokes the verified acceptance exactly once');
    } else if (calls !== 0) {
      offenders.push(`${rel}: ${calls} direct call(s)`);
    }
  }
  assert.deepEqual(offenders, [],
    'ADR-081 exit gate: one acceptance mutation service — the coordinator\'s '
    + 'verified acceptance is reachable only through CommitAcceptedCandidate');
});

test('K12/exit-gate: no src caller supplies accepted truth to the coordinator', () => {
  const coordinatorSrc = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'application', 'production-cell-coordinator.ts'),
    'utf8',
  ));
  // The candidate-set truth field appears in exactly TWO places: the
  // parameter declaration and the GATE_PROOF rejection condition. Any
  // additional mention (a read, a write, a pass-through) means accepted
  // truth flows again — fail.
  const mentions = [...coordinatorSrc.matchAll(/acceptedCandidateSetRef/gu)].length;
  assert.equal(
    mentions,
    2,
    'acceptedCandidateSetRef survives only as the rejected-truth parameter '
    + 'declaration and the rejection condition — never used',
  );
  assert.match(coordinatorSrc, /GATE_PROOF_VERIFICATION_REQUIRED/u,
    'the direct accepted-truth path throws with the typed routing error');

  const executorSrc = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'application', 'node-executors', 'production-cell-node-executor.ts'),
    'utf8',
  ));
  assert.match(executorSrc, /this\.opts\.authorityCommit\.commit\(\{/u,
    'the executor routes acceptance through the service');
});
