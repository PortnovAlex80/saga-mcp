// Path helpers — locate a project's working repository and resolve a
// saga-artifact `path` (e.g. "docs/requirements/REQ-001/03-acceptance-criteria.md#AC-1")
// to an absolute filesystem path, with the same traversal guard saga uses
// internally (see src/helpers/artifact-file.ts:artifactDiskHash).
//
// We deliberately do NOT import saga's compiled TS — docs-graph stays
// independent of the dist/ build, so it runs even before `tsc`.

import path from 'node:path';

/**
 * Resolve a project repository binding for graph scanning.
 *
 * Returns { id, localPath, docsRoot, integrationBranch, defaultBranch } or null.
 * `localPath` is required — a binding without a filesystem path cannot be scanned.
 */
export function resolveProjectRepo(db, projectId) {
  const row = db
    .prepare(
      `SELECT pr.id, pr.local_path, pr.docs_root, pr.integration_branch,
              r.default_branch
         FROM project_repositories pr
         JOIN repositories r ON r.id = pr.repository_id
        WHERE pr.project_id = ? AND pr.status = 'active'
              AND pr.local_path IS NOT NULL
        ORDER BY pr.id LIMIT 1`,
    )
    .get(projectId);
  if (!row || !row.local_path) return null;
  return {
    id: row.id,
    localPath: path.resolve(row.local_path),
    docsRoot: row.docs_root ?? null,
    integrationBranch: row.integration_branch || 'dev',
    defaultBranch: row.default_branch || 'main',
  };
}

/**
 * Compute the scan root for a repository binding.
 * Falls back from docs_root → local_path.
 */
export function scanRootFor(binding) {
  if (binding.docsRoot && binding.docsRoot.trim()) {
    return path.resolve(binding.localPath, binding.docsRoot);
  }
  return binding.localPath;
}

/**
 * Resolve an artifact `path` (possibly with `#anchor`) to an absolute
 * filesystem path, asserting it stays under `root`.
 *
 * Returns null when the path escapes `root` (defence against malformed
 * absolute paths authored by an LLM worker) — mirrors artifactDiskHash.
 */
export function resolveUnderRoot(root, artifactPath) {
  const relative = String(artifactPath || '').split('#')[0];
  if (!relative) return null;
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) return null;
  return absolute;
}

/** Strip a `#anchor` from a saga artifact path. */
export function withoutAnchor(p) {
  return String(p || '').split('#')[0];
}

/** Normalise a path to POSIX-style forward slashes (stable across platforms). */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
