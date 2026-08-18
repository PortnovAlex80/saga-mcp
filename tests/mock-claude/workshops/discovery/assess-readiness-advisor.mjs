#!/usr/bin/env node
/**
 * Скрипт-рабочий: Discovery Readiness Advisor (assess-readiness node).
 *
 * Один рабочий = одна задача = один процесс. Делает работу и увольняется.
 *
 * Что делает:
 *   1. Парсит argv/stdin
 *   2. Поднимает MCP-child
 *   3. product_submit(schema='factory.discovery-readiness-assessment.v2',
 *      content=<валидный assessment — все 7 dimensions, overall_readiness=ready,
 *      confidence=0.85, recommended_next_action=proceed_to_settlement>)
 *   4. worker_done
 *   5. exit 0
 *
 * Assessment — семантика из golden-корпуса (материал, который реальный
 * advisory-воркер произвёл и реальный гейт принял в захваченном ране),
 * адаптированная под ДЕЙСТВУЮЩИЙ контракт v2:
 *   - v2 запрещает поле proposal_id (физический id строки — провенанс ядра,
 *     не семантика; см. discovery-readiness-assessment.ts) — удаляем;
 *   - proposal_content_hash перепривязывается к proposal ТЕКУЩЕГО рана.
 * Имитатор не сочиняет оценку — он подаёт захваченную.
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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'readiness-advisor', version: '1.0.0' } });
    this.notify('notifications/initialized', {});
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`MCP_ERROR ${name}: ${JSON.stringify(r.error)}`);
    return r.result?.content ?? [];
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

// --- Продукт: readiness assessment из golden-корпуса, перепривязанный к текущему рану ---
// Корпус хранит payload схемы v1 (захваченный ран); действующий контракт — v2.
// Разница ровно одна: v2 убрал proposal_id (контент-адресация вместо
// физического id). Семантику несёт корпус, конвертацию конверта — имитатор.
const CORPUS_ASSESSMENT = loadCorpus().product(
  'assess-readiness', 'factory.discovery-readiness-assessment.v1',
);

function buildAssessment(proposalHash) {
  const { proposal_id: _droppedProvenanceId, ...semantic } = CORPUS_ASSESSMENT;
  return { ...semantic, proposal_content_hash: proposalHash };
}

async function main() {
  const { mcpConfigPath } = parseArgv(process.argv);
  if (!mcpConfigPath) { process.stderr.write('--mcp-config required\n'); process.exit(2); }

  const prompt = parsePrompt(await readStdin());
  process.stderr.write(`[readiness-advisor] task_id=${prompt.task_id} execution_id=${prompt.execution_id}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // КОНВЕЙЕР §2 + discovery.exact-lineage: advisor находит proposal через MCP.
    // process_node_input для assess-readiness — это production-cell-output-manifest.v1:
    //   { schema, artifactRef, contentHash, semanticDigest,
    //     bindings: { cellId, final, items: [{ products: [{schemaId,ref,digest}], ... }] } }
    // Proposal ProductRef лежит в bindings.items[].products[] со schemaId=discovery-proposal.
    // Fallback: candidate_read по proposal workplace_ref.
    const taskResult = await client.call('task_get', { id: Number(prompt.task_id) });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    // tasks.metadata is a JSON-string column; handleTaskGet returns it raw.
    const metadata = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    process.stderr.write(`[readiness-advisor] metadata keys: ${Object.keys(metadata).join(', ')}\n`);
    const processNodeInput = metadata.process_node_input;

    let proposalSchema, proposalRef, proposalDigest;

    // Path A: извлекаем из production-cell-output-manifest
    if (processNodeInput?.bindings?.items) {
      for (const item of processNodeInput.bindings.items) {
        const proposalProduct = (item.products || []).find(p => p.schemaId === 'factory.discovery-proposal.v1');
        if (proposalProduct) {
          proposalSchema = proposalProduct.schemaId;
          proposalRef = proposalProduct.ref;
          proposalDigest = proposalProduct.digest;
          break;
        }
      }
      if (proposalSchema) {
        process.stderr.write(`[readiness-advisor] proposal from manifest bindings.items[].products\n`);
      }
    }

    // Path B: candidate_read по proposal workplace_ref
    if (!proposalSchema) {
      const processRunId = metadata.process_run_id;
      const moduleRef = metadata.process_module_ref;
      if (!processRunId || !moduleRef) throw new Error('No process_run_id/module_ref in metadata');
      const proposalWpRef = `workplace/${processRunId}/${moduleRef}/discovery-proposal/default`;
      process.stderr.write(`[readiness-advisor] trying candidate_read for ${proposalWpRef}\n`);
      const candResult = await client.call('candidate_read', { workplace_ref: proposalWpRef, role: 'author' });
      const candData = JSON.parse(candResult[0]?.text ?? '{}');
      const proposalProduct = (candData.product_refs || []).find(p => p.schemaId === 'factory.discovery-proposal.v1');
      if (!proposalProduct) throw new Error('No proposal product in candidate_read for ' + proposalWpRef);
      proposalSchema = proposalProduct.schemaId;
      proposalRef = proposalProduct.ref;
      proposalDigest = proposalProduct.digest;
      process.stderr.write(`[readiness-advisor] proposal from candidate_read\n`);
    }

    if (!proposalSchema || !proposalRef || !proposalDigest) {
      throw new Error(`PROPOSAL_PRODUCTREF_INCOMPLETE: schema=${proposalSchema}, ref=${proposalRef}`);
    }

    process.stderr.write(`[readiness-advisor] proposal ProductRef: schema=${proposalSchema} ref=${proposalRef} digest=${proposalDigest.slice(0, 12)}\n`);

    // Шаг 3: product_read — точное чтение proposal по ProductRef triple.
    const readResult = await client.call('product_read', {
      schema_id: proposalSchema,
      ref: proposalRef,
      digest: proposalDigest,
    });
    const proposalData = JSON.parse(readResult[0]?.text ?? '{}');
    const proposalId = proposalData.submission_id ?? 0;
    const proposalHash = proposalDigest;

    process.stderr.write(`[readiness-advisor] proposal_id=${proposalId} hash=${proposalHash.slice(0, 12)}\n`);

    // Строим assessment с exact proposal_id и proposal_content_hash.
    const assessment = buildAssessment(proposalHash);

    emit('assistant', { message: { content: [{ type: 'text', text: '[mock] product_submit: readiness-assessment' }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.discovery-readiness-assessment.v2',
      content: assessment,
    });
    process.stderr.write(`[readiness-advisor] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    const wd = await client.call('worker_done', {
      task_id: Number(prompt.task_id),
      worker_id: prompt.worker_id,
      result: `produced readiness assessment: overall=${CORPUS_ASSESSMENT.overall_readiness}, confidence=${CORPUS_ASSESSMENT.confidence}, action=${CORPUS_ASSESSMENT.recommended_next_action}`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[readiness-advisor] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[readiness-advisor] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
