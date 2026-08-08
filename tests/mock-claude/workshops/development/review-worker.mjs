#!/usr/bin/env node
/**
 * Development Review Worker (development.review).
 *
 * Reads the author's implementation result product, approves it with
 * the exact sourceCommit + sourceTree from the implementation.
 *
 * The git-integration effect validates:
 *   reviewPayload.verdict === 'approved'
 *   reviewPayload.workItemKey === payload.workItemKey
 *   reviewPayload.reviewedCandidate.sourceCommit === sourceCommit
 *   reviewPayload.reviewedCandidate.sourceTree === sourceTree
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev-review', version: '1.0.0' } });
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
  process.stderr.write(`[dev-review] task_id=${taskId}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // Read task metadata
    const taskResult = await client.call('task_get', { id: taskId });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    const meta = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    const workplaceRef = meta.workplace_ref || '';

    // Read author CandidateSet to find the implementation result
    const candResult = await client.call('candidate_read', {
      workplace_ref: workplaceRef,
      role: 'author',
    });
    const candData = JSON.parse(candResult[0]?.text ?? '{}');
    const subjectCandidateSetRef = candData.candidate_set_ref || '';

    // Find the implementation result product in the candidate
    const implProduct = (candData.product_refs || []).find(
      p => p.schemaId === 'factory.development-implementation-result.v1'
    );
    if (!implProduct) throw new Error('No implementation result in author candidate');

    // Read the implementation result to get sourceCommit + sourceTree
    const readResult = await client.call('product_read', {
      schema_id: implProduct.schemaId,
      ref: implProduct.ref,
      digest: implProduct.digest,
    });
    const implData = JSON.parse(readResult[0]?.text ?? '{}');
    const implPayload = implData.content || implData;
    const workItemKey = implPayload.workItemKey;
    const sourceCommit = implPayload.source?.commitSha;
    const sourceTree = implPayload.snapshot?.treeSha;

    process.stderr.write(`[dev-review] workItemKey=${workItemKey} commit=${sourceCommit?.slice(0,12)} tree=${sourceTree?.slice(0,12)}\n`);

    // Submit the review verdict — matches git-integration expectations
    const verdict = {
      workItemKey,
      verdict: 'approved',
      reviewedCandidate: {
        sourceCommit,
        sourceTree,
      },
    };

    emit('assistant', { message: { content: [{ type: 'text', text: `[mock] product_submit: review verdict approved for ${workItemKey}` }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.development-review-verdict.v1',
      content: verdict,
    });
    process.stderr.write(`[dev-review] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    const wd = await client.call('worker_done', {
      task_id: taskId,
      worker_id: prompt.worker_id,
      result: `review approved: ${workItemKey}`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[dev-review] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[dev-review] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
