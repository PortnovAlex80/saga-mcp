import type { Node, Edge } from '@xyflow/react';

// graph_json — the same declarative document the kernel executes
// (src/kernel/graph.ts). position is desk-only metadata; the kernel ignores it.

export type NodeParameters = Record<string, unknown>;

export interface DeskNodeData extends Record<string, unknown> {
  sagaType: string;
  parameters: NodeParameters;
}

export type DeskNode = Node<DeskNodeData, 'saga'>;

export interface GraphDoc {
  nodes: Record<
    string,
    { type: string; parameters?: NodeParameters; position?: [number, number] }
  >;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

export const NODE_TYPES = ['emit', 'template', 'collect', 'fail'] as const;

export function toGraphDoc(nodes: DeskNode[], edges: Edge[]): GraphDoc {
  const doc: GraphDoc = { nodes: {}, connections: {} };
  for (const node of nodes) {
    doc.nodes[node.id] = {
      type: node.data.sagaType,
      parameters: node.data.parameters,
      position: [Math.round(node.position.x), Math.round(node.position.y)],
    };
  }
  for (const edge of edges) {
    const conn = (doc.connections[edge.source] ??= { main: [[]] });
    conn.main[0].push({ node: edge.target });
  }
  return doc;
}

export function fromGraphDoc(doc: GraphDoc): { nodes: DeskNode[]; edges: Edge[] } {
  const nodes: DeskNode[] = [];
  const level = layoutLevels(doc);
  Object.entries(doc.nodes).forEach(([name, spec], index) => {
    const [x, y] = spec.position ?? [80 + (level.get(name) ?? 0) * 260, 80 + index * 120];
    nodes.push({
      id: name,
      type: 'saga',
      position: { x, y },
      data: { sagaType: spec.type, parameters: spec.parameters ?? {} },
    });
  });
  const names = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = [];
  for (const [source, conn] of Object.entries(doc.connections ?? {})) {
    if (!names.has(source)) continue;
    for (const outputs of conn.main ?? []) {
      for (const target of outputs ?? []) {
        if (names.has(target.node)) {
          edges.push({
            id: `${source}->${target.node}`,
            source,
            target: target.node,
            animated: false,
          });
        }
      }
    }
  }
  return { nodes, edges };
}

/** Longest-path layering from roots — deterministic auto-layout for graphs
 *  saved without desk positions. */
function layoutLevels(doc: GraphDoc): Map<string, number> {
  const inbound = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const name of Object.keys(doc.nodes)) {
    inbound.set(name, 0);
    outgoing.set(name, []);
  }
  for (const [source, conn] of Object.entries(doc.connections ?? {})) {
    for (const outputs of conn.main ?? []) {
      for (const target of outputs ?? []) {
        if (!inbound.has(target.node) || !inbound.has(source)) continue;
        inbound.set(target.node, (inbound.get(target.node) ?? 0) + 1);
        outgoing.get(source)!.push(target.node);
      }
    }
  }
  const level = new Map<string, number>();
  const queue = [...inbound.entries()].filter(([, n]) => n === 0).map(([name]) => name);
  for (const name of queue) level.set(name, 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(current) ?? 0) + 1));
      inbound.set(next, (inbound.get(next) ?? 1) - 1);
      if ((inbound.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  return level;
}

export const DEMO_GRAPH: GraphDoc = {
  nodes: {
    source: {
      type: 'emit',
      parameters: { items: [{ json: { who: 'saga5' } }, { json: { who: 'desk' } }] },
      position: [80, 160],
    },
    greet: { type: 'template', parameters: { template: 'hello {{who}}' }, position: [380, 160] },
    bundle: { type: 'collect', parameters: {}, position: [680, 160] },
  },
  connections: {
    source: { main: [[{ node: 'greet' }]] },
    greet: { main: [[{ node: 'bundle' }]] },
  },
};
