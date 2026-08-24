// tests/factory-contract/scenario-scripted-executor.mjs
//
// Test-only physical worker substitution behind the real WorkerExecutorFactory
// port. Process termination is interpreted by the SAME production finalizer as
// in-process replay: OS exit alone never fabricates semantic completion.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const execMod = await import(pathToFileURL(path.resolve('dist/worker-executions.js')).href);
const markExecutionRunning = execMod.markExecutionRunning;

// Git Desk parity: the scripted executor provisions the SAME per-task git
// worktree production uses (RepositoryDeskProvisioner). Without this, all
// scripted workers share SAGA_BUTTON_REPO_PATH and `git checkout -B` races
// when Development dispatches ≥2 implementation items concurrently. The race
// orphans source commits → PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH.
const deskProvisionerMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/repository-desk-provisioner.js')).href
);
const RepositoryDeskProvisioner = deskProvisionerMod.RepositoryDeskProvisioner;
const effectiveDeskBaseMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/effective-desk-base.js')).href
);
const resolveEffectiveDeskBase = effectiveDeskBaseMod.resolveEffectiveDeskBase;

const terminationMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/worker-process-termination.js')).href
);
const finalizeManagedWorkerProcess = terminationMod.finalizeManagedWorkerProcess;

const dbMod = await import(pathToFileURL(path.resolve('dist/db.js')).href);
const openDb = dbMod.getDb;

// Replay support: import the SAME capsule replay executor and MCP handler
// containers the production claude executor uses. When an assignment carries
// a frozen capsule_ref, the scripted executor replays the capsule instead of
// spawning a scripted worker — proving zero scripted inference calls on
// compatible replay hits.
const replayMod = await import(pathToFileURL(path.resolve('dist/infrastructure/replay/capsule-replay-executor.js')).href);
const executeCapsuleReplay = replayMod.executeCapsuleReplay;
const productHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/products.js')).href);
const artifactHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/artifacts.js')).href);
const dispatcherHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/dispatcher.js')).href);

function hasFrozenCapsule(assignment) {
  const ctx = assignment?.executionContext;
  if (!ctx || typeof ctx !== 'object') return false;
  const replay = ctx.replay;
  return !!replay && typeof replay.capsule_ref === 'string' && replay.capsule_ref.length > 0;
}

function runCapsuleReplay(dbPath, assignment, workspaceRoot) {
  const { getDb } = dbMod;
  process.env.DB_PATH = dbPath;
  const db = getDb();
  const cwd = assignment?.executionContext?.repository_desk?.execution_path || workspaceRoot || process.cwd();
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = assignment.workerExecutionId;
  process.env.SAGA_TASK_ID = String(assignment.taskId);
  process.env.SAGA_WORKER_ID = assignment.workerId;
  db.prepare(
    `UPDATE worker_executions SET state='running', started_at=datetime('now'), phase_updated_at=datetime('now') WHERE execution_id=? AND state='reserved'`,
  ).run(assignment.workerExecutionId);
  try {
    const handlers = {
      product_submit: input => productHandlersMod.handlers.product_submit(input),
      artifact_create: input => artifactHandlersMod.handlers.artifact_create(input),
      trace_add: input => artifactHandlersMod.handlers.trace_add(input),
      worker_done: input => dispatcherHandlersMod.handlers.worker_done(input),
    };
    executeCapsuleReplay(db, handlers, {
      taskId: Number(assignment.taskId),
      workerId: assignment.workerId,
      executionId: assignment.workerExecutionId,
      cwd,
    });
    handlers.worker_done({
      task_id: Number(assignment.taskId),
      worker_id: assignment.workerId,
      result: 'capsule replay: reconstructed accepted worker production',
      execution_id: assignment.workerExecutionId,
    });
    db.prepare(
      `UPDATE worker_executions SET state='exited', exit_code=0, finished_at=datetime('now'), phase_updated_at=datetime('now') WHERE execution_id=? AND state IN ('running','finishing')`,
    ).run(assignment.workerExecutionId);
  } finally {
    delete process.env.SAGA_MANAGED_EXECUTION;
    delete process.env.SAGA_EXECUTION_ID;
    delete process.env.SAGA_TASK_ID;
    delete process.env.SAGA_WORKER_ID;
  }
}

