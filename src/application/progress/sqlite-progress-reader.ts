// src/application/progress/sqlite-progress-reader.ts
//
// Adapter for the CONVEYOR §23 progress-obligation invariant: gather the exact
// durable facts for every nonterminal Workplace and classify them.
//
// The facts come only from authoritative tables (factory_workplaces,
// worker_executions, factory_transition_obligations, factory_effect_attempts,
// factory_workplace_dependencies, factory_workplace_recovery_epochs). Task
// rows, board columns and log activity are projections and are deliberately
// not consulted — the model forbids them from explaining authority.

import type Database from 'better-sqlite3';

import {
  classifyWorkplaceProgress,
  defaultEffectAttemptCap,
  isHealthyProgress,
  type ProgressExplanation,
  type WorkplaceLoopState,
  type WorkplaceProgressFacts,
} from './progress-classification.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Classify every nonterminal Workplace in the database.
 *
 * `now` is injected so a historical database can be judged against the clock
 * of its own run rather than today's wall time.
 */
export function classifyFactoryProgress(
  db: Database.Database,
  options: { readonly now?: Date; readonly processRunId?: number } = {},
): readonly ProgressExplanation[] {
  if (!tableExists(db, 'factory_workplaces')) return [];
  const now = (options.now ?? new Date()).toISOString();
  const hasObligations = tableExists(db, 'factory_transition_obligations');
  const hasAttempts = tableExists(db, 'factory_effect_attempts');
  const hasDependencies = tableExists(db, 'factory_workplace_dependencies');
  const hasEpochs = tableExists(db, 'factory_workplace_recovery_epochs');
  const hasExecutions = tableExists(db, 'worker_executions');

  const workplaces = db.prepare(
    `SELECT workplace_ref,loop_state,terminal_reason,active_reservation_ref
       FROM factory_workplaces
      WHERE loop_state <> 'terminal'
        AND (? IS NULL OR process_run_id = ?)
      ORDER BY workplace_ref`,
  ).all(
    options.processRunId ?? null,
    options.processRunId ?? null,
  ) as Array<{
    workplace_ref: string;
    loop_state: string;
    terminal_reason: string | null;
    active_reservation_ref: string | null;
  }>;

  return workplaces.map(workplace => {
    const facts: WorkplaceProgressFacts = {
      workplaceRef: workplace.workplace_ref,
      loopState: workplace.loop_state as WorkplaceLoopState,
      terminalReason: workplace.terminal_reason,
      activeReservationRef: workplace.active_reservation_ref,
      execution: hasExecutions
        ? readExecution(db, workplace.active_reservation_ref, now)
        : null,
      openObligations: hasObligations
        ? readOpenObligations(db, workplace.workplace_ref)
        : [],
      effectAttempts: hasAttempts
        ? readLatestEffectAttempts(db, workplace.workplace_ref)
        : [],
      unsatisfiedDependencies: hasDependencies
        ? countUnsatisfiedDependencies(db, workplace.workplace_ref)
        : 0,
      repairAttempts: hasEpochs ? readRepairAttempts(db, workplace.workplace_ref) : null,
      repairCap: hasEpochs ? readRepairCap(db, workplace.workplace_ref) : null,
      effectAttemptCap: defaultEffectAttemptCap(),
    };
    return classifyWorkplaceProgress(facts);
  });
}

/** Only the scopes that cannot prove they will still move. */
export function findStalledScopes(
  db: Database.Database,
  options: { readonly now?: Date; readonly processRunId?: number } = {},
): readonly ProgressExplanation[] {
  return classifyFactoryProgress(db, options)
    .filter(explanation => !isHealthyProgress(explanation.classification));
}

/**
 * Resolve the execution the Workplace itself names as its mutation owner.
 *
 * The authority is `factory_workplaces.active_reservation_ref` — the Workplace
 * declares its actor. We deliberately do NOT search worker_executions by task,
 * because a task row is a projection and cannot establish who owns a mutation.
 * A reservation that points at an already-terminal execution resolves to null,
 * which is exactly the "state claims an owner, none exists" stall.
 */
function readExecution(
  db: Database.Database,
  activeReservationRef: string | null,
  now: string,
): WorkplaceProgressFacts['execution'] {
  if (!activeReservationRef) return null;
  const row = db.prepare(
    `SELECT execution_id,lease_expires_at
       FROM worker_executions
      WHERE execution_id=?
        AND state IN ('reserved','running','cancel_requested')`,
  ).get(activeReservationRef) as {
    execution_id: string;
    lease_expires_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    executionId: row.execution_id,
    // A missing deadline cannot prove ownership, so it counts as expired.
    leaseExpired: row.lease_expires_at === null || row.lease_expires_at <= now,
  };
}

function readOpenObligations(
  db: Database.Database,
  workplaceRef: string,
): WorkplaceProgressFacts['openObligations'] {
  const rows = db.prepare(
    `SELECT handoff_kind,state
       FROM factory_transition_obligations
      WHERE subject_ref=? AND state <> 'completed'
      ORDER BY handoff_kind`,
  ).all(workplaceRef) as Array<{ handoff_kind: string; state: string }>;
  return rows.map(row => ({ handoffKind: row.handoff_kind, state: row.state }));
}

/**
 * Attempts for the most recent desired state of this Workplace. Attempts are
 * scoped by idempotency key (the acceptance digest), so a Workplace that has
 * been accepted more than once reports only its current subject.
 */
function readLatestEffectAttempts(
  db: Database.Database,
  workplaceRef: string,
): WorkplaceProgressFacts['effectAttempts'] {
  const latest = db.prepare(
    `SELECT idempotency_key
       FROM factory_effect_attempts
      WHERE workplace_ref=?
      ORDER BY attempt_no DESC, created_at DESC
      LIMIT 1`,
  ).get(workplaceRef) as { idempotency_key: string } | undefined;
  if (!latest) return [];
  const rows = db.prepare(
    `SELECT attempt_no,outcome
       FROM factory_effect_attempts
      WHERE workplace_ref=? AND idempotency_key=?
      ORDER BY attempt_no ASC`,
  ).all(workplaceRef, latest.idempotency_key) as Array<{
    attempt_no: number; outcome: string;
  }>;
  return rows.map(row => ({ attemptNo: row.attempt_no, outcome: row.outcome }));
}

function countUnsatisfiedDependencies(
  db: Database.Database,
  workplaceRef: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM factory_workplace_dependencies d
       JOIN factory_workplaces w ON w.workplace_ref=d.depends_on_workplace_ref
      WHERE d.workplace_ref=?
        AND NOT (w.loop_state='terminal' AND w.terminal_reason='accepted')`,
  ).get(workplaceRef) as { n: number };
  return row.n;
}

function readRepairAttempts(db: Database.Database, workplaceRef: string): number | null {
  const row = db.prepare(
    `SELECT SUM(exhausted_attempts) AS n
       FROM factory_workplace_recovery_epochs
      WHERE workplace_ref=?`,
  ).get(workplaceRef) as { n: number | null } | undefined;
  return row?.n ?? null;
}

function readRepairCap(db: Database.Database, workplaceRef: string): number | null {
  const row = db.prepare(
    `SELECT total_attempts_cap
       FROM factory_workplace_recovery_epochs
      WHERE workplace_ref=?
      ORDER BY epoch DESC
      LIMIT 1`,
  ).get(workplaceRef) as { total_attempts_cap: number } | undefined;
  return row?.total_attempts_cap ?? null;
}
