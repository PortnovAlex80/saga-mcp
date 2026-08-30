#!/usr/bin/env node
// Saga5 canary (M5): one real end-to-end run through the whole stack.
//
//   idea (emit) → spec (llm: glm-5.3-flash) → implement (llm) →
//   quality (gate: valid HTML, repair budget) → publish (git effect)
//
// Requirements: the bridge is running (DB_PATH=.saga.db npm run bridge),
// opencode is authenticated for zai-coding-plan.
//
//   node scenarios/canary.mjs [bridgeUrl]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.env.SAGA_CANARY_DIR ?? path.resolve(repoRoot, '..', 'saga5-canary');
const productRepo = path.join(workspace, 'product-repo');
const bridge = process.argv[2] ?? process.env.SAGA_BRIDGE_URL ?? 'http://localhost:4455';
const MODEL = 'zai-coding-plan/glm-5.3-flash';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

if (!existsSync(productRepo)) {
  mkdirSync(productRepo, { recursive: true });
  git(productRepo, ['init', '-q', '-b', 'main']);
  git(productRepo, ['config', 'user.email', 'canary@saga5.local']);
  git(productRepo, ['config', 'user.name', 'saga5 canary']);
  console.log(`[canary] product repo created: ${productRepo}`);
}

const graph = {
  nodes: {
    idea: {
      type: 'emit',
      parameters: {
        items: [{
          json: {
            text: "Одностраничный сайт-визитка кофейни «Тёплый пар»: секции — о нас, меню, контакты; стиль — минимализм, тёплые тона.",
          },
        }],
      },
    },
    spec: {
      type: 'llm',
      parameters: {
        mode: 'opencode',
        model: MODEL,
        prompt: 'Ты аналитик. По идее составь краткое ТЗ из 5 пунктов; каждый пункт с новой строки и начинается с "- ". Только пункты, без лишних слов:\n\n{{text}}',
      },
    },
    implement: {
      type: 'llm',
      parameters: {
        mode: 'opencode',
        model: MODEL,
        prompt: 'Ты верстальщик. По ТЗ напиши ОДИН самодостаточный HTML-файл (с <!DOCTYPE html>, <html>, <head> с <title> и <body>). Верни только код без пояснений:\n\n{{text}}',
      },
    },
    quality: {
      type: 'gate',
      parameters: {
        checks: [
          { op: 'contains', value: '<html' },
          { op: 'contains', value: '</html>' },
          { op: 'contains', value: '<body' },
        ],
        repair_target: 'implement',
        max_repairs: 2,
        title: 'Канарейка: страница без валидного HTML',
      },
    },
    publish: {
      type: 'effect',
      parameters: {
        mode: 'git',
        repo: productRepo,
        branch: 'main',
        message: 'canary: publish page from desk material',
        files: [{ path: 'index.html', field: 'text' }],
      },
    },
  },
  connections: {
    idea: { main: [[{ node: 'spec' }]] },
    spec: { main: [[{ node: 'implement' }]] },
    implement: { main: [[{ node: 'quality' }]] },
    quality: { main: [[{ node: 'publish' }]] },
  },
};

const post = async (path_, body) => {
  const res = await fetch(`${bridge}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};
const get = async (path_) => (await fetch(`${bridge}${path_}`)).json();

console.log(`[canary] bridge: ${bridge}`);
const started = await post('/api/graph', { name: 'canary', graph_json: JSON.stringify(graph) });
console.log(`[canary] run ${started.runId}: ${started.status}`);
if (started.status === 'error') {
  console.error('[canary] kernel rejected the graph — см. event_tail');
  process.exit(1);
}

const deadline = Date.now() + 5 * 60_000;
let status = started.status;
while (status !== 'success' && status !== 'error' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const header = await get(`/api/runs/${started.runId}`);
  status = header.run.status;
  const tail = await get(`/api/runs/${started.runId}/events?limit=100`);
  const marks = tail.events
    .filter((e) => ['gate.decided', 'effect.receipted', 'node.completed'].includes(e.type))
    .map((e) => {
      const p = JSON.parse(e.payload_json);
      if (e.type === 'gate.decided') return `gate ${p.node_id}: ${p.verdict} (${p.reasons?.length ?? 0} reasons)`;
      if (e.type === 'effect.receipted') return `effect ${p.node_id}: ${p.outcome}`;
      return `✓ ${p.node_id}`;
    });
  console.log(`[canary] ${status} | ${marks.join(' · ') || 'ожидание активностей…'}`);
}

if (status !== 'success') {
  console.error(`[canary] итог: ${status}. Разбор: GET ${bridge}/api/runs/${started.runId}/events`);
  process.exit(1);
}

console.log('[canary] SUCCESS');
console.log(`[canary] product repo:`);
console.log(git(productRepo, ['log', '--oneline']));
console.log(`[canary] page size: ${git(productRepo, ['show', 'HEAD:index.html']).length} bytes`);
