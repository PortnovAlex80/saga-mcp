from pathlib import Path
import re

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')


# 1. Authority fixtures must carry the same task -> WorkIntent binding that the
# production dispatcher freezes at claim time.
auth_path = 'tests/saga3/d1-1-authority.test.mjs'
auth = read(auth_path)
seed_pattern = r"function seedExecution\(db, executionId, metadata, \{ state = 'running', taskId = 100, workerId = 'w-1' \} = \{\}\) \{.*?\n\}\n\n(?=function runtimeSnapshot)"
seed_replacement = r'''function seedExecution(db, executionId, metadata, { state = 'running', taskId = 100, workerId = 'w-1' } = {}) {
  db.prepare(`INSERT OR IGNORE INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT OR IGNORE INTO epics (id,project_id,name) VALUES (10,1,'REQ-10')`).run();
  let taskMetadata = '{}';
  try {
    const parsed = JSON.parse(metadata);
    const context = parsed?.execution_context;
    if (context?.authority && Number.isInteger(context.work_intent_id)) {
      taskMetadata = JSON.stringify({ work_intent_id: context.work_intent_id });
    }
  } catch {
    taskMetadata = '{}';
  }
  db.prepare(`INSERT OR IGNORE INTO tasks (id, epic_id, title, status, task_kind, generation_key, metadata)
              VALUES (?, 10, 'T', 'in_progress', 'discovery.work', ?, ?)`).run(taskId, `gk-${taskId}`, taskMetadata);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase, metadata)
     VALUES (?, 'run-1', 1, 10, ?, ?, 'm-1', ?, 'executing', ?)`,
  ).run(executionId, taskId, workerId, state, metadata);
}

'''
auth, count = re.subn(seed_pattern, seed_replacement, auth, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f'{auth_path}: seedExecution rewrite matched {count}')

advisory_pattern = r"function advisorySnapshot\(allowed = ALLOWED, workIntentId = 7\) \{.*?\n\}"
advisory_replacement = r'''function advisorySnapshot(allowed = ALLOWED, workIntentId = 7) {
  const base = JSON.parse(runtimeSnapshot(allowed, workIntentId));
  const authority = base.execution_context.authority;
  authority.enforcement = 'advisory';
  authority.authority_hash = authorityHash({
    enforcement: authority.enforcement,
    allowed_saga_tools: authority.allowed_saga_tools,
    scope: authority.scope,
    snapshot_ref: authority.snapshot_ref,
    work_intent_id: authority.work_intent_id,
  });
  base.execution_context_hash = executionContextHash(base.execution_context);
  return JSON.stringify(base);
}'''
auth, count = re.subn(advisory_pattern, advisory_replacement, auth, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f'{auth_path}: advisorySnapshot rewrite matched {count}')

compat_old = """    const snapshot = JSON.stringify({
      execution_context: {
        policy_version: 'saga3.execution.v1',
        work_intent_id: null,
        authority: null,   // Saga 2 managed execution: no WorkIntent
        model_route: { provider: 'zai', model: null, effort: 'high' },
        captured_at: '2026-07-23T20:00:00.000Z',
      },
    });"""
compat_new = """    const execution_context = {
      policy_version: 'saga3.execution.v1',
      work_intent_id: null,
      authority: null,
      model_route: { provider: 'zai', model: null, effort: 'high' },
      captured_at: '2026-07-23T20:00:00.000Z',
    };
    const snapshot = JSON.stringify({
      execution_context,
      execution_context_hash: executionContextHash(execution_context),
    });"""
if auth.count(compat_old) != 1:
    raise SystemExit(f'{auth_path}: Saga2 compat snapshot anchor count={auth.count(compat_old)}')
auth = auth.replace(compat_old, compat_new, 1)
write(auth_path, auth)


# 2. Lifecycle mutation belongs to an existing sanctioned lifecycle writer, not
# the SQLite orchestration adapter.
lifecycle_path = 'src/lifecycle/legacy-assignment-recovery.ts'
lifecycle = read(lifecycle_path)
helper_marker = 'export function prepareSaga3ProjectedTaskForExecution('
if helper_marker not in lifecycle:
    lifecycle += r'''

export interface Saga3ProjectedTaskRecoveryCommand {
  taskId: number;
  currentStatus: string;
  assignedTo: string | null;
  currentExecutionId: string | null;
}

/**
 * Restore an interrupted Saga 3 projected task to a claimable queue state.
 * The caller owns the surrounding transaction; this module owns the lifecycle
 * mutation so orchestration persistence never writes task status directly.
 */
export function prepareSaga3ProjectedTaskForExecution(
  db: Database.Database,
  command: Saga3ProjectedTaskRecoveryCommand,
): string {
  const restoredStatus = command.currentStatus === 'review_in_progress'
    ? 'review'
    : command.currentStatus === 'in_progress'
      ? 'todo'
      : command.currentStatus;
  if (command.assignedTo || command.currentExecutionId || restoredStatus !== command.currentStatus) {
    db.prepare(
      `UPDATE tasks SET status=?, assigned_to=NULL, current_execution_id=NULL,
                        updated_at=datetime('now') WHERE id=?`,
    ).run(restoredStatus, command.taskId);
  }
  return restoredStatus;
}
'''
    write(lifecycle_path, lifecycle)

runtime_path = 'src/saga3/persistence/sqlite-saga3-discovery-runtime.ts'
runtime = read(runtime_path)
import_anchor = "import { getDb } from '../../db.js';\n"
import_line = "import { prepareSaga3ProjectedTaskForExecution } from '../../lifecycle/legacy-assignment-recovery.js';\n"
if import_line not in runtime:
    if import_anchor not in runtime:
        raise SystemExit(f'{runtime_path}: import anchor missing')
    runtime = runtime.replace(import_anchor, import_anchor + import_line, 1)

recovery_pattern = re.compile(
    r"\n\s*const restoredStatus\s*=\s*task\.status\s*===\s*'review_in_progress'\s*\?\s*'review'"
    r".*?if\s*\(task\.assigned_to\s*\|\|\s*task\.current_execution_id\s*\|\|\s*restoredStatus\s*!==\s*task\.status\)\s*\{"
    r".*?\n\s*\}",
    re.S,
)
writer_call = """
      const restoredStatus = prepareSaga3ProjectedTaskForExecution(db, {
        taskId,
        currentStatus: task.status,
        assignedTo: task.assigned_to,
        currentExecutionId: task.current_execution_id,
      });"""
runtime, count = recovery_pattern.subn(writer_call, runtime, count=1)
if count != 1:
    raise SystemExit(f'{runtime_path}: structured recovery rewrite matched {count}')
write(runtime_path, runtime)

print('remaining D1.1 fixes applied')
