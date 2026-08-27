/**
 * tools/frf-corpus/lib/faults.mjs - the FRF crash/restart fault layer
 * (FRF-WP10), the sibling of the EK WP-13B scenario-fault scheduler for
 * the NEW semantic chain.
 *
 * The desks of the formalization chain are pure exported functions over
 * immutable content-addressed artifacts; the DURABLE seams of the flow
 * are the immutable kernel-evidence submissions of the WP07 persistence
 * module (KernelEvidence:what-baseline, KernelEvidence:solution-contract)
 * and the D12/D5 typed waits are the RESUME POINTS: a crash while a wait
 * is open resumes at the wait disposition, never at a re-derived desk.
 *
 * THE SCENARIO-LEVEL CRASH LAW (mirrors the EK law exactly): a fault
 * scheduled at EVERY named crash window settles, after restart, to the
 * IDENTICAL normalized world as the clean run (exactly-once logical
 * outcome). Restarts re-derive every desk output from the green seed
 * (pure functions) and restore the evidence ledger THROUGH ITS PUBLIC
 * submit() path by replaying the durable rows - never by writing
 * authority state directly.
 *
 * PURITY: no clock, no timers, no network, no kernel database.
 */

/* ------------------------------------------------------------------ */
/* The crash signal                                                    */
/* ------------------------------------------------------------------ */

export class FrfFaultCrashError extends Error {
  constructor(fault, anchor) {
    super(`FRF FAULT ${fault} @ ${anchor} (the driving process died at the named window)`);
    this.name = 'FrfFaultCrashError';
    this.fault = fault;
    this.anchor = anchor;
  }
}

/** Arm at most one crash from a validated fault schedule (one process dies once). */
export function armFrfFaults(schedule) {
  const crashes = (schedule ?? []).filter((entry) => typeof entry?.fault === 'string' && entry.fault.startsWith('crash-'));
  if (crashes.length > 1) {
    throw new Error(`the scenario schedules ${crashes.length} crashes; one process dies once`);
  }
  return crashes.length === 1 ? crashes[0] : null;
}

/** The scheduler of one armed crash: fires exactly at its named window. */
export class FrfFaultScheduler {
  constructor(armed) {
    this.armed = armed;
    this.fired = false;
  }

  /** Fire the crash if this window is the armed one (idempotent: once). */
  fire(fault, anchor) {
    if (this.armed === null || this.fired) return;
    if (this.armed.fault !== fault || this.armed.anchor !== anchor) return;
    this.fired = true;
    throw new FrfFaultCrashError(fault, anchor);
  }
}

/* ------------------------------------------------------------------ */
/* The durable session (evidence ledger + rows)                        */
/* ------------------------------------------------------------------ */

/**
 * The FRF durable session: the WP07 KernelEvidenceLedger plus the
 * durable-row journal that survives a crash (the snapshot is taken
 * atomically with each evidence commit; everything else is re-derived).
 */
export class FrfDurableSession {
  /** @param {object} persistence the WP07 persistence module */
  constructor(persistence, restoredRows = []) {
    this.persistence = persistence;
    this.rows = restoredRows.map((row) => ({ ...row }));
    this.ledger = new persistence.KernelEvidenceLedger();
    // Restore THROUGH THE PUBLIC PATH: replay every durable row's
    // submission (identical content -> identical action keys).
    for (const row of this.rows) {
      const outcome = this.ledger.submit(row.evidenceKind, row.caseRef, row.artifact);
      if (outcome.ok !== true) {
        throw new Error(`ledger restoration refused row ${row.actionKey}: ${JSON.stringify(outcome)}`);
      }
    }
  }

  /**
   * Submit one immutable kernel-evidence product and journal the durable
   * row atomically with the commit (the row IS the durable fact).
   */
  submitEvidence(evidenceKind, caseRef, artifact) {
    const outcome = this.ledger.submit(evidenceKind, caseRef, artifact);
    if (outcome.ok === true && outcome.outcome === 'success') {
      this.rows.push({ actionKey: outcome.actionKey, artifact, caseRef, evidenceKind, receiptDigest: outcome.receiptDigest });
    }
    return outcome;
  }

  /** The durable snapshot (the rows that survive a crash). */
  snapshotRows() {
    return this.rows.map((row) => ({ ...row }));
  }
}

/* ------------------------------------------------------------------ */
/* The named crash windows (the coverage matrix)                       */
/* ------------------------------------------------------------------ */

/** The desks that own an immutable kernel-evidence commit seam. */
export const EVIDENCE_COMMIT_DESKS = ['freeze-what-baseline', 'settle-formalization'];

/** The wait disposition seam (the D5 resume point). */
export const WAIT_DISPOSITION_ANCHOR = 'd5-human-wait';

/**
 * The full crash-window matrix of the formalization flow: every desk
 * (before/after) plus the evidence-commit seams and the D5 wait
 * disposition seams. A scenario with dimension 'crash-restart-matrix'
 * sweeps every window; the law is the identical normalized world.
 */
export function frfCrashWindows(deskIds) {
  const windows = [];
  for (const desk of deskIds) {
    windows.push({ anchor: desk, fault: 'crash-before-desk' });
    windows.push({ anchor: desk, fault: 'crash-after-desk' });
    if (EVIDENCE_COMMIT_DESKS.includes(desk)) {
      windows.push({ anchor: desk, fault: 'crash-before-evidence-commit' });
      windows.push({ anchor: desk, fault: 'crash-after-evidence-commit' });
    }
  }
  windows.push({ anchor: WAIT_DISPOSITION_ANCHOR, fault: 'crash-before-wait-disposition' });
  windows.push({ anchor: WAIT_DISPOSITION_ANCHOR, fault: 'crash-after-wait-disposition' });
  return windows;
}
