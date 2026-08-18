#!/usr/bin/env node
/**
 * Универсальный formalization author — создаёт артефакты + трассы по node_id.
 *
 * Материал — golden-корпус (tests/fixtures/golden-corpus): документы, которые
 * реальная модель произвела и реальные гейты приняли в захваченном ране.
 * Имитатор воспроизводит захваченную структуру производства узла:
 *   - какие артефакты создаёт узел (порядок и типы — из бандла узла),
 *   - тела документов (байты корпуса, content_hash = sha256 этих байтов),
 *   - топологию трасс (рёбра из бандла, перепривязанные на id текущего рана).
 * Run-специфичное (id артефактов, projectId/epicId, путь репо) разрешается
 * в рантайме; сочинять текст имитатору больше нечего — loadCorpus fail-closed.
 *
 * Формализация использует kernel-gate artifact acceptance: артефакты
 * создаются со статусом 'draft', гейт/эффект приёмки помечает их accepted.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
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

// --- Corpus access (fail-closed: absence of material is an error, not prose) ---

const corpus = loadCorpus();

// manifest.artifacts упорядочен по id захваченного рана; бандлы узлов
// ссылаются на те же id. Join id↔code проверяется при первом обращении.
const CORPUS_ARTIFACTS = corpus.manifest.artifacts;
const corpusRowByCode = new Map(CORPUS_ARTIFACTS.map(row => [row.code, row]));
const corpusCodeById = new Map(CORPUS_ARTIFACTS.map((row, index) => [index + 1, row.code]));

const NODE_BUNDLE_SCHEMA = {
  'define-product-contract': 'factory.formalization-product-bundle.v1',
  'model-use-cases': 'factory.formalization-use-case-bundle.v1',
  'define-acceptance-contract': 'factory.formalization-acceptance-bundle.v1',
  'define-architecture-contract': 'factory.formalization-architecture-bundle.v1',
};

function corpusCode(artifactId) {
  const code = corpusCodeById.get(artifactId);
  if (!code) {
    throw new Error(`GOLDEN_CORPUS_JOIN_FAILED: bundle references artifact id ${artifactId}, `
      + `corpus index has ${CORPUS_ARTIFACTS.length} artifacts (codes: ${[...corpusCodeById.values()].join(', ')})`);
  }
  return code;
}

// Тело документа узла: якорь '#AC-1' отрезается — несколько артефактов
// (например FR-1..FR-4) законно делят один файл корпуса.
function corpusDocumentBytes(row) {
  return corpus.document(row.path.split('#')[0].split('/').pop());
}

// --- Artifact + trace creation helpers ---

async function createArtifact(client, {
  projectId, epicId, type, code, title, artifactPath, contentHash,
  metadata = undefined, projectRepositoryId = undefined,
}) {
  const result = await client.call('artifact_create', {
    project_id: projectId,
    epic_id: epicId,
    type,
    code,
    title,
    path: artifactPath,
    status: 'draft',
    content_hash: contentHash,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(projectRepositoryId !== undefined ? { project_repository_id: projectRepositoryId } : {}),
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

async function findArtifactIdsByCodes(client, epicId, codes) {
  // Разрешение корпусных id → id текущего рана для артефактов, созданных
  // РАНЕЕ работавшими узлами (например UC → PRD). Код уникален в рамках
  // (epic, type) — статусы не фильтруем:kernel-gate принимает асинхронно.
  const wanted = new Set(codes);
  const idByCode = new Map();
  for (const code of wanted) {
    const row = corpusRowByCode.get(code);
    if (!row) throw new Error(`GOLDEN_CORPUS_ARTIFACT_ABSENT: ${code}`);
    const result = await client.call('artifact_list', { epic_id: epicId, type: row.type });
    const parsed = JSON.parse(result[0]?.text ?? '{"artifacts":[]}');
    const artifacts = parsed.artifacts || parsed || [];
    const match = artifacts.find(a => a.code === code);
    if (!match) {
      throw new Error(`artifact '${code}' (type ${row.type}) not found in epic ${epicId} — `
        + `earlier formalization node did not run or did not produce it`);
    }
    idByCode.set(code, match.id);
  }
  return idByCode;
}

// brief_payload: структурные значения парсятся из Complexity Profile документа
// корпуса (complexity.tshirt / topology_hint / shared_mutation_risk / Discovery
// Outcome). classification/completeness — структурные константы контракта.
function briefPayloadFromDocument(bytes, projectId) {
  const line = (re) => {
    const m = re.exec(bytes);
    if (!m) throw new Error(`GOLDEN_CORPUS_BRIEF_PROFILE_MISSING: ${re}`);
    return m[1].trim();
  };
  return {
    classification: 'product',
    complexity: { tshirt: line(/- \*\*complexity\.tshirt:\*\* (\S+)/), risk_triggers: [] },
    decision: line(/\*\*Discovery Outcome:\*\* (\S+)/),
    reasoning: line(/- \*\*rationale:\*\* (.+)/),
    affected_projects: [projectId],
    topology_hint: line(/- \*\*topology_hint:\*\* (\S+)/),
    scaffold_artifacts: [],
    shared_mutation_risk: line(/- \*\*shared_mutation_risk:\*\* (\S+)/) === 'true',
    completeness: 'high',
    degraded: false,
  };
}

// --- Per-node production logic (корпус: бандл узла = план производства) ---

function writeDocumentFile(repoPath, artifactPath, bytes) {
  const file = artifactPath.split('#')[0];
  const fullPath = path.join(repoPath, file);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, bytes, 'utf8');
}

/**
 * Воспроизвести производство узла по его бандлу из корпуса:
 * артефакты в порядке захвата, затем трассы бандла (цели из предыдущих
 * узлов разрешаются через artifact_list по коду).
 */
