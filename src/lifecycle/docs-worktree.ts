/**
 * Docs worktree — git operations for branch-based documentation editing.
 *
 * Lifecycle of a docs edit session:
 *   1. createChange(repoPath, changeId, baseRef?) → creates `docs/<changeId>`
 *      branch + `.worktrees/docs-<changeId>` worktree.
 *   2. writeFile(worktreePath, relPath, content) → writes .md inside the
 *      worktree (path-traversal safe).
 *   3. commit(worktreePath, message) → commits the change.
 *   4. (Phase C) merge(repoPath, changeId, integrationBranch) → CAS-merge into
 *      the project's integration branch, then remove the worktree.
 *
 * Namespace isolation vs saga execution tasks:
 *   - task branches: `task/<id>`, worktrees `.worktrees/task-<id>` (workers).
 *   - docs branches: `docs/<id>`, worktrees `.worktrees/docs-<id>` (this module).
 * No overlap; parallel editing is safe.
 *
 * Git engine: child_process spawnSync against the system `git` CLI — same
 * approach as integration-executor.ts and helpers/git.ts. No JS-git lib.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DOCS_BRANCH_PREFIX = 'docs/';
export const DOCS_WORKTREE_DIR = '.worktrees';
export const DOCS_WORKTREE_PREFIX = 'docs-';

/** Spawn `git` in repoPath, return {ok, stdout, stderr}. Never throws. */
function git(repoPath: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    input,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    status: r.status,
  };
}

export interface DocsWorktree {
  changeId: string;
  branch: string;       // 'docs/<changeId>'
  worktreePath: string; // absolute path under repo/.worktrees/docs-<changeId>
  baseRef: string;      // base ref the branch was created from
  baseSha: string;      // resolved sha at creation time
  createdAt: string;    // ISO
}

export interface DocsChangeOptions {
  /** Base ref for the branch. Defaults to 'HEAD' of the current branch. */
  baseRef?: string;
  /** Override the auto-generated changeId (slug must match /^[a-z0-9-]+$/). */
  changeId?: string;
}

/**
 * Create a docs branch + worktree. Idempotent: if the worktree already exists
 * at the expected path, returns the existing record without recreating.
 */
