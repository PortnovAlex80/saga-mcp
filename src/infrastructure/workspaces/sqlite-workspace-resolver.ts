import { existsSync } from 'node:fs';
import os from 'node:os';
import type {
  WorkspaceResolution,
  WorkspaceResolver,
} from '../../application/ports/saga2-runtime-persistence.js';
import { getDb } from '../../db.js';

/** Preserves the current Saga 2 repository-checkout resolution order. */
export class SqliteWorkspaceResolver implements WorkspaceResolver {
  resolve(projectId: number): WorkspaceResolution {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) return { projectExists: false, workspaceRoot: null };

    const rows = db.prepare(
      `SELECT pr.id, r.name, COALESCE(rc.local_path, pr.local_path) AS local_path
       FROM project_repositories pr
       JOIN repositories r ON r.id=pr.repository_id
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
       WHERE pr.project_id=? AND pr.status='active'
       ORDER BY pr.id`,
    ).all(os.hostname(), projectId) as Array<{
      id: number;
      name: string;
      local_path: string | null;
    }>;

    const workspaceRoot = rows.find(row => row.local_path && existsSync(row.local_path))
      ?.local_path ?? null;
    return { projectExists: true, workspaceRoot };
  }
}
