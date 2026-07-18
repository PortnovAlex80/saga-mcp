import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

export const ACTIVE_EXECUTION_STATES = ['reserved', 'running', 'cancel_requested'] as const;
const ACTIVE_STATE_SQL = "'reserved','running','cancel_requested'";
const RESERVED_BOOT_TIMEOUT_MS = 60_000;
const FINISH_GRACE_MS = 30_000;

export interface WorkerExecutionRow {
  execution_id: string;
  run_id: string;
  project_id: number;
  epic_id: number;
  task_id: number;
  worker_id: string;
  machine_id: string;
  state: string;
  phase: string;
  pid: number | null;
  process_birth_token: string | null;
  log_path: string | null;
  reserved_at: string;
  started_at: string | null;
  phase_updated_at: string;
  task_status: string | null;
  task_assigned_to: string | null;
  current_execution_id: string | null;
  integration_state: string | null;
}

function openRuntimeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function assertExecutionFence(
  db: Database.Database,
  task: { id: number; current_execution_id?: string | null },
  executionId: unknown,
): void {
  if (!task.current_execution_id) return;
  if (typeof executionId !== 'string' || executionId !== task.current_execution_id) {
    throw new Error(
      `Task ${task.id} is fenced by execution ${task.current_execution_id}; ` +
      `stale or missing execution_id cannot mutate it`,
    );
  }
  const active = db.prepare(
    `SELECT 1 FROM worker_executions
     WHERE execution_id=? AND task_id=? AND state IN (${ACTIVE_STATE_SQL})`,
  ).get(executionId, task.id);
  if (!active) throw new Error(`Execution ${executionId} is no longer active for task ${task.id}`);
}

export function markExecutionRunning(
  dbPath: string,
  executionId: string,
  pid: number | null,
  processBirthToken: string | null,
  logPath: string,
  startedAt: string,
): void {
  if (pid !== null && !processBirthToken) {
    throw new Error(`cannot fence execution ${executionId}: process birth identity is unavailable`);
  }
  const db = openRuntimeDb(dbPath);
  try {
    const info = db.prepare(
      `UPDATE worker_executions
       SET state='running', pid=?, process_birth_token=?, log_path=?,
           started_at=?, phase_updated_at=datetime('now')
       WHERE execution_id=? AND state='reserved'`,
    ).run(pid, processBirthToken, logPath, startedAt, executionId);
    if (info.changes !== 1) {
      throw new Error(`execution ${executionId} reservation is missing or no longer active`);
    }
    db.prepare(
      `UPDATE tasks SET metadata=json_set(COALESCE(metadata,'{}'),
         '$.worker_pid', ?, '$.worker_started_at', ?)
       WHERE current_execution_id=?`,
    ).run(pid, startedAt, executionId);
  } finally {
    db.close();
  }
}

export function markExecutionSpawnFailed(
  dbPath: string,
  executionId: string,
  error: string,
): void {
  const db = openRuntimeDb(dbPath);
  try {
    db.prepare(
      `UPDATE worker_executions
       SET state='spawn_failed', finished_at=datetime('now'), last_error=?
       WHERE execution_id=? AND state IN ('reserved','running')`,
    ).run(error, executionId);
  } finally {
    db.close();
  }
}

export function markExecutionExited(
  dbPath: string,
  executionId: string,
  exitCode: number | null,
  state: 'exited' | 'terminated' = 'exited',
): void {
  const db = openRuntimeDb(dbPath);
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE worker_executions
         SET state=?, finished_at=datetime('now'), exit_code=?
         WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
      ).run(state, exitCode, executionId);
      db.prepare(
        `UPDATE tasks
         SET current_execution_id=NULL,
             metadata=CASE
               WHEN json_extract(metadata,'$.worker_pid') = (
                 SELECT pid FROM worker_executions WHERE execution_id=?
               ) THEN json_remove(metadata,'$.worker_pid','$.worker_started_at')
               ELSE metadata END,
             updated_at=datetime('now')
         WHERE current_execution_id=?`,
      ).run(executionId, executionId);
    })();
  } finally {
    db.close();
  }
}

