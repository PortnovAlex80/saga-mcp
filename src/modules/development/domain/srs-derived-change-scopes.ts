/**
 * SRS-derived `requiredChangeScopes` for the ReferenceDevelopmentPolicy.
 *
 * Why this module exists (workshop project 7 / todo): the development policy
 * hardcoded `['package.json', 'tests/']` for EVERY project. The todo SRS
 * mandates a single `index.html` with embedded CSS and vanilla JavaScript and
 * no Node scaffolding, yet the plan gate forced every repository to assign a
 * `package.json` scope. Under two rejections the planner abandoned the SRS
 * delivery shape and delivered headless modules plus `package.json`/`tests`
 * — the UI (`renderer`/`events`/`index.html`) was lost. The policy must be
 * derived from the accepted SRS file surface instead of being hardcoded.
 *
 * The derivation is PURE (no I/O, no clocks, no randomness) so the resulting
 * policy is deterministic and its content hash reproducible.
 *
 * Derivation rule (exact):
 *
 * 1. Collect declared file paths from the SRS file-surface sections — the
 *    union of:
 *      - §D2 AC Map YAML `files:` values (flow list `files: [a, b]`, a bare
 *        scalar, or a block list of `- path` lines);
 *      - §D1 Canonical File/Module Surface table backticked path tokens.
 *    §2.2 Module Manifest is deliberately NOT a source: its "Owned Surfaces"
 *    can be module-relative (`data/categories.js` for a module whose file is
 *    `js/data/categories.js` — real workshop evidence, project 8/units), and
 *    requiring scopes for paths that never exist would over-constrain the
 *    plan gate. Tokens are kept only when they are path-like: path characters
 *    only, and either contain `/` or end in a known file extension. Module
 *    names (`task-model`), storage keys, protocol signatures and runnable
 *    commands (`node --check src/index.js`) are therefore never mistaken for
 *    files.
 * 2. `package.json` is required ONLY when the SRS actually declares it on its
 *    file surface (§D2/§D1) or names the literal `package.json` file in
 *    a Technology Stack (§2.5/§9) / Test Strategy (§3) section without a
 *    negation on the same line. Bare `npm`/`node` command mentions do NOT
 *    trigger it: the real single-HTML todo SRS lists `npm test` tooling while
 *    its delivery shape has no package.json.
 * 3. Every collected path is normalized to a top-level repository scope
 *    (`js/app.js` → `js/`, `index.html` → `index.html`) and validated by
 *    `parseRepositoryScope`.
 * 4. `tests/` is ALWAYS required (verification items write tests; this also
 *    preserves the passing behavior of Node-style projects whose SRS lists
 *    package.json + tests).
 * 5. The result is the sorted union of the normalized scopes, `tests/` and
 *    (when triggered) `package.json`.
 *
 * Fail-safe: when the SRS content is null/blank or carries no file
 * declarations at all, the function returns `null` and the caller falls back
 * to the historical defaults — it never throws and never rejects a plan.
 */

import { parseRepositoryScope } from '../../../shared/repository-scope.js';

/** Historical hardcoded scopes — the fail-safe fallback. */
export const DEFAULT_REQUIRED_CHANGE_SCOPES: readonly string[] = [
  'package.json',
  'tests/',
];

const FENCED_BLOCK = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi;
const BACKTICKED_TOKEN = /`([^`\n]+)`/g;
const FILE_EXTENSION
  = /\.(?:html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|markdown|ya?ml|toml|ini|cfg|conf|env|xml|svg|png|jpe?g|gif|webp|ico|txt|csv|tsv|py|rb|go|rs|java|kt|kts|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|bat|cmd|sql|graphql|proto|wasm)$/i;
const PATH_CHARACTERS = /^[A-Za-z0-9._\-/]+$/;
const D2_HEADING = /(?:§\s*D[.-]?2\b)|(?:\bAC\s*(?:Map|Mapping|Decomposition))/i;
const D1_HEADING = /(?:§\s*D[.-]?1\b)|(?:canonical\s+file)/i;
const TECH_STACK_HEADING = /(?:technology\s+stack)|(?:§\s*2\.5\b)/i;
const TEST_STRATEGY_HEADING
  = /(?:§\s*3\b[^\n]*(?:test|verif))|(?:\btest[\s\S]{0,40}(?:strategy|verification))/i;
const NEGATED_PACKAGE_JSON
  = /\b(?:no|without|zero|never|not|lacks?|excludes?|absent)\b[^.\n]{0,50}package\.json/i;

interface Section {
  readonly heading: string;
  readonly level: number;
  readonly body: string;
}

interface SectionBuffer {
  readonly heading: string;
  readonly level: number;
  readonly lines: string[];
}

/**
 * Split markdown into (heading, body) sections. Every heading starts a new
 * section whose body runs until the next heading of the same or a shallower
 * level (a `### 3.1` body therefore ends at the next `##`).
 */
function splitSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: SectionBuffer[] = [];
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        const closed = stack.pop()!;
        sections.push({
          heading: closed.heading,
          level: closed.level,
          body: closed.lines.join('\n'),
        });
      }
      stack.push({ heading: heading[2] ?? '', level, lines: [line] });
      continue;
    }
    if (stack.length === 0) {
      // Preamble before the first heading — keep it addressable so heading
      // variants that live at level 1 are not the only extraction source.
      stack.push({ heading: '', level: 1, lines: [line] });
      continue;
    }
    stack[stack.length - 1]!.lines.push(line);
  }
  while (stack.length > 0) {
    const closed = stack.pop()!;
    sections.push({
      heading: closed.heading,
      level: closed.level,
      body: closed.lines.join('\n'),
    });
  }
  return sections;
}

