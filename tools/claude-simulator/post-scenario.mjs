import { spawnSync } from 'node:child_process';

function requireHandler(container, name) {
  const value = container?.handlers?.[name];
  if (typeof value !== 'function') throw new Error(`SIMULATOR_HANDLER_MISSING: ${name}`);
  return value;
}

export function maybeIntegrateApprovedReview(runtime, ctx, scenario, stream) {
  if (
    ctx.role !== 'reviewer'
    || ctx.execution_mode !== 'git_change'
    || ctx.task_kind === 'verification.ac'
  ) return;

  const completion = scenario.steps.find(step => step.type === 'worker_done');
  if (!completion || completion.args?.verdict !== 'approved') return;

  const db = runtime.dbModule.getDb();
  const task = db.prepare(
    'SELECT status, integration_state, metadata, project_repository_id FROM tasks WHERE id=?',
  ).get(ctx.task_id);
  if (!task || task.status !== 'done' || task.integration_state !== 'pending') return;

  const acquire = requireHandler(runtime.dispatcher, 'worker_merge_acquire');
  const release = requireHandler(runtime.dispatcher, 'worker_merge_release');
  const execution = ctx.execution_id ? { execution_id: ctx.execution_id } : {};
  acquire({ task_id: ctx.task_id, worker_id: ctx.worker_id, ...execution });

  const repository = db.prepare(
    `SELECT local_path, integration_branch FROM project_repositories WHERE id=?`,
  ).get(task.project_repository_id);
  let metadata = {};
  try { metadata = JSON.parse(task.metadata || '{}'); } catch { metadata = {}; }
  const repositoryPath = repository?.local_path || ctx.workspace_root || process.cwd();
  const branch = metadata?.worktree?.branch || `task/${ctx.task_id}`;

  const commit = spawnSync('git', ['-C', repositoryPath, 'commit', '--allow-empty',
    '-m', `simulator: complete task #${ctx.task_id}`], { encoding: 'utf8' });
  if (commit.status !== 0) {
    stream.text(`simulator: empty commit skipped: ${(commit.stderr || '').slice(0, 160)}`);
  }

  const merge = spawnSync('git', ['-C', repositoryPath, 'merge', '--no-ff',
    '-m', `simulator: merge task #${ctx.task_id}`, branch], { encoding: 'utf8' });
  if (merge.status !== 0) {
    spawnSync('git', ['-C', repositoryPath, 'merge', '--abort'], { encoding: 'utf8' });
    release({ task_id: ctx.task_id, worker_id: ctx.worker_id, result: 'conflict', ...execution });
    throw new Error(`SIMULATOR_GIT_MERGE_CONFLICT: task ${ctx.task_id}`);
  }

  const revision = spawnSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' });
  release({
    task_id: ctx.task_id,
    worker_id: ctx.worker_id,
    result: 'merged',
    commit_sha: revision.status === 0 ? revision.stdout.trim() : null,
    ...execution,
  });
  stream.text(`simulator: merged ${branch} into ${repository?.integration_branch || 'integration branch'}`);
}
