import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EngineLockAcquisition,
  WorkerHostContext,
  WorkerHostRuntime,
  WorkerRuntimePaths,
} from '../../application/ports/worker-host-runtime.js';

export interface NodeWorkerHostRuntimeOptions {
  processId?: number;
  homeDirectory?: string;
  workerPaths?: Partial<WorkerRuntimePaths>;
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

/** Node/filesystem implementation of the worker host boundary. */
export class NodeWorkerHostRuntime implements WorkerHostRuntime {
  readonly processId: number;
  readonly workerPaths: WorkerRuntimePaths;

  private readonly homeDirectory: string;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly processAlive: (pid: number) => boolean;

  constructor(options: NodeWorkerHostRuntimeOptions = {}) {
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

  heartbeat(context: WorkerHostContext, event: string, message: string): void {
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

  acquireEngineLock(context: WorkerHostContext): EngineLockAcquisition {
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

  releaseEngineLock(context: WorkerHostContext): void {
    const lockFile = this.lockFile(context);
    try {
      if (!existsSync(lockFile)) return;
      const ownerPid = parsePid(readFileSync(lockFile, 'utf8'));
      if (ownerPid === this.processId) unlinkSync(lockFile);
    } catch {
      // Best-effort cleanup; a stale lock is recovered on the next acquire.
    }
  }

  private lockFile(context: WorkerHostContext): string {
    return path.join(
      this.homeDirectory,
      '.zcode',
      'cli',
      `engine-${context.projectId}-${context.epicId}.pid`,
    );
  }
}
