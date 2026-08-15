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
import type {
  CausalSourceRevision,
  LeaseFence,
} from '../domain/transition-obligation.js';
import {
  assertCausalSourceRevision,
  assertLeaseFence,
  leaseFence,
} from '../domain/transition-obligation.js';

// ---------------------------------------------------------------------------
// Obligation identity.
//
// The six conveyor transitions that MUST become durable. Each source kind is
// a sealed fact; each handoff kind is the transition that fact requires.
// ---------------------------------------------------------------------------
export const TRANSITION_SOURCE_KINDS = [
  'final-presentation-committed',
  'candidate-set-sealed',
  'gate-accepted',
  'effects-settled',
  'final-acceptance-recorded',
  'process-settled',
] as const;
export type TransitionSourceKind = (typeof TRANSITION_SOURCE_KINDS)[number];

export const TRANSITION_HANDOFF_KINDS = [
  'close-presentation',
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
//
// ADR-053 C7-02 split the storage that C7-01 had typed apart at the seams:
//   * `fence`       — the CAUSAL SOURCE REVISION (provenance). RAW stored value
//                     of the `fence` column. SET once at `append`; NEVER
//                     overwritten by a lease after C7-02.
//   * `leaseFence`  — the MONOTONIC LEASE FENCE (ordering token). RAW stored
//                     value of the DISTINCT `lease_fence` column. NULL until the
//                     obligation is first leased; written only by `lease` and
//                     never allowed to decrease on overwrite.
// Both are exposed as raw numbers (the brand lives at the INPUT boundaries —
// `append` accepts a CausalSourceRevision, `lease` accepts a LeaseFence).
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
  readonly leaseFence: number | null;
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
  /**
   * The source-fact revision that CAUSED this obligation (provenance). NOT a
   * lease fence. Distinct type from LeaseFence so the two cannot be swapped.
   */
  readonly causalSourceRevision: CausalSourceRevision;
}

/**
 * ADR-053 C7-06 — the production obligation-creation input. Identical to
 * {@link AppendObligationInput} MINUS the `causalSourceRevision`: the causal
 * revision is NOT supplied by the caller — it is ALLOCATED by the store inside
 * {@link appendFenced}. This removes the fabricated `fence: 1` token from every
 * canonical production handoff (CandidateSet seal, Gate acceptance, Effects
 * settlement, FinalAcceptance, Process settlement): the causal source revision
 * now carries a REAL monotonic fence value allocated atomically with the
 * obligation's creation, and the obligation's `lease_fence` is pre-reserved to
 * the same value so the reconciler's first lease runs under a real fence.
 */
export type AppendFencedObligationInput = Omit<AppendObligationInput, 'causalSourceRevision'>;

export interface CompleteObligationInput {
  readonly obligationKey: string;
  readonly completionReceipt: string;
  readonly resultDigest: string;
  /**
   * ADR-053 C7-04 — the owner completing this obligation (the lease holder that
   * acquired the lease for this sweep). REQUIRED: a completion without an owner
   * fails closed (anonymous/unattributed completion is rejected).
   */
  readonly owner: string;
  /**
   * ADR-053 C7-04 — the monotonic LEASE-FENCE token authorizing this completion.
   * REQUIRED: a completion without a fence fails closed. A fence LOWER than the
   * obligation's stored monotonic `lease_fence` is rejected — a stale lease
   * holder (older fence) cannot complete work that a newer fence now owns. The
   * stored fence is never lowered by a completion attempt: {@link complete}
   * performs the staleness read but its UPDATE never writes `lease_fence`.
   */
  readonly fence: LeaseFence;
}

export interface DeferObligationInput {
  readonly obligationKey: string;
  readonly reason: string;
  readonly owner: string;
  readonly fence: LeaseFence;
}

