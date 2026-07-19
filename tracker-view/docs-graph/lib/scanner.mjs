// Markdown scanner — recursively walks a repository root (or docs_root) and
// indexes every .md file. Returns the metadata needed to render docs as graph
// nodes and to merge them with saga `artifacts` rows.
//
// Design goals:
//   - Zero third-party deps (Node fs + crypto only). YAML front-matter is
//     parsed by a tiny hand-rolled reader — we only need title/status/code.
//   - Ignore noise: .git, .worktrees, node_modules, dist, build artifacts.
//   - Path-traversal safe: every emitted path stays under the scanned root.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_IGNORE = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  '.saga',
  '.idea',
  '.vscode',
  'coverage',
]);

/**
 * Parse a tiny subset of YAML front-matter from a markdown string.
 * Returns {} when no front-matter block is present.
 *
 * Recognised fields (single-line `key: value` only):
 *   title, status, artifact_code (or `code`), type, epic, drift
 *
 * Everything else is preserved under `rest` so the UI can show it.
 */
export function parseFrontMatter(markdown) {
  if (!markdown.startsWith('---')) return {};
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = markdown.slice(3, end).replace(/^\r?\n/, '');
  const fm = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

/**
 * Extract the first H1 heading as a fallback title when front-matter has none.
 */
function firstH1(markdown) {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Walk `root` recursively, returning a flat list of `.md` file descriptors.
 *
 * Each descriptor:
 *   {
 *     relPath: string,           // POSIX-style, relative to `root`
 *     absPath: string,           // absolute, guaranteed under root
 *     sha256: string,            // content digest (for drift detection)
 *     title: string | null,
 *     frontMatter: { status?, artifact_code?, type?, ... },
 *     mtime: number              // ms epoch
 *   }
 *
 * `extraIgnore` is appended to DEFAULT_IGNORE (e.g. integration_branch dir).
 */
export function scanMarkdownFiles(root, { extraIgnore = [] } = {}) {
  const ignore = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
  const out = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission / race — skip silently
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;

      let content;
      let st;
      try {
        content = readFileSync(abs, 'utf8');
        st = statSync(abs);
      } catch {
        continue;
      }
      const fm = parseFrontMatter(content);
      const relPath = toPosix(path.relative(root, abs));
      const sha = createHash('sha256').update(content).digest('hex');
      out.push({
        relPath,
        absPath: abs,
        sha256: sha,
        title: fm.title || firstH1(content) || path.basename(relPath, '.md'),
        frontMatter: fm,
        mtime: st.mtimeMs,
      });
    }
  }

  walk(path.resolve(root));
  return out;
}

/** Convert a platform path to forward slashes (stable for git relpaths). */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
