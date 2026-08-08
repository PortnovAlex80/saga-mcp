#!/usr/bin/env node
/**
 * Development Task Graph Planner (plan-task-graph node).
 *
 * Reads the DevelopmentCase from process_run input_snapshot, builds a valid
 * task graph proposal that satisfies the ReferenceDevelopmentTaskGraphPolicy,
 * submits via product_submit.
 *
 * The proposal MUST:
 *   - Cover ALL accepted ACs with implementation items (implementationRequired=true)
 *   - Cover ALL accepted ACs with verification items (one per AC, read_only_evidence)
 *   - Each implementation item: git_change, bind one case repository, non-empty changeScopes
 *   - Integration targets: partition required implementation items by repository
 *   - No cycles, no self-dependencies, no scope overlap without dependency order
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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev-planner', version: '1.0.0' } });
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
  process.stderr.write(`[dev-planner] task_id=${prompt.task_id}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // Read task to get process_run_id
    const taskResult = await client.call('task_get', { id: Number(prompt.task_id) });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    const meta = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    const processRunId = meta.process_run_id;
    if (!processRunId) throw new Error('No process_run_id in metadata');
    process.stderr.write(`[dev-planner] processRunId=${processRunId}\n`);

    // Read the DevelopmentCase from process_run input_snapshot
    // Use lifecycle_run_get or process_run_get to read the input
    const runResult = await client.call('process_run_get', { process_run_id: processRunId });
    const runData = JSON.parse(runResult[0]?.text ?? '{}');
    const developmentCase = runData.input_snapshot
      ? JSON.parse(runData.input_snapshot)
      : runData.input?.input_snapshot
        ? JSON.parse(runData.input.input_snapshot)
        : null;
    if (!developmentCase) {
      throw new Error(`No input_snapshot in process_run ${processRunId}: ${JSON.stringify(runData).slice(0, 200)}`);
    }
    process.stderr.write(`[dev-planner] DevelopmentCase: epic=${developmentCase.epicId} acs=${developmentCase.acceptanceCriteria?.length} repos=${developmentCase.repositories?.length}\n`);

    // Build the task graph proposal from the DevelopmentCase
    const acs = developmentCase.acceptanceCriteria || [];
    const repos = developmentCase.repositories || [];
    const repoId = repos[0]?.projectRepositoryId ?? 1;
    const integrationBranch = repos[0]?.integrationBranch ?? 'dev';
    const baseCommit = repos[0]?.expectedBaseCommit ?? '';

    // One implementation item per AC with implementationRequired=true
    const implAcIds = acs.filter(ac => ac.implementationRequired).map(ac => ac.artifactId);
    const implementationItems = acs.filter(ac => ac.implementationRequired).map((ac, i) => ({
      key: `impl-${ac.artifactId}`,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: repoId,
      acceptanceCriterionIds: [ac.artifactId],
      dependsOnKeys: [],
      changeScopes: [`ac-${ac.artifactId}`],
      required: true,
      criticality: ac.criticality || 'blocker',
    }));

    // One verification item per AC (ALL accepted ACs, not just impl-required)
    const verificationItems = acs.map(ac => ({
      key: `verify-${ac.artifactId}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: repoId,
      acceptanceCriterionIds: [ac.artifactId],
      dependsOnKeys: [],
      changeScopes: [],
      required: true,
      criticality: ac.criticality || 'blocker',
    }));

    // Integration target: all required implementation items → one repository
    const integrationTargets = [{
      projectRepositoryId: repoId,
      sourceWorkItemKeys: implementationItems.map(item => item.key),
      targetBranch: integrationBranch,
      expectedBaseCommit: baseCommit,
    }];

    const proposal = {
      schemaVersion: 'factory.development-task-graph-proposal.v1',
      implementationItems,
      verificationItems,
      integrationTargets,
    };

    process.stderr.write(`[dev-planner] proposal: ${implementationItems.length} impl, ${verificationItems.length} verify, ${integrationTargets.length} targets\n`);

    // Submit via product_submit
    emit('assistant', { message: { content: [{ type: 'text', text: '[mock] product_submit: development-task-graph-proposal' }] } });
    const ps = await client.call('product_submit', {
      schema: 'factory.development-task-graph-proposal.v1',
      content: proposal,
    });
    process.stderr.write(`[dev-planner] product_submit → ${ps[0]?.text?.slice(0, 100) ?? '(empty)'}\n`);

    // worker_done
    const wd = await client.call('worker_done', {
      task_id: Number(prompt.task_id),
      worker_id: prompt.worker_id,
      result: `development task graph: ${implementationItems.length} impl + ${verificationItems.length} verify`,
      execution_id: prompt.execution_id,
    });
    process.stderr.write(`[dev-planner] worker_done → ${wd[0]?.text?.slice(0, 80) ?? '(empty)'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[dev-planner] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
