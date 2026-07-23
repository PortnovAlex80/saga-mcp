import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EngineLockAcquisition,
  Saga2HostContext,
  Saga2HostRuntime,
  Saga2WorkerRuntimePaths,
} from '../../application/ports/saga2-host-runtime.js';
import type { RateLimitTaskProjection } from '../../application/ports/saga2-runtime-persistence.js';

const RATE_LIMIT_LOG_TAIL_BYTES = 8192;
const RATE_LIMIT_PATTERN = /api_retry[^\n]*"error_status":429[^\n]*"error":"rate_limit"/;

export interface NodeSaga2HostRuntimeOptions {
  processId?: number;
  homeDirectory?: string;
  workerPaths?: Partial<Saga2WorkerRuntimePaths>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(value: string): number | null {
  const pid = Number.parseInt(value.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Node/filesystem implementation of the Saga 2 host boundary. */
export class NodeSaga2HostRuntime implements Saga2HostRuntime {
  readonly processId: number;
  readonly workerPaths: Saga2WorkerRuntimePaths;

  private readonly homeDirectory: string;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly processAlive: (pid: number) => boolean;

  constructor(options: NodeSaga2HostRuntimeOptions = {}) {
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    this.processId = options.processId ?? process.pid;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.nowFn = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.processAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.workerPaths = {
      sagaEntry: options.workerPaths?.sagaEntry
        ?? path.resolve(dirname, '..', '..', 'index.js'),
      sagaSkillRoot: options.workerPaths?.sagaSkillRoot
        ?? path.resolve(dirname, '..', '..', '..', 'skills'),
      logRoot: options.workerPaths?.logRoot,
      heartbeatLog: options.workerPaths?.heartbeatLog,
    };
  }

  now(): number {
    return this.nowFn();
  }

  sleep(ms: number): Promise<void> {
    return this.sleepFn(ms);
  }

  heartbeat(context: Saga2HostContext, event: string, message: string): void {
    const line = [
      new Date(this.now()).toISOString(),
      `engine project=${context.projectId} epic=${context.epicId}`,
      event,
      message,
    ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
    const logPath = this.workerPaths.heartbeatLog
      ?? path.join(this.homeDirectory, '.zcode', 'cli', 'engine-heartbeat.log');
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, line);
    } catch {
      // Heartbeat output is observability only and must not stop the engine.
    }
  }

  acquireEngineLock(context: Saga2HostContext): EngineLockAcquisition {
    const lockFile = this.lockFile(context);
    try {
      if (existsSync(lockFile)) {
        const existingPid = parsePid(readFileSync(lockFile, 'utf8'));
        if (existingPid !== null && this.processAlive(existingPid)) {
          return { status: 'duplicate', ownerPid: existingPid };
        }
        try { unlinkSync(lockFile); } catch { /* race handled by atomic create */ }
      }

      mkdirSync(path.dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, String(this.processId), { encoding: 'utf8', flag: 'wx' });
      return { status: 'acquired', ownerPid: this.processId };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        let ownerPid: number | null = null;
        try { ownerPid = parsePid(readFileSync(lockFile, 'utf8')); } catch { /* unknown winner */ }
        return { status: 'duplicate', ownerPid };
      }
      return {
        status: 'unavailable',
        ownerPid: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  releaseEngineLock(context: Saga2HostContext): void {
    const lockFile = this.lockFile(context);
    try {
      if (!existsSync(lockFile)) return;
      const ownerPid = parsePid(readFileSync(lockFile, 'utf8'));
      if (ownerPid === this.processId) unlinkSync(lockFile);
    } catch {
      // Best-effort cleanup; a stale lock is recovered on the next acquire.
    }
  }

  scanRateLimitSignals(
    context: Saga2HostContext,
    tasks: readonly RateLimitTaskProjection[],
  ): number {
    let rateLimited = 0;
    for (const task of tasks) {
      const logPath = this.resolveWorkerLogPath(
        task.id,
        task.assigned_to,
        context.projectId,
      );
      if (!logPath || !existsSync(logPath)) continue;
      try {
        const stat = statSync(logPath);
        const tailBytes = Math.min(stat.size, RATE_LIMIT_LOG_TAIL_BYTES);
        if (tailBytes <= 0) continue;
        const fd = openSync(logPath, 'r');
        try {
          const buffer = Buffer.alloc(tailBytes);
          readSync(fd, buffer, 0, tailBytes, Math.max(0, stat.size - tailBytes));
          if (RATE_LIMIT_PATTERN.test(buffer.toString('utf8'))) rateLimited += 1;
        } finally {
          closeSync(fd);
        }
      } catch {
        // A concurrently rotating/missing log is simply absent telemetry.
      }
    }
    return rateLimited;
  }

  private lockFile(context: Saga2HostContext): string {
    return path.join(
      this.homeDirectory,
      '.zcode',
      'cli',
      `engine-${context.projectId}-${context.epicId}.pid`,
    );
  }

  private resolveWorkerLogPath(
    taskId: number,
    workerId: string,
    projectId: number,
  ): string | null {
    const logRoot = this.workerPaths.logRoot
      ?? path.join(this.homeDirectory, '.zcode', 'cli', 'board-runs');
    const safeWorker = workerId.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const fileName = `task-${taskId}-${safeWorker}.jsonl`;
    try {
      const directories = readdirSync(logRoot)
        .filter(directory => directory.startsWith(`board-${projectId}-`))
        .map(directory => ({
          full: path.join(logRoot, directory),
          mtime: statSync(path.join(logRoot, directory)).mtimeMs,
        }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const directory of directories) {
        const candidate = path.join(directory.full, fileName);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Missing/rotating log root means no rate-limit telemetry for this task.
    }
    return null;
  }
}
