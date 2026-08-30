import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { getRun, tailEvents } from '../events.js';
import { artifactBody, artifactIndex, runArtifacts } from '../kernel/artifacts.js';
import { board, operatorQueue } from '../kernel/board.js';
import { runGraph } from '../kernel/runner.js';
import { kernelStats } from '../kernel/stats.js';
import { completeHumanTask, resolveHumanGate, submitOperatorMaterial } from '../operator.js';
import { DEFAULT_WORKSHOPS, startWorkshop } from '../workshops.js';
import type { Item } from '../kernel/node-types.js';
import type { ToolHandler } from '../types.js';

// The kernel's MCP surface: ONE start path (`workshop_start`), read models
// (board, artifacts, events) and the two operator writes (a decision at a
// human gate, hand-authored material). A new workshop adds a graph — never a
// tool, an endpoint or a UI branch.

export const definitions: Tool[] = [
  {
    name: 'factory_status',
    description: 'Overview of kernel runs: counts by status, recent runs, executions, pending timers.',
    annotations: { title: 'Factory Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'factory_start',
    description: 'Register a declarative workflow graph and run it to completion on the kernel (M1: scripted node types only).',
    annotations: { title: 'Factory Start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (dedup: same name + same graph bytes reuse the workflow row)' },
        graph_json: {
          type: 'string',
          description: 'Declarative graph: {nodes: {name: {type, parameters}}, connections: {name: {main: [[{node}]]}}}',
        },
      },
      required: ['graph_json'],
    },
  },
  {
    name: 'operator_resolve',
    description: 'Operator decision at a human gate: approve re-runs the gate, reject fails its node.',
    annotations: { title: 'Operator Resolve', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id' },
        node: { type: 'string', description: 'Gate node id' },
        decision: { type: 'string', enum: ['approve', 'reject'], description: 'Operator decision' },
        note: { type: 'string', description: 'Optional decision note' },
      },
      required: ['run_id', 'node', 'decision'],
    },
  },
  {
    name: 'workshop_start',
    description: 'THE start path: run a declared workshop (discovery | formalization | product | development). Inputs are declared per workshop (see workshops_list); missing upstream material is taken from the accepted artifact of the previous workshop.',
    annotations: { title: 'Workshop Start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        workshop: { type: 'string', description: 'Workshop name (workshops_list)' },
        input: {
          type: 'object',
          description: 'Declared inputs, e.g. {"idea": "..."} — plus optional repo / mode / tasks',
        },
      },
      required: ['workshop'],
    },
  },
  {
    name: 'workshops_list',
    description: 'List default workshops (declarative desk graphs), their declared inputs and their shapes.',
    annotations: { title: 'Workshops', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_view',
    description: 'Kanban board: every node of the recent runs as a card in the columns todo | in_progress | review | blocked | done | failed. A pure projection of the event log — cards cannot be moved, only produced.',
    annotations: { title: 'Board', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Only this run' },
        runs: { type: 'number', description: 'How many recent runs to fold (default 12)' },
        active_only: { type: 'boolean', description: 'Hide done cards of finished runs' },
        blocked_only: { type: 'boolean', description: 'Only cards waiting for an operator decision' },
      },
    },
  },
  {
    name: 'artifact_list',
    description: 'The artifact wiki: every material produced by the recent runs (or one run), with its repo path, digest and acceptance state.',
    annotations: { title: 'Artifacts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Only this run' },
        path: { type: 'string', description: 'Only artifacts published at this repo path' },
        accepted_only: { type: 'boolean', description: 'Only material a gate accepted' },
        runs: { type: 'number', description: 'How many recent runs to fold (default 12)' },
      },
    },
  },
  {
    name: 'artifact_read',
    description: 'Full body of one artifact (run + node + material digest + item index).',
    annotations: { title: 'Artifact Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        node: { type: 'string', description: 'Node whose desk holds the material' },
        digest: { type: 'string', description: 'Material digest (a prefix is enough)' },
        index: { type: 'number', description: 'Item index inside the material (default 0)' },
      },
      required: ['run_id', 'node', 'digest'],
    },
  },
  {
    name: 'artifact_submit',
    description: 'Operator-authored material for one node: the edited artifact lands on the node desk exactly like a worker submission, the gate re-decides, downstream follows. Provenance is recorded as author=operator.',
    annotations: { title: 'Artifact Submit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        node: { type: 'string', description: 'Node whose desk receives the material' },
        text: { type: 'string', description: 'Edited body — shorthand for items [{json:{text}}]' },
        items: { type: 'array', description: 'Full item array, when the shape is not plain text', items: { type: 'object' } },
        note: { type: 'string', description: 'Why the operator wrote this material' },
      },
      required: ['run_id', 'node'],
    },
  },
  {
    name: 'event_tail',
    description: 'Last events of a run, oldest first (the append-only event log is the kernel authority).',
    annotations: { title: 'Event Tail', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id' },
        limit: { type: 'number', description: 'Max events to return (default 50, max 500)' },
      },
      required: ['run_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  factory_status: () => kernelStats(getDb()),

  factory_start: (args) => {
    const db = getDb();
    const graphJson = String(args.graph_json ?? '');
    if (!graphJson) {
      throw new Error('GRAPH_INVALID: graph_json is required');
    }
    return runGraph(db, graphJson, { name: args.name === undefined ? undefined : String(args.name) });
  },

  operator_resolve: (args) => {
    const db = getDb();
    const runId = String(args.run_id ?? '');
    const node = String(args.node ?? '');
    const decision = args.decision === 'reject' ? 'reject' : 'approve';
    if (!runId || !node) throw new Error('run_id and node are required');
    const event = resolveHumanGate(db, runId, node, decision, args.note ? String(args.note) : undefined);
    getRun(db, runId);
    completeHumanTask(db, runId, node, decision);
    return event;
  },

  workshop_start: (args) =>
    startWorkshop(
      getDb(),
      String(args.workshop ?? ''),
      (args.input as Record<string, unknown>) ?? {}
    ),

  workshops_list: () => {
    const shape = (graph: unknown) => {
      const doc = graph as { nodes: Record<string, { type: string }>; connections: Record<string, { main: Array<Array<{ node: string }>> }> };
      return Object.keys(doc.nodes).map((name) => ({
        node: name,
        type: doc.nodes[name].type,
        next: (doc.connections[name]?.main?.[0] ?? []).map((t) => t.node),
      }));
    };
    return Object.fromEntries(
      Object.entries(DEFAULT_WORKSHOPS).map(([name, w]) => [
        name,
        { title: w.title, inputs: w.inputs, shape: shape(w.graph) },
      ])
    );
  },

  board_view: (args) => {
    const db = getDb();
    if (args.blocked_only) return { queue: operatorQueue(db, Number(args.runs ?? 50) || 50) };
    return board(db, {
      run_id: args.run_id === undefined ? undefined : String(args.run_id),
      runs: args.runs === undefined ? undefined : Number(args.runs),
      active_only: Boolean(args.active_only),
    });
  },

  artifact_list: (args) => {
    const db = getDb();
    if (args.run_id) return runArtifacts(db, String(args.run_id));
    return artifactIndex(db, {
      runs: args.runs === undefined ? undefined : Number(args.runs),
      path: args.path === undefined ? undefined : String(args.path),
      accepted_only: Boolean(args.accepted_only),
    });
  },

  artifact_read: (args) =>
    artifactBody(
      getDb(),
      String(args.run_id ?? ''),
      String(args.node ?? ''),
      String(args.digest ?? ''),
      Number(args.index ?? 0) || 0
    ),

  artifact_submit: (args) => {
    const items: Item[] = Array.isArray(args.items)
      ? (args.items as Item[])
      : [{ json: { text: String(args.text ?? '') } }];
    return submitOperatorMaterial(
      getDb(),
      String(args.run_id ?? ''),
      String(args.node ?? ''),
      items,
      args.note === undefined ? undefined : String(args.note)
    );
  },

  event_tail: (args) => {
    const runId = String(args.run_id ?? '');
    const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
    const db = getDb();
    const run = getRun(db, runId);
    return { run, events: tailEvents(db, runId, limit) };
  },
};