/**
 * Return the matched sections together with their full subsection trees: a
 * matched `## 3. Test Strategy` also yields `### 3.1`, `### 3.2`, ... until
 * the next same-or-shallower heading.
 */
function sectionSubtrees(
  sections: readonly Section[],
  headingTest: RegExp,
): Section[] {
  const collected: Section[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    if (!headingTest.test(section.heading)) continue;
    collected.push(section);
    let cursor = index + 1;
    while (
      cursor < sections.length
      && sections[cursor]!.level > section.level
    ) {
      collected.push(sections[cursor]!);
      cursor += 1;
    }
  }
  return collected;
}

function isPathLike(token: string): boolean {
  const value = token.trim();
  if (value.length === 0 || !PATH_CHARACTERS.test(value)) return false;
  return value.includes('/') || FILE_EXTENSION.test(value);
}

/** Strip quotes and trailing YAML comments from a scalar. */
function cleanScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitFlowList(raw: string): string[] {
  let value = cleanScalar(raw);
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (value.length === 0) return [];
  return value
    .split(',')
    .map(item => cleanScalar(item))
    .filter(item => item.length > 0);
}

/**
 * Collect `files:` values from YAML AC-map stanzas. Handles flow lists
 * (`files: [a, b]`), bare scalars (`files: index.html`) and block lists
 * (`files:` followed by `  - path` lines).
 */
function collectD2Files(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const files: string[] = [];
  let inFilesBlockList = false;
  for (const line of lines) {
    const filesField = line.match(/^\s{0,8}files\s*:\s*(.*)$/i);
    if (filesField) {
      const value = (filesField[1] ?? '').trim();
      if (value.length === 0) {
        inFilesBlockList = true;
        continue;
      }
      inFilesBlockList = false;
      files.push(...splitFlowList(value));
      continue;
    }
    if (inFilesBlockList) {
      const listItem = line.match(/^\s+-\s+(.+)$/);
      if (listItem) {
        files.push(...splitFlowList(listItem[1] ?? ''));
        continue;
      }
      if (line.trim().length > 0) {
        inFilesBlockList = false;
      }
    }
  }
  return files;
}

function collectBacktickedPaths(sectionBody: string): string[] {
  const paths: string[] = [];
  for (const match of sectionBody.matchAll(BACKTICKED_TOKEN)) {
    const token = match[1] ?? '';
    if (isPathLike(token)) {
      paths.push(token.trim());
    }
  }
  return paths;
}

function mentionsPackageJson(sectionBody: string): boolean {
  return sectionBody
    .split(/\r?\n/)
    .some(line =>
      line.includes('package.json') && !NEGATED_PACKAGE_JSON.test(line));
}

/**
 * Normalize one declared file path to a top-level repository scope:
 * `js/app.js` → `js/` (directory prefix), `index.html` → `index.html`
 * (exact file). Returns null for paths that are not valid repository scopes.
 */
function normalizeTopLevelScope(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length === 0) return null;
  const segments = normalized.split('/');
  const top = segments[0] ?? '';
  const scope = segments.length === 1 ? top : `${top}/`;
  try {
    parseRepositoryScope(scope);
  } catch {
    return null;
  }
  return scope;
}

/**
 * Derive the development policy `requiredChangeScopes` from an accepted SRS
 * document. Returns `null` when nothing is derivable (no readable content or
 * no file declarations) — callers must then fall back to
 * {@link DEFAULT_REQUIRED_CHANGE_SCOPES}.
 */
export function deriveRequiredChangeScopesFromSrs(
  srsContent: string | null | undefined,
): readonly string[] | null {
  if (typeof srsContent !== 'string' || srsContent.trim().length === 0) {
    return null;
  }
  const sections = splitSections(srsContent);

  const declaredPaths: string[] = [];

  // §D2 AC Map — the canonical machine-checked contract.
  const d2Sections = sectionSubtrees(sections, D2_HEADING);
  const yamlSources = (d2Sections.length > 0
    ? d2Sections.map(section => section.body)
    : [srsContent]);
  for (const source of yamlSources) {
    for (const block of source.matchAll(FENCED_BLOCK)) {
      const yaml = block[1] ?? '';
      // Only fenced blocks that actually carry AC-map stanzas contribute.
      if (/^\s*-\s+ac\s*:/im.test(yaml)) {
        declaredPaths.push(...collectD2Files(yaml));
      }
    }
  }

  // §D1 Canonical File/Module Surface table.
  for (const surfaceSection of sectionSubtrees(sections, D1_HEADING)) {
    declaredPaths.push(...collectBacktickedPaths(surfaceSection.body));
  }

  // package.json is required only when the SRS names it as an actual file.
  const packageJsonRequired
    = declaredPaths.some(path => path.trim() === 'package.json')
    || [
      ...sectionSubtrees(sections, TECH_STACK_HEADING),
      ...sectionSubtrees(sections, TEST_STRATEGY_HEADING),
    ].some(section => mentionsPackageJson(section.body));

  const scopes = new Set<string>();
  for (const declared of declaredPaths) {
    const scope = normalizeTopLevelScope(declared);
    if (scope !== null) {
      scopes.add(scope);
    }
  }
  if (scopes.size === 0) {
    return null;
  }
  // Verification items always write tests; keep the scope mandatory for every
  // delivery shape (this is what Node-style SRSs already declare).
  scopes.add('tests/');
  if (packageJsonRequired) {
    scopes.add('package.json');
  }
  return [...scopes].sort();
}
