// src/tools/conflicts.ts
//
// REQ-010 — CGAD §7 Phase 7 Semantic Conflict Model.
//
// Provides typed conflict-key management and detection:
//   - conflict_keys_set: tag a task with one or more conflict keys
//     (file_path / schema / public_protocol / integration_branch).
//   - conflict_keys_list: read a task's keys.
//   - conflict_check: scan an episode (or repository scope) for two-or-more
//     tasks sharing a (key_type, key_value) pair. Returns the collision set.
//
// CGAD §22 forbidden construct §34: git conflict must not be the only
// conflict detector. This tool computes SEMANTIC overlap at planning time —
// before any worker starts. The episode_transition to 'development' can use
// the collision set to refuse entry when ≥2 active tasks collide and no
// scaffold mediates (cf. CGAD-R4 in cgad-spec-lint).
//
// Key derivation (v1, deterministic):
//   file_path        — from task.source_ref (JSON-encoded file list or single path)
//   schema           — from task.metadata.schema (string or array)
//   public_protocol  — from task.metadata.public_protocol
//   integration_branch — from task.project_repository_id → project_repositories.integration_branch
//
// Auto-derivation is exposed via conflict_keys_auto_derive, which the planner
// can call after task_create to populate keys from task fields without manual
// tagging. Manual keys (set explicitly) always win over auto-derived.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

const KEY_TYPES = ['file_path', 'schema', 'public_protocol', 'integration_branch'] as const;
type KeyType = typeof KEY_TYPES[number];

function handleConflictKeysSet(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const keys = args.keys as Array<{ key_type: KeyType; key_value: string }>;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys must be a non-empty array of {key_type, key_value}');
  }
  // Validate task exists.
  const task = db.prepare('SELECT id, title FROM tasks WHERE id=?').get(taskId) as { id: number; title: string } | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO task_conflict_keys (task_id, key_type, key_value) VALUES (?, ?, ?)',
  );
  let added = 0;
  for (const k of keys) {
    if (!KEY_TYPES.includes(k.key_type)) {
      throw new Error(`Invalid key_type '${k.key_type}' (expected one of: ${KEY_TYPES.join(', ')})`);
    }
    if (!k.key_value || typeof k.key_value !== 'string') {
      throw new Error('key_value must be a non-empty string');
    }
    const info = insert.run(taskId, k.key_type, k.key_value);
    if (info.changes > 0) added += 1;
  }
  logActivity(db, 'task', taskId, 'updated', 'conflict_keys', null, String(added),
    `Task '${task.title}' tagged with ${added} conflict key(s)`);
  return { task_id: taskId, added, total: conflictKeyCount(db, taskId) };
}

function conflictKeyCount(db: ReturnType<typeof getDb>, taskId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM task_conflict_keys WHERE task_id=?').get(taskId) as { n: number }).n;
}

function handleConflictKeysList(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const rows = db.prepare(
    'SELECT key_type, key_value FROM task_conflict_keys WHERE task_id=? ORDER BY key_type, key_value',
  ).all(taskId);
  return { task_id: taskId, keys: rows };
}

function handleConflictKeysClear(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const info = db.prepare('DELETE FROM task_conflict_keys WHERE task_id=?').run(taskId);
  return { task_id: taskId, removed: info.changes };
}

