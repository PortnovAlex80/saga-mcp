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
import {
  evaluateChecks,
  revisionManifest,
  readDeskItems,
  type GateParameters,
  type RevisionMembers,
} from './gate.js';
import { parseGraph, type ParsedGraph } from './graph.js';
import type { WorkflowRow } from '../types.js';

// The deterministic kernel interpreter. Temporal's split, minimal:
// the kernel only folds the event log and emits command events. Scripted
// nodes execute inside one kernel transaction; activity nodes (LLM) are
// scheduled and executed by worker processes; gates are decided by the
// kernel over the sealed desk revision. Node desks ACCUMULATE member digests
// across executions and repairs — "latest wins" does not exist here (ADR-053).

export interface DriveOptions {
  /** Stop cleanly after N kernel operations, leaving the run `running`. */
  maxNodeExecutions?: number;
}

export interface RunResult {
  runId: string;
  status: string;
  /** Kernel operations performed by THIS call (not total). */
  executed: number;
  stop: 'terminal' | 'budget' | 'waiting';
}

interface NodeFold {
  status?: 'completed' | 'failed';
  /** Accumulated output digests, event order, deduped by content. */
  desk: string[];
  lastSeq?: number;
}

interface ExecFold {
  executionId: string;
  state: 'scheduled' | 'running' | 'completed' | 'failed' | 'timed_out';
  attempt: number;
}

interface GateFold {
  verdict: 'accepted' | 'repair_required' | 'human_required';
  decisionSeq: number;
  revisionDigest?: string;
  repairsUsed: number;
}

interface OpenRepair {
  gate: string;
  seq: number;
  attempt: number;
}

interface OperatorAction {
  decision: 'approve' | 'reject';
  seq: number;
}

interface Fold {
  nodes: Map<string, NodeFold>;
  execs: Map<string, ExecFold>;
  gates: Map<string, GateFold>;
  openRepairs: Map<string, OpenRepair>;
  operator: Map<string, OperatorAction>;
}

type Payload = Record<string, unknown>;

function foldRun(db: Database.Database, runId: string): Fold {
  const fold: Fold = {
    nodes: new Map(),
    execs: new Map(),
    gates: new Map(),
    openRepairs: new Map(),
    operator: new Map(),
  };
  const nodeOf = (name: string): NodeFold => {
    let n = fold.nodes.get(name);
    if (!n) {
      n = { desk: [] };
      fold.nodes.set(name, n);
    }
    return n;
  };
  for (const event of getEvents(db, runId)) {
    const payload = JSON.parse(event.payload_json) as Payload;
    switch (event.type) {
      case 'node.completed': {
        const n = nodeOf(String(payload.node_id));
        const digest = String(payload.output_digest);
        if (!n.desk.includes(digest)) n.desk.push(digest);
        n.status = 'completed';
        n.lastSeq = event.seq;
        const repair = fold.openRepairs.get(String(payload.node_id));
        if (repair && repair.seq < event.seq) fold.openRepairs.delete(String(payload.node_id));
        break;
      }
      case 'node.failed': {
        const n = nodeOf(String(payload.node_id));
        n.status = 'failed';
        n.lastSeq = event.seq;
        break;
      }
      case 'execution.scheduled':
        fold.execs.set(String(payload.node_id), {
          executionId: String(payload.execution_id),
          state: 'scheduled',
          attempt: Number(payload.attempt),
        });
        break;
      case 'execution.started': {
        const exec = fold.execs.get(String(payload.node_id));
        if (exec) exec.state = 'running';
        break;
      }
      case 'execution.completed': {
        for (const exec of fold.execs.values()) {
          if (exec.executionId === String(payload.execution_id)) exec.state = 'completed';
        }
        break;
      }
      case 'execution.failed':
      case 'execution.timed_out': {
        for (const exec of fold.execs.values()) {
          if (exec.executionId === String(payload.execution_id)) {
            exec.state = event.type === 'execution.failed' ? 'failed' : 'timed_out';
          }
        }
        break;
      }
      case 'gate.decided':
        fold.gates.set(String(payload.node_id), {
          verdict: payload.verdict as GateFold['verdict'],
          decisionSeq: event.seq,
          revisionDigest: payload.revision_digest === undefined ? undefined : String(payload.revision_digest),
          repairsUsed: Number(payload.attempts_used ?? 0),
        });
        break;
      case 'repair.requested':
        fold.openRepairs.set(String(payload.target), {
          gate: String(payload.node_id),
          seq: event.seq,
          attempt: Number(payload.attempt),
        });
        break;
      case 'operator.resolved':
        fold.operator.set(String(payload.node_id), {
          decision: payload.decision as 'approve' | 'reject',
          seq: event.seq,
        });
        break;
    }
  }
  return fold;
}

