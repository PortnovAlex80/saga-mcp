#!/usr/bin/env node
/**
 * Универсальный formalization author — создаёт артефакты + трассы по node_id.
 *
 * formalization authors создают артефакты через artifact_create и связывают их
 * трассами через trace_add. Каждый node требует свой набор:
 *
 *   define-product-contract: brief, PRD(→brief), FR, NFR, RULE
 *   model-use-cases:         UC(→PRD derived_from, →FR covers)
 *   define-acceptance-contract: AC(→FR/NFR derived_from, →UC derived_from)
 *   reconcile-what:          product_submit (reconciliation report)
 *   define-architecture-contract: SRS(→PRD derived_from)
 *
 * Артефакты пишутся в factory_managed_artifact_productions автоматически через
 * provenance env (SAGA_EXECUTION_ID etc.). Gate validator читает их оттуда.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
    await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'formalization-author', version: '1.0.0' } });
    this.notify('notifications/initialized', {});
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`MCP_ERROR ${name}: ${JSON.stringify(r.error)}`);
    return r.result?.content ?? [];
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

// --- Artifact + trace creation helpers ---

async function createArtifact(client, { projectId, epicId, type, code, title, path }) {
  // Deterministic content_hash from artifact identity (no real file on disk).
  const contentHash = createHash('sha256')
    .update(`${type}:${code}:${title}`)
    .digest('hex');
  const result = await client.call('artifact_create', {
    project_id: projectId,
    epic_id: epicId,
    type,
    code,
    title,
    path,
    status: 'draft',
    content_hash: contentHash,
  });
  const data = JSON.parse(result[0]?.text ?? '{}');
  process.stderr.write(`[formalization-author] artifact_create ${type} ${code} → id=${data.id}\n`);
  return data;
}

async function addTrace(client, sourceId, targetId, linkType) {
  await client.call('trace_add', {
    source_id: sourceId,
    target_type: 'artifact',
    target_id: targetId,
    link_type: linkType,
  });
  process.stderr.write(`[formalization-author] trace ${sourceId} --${linkType}--> ${targetId}\n`);
}

// --- Per-node production logic ---

async function produceProductContract(client, { projectId, epicId }) {
  // brief (root ancestor) → PRD → FR, NFR, RULE
  // The formalization kernel specifically checks PRD → brief (not just any root).
  // brief artifact requires metadata.brief_payload validated by validateBrief.
  const briefPayload = {
    classification: 'product',
    complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go',
    reasoning: 'The deterministic test harness is feasible and bounded.',
    affected_projects: [projectId],
    topology_hint: 'sequence',
    scaffold_artifacts: [],
    shared_mutation_risk: false,
    completeness: 'high',
    degraded: false,
  };
  const briefHash = createHash('sha256').update(`brief:BRIEF-1`).digest('hex');
  const briefResult = await client.call('artifact_create', {
    project_id: projectId, epic_id: epicId,
    type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief',
    path: `docs/formalization/BRIEF-1.md`,
    status: 'accepted',
    content_hash: briefHash,
    metadata: { brief_payload: briefPayload },
  });
  const brief = JSON.parse(briefResult[0]?.text ?? '{}');
  process.stderr.write(`[formalization-author] artifact_create brief BRIEF-1 → id=${brief.id}\n`);

  const prd = await createArtifact(client, {
    projectId, epicId, type: 'PRD', code: 'PRD',
    title: 'Product Requirements Document',
    path: `docs/formalization/PRD.md`,
  });
  const fr = await createArtifact(client, {
    projectId, epicId, type: 'FR', code: 'FR-1',
    title: 'Functional Requirement 1',
    path: `docs/formalization/FR-1.md`,
  });
  const nfr = await createArtifact(client, {
    projectId, epicId, type: 'NFR', code: 'NFR-1',
    title: 'Non-Functional Requirement 1',
    path: `docs/formalization/NFR-1.md`,
  });
  const rule = await createArtifact(client, {
    projectId, epicId, type: 'RULE', code: 'RULE-1',
    title: 'Business Rule 1',
    path: `docs/formalization/RULE-1.md`,
  });
  // PRD --derived_from--> brief (root lineage)
  await addTrace(client, prd.id, brief.id, 'derived_from');
  return { brief, prd, fr, nfr, rule };
}

async function produceUseCases(client, { projectId, epicId, prdId, frIds }) {
  // UC --derived_from--> PRD, UC --covers--> FR
  const uc = await createArtifact(client, {
    projectId, epicId, type: 'UC', code: 'UC-1',
    title: 'Use Case 1: Run Pipeline',
    path: `docs/formalization/UC-1.md`,
  });
  await addTrace(client, uc.id, prdId, 'derived_from');
  for (const frId of frIds) {
    await addTrace(client, uc.id, frId, 'covers');
  }
  return { ucs: [uc] };
}

async function produceAcceptance(client, { projectId, epicId, frIds, nfrIds, ucIds }) {
  // AC --derived_from--> FR (or NFR), AC --derived_from--> UC (if FR-derived)
  const ac1 = await createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-1',
    title: 'AC-1: Pipeline Completes',
    path: `docs/formalization/AC-1.md`,
  });
  // FR-derived AC: must trace to FR AND UC
  if (frIds.length > 0) await addTrace(client, ac1.id, frIds[0], 'derived_from');
  if (ucIds.length > 0) await addTrace(client, ac1.id, ucIds[0], 'derived_from');

  const ac2 = await createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-2',
    title: 'AC-2: NFR Compliance',
    path: `docs/formalization/AC-2.md`,
  });
  // NFR-derived AC: only needs NFR trace
  if (nfrIds.length > 0) await addTrace(client, ac2.id, nfrIds[0], 'derived_from');

  return { acs: [ac1, ac2] };
}

async function produceReconciliation(client) {
  // reconcile-what uses typed-submission (product_submit), not artifacts
  const ps = await client.call('product_submit', {
    schema: 'factory.formalization-reconciliation-report.v1',
    content: {
      status: 'reconciled',
      rationale: 'All artifacts trace correctly. No gaps remaining.',
      remaining_gaps: [],
      repairs: [],
    },
  });
  process.stderr.write(`[formalization-author] reconciliation submitted\n`);
}

async function produceArchitecture(client, { projectId, epicId, prdId, repoPath }) {
  // The SRS validator checks: file exists on disk, file hash matches content_hash,
  // §12 Decision Log with 6-column table, §D2 stanzas with all required fields.
  const srsContent = `# SRS — Software Requirements Specification

## §1 Introduction

This SRS covers the deterministic test harness factory.

## §D Decomposition

### §D2 Acceptance Criteria Decomposition

\`\`\`yaml
- ac: AC-1
  title: Pipeline Completes
  module: tests/mock-claude/button.mjs
  files:
    - tests/mock-claude/button.mjs
  invariants:
    - "Factory reaches terminal status"
  test_layers:
    - e2e
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
- ac: AC-2
  title: NFR Compliance
  module: tests/mock-claude/scripted-executor.mjs
  files:
    - tests/mock-claude/scripted-executor.mjs
  invariants:
    - "Scripted workers substitute LLM"
  test_layers:
    - contract
  pattern: B
  depends_on: []
  ac_kind: implementation
  criticality: degradable
\`\`\`

## §12 Decision Log

| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|---------------|------------------------|-----------|------|
| 1 | Use scripted workers | CONVEYOR v4.3 §16 | Real LLM, fixture replay | Deterministic, fast, contract-faithful | 2026-08-08 |
`;

  // Write file to disk so the SRS validator can read it
  const srsPath = 'docs/formalization/SRS.md';
  const fullPath = `${repoPath}/${srsPath}`;
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, srsContent, 'utf8');
  process.stderr.write(`[formalization-author] wrote SRS file: ${fullPath}\n`);

  // Compute content_hash from the actual file bytes (validator will verify)
  const fileHash = createHash('sha256').update(srsContent, 'utf8').digest('hex');
  const srsResult = await client.call('artifact_create', {
    project_id: projectId, epic_id: epicId,
    type: 'SRS', code: 'SRS',
    title: 'Software Requirements Specification',
    path: srsPath,
    status: 'draft',
    content_hash: fileHash,
    project_repository_id: 1,
  });
  const srs = JSON.parse(srsResult[0]?.text ?? '{}');
  process.stderr.write(`[formalization-author] artifact_create SRS → id=${srs.id}\n`);
  // SRS --derived_from--> PRD
  await addTrace(client, srs.id, prdId, 'derived_from');
  return { srs };
}

// --- Find previously-accepted artifacts in this epic (from earlier cells) ---

async function findAcceptedArtifacts(client, epicId, type) {
  const result = await client.call('artifact_list', {
    epic_id: epicId,
    type,
    status: 'accepted',
  });
  const parsed = JSON.parse(result[0]?.text ?? '{"artifacts":[]}');
  const artifacts = parsed.artifacts || parsed || [];
  process.stderr.write(`[formalization-author] found ${artifacts.length} accepted ${type}\n`);
  return artifacts;
}

// --- main ---

async function main() {
  const { mcpConfigPath } = parseArgv(process.argv);
  if (!mcpConfigPath) { process.stderr.write('--mcp-config required\n'); process.exit(2); }

  const prompt = parsePrompt(await readStdin());
  process.stderr.write(`[formalization-author] task_id=${prompt.task_id} execution_id=${prompt.execution_id}\n`);

  emit('system', { subtype: 'init' });

  const client = new McpClient(mcpConfigPath);
  try {
    await client.init();

    // Читаем task metadata — нужен process_node_id
    const taskResult = await client.call('task_get', { id: Number(prompt.task_id) });
    const taskData = JSON.parse(taskResult[0]?.text ?? '{}');
    // tasks.metadata is a JSON-string column; handleTaskGet returns it raw.
    const meta = typeof taskData.metadata === 'string'
      ? JSON.parse(taskData.metadata || '{}')
      : (taskData.metadata || {});
    const nodeId = meta.process_node_id || '';
    const projectId = taskData.project_id || Number(prompt.project_id) || 1;
    const epicId = taskData.epic_id || 1;

    process.stderr.write(`[formalization-author] node=${nodeId} project=${projectId} epic=${epicId}\n`);

    emit('assistant', { message: { content: [{ type: 'text', text: `[mock] producing artifacts for ${nodeId}` }] } });

    switch (nodeId) {
      case 'define-product-contract': {
        await produceProductContract(client, { projectId, epicId });
        break;
      }
      case 'model-use-cases': {
        // Find accepted PRD + FR from the product-contract cell
        const prds = await findAcceptedArtifacts(client, epicId, 'PRD');
        const frs = await findAcceptedArtifacts(client, epicId, 'FR');
        if (prds.length === 0 || frs.length === 0) {
          throw new Error(`model-use-cases: no accepted PRD/FR found (prd=${prds.length} fr=${frs.length})`);
        }
        await produceUseCases(client, {
          projectId, epicId,
          prdId: prds[0].id,
          frIds: frs.map(f => f.id),
        });
        break;
      }
      case 'define-acceptance-contract': {
        const frs = await findAcceptedArtifacts(client, epicId, 'FR');
        const nfrs = await findAcceptedArtifacts(client, epicId, 'NFR');
        const ucs = await findAcceptedArtifacts(client, epicId, 'UC');
        if (frs.length === 0) throw new Error('define-acceptance-contract: no accepted FR');
        await produceAcceptance(client, {
          projectId, epicId,
          frIds: frs.map(f => f.id),
          nfrIds: nfrs.map(n => n.id),
          ucIds: ucs.map(u => u.id),
        });
        break;
      }
      case 'reconcile-what': {
        await produceReconciliation(client);
        break;
      }
      case 'define-architecture-contract': {
        const prds = await findAcceptedArtifacts(client, epicId, 'PRD');
        if (prds.length === 0) throw new Error('define-architecture-contract: no accepted PRD');
        // The SRS validator reads file from project_repositories.local_path + srs.path.
        // button.mjs sets SAGA_BUTTON_REPO_PATH to the exact temp repo dir it created.
        const repoPath = process.env.SAGA_BUTTON_REPO_PATH || '.';
        process.stderr.write(`[formalization-author] repoPath=${repoPath}\n`);
        await produceArchitecture(client, {
          projectId, epicId,
          prdId: prds[0].id,
          repoPath,
        });
        break;
      }
      default:
        throw new Error(`Unknown formalization node: ${nodeId}`);
    }

    // worker_done
    const wd = await client.call('worker_done', {
      task_id: Number(prompt.task_id),
      worker_id: prompt.worker_id,
      result: `formalization author completed for ${nodeId}`,
      execution_id: prompt.execution_id,
    });
    const wdText = wd[0]?.text ?? '{}';
    process.stderr.write(`[formalization-author] worker_done raw: ${wdText.slice(0, 200)}\n`);
    let wdData;
    try { wdData = JSON.parse(wdText); } catch { wdData = { parse_error: wdText.slice(0, 100) }; }
    process.stderr.write(`[formalization-author] worker_done → status=${wdData.completed_new_status || wdData.parse_error || '?'}\n`);

    emit('result', { subtype: 'success', is_error: false });
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[formalization-author] FATAL: ${err.message}\n`);
  emit('result', { subtype: 'error', is_error: true });
  process.exit(1);
});
