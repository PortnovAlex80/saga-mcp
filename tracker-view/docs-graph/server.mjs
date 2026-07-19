// Docs Graph Viewer — HTTP server.
//
// Renders the unified documentation graph (saga artifacts + all .md files) for
// a saga project, and (Phase B/C) lets the user edit docs in git branches with
// PR-like merge into the project's integration branch.
//
// Routes (Phase A — view-only):
//   GET /                          → public/index.html
//   GET /api/projects              → list of saga projects
//   GET /api/graph?project=<id>    → unified graph snapshot JSON
//   GET /<static-asset>            → files under public/
//
// Phase B/C routes are added in later edits (see plan).
//
// The server opens process.env.DB_PATH read-only per request — same pattern as
// the sibling tracker-view.mjs. WAL mode on the saga DB makes this safe to run
// concurrently with saga-mcp itself.

import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildGraphSnapshot } from './lib/graph-snapshot.mjs';
import { resolveProjectRepo } from './lib/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// better-sqlite3 is installed at the saga-mcp repo root (npm install there).
// Resolve via createRequire so this subpackage stays zero-install.
const Database = require(
  path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'),
);

// Compiled docs-worktree module — lives in saga-mcp's dist/. Always resolve
// through the parent's compiled output (created by `npm run build` / `tsc`).
const docsWorktreeDist = path.join(__dirname, '..', '..', 'dist', 'lifecycle', 'docs-worktree.js');
const docsWorktree = existsSync(docsWorktreeDist)
  ? require(docsWorktreeDist)
  : null;

// refreshArtifactHash lives in the compiled helpers bundle. Used after a docs
// merge to sync saga artifact content_hash / drift_state with the integrated
// .md content.
const artifactFileDist = path.join(__dirname, '..', '..', 'dist', 'helpers', 'artifact-file.js');
const artifactFile = existsSync(artifactFileDist)
  ? require(artifactFileDist)
  : null;

const DB_PATH = process.env.DB_PATH;
if (!DB_PATH || !existsSync(DB_PATH)) {
  console.error(
    'DB_PATH not set or missing. saga-mcp must start docs-graph with a valid DB_PATH.',
  );
  process.exit(1);
}

