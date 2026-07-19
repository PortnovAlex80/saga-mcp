// Graph snapshot — build the unified documentation graph for a saga project.
//
// The graph has two kinds of nodes:
//   1. `artifact` nodes — from the saga `artifacts` table (PRD/SRS/UC/AC/...),
//      with full metadata (type, code, status, drift_state, content_hash).
//   2. `doc` nodes — `.md` files found by the scanner that do NOT correspond
//      to any saga artifact. These are "orphan" docs (README, notes, etc.),
//      rendered in grey with a `doc` type badge.
//
// Edges come from three sources:
//   a. `parent_artifact_id` (the artifact tree spine) → link_type 'parent'
//   b. `artifact_traces` (7 link_types: covers, implements, derived_from,
//      depends_on, verified_by, superseded_by, implements_spec)
//   c. `wikilinks` — `[[code]]` or `[text](relative.md)` references parsed
//      out of document bodies → link_type 'links' (best-effort, never throws).
//
// Task targets are flattened to nodes too (type 'task') so that an
// `implements` edge AC → DEV-task renders end-to-end in the same graph.

import { scanMarkdownFiles, toPosix } from './scanner.mjs';
import { resolveProjectRepo, scanRootFor, resolveUnderRoot, withoutAnchor } from './paths.mjs';
import path from 'node:path';

const TASK_NODE_PREFIX = 'task:';
const DOC_NODE_PREFIX = 'doc:';
const ARTIFACT_NODE_PREFIX = 'art:';

/**
 * Build the full graph snapshot for a project.
 *
 * Returns:
 *   {
 *     available: boolean,
 *     reason?: string,            // when available=false
 *     project: { id, name },
 *     repository: { id, scanRoot, integrationBranch, ... },
 *     nodes: GraphNode[],
 *     edges: GraphEdge[],
 *     stats: { artifactCount, docCount, taskCount, edgeCount }
 *   }
 *
 * Never throws on missing repo / empty project — returns available:false.
 */
export function buildGraphSnapshot(db, projectId) {
  const project = db
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(projectId);
  if (!project) {
    return { available: false, reason: 'project-not-found' };
  }

  // Defensive: old DBs may lack the artifacts table.
  const hasArtifacts = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'")
    .get();
  if (!hasArtifacts) {
    return { available: false, reason: 'no-artifacts-table' };
  }

  const binding = resolveProjectRepo(db, projectId);
  if (!binding) {
    // Still return artifacts so the graph renders DB-only (no doc scan).
    return buildArtifactOnlySnapshot(db, project);
  }

  const scanRoot = scanRootFor(binding);
  let docs = [];
  try {
    docs = scanMarkdownFiles(scanRoot, { extraIgnore: ['.worktrees'] });
  } catch {
    docs = []; // unreadable root — degrade gracefully
  }

  // ---- artifact nodes ----
  const artifactRows = db
    .prepare(
      `SELECT a.id, a.epic_id, a.type, a.code, a.title, a.status,
              a.parent_artifact_id, a.path, a.content_hash, a.accepted_hash,
              a.drift_state, a.tags, a.updated_at, e.name AS epic_name
         FROM artifacts a
         JOIN epics e ON e.id = a.epic_id
        WHERE e.project_id = ?
        ORDER BY a.parent_artifact_id NULLS FIRST, a.type, a.code`,
    )
    .all(projectId);

  // Index by artifact_path → artifact node id, so we can match scanned docs
  // to saga artifacts (same .md file = same node, not two).
  const pathToArtifactId = new Map();
  for (const a of artifactRows) {
    if (!a.path) continue;
    const p = withoutAnchor(a.path);
    // Normalize: strip leading `./`, collapse backslashes.
    const norm = toPosix(p).replace(/^\.\//, '');
    pathToArtifactId.set(norm, a.id);
  }

  const nodes = [];
  const artifactById = new Map();
  for (const a of artifactRows) {
    const nodeId = `${ARTIFACT_NODE_PREFIX}${a.id}`;
    artifactById.set(a.id, nodeId);
    const fmPath = a.path ? toPosix(withoutAnchor(a.path)) : null;
    nodes.push({
      id: nodeId,
      kind: 'artifact',
      artifactId: a.id,
      type: a.type,
      code: a.code,
      title: a.title,
      status: a.status,
      path: fmPath,
      driftState: a.drift_state,
      contentHash: a.content_hash,
      epicId: a.epic_id,
      epicName: a.epic_name,
      tags: parseJsonArray(a.tags),
      updatedAt: a.updated_at,
    });
  }

  // ---- doc nodes (only those NOT matched to a saga artifact) ----
  let docCount = 0;
  for (const d of docs) {
    // Try to match this scanned file to an artifact by relative path.
    // Scanner returns POSIX-style relPath relative to scanRoot; artifact paths
    // are relative to localPath. When docs_root is null they coincide.
    const relVsRepo = toPosix(
      binding.docsRoot
        ? path.relative(binding.localPath, d.absPath)
        : path.relative(scanRoot, d.absPath),
    );
    const matched = pathToArtifactId.has(relVsRepo) || pathToArtifactId.has(d.relPath);
    if (matched) continue;
    nodes.push({
      id: `${DOC_NODE_PREFIX}${d.relPath}`,
      kind: 'doc',
      type: 'doc',
      title: d.title,
      path: d.relPath,
      contentHash: d.sha256,
      status: d.frontMatter.status || null,
      frontMatter: d.frontMatter,
      mtime: d.mtime,
    });
    docCount++;
  }

  // ---- edges: parent_artifact_id (spine) ----
  const edges = [];
  const seenEdge = new Set();
  function pushEdge(source, target, linkType, extra = {}) {
    const key = `${source}|${target}|${linkType}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, linkType, ...extra });
  }
  for (const a of artifactRows) {
    if (a.parent_artifact_id && artifactById.has(a.parent_artifact_id)) {
      pushEdge(
        artifactById.get(a.parent_artifact_id),
        artifactById.get(a.id),
        'parent',
      );
    }
  }

  // ---- edges: artifact_traces (shared with buildArtifactOnlySnapshot) ----
  appendTraceEdges(db, artifactRows, artifactById, nodes, pushEdge, () => `${TASK_NODE_PREFIX}`);

  // NOTE: wiki-link extraction ([[code]] / [text](rel.md)) is a follow-up.
  // The artifact-traces + parent_artifact_id edges already capture the
  // structural graph; wikilinks would add soft cross-references that can be
  // noisy. Tracked in plan under "Wiki-link extraction из .md — optional".

  return {
    available: true,
    project: { id: project.id, name: project.name },
    repository: {
      id: binding.id,
      localPath: binding.localPath,
      docsRoot: binding.docsRoot,
      scanRoot,
      integrationBranch: binding.integrationBranch,
      defaultBranch: binding.defaultBranch,
    },
    nodes,
    edges,
    stats: {
      artifactCount: artifactRows.length,
      docCount,
      taskCount: nodes.filter(n => n.kind === 'task').length,
      edgeCount: edges.length,
    },
  };
}

/**
 * Fall-back when a project has no repository binding (DB-only view).
 * Renders the artifact + traces graph but skips the doc scan.
 */
function buildArtifactOnlySnapshot(db, project) {
  // Re-enter buildGraphSnapshot's inner pipeline via a null repo: simpler to
  // build a minimal shape than to thread nulls through the main builder.
  const artifactRows = db
    .prepare(
      `SELECT a.id, a.epic_id, a.type, a.code, a.title, a.status,
              a.parent_artifact_id, a.path, a.content_hash, a.accepted_hash,
              a.drift_state, a.tags, a.updated_at, e.name AS epic_name
         FROM artifacts a JOIN epics e ON e.id = a.epic_id
        WHERE e.project_id = ?
        ORDER BY a.parent_artifact_id NULLS FIRST, a.type, a.code`,
    )
    .all(project.id);

  const nodes = [];
  const artifactById = new Map();
  for (const a of artifactRows) {
    const nodeId = `${ARTIFACT_NODE_PREFIX}${a.id}`;
    artifactById.set(a.id, nodeId);
    nodes.push({
      id: nodeId,
      kind: 'artifact',
      artifactId: a.id,
      type: a.type,
      code: a.code,
      title: a.title,
      status: a.status,
      path: a.path ? toPosix(withoutAnchor(a.path)) : null,
      driftState: a.drift_state,
      contentHash: a.content_hash,
      epicId: a.epic_id,
      epicName: a.epic_name,
      tags: parseJsonArray(a.tags),
      updatedAt: a.updated_at,
    });
  }

  const edges = [];
  const seen = new Set();
  function pushEdge(s, t, lt) {
    const k = `${s}|${t}|${lt}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ source: s, target: t, linkType: lt });
  }
  for (const a of artifactRows) {
    if (a.parent_artifact_id && artifactById.has(a.parent_artifact_id)) {
      pushEdge(artifactById.get(a.parent_artifact_id), artifactById.get(a.id), 'parent');
    }
  }

  appendTraceEdges(db, artifactRows, artifactById, nodes, pushEdge, () => `${TASK_NODE_PREFIX}`);

  return {
    available: true,
    project: { id: project.id, name: project.name },
    repository: null,
    nodes,
    edges,
    stats: {
      artifactCount: artifactRows.length,
      docCount: 0,
      taskCount: 0,
      edgeCount: edges.length,
    },
  };
}

