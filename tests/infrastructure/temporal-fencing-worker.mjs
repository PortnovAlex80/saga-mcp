// tests/infrastructure/temporal-fencing-worker.mjs
//
// Worker thread for transition-obligation-temporal-fencing.test.mjs (ADR-053
// C7-07 — the TEMPORAL FENCING closeout proof).
//
// Each worker is a stand-in for one CONCURRENT reconciler / executor generation
// racing on ONE shared obligation. It opens its OWN better-sqlite3 connection to
// a shared WAL database (the real cross-process shape) and runs in one of two
// DETERMINISTIC modes. The assertions the parent makes are all on ORDER-
// INVARIANT properties — they hold for EVERY interleaving SQLite's write lock
// can produce, so the proof is deterministic (no wall-clock races):
//
//   mode 'takeover-race':
//     The obligation is seeded NON-TERMINAL (in_progress) with a stored
//     lease_fence already STRICTLY HIGHER than `staleFence`. Each round the
//     worker (a) ALLOCATES a fresh monotonic fence (store-minted → globally
//     distinct), sampling the stored value before/after to prove it only
//     climbs, and (b) mounts a STALE attack with `staleFence` via complete /
//     fail / reclaim. Because `staleFence` < the seeded stored fence and the
//     stored fence only ever climbs (MAX-CAS), EVERY stale attack MUST be
//     rejected (TRANSITION_OBLIGATION_STALE_FENCE) — the stale holder can never
//     complete, fail, or reclaim work a newer fence owns. The worker records a
//     'SUCCESS' marker if an attack ever fails to throw (a correctness bug).
//
//   mode 'terminal-attack':
//     The obligation is seeded COMPLETED under `originalReceipt`. Each round the
//     worker attacks the terminal obligation with stale AND current/higher fences
//     via complete (different receipt), fail, reclaim, plus an idempotent
//     re-complete with the ORIGINAL receipt. A terminal state is NEVER altered:
//     complete-with-different-receipt is rejected (ALREADY_COMPLETED), fail /
//     reclaim are rejected (TERMINAL), and only the idempotent re-complete with
//     the SAME receipt is a no-op. The worker records a 'SUCCESS' marker if a
//     mutating attack (fail / reclaim / divergent complete) ever fails to throw.

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { leaseFence } from '../../dist/process-modules/domain/transition-obligation.js';

const {
  dbPath,
  obligationKey,
  workerId,
  rounds,
  staleFence,
  mode,
  originalReceipt,
} = workerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('synchronous = NORMAL');
db.exec(SCHEMA_SQL); // idempotent against the shared file

const ledger = new SqliteTransitionObligationLedger(db);

// Classify a rejection reason into a stable token for order-invariant assertions.
function classify(message) {
  if (/STALE_FENCE/.test(message)) return 'STALE_FENCE';
  if (/TERMINAL/.test(message)) return 'TERMINAL';
  if (/ALREADY_COMPLETED/.test(message)) return 'ALREADY_COMPLETED';
  return 'OTHER';
}

if (mode === 'takeover-race') {
  const allocated = [];
  const storedSamples = [];
  const attackResults = { complete: [], fail: [], reclaim: [] };

  for (let i = 0; i < rounds; i++) {
    // (a) Allocate a fresh monotonic fence; sample the stored value before/after.
    const before = ledger.readLeaseFence(obligationKey);
    const f = ledger.allocateLeaseFence(obligationKey).value;
    const after = ledger.readLeaseFence(obligationKey);
    allocated.push(f);
    storedSamples.push({ before, after });

    // (b) STALE complete — must ALWAYS be rejected.
    try {
      ledger.complete({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(staleFence),
        completionReceipt: `STALE/w${workerId}/${i}`,
        resultDigest: 'sha256:stale',
      });
      attackResults.complete.push('SUCCESS'); // must never happen
    } catch (e) {
      attackResults.complete.push(classify(e.message));
    }

    // (b) STALE fail — must ALWAYS be rejected.
    try {
      ledger.fail({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(staleFence),
        error: `STALE_FAIL/w${workerId}/${i}`,
      });
      attackResults.fail.push('SUCCESS'); // must never happen
    } catch (e) {
      attackResults.fail.push(classify(e.message));
    }

    // (b) STALE reclaim — must ALWAYS be rejected.
    try {
      ledger.reclaim({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(staleFence),
      });
      attackResults.reclaim.push('SUCCESS'); // must never happen
    } catch (e) {
      attackResults.reclaim.push(classify(e.message));
    }
  }

  db.close();
  parentPort.postMessage({ workerId, allocated, storedSamples, attackResults });
} else if (mode === 'terminal-attack') {
  const results = {
    completeDivergent: [], // complete with a DIFFERENT receipt — must be rejected
    completeIdempotent: [], // complete with the ORIGINAL receipt — no-op allowed
    fail: [], // fail on terminal — must be rejected
    reclaim: [], // reclaim on terminal — must be rejected
    allocated: [],
  };

  for (let i = 0; i < rounds; i++) {
    // Climbing the fence cannot lower it; the higher fence proves even a CURRENT
    // holder cannot alter a terminal state.
    const higher = ledger.allocateLeaseFence(obligationKey).value;
    results.allocated.push(higher);

    // complete with a divergent receipt under the higher fence — rejected.
    try {
      ledger.complete({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(higher),
        completionReceipt: `OTHER/w${workerId}/${i}`,
        resultDigest: 'sha256:other',
      });
      results.completeDivergent.push('SUCCESS'); // must never happen
    } catch (e) {
      results.completeDivergent.push(classify(e.message));
    }

    // Idempotent re-complete with the ORIGINAL receipt — allowed no-op (the
    // converged read path returns the existing obligation without mutating it).
    try {
      ledger.complete({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(higher),
        completionReceipt: originalReceipt,
        resultDigest: 'sha256:result',
      });
      results.completeIdempotent.push('SUCCESS');
    } catch (e) {
      results.completeIdempotent.push(classify(e.message));
    }

    // fail on a terminal obligation — rejected, regardless of fence.
    try {
      ledger.fail({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(higher),
        error: `LATE_FAIL/w${workerId}/${i}`,
      });
      results.fail.push('SUCCESS'); // must never happen
    } catch (e) {
      results.fail.push(classify(e.message));
    }

    // reclaim on a terminal obligation — rejected, regardless of fence.
    try {
      ledger.reclaim({
        obligationKey,
        owner: `w${workerId}`,
        fence: leaseFence(higher),
      });
      results.reclaim.push('SUCCESS'); // must never happen
    } catch (e) {
      results.reclaim.push(classify(e.message));
    }
  }

  db.close();
  parentPort.postMessage({ workerId, results });
} else {
  db.close();
  throw new Error(`TEMPORAL_FENCING_WORKER_UNKNOWN_MODE: ${mode}`);
}
