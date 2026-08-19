// tests/process-modules/reconciliation-desk.test.mjs
//
// SEAM-ARCHITECT-DESIGN Layer 3 — reconciliation for ORPHAN SEAMS
// (docs/architecture/SEAM-ARCHITECT-DESIGN.md "Ремонт через владельца").
//
// Reconciliation COMPLEMENTS the re-plan cycle (Layer 1, already in code:
// finding-trajectory.ts scope-impossible + replan-cycle-policy.ts), it never
// replaces it. Bounded admission rules pinned here:
//
//   1. OWNED seam      — a live owner exists → deny; route to the owner cell.
//   2. STRUCTURAL seam — the same key survived a reconciliation round OR is a
//                        replan surviving key → deny; replan territory.
//   3. CAP             — too many prior reconciliations in the lineage → deny
//                        with the full diagnosis (never an eternal loop).
//   4. Orphan seam     — the only admission: bounded records, typed report,
//                        independent reviewer + gate sanction. Reconciliation
//                        NEVER writes into authority directly.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILIATION_SEAM_CAP,
  admitReconciliation,
  assembleReconciliationReport,
  sealReconciliation,
} from '../../dist/process-modules/domain/workplace/reconciliation-desk.js';

const ORPHAN = { ownedByTaskId: null };
const OWNED_BY_7 = { ownedByTaskId: 7 };

function seam(key, paths = ['src/seam.ts']) {
  return { seamKey: key, seamPaths: paths, description: `defect at ${key}` };
}

test('admission: an orphan seam with no history is admitted (bounded, labeled orphan-seam)', () => {
  const verdict = admitReconciliation({
    seam: seam('integration-seam-mismatch::physics/engine boundary'),
    ownership: ORPHAN,
    priorReconciliations: [],
  });
  assert.equal(verdict.admitted, true);
  assert.equal(verdict.reason, 'orphan-seam');
  assert.ok(verdict.diagnosis.includes('orphan'),
    'the diagnosis must name the routing decision');
});

test('admission: an OWNED seam is denied — the owner cell repairs, reconciliation never competes', () => {
  const verdict = admitReconciliation({
    seam: seam('integration-seam-mismatch::owned boundary'),
    ownership: OWNED_BY_7,
    priorReconciliations: [],
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'owned-seam');
  assert.ok(verdict.diagnosis.includes('7'),
    'the diagnosis names the owning task for routing');
});

test('admission: a seam whose key SURVIVED a prior reconciliation is structural — replan territory', () => {
  const key = 'integration-seam-mismatch::surviving boundary';
  const verdict = admitReconciliation({
    seam: seam(key),
    ownership: ORPHAN,
    priorReconciliations: [{ seamKeys: [key] }],
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'structural-seam');
  assert.ok(verdict.diagnosis.includes('re-plan'),
    'the diagnosis routes to the re-plan mechanism, not another reconciliation');
});

test('admission: a seam that is already a surviving replan key is structural — not reconciliation input', () => {
  const key = 'path-outside-authority::src/outside/frozen-scope.ts';
  const verdict = admitReconciliation({
    seam: seam(key),
    ownership: ORPHAN,
    priorReconciliations: [],
    survivingReplanKeys: [key],
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'structural-seam');
});

test('admission: CAP — a lineage at the reconciliation cap is denied with the full diagnosis', () => {
  const prior = Array.from({ length: RECONCILIATION_SEAM_CAP }, (_, i) => ({
    seamKeys: [`integration-seam-mismatch::burned-${i}`],
  }));
  const verdict = admitReconciliation({
    seam: seam('integration-seam-mismatch::fresh orphan'),
    ownership: ORPHAN,
    priorReconciliations: prior,
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'cap');
  assert.ok(verdict.diagnosis.includes(String(RECONCILIATION_SEAM_CAP)),
    'the diagnosis states the cap');
});

test('report: coverage conservation — every admitted seam is repaired or acknowledged, exactly once', () => {
  const seams = [
    seam('s::a', ['src/a.ts']),
    seam('s::b', ['src/b.ts']),
  ];
  const report = assembleReconciliationReport({
    admittedSeams: seams,
    repairs: [{
      seamKey: 's::a',
      seamPaths: ['src/a.ts'],
      whatWasDone: 'aligned the exported surface with the consumer contract',
      evidenceRef: 'check-receipt:sha256:abc',
    }],
    remainingGaps: [{
      seamKey: 's::b',
      acknowledgedBecause: 'fix requires the physics engine release train; tracked as a gap, not silently dropped',
    }],
    rationale: 'two orphan seams at the physics/engine boundary; one repaired within the bounded surface, one acknowledged',
  });
  assert.equal(report.repairs.length, 1);
  assert.equal(report.remainingGaps.length, 1);
  assert.ok(report.rationale.length > 0);
});

test('report: FAIL-CLOSED — a dropped admitted seam is a coverage violation', () => {
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts']), seam('s::b', ['src/b.ts'])],
      repairs: [{
        seamKey: 's::a',
        seamPaths: ['src/a.ts'],
        whatWasDone: 'x',
        evidenceRef: 'r',
      }],
      remainingGaps: [],
      rationale: 'r',
    }),
    /RECONCILIATION_COVERAGE_VIOLATION/,
    'admitting a seam and then silently dropping it from the report must abort',
  );
});

test('report: FAIL-CLOSED — a repair for a seam that was never admitted is a coverage violation', () => {
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts'])],
      repairs: [
        {
          seamKey: 's::a',
          seamPaths: ['src/a.ts'],
          whatWasDone: 'x',
          evidenceRef: 'r',
        },
        {
          seamKey: 's::ghost',
          seamPaths: ['src/ghost.ts'],
          whatWasDone: 'x',
          evidenceRef: 'r',
        },
      ],
      remainingGaps: [],
      rationale: 'r',
    }),
    /RECONCILIATION_COVERAGE_VIOLATION/,
  );
});