/**
 * Provision a per-task git worktree desk, mirroring production
 * (claude-worker-executor-factory.ts provisionRepositoryDesk). Returns
 * { executionPath, branch, baseCommit, integrationBranch, repositoryRoot }
 * or null when the task is not git_change / has no repository binding.
 *
 * This is the ONLY place in the scripted harness that runs `git worktree`.
 * Each scripted worker commits inside its own isolated worktree on branch
 * task/<id>, eliminating the shared-checkout race that caused
 * PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH under concurrency ≥ 2.
 */
function provisionScriptedDesk(dbPath, assignment) {
  const repo = assignment.repository;
  if (!repo || !repo.local_path) return null;

  // Read the full task row to get execution_mode, metadata, status.
  const { getDb } = dbMod;
  const savedDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  let db;
  try {
    db = getDb();
  } finally {
    process.env.DB_PATH = savedDbPath;
  }
  const task = db.prepare(
    'SELECT id,workplace_ref,execution_mode,project_repository_id,status,metadata FROM tasks WHERE id=?',
  ).get(Number(assignment.taskId));
  if (!task || task.execution_mode !== 'git_change') return null;

  const projectRepositoryId = task.project_repository_id ?? repo.id;
  const integrationBranch = repo.integration_branch || 'dev';
  const provisioner = new RepositoryDeskProvisioner();
  const isReview = assignment.status === 'review_in_progress';

  if (isReview) {
    // Reviewer: read-only detached worktree at the accepted source commit.
    const row = db.prepare(
      `SELECT payload_snapshot FROM factory_managed_node_submissions
        WHERE task_id=? ORDER BY id DESC LIMIT 1`,
    ).get(Number(assignment.taskId));
    if (!row?.payload_snapshot) return null;
    let sourceCommit = null;
    try {
      const payload = JSON.parse(row.payload_snapshot);
      sourceCommit = payload?.source?.commitSha ?? null;
    } catch { /* fall through */ }
    if (typeof sourceCommit !== 'string' || !sourceCommit) return null;
    const desk = provisioner.provisionReviewerDesk({
      repositoryRoot: repo.local_path,
      taskId: Number(assignment.taskId),
      sourceCommit,
      projectRepositoryId,
      integrationBranch,
    });
    return {
      executionPath: desk.executionPath,
      branch: desk.git.branch,
      baseCommit: desk.git.baseCommit,
      headCommit: desk.git.headCommit,
      integrationBranch: desk.git.integrationBranch,
      repositoryRoot: desk.repositoryRoot,
      detached: desk.git.detached,
    };
  }

  // Author: use the SAME durable dependency-aware base resolver as production.
  // This keeps the scripted worker substitution below the authority boundary;
  // it may replace inference, but it may not invent a weaker desk lineage.
  const baseReceipt = resolveEffectiveDeskBase(db, {
    executionRef: assignment.workerExecutionId,
    task,
    repository: {
      id: projectRepositoryId,
      integrationBranch,
      repositoryRoot: repo.local_path,
    },
  });

  const desk = provisioner.provisionAuthorDesk({
    repositoryRoot: repo.local_path,
    taskId: Number(assignment.taskId),
    executionRef: assignment.workerExecutionId,
    integrationBranch,
    baseCommit: baseReceipt.effectiveBaseCommit,
    projectRepositoryId,
    expectedIntegrationHead: baseReceipt.observedIntegrationHead,
    effectiveBaseReceiptRef: baseReceipt.receiptRef,
    effectiveBaseReceiptDigest: baseReceipt.receiptDigest,
  });
  return {
    executionPath: desk.executionPath,
    branch: desk.git.branch,
    baseCommit: desk.git.baseCommit,
    headCommit: desk.git.headCommit,
    integrationBranch: desk.git.integrationBranch,
    repositoryRoot: desk.repositoryRoot,
    detached: desk.git.detached,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createScriptedWorkerExecutorFactory(opts = {}) {
  const dispatcherPath = opts.dispatcherPath || path.join(__dirname, 'scenario-dispatcher.mjs');
  return (context) => {
    const runId = `scenario-${randomUUID().slice(0, 8)}`;
    let activeChild = null;
    let disposed = false;
    let completed = 0;
    let failed = 0;
    let claimed = 0;
    let startedAt = null;
    let finishedAt = null;
    let lastError = null;

    const sagaEntry = path.resolve('dist/index.js');

    return {
      start(command) {
        const { assignment } = command;
        if (disposed) throw new Error('ScriptedWorkerExecutor: disposed');
        if (activeChild) throw new Error('ScriptedWorkerExecutor: already running');

        claimed++;
        startedAt = new Date().toISOString();
        lastError = null;

        // CONVEYOR v4.3 PART 1-2: when a frozen capsule_ref is present, replay
        // the capsule instead of spawning a scripted worker. This is the SAME
        // in-process replay path the production claude executor uses. Proves
        // zero scripted inference calls on compatible replay hits.
        if (hasFrozenCapsule(assignment)) {
          const replayRunId = `replay-${assignment.workerExecutionId.slice(-8)}`;
          try {
            runCapsuleReplay(context.dbPath, assignment, context.workspaceRoot);
            completed++;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            failed++;
            process.stderr.write(`[scenario-executor] capsule replay FAILED: ${lastError}\n`);
          }
          finishedAt = new Date().toISOString();
          return {
            id: replayRunId,
            project_id: assignment.projectId,
            concurrency: 1,
            status: 'completed',
            started_at: startedAt,
            finished_at: finishedAt,
            active: [],
            completed, failed, claimed, last_error: lastError,
          };
        }

        let terminationHandled = false;

        const mcpConfigPath = path.join(os.tmpdir(), `saga-scenario-mcp-${randomUUID().slice(0, 8)}.json`);
        writeFileSync(mcpConfigPath, JSON.stringify({
          mcpServers: {
            saga: {
              type: 'stdio',
              command: 'node',
              args: [sagaEntry],
              env: {
                DB_PATH: context.dbPath,
                TRACKER_AUTOSTART: '0',
                SAGA_MANAGED_EXECUTION: '1',
                SAGA_EXECUTION_ID: assignment.workerExecutionId,
                SAGA_TASK_ID: String(assignment.taskId),
                SAGA_WORKER_ID: assignment.workerId,
              },
            },
          },
        }, null, 2));

        const task = assignment;
        const prompt = [
          `project_id=${task.projectId}`,
          `task_id=${task.taskId}`,
          `worker_id=${task.workerId}`,
          `execution_id=${task.workerExecutionId}`,
          `role=author`,
          '',
          'You are a single-use Saga CLI worker.',
        ].join('\n');

        // Git Desk parity: provision a per-task git worktree (same as
        // production). The scenario worker commits inside this isolated desk
        // instead of the shared root. Null for non-git tasks.
        let desk = null;
        try {
          desk = provisionScriptedDesk(context.dbPath, assignment);
        } catch (error) {
          process.stderr.write(`[scenario-executor] desk provision failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`);
        }
        const deskEnv = desk ? {
          SAGA_DESK_EXECUTION_PATH: desk.executionPath,
          SAGA_DESK_BRANCH: desk.branch,
          SAGA_DESK_BASE_COMMIT: desk.baseCommit,
          SAGA_DESK_HEAD_COMMIT: desk.headCommit || '',
          SAGA_DESK_INTEGRATION_BRANCH: desk.integrationBranch,
          SAGA_DESK_REPOSITORY_ROOT: desk.repositoryRoot,
          SAGA_DESK_DETACHED: desk.detached ? '1' : '0',
        } : {};
        const deskCwd = desk ? desk.executionPath : (context.workspaceRoot || process.cwd());

        activeChild = spawn('node', [
          dispatcherPath,
          '-p', '--bare',
          '--mcp-config', mcpConfigPath,
          '--strict-mcp-config',
        ], {
          cwd: deskCwd,
          env: {
            ...process.env,
            SAGA_EXECUTION_ID: assignment.workerExecutionId,
            SAGA_TASK_ID: String(assignment.taskId),
            SAGA_WORKER_ID: assignment.workerId,
            SAGA_RUN_ID: runId,
            SAGA_PROJECT_ID: String(assignment.projectId),
            ...(opts.scenariosPath ? { SAGA_SCENARIOS: opts.scenariosPath } : {}),
            ...(opts.invocationLogPath ? { SAGA_INVOCATION_LOG: opts.invocationLogPath } : {}),
            ...deskEnv,
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        activeChild.stdin.write(prompt);
        activeChild.stdin.end();

        if (!markExecutionRunning || !finalizeManagedWorkerProcess || !openDb) {
          throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: production lifecycle primitive unavailable');
        }
        // Production-fidelity liveness identity: record the REAL child pid and
        // OS birth token, exactly like the production executor does. The
        // supervision policy (stuck-policy.ts) releases a RUNNING row as lost
        // IMMEDIATELY when the PID probe reads dead — and a null-pid row
        // always reads dead — so an empty-queue sweep pass (orchestrate-cli
        // runs reconcileOnce whenever the queue drains) releases the LIVE
        // scripted execution mid-protocol; the dispatch loop then observes
        // durableTerminal, disposes the executor and kills the running child
        // (observed 2026-08-24: transient MANAGED_NODE_SUBMISSION_FENCE_LOST
        // on first-dispatch-of-cell moments, nondeterministically consuming
        // captured planner repair rounds). The token is read BEFORE
        // markExecutionRunning flips the row to 'running': while the row is
        // still 'reserved' the notAlive arm cannot fire (RESERVED_BOOT
        // timeout owns reserved rows), so the CIM query latency is safe. The
        // Windows CIM registration of a just-spawned process can transiently
        // lag, hence the bounded retries; if all fail we record no pid (the
        // old behavior) rather than an unfenceable pid-without-token.
        const childPid = activeChild.pid ?? null;
        let childBirthToken = null;
        if (childPid !== null && typeof execMod.readProcessBirthToken === 'function') {
          for (let tokenAttempt = 0; tokenAttempt < 3 && childBirthToken === null; tokenAttempt += 1) {
            try {
              childBirthToken = execMod.readProcessBirthToken(childPid) ?? null;
            } catch { childBirthToken = null; }
            if (childBirthToken === null && tokenAttempt < 2) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
            }
          }
        }
        markExecutionRunning(
          context.dbPath, assignment.workerExecutionId,
          childBirthToken !== null ? childPid : null, childBirthToken,
          `scenario-${runId}`, new Date().toISOString(),
        );

        activeChild.stderr?.setEncoding('utf8');
        activeChild.stderr?.on('data', c => process.stderr.write(c));

        const finalize = ({ code = null, spawnFailure = false, reason }) => {
          if (terminationHandled) return;
          terminationHandled = true;
          try { if (existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath); } catch {}
          process.env.DB_PATH = context.dbPath;
          try {
            const outcome = finalizeManagedWorkerProcess(openDb(), {
              taskId: Number(assignment.taskId),
              executionId: String(assignment.workerExecutionId),
              exitCode: code,
              reason,
              spawnFailure,
            });
            process.stderr.write(
              `[scenario-executor] finalizer: state=${outcome.executionState} ` +
              `semantic=${outcome.semanticCompletion} repair=${outcome.workplaceRepairRequested} ` +
              `released=${outcome.taskReleased} blocked=${outcome.blockedReason || '(none)'}\n`,
            );
            if (outcome.semanticCompletion) completed++;
            else failed++;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            failed++;
            process.stderr.write(`[scenario-executor] FATAL finalizer failure: ${lastError}\n`);
          }
          activeChild = null;
          finishedAt = new Date().toISOString();
        };

        activeChild.once('close', code => {
          process.stderr.write(`[scenario-executor] child closed: code=${code}\n`);
          finalize({
            code: code ?? 0,
            reason: code === 0
              ? 'scenario worker process exited'
              : `scenario worker process exited non-zero (${code})`,
          });
        });

        activeChild.once('error', error => {
          finalize({
            spawnFailure: true,
            reason: `scenario worker spawn failed: ${error.message}`,
          });
        });

        return {
          id: runId,
          project_id: task.projectId,
          concurrency: 1,
          status: 'running',
          started_at: startedAt,
          finished_at: null,
          active: [{
            task_id: task.taskId,
            worker_id: task.workerId,
            pid: activeChild.pid,
            started_at: startedAt,
          }],
          completed, failed, claimed, last_error: lastError,
        };
      },

      stop() {
        if (activeChild) { try { activeChild.kill('SIGTERM'); } catch {} }
        return null;
      },

      status(projectId) {
        if (!activeChild && !startedAt) return null;
        return {
          id: runId,
          project_id: projectId,
          concurrency: 1,
          status: activeChild ? 'running' : (failed > 0 ? 'failed' : 'completed'),
          started_at: startedAt,
          finished_at: finishedAt,
          active: activeChild ? [{ task_id: null, worker_id: null, pid: activeChild.pid }] : [],
          completed, failed, claimed, last_error: lastError,
        };
      },

      setConcurrency() {},
      dispose() {
        disposed = true;
        if (activeChild) { try { activeChild.kill('SIGTERM'); } catch {} activeChild = null; }
      },
    };
  };
}
