/**
 * Workplace domain — pure-domain property tests (Conveyor v4, step 1.1).
 *
 * Target contracts covered:
 *   - REG-05  WorkplaceRef identity (asWorkplaceRef validation, equality).
 *   - REG-28  Two-channel state (closed phase×loop pairs, role consistency,
 *             terminal-reason ↔ phase).
 *   - REG-12  CandidateSet (seal key determinism, member-origin rules,
 *             reviewer subject requirement).
 *   - REG-18  GateDecision (closed verdict, repairTargetRole requirement,
 *             bindings only on accepted).
 *   - REG-09  ExecutionReservation (deterministic ref derivation, validation).
 *   - REG-19  TargetRecoveryIssue (exact-reference requirements).
 *
 * These tests import ONLY the pure domain module (no SQLite, no MCP, no db).
 * They run against dist/ after `tsc`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asWorkplaceRef,
  serializeWorkplaceRef,
  workplaceRefEquals,
  DEFAULT_WORK_KEY,
  KANBAN_PHASES,
  LOOP_STATES,
  TERMINAL_REASONS,
  isAllowedPhaseLoopPair,
  assertAllowedPhaseLoopPair,
  isRoleCompatibleWithPhase,
  terminalReasonForPhase,
  phaseForTerminalReason,
  assertValidWorkplaceState,
  initialWorkplaceState,
  candidateSetSealKey,
  computeCandidateSetRef,
  assertValidCandidateSet,
  executionReservationRef,
  assertValidExecutionReservation,
  assertValidGateDecision,
  assertValidTargetRecoveryIssue,
} from '../../dist/process-modules/domain/workplace/index.js';

// ---------------------------------------------------------------------------
// REG-05 — WorkplaceRef.
// ---------------------------------------------------------------------------

test('REG-05: asWorkplaceRef accepts a well-formed singleton ref', () => {
  const ref = asWorkplaceRef({
    processRunId: 7,
    moduleRef: 'product-formalization@1.0.0',
    productionCellId: 'srs-author',
  });
  assert.equal(ref.processRunId, 7);
  assert.equal(ref.moduleRef, 'product-formalization@1.0.0');
  assert.equal(ref.productionCellId, 'srs-author');
  assert.equal(ref.workKey, DEFAULT_WORK_KEY);
});

test('REG-05: asWorkplaceRef accepts an explicit fan-out workKey', () => {
  const ref = asWorkplaceRef({
    processRunId: 7,
    moduleRef: 'development@1.0.0',
    productionCellId: 'implement-work-item',
    workKey: 'task-graph-item:42',
  });
  assert.equal(ref.workKey, 'task-graph-item:42');
});

test('REG-05: asWorkplaceRef rejects bad processRunId', () => {
  for (const bad of [0, -1, 1.5, '7', null, undefined]) {
    assert.throws(
      () => asWorkplaceRef({
        processRunId: bad,
        moduleRef: 'm@1',
        productionCellId: 'c',
      }),
      /processRunId/,
    );
  }
});

test('REG-05: asWorkplaceRef rejects moduleRef without @', () => {
  assert.throws(
    () => asWorkplaceRef({
      processRunId: 1,
      moduleRef: 'no-version',
      productionCellId: 'c',
    }),
    /name@version/,
  );
});

test('REG-05: asWorkplaceRef rejects empty components', () => {
  assert.throws(
    () => asWorkplaceRef({ processRunId: 1, moduleRef: '  ', productionCellId: 'c' }),
    /moduleRef/,
  );
  assert.throws(
    () => asWorkplaceRef({ processRunId: 1, moduleRef: 'm@1', productionCellId: '' }),
    /productionCellId/,
  );
  assert.throws(
    () => asWorkplaceRef({
      processRunId: 1,
      moduleRef: 'm@1',
      productionCellId: 'c',
      workKey: '   ',
    }),
    /workKey/,
  );
});

test('REG-05: serializeWorkplaceRef is stable & deterministic', () => {
  const ref = asWorkplaceRef({
    processRunId: 3,
    moduleRef: 'm@1',
    productionCellId: 'c',
    workKey: 'k',
  });
  const s1 = serializeWorkplaceRef(ref);
  const s2 = serializeWorkplaceRef(ref);
  assert.equal(s1, s2);
  assert.equal(s1, 'workplace/3/m@1/c/k');
});

test('REG-05: workplaceRefEquals is structural', () => {
  const a = asWorkplaceRef({ processRunId: 1, moduleRef: 'm@1', productionCellId: 'c' });
  const b = asWorkplaceRef({ processRunId: 1, moduleRef: 'm@1', productionCellId: 'c' });
  const c = asWorkplaceRef({ processRunId: 2, moduleRef: 'm@1', productionCellId: 'c' });
  assert.equal(workplaceRefEquals(a, b), true);
  assert.equal(workplaceRefEquals(a, c), false);
});

// ---------------------------------------------------------------------------
// REG-28 — Two-channel state.
// ---------------------------------------------------------------------------

test('REG-28-AC-01: every allowed pair from v4 is accepted', () => {
  const allowed = [
    ['todo', 'idle'],
    ['in_progress', 'queued'],
    ['in_progress', 'leased'],
    ['in_progress', 'running'],
    ['in_progress', 'verifying'],
    ['in_progress', 'repair_wait'],
    ['review', 'queued'],
    ['review_in_progress', 'queued'],
    ['review_in_progress', 'leased'],
    ['review_in_progress', 'running'],
    ['review_in_progress', 'verifying'],
    ['review_in_progress', 'repair_wait'],
    ['blocked', 'paused'],
    ['done', 'terminal'],
    ['failed', 'terminal'],
    ['cancelled', 'terminal'],
  ];
  for (const [phase, loop] of allowed) {
    assert.equal(
      isAllowedPhaseLoopPair(phase, loop),
      true,
      `${phase}|${loop} should be allowed`,
    );
    assert.doesNotThrow(() => assertAllowedPhaseLoopPair(phase, loop));
  }
});

test('REG-28-AC-01: disallowed pairs are rejected', () => {
  const disallowed = [
    // Kanban terminal with a non-terminal loop.
    ['done', 'running'],
    ['failed', 'queued'],
    // todo with a non-idle loop (todo only allows idle).
    ['todo', 'running'],
    ['todo', 'terminal'],
    // blocked only allows paused.
    ['blocked', 'running'],
    // in_progress with terminal — terminal belongs to done/failed/cancelled.
    ['in_progress', 'terminal'],
    // review with a non-queued loop (review only allows queued).
    ['review', 'running'],
  ];
  for (const [phase, loop] of disallowed) {
    assert.equal(
      isAllowedPhaseLoopPair(phase, loop),
      false,
      `${phase}|${loop} should be rejected`,
    );
    assert.throws(() => assertAllowedPhaseLoopPair(phase, loop), /REG-28-AC-01/);
  }
});

test('REG-28: all Kanban phases and loop states are exported as closed unions', () => {
  assert.equal(KANBAN_PHASES.length, 8);
  assert.equal(LOOP_STATES.length, 8);
  assert.equal(TERMINAL_REASONS.length, 3);
  // Sanity: the unions contain the expected literals.
  assert.ok(KANBAN_PHASES.includes('in_progress'));
  assert.ok(LOOP_STATES.includes('repair_wait'));
  assert.ok(TERMINAL_REASONS.includes('accepted'));
});

test('REG-28-AC-03: role consistency — in_progress requires author, review requires reviewer', () => {
  assert.equal(isRoleCompatibleWithPhase('in_progress', 'author'), true);
  assert.equal(isRoleCompatibleWithPhase('in_progress', 'reviewer'), false);
  assert.equal(isRoleCompatibleWithPhase('review', 'reviewer'), true);
  assert.equal(isRoleCompatibleWithPhase('review', 'author'), false);
  assert.equal(isRoleCompatibleWithPhase('review_in_progress', 'reviewer'), true);
  assert.equal(isRoleCompatibleWithPhase('todo', 'author'), true);
  // Terminal/blocked accept any (dispatcher ignores role there).
  assert.equal(isRoleCompatibleWithPhase('done', 'author'), true);
  assert.equal(isRoleCompatibleWithPhase('blocked', 'reviewer'), true);
});

test('REG-28-AC-05: terminalReason ↔ phase is a 1:1 mapping', () => {
  assert.equal(terminalReasonForPhase('done'), 'accepted');
  assert.equal(terminalReasonForPhase('failed'), 'failed');
  assert.equal(terminalReasonForPhase('cancelled'), 'cancelled');
  assert.equal(phaseForTerminalReason('accepted'), 'done');
  assert.equal(phaseForTerminalReason('failed'), 'failed');
  assert.equal(phaseForTerminalReason('cancelled'), 'cancelled');
  // Round-trip.
  for (const reason of TERMINAL_REASONS) {
    const phase = phaseForTerminalReason(reason);
    assert.equal(terminalReasonForPhase(phase), reason);
  }
});

test('REG-28: initialWorkplaceState is todo/idle/author/revision-0', () => {
  const s = initialWorkplaceState();
  assert.equal(s.kanbanPhase, 'todo');
  assert.equal(s.loopState, 'idle');
  assert.equal(s.nextRole, 'author');
  assert.equal(s.revision, 0);
  assert.equal(s.terminalReason, null);
  assert.doesNotThrow(() => assertValidWorkplaceState(s));
});

test('REG-28-AC-05: assertValidWorkplaceState rejects terminal loop without reason', () => {
  assert.throws(
    () => assertValidWorkplaceState({
      kanbanPhase: 'done',
      loopState: 'terminal',
      nextRole: 'author',
      revision: 1,
      terminalReason: null,
    }),
    /terminalReason/,
  );
});

test('REG-28-AC-05: assertValidWorkplaceState rejects mismatched terminal reason/phase', () => {
  assert.throws(
    () => assertValidWorkplaceState({
      kanbanPhase: 'done',
      loopState: 'terminal',
      nextRole: 'author',
      revision: 1,
      terminalReason: 'failed', // done requires accepted
    }),
    /REG-28-AC-05/,
  );
});

test('REG-28: assertValidWorkplaceState rejects non-terminal loop with a terminal reason', () => {
  assert.throws(
    () => assertValidWorkplaceState({
      kanbanPhase: 'in_progress',
      loopState: 'running',
      nextRole: 'author',
      revision: 1,
      terminalReason: 'accepted',
    }),
    /terminalReason/,
  );
});

test('REG-28-AC-03: assertValidWorkplaceState rejects wrong role for phase', () => {
  assert.throws(
    () => assertValidWorkplaceState({
      kanbanPhase: 'in_progress',
      loopState: 'running',
      nextRole: 'reviewer', // in_progress requires author
      revision: 1,
      terminalReason: null,
    }),
    /REG-28-AC-03/,
  );
});

// ---------------------------------------------------------------------------
// REG-12 — CandidateSet.
// ---------------------------------------------------------------------------

const ref = asWorkplaceRef({
  processRunId: 5,
  moduleRef: 'formalization@1.0.0',
  productionCellId: 'srs-author',
});

test('REG-12: candidateSetSealKey is deterministic over (workplace, exec, role)', () => {
  const k1 = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'author',
  });
  const k2 = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'author',
  });
  assert.equal(k1, k2);
  // Different role → different key.
  const kReviewer = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'reviewer',
  });
  assert.notEqual(k1, kReviewer);
  // Different execution → different key.
  const kOtherExec = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-2',
    role: 'author',
  });
  assert.notEqual(k1, kOtherExec);
});

test('REG-12: computeCandidateSetRef echoes the seal key', () => {
  const key = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'author',
  });
  assert.equal(computeCandidateSetRef(key), key);
});

const DIGEST = 'a'.repeat(64);

function makeAuthorSet(overrides = {}) {
  const key = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'author',
  });
  return {
    candidateSetRef: computeCandidateSetRef(key),
    workplaceRef: ref,
    producerExecutionRef: 'exec-1',
    role: 'author',
    subjectCandidateSetRef: null,
    members: [
      { productRef: { schemaId: 's', ref: 'r', digest: DIGEST }, origin: 'produced', sourceCandidateSetRef: null },
    ],
    sealReceiptRef: 'receipt-1',
    candidateSetDigest: DIGEST,
    sealedAt: '2026-08-04T12:00:00Z',
    ...overrides,
  };
}

test('REG-12-AC-02: produced member with sourceCandidateSetRef is rejected', () => {
  const set = makeAuthorSet({
    members: [
      {
        productRef: { schemaId: 's', ref: 'r', digest: DIGEST },
        origin: 'produced',
        sourceCandidateSetRef: 'prior-set', // illegal for produced
      },
    ],
  });
  assert.throws(() => assertValidCandidateSet(set), /REG-12-AC-02/);
});

test('REG-12-AC-02/03: carried-forward member without sourceCandidateSetRef is rejected', () => {
  const set = makeAuthorSet({
    members: [
      {
        productRef: { schemaId: 's', ref: 'r', digest: DIGEST },
        origin: 'carried-forward',
        sourceCandidateSetRef: null, // illegal for carried-forward
      },
    ],
  });
  assert.throws(() => assertValidCandidateSet(set), /REG-12-AC-02/);
});

test('REG-12-AC-04: reviewer set without subjectCandidateSetRef is rejected', () => {
  const key = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-reviewer',
    role: 'reviewer',
  });
  const set = makeAuthorSet({
    candidateSetRef: computeCandidateSetRef(key),
    producerExecutionRef: 'exec-reviewer',
    role: 'reviewer',
    subjectCandidateSetRef: null, // illegal for reviewer
  });
  assert.throws(() => assertValidCandidateSet(set), /REG-12-AC-04/);
});

test('REG-12-AC-04: author set WITH subjectCandidateSetRef is rejected', () => {
  const set = makeAuthorSet({
    subjectCandidateSetRef: 'some-author-set', // illegal for author
  });
  assert.throws(() => assertValidCandidateSet(set), /REG-12-AC-04/);
});

test('REG-12: valid author set passes', () => {
  assert.doesNotThrow(() => assertValidCandidateSet(makeAuthorSet()));
});

test('REG-12: valid reviewer set (with subject) passes', () => {
  const key = candidateSetSealKey({
    workplaceRef: ref,
    producerExecutionRef: 'exec-reviewer',
    role: 'reviewer',
  });
  const set = makeAuthorSet({
    candidateSetRef: computeCandidateSetRef(key),
    producerExecutionRef: 'exec-reviewer',
    role: 'reviewer',
    subjectCandidateSetRef: 'author-set-ref',
  });
  assert.doesNotThrow(() => assertValidCandidateSet(set));
});

test('REG-12: empty members rejected', () => {
  assert.throws(() => assertValidCandidateSet(makeAuthorSet({ members: [] })), /non-empty/);
});

test('REG-12: bad digest rejected', () => {
  assert.throws(
    () => assertValidCandidateSet(makeAuthorSet({ candidateSetDigest: 'not-a-hash' })),
    /64-char/,
  );
});

// ---------------------------------------------------------------------------
// REG-09 — ExecutionReservation.
// ---------------------------------------------------------------------------

test('REG-09: executionReservationRef is deterministic over (workplace, role, revision)', () => {
  const r1 = executionReservationRef({ workplaceRef: ref, role: 'author', expectedWorkplaceRevision: 3 });
  const r2 = executionReservationRef({ workplaceRef: ref, role: 'author', expectedWorkplaceRevision: 3 });
  assert.equal(r1, r2);
  // Different revision → different ref.
  const r3 = executionReservationRef({ workplaceRef: ref, role: 'author', expectedWorkplaceRevision: 4 });
  assert.notEqual(r1, r3);
});

test('REG-09: assertValidExecutionReservation accepts a well-formed reservation', () => {
  const reservationRef = executionReservationRef({
    workplaceRef: ref,
    role: 'author',
    expectedWorkplaceRevision: 0,
  });
  assert.doesNotThrow(() => assertValidExecutionReservation({
    reservationRef,
    workplaceRef: ref,
    expectedWorkplaceRevision: 0,
    role: 'author',
    idempotencyKey: 'k1',
    fenceToken: 'fence-1',
    expiresAt: '2026-08-04T13:00:00Z',
    state: 'queued',
  }));
});

test('REG-09-AC-01: reservation ref not matching the derivation is rejected', () => {
  assert.throws(
    () => assertValidExecutionReservation({
      reservationRef: 'wrong-ref',
      workplaceRef: ref,
      expectedWorkplaceRevision: 0,
      role: 'author',
      idempotencyKey: 'k1',
      fenceToken: 'fence-1',
      expiresAt: '2026-08-04T13:00:00Z',
      state: 'queued',
    }),
    /deterministic derivation/,
  );
});

test('REG-09: negative revision rejected', () => {
  assert.throws(
    () => assertValidExecutionReservation({
      reservationRef: executionReservationRef({
        workplaceRef: ref,
        role: 'author',
        expectedWorkplaceRevision: -1,
      }),
      workplaceRef: ref,
      expectedWorkplaceRevision: -1,
      role: 'author',
      idempotencyKey: 'k1',
      fenceToken: 'fence-1',
      expiresAt: '2026-08-04T13:00:00Z',
      state: 'queued',
    }),
    /non-negative/,
  );
});

// ---------------------------------------------------------------------------
// REG-18 — GateDecision.
// ---------------------------------------------------------------------------

function makeDecision(overrides = {}) {
  return {
    workplaceRef: ref,
    gateRef: 'formalization.author-gate',
    gateRunRef: 'gate-run-1',
    gatePhase: 'final',
    transitionRef: 'transition-1',
    subjectCandidateSetRef: 'cs-1',
    assessmentCandidateSetRefs: [],
    verdict: 'accepted',
    repairTargetRole: null,
    checkPlanRef: 'plan-1',
    checkPlanDigest: 'd'.repeat(64),
    decisionPolicyRef: 'policy-1',
    decisionPolicyDigest: 'p'.repeat(64),
    checkReceiptRefs: ['receipt-1'],
    installationDigest: 'i'.repeat(64),
    decisionKey: 'dk-1',
    acceptedOutputBindings: [],
    recoveryIssueRef: null,
    decisionDigest: 'e'.repeat(64),
    ...overrides,
  };
}

test('REG-18-AC-04: repair_required without repairTargetRole rejected', () => {
  assert.throws(
    () => assertValidGateDecision(makeDecision({
      verdict: 'repair_required',
      repairTargetRole: null,
      recoveryIssueRef: 'issue-1',
    })),
    /REG-18-AC-04/,
  );
});

test('REG-18: repair_required without recoveryIssueRef rejected', () => {
  assert.throws(
    () => assertValidGateDecision(makeDecision({
      verdict: 'repair_required',
      repairTargetRole: 'author',
      recoveryIssueRef: null,
    })),
    /recoveryIssueRef/,
  );
});

test('REG-18: repair_required with role+issue passes', () => {
  assert.doesNotThrow(() => assertValidGateDecision(makeDecision({
    verdict: 'repair_required',
    repairTargetRole: 'author',
    recoveryIssueRef: 'issue-1',
  })));
});

test('REG-18: non-repair verdict with repairTargetRole rejected', () => {
  assert.throws(
    () => assertValidGateDecision(makeDecision({
      verdict: 'accepted',
      repairTargetRole: 'author',
    })),
    /repairTargetRole/,
  );
});

test('REG-18-AC-02/03: bindings on non-accepted verdict rejected', () => {
  assert.throws(
    () => assertValidGateDecision(makeDecision({
      verdict: 'failed',
      acceptedOutputBindings: [
        { binding: 'out', productRefs: [{ schemaId: 's', ref: 'r', digest: DIGEST }] },
      ],
    })),
    /acceptedOutputBindings/,
  );
});

test('REG-18: accepted with bindings passes (final-gate case)', () => {
  assert.doesNotThrow(() => assertValidGateDecision(makeDecision({
    verdict: 'accepted',
    acceptedOutputBindings: [
      { binding: 'solution-contract', productRefs: [{ schemaId: 's', ref: 'r', digest: DIGEST }] },
    ],
  })));
});

test('REG-18: bad decisionDigest rejected', () => {
  assert.throws(
    () => assertValidGateDecision(makeDecision({ decisionDigest: 'short' })),
    /64-char/,
  );
});

// ---------------------------------------------------------------------------
// REG-19 — TargetRecoveryIssue.
// ---------------------------------------------------------------------------

function makeIssue(overrides = {}) {
  return {
    recoveryIssueRef: 'issue-1',
    recoveryIssueDigest: 'c'.repeat(64),
    rejectedGateDecisionRef: 'decision-1',
    subjectCandidateSetRef: 'cs-1',
    failingCheckReceiptRefs: ['receipt-1'],
    repairTargetRole: 'author',
    reasonCode: 'SRS_DRAFT_INCOMPLETE',
    summary: 'SRS section 3 is missing the invariant table',
    findings: [
      { code: 'MISSING_SECTION', severity: 'error', message: 'section 3 absent' },
    ],
    requiredAcceptance: ['Section 3 must contain the invariant table'],
    allowedChanges: ['docs/design/srs.md'],
    ...overrides,
  };
}

test('REG-19: valid issue passes', () => {
  assert.doesNotThrow(() => assertValidTargetRecoveryIssue(makeIssue()));
});

test('REG-19: missing rejectedGateDecisionRef rejected', () => {
  assert.throws(
    () => assertValidTargetRecoveryIssue(makeIssue({ rejectedGateDecisionRef: '' })),
    /rejectedGateDecisionRef/,
  );
});

test('REG-19: empty failingCheckReceiptRefs rejected', () => {
  assert.throws(
    () => assertValidTargetRecoveryIssue(makeIssue({ failingCheckReceiptRefs: [] })),
    /failingCheckReceiptRefs/,
  );
});

test('REG-19: empty findings rejected', () => {
  assert.throws(
    () => assertValidTargetRecoveryIssue(makeIssue({ findings: [] })),
    /findings/,
  );
});

test('REG-19: bad digest rejected', () => {
  assert.throws(
    () => assertValidTargetRecoveryIssue(makeIssue({ recoveryIssueDigest: 'no' })),
    /64-char/,
  );
});

test('REG-19-AC-03: bad repairTargetRole rejected', () => {
  assert.throws(
    () => assertValidTargetRecoveryIssue(makeIssue({ repairTargetRole: 'qa' })),
    /repairTargetRole/,
  );
});
