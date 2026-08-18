#!/usr/bin/env node
/**
 * Универсальный formalization reviewer — подаёт вердикт из golden-корпуса.
 *
 * Семантика вердикта (verdict + findings) — материал, который реальный
 * ревьюер произвёл и реальный гейт принял в захваченном ране, по node_id
 * текущей задачи. Единственное перепривязывание: subject_candidate_set_ref
 * указывает на CandidateSet ТЕКУЩЕГО рана (корпусной рефлексией быть не может
 * по определению — это run-специфичная привязка).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadCorpus } from '../../corpus.mjs';

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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reviewer', version: '1.0.0' } });
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
  process.stderr.write(`[reviewer] task_id=${prompt.task_id} execution_id=${prompt.execution_id}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // Читаем task чтобы получить workplace_ref и node_id
    const taskResult = await client.call('task_get', { id: Number(prompt.task_id) });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    const meta = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    const workplaceRef = meta.workplace_ref || '';
    const nodeId = meta.process_node_id || '';
    process.stderr.write(`[reviewer] workplace_ref=${workplaceRef} node=${nodeId}\n`);

    // Вердикт из корпуса по узлу (fail-closed: нет захвата — нет вердикта).
    const corpus = loadCorpus();
    const captured = corpus.product(nodeId, 'factory.review-verdict.v1');

    // subject_candidate_set_ref = author CandidateSet ref for this workplace.
    // Read it via candidate_read(workplace_ref, role='author') → candidateSetRef.
    let subjectCandidateSetRef = '';
    const candResult = await client.call('candidate_read', {
      workplace_ref: workplaceRef,
      role: 'author',
    });
    const candData = JSON.parse(candResult[0]?.text ?? '{}');
    subjectCandidateSetRef = candData.candidate_set_ref || '';
    if (!subjectCandidateSetRef) {
      throw new Error(`reviewer: no author candidate_set_ref for ${workplaceRef}`);
    }
    process.stderr.write(`[reviewer] subject_candidate_set_ref=${subjectCandidateSetRef}\n`);

    // product_submit — captured verdict, subject rebound to THIS run's set
    emit('assistant', { message: { content: [{ type: 'text', text: `[mock] review verdict: ${captured.verdict}` }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.review-verdict.v1',
      content: { ...captured, subject_candidate_set_ref: subjectCandidateSetRef },
    });
    process.stderr.write(`[reviewer] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    const wd = await client.call('worker_done', {
      task_id: Number(prompt.task_id),
      worker_id: prompt.worker_id,
      result: `review verdict: ${captured.verdict} — ${captured.findings?.length ?? 0} findings (corpus)`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[reviewer] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[reviewer] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
