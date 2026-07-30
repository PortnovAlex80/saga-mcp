// Lifecycle Pipeline — HTTP adapter (route-only).
//
// Clean-architecture boundary: this module knows HTTP and file serving, and
// NOTHING else. All pipeline business logic lives in the application layer
// (`dist/process-modules/application/lifecycle-pipeline-query.js`); this adapter
// only delegates to it and translates the result into the frozen JSON contract.
//
// Dependencies are INJECTED by the caller (the tracker-view composition in
// tracker-view.mjs): the lifecycle-run repository (for reading runs), a
// `resolveProjectId(epicId)` thunk (because the client only knows the epic id,
// but the projection is keyed by project+epic), and the `publicDir` to serve
// the static client assets (pipeline.css / pipeline.js / mount.js).
//
// Two handlers are exported via the factory:
//   handlePipeline(req, res, url)   GET /api/lifecycle/pipeline?epic_id=N
//   handleStatic(req, res, url)     GET /lifecycle-pipeline/<asset>
//
// Pipeline response shape (the single source-of-truth for which pipeline the
// UI renders):
//   { ok:true, source:'lifecycle', view: <PipelineView> }  // render new bar
//   { ok:true, source:'legacy' }                            // defer to legacy pipeline
// `source:'legacy'` is emitted when no LifecycleRun exists for the epic (the
// projection returns null) — the client then yields the shared container to the
// legacy refreshPipeline(). This is the coexistence/fallback contract.

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPipelineView } from '../../dist/process-modules/application/lifecycle-pipeline-query.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MIME types for the (small, fixed) set of static assets we serve.
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * Construct the lifecycle-pipeline HTTP adapter with injected dependencies.
 *
 * @param {object} deps
 * @param {object} deps.repo             LifecycleRunRepository (read interface).
 * @param {(epicId:number)=>number|null} deps.resolveProjectId
 *        Resolves an epic id to its project id (single lookup against `epics`).
 * @param {string} [deps.publicDir]      Directory of static client assets.
 *        Defaults to the `public/` folder next to this module.
 */
export function createLifecyclePipelineApi({ repo, resolveProjectId, publicDir }) {
  const assetRoot = publicDir || path.join(__dirname, 'public');

  /** GET /api/lifecycle/pipeline?epic_id=N — the per-epic pipeline decision. */
  async function handlePipeline(req, res, url) {
    const epicId = Number(url.searchParams.get('epic_id'));
    if (!Number.isSafeInteger(epicId) || epicId <= 0) {
      return respondJson(res, 400, { ok: false, error: 'epic_id required' });
    }
    try {
      const projectId = resolveProjectId(epicId);
      // No project for this epic (or epic gone) → no lifecycle run possible.
      if (projectId === null || projectId === undefined) {
        return respondJson(res, 200, { ok: true, source: 'legacy' });
      }
      const view = buildPipelineView(projectId, epicId, repo);
      if (view === null) {
        // No LifecycleRun for this epic → defer to the legacy pipeline.
        return respondJson(res, 200, { ok: true, source: 'legacy' });
      }
      return respondJson(res, 200, { ok: true, source: 'lifecycle', view });
    } catch (e) {
      // Honest failure: a genuine read error must not be silently masked. The
      // client treats non-ok as "yield to legacy" so the board keeps working.
      return respondJson(res, 500, { ok: false, error: 'lifecycle-pipeline: ' + e.message });
    }
  }

  /**
   * GET /lifecycle-pipeline/<asset> — serve a static client asset from the
   * public dir. Path traversal is blocked by normalising and requiring the
   * resolved path to stay inside `assetRoot`. Unknown paths → 404.
   */
  async function handleStatic(req, res, url) {
    // Strip the `/lifecycle-pipeline` prefix to get the asset subpath.
    let rel = url.pathname.slice('/lifecycle-pipeline'.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) return respondNotFound(res);

    const resolved = path.resolve(assetRoot, rel);
    // Containment check: the resolved path must be inside assetRoot.
    const root = path.resolve(assetRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return respondNotFound(res);
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext];
    if (!type) return respondNotFound(res); // only whitelisted types
    try {
      const [canonicalRoot, canonicalFile] = await Promise.all([
        realpath(root),
        realpath(resolved),
      ]);
      if (
        canonicalFile !== canonicalRoot
        && !canonicalFile.startsWith(canonicalRoot + path.sep)
      ) {
        return respondNotFound(res);
      }
      const data = await readFile(canonicalFile);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      respondNotFound(res);
    }
  }

  return { handlePipeline, handleStatic };
}

function respondJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function respondNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
