import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export function parseClaudeArgv(argv) {
  const flagsWithValue = new Set([
    '--mcp-config', '--model', '--output-format', '--permission-mode',
    '--append-system-prompt', '--allowedTools', '--disallowedTools',
    '--max-turns', '--max-budget-usd', '--fallback-model',
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
      if (value.startsWith('--mcp-config=')) {
        mcpConfigPath = value.slice('--mcp-config='.length);
      }
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
    if (!match) continue;
    values[match[1]] = match[2];
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
    } catch {
      // Fall through to inherited environment.
    }
  }
  return env.DB_PATH || null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, path) => {
      const resolved = path.split('.').reduce((current, part) => current?.[part], vars);
      if (resolved === undefined || resolved === null) {
        throw new Error(`SIMULATOR_TEMPLATE_VALUE_MISSING: ${path}`);
      }
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, vars)]),
    );
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
  const line = [
    new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    `pid=${process.pid}`, `worker=${ctx.worker_id ?? 'unknown'}`,
    `project=${ctx.project_id ?? 'unknown'}`, `task=${ctx.task_id ?? 'unknown'}`,
    event, message,
  ].join(' ').replace(/\s+/g, ' ').trim();
  try {
    const target = join(homedir(), '.zcode', 'cli', 'worker-heartbeat.log');
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`);
  } catch {
    // Heartbeat is observability, not scenario authority.
  }
}

export async function loadSagaRuntime(dbPath) {
  process.env.DB_PATH = dbPath;
  const dbModule = await import('../../dist/db.js');
  if (typeof dbModule.closeDb === 'function') {
    try { dbModule.closeDb(); } catch { /* no cached connection */ }
  }
  const [dispatcher, lifecycle, artifacts, traces] = await Promise.all([
    import('../../dist/tools/dispatcher.js'),
    import('../../dist/tools/lifecycle.js'),
    import('../../dist/tools/artifacts.js'),
    import('../../dist/tools/traces.js').catch(() => null),
  ]);
  return { dbModule, dispatcher, lifecycle, artifacts, traces };
}

export function enrichContext(runtime, promptContext) {
  const db = runtime.dbModule.getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(promptContext.task_id);
  if (!task) throw new Error(`SIMULATOR_TASK_NOT_FOUND: ${promptContext.task_id}`);
  let metadata = {};
  try { metadata = JSON.parse(task.metadata || '{}'); } catch { metadata = {}; }
  const attemptRow = promptContext.execution_id
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM worker_executions
          WHERE task_id=? AND reserved_at <= (
            SELECT reserved_at FROM worker_executions WHERE execution_id=?
          )`,
      ).get(task.id, promptContext.execution_id)
    : { n: 1 };
  return {
    ...promptContext,
    task,
    metadata,
    epic_id: task.epic_id,
    task_kind: task.task_kind || promptContext.task_kind || 'legacy',
    execution_mode: task.execution_mode || promptContext.execution_mode || 'tracker_only',
    process_run_id: metadata.process_run_id ?? null,
    process_module_ref: metadata.process_module_ref ?? promptContext.process_module_ref ?? null,
    process_node_id: metadata.process_node_id ?? null,
    attempt: Math.max(1, Number(attemptRow?.n ?? 1)),
    role: task.status === 'review' || task.status === 'review_in_progress'
      ? 'reviewer'
      : (promptContext.role || 'author'),
  };
}

function findArtifact(db, epicId, type, code = null) {
  if (code) {
    return db.prepare(
      `SELECT * FROM artifacts WHERE epic_id=? AND type=? AND code=?
       ORDER BY id DESC LIMIT 1`,
    ).get(epicId, type, code);
  }
  return db.prepare(
    `SELECT * FROM artifacts WHERE epic_id=? AND type=? ORDER BY id DESC LIMIT 1`,
  ).get(epicId, type);
}

function handler(container, name) {
  const value = container?.handlers?.[name];
  if (typeof value !== 'function') throw new Error(`SIMULATOR_HANDLER_MISSING: ${name}`);
  return value;
}

function writeWorkspaceFile(ctx, relativePath, content) {
  const root = ctx.workspace_root && ctx.workspace_root !== 'undefined'
    ? ctx.workspace_root
    : process.cwd();
  const target = isAbsolute(relativePath) ? relativePath : resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

export async function executeSteps(runtime, ctx, scenario, stream) {
  const db = runtime.dbModule.getDb();
  const vars = { ctx, aliases: {}, env: process.env };
  for (const rawStep of scenario.steps) {
    const step = renderTemplate(rawStep, vars);
    switch (step.type) {
      case 'emit':
        stream.text(step.text);
        break;
      case 'sleep':
        await new Promise(resolveDelay => setTimeout(resolveDelay, step.ms));
        break;
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
        const result = handler(runtime.artifacts, 'artifact_create')(args);
        const artifactId = result?.id ?? result?.artifact?.id ?? result?.artifact_id;
        if (!Number.isInteger(artifactId)) {
          const row = findArtifact(db, args.epic_id, args.type, args.code ?? null);
          if (!row) throw new Error(`SIMULATOR_ARTIFACT_CREATE_UNRESOLVED: ${args.type}`);
          vars.aliases[step.as] = row.id;
        } else {
          vars.aliases[step.as] = artifactId;
        }
        stream.text(`simulator: created ${args.type} #${vars.aliases[step.as]}`);
        break;
      }
      case 'artifact_find': {
        const row = findArtifact(db, ctx.epic_id, step.artifactType, step.code ?? null);
        if (!row) throw new Error(`SIMULATOR_ARTIFACT_NOT_FOUND: ${step.artifactType}/${step.code ?? '*'}`);
        vars.aliases[step.as] = row.id;
        break;
      }
      case 'trace_add': {
        const traceHandler = runtime.traces?.handlers?.trace_add
          ?? runtime.artifacts?.handlers?.trace_add;
        if (typeof traceHandler !== 'function') throw new Error('SIMULATOR_HANDLER_MISSING: trace_add');
        traceHandler(step.args);
        stream.text(`simulator: trace ${step.args.source_id} -> ${step.args.target_id}`);
        break;
      }
      case 'verification_record':
        handler(runtime.lifecycle, 'verification_record')(step.args);
        stream.text('simulator: verification evidence recorded');
        break;
      case 'worker_done':
        handler(runtime.dispatcher, 'worker_done')(step.args);
        stream.text(`simulator: worker_done task #${step.args.task_id}`);
        break;
      case 'assert': {
        const row = db.prepare(step.sql).get(...(step.params || []));
        if (!row || (step.field && row[step.field] !== step.equals)) {
          throw new Error(`SIMULATOR_ASSERTION_FAILED: ${step.message || step.sql}`);
        }
        break;
      }
      case 'exit_error':
        throw new Error(step.message || 'SIMULATOR_INJECTED_FAILURE');
      default:
        throw new Error(`SIMULATOR_STEP_UNSUPPORTED: ${step.type}`);
    }
  }
  return vars;
}
