#!/usr/bin/env node
/**
 * Mock-диспетчер рабочих.
 *
 * Подключается через project.metadata.mockDispatcher — infrastructure routing.
 * Система видит "claude-cli" executor, resolveExecutorPath отдаёт этот скрипт.
 * Ядро и оркестр не знают о подмене.
 *
 * Скрипт получает тот же что claude: argv (--mcp-config), stdin (prompt).
 * Читает task_kind из prompt → запускает соответствующий рабочий скрипт.
 * Рабочий работает через MCP (product_submit, worker_done — как настоящий).
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Парсинг argv и stdin ---
function parseArgv(argv) {
  const args = argv.slice(2);
  let mcpConfigPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config' && i + 1 < args.length) {
      mcpConfigPath = args[i + 1]; i++;
    }
  }
  return { mcpConfigPath, rawArgs: args };
}

// --- Маршрутизация: task_kind → рабочий скрипт по цехам ---
const KIND_TO_SCRIPT = {
  // Discovery
  'discovery.work': 'workshops/discovery/produce-proposal-author.mjs',
  'discovery.assess': 'workshops/discovery/assess-readiness-advisor.mjs',
  // Formalization — один generic-author для всех author ролей
  'formalization.product': 'workshops/formalization/generic-author.mjs',
  'formalization.use-cases': 'workshops/formalization/generic-author.mjs',
  'formalization.acceptance': 'workshops/formalization/generic-author.mjs',
  'formalization.reconcile': 'workshops/formalization/generic-author.mjs',
  'formalization.architecture': 'workshops/formalization/generic-author.mjs',
  // Development (TODO)
  // Delivery (kernel + human — не нужны mock-воркеры)
};

// --- main ---
async function main() {
  const { mcpConfigPath, rawArgs } = parseArgv(process.argv);
  if (!mcpConfigPath) { process.stderr.write('[dispatcher] --mcp-config required\n'); process.exit(2); }

  // Читаем stdin (prompt от buildPrompt)
  const stdinChunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdinChunks.push(chunk);
  const prompt = stdinChunks.join('');

  // Извлекаем task_kind из key=value строк (fallback если нет в prompt)
  const kv = {};
  for (const line of prompt.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2];
  }
  let taskKind = kv.task_kind || '';
  const role = kv.role || 'author';
  const taskId = kv.task_id || '';

  // Если task_kind пустой — читаем через MCP (как настоящий claude: task_get)
  if (!taskKind && taskId) {
    process.stderr.write(`[dispatcher] task_kind missing in prompt, reading task_get...\n`);
    // Временно создаём MCP-client для чтения task
    const { spawn: spawnMcp } = await import('node:child_process');
    const { readFileSync: readMcp } = await import('node:fs');
    const mcpConfig = JSON.parse(readMcp(mcpConfigPath, 'utf8'));
    const server = mcpConfig.mcpServers[Object.keys(mcpConfig.mcpServers)[0]];
    const mcpChild = spawnMcp(server.command, server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...server.env },
      windowsHide: true,
    });
    let mcpBuf = '';
    let mcpId = 1;
    const mcpPending = new Map();
    mcpChild.stdout.setEncoding('utf8');
    mcpChild.stdout.on('data', c => {
      mcpBuf += c;
      let nl;
      while ((nl = mcpBuf.indexOf('\n')) >= 0) {
        const line = mcpBuf.slice(0, nl);
        mcpBuf = mcpBuf.slice(nl + 1);
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && mcpPending.has(msg.id)) {
            mcpPending.get(msg.id)(msg);
            mcpPending.delete(msg.id);
          }
        } catch {}
      }
    });
    const mcpSend = (method, params) => new Promise((resolve, reject) => {
      const id = mcpId++;
      mcpPending.set(id, resolve);
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (mcpPending.has(id)) { mcpPending.delete(id); reject(new Error('TIMEOUT')); } }, 5000);
    });
    try {
      await mcpSend('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dispatcher-lookup', version: '1.0' } });
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      const resp = await mcpSend('tools/call', { name: 'task_get', arguments: { id: Number(taskId) } });
      const taskData = JSON.parse(resp.result?.content?.[0]?.text ?? '{}');
      taskKind = taskData.task_kind || '';
      process.stderr.write(`[dispatcher] task_get → task_kind=${taskKind}\n`);
    } catch (e) {
      process.stderr.write(`[dispatcher] task_get failed: ${e.message}\n`);
    }
    try { mcpChild.stdin.end(); mcpChild.kill(); } catch {}
  }

  process.stderr.write(`[dispatcher] task_id=${taskId} task_kind=${taskKind} role=${role}\n`);

  // Маршрутизация: formalization.review маршрутизируется по node_id
  let script;
  if (taskKind === 'formalization.review') {
    // Все formalization reviewers — один скрипт, передаём node_id через env
    script = 'workshops/formalization/generic-reviewer.mjs';
  } else {
    script = KIND_TO_SCRIPT[taskKind];
  }
  if (!script) {
    process.stderr.write(`[dispatcher] NO_WORKER for task_kind='${taskKind}'\n`);
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true }) + '\n');
    process.exit(1);
  }

  // Запускаем рабочий скрипт — тот же argv + тот же stdin
  const scriptPath = path.join(__dirname, script);
  const cliArgs = rawArgs.filter(a => a !== '--model' && !a.startsWith('opus') && !a.startsWith('high'));
  try {
    const result = execSync(
      `node "${scriptPath}" ${cliArgs.map(a => `"${a}"`).join(' ')}`,
      { input: prompt, env: { ...process.env }, cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 60000 },
    );
    process.stdout.write(result);
  } catch (err) {
    process.stderr.write(`[dispatcher] worker failed: ${err.message}\n`);
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[dispatcher] FATAL: ${err.message}\n`);
  process.exit(1);
});
