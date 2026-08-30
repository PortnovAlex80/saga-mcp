import nodePath from 'node:path';
import type Database from 'better-sqlite3';
import { requireMaterial } from '../materials.js';
import { parseGraph } from './graph.js';
import type { Item } from './node-types.js';
import { projectRun, recentRuns, type NodeProjection, type RunProjection } from './projection.js';

// The mini-wiki read model: every artifact the factory produced, addressable,
// readable and editable — derived from the SAME log as the board.
//
// An artifact is one item on one node's desk. It is never a new authority:
// its identity is the material digest, its provenance is the event log, and
// "accepted" means a gate sealed it into a revision it accepted.

export type ArtifactKind = 'markdown' | 'json' | 'code' | 'text' | 'receipt';

export interface Artifact {
  id: string;
  run_id: string;
  workflow: string;
  node_id: string;
  node_type: string;
  /** Repo path this material is published to, when a downstream effect declares one. */
  path?: string;
  name: string;
  digest: string;
  /** Item index inside the material. */
  index: number;
  /** json field holding the body. */
  field: string;
  kind: ArtifactKind;
  bytes: number;
  accepted: boolean;
  seq: number;
  preview: string;
  /** false for effect receipts and other non-material rows. */
  editable: boolean;
}

const PREVIEW_CHARS = 240;

