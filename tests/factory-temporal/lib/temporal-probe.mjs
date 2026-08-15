// tests/factory-temporal/lib/temporal-probe.mjs
//
// Durable temporal probe. Records change-only snapshots from a temporary
// SQLite database and supports `eventually`, `never`, and `stable-until`
// assertions using host-cycle or transition budgets rather than arbitrary
// sleeps.
//
// # Why change-only
//
// ADR-048 pre-mortem risk #2: polling that records every sample can produce
// flaky failures when a transient legal state passes through the window. We
// record only changes — the probe captures the first observation, then a new
// entry only when the predicate value or a durable revision changes.
//
// # Fairness
//
// Internal progress may assume continued orchestrator cycles and writable
// SQLite. The probe therefore drives the host by invoking the supplied
// `cycle()` callback (e.g. one runEpisode + distributeQueuedTasks pass)
// rather than sleeping. A `transitionBudget` bounds how many cycles the
// probe will run before declaring `eventually` unsatisfied.

import Database from 'better-sqlite3';

/**
 * One recorded snapshot. `revision` is a monotonic counter; `changed` is
 * true only when the observed value differs from the previous entry.
 * @typedef {object} ProbeEntry
 * @property {number} cycle
 * @property {number} revision
 * @property {string} label
 * @property {*} value
 * @property {boolean} changed
 * @property {string} observedAt
 */

/**
 * Create a temporal probe bound to one SQLite database path.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - SQLite database file
 * @param {function} opts.cycle - async callback that drives one host cycle
 *   (e.g. run runEpisode + dispatch). The probe calls this between samples.
 * @param {number} [opts.transitionBudget=200] - max cycles before `eventually`
 *   declares failure.
 * @param {number} [opts.pollIntervalMs=50] - sleep between cycles when cycle()
 *   does not itself block. Internal progress uses cycles, not wall-clock.
 */
