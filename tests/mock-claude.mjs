#!/usr/bin/env node
// Saga-mcp mock-claude — subprocess replacement for `claude.exe` in tests.
//
// The orchestrate engine spawns this script via `SAGA_CLAUDE_PATH=node tests/mock-claude.mjs`
// (see claude-runner.mjs:97 — claudePath = process.env.SAGA_CLAUDE_PATH ?? 'claude').
// It receives the same argv vector and env block as a real claude worker would,
// and must satisfy the close-handler contract in claude-runner.mjs:397-458.
//
// Behaviour (MVP): simulate 1 second of "work", then drive the saga DB through
// the canonical worker lifecycle:
//
//   verification.ac  →  verification_record(passed, target_AC)
//                      → worker_done(approved)
//   git_change review→  worker_done(approved)
//                      → worker_merge_acquire
//                      → empty git commit on task/<id>
//                      → worker_merge_release(merged)
//   anything else    →  worker_done(approved)
//
// Always exits 0. Always APPROVED. Never fails, never asks human, never emits
// rate-limit events. Future iterations will support fixture-driven failure
// scenarios (changes_requested, exit 1, cargo delay, rate-limit).
//
// JSONL stream-json output is minimal but shaped so the runner's
// /api/workers/active endpoint sees fresh mtime + a 'result' envelope.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// argv + prompt parsing
// ---------------------------------------------------------------------------

// claude-runner.mjs:329-352 passes these flags. We only need the positional
// prompt (last argv element) and the --mcp-config path.
function parseArgv(argv) {
  let mcpConfigPath = null;
  let prompt = '';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mcp-config' && i + 1 < argv.length) {
      mcpConfigPath = argv[++i];
    } else if (!a.startsWith('-')) {
      // Last positional wins (the prompt is the final arg).
      prompt = a;
    }
  }
  return { mcpConfigPath, prompt };
}

// The prompt is built by buildPrompt() in claude-runner.mjs:35-87. It always
// starts with key=value lines after the header. We extract the fields we need.
function parsePrompt(prompt) {
  const out = {};
  const lines = prompt.split('\n');
  for (const line of lines) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (['project_id', 'project_name', 'task_id', 'worker_id', 'execution_id',
         'role', 'dispatcher_skill', 'task_kind', 'workflow_stage',
         'execution_mode', 'repository', 'workspace_root'].includes(key)) {
      out[key] = value;
    }
    // Only parse until we hit "Hard rules:" — afterwards values are prose.
    if (line.startsWith('Hard rules:')) break;
  }
  // Coerce types.
  out.task_id = Number(out.task_id);
  out.project_id = Number(out.project_id);
  out.execution_id = out.execution_id === 'legacy' ? null : out.execution_id;
  return out;
}

// Read DB_PATH from --mcp-config JSON (written by claude-runner.mjs:132-147).
// Structure: { mcpServers: { saga: { env: { DB_PATH } } } }
function resolveDbPath(mcpConfigPath) {
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) {
    // Fallback: respect process.env.DB_PATH inherited from parent.
    return process.env.DB_PATH;
  }
  try {
    const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    const dbPath = cfg.mcpServers?.saga?.env?.DB_PATH;
    return dbPath || process.env.DB_PATH;
  } catch {
    return process.env.DB_PATH;
  }
}

// ---------------------------------------------------------------------------
// JSONL stream-json output (minimal but valid)
// ---------------------------------------------------------------------------

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitStreamHeader(model) {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: `mock-${process.pid}`,
    tools: ['mcp__saga__worker_done', 'mcp__saga__worker_merge_acquire',
            'mcp__saga__worker_merge_release', 'mcp__saga__verification_record'],
    mcp_servers: [{ name: 'saga', status: 'connected' }],
    model: model || 'mock-claude',
    permissionMode: 'bypassPermissions',
  });
}

