/**
 * workflow-kernel/application/faults.ts - the EK-4 fault-point registry and
 * crash scheduler (WP-07, plan phase EK-4).
 *
 * Plan law (EK-4): fault points sit immediately before and after every
 * durable write, worker spawn/return, gate, effect and obligation completion
 * boundary; executing every fault point with restart must prove an
 * exactly-once logical outcome.
 *
 * The registry is CLOSED: a point that is not in FAULT_POINTS cannot be
 * armed, and a boundary that is not listed cannot claim fault coverage.
 * Every point is a physical boundary of the kernel composition:
 *
 *   - before/after-durable-write          one sole-writer repository command
 *                                         transaction (BEGIN..COMMIT);
 *   - before/after-obligation-completion  the obligation open->completed
 *                                         edge, which physically lives INSIDE
 *                                         the same transaction as the target
 *                                         command write (a crash between the
 *                                         two cannot exist - that is the
 *                                         durable-handoff proof);
 *   - before/after-admission             activityAttempt.admitProviderRequest
 *                                         (receipt + provider-send obligation
 *                                         + counter advance, one transaction);
 *   - before/after-provider-send          cognition.sendProviderRequest (the
 *                                         eventless transport boundary);
 *   - before/after-worker-spawn           the cognition worker launch - the
 *                                         provider send IS the spawn boundary
 *                                         in the kernel composition (the
 *                                         attempt was already admitted);
 *   - before/after-worker-return          activityAttempt.recordOutcome (the
 *                                         worker's outcome entering the
 *                                         attempt);
 *   - before/after-gate                   workplace.runAuthorGate /
 *                                         workplace.runFinalGate;
 *   - before/after-effect                 workplace.settleEffect.
 *
 * A crash is FaultCrashError - the simulated death of the driving process.
 * The scheduler holds NO durable state and NO timers: recovery is always
 * "restart the composition and re-derive the next step from durable rows"
 * (never from a heartbeat, a board or an empty queue).
 */

/** The closed fault-point registry (every durable boundary of EK-4). */
export const FAULT_POINTS = [
  'before-durable-write',
  'after-durable-write',
  'before-obligation-completion',
  'after-obligation-completion',
  'before-admission',
  'after-admission',
  'before-provider-send',
  'after-provider-send',
  'before-worker-spawn',
  'after-worker-spawn',
  'before-worker-return',
  'after-worker-return',
  'before-gate',
  'after-gate',
  'before-effect',
  'after-effect',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

/** The named crash window at an exact fault point. */
export class FaultCrashError extends Error {
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`EK_FAULT_CRASH at ${point}`);
    this.name = 'FaultCrashError';
    this.point = point;
  }
}

/** The point classification of one command boundary (co-fired with the generic durable-write points). */
export function commandFaultPoints(command: string): readonly FaultPoint[] {
  switch (command) {
    case 'cognition.sendProviderRequest':
      return ['before-worker-spawn', 'before-provider-send', 'after-provider-send', 'after-worker-spawn'];
    case 'activityAttempt.recordOutcome':
      return ['before-worker-return', 'after-worker-return'];
    case 'workplace.runAuthorGate':
    case 'workplace.runFinalGate':
      return ['before-gate', 'after-gate'];
    case 'workplace.settleEffect':
      return ['before-effect', 'after-effect'];
    default:
      return [];
  }
}

/**
 * Arm ONE fault point; the fire with the given 1-based index (default: the
 * first) crashes the driving process exactly once - a restart is a clean
 * process, so the schedule does not survive it, exactly like a real crash.
 * Deterministic, timer-free.
 */
export class FaultScheduler {
  private readonly armedPoint: FaultPoint | undefined;
  private readonly armedAtFire: number;
  private readonly fireCounts = new Map<FaultPoint, number>();
  private crashed = false;

  constructor(point?: FaultPoint, atFire = 1) {
    if (point !== undefined && !(FAULT_POINTS as readonly string[]).includes(point)) {
      throw new TypeError(`unknown fault point "${point}" (the registry is closed)`);
    }
    if (!Number.isInteger(atFire) || atFire < 1) {
      throw new TypeError(`fault fire index must be a positive integer (got ${String(atFire)})`);
    }
    this.armedPoint = point;
    this.armedAtFire = atFire;
  }

  /** Arm a scheduler without a crash point (pure observation/coverage mode). */
  static observing(): FaultScheduler {
    return new FaultScheduler();
  }

  /** Fire a fault point: crash exactly once, at the armed fire index. */
  fire(point: FaultPoint): void {
    const count = (this.fireCounts.get(point) ?? 0) + 1;
    this.fireCounts.set(point, count);
    if (this.armedPoint === point && count === this.armedAtFire && !this.crashed) {
      this.crashed = true;
      throw new FaultCrashError(point);
    }
  }

  /** How many times a point was reached (fault coverage evidence). */
  count(point: FaultPoint): number {
    return this.fireCounts.get(point) ?? 0;
  }

  /** True when the armed crash already happened. */
  readonly hasCrashed = (): boolean => this.crashed;
}

/** Fire every point of one command boundary phase (before-* or after-*). */
export function fireBoundaryPoints(faults: FaultScheduler | undefined, command: string, phase: 'before' | 'after'): void {
  for (const point of commandFaultPoints(command)) {
    if (point.startsWith(`${phase}-`)) faults?.fire(point);
  }
}
