import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isProcessAlive } from '../../worker-executions.js';
import {
  EngineAdministrationError,
  type EngineAdministration,
  type EngineStartCommand,
  type EngineStateSnapshot,
} from '../../application/ports/engine-administration.js';
import type { SagaRuntimeConfig } from '../../runtime/saga-runtime-config.js';

export interface LegacyEngineAdministrationOptions {
  config: SagaRuntimeConfig;
  baseEnv?: NodeJS.ProcessEnv;
  orchestrateCliPath?: string;
  spawnProcess?: typeof spawn;
  spawnProcessSync?: typeof spawnSync;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

interface PersistedEngineState {
  running: boolean;
  pid: number | null;
  concurrency: number | null;
  startedAt: string | null;
}

/**
 * Compatibility adapter for tracker-view's existing engine controls.
 *
 * Process-tree termination, detached CLI spawning and episode metadata stay
 * compatible in behavior, but the HTTP/frontend layer no longer owns them.
 */
export class LegacyEngineAdministration implements EngineAdministration {
  private readonly config: SagaRuntimeConfig;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly orchestrateCliPath: string;
  private readonly spawnProcess: typeof spawn;
  private readonly spawnProcessSync: typeof spawnSync;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  /**
   * Short-lived liveness cache keyed by `${projectId}:${epicId}`. The browser
   * polls /api/engine/status every ~2s; without this cache, Windows would spawn
   * a PowerShell subprocess on EVERY tick to verify the engine process tree,
   * flashing a console window even though `windowsHide:true` is set. The cache
   * throttles the expensive command-line verification so it runs at most once
   * per ALIVE_CACHE_MS, while the cheap `process.kill(pid,0)` path still runs
   * every call and clears the cache instantly when the process dies.
   */
  private readonly aliveCache = new Map<string, { at: number; alive: boolean }>();
  private static readonly ALIVE_CACHE_MS = 5000;

  constructor(options: LegacyEngineAdministrationOptions) {
    this.config = options.config;
    this.baseEnv = { ...(options.baseEnv ?? {}) };
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.spawnProcessSync = options.spawnProcessSync ?? spawnSync;
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;

    const here = path.dirname(fileURLToPath(import.meta.url));
    this.orchestrateCliPath = options.orchestrateCliPath
      ?? path.join(here, '..', '..', 'orchestrate-cli.js');
  }