// Derive conflict keys from task fields. The planner can call this after
// task_create to populate keys without manual tagging. Manual keys (already
// in the table) are preserved — auto-derive only adds missing ones.
function handleConflictKeysAutoDerive(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const task = db.prepare(
    `SELECT t.id, t.source_ref, t.metadata, t.project_repository_id,
            pr.integration_branch
     FROM tasks t
     LEFT JOIN project_repositories pr ON pr.id = t.project_repository_id
     WHERE t.id = ?`,
  ).get(taskId) as {
    id: number; source_ref: string | null; metadata: string;
    project_repository_id: number | null; integration_branch: string | null;
  } | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const derived: Array<{ key_type: KeyType; key_value: string }> = [];

  // file_path from source_ref — saga stores source_ref as JSON stringified
  // (object with file/line_start/line_end/repo) or as a plain path.
  // IMPORTANT: only emit a file_path conflict key for CODE files, not for
  // requirements .md documents. Dev tasks created by saga-planner often carry
  // a source_ref pointing at the AC .md anchor (traceability), but the
  // conflict we care about is the code file the worker will actually mutate.
  // Source-ref-as-.md produces false positives (every task for the same AC
  // collides on the AC document). Skip .md/.markdown/.rst/.txt.
  const isCodeFile = (p: string): boolean => {
    const lower = p.toLowerCase();
    // Reject docs (with or without anchor fragments like 'foo.md#AC-1').
    if (/\.md([#?].*)?$/.test(lower)) return false;
    if (/\.markdown([#?].*)?$/.test(lower)) return false;
    if (/\.rst([#?].*)?$/.test(lower)) return false;
    if (/\.txt([#?].*)?$/.test(lower)) return false;
    return true;
  };
  if (task.source_ref) {
    try {
      const parsed = JSON.parse(task.source_ref);
      if (parsed && typeof parsed === 'object' && 'file' in parsed && typeof (parsed as { file: unknown }).file === 'string') {
        const f = (parsed as { file: string }).file;
        if (isCodeFile(f)) derived.push({ key_type: 'file_path', key_value: f });
      } else if (typeof parsed === 'string' && isCodeFile(parsed)) {
        derived.push({ key_type: 'file_path', key_value: parsed });
      }
    } catch {
      // Not JSON — treat as plain path, only if code.
      if (isCodeFile(task.source_ref)) {
        derived.push({ key_type: 'file_path', key_value: task.source_ref });
      }
    }
  }
  // schema + public_protocol from metadata.
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(task.metadata || '{}') as Record<string, unknown>; } catch { /* ignore */ }

  // Code-file fallback: dev tasks that did not set source_ref to a code path
  // often carry metadata.target_file (planner convention) — prefer it when
  // source_ref did not yield a code key.
  const targetFile = typeof meta.target_file === 'string' && isCodeFile(meta.target_file)
    ? meta.target_file
    : null;
  if (targetFile && !derived.some(k => k.key_type === 'file_path')) {
    derived.push({ key_type: 'file_path', key_value: targetFile });
  }

  const pushMetaKey = (metaKey: string, keyType: KeyType) => {
    const v = meta[metaKey];
    if (typeof v === 'string' && v.trim()) {
      derived.push({ key_type: keyType, key_value: v });
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) {
          derived.push({ key_type: keyType, key_value: item });
        }
      }
    }
  };
  pushMetaKey('schema', 'schema');
  pushMetaKey('public_protocol', 'public_protocol');

  // integration_branch from the repository binding.
  if (task.integration_branch) {
    derived.push({ key_type: 'integration_branch', key_value: task.integration_branch });
  }

  // Insert only keys not already present (preserve manual keys).
  const insert = db.prepare(
    'INSERT OR IGNORE INTO task_conflict_keys (task_id, key_type, key_value) VALUES (?, ?, ?)',
  );
  let added = 0;
  for (const k of derived) {
    const info = insert.run(taskId, k.key_type, k.key_value);
    if (info.changes > 0) added += 1;
  }
  return { task_id: taskId, derived: derived.length, added, total: conflictKeyCount(db, taskId) };
}

// The headline tool. Given an epic (or repository scope), find every
// (key_type, key_value) pair that ≥2 ACTIVE-or-PENDING tasks share. Each
// collision is a SEMANTIC conflict that git might or might not catch — this
// tool guarantees detection at planning time.
//
// "Active or pending" = NOT done, NOT cancelled. Crucially this INCLUDES
// `blocked` tasks: a blocked task is waiting on a dependency but will become
// active when the dependency lands. Excluding blocked tasks from collision
// detection defeats the entire point of planning-time detection — at
// planning time, body tasks are typically blocked on a scaffold, and that is
// exactly the collision we need to see.
//
// Only tasks whose lifecycle is OVER (done) are excluded — they cannot
// mutate the workspace anymore. (saga has no `cancelled` status on tasks;
// episodes have it, tasks do not.)
function handleConflictCheck(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const repositoryId = args.project_repository_id as number | undefined;
  if (epicId == null && repositoryId == null) {
    throw new Error('Either epic_id or project_repository_id is required');
  }

  // In-flight-or-pending statuses. Done is excluded (lifecycle over).
  // Blocked, todo, in_progress, review, review_in_progress — all included.
  const IN_PIPELINE = "('todo','in_progress','review','review_in_progress','blocked')";

  // Build the task filter: either epic or repository scope.
  let taskFilter: string;
  let filterParams: unknown[];
  if (epicId != null) {
    taskFilter = 't.epic_id = ?';
    filterParams = [epicId];
  } else {
    taskFilter = 't.project_repository_id = ?';
    filterParams = [repositoryId];
  }

  // Find collision pairs.
  const collisions = db.prepare(
    `SELECT k.key_type, k.key_value,
       GROUP_CONCAT(k.task_id) AS task_ids_csv,
       COUNT(DISTINCT k.task_id) AS n_tasks
     FROM task_conflict_keys k
     JOIN tasks t ON t.id = k.task_id
     WHERE t.status IN ${IN_PIPELINE}
       AND ${taskFilter}
     GROUP BY k.key_type, k.key_value
     HAVING n_tasks >= 2
     ORDER BY n_tasks DESC, k.key_type, k.key_value`,
  ).all(...filterParams) as Array<{
    key_type: string; key_value: string;
    task_ids_csv: string; n_tasks: number;
  }>;

  const mapped = collisions.map(c => ({
    key_type: c.key_type,
    key_value: c.key_value,
    task_ids: c.task_ids_csv.split(',').map((s) => Number(s)),
    n_tasks: c.n_tasks,
  }));

  // REQ-010 noise reduction: integration_branch collisions are expected and
  // benign when the colliding tasks are SEQUENCED via task_dependencies
  // (scaffold → bodies → integrate all share the repo's integration_branch
  // because they all target the same repo). Without this filter, every
  // single-repo episode reports a noisy integration_branch collision that
  // obscures real collisions (file_path / schema / public_protocol).
  //
  // Rule: an integration_branch collision is SUPPRESSED when all colliding
  // tasks form a single connected component in the dependency graph (edges
  // treated as undirected, traversed transitively through ANY task —
  // including ancestors outside the collision set, e.g. a scaffold that is
  // done or that does not itself carry the integration_branch key). If they
  // are sequenced they cannot parallel-race the branch. If they are NOT
  // connected, they are a genuine parallel race on the same branch and the
  // collision is kept.
  //
  // Only integration_branch is filtered — file_path / schema / public_protocol
  // collisions ALWAYS remain, even when the tasks are sequenced, because
  // those represent concrete semantic overlap that git may not catch.
  const filtered = mapped.filter(c => {
    if (c.key_type !== 'integration_branch') return true;
    return !integrationBranchCollisionIsSequenced(db, c.task_ids);
  });

  return {
    scope: epicId != null ? { epic_id: epicId } : { project_repository_id: repositoryId },
    collisions: filtered,
    collision_count: filtered.length,
  };
}

// Returns true when every colliding task is reachable from every other
// through task_dependencies (undirected transitive closure). When true,
// the integration_branch collision is sequenced (not a parallel race)
// and should be suppressed.
function integrationBranchCollisionIsSequenced(
  db: ReturnType<typeof getDb>,
  taskIds: number[],
): boolean {
  if (taskIds.length < 2) return true; // trivially sequenced
  const placeholders = taskIds.map(() => '?').join(',');
  // Load every dependency edge that touches the colliding set in either
  // direction. We traverse transitively through any task (ancestors outside
  // the collision set included) — the question is lineage connectivity,
  // not whether the mediator is itself colliding.
  const edges = db.prepare(
    `SELECT task_id, depends_on_task_id FROM task_dependencies
     WHERE task_id IN (${placeholders})
        OR depends_on_task_id IN (${placeholders})`,
  ).all(...taskIds, ...taskIds) as Array<{ task_id: number; depends_on_task_id: number }>;

  // Build undirected adjacency over every node mentioned by any loaded edge.
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const e of edges) link(e.task_id, e.depends_on_task_id);

  // BFS from the first colliding task. Seed visited with it so a task with
  // no edges still counts as its own (singleton) component.
  const start = taskIds[0];
  const visited = new Set<number>([start]);
  const queue: number[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbors = adj.get(cur);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  // All colliding tasks must sit inside the one component we just traversed.
  return taskIds.every(id => visited.has(id));
}

export const definitions: Tool[] = [
  {
    name: 'conflict_keys_set',
    description: 'REQ-010 — Tag a task with semantic conflict keys (file_path/schema/public_protocol/integration_branch). Two active tasks sharing a key pair collide semantically (CGAD §34: git conflict must not be the only detector).',
    annotations: { title: 'Conflict Keys: Set', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key_type: { type: 'string', enum: [...KEY_TYPES] },
              key_value: { type: 'string' },
            },
            required: ['key_type', 'key_value'],
          },
          minItems: 1,
        },
      },
      required: ['task_id', 'keys'],
    },
  },
  {
    name: 'conflict_keys_list',
    description: 'REQ-010 — List a task\'s semantic conflict keys.',
    annotations: { title: 'Conflict Keys: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
  {
    name: 'conflict_keys_clear',
    description: 'REQ-010 — Remove all semantic conflict keys from a task.',
    annotations: { title: 'Conflict Keys: Clear', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
  {
    name: 'conflict_keys_auto_derive',
    description: 'REQ-010 — Auto-derive conflict keys from task fields (source_ref → file_path, metadata.schema → schema, metadata.public_protocol → public_protocol, repository binding → integration_branch). Preserves manually-set keys.',
    annotations: { title: 'Conflict Keys: Auto-Derive', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
  {
    name: 'conflict_check',
    description: 'REQ-010 — Scan an epic or repository scope for semantic collisions: pairs of ACTIVE tasks sharing a (key_type, key_value) pair. Returns the collision set. Use at planning time to decide whether Pattern B (scaffold) is required.',
    annotations: { title: 'Conflict: Check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer' },
        project_repository_id: { type: 'integer' },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  conflict_keys_set: handleConflictKeysSet,
  conflict_keys_list: handleConflictKeysList,
  conflict_keys_clear: handleConflictKeysClear,
  conflict_keys_auto_derive: handleConflictKeysAutoDerive,
  conflict_check: handleConflictCheck,
};
