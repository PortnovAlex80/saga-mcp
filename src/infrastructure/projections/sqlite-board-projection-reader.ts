import Database from 'better-sqlite3';
import type {
  BoardEpicProjection,
  BoardProjectSummary,
  BoardProjectionReader,
  BoardTaskProjection,
  ProjectBoardProjection,
} from '../../application/ports/board-projection.js';

const PROJECT_COLORS = [
  '#4f8cff', '#16a085', '#e67e22', '#9b59b6', '#e74c3c',
  '#1abc9c', '#f39c12', '#34495e', '#2ecc71', '#e84393',
];

interface BoardProjectRow {
  id: number;
  name: string;
  status: string;
  total: number | null;
  in_progress: number | null;
  reviewing: number | null;
}

/**
 * Read-only adapter containing the tracker board SQL that is currently part of
 * tracker-view.mjs. It intentionally preserves query semantics and result
 * shapes so the HTTP/UI layer can later switch to this adapter without a
 * simultaneous frontend rewrite.
 */
export class SqliteBoardProjectionReader implements BoardProjectionReader {
  constructor(private readonly dbPath: string) {}

  listProjects(): BoardProjectSummary[] {
    return this.withDb(db => {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.status,
          COUNT(t.id) AS total,
          SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN t.status='review_in_progress' THEN 1 ELSE 0 END) AS reviewing
        FROM projects p
        LEFT JOIN epics e ON e.project_id = p.id
        LEFT JOIN tasks t ON t.epic_id = e.id
        WHERE p.status != 'archived'
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE
      `).all() as BoardProjectRow[];

      return rows.map((row, index): BoardProjectSummary => ({
        id: row.id,
        name: row.name,
        status: row.status,
        total: Number(row.total ?? 0),
        in_progress: Number(row.in_progress ?? 0),
        reviewing: Number(row.reviewing ?? 0),
        color: PROJECT_COLORS[index % PROJECT_COLORS.length],
      }));
    });
  }

  loadProjectBoard(projectId: number): ProjectBoardProjection {
    return this.withDb(db => {
      const epics = db.prepare(`
        SELECT e.id, e.name, e.project_id, ew.stage AS episode_stage,
          json_extract(ew.metadata,'$.last_gate_error') AS gate_error,
          json_extract(ew.metadata,'$.needs-human') AS needs_human,
          json_extract(ew.metadata,'$.pause_reason') AS pause_reason,
          (SELECT count(*) FROM artifacts a
            WHERE a.epic_id=e.id AND a.status='accepted' AND a.drift_state='drifted') AS drift_count,
          (SELECT count(*) FROM verification_evidence v
            JOIN artifacts a ON a.id=v.artifact_id
            WHERE a.epic_id=e.id AND v.outcome='passed') AS evidence_count
        FROM epics e
        LEFT JOIN episode_workflows ew ON ew.epic_id=e.id
        WHERE e.project_id=?
        ORDER BY e.id
      `).all(projectId) as BoardEpicProjection[];

      if (epics.length === 0) return { empty: true, reason: 'no-epics' };

      const epicIds = epics.map(epic => epic.id);
      const placeholders = epicIds.map(() => '?').join(',');
      const tasks = db.prepare(`
        SELECT t.*,
          (SELECT r.name
             FROM project_repositories pr
             JOIN repositories r ON r.id=pr.repository_id
            WHERE pr.id=t.project_repository_id) AS repository_name,
          (SELECT group_concat('#' || dep.id || ' ' ||
            CASE WHEN dep.status!='done' THEN dep.status ELSE dep.integration_state END, ', ')
             FROM task_dependencies d
             JOIN tasks dep ON dep.id=d.depends_on_task_id
            WHERE d.task_id=t.id AND (
              dep.status!='done' OR
              (dep.task_kind IS NOT NULL AND dep.execution_mode='git_change'
               AND dep.integration_state!='merged')
            )) AS blocked_reason
        FROM tasks t
        WHERE epic_id IN (${placeholders})
        ORDER BY sort_order, id
      `).all(...epicIds) as BoardTaskProjection[];

      const epicById = Object.fromEntries(
        epics.map(epic => [epic.id, epic]),
      ) as Record<number, BoardEpicProjection>;

      return { epics, epicById, tasks };
    });
  }

  private withDb<T>(operation: (db: Database.Database) => T): T {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
}
