// tests/matrix/a-progress-space.test.mjs
//
// STAGE-16 SPACE A — the progress space, swept exhaustively forward.
//
// Thesis (see tests/matrix/README.md): defects have shapes; the classifier
// shape is "a reachable state that neither progresses nor fails closed".
// `classifyWorkplaceProgress` (CONVEYOR §23) has only ever been used
// reactively — a sweep every 30 episodes. This test drives it over its WHOLE
// input space, once, in milliseconds.
//
// Method (brief §SPACE A):
//   A1  dimensions enumerated FROM CODE: loop states and effect outcomes are
//       extracted from src/schema.ts CHECK constraints (the frozen sets), not
//       typed from memory.
//   A2  full cartesian product classified; total printed.
//   A3  every behavior cell carries a reachability annotation with a
//       one-line reason; dimensions a state does not read are named once in
//       READS (the full-product sweep asserts the classifier really ignores
//       them — a hidden read is a defect).
//   A4  every reachable cell is healthy or in KNOWN_UNHEALTHY (reason+owner).
//   A5  set equality: every dimension VALUE actually changes some
//       classification somewhere (the enumeration is not vacuous), and every
//       behavior row of the table below is realized by ≥1 product cell.
//
// Findings are recorded, not fixed (brief §2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyWorkplaceProgress,
  isHealthyProgress,
} from '../../dist/application/progress/progress-classification.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ── A1: the frozen dimension sets, extracted from the schema source ────────
/** Slice one CREATE TABLE block out of schema.ts, then extract a CHECK set
 * from INSIDE that block only — a bare file-wide regex grabs the first
 * same-named column of an unrelated table (found the hard way: 'outcome'
 * exists in four tables). */