export function updateExecutionPhase(
  db: Database.Database,
  taskId: number,
  workerId: string,
  executionId: unknown,
  phase: 'finishing' | 'integrating',
): void {
  if (typeof executionId !== 'string') return;
  db.prepare(
    `UPDATE worker_executions
     SET phase=?, phase_updated_at=datetime('now')
     WHERE execution_id=? AND task_id=? AND worker_id=?
       AND state IN (${ACTIVE_STATE_SQL})`,
  ).run(phase, executionId, taskId, workerId);
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readProcessBirthToken(pid: number | null): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      const token = String(result.stdout ?? '').trim();
      return token || null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      return tail[19] ? `linux:${tail[19]}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function terminateVerifiedProcess(
  row: Pick<WorkerExecutionRow, 'pid' | 'machine_id' | 'process_birth_token'>,
): boolean {
  if (!row.pid || row.machine_id !== os.hostname() || !row.process_birth_token) return false;
  const currentToken = readProcessBirthToken(row.pid);
  if (!currentToken || currentToken !== row.process_birth_token) return false;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill',
        ['/F', '/T', '/PID', String(row.pid)],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      );
      return result.status === 0 || !isProcessAlive(row.pid);
    }
    process.kill(row.pid, 'SIGKILL');
    return true;
  } catch {
    return !isProcessAlive(row.pid);
  }
}

function parseDbTime(value: string | null): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function releaseOwnedTask(db: Database.Database, row: WorkerExecutionRow): boolean {
  if (row.current_execution_id !== row.execution_id) return false;
  let restoredStatus = row.task_status;
  if (row.task_status === 'in_progress') restoredStatus = 'todo';
  else if (row.task_status === 'review_in_progress') restoredStatus = 'review';
  else if (row.task_status === 'done' && row.integration_state === 'pending') {
    restoredStatus = 'review';
  }
  const info = db.prepare(
    `UPDATE tasks
     SET status=?, assigned_to=NULL, current_execution_id=NULL,
         metadata=json_remove(metadata,'$.worker_pid','$.worker_started_at'),
         updated_at=datetime('now')
     WHERE id=? AND current_execution_id=?`,
  ).run(restoredStatus, row.task_id, row.execution_id);
  return info.changes === 1;
}

export interface ReconcileResult {
  executionId: string;
  taskId: number;
  action: 'kept' | 'lost' | 'terminated' | 'remote_unknown';
  released: boolean;
  reason: string;
}

export function reconcileWorkerExecutions(
  db: Database.Database,
  projectId: number,
  epicId?: number,
  nowMs = Date.now(),
): ReconcileResult[] {
  const epicClause = epicId === undefined ? '' : 'AND we.epic_id=?';
  const params = epicId === undefined ? [projectId] : [projectId, epicId];
  const rows = db.prepare(
    `SELECT we.*, t.status AS task_status, t.assigned_to AS task_assigned_to,
            t.current_execution_id, t.integration_state
     FROM worker_executions we
     LEFT JOIN tasks t ON t.id=we.task_id
     WHERE we.project_id=? AND we.state IN (${ACTIVE_STATE_SQL}) ${epicClause}
     ORDER BY we.reserved_at`,
  ).all(...params) as WorkerExecutionRow[];

  const results: ReconcileResult[] = [];
  for (const row of rows) {
    if (row.machine_id !== os.hostname()) {
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'remote_unknown',
        released: false, reason: 'process belongs to another machine',
      });
      continue;
    }

    const alive = row.state === 'reserved' ? false : isProcessAlive(row.pid);
    const reservedExpired = row.state === 'reserved'
      && nowMs - parseDbTime(row.reserved_at) >= RESERVED_BOOT_TIMEOUT_MS;
    if ((row.state === 'running' || row.state === 'cancel_requested') && !alive || reservedExpired) {
      const terminal = row.state === 'reserved' ? 'spawn_failed' : 'lost';
      db.prepare(
        `UPDATE worker_executions
         SET state=?, finished_at=datetime('now'), last_error=?
         WHERE execution_id=? AND state=?`,
      ).run(terminal, reservedExpired ? 'spawn reservation timed out' : 'OS process is not alive',
        row.execution_id, row.state);
      const released = releaseOwnedTask(db, row);
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'lost', released,
        reason: reservedExpired ? 'spawn reservation timed out' : 'OS process is not alive',
      });
      continue;
    }

    const phaseAge = nowMs - parseDbTime(row.phase_updated_at);
    const ownsActiveTask = row.current_execution_id === row.execution_id
      && row.task_assigned_to === row.worker_id
      && (row.task_status === 'in_progress' || row.task_status === 'review_in_progress');
    const legitimateIntegration = row.current_execution_id === row.execution_id
      && row.phase === 'integrating'
      && row.task_status === 'done'
      && row.integration_state === 'pending';
    const legitimateFinishing = row.current_execution_id === row.execution_id
      && row.phase === 'finishing'
      && phaseAge < FINISH_GRACE_MS;

    if (alive && (ownsActiveTask || legitimateIntegration || legitimateFinishing)) {
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'kept',
        released: false, reason: 'execution still owns an allowed lifecycle phase',
      });
      continue;
    }

    if (alive) {
      const killed = terminateVerifiedProcess(row);
      if (!killed) {
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'kept',
          released: false, reason: 'unsafe to terminate without matching process birth identity',
        });
        continue;
      }
      db.prepare(
        `UPDATE worker_executions
         SET state='terminated', finished_at=datetime('now'),
             last_error='execution no longer owns an allowed task phase'
         WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
      ).run(row.execution_id);
      const released = releaseOwnedTask(db, row);
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'terminated', released,
        reason: 'execution no longer owns an allowed task phase',
      });
    }
  }

  // Transitional recovery for assignments created before ADR-009. These rows
  // have no execution fence, so they may be observed and released when dead,
  // but never killed: PID identity alone is not sufficient for termination.
  const legacyParams = epicId === undefined ? [projectId] : [projectId, epicId];
  const legacyEpicClause = epicId === undefined ? '' : 'AND t.epic_id=?';
  const legacy = db.prepare(
    `SELECT t.id, t.status, t.assigned_to, t.metadata
       FROM tasks t
       JOIN epics e ON e.id=t.epic_id
      WHERE e.project_id=?
        ${legacyEpicClause}
        AND (
          t.status IN ('in_progress','review_in_progress')
          OR (t.status='review' AND t.assigned_to IS NOT NULL AND t.assigned_to!='')
        )
        AND t.current_execution_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM worker_executions we
           WHERE we.task_id=t.id AND we.state IN (${ACTIVE_STATE_SQL})
        )`,
  ).all(...legacyParams) as Array<{
    id: number;
    status: string;
    assigned_to: string | null;
    metadata: string;
  }>;
  for (const task of legacy) {
    let pid: number | null = null;
    try {
      const parsed = JSON.parse(task.metadata || '{}') as { worker_pid?: unknown };
      pid = typeof parsed.worker_pid === 'number' ? parsed.worker_pid : null;
    } catch {
      pid = null;
    }
    if (isProcessAlive(pid)) {
      results.push({
        executionId: `legacy-task-${task.id}`,
        taskId: task.id,
        action: 'kept',
        released: false,
        reason: 'legacy assignment has a live PID; observe only',
      });
      continue;
    }
    const restoredStatus = task.status === 'in_progress'
      ? 'todo'
      : 'review';
    const info = db.prepare(
      `UPDATE tasks
          SET status=?, assigned_to=NULL,
              metadata=json_remove(metadata,'$.worker_pid','$.worker_started_at'),
              updated_at=datetime('now')
        WHERE id=? AND assigned_to IS ? AND current_execution_id IS NULL`,
    ).run(restoredStatus, task.id, task.assigned_to);
    results.push({
      executionId: `legacy-task-${task.id}`,
      taskId: task.id,
      action: 'lost',
      released: info.changes === 1,
      reason: pid ? 'legacy OS process is not alive' : 'legacy assignment has no PID',
    });
  }
  return results;
}
