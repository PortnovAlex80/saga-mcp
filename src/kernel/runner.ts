import type Database from 'better-sqlite3';
import {
  appendEventInTx,
  createRun,
  createWorkflow,
  getEvents,
  getRun,
  setRunStatus,
} from '../events.js';
import { putMaterial, requireMaterial } from '../materials.js';
import type { Item } from './node-types.js';
import { getNodeType } from './node-types.js';
import { parseGraph, type ParsedGraph } from './graph.js';
import type { WorkflowRow } from '../types.js';

// The deterministic kernel interpreter (M1). Temporal's split, minimal:
// the kernel only folds the event log and emits command events; all real
// work happens inside node executions. Scripted node types are deterministic,
// so one committed node execution = one atomic transaction, and recovery from
// a crash is exactly "fold the log, drive what is still missing".

export interface DriveOptions {
  /** Stop cleanly after N node executions, leaving the run `running`.
   *  The recovery affordance for tests and incremental driving. */
  maxNodeExecutions?: number;
}

export interface RunResult {
  runId: string;
  status: string;
  /** Node executions performed by THIS call (not total). */
  executed: number;
  stop: 'terminal' | 'budget';
}

interface NodeFold {
  status: 'completed' | 'failed';
  outputDigest?: string;
}

type Fold = Map<string, NodeFold>;

function foldRun(db: Database.Database, runId: string): Fold {
  const fold: Fold = new Map();
  for (const event of getEvents(db, runId)) {
    const payload = JSON.parse(event.payload_json) as { node_id?: string; output_digest?: string };
    if (event.type === 'node.completed' && payload.node_id) {
      fold.set(payload.node_id, { status: 'completed', outputDigest: payload.output_digest });
    } else if (event.type === 'node.failed' && payload.node_id) {
      fold.set(payload.node_id, { status: 'failed' });
    }
  }
  return fold;
}

function findRunnable(graph: ParsedGraph, fold: Fold): string | undefined {
  return graph.order.find((name) => {
    if (fold.has(name)) return false;
    return graph.inbound[name].every((upstream) => fold.get(upstream)?.status === 'completed');
  });
}

/** Executes one node. The happy path commits scheduled+started+material+
 *  completed in ONE transaction; on failure the rolled-back attempt is
 *  re-logged as scheduled+started+failed so the log always tells the truth. */
function executeNode(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold
): { status: 'completed' | 'failed'; outputDigest?: string } {
  const node = graph.nodes[nodeId];
  const upstream = graph.inbound[nodeId];
  const inputDigests = upstream.map((name) => fold.get(name)!.outputDigest!);

  try {
    return db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      const inputs = upstream.map((name) =>
        JSON.parse(requireMaterial(db, fold.get(name)!.outputDigest!).content) as Item[]
      );
      const outputs = getNodeType(node.type).execute({
        nodeId,
        parameters: node.parameters ?? {},
        inputs,
      });
      const { digest } = putMaterial(db, 'node_output', JSON.stringify(outputs));
      appendEventInTx(db, runId, 'material.submitted', {
        node_id: nodeId,
        digest,
        schema_ref: 'node_output',
        items_count: outputs.length,
      });
      appendEventInTx(db, runId, 'node.completed', {
        node_id: nodeId,
        output_digest: digest,
        items_count: outputs.length,
      });
      return { status: 'completed' as const, outputDigest: digest };
    }).immediate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      appendEventInTx(db, runId, 'node.failed', { node_id: nodeId, error: message });
    }).immediate();
    return { status: 'failed' };
  }
}

function drive(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  opts: DriveOptions
): RunResult {
  let executed = 0;
  for (;;) {
    const fold = foldRun(db, runId);
    const runnable = findRunnable(graph, fold);
    if (!runnable) {
      const allCompleted = graph.order.every((name) => fold.get(name)?.status === 'completed');
      setRunStatus(db, runId, allCompleted ? 'success' : 'error');
      return { runId, status: allCompleted ? 'success' : 'error', executed, stop: 'terminal' };
    }
    if (opts.maxNodeExecutions !== undefined && executed >= opts.maxNodeExecutions) {
      return { runId, status: 'running', executed, stop: 'budget' };
    }
    executeNode(db, runId, graph, runnable, fold);
    executed++;
  }
}

/** Registers the workflow (dedup by identical content) and runs a fresh run
 *  to completion (or budget). */
export function runGraph(
  db: Database.Database,
  graphJson: string,
  opts: { name?: string } & DriveOptions = {}
): RunResult {
  const graph = parseGraph(graphJson);
  const workflow = ensureWorkflow(db, opts.name ?? 'graph', graphJson);
  const started = createRun(db, workflow.id);
  setRunStatus(db, started.run_id, 'running');
  return drive(db, started.run_id, graph, opts);
}

/** Resumes a run from its event log. Terminal runs are a no-op; a `running`
 *  run (including one whose kernel died mid-node — the transaction simply
 *  never committed) is re-driven until terminal or budget. */
export function resumeRun(
  db: Database.Database,
  runId: string,
  opts: DriveOptions = {}
): RunResult {
  const run = getRun(db, runId);
  if (run.status === 'success' || run.status === 'error' || run.status === 'canceled' || run.status === 'crashed') {
    return { runId, status: run.status, executed: 0, stop: 'terminal' };
  }
  const workflow = db
    .prepare('SELECT graph_json FROM workflows WHERE id = ?')
    .get(run.workflow_id) as { graph_json: string } | undefined;
  if (!workflow) {
    throw new Error(`WORKFLOW_NOT_FOUND: ${run.workflow_id}`);
  }
  return drive(db, runId, parseGraph(workflow.graph_json), opts);
}

/** Workflow registration with content dedup: same name + same bytes → same
 *  workflow row; same name + changed bytes → next version. */
function ensureWorkflow(db: Database.Database, name: string, graphJson: string): WorkflowRow {
  const existing = db
    .prepare('SELECT id, name, version, graph_json, created_at FROM workflows WHERE name = ? ORDER BY version DESC')
    .all(name) as WorkflowRow[];
  const identical = existing.find((wf) => wf.graph_json === graphJson);
  if (identical) return identical;
  return createWorkflow(db, name, graphJson, existing.length > 0 ? existing[0].version + 1 : 1);
}
