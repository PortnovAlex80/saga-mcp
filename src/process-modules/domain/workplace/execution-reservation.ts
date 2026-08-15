/**
 * ExecutionReservation — the durable authority token that lets Execution
 * Control launch one worker for one Workplace.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-09 (Наряд и пропуск)
 * + Conveyor Mental Model v4 §«One queue, one concurrency knob, infrastructure
 * leases Workplaces» and §«From production order to the first worker».
 *
 * # Why this exists (the bug it replaces)
 *
 * Earlier saga let the dispatcher and the runner race on the task row: the
 * dispatcher "suggested" a task and the runner's `worker_next` actually
 * claimed it later inside its pump. That left a window where two runners
 * could both think they were about to claim the same card. v4 closes that:
 * Conveyor Runtime ATOMICALLY changes `queued -> leased` AND records an
 * ExecutionReservation in ONE transaction; Execution Control CONSUMES the
 * committed reservation idempotently to launch the worker (REG-09-AC-02:
 * "the process does not launch until the reservation is durably committed").
 *
 * The reservation is the BOUNDARY between Conveyor Runtime (which owns
 * Workplace state and the queue) and Execution Control (which owns
 * WorkerExecution and the process). Runtime writes the reservation; Execution
 * Control reads it, launches, and reports lifecycle events back. Neither
 * reaches into the other's tables.
 *
 * # Idempotency
 *
 * The reservation's identity is a deterministic `(workplaceRef, role,
 * workplaceRevision)` key — two dispatchers racing for the same queued
 * workplace produce ONE effective reservation (REG-09-AC-01). A launch retry
 * by the SAME reservation does not create a second live execution
 * (REG-09-AC-03): the consumer is idempotent on the reservation ref. A
 * revoked/expired reservation cannot clear or replace a newer fence
 * (REG-09-AC-04).
 *
 * # Pure domain
 *
 * Imports only sibling pure types (`WorkplaceRef`, `NextRole`). No SQLite,
 * MCP, db.ts, clock, or application/behavioral code. The consumed/expired
 * transitions are owned by Execution Control at the boundary; this file only
 * defines the value shape and the closed state set.
 */

import type { WorkplaceRef } from './workplace-ref.js';
import type { NextRole } from './workplace-state.js';

/**
 * The closed lifecycle of one reservation.
 *
 *   - `queued` — just created; not yet consumed by Execution Control.
 *   - `consumed` — Execution Control launched exactly one WorkerExecution
 *     from this reservation (REG-09-AC-03).
 *   - `expired` — the reservation's lease passed before launch; the queue
 *     item returns to `queued` for a fresh reservation.
 *   - `cancelled` — an authorized actor cancelled the pending launch.
 *
 * Transitions are one-way: `consumed`/`expired`/`cancelled` are terminal. A
 * consumed reservation cannot be re-consumed; an expired one is replaced by a
 * new reservation with a fresh identity, not resurrected.
 */
export type ExecutionReservationState =
  | 'queued'
  | 'consumed'
  | 'expired'
  | 'cancelled';

/**
 * A durable launch authority for one Workplace + role.
 *
 * REG-09. Created atomically with the Workplace `queued -> leased` transition.
 * The reservation pins the EXACT context the worker will run with —
 * Workplace, role, read set, fence token — so the worker process receives
 * one immutable launch context and cannot rebind any of it (REG-08-AC-01,
 * v4 §«Universal conveyor protocol surface»: "Runtime derives Workplace,
 * execution, role and fence from the launch context; the model cannot choose
 * or rebind them").
 */
export interface ExecutionReservation {
  /** Deterministic ref over (workplaceRef, role, workplaceRevision). */
  readonly reservationRef: string;
  readonly workplaceRef: WorkplaceRef;
  /** Workplace revision the reservation was issued against; CAS target. */
  readonly expectedWorkplaceRevision: number;
  /** author or reviewer. */
  readonly role: NextRole;
  /** Opaque idempotency key (caller-chosen; unique per launch attempt). */
  readonly idempotencyKey: string;
  /** Unique fence token this reservation grants to the launched execution. */
  readonly fenceToken: string;
  /** ISO timestamp the reservation expires at (lease deadline). */
  readonly expiresAt: string;
  readonly state: ExecutionReservationState;
}

/**
 * Compute the deterministic reservation reference.
 *
 * Per REG-09 the reservation is keyed by `(workplaceRef, role,
 * workplaceRevision)`: two dispatchers racing for the same queued workplace
 * at the same revision derive the same ref, so the repository UNIQUE on this
 * ref accepts only the first insert and the race has one winner
 * (REG-09-AC-01). A new revision (after a transition) derives a new ref — a
 * fresh reservation, not a resurrection of the old one.
 */
export function executionReservationRef(input: {
  workplaceRef: WorkplaceRef;
  role: NextRole;
  expectedWorkplaceRevision: number;
}): string {
  return [
    'reservation',
    input.workplaceRef.processRunId,
    input.workplaceRef.moduleRef,
    input.workplaceRef.productionCellId,
    input.workplaceRef.workKey,
    input.role,
    `r${input.expectedWorkplaceRevision}`,
  ].join('/');
}

/**
 * Validate an ExecutionReservation's shape (REG-09).
 *
 * Pure. Throws on any violation. Rules:
 *   - `reservationRef` matches the deterministic derivation from
 *     (workplace, role, revision) — a typo'd ref cannot persist.
 *   - `expectedWorkplaceRevision` is a non-negative integer.
 *   - `fenceToken` is non-empty (REG-09-AC-04: a revoked/expired fence cannot
 *     clear a newer one — the fence must be a real value).
 *   - `expiresAt` is non-empty (every reservation has a deadline).
 */
export function assertValidExecutionReservation(
  reservation: ExecutionReservation,
): void {
  requireNonEmpty(reservation.reservationRef, 'reservationRef');
  requireNonEmpty(reservation.idempotencyKey, 'idempotencyKey');
  requireNonEmpty(reservation.fenceToken, 'fenceToken');
  requireNonEmpty(reservation.expiresAt, 'expiresAt');
  if (
    !Number.isInteger(reservation.expectedWorkplaceRevision)
    || reservation.expectedWorkplaceRevision < 0
  ) {
    throw new Error(
      'ExecutionReservation.expectedWorkplaceRevision must be a non-negative '
        + `integer, got ${reservation.expectedWorkplaceRevision}`,
    );
  }
  const expected = executionReservationRef({
    workplaceRef: reservation.workplaceRef,
    role: reservation.role,
    expectedWorkplaceRevision: reservation.expectedWorkplaceRevision,
  });
  if (reservation.reservationRef !== expected) {
    throw new Error(
      `ExecutionReservation.reservationRef '${reservation.reservationRef}' `
        + `does not match the deterministic derivation '${expected}' — the ref `
        + 'MUST be computed via executionReservationRef() so race-detection '
        + '(REG-09-AC-01) is reliable',
    );
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ExecutionReservation.${label} must be a non-empty string`);
  }
}
