/**
 * Uncle Bob Wave 2 / FU-D — PURE stuck-policy unit tests.
 *
 * These test the POLICY in isolation: `decideStuckAction` is a pure function
 * (no SQLite, no probe, no fs, no temp dir, no DB schema). Each case builds a
 * StuckPolicyInput snapshot and asserts the returned StuckAction. Runs in
 * microseconds — orders of magnitude cheaper than the DB-backed golden tests in
 * tests/architecture/worker-supervision-reaper.test.mjs (which remain the
 * byte-identity characterization for the full mechanism).
 *
 * The golden DB tests prove the mechanism+policy combination reproduces the
 * procedural code end-to-end. THIS file covers the corners the DB harness
 * cannot reach cheaply and locks the policy's decision matrix so a future
 * refactor of the mechanism cannot silently drift it.
 *
 * Thresholds (from src/lifecycle/stuck-policy.ts):
 *   STUCK_SILENCE_MS        = 10 min  (progress silence → suspected_stuck)
 *   STUCK_CANCEL_GRACE_MS   =  5 min  (suspected_stuck → cancel_requested)
 *   CANCEL_GRACE_MS         = 60 s    (cancel_requested → terminate)
 *   RESERVED_BOOT_TIMEOUT_MS= 60 s    (reserved → spawn_failed)
 *   FINISH_GRACE_MS         = 30 s    (finishing activity kept window)
 *   PID_REUSE_GRACE_MS      = 10 min  (Wave 8 HIGH 5B: PID-reuse escalation)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideStuckAction,
  STUCK_SILENCE_MS,
  STUCK_CANCEL_GRACE_MS,
  CANCEL_GRACE_MS,
  RESERVED_BOOT_TIMEOUT_MS,
  FINISH_GRACE_MS,
  PID_REUSE_GRACE_MS,
  RECEIPT_CLOSE_GRACE_MS,
} from '../../dist/lifecycle/stuck-policy.js';

// ---------------------------------------------------------------------------
// Threshold sanity — guards against an accidental constants edit.
// ---------------------------------------------------------------------------
test('stuck-policy thresholds are the documented values (drift guard)', () => {
  assert.equal(STUCK_SILENCE_MS, 10 * 60 * 1000);
  assert.equal(STUCK_CANCEL_GRACE_MS, 5 * 60 * 1000);
  assert.equal(CANCEL_GRACE_MS, 60_000);
  assert.equal(RESERVED_BOOT_TIMEOUT_MS, 60_000);
  assert.equal(FINISH_GRACE_MS, 30_000);
  assert.equal(PID_REUSE_GRACE_MS, 10 * 60 * 1000);
  assert.equal(RECEIPT_CLOSE_GRACE_MS, 10 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Input builder. Every field has a sensible default for an alive, local,
// legitimate, fresh execution; each case overrides only the fields it varies.
// ---------------------------------------------------------------------------
const NOW = 1_700_000_000_000; // arbitrary fixed epoch

/**
 * @typedef {import('../../dist/lifecycle/stuck-policy.js').StuckPolicyInput} Input
 */
/**
 * Build a baseline Input (alive local running execution that owns its task) and
 * apply `overrides`. The baseline is the "definitely KEEP" case so any
 * divergence is driven entirely by the overrides.
 */
