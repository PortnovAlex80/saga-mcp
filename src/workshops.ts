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
        items: [{ json: { text: '', source_ref: '' } }],
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

const PRODUCT_GRAPH = {
  nodes: {
    idea: { type: 'emit', parameters: { items: [{ json: { text: '' } }] } },
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
    brief_gate: {
      type: 'gate',
      parameters: {
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
    publish_brief: {
      type: 'effect',
      parameters: {
        mode: 'git',
        repo: '', // injected at start time
        branch: 'main',
        message: 'discovery: brief artifact',
        files: [{ path: 'discovery/brief.md', field: 'text' }],
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
    srs_gate: {
      type: 'gate',
      parameters: {
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
    publish_srs: {
      type: 'effect',
      parameters: {
        mode: 'git',
        repo: '', // injected at start time
        branch: 'main',
        message: 'formalization: SRS artifact',
        files: [{ path: 'formalization/srs.md', field: 'text' }],
      },
    },
  },
  connections: {
    idea: { main: [[{ node: 'brief' }]] },
    brief: { main: [[{ node: 'brief_gate' }]] },
    // Принятая ревизия брифа расходится в две стороны: публикация артефакта
    // и следующий цех (SRS читает бриф по точным дайджестам того же стола).
    brief_gate: { main: [[{ node: 'publish_brief' }, { node: 'srs' }]] },
    srs: { main: [[{ node: 'srs_gate' }]] },
    srs_gate: { main: [[{ node: 'publish_srs' }]] },
  },
};

const IMPLEMENT_PROMPT = [
  'Ты — разработчик. Реализуй ОДНУ задачу веб-приложения (статические файлы: html/css/js, без сборки и серверного кода).',
  'Верни ТОЛЬКО JSON-массив файлов: [{"path":"...","content":"..."}] — без markdown, без пояснений.',
  'Файлы должны быть полными и рабочими (не заглушки).',
  '',
  'Задача: {{title}}.',
  'Описание: {{description}}.',
  'Файлы: {{files}}.',
].join('\n');

const REVIEW_PROMPT = [
  'Ты — ревьюер кода. Проверь файлы на: полноту реализации (не заглушки),',
  'синтаксическую корректность, соответствие заявленным файлам задачи.',
  'Первая строка ответа строго: VERDICT: APPROVED или VERDICT: REJECT.',
  'При REJECT после вердикта перечисли конкретные причины.',
  '',
  '{{path}}:',
  '```',
  '{{content}}',
  '```',
].join('\n');

function devGraph(usePlanner: boolean) {
  const head = usePlanner
    ? {
        input: { type: 'emit', parameters: { items: [{ json: { text: '', source_ref: 'formalization/srs.md' } }] } },
        plan: {
          type: 'llm',
          parameters: {
            mode: 'opencode',
            model: MODEL,
            prompt: [
              'Ты — техлид (цех Development). По SRS составь план НЕЗАВИСИМЫХ задач разработки.',
              'Верни ТОЛЬКО JSON-массив, каждый элемент:',
              '{"id":"T1","title":"...","description":"...","files":["index.html","styles.css"]}.',
              'Правила: 2–4 задачи; задачи независимы (каждая осмысленна сама по себе);',
              'файлы не пересекаются между задачами; без markdown — только JSON.',
              '',
              'SRS:',
              '{{text}}',
            ].join('\n'),
          },
        },
        plan_gate: {
          type: 'gate',
          parameters: {
            checks: [
              { op: 'not_contains', field: 'text', value: '\uFFFD' },
              { op: 'json_array', field: 'text', min_count: 2 },
            ],
            repair_target: 'plan',
            max_repairs: 2,
            title: 'Development: план задач не является JSON-массивом (≥2)',
          },
        },
        parse: { type: 'json_parse', parameters: {} },
      }
    : {
        input: { type: 'emit', parameters: { items: [] } }, // tasks injected at start
      };

  const headConnections = usePlanner
    ? {
        input: { main: [[{ node: 'plan' }]] },
        plan: { main: [[{ node: 'plan_gate' }]] },
        plan_gate: { main: [[{ node: 'parse' }]] },
        parse: { main: [[{ node: 'tasks' }]] },
      }
    : {
        input: { main: [[{ node: 'tasks' }]] },
      };

  return {
    nodes: {
      ...head,
      // Динамический fan-out: по одному дочернему llm-воркеру на задачу.
      tasks: {
        type: 'split',
        parameters: {
          child: {
            type: 'llm',
            parameters: {
              mode: 'opencode',
              model: MODEL,
              prompt: IMPLEMENT_PROMPT,
              timeouts: { heartbeat_s: 15, start_to_close_s: 240, schedule_to_start_s: 60 },
              retry: { max_attempts: 2 },
            },
          },
        },
      },
      merge: { type: 'join', parameters: {} },
      parse_files: { type: 'json_parse', parameters: {} },
      review: {
        type: 'llm',
        parameters: {
          mode: 'opencode',
          model: MODEL,
          prompt: REVIEW_PROMPT,
          timeouts: { heartbeat_s: 15, start_to_close_s: 240 },
          retry: { max_attempts: 2 },
        },
      },
      review_gate: {
        type: 'gate',
        parameters: {
          checks: [
            { op: 'not_contains', field: 'text', value: '\uFFFD' },
            { op: 'contains', field: 'text', value: 'VERDICT: APPROVED' },
          ],
          repair_target: 'review',
          max_repairs: 2,
          title: 'Development: ревью не одобрило код',
        },
      },
      integrate: {
        type: 'effect',
        parameters: {
          mode: 'git',
          repo: '', // injected at start time
          branch: 'main',
          message: 'development: implement tasks',
          files_from: 'items',
        },
      },
    },
    connections: {
      ...headConnections,
      tasks: { main: [[{ node: 'merge' }]] },
      merge: { main: [[{ node: 'parse_files' }]] },
      parse_files: { main: [[{ node: 'review' }]] },
      review: { main: [[{ node: 'review_gate' }]] },
      review_gate: { main: [[{ node: 'integrate' }]] },
    },
  };
}

export const DEFAULT_WORKSHOPS: Record<string, { title: string; graph: unknown }> = {
  product: {
    title: 'Продуктовый конвейер — Discovery + Formalization единым прогоном',
    graph: PRODUCT_GRAPH,
  },
  discovery: {
    title: 'Discovery Desk — идея → бриф → артефакт',
    graph: DISCOVERY_GRAPH,
  },
  formalization: {
    title: 'Formalization Desk — бриф → SRS (FR/NFR/UC/AC)',
    graph: FORMALIZATION_GRAPH,
  },
  development: {
    title: 'Development Desk — SRS → задачи → параллельная реализация → ревью → интеграция',
    graph: devGraph(true),
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

/** The unified product conveyor: Discovery + Formalization in ONE run.
 *  The brief is accepted by its gate, published as an artifact, and the SAME
 *  accepted material (exact digests) flows into the SRS stage — data passes
 *  between the workshops by reference through the content-addressed desk. */
export function startProduct(
  db: Database.Database,
  opts: { idea: string; repo?: string; mode?: string }
): RunResult & { repo: string } {
  if (!opts.idea || !opts.idea.trim()) {
    throw new Error('IDEA_REQUIRED: напишите идею в стартовый узел');
  }
  if (opts.idea.includes('\uFFFD')) {
    throw new Error('IDEA_NOT_UTF8: идея пришла в битой кодировке (символы \uFFFD)');
  }
  const graph = JSON.parse(JSON.stringify(PRODUCT_GRAPH)) as typeof PRODUCT_GRAPH;
  graph.nodes.idea.parameters.items[0].json.text = opts.idea.trim();
  if (opts.mode) {
    graph.nodes.brief.parameters.mode = opts.mode as 'echo' | 'opencode' | 'api';
    graph.nodes.srs.parameters.mode = opts.mode as 'echo' | 'opencode' | 'api';
  }
  const repo = ensureProductRepo(opts.repo);
  graph.nodes.publish_brief.parameters.repo = repo;
  graph.nodes.publish_srs.parameters.repo = repo;
  const result = runGraph(db, JSON.stringify(graph), { name: 'product' });
  return { ...result, repo };
}

/** The Development Desk: SRS → task plan → PARALLEL implementation (dynamic
 *  fan-out, one worker per task) → review → integration commit.
 *  opts.tasks bypasses the planner (operator override / tests). */
export function startDevelopment(
  db: Database.Database,
  opts: { srs?: string; tasks?: Array<Record<string, unknown>>; repo?: string; mode?: string }
): RunResult & { repo: string; srsSource: string; tasks: number } {
  const repo = ensureProductRepo(opts.repo);
  const usePlanner = !opts.tasks;
  const graph = devGraph(usePlanner) as ReturnType<typeof devGraph>;

  let srsSource = 'provided';
  if (usePlanner) {
    let srs = opts.srs?.trim();
    if (!srs) {
      const prev = path.join(repo, 'formalization', 'srs.md');
      if (!existsSync(prev)) {
        throw new Error('SRS_MISSING: сначала запустите Formalization Desk (артефакта formalization/srs.md нет) или передайте srs/tasks явно');
      }
      srs = readFileSync(prev, 'utf8');
      srsSource = 'formalization/srs.md';
    }
    if (srs.includes('\uFFFD')) {
      throw new Error('SRS_NOT_UTF8: SRS содержит символы \uFFFD — исправьте кодировку');
    }
    (graph.nodes.input.parameters as { items: Array<{ json: Record<string, unknown> }> }).items[0].json.text = srs;
  } else {
    const tasks = opts.tasks ?? [];
    if (tasks.length === 0) throw new Error('TASKS_REQUIRED: передайте непустой массив задач');
    (graph.nodes.input.parameters as { items: unknown[] }).items = tasks;
    srsSource = 'manual-tasks';
  }

  if (opts.mode) {
    const m = opts.mode as 'echo' | 'opencode' | 'api';
    const planner = (graph.nodes as Record<string, { parameters?: Record<string, unknown> }>).plan;
    if (planner?.parameters) planner.parameters.mode = m;
    ((graph.nodes.tasks.parameters as { child: { parameters: Record<string, unknown> } }).child.parameters).mode = m;
    (graph.nodes.review.parameters as Record<string, unknown>).mode = m;
  }
  (graph.nodes.integrate.parameters as Record<string, unknown>).repo = repo;

  const result = runGraph(db, JSON.stringify(graph), {
    name: usePlanner ? 'development' : 'development-manual',
  });
  return {
    ...result,
    repo,
    srsSource,
    tasks: usePlanner ? 0 : (opts.tasks ?? []).length,
  };
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
  // передача ссылкой: вход следующего цеха ссылается на артефакт предыдущего
  graph.nodes.brief.parameters.items[0].json.source_ref = 'discovery/brief.md';
  if (opts.mode) {
    graph.nodes.srs.parameters.mode = opts.mode as 'echo' | 'opencode' | 'api';
  }
  graph.nodes.artifact.parameters.repo = repo;
  const result = runGraph(db, JSON.stringify(graph), { name: 'formalization' });
  return { ...result, repo, briefSource };
}