/**
 * ADR-053 C7-05 — fence obligation FAILURE (business-handler failure). The
 * handler threw: the effect ITSELF failed (a genuine business error). This is a
 * DISTINCT concept from LEASE LOSS (the holder lost the fence), which is
 * recorded by {@link reclaim}. Both `owner` and `fence` are REQUIRED, symmetric
 * with {@link CompleteObligationInput}: a failure that lacks either fails
 * closed. The `fence` must be >= the stored monotonic `lease_fence`; a LOWER
 * fence is rejected so a stale lease holder cannot fail work a newer fence owns.
 * The stored fence is NEVER lowered by a failure attempt; a terminal state is
 * NEVER altered.
 */
export interface FailObligationInput {
  readonly obligationKey: string;
  /**
   * The business-failure error message (the reason the handler threw). Stored
   * on `last_error` DISTINCTLY from the {@link LEASE_LOSS_RECLAIM_MARKER} that
   * {@link reclaim} writes — a reader can tell a business failure apart from a
   * lease-loss reclaim by comparing `last_error` to the marker.
   */
  readonly error: string;
  /** REQUIRED: the lease owner that attempted (and failed) the handoff. */
  readonly owner: string;
  /** REQUIRED: the monotonic LEASE-FENCE token authorizing this failure. */
  readonly fence: LeaseFence;
}

/**
 * ADR-053 C7-05 — fence obligation RECLAIM (lease-loss / expiry). The previous
 * lease holder LOST the fence (its lease expired, or a newer fence took the
 * obligation over). This is LEASE LOSS, NOT a business failure: the effect did
 * not throw, the holder simply no longer holds authority. Recorded DISTINCTLY
 * from {@link fail} — {@link reclaim} writes the {@link LEASE_LOSS_RECLAIM_MARKER}
 * sentinel to `last_error` rather than a business error, so the two transitions
 * stay distinguishable in the durable record.
 *
 * Both `owner` and `fence` are REQUIRED, symmetric with completion/failure. A
 * stale fence (LOWER than the stored `lease_fence`) is rejected: a stale holder
 * cannot reclaim an obligation a newer fence owns. The stored fence is NEVER
 * lowered; a terminal state is NEVER altered. Reclaim returns the obligation to
 * `pending` so a fresh lease can pick it up.
 */
export interface ReclaimObligationInput {
  readonly obligationKey: string;
  /** REQUIRED: the lease owner performing the reclaim. */
  readonly owner: string;
  /** REQUIRED: the monotonic LEASE-FENCE token authorizing this reclaim. */
  readonly fence: LeaseFence;
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

/**
 * ADR-053 C7-05 — sentinel written to `last_error` by {@link reclaim} (lease-
 * loss) to keep it DISTINCT from a business-handler failure recorded by
 * {@link fail}. A reader compares `last_error` against this marker: equality
 * means the obligation was reclaimed due to lease loss (the holder lost the
 * fence), NOT because the effect failed. {@link fail} always writes the actual
 * business error message, which never equals this sentinel.
 */
export const LEASE_LOSS_RECLAIM_MARKER = 'LEASE_LOSS_RECLAIM';

export class SqliteTransitionObligationLedger {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Append an obligation. Idempotent on the deterministic key: if the
   * obligation already exists (from a prior append in the same or a recovered
   * transaction), this is a no-op and the existing obligation is returned.
   * This means a source fact re-played after crash does NOT create a duplicate.
   *
   * The causal source revision (provenance) is recorded on the `fence` column.
   * ADR-053 C7-01: `causalSourceRevision` is a DISTINCT type from the lease
   * fence — a LeaseFence passed here is rejected (brand mismatch). ADR-053
   * C7-02: `fence` is no longer overwritten by `lease`; the lease fence now
   * lives in its own `lease_fence` column (see {@link lease}). `lease_fence`
   * starts NULL here — no lease has been taken at append time.
   */
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
    return obligation;
  }

