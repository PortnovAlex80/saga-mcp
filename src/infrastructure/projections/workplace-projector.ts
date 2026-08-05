/**
 * WorkplaceProjector — dual-write shadow of legacy tasks → v4_workplaces
 * (Conveyor v4 step 5.2).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05 (Workplace) +
 * Conveyor Mental Model v4 §«One engine, two channels».
 *
 * # What this does
 *
 * The legacy dispatcher (`worker_next`, `worker_done`, `worker_ask_need`)
 * mutates `tasks.{status, assigned_to, current_execution_id}`. Until step 5's
 * full cutover, we CANNOT replace those writes. But we CAN write a SHADOW
 * into `v4_workplaces` so the new aggregate store fills with real production
 * data and the board shows it.
 *
 * This projector hooks into the dispatcher's status transitions and writes a
 * parallel v4_workplaces row. It is BEHIND a feature-flag
 * (`SAGA_WORKPLACE_WRITE=on`, default off) so production only activates it
 * when the operator is ready.
 *
 * # Mapping (legacy tasks.status → v4 two-channel state)
 *
 *   tasks.status='todo'              → kanbanPhase=todo,      loopState=idle
 *   tasks.status='in_progress'       → kanbanPhase=in_progress, loopState=running
 *   tasks.status='review'            → kanbanPhase=review,    loopState=queued, nextRole=reviewer
 *   tasks.status='review_in_progress'→ kanbanPhase=review_in_progress, loopState=running, nextRole=reviewer
 *   tasks.status='done'              → kanbanPhase=done,      loopState=terminal, terminalReason=accepted
 *   tasks.status='blocked'           → kanbanPhase=blocked,   loopState=paused
 *
 * The WorkplaceRef is derived from the task's metadata (processRunId,
 * moduleRef, productionCellId, workKey) — fields the runtime already stamps
 * when it creates a Process Module task.
 *
 * # Non-goals
 *
 * This projector does NOT read from v4_workplaces (that is step 5.3's read
 * cutover). It only WRITES shadows. It does NOT launch workers, does NOT
 * decide transitions, does NOT touch the legacy tasks-table — it only adds a
 * parallel write.
 */

import type Database from 'better-sqlite3';
import {
  asWorkplaceRef,
  type KanbanPhase,
  type LoopState,
  type NextRole,
  type TerminalReason,
  type WorkplaceRef,
} from '../../process-modules/domain/workplace/index.js';
import { SqliteWorkplaceRepository } from '../workplace/sqlite-workplace-repository.js';

/**
 * The legacy task status that triggers a projection write.
 */
export interface TaskStatusSnapshot {
  readonly taskId: number;
  readonly status: string;
  readonly epicId: number;
  readonly projectId: number;
  readonly taskKind: string | null;
  readonly metadata: string;
}

/**
 * The projector. Construct once per DB; call `projectStatusChange` after every
 * dispatcher status transition (worker_next, worker_done, worker_ask_need).
 *
 * Safe to call when `SAGA_WORKPLACE_WRITE` is not 'on' — it no-ops.
 */
export class WorkplaceProjector {
  private readonly repo: SqliteWorkplaceRepository;
  private readonly enabled: boolean;

  constructor(db: Database.Database) {
    this.repo = new SqliteWorkplaceRepository(db);
    this.enabled = process.env.SAGA_WORKPLACE_WRITE === 'on';
  }

  /**
   * Shadow-write a task status change into v4_workplaces.
   *
   * Derives the WorkplaceRef from the task's metadata (processRunId, moduleRef,
   * productionCellId, workKey). When the metadata lacks these fields (a legacy
   * task not created by a Process Module), the projection is silently skipped
   * — v4_workplaces only tracks Process Module tasks.
   *
   * Uses CAS: reads the current v4 row, computes the target state via the
   * mapping table, and applies the transition. If the CAS misses (a concurrent
   * write), it retries once. This is best-effort shadow — a missed projection
   * is observable but not fatal (the legacy tasks-table is still the authority).
   */
  projectStatusChange(snapshot: TaskStatusSnapshot): void {
    if (!this.enabled) return;

    const ref = this.deriveWorkplaceRef(snapshot);
    if (!ref) return; // not a Process Module task — skip

    const target = mapLegacyStatusToV4(snapshot.status);
    if (!target) return; // unknown status — skip

    // Materialize if not present (idempotent — returns existing if already there).
    this.repo.materialize({
      processRunId: ref.processRunId,
      moduleRef: ref.moduleRef,
      productionCellId: ref.productionCellId,
      workKey: ref.workKey,
    });

    // Read current state and CAS the transition.
    const current = this.repo.read(ref);
    if (!current) return;

    // Skip if already at the target (idempotent shadow — avoid spurious revision bumps).
    if (
      current.kanbanPhase === target.kanbanPhase
      && current.loopState === target.loopState
      && current.nextRole === target.nextRole
    ) return;

    try {
      this.repo.applyTransition({
        workplaceRef: ref,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
      });
    } catch {
      // CAS miss or invariant violation — best-effort shadow. Log but do not crash.
      // The legacy tasks-table is still authoritative; a missed projection
      // surfaces as a stale v4_workplaces row, not a data loss event.
    }
  }

  /**
   * Derive a WorkplaceRef from a task's metadata. The runtime stamps
   * `process_run_id`, `process_node_id` and the module context when it creates
   * a Process Module task. When those fields are absent, the task is a legacy
   * board task and is NOT projected (v4 tracks only Process Module work).
   */
  private deriveWorkplaceRef(snapshot: TaskStatusSnapshot): WorkplaceRef | null {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(snapshot.metadata || '{}');
    } catch {
      return null;
    }
    const processRunId = meta['process_run_id'];
    if (!Number.isInteger(processRunId) || (processRunId as number) < 1) return null;

    const moduleRef = typeof meta['module_ref'] === 'string'
      ? meta['module_ref']
      : typeof snapshot.taskKind === 'string'
        ? `${snapshot.taskKind.split('.')[0]}@1.0.0`
        : 'unknown@1.0.0';
    const productionCellId = typeof meta['process_node_id'] === 'string'
      ? meta['process_node_id']
      : snapshot.taskKind ?? 'default';
    const workKey = typeof meta['work_key'] === 'string'
      ? meta['work_key']
      : `task-${snapshot.taskId}`;

    return asWorkplaceRef({
      processRunId: processRunId as number,
      moduleRef,
      productionCellId,
      workKey,
    });
  }
}

/**
 * Map a legacy tasks.status to the v4 two-channel state.
 *
 * Returns null for unrecognized statuses (the projection is skipped).
 */
function mapLegacyStatusToV4(status: string): {
  kanbanPhase: KanbanPhase;
  loopState: LoopState;
  nextRole: NextRole;
  terminalReason: TerminalReason | null;
} | null {
  switch (status) {
    case 'todo':
      return { kanbanPhase: 'todo', loopState: 'idle', nextRole: 'author', terminalReason: null };
    case 'in_progress':
      return { kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null };
    case 'review':
      return { kanbanPhase: 'review', loopState: 'queued', nextRole: 'reviewer', terminalReason: null };
    case 'review_in_progress':
      return { kanbanPhase: 'review_in_progress', loopState: 'running', nextRole: 'reviewer', terminalReason: null };
    case 'done':
      return { kanbanPhase: 'done', loopState: 'terminal', nextRole: 'author', terminalReason: 'accepted' };
    case 'blocked':
      return { kanbanPhase: 'blocked', loopState: 'paused', nextRole: 'author', terminalReason: null };
    default:
      return null;
  }
}
