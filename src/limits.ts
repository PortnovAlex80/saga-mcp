import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Operator throttle. NOT kernel state: how fast we are willing to hire workers
// is a property of the machine and of the provider's plan, not of the product
// being built. It therefore lives beside the database as a small JSON file —
// no table, no event, nothing to replay.
//
// The file is the source of truth so that the MCP server, the bridge and a
// human with an editor all agree; the bridge re-reads it when its mtime moves.

export interface Limits {
  /** Workers hired at the same time. GLM plans throttle above ~2–3. */
  max_workers: number;
  /** Minimum delay between two hires — a rate limit, not a concurrency cap. */
  min_spawn_interval_ms: number;
}

export const DEFAULT_LIMITS: Limits = { max_workers: 4, min_spawn_interval_ms: 0 };

export function limitsPath(dbPath = process.env.DB_PATH ?? ''): string {
  if (!dbPath) throw new Error('DB_PATH is required to locate the limits file');
  return `${dbPath}.limits.json`;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

/** Fail-open: an unreadable or malformed file must never stop the factory. */
export function readLimits(dbPath?: string, defaults: Limits = DEFAULT_LIMITS): Limits {
  try {
    const file = limitsPath(dbPath);
    if (!existsSync(file)) return { ...defaults };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Limits>;
    return {
      max_workers: clamp(raw.max_workers, 1, 64, defaults.max_workers),
      min_spawn_interval_ms: clamp(raw.min_spawn_interval_ms, 0, 600_000, defaults.min_spawn_interval_ms),
    };
  } catch {
    return { ...defaults };
  }
}

export function writeLimits(limits: Partial<Limits>, dbPath?: string): Limits {
  const current = readLimits(dbPath);
  const next: Limits = {
    max_workers: clamp(limits.max_workers ?? current.max_workers, 1, 64, current.max_workers),
    min_spawn_interval_ms: clamp(
      limits.min_spawn_interval_ms ?? current.min_spawn_interval_ms,
      0,
      600_000,
      current.min_spawn_interval_ms
    ),
  };
  const file = limitsPath(dbPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** mtime of the limits file, so a reader can notice an external change. */
export function limitsStamp(dbPath?: string): number {
  try {
    return statSync(limitsPath(dbPath)).mtimeMs;
  } catch {
    return 0;
  }
}
