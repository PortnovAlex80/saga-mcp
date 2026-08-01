/**
 * CONVEYOR Wave — production adapters for the formal outbound ports declared
 * in `src/application/ports/conveyor-ports.ts`.
 *
 * Each adapter here wraps an EXISTING proven concrete implementation so the
 * formal port surface is satisfied without behavioral change. The composition
 * root may construct these and inject them where a port is required.
 */

import { randomUUID } from 'node:crypto';
import type {
  ClockPort,
  IdGeneratorPort,
  ProcessLivenessPort,
} from '../../application/ports/conveyor-ports.js';
import { isProcessAlive, readProcessBirthToken } from '../../worker-executions.js';

// ---------------------------------------------------------------------------
// ClockPort — production wall-clock adapter.
// ---------------------------------------------------------------------------

export const systemClock: ClockPort = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/** Fixed clock for tests — deterministic time. */
export function fixedClock(time: Date): ClockPort {
  const iso = time.toISOString();
  const ms = time.getTime();
  return { now: () => time, nowIso: () => iso, nowMs: () => ms };
}

// ---------------------------------------------------------------------------
// IdGeneratorPort — production UUID adapter.
// ---------------------------------------------------------------------------

export const uuidIdGenerator: IdGeneratorPort = {
  newId: () => randomUUID(),
  newTypedId: (prefix: string) => `${prefix}:${randomUUID()}`,
};

/** Deterministic id generator for tests — sequential counter. */
export function sequentialIdGenerator(prefix = 'id'): IdGeneratorPort {
  let n = 0;
  return {
    newId: () => `${prefix}-${++n}`,
    newTypedId: (p: string) => `${p}-${++n}`,
  };
}

// ---------------------------------------------------------------------------
// ProcessLivenessPort — wraps the existing OS process inspection functions.
// The domain receives observations; termination (kill) stays behind
// ProcessProbe in worker-executions.ts — this port deliberately exposes only
// read-only liveness + birth-token (doc line 638-639).
// ---------------------------------------------------------------------------

export const systemProcessLiveness: ProcessLivenessPort = {
  isAlive: (pid: number) => isProcessAlive(pid),
  readBirthToken: (pid: number) => readProcessBirthToken(pid),
};
