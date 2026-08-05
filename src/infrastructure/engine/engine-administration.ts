import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { isProcessAlive } from '../../worker-executions.js';
import {
  EngineAdministrationError,
  type EngineAdministration,
  type EngineStartCommand,
  type EngineStateSnapshot,
} from '../../application/ports/engine-administration.js';
import type { SagaRuntimeConfig } from '../../runtime/saga-runtime-config.js';
import { requestFactoryLaunch } from '../factory/sqlite-factory-launch-repository.js';

export interface EngineProcessAdministrationOptions {
  config: SagaRuntimeConfig;
  baseEnv?: NodeJS.ProcessEnv;
  orchestrateCliPath?: string;
  spawnProcess?: typeof spawn;
  spawnProcessSync?: typeof spawnSync;
  now?: () => Date;
  platform?: NodeJS.Platform;
  /**
   * Process-liveness probe injected for testability. The fast-path in
   * isEngineAlive calls this against the persisted engine PID. In production it
   * defaults to the real process.kill(pid,0) check; tests inject a stub so they
   * do not depend on a real OS process matching the spawned mock PID.
   */
  isProcessAlive?: (pid: number | null) => boolean;
}

interface PersistedEngineState {
  running: boolean;
  pid: number | null;
  concurrency: number | null;
  startedAt: string | null;
}

interface ResumableLifecycleRun {
  id: number;
  idempotencyKey: string;
  initiatedBy: string;
}

/**
 * Compatibility adapter for tracker-view's existing engine controls.
 *
 * Process-tree termination, detached CLI spawning and episode metadata stay
 * compatible in behavior, but the HTTP/frontend layer no longer owns them.
 */
export class EngineProcessAdministration implements EngineAdministration {
  private readonly config: SagaRuntimeConfig;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly orchestrateCliPath: string;
  private readonly spawnProcess: typeof spawn;
  private readonly spawnProcessSync: typeof spawnSync;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly isProcessAlive: (pid: number | null) => boolean;

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

  constructor(options: EngineProcessAdministrationOptions) {
    this.config = options.config;
    this.baseEnv = { ...(options.baseEnv ?? {}) };
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.spawnProcessSync = options.spawnProcessSync ?? spawnSync;
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;

    const here = path.dirname(fileURLToPath(import.meta.url));
    this.orchestrateCliPath = options.orchestrateCliPath
      ?? path.join(here, '..', '..', 'orchestrate-cli.js');
  }