function input(overrides = {}) {
  const reservedAt = NOW - 60_000;
  return {
    isLocal: true,
    nowMs: NOW,
    reservedAtMs: reservedAt,
    leaseExpiresAtMs: NOW + 60_000,
    progressAtMs: NOW,
    suspectedStuckAtMs: 0,
    cancelRequestedAtMs: 0,
    phaseUpdatedAtMs: NOW,
    state: 'running',
    stuckState: null,
    phase: 'running',
    isAlive: true,
    birthTokenMatches: true,
    ownsActiveTask: true,
    legitimateIntegration: false,
    legitimateFinishing: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Table-driven cases. Each row: { name, input, expected } where `expected` is
// a partial StuckAction matched on `kind` and (where relevant) `terminal`/
// `reason` substrings.
// ---------------------------------------------------------------------------
const CASES = [
  {
    name: 'silent 0min, alive → KEEP (owns active task)',
    input: input({ progressAtMs: NOW }), // 0 min silent
    expected: { kind: 'KEEP', reasonMatches: /allowed lifecycle phase/ },
  },
  {
    name: 'silent 11min, alive, owns task → MARK_SUSPECTED',
    input: input({ progressAtMs: NOW - (STUCK_SILENCE_MS + 60_000) }), // 11 min silent, grace not met
    expected: { kind: 'MARK_SUSPECTED' },
  },
  {
    name: 'suspected 6min → REQUEST_CANCEL (past 5min cancel grace)',
    input: input({
      progressAtMs: NOW - (STUCK_SILENCE_MS + 60_000),
      suspectedStuckAtMs: NOW - (STUCK_CANCEL_GRACE_MS + 60_000), // 6 min suspected
      stuckState: 'suspected_stuck',
    }),
    expected: { kind: 'REQUEST_CANCEL' },
  },
  {
    name: 'cancel 61s, birth token matches → TERMINATE',
    input: input({
      stuckState: 'cancel_requested',
      cancelRequestedAtMs: NOW - (CANCEL_GRACE_MS + 1000), // 61s
      birthTokenMatches: true,
      ownsActiveTask: false,
    }),
    expected: { kind: 'TERMINATE', reasonMatches: /verified PID identity/ },
  },
  {
    name: 'cancel 61s, birth token MISMATCH → TERMINATE_BUT_PID_REUSE',
    input: input({
      stuckState: 'cancel_requested',
      cancelRequestedAtMs: NOW - (CANCEL_GRACE_MS + 1000),
      birthTokenMatches: false, // PID reused (scenario 16)
      ownsActiveTask: false,
    }),
    expected: { kind: 'TERMINATE_BUT_PID_REUSE', reasonMatches: /birth token changed/ },
  },
  {
    name: 'cancel 30s, owns task → KEEP (still inside the 1min kill grace + legit)',
    input: input({
      stuckState: 'cancel_requested',
      cancelRequestedAtMs: NOW - 30_000, // 30s — under CANCEL_GRACE_MS
      ownsActiveTask: true, // legitimate → KEEP via the legitimacy gate
    }),
    expected: { kind: 'KEEP', reasonMatches: /allowed lifecycle phase/ },
  },
  {
    name: 'reserved 1s → KEEP (before 60s boot timeout)',
    input: input({
      state: 'reserved',
      reservedAtMs: NOW - 1000, // 1s ago
      isAlive: false, // reserved → not alive (no PID)
      ownsActiveTask: false,
    }),
    expected: { kind: 'KEEP' }, // reserved, not expired, not lease-expired → falls through, not alive → defensive KEEP
  },
  {
    name: 'reserved 61s → RELEASE(spawn_failed) (boot timeout)',
    input: input({
      state: 'reserved',
      reservedAtMs: NOW - (RESERVED_BOOT_TIMEOUT_MS + 1000), // 61s
      isAlive: false,
      ownsActiveTask: false,
    }),
    expected: { kind: 'RELEASE', terminal: 'spawn_failed', reasonMatches: /spawn reservation timed out/ },
  },
  {
    name: 'remote lease live → KEEP (decision deferred to durable lease)',
    input: input({
      isLocal: false,
      leaseExpiresAtMs: NOW + 60_000, // live lease
    }),
    expected: { kind: 'KEEP', reasonMatches: /lease still alive/ },
  },
  {
    name: 'remote lease expired → RELEASE(lost)',
    input: input({
      isLocal: false,
      leaseExpiresAtMs: NOW - 60_000, // expired
    }),
    expected: { kind: 'RELEASE', terminal: 'lost', reasonMatches: /remote lease expired/ },
  },
  {
    // Wave 8 HIGH 5A — alive + lease expired → TERMINATE (verified kill),
    // NOT RELEASE. Releasing without killing would let a second worker claim
    // the same card while the first process is still spinning. The mechanism
    // handles TERMINATE by calling probe.killVerified BEFORE
    // releaseExecutionAtomically. This dominates legitimacy (ownsActiveTask)
    // and progress-silence: the supervisor authority is gone.
    name: 'alive + lease expired → TERMINATE (verified kill, not release)',
    input: input({
      leaseExpiresAtMs: NOW - 1000, // lease expired
      isAlive: true,
      ownsActiveTask: true, // legitimacy does NOT save it — lease expiry wins
    }),
    expected: { kind: 'TERMINATE', reasonMatches: /lease expired.*verified PID identity/ },
  },
  {
    // Wave 8 HIGH 5A corner: alive + lease expired + NOT owning the task still
    // terminates (not the generic illegitimate TERMINATE — the lease-expiry
    // reason is carried so the audit trail is precise).
    name: 'alive + lease expired + illegitimate → TERMINATE (lease-expiry reason)',
    input: input({
      leaseExpiresAtMs: NOW - 1000,
      isAlive: true,
      ownsActiveTask: false,
    }),
    expected: { kind: 'TERMINATE', reasonMatches: /lease expired.*verified PID identity/ },
  },
  {
    name: 'legitimate finishing phase → KEEP',
    input: input({
      phase: 'finishing',
      phaseUpdatedAtMs: NOW - 5_000, // 5s into finishing — under FINISH_GRACE_MS
      legitimateFinishing: true,
      ownsActiveTask: false,
    }),
    expected: { kind: 'KEEP', reasonMatches: /allowed lifecycle phase/ },
  },
];

for (const c of CASES) {
  test(`stuck-policy: ${c.name}`, () => {
    const action = decideStuckAction(c.input);
    assert.equal(action.kind, c.expected.kind,
      `kind: expected ${c.expected.kind}, got ${action.kind} (reason: ${action.reason})`);
    if ('terminal' in c.expected) {
      assert.equal(action.terminal, c.expected.terminal,
        `terminal: expected ${c.expected.terminal}, got ${action.terminal}`);
    }
    if (c.expected.reasonMatches) {
      assert.match(action.reason, c.expected.reasonMatches,
        `reason did not match ${c.expected.reasonMatches}: got "${action.reason}"`);
    }
  });
}

// ---------------------------------------------------------------------------
// Focused corner-case tests that need assertions beyond the table shape.
// ---------------------------------------------------------------------------

test('stuck-policy: cancel 30s in kill grace + NOT legit → TERMINATE (alive-illegit final path)', () => {
  // Inside the kill grace, stage 3 does not fire (cancel age < CANCEL_GRACE_MS).
  // But the row is alive and NOT legitimate, so the final-alive-illegit path
  // emits TERMINATE. (The mechanism then attempts killVerified; on failure KEEP.)
  // This is the subtle fall-through preserved for byte-identity.
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - 30_000, // 30s — kill grace NOT met
    ownsActiveTask: false,
    legitimateFinishing: false,
    legitimateIntegration: false,
  }));
  assert.equal(action.kind, 'TERMINATE');
  assert.match(action.reason, /no longer owns an allowed task phase/);
});

