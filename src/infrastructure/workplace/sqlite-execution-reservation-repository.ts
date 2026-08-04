/**
 * SqliteExecutionReservationRepository — durable launch authority (step 1.2).
 *
 * Target contract: REG-09 (Наряд и пропуск — ExecutionReservation).
 *
 * # Race chokepoint (REG-09-AC-01)
 *
 * `create` is the single chokepoint for "two dispatchers racing for one queued
 * workplace produce one effective reservation". The reservation ref is the
 * deterministic derivation over (workplace_ref, role, workplace_revision) —
 * two racers compute the SAME ref, so the UNIQUE PK accepts only the first
 * INSERT and the second throws SQLITE_CONSTRAINT_PRIMARY_KEY. The repository
 * translates that into a `RESERVATION_RACE_LOST` result so the caller can
 * re-read and re-evaluate without treating it as a fatal error.
 *
 * # Lifecycle (REG-09)
 *
 *   queued → consumed  (Execution Control launched one WorkerExecution)
 *   queued → expired   (lease passed before launch)
 *   queued → cancelled (authorized actor cancelled)
 *
 * All three terminal transitions are one-way; the repository enforces them via
 * CAS on state (the UPDATE matches `WHERE reservation_ref=? AND state='queued'`).
 *
 * Step 1.2 scope: EXISTS and tested; nothing on the runtime path uses it yet.
 */

import type Database from 'better-sqlite3';
import {
  assertValidExecutionReservation,
  executionReservationRef,
  type ExecutionReservation,
  type ExecutionReservationState,
} from '../../process-modules/domain/workplace/index.js';
import type { NextRole } from '../../process-modules/domain/workplace/workplace-state.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export interface CreateReservationInput {
  readonly workplaceRef: WorkplaceRef;
  readonly expectedWorkplaceRevision: number;
  readonly role: NextRole;
  readonly idempotencyKey: string;
  readonly fenceToken: string;
  readonly expiresAt: string;
}

export type CreateReservationResult =
  | { kind: 'created'; reservation: ExecutionReservation }
  | { kind: 'race_lost'; winner: ExecutionReservation };

export class SqliteExecutionReservationRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a reservation. Idempotency + race resolution via the deterministic
   * PK: two callers racing for the same (workplace, role, revision) compute
   * the same ref; the first INSERT wins, the second gets `race_lost` with the
   * winner's row (REG-09-AC-01).
   *
   * Runs inside BEGIN IMMEDIATE so the ref derivation, the existence check and
   * the INSERT are one atomic step — a third racer cannot slip between them.
   */
  create(input: CreateReservationInput): CreateReservationResult {
    const reservation: ExecutionReservation = {
      reservationRef: executionReservationRef({
        workplaceRef: input.workplaceRef,
        role: input.role,
        expectedWorkplaceRevision: input.expectedWorkplaceRevision,
      }),
      workplaceRef: input.workplaceRef,
      expectedWorkplaceRevision: input.expectedWorkplaceRevision,
      role: input.role,
      idempotencyKey: input.idempotencyKey,
      fenceToken: input.fenceToken,
      expiresAt: input.expiresAt,
      state: 'queued',
    };
    // Validate the shape BEFORE any DB write (REG-09).
    assertValidExecutionReservation(reservation);

    return this.withImmediateTransaction(() => {
      const existing = this.readRow(reservation.reservationRef);
      if (existing) {
        // Same ref already exists — another dispatcher won this revision.
        return { kind: 'race_lost', winner: rowToReservation(existing) } as CreateReservationResult;
      }
      this.db.prepare(
        `INSERT INTO v4_execution_reservations
           (reservation_ref, workplace_ref, expected_workplace_revision, role,
            idempotency_key, fence_token, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
      ).run(
        reservation.reservationRef,
        serializeWorkplaceRef(input.workplaceRef),
        input.expectedWorkplaceRevision,
        input.role,
        input.idempotencyKey,
        input.fenceToken,
        input.expiresAt,
      );
      return { kind: 'created', reservation } as CreateReservationResult;
    });
  }

  /** Read a reservation by ref. Returns null when absent. */
  read(reservationRef: string): ExecutionReservation | null {
    const row = this.readRow(reservationRef);
    return row ? rowToReservation(row) : null;
  }

  /**
   * Transition a queued reservation to a terminal state (consumed/expired/
   * cancelled). CAS on `state='queued'` — a terminal reservation cannot be
   * re-transitioned. Returns true when the CAS matched.
   */
  terminate(
    reservationRef: string,
    target: Exclude<ExecutionReservationState, 'queued'>,
  ): boolean {
    const info = this.db.prepare(
      `UPDATE v4_execution_reservations
          SET state=?, updated_at=datetime('now')
        WHERE reservation_ref=? AND state='queued'`,
    ).run(target, reservationRef);
    return info.changes === 1;
  }

  /**
   * List active (queued) reservations for a workplace. Used by diagnostics and
   * by the dispatcher to check for an already-issued reservation before
   * creating a new one.
   */
  listQueuedForWorkplace(workplaceRef: WorkplaceRef): ExecutionReservation[] {
    const rows = this.db.prepare(
      `SELECT * FROM v4_execution_reservations
        WHERE workplace_ref=? AND state='queued'
        ORDER BY created_at`,
    ).all(serializeWorkplaceRef(workplaceRef)) as ReservationRow[];
    return rows.map(rowToReservation);
  }

  // -----------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------

  private readRow(reservationRef: string): ReservationRow | null {
    const row = this.db.prepare(
      'SELECT * FROM v4_execution_reservations WHERE reservation_ref=?',
    ).get(reservationRef) as ReservationRow | undefined;
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

interface ReservationRow {
  reservation_ref: string;
  workplace_ref: string;
  expected_workplace_revision: number;
  role: NextRole;
  idempotency_key: string;
  fence_token: string;
  expires_at: string;
  state: ExecutionReservationState;
}

function rowToReservation(row: ReservationRow): ExecutionReservation {
  return {
    reservationRef: row.reservation_ref,
    workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
    expectedWorkplaceRevision: row.expected_workplace_revision,
    role: row.role,
    idempotencyKey: row.idempotency_key,
    fenceToken: row.fence_token,
    expiresAt: row.expires_at,
    state: row.state,
  };
}

function deserializeWorkplaceRef(serialized: string): WorkplaceRef {
  const parts = serialized.split('/');
  if (parts.length < 5 || parts[0] !== 'workplace') {
    throw new Error(`RESERVATION_CORRUPT: invalid workplace_ref '${serialized}'`);
  }
  return {
    processRunId: Number(parts[1]),
    moduleRef: parts[2]!,
    productionCellId: parts[3]!,
    workKey: parts.slice(4).join('/'),
  } as WorkplaceRef;
}
