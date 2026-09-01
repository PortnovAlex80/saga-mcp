import type Database from 'better-sqlite3';
import { getEvents } from '../events.js';
import { parseGraph, type ParsedGraph } from './graph.js';
import type { Item } from './node-types.js';

// The ONE read model. Kanban and the artifact wiki are both folds of the same
// append-only log — no new tables, no second authority (SAGA5-REBUILD-PLAN §2.5).
//
// saga4's disease was two channels: a Kanban state machine AND a loop state
// machine, kept in sync by mapping rules. Here a card cannot be dragged into
// `done`, because `done` is DERIVED. The only board write an operator has is a
// decision at a human gate — and that is an ordinary kernel event.

/** Board columns, the upstream board vocabulary, derived from the log. */
export type CardStatus = 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'failed';

export const CARD_STATUSES: CardStatus[] = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'failed',
];

export interface NodeProjection {
  node_id: string;
  type: string;
  parameters: Record<string, unknown>;
  /** Set for children spawned by a split — dynamic fan-out cards. */
  parent?: string;
  title: string;
  status: CardStatus;
  /** Accumulated, non-superseded output digests, event order. */
  desk: string[];
  verdict?: 'accepted' | 'repair_required' | 'human_required';
  reasons: string[];
  /** Сколько рабочих нанято на это место — падения и круги доработки вместе. */
  attempts: number;
  /** Repair rounds this gate has spent. */
  repairs: number;
  effect_outcome?: string;
  /** Gate node this card is waiting on (human_required), for the operator UI. */
  gate?: string;
  /** true — исполнение уже назначено и ждёт свободного воркера. */
  queued: boolean;
  /** Ближайший отказавший узел выше по маршруту. Пока он не починен, эта
   *  работа не поедет — и это НЕ «очередь». */
  blocked_by?: string;
  last_seq: number;
  last_ts: string;
}

export interface RunProjection {
  run_id: string;
  workflow_id: string;
  workflow: string;
  graph_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** Digests a gate has accepted as part of a sealed revision. */
  accepted_digests: Set<string>;
  nodes: NodeProjection[];
}

interface RunRowLite {
  id: string;
  workflow_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  name: string;
  graph_json: string;
}

function runRow(db: Database.Database, runId: string): RunRowLite {
  const row = db
    .prepare(
      `SELECT r.id, r.workflow_id, r.status, r.created_at, r.updated_at, w.name, w.graph_json
         FROM runs r JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`
    )
    .get(runId) as RunRowLite | undefined;
  if (!row) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  return row;
}

/** The declarative graph a run was pinned to. */
export function runGraphJson(db: Database.Database, runId: string): string {
  return runRow(db, runId).graph_json;
}

function titleOf(nodeId: string, type: string, parameters: Record<string, unknown>): string {
  const declared = parameters.title;
  if (typeof declared === 'string' && declared.trim()) return declared;
  return `${nodeId} · ${type}`;
}