/**
 * Read `artifact_traces` for the given artifact rows, promote task targets to
 * nodes, and push trace edges via the provided `pushEdge`. Shared between the
 * main snapshot (with repo binding + doc scan) and the DB-only fallback.
 *
 * `taskNodePrefix` is a thunk so the prefix constant stays in the closure
 * (kept consistent across both call sites).
 */
function appendTraceEdges(db, artifactRows, artifactById, nodes, pushEdge, taskNodePrefix) {
  if (!artifactRows.length) return;
  const ids = artifactRows.map((a) => a.id);
  const traces = db
    .prepare(
      `SELECT source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE source_id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids);

  // Promote task targets to nodes (one node per unique target_id).
  const taskTargetIds = [
    ...new Set(
      traces.filter((t) => t.target_type === 'task').map((t) => t.target_id),
    ),
  ];
  const taskNodeById = new Map();
  if (taskTargetIds.length) {
    const taskRows = db
      .prepare(
        `SELECT tk.id, tk.title, tk.status, tk.epic_id
           FROM tasks tk WHERE tk.id IN (${taskTargetIds.map(() => '?').join(',')})`,
      )
      .all(...taskTargetIds);
    for (const t of taskRows) {
      const nodeId = `${taskNodePrefix()}${t.id}`;
      taskNodeById.set(t.id, nodeId);
      // Avoid pushing duplicate task nodes if the caller already added them.
      if (!nodes.some((n) => n.id === nodeId)) {
        nodes.push({
          id: nodeId,
          kind: 'task',
          type: 'task',
          taskId: t.id,
          title: t.title,
          status: t.status,
          epicId: t.epic_id,
        });
      }
    }
  }

  for (const t of traces) {
    const source = artifactById.get(t.source_id);
    if (!source) continue;
    const target =
      t.target_type === 'artifact'
        ? artifactById.get(t.target_id)
        : t.target_type === 'task'
          ? taskNodeById.get(t.target_id)
          : null;
    if (!target) continue; // dangling trace — skip
    pushEdge(source, target, t.link_type);
  }
}

function parseJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