  start(command: EngineStartCommand): EngineStateSnapshot {
    const projectId = this.projectIdForEpic(command.epicId);
    const persisted = this.readPersisted(command.epicId);
    const requested = Number(command.concurrency);
    const concurrency = Number.isInteger(requested) && requested >= 1 && requested <= 10
      ? requested
      : (Number(persisted.concurrency) || 4);

    this.killEngineTree(projectId, command.epicId);

    try {
      const cliArgs = [
        this.orchestrateCliPath,
        String(projectId),
        String(command.epicId),
        `--concurrency=${concurrency}`,
      ];
      if (command.lifecycleInputPath?.trim()) {
        cliArgs.push(`--lifecycle-input=${command.lifecycleInputPath.trim()}`);
      }
      if (command.idempotencyKey?.trim()) {
        cliArgs.push(`--idempotency-key=${command.idempotencyKey.trim()}`);
      }
      if (command.resumePaused) cliArgs.push('--resume');
      const child = this.spawnProcess(
        'node',
        cliArgs,
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...this.baseEnv,
            DB_PATH: this.config.dbPath,
            SAGA_ORCHESTRATION_MODE: this.config.orchestrationMode,
          },
        },
      );
      child.unref();
      const startedAt = this.timestamp();
      this.setMeta(command.epicId, {
        engine_running: 1,
        engine_pid: child.pid ?? null,
        engine_concurrency: concurrency,
        engine_started_at: startedAt,
      });
      return {
        projectId,
        epicId: command.epicId,
        running: true,
        alive: true,
        pid: child.pid ?? null,
        concurrency,
        startedAt,
      };
    } catch (error) {
      throw new EngineAdministrationError(
        'spawn_failed',
        `spawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stop(epicId: number): EngineStateSnapshot {
    const projectId = this.projectIdForEpic(epicId);
    this.killEngineTree(projectId, epicId);
    this.setMeta(epicId, {
      engine_running: 0,
      engine_stopped_at: this.timestamp(),
    });
    const persisted = this.readPersisted(epicId);
    return {
      projectId,
      epicId,
      running: false,
      alive: false,
      pid: persisted.pid,
      concurrency: persisted.concurrency,
      startedAt: persisted.startedAt,
    };
  }

  restart(command: EngineStartCommand): EngineStateSnapshot {
    return this.start(command);
  }

  setConcurrency(epicId: number, concurrency: number): EngineStateSnapshot {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw new EngineAdministrationError(
        'invalid_concurrency',
        'concurrency must be 1..10',
      );
    }
    const projectId = this.projectIdForEpic(epicId);
    this.setMeta(epicId, {
      engine_concurrency: concurrency,
      engine_concurrency_changed_at: this.timestamp(),
    });
    const persisted = this.readPersisted(epicId);
    return {
      projectId,
      epicId,
      running: persisted.running,
      alive: this.isEngineAlive(projectId, epicId),
      pid: persisted.pid,
      concurrency,
      startedAt: persisted.startedAt,
    };
  }

  status(epicId: number): EngineStateSnapshot {
    const projectId = this.projectIdForEpic(epicId);
    const persisted = this.readPersisted(epicId);
    const alive = this.isEngineAlive(projectId, epicId);
    if (persisted.running && !alive) {
      this.setMeta(epicId, { engine_running: 0 });
      persisted.running = false;
    }
    return {
      projectId,
      epicId,
      running: persisted.running,
      alive,
      pid: persisted.pid,
      concurrency: persisted.concurrency,
      startedAt: persisted.startedAt,
    };
  }

  dispose(): void {
    // Administration owns no long-lived handles.
  }

  private projectIdForEpic(epicId: number): number {
    if (!Number.isInteger(epicId) || epicId <= 0) {
      throw new EngineAdministrationError('invalid_epic', 'epic_id required');
    }
    return this.withDb(db => {
      const row = db.prepare(
        'SELECT project_id FROM epics WHERE id=?',
      ).get(epicId) as { project_id: number } | undefined;
      if (!row) {
        throw new EngineAdministrationError('epic_not_found', 'epic not found');
      }
      return row.project_id;
    });
  }

  private readPersisted(epicId: number): PersistedEngineState {
    return this.withDb(db => {
      const row = db.prepare(
        `SELECT json_extract(metadata, '$.engine_running') AS running,
                json_extract(metadata, '$.engine_pid') AS pid,
                json_extract(metadata, '$.engine_concurrency') AS concurrency,
                json_extract(metadata, '$.engine_started_at') AS started_at
           FROM episode_workflows WHERE epic_id=?`,
      ).get(epicId) as {
        running: number | boolean | null;
        pid: number | null;
        concurrency: number | null;
        started_at: string | null;
      } | undefined;
      return {
        running: row?.running === 1 || row?.running === true,
        pid: row?.pid ?? null,
        concurrency: row?.concurrency ?? null,
        startedAt: row?.started_at ?? null,
      };
    });
  }

  private setMeta(epicId: number, patch: Record<string, unknown>): void {
    this.withDb(db => {
      const current = db.prepare(
        'SELECT metadata FROM episode_workflows WHERE epic_id=?',
      ).get(epicId) as { metadata: string | null } | undefined;
      const metadata = JSON.parse(current?.metadata || '{}') as Record<string, unknown>;
      Object.assign(metadata, patch);
      db.prepare(
        `UPDATE episode_workflows
            SET metadata=?, updated_at=datetime('now')
          WHERE epic_id=?`,
      ).run(JSON.stringify(metadata), epicId);
    }, false);
  }

  private killEngineTree(projectId: number, epicId: number): void {
    try {
      if (this.platform === 'win32') {
        this.spawnProcessSync(
          'powershell',
          ['-Command',
            `function Get-Descendants($procId) { `
            + `  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId"; `
            + `  foreach ($k in $kids) { ,($k.ProcessId); Get-Descendants $k.ProcessId } `
            + `} ; `
            + `$toKill = @(); `
            + `$engines = Get-CimInstance Win32_Process -Filter "name='node.exe'" | `
            + `  Where-Object { $_.CommandLine -like '*orchestrate-cli.js ${projectId} ${epicId}*' }; `
            + `foreach ($e in $engines) { `
            + `  $toKill += $e.ProcessId; `
            + `  $toKill += Get-Descendants $e.ProcessId `
            + `} ; `
            + `$orphans = Get-CimInstance Win32_Process -Filter "name='claude.exe'" | `
            + `  Where-Object { $_.CommandLine -like '*project_id=${projectId}*' } ; `
            + `foreach ($o in $orphans) { $toKill += $o.ProcessId } ; `
            + `$toKill = $toKill | Sort-Object -Unique; `
            + `foreach ($p in $toKill) { taskkill /F /PID $p 2>$null }`],
          { encoding: 'utf8', windowsHide: true },
        );
        this.spawnProcessSync(
          'timeout',
          ['/T', '1', '/NOBREAK'],
          { encoding: 'utf8', stdio: 'ignore', windowsHide: true },
        );
      } else {
        this.spawnProcessSync(
          'pkill',
          ['-f', `orchestrate-cli.js ${projectId} ${epicId}`],
          { encoding: 'utf8' },
        );
      }
    } catch {
      // Existing behavior is best-effort: failure to find/kill is not fatal.
    }
  }

  private isEngineAlive(projectId: number, epicId: number): boolean {
    // Fast path: a cheap `process.kill(pid, 0)` check against the persisted
    // engine PID. This spawns NO subprocess on any platform, so it cannot flash
    // a console window on the browser's 2s status poll. If the PID is gone, the
    // engine is definitively dead — invalidate the throttle cache and return.
    const persisted = this.readPersisted(epicId);
    const fastAlive = isProcessAlive(persisted.pid);
    if (!fastAlive) {
      this.aliveCache.delete(this.aliveCacheKey(projectId, epicId));
      return false;
    }

    // The PID exists, but on Windows a PID can be reused by an unrelated
    // process after the engine died. Verify the command line, but throttle that
    // expensive verification so PowerShell spawns at most once per ALIVE_CACHE_MS
    // instead of on every poll tick. `process.kill(pid,0)` already proved the
    // PID is live, so a cached "alive" within the TTL is still correct.
    const cacheKey = this.aliveCacheKey(projectId, epicId);
    const cached = this.aliveCache.get(cacheKey);
    const nowMs = this.now().getTime();
    if (cached && nowMs - cached.at < LegacyEngineAdministration.ALIVE_CACHE_MS) {
      return cached.alive;
    }

    let verified: boolean = fastAlive;
    try {
      if (this.platform === 'win32') {
        const result = this.spawnProcessSync(
          'powershell',
          ['-Command',
            `$es = Get-CimInstance Win32_Process -Filter "name='node.exe'" | `
            + `  Where-Object { $_.CommandLine -like '*orchestrate-cli.js ${projectId} ${epicId}*' }; `
            + `if ($es) { 'alive' } else { 'dead' }`],
          { encoding: 'utf8', windowsHide: true },
        );
        verified = String(result.stdout || '').trim() === 'alive';
      } else {
        const result = this.spawnProcessSync(
          'pgrep',
          ['-f', `orchestrate-cli.js ${projectId} ${epicId}`],
          { encoding: 'utf8' },
        );
        verified = result.status === 0;
      }
    } catch {
      verified = false;
    }
    this.aliveCache.set(cacheKey, { at: nowMs, alive: verified });
    return verified;
  }

  private aliveCacheKey(projectId: number, epicId: number): string {
    return `${projectId}:${epicId}`;
  }

  private timestamp(): string {
    return this.now().toISOString().replace('T', ' ').slice(0, 19);
  }

  private withDb<T>(
    operation: (db: Database.Database) => T,
    readonly = true,
  ): T {
    const db = new Database(
      this.config.dbPath,
      readonly ? { readonly: true, fileMustExist: true } : undefined,
    );
    if (!readonly) {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
    }
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
}