const PORT = Number(process.env.DOCS_GRAPH_PORT) || 4322;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function withDb(fn) {
  const db = new Database(DB_PATH, { readonly: true, timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function respondJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } else {
        resolve(raw);
      }
    });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(req, res) {
  // Only allow paths that stay inside PUBLIC_DIR (no ../ escapes).
  const requested = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, requested || 'index.html');
  const prefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (abs !== PUBLIC_DIR && !abs.startsWith(prefix)) {
    respondJson(res, 403, { error: 'forbidden' });
    return true;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  // Disable caching for development — these assets change frequently.
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(abs));
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ---- API: project list ----
  if (pathname === '/api/projects' && req.method === 'GET') {
    const rows = withDb((db) =>
      db
        .prepare(
          `SELECT p.id, p.name, p.description, p.status,
                  (SELECT COUNT(*) FROM artifacts a
                     JOIN epics e ON e.id=a.epic_id
                    WHERE e.project_id=p.id) AS artifact_count
             FROM projects p
            ORDER BY p.id`,
        )
        .all(),
    );
    respondJson(res, 200, { projects: rows });
    return;
  }

  // ---- API: graph snapshot ----
  if (pathname === '/api/graph' && req.method === 'GET') {
    const projectId = Number(url.searchParams.get('project'));
    if (!projectId) {
      respondJson(res, 400, { error: 'project query param required' });
      return;
    }
    try {
      const snapshot = withDb((db) => buildGraphSnapshot(db, projectId));
      respondJson(res, 200, snapshot);
    } catch (e) {
      respondJson(res, 500, { error: 'graph-build: ' + e.message });
    }
    return;
  }

  // =========================================================================
  // Phase B: branch editing endpoints.
  // =========================================================================
  // All branch operations operate on the repository bound to a saga project.
  // We resolve the binding from the DB; if docsWorktree (compiled) is missing,
  // the endpoints return a 503 with an actionable hint.

  if (pathname.startsWith('/api/doc/') && req.method === 'POST') {
    return handleDocMutation(req, res, pathname);
  }
  if (pathname === '/api/doc/diff' && req.method === 'GET') {
    const branch = url.searchParams.get('branch') || '';
    const projectId = Number(url.searchParams.get('project'));
    if (!branch || !projectId) {
      return respondJson(res, 400, { error: 'branch and project required' });
    }
    const repo = resolveRepoForProject(projectId);
    if (!repo) return respondJson(res, 404, { error: 'no repository bound' });
    if (!docsWorktree) return respondJson(res, 503, { error: 'docs-worktree not built' });
    try {
      const changeId = parseChangeId(branch);
      if (!changeId) return respondJson(res, 400, { error: 'branch must be docs/<id>' });
      // Base sha: the merge-base between branch and the integration branch.
      // If integration branch is missing, fall back to default_branch (the
      // merge endpoint would auto-create integration from there anyway).
      let baseRef = repo.integrationBranch;
      const intExists = safeGit(repo.localPath, ['rev-parse', '--verify', `refs/heads/${repo.integrationBranch}`]);
      if (!intExists.ok) baseRef = repo.defaultBranch;
      const mb = safeGit(repo.localPath, ['merge-base', baseRef, branch]);
      if (!mb.ok) {
        return respondJson(res, 400, { error: `cannot compute merge-base (${baseRef}..${branch})` });
      }
      const baseSha = mb.stdout;
      const diff = docsWorktree.diffAgainstBase(repo.localPath, branch, baseSha);
      respondJson(res, 200, {
        files: diff.files,
        patch: diff.patch,
        baseSha,
        baseRef,
        integrationBranch: repo.integrationBranch,
        integrationBranchExists: intExists.ok,
        branch,
      });
    } catch (e) {
      respondJson(res, 500, { error: e.message });
    }
    return;
  }
  if (pathname === '/api/doc/branch/list' && req.method === 'GET') {
    const projectId = Number(url.searchParams.get('project'));
    if (!projectId) return respondJson(res, 400, { error: 'project query param required' });
    const repo = resolveRepoForProject(projectId);
    if (!repo) return respondJson(res, 404, { error: 'no repository bound to this project' });
    if (!docsWorktree) return respondJson(res, 503, { error: 'docs-worktree module not built (run: npm run build)' });
    try {
      const branches = docsWorktree.listChanges(repo.localPath);
      respondJson(res, 200, { branches });
    } catch (e) {
      respondJson(res, 500, { error: e.message });
    }
    return;
  }
  if (pathname === '/api/doc/read' && req.method === 'GET') {
    const branch = url.searchParams.get('branch') || '';
    const relPath = url.searchParams.get('path') || '';
    const projectId = Number(url.searchParams.get('project'));
    if (!branch || !relPath || !projectId) {
      return respondJson(res, 400, { error: 'branch, path, project required' });
    }
    const repo = resolveRepoForProject(projectId);
    if (!repo) return respondJson(res, 404, { error: 'no repository bound' });
    if (!docsWorktree) return respondJson(res, 503, { error: 'docs-worktree not built' });
    try {
      const changeId = parseChangeId(branch);
      if (!changeId) return respondJson(res, 400, { error: 'branch must be docs/<id>' });
      // Resolve the worktree path.
      const wtPath = path.join(repo.localPath, '.worktrees', `docs-${changeId}`);
      const content = docsWorktree.readFile(wtPath, relPath);
      if (content == null) return respondJson(res, 404, { error: 'file not found in worktree' });
      respondJson(res, 200, { content });
    } catch (e) {
      respondJson(res, 500, { error: e.message });
    }
    return;
  }

  // ---- static / index.html ----
  if (req.method === 'GET' && serveStatic(req, res)) return;

  respondJson(res, 404, { error: 'not-found', path: pathname });
}

/**
 * Resolve the repository binding for a saga project (local_path, docs_root,
 * integration_branch). Returns null when the project has no bound repo with a
 * filesystem path.
 */
function resolveRepoForProject(projectId) {
  return withDb((db) => resolveProjectRepo(db, projectId));
}

/** Extract changeId from a 'docs/<changeId>' branch name. */
function parseChangeId(branch) {
  const m = /^docs\/([a-z0-9][a-z0-9-]*)$/.exec(branch || '');
  return m ? m[1] : null;
}

/** Spawn `git` in repoPath and return {ok, stdout, stderr, status}. Never throws. */
function safeGit(repoPath, args) {
  try {
    const r = require('node:child_process').spawnSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      ok: r.status === 0,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
      status: r.status,
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e), status: null };
  }
}

/**
 * After a docs merge, refresh content_hash + drift_state for every saga
 * artifact whose .md file was touched by the change. Uses the compiled
 * refreshArtifactHash helper from dist/helpers/artifact-file.js.
 *
 * Best-effort: failures to refresh individual artifacts are logged but never
 * fail the merge — the git integration already succeeded.
 */
