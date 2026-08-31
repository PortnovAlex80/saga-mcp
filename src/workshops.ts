import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Desk, WorkshopSpec } from './desks.js';
import { latestPublished } from './kernel/artifacts.js';
import { runGraph, type RunResult } from './kernel/runner.js';
import { BUILTIN_SKILLS } from './skills.js';
import { compileWorkshop, type GraphDoc } from './workshop-compiler.js';
import { WORKSHOP_SPECS } from './workshop-specs.js';

// ЕДИНСТВЕННЫЙ вход в производство.
//
// Цех — это данные (`workshop-specs.ts`), граф компилируется из столов, а эта
// функция делает ровно три вещи: подставляет продуктовый репозиторий, находит
// входной материал и запускает прогон. Новый цех не добавляет ни функции, ни
// тула, ни ручки — только запись в спецификации.

export interface WorkshopInput {
  name: string;
  label: string;
  kind: 'text' | 'longtext';
  required?: boolean;
  placeholder?: string;
}

export interface Workshop {
  title: string;
  graph: GraphDoc;
  inputs: WorkshopInput[];
  spec: WorkshopSpec;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Абсолютный путь к инструментам завода — подставляется в команды столов
 *  приёмки, которые выполняются В ПРОДУКТОВОМ репозитории. */
function toolsDir(): string {
  return path.join(repoRoot(), 'tools');
}

function compile(spec: WorkshopSpec): GraphDoc {
  return compileWorkshop(spec, { skills: BUILTIN_SKILLS }).graph;
}

/** Поля ввода цеха выводятся из его столов: оператор заполняет то, что цех
 *  объявил, а стол рисует форму сам. */
function inputsOf(spec: WorkshopSpec): WorkshopInput[] {
  const inputs: WorkshopInput[] = [];
  for (const desk of spec.desks) {
    if (desk.input.kind === 'operator') {
      inputs.push({
        name: desk.input.field ?? 'idea',
        label: desk.input.label ?? `Вход стола «${desk.title}»`,
        kind: 'longtext',
        required: true,
        placeholder: 'опиши идею…',
      });
    } else if (desk.input.kind === 'artifact' && desk.input.field) {
      inputs.push({
        name: desk.input.field,
        label: desk.input.label ?? `${desk.title} (пусто — возьмём принятый артефакт ${desk.input.path})`,
        kind: 'longtext',
      });
    }
  }
  return inputs;
}

export const DEFAULT_WORKSHOPS: Record<string, Workshop> = Object.fromEntries(
  Object.entries(WORKSHOP_SPECS).map(([name, spec]) => [
    name,
    { title: spec.title, graph: compile(spec), inputs: inputsOf(spec), spec },
  ])
);

/** Resolves (and lazily creates) the product repo the desks publish into. */
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

/** Материал между цехами передаётся ПРИНЯТЫМ артефактом из хранилища (точный
 *  дайджест, полная родословная); файл в репозитории — запасной путь для
 *  материала, произведённого вне ядра. */
function readUpstreamArtifact(
  db: Database.Database,
  repo: string,
  filePath: string,
  errorCode: string
): { text: string; source: string; digest?: string } {
  const published = latestPublished(db, filePath, { repo });
  if (published) {
    return { text: published.content, source: filePath, digest: published.digest };
  }
  const onDisk = path.join(repo, filePath);
  if (existsSync(onDisk)) {
    return { text: readFileSync(onDisk, 'utf8'), source: filePath };
  }
  throw new Error(
    `${errorCode}: нет принятого артефакта '${filePath}' ни на столе, ни в продуктовом репозитории — запустите предыдущий цех или передайте материал явно`
  );
}

function assertReadable(text: string, code: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${code}_REQUIRED: материал пуст`);
  if (trimmed.includes('�')) {
    throw new Error(
      `${code}_NOT_UTF8: материал пришёл в битой кодировке (символы �). ` +
      'Пришлите его через стол (браузер всегда UTF-8) или JSON-файлом в UTF-8 через curl --data-binary @file'
    );
  }
  return trimmed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Подстановка окружения в скомпилированный граф: продуктовый репозиторий,
 *  путь к инструментам завода и (для тестов) режим воркера. */
function injectEnvironment(
  graph: GraphDoc,
  opts: { repo: string; mode?: string }
): void {
  const applyMode = (parameters: Record<string, unknown>): void => {
    if (opts.mode) parameters.mode = opts.mode;
  };
  for (const node of Object.values(graph.nodes)) {
    const parameters = (node.parameters ?? {}) as Record<string, unknown>;
    if (node.type === 'effect' || node.type === 'command') parameters.repo = opts.repo;
    if (node.type === 'command' && typeof parameters.run === 'string') {
      parameters.run = parameters.run.replace(/\{\{tools\}\}/g, toolsDir().replace(/\\/g, '/'));
    }
    if (node.type === 'llm') {
      if (parameters.attach) parameters.repo = opts.repo;
      applyMode(parameters);
    }
    if (node.type === 'split' && isRecord(parameters.child)) {
      const child = parameters.child as { type?: string; parameters?: Record<string, unknown> };
      if (child.parameters) {
        if (child.parameters.attach) child.parameters.repo = opts.repo;
        applyMode(child.parameters);
      }
    }
  }
}

function inputNodeText(graph: GraphDoc, desk: Desk, text: string): void {
  const node = graph.nodes[`${desk.id}_input`];
  const items = (node?.parameters?.items ?? []) as Array<{ json: Record<string, unknown> }>;
  if (items[0]) items[0].json.text = text;
}

export interface WorkshopStart extends RunResult {
  workshop: string;
  repo: string;
  /** Откуда взят материал каждого входного стола. */
  sources: Record<string, string>;
}

export function startWorkshop(
  db: Database.Database,
  name: string,
  input: Record<string, unknown> = {}
): WorkshopStart {
  const spec = WORKSHOP_SPECS[name];
  if (!spec) {
    throw new Error(`WORKSHOP_UNKNOWN: '${name}' (известны: ${Object.keys(WORKSHOP_SPECS).join(', ')})`);
  }
  const repo = ensureProductRepo(input.repo === undefined ? undefined : String(input.repo));
  const graph = JSON.parse(JSON.stringify(compile(spec))) as GraphDoc;
  const sources: Record<string, string> = {};

  for (const desk of spec.desks) {
    if (desk.input.kind === 'operator') {
      const field = desk.input.field ?? 'idea';
      const raw = input[field];
      if (raw === undefined || String(raw).trim() === '') {
        throw new Error(`INPUT_REQUIRED: '${field}' — ${desk.input.label ?? desk.title}`);
      }
      inputNodeText(graph, desk, assertReadable(String(raw), field.toUpperCase()));
      sources[desk.id] = 'operator';
    } else if (desk.input.kind === 'artifact') {
      const override = desk.input.field === undefined ? undefined : input[desk.input.field];
      if (override !== undefined && String(override).trim() !== '') {
        inputNodeText(graph, desk, assertReadable(String(override), desk.id.toUpperCase()));
        sources[desk.id] = 'provided';
      } else {
        const upstream = readUpstreamArtifact(db, repo, desk.input.path, `${desk.id.toUpperCase()}_MISSING`);
        inputNodeText(graph, desk, assertReadable(upstream.text, desk.id.toUpperCase()));
        sources[desk.id] = upstream.digest ? `${upstream.source}@${upstream.digest.slice(0, 12)}` : upstream.source;
      }
    }
  }

  injectEnvironment(graph, {
    repo,
    mode: input.mode === undefined ? undefined : String(input.mode),
  });

  const result = runGraph(db, JSON.stringify(graph), { name });
  return { workshop: name, repo, sources, ...result };
}