test('report: FAIL-CLOSED — a repair whose paths escape the admitted seam surface is a scope violation', () => {
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts'])],
      repairs: [{
        seamKey: 's::a',
        seamPaths: ['src/a.ts', 'src/physics-core.ts'],
        whatWasDone: 'also touched the accepted physics core',
        evidenceRef: 'r',
      }],
      remainingGaps: [],
      rationale: 'r',
    }),
    /RECONCILIATION_REPAIR_SCOPE_VIOLATION/,
    'bounded records: a repair may only name its seam paths, never a wider surface',
  );
});

test('report: FAIL-CLOSED — a repair without evidence, a gap without reason, an empty rationale', () => {
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts'])],
      repairs: [{ seamKey: 's::a', seamPaths: ['src/a.ts'], whatWasDone: 'x', evidenceRef: '' }],
      remainingGaps: [],
      rationale: 'r',
    }),
    /RECONCILIATION_REPAIR_EVIDENCE_REQUIRED/,
  );
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts'])],
      repairs: [],
      remainingGaps: [{ seamKey: 's::a', acknowledgedBecause: '' }],
      rationale: 'r',
    }),
    /RECONCILIATION_GAP_REASON_REQUIRED/,
  );
  assert.throws(
    () => assembleReconciliationReport({
      admittedSeams: [seam('s::a', ['src/a.ts'])],
      repairs: [],
      remainingGaps: [{ seamKey: 's::a', acknowledgedBecause: 'why' }],
      rationale: '   ',
    }),
    /RECONCILIATION_RATIONALE_REQUIRED/,
  );
});

test('sanction: sealing WITHOUT an independent reviewer + gate receipt FAILS CLOSED', () => {
  const seams = [seam('s::a', ['src/a.ts'])];
  const report = assembleReconciliationReport({
    admittedSeams: seams,
    repairs: [{
      seamKey: 's::a',
      seamPaths: ['src/a.ts'],
      whatWasDone: 'x',
      evidenceRef: 'r',
    }],
    remainingGaps: [],
    rationale: 'r',
  });
  assert.throws(
    () => sealReconciliation({ admittedSeams: seams, report, sanction: null }),
    /RECONCILIATION_SANCTION_REQUIRED/,
    'reconciliation never writes into authority directly — sanction is mandatory',
  );
  assert.throws(
    () => sealReconciliation({
      admittedSeams: seams,
      report,
      sanction: { reviewerExecutionRef: '', gateDecisionKey: 'gate-key' },
    }),
    /RECONCILIATION_SANCTION_REQUIRED/,
  );
});

test('sanction: a sanctioned record is typed, seam-keyed, and re-validates coverage', () => {
  const seams = [seam('s::a', ['src/a.ts']), seam('s::b', ['src/b.ts'])];
  const report = assembleReconciliationReport({
    admittedSeams: seams,
    repairs: [{
      seamKey: 's::a',
      seamPaths: ['src/a.ts'],
      whatWasDone: 'x',
      evidenceRef: 'r',
    }],
    remainingGaps: [{ seamKey: 's::b', acknowledgedBecause: 'waiting on release train' }],
    rationale: 'bounded reconciliation of the physics/engine seam',
  });
  const sealed = sealReconciliation({
    admittedSeams: seams,
    report,
    sanction: { reviewerExecutionRef: 'exec-reviewer-1', gateDecisionKey: 'gate-decision-42' },
  });
  assert.deepEqual([...sealed.seamKeys].sort(), ['s::a', 's::b']);
  assert.equal(sealed.sanction.gateDecisionKey, 'gate-decision-42');

  // Defense in depth: a report swapped after admission does not seal.
  const tampered = { ...report, repairs: [] };
  assert.throws(
    () => sealReconciliation({ admittedSeams: seams, report: tampered,
      sanction: { reviewerExecutionRef: 'e', gateDecisionKey: 'g' } }),
    /RECONCILIATION_COVERAGE_VIOLATION/,
  );
});
