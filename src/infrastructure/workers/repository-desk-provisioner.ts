/**
 * RepositoryDeskProvisioner — the SINGLE place in the runtime that runs
 * `git worktree`. Creates the physical git execution environment for a worker
 * BEFORE the worker process is spawned.
 *
 * The factory (not the LM) decides:
 *   - which repository
 *   - which branch (task/<id> for author, detached for reviewer/verifier)
 *   - which base commit to start from
 *
 * The worker is a temporary visitor in a pre-prepared desk. It must not create
 * worktrees, switch branches, or choose a starting commit.
 *
 * All methods are IDEMPOTENT: if a worktree already exists at the expected path
 * and points at the expected branch/commit, it is reused. This is critical for
 * retry-after-crash scenarios where the desk was provisioned but the worker
 * died before completing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryDesk, RepositoryDeskRole } from '../../process-modules/application/repository-desk.js';

export interface AuthorDeskInput {
  readonly repositoryRoot: string;
  readonly taskId: number;
  readonly integrationBranch: string;
  /** The commit to base the task branch on. If null, uses integration branch HEAD. */
  readonly baseCommit?: string | null;
  readonly projectRepositoryId: number;
  /** When present, branch HEAD must still equal this value around provisioning. */
  readonly expectedIntegrationHead?: string | null;
  readonly effectiveBaseReceiptRef?: string;
  readonly effectiveBaseReceiptDigest?: string;
}

export interface ReviewerDeskInput {
  readonly repositoryRoot: string;
  readonly taskId: number;
  /** The frozen CandidateSet source commit to review. */
  readonly sourceCommit: string;
  readonly projectRepositoryId: number;
  readonly integrationBranch: string;
}

export interface VerifierDeskInput {
  readonly repositoryRoot: string;
  readonly taskId: number;
  /** The frozen IntegratedCandidate commit to verify. */
  readonly integratedCommit: string;
  readonly projectRepositoryId: number;
  readonly integrationBranch: string;
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `git ${args.join(' ')} failed (status=${result.status}) in ${repoRoot}: ${stderr}`,
    );
  }
  return result.stdout.trim();
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function worktreeBranchName(taskId: number): string {
  return `task/${taskId}`;
}

function worktreePath(repoRoot: string, taskId: number, suffix: string): string {
  return path.join(repoRoot, '.worktrees', `${suffix}-${taskId}`);
}

/**
 * Check if a worktree already exists at the given path and is on the expected
 * branch/commit. Returns true if reusable, false if it needs (re)creation.
 */
function isWorktreeOnBranch(worktreeDir: string, expectedBranch: string): boolean {
  if (!existsSync(worktreeDir)) return false;
  try {
    const currentBranch = git(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return currentBranch === expectedBranch;
  } catch {
    return false;
  }
}

function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', repositoryRoot, 'merge-base', '--is-ancestor', ancestor, descendant],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return result.status === 0;
}

function isWorktreeDetachedAt(worktreeDir: string, expectedCommit: string): boolean {
  if (!existsSync(worktreeDir)) return false;
  try {
    const head = git(worktreeDir, ['rev-parse', 'HEAD']);
    return head === expectedCommit;
  } catch {
    return false;
  }
}

export class RepositoryDeskProvisioner {
  /**
   * Provision a writable author desk: a worktree on `task/<id>` based on the
   * integration branch's frozen commit. The worker commits here and reports
   * `source.branch = task/<id>` + `source.commitSha`.
   */
  provisionAuthorDesk(input: AuthorDeskInput): RepositoryDesk {
    const { repositoryRoot, taskId, integrationBranch, projectRepositoryId } = input;
    const branch = worktreeBranchName(taskId);
    const worktreeDir = worktreePath(repositoryRoot, taskId, 'task');

    // Resolve the base commit: explicit override or integration branch HEAD.
    const baseCommit = input.baseCommit
      ? input.baseCommit
      : git(repositoryRoot, ['rev-parse', `refs/heads/${integrationBranch}`]);

    const assertIntegrationHead = (): void => {
      if (!input.expectedIntegrationHead) return;
      const actual = git(repositoryRoot, ['rev-parse', `refs/heads/${integrationBranch}`]);
      if (actual !== input.expectedIntegrationHead) {
        throw new Error(
          `REPOSITORY_DESK_INTEGRATION_HEAD_DRIFT: expected `
          + `${input.expectedIntegrationHead}, got ${actual}`,
        );
      }
    };
    assertIntegrationHead();

    // Idempotent: if worktree exists and is on the right branch, reuse it.
    if (isWorktreeOnBranch(worktreeDir, branch)) {
      const headCommit = this.readHeadCommit(worktreeDir);
      if (!headCommit || !isAncestor(repositoryRoot, baseCommit, headCommit)) {
        throw new Error(
          `REPOSITORY_DESK_BASE_MISMATCH: existing ${branch} at `
          + `${headCommit ?? '<missing>'} does not descend from ${baseCommit}`,
        );
      }
      assertIntegrationHead();
      return this.buildDesk(
        projectRepositoryId, repositoryRoot, worktreeDir, 'author',
        branch, baseCommit, headCommit, integrationBranch, false,
        input.effectiveBaseReceiptRef,
        input.effectiveBaseReceiptDigest,
        input.expectedIntegrationHead ?? undefined,
      );
    }

    // Worktree exists but on wrong branch — prune and recreate.
    if (existsSync(worktreeDir)) {
      git(repositoryRoot, ['worktree', 'remove', '--force', worktreeDir]);
    }

    // Create the worktree with a new branch based on the frozen commit.
    // If the branch already exists (from a prior attempt), use --force to
    // re-checkout it at the correct base.
    try {
      git(repositoryRoot, [
        'worktree', 'add', '-b', branch, worktreeDir, baseCommit,
      ]);
    } catch (error) {
      // Branch may already exist from a prior run; try force checkout of existing branch.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('already used')) {
        const existingHead = git(repositoryRoot, ['rev-parse', `refs/heads/${branch}`]);
        if (!isAncestor(repositoryRoot, baseCommit, existingHead)) {
          throw new Error(
            `REPOSITORY_DESK_BASE_MISMATCH: existing ${branch} at ${existingHead} `
            + `does not descend from ${baseCommit}`,
          );
        }
        git(repositoryRoot, [
          'worktree', 'add', '--force', worktreeDir, branch,
        ]);
      } else {
        throw error;
      }
    }

