/**
 * Saga 3 — Budget ledger.
 *
 * Append-only. Parallel workers reserve before dispatch.
 * Two workers attempting to reserve the final unit → exactly one accepted.
 * A new generation never resets prior consumption (carry-forward).
 */

export type BudgetEntryType =
  | 'allocation'
  | 'reservation'
  | 'consumption'
  | 'release'
  | 'exhaustion';

export interface BudgetEntry {
  readonly id: string;
  readonly episodeSpecId: string;
  readonly budgetKind: string; // total | stage | incident | strategy
  readonly entryType: BudgetEntryType;
  readonly amount: number; // positive for alloc/reserve/consume, negative for release
  readonly reservationRef: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
}

/**
 * In-memory budget ledger. Production uses SQLite (append-only table).
 * Tests use this directly.
 */
export class BudgetLedger {
  private entries: BudgetEntry[] = [];

  constructor(private readonly episodeSpecId: string) {}

  allocate(amount: number, reason?: string): void {
    this.entries.push({
      id: '',
      episodeSpecId: this.episodeSpecId,
      budgetKind: 'total',
      entryType: 'allocation',
      amount,
      reservationRef: null,
      reason: reason ?? 'initial allocation',
      createdAt: Date.now(),
    });
  }

  /**
   * Atomically reserve budget. Returns false if insufficient remaining.
   * Two concurrent calls for the final unit → exactly one succeeds.
   */
  reserve(amount: number, reservationRef: string, reason?: string): boolean {
    const remaining = this.getRemaining();
    if (remaining < amount) return false;
    this.entries.push({
      id: '',
      episodeSpecId: this.episodeSpecId,
      budgetKind: 'total',
      entryType: 'reservation',
      amount,
      reservationRef,
      reason: reason ?? 'reservation',
      createdAt: Date.now(),
    });
    return true;
  }

  consume(amount: number, reservationRef: string, reason?: string): void {
    this.entries.push({
      id: '',
      episodeSpecId: this.episodeSpecId,
      budgetKind: 'total',
      entryType: 'consumption',
      amount,
      reservationRef,
      reason: reason ?? 'consumption',
      createdAt: Date.now(),
    });
  }

  release(amount: number, reservationRef: string, reason?: string): void {
    this.entries.push({
      id: '',
      episodeSpecId: this.episodeSpecId,
      budgetKind: 'total',
      entryType: 'release',
      amount: -amount,
      reservationRef,
      reason: reason ?? 'release',
      createdAt: Date.now(),
    });
  }

  getAllocated(): number {
    return this.sum('allocation');
  }

  getReserved(): number {
    return this.sum('reservation') - this.sum('release');
  }

  getConsumed(): number {
    return this.sum('consumption');
  }

  getRemaining(): number {
    return this.getAllocated() - this.getReserved() - this.getConsumed();
  }

  isExhausted(): boolean {
    return this.getRemaining() <= 0;
  }

  /**
   * Carry forward consumption to a new generation.
   * Returns the consumed amount for the new generation to seed.
   */
  carryForward(): number {
    return this.getConsumed();
  }

  private sum(type: BudgetEntryType): number {
    return this.entries
      .filter((e) => e.entryType === type)
      .reduce((s, e) => s + e.amount, 0);
  }

  getAll(): readonly BudgetEntry[] {
    return [...this.entries];
  }
}