function emitAssistantText(text) {
  emit({
    type: 'assistant',
    message: {
      id: `msg_mock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'mock-claude',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: `mock-${process.pid}`,
    uuid: `uuid_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  });
}

function emitResult(durationMs) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    ttft_ms: 1,
    num_turns: 1,
    result: 'mock worker completed successfully',
    stop_reason: 'end_turn',
    session_id: `mock-${process.pid}`,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock-claude',
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: `uuid_mock_result_${Date.now()}`,
  });
}

// ---------------------------------------------------------------------------
// Heartbeat (same file real claude workers write to via saga-worker skill)
// ---------------------------------------------------------------------------

function heartbeat(fields, event, message) {
  const line = [
    new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    `pid=${process.pid}`,
    `worker=${fields.worker_id}`,
    `project=${fields.project_id} [mock-project]`,
    `task=${fields.task_id}`,
    event,
    message || '',
  ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
  try {
    appendFileSync(join(homedir(), '.zcode', 'cli', 'worker-heartbeat.log'), line);
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Worker lifecycle — direct saga handler invocation
// ---------------------------------------------------------------------------

async function loadHandlers(dbPath) {
  // Set DB_PATH so getDb() inside the dist handlers resolves to our DB.
  process.env.DB_PATH = dbPath;
  // Force a fresh DB connection: getDb caches on first call. We reset by
  // importing the handlers module fresh — ESM cache makes this unreliable,
  // so we use the closeDb() helper exported alongside getDb.
  const dbMod = await import('../dist/db.js');
  if (typeof dbMod.closeDb === 'function') {
    try { dbMod.closeDb(); } catch { /* no active connection yet */ }
  }
  const dispatcher = await import('../dist/tools/dispatcher.js');
  const lifecycle = await import('../dist/tools/lifecycle.js');
  const tasks = await import('../dist/tools/tasks.js');
  const artifacts = await import('../dist/tools/artifacts.js');
  return { dispatcher, lifecycle, tasks, artifacts, dbMod };
}

// ---------------------------------------------------------------------------
// Helpers for kickstart brief emission (ADR-012 track tests)
// ---------------------------------------------------------------------------

function getEpicIdFromTask(handlers, taskId) {
  const db = handlers.dbMod.getDb();
  const row = db.prepare('SELECT epic_id FROM tasks WHERE id=?').get(taskId);
  if (!row) throw new Error(`task ${taskId} not found`);
  return row.epic_id;
}

// Build a BriefPayload (validators/brief.ts:31-52) for the given decision.
// For 'fast-track' the payload is eligible per canFastTrack (fast-track.ts:67-82):
// classification=tech-task, complexity.tshirt=S, affected_projects.length<=1,
// complexity.risk_triggers=[]. For other decisions eligibility doesn't matter.
function briefPayloadFor(decision, ctx) {
  const base = {
    classification: 'tech-task',
    complexity: { tshirt: 'S', risk_triggers: [] },
    decision,
    reasoning: `mock brief reasoning for task ${ctx.task_id} (${decision})`,
    affected_projects: [ctx.project_id],
    topology_hint: 'parallel-independent',
    scaffold_artifacts: [],
    shared_mutation_risk: false,
    completeness: 'high',
    degraded: false,
  };
  return base;
}

async function driveWorkerLifecycle(handlers, ctx) {
  const { dispatcher, lifecycle, artifacts } = handlers;
  const { task_id, worker_id, execution_id, task_kind, execution_mode, role } = ctx;
  const execArg = execution_id ? { execution_id } : {};

  // 0. For discovery.kickstart tasks: register a brief artifact with a
  //    brief_payload whose `decision` is controlled by the
  //    SAGA_MOCK_DECISION env var. The engine's brief_accepted transition
  //    (workflow.ts) reads this decision to pick a track. Without this
  //    branch the mock would just call worker_done on a kickstart task that
  //    never emitted a brief — brief_accepted would throw "no brief artifact".
  if (task_kind === 'discovery.kickstart') {
    try {
      const decision = process.env.SAGA_MOCK_DECISION || 'go';
      const payload = briefPayloadFor(decision, ctx);
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256')
        .update(JSON.stringify(payload)).digest('hex');
      artifacts.handlers.artifact_create({
        project_id: ctx.project_id,
        epic_id: getEpicIdFromTask(handlers, task_id),
        type: 'brief',
        code: 'BRIEF-1',
        title: `Mock brief: ${ctx.task_title || 'discovery'} (${decision})`,
        path: `docs/mock-brief-${task_id}.md`,
        status: 'accepted',
        content_hash: contentHash,
        metadata: { brief_payload: payload },
      });
      emitAssistantText(`mock: brief artifact registered (decision='${decision}')`);
    } catch (e) {
      emitAssistantText(`mock: brief registration failed: ${e.message}`);
    }
    // Fall through to worker_done below.
  }

  // 1. For verification.ac tasks: record passing evidence for the canonical AC
  //    before worker_done. The canonical target is stored on the task row
  //    (tasks.verification_target_artifact_id, set by planner + migration).
  if (task_kind === 'verification.ac') {
    try {
      // lifecycle.verification_record needs recorded_by + execution fence +
      // active task status. We pass them through.
      const dbMod = handlers.dbMod;
      const db = dbMod.getDb();
      const task = db.prepare(
        'SELECT verification_target_artifact_id FROM tasks WHERE id=?',
      ).get(task_id);
      const targetId = task?.verification_target_artifact_id;
      if (!targetId) {
        throw new Error(`verification task ${task_id} has no canonical AC target`);
      }
      lifecycle.handlers.verification_record({
        task_id,
        artifact_id: targetId,
        outcome: 'passed',
        evidence: 'mock-claude: AC verified PASS (deterministic mock, no test execution).',
        recorded_by: worker_id,
        provider: 'mock-claude',
        ...execArg,
      });
      emitAssistantText(`mock: verification_record passed for AC #${targetId}`);
    } catch (e) {
      emitAssistantText(`mock: verification_record failed: ${e.message}`);
      // Continue anyway — worker_done may still succeed.
    }
  }

  // 2. worker_done(approved). For in_progress → review; for review_in_progress → done.
  try {
    dispatcher.handlers.worker_done({
      task_id,
      worker_id,
      result: 'mock worker approved',
      verdict: 'approved',
      ...execArg,
    });
    emitAssistantText(`mock: worker_done approved for task #${task_id}`);
  } catch (e) {
    emitAssistantText(`mock: worker_done failed: ${e.message}`);
    throw e;
  }

  // 3. For git_change review tasks reaching done: worker_merge_acquire +
  //    empty commit on task/<id> + worker_merge_release(merged). The runner's
  //    close-handler treats integration_state='pending' as incomplete, so we
  //    must complete the merge to be classified as 'completed' instead of
  //    triggering recoverAssignment.
  //
  //    Detection: original task.status was 'review'/'review_in_progress' AND
  //    execution_mode='git_change'. We rely on task_kind !== 'verification.ac'
  //    (verification tasks are git_change but their worktrees were never
  //    branched; integration_state is 'not_required' for them and the gate
  //    skips them).
  if (execution_mode === 'git_change' && task_kind !== 'verification.ac') {
    try {
      const acquireResult = dispatcher.handlers.worker_merge_acquire({
        task_id,
        worker_id,
        ...execArg,
      });
      emitAssistantText(`mock: merge lock acquired for task #${task_id}`);

      // Create an empty commit on the task branch so the merge has something
      // to fast-forward. Skip if the worktree/branch isn't set up.
      const dbMod = handlers.dbMod;
      const db = dbMod.getDb();
      const task = db.prepare(
        `SELECT t.metadata, t.title, pr.local_path, pr.integration_branch
         FROM tasks t
         LEFT JOIN project_repositories pr ON pr.id = t.project_repository_id
         WHERE t.id=?`,
      ).get(task_id);
      let meta = {};
      try { meta = JSON.parse(task?.metadata || '{}'); } catch {}
      const branch = meta.worktree?.branch || `task/${task_id}`;
      const integBranch = task?.integration_branch || 'dev';
      const repoPath = task?.local_path || process.cwd();

      // Best-effort empty commit. If git fails (no repo, no branch) the
      // worker_merge_release will report a conflict — surface it but keep
      // going so the lifecycle completes from saga's perspective.
      const { spawnSync } = await import('node:child_process');
      const commitMsg = `mock: task #${task_id} approved (mock-claude)`;
      const commitRes = spawnSync('git', ['-C', repoPath, 'commit', '--allow-empty',
                                          '-m', commitMsg], { encoding: 'utf8' });
      if (commitRes.status !== 0) {
        emitAssistantText(`mock: empty commit failed (non-fatal): ${commitRes.stderr?.slice(0, 200)}`);
      }

      // Attempt the merge into integration branch. If it fails we report
      // 'conflict' so the task gets flagged needs-human — same as a real
      // worker would do.
      const mergeRes = spawnSync('git',
        ['-C', repoPath, 'merge', '--no-ff', '-m',
         `merge: task #${task_id} (mock-approved)`, branch],
        { encoding: 'utf8' });
      let mergeOutcome, commitSha = null;
      if (mergeRes.status === 0) {
        mergeOutcome = 'merged';
        const shaRes = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'],
                                 { encoding: 'utf8' });
        commitSha = shaRes.stdout?.trim() || null;
      } else {
        // Abort to leave the index clean.
        spawnSync('git', ['-C', repoPath, 'merge', '--abort'], { encoding: 'utf8' });
        mergeOutcome = 'conflict';
      }

      dispatcher.handlers.worker_merge_release({
        task_id,
        worker_id,
        result: mergeOutcome,
        commit_sha: commitSha,
        ...execArg,
      });
      emitAssistantText(`mock: merge_release ${mergeOutcome} for task #${task_id}`);
    } catch (e) {
      emitAssistantText(`mock: merge lifecycle failed: ${e.message}`);
      // Not fatal — worker_done already fired, task is in 'done' state.
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const { mcpConfigPath, prompt } = parseArgv(process.argv);
  const ctx = parsePrompt(prompt);

  if (!ctx.task_id || !ctx.worker_id) {
    process.stderr.write(`mock-claude: could not parse task_id/worker_id from prompt\n`);
    process.exit(2);
  }

  const dbPath = resolveDbPath(mcpConfigPath);
  if (!dbPath) {
    process.stderr.write(`mock-claude: DB_PATH unresolved\n`);
    process.exit(2);
  }

  // Minimal stream-json output so the runner's log grows (mtime freshness
  // for /api/workers/active is_stale=false).
  emitStreamHeader('mock-claude');
  emitAssistantText(`mock-claude: claimed task #${ctx.task_id} (${ctx.task_kind || 'legacy'})`);
  heartbeat(ctx, 'CLAIMED', 'started');

  // Simulate 1 second of "work" (cargo/vitest/reading contracts).
  await new Promise(r => setTimeout(r, 1000));

  let ok = true;
  let errMsg = null;
  try {
    const handlers = await loadHandlers(dbPath);
    await driveWorkerLifecycle(handlers, ctx);
  } catch (e) {
    ok = false;
    errMsg = e instanceof Error ? e.message : String(e);
  }

  const durationMs = Date.now() - startedAt;
  emitResult(durationMs);

  // Always exit 0. The runner's close-handler reads task status from the DB,
  // not from this exit code. A non-zero exit triggers recoverAssignment →
  // infinite respawn loop, which is the worst outcome for tests. If the saga
  // handlers failed, the task stays in its current status and the engine's
  // own recovery machinery (reconcileWorkerExecutions, episode gate failure)
  // surfaces the problem — same as a real worker crashing after partial work.
  heartbeat(ctx, ok ? 'MOCK_DONE' : 'MOCK_PARTIAL',
    ok ? `exit=0 approved duration=${durationMs}ms`
       : `exit=0 partial (saga handler error: ${errMsg})`);
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`mock-claude fatal: ${e.stack || e}\n`);
  process.exit(1);
});
