import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

// ESM .mjs files don't have `require` — use createRequire to load CJS
// modules (better-sqlite3 is CJS). Used for worker_pid persistence.
const require = createRequire(import.meta.url);

const TERMINAL_RUN_STATES = new Set(['completed', 'stopped', 'failed']);

function nowIso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function roleFromTask(task, fallbackSkill) {
  let tags = [];
  try { tags = JSON.parse(task.tags || '[]'); } catch {}
  const roleTag = tags.find(tag => typeof tag === 'string' && tag.startsWith('role:'));
  if (roleTag) return roleTag.slice('role:'.length);
  return fallbackSkill === 'saga-reviewer' ? 'reviewer' : 'developer';
}

function buildPrompt({ assignment, project, workerId, workspaceRoot, sagaSkillRoot }) {
  const task = assignment.task;
  const role = roleFromTask(task, assignment.skill);
  const selectedSkill = assignment.skill || `saga-${role}`;
  const roleSkill = path.join(sagaSkillRoot, selectedSkill, 'SKILL.md');
  const workerSkill = path.join(sagaSkillRoot, 'saga-worker', 'SKILL.md');
  const skillPath = existsSync(roleSkill) ? roleSkill : workerSkill;
  const isReview = task.status === 'review' || task.status === 'review_in_progress';

  return [
    'You are a single-use Saga CLI worker. Saga already atomically assigned exactly one task to this process.',
    '',
    `project_id=${project.id}`,
    `project_name=${project.name}`,
    `task_id=${task.id}`,
    `worker_id=${workerId}`,
    `role=${role}`,
    `dispatcher_skill=${assignment.skill}`,
    `task_kind=${task.task_kind || 'legacy'}`,
    `workflow_stage=${task.workflow_stage || 'legacy'}`,
    `execution_mode=${task.execution_mode || 'git_change'}`,
    `repository=${assignment.repository?.name || 'legacy-project-workspace'}`,
    `workspace_root=${workspaceRoot}`,
    '',
    'Hard rules:',
    '0. IMMEDIATELY on startup, before any other action, run this heartbeat command exactly once (it marks you as alive for the operator):',
    `   bash -c 'echo "$(date -u +%FT%TZ) pid=$$ worker=${workerId} project=${project.id} task=${task.id} CLAIMED started" >> ~/.zcode/cli/worker-heartbeat.log'`,
    `1. Work only on task_id=${task.id}.`,
    '2. Never call worker_next; it is explicitly disabled for this process.',
    '3. Read the assigned task and its context through Saga MCP as needed.',
    `4. Read ${skillPath} for the role workflow, but SKIP every instruction that claims or selects a task.`,
    task.execution_mode === 'git_change'
      ? '5. Use the existing task worktree/branch conventions from the skill.'
      : '5. This task is not a git-change task. Do not create a worktree or merge unless the assigned skill explicitly requires one.',
    isReview
      ? '6. Review the assigned implementation and call worker_done exactly once with verdict approved or changes_requested.'
      : '6. Complete the assigned task according to its selected skill, verify its output, and call worker_done exactly once with a truthful result.',
    task.execution_mode === 'git_change' && isReview
      ? '7. If APPROVED reaches done, stop:true means do not claim another task: first acquire the repository merge lock, merge into the assigned integration branch, call worker_merge_release, then summarize and exit.'
      : '7. After worker_done returns stop:true, do not claim another task; finish any required terminal protocol, then return a concise summary and exit.',
    '8. Do not start, select, or accept another task. Do not spawn nested agents.',
    task.task_kind === 'verification.ac'
      ? `9. Before worker_done, call verification_record for every assigned AC with recorded_by="${workerId}" and truthful pass/fail evidence.`
      : '9. Preserve the task provenance and do not create unrelated downstream work.',
    '',
    'Assigned task payload:',
    JSON.stringify(task, null, 2),
  ].join('\n');
}

