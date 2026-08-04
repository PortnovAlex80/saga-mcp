import type {
  BoardProjectionReader,
  BoardProjectSummary,
  ProjectBoardProjection,
} from '../../application/ports/board-projection.js';

export interface LegacyBoardProjectionSource {
  listProjects(): BoardProjectSummary[];
  loadProjectBoard(projectId: number): ProjectBoardProjection;
}

/**
 * Compatibility adapter for the existing tracker SQL projection.
 *
 * It lets the frontend projection move behind a stable application port before
 * any HTTP or HTML rewrite. Existing tracker behavior remains the reference.
 */
export class LegacyBoardProjectionAdapter implements BoardProjectionReader {
  constructor(private readonly source: LegacyBoardProjectionSource) {}

  listProjects(): BoardProjectSummary[] {
    return this.source.listProjects();
  }

  loadProjectBoard(projectId: number): ProjectBoardProjection {
    return this.source.loadProjectBoard(projectId);
  }
}
