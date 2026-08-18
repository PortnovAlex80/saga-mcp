#!/usr/bin/env node
/**
 * Скрипт-рабочий: Discovery Proposal Author (produce-proposal node).
 *
 * Один рабочий = одна задача = один процесс. Делает свою работу и увольняется.
 *
 * Что делает (захардкожено, не fixture — это и есть «текст ЛЛМ заранее»):
 *   1. Парсит argv/stdin — извлекает task_id, worker_id, execution_id, --mcp-config
 *   2. Поднимает stdio-MCP-child (dist/index.js) — тот же что настоящий claude
 *   3. Вызывает product_submit(schema='factory.discovery-proposal.v1', content=<валидный proposal>)
 *   4. Вызывает worker_done(result='...')
 *   5. Exit 0 (увольняется)
 *
 * Продукт — Discovery proposal, рекомендованный исход берётся из захваченного
 * golden-рана (см. tests/fixtures/golden-corpus). Текст — материал, который
 * произвела реальная модель и приняли реальные гейты; имитатор его только
 * подаёт, ничего не сочиняя (loadCorpus fail-closed на отсутствующий материал).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadCorpus } from '../../corpus.mjs';

// --- Парсинг argv (тот же контракт что claude CLI) ---
function parseArgv(argv) {
  const args = argv.slice(2);
  let mcpConfigPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config' && i + 1 < args.length) {
      mcpConfigPath = args[i + 1];
      i++;
    }
  }
  return { mcpConfigPath };
}

// --- Парсинг stdin prompt ---
async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
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

// --- stream-json (liveness для фабрики) ---
function emit(type, extra = {}) {
  process.stdout.write(JSON.stringify({ type, ...extra }) + '\n');
}

// --- MCP-client ---
class McpClient {
  constructor(configPath) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const server = config.mcpServers[Object.keys(config.mcpServers)[0]];
    this.child = spawn(server.command, server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...server.env },
      windowsHide: true,
    });
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proposal-author', version: '1.0.0' } });
    this.notify('notifications/initialized', {});
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`MCP_ERROR ${name}: ${JSON.stringify(r.error)}`);
    return r.result?.content ?? [];
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

// --- Продукт: discovery proposal из golden-корпуса (захваченный accepted материал) ---
const PROPOSAL_CONTENT = loadCorpus().product(
  'produce-proposal', 'factory.discovery-proposal.v1',
);

// --- main ---
async function main() {
  const { mcpConfigPath } = parseArgv(process.argv);
  if (!mcpConfigPath) { process.stderr.write('--mcp-config required\n'); process.exit(2); }

  const prompt = parsePrompt(await readStdin());
  process.stderr.write(`[proposal-author] task_id=${prompt.task_id} execution_id=${prompt.execution_id}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // product_submit — единственный продукт этого рабочего
    emit('assistant', { message: { content: [{ type: 'text', text: '[mock] product_submit: discovery-proposal' }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.discovery-proposal.v1',
      content: PROPOSAL_CONTENT,
    });
    process.stderr.write(`[proposal-author] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    // worker_done — увольнение
    const wd = await client.call('worker_done', {
      task_id: Number(prompt.task_id),
      worker_id: prompt.worker_id,
      result: `produced discovery proposal with recommended_outcome=${PROPOSAL_CONTENT.recommended_outcome}`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[proposal-author] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[proposal-author] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
