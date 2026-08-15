// tests/factory-temporal/lib/cleanup.mjs
//
// Deterministic resource lifecycle for temporal tests.
// Every process, worktree, database, and temporary directory registered
// here is cleaned up even after a failed assertion. The registry attaches
// process-exit handlers so a thrown AssertionError inside node:test still
// runs finalization.

import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * One global resource registry per process. Temporal tests register
 * databases, git repos, child processes, and timers; the registry
 * guarantees cleanup on both normal completion and assertion failure.
 */
export class TemporalResourceRegistry {
  constructor() {
    this._dirs = [];
    this._processes = [];
    this._timers = [];
    this._finalizers = [];
    this._finalized = false;
  }

  /** Register a temp directory for recursive removal. */
  trackDir(dirPath) {
    this._dirs.push(dirPath);
    return dirPath;
  }

  /** Register a child process for SIGTERM + wait. */
  trackProcess(child, label = 'unnamed') {
    this._processes.push({ child, label });
    return child;
  }

  /** Register a timer for clear. */
  trackTimer(timer) {
    this._timers.push(timer);
    return timer;
  }

  /** Register an arbitrary async cleanup function. */
  trackFinalizer(fn, label) {
    this._finalizers.push({ fn, label: label || 'finalizer' });
  }

  /**
   * Run all finalizers synchronously, then kill processes, clear timers,
   * then remove directories. Safe to call multiple times.
   */
  finalizeSync() {
    if (this._finalized) return;
    this._finalized = true;

    // Clear timers first — prevents scheduled callbacks during cleanup.
    for (const timer of this._timers) {
      try { clearTimeout(timer); } catch {}
      try { clearInterval(timer); } catch {}
    }
    this._timers = [];

    // Kill tracked child processes.
    for (const { child, label } of this._processes) {
      try {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
      } catch (error) {
        process.stderr.write(`[cleanup] failed to kill ${label}: ${error.message}\n`);
      }
    }
    this._processes = [];

    // Remove tracked directories.
    for (const dir of this._dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    this._dirs = [];
  }

  async finalize() {
    if (this._finalized) return;
    if (process.env.SAGA_KEEP_TEMP === '1') {
      process.stderr.write(`[cleanup] preserving temporal resources: ${this._dirs.join(', ')}\n`);
      this._finalized = true;
      return;
    }
    // Run registered finalizers first (DB closes, worktree removal).
    for (const { fn, label } of this._finalizers) {
      try { await fn(); } catch (error) {
        process.stderr.write(`[cleanup] finalizer '${label}' failed: ${error.message}\n`);
      }
    }
    this._finalizers = [];
    this.finalizeSync();
  }
}

/**
 * Create a registry and attach it to a test context. Returns the registry
 * and a cleanup function to call in `finally`.
 *
 * Usage:
 *   const registry = createRegistry();
 *   try {
 *     // ... test body, register resources ...
 *   } finally {
 *     await cleanupRegistry(registry);
 *   }
 */
export function createRegistry() {
  const registry = new TemporalResourceRegistry();
  // Safety net: if the test process exits without calling finalize,
  // best-effort synchronous cleanup.
  const exitHandler = () => registry.finalizeSync();
  process.once('exit', exitHandler);
  process.once('SIGTERM', exitHandler);
  process.once('SIGINT', exitHandler);
  registry.trackFinalizer(async () => {
    process.removeListener('exit', exitHandler);
    process.removeListener('SIGTERM', exitHandler);
    process.removeListener('SIGINT', exitHandler);
  }, 'remove-exit-handler');
  return registry;
}

export async function cleanupRegistry(registry) {
  await registry.finalize();
}

/**
 * Kill any orphaned node.exe processes spawned by a test run.
 * Windows-safe: uses taskkill //F //PID.
 */
export function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already dead */ }
}
