export type BoardTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'review_in_progress'
  | 'done'
  | 'blocked';

export interface BoardProjectSummary {
  id: number;
  name: string;
  status: string;
  total: number;
  in_progress: number;
  reviewing: number;
  color?: string;
  [key: string]: unknown;
}

export interface BoardEpicProjection {
  id: number;
  name: string;
  project_id: number;
  episode_stage: string | null;
  gate_error: string | null;
  needs_human: number | null;
  pause_reason: string | null;
  drift_count: number;
  evidence_count: number;
  [key: string]: unknown;
}

export interface BoardTaskProjection {
  id: number;
  epic_id: number;
  title: string;
  status: BoardTaskStatus;
  task_kind: string | null;
  workflow_stage: string | null;
  execution_skill: string | null;
  execution_mode: string | null;
  assigned_to: string | null;
  integration_state: string | null;
  blocked_reason: string | null;
  repository_name: string | null;
  [key: string]: unknown;
}

/**
 * Compatibility shape of tracker-view's current loadBoard() result.
 * The empty case intentionally omits epics/tasks, matching the existing HTTP
 * implementation rather than inventing a cleaner but incompatible shape.
 */
export interface ProjectBoardProjection {
  empty?: boolean;
  reason?: 'no-epics';
  epics?: BoardEpicProjection[];
  epicById?: Record<number, BoardEpicProjection>;
  tasks?: BoardTaskProjection[];
}

/** Read-only administrative view consumed by tracker/frontends. */
export interface BoardProjectionReader {
  listProjects(): BoardProjectSummary[];
  loadProjectBoard(projectId: number): ProjectBoardProjection;
}
