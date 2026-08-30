import type Database from 'better-sqlite3';
import { appendEvent } from './events.js';
import type { EventRow } from './types.js';

// The operator layer: human gates surface as `blocked` tasks on the board
// (a projection — the kernel only emits events), and operator decisions
// re-enter the kernel as ordinary events (`operator.resolved`).

export type OperatorDecision = 'approve' | 'reject';

/** Kernel entry for an operator decision at a human gate. */
export function resolveHumanGate(
  db: Database.Database,
  runId: string,
  node: string,
  decision: OperatorDecision,
  note?: string
): EventRow {
  return appendEvent(db, runId, 'operator.resolved', {
    node_id: node,
    decision,
    note: note ?? null,
  });
}

function ensureProjectEpic(db: Database.Database): { projectId: number; epicId: number } {
  let project = db.prepare("SELECT id FROM projects WHERE name = 'saga5'").get() as
    | { id: number }
    | undefined;
  if (!project) {
    const info = db.prepare("INSERT INTO projects (name, description) VALUES ('saga5', 'Factory runs board')").run();
    project = { id: Number(info.lastInsertRowid) };
  }
  let epic = db
    .prepare("SELECT id FROM epics WHERE project_id = ? AND name = 'factory'")
    .get(project.id) as { id: number } | undefined;
  if (!epic) {
    const info = db
      .prepare("INSERT INTO epics (project_id, name, description) VALUES (?, 'factory', 'Operator gates and run tracking')")
      .run(project.id);
    epic = { id: Number(info.lastInsertRowid) };
  }
  return { projectId: project.id, epicId: epic.id };
}

/** Idempotently surfaces a human gate as a `blocked` board task. */
export function ensureHumanTask(
  db: Database.Database,
  runId: string,
  node: string,
  revisionDigest: string | undefined,
  title?: string
): number {
  const { epicId } = ensureProjectEpic(db);
  const existing = db
    .prepare(
      "SELECT id FROM tasks WHERE epic_id = ? AND metadata LIKE ? AND metadata LIKE ?"
    )
    .get(epicId, `%"run_id":"${runId}"%`, `%"node":"${node}"%`) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(
      "INSERT INTO tasks (epic_id, title, status, metadata) VALUES (?, ?, 'blocked', ?)"
    )
    .run(
      epicId,
      title ?? `human_required: ${node} (${runId.slice(0, 8)})`,
      JSON.stringify({ kind: 'human_gate', run_id: runId, node, revision_digest: revisionDigest ?? null })
    );
  return Number(info.lastInsertRowid);
}

/** Projects the operator decision back onto the board task. */
export function completeHumanTask(
  db: Database.Database,
  runId: string,
  node: string,
  decision: OperatorDecision
): void {
  db.prepare(
    "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE metadata LIKE ? AND metadata LIKE ? AND status = 'blocked'"
  )
    .run(
      decision === 'approve' ? 'done' : 'failed',
      `%"run_id":"${runId}"%`,
      `%"node":"${node}"%`
    );
}
