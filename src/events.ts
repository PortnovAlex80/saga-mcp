import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventRow, RunRow, WorkflowRow } from './types.js';

// Kernel foundation (M0): append-only event log with per-run sequence numbers.
// The Temporal idea, minimal: events + header projection + spawned rows commit
// in one transaction; state is always re-derivable from the log.

type Payload = Record<string, unknown>;

/** Inserts the next event for a run and advances `runs.next_seq`.
 *  Assumes an open transaction — public wrappers provide one. */
function appendEventInTx(db: Database.Database, runId: string, type: string, payload: Payload): EventRow {
  const run = db
    .prepare('SELECT next_seq FROM runs WHERE id = ?')
    .get(runId) as { next_seq: number } | undefined;
  if (!run) {
    throw new Error(`RUN_NOT_FOUND: ${runId}`);
  }
  const seq = run.next_seq + 1;
  const payloadJson = JSON.stringify(payload);
  db.prepare('INSERT INTO events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)')
    .run(runId, seq, type, payloadJson);
  db.prepare("UPDATE runs SET next_seq = ?, updated_at = datetime('now') WHERE id = ?")
    .run(seq, runId);
  return { run_id: runId, seq, type, payload_json: payloadJson, ts: new Date().toISOString() };
}

/** Registers a declarative workflow graph. `graphJson` is the full
 *  nodes+connections document; the kernel never interprets it here (M1). */
export function createWorkflow(
  db: Database.Database,
  name: string,
  graphJson: string,
  version = 1
): WorkflowRow {
  const id = randomUUID();
  db.prepare('INSERT INTO workflows (id, name, version, graph_json) VALUES (?, ?, ?, ?)')
    .run(id, name, version, graphJson);
  return { id, name, version, graph_json: graphJson, created_at: new Date().toISOString() };
}

/** Creates a run in status `new` and logs its first event — atomically. */
export function createRun(
  db: Database.Database,
  workflowId: string,
  opts: { rootRunId?: string; runId?: string } = {}
): EventRow {
  const runId = opts.runId ?? randomUUID();
  return db.transaction(() => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, root_run_id, status, writer_token) VALUES (?, ?, ?, 'new', ?)"
    ).run(runId, workflowId, opts.rootRunId ?? null, randomUUID());
    return appendEventInTx(db, runId, 'run.started', {
      workflow_id: workflowId,
      root_run_id: opts.rootRunId ?? null,
    });
  }).immediate();
}

/** Appends one event to a run. Sequence is allocated inside the same
 *  immediate transaction as the insert, so concurrent writers serialize. */
export function appendEvent(
  db: Database.Database,
  runId: string,
  type: string,
  payload: Payload = {}
): EventRow {
  return db.transaction(() => appendEventInTx(db, runId, type, payload)).immediate();
}

/** Kernel-only projection update: header status changes with its event in one
 *  commit, so the header can never disagree with the log. */
export function setRunStatus(
  db: Database.Database,
  runId: string,
  status: RunRow['status'],
  waitTill: string | null = null
): EventRow {
  return db.transaction(() => {
    db.prepare("UPDATE runs SET status = ?, wait_till = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, waitTill, runId);
    return appendEventInTx(db, runId, 'run.status_changed', { status, wait_till: waitTill });
  }).immediate();
}

export function getEvents(db: Database.Database, runId: string, afterSeq = 0): EventRow[] {
  return db
    .prepare('SELECT run_id, seq, type, payload_json, ts FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
    .all(runId, afterSeq) as EventRow[];
}

/** Last `limit` events of a run, oldest first. */
export function tailEvents(db: Database.Database, runId: string, limit = 50): EventRow[] {
  const rows = db
    .prepare('SELECT run_id, seq, type, payload_json, ts FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?')
    .all(runId, limit) as EventRow[];
  return rows.reverse();
}

export function getRun(db: Database.Database, runId: string): RunRow {
  const run = db
    .prepare('SELECT * FROM runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
  if (!run) {
    throw new Error(`RUN_NOT_FOUND: ${runId}`);
  }
  return run;
}