export function createChange(
  repoPath: string,
  opts: DocsChangeOptions = {},
): DocsWorktree {
  const absoluteRepo = path.resolve(repoPath);
  if (!existsSync(absoluteRepo)) {
    throw new Error(`repository not found: ${absoluteRepo}`);
  }
  // Validate git repo.
  const rev = git(absoluteRepo, ['rev-parse', '--is-inside-work-tree']);
  if (!rev.ok) {
    throw new Error(`not a git repository: ${absoluteRepo} (${rev.stderr})`);
  }

  const baseRef = opts.baseRef || 'HEAD';
  const baseSha = git(absoluteRepo, ['rev-parse', baseRef]);
  if (!baseSha.ok) {
    throw new Error(`cannot resolve baseRef '${baseRef}': ${baseSha.stderr}`);
  }

  const changeId = opts.changeId || generateChangeId();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
    throw new Error(`changeId must match /^[a-z0-9][a-z0-9-]*$/: '${changeId}'`);
  }
  const branch = `${DOCS_BRANCH_PREFIX}${changeId}`;
  const worktreeName = `${DOCS_WORKTREE_PREFIX}${changeId}`;
  const worktreePath = path.join(absoluteRepo, DOCS_WORKTREE_DIR, worktreeName);

  // Idempotent: existing worktree → return as-is.
  if (existsSync(worktreePath) && existsSync(path.join(worktreePath, '.git'))) {
    return {
      changeId,
      branch,
      worktreePath,
      baseRef,
      baseSha: baseSha.stdout,
      createdAt: new Date().toISOString(),
    };
  }

  // Create branch (don't fail if it already exists, but ensure it points where
  // we expect — for an existing branch we honour the existing tip and don't
  // force-rewrite).
  const branchExists =
    git(absoluteRepo, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
  if (!branchExists) {
    const b = git(absoluteRepo, ['branch', branch, baseSha.stdout]);
    if (!b.ok) {
      throw new Error(`git branch ${branch} failed: ${b.stderr}`);
    }
  }

  // Create the worktree.
  const wt = git(absoluteRepo, [
    'worktree', 'add', '--force',
    worktreePath,
    branch,
  ]);
  if (!wt.ok) {
    // Clean up the branch we just created if worktree add failed.
    if (!branchExists) git(absoluteRepo, ['branch', '-D', branch]);
    throw new Error(`git worktree add failed: ${wt.stderr}`);
  }

  return {
    changeId,
    branch,
    worktreePath,
    baseRef,
    baseSha: baseSha.stdout,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Write a .md file inside a docs worktree. Path-traversal safe: the resolved
 * absolute path must stay under `worktreePath`.
 */
export function writeFile(
  worktreePath: string,
  relPath: string,
  content: string,
): string {
  const absolute = path.resolve(worktreePath, relPath);
  const prefix = worktreePath.endsWith(path.sep) ? worktreePath : worktreePath + path.sep;
  if (absolute !== worktreePath && !absolute.startsWith(prefix)) {
    throw new Error(`path escapes worktree root: ${relPath}`);
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return absolute;
}

/** Read a file inside a worktree. Returns null if missing. */
export function readFile(worktreePath: string, relPath: string): string | null {
  const absolute = path.resolve(worktreePath, relPath);
  const prefix = worktreePath.endsWith(path.sep) ? worktreePath : worktreePath + path.sep;
  if (absolute !== worktreePath && !absolute.startsWith(prefix)) {
    throw new Error(`path escapes worktree root: ${relPath}`);
  }
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf8');
}

/**
 * Stage all changes in the worktree and commit. No-op (returns null) when the
 * tree is clean.
 *
 * @returns the commit sha, or null when there was nothing to commit.
 */
export function commit(
  worktreePath: string,
  message: string,
): string | null {
  // Stage everything inside the worktree.
  const add = git(worktreePath, ['add', '-A']);
  if (!add.ok) {
    throw new Error(`git add failed: ${add.stderr}`);
  }
  // Detect clean tree.
  const clean = git(worktreePath, ['diff', '--cached', '--quiet']);
  if (clean.ok) return null; // exit 0 → nothing staged

  const c = git(worktreePath, ['commit', '-m', message]);
  if (!c.ok) {
    throw new Error(`git commit failed: ${c.stderr}`);
  }
  const sha = git(worktreePath, ['rev-parse', 'HEAD']);
  return sha.ok ? sha.stdout : null;
}

/**
 * Compute diff between the docs branch and its base.
 *
 * @returns `{ files: [{path, status}], patch: string }` — `patch` is the full
 * textual diff, `files` is a parsed name-status list.
 */
export function diffAgainstBase(
  repoPath: string,
  branch: string,
  baseSha: string,
): { files: Array<{ path: string; status: string }>; patch: string } {
  const nameStatus = git(repoPath, ['diff', '--name-status', `${baseSha}..${branch}`]);
  const files = nameStatus.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = /^([A-Z])\s+(.+)$/.exec(line);
      return m ? { status: m[1]!, path: m[2]! } : { status: '?', path: line };
    });
  const patch = git(repoPath, ['diff', `${baseSha}..${branch}`]).stdout;
  return { files, patch };
}

/** Resolve the current tip sha of a branch. Returns null if missing. */
export function branchHead(repoPath: string, branch: string): string | null {
  const r = git(repoPath, ['rev-parse', `refs/heads/${branch}`]);
  return r.ok ? r.stdout : null;
}

export interface DocsBranchInfo {
  changeId: string;
  branch: string;
  hasWorktree: boolean;
  worktreePath: string | null;
  head: string | null;
}

/**
 * List all docs branches under `docs/*`. Detects whether each has a worktree.
 */
export function listChanges(repoPath: string): DocsBranchInfo[] {
  const r = git(repoPath, ['branch', '--list', `${DOCS_BRANCH_PREFIX}*`]);
  if (!r.ok) return [];
  const branches = r.stdout
    .split(/\r?\n/)
    // Leading marker chars: '*' = current branch, '+' = checked-out in a
    // worktree, '-' = gone. Strip any of them plus whitespace.
    .map((l) => l.replace(/^[*+\-]\s+/, '').trim())
    .filter((l) => l.startsWith(DOCS_BRANCH_PREFIX));

  // Map worktrees back to branches via `git worktree list`.
  const wtRaw = git(repoPath, ['worktree', 'list', '--porcelain']);
  const wtByBranch = new Map<string, string>();
  let currentWt: { branch?: string; path?: string } = {};
  for (const line of wtRaw.stdout.split(/\r?\n/)) {
    if (line === '') {
      if (currentWt.branch && currentWt.path) {
        wtByBranch.set(currentWt.branch, currentWt.path);
      }
      currentWt = {};
      continue;
    }
    if (line.startsWith('worktree ')) currentWt.path = line.slice('worktree '.length);
    if (line.startsWith('branch ')) currentWt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
  }

  return branches.map((branch) => {
    const changeId = branch.slice(DOCS_BRANCH_PREFIX.length);
    const wt = wtByBranch.get(branch) || null;
    const head = branchHead(repoPath, branch);
    return {
      changeId,
      branch,
      hasWorktree: !!wt && existsSync(wt),
      worktreePath: wt,
      head,
    };
  });
}

/**
 * Remove a docs branch + its worktree. Cleans up both even if one is missing.
 * Safe to call on an already-removed change (idempotent).
 */
export function discardChange(repoPath: string, changeId: string): void {
  const branch = `${DOCS_BRANCH_PREFIX}${changeId}`;
  const worktreePath = path.join(
    path.resolve(repoPath),
    DOCS_WORKTREE_DIR,
    `${DOCS_WORKTREE_PREFIX}${changeId}`,
  );
  if (existsSync(worktreePath)) {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  }
  git(repoPath, ['branch', '-D', branch]);
}

/**
 * Auto-generate a changeId from the current timestamp.
 * Format: `doc-YYYYMMDD-HHMMSS-XXXX` (XXXX = 4 random hex chars).
 */
export function generateChangeId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `doc-${date}-${time}-${rand}`;
}