type RunnableKind = 'scripted' | 'activity' | 'gate' | 'operator-reject';

function findRunnable(graph: ParsedGraph, fold: Fold): { nodeId: string; kind: RunnableKind } | undefined {
  for (const name of graph.order) {
    const nodeFold = fold.nodes.get(name);
    if (nodeFold?.status === 'failed') continue;
    if (!graph.inbound[name].every((upstream) => fold.nodes.get(upstream)?.status === 'completed')) {
      continue;
    }
    const type = getNodeType(graph.nodes[name].type);

    if (type.gate) {
      const gate = fold.gates.get(name);
      if (!gate) return { nodeId: name, kind: 'gate' };
      if (gate.verdict === 'accepted') continue; // node.completed exists
      const operator = fold.operator.get(name);
      if (gate.verdict === 'human_required') {
        if (operator && operator.seq > gate.decisionSeq) {
          return { nodeId: name, kind: operator.decision === 'reject' ? 'operator-reject' : 'gate' };
        }
        continue; // typed human wait
      }
      // repair_required: re-check once the repair target produced new material
      const params = graph.nodes[name].parameters as Partial<GateParameters>;
      const target = params.repair_target ?? graph.inbound[name][0];
      const targetFold = fold.nodes.get(target);
      if (targetFold?.lastSeq !== undefined && targetFold.lastSeq > gate.decisionSeq) {
        return { nodeId: name, kind: 'gate' };
      }
      continue;
    }

    if (nodeFold && !fold.openRepairs.has(name)) {
      if (type.activity) continue; // already finished; retries are the sweep's job
      continue; // scripted finished
    }

    if (type.activity) {
      const exec = fold.execs.get(name);
      if (!exec) return { nodeId: name, kind: 'activity' };
      const settled = exec.state === 'completed' || exec.state === 'failed' || exec.state === 'timed_out';
      if (fold.openRepairs.has(name) && settled) return { nodeId: name, kind: 'activity' };
      continue; // in flight
    }
    return { nodeId: name, kind: 'scripted' };
  }
  return undefined;
}

/** success → every node completed; error → the rest is stranded downstream of
 *  failures; waiting → an activity is in flight, a repair cycle is spinning,
 *  or a gate waits for the operator. */
function analyzeTerminal(graph: ParsedGraph, fold: Fold): 'success' | 'error' | 'waiting' {
  const failed = new Set<string>();
  let allCompleted = true;
  for (const name of graph.order) {
    const nodeFold = fold.nodes.get(name);
    if (!nodeFold?.status) {
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
    if (!fold.nodes.get(name)?.status && !stranded.has(name)) return 'waiting';
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

/** Executes one scripted node: scheduled+started+material+completed in ONE
 *  transaction; failures are re-logged honestly. */
function executeNode(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold
): void {
  const node = graph.nodes[nodeId];
  const upstream = graph.inbound[nodeId];
  const inputDigests = upstream.flatMap((name) => fold.nodes.get(name)!.desk);
  try {
    db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      const inputs = upstream.flatMap((name) => readDeskItems(db, fold.nodes.get(name)!.desk));
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
    }).immediate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      appendEventInTx(db, runId, 'node.failed', { node_id: nodeId, error: message });
    }).immediate();
  }
}

/** Kernel decision over the sealed desk revision. One transaction commits:
 *  revision.sealed + gate.decided (+ node.completed on accepted, +
 *  repair.requested on repair_required). */
