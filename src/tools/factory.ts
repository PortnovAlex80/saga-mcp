import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { getRun, tailEvents } from '../events.js';
import { runGraph } from '../kernel/runner.js';
import { completeHumanTask, resolveHumanGate } from '../operator.js';
import { DEFAULT_WORKSHOPS, startDiscovery, startFormalization } from '../workshops.js';
import type { ToolHandler } from '../types.js';

// M0 kernel surface: read-only observation of runs and the event log.
// The interpreting kernel (graph execution) arrives in M1; until then these
// tools make the kernel tables visible and testable through MCP.

interface RunSummary {
  id: string;
  workflow_id: string;
  status: string;
  wait_till: string | null;
  next_seq: number;
  created_at: string;
  updated_at: string;
}

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
    name: 'discovery_start',
    description: 'Default Discovery Desk: accepts an idea, runs the brief skill (Discovery workshop), publishes the brief artifact to discovery/brief.md in the product repo.',
    annotations: { title: 'Discovery Start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        idea: { type: 'string', description: 'The raw idea written into the start node' },
        repo: { type: 'string', description: 'Product repo path (default: SAGA_PRODUCT_REPO or ../saga5-canary/product-repo)' },
        mode: { type: 'string', enum: ['opencode', 'echo'], description: 'Worker mode (echo = scripted, for tests)' },
      },
      required: ['idea'],
    },
  },
  {
    name: 'formalization_start',
    description: 'Formalization Desk: takes the accepted discovery brief (default: latest discovery/brief.md from the product repo), runs the SRS skill, publishes formalization/srs.md.',
    annotations: { title: 'Formalization Start', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'Approved brief text (default: latest discovery/brief.md)' },
        repo: { type: 'string', description: 'Product repo path' },
        mode: { type: 'string', enum: ['opencode', 'echo'], description: 'Worker mode (echo = scripted, for tests)' },
      },
    },
  },
  {
    name: 'workshops_list',
    description: 'List default workshops (declarative desk graphs) and their shapes.',
    annotations: { title: 'Workshops', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
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
  factory_status: () => {
    const db = getDb();
    const runsByStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY count DESC')
      .all() as Array<{ status: string; count: number }>;
    const executionsByStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM executions GROUP BY status ORDER BY count DESC')
      .all() as Array<{ status: string; count: number }>;
    const recentRuns = db
      .prepare(`SELECT id, workflow_id, root_run_id, status, wait_till, next_seq, created_at, updated_at
                FROM runs ORDER BY updated_at DESC LIMIT 20`)
      .all() as RunSummary[];
    const pendingTimers = (
      db.prepare('SELECT COUNT(*) AS count FROM timers WHERE fired_at IS NULL AND due_at <= datetime(\'now\')')
        .get() as { count: number }
    ).count;
    const materialCount = (
      db.prepare('SELECT COUNT(*) AS count FROM materials').get() as { count: number }
    ).count;
    return {
      runs_by_status: runsByStatus,
      executions_by_status: executionsByStatus,
      recent_runs: recentRuns,
      timers_due: pendingTimers,
      materials_stored: materialCount,
    };
  },

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

  discovery_start: (args) => {
    const db = getDb();
    return startDiscovery(db, {
      idea: String(args.idea ?? ''),
      repo: args.repo === undefined ? undefined : String(args.repo),
      mode: args.mode === undefined ? undefined : (String(args.mode) as 'echo' | 'opencode'),
    });
  },

  formalization_start: (args) => {
    const db = getDb();
    return startFormalization(db, {
      brief: args.brief === undefined ? undefined : String(args.brief),
      repo: args.repo === undefined ? undefined : String(args.repo),
      mode: args.mode === undefined ? undefined : (String(args.mode) as 'echo' | 'opencode'),
    });
  },

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
      Object.entries(DEFAULT_WORKSHOPS).map(([name, w]) => [name, { title: w.title, shape: shape(w.graph) }])
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