// ---------------------------------------------------------------------------
// Phase C: PR-like merge into the project integration branch.
// ---------------------------------------------------------------------------
//
// We deliberately do NOT reuse integration-executor.ts's `performMerge`. That
// module is tightly coupled to the `integration_intents` saga table and the
// CGAD integration flow — refactoring it would risk the regulated task-merge
// path that ships with saga-mcp. Instead we re-implement the same safe
// algorithm (observe → merge-tree --write-tree → commit-tree → CAS update-ref)
// tailored to docs changes, which carry no saga task id.
//
// Idempotency: if the branch tip is already an ancestor of the target, we
// report `already_merged` without touching history. Re-invoking merge on an
// already-merged branch is a no-op.

export type DocsMergeResult =
  | { kind: 'merged'; mergeCommitSha: string; targetBranch: string }
  | { kind: 'already_merged'; targetBranch: string }
  | { kind: 'conflict'; conflictFiles: string[]; targetBranch: string }
  | { kind: 'base_advanced'; observedTargetSha: string; expectedTargetSha: string }
  | { kind: 'source_missing'; branch: string }
  | { kind: 'git_error'; message: string };

export interface DocsMergeOptions {
  /**
   * Expected target sha (for CAS). If omitted, we read the current target sha
   * at observe time and use it as the expected value — this means a concurrent
   * advance between observe and merge will be caught and reported as
   * `base_advanced`. Pre-checking the sha from the UI diff preview and passing
   * it here makes the CAS stricter.
   */
  expectedTargetSha?: string;
  /**
   * If the integration branch does not exist, create it from this ref (e.g.
   * 'master' / 'main'). When omitted, a missing target returns git_error.
   */
  createTargetFromRef?: string;
}

/**
 * Merge `docs/<changeId>` into `integrationBranch` using the observe →
 * merge-tree → CAS pattern.
 *
 * @returns DocsMergeResult describing the outcome. Caller (HTTP layer) maps
 *          conflict/git_error to actionable UI responses.
 */
