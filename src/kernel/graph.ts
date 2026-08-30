import { nodeTypeNames } from './node-types.js';

// Declarative workflow graph (n8n shape, reduced to what M1 needs):
//   nodes: name -> { type, typeVersion?, parameters }
//   connections: name -> { main: [[{ node, type?, index? }]] } (adjacency map)
// The kernel interprets this data; workshops are graphs, not engine code.

export interface GraphNode {
  type: string;
  typeVersion?: number;
  parameters?: Record<string, unknown>;
}

export interface GraphConnectionTarget {
  node: string;
  type?: string;
  index?: number;
}

export interface Graph {
  nodes: Record<string, GraphNode>;
  connections: Record<string, { main?: GraphConnectionTarget[][] }>;
}

export interface ParsedGraph {
  /** Node names in declaration order — the deterministic execution order. */
  order: string[];
  nodes: Record<string, GraphNode>;
  /** inbound[node] = upstream node names in connection order. */
  inbound: Record<string, string[]>;
}

export function parseGraph(graphJson: string): ParsedGraph {
  let raw: Graph;
  try {
    raw = JSON.parse(graphJson) as Graph;
  } catch {
    throw new Error('GRAPH_INVALID: graph_json is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') {
    throw new Error('GRAPH_INVALID: missing nodes map');
  }

  const names = Object.keys(raw.nodes);
  if (names.length === 0) {
    throw new Error('GRAPH_INVALID: graph has no nodes');
  }

  const knownTypes = nodeTypeNames();
  for (const name of names) {
    const node = raw.nodes[name];
    if (!node || typeof node.type !== 'string') {
      throw new Error(`GRAPH_INVALID: node '${name}' has no type`);
    }
    if (!knownTypes.has(node.type)) {
      throw new Error(`NODE_TYPE_UNKNOWN: '${node.type}' on node '${name}' (known: ${[...knownTypes].sort().join(', ')})`);
    }
    if (node.type === 'gate') {
      const params = (node.parameters ?? {}) as { repair_target?: string };
      if (params.repair_target && !raw.nodes[params.repair_target]) {
        throw new Error(`GRAPH_REF_INVALID: gate '${name}' repair_target '${params.repair_target}' is not a node`);
      }
    }
  }

  const inbound: Record<string, string[]> = {};
  for (const name of names) inbound[name] = [];

  for (const [from, conn] of Object.entries(raw.connections ?? {})) {
    if (!raw.nodes[from]) {
      throw new Error(`GRAPH_REF_INVALID: connection source '${from}' is not a node`);
    }
    for (const outputs of conn?.main ?? []) {
      for (const target of outputs ?? []) {
        if (!raw.nodes[target.node]) {
          throw new Error(`GRAPH_REF_INVALID: connection '${from}' → '${target.node}' references an unknown node`);
        }
        if ((target.type ?? 'main') !== 'main' || (target.index ?? 0) !== 0) {
          throw new Error(`GRAPH_UNSUPPORTED: '${from}' → '${target.node}': only main output index 0 exists in M1`);
        }
        inbound[target.node].push(from);
      }
    }
  }

  assertAcyclic(names, inbound);
  return { order: names, nodes: raw.nodes, inbound };
}

function assertAcyclic(names: string[], inbound: Record<string, string[]>): void {
  // Kahn's algorithm; M1 graphs are feed-forward, cycles are rejected fail-closed.
  const remainingDeps: Record<string, number> = {};
  for (const name of names) remainingDeps[name] = inbound[name].length;

  const queue = names.filter((n) => remainingDeps[n] === 0);
  let processed = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    processed++;
    for (const name of names) {
      if (inbound[name].includes(current)) {
        remainingDeps[name]--;
        if (remainingDeps[name] === 0) queue.push(name);
      }
    }
  }
  if (processed !== names.length) {
    const stuck = names.filter((n) => remainingDeps[n] > 0);
    throw new Error(`GRAPH_CYCLE: cycle through ${stuck.join(', ')}`);
  }
}
