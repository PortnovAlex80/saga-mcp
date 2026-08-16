/**
 * Factory boot revision — controller-owned stale-worker reconciliation.
 *
 * The operator pain: when the factory engine is killed, its per-epic reaper
 * dies with it. Workplaces in `leased|running` with dead worker processes
 * remain in those states forever — the board shows "In Progress" /
 * "Reviewing" with nobody actually working. On the next engine start the
 * executor sees `running` and returns pending (it doesn't check execution
 * liveness), so the phantom persists even after restart.
 *
 * This pass runs once under the orchestration controller fence, across ALL
 * projects and epics — not scoped to any single engine's epic:
 *
 *   1. TB-9 adoption (kernel-owned: verifying/effect_pending with terminal
 *      executions) — already global
 *   2. TB-11 burial (dead lifecycles: obligations → failed, kernel-owned
 *      workplaces → terminal, phantom tasks → cancelled) — already global
 *   3. Stale-worker sweep (worker-owned: leased/running with dead workers
 *      → releaseExecution('crashed') → repair_wait, task fence cleared)
 *
 * The sweep reuses the EXISTING reaper chain (`reconcileWorkerExecutions` →
 * `releaseExecutionAtomically` → `ConveyorRuntime.releaseExecution('crashed')`)
 * — it introduces NO new semantics, only a new call site. The reaper's policy
 * already handles: PID liveness check, birth-token verification, cross-process
 * lease expiry, accepted-receipt skip (monotonicity of verifying with proof),
 * retry-budget exhaustion → pauseForHuman.
 *
 * Safety:
 * - Live workers (running PID on this or another machine) → KEEP (untouched)
 * - `verifying` with accepted receipt → SKIP (adoption owns it)
 * - `effect_pending` → SKIP (kernel re-drives from accepted CandidateSet)
 * - `paused/blocked` → SKIP (human resume path)
 * - Terminal workplaces → SKIP (monotonicity)
 * - Workplaces of dead lifecycles → SKIP (burial owns them)
 * - Idempotent: second run finds 0 rows (execution already `lost`, loop
 *   already `repair_wait`)
 *
 * After this pass, the DB is truthful: dead reservations cleared, workplaces
 * in `repair_wait` (the executor's first `runEpisode` will drive them to
 * `queued` with retry-budget check). The Kanban column stays `in_progress` /
 * `review_in_progress` per REG-28-AC-02 — the "buffer" is `queued` inside
 * the phase, not a rollback to `todo`.
 */
import type Database from 'better-sqlite3';
import { adoptTerminalExecutionsAtEngineStart } from './engine-start-adoption.js';
import { buryDeadLifecycleObligations } from './engine-start-lifecycle-burial.js';
import { reconcileWorkerExecutions } from '../worker-executions.js';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import type { ReconcileResult } from '../worker-executions.js';

export interface FactoryBootRevisionResult {
  readonly adoption: ReturnType<typeof adoptTerminalExecutionsAtEngineStart>;
  readonly burial: ReturnType<typeof buryDeadLifecycleObligations>;
  readonly swept: readonly {
    readonly projectId: number;
    readonly epicId: number;
    readonly executionId: string;
    readonly taskId: number;
    readonly action: string;
    readonly reason: string;
  }[];
  readonly scopesChecked: number;
}

