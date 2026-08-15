// tools/dep-graph-scanner.mjs - W0-A1 repository-wide dependency scanner.
//
// Plain Node ESM, no third-party deps. Scans TypeScript sources under src/
// and produces, for each source file, the list of RELATIVE import targets it
// depends on. Bare specifiers (node:fs, @modelcontextprotocol/sdk, etc.) are
// ignored.
//
// Output shape: { sourcePath: [resolvedTargetPaths...] }
//
// Resolved paths use POSIX-style forward slashes and are repo-relative
// (resolved against the supplied repository root, default: process.cwd()).
//
// A target file may have any extension or none; the scanner tries the literal
// specifier first, then .ts, .tsx, .mjs, .js, .json, and finally
// index.{ts,tsx,mjs,js} - matching Node ESM + TypeScript resolution closely
// enough for source-graph work.
//
// Used by tests/architecture/dependency-direction.test.mjs (plan section
// 0.3.2, 13.14, 14.1.3, C047). This file owns no production behavior - it is
// a test tool.
//
// NOTE: line comments only in this file. The C-style block-comment terminator
// clashes with the glob sequence that documents this scanner, so we avoid
// block comments entirely.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.cjs', '.json'];
const INDEX_NAMES = ['index'];

// Match TypeScript import / export ... from '...' statements whose specifier
// is a relative path (starts with ./ or ../). Captures the trailing specifier.
// Handles single-line AND multi-line import blocks (newline-tolerant body
// between the `import`/`export` keyword and the `from` clause). The body
// class [^;] bounds the match to one statement (TS import/export specifier
// lists never contain a literal ';'). Uses the [.][./] charclass trick: a
// dot followed by either a dot or a slash.
const RELATIVE_IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;

// Dynamic relative imports: import('...') and require('...') whose specifier
// begins with ./ or ../. Caught separately because they don't use `from`.
const RELATIVE_DYNAMIC_RE =
  /(?:^|\n)\s*(?:import|require)\(\s*['"]([.][./][^'"]+)['"]\s*\)/g;

// Is `spec` a bare specifier we must ignore? Anything that doesn't start with
// ./ or ../ or / is treated as bare (node:fs, @scope/pkg, plain pkg).
function isBareSpecifier(spec) {
  return spec[0] !== '.' && spec[0] !== '/';
}

// Walk a directory tree returning every file matching one of `extensions`.
function walk(dir, extensions, accumulator) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, extensions, accumulator);
    } else if (st.isFile() && extensions.includes(path.extname(full))) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

// Resolve a relative import specifier to an absolute file path.
// Returns null when no candidate file exists on disk.
//
// Mirrors TypeScript module resolution closely enough for source-graph work:
// tries the literal path first, then path + each extension, then path + each
// extension under INDEX_NAMES when the spec points at a directory.
export function resolveImport(fromFile, spec, rootDir) {
  if (isBareSpecifier(spec)) return null;
  const baseDir = path.dirname(fromFile);
  const absolute = path.resolve(baseDir, spec);

  // 1. Literal path may already be a file.
  try {
    if (statSync(absolute).isFile()) return toPosixPath(absolute, rootDir);
  } catch {
    // not a file, fall through
  }

  // 2. Try each extension appended to the literal spec.
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = absolute + ext;
    try {
      if (statSync(candidate).isFile()) return toPosixPath(candidate, rootDir);
    } catch {
      // try next
    }
  }

  // 2b. TypeScript ESM allows importing './foo.js' to resolve to foo.ts.
  // When the spec itself ends in a JS extension that has no file on disk,
  // swap it for each TypeScript / source extension before giving up.
  const specExt = path.extname(absolute);
  const JS_RUNTIMES = new Set(['.js', '.jsx', '.mjs', '.cjs']);
  if (JS_RUNTIMES.has(specExt)) {
    const stem = absolute.slice(0, absolute.length - specExt.length);
    for (const ext of RESOLVE_EXTENSIONS) {
      if (ext === specExt) continue;
      const candidate = stem + ext;
      try {
        if (statSync(candidate).isFile()) return toPosixPath(candidate, rootDir);
      } catch {
        // try next
      }
    }
  }

  // 3. Treat the literal spec as a directory and look for index.* .
  let isDir = false;
  try {
    isDir = statSync(absolute).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    for (const idx of INDEX_NAMES) {
      for (const ext of RESOLVE_EXTENSIONS) {
        const candidate = path.join(absolute, idx + ext);
        try {
          if (statSync(candidate).isFile()) return toPosixPath(candidate, rootDir);
        } catch {
          // try next
        }
      }
    }
  }

  return null;
}

function toPosixPath(p, rootDir) {
  const rel = path.relative(rootDir, p);
  const posix = rel.split(path.sep).join('/');
  // Normalise to repo-relative forward-slash path so comparisons are
  // OS-independent. Absolute outside-root paths fall back to basename.
  return posix.startsWith('..') ? path.basename(p) : posix;
}

// Extract every relative import specifier from a TypeScript source string.
// Returns a de-duplicated, insertion-ordered array of spec strings.
export function extractRelativeSpecifiers(source) {
  const out = [];
  const seen = new Set();
  const push = (m) => {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  };
  let match;
  RELATIVE_IMPORT_RE.lastIndex = 0;
  while ((match = RELATIVE_IMPORT_RE.exec(source)) !== null) {
    push(match[1]);
  }
  RELATIVE_DYNAMIC_RE.lastIndex = 0;
  while ((match = RELATIVE_DYNAMIC_RE.exec(source)) !== null) {
    push(match[1]);
  }
  return out;
}

// Scan TypeScript sources under the given globs (default: src/) inside
// rootDir and return the dependency map { sourcePath: [targets...] }.
//
// rootDir defaults to the repository root (parent of this file's tools/ dir).
// globs defaults to ['src']. Each entry is a directory path the scanner walks.
// Unresolved specifiers (no file on disk) are dropped silently - they are not
// architectural edges for this scanner's purpose.
export function scanDependencyGraph({
  rootDir,
  globs = ['src'],
  extensions = TS_EXTENSIONS,
} = {}) {
  const root = rootDir || path.resolve(__dirname, '..');
  const files = [];
  for (const g of globs) {
    const abs = path.isAbsolute(g) ? g : path.join(root, g);
    walk(abs, extensions, files);
  }
  files.sort();

  const graph = {};
  for (const file of files) {
    const sourcePath = toPosixPath(file, root);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const specs = extractRelativeSpecifiers(source);
    const resolved = [];
    const seen = new Set();
    for (const spec of specs) {
      const resolvedPath = resolveImport(file, spec, root);
      if (resolvedPath && !seen.has(resolvedPath)) {
        seen.add(resolvedPath);
        resolved.push(resolvedPath);
      }
    }
    graph[sourcePath] = resolved;
  }
  return graph;
}

export const __internal = {
  RELATIVE_IMPORT_RE,
  RELATIVE_DYNAMIC_RE,
  TS_EXTENSIONS,
  walk,
  isBareSpecifier,
  toPosixPath,
};

// Allow `node tools/dep-graph-scanner.mjs [root]` for ad-hoc inspection.
if (process.argv[1] === __filename) {
  const root = process.argv[2] || path.resolve(__dirname, '..');
  const graph = scanDependencyGraph({ rootDir: root });
  process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
}
