// src/process-modules/persistence/sqlite-transition-obligation-ledger.ts
//
// ADR-053 Phase 2 — durable transition-obligation ledger.
//
// A transition obligation is a durable, fenced, idempotent record that says:
// "this source fact (e.g. a sealed CandidateSet) requires this handoff (e.g.
// RunGate) to be performed by this owner capability." It is appended in the
// SAME transaction as the source fact so a crash cannot leave a fact without
// its transition, nor a transition without its fact.
//
// The obligation converges to exactly one completion receipt: the deterministic
// key (sourceKind + sourceRef + handoffKind) means the same source fact never
// creates two obligations, and idempotent completion means a retry after crash
// records the same receipt.
//
// Phase 2 creates the substrate only. Phase 8 wires production handoffs onto it.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Obligation identity.
//
// The five conveyor transitions that MUST become durable. Each source kind is
// a sealed fact; each handoff kind is the transition that fact requires.
// ---------------------------------------------------------------------------
export const TRANSITION_SOURCE_KINDS = [
  'candidate-set-sealed',
  'gate-accepted',
  'effects-settled',
  'final-acceptance-recorded',
  'process-settled',
] as const;
export type TransitionSourceKind = (typeof TRANSITION_SOURCE_KINDS)[number];

export const TRANSITION_HANDOFF_KINDS = [
  'run-gate',
  'run-effects',
  'record-final-acceptance',
  'settle-process',
  'route-lifecycle',
] as const;
export type TransitionHandoffKind = (typeof TRANSITION_HANDOFF_KINDS)[number];

export type TransitionObligationState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

// ---------------------------------------------------------------------------
// Obligation record — the durable row.
// ---------------------------------------------------------------------------
export interface TransitionObligation {
  readonly obligationKey: string;
  readonly sourceKind: TransitionSourceKind;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly subjectRef: string;
  readonly handoffKind: TransitionHandoffKind;
  readonly ownerCapability: string;
  readonly fence: number;
  readonly state: TransitionObligationState;
  readonly attempt: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completionReceipt: string | null;
  readonly resultDigest: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AppendObligationInput {
  readonly sourceKind: TransitionSourceKind;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly subjectRef: string;
  readonly handoffKind: TransitionHandoffKind;
  readonly ownerCapability: string;
  readonly fence: number;
}

export interface CompleteObligationInput {
  readonly obligationKey: string;
  readonly completionReceipt: string;
  readonly resultDigest: string;
}

/**
 * Deterministic obligation key. The same source fact + handoff always produces
 * the same key, so a replay of the source fact's creation cannot create a
 * second obligation — it finds the existing one.
 */
export function transitionObligationKey(input: {
  sourceKind: string;
  sourceRef: string;
  handoffKind: string;
}): string {
  return `${input.sourceKind}:${input.sourceRef}:${input.handoffKind}`;
}

// ---------------------------------------------------------------------------
// SQLite repository.
//
// All writes are idempotent on the deterministic key. The `append` is
// INSERT OR IGNORE — a second append for the same key is a no-op (the existing
// obligation wins). This is the crash-safety guarantee: a source fact re-played
// after recovery finds its existing obligation rather than creating a second.
// ---------------------------------------------------------------------------
const LEASE_DURATION_SECONDS = 120;

export class SqliteTransitionObligationLedger {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Append an obligation. Idempotent on the deterministic key: if the
   * obligation already exists (from a prior append in the same or a recovered
   * transaction), this is a no-op and the existing obligation is returned.
   * This means a source fact re-played after crash does NOT create a duplicate.
   */
  append(input: AppendObligationInput): TransitionObligation {
    const key = transitionObligationKey(input);
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_transition_obligations
         (obligation_key, source_kind, source_ref, source_digest,
          subject_ref, handoff_kind, owner_capability, fence, state)
       VALUES (@key, @sourceKind, @sourceRef, @sourceDigest,
               @subjectRef, @handoffKind, @ownerCapability, @fence, 'pending')`,
    ).run({
      key,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourceDigest: input.sourceDigest,
      subjectRef: input.subjectRef,
      handoffKind: input.handoffKind,
      ownerCapability: input.ownerCapability,
      fence: input.fence,
    });
    return this.getOrThrow(key);
  }

  get(obligationKey: string): TransitionObligation | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_transition_obligations WHERE obligation_key = ?`,
    ).get(obligationKey) as TransitionObligationRow | undefined;
    return row ? rowToObligation(row) : null;
  }

