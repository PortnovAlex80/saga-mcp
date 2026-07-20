/**
 * Cross-process advisory filesystem lock for repository-scoped operations.
 *
 * Source: ADR-013 Phase 2.1 (docs/architecture/decisions/013-lifecycle-fix-execution-plan.md).
 *
 * Why: saga-mcp runs as multiple OS processes — one per worker (see the
 * comment at dispatcher.ts:1042: «несколько процессов saga-mcp обслуживают
 * разных воркеров параллельно»). Coordination between them happens via the
 * SQLite DB (serialized through BEGIN IMMEDIATE). But some operations touch
 * the filesystem OUTSIDE the DB tx — git operations on a shared worktree,
 * file mutations, integration-branch checkouts. The DB lock does not protect
 * those; we need a cross-process advisory lock keyed by repository path.
 *
 * Scope of THIS module: a thin per-repoPath advisory lock, used to serialize
 * filesystem operations on the SAME repository across processes. Different
 * repositories run fully in parallel — neither the DB lock nor this lock
 * touches them.
 *
 * What this does NOT solve (documented in ADR-013 §2.1 limitation): the
 * SQLite-level BEGIN IMMEDIATE still serializes all DB writers across ALL
 * repositories. Removing that requires sharding the DB per repository,
 * which is a separate large refactor outside ADR-013's scope. This module
 * narrows the filesystem-mutation window that used to be implicitly
 * "protected" only by the worker's good behaviour.
 *
 * Implementation: per-repoPath lock file with an exclusive hold for the
 * duration of the callback. On POSIX this would be flock(2); on Windows
 * (the primary saga-mcp platform per AGENTS.md) we use a sentinel file with
 * O_EXCL create-or-fail retry, since Node's fs has no flock binding.
 */

import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Where lock files live. ~/.saga/locks/<slugified-path>.lock */
function locksDir(): string {
  const dir = path.join(os.homedir(), '.saga', 'locks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Convert a repository local_path into a safe filename component. Avoids
 * path separators, colons (Windows drive letters), and other filesystem-
 * hostile characters. The slug is not reversible — it is only a stable
 * identifier for "the same repo path".
 */
function slugifyRepoPath(repoPath: string): string {
  // Replace anything that is not [a-zA-Z0-9._-] with '_'. This collapses
  // 'D:\foo\bar' and '/d/foo/bar' to the same shape only if they share
  // segments — which is the intent: same physical repo, same lock.
  return repoPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'repo';
}

function lockFilePath(repoPath: string): string {
  return path.join(locksDir(), `${slugifyRepoPath(repoPath)}.lock`);
}

/**
 * Run `fn` while holding an exclusive advisory lock on the given repoPath.
 * Blocks (with retry) until the lock is acquired. Releases the lock in a
 * finally block, even if fn throws.
 *
 * Lock-file protocol (cross-process safe on Windows + POSIX):
 *  - Acquire: O_EXCL create of `<path>.lock`. If it exists, retry after a
 *    short sleep. Stale locks (older than STALE_MS) are reclaimed by unlink.
 *  - Release: unlink the lock file.
 *  - The lock file contains a small payload (pid + timestamp) for diagnostics
 *    and staleness checks — but we do NOT rely on it for correctness (a
 *    crashed process leaves a stale file, which the next acquirer unlinks).
 *
 * Limitation: a crashed process leaves a stale lock file that the next
 * acquirer unlinks after STALE_MS. Until then, that repo's operations block.
 * This is intentional — better to block than to race.
 *
 * @param repoPath absolute path to the repository root
 * @param fn the filesystem operation to run under the lock
 * @returns whatever fn returns
 */
export function withRepositoryLock<T>(repoPath: string, fn: () => T): T {
  if (!repoPath) return fn();
  const lockPath = lockFilePath(repoPath);
  const STALE_MS = 10 * 60 * 1000; // 10 min — same as MERGE_LOCK_STALE_MIN
  const RETRY_MS = 200;
  const MAX_WAIT_MS = 60 * 1000; // 1 min hard cap — refuse to wait forever

  const startedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fd: number | null = null;
  while (fd === null) {
    try {
      // O_EXCL create — atomic cross-process "I won" check.
      fd = openSync(lockPath, 'wx');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // File exists. If it is stale (older than STALE_MS), reclaim it.
      if (existsSync(lockPath)) {
        let stat: { mtimeMs: number } | null = null;
        try {
          stat = statSync(lockPath);
        } catch {
          stat = null;
        }
        if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
          // Stale — unlink and retry create on the next loop iteration.
          try { unlinkSync(lockPath); } catch { /* raced — someone else unlinked */ }
          continue;
        }
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error(
          `Repository lock for ${repoPath} (${lockPath}) could not be acquired ` +
          `within ${MAX_WAIT_MS}ms. Another saga process may be stuck. ` +
          `If you are sure no other process is operating on this repo, ` +
          `delete the lock file manually.`,
        );
      }
      // Sleep synchronously — we are already inside a sync operation.
      const deadline = Date.now() + RETRY_MS;
      while (Date.now() < deadline) { /* busy wait — short */ }
    }
  }

  try {
    // Write a small payload for diagnostics (who holds it, since when).
    // Best-effort; failures here do not affect lock correctness.
    try {
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        repo: repoPath,
        acquired_at: new Date().toISOString(),
      }));
    } catch { /* ignore — lock file is held regardless */ }

    return fn();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* someone else may have unlinked a stale copy */ }
  }
}