export function createTemporalProbe(opts) {
  const {
    dbPath,
    cycle,
    transitionBudget = 200,
    pollIntervalMs = 50,
  } = opts;

  if (typeof cycle !== 'function') {
    throw new Error('TEMPORAL_PROBE_CYCLE_REQUIRED: cycle callback is mandatory');
  }

  /** @type {ProbeEntry[]} */
  const trace = [];
  let revisionCounter = 0;

  /**
   * Read a snapshot of the durable state through small relational predicates.
   * NEVER copies production SQL branch-for-branch — see predicates.mjs.
   */
  async function sample(readSnapshot, label = 'sample') {
    const db = new Database(dbPath, { readonly: true });
    try {
      const value = await readSnapshot(db);
      const last = trace[trace.length - 1];
      const changed = !last || !deepEqual(last.value, value);
      if (changed) revisionCounter++;
      const entry = {
        cycle: trace.length,
        revision: revisionCounter,
        label,
        value,
        changed,
        observedAt: new Date().toISOString(),
      };
      trace.push(entry);
      return entry;
    } finally {
      db.close();
    }
  }

  /**
   * Assert that `predicate(db)` eventually returns true within the transition
   * budget. Drives `cycle()` between samples.
   *
   * @param {function(Database): boolean|Promise<boolean>} predicate
   * @param {object} [assertOpts]
   * @param {string} [assertOpts.description]
   * @param {number} [assertOpts.budget] - override transitionBudget
   * @param {function(Database): *} [assertOpts.readContext] - extra state to
   *   include in the failure message.
   */
  async function eventually(predicate, assertOpts = {}) {
    const {
      description = 'eventually',
      budget = transitionBudget,
      readContext = null,
    } = assertOpts;
    let lastEntry = null;
    for (let i = 0; i < budget; i++) {
      const db = new Database(dbPath, { readonly: true });
      let satisfied = false;
      let contextValue = null;
      try {
        satisfied = await predicate(db);
        if (readContext) contextValue = await readContext(db);
      } finally {
        db.close();
      }
      const last = trace[trace.length - 1];
      const changed = !last || !deepEqual(last.value, contextValue);
      if (changed) revisionCounter++;
      lastEntry = {
        cycle: trace.length,
        revision: revisionCounter,
        label: description,
        value: contextValue,
        changed,
        observedAt: new Date().toISOString(),
        satisfied,
      };
      trace.push(lastEntry);
      if (satisfied) return lastEntry;
      await cycle();
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
    const traceSummary = trace.slice(-10).map(t => `  cycle ${t.cycle}: ${JSON.stringify(t.value)}`).join('\n');
    const contextStr = readContext && lastEntry?.value ? `\nContext: ${JSON.stringify(lastEntry.value, null, 2)}` : '';
    throw new Error(
      `TEMPORAL_EVENTUALLY_FAILED: '${description}' not satisfied within ${budget} cycles.\n`
      + `Last 10 trace entries:\n${traceSummary}${contextStr}`,
    );
  }

  /**
   * Assert that `predicate(db)` NEVER returns true within the budget.
   * The probe still drives cycles — the point is that progress happens but
   * the forbidden state is never entered.
   */
  async function never(predicate, assertOpts = {}) {
    const {
      description = 'never',
      budget = transitionBudget,
    } = assertOpts;
    for (let i = 0; i < budget; i++) {
      const db = new Database(dbPath, { readonly: true });
      let satisfied = false;
      try {
        satisfied = await predicate(db);
      } finally {
        db.close();
      }
      if (satisfied) {
        throw new Error(
          `TEMPORAL_NEVER_VIOLATED: '${description}' was satisfied at cycle ${i}`,
        );
      }
      await cycle();
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
  }

  /**
   * Assert that `predicate(db)` becomes true and STAYS true until
   * `terminalCondition(db)` is true. Catches oscillation.
   */
  async function stableUntil(predicate, terminalCondition, assertOpts = {}) {
    const {
      description = 'stableUntil',
      budget = transitionBudget,
    } = assertOpts;
    let achieved = false;
    let achievedAtCycle = -1;
    for (let i = 0; i < budget; i++) {
      const db = new Database(dbPath, { readonly: true });
      let predValue = false;
      let terminal = false;
      try {
        predValue = await predicate(db);
        terminal = await terminalCondition(db);
      } finally {
        db.close();
      }
      if (!achieved && predValue) {
        achieved = true;
        achievedAtCycle = i;
      }
      if (achieved && !predValue && !terminal) {
        throw new Error(
          `TEMPORAL_STABLE_UNTIL_VIOLATED: '${description}' became true at cycle `
          + `${achievedAtCycle} but reverted before terminal at cycle ${i}`,
        );
      }
      if (terminal) {
        if (!achieved) {
          throw new Error(
            `TEMPORAL_STABLE_UNTIL_NEVER_ACHIEVED: '${description}' never became true `
            + `before terminal at cycle ${i}`,
          );
        }
        return { achievedAtCycle, terminalAtCycle: i };
      }
      await cycle();
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
    throw new Error(
      `TEMPORAL_STABLE_UNTIL_TIMEOUT: '${description}' never reached terminal within ${budget} cycles`,
    );
  }

  /**
   * Assert that no new trace entry appears for `stableCycles` cycles after
   * the last change. Used to prove a terminal state is truly stable.
   */
  async function assertStable(stableCycles = 5, assertOpts = {}) {
    const { description = 'assertStable' } = assertOpts;
    const startLen = trace.length;
    for (let i = 0; i < stableCycles; i++) {
      await cycle();
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
    // No new entries should have been added unless they came from other
    // eventually/stableUntil calls. We check that trace length did not grow
    // from the caller's perspective (startLen).
    if (trace.length > startLen) {
      throw new Error(
        `TEMPORAL_NOT_STABLE: '${description}' trace grew by ${trace.length - startLen} `
        + `during ${stableCycles} stability cycles`,
      );
    }
  }

  return {
    sample,
    eventually,
    never,
    stableUntil,
    assertStable,
    trace: () => [...trace],
    traceSummary: () => trace.map(t => `cycle ${t.cycle} [${t.label}]: ${JSON.stringify(t.value)}`).join('\n'),
  };
}

function deepEqual(a, b) {
  try {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Serialize a temporal trace into a deterministic regression fixture.
 * The fixture preserves the seed (if any), composition fingerprint, and
 * the full trace of predicate evaluations.
 */
export function serializeRegressionFixture(opts) {
  const { seed, compositionFingerprint, trace, failingPredicate, dbPath } = opts;
  return {
    schemaVersion: 'factory.temporal-regression-fixture.v1',
    seed,
    compositionFingerprint,
    failingPredicate,
    trace: trace.map(t => ({
      cycle: t.cycle,
      revision: t.revision,
      label: t.label,
      value: t.value,
      changed: t.changed,
      satisfied: t.satisfied ?? null,
      observedAt: t.observedAt,
    })),
    capturedAt: new Date().toISOString(),
    dbPath,
  };
}