  private getOrThrow(key: string): TransitionObligation {
    const ob = this.get(key);
    if (!ob) throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${key}`);
    return ob;
  }

  /**
   * Find obligations that are ready to execute: either pending, or
   * in_progress with an expired lease (the previous lease holder crashed).
   */
  findReady(limit = 32): readonly TransitionObligation[] {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db.prepare(
      `SELECT * FROM factory_transition_obligations
       WHERE state = 'pending'
          OR (state = 'in_progress' AND lease_expires_at IS NOT NULL
              AND unixepoch(lease_expires_at) < ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(now, limit) as TransitionObligationRow[];
    return rows.map(rowToObligation);
  }

  /**
   * Atomically lease an obligation for execution. Returns true if the lease
   * was acquired, false if another owner holds a live lease. Uses CAS on
   * (state, lease_expires_at) to avoid two owners leasing concurrently.
   */
  lease(
    obligationKey: string,
    leaseOwner: string,
    fence: number,
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + LEASE_DURATION_SECONDS) * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
       SET state = 'in_progress',
           attempt = attempt + 1,
           lease_owner = @leaseOwner,
           lease_expires_at = @expiresAt,
           fence = @fence,
           updated_at = datetime('now')
       WHERE obligation_key = @key
         AND (state = 'pending'
              OR (state = 'in_progress' AND lease_expires_at IS NOT NULL
                  AND unixepoch(lease_expires_at) < @now))`,
    ).run({
      key: obligationKey,
      leaseOwner,
      expiresAt,
      fence,
      now,
    });
    return result.changes > 0;
  }

  /**
   * Record a successful completion. Idempotent: if already completed with the
   * same receipt, this is a no-op. A different receipt for the same key is
   * rejected — the obligation converged already.
   */
  complete(input: CompleteObligationInput): TransitionObligation {
    const existing = this.get(input.obligationKey);
    if (!existing) {
      throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${input.obligationKey}`);
    }
    if (existing.state === 'completed') {
      if (existing.completionReceipt !== input.completionReceipt) {
        throw new Error(
          `TRANSITION_OBLIGATION_ALREADY_COMPLETED: ${input.obligationKey} `
          + `with receipt ${existing.completionReceipt}; cannot replace with `
          + `${input.completionReceipt}`,
        );
      }
      return existing;
    }
    this.db.prepare(
      `UPDATE factory_transition_obligations
       SET state = 'completed',
           completion_receipt = @receipt,
           result_digest = @resultDigest,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = NULL,
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE obligation_key = @key`,
    ).run({
      key: input.obligationKey,
      receipt: input.completionReceipt,
      resultDigest: input.resultDigest,
    });
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Record a failure. The obligation returns to pending state so the
   * reconciler can retry it. The error is stored for diagnostics.
   */
  fail(obligationKey: string, error: string): TransitionObligation {
    this.db.prepare(
      `UPDATE factory_transition_obligations
       SET state = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = @error,
           updated_at = datetime('now')
       WHERE obligation_key = @key`,
    ).run({ key: obligationKey, error });
    return this.getOrThrow(obligationKey);
  }
}

// ---------------------------------------------------------------------------
// Row mapping.
// ---------------------------------------------------------------------------
interface TransitionObligationRow {
  obligation_key: string;
  source_kind: string;
  source_ref: string;
  source_digest: string;
  subject_ref: string;
  handoff_kind: string;
  owner_capability: string;
  fence: number;
  state: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  completion_receipt: string | null;
  result_digest: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToObligation(row: TransitionObligationRow): TransitionObligation {
  return {
    obligationKey: row.obligation_key,
    sourceKind: row.source_kind as TransitionSourceKind,
    sourceRef: row.source_ref,
    sourceDigest: row.source_digest,
    subjectRef: row.subject_ref,
    handoffKind: row.handoff_kind as TransitionHandoffKind,
    ownerCapability: row.owner_capability,
    fence: row.fence,
    state: row.state as TransitionObligationState,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    completionReceipt: row.completion_receipt,
    resultDigest: row.result_digest,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * Compute a deterministic completion-receipt digest from the source fact and
 * the completion result. Two identical completions produce the same digest,
 * so crash-recovery converges to one receipt.
 */
export function obligationResultDigest(input: {
  sourceKind: string;
  sourceRef: string;
  handoffKind: string;
  result: Readonly<Record<string, unknown>>;
}): string {
  return sha256Hex(input);
}
