import type Database from 'better-sqlite3';
import { appendEventInTx, getEvents } from '../events.js';
import { resumeRun } from './runner.js';
import { scheduleExecution, type ExecutionRow } from './executions.js';

// The sweep is a SELECT, not a supervisor. Every temporal decision is a
// durable event; liveness is re-established by folding the log. `now` is
// injectable so tests drive time synthetically — no sleeps, no timers here.
//
// Two passes, both idempotent:
//   1. REAP: `new`/`running` attempts whose time budget expired → `crashed`
//      + execution.timed_out (row left the active set, so this happens once).
//   2. DECIDE: settled attempts (`crashed` timed out, `error` worker-failed)
//      get exactly one retry decision, durably marked by
//      execution.retry_scheduled (atomic with the new attempt) or
//      execution.retry_exhausted (atomic with node.failed).

export interface SweepResult {
  reaped: Array<{ executionId: string; nodeId: string; kind: string }>;
  decisions: Array<{ executionId: string; nodeId: string; decision: 'retry' | 'exhausted' }>;
}

function timeoutsOf(row: ExecutionRow): { schedule_to_start_s: number; heartbeat_s: number } {
  return JSON.parse(row.timeouts_json) as { schedule_to_start_s: number; heartbeat_s: number };
}

function ageSeconds(now: Date, iso: string | null): number {
  if (!iso) return 0;
  return (now.getTime() - Date.parse(iso)) / 1000;
}

function hasDecision(db: Database.Database, runId: string, executionId: string): boolean {
  return getEvents(db, runId).some((event) => {
    if (event.type !== 'execution.retry_scheduled' && event.type !== 'execution.retry_exhausted') {
      return false;
    }
    return JSON.parse(event.payload_json).supersedes === executionId;
  });
}

export function sweep(db: Database.Database, now: Date = new Date()): SweepResult {
  const result: SweepResult = { reaped: [], decisions: [] };

  const active = db
    .prepare("SELECT * FROM executions WHERE status IN ('new', 'running')")
    .all() as ExecutionRow[];
  for (const row of active) {
    const timeouts = timeoutsOf(row);
    const isQueued = row.status === 'new';
    const kind = isQueued ? 'schedule_to_start' : 'heartbeat';
    const staleSeconds = isQueued
      ? ageSeconds(now, row.created_at)
      : ageSeconds(now, row.heartbeat_at ?? row.started_at);
    if (staleSeconds <= (isQueued ? timeouts.schedule_to_start_s : timeouts.heartbeat_s)) {
      continue;
    }
    db.transaction(() => {
      appendEventInTx(db, row.run_id, 'execution.timed_out', {
        execution_id: row.id,
        node_id: row.node_id,
        attempt: row.attempt,
        kind,
      });
      db.prepare("UPDATE executions SET status = 'crashed', finished_at = ? WHERE id = ?")
        .run(now.toISOString(), row.id);
    }).immediate();
    result.reaped.push({ executionId: row.id, nodeId: row.node_id, kind });
  }

  const settled = db
    .prepare("SELECT * FROM executions WHERE status IN ('crashed', 'error')")
    .all() as ExecutionRow[];
  for (const row of settled) {
    if (hasDecision(db, row.run_id, row.id)) continue;
    const retry = JSON.parse(row.retry_json) as { max_attempts: number };
    if (row.attempt < retry.max_attempts) {
      scheduleExecution(
        db,
        row.run_id,
        row.node_id,
        row.attempt + 1,
        {
          workerKind: row.worker_kind ?? 'llm-echo',
          timeouts: timeoutsOf(row),
          retry,
        },
        now,
        { supersedes: row.id }
      );
      result.decisions.push({ executionId: row.id, nodeId: row.node_id, decision: 'retry' });
    } else {
      db.transaction(() => {
        appendEventInTx(db, row.run_id, 'execution.retry_exhausted', {
          supersedes: row.id,
          node_id: row.node_id,
          attempts: row.attempt,
        });
        appendEventInTx(db, row.run_id, 'node.failed', {
          node_id: row.node_id,
          error: `activity failed after ${row.attempt} attempt(s)`,
        });
      }).immediate();
      result.decisions.push({ executionId: row.id, nodeId: row.node_id, decision: 'exhausted' });
    }
  }

  const runningRuns = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as Array<{
    id: string;
  }>;
  for (const { id } of runningRuns) {
    resumeRun(db, id);
  }
  return result;
}
