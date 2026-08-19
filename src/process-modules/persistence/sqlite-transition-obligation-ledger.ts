// src/process-modules/persistence/sqlite-transition-obligation-ledger.ts
//
// Durable, fenced, idempotent transition-obligation ledger.
// A source fact and its obligation are committed together; the obligation is
// then leased and driven by an idempotent handoff handler.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';
import { journalEvent } from '../../observability/run-journal.js';
import type {
  CausalSourceRevision,
  LeaseFence,
} from '../domain/transition-obligation.js';
import {
  assertCausalSourceRevision,
  assertLeaseFence,
  leaseFence,
} from '../domain/transition-obligation.js';

export const TRANSITION_SOURCE_KINDS = [
  'final-presentation-committed',
  'candidate-set-sealed',
  'gate-accepted',
  'effects-settled',
  'process-settled',
] as const;
export type TransitionSourceKind = (typeof TRANSITION_SOURCE_KINDS)[number];

export const TRANSITION_HANDOFF_KINDS = [
  'close-presentation',
  'run-gate',
  'run-effects',
  'record-final-acceptance',
  'route-lifecycle',
] as const;
export type TransitionHandoffKind = (typeof TRANSITION_HANDOFF_KINDS)[number];

export type TransitionObligationState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface TransitionObligation {
  readonly obligationKey: string;
  readonly sourceKind: TransitionSourceKind;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly subjectRef: string;
  readonly handoffKind: TransitionHandoffKind;
  readonly ownerCapability: string;
  readonly fence: number;
  readonly leaseFence: number | null;
  readonly state: TransitionObligationState;
  readonly attempt: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completionReceipt: string | null;
  readonly resultDigest: string | null;
  readonly lastError: string | null;
  /** B-004/O-D6 — typed identity of the last defer/fail reason (§15 valve). */
  readonly lastReasonKey: string | null;
  /** B-004/O-D6 — CONSECUTIVE repetitions of {@link lastReasonKey}. */
  readonly reasonRepeatCount: number;
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
  readonly causalSourceRevision: CausalSourceRevision;
}

export type AppendFencedObligationInput = Omit<AppendObligationInput, 'causalSourceRevision'>;

export interface CompleteObligationInput {
  readonly obligationKey: string;
  readonly completionReceipt: string;
  readonly resultDigest: string;
  readonly owner: string;
  readonly fence: LeaseFence;
}

export interface DeferObligationInput {
  readonly obligationKey: string;
  readonly reason: string;
  readonly owner: string;
  readonly fence: LeaseFence;
}

export interface FailObligationInput {
  readonly obligationKey: string;
  readonly error: string;
  readonly owner: string;
  readonly fence: LeaseFence;
}

export interface ReclaimObligationInput {
  readonly obligationKey: string;
  readonly owner: string;
  readonly fence: LeaseFence;
}

export function transitionObligationKey(input: {
  sourceKind: string;
  sourceRef: string;
  handoffKind: string;
}): string {
  return `${input.sourceKind}:${input.sourceRef}:${input.handoffKind}`;
}

const LEASE_DURATION_SECONDS = 120;
export const LEASE_LOSS_RECLAIM_MARKER = 'LEASE_LOSS_RECLAIM';

/**
 * B-004/O-D6 (CONVEYOR §15) — the typed terminal marker prefix written by the
 * reconciler's reason-identity valve when it abandons a spinning obligation.
 * `abandon` journals kind 'obligation.valve' exactly for reasons carrying this
 * prefix; every other abandon reason (e.g. the engine-start burial's
 * LIFECYCLE_TERMINAL provenance) keeps its existing silent behavior.
 */
export const OBLIGATION_VALVE_MARKER = 'OBLIGATION_VALVE';

/**
 * The TYPED reason identity of a defer/fail outcome (CONVEYOR §15 step 1).
 *
 * - 'failed': the typed error CODE prefix before the first colon — the
 *   fail-closed vocabulary style. Prose after the colon (counts, digests,
 *   volatile detail) is excluded: a rephrased message with the same CODE is
 *   the SAME reason.
 * - 'deferred': the postcondition reason string — the durable statement of
 *   WHICH postcondition arm is still missing.
 *
 * The first line, capped, is the identity. Timestamps/run digests/execution
 * ids never appear in these sources by construction.
 */
