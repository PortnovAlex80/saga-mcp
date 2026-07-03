import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

function repoDir(): string {
  const dbPath = process.env.DB_PATH;
  return dbPath ? dirname(dbPath) : process.cwd();
}

/**
 * Returns the current git branch of the repo holding the tracker DB.
 *
 * No caching: a single saga-mcp process can serve multiple workers that each
 * operate in their own worktree (different branches). A process-global cache
 * (the old `let cached`) would return the first worker's branch to all the
 * others, poisoning dispatcher branch logic. `git rev-parse` is cheap enough
 * to call per-tool-invocation.
 */
export function getCurrentBranch(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

export function resolveBranch(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === '') return null;
  if (typeof input !== 'string') return undefined;
  if (input === 'current') return getCurrentBranch();
  return input;
}
