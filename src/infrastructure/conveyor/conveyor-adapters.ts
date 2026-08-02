/**
 * Conveyor Wave — production + test adapters for the SURVIVING global port
 * surface declared in `src/application/ports/conveyor-ports.ts`.
 *
 * After the Wave 1C (FU-E) dead-port inventory + ADR-022, the only global
 * port is `IdGeneratorPort` (the one genuinely cross-module concern). The
 * previous `ClockPort` and `ProcessLivenessPort` adapters
 * (`systemClock` / `fixedClock` / `systemProcessLiveness`) had ZERO
 * production consumers and were removed: a narrow local `SupervisionClock`
 * (FU-D's job) is preferred over a global clock abstraction, and
 * `ProcessProbe` (worker-executions.ts:34) is the live liveness contract.
 *
 * What remains: the id-generator adapters that production
 * (`orchestrate-cli.ts`) and tests actually consume.
 */

import { randomUUID } from 'node:crypto';
import type { IdGeneratorPort } from '../../application/ports/conveyor-ports.js';

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