    const headCommit = this.readHeadCommit(worktreeDir);
    if (!headCommit || !isAncestor(repositoryRoot, baseCommit, headCommit)) {
      throw new Error(
        `REPOSITORY_DESK_BASE_MISMATCH: provisioned ${branch} at `
        + `${headCommit ?? '<missing>'} does not descend from ${baseCommit}`,
      );
    }
    assertIntegrationHead();
    return this.buildDesk(
      projectRepositoryId, repositoryRoot, worktreeDir, 'author',
      branch, baseCommit, headCommit, integrationBranch, false,
      input.effectiveBaseReceiptRef,
      input.effectiveBaseReceiptDigest,
      input.expectedIntegrationHead ?? undefined,
    );
  }

  /**
   * Provision a read-only reviewer desk: a detached worktree at the frozen
   * CandidateSet source commit. The reviewer reads exactly what the author
   * produced.
   */
  provisionReviewerDesk(input: ReviewerDeskInput): RepositoryDesk {
    const { repositoryRoot, taskId, sourceCommit, projectRepositoryId, integrationBranch } = input;
    const worktreeDir = worktreePath(repositoryRoot, taskId, `review-${shortSha(sourceCommit)}`);

    if (!isWorktreeDetachedAt(worktreeDir, sourceCommit)) {
      if (existsSync(worktreeDir)) {
        git(repositoryRoot, ['worktree', 'remove', '--force', worktreeDir]);
      }
      git(repositoryRoot, [
        'worktree', 'add', '--detach', worktreeDir, sourceCommit,
      ]);
    }

    return this.buildDesk(
      projectRepositoryId, repositoryRoot, worktreeDir, 'reviewer',
      '', sourceCommit, sourceCommit, integrationBranch, true,
    );
  }

  /**
   * Provision a read-only verifier desk: a detached worktree at the frozen
   * IntegratedCandidate commit. The verifier tests exactly the integrated state.
   */
  provisionVerifierDesk(input: VerifierDeskInput): RepositoryDesk {
    const { repositoryRoot, taskId, integratedCommit, projectRepositoryId, integrationBranch } = input;
    const worktreeDir = worktreePath(repositoryRoot, taskId, `verify-${shortSha(integratedCommit)}`);

    if (!isWorktreeDetachedAt(worktreeDir, integratedCommit)) {
      if (existsSync(worktreeDir)) {
        git(repositoryRoot, ['worktree', 'remove', '--force', worktreeDir]);
      }
      git(repositoryRoot, [
        'worktree', 'add', '--detach', worktreeDir, integratedCommit,
      ]);
    }

    return this.buildDesk(
      projectRepositoryId, repositoryRoot, worktreeDir, 'verifier',
      '', integratedCommit, integratedCommit, integrationBranch, true,
    );
  }

  /**
   * Remove a worktree after the worker is done (optional cleanup). Safe to call
   * even if the worktree was already removed.
   */
  disposeDesk(executionPath: string, repositoryRoot: string): void {
    try {
      if (existsSync(executionPath)) {
        git(repositoryRoot, ['worktree', 'remove', '--force', executionPath]);
      }
    } catch {
      // Best-effort cleanup; a stale worktree is not a failure.
    }
  }

  private readHeadCommit(worktreeDir: string): string | null {
    try {
      const head = git(worktreeDir, ['rev-parse', 'HEAD']);
      return head || null;
    } catch {
      return null;
    }
  }

  private buildDesk(
    projectRepositoryId: number,
    repositoryRoot: string,
    executionPath: string,
    role: RepositoryDeskRole,
    branch: string,
    baseCommit: string,
    headCommit: string | null,
    integrationBranch: string,
    detached: boolean,
    effectiveBaseReceiptRef?: string,
    effectiveBaseReceiptDigest?: string,
    observedIntegrationHead?: string,
  ): RepositoryDesk {
    return {
      projectRepositoryId,
      repositoryRoot,
      executionPath,
      role,
      git: {
        branch,
        baseCommit,
        headCommit,
        integrationBranch,
        detached,
        ...(effectiveBaseReceiptRef ? { effectiveBaseReceiptRef } : {}),
        ...(effectiveBaseReceiptDigest ? { effectiveBaseReceiptDigest } : {}),
        ...(observedIntegrationHead ? { observedIntegrationHead } : {}),
      },
    };
  }
}
