/**
 * ConcurrentLaunchBudget — the single global concurrency governor
 * (Conveyor v4 step 2.5).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-10-AC-05 ("все launch
 * paths учитываются одним concurrency budget") + Conveyor Mental Model v4
 * §«One queue, one concurrency knob, infrastructure leases Workplaces».
 *
 * # Why this exists
 *
 * Today two launch paths can run in parallel:
 *      `WorkAssignmentPort.assignTask` → `WorkerExecutor.start`.
 *   2. `dispatch-loop.ts` drains queued tasks through
 *      `WorkerExecutorFactory` → `ClaudeBoardWorkerExecutor`.
 *
 * Each path has its own concurrency tracking (the LM executor spawns one
 * worker per node; the dispatch loop tracks `active.size`). v4 requires ONE
 * global `--concurrency=N` that covers EVERY launch path (REG-10-AC-05).
 * This module is the single budget both paths MUST consult before spawning.
 *
 * # Pure mechanism
 *
 * The budget is a pure counter with acquire/release semantics. It does NOT
 * decide WHICH workplace to staff (that is the dispatcher's job) and does NOT
 * launch processes (that is the launcher's job). It only answers:
 *
 *   "Is there a free slot under the global cap? If yes, acquire it; if no,
 *   the caller must wait."
 *
 * # Thread-safety
 *
 * Node.js is single-threaded, so the counter needs no locks. The budget is
 * async-aware: `acquire()` returns a Promise that resolves when a slot frees
 * (callers `await` it). This mirrors how the dispatch-loop already awaits
 * `Promise.race(active)` before launching the next worker.
 *
 * # Step 2.5 scope
 *
 * EXISTS and tested; nothing on the runtime path uses it yet. Step 5 wires
 * BOTH launch paths through this budget (the LM executor and the dispatch
 * loop both call `acquire()` before spawning). Until then both paths keep
 * their existing per-path tracking.
 */

/**
 * The single global concurrency governor.
 *
 * REG-10-AC-05. Construct once per runtime with `--concurrency=N`. Every
 * launch path MUST call `acquire()` before spawning a worker and `release()`
 * when the worker terminates. The budget enforces:
 *
 *   - at most `capacity` concurrent slots are held at any time;
 *   - `acquire()` blocks (returns a pending Promise) when the budget is full;
 *   - `release()` frees one slot and unblocks the next waiter (FIFO order);
 *   - `available()` reports the current free count (for the dispatcher's
 *     batch-planning signal — NOT authoritative for assignment, which still
 *     goes through `WorkAssignmentPort.assignTask`).
 */
export class ConcurrentLaunchBudget {
  private readonly capacity: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param capacity the global concurrency cap (`--concurrency=N`). Must be a
   * positive integer (the dispatch loop already enforces 1..10).
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `ConcurrentLaunchBudget: capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacity = capacity;
  }

  /**
   * Acquire one concurrency slot.
   *
   * Returns immediately (resolved Promise) when a slot is free; returns a
   * pending Promise when the budget is full — the caller MUST `await` it
   * before spawning. Waiters are served in FIFO order.
   *
   * REG-10-AC-05: every launch path MUST go through this. A path that spawns
   * without acquiring breaks the global budget and can exceed `capacity`.
   */
  async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    // Full — queue the caller behind a Promise that `release()` will resolve.
    // When release() resolves us, the slot was TRANSFERRED (active did not
    // change), so we do NOT increment here.
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release one concurrency slot. MUST be called when a worker terminates
   * (normal close, crash, cancel). If a waiter is queued, the slot is
   * transferred directly to them (active stays the same — the waiter "takes
   * over" the releasing slot). If no waiter, active decrements.
   */
  release(): void {
    if (this.active <= 0) {
      throw new Error(
        'ConcurrentLaunchBudget.release called with no active slot — double release?',
      );
    }
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot directly: the waiter takes over without active
      // dipping to zero. The waiter's acquire() does NOT re-increment
      // (we already counted this slot). To make this work, we mark the
      // waiter as "pre-counted" by NOT incrementing in acquire's waiter path.
      // So: active stays the same here, and the waiter resolves without
      // touching active.
      next();
      // active unchanged — slot transferred.
    } else {
      this.active -= 1;
    }
  }

  /** How many slots are currently free (capacity - active). */
  available(): number {
    return Math.max(0, this.capacity - this.active);
  }

  /** How many slots are currently held. */
  inUse(): number {
    return this.active;
  }

  /** The configured cap. */
  get cap(): number {
    return this.capacity;
  }
}
