#!/usr/bin/env node
/**
 * Development Verification Worker (verification.ac).
 *
 * Reads the frozen integrated candidate hash and the AC baseline, then submits
 * DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA with outcome='passed'.
 *
 * The verification cell is read_only_evidence — no git changes needed.
 * The product must reference the exact frozen candidateHash + acceptedCriterionHash.
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

function findObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findObject(child, predicate, seen);
    if (found) return found;
  }
  return null;
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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev-verify', version: '1.0.0' } });
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
  process.stderr.write(`[dev-verify] task_id=${taskId}\n`);

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
    if (prompt.task_kind === 'development.readiness') {
      const sourceRef = findObject(
        meta.process_node_input ?? meta,
        value => value.schema === 'factory.integrated-source-candidate.v1'
          && typeof value.ref === 'string' && typeof value.hash === 'string',
      );
      if (!sourceRef) throw new Error('integrated source ProductRef not found');
      await client.call('product_submit', {
        schema: 'factory.development-readiness-manifest.v1',
        content: {
          schemaVersion: 'factory.development-readiness-manifest.v1',
          sourceCandidate: sourceRef,
          targets: [{
            key: 'primary',
            readiness: {
              kind: 'static',
              commands: { installCommand: null, testCommand: 'node -e "process.exit(0)"' },
            },
          }],
        },
      });
      await client.call('worker_done', {
        task_id: taskId,
        worker_id: prompt.worker_id,
        result: 'certified product readiness',
        execution_id: prompt.execution_id,
      });
      return;
    }
    const processRunId = meta.process_run_id;
    const workItemKey = meta.work_key || meta.cell_input_item?.key || `verify-${taskId}`;
    const acId = taskData.verification_target_artifact_id
      || meta.cell_input_item?.acceptanceCriterionIds?.[0]
      || 0;

    process.stderr.write(`[dev-verify] processRunId=${processRunId} workItemKey=${workItemKey} acId=${acId}\n`);

    // Read the process run to get the frozen candidate hash
    const runResult = await client.call('process_run_get', { process_run_id: processRunId });
    const runData = JSON.parse(runResult[0]?.text ?? '{}');
    const runSnapshot = runData.input_snapshot ? JSON.parse(runData.input_snapshot) : runData;

    // The candidateHash comes from the freeze-integrated-candidate kernel output.
    // Read it from the lifecycle run's stage outputs or node runs.
    let candidateHash = '';
    const lifecycleResult = await client.call('lifecycle_run_get', { lifecycle_run_id: processRunId });
    const lifecycleData = JSON.parse(lifecycleResult[0]?.text ?? '{}');
    const stages = lifecycleData.stages || lifecycleData.stageRuns || [];
    for (const stage of stages) {
      const nodes = stage.nodeRuns || stage.nodes || [];
      for (const node of nodes) {
        if (node.nodeId === 'freeze-integrated-candidate' && node.output) {
          const out = typeof node.output === 'string' ? JSON.parse(node.output) : node.output;
          candidateHash = out.candidateHash || out.content?.candidateHash || '';
        }
      }
    }

    // Fallback: try to read from node_run products
    if (!candidateHash) {
      try {
        const productsResult = await client.call('process_node_products', {
          process_run_id: processRunId,
          node_id: 'freeze-integrated-candidate',
        });
        const productsData = JSON.parse(productsResult[0]?.text ?? '{"products":[]}');
        const products = productsData.products || [];
        for (const p of products) {
          const content = typeof p.content === 'string' ? JSON.parse(p.content) : (p.content || p);
          if (content.candidateHash) { candidateHash = content.candidateHash; break; }
        }
      } catch {}
    }

    if (!candidateHash) {
      process.stderr.write(`[dev-verify] WARNING: no candidateHash found, using placeholder\n`);
      candidateHash = 'placeholder-candidate-hash';
    }

    // Read the accepted AC hash from the artifacts table
    let acceptedCriterionHash = '';
    if (acId) {
      const acResult = await client.call('artifact_get', { id: acId });
      const acData = JSON.parse(acResult[0]?.text ?? '{}');
      acceptedCriterionHash = acData.accepted_hash || acData.content_hash || '';
    }

    process.stderr.write(`[dev-verify] candidateHash=${candidateHash.slice(0,16)} acHash=${acceptedCriterionHash.slice(0,16)}\n`);

    // Submit the verification evidence product with outcome='passed'
    const evidence = {
      schemaVersion: 'factory.candidate-verification-evidence-product.v2',
      verificationItemKey: workItemKey,
      acceptanceCriterionId: acId,
      acceptedCriterionHash,
      candidateHash,
      outcome: 'passed',
      evidence: {
        summary: `Automated verification passed for ${workItemKey}`,
        observations: [`accepted AC ${acId} matches frozen candidate ${candidateHash}`],
        limitations: [],
      },
    };

    emit('assistant', { message: { content: [{ type: 'text', text: `[mock] product_submit: verification evidence passed for ${workItemKey}` }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.candidate-verification-evidence-product.v2',
      content: evidence,
    });
    process.stderr.write(`[dev-verify] product_submit → ${ps[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    // Also record verification evidence via verification_record (for the AC)
    try {
      await client.call('verification_record', {
        task_id: taskId,
        artifact_id: acId,
        outcome: 'passed',
        evidence: `Automated verification passed for ${workItemKey}`,
      });
      process.stderr.write(`[dev-verify] verification_record recorded\n`);
    } catch (e) {
      process.stderr.write(`[dev-verify] verification_record failed (non-fatal): ${e.message}\n`);
    }

    const wd = await client.call('worker_done', {
      task_id: taskId,
      worker_id: prompt.worker_id,
      result: `verification passed for ${workItemKey}`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[dev-verify] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[dev-verify] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
