import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function parseClaudeArgv(argv) {
  const flagsWithValue = new Set([
    '--mcp-config', '--model', '--output-format', '--permission-mode',
    '--append-system-prompt', '--allowedTools', '--disallowedTools',
    '--max-turns', '--max-budget-usd', '--fallback-model',
    '--settings', '--effort',
  ]);
  let mcpConfigPath = null;
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (flagsWithValue.has(value)) {
      const next = argv[i + 1];
      if (value === '--mcp-config') mcpConfigPath = next ?? null;
      i += 1;
      continue;
    }
    if (value.startsWith('--') && value.includes('=')) {
      if (value.startsWith('--mcp-config=')) mcpConfigPath = value.slice('--mcp-config='.length);
      continue;
    }
    if (value.startsWith('-')) continue;
    positionals.push(value);
  }
  return { mcpConfigPath, prompt: positionals.at(-1) ?? '' };
}

export function parseSagaPrompt(prompt) {
  const values = {};
  for (const line of String(prompt).split('\n')) {
    if (line === 'Hard rules:') break;
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  for (const key of ['project_id', 'task_id']) {
    if (values[key] !== undefined) values[key] = Number(values[key]);
  }
  if (values.execution_id === 'legacy') values.execution_id = null;
  return values;
}

export function resolveDbPath(mcpConfigPath, env = process.env) {
  if (mcpConfigPath && existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      const configured = config?.mcpServers?.saga?.env?.DB_PATH;
      if (typeof configured === 'string' && configured.length > 0) return configured;
    } catch { /* inherited env remains the fallback */ }
  }
  return env.DB_PATH || null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveTemplatePath(path, vars) {
  const resolved = path.split('.').reduce((current, part) => current?.[part], vars);
  if (resolved === undefined || resolved === null) {
    throw new Error(`SIMULATOR_TEMPLATE_VALUE_MISSING: ${path}`);
  }
  return resolved;
}

export function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-zA-Z0-9_.-]+)\}\}$/.exec(value);
    if (exact) return resolveTemplatePath(exact[1], vars);
    return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, path) =>
      String(resolveTemplatePath(path, vars)));
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, renderTemplate(item, vars)]));
  }
  return value;
}

