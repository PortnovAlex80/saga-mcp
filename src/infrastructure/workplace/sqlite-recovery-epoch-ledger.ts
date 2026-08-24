import type Database from 'better-sqlite3';
import { recoveryEpochBackoffMs } from '../../process-modules/domain/workplace/production-cell-definition.js';

/**
 * TASK-SHADOW F4 (audit) — the ADR-075 recovery-epoch reads/writes as
 * PRODUCTION helpers instead of duplicated inline SQL.
 *
 * Before this module the exact same epoch SQL lived twice: once as the
 * composition-root closures (src/app/product-lifecycle-runtime.ts) and once
 * in the task-shadow integration harness — the B-004/W-1 "no second divergent
 * predicate" house rule violated by copy. Both sites now call THESE helpers;
 * the SQLite statements and the backoff-deadline derivation have exactly one
 * owner.
 *
 * The `ORDER BY epoch DESC LIMIT 1` frontier read is the classified K7/K8
 * shape (see tests/architecture/authority-recency-classification.test.mjs):
 * `epoch` is a per-(workplace, role) ordinal minted monotonically by the
 * rollover writer under `UNIQUE (workplace_ref, role, epoch)`, never wall
 * clock chronology, and the picked row itself carries the full baseline
 * material — chronology selects the frontier of an already-exactly-named
 * epoch chain, not a material subject.
 */

export interface RecoveryEpochBaseline {
  readonly epoch: number;
  readonly baselineRejectedSets: number;
  readonly baselineTerminalExecutions: number;
  readonly baselineEffectRepairs: number;
  readonly rolledBackoffUntilMs: number;
  readonly lastDiagnosis?: string | null;
}

/**
 * The latest recovery-epoch rollover for a (workplace, role): the attempt
 * counter baselines frozen at the last exhaustion plus the inter-epoch
 * backoff deadline (derived from the immutable row's `created_at` — SQLite
 * `datetime('now')` is UTC — and the epoch's exponential delay).
 */
export function readRecoveryEpochBaseline(
  db: Database.Database,
  workplaceRef: string,
  role: 'author' | 'reviewer',
): RecoveryEpochBaseline | null {
  const row = db.prepare(
    `SELECT epoch, baseline_rejected_sets, baseline_terminal_executions,
            baseline_effect_repairs, created_at, last_diagnosis
       FROM factory_workplace_recovery_epochs
      WHERE workplace_ref=? AND role=?
      ORDER BY epoch DESC LIMIT 1`,
  ).get(workplaceRef, role) as {
    epoch: number;
    baseline_rejected_sets: number;
    baseline_terminal_executions: number;
    baseline_effect_repairs: number;
    created_at: string;
    last_diagnosis: string | null;
  } | undefined;
  if (!row) return null;
  return {
    epoch: row.epoch,
    baselineRejectedSets: row.baseline_rejected_sets,
    baselineTerminalExecutions: row.baseline_terminal_executions,
    baselineEffectRepairs: row.baseline_effect_repairs,
    // BLINDSIGHT F6 — deliver the PREVIOUS epoch's persisted diagnosis to
    // the rollover decision (written at every rollover, previously never
    // read: epoch amnesia).
    lastDiagnosis: row.last_diagnosis ?? null,
    rolledBackoffUntilMs:
      Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
      + recoveryEpochBackoffMs(row.epoch),
  };
}

export interface RecoveryEpochRolloverInput {
  readonly workplaceRef: string;
  readonly role: 'author' | 'reviewer';
  readonly epoch: number;
  readonly baselineRejectedSets: number;
  readonly baselineTerminalExecutions: number;
  readonly baselineEffectRepairs: number;
  readonly exhaustedAttempts: number;
  readonly maxAttempts: number;
  readonly totalAttemptsCap: number;
  readonly lastDiagnosis: string | null;
}

/** Append one immutable rollover row; idempotent by the UNIQUE
 *  (workplace_ref, role, epoch) constraint. */
export function recordRecoveryEpoch(
  db: Database.Database,
  input: RecoveryEpochRolloverInput,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO factory_workplace_recovery_epochs
       (workplace_ref, role, epoch,
        baseline_rejected_sets, baseline_terminal_executions,
        baseline_effect_repairs, exhausted_attempts,
        max_attempts, total_attempts_cap, last_diagnosis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.workplaceRef,
    input.role,
    input.epoch,
    input.baselineRejectedSets,
    input.baselineTerminalExecutions,
    input.baselineEffectRepairs,
    input.exhaustedAttempts,
    input.maxAttempts,
    input.totalAttemptsCap,
    input.lastDiagnosis,
  );
}