async function produceFromCorpusBundle(client, { projectId, epicId, nodeId, repoPath }) {
  const schemaId = NODE_BUNDLE_SCHEMA[nodeId];
  if (!schemaId) throw new Error(`Unknown formalization node: ${nodeId}`);
  const bundle = corpus.product(nodeId, schemaId);

  const createdIdByCorpusId = new Map();
  for (const entry of bundle.artifacts) {
    const code = corpusCode(entry.artifactId);
    const row = corpusRowByCode.get(code);
    if (row.type !== entry.artifactType) {
      throw new Error(`GOLDEN_CORPUS_JOIN_FAILED: bundle says id ${entry.artifactId} is `
        + `${entry.artifactType}, corpus index says ${row.type}`);
    }
    const bytes = corpusDocumentBytes(row);
    writeDocumentFile(repoPath, row.path, bytes);
    const created = await createArtifact(client, {
      projectId, epicId,
      type: entry.artifactType,
      code,
      title: row.title,
      artifactPath: row.path,
      contentHash: createHash('sha256').update(bytes, 'utf8').digest('hex'),
      metadata: entry.artifactType === 'brief'
        ? { brief_payload: briefPayloadFromDocument(bytes, projectId) }
        : undefined,
      projectRepositoryId: entry.artifactType === 'SRS' ? 1 : undefined,
    });
    createdIdByCorpusId.set(entry.artifactId, created.id);
  }

  // Трассы бандла: источники — только что созданные артефакты узла; цели могут
  // быть из предыдущих узлов (разрешение по коду через текущий epic).
  const externalTargetCodes = [...new Set(
    bundle.traces
      .filter(trace => !createdIdByCorpusId.has(trace.targetId))
      .map(trace => corpusCode(trace.targetId)),
  )];
  const externalIdByCode = await findArtifactIdsByCodes(client, epicId, externalTargetCodes);
  for (const trace of bundle.traces) {
    const targetId = createdIdByCorpusId.has(trace.targetId)
      ? createdIdByCorpusId.get(trace.targetId)
      : externalIdByCode.get(corpusCode(trace.targetId));
    await addTrace(client, createdIdByCorpusId.get(trace.sourceId), targetId, trace.linkType);
  }
}

async function produceReconciliation(client) {
  // reconcile-what использует typed-submission (product_submit), не артефакты.
  // Отчёт примирения — тоже захваченный материал корпуса.
  const report = corpus.product('reconcile-what', 'factory.formalization-reconciliation-report.v1');
  await client.call('product_submit', {
    schema: 'factory.formalization-reconciliation-report.v1',
    content: report,
  });
  process.stderr.write(`[formalization-author] reconciliation submitted (corpus)\n`);
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

    // План производства каждого узла — бандл узла из корпуса; для SRS-узла
    // файл пишется в репо, привязанное к задаче (SAGA_BUTTON_REPO_PATH).
    const repoPath = process.env.SAGA_BUTTON_REPO_PATH || '.';
    switch (nodeId) {
      case 'define-product-contract':
      case 'model-use-cases':
      case 'define-acceptance-contract':
      case 'define-architecture-contract': {
        await produceFromCorpusBundle(client, { projectId, epicId, nodeId, repoPath });
        break;
      }
      case 'reconcile-what': {
        await produceReconciliation(client);
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
