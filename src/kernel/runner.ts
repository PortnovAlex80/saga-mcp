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
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUTS,
  scheduleExecution,
  type ActivityRetry,
  type ActivityTimeouts,
} from './executions.js';
import { parseGraph, type ParsedGraph } from './graph.js';
import type { WorkflowRow } from '../types.js';

// The deterministic kernel interpreter. Temporal's split, minimal:
// the kernel only folds the event log and emits command events. Scripted
// nodes execute inside one kernel transaction; activity nodes (LLM) are only
// SCHEDULED here and executed by worker processes — the kernel folds their
// outcome and decides retries in the sweep, never inside a worker.

export interface DriveOptions {
  /** Stop cleanly after N node operations (executions + activity schedules),
   *  leaving the run `running`. The recovery affordance for tests and
   *  incremental driving. */
  maxNodeExecutions?: number;
}

export interface RunResult {
  runId: string;
  status: string;
  /** Node operations performed by THIS call (not total). */
  executed: number;
  stop: 'terminal' | 'budget' | 'waiting';
}

interface NodeFold {
  status: 'completed' | 'failed';
  outputDigest?: string;
}

interface ExecFold {
  executionId: string;
  state: 'scheduled' | 'running' | 'completed' | 'failed' | 'timed_out';
  attempt: number;
}

interface Fold {
  nodes: Map<string, NodeFold>;
  execs: Map<string, ExecFold>;
}

function foldRun(db: Database.Database, runId: string): Fold {
  const nodes: Fold['nodes'] = new Map();
  const execs: Fold['execs'] = new Map();
  for (const event of getEvents(db, runId)) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    switch (event.type) {
      case 'node.completed':
        nodes.set(String(payload.node_id), {
          status: 'completed',
          outputDigest: String(payload.output_digest),
        });
        break;
      case 'node.failed':
        nodes.set(String(payload.node_id), { status: 'failed' });
        break;
      case 'execution.scheduled':
        execs.set(String(payload.node_id), {
          executionId: String(payload.execution_id),
          state: 'scheduled',
          attempt: Number(payload.attempt),
        });
        break;
      case 'execution.started': {
        const exec = execs.get(String(payload.node_id));
        if (exec) exec.state = 'running';
        break;
      }
      case 'execution.completed': {
        for (const exec of execs.values()) {
          if (exec.executionId === String(payload.execution_id)) exec.state = 'completed';
        }
        break;
      }
      case 'execution.failed':
      case 'execution.timed_out': {
        for (const exec of execs.values()) {
          if (exec.executionId === String(payload.execution_id)) {
            exec.state = event.type === 'execution.failed' ? 'failed' : 'timed_out';
          }
        }
        break;
      }
    }
  }
  return { nodes, execs };
}

function findRunnable(graph: ParsedGraph, fold: Fold): { nodeId: string; isActivity: boolean } | undefined {
  for (const name of graph.order) {
    if (fold.nodes.has(name)) continue;
    if (!graph.inbound[name].every((upstream) => fold.nodes.get(upstream)?.status === 'completed')) {
      continue;
    }
    if (getNodeType(graph.nodes[name].type).activity) {
      // One attempt in flight at a time; retry attempts are the sweep's job.
      if (fold.execs.has(name)) continue;
      return { nodeId: name, isActivity: true };
    }
    return { nodeId: name, isActivity: false };
  }
  return undefined;
}

/** success → every node completed; error → the rest is stranded downstream of
 *  failures; waiting → an activity is in flight (or a transient kernel state)
 *  and the run stays `running`. */