  start(command: EngineStartCommand): EngineStateSnapshot {
    const projectId = this.projectIdForEpic(command.epicId);
    const resumable = this.findResumableLifecycleRun(projectId, command.epicId);
    if (!resumable) {
      throw new EngineAdministrationError(
        'run_not_resumable',
        `project ${projectId} epic ${command.epicId} has no resumable factory run`,
      );
    }
    const persisted = this.readPersisted(command.epicId);
    const requested = Number(command.concurrency);
    const concurrency = Number.isInteger(requested) && requested >= 1 && requested <= 10
      ? requested
      : (Number(persisted.concurrency) || 4);

    if (persisted.running && this.isEngineAlive(projectId, command.epicId)) {
      return {
        projectId,
        epicId: command.epicId,
        running: true,
        alive: true,
        pid: persisted.pid,
        concurrency: persisted.concurrency ?? concurrency,
        startedAt: persisted.startedAt,
      };
    }

    this.killEngineTree(projectId, command.epicId);

    try {
      const launchRef = this.createResumeLaunch(
        projectId,
        command.epicId,
        resumable,
        concurrency,
      );
      const cliArgs = [this.orchestrateCliPath, `--launch-ref=${launchRef}`];
      const child = this.spawnProcess(
        'node',
        cliArgs,
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...this.baseEnv,
            DB_PATH: this.config.dbPath,
            SAGA_ORCHESTRATION_MODE: this.config.orchestrationMode,
            SAGA_PRODUCT_LIFECYCLE_COMPOSITION: process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION,
          },
        },
      );
      // Pipe engine output to a persistent log file for debugging.
      const engineLog = `${tmpdir()}/saga-engine-${command.epicId}-${Date.now()}.log`;
      const logStream = createWriteStream(engineLog, { flags: 'a' });
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);
      child.unref();
      const startedAt = this.timestamp();
      this.upsertControl(command.epicId, {
        engine_state: 'running',
        engine_pid: child.pid ?? null,
        concurrency,
        started_at: startedAt,
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
    this.upsertControl(epicId, {
      engine_state: 'stopped',
      stopped_at: this.timestamp(),
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

  setConcurrency(epicId: number, concurrency: number): EngineStateSnapshot {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw new EngineAdministrationError(
        'invalid_concurrency',
        'concurrency must be 1..10',
      );
    }
    const projectId = this.projectIdForEpic(epicId);
    this.upsertControl(epicId, {
      concurrency,
      concurrency_changed_at: this.timestamp(),
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
      this.upsertControl(epicId, { engine_state: 'stopped' });
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
        `SELECT engine_state, engine_pid, concurrency, started_at
           FROM lifecycle_execution_controls WHERE epic_id=?`,
      ).get(epicId) as {
        engine_state: string | null;
        engine_pid: number | null;
        concurrency: number | null;
        started_at: string | null;
      } | undefined;
      return {
        running: row?.engine_state === 'running',
        pid: row?.engine_pid ?? null,
        concurrency: row?.concurrency ?? null,
        startedAt: row?.started_at ?? null,
      };
    });
  }

  private findResumableLifecycleRun(
    projectId: number,
    epicId: number,
  ): ResumableLifecycleRun | null {
    return this.withDb(db => {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_lifecycle_runs'",
      ).get();
      if (!table) return null;
      const rows = db.prepare(
        `SELECT id, idempotency_key, initiated_by
           FROM factory_lifecycle_runs
          WHERE project_id=? AND epic_id=?
            AND status IN ('created','running','paused')
          ORDER BY id DESC`,
      ).all(projectId, epicId) as Array<{
        id: number;
        idempotency_key: string;
        initiated_by: string;
      }>;
      if (rows.length > 1) {
        throw new EngineAdministrationError(
          'ambiguous_active_run',
          `multiple resumable LifecycleRuns exist for project ${projectId}, epic ${epicId}; `
            + 'refusing to guess',
        );
      }
      const row = rows[0];
      return row ? {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        initiatedBy: row.initiated_by,
      } : null;
    });
  }

  /**
   * Targeted upsert into lifecycle_execution_controls (the saga4 home for engine
   * + model state). Replaces the old generic JSON-metadata patch on the legacy
   * workflows table.
   * Each caller writes only the concrete columns it owns; engine_state must be a
   * valid CHECK constraint value ('running' | 'stopped' | 'unknown') — never 0/1.
   */
  private upsertControl(epicId: number, patch: Partial<{
    engine_state: string; engine_pid: number | null; concurrency: number;
    started_at: string; stopped_at: string; concurrency_changed_at: string;
  }>): void {
    this.withDb(db => {
      const sets = Object.entries(patch).map(([k]) => `${k}=@${k}`);
      const params: Record<string, unknown> = { ...patch, epic_id: epicId };
      db.prepare(
        `INSERT INTO lifecycle_execution_controls (epic_id, ${Object.keys(patch).join(', ')})
         VALUES (@epic_id, ${Object.keys(patch).map(k => `@${k}`).join(', ')})
         ON CONFLICT(epic_id) DO UPDATE SET ${sets.join(', ')}, updated_at=datetime('now')`,
      ).run(params);
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
    const fastAlive = this.isProcessAlive(persisted.pid);
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
    if (cached && nowMs - cached.at < EngineProcessAdministration.ALIVE_CACHE_MS) {
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

  private createResumeLaunch(
    projectId: number,
    epicId: number,
    run: ResumableLifecycleRun,
    concurrency: number,
  ): string {
    return this.withDb(db => db.transaction(() => {
      const existing = db.prepare(
        'SELECT order_ref FROM factory_orders WHERE project_id=?',
      ).get(projectId) as { order_ref: string } | undefined;
      const orderRef = existing?.order_ref ?? `order-${randomUUID()}`;
      if (!existing) {
        db.prepare(
          `INSERT INTO factory_orders
             (order_ref, project_id, epic_id, lifecycle_run_id, source_kind,
              state, source_url, source_final_url, source_media_type,
              source_digest, source_body)
           VALUES (?, ?, ?, ?, 'existing_project', 'paused',
                   NULL, NULL, NULL, NULL, NULL)`,
        ).run(orderRef, projectId, epicId, run.id);
      }
      return requestFactoryLaunch({
        orderRef,
        mode: 'resume',
        projectId,
        epicId,
        lifecycleRunId: run.id,
        initiatedBy: run.initiatedBy,
        idempotencyKey: run.idempotencyKey,
        concurrency,
      }, db);
    })(), false);
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
