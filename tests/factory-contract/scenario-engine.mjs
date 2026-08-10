// tests/factory-contract/scenario-engine.mjs
//
// Scenario-driven deterministic worker test double for Saga Factory contract tests.
//
// A Scenario describes what a scripted worker should do for a given execution
// context (module, cell, role, workKey, attempt). The engine dispatches by
// scenario key and executes only normal worker-level actions through the real
// worker-facing MCP boundary.
//
// Scenario scripts may:
//   - read products, candidate sets, artifacts via MCP read APIs
//   - submit typed products via product_submit
//   - create/update artifacts via artifact_create/artifact_update
//   - create traces via trace_add
//   - submit reviewer verdicts via product_submit
//   - call worker_done
//   - exit 0 without worker_done (crash simulation)
//   - exit non-zero (failure simulation)
//
// Scenario scripts may NOT:
//   - select their own work (no worker_next)
//   - directly mutate DB tables
//   - call lifecycle/dispatcher internals
//
// Invocation counting: every physical scenario process reserves its invocation
// in a cross-process ledger before running the handler. Tests can therefore
// distinguish repair/retry attempts and assert zero scripted calls on replay.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const PROCESS_INSTANCE_ID = randomUUID();

// --- MCP client (same stdio protocol as real workers) ---

class McpClient {
  constructor(configPath) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const server = config.mcpServers[Object.keys(config.mcpServers)[0]];
    this.child = spawn(server.command, server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...server.env },
      windowsHide: true,
    });
    this.buf = ''; this.nextId = 1; this.pending = new Map();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', c => this.onData(c));
  }
  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {}
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP_TIMEOUT')); }
      }, 30000);
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async init(name = 'scenario-worker') {
    await this.send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name, version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`MCP_ERROR ${name}: ${JSON.stringify(r.error)}`);
    return r.result?.content ?? [];
  }
  /** Call an MCP tool and parse the text content as JSON. */
  async callJson(name, args) {
    const content = await this.call(name, args);
    const text = content[0]?.text ?? '{}';
    try {
      return JSON.parse(text);
    } catch {
      // The response is not JSON — likely an error message like "Error: ..."
      throw new Error(`MCP_RESPONSE_PARSE_ERROR (${name}): ${text.slice(0, 200)}`);
    }
  }
  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

// --- Scenario context ---

/**
 * Build the scenario key for a worker invocation.
 * The key is semantic and cross-run stable: it identifies WHAT work is being
 * done, not WHICH execution is doing it.
 */
export function scenarioKey(task) {
  const meta = typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
  return {
    module: meta.process_module_ref || 'unknown',
    node: meta.process_node_id || 'unknown',
    cell: meta.production_cell_id || 'unknown',
    role: meta.role || 'author',
    workKey: meta.work_key || meta.cell_input_item?.key || 'singleton',
    taskKind: task.task_kind || '',
  };
}

/**
 * Format the scenario key as a string for matching.
 */
export function scenarioKeyString(key) {
  return `${key.module}/${key.node}/${key.role}/${key.workKey}`;
}

// --- Scenario engine ---

/**
 * Create a scenario worker process.
 *
 * @param {object} opts
 * @param {string} opts.mcpConfigPath - MCP config file path
 * @param {object} opts.prompt - parsed prompt key-values
 * @param {object} opts.scenarios - map of scenarioKeyString → handler function
 * @param {object} opts.invocationLog - process-local invocation records
 * @param {(record: object) => Promise<object>} [opts.reserveInvocation]
 *   Cross-process atomic invocation reservation. The returned record must
 *   contain a positive integer `attempt`.
 */
