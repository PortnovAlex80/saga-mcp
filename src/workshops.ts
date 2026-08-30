import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
        // not_contains U+FFFD: an unreadable (broken-encoding) idea is an
        // acceptance failure — honest human gate, not a hallucinated brief.
        checks: [
          { op: 'not_contains', field: 'text', value: '\uFFFD' },
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

const FORMALIZATION_GRAPH = {
  nodes: {
    brief: {
      type: 'emit',
      parameters: {
        items: [{ json: { text: '' } }],
      },
    },
    srs: {
      type: 'llm',
      parameters: {
        mode: 'opencode',
        model: MODEL,
        prompt: [
          'Ты — системный аналитик (цех Formalization). По утверждённому брифу подготовь SRS в markdown:',
          '1) Обзор;',
          '2) Функциональные требования — пронумерованные FR-1, FR-2, …',
          '3) Нефункциональные требования — NFR-1, …',
          '4) Варианты использования — UC-1, UC-2, … (актор, сценарий);',
          '5) Критерии приёмки — AC-1, AC-2, …, каждый проверяемый и привязан к FR.',
          'Только документ, без вступлений.',
          '',
          'Бриф:',
          '{{text}}',
        ].join('\n'),
      },
    },
    quality: {
      type: 'gate',
      parameters: {
        // SRS contract: FR/UC/AC numbering must exist, nothing unreadable.
        checks: [
          { op: 'not_contains', field: 'text', value: '\uFFFD' },
          { op: 'nonempty', field: 'text' },
          { op: 'regex', field: 'text', pattern: 'FR-[0-9]' },
          { op: 'regex', field: 'text', pattern: 'UC-[0-9]' },
          { op: 'regex', field: 'text', pattern: 'AC-[0-9]' },
        ],
        repair_target: 'srs',
        max_repairs: 2,
        title: 'Formalization: SRS не соответствует контракту',
      },
    },
    artifact: {
      type: 'effect',
      parameters: {
        mode: 'git',
        repo: '', // injected at start time by startFormalization()
        branch: 'main',
        message: 'formalization: SRS artifact',
        files: [{ path: 'formalization/srs.md', field: 'text' }],
      },
    },
  },
  connections: {
    brief: { main: [[{ node: 'srs' }]] },
    srs: { main: [[{ node: 'quality' }]] },
    quality: { main: [[{ node: 'artifact' }]] },
  },
};

export const DEFAULT_WORKSHOPS: Record<string, { title: string; graph: unknown }> = {
  discovery: {
    title: 'Discovery Desk — идея → бриф → артефакт',
    graph: DISCOVERY_GRAPH,
  },
  formalization: {
    title: 'Formalization Desk — бриф → SRS (FR/NFR/UC/AC)',
    graph: FORMALIZATION_GRAPH,
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
  if (opts.idea.includes('\uFFFD')) {
    throw new Error(
      'IDEA_NOT_UTF8: идея пришла в битой кодировке (символы \uFFFD). ' +
      'Пришлите идею через стол (браузер всегда UTF-8) или запишите JSON в файл в UTF-8 и используйте curl --data-binary @file'
    );
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

/** The Formalization Desk: takes the ACCEPTED discovery artifact (or an
 *  explicitly provided brief), runs the SRS skill, lands
 *  formalization/srs.md. First lifecycle link: the previous workshop's
 *  artifact is this workshop's input. */
export function startFormalization(
  db: Database.Database,
  opts: { brief?: string; repo?: string; mode?: string }
): RunResult & { repo: string; briefSource: string } {
  const repo = ensureProductRepo(opts.repo);
  let brief = opts.brief?.trim();
  let briefSource = 'provided';
  if (!brief) {
    const prev = path.join(repo, 'discovery', 'brief.md');
    if (!existsSync(prev)) {
      throw new Error('BRIEF_MISSING: сначала запустите Discovery Desk (артефакта discovery/brief.md нет) или передайте brief явно');
    }
    brief = readFileSync(prev, 'utf8');
    briefSource = 'discovery/brief.md';
  }
  if (brief.includes('\uFFFD')) {
    throw new Error('BRIEF_NOT_UTF8: бриф содержит символы \uFFFD — исправьте кодировку');
  }
  const graph = JSON.parse(JSON.stringify(FORMALIZATION_GRAPH)) as typeof FORMALIZATION_GRAPH;
  graph.nodes.brief.parameters.items[0].json.text = brief;
  if (opts.mode) {
    graph.nodes.srs.parameters.mode = opts.mode as 'echo' | 'opencode' | 'api';
  }
  graph.nodes.artifact.parameters.repo = repo;
  const result = runGraph(db, JSON.stringify(graph), { name: 'formalization' });
  return { ...result, repo, briefSource };
}