test('stuck-policy: freshly suspected + NOT legit + alive → TERMINATE (fall-through, not MARK)', () => {
  // Progress silent 11 min on a FRESH row (stuckState null). The procedural
  // code freshly stamps suspected_stuck_at=now IN MEMORY, which makes the
  // stage-2 `since = nowMs`, so the cancel grace is NOT met on this sweep (age
  // 0). It then FALLS THROUGH to the legitimacy check. Because the row does not
  // own an allowed phase, the final-alive kill path emits TERMINATE. The policy
  // mirrors that (does NOT short-circuit MARK_SUSPECTED here — MARK is only for
  // the legitimate case).
  const action = decideStuckAction(input({
    progressAtMs: NOW - (STUCK_SILENCE_MS + 60_000), // 11 min silent
    suspectedStuckAtMs: 0, // fresh row — not yet suspected
    stuckState: null,
    ownsActiveTask: false,
    legitimateFinishing: false,
    legitimateIntegration: false,
  }));
  assert.equal(action.kind, 'TERMINATE');
  assert.match(action.reason, /no longer owns an allowed task phase/);
});

test('stuck-policy: suspected just under cancel grace + owns task → MARK_SUSPECTED', () => {
  // Progress silent 11 min, suspected stamped 4 min ago (under 5 min cancel
  // grace). Owns the task → MARK_SUSPECTED (legitimate → KEEP path).
  const action = decideStuckAction(input({
    progressAtMs: NOW - (STUCK_SILENCE_MS + 60_000), // 11 min silent
    suspectedStuckAtMs: NOW - (4 * 60 * 1000), // suspected 4 min ago
    stuckState: 'suspected_stuck',
    ownsActiveTask: true,
  }));
  assert.equal(action.kind, 'MARK_SUSPECTED');
});

