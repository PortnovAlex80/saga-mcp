import os from 'node:os';
import path from 'node:path';

interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Resolve the repository root observed by a worker on this machine.
 *
 * The active machine checkout is authoritative when present; the canonical
 * project-repository path is the fallback. Every file-backed material reader
 * must use this resolver so stamping and acceptance cannot inspect different
 * trees.
 */
export function resolveEffectiveRepositoryRoot(
  db: DbHandle,
  projectRepositoryId: number,
  machineId = os.hostname(),
): string | null {
  const row = db.prepare(
    `SELECT COALESCE(rc.local_path, pr.local_path) AS local_path
       FROM project_repositories pr
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id=pr.id
        AND rc.machine_id=?
        AND rc.status='active'
      WHERE pr.id=?`,
  ).get(machineId, projectRepositoryId) as { local_path: string | null } | undefined;
  return row?.local_path ? path.resolve(row.local_path) : null;
}

/** Resolve a repository-relative artifact path without allowing root escape. */
export function resolveRepositoryMaterialPath(
  repositoryRoot: string,
  materialPath: string,
): string | null {
  const root = path.resolve(repositoryRoot);
  const relative = materialPath.split('#')[0]!;
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return absolute === root || absolute.startsWith(prefix) ? absolute : null;
}
