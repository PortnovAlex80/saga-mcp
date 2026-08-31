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
  deskMembers,
  evaluateDesk,
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
  /** Узел-гейт, потребовавший доработку, либо OPERATOR_RETRY. */
  gate: string;
  seq: number;
  attempt: number;
}

/** Псевдо-«гейт» для операторского повтора: доработку запросил человек. */
export const OPERATOR_RETRY = '@operator';

interface OperatorAction {
  decision: 'approve' | 'reject';
  seq: number;
}

interface SpawnedChild {
  id: string;
  item: Item;
}

interface Fold {
  nodes: Map<string, NodeFold>;
  execs: Map<string, ExecFold>;
  gates: Map<string, GateFold>;
  openRepairs: Map<string, OpenRepair>;
  operator: Map<string, OperatorAction>;
  /** Dynamic fan-out: parent split → spawned children (topology from the log). */
  spawned: Map<string, SpawnedChild[]>;
}

type Payload = Record<string, unknown>;

function foldRun(db: Database.Database, runId: string): Fold {
  const fold: Fold = {
    nodes: new Map(),
    execs: new Map(),
    gates: new Map(),
    openRepairs: new Map(),
    operator: new Map(),
    spawned: new Map(),
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
      case 'material.superseded': {
        // Material that failed an ADMISSION criterion leaves the desk with a
        // durable reason, so the repair judges only what remains (gate.ts).
        for (const member of (payload.members ?? []) as Array<{ node: string; digest: string }>) {
          const n = nodeOf(member.node);
          n.desk = n.desk.filter((digest) => digest !== member.digest);
        }
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
      case 'operator.retry_requested': {
        // «Мир изменился — попробуй снова». Исчерпанный бюджет ретраев — это
        // утверждение о ВОРКЕРЕ, а не о мире: сеть пропала, диск был занят,
        // провайдер лежал. Оператор снимает отказ явным событием, и узел
        // снова становится исполнимым — с новым бюджетом попыток.
        const target = String(payload.node_id);
        const n = nodeOf(target);
        n.status = undefined;
        n.lastSeq = event.seq;
        fold.openRepairs.set(target, { gate: OPERATOR_RETRY, seq: event.seq, attempt: 0 });
        break;
      }
      case 'nodes.spawned': {
        const children = (payload.children ?? []) as Array<{ id: string; item: Item }>;
        fold.spawned.set(String(payload.parent), children.map((c) => ({ id: c.id, item: c.item })));
        break;
      }
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

/** Runtime node view: static graph + children spawned by splits (from the
 *  event log). This is the run's EFFECTIVE topology — dynamic fan-out is
 *  data in the log, not a graph mutation. */
interface EffectiveNode {
  nodeId: string;
  type: string;
  parameters: Record<string, unknown>;
  inbound: string[];
  /** join nodes: the split parent whose children gate this node. */
  joinParent?: string;
}

function effectiveNodes(graph: ParsedGraph, fold: Fold): Map<string, EffectiveNode> {
  const result = new Map<string, EffectiveNode>();
  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    result.set(nodeId, {
      nodeId,
      type: node.type,
      parameters: (node.parameters ?? {}) as Record<string, unknown>,
      inbound: graph.inbound[nodeId],
    });
  }
  for (const [parent, children] of fold.spawned) {
    const splitDef = graph.nodes[parent];
    const childDef = ((splitDef?.parameters ?? {}) as { child?: { type?: string; parameters?: Record<string, unknown> } }).child;
    if (!childDef?.type) continue;
    for (const child of children) {
      result.set(child.id, {
        nodeId: child.id,
        type: childDef.type,
        parameters: childDef.parameters ?? {},
        inbound: [parent],
      });
    }
    // join's effective inbound = the spawned children (it waits for THEM)
    for (const nodeId of graph.order) {
      if (graph.inbound[nodeId].includes(parent) && getNodeType(graph.nodes[nodeId].type).joiner) {
        const entry = result.get(nodeId);
        if (entry) entry.joinParent = parent;
      }
    }
  }
  return result;
}

function splitChildrenCompleted(fold: Fold, parent: string): boolean {
  const children = fold.spawned.get(parent);
  if (!children || children.length === 0) return false;
  return children.every((child) => fold.nodes.get(child.id)?.status === 'completed');
}

function findRunnable(graph: ParsedGraph, fold: Fold): { nodeId: string; kind: RunnableKind } | undefined {
  const effective = effectiveNodes(graph, fold);
  for (const name of graph.order) {
    const nodeFold = fold.nodes.get(name);
    if (nodeFold?.status === 'failed') continue;
    const def = effective.get(name);
    if (!def) continue;
    const type = getNodeType(def.type);

    if (type.joiner) {
      if (nodeFold?.status) continue; // already settled (completed/failed)
      const parent = def.joinParent;
      if (!parent || !splitChildrenCompleted(fold, parent)) continue;
      if (!graph.inbound[name].every((upstream) => fold.nodes.get(upstream)?.status === 'completed')) continue;
      return { nodeId: name, kind: 'scripted' };
    }

    if (!def.inbound.every((upstream) => fold.nodes.get(upstream)?.status === 'completed')) {
      continue;
    }
    if (type.gate) {
      const gate = fold.gates.get(name);
      if (!gate) return { nodeId: name, kind: 'gate' };
      if (gate.verdict === 'accepted') continue; // node.completed exists
      const operator = fold.operator.get(name);
      const params = graph.nodes[name].parameters as Partial<GateParameters>;
      const target = params.repair_target ?? graph.inbound[name][0];
      const targetFold = fold.nodes.get(target);
      if (gate.verdict === 'human_required') {
        if (operator && operator.seq > gate.decisionSeq) {
          return { nodeId: name, kind: operator.decision === 'reject' ? 'operator-reject' : 'gate' };
        }
        // The operator may answer a human gate by REPAIRING the material
        // instead of deciding: new material on the repair target is judged by
        // the same criteria, no budget spent (the budget is already exhausted).
        if (targetFold?.lastSeq !== undefined && targetFold.lastSeq > gate.decisionSeq) {
          return { nodeId: name, kind: 'gate' };
        }
        continue; // typed human wait
      }
      // repair_required: re-check once the repair target produced new material
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

  // spawned children: schedule as activities once their split completed
  for (const [parent, children] of fold.spawned) {
    if (fold.nodes.get(parent)?.status !== 'completed') continue;
    const splitDef = graph.nodes[parent];
    const childDef = ((splitDef?.parameters ?? {}) as { child?: { type?: string } }).child;
    if (!childDef?.type) continue;
    const childType = getNodeType(childDef.type);
    for (const child of children) {
      const childFold = fold.nodes.get(child.id);
      if (childFold?.status) continue; // settled (completed or failed)
      if (childType.activity) {
        const exec = fold.execs.get(child.id);
        if (!exec) return { nodeId: child.id, kind: 'activity' };
        continue; // in flight or awaiting sweep decision
      }
      return { nodeId: child.id, kind: 'scripted' };
    }
  }
  return undefined;
}

/** success → every node completed; error → the rest is stranded downstream of
 *  failures; waiting → an activity is in flight, a repair cycle is spinning,
 *  or a gate waits for the operator. Spawned children count as nodes: a
 *  failed child strands the join (its effective inbound). */
function analyzeTerminal(graph: ParsedGraph, fold: Fold): 'success' | 'error' | 'waiting' {
  const effective = effectiveNodes(graph, fold);
  const failed = new Set<string>();
  let allCompleted = true;
  for (const name of effective.keys()) {
    const nodeFold = fold.nodes.get(name);
    if (!nodeFold?.status) {
      allCompleted = false;
    } else if (nodeFold.status === 'failed') {
      allCompleted = false;
      failed.add(name);
    }
  }
  // join nodes are complete only when all spawned siblings completed
  for (const name of effective.keys()) {
    const entry = effective.get(name);
    if (entry?.joinParent && !splitChildrenCompleted(fold, entry.joinParent)) allCompleted = false;
  }
  if (allCompleted) return 'success';

  const inboundOf = (name: string): string[] => {
    const def = effective.get(name);
    if (def?.joinParent) return (fold.spawned.get(def.joinParent) ?? []).map((c) => c.id);
    return def?.inbound ?? [];
  };

  const stranded = new Set<string>();
  const stack = [...failed];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of effective.keys()) {
      if (!stranded.has(name) && inboundOf(name).includes(current)) {
        stranded.add(name);
        stack.push(name);
      }
    }
  }
  for (const name of effective.keys()) {
    const entry = effective.get(name)!;
    if (entry.joinParent && !splitChildrenCompleted(fold, entry.joinParent) && !stranded.has(name)) {
      // join waiting on unfinished children: waiting unless a child failed
      const children = fold.spawned.get(entry.joinParent) ?? [];
      if (children.some((c) => fold.nodes.get(c.id)?.status === 'failed')) continue;
      return 'waiting';
    }
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
 *  transaction; failures are re-logged honestly. Works for static nodes AND
 *  spawned children / join (effective defs). */
function executeNode(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold,
  effective?: Map<string, EffectiveNode>
): void {
  const def = effective?.get(nodeId);
  const nodeType = def?.type ?? graph.nodes[nodeId]?.type;
  const parameters = def?.parameters ?? (graph.nodes[nodeId]?.parameters ?? {}) as Record<string, unknown>;
  // join reads the spawned children's desks, not the split's own output
  const upstream = def?.joinParent
    ? (fold.spawned.get(def.joinParent) ?? []).map((c) => c.id)
    : (def?.inbound ?? graph.inbound[nodeId] ?? []);
  const inputDigests = upstream.flatMap((name) => fold.nodes.get(name)?.desk ?? []);
  try {
    db.transaction(() => {
      appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
      appendEventInTx(db, runId, 'node.started', { node_id: nodeId, input_digests: inputDigests });
      const inputs = upstream.flatMap((name) => readDeskItems(db, fold.nodes.get(name)?.desk ?? []));
      const outputs = getNodeType(nodeType).execute({
        nodeId,
        parameters,
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

/** Dynamic fan-out: one transaction spawns the COMPLETE child set (the
 *  conveyor model's "materialize and seal the workplace set atomically")
 *  and completes the split with its input items. */
function executeSplit(
  db: Database.Database,
  runId: string,
  graph: ParsedGraph,
  nodeId: string,
  fold: Fold
): void {
  const upstream = graph.inbound[nodeId];
  const items = upstream.flatMap((name) => readDeskItems(db, fold.nodes.get(name)!.desk));
  const childDef = ((graph.nodes[nodeId].parameters ?? {}) as {
    child?: { type: string; parameters?: Record<string, unknown> };
  }).child;
  if (!childDef?.type) {
    throw new Error(`SPLIT_MISCONFIGURED: node '${nodeId}' has no parameters.child`);
  }
  if (items.length === 0) {
    throw new Error('SPLIT_EMPTY: nothing to fan out (upstream desk is empty)');
  }
  db.transaction(() => {
    appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
    appendEventInTx(db, runId, 'node.started', { node_id: nodeId, items_count: items.length });
    const children = items.map((item, index) => ({
      id: `${nodeId}::${index + 1}`,
      item,
    }));
    appendEventInTx(db, runId, 'nodes.spawned', {
      parent: nodeId,
      children: children.map((c) => ({ id: c.id, item: c.item })),
      child_type: childDef.type,
    });
    const { digest } = putMaterial(db, 'node_output', JSON.stringify(items));
    appendEventInTx(db, runId, 'node.completed', {
      node_id: nodeId,
      output_digest: digest,
      items_count: items.length,
    });
  }).immediate();
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

  const desk: RevisionMembers[] = inbound.map((name) => ({
    node: name,
    digests: [...(fold.nodes.get(name)!.desk)],
  }));
  const outcome = evaluateDesk(checks, deskMembers(db, desk));
  const items = outcome.survivors.flatMap((member) => member.items);
  const verdict =
    outcome.verdict === 'accepted'
      ? 'accepted'
      : repairsUsed < maxRepairs
        ? 'repair_required'
        : 'human_required';

  // The sealed revision judges only what survived admission.
  const members: RevisionMembers[] = inbound.map((name) => ({
    node: name,
    digests: outcome.survivors.filter((m) => m.node === name).map((m) => m.digest),
  }));
  const manifest = revisionManifest(members);

  db.transaction(() => {
    if (outcome.tainted.length > 0) {
      appendEventInTx(db, runId, 'material.superseded', {
        node_id: nodeId,
        members: outcome.tainted.map((entry) => ({ node: entry.node, digest: entry.digest })),
        reasons: outcome.tainted.map((entry) => entry.reason),
      });
    }
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
    const effective = effectiveNodes(graph, fold);
    const def = effective.get(runnable.nodeId);
    const nodeType = getNodeType(def?.type ?? graph.nodes[runnable.nodeId]?.type ?? 'fail');
    if (nodeType.splitter) {
      executeSplit(db, runId, graph, runnable.nodeId, fold);
    } else if (runnable.kind === 'scripted') {
      executeNode(db, runId, graph, runnable.nodeId, fold, effective);
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
      const policy = activityPolicy(def?.parameters ?? graph.nodes[runnable.nodeId]?.parameters ?? {});
      const prior = fold.execs.get(runnable.nodeId)?.attempt ?? 0;
      // Операторский повтор даёт узлу СВЕЖИЙ бюджет автоматических ретраев:
      // прошлые попытки сгорели на условии, которого больше нет.
      if (fold.openRepairs.get(runnable.nodeId)?.gate === OPERATOR_RETRY) {
        policy.retry = { ...policy.retry, max_attempts: prior + policy.retry.max_attempts };
      }
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

/** Resolves a node's runtime definition: static graph nodes OR children
 *  spawned by a split (their def lives in the parent's parameters.child,
 *  recorded in the nodes.spawned event). */
export function nodeDefinitionFor(
  db: Database.Database,
  runId: string,
  graphJson: string,
  nodeId: string
): { type: string; parameters: Record<string, unknown> } {
  const graph = parseGraph(graphJson);
  const staticNode = graph.nodes[nodeId];
  if (staticNode) {
    return { type: staticNode.type, parameters: (staticNode.parameters ?? {}) as Record<string, unknown> };
  }
  for (const event of getEvents(db, runId)) {
    if (event.type !== 'nodes.spawned') continue;
    const payload = JSON.parse(event.payload_json) as {
      parent: string;
      children: Array<{ id: string }>;
    };
    if (!payload.children.some((c) => c.id === nodeId)) continue;
    const parentDef = graph.nodes[payload.parent];
    const childDef = ((parentDef?.parameters ?? {}) as {
      child?: { type: string; parameters?: Record<string, unknown> };
    }).child;
    if (childDef) return { type: childDef.type, parameters: childDef.parameters ?? {} };
  }
  throw new Error(`NODE_DEFINITION_NOT_FOUND: ${nodeId}`);
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
 *  completed materials, event order) — exact digests, never 'latest' (ADR-053).
 *  Spawned children receive their OWN item (from nodes.spawned), not a desk. */
export function readActivityInputs(
  db: Database.Database,
  runId: string,
  graphJson: string,
  nodeId: string
): Item[] {
  const graph = parseGraph(graphJson);
  const desks = new Map<string, string[]>();
  for (const event of getEvents(db, runId)) {
    if (event.type === 'node.completed') {
      const payload = JSON.parse(event.payload_json) as { node_id: string; output_digest: string };
      const desk = desks.get(payload.node_id) ?? [];
      if (!desk.includes(payload.output_digest)) desk.push(payload.output_digest);
      desks.set(payload.node_id, desk);
    }
    if (event.type === 'material.superseded') {
      const payload = JSON.parse(event.payload_json) as { members: Array<{ node: string; digest: string }> };
      for (const member of payload.members ?? []) {
        const desk = desks.get(member.node);
        if (desk) desks.set(member.node, desk.filter((digest) => digest !== member.digest));
      }
    }
    if (event.type === 'nodes.spawned') {
      const payload = JSON.parse(event.payload_json) as { children: Array<{ id: string; item: Item }> };
      const mine = payload.children.find((c) => c.id === nodeId);
      if (mine) return [mine.item];
    }
  }
  return graph.inbound[nodeId].flatMap((upstream) => {
    const digests = desks.get(upstream);
    if (!digests?.length) {
      throw new Error(`ACTIVITY_INPUT_MISSING: upstream '${upstream}' of '${nodeId}' has no completed material`);
    }
    return digests.flatMap((digest) => JSON.parse(requireMaterial(db, digest).content) as Item[]);
  });
}
