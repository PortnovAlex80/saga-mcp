import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { runGraph, type RunResult } from './kernel/runner.js';

// Default workshops (цеха) — declarative graphs, the saga5 way of shipping
// "a desk that accepts a task and produces an artifact". No private engines:
// a workshop is data for the same kernel.

const MODEL = 'zai-coding-plan/glm-5.3-flash';

const DISCOVERY_GRAPH = {
  nodes: {
    idea: {
      type: 'emit',
      parameters: {
        items: [{ json: { text: '' } }],
      },
    },
    brief: {
      type: 'llm',
      parameters: {
        mode: 'opencode',
        model: MODEL,
        prompt: [
          'Ты — ведущий аналитик (цех Discovery). По сырой идее сделай короткий продуктовый бриф:',
          '1) суть продукта одним предложением;',
          '2) целевая аудитория;',
          '3) три ключевые ценности;',
          '4) основные риски и открытые вопросы;',
          '5) критерий готовности (что считаем результатом).',
          'Формат — markdown. Только бриф, без вступлений.',
          '',
          'Идея:',
          '{{text}}',
        ].join('\n'),
      },
    },
    quality: {
      type: 'gate',
      parameters: {
        // Executable acceptance criteria = the brief skill's 5-point contract.
        // A section missing from the artifact fails the gate with a typed
        // reason that travels back into the repair attempt's prompt.
        checks: [
          { op: 'nonempty', field: 'text' },
          { op: 'regex', field: 'text', pattern: 'Суть продукта' },
          { op: 'regex', field: 'text', pattern: 'аудитор' },
          { op: 'regex', field: 'text', pattern: 'ценност' },
          { op: 'regex', field: 'text', pattern: 'риск' },
          { op: 'regex', field: 'text', pattern: 'ритери' },
        ],
        repair_target: 'brief',
        max_repairs: 2,
        title: 'Discovery: бриф не соответствует контракту',
      },
    },
    artifact: {
      type: 'effect',
      parameters: {
        mode: 'git',
        repo: '', // injected at start time by startDiscovery()
        branch: 'main',
        message: 'discovery: brief artifact',
        files: [{ path: 'discovery/brief.md', field: 'text' }],
      },
    },
  },
  connections: {
    idea: { main: [[{ node: 'brief' }]] },
    brief: { main: [[{ node: 'quality' }]] },
    quality: { main: [[{ node: 'artifact' }]] },
  },
};

export const DEFAULT_WORKSHOPS: Record<string, { title: string; graph: unknown }> = {
  discovery: {
    title: 'Discovery Desk — идея → бриф → артефакт',
    graph: DISCOVERY_GRAPH,
  },
};

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Resolves (and lazily creates) the product repo the default desk publishes
 *  artifacts into. */
export function ensureProductRepo(explicit?: string): string {
  const repo = explicit ?? process.env.SAGA_PRODUCT_REPO
    ?? path.resolve(repoRoot(), '..', 'saga5-canary', 'product-repo');
  if (!existsSync(path.join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true });
    const run = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'desk@saga5.local']);
    run(['config', 'user.name', 'saga5 desk']);
  }
  return repo;
}

/** The default Discovery Desk: accepts a task (the idea), runs the brief
 *  skill (Discovery workshop), and lands the discovery artifact in the
 *  product repo at discovery/brief.md. */
export function startDiscovery(
  db: Database.Database,
  opts: { idea: string; repo?: string; mode?: string }
): RunResult & { repo: string } {
  if (!opts.idea || !opts.idea.trim()) {
    throw new Error('IDEA_REQUIRED: напишите идею в стартовый узел');
  }
  const graph = JSON.parse(JSON.stringify(DISCOVERY_GRAPH)) as typeof DISCOVERY_GRAPH;
  graph.nodes.idea.parameters.items[0].json.text = opts.idea.trim();
  if (opts.mode) {
    graph.nodes.brief.parameters.mode = opts.mode as 'echo' | 'opencode' | 'api';
  }
  const repo = ensureProductRepo(opts.repo);
  graph.nodes.artifact.parameters.repo = repo;
  const result = runGraph(db, JSON.stringify(graph), { name: 'discovery' });
  return { ...result, repo };
}