function syncArtifactHashesForMerge(repo, changeId, mergeSha) {
  if (!artifactFile || typeof artifactFile.refreshArtifactHash !== 'function') return;
  // Compare the merge commit against its first parent (the previous target
  // tip). That diff is exactly what the docs branch contributed.
  let touched = [];
  try {
    touched = docsWorktree.filesTouchedBetween(repo.localPath, `${mergeSha}^1`, mergeSha);
  } catch {
    return;
  }
  if (!touched.length) return;
  // Find artifacts whose path (without anchor) matches any touched file.
  // Match by suffix so anchor-style paths (foo.md#AC-1) still resolve.
  const db = new Database(DB_PATH, { timeout: 5000 });
  try {
    db.pragma('journal_mode = WAL');
    const candidates = db
      .prepare(`SELECT id, path FROM artifacts WHERE project_repository_id = ?`)
      .all(repo.id);
    for (const a of candidates) {
      const cleanPath = String(a.path || '').split('#')[0].replace(/^\.\//, '');
      const posix = cleanPath.split(path.sep).join('/');
      if (touched.some((t) => t === posix || t.endsWith('/' + posix) || posix.endsWith('/' + t))) {
        try {
          artifactFile.refreshArtifactHash(db, a.id);
        } catch {
          // Skip — refresh failures are non-fatal.
        }
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Phase B POST handler: branch/create, branch/discard, doc/save.
 * Body fields vary by action.
 */
async function handleDocMutation(req, res, pathname) {
  if (!docsWorktree) {
    return respondJson(res, 503, {
      error: 'docs-worktree module not built. Run `npm run build` in saga-mcp root.',
    });
  }
  const fields = await readBody(req);
  const projectId = Number(fields.project_id || fields.project);
  if (!projectId) return respondJson(res, 400, { error: 'project_id required' });
  const repo = resolveRepoForProject(projectId);
  if (!repo) return respondJson(res, 404, { error: 'no repository bound to this project' });

  try {
    if (pathname === '/api/doc/branch/create') {
      const opts = {};
      if (fields.base) {
        // Explicit caller override.
        opts.baseRef = String(fields.base);
      } else {
        // Default: base the docs branch on the integration branch (so the
        // subsequent merge is fast-forward-ish and the diff preview shows only
        // the docs changes, not the entire feature-branch delta). If the
        // integration branch doesn't exist, fall back to default_branch — the
        // merge endpoint will create integration from there on demand.
        const intExists = safeGit(repo.localPath, ['rev-parse', '--verify', `refs/heads/${repo.integrationBranch}`]);
        opts.baseRef = intExists.ok ? repo.integrationBranch : repo.defaultBranch;
      }
      if (fields.change_id) opts.changeId = String(fields.change_id);
      const wt = docsWorktree.createChange(repo.localPath, opts);
      return respondJson(res, 200, { worktree: wt, integrationBranch: repo.integrationBranch });
    }
    if (pathname === '/api/doc/branch/discard') {
      const changeId = fields.change_id || parseChangeId(fields.branch);
      if (!changeId) return respondJson(res, 400, { error: 'change_id or branch required' });
      docsWorktree.discardChange(repo.localPath, changeId);
      return respondJson(res, 200, { ok: true, changeId });
    }
    if (pathname === '/api/doc/save') {
      const branch = String(fields.branch || '');
      const relPath = String(fields.path || fields.relPath || '');
      const markdown = fields.markdown != null ? String(fields.markdown) : null;
      const message = String(fields.message || `docs: update ${relPath}`);
      const changeId = parseChangeId(branch) || fields.change_id;
      if (!changeId) return respondJson(res, 400, { error: 'branch (docs/<id>) required' });
      if (!relPath) return respondJson(res, 400, { error: 'path required' });

      const wtPath = path.join(repo.localPath, '.worktrees', `docs-${changeId}`);
      if (!existsSync(wtPath)) {
        return respondJson(res, 404, { error: 'worktree not found for change ' + changeId });
      }
      if (markdown != null) {
        docsWorktree.writeFile(wtPath, relPath, markdown);
      }
      const sha = docsWorktree.commit(wtPath, message);
      return respondJson(res, 200, { ok: true, commit: sha, branch, path: relPath });
    }
    if (pathname === '/api/doc/merge') {
      const branch = String(fields.branch || '');
      const changeId = parseChangeId(branch) || String(fields.change_id || '');
      if (!changeId) return respondJson(res, 400, { error: 'branch (docs/<id>) or change_id required' });
      const expectedTargetSha = fields.expected_target_sha ? String(fields.expected_target_sha) : undefined;
      // If the integration branch doesn't exist yet, auto-create it from the
      // repository's default branch (master/main). This matches saga's
      // convention that integration_branch = 'dev' off main, but tolerates
      // projects that haven't yet adopted the dev/main split.
      const opts = {
        expectedTargetSha,
        createTargetFromRef: repo.defaultBranch,
      };
      try {
        const result = docsWorktree.mergeDocsBranch(
          repo.localPath,
          changeId,
          repo.integrationBranch,
          opts,
        );
        // On successful merge, sync saga artifact hashes for affected files.
        if (result.kind === 'merged') {
          syncArtifactHashesForMerge(repo, changeId, result.mergeCommitSha);
          // Clean up the worktree + branch — change is integrated.
          try { docsWorktree.discardChange(repo.localPath, changeId); } catch { /* non-fatal */ }
        }
        return respondJson(res, 200, { result, changeId, integrationBranch: repo.integrationBranch });
      } catch (e) {
        return respondJson(res, 500, { error: e.message });
      }
    }
    return respondJson(res, 404, { error: 'unknown doc mutation: ' + pathname });
  } catch (e) {
    return respondJson(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      respondJson(res, 500, { error: 'unhandled: ' + (e?.message || String(e)) });
    } catch {
      // socket may already be closed
    }
  });
});

server.listen(PORT, () => {
  console.log(`docs-graph viewer listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});

// Soft-shutdown when saga-mcp parent dies (TRACKER_SPAWNED env pattern).
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
