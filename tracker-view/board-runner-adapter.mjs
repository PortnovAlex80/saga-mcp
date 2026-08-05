// ClaudeBoardRunner wiring extracted from tracker-view.mjs (T10 step 2).
//
// This module is the single seam between the tracker-view HTTP layer and the
// board runner (./claude-runner.mjs). It owns:
//   - getRunnerTaskState(taskId)        — reads the task row the runner hosts
//   - recoverRunnerAssignment({...})    — fenced recovery of a dead runner's task
//   - createBoardRunnerAdapter({...})   — constructs and returns the boardRunner
//
// It depends only on ./shared.mjs (DB helpers + workspace resolver), the
// dispatcher handlers, and the atomic release path. No HTTP, no rendering.
import path from 'node:path';
import { createClaudeBoardRunner } from './claude-runner.mjs';
import { handlers as dispatcherHandlers } from '../dist/tools/dispatcher.js';
import { releaseExecutionAtomically } from '../dist/lifecycle/atomic-release.js';
import { withDb, withDbWrite, resolveProjectWorkspace } from './shared.mjs';

export function getRunnerTaskState(taskId) {
  return withDb(db =>
    db.prepare('SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?').get(taskId),
  );
}

export function recoverRunnerAssignment({ taskId, workerId, originalStatus, executionId, reason }) {
  // Slice 1 (ADR-010/011, blueprint §16:829-845): the recovery path now
  // delegates fenced releases to the single atomic terminalization+release
  // function in src/lifecycle/atomic-release.ts. This removes the duplicate
  // recovery SQL that existed between tracker-view and orchestrate.ts
  // (blueprint §22:1199) and collapses the close/reconciler race
  // (blueprint §16:844): the function's fence CAS means only one of the two
  // callers wins; the other no-ops.
  //
  // Legacy (pre-ADR-009, unfenced) assignments still need the old code path
  // because there is no execution row to terminalize — only a stale
  // assigned_to to clear.
  return withDbWrite(db => {
    const task = db.prepare(
      'SELECT id, title, status, assigned_to, tags, current_execution_id FROM tasks WHERE id=?',
    ).get(taskId);
    if (!task || task.assigned_to !== workerId) return false;
    let tags = [];
    try { tags = JSON.parse(task.tags || '[]'); } catch {}
    if (tags.includes('needs-human')) return false;

    // Fenced task: delegate to the atomic release path. The fence CAS inside
    // protects against the close/reconciler race — if orchestrate.ts already
    // released, this call no-ops on the task row (still terminalizes nothing
    // because execution is already terminal).
    if (executionId && task.current_execution_id === executionId) {
      const terminalState = reason && /exit\s*code/i.test(String(reason)) ? 'exited' : 'lost';
      const outcome = releaseExecutionAtomically(db, {
        executionId,
        terminalState,
        exitCode: null,
        reason: `runner recovery: ${reason}`,
      });
      if (outcome.taskReleased) {
        db.prepare(
          `INSERT INTO activity_log
            (entity_type, entity_id, action, field_name, old_value, new_value, summary)
           VALUES ('task', ?, 'status_changed', 'status', ?, ?, ?)`,
        ).run(taskId, task.status, outcome.restoredStatus,
          `Board runner recovered task '${task.title}' (atomic): ${reason}`);
      }
      return outcome.taskReleased;
    }

    // Legacy path: pre-ADR-009 unfenced assignment. Keep the old SQL — there
    // is no execution to terminalize.
    let restoredStatus = originalStatus === 'review' ? 'review' : 'todo';
    if (originalStatus === 'review' && task.status === 'in_progress') restoredStatus = 'todo';
    const info = db.prepare(
      `UPDATE tasks SET status=?, assigned_to=NULL, current_execution_id=NULL,
         updated_at=datetime('now')
       WHERE id=? AND assigned_to=?
         AND (current_execution_id IS NULL OR current_execution_id=?)`,
    ).run(restoredStatus, taskId, workerId, executionId ?? null);
    if (info.changes === 1) {
      db.prepare(
        `INSERT INTO activity_log
          (entity_type, entity_id, action, field_name, old_value, new_value, summary)
         VALUES ('task', ?, 'status_changed', 'status', ?, ?, ?)`,
      ).run(taskId, task.status, restoredStatus, `Board runner recovered task '${task.title}': ${reason}`);
    }
    return info.changes === 1;
  });
}

// Constructs the singleton boardRunner. All runtime-config-derived paths
// (sagaEntry, sagaSkillRoot, dbPath, lmstudioBaseUrl, claudePath, logRoot) are
// passed in from the composition root so this module stays free of globals.
export function createBoardRunnerAdapter({
  runtimeConfig, sagaEntry, sagaSkillRoot, dbPath, lmstudioBaseUrl,
}) {
  const boardRunner = createClaudeBoardRunner({
    claimTask: args => dispatcherHandlers.worker_next(args),
    getProject: projectId => withDb(db => db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)),
    getTaskState: getRunnerTaskState,
    recoverAssignment: recoverRunnerAssignment,
    resolveWorkspace: resolveProjectWorkspace,
    dbPath,
    sagaEntry,
    sagaSkillRoot,
    claudePath: runtimeConfig.claudePath,
    lmstudioBaseUrl,
    logRoot: runtimeConfig.orchestrationLogRoot,
    // Provider + effort routing for the board-run path (mirrors the engine's
    // legacy-claude-worker-executor-factory.ts and
    // sqlite-factory-runtime-repositories.readWorkerModelRoute). Reads
    // model_name / model_provider / model_effort from the episode's
    // lifecycle_execution_controls row so the runner can point the worker at
    // LM Studio and omit --effort for it. Returns the zai/null default when the
    // episode has no chosen model yet.
    getActiveModel: epicId => {
      if (!epicId) return { model: null, provider: 'zai', effort: null };
      try {
        const row = withDb(db => db.prepare(
          `SELECT model_name AS m, model_provider AS p, model_effort AS e
             FROM lifecycle_execution_controls WHERE epic_id=?`,
        ).get(epicId));
        return { model: row?.m ?? null, provider: row?.p ?? 'zai', effort: row?.e ?? null };
      } catch { return { model: null, provider: 'zai', effort: null }; }
    },
  });
  return boardRunner;
}