  /**
   * ADR-053 C7-06 — append an obligation AND allocate its FIRST real monotonic
   * lease fence in ONE atomic IMMEDIATE transaction. This is the production
   * obligation-creation path: it replaces the fabricated `fence: 1` causal-
   * revision stub that every production handoff previously passed. The causal
   * source revision (the `fence` column) is set to the ALLOCATED fence value —
   * the creation-generation fence IS the provenance revision of this obligation
   * (which fence-generation caused it). The obligation's `lease_fence` is
   * pre-reserved to the same value, so the reconciler's first lease runs under a
   * real fence rather than allocating one from NULL.
   *
   * The fence is ALLOCATED BY THE STORE (same as {@link allocateLeaseFence}),
   * never supplied by the caller: a caller can neither choose nor lower it. The
   * causal revision is therefore a REAL monotonic value — not a fabricated
   * constant.
   *
   * For a REPLAY (the obligation already exists from a prior append, e.g. a
   * crash-recovery re-seal of the same CandidateSet), this is a NO-OP: `INSERT
   * OR IGNORE` inserts nothing and the existing causal revision + lease fence
   * are PRESERVED. Provenance is immutable — a replay does NOT allocate a new
   * fence or change the causal revision.
   *
   * @returns the obligation (newly-created with its allocated fence, or the
   *          existing one for a replay).
   */
  appendFenced(input: AppendFencedObligationInput): TransitionObligation {
    const key = transitionObligationKey(input);
    this.transaction(() => {
      const insertResult = this.db.prepare(
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
      if (insertResult.changes > 0) {
        // New obligation: allocate the first real monotonic fence (current + 1)
        // and set BOTH the causal revision (`fence`) and the pre-reserved lease
        // fence (`lease_fence`) to the allocated value. The causal revision
        // records WHICH generation created this obligation; the pre-reserved
        // lease fence means the reconciler's first lease runs under a real fence.
        const row = this.db.prepare(
          `SELECT COALESCE(lease_fence, 0) AS current
             FROM factory_transition_obligations
            WHERE obligation_key = ?`,
        ).get(key) as { current: number } | undefined;
        if (!row) {
          throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${key}`);
        }
        const candidate = row.current + 1;
        this.db.prepare(
          `UPDATE factory_transition_obligations
              SET fence = @candidate,
                  lease_fence = MAX(COALESCE(lease_fence, 0), @candidate),
                  updated_at = datetime('now')
            WHERE obligation_key = @key`,
        ).run({ key, candidate });
      }
      // Replay (changes === 0): the existing obligation's causal revision and
      // lease fence are preserved — no allocation, no overwrite.
    });
    const obligation = this.getOrThrow(key);
    assertObligationReplayMatches(obligation, input);
    return obligation;
  }

  /**
   * Read the persisted monotonic lease fence for an obligation, or NULL if no
   * lease fence has ever been persisted (the obligation has never been leased,
   * or was created before the C7-02 storage split and has not been leased
   * since). This is the durable fence read used by later fencing cards
   * (C7-03 allocation compares its candidate against this value).
   */
  readLeaseFence(obligationKey: string): number | null {
    const row = this.db.prepare(
      'SELECT lease_fence AS leaseFence FROM factory_transition_obligations WHERE obligation_key = ?',
    ).get(obligationKey) as { leaseFence: number | null } | undefined;
    return row ? row.leaseFence : null;
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
   *
   * ADR-053 C7-01: `fence` is a DISTINCT type from a causal source revision — a
   * CausalSourceRevision passed here is rejected (brand mismatch). ADR-053
   * C7-02: the monotonic lease fence is persisted on the DEDICATED `lease_fence`
   * column (NOT on the causal `fence` column, which retains the source-fact
   * revision written at append). The write is MONOTONIC at the storage level —
   * `lease_fence = MAX(COALESCE(lease_fence, 0), :new)` — so a stored fence
   * value never decreases on overwrite, regardless of what value the caller
   * supplies. (Enforcing that callers must obtain a strictly-increasing fence
   * from the allocator — i.e. they cannot choose an arbitrary future fence — is
   * C7-03's atomic-allocation concern; this method only stores and reads it.)
   */
  lease(
    obligationKey: string,
    leaseOwner: string,
    fence: LeaseFence,
  ): boolean {
    assertLeaseFence(fence);
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
           lease_fence = MAX(COALESCE(lease_fence, 0), @fence),
           updated_at = datetime('now')
       WHERE obligation_key = @key
         AND (state = 'pending'
              OR (state = 'in_progress' AND lease_expires_at IS NOT NULL
                  AND unixepoch(lease_expires_at) < @now))`,
    ).run({
      key: obligationKey,
      leaseOwner,
      expiresAt,
      fence: fence.value,
      now,
    });
    return result.changes > 0;
  }

  /**
   * Persist a monotonic lease fence into an obligation's DEDICATED `lease_fence`
   * column WITHOUT taking the execution lease (no state transition, no lease
   * owner, no attempt bump). The write is MONOTONIC: a value lower than the
   * stored fence does NOT overwrite it (`lease_fence = MAX(COALESCE(lease_fence,
   * 0), :new)`). Used by the fence allocator in C7-03 to pre-reserve a fence
   * before the reconciler leases the obligation; here in C7-02 it is exposed so
   * the storage-level monotonicity guarantee is testable independently of the
   * lease CAS. Returns the fence value now in effect for the obligation (the
   * higher of the stored and supplied values), or NULL if the obligation does
   * not exist.
   */
  persistLeaseFence(obligationKey: string, fence: LeaseFence): number | null {
    assertLeaseFence(fence);
    this.db.prepare(
      `UPDATE factory_transition_obligations
       SET lease_fence = MAX(COALESCE(lease_fence, 0), @fence),
           updated_at = datetime('now')
       WHERE obligation_key = @key`,
    ).run({ key: obligationKey, fence: fence.value });
    return this.readLeaseFence(obligationKey);
  }

  /**
   * Atomically ALLOCATE the next monotonic lease fence for an obligation and
   * return it (ADR-053 C7-03). The fence is ALLOCATED BY THE STORE, never
   * supplied by the caller: a caller cannot choose, predict, or lower a future
   * fence. Contrast {@link persistLeaseFence} / {@link lease}, which accept a
   * caller-supplied fence and apply the MAX-CAS — those are the "supply" paths;
   * this is the "allocate" path the reconciler uses when it has no externally-
   * minted fence token.
   *
   * Implementation: ONE IMMEDIATE transaction — read the stored fence, derive
   * `candidate = current + 1` INSIDE the transaction, apply the MAX-based CAS
   * (`lease_fence = MAX(COALESCE(lease_fence, 0), :candidate)`) so the stored
   * value can never decrease even if the read were somehow stale, and return
   * the value now in effect. SQLite serializes writers via the write lock taken
   * by `BEGIN IMMEDIATE` (see {@link transaction}), so two concurrent
   * allocators on the SAME obligation receive strictly-distinct, monotonically-
   * increasing fences — monotonicity is enforced by the STORE, not by process
   * memory or wall-clock ordering. (Two allocators on DIFFERENT obligations
   * allocate independently: each obligation's fence is monotonic per-
   * obligation, which is the fencing unit the reconciler leases.)
   *
   * Allocation does NOT take the execution lease: it only bumps `lease_fence`
   * and `updated_at`. The state, lease owner, and attempt count are untouched.
   * The reconciler follows allocation with {@link lease}, whose MAX-CAS keeps
   * the just-allocated fence in effect.
   *
   * @returns the newly-allocated monotonic LeaseFence (its `.value` is strictly
   *          greater than every previously-allocated / stored fence for this
   *          obligation).
   * @throws  TRANSITION_OBLIGATION_NOT_FOUND if the obligation does not exist
   *          (a fence can only be allocated for a durable obligation).
   */
  allocateLeaseFence(obligationKey: string): LeaseFence {
    const allocated = this.transaction(() => {
      const row = this.db.prepare(
        `SELECT COALESCE(lease_fence, 0) AS current
           FROM factory_transition_obligations
          WHERE obligation_key = ?`,
      ).get(obligationKey) as { current: number } | undefined;
      if (!row) {
        throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${obligationKey}`);
      }
      const candidate = row.current + 1;
      this.db.prepare(
        `UPDATE factory_transition_obligations
            SET lease_fence = MAX(COALESCE(lease_fence, 0), @candidate),
                updated_at = datetime('now')
          WHERE obligation_key = @key`,
      ).run({ key: obligationKey, candidate });
      const after = this.readLeaseFence(obligationKey);
      if (after === null) {
        // Unreachable: the row exists (checked above) and we just wrote
        // lease_fence. Defend against a concurrent DELETE nonetheless.
        throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${obligationKey}`);
      }
      return after;
    });
    return leaseFence(allocated);
  }

  /**
   * Record a successful completion. Idempotent: if already completed with the
   * same receipt, this is a no-op. A different receipt for the same key is
   * rejected — the obligation converged already.
   *
   * ADR-053 C7-04 — completion is FENCED BY THE LEASE TOKEN. Both `owner` and
   * `fence` are REQUIRED: a completion that lacks either fails closed. The
   * `fence` must be >= the obligation's stored monotonic `lease_fence`; a LOWER
   * fence is REJECTED, so a stale lease holder (an older fence) cannot complete
   * work that a newer fence has since taken over (via {@link lease} /
   * {@link allocateLeaseFence} / {@link persistLeaseFence}). The stored fence is
   * NEVER lowered by a completion attempt: the UPDATE below does not write
   * `lease_fence`, so whatever monotonic value is there stays.
   */
  complete(input: CompleteObligationInput): TransitionObligation {
    // Fail closed first: a completion MUST carry the lease owner and the lease
    // fence. assertLeaseFence rejects a missing or wrongly-branded fence (a
    // causal source revision is not a lease token); the owner check rejects an
    // empty/whitespace owner.
    assertLeaseFence(input.fence);
    if (typeof input.owner !== 'string' || input.owner.trim() === '') {
      throw new Error(
        `TRANSITION_OBLIGATION_COMPLETION_REQUIRES_OWNER: ${input.obligationKey} `
          + '(completion must carry the lease owner; an anonymous completion is '
          + 'rejected)',
      );
    }

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

    // Stale-lease guard. A fence LOWER than the stored monotonic lease_fence
    // means the completer holds an OUTDATED lease: a newer fence has since
    // taken the obligation over. Such a completion is REJECTED — the stale
    // holder cannot complete work a newer fence now owns. When no lease fence
    // has ever been stored (NULL), the floor is 0 and any allocated/supplied
    // fence (>= 1) is accepted. This is a READ only; the UPDATE below does not
    // write `lease_fence`, so the stored value can never decrease here.
    const storedFenceFloor = existing.leaseFence ?? 0;
    if (input.fence.value < storedFenceFloor) {
      throw new Error(
        `TRANSITION_OBLIGATION_STALE_FENCE: ${input.obligationKey} completion `
          + `fence ${input.fence.value} is lower than the stored monotonic `
          + `lease_fence ${existing.leaseFence}; a stale lease holder cannot `
          + 'complete after a newer fence has taken over',
      );
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

  /** Release a live lease without claiming that the handoff completed. */
  defer(input: DeferObligationInput): TransitionObligation {
    assertLeaseFence(input.fence);
    if (typeof input.owner !== 'string' || input.owner.trim() === '') {
      throw new Error(`TRANSITION_OBLIGATION_DEFER_REQUIRES_OWNER: ${input.obligationKey}`);
    }
    const existing = this.get(input.obligationKey);
    if (!existing) {
      throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${input.obligationKey}`);
    }
    if (existing.state !== 'in_progress' || existing.leaseOwner !== input.owner) {
      throw new Error(
        `TRANSITION_OBLIGATION_DEFER_REQUIRES_CURRENT_LEASE: ${input.obligationKey}`,
      );
    }
    const storedFenceFloor = existing.leaseFence ?? 0;
    if (input.fence.value < storedFenceFloor) {
      throw new Error(
        `TRANSITION_OBLIGATION_STALE_FENCE: ${input.obligationKey} defer fence `
          + `${input.fence.value} is lower than ${storedFenceFloor}`,
      );
    }
    this.db.prepare(
      `UPDATE factory_transition_obligations
          SET state='pending',lease_owner=NULL,lease_expires_at=NULL,
              last_error=@reason,updated_at=datetime('now')
        WHERE obligation_key=@key`,
    ).run({ key: input.obligationKey, reason: `DEFERRED: ${input.reason}` });
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Record a BUSINESS-HANDLER FAILURE (the effect itself failed — the handler
   * threw). The obligation returns to `pending` so the reconciler can retry it.
   * The business error is stored on `last_error`, DISTINCT from the
   * {@link LEASE_LOSS_RECLAIM_MARKER} that {@link reclaim} writes, so a reader
   * can tell a genuine business failure apart from a lease-loss reclaim.
   *
   * ADR-053 C7-05 — failure is FENCED BY THE LEASE TOKEN, symmetric with
   * {@link complete}. Both `owner` and `fence` are REQUIRED: a failure that
   * lacks either fails closed. The `fence` must be >= the obligation's stored
   * monotonic `lease_fence`; a LOWER fence is REJECTED, so a stale lease holder
   * (an older fence) cannot fail work that a newer fence has since taken over.
   * The stored fence is NEVER lowered by a failure attempt (the UPDATE does not
   * write `lease_fence`). A terminal state (`completed` / `failed`) is NEVER
   * altered — a failure on a converged obligation is rejected outright.
   */
  fail(input: FailObligationInput): TransitionObligation {
    // Fail closed first: a failure MUST carry the lease owner and the lease
    // fence (symmetric with complete).
    assertLeaseFence(input.fence);
    if (typeof input.owner !== 'string' || input.owner.trim() === '') {
      throw new Error(
        `TRANSITION_OBLIGATION_FAILURE_REQUIRES_OWNER: ${input.obligationKey} `
          + '(failure must carry the lease owner; an anonymous failure is '
          + 'rejected)',
      );
    }

    const existing = this.get(input.obligationKey);
    if (!existing) {
      throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${input.obligationKey}`);
    }

    // Terminal-state guard. A converged obligation (completed) or a permanently
    // failed one cannot be failed again — and crucially a STALE transition
    // cannot change a terminal state. This is checked before the staleness read
    // so a stale failure on a terminal obligation is rejected (state preserved)
    // regardless of the fence value.
    if (existing.state === 'completed' || existing.state === 'failed') {
      throw new Error(
        `TRANSITION_OBLIGATION_TERMINAL: ${input.obligationKey} is `
          + `${existing.state}; a terminal obligation cannot be failed`,
      );
    }

    // Stale-lease guard. A fence LOWER than the stored monotonic lease_fence
    // means the failing holder holds an OUTDATED lease: a newer fence has since
    // taken the obligation over. Such a failure is REJECTED — the stale holder
    // cannot fail work a newer fence now owns. This is a READ only; the UPDATE
    // below does not write `lease_fence`, so the stored value can never
    // decrease here.
    const storedFenceFloor = existing.leaseFence ?? 0;
    if (input.fence.value < storedFenceFloor) {
      throw new Error(
        `TRANSITION_OBLIGATION_STALE_FENCE: ${input.obligationKey} failure `
          + `fence ${input.fence.value} is lower than the stored monotonic `
          + `lease_fence ${existing.leaseFence}; a stale lease holder cannot `
          + 'fail after a newer fence has taken over',
      );
    }

    this.db.prepare(
      `UPDATE factory_transition_obligations
       SET state = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = @error,
           updated_at = datetime('now')
       WHERE obligation_key = @key`,
    ).run({ key: input.obligationKey, error: input.error });
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Record a LEASE-LOSS RECLAIM (the previous holder lost the fence — its lease
   * expired or a newer fence took the obligation over). This is LEASE LOSS, NOT
   * a business failure: the effect did not throw, the holder simply no longer
   * holds authority. The obligation returns to `pending` so a fresh lease can
   * pick it up, and {@link LEASE_LOSS_RECLAIM_MARKER} is written to `last_error`
   * so the reclaim stays DISTINCT from a {@link fail} business failure in the
   * durable record.
   *
   * ADR-053 C7-05 — reclaim is FENCED BY THE LEASE TOKEN, symmetric with
   * {@link complete} / {@link fail}. Both `owner` and `fence` are REQUIRED: a
   * reclaim that lacks either fails closed. The `fence` must be >= the stored
   * monotonic `lease_fence`; a LOWER fence is REJECTED, so a stale lease holder
   * cannot reclaim an obligation a newer fence owns (only a current holder may
   * reclaim). The stored fence is NEVER lowered (the UPDATE does not write
   * `lease_fence`). A terminal state is NEVER altered.
   */
  reclaim(input: ReclaimObligationInput): TransitionObligation {
    // Fail closed first: a reclaim MUST carry the lease owner and the lease
    // fence (symmetric with complete / fail).
    assertLeaseFence(input.fence);
    if (typeof input.owner !== 'string' || input.owner.trim() === '') {
      throw new Error(
        `TRANSITION_OBLIGATION_RECLAIM_REQUIRES_OWNER: ${input.obligationKey} `
          + '(reclaim must carry the lease owner; an anonymous reclaim is '
          + 'rejected)',
      );
    }

    const existing = this.get(input.obligationKey);
    if (!existing) {
      throw new Error(`TRANSITION_OBLIGATION_NOT_FOUND: ${input.obligationKey}`);
    }

    // Terminal-state guard. A converged/permanently-failed obligation cannot be
    // reclaimed, and a STALE transition cannot change a terminal state.
    if (existing.state === 'completed' || existing.state === 'failed') {
      throw new Error(
        `TRANSITION_OBLIGATION_TERMINAL: ${input.obligationKey} is `
          + `${existing.state}; a terminal obligation cannot be reclaimed`,
      );
    }

    // Stale-lease guard. A fence LOWER than the stored monotonic lease_fence
    // means the reclaiming holder holds an OUTDATED lease. Such a reclaim is
    // REJECTED — only the CURRENT (>= stored) fence may reclaim; a stale holder
    // cannot reclaim an obligation a newer fence owns. READ only; the UPDATE
    // below does not write `lease_fence`, so the stored value can never
    // decrease.
    const storedFenceFloor = existing.leaseFence ?? 0;
    if (input.fence.value < storedFenceFloor) {
      throw new Error(
        `TRANSITION_OBLIGATION_STALE_FENCE: ${input.obligationKey} reclaim `
          + `fence ${input.fence.value} is lower than the stored monotonic `
          + `lease_fence ${existing.leaseFence}; a stale lease holder cannot `
          + 'reclaim after a newer fence has taken over',
      );
    }

    // Lease-loss reclaim: record the sentinel (NOT a business error) so the
    // reclaim is distinguishable from a handler failure, and return to pending
    // for a fresh lease.
    this.db.prepare(
      `UPDATE factory_transition_obligations
       SET state = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = @marker,
           updated_at = datetime('now')
       WHERE obligation_key = @key`,
    ).run({ key: input.obligationKey, marker: LEASE_LOSS_RECLAIM_MARKER });
    return this.getOrThrow(input.obligationKey);
  }

  /**
   * Run `work` inside one IMMEDIATE transaction, committing on success and
   * rolling back on error. If the caller is ALREADY inside a transaction
   * (`this.db.inTransaction`), the work is nested into it without issuing a new
   * BEGIN/COMMIT — the outer owner controls the boundary. The IMMEDIATE begin
   * takes a RESERVED write lock up front, so concurrent writers serialize at
   * the store; this is what makes {@link allocateLeaseFence} store-enforced
   * monotonic under contention. Mirrors the idiom in the lifecycle-run /
   * external-effect repositories.
   */
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
  lease_fence: number | null;
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
    leaseFence: row.lease_fence,
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
