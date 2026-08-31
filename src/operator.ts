import type Database from 'better-sqlite3';
import { appendEvent, appendEventInTx, getRun } from './events.js';
import { putMaterial } from './materials.js';
import { nodeDefinitionFor, resumeRun, type RunResult } from './kernel/runner.js';
import { runGraphJson } from './kernel/projection.js';
import type { Item } from './kernel/node-types.js';
import type { EventRow } from './types.js';

// The operator layer: human gates surface as `blocked` tasks on the board
// (a projection — the kernel only emits events), and operator decisions
// re-enter the kernel as ordinary events (`operator.resolved`).
//
// Editing an artifact is NOT a second mechanism: a human hand-writing material
// is a worker submitting material. Same events, same desk accumulation, same
// gate — only the provenance differs (`author: 'operator'`). That is what
// makes "управление через артефакты-спецификации" cost one function.

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

/** «Мир изменился — попробуй снова».
 *
 *  Исчерпанный бюджет ретраев — утверждение о ВОРКЕРЕ, а не о мире: пропала
 *  сеть, лежал провайдер, был занят диск. Автоматически отличить такое от
 *  настоящего дефекта нельзя (именно на этой развилке saga4 отрастила
 *  супервайзеров), поэтому решение остаётся за человеком — но стоит одну
 *  команду и записывается durable-событием, а не правкой состояния руками.
 *
 *  Терминальный прогон переоткрывается явно; узел получает свежий бюджет
 *  автоматических попыток. Материал, уже принятый выше по конвейеру, не
 *  трогается — повторяется ровно один узел. */
export function retryNode(
  db: Database.Database,
  runId: string,
  nodeId: string,
  note?: string
): OperatorSubmission['run'] {
  const run = getRun(db, runId);
  if (run.status === 'success') {
    throw new Error('RUN_SEALED: успешный прогон повторять нечего — запустите новый');
  }
  nodeDefinitionFor(db, runId, runGraphJson(db, runId), nodeId);

  db.transaction(() => {
    if (run.status === 'error' || run.status === 'crashed') {
      appendEventInTx(db, runId, 'operator.reopened', { from_status: run.status, note: note ?? null });
      db.prepare("UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(runId);
    }
    appendEventInTx(db, runId, 'operator.retry_requested', { node_id: nodeId, note: note ?? null });
  }).immediate();

  return resumeRun(db, runId);
}

export interface OperatorSubmission {
  run_id: string;
  node_id: string;
  digest: string;
  items_count: number;
  /** The run after the kernel re-drove it (gate re-decides over the new desk). */
  run: RunResult;
}

/** Operator-authored material for one node: the artifact editor's write path.
 *
 *  The new material lands on the node's desk exactly like a worker submission,
 *  so the gate re-decides over the accumulated desk and downstream nodes see
 *  the repaired revision. A terminal (`error`) run is explicitly reopened with
 *  a durable `operator.reopened` event — never silently. */
export function submitOperatorMaterial(
  db: Database.Database,
  runId: string,
  nodeId: string,
  items: Item[],
  note?: string
): OperatorSubmission {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('ITEMS_REQUIRED: operator submission needs at least one item');
  }
  const run = getRun(db, runId);
  if (run.status === 'success') {
    throw new Error('RUN_SEALED: a successful run is accepted material; start a new run instead');
  }
  // Fails closed for a node that does not exist in this run's topology.
  nodeDefinitionFor(db, runId, runGraphJson(db, runId), nodeId);

  const normalized: Item[] = items.map((item) => ({
    json: (item && typeof item === 'object' && 'json' in item
      ? (item as Item).json
      : (item as unknown as Record<string, unknown>)) ?? {},
  }));

  const digest = db.transaction(() => {
    if (run.status === 'error' || run.status === 'crashed') {
      appendEventInTx(db, runId, 'operator.reopened', { from_status: run.status, note: note ?? null });
      db.prepare("UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(runId);
    }
    const stored = putMaterial(db, 'node_output', JSON.stringify(normalized));
    appendEventInTx(db, runId, 'material.submitted', {
      node_id: nodeId,
      digest: stored.digest,
      schema_ref: 'node_output',
      items_count: normalized.length,
      author: 'operator',
      note: note ?? null,
    });
    appendEventInTx(db, runId, 'node.completed', {
      node_id: nodeId,
      output_digest: stored.digest,
      items_count: normalized.length,
      author: 'operator',
    });
    return stored.digest;
  }).immediate();

  return {
    run_id: runId,
    node_id: nodeId,
    digest,
    items_count: normalized.length,
    run: resumeRun(db, runId),
  };
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