function itemTitle(item: Item | undefined, fallback: string): string {
  const json = item?.json ?? {};
  for (const key of ['title', 'name', 'id', 'path']) {
    const value = json[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

/** Folds one run's event log into per-node cards. Mirrors the kernel's own
 *  fold (runner.ts) — painting only, never a decision. */
export function projectRun(db: Database.Database, runId: string): RunProjection {
  const row = runRow(db, runId);
  const graph = parseGraph(row.graph_json);
  const nodes = new Map<string, NodeProjection>();
  const accepted = new Set<string>();
  const revisions = new Map<string, string[]>();

  const ensure = (
    nodeId: string,
    type: string,
    parameters: Record<string, unknown>,
    parent?: string
  ): NodeProjection => {
    let node = nodes.get(nodeId);
    if (!node) {
      node = {
        node_id: nodeId,
        type,
        parameters,
        parent,
        title: titleOf(nodeId, type, parameters),
        status: 'todo',
        desk: [],
        reasons: [],
        attempts: 0,
        repairs: 0,
        queued: false,
        last_seq: 0,
        last_ts: row.created_at,
      };
      nodes.set(nodeId, node);
    }
    return node;
  };

  for (const nodeId of graph.order) {
    const def = graph.nodes[nodeId];
    ensure(nodeId, def.type, (def.parameters ?? {}) as Record<string, unknown>);
  }

  for (const event of getEvents(db, runId)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const nodeId = typeof payload.node_id === 'string' ? payload.node_id : '';
    const known = nodeId ? nodes.get(nodeId) : undefined;
    const touch = (node: NodeProjection | undefined): NodeProjection | undefined => {
      if (node) {
        node.last_seq = event.seq;
        node.last_ts = event.ts;
      }
      return node;
    };

    switch (event.type) {
      case 'nodes.spawned': {
        const parent = String(payload.parent);
        const childType = String(payload.child_type ?? 'llm');
        const parentDef = graph.nodes[parent];
        const childParams =
          ((parentDef?.parameters ?? {}) as { child?: { parameters?: Record<string, unknown> } })
            .child?.parameters ?? {};
        const children = (payload.children ?? []) as Array<{ id: string; item: Item }>;
        for (const child of children) {
          const node = ensure(child.id, childType, childParams, parent);
          node.title = itemTitle(child.item, child.id);
          touch(node);
        }
        break;
      }
      case 'node.scheduled':
      case 'execution.scheduled': {
        const node = touch(known);
        if (node && node.status !== 'in_progress') node.status = 'todo';
        if (node && event.type === 'execution.scheduled') {
          node.attempts += 1;
          node.queued = true; // ждёт свободного воркера — вот это очередь
        }
        break;
      }
      case 'node.started':
      case 'execution.started': {
        const node = touch(known);
        if (node) {
          node.status = 'in_progress';
          node.queued = false;
        }
        break;
      }
      case 'node.completed': {
        const node = touch(known);
        if (node) {
          const digest = String(payload.output_digest);
          if (!node.desk.includes(digest)) node.desk.push(digest);
          node.status = 'done';
          node.queued = false;
          // New material answers the previous rejection: the old gate reasons
          // described material that is no longer the newest word on this desk.
          node.reasons = [];
          node.gate = undefined;
          // A gate that completes carries the revision it accepted: its own
          // pass-through material is accepted material too.
          if (payload.revision_digest !== undefined) accepted.add(digest);
        }
        break;
      }
      case 'node.failed': {
        const node = touch(known);
        if (node) {
          node.status = 'failed';
          node.queued = false;
          if (typeof payload.error === 'string') node.reasons = [payload.error];
        }
        break;
      }
      case 'execution.failed':
      case 'execution.timed_out': {
        // Back in the queue: the sweep — not the worker — decides retry vs fail.
        const node = touch(known);
        if (node && node.status !== 'done') node.status = 'todo';
        break;
      }
      case 'material.superseded': {
        const members = (payload.members ?? []) as Array<{ node: string; digest: string }>;
        for (const member of members) {
          const node = nodes.get(member.node);
          if (node) node.desk = node.desk.filter((digest) => digest !== member.digest);
        }
        break;
      }
      case 'revision.sealed': {
        const members = (payload.members ?? []) as Array<{ node: string; digests: string[] }>;
        revisions.set(
          String(payload.revision_digest),
          members.flatMap((member) => member.digests)
        );
        break;
      }
      case 'gate.decided': {
        const node = touch(known);
        const verdict = String(payload.verdict) as NodeProjection['verdict'];
        if (node) {
          node.verdict = verdict;
          node.reasons = Array.isArray(payload.reasons) ? (payload.reasons as string[]) : [];
          node.repairs = Number(payload.attempts_used ?? node.repairs);
          if (verdict === 'repair_required') node.status = 'review';
          if (verdict === 'human_required') node.status = 'blocked';
        }
        if (verdict === 'accepted') {
          for (const digest of revisions.get(String(payload.revision_digest)) ?? []) {
            accepted.add(digest);
          }
        }
        break;
      }
      case 'repair.requested': {
        const target = touch(nodes.get(String(payload.target)));
        if (target) {
          target.status = 'review';
          target.gate = nodeId;
          target.reasons = Array.isArray(payload.reasons) ? (payload.reasons as string[]) : [];
        }
        break;
      }
      case 'operator.resolved': {
        const node = touch(known);
        if (node) node.status = payload.decision === 'reject' ? 'failed' : 'in_progress';
        break;
      }
      case 'effect.receipted': {
        const node = touch(known);
        if (node) node.effect_outcome = String(payload.outcome);
        break;
      }
    }
  }

  markStranded(graph, nodes);

  return {
    run_id: row.id,
    workflow_id: row.workflow_id,
    workflow: row.name,
    graph_json: row.graph_json,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    accepted_digests: accepted,
    nodes: [...nodes.values()],
  };
}

/** Работа ниже отказа — это не «очередь», а обрыв конвейера.
 *
 *  Оператор, глядящий на доску, обязан различать «ещё не дошли» и «не поедет,
 *  пока не починишь вот здесь». Поэтому каждой не начатой карточке ниже
 *  отказа проставляется ближайший виновник. */
function markStranded(graph: ParsedGraph, nodes: Map<string, NodeProjection>): void {
  // Эффективная топология: дети веера входят от своего split, а join ждёт
  // ИМЕННО детей, а не сам split.
  const inbound = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parent) {
      inbound.set(node.node_id, [node.parent]);
      continue;
    }
    inbound.set(node.node_id, [...(graph.inbound[node.node_id] ?? [])]);
  }
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (!node.parent) continue;
    childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node.node_id]);
  }
  for (const node of nodes.values()) {
    if (graph.nodes[node.node_id]?.type !== 'join') continue;
    const parent = (graph.inbound[node.node_id] ?? []).find((up) => childrenOf.has(up));
    if (parent) inbound.set(node.node_id, childrenOf.get(parent)!);
  }

  const blame = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.status === 'failed') blame.set(node.node_id, node.node_id);
  }
  // Распространяем вниз, пока есть чему распространяться (граф ацикличен).
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false;
    for (const node of nodes.values()) {
      if (blame.has(node.node_id) || node.status === 'done') continue;
      const culprit = (inbound.get(node.node_id) ?? [])
        .map((up) => blame.get(up))
        .find((found) => found !== undefined);
      if (culprit) {
        blame.set(node.node_id, culprit);
        node.blocked_by = culprit;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

export interface RunSummary {
  run_id: string;
  workflow: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Newest runs, newest first — the board's swimlane list. */
export function recentRuns(db: Database.Database, limit = 20): RunSummary[] {
  return db
    .prepare(
      `SELECT r.id AS run_id, w.name AS workflow, r.status, r.created_at, r.updated_at
         FROM runs r JOIN workflows w ON w.id = r.workflow_id
        ORDER BY r.updated_at DESC, r.rowid DESC LIMIT ?`
    )
    .all(Math.max(1, Math.min(limit, 200))) as RunSummary[];
}
