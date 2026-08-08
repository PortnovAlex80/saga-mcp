#!/usr/bin/env node
/**
 * Development Implementation Worker (development.code).
 *
 * Creates a git branch with a code change, commits it, and submits
 * DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA via product_submit.
 *
 * The product payload must contain:
 *   workItemKey, terminalStatus='complete',
 *   source: { branch, commitSha, workItemKey },
 *   snapshot: { commitSha, treeSha },
 *   repository: { projectRepositoryId, integrationBranch }
 *
 * The git-integration postAcceptanceEffect will merge source.commitSha into
 * the integration branch after the reviewer approves.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function parseArgv(argv) {
  const args = argv.slice(2);
  let mcpConfigPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config' && i + 1 < args.length) { mcpConfigPath = args[i + 1]; i++; }
  }
  return { mcpConfigPath };
}

async function readStdin() {
  return new Promise(resolve => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { d += c; });
    process.stdin.on('end', () => resolve(d));
    setTimeout(() => resolve(d), 1000);
  });
}

function parsePrompt(text) {
  const kv = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2];
  }
  return kv;
}

function emit(type, extra = {}) {
  process.stdout.write(JSON.stringify({ type, ...extra }) + '\n');
}

function git(repoPath, args) {
  const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.trim()}`);
  return r.stdout.trim();
}

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP_TIMEOUT')); } }, 30000);
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async init() {
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev-impl', version: '1.0.0' } });
    this.notify('notifications/initialized', {});
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`MCP_ERROR ${name}: ${JSON.stringify(r.error)}`);
    return r.result?.content ?? [];
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

async function main() {
  const { mcpConfigPath } = parseArgv(process.argv);
  if (!mcpConfigPath) { process.stderr.write('--mcp-config required\n'); process.exit(2); }

  const prompt = parsePrompt(await readStdin());
  const taskId = Number(prompt.task_id);
  process.stderr.write(`[dev-impl] task_id=${taskId}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // Read task metadata for work item key and repo
    const taskResult = await client.call('task_get', { id: taskId });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    const meta = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    const workItemKey = meta.work_key || meta.cell_input_item?.key || `task-${taskId}`;
    const repoPath = process.env.SAGA_BUTTON_REPO_PATH || '.';

    process.stderr.write(`[dev-impl] workItemKey=${workItemKey} repoPath=${repoPath}\n`);

    // Create a feature branch and make a code change
    const branchName = `task-${taskId}`;
    git(repoPath, ['checkout', '-b', branchName]);

    // Write a minimal code file
    const implFile = path.join(repoPath, `src/impl-${taskId}.ts`);
    mkdirSync(path.dirname(implFile), { recursive: true });
    writeFileSync(implFile, `// Implementation for ${workItemKey}\nexport const impl${taskId} = true;\n`);

    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-m', `implement ${workItemKey}`]);

    const commitSha = git(repoPath, ['rev-parse', 'HEAD']);
    const treeSha = git(repoPath, ['rev-parse', `${commitSha}^{tree}`]);

    process.stderr.write(`[dev-impl] branch=${branchName} commit=${commitSha.slice(0, 12)} tree=${treeSha.slice(0, 12)}\n`);

    // Submit the implementation result product
    const product = {
      workItemKey,
      terminalStatus: 'complete',
      source: {
        branch: branchName,
        commitSha,
        workItemKey,
      },
      snapshot: {
        commitSha,
        treeSha,
      },
      repository: {
        projectRepositoryId: 1,
        integrationBranch: 'dev',
      },
    };

    emit('assistant', { message: { content: [{ type: 'text', text: `[mock] product_submit: implementation-result for ${workItemKey}` }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.development-implementation-result.v1',
      content: product,
    });
    process.stderr.write(`[dev-impl] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    // Checkout back to dev so the integration effect can merge
    git(repoPath, ['checkout', 'dev']);

    const wd = await client.call('worker_done', {
      task_id: taskId,
      worker_id: prompt.worker_id,
      result: `implemented ${workItemKey} on branch ${branchName}`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[dev-impl] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[dev-impl] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
