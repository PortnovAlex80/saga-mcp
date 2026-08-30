import type Database from 'better-sqlite3';
import { nodeDefinitionFor } from './runner.js';
import { runGraphJson } from './projection.js';
import type { ExecutionRow, ModelUsage } from './executions.js';

// The worker monitor: who is hired right now, on what model, for how long,
// and what they are producing at this second.
//
// Everything here is a READ of the executions header plus the run's declared
// graph. The live text comes from `executions.progress`, which the heartbeat
// overwrites — operational, never an authority. What a worker MEANS is what
// it submits; what it is DOING is this window.

export interface WorkerView {
  execution_id: string;
  run_id: string;
  workflow: string;
  node_id: string;
  attempt: number;
  status: ExecutionRow['status'];
  worker_kind: string | null;
  model?: string;
  mode?: string;
  prompt_preview?: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  /** Seconds since the attempt was claimed (or queued, when still `new`). */
  elapsed_s: number;
  /** Seconds since the last proof of life; null while queued. */
  heartbeat_age_s: number | null;
  /** Budget the kernel will enforce, so the operator sees the deadline. */
  heartbeat_s: number;
  start_to_close_s: number | null;
  schedule_to_start_s: number;
  /** true when the kernel is about to reap this attempt. */
  stale: boolean;
  progress: string;
  progress_chars: number;
  /** What the attempt spent, from `execution.completed`. */
  usage?: ModelUsage;
}

interface JoinedRow extends ExecutionRow {
  workflow: string;
}

function stamp(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(/[TZ]/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function seconds(now: number, iso: string | null): number {
  const parsed = stamp(iso);
  return parsed === null ? 0 : Math.max(0, Math.round((now - parsed) / 1000));
}

function view(db: Database.Database, row: JoinedRow, now: number): WorkerView {
  const timeouts = JSON.parse(row.timeouts_json ?? '{}') as {
    heartbeat_s?: number;
    start_to_close_s?: number;
    schedule_to_start_s?: number;
  };
  let model: string | undefined;
  let mode: string | undefined;
  let promptPreview: string | undefined;
  try {
    const def = nodeDefinitionFor(db, row.run_id, runGraphJson(db, row.run_id), row.node_id);
    const params = def.parameters as { model?: string; mode?: string; prompt?: string };
    model = typeof params.model === 'string' ? params.model : undefined;
    mode = typeof params.mode === 'string' ? params.mode : undefined;
    promptPreview = typeof params.prompt === 'string' ? params.prompt.slice(0, 300) : undefined;
  } catch {
    // a run whose graph no longer resolves must not break the monitor
  }
  const queued = row.status === 'new';
  const settled = row.finished_at !== null;
  const heartbeatS = timeouts.heartbeat_s ?? 15;
  const heartbeatAge = queued || settled ? null : seconds(now, row.heartbeat_at ?? row.started_at);
  const scheduleToStartS = timeouts.schedule_to_start_s ?? 30;
  // For a settled attempt `elapsed` is its DURATION, not its age.
  const elapsed = settled
    ? seconds(stamp(row.finished_at) ?? now, row.started_at ?? row.created_at)
    : seconds(now, queued ? row.created_at : row.started_at);
  return {
    execution_id: row.id,
    run_id: row.run_id,
    workflow: row.workflow,
    node_id: row.node_id,
    attempt: row.attempt,
    status: row.status,
    worker_kind: row.worker_kind,
    model,
    mode,
    prompt_preview: promptPreview,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    heartbeat_at: row.heartbeat_at,
    elapsed_s: elapsed,
    heartbeat_age_s: heartbeatAge,
    heartbeat_s: heartbeatS,
    start_to_close_s: timeouts.start_to_close_s ?? null,
    schedule_to_start_s: scheduleToStartS,
    stale: settled
      ? false
      : queued
        ? seconds(now, row.created_at) > scheduleToStartS
        : (heartbeatAge ?? 0) > heartbeatS,
    progress: row.progress ?? '',
    progress_chars: (row.progress ?? '').length,
  };
}

const JOIN = `SELECT e.*, w.name AS workflow
                FROM executions e
                JOIN runs r ON r.id = e.run_id
                JOIN workflows w ON w.id = r.workflow_id`;

/** Spend per attempt, read from the log where the worker recorded it. */
function usageByExecution(db: Database.Database, ids: string[]): Map<string, ModelUsage> {
  const result = new Map<string, ModelUsage>();
  if (ids.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
        WHERE type = 'execution.completed' AND payload_json LIKE '%"usage"%'`
    )
    .all() as Array<{ payload_json: string }>;
  const wanted = new Set(ids);
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { execution_id?: string; usage?: ModelUsage };
    if (payload.execution_id && payload.usage && wanted.has(payload.execution_id)) {
      result.set(payload.execution_id, payload.usage);
    }
  }
  return result;
}

/** Hired right now: claimed workers first, then the queue. */
export function liveWorkers(db: Database.Database, now = Date.now()): WorkerView[] {
  const rows = db
    .prepare(`${JOIN} WHERE e.status IN ('running','new') ORDER BY e.status DESC, e.created_at`)
    .all() as JoinedRow[];
  return rows.map((row) => view(db, row, now));
}

/** Recently settled attempts — the shift that just ended. */
export function recentWorkers(db: Database.Database, limit = 20, now = Date.now()): WorkerView[] {
  const rows = db
    .prepare(
      `${JOIN} WHERE e.status NOT IN ('running','new')
        ORDER BY COALESCE(e.finished_at, e.created_at) DESC LIMIT ?`
    )
    .all(Math.max(1, Math.min(limit, 100))) as JoinedRow[];
  const usage = usageByExecution(db, rows.map((row) => row.id));
  return rows.map((row) => ({ ...view(db, row, now), usage: usage.get(row.id) }));
}

export interface WorkerStats {
  running: number;
  queued: number;
  stale: number;
  succeeded: number;
  failed: number;
}

export function workerStats(db: Database.Database, now = Date.now()): WorkerStats {
  const live = liveWorkers(db, now);
  const byStatus = Object.fromEntries(
    (db.prepare('SELECT status, COUNT(*) AS count FROM executions GROUP BY status').all() as Array<{
      status: string;
      count: number;
    }>).map((row) => [row.status, row.count])
  );
  return {
    running: live.filter((worker) => worker.status === 'running').length,
    queued: live.filter((worker) => worker.status === 'new').length,
    stale: live.filter((worker) => worker.stale).length,
    succeeded: byStatus.success ?? 0,
    failed: (byStatus.error ?? 0) + (byStatus.crashed ?? 0),
  };
}