/** Repo paths compare case- and separator-insensitively (Windows hosts). */
function normalizeRepo(repo: string): string {
  return nodePath.resolve(repo).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function classify(path: string | undefined, body: string): ArtifactKind {
  if (path) {
    if (/\.md$/i.test(path)) return 'markdown';
    if (/\.json$/i.test(path)) return 'json';
    if (/\.(m?js|ts|tsx|css|html?|py|sh)$/i.test(path)) return 'code';
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^#{1,3}\s|^\d\)\s|\n#{1,3}\s/.test(trimmed)) return 'markdown';
  return 'text';
}

function bodyOf(item: Item): { field: string; body: string } {
  for (const field of ['content', 'text']) {
    const value = item.json[field];
    if (typeof value === 'string') return { field, body: value };
  }
  return { field: '', body: JSON.stringify(item.json, null, 2) };
}

function readItems(db: Database.Database, digest: string): Item[] {
  try {
    const parsed = JSON.parse(requireMaterial(db, digest).content) as Item[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface PublishedFile {
  path: string;
  content: string;
  /** Product repository the effect publishes into — artifacts belong to a
   *  product, so material never leaks between products. */
  repo: string;
  /** Effect node that publishes it. */
  effect_node: string;
  /** Nodes whose desk material became this file. */
  source_nodes: string[];
  source_digests: string[];
  field: string;
}

/** Mirrors the worker's `desiredFiles`: what an effect node WOULD write, from
 *  the exact desk material it reads. Lets the wiki show repository artifacts
 *  byte-for-byte without touching the filesystem. */
export function publishedFiles(db: Database.Database, run: RunProjection): PublishedFile[] {
  const graph = parseGraph(run.graph_json);
  const byId = new Map(run.nodes.map((node) => [node.node_id, node]));
  const files: PublishedFile[] = [];

  for (const nodeId of graph.order) {
    const def = graph.nodes[nodeId];
    if (def.type !== 'effect') continue;
    const params = (def.parameters ?? {}) as {
      files?: Array<{ path: string; field?: string }>;
      files_from?: 'items';
      repo?: string;
    };
    const repo = String(params.repo ?? '');
    const upstream = graph.inbound[nodeId] ?? [];
    const sourceDigests = upstream.flatMap((name) => byId.get(name)?.desk ?? []);
    const items = sourceDigests.flatMap((digest) => readItems(db, digest));

    if (params.files_from === 'items') {
      for (const item of items) {
        const filePath = typeof item.json.path === 'string' ? item.json.path : '';
        if (!filePath) continue;
        files.push({
          path: filePath,
          content: String(item.json.content ?? ''),
          repo,
          effect_node: nodeId,
          source_nodes: upstream,
          source_digests: sourceDigests,
          field: 'content',
        });
      }
      continue;
    }
    for (const file of params.files ?? []) {
      const field = file.field ?? 'text';
      files.push({
        path: file.path,
        content: items.map((item) => String(item.json[field] ?? '')).join('\n'),
        repo,
        effect_node: nodeId,
        source_nodes: upstream,
        source_digests: sourceDigests,
        field,
      });
    }
  }
  return files;
}

/** path a node's material ends up at, if a downstream effect declares one.
 *  Gates are transparent hops — an accepted revision keeps the same path. */
function pathsByNode(db: Database.Database, run: RunProjection): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of publishedFiles(db, run)) {
    for (const source of file.source_nodes) {
      if (!result.has(source)) result.set(source, file.path);
    }
  }
  // Gates are transparent: material a gate accepted is published under the
  // same path. Ordinary nodes are NOT — an idea is not the brief it produced,
  // so path attribution stops at the material's own author.
  const graph = parseGraph(run.graph_json);
  for (let hop = 0; hop < 4; hop++) {
    for (const nodeId of graph.order) {
      const filePath = result.get(nodeId);
      if (!filePath || graph.nodes[nodeId]?.type !== 'gate') continue;
      for (const upstream of graph.inbound[nodeId] ?? []) {
        if (!result.has(upstream)) result.set(upstream, filePath);
      }
    }
  }
  return result;
}

function artifactsOfNode(
  db: Database.Database,
  run: RunProjection,
  node: NodeProjection,
  paths: Map<string, string>
): Artifact[] {
  const out: Artifact[] = [];
  node.desk.forEach((digest, deskIndex) => {
    const items = readItems(db, digest);
    // A desk accumulates: several materials may carry the same path. They are
    // revisions of one artifact, numbered in submission order — history, not
    // duplicates (the accepted revision is their union, ADR-053).
    const revision = node.desk.length > 1 ? ` · ревизия ${deskIndex + 1}` : '';
    items.forEach((item, index) => {
      const { field, body } = bodyOf(item);
      const itemPath = typeof item.json.path === 'string' ? item.json.path : paths.get(node.node_id);
      const isReceipt = node.type === 'effect' && typeof item.json.effect_key === 'string';
      out.push({
        id: `${run.run_id}::${node.node_id}::${digest.slice(0, 12)}::${index}`,
        run_id: run.run_id,
        workflow: run.workflow,
        node_id: node.node_id,
        node_type: node.type,
        path: isReceipt ? undefined : itemPath,
        name: isReceipt
          ? `${node.node_id} · receipt ${String(item.json.outcome ?? '')}`
          : `${itemPath ?? node.node_id}${items.length > 1 ? ` #${index + 1}` : ''}${revision}`,
        digest,
        index,
        field,
        kind: isReceipt ? 'receipt' : classify(itemPath, body),
        bytes: Buffer.byteLength(body, 'utf8'),
        accepted: run.accepted_digests.has(digest),
        seq: node.last_seq,
        preview: body.slice(0, PREVIEW_CHARS),
        editable: !isReceipt && field !== '',
      });
    });
  });
  return out;
}

/** Nodes that only pass material through: their desk repeats their upstream's
 *  material under a new digest, so listing them would double every artifact. */
const PASS_THROUGH = new Set(['gate', 'join', 'split']);

/** Every artifact produced by one run, newest node activity first. */
export function runArtifacts(db: Database.Database, runId: string): Artifact[] {
  const run = projectRun(db, runId);
  const paths = pathsByNode(db, run);
  return run.nodes
    .filter((node) => !PASS_THROUGH.has(node.type))
    .flatMap((node) => artifactsOfNode(db, run, node, paths))
    .sort((a, b) => b.seq - a.seq || a.node_id.localeCompare(b.node_id) || a.index - b.index);
}

/** The wiki index across runs: newest first, optionally filtered by path. */
export function artifactIndex(
  db: Database.Database,
  opts: { runs?: number; path?: string; accepted_only?: boolean } = {}
): Artifact[] {
  const out: Artifact[] = [];
  for (const summary of recentRuns(db, opts.runs ?? 12)) {
    let artifacts: Artifact[];
    try {
      artifacts = runArtifacts(db, summary.run_id);
    } catch {
      continue;
    }
    for (const artifact of artifacts) {
      if (opts.path && artifact.path !== opts.path) continue;
      if (opts.accepted_only && !artifact.accepted) continue;
      out.push(artifact);
    }
  }
  return out;
}

export interface ArtifactBody extends Artifact {
  body: string;
  /** All items of the material, so an edit can rewrite exactly one of them. */
  items: Item[];
}

/** Full body of one artifact (run + node + digest + item index). */
export function artifactBody(
  db: Database.Database,
  runId: string,
  nodeId: string,
  digest: string,
  index = 0
): ArtifactBody {
  const run = projectRun(db, runId);
  const node = run.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
  const full = node.desk.find((candidate) => candidate === digest || candidate.startsWith(digest));
  if (!full) throw new Error(`ARTIFACT_NOT_ON_DESK: ${nodeId} / ${digest}`);
  const artifacts = artifactsOfNode(db, run, node, pathsByNode(db, run));
  const artifact = artifacts.find(
    (candidate) => candidate.digest === full && candidate.index === index
  );
  if (!artifact) throw new Error(`ARTIFACT_NOT_FOUND: ${nodeId} / ${digest} #${index}`);
  const items = readItems(db, full);
  const { body } = bodyOf(items[index] ?? { json: {} });
  return { ...artifact, body, items };
}

/** Cross-run lookup: the newest ACCEPTED material published at `path`.
 *  This is how one workshop hands material to the next — by digest through the
 *  content-addressed desk, not by reading a file off disk. */
export function latestPublished(
  db: Database.Database,
  filePath: string,
  opts: { repo?: string; limit?: number } = {}
): { path: string; content: string; run_id: string; node_id: string; digest: string } | undefined {
  const wanted = opts.repo ? normalizeRepo(opts.repo) : undefined;
  for (const summary of recentRuns(db, opts.limit ?? 40)) {
    let run: RunProjection;
    try {
      run = projectRun(db, summary.run_id);
    } catch {
      continue;
    }
    for (const file of publishedFiles(db, run)) {
      if (file.path !== filePath) continue;
      // An artifact belongs to its product: never hand material from one
      // product repository to a run publishing into another.
      if (wanted && normalizeRepo(file.repo) !== wanted) continue;
      const accepted = file.source_digests.filter((digest) => run.accepted_digests.has(digest));
      if (accepted.length === 0) continue;
      if (!file.content.trim()) continue;
      return {
        path: file.path,
        content: file.content,
        run_id: run.run_id,
        node_id: file.source_nodes[0] ?? file.effect_node,
        digest: accepted[accepted.length - 1],
      };
    }
  }
  return undefined;
}