export function mergeDocsBranch(
  repoPath: string,
  changeId: string,
  integrationBranch: string,
  opts: DocsMergeOptions = {},
): DocsMergeResult {
  const absoluteRepo = path.resolve(repoPath);
  const branch = `${DOCS_BRANCH_PREFIX}${changeId}`;

  // 1. Observe source + target shas.
  const sourceSha = git(absoluteRepo, ['rev-parse', `refs/heads/${branch}`]);
  if (!sourceSha.ok) {
    return { kind: 'source_missing', branch };
  }
  const reviewedSourceSha = sourceSha.stdout;

  let observedTargetSha = git(absoluteRepo, ['rev-parse', `refs/heads/${integrationBranch}`]);
  if (!observedTargetSha.ok) {
    if (opts.createTargetFromRef) {
      const baseSha = git(absoluteRepo, ['rev-parse', opts.createTargetFromRef]);
      if (!baseSha.ok) {
        return {
          kind: 'git_error',
          message: `cannot create target from '${opts.createTargetFromRef}': ${baseSha.stderr}`,
        };
      }
      const created = git(absoluteRepo, ['branch', integrationBranch, baseSha.stdout]);
      if (!created.ok) {
        return {
          kind: 'git_error',
          message: `failed to create target branch '${integrationBranch}': ${created.stderr}`,
        };
      }
      observedTargetSha = git(absoluteRepo, ['rev-parse', `refs/heads/${integrationBranch}`]);
    }
    if (!observedTargetSha.ok) {
      return {
        kind: 'git_error',
        message: `target branch '${integrationBranch}' does not exist: ${observedTargetSha.stderr}`,
      };
    }
  }
  const targetSha = observedTargetSha.stdout;
  const expectedTargetSha = opts.expectedTargetSha || targetSha;

  // If caller-supplied expected sha differs from observed, the base already
  // advanced since the UI rendered the diff — refuse to blind-merge.
  if (opts.expectedTargetSha && opts.expectedTargetSha !== targetSha) {
    return {
      kind: 'base_advanced',
      observedTargetSha: targetSha,
      expectedTargetSha: opts.expectedTargetSha,
    };
  }

  // 2. Idempotency: source already an ancestor of target.
  const anc = git(absoluteRepo, ['merge-base', '--is-ancestor', reviewedSourceSha, targetSha]);
  if (anc.ok) {
    return { kind: 'already_merged', targetBranch: integrationBranch };
  }

  // 3. Run merge-tree (no working-tree touched, no refs moved).
  const mergeTree = git(absoluteRepo, [
    'merge-tree', '--write-tree', '--messages', '--no-messages',
    expectedTargetSha, reviewedSourceSha,
  ]);

  if (mergeTree.status === 0) {
    const lines = (mergeTree.stdout || '').split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { kind: 'git_error', message: 'merge-tree produced no output' };
    }
    const treeSha = lines[0]!;

    // 4. Build the commit with both parents + a saga-docs trailer.
    const commitMsg = [
      `Merge docs/${changeId} into ${integrationBranch}`,
      '',
      `Saga-Docs-Change: ${changeId}`,
      `Saga-Reviewed-Source: ${reviewedSourceSha}`,
      `Saga-Target-Branch: ${integrationBranch}`,
      '',
    ].join('\n');
    const commit = git(absoluteRepo, [
      'commit-tree', treeSha,
      '-p', expectedTargetSha,
      '-p', reviewedSourceSha,
      '-F', '-',
    ], commitMsg);
    if (!commit.ok) {
      return { kind: 'git_error', message: `commit-tree failed: ${commit.stderr}` };
    }
    const mergeSha = commit.stdout;

    // 5. CAS: advance target only if it still equals expectedTargetSha.
    const cas = git(absoluteRepo, [
      'update-ref',
      `refs/heads/${integrationBranch}`,
      mergeSha,
      expectedTargetSha,
    ]);
    if (!cas.ok) {
      // Target advanced between observe and CAS. Re-observe; caller reconciles.
      const newTarget = git(absoluteRepo, ['rev-parse', `refs/heads/${integrationBranch}`]);
      return {
        kind: 'base_advanced',
        observedTargetSha: newTarget.ok ? newTarget.stdout : '(missing)',
        expectedTargetSha,
      };
    }
    return { kind: 'merged', mergeCommitSha: mergeSha, targetBranch: integrationBranch };
  }

  // Exit 1 from merge-tree = conflict; stdout lists conflicts after tree sha.
  if (mergeTree.status === 1) {
    const lines = (mergeTree.stdout || '').split('\n').filter(Boolean);
    const paths = new Set<string>();
    for (const line of lines.slice(1)) {
      const tabIdx = line.indexOf('\t');
      const p = tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
      if (p) paths.add(p);
    }
    return {
      kind: 'conflict',
      conflictFiles: [...paths],
      targetBranch: integrationBranch,
    };
  }

  // 128/129 — bad refs or unsupported flag.
  return {
    kind: 'git_error',
    message: `merge-tree exited ${mergeTree.status}: ${mergeTree.stderr}`,
  };
}

/**
 * Return the list of files changed between two commit shas. After a docs
 * merge, pass `(repoPath, mergeSha + '^1', mergeSha)` to get exactly what
 * the merged branch contributed to the integration branch.
 */
export function filesTouchedBetween(
  repoPath: string,
  fromSha: string,
  toSha: string,
): string[] {
  const r = git(repoPath, ['diff', '--name-only', `${fromSha}..${toSha}`]);
  return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}
