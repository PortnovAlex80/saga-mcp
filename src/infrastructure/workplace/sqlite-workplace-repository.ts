/**
 * SqliteWorkplaceRepository — authoritative Workplace aggregate store (step 1.2).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05 (Рабочее место —
 * Workplace) + Conveyor Mental Model v4 §«Two-channel state».
 *
 * # What this repository owns
 *
 * The Workplace is the PRIMARY aggregate of the conveyor (REG-05). It owns
 * authoritative two-channel state — `kanbanPhase`, `loopState`, `nextRole`,
 * `terminalReason` — plus a monotonic `revision` token used for CAS at the
 * transition boundary (REG-05-AC-06: "state transition uses expected revision
 * CAS and is idempotent under replay").
 *
 * # CAS discipline (REG-05-AC-02/06)
 *
 * `applyTransition` is the ONLY writer of (kanban_phase, loop_state, next_role,
 * terminal_reason, revision). It does a compare-and-set: the UPDATE matches
 * `WHERE workplace_ref=? AND revision=?expected`. A stale actor (a worker or
 * gate that read revision N while revision has since advanced to N+1) gets
 * `changes=0` and the repository throws `WORKPLACE_CAS_FAILED` — the loser of
 * a GateRun-vs-worker claim race cannot mutate (REG-05-AC-02, E2E-08).
 *
 * # Step 1 scope
 *
 * At step 1.2 this repository EXISTS and is covered by tests, but nothing on
 * the runtime path reads or writes it yet. Step 1.3 (WorkItem projector)
 * it the single authority. The repository is intentionally complete now so
 * the projector and the coordinator (step 2) consume one proven-correct
 * store from day one.
 *
 *
 * The single-writer ratchet (`tasks-writer-invariant.test.mjs`) names exactly
 * three files allowed to write `tasks.{status,assigned_to,current_execution_id}`.
 * This repository is NOT in that set and does NOT touch `tasks`. It writes
 * only the new `factory_workplaces` table.
 */

