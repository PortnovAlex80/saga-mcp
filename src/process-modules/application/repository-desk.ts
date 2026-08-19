/**
 * RepositoryDesk — the machine-provisioned git workspace for one worker spawn.
 *
 * The factory MUST provision the physical git execution environment BEFORE
 * hiring a worker. The worker is a temporary visitor: it must not choose a
 * repository, invent a branch, create a worktree, or decide which commit to
 * start from. All of that is infrastructure responsibility.
 *
 * Three role-dependent projections:
 *
 *   author   → writable worktree on `task/<id>` branch, based on the frozen
 *              integration-branch commit. The worker commits here; settlement
 *              verifies `refs/heads/task/<id>` points at the declared commit.
 *
 *   reviewer → read-only detached checkout of the frozen CandidateSet source
 *              commit. The reviewer reads exactly what the author produced,
 *              never a moving branch.
 *
 *   verifier → read-only detached checkout of the frozen IntegratedCandidate
 *              commit. The verifier tests exactly the integrated state, never
 *              a moving HEAD.
 *
 * This eliminates the class of errors where:
 *   - the model committed to the wrong branch
 *   - the reviewer reviewed a moving branch
 *   - verification tested a later HEAD
 *   - settlement saw a different SHA than the worker declared
 *
 * The desk is created by RepositoryDeskProvisioner (the single place that runs
 * `git worktree`) and carried into WorkplaceDesk.repositoryDesk, so the runner
 * can spawn the worker with `cwd = desk.executionPath` and the prompt can show
 * the exact machine-provisioned bindings.
 */
export type RepositoryDeskRole = 'author' | 'reviewer' | 'verifier';

export interface RepositoryDeskGit {
  /** Execution-scoped Factory branch for author; empty for detached desks. */
  readonly branch: string;
  /** The commit the desk was based on (integration branch HEAD for author). */
  readonly baseCommit: string;
  /** The HEAD commit after provisioning (null before any worker commit). */
  readonly headCommit: string | null;
  /** The integration branch (e.g. `dev`) that the author branch targets. */
  readonly integrationBranch: string;
  /** True for reviewer/verifier desks (detached HEAD). */
  readonly detached: boolean;
  /** Immutable Factory receipt that authorized this effective base. */
  readonly effectiveBaseReceiptRef?: string;
  readonly effectiveBaseReceiptDigest?: string;
  /** Integration head observed while the author base was frozen. */
  readonly observedIntegrationHead?: string;
}

/**
 * REPAIR-CODE-PRESERVATION — the rejected attempt's coordinates, delivered to
 * the repair author's desk as previous-attempt.{json,patch}. Provenance only:
 * the materials are a VIEW (git diff against the merge-base), never an
 * inherited base. See it, but do not be bound — no auto-merge, no rebase.
 */
export interface PreviousAttemptDeskMaterials {
  /** The shared-ref branch the rejected attempt committed to. */
  readonly branch: string;
  /** The frozen HEAD of that branch at rejection time. */
  readonly commitSha: string;
  /** merge-base(current frozen base, previous head) the diff was taken against. */
  readonly mergeBaseCommit: string;
  /** Directory receiving previous-attempt.{json,patch} (the execution workspace). */
  readonly patchDirectory: string;
}

export interface RepositoryDesk {
  /** The project_repositories.id this desk is bound to. */
  readonly projectRepositoryId: number;
  /** The main checkout path (where refs are visible — worktrees share refs). */
  readonly repositoryRoot: string;
  /** The physical path the worker process is spawned with as cwd. */
  readonly executionPath: string;
  /** The role this desk was provisioned for. */
  readonly role: RepositoryDeskRole;
  /** Frozen git state of the desk at provisioning time. */
  readonly git: RepositoryDeskGit;
  /** Present only on author desks provisioned as a repair attempt. */
  readonly previousAttempt?: PreviousAttemptDeskMaterials;
}