export function createStreamEmitter(output = process.stdout) {
  const sessionId = `sim-${process.pid}-${Date.now()}`;
  const emit = event => output.write(`${JSON.stringify(event)}\n`);
  return {
    sessionId,
    init(model = 'saga-deterministic-simulator') {
      emit({
        type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
        tools: ['mcp__saga__worker_done', 'mcp__saga__artifact_create',
          'mcp__saga__artifact_update', 'mcp__saga__trace_add',
          'mcp__saga__verification_record', 'mcp__saga__worker_merge_acquire',
          'mcp__saga__worker_merge_release'],
        mcp_servers: [{ name: 'saga', status: 'connected' }],
        model, permissionMode: 'bypassPermissions',
      });
    },
    text(text) {
      emit({
        type: 'assistant',
        message: {
          id: `msg_sim_${Date.now()}`, type: 'message', role: 'assistant',
          model: 'saga-deterministic-simulator',
          content: [{ type: 'text', text }], stop_reason: 'end_turn',
          stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null, session_id: sessionId,
        uuid: `uuid_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
      });
    },
    result({ durationMs, success, summary, error = null }) {
      emit({
        type: 'result', subtype: success ? 'success' : 'error', is_error: !success,
        api_error_status: null, duration_ms: durationMs, duration_api_ms: durationMs,
        ttft_ms: 1, num_turns: 1, result: summary,
        stop_reason: success ? 'end_turn' : 'error', session_id: sessionId,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
        model: 'saga-deterministic-simulator', permission_denials: [],
        terminal_reason: success ? 'completed' : 'failed', error,
        uuid: `uuid_sim_result_${Date.now()}`,
      });
    },
  };
}

export function heartbeat(ctx, event, message = '') {
  const line = [new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    `pid=${process.pid}`, `worker=${ctx.worker_id ?? 'unknown'}`,
    `project=${ctx.project_id ?? 'unknown'}`, `task=${ctx.task_id ?? 'unknown'}`,
    event, message].join(' ').replace(/\s+/g, ' ').trim();
  try {
    const target = join(homedir(), '.zcode', 'cli', 'worker-heartbeat.log');
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`);
  } catch { /* observability is non-authoritative */ }
}

export async function loadSagaRuntime(dbPath) {
  process.env.DB_PATH = dbPath;
  // The runner sets SAGA_MANAGED_EXECUTION=1 + SAGA_EXECUTION_ID in the MCP
  // server's env (mcpServers.saga.env). When the real Claude CLI spawns the
  // saga MCP server, those env vars are present. The simulator calls handlers
  // in-process (no MCP subprocess), so it must set them itself — otherwise
  // resolveManagedExecutionProvenance returns null and artifact_create
  // falls back to executionRef='system' → STALE_EXECUTION_CANNOT_SUBMIT.
  // enrichContext (called later) sets the per-task SAGA_EXECUTION_ID.
  process.env.SAGA_MANAGED_EXECUTION = '1';
  const dbModule = await import('../../dist/db.js');
  if (typeof dbModule.closeDb === 'function') {
    try { dbModule.closeDb(); } catch { /* no cached connection */ }
  }
  const [dispatcher, lifecycle, artifacts, proposalMod, readinessMod] = await Promise.all([
    import('../../dist/tools/dispatcher.js'),
    import('../../dist/tools/lifecycle.js'),
    import('../../dist/tools/artifacts.js'),
    import('../../dist/tools/discovery-proposal-tools.js'),
    import('../../dist/tools/discovery-readiness-tools.js'),
  ]);
  // Create handler instances (factory pattern — modules export create*Handlers())
  const proposals = proposalMod.createDiscoveryProposalHandlers();
  const readiness = readinessMod.createDiscoveryReadinessHandlers();
  return { dbModule, dispatcher, lifecycle, artifacts, proposals, readiness };
}

export function enrichContext(runtime, promptContext) {
  const db = runtime.dbModule.getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(promptContext.task_id);
  if (!task) throw new Error(`SIMULATOR_TASK_NOT_FOUND: ${promptContext.task_id}`);
  let metadata = {};
  try { metadata = JSON.parse(task.metadata || '{}'); } catch { metadata = {}; }
  const attemptRow = promptContext.execution_id
    ? db.prepare(`SELECT COUNT(*) AS n FROM worker_executions
        WHERE task_id=? AND reserved_at <= (
          SELECT reserved_at FROM worker_executions WHERE execution_id=?)`)
      .get(task.id, promptContext.execution_id)
    : { n: 1 };
  return {
    ...promptContext, task, metadata, epic_id: task.epic_id,
    task_kind: task.task_kind || promptContext.task_kind || 'legacy',
    execution_mode: task.execution_mode || promptContext.execution_mode || 'tracker_only',
    process_run_id: metadata.process_run_id ?? null,
    process_module_ref: metadata.process_module_ref ?? promptContext.process_module_ref ?? null,
    process_node_id: metadata.process_node_id ?? null,
    attempt: Math.max(1, Number(attemptRow?.n ?? 1)),
    role: task.status === 'review' || task.status === 'review_in_progress'
      ? 'reviewer' : (promptContext.role || 'author'),
    isRetry: !!(metadata.recovery_feedback || metadata.process_node_input?.schema === 'factory.recovery-feedback.v1'),
  };
}

/**
 * Set the per-task execution env vars that handlers (artifact_create,
 * trace_add, worker_done, proposal_submit, etc.) read via
 * resolveManagedExecutionProvenance. The runner would set these in the
 * MCP server subprocess env; the simulator calls handlers in-process so
 * it must set them itself.
 */
export function setExecutionEnv(ctx) {
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = ctx.execution_id || ctx.task?.current_execution_id || '';
  process.env.SAGA_TASK_ID = String(ctx.task_id ?? ctx.task?.id ?? '');
  process.env.SAGA_WORKER_ID = ctx.worker_id || '';
}

function findArtifact(db, epicId, type, code = null) {
  return code
    ? db.prepare(`SELECT * FROM artifacts WHERE epic_id=? AND type=? AND code=?
        ORDER BY id DESC LIMIT 1`).get(epicId, type, code)
    : db.prepare(`SELECT * FROM artifacts WHERE epic_id=? AND type=?
        ORDER BY id DESC LIMIT 1`).get(epicId, type);
}

function requireHandler(container, name) {
  const value = container?.handlers?.[name];
  if (typeof value !== 'function') throw new Error(`SIMULATOR_HANDLER_MISSING: ${name}`);
  return value;
}

function writeWorkspaceFile(ctx, relativePath, content) {
  const root = ctx.workspace_root && ctx.workspace_root !== 'undefined'
    ? ctx.workspace_root : process.cwd();
  const target = isAbsolute(relativePath) ? relativePath : resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function integrateGitTask(runtime, ctx, stream) {
  const acquire = requireHandler(runtime.dispatcher, 'worker_merge_acquire');
  const release = requireHandler(runtime.dispatcher, 'worker_merge_release');
  const execution = ctx.execution_id ? { execution_id: ctx.execution_id } : {};
  acquire({ task_id: ctx.task_id, worker_id: ctx.worker_id, ...execution });

  const db = runtime.dbModule.getDb();
  const row = db.prepare(`SELECT t.metadata, pr.local_path, pr.integration_branch
      FROM tasks t LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
      WHERE t.id=?`).get(ctx.task_id);
  let metadata = {};
  try { metadata = JSON.parse(row?.metadata || '{}'); } catch { metadata = {}; }
  const repositoryPath = row?.local_path || ctx.workspace_root || process.cwd();
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
  const commitSha = revision.status === 0 ? revision.stdout.trim() : null;
  release({ task_id: ctx.task_id, worker_id: ctx.worker_id, result: 'merged',
    commit_sha: commitSha, ...execution });
  stream.text(`simulator: merged ${branch} into ${row?.integration_branch || 'integration branch'}`);
}

export async function executeSteps(runtime, ctx, scenario, stream) {
  const db = runtime.dbModule.getDb();
  const vars = { ctx, aliases: {}, env: process.env };
  for (const rawStep of scenario.steps) {
    const step = renderTemplate(rawStep, vars);
    switch (step.type) {
      case 'emit': stream.text(step.text); break;
      case 'sleep': await new Promise(done => setTimeout(done, step.ms)); break;
      case 'write_file': {
        const target = writeWorkspaceFile(ctx, step.path, step.content);
        vars.aliases[step.as || 'last_file'] = target;
        stream.text(`simulator: wrote ${target}`);
        break;
      }
      case 'artifact_create': {
        const args = { ...step.args };
        if (step.content !== undefined) {
          const target = writeWorkspaceFile(ctx, args.path, step.content);
          args.content_hash = sha256(step.content);
          vars.aliases[`${step.as || args.type}_path`] = target;
        }
        const result = requireHandler(runtime.artifacts, 'artifact_create')(args);
        const returnedId = result?.id ?? result?.artifact?.id ?? result?.artifact_id;
        const row = Number.isInteger(returnedId)
          ? { id: returnedId }
          : findArtifact(db, args.epic_id, args.type, args.code ?? null);
        if (!row) throw new Error(`SIMULATOR_ARTIFACT_CREATE_UNRESOLVED: ${args.type}`);
        vars.aliases[step.as] = row.id;
        stream.text(`simulator: created ${args.type} #${row.id}`);
        break;
      }
      case 'artifact_find': {
        const row = findArtifact(db, ctx.epic_id, step.artifactType, step.code ?? null);
        if (!row) throw new Error(`SIMULATOR_ARTIFACT_NOT_FOUND: ${step.artifactType}/${step.code ?? '*'}`);
        vars.aliases[step.as] = row.id;
        break;
      }
      case 'artifact_find_optional': {
        // Find artifact but don't throw if missing. Sets alias to the row id
        // or null. Used for idempotent retries: if the artifact already exists
        // (from a previous author run), skip re-creating it.
        const row = findArtifact(db, ctx.epic_id, step.artifactType, step.code ?? null);
        vars.aliases[step.as] = row?.id ?? null;
        if (row) stream.text(`simulator: found existing ${step.artifactType} #${row.id}`);
        break;
      }
      case 'skip_if': {
        // Conditional skip: if the alias referenced by 'check' is non-null
        // (artifact already exists), skip the next N steps.
        const value = vars.aliases[step.check];
        if (value !== null && value !== undefined) {
          // Skip the next step.skipCount steps by advancing the loop index.
          // We can't modify the for-of index directly, so use a sentinel.
          vars.aliases.__skip_count = step.skipCount || 1;
          stream.text(`simulator: skip ${step.skipCount || 1} step(s) — ${step.check} exists`);
        }
        break;
      }
      case 'trace_add':
        requireHandler(runtime.artifacts, 'trace_add')(step.args);
        stream.text(`simulator: trace ${step.args.source_id} -> ${step.args.target_id}`);
        break;
      case 'verification_record':
        requireHandler(runtime.lifecycle, 'verification_record')(step.args);
        stream.text('simulator: verification evidence recorded');
        break;
      case 'proposal_submit': {
        const result = requireHandler(runtime.proposals, 'proposal_submit')(step.args);
        const proposalId = result?.proposal_id;
        if (typeof proposalId === 'number' && proposalId > 0) {
          vars.aliases[step.as || 'proposal'] = proposalId;
          vars.aliases.proposal_content_hash = result?.content_hash ?? null;
          stream.text(`simulator: proposal #${proposalId} submitted (${result?.status})`);
        } else {
          stream.text(`simulator: proposal ${result?.status} (no canonical row)`);
        }
        break;
      }
      case 'readiness_get': {
        const result = requireHandler(runtime.readiness, 'readiness_get')(step.args);
        const proposalId = result?.proposal_id;
        const proposalHash = result?.proposal_content_hash;
        const allowed = result?.allowed_source_refs ?? [];
        if (typeof proposalId === 'number') vars.aliases.readiness_proposal_id = proposalId;
        if (typeof proposalHash === 'string') vars.aliases.readiness_proposal_hash = proposalHash;
        vars.aliases.allowed_source_refs = allowed;
        stream.text(`simulator: readiness_get proposal=${proposalId} allowed=${allowed.length} refs`);
        break;
      }
      case 'readiness_submit': {
        const result = requireHandler(runtime.readiness, 'readiness_submit')(step.args);
        stream.text(`simulator: readiness ${result?.status} (#${result?.assessment_id})`);
        break;
      }
      case 'worker_done':
        requireHandler(runtime.dispatcher, 'worker_done')(step.args);
        stream.text(`simulator: worker_done task #${step.args.task_id}`);
        break;
      case 'git_integrate':
        integrateGitTask(runtime, ctx, stream);
        break;
      case 'assert': {
        const row = db.prepare(step.sql).get(...(step.params || []));
        if (!row || (step.field && row[step.field] !== step.equals)) {
          throw new Error(`SIMULATOR_ASSERTION_FAILED: ${step.message || step.sql}`);
        }
        break;
      }
      case 'exit_error': throw new Error(step.message || 'SIMULATOR_INJECTED_FAILURE');
      default: throw new Error(`SIMULATOR_STEP_UNSUPPORTED: ${step.type}`);
    }
  }
  return vars;
}
