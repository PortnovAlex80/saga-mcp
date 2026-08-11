import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import { sha256Hex } from '../shared/canonical-json.js';

export const PRE_SPAWN_RECOVERY_POLICY_REF = 'factory.pre-spawn-recovery.v1';

const RESOLVED_FAILURE_CODES = [
  'REPOSITORY_DESK_BASE_MISMATCH',
] as const;

export const PRE_SPAWN_RECOVERY_POLICY_DIGEST = sha256Hex({
  policyRef: PRE_SPAWN_RECOVERY_POLICY_REF,
  resolvedFailureCodes: RESOLVED_FAILURE_CODES,
  action: 'fresh-author-execution-scoped-desk',
});

export interface AutomaticPreSpawnRecoveryResult {
  readonly recoveryRef: string;
  readonly executionId: string;
  readonly workplaceRef: string;
  readonly resultingRevision: number;
  readonly replayed: boolean;
}

function readFailureCode(error: string | null): string | null {
  if (!error) return null;
  for (const code of RESOLVED_FAILURE_CODES) {
    if (error.includes(`${code}:`)) return code;
  }
  return null;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table));
}

/**
 * Reconcile one historical human pause that is now covered by an installed
 * Factory provisioning fix. Unknown and actual process-spawn failures remain
 * paused. No candidate, gate, product, or terminal execution is rewritten.
 */
export function reconcileAutomaticPreSpawnRecovery(
  db: Database.Database,
  lifecycleRunId: number,
): AutomaticPreSpawnRecoveryResult | null {
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare(
      `SELECT lr.id AS lifecycle_run_id, sr.process_run_id,
              w.workplace_ref, w.revision, w.next_role,
              w.active_reservation_ref, w.active_gate_ref,
              w.active_recovery_case_ref,
              t.id AS task_id, t.assigned_to, t.current_execution_id,
              we.execution_id, we.last_error, we.pid, we.started_at
         FROM factory_lifecycle_runs lr
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
         JOIN factory_workplaces w ON w.process_run_id=sr.process_run_id
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
         JOIN worker_executions we ON we.execution_id=(
           SELECT latest.execution_id FROM worker_executions latest
            WHERE latest.task_id=t.id
            ORDER BY latest.reserved_at DESC, latest.execution_id DESC LIMIT 1
         )
        WHERE lr.id=? AND lr.status='paused' AND sr.status='paused'
          AND w.kanban_phase='blocked' AND w.loop_state='paused'
          AND we.state='spawn_failed'`,
    ).all(lifecycleRunId) as Array<{
      lifecycle_run_id: number;
      process_run_id: number;
      workplace_ref: string;
      revision: number;
      next_role: 'author' | 'reviewer';
      active_reservation_ref: string | null;
      active_gate_ref: string | null;
      active_recovery_case_ref: string | null;
      task_id: number;
      assigned_to: string | null;
      current_execution_id: string | null;
      execution_id: string;
      last_error: string | null;
      pid: number | null;
      started_at: string | null;
    }>;

    const eligible = rows.filter(row => readFailureCode(row.last_error) !== null);
    if (eligible.length === 0) {
      db.exec('COMMIT');
      return null;
    }
    if (eligible.length !== 1) {
      throw new Error(
        `AUTOMATIC_PRE_SPAWN_RECOVERY_NOT_UNIQUE: lifecycle ${lifecycleRunId} `
        + `has ${eligible.length} eligible workplaces`,
      );
    }
    const row = eligible[0]!;
    const failureCode = readFailureCode(row.last_error)!;
    const prior = db.prepare(
      `SELECT recovery_ref, resulting_revision FROM factory_automatic_spawn_recovery_receipts
        WHERE execution_id=?`,
    ).get(row.execution_id) as {
      recovery_ref: string;
      resulting_revision: number;
    } | undefined;
    if (prior) {
      db.exec('COMMIT');
      return {
        recoveryRef: prior.recovery_ref,
        executionId: row.execution_id,
        workplaceRef: row.workplace_ref,
        resultingRevision: prior.resulting_revision,
        replayed: true,
      };
    }

    if (
      row.next_role !== 'author'
      || row.pid !== null
      || row.started_at !== null
      || row.active_reservation_ref
      || row.active_gate_ref
      || row.active_recovery_case_ref
      || row.assigned_to
      || row.current_execution_id
    ) {
      throw new Error(
        `AUTOMATIC_PRE_SPAWN_RECOVERY_UNSAFE: ${row.workplace_ref} still has actor/process authority`,
      );
    }
    const executionEvidence = {
      submissions: tableExists(db, 'factory_managed_node_submissions')
        ? (db.prepare(
            'SELECT COUNT(*) n FROM factory_managed_node_submissions WHERE execution_id=?',
          ).get(row.execution_id) as { n: number }).n
        : 0,
      done_receipts: (db.prepare(
        `SELECT COUNT(*) n FROM command_receipts
          WHERE execution_id=? AND command_kind='worker_done' AND accepted=1`,
      ).get(row.execution_id) as { n: number }).n,
      candidate_sets: tableExists(db, 'factory_candidate_sets')
        ? (db.prepare(
            'SELECT COUNT(*) n FROM factory_candidate_sets WHERE producer_execution_ref=?',
          ).get(row.execution_id) as { n: number }).n
        : 0,
    };
    if (
      executionEvidence.submissions !== 0
      || executionEvidence.done_receipts !== 0
      || executionEvidence.candidate_sets !== 0
    ) {
      throw new Error(
        `AUTOMATIC_PRE_SPAWN_RECOVERY_UNSAFE: execution ${row.execution_id} produced authority`,
      );
    }

    const failureDigest = sha256Hex({
      executionId: row.execution_id,
      failureCode,
      lastError: row.last_error,
      pid: row.pid,
      startedAt: row.started_at,
    });
    const recoveryRef = `automatic-spawn-recovery:${sha256Hex({
      lifecycleRunId,
      processRunId: row.process_run_id,
      workplaceRef: row.workplace_ref,
      expectedRevision: row.revision,
      executionId: row.execution_id,
      failureDigest,
      policyDigest: PRE_SPAWN_RECOVERY_POLICY_DIGEST,
    })}`;
    const resumed = new ConveyorRuntime(db).resumeFromHuman({
      workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
      taskId: row.task_id,
      role: 'author',
    });
    if (!resumed.applied || resumed.workplace.revision !== row.revision + 1) {
      throw new Error(
        `AUTOMATIC_PRE_SPAWN_RECOVERY_CAS_FAILED: ${row.workplace_ref}`,
      );
    }
    db.prepare(
      `INSERT INTO factory_automatic_spawn_recovery_receipts
         (recovery_ref, execution_id, lifecycle_run_id, process_run_id,
          workplace_ref, expected_revision, resulting_revision, task_id,
          failure_code, failure_digest, recovery_policy_ref, recovery_policy_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recoveryRef,
      row.execution_id,
      lifecycleRunId,
      row.process_run_id,
      row.workplace_ref,
      row.revision,
      resumed.workplace.revision,
      row.task_id,
      failureCode,
      failureDigest,
      PRE_SPAWN_RECOVERY_POLICY_REF,
      PRE_SPAWN_RECOVERY_POLICY_DIGEST,
    );
    db.exec('COMMIT');
    return {
      recoveryRef,
      executionId: row.execution_id,
      workplaceRef: row.workplace_ref,
      resultingRevision: resumed.workplace.revision,
      replayed: false,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}