export function obligationReasonKey(
  kind: 'deferred' | 'failed',
  message: string,
): string {
  const firstLine = String(message ?? '').trim().split('\n', 1)[0] ?? '';
  const identity = kind === 'failed' ? (firstLine.split(':', 1)[0] || firstLine) : firstLine;
  return identity.slice(0, 200);
}

/**
 * PRAGMA-guarded ADD COLUMN for existing factory DBs (the K13 lazy-ALTER
 * pattern: converge with the base DDL in schema.ts, never reset rows).
 */
function ensureReasonValveColumns(db: SqliteDatabase): void {
  const names = new Set(
    (db.prepare('PRAGMA table_info(factory_transition_obligations)').all() as
      { name: string }[]).map((column) => column.name),
  );
  if (!names.has('last_reason_key')) {
    db.exec('ALTER TABLE factory_transition_obligations ADD COLUMN last_reason_key TEXT');
  }
  if (!names.has('reason_repeat_count')) {
    db.exec(
      'ALTER TABLE factory_transition_obligations ADD COLUMN reason_repeat_count INTEGER NOT NULL DEFAULT 0',
    );
  }
}

export class SqliteTransitionObligationLedger {
  constructor(private readonly db: SqliteDatabase) {
    ensureReasonValveColumns(db);
  }

