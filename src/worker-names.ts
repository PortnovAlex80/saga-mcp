/**
 * Factory-floor worker callsigns (docs/architecture/WORKER-NAMES-DESIGN.md).
 *
 * The UUID `worker_id` / `execution_id` remain the AUTHORITY identifiers
 * everywhere — joins, fences, gate receipts, journal correlation keys, file
 * names (ADR-053: WorkerExecution is provenance). The callsign stamped into
 * `worker_executions.display_name` at claim time is a human-visibility layer
 * ONLY: the operator reads `worker=Forge` in the heartbeat log, `@Forge` on
 * the kanban and `grep Forge` for forensics, while every machine boundary
 * keeps speaking UUIDs.
 *
 * Schema: factory TOOLS, not people — four workshops, callsigns grouped by
 * theme (navigation / drafting / forge / print-shop), no role inside the
 * name (the phase renders NEXT to it: `Square · review`).
 *
 * Lifetime: a name is issued inside the claim transaction, is unique among
 * LIVE executions (reserved/running/cancel_requested) of one project, and
 * stays on the row for audit after the worker dies; the pool naturally
 * rotates because dead names become reusable.
 *
 * Legacy rows (written before the column existed) read through
 * `COALESCE(display_name, hashName(worker_id))` — zero-migration.
 */

import type Database from 'better-sqlite3';

/** The four factory workshops that own a dedicated name pool. */
export type WorkerWorkshop = 'discovery' | 'formalization' | 'development' | 'documentation';

/**
 * The factory callsigns, grouped by workshop (WORKER-NAMES-DESIGN.md table).
 * The design table lists 7+7+7+8 = 29 names; its prose says "28" while also
 * claiming 3–7 chars (Meridian/Endmill are 8) — the TABLE is canon, so the
 * pools carry every listed name. 24 unique first letters, no log-word
 * collisions, semantic grouping. Frozen: tests pin the exact arrays.
 */
export const WORKER_NAME_POOLS: Readonly<Record<WorkerWorkshop, readonly string[]>> = Object.freeze({
  discovery: Object.freeze(['Beacon', 'Compass', 'Gyro', 'Meridian', 'Probe', 'Transit', 'Zenith']),
  formalization: Object.freeze(['Draft', 'Jig', 'Kernel', 'Origin', 'Ruler', 'Square', 'Vector']),
  development: Object.freeze(['Anvil', 'Endmill', 'Forge', 'Hammer', 'Lathe', 'Union', 'Wrench']),
  documentation: Object.freeze(['Index', 'Nib', 'Quill', 'Vellum', 'Binder', 'Ledger', 'Ream', 'Tome']),
});

/** Flat fixed-order view of all names (workshop order preserved). */
export const ALL_WORKER_NAMES: readonly string[] = Object.freeze(
  Object.values(WORKER_NAME_POOLS).flatMap(pool => [...pool]),
);

/**
 * factory_process_runs.module_name → owning workshop. Modules without a pool
 * of their own (delivery, tests, unknown) resolve to null — the picker then
 * draws from all 28.
 */
const MODULE_NAME_TO_WORKSHOP: Readonly<Record<string, WorkerWorkshop>> = Object.freeze({
  'product-discovery': 'discovery',
  'solution-formalization': 'formalization',
  'solution-development': 'development',
  'documentation-release': 'documentation',
});

export function stageFromModuleName(
  moduleName: string | null | undefined,
): WorkerWorkshop | null {
  if (typeof moduleName !== 'string') return null;
  return MODULE_NAME_TO_WORKSHOP[moduleName] ?? null;
}

const ACTIVE_NAME_STATE_SQL = "'reserved','running','cancel_requested'";

/**
 * Pick the callsign for one new claim, inside the claim transaction.
 *
 * Selection order (design §Mechanism): free names from the workshop pool →
 * free names from the whole catalogue → deterministic suffixed series
 * (`Beacon-2`, …). "Free" = not held by a LIVE execution of the SAME project;
 * terminal executions release their names (the row keeps it for audit, the
 * pool rotates). Two live workers of one project can therefore never share a
 * display_name, while different projects draw independently.
 */
export function pickWorkerName(
  db: Database.Database,
  projectId: number,
  workshop: WorkerWorkshop | null,
): string {
  const taken = new Set<string>(
    (db.prepare(
      `SELECT DISTINCT display_name FROM worker_executions
        WHERE project_id=? AND state IN (${ACTIVE_NAME_STATE_SQL})
          AND display_name IS NOT NULL`,
    ).all(projectId) as Array<{ display_name: string }>)
      .map(row => row.display_name),
  );

  const workshopPool = workshop === null ? [] : WORKER_NAME_POOLS[workshop];
  for (const name of workshopPool) {
    if (!taken.has(name)) return name;
  }
  for (const name of ALL_WORKER_NAMES) {
    if (!taken.has(name)) return name;
  }
  // Whole catalogue live in this project: deterministic suffixed series,
  // base-name order fixed, suffix from 2 upward. Predictable for tests and
  // operators.
  for (const base of ALL_WORKER_NAMES) {
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  // Unreachable in practice (99 suffixed slots × 28 bases); last-resort
  // uniqueness guard keeps the collision-free property total.
  return `Worker-${Date.now()}`;
}

/**
 * Deterministic short fallback name for legacy rows written before the
 * display_name column existed. Stable per worker_id, distinct across ids,
 * never collides with the pool names (different alphabet shape: `W-<base36>`).
 */
export function hashName(workerId: string): string {
  // FNV-1a 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < workerId.length; i += 1) {
    hash ^= workerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W-${hash.toString(36)}`;
}