function analyzeTerminal(graph: ParsedGraph, fold: Fold): 'success' | 'error' | 'waiting' {
  const failed = new Set<string>();
  let allCompleted = true;
  for (const name of graph.order) {
    const nodeFold = fold.nodes.get(name);
    if (!nodeFold) {
      allCompleted = false;
    } else if (nodeFold.status === 'failed') {
      allCompleted = false;
      failed.add(name);
    }
  }
  if (allCompleted) return 'success';

  const stranded = new Set<string>();
  const stack = [...failed];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of graph.order) {
      if (!stranded.has(name) && graph.inbound[name].includes(current)) {
        stranded.add(name);
        stack.push(name);
      }
    }
  }
  for (const name of graph.order) {
    if (!fold.nodes.has(name) && !stranded.has(name)) return 'waiting';
  }
  return 'error';
}

function activityPolicy(parameters: Record<string, unknown>): {
  workerKind: string;
  timeouts: ActivityTimeouts;
  retry: ActivityRetry;
} {
  const mode = typeof parameters.mode === 'string' ? parameters.mode : 'echo';
  const timeouts = { ...DEFAULT_TIMEOUTS };
  const retry = { ...DEFAULT_RETRY };
  if (parameters.timeouts && typeof parameters.timeouts === 'object') {
    Object.assign(timeouts, parameters.timeouts as Partial<ActivityTimeouts>);
  }
  if (parameters.retry && typeof parameters.retry === 'object') {
    Object.assign(retry, parameters.retry as Partial<ActivityRetry>);
  }
  return { workerKind: `llm-${mode}`, timeouts, retry };
}

/** Executes one scripted node. The happy path commits scheduled+started+
 *  material+completed in ONE transaction; on failure the rolled-back attempt
 *  is re-logged as scheduled+started+failed so the log always tells the truth. */
function executeNode(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold
): { status: 'completed' | 'failed' } {
  const node = graph.nodes[nodeId];
  const upstream = graph.inbound[nodeId];
  const inputDigests = upstream.map((name) => fold.nodes.get(name)!.outputDigest!);

  try {
    return db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      const inputs = upstream.map((name) =>
        JSON.parse(requireMaterial(db, fold.nodes.get(name)!.outputDigest!).content) as Item[]
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
      return { status: 'completed' as const };
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
  let fold = foldRun(db, runId);
  for (;;) {
    const runnable = findRunnable(graph, fold);
    if (!runnable) break;
    if (opts.maxNodeExecutions !== undefined && executed >= opts.maxNodeExecutions) {
      return { runId, status: 'running', executed, stop: 'budget' };
    }
    if (runnable.isActivity) {
      const policy = activityPolicy(graph.nodes[runnable.nodeId].parameters ?? {});
      scheduleExecution(db, runId, runnable.nodeId, 1, policy);
    } else {
      executeNode(db, runId, graph, runnable.nodeId, fold);
    }
    executed++;
    fold = foldRun(db, runId);
  }

  const outcome = analyzeTerminal(graph, fold);
  if (outcome === 'waiting') {
    return { runId, status: 'running', executed, stop: 'waiting' };
  }
  setRunStatus(db, runId, outcome);
  return { runId, status: outcome, executed, stop: 'terminal' };
}

/** Registers the workflow (dedup by identical content) and runs a fresh run
 *  to completion, budget, or the first in-flight activity. */
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
 *  never committed) is re-driven until terminal, budget, or in-flight wait. */
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

/** Worker-side input read: exact upstream digests, exact materials — the
 *  ADR-053 rule at the activity boundary. */
export function readActivityInputs(
  db: Database.Database,
  runId: string,
  graphJson: string,
  nodeId: string
): Item[][] {
  const graph = parseGraph(graphJson);
  const digests = new Map<string, string>();
  for (const event of getEvents(db, runId)) {
    if (event.type !== 'node.completed') continue;
    const payload = JSON.parse(event.payload_json) as { node_id: string; output_digest: string };
    digests.set(payload.node_id, payload.output_digest);
  }
  return graph.inbound[nodeId].map((upstream) => {
    const digest = digests.get(upstream);
    if (!digest) {
      throw new Error(`ACTIVITY_INPUT_MISSING: upstream '${upstream}' of '${nodeId}' has no completed material`);
    }
    return JSON.parse(requireMaterial(db, digest).content) as Item[];
  });
}