  append(input: AppendObligationInput): TransitionObligation {
    assertCausalSourceRevision(input.causalSourceRevision);
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
      fence: input.causalSourceRevision.value,
    });
    const obligation = this.getOrThrow(key);
    assertObligationReplayMatches(obligation, input);
    journalEvent('obligation.created', {
      workplace_ref: input.subjectRef,
    }, {
      obligation_key: key,
      handoff_kind: input.handoffKind,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
      owner_capability: input.ownerCapability,
    });
    return obligation;
  }

  /** Production append path: creation and first store-minted fence are atomic. */
  appendFenced(input: AppendFencedObligationInput): TransitionObligation {
    const key = transitionObligationKey(input);
    this.transaction(() => {
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO factory_transition_obligations
           (obligation_key, source_kind, source_ref, source_digest,
            subject_ref, handoff_kind, owner_capability, fence, state)
         VALUES (@key, @sourceKind, @sourceRef, @sourceDigest,
                 @subjectRef, @handoffKind, @ownerCapability, 0, 'pending')`,
      ).run({
        key,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
        subjectRef: input.subjectRef,
        handoffKind: input.handoffKind,
        ownerCapability: input.ownerCapability,
      });
      if (inserted.changes > 0) {
        const row = this.db.prepare(
          `SELECT COALESCE(lease_fence, 0) AS current
             FROM factory_transition_obligations
            WHERE obligation_key=?`,
        ).get(key) as { current: number } | undefined;
        if (!row) throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${key}`);
        const candidate = row.current + 1;
        this.db.prepare(
          `UPDATE factory_transition_obligations
              SET fence=@candidate,
                  lease_fence=@candidate,
                  updated_at=datetime('now')
            WHERE obligation_key=@key`,
        ).run({ key, candidate });
      }
    });
    const obligation = this.getOrThrow(key);
    assertObligationReplayMatches(obligation, input);
    journalEvent('obligation.created', {
      workplace_ref: input.subjectRef,
    }, {
      obligation_key: key,
      handoff_kind: input.handoffKind,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
      owner_capability: input.ownerCapability,
      path: 'appendFenced',
    });
    return obligation;
  }

  readLeaseFence(obligationKey: string): number | null {
    const row = this.db.prepare(
      `SELECT lease_fence AS leaseFence
         FROM factory_transition_obligations
        WHERE obligation_key=?`,
    ).get(obligationKey) as { leaseFence: number | null } | undefined;
    return row?.leaseFence ?? null;
  }

  get(obligationKey: string): TransitionObligation | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_transition_obligations WHERE obligation_key=?`,
    ).get(obligationKey) as TransitionObligationRow | undefined;
    return row ? rowToObligation(row) : null;
  }

  private getOrThrow(key: string): TransitionObligation {
    const obligation = this.get(key);
    if (!obligation) throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${key}`);
    return obligation;
  }

  findReady(limit = 32): readonly TransitionObligation[] {
    const now = Math.floor(Date.now() / 1000);
    // Round-robin fairness: lease/defer/complete bump updated_at, so an
    // obligation that was just swept (e.g. deferred because its lifecycle is
    // not yet at the postcondition) rotates to the BACK of the batch. Ordering
    // by created_at alone starves every obligation created after the first
    // `limit` entries when permanently-deferring ones keep re-queuing at the
    // front with an old created_at.
    const rows = this.db.prepare(
      `SELECT * FROM factory_transition_obligations
        WHERE state='pending'
           OR (state='in_progress' AND lease_expires_at IS NOT NULL
               AND unixepoch(lease_expires_at) < ?)
        ORDER BY unixepoch(updated_at) ASC, created_at ASC, obligation_key ASC
        LIMIT ?`,
    ).all(now, limit) as TransitionObligationRow[];
    return rows.map(rowToObligation);
  }

  lease(
    obligationKey: string,
    leaseOwner: string,
    fence: LeaseFence,
  ): boolean {
    assertLeaseFence(fence);
    if (typeof leaseOwner !== 'string' || leaseOwner.trim() === '') {
      throw new Error(`TRANSITION_OBLIGATION_LEASE_REQUIRES_OWNER: ${obligationKey}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + LEASE_DURATION_SECONDS) * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='in_progress',
              attempt=attempt+1,
              lease_owner=@leaseOwner,
              lease_expires_at=@expiresAt,
              lease_fence=@fence,
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND @fence >= COALESCE(lease_fence, 0)
          AND (state='pending'
               OR (state='in_progress' AND lease_expires_at IS NOT NULL
                   AND unixepoch(lease_expires_at) < @now))`,
    ).run({
      key: obligationKey,
      leaseOwner,
      expiresAt,
      fence: fence.value,
      now,
    });
    if (result.changes === 1) {
      const subject = this.db.prepare(
        'SELECT subject_ref FROM factory_transition_obligations WHERE obligation_key=?',
      ).get(obligationKey) as { subject_ref: string } | undefined;
      journalEvent('obligation.claimed', {
        workplace_ref: subject?.subject_ref,
      }, {
        obligation_key: obligationKey,
        lease_owner: leaseOwner,
        lease_fence: fence.value,
      });
    }
    return result.changes === 1;
  }

  persistLeaseFence(obligationKey: string, fence: LeaseFence): number | null {
    assertLeaseFence(fence);
    this.db.prepare(
      `UPDATE factory_transition_obligations
          SET lease_fence=MAX(COALESCE(lease_fence,0),@fence),
              updated_at=datetime('now')
        WHERE obligation_key=@key`,
    ).run({ key: obligationKey, fence: fence.value });
    return this.readLeaseFence(obligationKey);
  }

  allocateLeaseFence(obligationKey: string): LeaseFence {
    const allocated = this.transaction(() => {
      const row = this.db.prepare(
        `SELECT COALESCE(lease_fence,0) AS current
           FROM factory_transition_obligations
          WHERE obligation_key=?`,
      ).get(obligationKey) as { current: number } | undefined;
      if (!row) throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${obligationKey}`);
      const candidate = row.current + 1;
      this.db.prepare(
        `UPDATE factory_transition_obligations
            SET lease_fence=@candidate, updated_at=datetime('now')
          WHERE obligation_key=@key
            AND COALESCE(lease_fence,0) < @candidate`,
      ).run({ key: obligationKey, candidate });
      const after = this.readLeaseFence(obligationKey);
      if (after === null) {
        throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${obligationKey}`);
      }
      return after;
    });
    return leaseFence(allocated);
  }

  complete(input: CompleteObligationInput): TransitionObligation {
    assertLeaseFence(input.fence);
    requireOwner(input.owner, 'COMPLETION', input.obligationKey);
    const existing = this.getOrThrow(input.obligationKey);
    if (existing.state === 'completed') {
      if (existing.completionReceipt !== input.completionReceipt) {
        throw new Error(
          `TRANSITION_OBLIGATION_ALREADY_COMPLETED: ${input.obligationKey} `
          + `with receipt ${existing.completionReceipt}; cannot replace with ${input.completionReceipt}`,
        );
      }
      return existing;
    }
    this.assertCurrentLease(existing, input.owner, input.fence, 'completion');
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='completed',
              completion_receipt=@receipt,
              result_digest=@resultDigest,
              lease_owner=NULL,
              lease_expires_at=NULL,
              last_error=NULL,
              completed_at=datetime('now'),
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND state='in_progress'
          AND lease_owner=@owner
          AND lease_fence=@fence`,
    ).run({
      key: input.obligationKey,
      owner: input.owner,
      fence: input.fence.value,
      receipt: input.completionReceipt,
      resultDigest: input.resultDigest,
    });
    if (result.changes !== 1) {
      throw new Error(
        `TRANSITION_OBLIGATION_COMPLETION_REQUIRES_CURRENT_LEASE: ${input.obligationKey}`,
      );
    }
    journalEvent('obligation.settled', {
      workplace_ref: existing.subjectRef,
    }, {
      obligation_key: input.obligationKey,
      completion_receipt: input.completionReceipt,
      result_digest: input.resultDigest,
      lease_owner: input.owner,
    });
    return this.getOrThrow(input.obligationKey);
  }

  defer(input: DeferObligationInput): TransitionObligation {
    assertLeaseFence(input.fence);
    requireOwner(input.owner, 'DEFER', input.obligationKey);
    const existing = this.getOrThrow(input.obligationKey);
    this.assertCurrentLease(existing, input.owner, input.fence, 'defer');
    // B-004/O-D6 — persist the typed reason identity and the CONSECUTIVE
    // repetition count (a new key resets to 1; CONVEYOR §15: converging
    // chains are work, not spin — do not tax them).
    const reasonKey = obligationReasonKey('deferred', input.reason);
    const repeatCount = existing.lastReasonKey === reasonKey
      ? existing.reasonRepeatCount + 1
      : 1;
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='pending',lease_owner=NULL,lease_expires_at=NULL,
              last_error=@reason,
              last_reason_key=@reasonKey,
              reason_repeat_count=@repeatCount,
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND state='in_progress'
          AND lease_owner=@owner
          AND lease_fence=@fence`,
    ).run({
      key: input.obligationKey,
      owner: input.owner,
      fence: input.fence.value,
      reason: `DEFERRED: ${input.reason}`,
      reasonKey,
      repeatCount,
    });
    if (result.changes !== 1) {
      throw new Error(`TRANSITION_OBLIGATION_DEFER_REQUIRES_CURRENT_LEASE: ${input.obligationKey}`);
    }
    // STAGE-11 TASK 5 — defer is the lease transition the stage-10 death
    // actually took (the claimed obligation silently returned to pending with
    // a DEFERRED last_error), and the only one without a journal line.
    journalEvent('obligation.deferred', {}, {
      obligation_key: input.obligationKey,
      reason: input.reason,
      lease_owner: input.owner,
      returned_to: 'pending',
    });
    return this.getOrThrow(input.obligationKey);
  }

  fail(input: FailObligationInput): TransitionObligation {
    assertLeaseFence(input.fence);
    requireOwner(input.owner, 'FAILURE', input.obligationKey);
    const existing = this.getOrThrow(input.obligationKey);
    if (existing.state === 'completed' || existing.state === 'failed') {
      throw new Error(
        `TRANSITION_OBLIGATION_TERMINAL: ${input.obligationKey} is ${existing.state}; `
        + 'a terminal obligation cannot be failed',
      );
    }
    this.assertCurrentLease(existing, input.owner, input.fence, 'failure');
    // B-004/O-D6 — same §15 valve state as defer: the typed error CODE prefix
    // is the identity; varying prose after the colon is the SAME reason.
    const reasonKey = obligationReasonKey('failed', input.error);
    const repeatCount = existing.lastReasonKey === reasonKey
      ? existing.reasonRepeatCount + 1
      : 1;
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='pending',
              lease_owner=NULL,
              lease_expires_at=NULL,
              last_error=@error,
              last_reason_key=@reasonKey,
              reason_repeat_count=@repeatCount,
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND state='in_progress'
          AND lease_owner=@owner
          AND lease_fence=@fence`,
    ).run({
      key: input.obligationKey,
      owner: input.owner,
      fence: input.fence.value,
      error: input.error,
      reasonKey,
      repeatCount,
    });
    if (result.changes !== 1) {
      throw new Error(`TRANSITION_OBLIGATION_FAILURE_REQUIRES_CURRENT_LEASE: ${input.obligationKey}`);
    }
    journalEvent('obligation.failed', {
      workplace_ref: existing.subjectRef,
    }, {
      obligation_key: input.obligationKey,
      last_error: input.error,
      lease_owner: input.owner,
      returned_to: 'pending',
    });
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Reclaim differs from complete/fail/defer: the caller may be the NEW
   * reconciler that just allocated the next fence, so it need not equal the
   * previous lease_owner. It must present the exact current fence and CAS an
   * in-progress row.
   */
  reclaim(input: ReclaimObligationInput): TransitionObligation {
    assertLeaseFence(input.fence);
    requireOwner(input.owner, 'RECLAIM', input.obligationKey);
    const existing = this.getOrThrow(input.obligationKey);
    if (existing.state === 'completed' || existing.state === 'failed') {
      throw new Error(
        `TRANSITION_OBLIGATION_TERMINAL: ${input.obligationKey} is ${existing.state}; `
        + 'a terminal obligation cannot be reclaimed',
      );
    }
    this.assertFenceMatches(existing, input.fence, 'reclaim');
    if (existing.state !== 'in_progress') {
      throw new Error(`TRANSITION_OBLIGATION_RECLAIM_REQUIRES_IN_PROGRESS: ${input.obligationKey}`);
    }
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='pending',
              lease_owner=NULL,
              lease_expires_at=NULL,
              last_error=@marker,
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND state='in_progress'
          AND lease_fence=@fence`,
    ).run({
      key: input.obligationKey,
      fence: input.fence.value,
      marker: LEASE_LOSS_RECLAIM_MARKER,
    });
    if (result.changes !== 1) {
      throw new Error(`TRANSITION_OBLIGATION_RECLAIM_REQUIRES_CURRENT_FENCE: ${input.obligationKey}`);
    }
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Abandon differs from complete/fail/defer/reclaim: it deliberately does
   * NOT require a lease. Every other transition is driven by the obligation's
   * owner holding the current fence; abandon is the kernel recovery path for
   * the case where that owner (the lifecycle run that sourced the obligation)
   * is itself terminally dead — no legitimate lease holder can ever exist
   * again, so demanding one would re-create the immortal re-lease loop this
   * method exists to end. The CAS is fail-closed: only an OPEN row
   * (pending/in_progress) can be abandoned, lease_fence stays monotonic
   * (bumped past any in-flight lease so a stale driver's fence is provably
   * stale), and the row lands in the same 'failed' terminal state as an
   * owned failure. Returns null when the row is already terminal or missing,
   * making recovery passes idempotent instead of loud.
   */
  abandon(obligationKey: string, reason: string): TransitionObligation | null {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`TRANSITION_OBLIGATION_ABANDON_REQUIRES_REASON: ${obligationKey}`);
    }
    // B-004/O-D6 — the reason-identity valve routes here with the typed
    // OBLIGATION_VALVE marker prefix; capture the pre-abandon valve state for
    // the journal correlation (burial-path abandons keep their silent shape).
    const valveTrip = reason.startsWith(OBLIGATION_VALVE_MARKER);
    const prior = valveTrip ? this.get(obligationKey) : null;
    const result = this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='failed',
              lease_owner=NULL,
              lease_expires_at=NULL,
              last_error=@reason,
              lease_fence=COALESCE(lease_fence,0)+1,
              updated_at=datetime('now')
        WHERE obligation_key=@key
          AND state IN ('pending','in_progress')`,
    ).run({ key: obligationKey, reason });
    if (result.changes !== 1) return null;
    if (valveTrip) {
      // Observation-only (the ratchet: written, never read back by the
      // factory). Correlation keys follow the obligation.deferred shape.
      journalEvent('obligation.valve', {
        workplace_ref: prior?.subjectRef,
      }, {
        obligation_key: obligationKey,
        reason,
        reason_key: prior?.lastReasonKey ?? null,
        repeated: prior?.reasonRepeatCount ?? 0,
        attempt: prior?.attempt ?? 0,
        terminal: 'failed',
      });
    }
    return this.getOrThrow(obligationKey);
  }

  private assertCurrentLease(
    existing: TransitionObligation,
    owner: string,
    fence: LeaseFence,
    action: string,
  ): void {
    // Report stale fencing first: after takeover the old owner is stale for two
    // independent reasons, and the monotonic fence is the more precise causal
    // diagnostic expected by the fencing contract tests.
    this.assertFenceMatches(existing, fence, action);
    if (existing.state !== 'in_progress' || existing.leaseOwner !== owner) {
      throw new Error(
        `TRANSITION_OBLIGATION_${action.toUpperCase()}_REQUIRES_CURRENT_LEASE: ${existing.obligationKey}`,
      );
    }
  }

  private assertFenceMatches(
    existing: TransitionObligation,
    fence: LeaseFence,
    action: string,
  ): void {
    const stored = existing.leaseFence ?? 0;
    if (fence.value < stored) {
      throw new Error(
        `TRANSITION_OBLIGATION_STALE_FENCE: ${existing.obligationKey} ${action} fence `
        + `${fence.value} is lower than the stored monotonic lease_fence ${stored}`,
      );
    }
    if (fence.value !== stored) {
      throw new Error(
        `TRANSITION_OBLIGATION_FENCE_MISMATCH: ${existing.obligationKey} ${action} fence `
        + `${fence.value} does not equal the current lease_fence ${stored}`,
      );
    }
  }

  private transaction<T>(work: () => T): T {
    const ownsTransaction = !this.db.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      }
      throw error;
    }
  }
}

function requireOwner(owner: string, action: string, key: string): void {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new Error(
      `TRANSITION_OBLIGATION_${action}_REQUIRES_OWNER: ${key} `
      + `(${action.toLowerCase()} must carry an attributed lease owner)`,
    );
  }
}

interface TransitionObligationRow {
  obligation_key: string;
  source_kind: string;
  source_ref: string;
  source_digest: string;
  subject_ref: string;
  handoff_kind: string;
  owner_capability: string;
  fence: number;
  lease_fence: number | null;
  state: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  completion_receipt: string | null;
  result_digest: string | null;
  last_error: string | null;
  last_reason_key: string | null;
  reason_repeat_count: number;
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
    leaseFence: row.lease_fence,
    state: row.state as TransitionObligationState,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    completionReceipt: row.completion_receipt,
    resultDigest: row.result_digest,
    lastError: row.last_error,
    lastReasonKey: row.last_reason_key ?? null,
    reasonRepeatCount: row.reason_repeat_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function assertObligationReplayMatches(
  existing: TransitionObligation,
  input: AppendFencedObligationInput | AppendObligationInput,
): void {
  const mismatches: string[] = [];
  for (const [field, actual, expected] of [
    ['sourceKind', existing.sourceKind, input.sourceKind],
    ['sourceRef', existing.sourceRef, input.sourceRef],
    ['sourceDigest', existing.sourceDigest, input.sourceDigest],
    ['subjectRef', existing.subjectRef, input.subjectRef],
    ['handoffKind', existing.handoffKind, input.handoffKind],
    ['ownerCapability', existing.ownerCapability, input.ownerCapability],
  ] as const) {
    if (actual !== expected) mismatches.push(`${field}:${actual}!=${expected}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `TRANSITION_OBLIGATION_REPLAY_MISMATCH: ${existing.obligationKey}: ${mismatches.join(', ')}`,
    );
  }
}

export function obligationResultDigest(input: {
  sourceKind: string;
  sourceRef: string;
  handoffKind: string;
  result: Readonly<Record<string, unknown>>;
}): string {
  return sha256Hex(input);
}