test('stuck-policy: dead local process (non-reserved) → RELEASE(lost) reason cites OS process', () => {
  const action = decideStuckAction(input({
    state: 'running',
    isAlive: false, // dead process
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'lost');
  assert.match(action.reason, /OS process is not alive/);
});

test('false-lost defect: dead local process WITH accepted worker_done receipt → RELEASE(exited)', () => {
  // SANCTIONED DIVERGENCE (2026-08-17): the receipt is the durable semantic-
  // completion authority, committed before the process died. A dead process
  // holding it is the NORMAL post-worker_done close; the terminal converges
  // with what the close callback would have written ('exited'), never 'lost'.
  const action = decideStuckAction(input({
    state: 'running',
    isAlive: false,
    semanticCompletionAccepted: true,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'exited');
  assert.match(action.reason, /accepted worker_done receipt proves semantic completion/);
});

test('false-lost defect: dead cancel_requested WITH receipt → RELEASE(exited) (receipt dominates stuck stage)', () => {
  const action = decideStuckAction(input({
    state: 'cancel_requested',
    isAlive: false,
    semanticCompletionAccepted: true,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'exited');
});

test('false-lost defect: reserved row never takes the receipt branch → spawn_failed stands', () => {
  // Reserved rows cannot hold a receipt (worker_done requires a running
  // execution); the boot/lease classification is untouched.
  const action = decideStuckAction(input({
    state: 'reserved',
    reservedAtMs: NOW - (RESERVED_BOOT_TIMEOUT_MS + 1_000),
    isAlive: false,
    semanticCompletionAccepted: true,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'spawn_failed');
});

test('stuck-policy: reserved + lease expired (boot not timed out) → RELEASE(spawn_failed) lease reason', () => {
  // Reserved row whose lease expired before the 60s boot timeout: the lease
  // gate fires first and the terminal is still spawn_failed (reserved state),
  // but the reason cites the lease, not the boot timeout.
  const action = decideStuckAction(input({
    state: 'reserved',
    reservedAtMs: NOW - 5_000, // 5s — boot NOT timed out
    leaseExpiresAtMs: NOW - 1_000, // but lease expired
    isAlive: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'spawn_failed');
  assert.match(action.reason, /lease expired.*during spawn reservation/);
});

test('stuck-policy: finishing phase past FINISH_GRACE → TERMINATE (no longer legit)', () => {
  // A finishing execution whose phase and progress ages exceeded
  // FINISH_GRACE_MS is no longer legitimate → alive-illegit TERMINATE.
  // NOTE: without a worker_done receipt the receipt-close grace does not
  // apply — this is a plain (never-completed) finishing row.
  const stale = NOW - (FINISH_GRACE_MS + 5_000);
  const action = decideStuckAction(input({
    phase: 'finishing',
    phaseUpdatedAtMs: stale,
    progressAtMs: stale,
    legitimateFinishing: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'TERMINATE');
});

test('false-lost defect: receipt-backed finisher at 34s phase age → KEEP (receipt-close grace)', () => {
  // SANCTIONED DIVERGENCE (2026-08-17): 4 of 5 observed 'terminated' rows were
  // LIVE receipt-backed finishers killed 32-36s after worker_done, mid teardown
  // I/O that does not touch phase_updated_at. The receipt-close grace keeps
  // them while the PHASE transition is under RECEIPT_CLOSE_GRACE_MS.
  const action = decideStuckAction(input({
    phase: 'finishing',
    semanticCompletionAccepted: true,
    phaseUpdatedAtMs: NOW - 34_000,
    progressAtMs: NOW - 3_000,
    legitimateFinishing: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'KEEP');
  assert.match(action.reason, /receipt-close grace/);
});

test('incident bound: post-completion output cannot extend the receipt-close deadline', () => {
  // The zombie-freeze bound survives in its new form: progress output does NOT
  // extend the deadline. Past RECEIPT_CLOSE_GRACE_MS from the phase transition
  // the closer is terminated (and the atomic release reclassifies the terminal
  // to 'exited' because the receipt stands — budget-safe kill).
  const action = decideStuckAction(input({
    phase: 'finishing',
    semanticCompletionAccepted: true,
    phaseUpdatedAtMs: NOW - (RECEIPT_CLOSE_GRACE_MS + 5_000),
    progressAtMs: NOW - 3_000, // FRESH progress — must not save it
    legitimateFinishing: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'TERMINATE');
});

test('incident bound: expired lease cannot cut the receipt-close grace short either', () => {
  // The grace also preempts the Wave 8 HIGH 5A lease-expiry TERMINATE for
  // receipt-backed closers: worker_done already released the task fence, so a
  // second worker cannot claim the card and lease renewal resumes for the
  // kept row. But once the grace is exhausted, the expired lease terminates.
  const within = decideStuckAction(input({
    phase: 'integrating',
    semanticCompletionAccepted: true,
    phaseUpdatedAtMs: NOW - 34_000,
    progressAtMs: NOW - 34_000,
    leaseExpiresAtMs: NOW - 1_000,
    legitimateIntegration: false,
    ownsActiveTask: false,
  }));
  assert.equal(within.kind, 'KEEP');

  const past = decideStuckAction(input({
    phase: 'integrating',
    semanticCompletionAccepted: true,
    phaseUpdatedAtMs: NOW - (RECEIPT_CLOSE_GRACE_MS + 5_000),
    progressAtMs: NOW - 3_000,
    leaseExpiresAtMs: NOW - 1_000,
    legitimateIntegration: false,
    ownsActiveTask: false,
  }));
  assert.equal(past.kind, 'TERMINATE');
});

test('incident: accepted worker_done keeps legacy integrating process during bounded drain', () => {
  const action = decideStuckAction(input({
    phase: 'integrating',
    semanticCompletionAccepted: true,
    phaseUpdatedAtMs: NOW - 4_000,
    progressAtMs: NOW - 4_000,
    legitimateIntegration: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'KEEP');
  assert.match(action.reason, /worker_done finishing activity grace/);
});

test('stuck-policy: legitimate integrating phase → KEEP', () => {
  const action = decideStuckAction(input({
    phase: 'integrating',
    legitimateIntegration: true,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'KEEP');
  assert.match(action.reason, /allowed lifecycle phase/);
});

test('stuck-policy is pure: same input ⇒ same action (determinism)', () => {
  const inp = input({ progressAtMs: NOW - (STUCK_SILENCE_MS + 60_000), ownsActiveTask: true });
  const a1 = decideStuckAction(inp);
  const a2 = decideStuckAction(inp);
  assert.deepEqual(a1, a2, 'pure function must be deterministic');
});

// ---------------------------------------------------------------------------
// Wave 8 HIGH 5B — PID-reuse escalation (scenario 16 grace bound).
//
// When the kill grace has elapsed in cancel_requested BUT the PID birth token
// no longer matches (the OS recycled the PID), the policy refuses to kill an
// unrelated process. The card is left fenced for a human on THIS sweep
// (TERMINATE_BUT_PID_REUSE). But after PID_REUSE_GRACE_MS elapses since
// cancel_requested_at, the policy ESCALATES to RELEASE: the process is either
// dead or stolen, but the card MUST return to the queue eventually — a
// reused-PID card cannot lock the queue forever.
// ---------------------------------------------------------------------------

test('HIGH 5B: PID reuse + grace NOT exhausted → KEEP (TERMINATE_BUT_PID_REUSE)', () => {
  // cancel_requested 90s ago (past the 60s kill grace, but only 90s into the
  // 10-min PID-reuse grace). PID is alive but token differs. The row is left
  // for a human — the reuse grace has not elapsed.
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - (CANCEL_GRACE_MS + 30_000), // 90s — kill grace met
    birthTokenMatches: false, // PID reused (scenario 16)
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'TERMINATE_BUT_PID_REUSE');
  assert.match(action.reason, /birth token changed/);
});

test('HIGH 5B: PID reuse + grace exhausted → RELEASE(lost) (card returns to queue)', () => {
  // cancel_requested 11 min ago — past BOTH the 60s kill grace AND the 10-min
  // PID_REUSE_GRACE_MS. The PID birth token still mismatches, but the card can
  // no longer stay locked. The policy escalates to RELEASE so the card returns
  // to the queue; this is a human-notification event, not a permanent block.
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - (PID_REUSE_GRACE_MS + 60_000), // 11 min
    birthTokenMatches: false, // still reused
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE');
  assert.equal(action.terminal, 'lost');
  assert.match(action.reason, /PID reuse grace exhausted/);
  assert.match(action.reason, /notify human/);
});

test('HIGH 5B: PID reuse escalation boundary — exactly at grace → RELEASE (>= fires)', () => {
  // Exactly PID_REUSE_GRACE_MS since cancel_requested_at. The escalation uses
  // >= so the boundary itself already releases: the grace has fully elapsed at
  // that instant, and the card must not stay locked past it. One millisecond
  // BEFORE the grace, the row is still KEEP (covered by the next test).
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - PID_REUSE_GRACE_MS, // exactly at grace
    birthTokenMatches: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'RELEASE',
    'exactly-at-grace escalates (>= is inclusive)');
  assert.equal(action.terminal, 'lost');
});

test('HIGH 5B: PID reuse escalation boundary — 1ms before grace → KEEP', () => {
  // One millisecond before PID_REUSE_GRACE_MS elapses. The reuse grace has not
  // yet fully elapsed, so the row is still left for a human. This pins the
  // off-by-one boundary: the escalation is >=, not >.
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - (PID_REUSE_GRACE_MS - 1), // 1ms short
    birthTokenMatches: false,
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'TERMINATE_BUT_PID_REUSE',
    '1ms before grace is still KEEP');
});

test('HIGH 5B: PID reuse escalation does NOT fire when birth token matches', () => {
  // Same age (past PID_REUSE_GRACE_MS) but the birth token MATCHES — this is
  // the normal verified-kill path, not the reuse path. Escalation is specific
  // to the mismatched-token branch.
  const action = decideStuckAction(input({
    stuckState: 'cancel_requested',
    cancelRequestedAtMs: NOW - (PID_REUSE_GRACE_MS + 60_000),
    birthTokenMatches: true, // token matches → normal verified kill
    ownsActiveTask: false,
  }));
  assert.equal(action.kind, 'TERMINATE');
  assert.match(action.reason, /verified PID identity/);
});