export async function runScenarioWorker(opts) {
  const {
    mcpConfigPath,
    prompt,
    scenarios,
    invocationLog,
    reserveInvocation,
    repoPath,
    desk,
  } = opts;
  const taskId = Number(prompt.task_id);
  const executionId = prompt.execution_id;
  const workerId = prompt.worker_id;

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init('scenario-worker');

    // Read the task to get the execution context
    const task = await client.callJson('task_get', { id: taskId });
    const key = scenarioKey(task);
    const keyStr = scenarioKeyString(key);
    const invocationBase = {
      keyStr,
      key,
      taskId,
      executionId,
      workerId,
      processId: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      at: new Date().toISOString(),
    };

    // A new scripted worker is a new OS process. The dispatcher therefore
    // reserves the attempt in a shared ledger before the handler runs. The
    // in-memory fallback is retained for direct unit use of runScenarioWorker.
    const invocation = typeof reserveInvocation === 'function'
      ? await reserveInvocation(invocationBase)
      : {
          ...invocationBase,
          attempt: invocationLog.filter(i => i.keyStr === keyStr).length + 1,
        };
    if (!Number.isSafeInteger(invocation.attempt) || invocation.attempt < 1) {
      throw new Error(`SCENARIO_ATTEMPT_INVALID: ${JSON.stringify(invocation)}`);
    }
    invocationLog.push(invocation);
    const attempt = invocation.attempt;

    // Find the handler — support exact match, wildcard role, and global fallback
    const handler = scenarios[keyStr]
      || scenarios[`${key.module}/${key.node}/${key.role}/*`]
      || scenarios['*'];

    if (!handler) {
      throw new Error(`SCENARIO_NOT_FOUND: no handler for ${keyStr}`);
    }

    // Execute the handler with the worker context
    await handler({
      client,
      task,
      key,
      prompt,
      attempt,
      repoPath,
      desk,
      taskId,
      executionId,
      workerId,
    });

    // If the handler didn't call worker_done or throw, we still exit normally.
    // The dispatch-loop will see exit(0) and handle it via production lifecycle.
  } finally {
    client.close();
  }
}

// --- Standard scenario action helpers (composable) ---

export const actions = {
  /** Submit a typed product via product_submit. */
  async submitProduct(client, schema, content) {
    return client.callJson('product_submit', { schema, content });
  },

  /** Create an artifact with deterministic content_hash. */
  async createArtifact(client, { projectId, epicId, type, code, title, artifactPath, status = 'draft', contentHash, projectRepositoryId, repoPath, fileContent }) {
    const hash = contentHash || createHash('sha256').update(`${type}:${code}:${title}`).digest('hex');
    // file_backed artifacts require real bytes on disk for replay capture.
    if (repoPath && artifactPath) {
      const body = fileContent || `# ${title}\n\nDeterministic ${type} artifact for ${code}.\n`;
      const fullPath = path.join(repoPath, artifactPath.split('#')[0]);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, body, 'utf8');
    }
    return client.callJson('artifact_create', {
      project_id: projectId, epic_id: epicId, type, code, title,
      path: artifactPath, status, content_hash: hash,
      ...(projectRepositoryId ? { project_repository_id: projectRepositoryId } : {}),
    });
  },

  /** Add a trace edge. */
  async addTrace(client, sourceId, targetId, linkType) {
    return client.callJson('trace_add', {
      source_id: sourceId, target_type: 'artifact', target_id: targetId, link_type: linkType,
    });
  },

  /** Find accepted artifacts by type in an epic. */
  async findAcceptedArtifacts(client, epicId, type) {
    const result = await client.callJson('artifact_list', { epic_id: epicId, type, status: 'accepted' });
    return result.artifacts || result || [];
  },

  /** Read author candidate set for a workplace. */
  async readAuthorCandidate(client, workplaceRef) {
    return client.callJson('candidate_read', { workplace_ref: workplaceRef, role: 'author' });
  },

  /** Complete the worker normally. */
  async done(client, taskId, workerId, executionId, result) {
    return client.callJson('worker_done', {
      task_id: taskId, worker_id: workerId, result, execution_id: executionId,
    });
  },

  /**
   * Exit(0) without calling worker_done — simulates a worker crash where
   * the process exited cleanly but never completed the protocol.
   * The Factory's repair/recovery path will detect the missing receipt and
   * requeue the Workplace.
   */
  exitWithoutDone() {
    // Simply return without calling worker_done. The scenario dispatcher
    // exits normally (process.exit(0)), but the scripted executor sees no
    // worker_done receipt and treats it as a crash.
  },

  /**
   * Exit non-zero — simulates a worker failure.
   * The scenario dispatcher exits with code 1.
   */
  exitWithFailure() {
    // Throw to cause the dispatcher to exit(1).
    throw new Error('SCENARIO_INTENTIONAL_FAILURE');
  },

  /** Write a file to disk (for SRS/git scenarios). */
  writeFile(repoPath, filePath, content) {
    const fullPath = path.join(repoPath, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  },

  /** Compute SHA-256 of string content. */
  contentHash(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  },
};