function executeGate(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold
): void {
  const params = (graph.nodes[nodeId].parameters ?? {}) as Partial<GateParameters>;
  const inbound = graph.inbound[nodeId];
  const checks = Array.isArray(params.checks) ? (params.checks as GateParameters['checks']) : [];
  const maxRepairs = typeof params.max_repairs === 'number' ? params.max_repairs : 2;
  const repairsUsed = fold.gates.get(nodeId)?.repairsUsed ?? 0;

  const items = inbound.flatMap((name) => readDeskItems(db, fold.nodes.get(name)!.desk));
  const outcome = evaluateChecks(checks, items);
  const verdict =
    outcome.verdict === 'accepted'
      ? 'accepted'
      : repairsUsed < maxRepairs
        ? 'repair_required'
        : 'human_required';

  const members: RevisionMembers[] = inbound.map((name) => ({
    node: name,
    digests: [...(fold.nodes.get(name)!.desk)],
  }));
  const manifest = revisionManifest(members);

  db.transaction(() => {
    const revision = putMaterial(db, 'desk_revision', manifest);
    appendEventInTx(db, runId, 'revision.sealed', {
      node_id: nodeId,
      revision_digest: revision.digest,
      members,
    });
    appendEventInTx(db, runId, 'gate.decided', {
      node_id: nodeId,
      verdict,
      revision_digest: revision.digest,
      reasons: outcome.reasons,
      attempts_used: verdict === 'repair_required' ? repairsUsed + 1 : repairsUsed,
    });
    if (verdict === 'accepted') {
      const { digest } = putMaterial(db, 'node_output', JSON.stringify(items));
      appendEventInTx(db, runId, 'node.completed', {
        node_id: nodeId,
        output_digest: digest,
        items_count: items.length,
        revision_digest: revision.digest,
      });
    }
    if (verdict === 'repair_required') {
      appendEventInTx(db, runId, 'repair.requested', {
        node_id: nodeId,
        target: params.repair_target ?? inbound[0],
        attempt: repairsUsed + 1,
        reasons: outcome.reasons,
      });
    }
  }).immediate();
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
    if (runnable.kind === 'scripted') {
      executeNode(db, runId, graph, runnable.nodeId, fold);
    } else if (runnable.kind === 'gate' || runnable.kind === 'operator-reject') {
      if (runnable.kind === 'operator-reject') {
        db.transaction(() => {
          appendEventInTx(db, runId, 'node.failed', {
            node_id: runnable.nodeId,
            error: 'operator rejected at the human gate',
          });
        }).immediate();
      } else {
        executeGate(db, runId, graph, runnable.nodeId, fold);
      }
    } else {
      const policy = activityPolicy(graph.nodes[runnable.nodeId].parameters ?? {});
      const prior = fold.execs.get(runnable.nodeId)?.attempt ?? 0;
      scheduleExecution(db, runId, runnable.nodeId, prior + 1, policy);
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
 *  to completion, budget, or the first typed wait. */
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
 *  never committed) is re-driven until terminal, budget, or typed wait. */
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

/** Worker-side input read: the ACCUMULATED desk of each upstream node (all
 *  completed materials, event order) — exact digests, never 'latest' (ADR-053). */
export function readActivityInputs(
  db: Database.Database,
  runId: string,
  graphJson: string,
  nodeId: string
): Item[] {
  const graph = parseGraph(graphJson);
  const desks = new Map<string, string[]>();
  for (const event of getEvents(db, runId)) {
    if (event.type !== 'node.completed') continue;
    const payload = JSON.parse(event.payload_json) as { node_id: string; output_digest: string };
    const desk = desks.get(payload.node_id) ?? [];
    if (!desk.includes(payload.output_digest)) desk.push(payload.output_digest);
    desks.set(payload.node_id, desk);
  }
  return graph.inbound[nodeId].flatMap((upstream) => {
    const digests = desks.get(upstream);
    if (!digests?.length) {
      throw new Error(`ACTIVITY_INPUT_MISSING: upstream '${upstream}' of '${nodeId}' has no completed material`);
    }
    return digests.flatMap((digest) => JSON.parse(requireMaterial(db, digest).content) as Item[]);
  });
}