export class ClaudeBoardRunner {
  constructor(options) {
    this.claimTask = options.claimTask;
    this.getProject = options.getProject;
    this.getTaskState = options.getTaskState;
    this.recoverAssignment = options.recoverAssignment;
    this.resolveWorkspace = options.resolveWorkspace;
    this.spawn = options.spawn ?? nodeSpawn;
    this.claudePath = options.claudePath ?? process.env.SAGA_CLAUDE_PATH ?? 'claude';
    this.dbPath = options.dbPath;
    this.sagaEntry = options.sagaEntry;
    this.sagaSkillRoot = options.sagaSkillRoot;
    this.logRoot = options.logRoot ?? path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
    // Единый heartbeat-лог всех воркеров (для наблюдения за запущенными агентами).
    // Plain text, по строке на событие. Смотреть через tail -f.
    this.heartbeatLog = options.heartbeatLog ?? path.join(os.homedir(), '.zcode', 'cli', 'worker-heartbeat.log');
    this.runs = new Map();
    this.sequence = 0;
    this.mcpConfigPath = path.join(os.tmpdir(), `saga-claude-mcp-${process.pid}.json`);
    this.writeMcpConfig();
  }

  // Записать строку в heartbeat-лог. Формат:
  //   <iso> pid=<pid> worker=<id> project=<id> [<name>] task=<id> <EVENT> <message>
  // Используется runner'ом при старте (STARTED) и завершении (CLOSED/FAILED).
  // Воркер пишет CLAIMED/STEP отдельно из скилла (см. saga-worker/SKILL.md).
  heartbeat(run, execution, event, message) {
    const line = [
      nowIso(),
      `pid=${execution?.child?.pid ?? '?'}`,
      `worker=${execution?.workerId ?? '?'}`,
      `project=${run.projectId} [${run.projectName}]`,
      `task=${execution?.taskId ?? '?'}`,
      event,
      message || '',
    ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
    try {
      writeFileSync(this.heartbeatLog, line, { flag: 'a' });
    } catch {
      // лог не критичен — падать не должны
    }
  }

  writeMcpConfig() {
    const config = {
      mcpServers: {
        saga: {
          type: 'stdio',
          command: 'node',
          args: [this.sagaEntry],
          env: {
            DB_PATH: this.dbPath,
            TRACKER_AUTOSTART: '0',
          },
        },
      },
    };
    writeFileSync(this.mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  dispose() {
    for (const run of this.runs.values()) this.stop(run.projectId);
    try { rmSync(this.mcpConfigPath, { force: true }); } catch {}
  }

  start({ projectId, concurrency }) {
    const existing = this.runs.get(projectId);
    if (existing && !TERMINAL_RUN_STATES.has(existing.status)) {
      throw new Error(`Project ${projectId} already has an active board run`);
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw new Error('concurrency must be an integer from 1 to 10');
    }

    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const workspaceRoot = this.resolveWorkspace(project);

    const runId = `board-${projectId}-${Date.now()}`;
    const run = {
      id: runId,
      projectId,
      projectName: project.name,
      workspaceRoot,
      concurrency,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      active: new Map(),
      completed: 0,
      failed: 0,
      claimed: 0,
      lastError: null,
      emptyChecks: 0,
      stopRequested: false,
    };
    this.runs.set(projectId, run);
    mkdirSync(path.join(this.logRoot, safeName(runId)), { recursive: true });
    queueMicrotask(() => this.pump(run));
    return this.snapshot(run);
  }

  stop(projectId) {
    const run = this.runs.get(projectId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return run ? this.snapshot(run) : null;
    run.stopRequested = true;
    run.status = 'stopping';
    for (const execution of run.active.values()) {
      try { execution.child.kill(); } catch {}
    }
    if (run.active.size === 0) this.finish(run, 'stopped');
    return this.snapshot(run);
  }

  status(projectId) {
    const run = this.runs.get(projectId);
    return run ? this.snapshot(run) : null;
  }

  // Live concurrency adjustment — the "natural rotation" mechanism. Calling
  // this does NOT kill or spawn anything. It only changes the ceiling that
  // pump() checks on every close event: `run.active.size < run.concurrency`.
  // When an active worker finishes naturally → pump decides whether to spawn
  // a replacement based on the new ceiling.
  //
  // Used by: model change (lower ceiling when switching to a smaller model),
  // rate-limit recovery (drop ceiling on 429, climb back after cooldown),
  // concurrency selector (user-initiated change via /api/engine/restart).
  setConcurrency(projectId, concurrency) {
    const run = this.runs.get(projectId);
    if (!run) return;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) return;
    run.concurrency = concurrency;
  }

  snapshot(run) {
    return {
      id: run.id,
      project_id: run.projectId,
      project_name: run.projectName,
      concurrency: run.concurrency,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      active: [...run.active.values()].map(execution => ({
        task_id: execution.taskId,
        title: execution.title,
        worker_id: execution.workerId,
        pid: execution.child.pid ?? null,
        started_at: execution.startedAt,
        // Exposed so the live-workers panel can fetch /api/worker/tail
        // and show the worker's real-time stream-json events.
        log_path: execution.logPath,
      })),
      completed: run.completed,
      failed: run.failed,
      claimed: run.claimed,
      last_error: run.lastError,
    };
  }

  finish(run, status) {
    if (TERMINAL_RUN_STATES.has(run.status)) return;
    run.status = status;
    run.finishedAt = nowIso();
  }

  pump(run) {
    if (run.stopRequested || run.status !== 'running') {
      if (run.active.size === 0) this.finish(run, 'stopped');
      return;
    }

    let claimedAny = false;
    while (run.active.size < run.concurrency && run.status === 'running') {
      const workerId = `board-${run.projectId}-${Date.now()}-${++this.sequence}`;
      let assignment;
      try {
        assignment = this.claimTask({
          worker_id: workerId,
          project_id: run.projectId,
          machine_id: os.hostname(),
        });
      } catch (error) {
        run.lastError = error instanceof Error ? error.message : String(error);
        run.failed += 1;
        this.finish(run, 'failed');
        return;
      }

      if (!assignment?.task) break;
      claimedAny = true;
      run.claimed += 1;
      try {
        this.launch(run, assignment, workerId);
      } catch (error) {
        run.failed += 1;
        run.lastError = error instanceof Error ? error.message : String(error);
        this.recoverAssignment({
          taskId: assignment.task.id,
          workerId,
          originalStatus: assignment.task.status,
          reason: `Claude spawn failed: ${run.lastError}`,
        });
      }
    }

    if (!claimedAny && run.active.size === 0) {
      run.emptyChecks += 1;
      this.finish(run, run.failed > 0 && run.completed === 0 ? 'failed' : 'completed');
    }
  }

  launch(run, assignment, workerId) {
    const task = assignment.task;
    const workspaceRoot = assignment.repository?.local_path || run.workspaceRoot;
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      throw new Error(
        assignment.repository
          ? `Local checkout for repository '${assignment.repository.name}' was not found`
          : `Legacy workspace for project '${run.projectName}' was not found`,
      );
    }
    const prompt = buildPrompt({
      assignment,
      project: { id: run.projectId, name: run.projectName },
      workerId,
      workspaceRoot,
      sagaSkillRoot: this.sagaSkillRoot,
    });
    const args = [
      '-p',
      '--model', 'opus',
      '--effort', 'xhigh',
      '--mcp-config', this.mcpConfigPath,
      '--strict-mcp-config',
      '--disallowedTools', 'mcp__saga__worker_next',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      // stream-json: one JSON event per line in real time (system/init,
      // assistant text, tool_use, tool_result, system/api_retry, result).
      // --verbose is required by stream-json (docs pair them in every example).
      // --forward-subagent-text (2.1.211+, we run 2.1.212): surfaces subagent
      // text+thinking so kickstart's 3 parallel assessors are visible in the
      // JSONL log, not just their tool calls.
      // SAFE: close handler reads task status from DB (getTaskState, l.343),
      // not from stdout — so changing output format has zero effect on runner
      // control flow. JSONL file is write-only (no in-repo consumer).
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--no-session-persistence',
      prompt,
    ];
    const child = this.spawn(this.claudePath, args, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        SAGA_RUN_ID: run.id,
        SAGA_WORKER_ID: workerId,
        SAGA_TASK_ID: String(task.id),
        // Для heartbeat-лога из скилла воркера (см. saga-worker/SKILL.md):
        SAGA_PROJECT_ID: String(run.projectId),
        SAGA_PROJECT_NAME: run.projectName,
        SAGA_TASK_TITLE: task.title,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logPath = path.join(this.logRoot, safeName(run.id), `task-${task.id}-${safeName(workerId)}.jsonl`);
    const log = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    const execution = {
      taskId: task.id,
      title: task.title,
      workerId,
      originalStatus: task.status,
      child,
      log,
      logPath,
      startedAt: nowIso(),
      workspaceRoot,
      repository: assignment.repository?.name || null,
    };
    run.active.set(workerId, execution);

    // Persist worker PID into task.metadata so external observers (engine
    // zombie-detector, manual kill via /api/engine/restart, debug tooling)
    // can locate and terminate the worker subprocess by PID without needing
    // access to this runner's in-memory state. Cheap UPDATE, runs once per
    // worker spawn.
    try {
      const pid = child.pid;
      const db = require('better-sqlite3')(this.dbPath);
      db.prepare(
        `UPDATE tasks SET metadata=json_set(COALESCE(metadata,'{}'),
            '$.worker_pid', ?,
            '$.worker_started_at', ?),
            updated_at=datetime('now')
         WHERE id=?`,
      ).run(pid, execution.startedAt, task.id);
      db.close();
    } catch (e) {
      // Non-critical: if the DB write fails the worker still runs, we just
      // lose the ability to kill it by PID later. Log to board-run JSONL.
      try { execution.log.write(`[runner] worker_pid persist failed: ${e.message}\n`); } catch {}
    }

    // Heartbeat: воркер стартовал (spawn завершён, процесс жив).
    this.heartbeat(run, execution, 'STARTED',
      `claude -p task_id=${task.id} role=${roleFromTask(task, assignment.skill)} pid=${child.pid}`);

    child.once('error', error => {
      run.lastError = error instanceof Error ? error.message : String(error);
      this.heartbeat(run, execution, 'ERROR', `spawn error: ${run.lastError}`);
    });
    child.once('close', code => {
      try { log.end(); } catch {}
      run.active.delete(workerId);
      const taskState = this.getTaskState(task.id);
      const integrationComplete = !(
        task.status === 'review'
        && task.task_kind
        && task.execution_mode === 'git_change'
      ) || taskState?.integration_state === 'merged';
      const completed = taskState &&
        (taskState.status === 'review' || taskState.status === 'done') &&
        !taskState.assigned_to &&
        integrationComplete;
      const changesRequested = code === 0 &&
        task.status === 'review' &&
        taskState?.status === 'in_progress' &&
        taskState.assigned_to === workerId;

      if (completed && code === 0) {
        run.completed += 1;
        this.heartbeat(run, execution, 'CLOSED',
          `exit=0 completed status=${taskState?.status || '?'}`);
      } else if (changesRequested) {
        this.recoverAssignment({
          taskId: task.id,
          workerId,
          originalStatus: task.status,
          reason: 'Review completed with changes_requested; returning task to the development queue',
        });
        run.completed += 1;
        this.heartbeat(run, execution, 'CLOSED',
          `exit=0 changes_requested → returned to dev queue`);
      } else {
        run.failed += 1;
        run.lastError = `Task ${task.id} Claude process exited with code ${code} before terminal worker_done`;
        this.heartbeat(run, execution, 'FAILED',
          `exit=${code} before worker_done → task recovered`);
        this.recoverAssignment({
          taskId: task.id,
          workerId,
          originalStatus: task.status,
          reason: run.lastError,
        });
      }

      if (run.stopRequested) {
        if (run.active.size === 0) this.finish(run, 'stopped');
      } else {
        queueMicrotask(() => this.pump(run));
      }
    });
  }
}

export function createClaudeBoardRunner(options) {
  return new ClaudeBoardRunner(options);
}