import type Database from 'better-sqlite3';
import {
  assertAllowedPhaseLoopPair,
  assertValidWorkplaceState,
  asWorkplaceRef,
  initialWorkplaceState,
  isRoleCompatibleWithPhase,
  phaseForTerminalReason,
  serializeWorkplaceRef,
  type KanbanPhase,
  type LoopState,
  type NextRole,
  type TerminalReason,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../process-modules/domain/workplace/index.js';

/** A row read from factory_workplaces, in the repository's concrete shape. */
interface WorkplaceRow {
  workplace_ref: string;
  process_run_id: number;
  module_ref: string;
  production_cell_id: string;
  work_key: string;
  kanban_phase: KanbanPhase;
  loop_state: LoopState;
  next_role: NextRole;
  terminal_reason: TerminalReason | null;
  revision: number;
  active_reservation_ref: string | null;
  active_gate_ref: string | null;
  active_recovery_case_ref: string | null;
  desk_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Result of an attempted transition. `applied=true` when the CAS matched and
 * the row advanced; `applied=false` when a concurrent writer won the revision
 * race (caller MUST re-read and re-evaluate — it MUST NOT blindly retry with
 * the same expected revision, which would be a stale-write attempt).
 */
export interface TransitionResult {
  readonly applied: boolean;
  /** The post-transition state when applied; the pre-transition state when not. */
  readonly state: WorkplaceState;
  /** The persisted revision after the attempt (unchanged when not applied). */
  readonly revision: number;
}

/**
 * Input to {@link SqliteWorkplaceRepository.applyTransition}. The caller
 * supplies the NEXT channel values and the revision it currently believes the
 * workplace is at. The repository CAS-matches that revision; on success it
 * bumps revision by 1 and writes the new values.
 *
 * `activeReservationRef`/`activeGateRef`/`activeRecoveryCaseRef` are optional
 * actor-binding fields — at most one mutation actor may own a revision
 * (REG-05-AC-02). The coordinator sets these when it claims a lease/gate and
 * clears them when the actor terminates.
 */
export interface TransitionInput {
  readonly workplaceRef: WorkplaceRef;
  readonly expectedRevision: number;
  readonly kanbanPhase: KanbanPhase;
  readonly loopState: LoopState;
  readonly nextRole: NextRole;
  readonly terminalReason: TerminalReason | null;
  readonly activeReservationRef?: string | null;
  readonly activeGateRef?: string | null;
  readonly activeRecoveryCaseRef?: string | null;
}

export class SqliteWorkplaceRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Materialize a new Workplace at `todo/idle` (v4 §«From production order to
   * the first worker»). Idempotent on `workplace_ref`: a repeat call for the
   * same ref returns the existing row unchanged (REG-04-AC-03 — fan-out does
   * not mint duplicates on reorder/replay).
   *
   * Throws if the ref already exists with a DIFFERENT identity-shape (a caller
   * passed a mismatched (processRunId, moduleRef, ...)). Same ref + same shape
   * = idempotent no-op; same ref + different shape = integrity violation.
   */
  materialize(input: {
    processRunId: number;
    moduleRef: string;
    productionCellId: string;
    workKey?: string;
  }): WorkplaceState {
    const ref = asWorkplaceRef(input);
    const serialized = serializeWorkplaceRef(ref);
    const existing = this.readRow(serialized);
    if (existing) {
      // Idempotency: confirm the identity components match.
      if (
        existing.process_run_id !== ref.processRunId
        || existing.module_ref !== ref.moduleRef
        || existing.production_cell_id !== ref.productionCellId
        || existing.work_key !== ref.workKey
      ) {
        throw new Error(
          `WORKPLACE_IDENTITY_CONFLICT: ref '${serialized}' already exists with `
            + 'different identity components',
        );
      }
      return rowToState(existing);
    }
    const initial = initialWorkplaceState();
    this.db.prepare(
      `INSERT INTO factory_workplaces
         (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
          kanban_phase, loop_state, next_role, terminal_reason, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    ).run(
      serialized,
      ref.processRunId,
      ref.moduleRef,
      ref.productionCellId,
      ref.workKey,
      initial.kanbanPhase,
      initial.loopState,
      initial.nextRole,
    );
    return initial;
  }

  /**
   * Read the authoritative WorkplaceState. Returns null when the workplace
   * has not been materialized.
   */
  read(ref: WorkplaceRef): WorkplaceState | null {
    const row = this.readRow(serializeWorkplaceRef(ref));
    return row ? rowToState(row) : null;
  }

  /**
   * Read the raw actor-binding fields (active reservation/gate/recovery). The
   * coordinator uses these to enforce REG-05-AC-02 (at most one mutation actor
   * per revision) before applying a transition.
   */
  readActiveActors(ref: WorkplaceRef): {
    activeReservationRef: string | null;
    activeGateRef: string | null;
    activeRecoveryCaseRef: string | null;
  } | null {
    const row = this.readRow(serializeWorkplaceRef(ref));
    if (!row) return null;
    return {
      activeReservationRef: row.active_reservation_ref,
      activeGateRef: row.active_gate_ref,
      activeRecoveryCaseRef: row.active_recovery_case_ref,
    };
  }

  /**
   * Atomically apply a state transition via CAS on `revision` (REG-05-AC-06).
   *
   * The UPDATE matches `WHERE workplace_ref=? AND revision=?expected`. On
   * success revision bumps to expected+1. On a CAS miss (changes=0) the
   * repository returns `{applied: false}` with the CURRENT state — the caller
   * must re-read and re-evaluate. This is the single chokepoint for owner-
   * column writes; no other method mutates channel state.
   *
   * Validates the target state BEFORE writing:
   *   - REG-28-AC-01: phase×loop pair is in the closed allowed table.
   *   - REG-28-AC-03: role is consistent with phase.
   *   - REG-28-AC-05: terminal reason ↔ phase consistency.
   * A domain violation throws (no partial write — validation runs before the
   * UPDATE inside the same IMMEDIATE transaction).
   */
  applyTransition(input: TransitionInput): TransitionResult {
    // Validate the TARGET state first (pure-domain check, no DB).
    const targetState: WorkplaceState = {
      kanbanPhase: input.kanbanPhase,
      loopState: input.loopState,
      nextRole: input.nextRole,
      revision: input.expectedRevision + 1,
      terminalReason: input.terminalReason,
    };
    assertValidWorkplaceState(targetState);

    const serialized = serializeWorkplaceRef(input.workplaceRef);
    // BEGIN IMMEDIATE so the read-validate-write is one atomic step: a
    // concurrent writer cannot advance the revision between our read and our
    // CAS UPDATE.
    return this.withImmediateTransaction(() => this.applyTransitionInTx(input, serialized));
  }

  /**
   * Apply a transition WITHOUT opening a transaction — for callers (the
   * ConveyorRuntime) that already hold a transaction and need the workplace
   * CAS + reverse projection to commit atomically together. The caller is
   * responsible for the BEGIN IMMEDIATE / COMMIT boundary.
   *
   * Same CAS semantics as {@link applyTransition}: matches expected revision,
   * bumps by 1 on success, returns `{applied:false}` on a CAS miss.
   */
  applyTransitionInTx(input: TransitionInput, serialized?: string): TransitionResult {
    // Validate the TARGET state first (pure-domain check, no DB).
    const targetState: WorkplaceState = {
      kanbanPhase: input.kanbanPhase,
      loopState: input.loopState,
      nextRole: input.nextRole,
      revision: input.expectedRevision + 1,
      terminalReason: input.terminalReason,
    };
    assertValidWorkplaceState(targetState);

    const ser = serialized ?? serializeWorkplaceRef(input.workplaceRef);
    const current = this.readRow(ser);
    if (!current) {
      throw new Error(`WORKPLACE_NOT_FOUND: '${ser}' was not materialized`);
    }
    if (current.revision !== input.expectedRevision) {
      // CAS miss — a concurrent writer already advanced the revision.
      return {
        applied: false,
        state: rowToState(current),
        revision: current.revision,
      };
    }
    const info = this.db.prepare(
      `UPDATE factory_workplaces
          SET kanban_phase=?, loop_state=?, next_role=?, terminal_reason=?,
              revision=revision+1,
              active_reservation_ref=?,
              active_gate_ref=?,
              active_recovery_case_ref=?,
              updated_at=datetime('now')
        WHERE workplace_ref=? AND revision=?`,
    ).run(
      input.kanbanPhase,
      input.loopState,
      input.nextRole,
      input.terminalReason,
      input.activeReservationRef ?? null,
      input.activeGateRef ?? null,
      input.activeRecoveryCaseRef ?? null,
      ser,
      input.expectedRevision,
    );
    if (info.changes !== 1) {
      // Lost the CAS race between read and UPDATE (extremely tight window
      // under BEGIN IMMEDIATE, but defensive).
      const after = this.readRow(ser)!;
      return { applied: false, state: rowToState(after), revision: after.revision };
    }
    const after = this.readRow(ser)!;
    return { applied: true, state: rowToState(after), revision: after.revision };
  }

  /**
   * Convenience: does this workplace's Kanban phase equal a target? Used by
   * the projector (step 1.3) to filter which workplaces to project.
   */
  isKanbanPhase(ref: WorkplaceRef, phase: KanbanPhase): boolean {
    const row = this.readRow(serializeWorkplaceRef(ref));
    return row?.kanban_phase === phase;
  }

  /**
   * List workplaces in a ProcessRun. Used by the projector (step 1.3) and by
   * diagnostics. Returns refs + states in deterministic order.
   */
  listInProcessRun(processRunId: number): Array<{ ref: WorkplaceRef; state: WorkplaceState }> {
    const rows = this.db.prepare(
      `SELECT * FROM factory_workplaces WHERE process_run_id=? ORDER BY workplace_ref`,
    ).all(processRunId) as WorkplaceRow[];
    return rows.map(row => ({
      ref: asWorkplaceRef({
        processRunId: row.process_run_id,
        moduleRef: row.module_ref,
        productionCellId: row.production_cell_id,
        workKey: row.work_key,
      }),
      state: rowToState(row),
    }));
  }

  // -----------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------

  private readRow(serialized: string): WorkplaceRow | null {
    const row = this.db.prepare(
      'SELECT * FROM factory_workplaces WHERE workplace_ref=?',
    ).get(serialized) as WorkplaceRow | undefined;
    return row ?? null;
  }

  private withImmediateTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* tx may not be active */ }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Row → domain-state mapping. Validates the persisted pair/role/terminal on
// read, so a row corrupted by a bypass of the write-time validator is caught
// at the read boundary (defence in depth for REG-28).
// ---------------------------------------------------------------------------

function rowToState(row: WorkplaceRow): WorkplaceState {
  // Defence in depth: re-assert the closed pair on read. A row written by a
  // future bypass of applyTransition would fail here, surfacing the violation
  // at the read instead of letting it propagate.
  assertAllowedPhaseLoopPair(row.kanban_phase, row.loop_state);
  if (row.loop_state === 'terminal' && row.terminal_reason === null) {
    throw new Error(
      `WORKPLACE_STATE_CORRUPT: '${row.workplace_ref}' loop=terminal but terminal_reason is null`,
    );
    }
  if (row.loop_state !== 'terminal' && row.terminal_reason !== null) {
    throw new Error(
      `WORKPLACE_STATE_CORRUPT: '${row.workplace_ref}' loop!=terminal but terminal_reason='${row.terminal_reason}'`,
    );
  }
  // Role consistency is only enforceable for non-terminal phases.
  if (row.loop_state !== 'terminal') {
    if (!isRoleCompatibleWithPhase(row.kanban_phase, row.next_role)) {
      throw new Error(
        `WORKPLACE_STATE_CORRUPT: '${row.workplace_ref}' role '${row.next_role}' `
          + `incompatible with phase '${row.kanban_phase}'`,
      );
    }
  }
  if (row.terminal_reason !== null) {
    const expectedPhase = phaseForTerminalReason(row.terminal_reason);
    if (row.kanban_phase !== expectedPhase) {
      throw new Error(
        `WORKPLACE_STATE_CORRUPT: '${row.workplace_ref}' terminal_reason `
          + `'${row.terminal_reason}' requires phase '${expectedPhase}', got '${row.kanban_phase}'`,
      );
    }
  }
  return Object.freeze({
    kanbanPhase: row.kanban_phase,
    loopState: row.loop_state,
    nextRole: row.next_role,
    revision: row.revision,
    terminalReason: row.terminal_reason,
  }) as WorkplaceState;
}