function extractCheckSet(createTableHeader, column, sql) {
  const start = sql.indexOf(createTableHeader);
  assert.ok(start !== -1, `${createTableHeader} not found — enumeration source drifted`);
  const end = sql.indexOf(');', start);
  const block = sql.slice(start, end);
  const re = new RegExp(`${column}\\s+TEXT[^]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const match = block.match(re);
  assert.ok(match, `CHECK constraint for ${column} not found in ${createTableHeader}`);
  return match[1].split(',').map(token => token.trim().replace(/^'|'$/g, ''));
}

const schemaSql = readFileSync(join(repoRoot, 'src', 'schema.ts'), 'utf8');
const LOOP_STATES = extractCheckSet('CREATE TABLE IF NOT EXISTS factory_workplaces', 'loop_state', schemaSql);            // 9
const EFFECT_OUTCOMES = extractCheckSet('CREATE TABLE IF NOT EXISTS factory_effect_attempts', 'outcome', schemaSql);     // 5
assert.equal(LOOP_STATES.length, 9, `loop_state frozen set drifted: ${LOOP_STATES}`);
assert.deepEqual(EFFECT_OUTCOMES.sort(), ['human_required', 'pending', 'policy_terminal', 'repair_required', 'succeeded'].sort());

/** The classifier reads only some facts in some states (from the code). */
const EXECUTION = ['none', 'expired', 'live'];
const OBLIGATIONS = ['none', 'open'];
const DEPS = [0, 1];
const REPAIR = ['no-cap', 'under-cap', 'exhausted'];
const TERMINAL_REASON = [null, 'failed'];
const CAP = 30;

/** Effect-attempt tails: shape × the five outcomes (pending appears under
 * cap and at cap; each settled outcome is its own cell). */
const EFFECT_TAILS = [
  'none',
  'pending-under-cap',
  'pending-at-cap',
  ...EFFECT_OUTCOMES.filter(o => o !== 'pending'), // 4 settled outcomes
];

function effectAttempts(tail) {
  if (tail === 'none') return [];
  if (tail === 'pending-under-cap') return [{ attemptNo: 1, outcome: 'pending' }];
  if (tail === 'pending-at-cap') {
    return Array.from({ length: CAP }, (_, i) => ({ attemptNo: i + 1, outcome: 'pending' }));
  }
  return [{ attemptNo: 1, outcome: tail }];
}

function executionOf(kind) {
  if (kind === 'none') return null;
  return { executionId: `exec:${kind}`, leaseExpired: kind === 'expired' };
}

function repairOf(shape) {
  if (shape === 'no-cap') return { repairAttempts: null, repairCap: null };
  if (shape === 'under-cap') return { repairAttempts: 2, repairCap: 5 };
  return { repairAttempts: 5, repairCap: 5 };
}

function factsFor({ loopState, execution, obligations, tail, deps, repair, terminalReason }) {
  const { repairAttempts, repairCap } = repairOf(repair);
  return {
    workplaceRef: `workplace/matrix/${loopState}`,
    loopState,
    terminalReason,
    activeReservationRef: execution === 'none' ? null : `reservation:${execution}`,
    execution: executionOf(execution),
    openObligations: obligations === 'open'
      ? [{ handoffKind: 'presentation-closure', state: 'pending' }]
      : [],
    effectAttempts: effectAttempts(tail),
    unsatisfiedDependencies: deps,
    repairAttempts,
    repairCap,
    effectAttemptCap: CAP,
  };
}

// ── A3/A4: the behavior table. One row per (state, read-dimensions) combo. ─
// reachability: 'reachable-healthy' | 'reachable-defect' | 'unreachable-defensive'
// KNOWN_UNHEALTHY = the reachable-defect rows whose class is stalled or
// inconsistent_state — the classifier's legitimate defect DETECTIONS. Each
// names the mechanism that owns preventing it (the owner).
const H = 'reachable-healthy';
const D = 'reachable-defect';
const U = 'unreachable-defensive';
const ROWS = [
  // leased / running — reads: execution
  { key: 'leased|none', cls: 'stalled', reach: D, owner: 'work-assignment-core (a lease is only granted after the durable execution row exists)', reason: 'reservation claims a mutation owner but no durable WorkerExecution exists' },
  { key: 'leased|expired', cls: 'runnable_command', reach: H, reason: 'supervision can reap the expired lease and requeue' },
  { key: 'leased|live', cls: 'live_owner', reach: H, reason: 'valid unexpired lease owns the next mutation' },
  { key: 'running|none', cls: 'stalled', reach: D, owner: 'work-assignment-core (a lease is only granted after the durable execution row exists)', reason: 'reservation claims a mutation owner but no durable WorkerExecution exists' },
  { key: 'running|expired', cls: 'runnable_command', reach: H, reason: 'supervision can reap the expired lease and requeue' },
  { key: 'running|live', cls: 'live_owner', reach: H, reason: 'valid unexpired lease owns the next mutation' },
  // idle / queued — contradiction branch reads execution, switch reads deps
  ...DEPS.flatMap(deps => [
    { key: `idle|live|deps${deps}`, cls: 'inconsistent_state', reach: D, owner: 'worker-supervision-service reaper (must reclaim the lease of an ownerless state)', reason: 'ownerless state holds a live lease' },
    { key: `queued|live|deps${deps}`, cls: 'inconsistent_state', reach: D, owner: 'worker-supervision-service reaper (must reclaim the lease of an ownerless state)', reason: 'ownerless state holds a live lease' },
    ...['none', 'expired'].map(execution => ({
      key: `idle|${execution}|deps${deps}`, cls: deps === 0 ? 'runnable_command' : 'typed_wait', reach: H,
      reason: deps === 0 ? 'admissible; dispatcher may reserve' : 'dependency settlement is the wake source',
    })),
    ...['none', 'expired'].map(execution => ({
      key: `queued|${execution}|deps${deps}`, cls: deps === 0 ? 'runnable_command' : 'typed_wait', reach: H,
      reason: deps === 0 ? 'admissible; dispatcher may reserve' : 'dependency settlement is the wake source',
    })),
  ]),
  // verifying — reads: obligations
  { key: 'verifying|open', cls: 'transition_due', reach: H, reason: 'sealed production awaits its committed handoff' },
  { key: 'verifying|none', cls: 'stalled', reach: D, owner: 'transition-obligation integrator (sealing must open the handoff obligation)', reason: 'verifying with no open obligation drives nothing toward a CandidateSet/GateRun' },
  // effect_pending — reads: obligations, then effect tail
  ...EFFECT_TAILS.map(tail => ({
    key: `effect_pending|open|${tail}`, cls: 'transition_due', reach: H,
    reason: 'accepted material awaits its declared post-acceptance effect handoff',
  })),
  { key: 'effect_pending|none|none', cls: 'stalled', reach: D, owner: 'transition-obligation integrator (entering effect_pending must open an obligation)', reason: 'the textbook §23 incident: effect_pending, zero obligations, zero attempts — nothing owns the next mutation' },
  { key: 'effect_pending|none|pending-under-cap', cls: 'typed_wait', reach: H, reason: 'obligation-reconciler sweep is the wake source' },
  { key: 'effect_pending|none|pending-at-cap', cls: 'stalled', reach: D, owner: 'effect router (a budget-exhausted pending effect must terminalize or escalate, not park)', reason: 'effect never settled within its declared budget' },
  ...EFFECT_OUTCOMES.filter(o => o !== 'pending').map(outcome => ({
    key: `effect_pending|none|${outcome}`, cls: 'inconsistent_state', reach: D,
    owner: `effect router (a settled '${outcome}' effect must be routed out of effect_pending)`,
    reason: 'settled but unrouted',
  })),
  // repair_wait — reads: repair budget
  { key: 'repair_wait|no-cap', cls: 'runnable_command', reach: H, reason: 'repair due; no declared cap' },
  { key: 'repair_wait|under-cap', cls: 'runnable_command', reach: H, reason: 'repair due within budget' },
  { key: 'repair_wait|exhausted', cls: 'stalled', reach: D, owner: 'production-cell budget executor (exhaustion must terminalize; stage-13 widening routes BEFORE the budget)', reason: 'repair budget exhausted and the workplace was not terminalized' },
  // paused — reads: nothing
  { key: 'paused', cls: 'typed_wait', reach: H, reason: 'explicit human-required park; operator is the wake source' },
  // terminal — reads: terminalReason. The reducer's ONLY terminal path is
  // the terminal() helper (production-cell-reducer.ts:375-391), which always
  // sets a reason — so reason-null is defensive, not reachable.
  { key: 'terminal|reason', cls: 'transition_due', reach: H, reason: 'terminal(reason) — excluded from the invariant by bookkeeping' },
  { key: 'terminal|no-reason', cls: 'inconsistent_state', reach: U, reason: 'unreachable through the reducer: terminal() always sets terminalReason (production-cell-reducer.ts:375)' },
];

const ROW_BY_KEY = new Map(ROWS.map(row => [row.key, row]));
const KNOWN_UNHEALTHY = ROWS.filter(row => row.reach === D && ['stalled', 'inconsistent_state'].includes(row.cls));

/** Map one product cell to its behavior row (the classifier's read structure,
 * restated — the full-product sweep then proves the classifier matches). */
function rowKeyFor(cell) {
  switch (cell.loopState) {
    case 'leased':
    case 'running':
      return `${cell.loopState}|${cell.execution}`;
    case 'idle':
    case 'queued': {
      if (cell.execution === 'live') return `${cell.loopState}|live|deps${cell.deps}`;
      return `${cell.loopState}|${cell.execution}|deps${cell.deps}`;
    }
    case 'verifying':
      return `verifying|${cell.obligations}`;
    case 'effect_pending':
      return `effect_pending|${cell.obligations}|${cell.tail}`;
    case 'repair_wait':
      return `repair_wait|${cell.repair}`;
    case 'paused':
      return 'paused';
    case 'terminal':
      return cell.terminalReason === null ? 'terminal|no-reason' : 'terminal|reason';
    default:
      throw new Error(`unmapped loop state ${cell.loopState}`);
  }
}

/** Which dimensions each state does NOT read (A3, one line per axis). */
const NOT_READ = {
  leased: ['obligations', 'tail', 'deps', 'repair', 'terminalReason'],
  running: ['obligations', 'tail', 'deps', 'repair', 'terminalReason'],
  idle: ['tail', 'repair', 'terminalReason'],
  queued: ['tail', 'repair', 'terminalReason'],
  verifying: ['execution', 'tail', 'deps', 'repair', 'terminalReason'],
  effect_pending: ['execution', 'deps', 'repair', 'terminalReason'],
  repair_wait: ['execution', 'obligations', 'tail', 'deps', 'terminalReason'],
  paused: ['execution', 'obligations', 'tail', 'deps', 'repair', 'terminalReason'],
  terminal: ['execution', 'obligations', 'tail', 'deps', 'repair'],
};

// ── A2: the full cartesian product ─────────────────────────────────────────
const CELLS = [];
for (const loopState of LOOP_STATES)
  for (const execution of EXECUTION)
    for (const obligations of OBLIGATIONS)
      for (const tail of EFFECT_TAILS)
        for (const deps of DEPS)
          for (const repair of REPAIR)
            for (const terminalReason of TERMINAL_REASON)
              CELLS.push({ loopState, execution, obligations, tail, deps, repair, terminalReason });

test(`space A — the full product (${CELLS.length} cells) classifies exactly as the behavior table says`, () => {
  assert.ok(CELLS.length > 4000, 'anti-vacuity: the product must be the real cartesian space');
  const mismatches = [];
  for (const cell of CELLS) {
    const explanation = classifyWorkplaceProgress(factsFor(cell));
    const row = ROW_BY_KEY.get(rowKeyFor(cell));
    assert.ok(row, `no behavior row for ${rowKeyFor(cell)}`);
    // A hidden read: a dimension this state must not read changed the class.
    if (explanation.classification !== row.cls) {
      mismatches.push(`${rowKeyFor(cell)} → expected ${row.cls}, got ${explanation.classification} (hidden read of a not-read dimension, or classifier drift)`);
    }
    // The unread-dimension invariance, checked directly: flipping any NOT_READ
    // axis must not change the classification of this cell.
    for (const axis of NOT_READ[cell.loopState]) {
      const flipped = flipAxis(cell, axis);
      if (!flipped) continue;
      const other = classifyWorkplaceProgress(factsFor(flipped));
      if (other.classification !== explanation.classification) {
        mismatches.push(`${rowKeyFor(cell)}: classification changed (${explanation.classification} → ${other.classification}) when unread axis '${axis}' flipped — the classifier reads what the table says it does not`);
      }
    }
  }
  assert.deepEqual(mismatches, [], `classification drift over the product (first 5):\n${mismatches.slice(0, 5).join('\n')}`);
  // eslint-disable-next-line no-console
  console.log([
    `[space A] total product cells: ${CELLS.length}`,
    `behavior rows: ${ROWS.length} (healthy ${ROWS.filter(r => r.reach === H).length}, reachable-defect ${ROWS.filter(r => r.reach === D).length}, unreachable-defensive ${ROWS.filter(r => r.reach === U).length})`,
    `KNOWN_UNHEALTHY registry rows: ${KNOWN_UNHEALTHY.length}`,
  ].join('\n'));
});

test('space A — every reachable unhealthy cell is in KNOWN_UNHEALTHY with reason and owner (A4)', () => {
  for (const row of KNOWN_UNHEALTHY) {
    assert.ok(row.owner, `${row.key} has no owner`);
    assert.ok(row.reason, `${row.key} has no reason`);
  }
  // The registry IS the reachable unhealthy set: a row outside it with an
  // unhealthy class and reach D would be unregistered (asserted by
  // construction above); a row marked H or U with an unhealthy class would
  // contradict A4's dichotomy.
  for (const row of ROWS) {
    if (row.reach === H) {
      assert.ok(!['stalled', 'inconsistent_state'].includes(row.cls),
        `${row.key} is marked reachable-healthy but classifies ${row.cls}`);
    }
  }
});

test('space A — set equality: every dimension value changes some classification somewhere (A5)', () => {
  // For each axis, cycling ONLY that axis must change some cell's
  // classification — the enumeration is not vacuous and the classifier
  // really reads the axis where the read-structure says it does. Cycling
  // (not toggling) covers every value of multi-valued axes.
  for (const axis of ['execution', 'obligations', 'tail', 'deps', 'repair', 'terminalReason']) {
    let sensitive = false;
    for (const cell of CELLS) {
      const flipped = flipAxis(cell, axis);
      if (classifyWorkplaceProgress(factsFor(cell)).classification
        !== classifyWorkplaceProgress(factsFor(flipped)).classification) {
        sensitive = true;
        break;
      }
    }
    assert.ok(sensitive, `axis '${axis}' changes no classification — the enumeration or the classifier is vacuous on it`);
  }
  // Every individual VALUE of the multi-valued axes is load-bearing, or is
  // documented as class-insensitive BY DESIGN with the reason. Found by this
  // sweep: the four settled effect outcomes all classify
  // inconsistent_state — the CLASS does not say WHICH settled outcome was
  // left unrouted, only the reason string does. Recorded as a granularity
  // fact, not repaired.
  const CLASS_INSENSITIVE_VALUES = new Map([
    ...['succeeded', 'repair_required', 'human_required', 'policy_terminal']
      .map(outcome => [`tail:${outcome}`, 'all settled outcomes classify inconsistent_state (settled-but-unrouted); the outcome is named in the reason, not the class']),
  ]);
  for (const [axis, values] of [['execution', EXECUTION], ['tail', EFFECT_TAILS]]) {
    for (const value of values) {
      if (CLASS_INSENSITIVE_VALUES.has(`${axis}:${value}`)) continue;
      let loadBearing = false;
      for (const cell of CELLS) {
        const withValue = { ...cell, [axis]: value };
        const away = flipAxis(withValue, axis);
        if (away[axis] === value) continue;
        if (classifyWorkplaceProgress(factsFor(withValue)).classification
          !== classifyWorkplaceProgress(factsFor(away)).classification) {
          loadBearing = true;
          break;
        }
      }
      assert.ok(loadBearing, `dimension value ${axis}:${value} changes no classification — vacuous value`);
    }
  }
});

test('space A — every behavior row is realized by at least one product cell (A5)', () => {
  const realized = new Set(CELLS.map(cell => rowKeyFor(cell)));
  for (const row of ROWS) {
    assert.ok(realized.has(row.key), `behavior row ${row.key} is realized by no product cell — dead table row`);
  }
  assert.equal(realized.size, ROWS.length, 'product realizes rows outside the table');
});

/** Cycle one axis to its next value (none → expired → live → none etc.),
 * keeping every other dimension identical. */
function flipAxis(cell, axis) {
  const next = { ...cell };
  switch (axis) {
    case 'execution': {
      const order = ['none', 'expired', 'live'];
      next.execution = order[(order.indexOf(cell.execution) + 1) % order.length];
      return next;
    }
    case 'obligations': next.obligations = cell.obligations === 'open' ? 'none' : 'open'; return next;
    case 'tail': {
      const order = ['none', 'pending-under-cap', 'pending-at-cap', ...EFFECT_OUTCOMES.filter(o => o !== 'pending')];
      next.tail = order[(order.indexOf(cell.tail) + 1) % order.length];
      return next;
    }
    case 'deps': next.deps = cell.deps === 0 ? 1 : 0; return next;
    case 'repair': {
      const order = ['no-cap', 'under-cap', 'exhausted'];
      next.repair = order[(order.indexOf(cell.repair) + 1) % order.length];
      return next;
    }
    case 'terminalReason': next.terminalReason = cell.terminalReason === null ? 'failed' : null; return next;
    default: return null;
  }
}