export function runFactoryBootRevision(
  db: Database.Database,
): FactoryBootRevisionResult {
  // Phase 1: kernel-owned states (verifying/effect_pending with terminal
  // executions + spawn-failed hybrids). Already global, already idempotent.
  const adoption = adoptTerminalExecutionsAtEngineStart(db);

  // Phase 2: dead lifecycles. Already global, already idempotent.
  const burial = buryDeadLifecycleObligations(db);

  // Phase 3: stale-worker sweep. Mirrors the chain inside
  // SqliteExecutionRuntimeRepository.reconcile but with an injected DB:
  //   (a) reaper: terminalize dead executions, clear task fences
  //   (b) for each lost/terminated with a workplace binding AND no accepted
  //       receipt: ConveyorRuntime.releaseExecution('crashed') on the workplace
  //       (running → repair_wait, reservation cleared, Kanban preserved)
  const scopes = db.prepare(
    `SELECT DISTINCT project_id, epic_id
       FROM worker_executions
      WHERE state IN ('reserved','running','cancel_requested')`,
  ).all() as Array<{ project_id: number; epic_id: number }>;

  const swept: {
    projectId: number; epicId: number; executionId: string;
    taskId: number; action: string; reason: string;
  }[] = [];
  const conveyor = new ConveyorRuntime(db);

  for (const scope of scopes) {
    // Read the execution→workplace bindings BEFORE the reaper runs. Use the
    // workplace's active_reservation_ref (the authoritative worker pointer),
    // not tasks.current_execution_id (which the reaper clears).
    const bindings = db.prepare(
      `SELECT DISTINCT w.workplace_ref, w.loop_state, t.id AS task_id
         FROM factory_workplaces w
         LEFT JOIN tasks t ON t.workplace_ref = w.workplace_ref
        WHERE w.process_run_id IN (
          SELECT DISTINCT pr.id FROM factory_process_runs pr
           WHERE pr.project_id=? AND pr.epic_id=?
        ) AND w.active_reservation_ref IS NOT NULL
          AND w.loop_state IN ('leased','running')`,
    ).all(scope.project_id, scope.epic_id) as Array<{
      workplace_ref: string; loop_state: string; task_id: number | null;
    }>;
    // Build a map: execution_id → { workplace_ref, task_id } via the
    // workplace's reservation pointer
    const bindingByWorkplace = new Map(
      bindings.map(row => [row.workplace_ref, row] as const),
    );
    // Also read which execution each workplace is reserving
    const reservationRows = db.prepare(
      `SELECT workplace_ref, active_reservation_ref FROM factory_workplaces
        WHERE active_reservation_ref IS NOT NULL
          AND loop_state IN ('leased','running')
          AND process_run_id IN (
            SELECT DISTINCT pr.id FROM factory_process_runs pr
             WHERE pr.project_id=? AND pr.epic_id=?
          )`,
    ).all(scope.project_id, scope.epic_id) as Array<{
      workplace_ref: string; active_reservation_ref: string;
    }>;
    const reservationByWorkplace = new Map(
      reservationRows.map(row =>
        [row.active_reservation_ref, row.workplace_ref] as const,
      ),
    );

    // (a) Reap: terminalize dead executions, clear task fences
    const results: readonly ReconcileResult[] = reconcileWorkerExecutions(
      db, scope.project_id, scope.epic_id,
    );

    // (b) Release the workplace for each dead worker
    for (const result of results) {
      if (result.action !== 'lost' && result.action !== 'terminated') continue;
      swept.push({
        projectId: scope.project_id,
        epicId: scope.epic_id,
        executionId: result.executionId,
        taskId: result.taskId,
        action: result.action,
        reason: result.reason,
      });

      // Find the workplace this execution was reserving
      const workplaceRef = reservationByWorkplace.get(result.executionId);
      if (!workplaceRef) continue;

      // Monotonicity guard: if worker_done was accepted, the material is
      // sealed (or in verifying) — adoption owns it, not the reaper.
      const semanticCompletionAccepted = Boolean(db.prepare(
        `SELECT 1 FROM command_receipts
          WHERE execution_id=? AND command_kind IN ('worker_done','presentation_close')
            AND accepted=1 LIMIT 1`,
      ).get(result.executionId));
      if (semanticCompletionAccepted) continue;

      // Find the task for this workplace (for the ConveyorRuntime call)
      const binding = bindingByWorkplace.get(workplaceRef);
      if (!binding?.task_id) continue;

      try {
        conveyor.releaseExecution({
          workplaceRef: deserializeWorkplaceRef(workplaceRef),
          reservationRef: result.executionId,
          taskId: binding.task_id,
          outcome: 'crashed',
        });
      } catch {
        // CAS race or fence mismatch — the next engine start re-evaluates
      }
    }
  }

  return { adoption, burial, swept, scopesChecked: scopes.length };
}
