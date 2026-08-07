import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';

import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

/**
 * Runtime-owned integration effect for an accepted git-changing Workplace.
 * The LM produces and reviews a source commit; this adapter alone mutates the
 * integration branch and records the observed result.
 */
export interface SqliteProductionCellIntegrationInput {
  readonly workplaceRef: import('../../process-modules/domain/workplace/workplace-ref.js').WorkplaceRef;
  readonly processRunId: number;
  readonly expectedProductSchema: string;
}

export class SqliteProductionCellIntegration {
  constructor(private readonly db: Database.Database) {}

  integrateAcceptedWorkplace(input: SqliteProductionCellIntegrationInput): void {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    // Repository Desk consistency fix: use COALESCE(rc.local_path, pr.local_path)
    // so the integration operates on the SAME machine-specific checkout that the
    // worker used (and that the dispatcher/freeze use). The previous raw
    // pr.local_path could point at a stale directory when a per-machine
    // repository_checkouts override was active.
    const task = this.db.prepare(
      `SELECT t.id,t.integration_state,t.project_repository_id,t.metadata,
              COALESCE(rc.local_path, pr.local_path) AS local_path,
              pr.integration_branch,
              s.payload_snapshot
         FROM tasks t
         JOIN project_repositories pr ON pr.id=t.project_repository_id
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
         JOIN factory_managed_node_submissions s
           ON s.task_id=t.id AND s.process_run_id=? AND s.schema_version=?
        WHERE t.workplace_ref=? AND t.execution_mode='git_change'
        ORDER BY s.id DESC LIMIT 1`,
    ).get(input.processRunId, input.expectedProductSchema, workplace) as {
      id: number;
      integration_state: string;
      project_repository_id: number;
      local_path: string;
      integration_branch: string;
      payload_snapshot: string;
      metadata: string;
    } | undefined;
    if (!task) return;
    if (task.integration_state === 'merged') return;
    const payload = JSON.parse(task.payload_snapshot) as {
      workItemKey?: unknown;
      terminalStatus?: unknown;
      source?: { branch?: unknown; commitSha?: unknown; workItemKey?: unknown };
      snapshot?: { commitSha?: unknown; treeSha?: unknown };
      repository?: { projectRepositoryId?: unknown; integrationBranch?: unknown };
    };
    const sourceCommit = payload.source?.commitSha;
    const sourceBranch = payload.source?.branch;
    if (
      payload.terminalStatus !== 'complete'
      || typeof payload.workItemKey !== 'string'
      || typeof sourceCommit !== 'string' || !sourceCommit
      || typeof sourceBranch !== 'string' || !sourceBranch
      || payload.source?.workItemKey !== payload.workItemKey
      || payload.snapshot?.commitSha !== sourceCommit
      || typeof payload.snapshot?.treeSha !== 'string'
      || payload.repository?.projectRepositoryId !== task.project_repository_id
      || payload.repository?.integrationBranch !== task.integration_branch
    ) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING: task ${task.id}`);
    }
    const source = git(task.local_path, [
      'rev-parse', `${sourceCommit}^{commit}`,
    ]);
    const branchHead = git(task.local_path, ['rev-parse', `refs/heads/${sourceBranch}`]);
    const sourceTree = git(task.local_path, ['rev-parse', `${sourceCommit}^{tree}`]);
    if (
      source !== sourceCommit
      || branchHead !== sourceCommit
      || sourceTree !== payload.snapshot.treeSha
    ) {
      throw new Error(
        `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task ${task.id} submitted `
        + `${sourceCommit} but branch is ${branchHead ?? 'missing'}`,
      );
    }
    const review = this.db.prepare(
      `SELECT s.payload_snapshot
         FROM tasks t
         JOIN factory_managed_node_submissions s ON s.task_id=t.id
        WHERE t.workplace_ref=?
          AND s.process_run_id=?
          AND s.schema_version='factory.development-review-verdict.v1'
        ORDER BY s.id DESC LIMIT 1`,
    ).get(workplace, input.processRunId) as { payload_snapshot: string } | undefined;
    const reviewPayload = review
      ? JSON.parse(review.payload_snapshot) as {
          verdict?: unknown;
          workItemKey?: unknown;
          reviewedCandidate?: { sourceCommit?: unknown; sourceTree?: unknown };
        }
      : null;
    if (
      reviewPayload?.verdict !== 'approved'
      || reviewPayload.workItemKey !== payload.workItemKey
      || reviewPayload.reviewedCandidate?.sourceCommit !== sourceCommit
      || reviewPayload.reviewedCandidate?.sourceTree !== sourceTree
    ) {
      throw new Error(`PRODUCTION_CELL_REVIEW_BINDING_INVALID: task ${task.id}`);
    }
    const checkout = spawnSync('git', [
      '-C', task.local_path, 'checkout', task.integration_branch,
    ], { encoding: 'utf8', windowsHide: true });
    if (checkout.status !== 0) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_CHECKOUT_FAILED: ${checkout.stderr.trim()}`);
    }
    const beforeHead = git(task.local_path, [
      'rev-parse', `refs/heads/${task.integration_branch}`,
    ]);
    if (!beforeHead) throw new Error(`PRODUCTION_CELL_INTEGRATION_TARGET_MISSING: ${task.integration_branch}`);
    const merge = spawnSync('git', [
      '-C', task.local_path, 'merge', '--no-ff',
      '-m', `factory: integrate task #${task.id}`, sourceCommit,
    ], { encoding: 'utf8', windowsHide: true });
    if (merge.status !== 0) {
      spawnSync('git', ['-C', task.local_path, 'merge', '--abort'], {
        encoding: 'utf8', windowsHide: true,
      });
      this.db.prepare(
        `UPDATE tasks SET integration_state='conflict',updated_at=datetime('now') WHERE id=?`,
      ).run(task.id);
      throw new Error(`PRODUCTION_CELL_INTEGRATION_CONFLICT: task ${task.id}`);
    }
    const afterHead = git(task.local_path, ['rev-parse', 'HEAD']);
    if (!afterHead || afterHead === beforeHead) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_RESULT_INVALID: task ${task.id}`);
    }
    this.db.prepare(
      `UPDATE tasks
          SET integration_state='merged',integrated_at=datetime('now'),
              integrated_commit=?,updated_at=datetime('now')
        WHERE id=?`,
    ).run(afterHead, task.id);
  }
}

function git(repositoryPath: string, args: readonly string[]): string | null {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}
