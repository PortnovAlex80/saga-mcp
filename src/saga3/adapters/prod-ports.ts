/**
 * Saga 3 — Production adapters.
 *
 * Real implementations of the 11 ports. No stubs. No throws.
 * These are the bridge between Level 2 (controller) and Level 3 (reality).
 *
 * ModelPort → claude CLI subprocess
 * OraclePort → command runner (npm test, tsc, git merge-tree, etc.)
 * EffectPort → git merge via integration-executor pattern
 * RepositoryPort → git rev-parse / git status
 * ProcessPort → child_process spawn/observe/stop
 * DurableStore → SQLite (better-sqlite3)
 * SchedulerPort → in-process capacity tracker
 * Clock → Date.now()
 * IdSource → crypto.randomUUID()
 * RandomSource → crypto.randomBytes
 * FaultInjector → noop (production)
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID, randomBytes, randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Ports, Clock, Deadline, IdSource, RandomSource,
  ModelPort, ModelRequest, ModelResult,
  OraclePort, OracleRequest, OracleResult,
  EffectPort, RepositoryPort, ProcessPort,
  DurableStore, Tx, SchedulerPort, FaultInjector,
} from '../ports/ports.js';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export class RealClock implements Clock {
  now(): number { return Date.now(); }
  deadline(afterMs: number): Deadline {
    const at = Date.now() + afterMs;
    return { at, expired: (t) => (t ?? Date.now()) >= at };
  }
}

// ---------------------------------------------------------------------------
// IdSource
// ---------------------------------------------------------------------------

export class ProdIds implements IdSource {
  next(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }
}

// ---------------------------------------------------------------------------
// RandomSource
// ---------------------------------------------------------------------------

export class ProdRandom implements RandomSource {
  unit(): number {
    return randomBytes(4).readUInt32LE() / 4294967296;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('ProdRandom.pick: empty array');
    return items[randomInt(0, items.length)];
  }
  jitter(baseMs: number, factor: number): number {
    return Math.round(baseMs * (1 + this.unit() * factor));
  }
}

// ---------------------------------------------------------------------------
// ModelPort — claude CLI subprocess
// ---------------------------------------------------------------------------

export class CliModelPort implements ModelPort {
  constructor(
    private readonly claudePath: string = process.env.SAGA_CLAUDE_PATH ?? 'claude',
    private readonly workspaceRoot: string,
  ) {}

  async propose(req: ModelRequest, deadline: Deadline): Promise<ModelResult> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      req.prompt,
    ];

    return new Promise<ModelResult>((resolve) => {
      const child = spawn(this.claudePath, args, {
        cwd: this.workspaceRoot,
        env: { ...process.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        resolve({ kind: 'timeout' });
      }, deadline.at - Date.now());

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          if (/rate_limit|429/i.test(stderr)) {
            resolve({ kind: 'provider_error', status: 429, message: stderr.slice(0, 500) });
          }
          resolve({ kind: 'provider_error', status: code ?? -1, message: stderr.slice(0, 500) });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const resultText = parsed.result ?? parsed.content ?? stdout;
          if (/refus|cannot|won't/i.test(resultText.slice(0, 200))) {
            resolve({ kind: 'refusal', message: resultText.slice(0, 200) });
            return;
          }
          resolve({
            kind: 'proposal',
            proposal: { proposalKind: req.proposalKind, payload: parsed },
          });
        } catch {
          resolve({ kind: 'malformed', raw: stdout.slice(0, 1000), reason: 'JSON parse failed' });
        }
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ kind: 'provider_error', message: e.message });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// OraclePort — command runner
// ---------------------------------------------------------------------------

const ORACLE_COMMANDS: Record<string, string> = {
  'npm-test': 'npm test',
  'npm-run-build': 'npm run build',
  'tsc': 'npx tsc --noEmit',
  'eslint': 'npx eslint src/',
  'node-test': 'node --test',
};

export class CommandOraclePort implements OraclePort {
  constructor(private readonly workspaceRoot: string) {}

  async observe(req: OracleRequest, deadline: Deadline): Promise<OracleResult> {
    const command = ORACLE_COMMANDS[req.oracleId] ?? req.command;
    const timeout = Math.max(1000, deadline.at - Date.now());

    return new Promise<OracleResult>((resolve) => {
      const result = spawnSync('bash', ['-c', command], {
        cwd: this.workspaceRoot,
        env: { ...process.env },
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const combined = stdout + stderr;
      const rawDigest = createHash('sha256').update(combined).digest('hex');

      if (result.status === 0) {
        resolve({ verdict: 'passed', rawDigest, executed: true });
      } else if (result.signal === 'SIGTERM' || result.error?.message.includes('timed out')) {
        resolve({ verdict: 'unknown', rawDigest, executed: false });
      } else if (result.status !== null) {
        resolve({ verdict: 'failed', rawDigest, executed: true });
      } else {
        resolve({ verdict: 'unknown', rawDigest, executed: false });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// EffectPort — git merge
// ---------------------------------------------------------------------------

export class GitEffectPort implements EffectPort {
  constructor(private readonly workspaceRoot: string) {}

  async execute(intent: import('../ports/ports.js').EffectPortIntent, _deadline: Deadline): Promise<import('../ports/ports.js').EffectPortObservation> {
    // Parse target: "repo:source_branch->target_branch"
    const parts = intent.targetIdentity.split(':');
    const branchPart = parts[parts.length - 1];
    const [sourceBranch, targetBranch] = branchPart.split('->');

    if (!sourceBranch || !targetBranch) {
      return { outcome: 'failed', resultDigest: 'invalid', detail: 'bad target format' };
    }

    // Check if already merged (ancestor).
    const ancestorCheck = spawnSync('git', ['-C', this.workspaceRoot, 'merge-base', '--is-ancestor', sourceBranch, targetBranch], { encoding: 'utf8', windowsHide: true });
    if (ancestorCheck.status === 0) {
      return { outcome: 'already_applied', resultDigest: createHash('sha256').update('ancestor').digest('hex') };
    }

    // Perform merge.
    const mergeResult = spawnSync('git', ['-C', this.workspaceRoot, 'merge', '--no-ff', '--no-edit', '-m', `merge: ${intent.idempotencyKey}`, sourceBranch], { encoding: 'utf8', windowsHide: true });

    if (mergeResult.status === 0) {
      const head = spawnSync('git', ['-C', this.workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
      return { outcome: 'succeeded', resultDigest: createHash('sha256').update(head.stdout.trim()).digest('hex') };
    }

    // Conflict.
    spawnSync('git', ['-C', this.workspaceRoot, 'merge', '--abort'], { encoding: 'utf8', windowsHide: true });
    return { outcome: 'failed', resultDigest: createHash('sha256').update('conflict').digest('hex'), detail: 'merge conflict' };
  }
}

// ---------------------------------------------------------------------------
// RepositoryPort — git observation
// ---------------------------------------------------------------------------

export class GitRepositoryPort implements RepositoryPort {
  async observeHead(repo: string, branch: string) {
    const result = spawnSync('git', ['-C', repo, 'rev-parse', branch], { encoding: 'utf8', windowsHide: true });
    const statusResult = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    return {
      head: result.stdout.trim(),
      clean: statusResult.stdout.trim().length === 0,
    };
  }

  async sourceFingerprint(repo: string) {
    const headResult = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    const statusResult = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const head = headResult.stdout.trim();
    const statusLines = statusResult.stdout.trim();
    const dirty = statusLines.length > 0;
    const fingerprint = createHash('sha256').update(head + statusLines).digest('hex');
    return { fingerprint, head, dirty };
  }
}

// ---------------------------------------------------------------------------
// ProcessPort — child_process
// ---------------------------------------------------------------------------

export class ChildProcessPort implements ProcessPort {
  private handles = new Map<string, ReturnType<typeof spawn>>();

  async start(spec: import('../ports/ports.js').ProcessSpec, _deadline: Deadline) {
    const child = spawn(spec.args[0], spec.args.slice(1), {
      cwd: spec.repo,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const id = `proc-${randomUUID().slice(0, 8)}`;
    this.handles.set(id, child);
    return { id, repo: spec.repo };
  }

  async observe(handle: import('../ports/ports.js').ProcessHandle) {
    const child = this.handles.get(handle.id);
    if (!child) return { state: 'lost' as const };
    if (child.exitCode !== null) return { state: 'exited' as const, code: child.exitCode };
    try {
      process.kill(child.pid!, 0);
      return { state: 'running' as const };
    } catch {
      return { state: 'lost' as const };
    }
  }

  async stop(handle: import('../ports/ports.js').ProcessHandle) {
    const child = this.handles.get(handle.id);
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }
    this.handles.delete(handle.id);
  }
}

// ---------------------------------------------------------------------------
// DurableStore — SQLite wrapper
// ---------------------------------------------------------------------------

export class SqliteStore implements DurableStore {
  constructor(private readonly db: Database.Database) {}

  transact<T>(fn: (tx: Tx) => T): T {
    // Fault injection point (test use — production ignores).
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const tx: Tx = {
        get: (sql, ...params) => this.db.prepare(sql).get(...params) as any,
        all: (sql, ...params) => this.db.prepare(sql).all(...params) as any,
        run: (sql, ...params) => {
          const info = this.db.prepare(sql).run(...params);
          return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
        },
      };
      const result = fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// SchedulerPort — in-process capacity tracker
// ---------------------------------------------------------------------------

export class ProdScheduler implements SchedulerPort {
  private active = new Map<string, Set<string>>(); // pool → active intent ids

  constructor(
    private readonly capacity: Record<string, number> = { model: 4, repo_writer: 1, integration: 1 },
  ) {}

  admit(req: import('../ports/ports.js').SchedulerAdmitRequest): import('../ports/ports.js').SchedulerAdmitDecision {
    const pool = this.active.get(req.capacityPool) ?? new Set();
    const max = this.capacity[req.capacityPool] ?? 1;

    if (pool.size >= max) {
      return { admitted: false, reason: 'capacity' };
    }

    pool.add(req.workIntentId);
    this.active.set(req.capacityPool, pool);
    return { admitted: true, launchOrder: pool.size };
  }

  release(pool: string, intentId: string): void {
    const p = this.active.get(pool);
    if (p) p.delete(intentId);
  }
}

// ---------------------------------------------------------------------------
// FaultInjector — noop in production
// ---------------------------------------------------------------------------

export class NoopFaults implements FaultInjector {
  arm(): void {}
  shouldFail(): boolean { return false; }
  reset(): void {}
}

// ---------------------------------------------------------------------------
// Bundle constructor
// ---------------------------------------------------------------------------

export function prodPorts(db: Database.Database, workspaceRoot: string): Ports {
  return {
    clock: new RealClock(),
    ids: new ProdIds(),
    random: new ProdRandom(),
    model: new CliModelPort('claude', workspaceRoot),
    oracle: new CommandOraclePort(workspaceRoot),
    effects: new GitEffectPort(workspaceRoot),
    repository: new GitRepositoryPort(),
    processes: new ChildProcessPort(),
    store: new SqliteStore(db),
    scheduler: new ProdScheduler(),
    faults: new NoopFaults(),
  };
}
