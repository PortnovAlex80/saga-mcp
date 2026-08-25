#!/usr/bin/env node
/**
 * census-nonsql-builder.mjs — assemble
 * docs/refactoring/event-kernel/authority-census-nonsql.json
 * (WP-01b / EK-1 stop-gate) from scripted non-SQL surface sweeps plus
 * hand-authored classification overlays.
 *
 * Operator review item 7 on the WP-01 census: "census is complete only for
 * found SQL constructs; filesystem, processes, environment, in-memory state,
 * singletons/caches stayed qualitative — 'zero unclassified authority access'
 * is stronger than the proof". This builder upgrades those five classes from
 * qualitative notes to machine-enumerated, machine-classified rows with the
 * same closed-vocabulary discipline as the SQL census:
 *
 *   (a) filesystem writes by production code (repo/worktree/desk writes,
 *       artifact files, package-store writes, log/journal/evidence files);
 *   (b) process authority (engine/worker spawning, supervisor/watchdog
 *       control, detached engines, pid/birth-token binding, kills);
 *   (c) environment variables (every env read in production scopes in three
 *       forms plus child-env writes; decision-altering vs operational);
 *   (d) in-memory state / process-global singletons (the effect registry,
 *       composition-root handles, module-level caches, lazy handles);
 *   (e) network/IPC boundaries (tracker HTTP write gateways, HTTP probes,
 *       engine/child pipes, hook stdin/stdout).
 *
 * Discipline:
 *   - every raw sweep hit MUST match exactly one classification rule
 *     (closed vocabulary; unmatched => UNCLASSIFIED => exit 1);
 *   - every emitted row draws its enum fields from the fixed vocabulary
 *     recorded in the JSON `enums`;
 *   - call sites are attributed through each file's real import bindings
 *     (a local helper named `truncate` is never an fs write; `db.exec` is
 *     never a process spawn);
 *   - deterministic: same tree + same overlays => byte-identical JSON.
 *
 * Usage:
 *   node docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs
 *   node docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs --dump-sweeps   # raw hits
 */

import fs from 'node:fs';
import path from 'node:path';
import { RULES, ENV_ROWS, NAMED_SINGLETONS, EXCLUSIONS } from './census-nonsql-overlays.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'authority-census-nonsql.json');
const BASE_SHA = '65e11f1478c3caede383408d5562dc808808645d';

const DUMP = process.argv.includes('--dump-sweeps');

// ---------------------------------------------------------------------------
// Closed vocabularies (the census JSON validates against exactly these).
// ---------------------------------------------------------------------------
const ENUMS = {
  surface: ['filesystem-write', 'process-control', 'env-var', 'in-memory-singleton', 'network-ipc'],
  classification: ['AUTHORITATIVE-WRITE', 'DECISION-INPUT', 'DIAGNOSTIC'],
  disposition: ['retain-and-move', 'rewrite', 'delete'],
  envRole: ['decision-altering', 'operational', 'exported-to-child'],
  scope: ['src', 'tracker-view', 'scripts'],
};

// ---------------------------------------------------------------------------
// Code-line extraction: comments stripped (bytes dropped, newlines counted),
// string literals KEPT (flags like 'wx' and route paths must stay visible),
// line numbers preserved. Char-walk sibling of the SQL scanner lexer.
// ---------------------------------------------------------------------------
export function codeLinesOf(src) {
  const out = [];
  let buf = '';
  let line = 1;
  let i = 0;
  const n = src.length;
  const flush = () => { if (buf.trim()) out.push({ line, code: buf }); buf = ''; };
  const newline = () => { flush(); line += 1; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') newline(); i += 1; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      buf += c; i += 1;
      while (i < n) {
        if (src[i] === '\\') { buf += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '\n' && quote !== '`') { newline(); i += 1; continue; }
        buf += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '\n') { newline(); i += 1; continue; }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// File walking over the production operator scopes (same scopes as the SQL
// census: src/**, tracker-view/**, scripts/**).
// ---------------------------------------------------------------------------
function collectFiles() {
  const files = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', '.factory-testbed', '.factory']);
  const visit = (abs, rel) => {
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(abs))) return;
      for (const name of fs.readdirSync(abs).sort()) visit(path.join(abs, name), path.join(rel, name));
      return;
    }
    if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(abs) && !/\.d\.ts$/.test(abs)) files.push(rel.replace(/\\/g, '/'));
  };
  visit(path.join(ROOT, 'src'), 'src');
  visit(path.join(ROOT, 'tracker-view'), 'tracker-view');
  visit(path.join(ROOT, 'scripts'), 'scripts');
  return files;
}

function scopeOf(rel) {
  if (rel.startsWith('src/')) return 'src';
  if (rel.startsWith('tracker-view/')) return 'tracker-view';
  if (rel.startsWith('scripts/')) return 'scripts';
  return 'other';
}

// ---------------------------------------------------------------------------
// Import-binding attribution.
// ---------------------------------------------------------------------------
export function importBindingsOf(src, moduleRe) {
  const named = new Set();
  const namespaces = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!moduleRe.test(m[2])) continue;
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.match(/^(\w+)\s+as\s+(\w+)$/);
      if (as) {
        // `promises as fs` binds a namespace-ish handle; type-only imports are not runtime bindings
        if (seg.startsWith('type ')) continue;
        namespaces.add(as[2]);
      } else if (/^type\s/.test(seg)) {
        continue;
      } else {
        named.add(seg);
      }
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*,?\s*(?:\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g)) {
    if (moduleRe.test(m[2])) namespaces.add(m[1]);
  }
  for (const m of src.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (moduleRe.test(m[2])) namespaces.add(m[1]);
  }
  return { named, namespaces };
}

// ---------------------------------------------------------------------------
// Sweep (a): filesystem writes.
// Only calls attributed through node:fs / node:fs/promises import bindings
// (bare name in named imports, or namespaced via an fs namespace binding).
// openSync counts only with a write-ish flag literal on the same line.
// ---------------------------------------------------------------------------
const FS_APIS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync',
  'unlinkSync', 'renameSync', 'cpSync', 'copyFileSync', 'truncateSync',
  'utimesSync', 'createWriteStream',
  'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'cp',
  'copyFile', 'truncate', 'utimes', 'mkdtemp', 'openSync',
];
const WRITE_FLAG_RE = /['"](wx?|ax?|r\+|w\+|a\+?)['"]/;

function sweepFsWrites(file, src, lines) {
  const { named, namespaces } = importBindingsOf(src, /^node:fs(\/promises)?$/);
  const nsList = [...namespaces];
  const hits = [];
  for (const { line, code } of lines) {
    for (const api of FS_APIS) {
      if (api === 'openSync') continue; // flag-gated below
      let hit = false;
      if (named.has(api) && new RegExp(`(^|[^\\w$.])${api}\\s*\\(`).test(code)) hit = true;
      for (const ns of nsList) {
        if (new RegExp(`\\b${ns}\\.${api}\\s*\\(`).test(code)) hit = true;
      }
      if (hit) hits.push({ file, line, api, surface: 'filesystem-write' });
    }
    let openHit = false;
    if (named.has('openSync') && /(^|[^\w$.])openSync\s*\(/.test(code) && WRITE_FLAG_RE.test(code)) openHit = true;
    for (const ns of nsList) {
      if (new RegExp(`\\b${ns}\\.open\\s*\\(`).test(code) && WRITE_FLAG_RE.test(code)) openHit = true;
    }
    if (openHit) hits.push({ file, line, api: 'openSync(write-flag)', surface: 'filesystem-write' });
  }
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.file}:${h.line}:${h.api}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------------------
// Sweep (b): process authority.
// child_process call sites attributed through the file's import bindings
// (db.exec / re.exec never match). Kill surfaces are the OS primitives
// (process.kill, taskkill, SIGKILL) plus detach markers (detached: true,
// child.unref()).
// ---------------------------------------------------------------------------
function sweepProcessControl(file, src, lines) {
  const { named, namespaces } = importBindingsOf(src, /^node:child_process$/);
  const apis = new Set([...named, ...namespaces]);
  const hits = [];
  for (const { line, code } of lines) {
    for (const api of apis) {
      if (new RegExp(`(^|[^\\w$.])${api}\\s*\\(`).test(code)) {
        hits.push({ file, line, api: `child_process:${api}`, surface: 'process-control' });
      }
      for (const ns of namespaces) {
        if (new RegExp(`\\b${ns}\\.${api}\\s*\\(`).test(code)) {
          hits.push({ file, line, api: `child_process:${api}`, surface: 'process-control' });
        }
      }
    }
    // inline require('node:child_process').api(...) — attribute directly
    for (const m of code.matchAll(/require\(['"]node:child_process['"]\)\.(\w+)\s*\(/g)) {
      hits.push({ file, line, api: `child_process:${m[1]}`, surface: 'process-control' });
    }
    if (/process\.kill\s*\(/.test(code)) hits.push({ file, line, api: 'process.kill', surface: 'process-control' });
    if (/['"]taskkill['"]/.test(code)) hits.push({ file, line, api: 'taskkill', surface: 'process-control' });
    if (/'SIGKILL'/.test(code)) hits.push({ file, line, api: 'SIGKILL', surface: 'process-control' });
    if (/detached:\s*true/.test(code)) hits.push({ file, line, api: 'detached:true', surface: 'process-control' });
    if (/\.unref\(\)/.test(code)) hits.push({ file, line, api: 'child.unref', surface: 'process-control' });
  }
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.file}:${h.line}:${h.api}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------------------
// Sweep (c): environment variables.
// Read forms: process.env.NAME; process.env[CONST] (name resolved through a
// same-file const->literal map); parameterized env.NAME (loaders that receive
// process.env); helper-mediated reads (a local function whose body indexes
// process.env[param], called with a string literal). Writes: assignments into
// a child environment object. Dynamic reads whose name cannot be resolved
// statically are recorded in a closed, separately classified list.
// ---------------------------------------------------------------------------
function envConstMap(lines) {
  const map = new Map();
  for (const { code } of lines) {
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

function envHelperLiterals(src, lines) {
  // function fname(p, ...) { ... process.env[p] ... } -> call sites fname('LIT')
  const helpers = new Map(); // fnName -> paramName
  const raw = src;
  for (const m of raw.matchAll(/function\s+(\w+)\s*\(\s*(\w+)\s*[,)]/g)) {
    const [all, fn, param] = m;
    const body = raw.slice(m.index, m.index + 400);
    if (new RegExp(`process\\.env\\[${param}\\]`).test(body)) helpers.set(fn, param);
  }
  const helperParams = new Set(helpers.values());
  const found = [];
  if (!helpers.size) return { found, helperParams };
  for (const { line, code } of lines) {
    for (const fn of helpers.keys()) {
      for (const m of code.matchAll(new RegExp(`\\b${fn}\\(\\s*'([A-Za-z_][A-Za-z0-9_]*)'`, 'g'))) {
        found.push({ name: m[1], line, via: fn });
      }
    }
  }
  return { found, helperParams };
}

function sweepEnvVars(file, src, lines) {
  const sites = [];
  const consts = envConstMap(lines);
  const unresolvedDynamic = [];
  const { found: helperSites, helperParams } = envHelperLiterals(src, lines);
  for (const { line, code } of lines) {
    for (const m of code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      sites.push({ name: m[1], kind: 'read-direct', line });
    }
    for (const m of code.matchAll(/process\.env\[([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
      const key = m[1];
      if (/^[A-Z][A-Z0-9_]*$/.test(key) && consts.has(key)) {
        sites.push({ name: consts.get(key), kind: 'read-dynamic', line });
      } else if (/^['"]/.test(key)) {
        sites.push({ name: key.replace(/['"]/g, ''), kind: 'read-dynamic', line });
      } else if (!helperParams.has(key)) {
        unresolvedDynamic.push({ file, line, variable: key });
      }
    }
    for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      sites.push({ name: m[1], kind: 'read-indirect', line });
    }
    for (const m of code.matchAll(/\b(\w*[Ee]nv\w*)\.([A-Z][A-Z0-9_]{2,})\s*=[^=]/g)) {
      if (m[1] === 'env') continue;
      sites.push({ name: m[2], kind: 'write-child-env', line });
    }
  }
  for (const h of helperSites) {
    sites.push({ name: h.name, kind: 'read-dynamic', line: h.line });
  }
  return { sites, unresolvedDynamic };
}

// ---------------------------------------------------------------------------
// Sweep (d): in-memory singletons / module-global mutable state.
// Column-0 declarations only (module level): mutable `let` handles, mutable
// containers (new Map()/new Set()), class-instance singletons, globalThis
// writes. Frozen constant-vocabulary containers (new Set/Map([literals])) are
// aggregated per file as non-state. scripts/** are one-shot CLI processes —
// their module state lives for a single run and is excluded by rule.
// ---------------------------------------------------------------------------
function sweepSingletons(file, lines) {
  const rows = [];
  const constVocabSites = [];
  // generic parameters (new Map<string, X>()) sit between ctor name and ()
  const GENERIC = '(?:<[^=(]{0,120}>)?';
  for (const { line, code } of lines) {
    if (/^let\s+[A-Za-z_]/.test(code)) {
      rows.push({ file, line, name: code.match(/^let\s+([A-Za-z_][\w]*)/)[1], shape: 'mutable-let' });
    } else if (new RegExp(`^const\\s+[A-Za-z_][\\w]*\\s*(?::[^=]+)?=\\s*new\\s+(Map|Set)${GENERIC}\\(\\s*\\)`).test(code)) {
      rows.push({ file, line, name: code.match(/^const\s+([A-Za-z_][\w]*)/)[1], shape: 'mutable-container' });
    } else if (new RegExp(`^const\\s+[A-Za-z_][\\w]*\\s*(?::[^=]+)?=\\s*new\\s+(Map|Set)${GENERIC}\\(\\s*\\[`).test(code)) {
      constVocabSites.push({ file, line, name: code.match(/^const\s+([A-Za-z_][\w]*)/)[1] });
    } else if (new RegExp(`^const\\s+[a-z_][\\w]*\\s*(?::[^=]+)?=\\s*new\\s+[A-Z]\\w*${GENERIC}\\(`).test(code)) {
      rows.push({ file, line, name: code.match(/^const\s+([A-Za-z_][\w]*)/)[1], shape: 'instance-singleton' });
    }
    if (/globalThis\.[A-Za-z_][\w]*\s*=[^=]/.test(code)) {
      rows.push({ file, line, name: code.match(/globalThis\.([A-Za-z_][\w]*)\s*=/)[1], shape: 'globalThis-write' });
    }
  }
  return { rows, constVocabSites };
}

// ---------------------------------------------------------------------------
// Sweep (e): network/IPC boundaries.
// HTTP servers + enumerated router literals, HTTP clients, spawn pipe options
// (stdio literals in child_process-importing files), process stdin/stdout,
// MCP stdio server declarations.
// ---------------------------------------------------------------------------
function sweepNetworkIpc(file, src, lines) {
  const hits = [];
  const hasCp = importBindingsOf(src, /^node:child_process$/).namespaces.size + importBindingsOf(src, /^node:child_process$/).named.size > 0;
  for (const { line, code } of lines) {
    if (/\bcreateServer\s*\(/.test(code)) hits.push({ file, line, api: 'http.createServer', surface: 'network-ipc' });
    if (/\.(?:server)?\.?listen\s*\(/.test(code) && /\.listen\s*\(/.test(code)) hits.push({ file, line, api: 'server.listen', surface: 'network-ipc' });
    if (/\bawait\s+fetch\s*\(/.test(code) || /(?:const|let)\s+\w+\s*=\s*fetch\s*\(/.test(code)) {
      hits.push({ file, line, api: 'fetch', surface: 'network-ipc' });
    }
    const m1 = code.match(/req\.method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'\s*&&\s*url\.pathname\s*===\s*'([^']+)'/);
    if (m1) hits.push({ file, line, api: `route:${m1[1]} ${m1[2]}`, surface: 'network-ipc' });
    const m2 = code.match(/(?:url\.)?pathname\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'/);
    if (m2) hits.push({ file, line, api: `route:${m2[2]} ${m2[1]}`, surface: 'network-ipc' });
    const m3 = code.match(/req\.method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'\s*&&\s*url\.pathname\.startsWith\('([^']+)'/);
    if (m3) hits.push({ file, line, api: `route-prefix:${m3[1]} ${m3[2]}`, surface: 'network-ipc' });
    const m4 = code.match(/(?:url\.)?pathname\.startsWith\('([^']+)'\)\s*&&\s*req\.method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'/);
    if (m4) hits.push({ file, line, api: `route-prefix:${m4[2]} ${m4[1]}`, surface: 'network-ipc' });
    // method-unspecified router literals (branches inside a method guard)
    if (!m1 && !m2 && !m3 && !m4) {
      const m5 = code.match(/(?:url\.)?pathname\s*===\s*'((?:\/api|\/admin)[^']*)'/);
      if (m5) hits.push({ file, line, api: `route:ANY ${m5[1]}`, surface: 'network-ipc' });
      const m6 = code.match(/(?:url\.)?pathname\.startsWith\('((?:\/api|\/lifecycle-pipeline)[^']*)'/);
      if (m6) hits.push({ file, line, api: `route-prefix:ANY ${m6[1]}`, surface: 'network-ipc' });
    }
    if ((hasCp || /stdio\s*:/.test(code)) && /stdio\s*:/.test(code) && /['"]pipe['"]/.test(code)) {
      hits.push({ file, line, api: 'stdio:pipe', surface: 'network-ipc' });
    }
    if (/\bprocess\.stdin\b/.test(code)) hits.push({ file, line, api: 'process.stdin', surface: 'network-ipc' });
    if (/\bprocess\.stdout\.(write|end)\s*\(/.test(code)) hits.push({ file, line, api: 'process.stdout.write', surface: 'network-ipc' });
    if (/type:\s*'stdio'/.test(code)) hits.push({ file, line, api: 'mcp-server:stdio', surface: 'network-ipc' });
  }
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.file}:${h.line}:${h.api}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------------------
// Rule engine: every sweep hit must match at least one overlay rule; the
// FIRST matching rule wins (RULES are ordered most-specific first — exact
// file lists before directory catch-alls; api-constrained before file-wide).
// A rule: { id, surface, match: {files?: [regex], apis?: [prefix-or-exact]},
//           currentOwner, feeds, classification, disposition, ekTarget,
//           exclusion?, note? }.
// ---------------------------------------------------------------------------
function matchRule(hit) {
  for (const rule of RULES) {
    if (rule.surface !== hit.surface) continue;
    if (rule.match.files && !rule.match.files.some((re) => re.test(hit.file))) continue;
    if (rule.match.apis && !rule.match.apis.some((a) => (a.endsWith('*') ? hit.api.startsWith(a.slice(0, -1)) : hit.api === a))) continue;
    return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main sweep pass.
// ---------------------------------------------------------------------------
const files = collectFiles();
const fileLines = new Map();
const fileSrc = new Map();
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  fileSrc.set(rel, src);
  fileLines.set(rel, codeLinesOf(src));
}

const fsHits = [];
const procHits = [];
const envSiteRows = new Map(); // name -> {kinds:Set, sites:[]}
const unresolvedDynamicEnv = [];
const singletonRows = [];
const constVocab = [];
const netHits = [];

for (const rel of files) {
  const lines = fileLines.get(rel);
  const src = fileSrc.get(rel);
  fsHits.push(...sweepFsWrites(rel, src, lines));
  procHits.push(...sweepProcessControl(rel, src, lines));
  const { sites, unresolvedDynamic } = sweepEnvVars(rel, src, lines);
  for (const s of sites) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(s.name)) continue; // lowercase props are not env names
    if (!envSiteRows.has(s.name)) envSiteRows.set(s.name, { name: s.name, kinds: new Set(), sites: [] });
    const e = envSiteRows.get(s.name);
    e.kinds.add(s.kind);
    e.sites.push({ file: rel, line: s.line, kind: s.kind });
  }
  unresolvedDynamicEnv.push(...unresolvedDynamic);
  if (scopeOf(rel) !== 'scripts') {
    const { rows, constVocabSites } = sweepSingletons(rel, lines);
    singletonRows.push(...rows);
    constVocab.push(...constVocabSites);
  }
  netHits.push(...sweepNetworkIpc(rel, src, lines));
}

// --- classify everything -----------------------------------------------------
const unclassified = [];
const rows = [];

function rowFor(hit, rule) {
  return {
    id: rule.id,
    surface: hit.surface,
    file: hit.file,
    line: hit.line,
    api: hit.api,
    scope: scopeOf(hit.file),
    currentOwner: rule.currentOwner,
    feeds: rule.feeds,
    classification: rule.classification,
    disposition: rule.disposition,
    ekTarget: rule.ekTarget,
    ...(rule.exclusion ? { exclusion: rule.exclusion } : {}),
    ...(rule.note ? { note: rule.note } : {}),
  };
}

for (const hit of [...fsHits, ...procHits, ...netHits]) {
  const rule = matchRule(hit);
  if (!rule) { unclassified.push({ ...hit, reason: 'no rule' }); continue; }
  rows.push(rowFor(hit, rule));
}

// env rows: one row per NAME (aggregated sites), classified by ENV_ROWS overlay
const envOut = [];
for (const [name, e] of [...envSiteRows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const decl = ENV_ROWS[name];
  if (!decl) { unclassified.push({ surface: 'env-var', api: name, file: '(all scopes)', line: 0, reason: 'no ENV_ROWS entry' }); continue; }
  envOut.push({
    id: `env:${name}`,
    surface: 'env-var',
    name,
    envRole: decl.envRole,
    sites: e.sites
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
      .map((s) => ({ file: s.file, line: s.line, kind: s.kind })),
    readForms: [...e.kinds].sort(),
    currentOwner: decl.currentOwner,
    feeds: decl.feeds,
    classification: decl.classification,
    disposition: decl.disposition,
    ekTarget: decl.ekTarget,
    ...(decl.note ? { note: decl.note } : {}),
  });
}

// singleton rows: named-singleton overlay first, then file-shaped rules
const singletonOut = [];
const consumedNamedIds = new Set();
for (const hit of singletonRows) {
  const named = NAMED_SINGLETONS.find((n) => n.file === hit.file && n.name === hit.name);
  if (named) consumedNamedIds.add(named.id);
  const rule = RULES.find((r) => r.surface === 'in-memory-singleton' && r.match.files?.some((re) => re.test(hit.file)));
  const source = named ?? rule;
  if (!source) { unclassified.push({ surface: 'in-memory-singleton', api: `${hit.shape} ${hit.name}`, file: hit.file, line: hit.line, reason: 'no singleton rule' }); continue; }
  singletonOut.push({
    id: named ? named.id : rule.id,
    surface: 'in-memory-singleton',
    file: hit.file,
    line: hit.line,
    name: hit.name,
    shape: hit.shape,
    scope: scopeOf(hit.file),
    origin: 'swept',
    currentOwner: named ? named.currentOwner : rule.currentOwner,
    feeds: named ? named.feeds : rule.feeds,
    classification: named ? named.classification : rule.classification,
    disposition: named ? named.disposition : rule.disposition,
    ekTarget: named ? named.ekTarget : rule.ekTarget,
    ...((named ? named.note : rule.note) ? { note: named ? named.note : rule.note } : {}),
    ...((named ? named.exclusion : rule.exclusion) ? { exclusion: named ? named.exclusion : rule.exclusion } : {}),
  });
}
// declared singletons: closure-scoped or instance-field persistent state the
// column-0 module-level sweep cannot see, enumerated by overlay declaration
// (origin: 'declared') so the class boundary is closed and reviewable.
for (const named of NAMED_SINGLETONS) {
  if (consumedNamedIds.has(named.id)) continue;
  singletonOut.push({
    id: named.id,
    surface: 'in-memory-singleton',
    file: named.file,
    line: named.line ?? 0,
    name: named.name,
    shape: named.shape ?? 'closure-or-instance-field',
    scope: scopeOf(named.file),
    origin: 'declared',
    currentOwner: named.currentOwner,
    feeds: named.feeds,
    classification: named.classification,
    disposition: named.disposition,
    ekTarget: named.ekTarget,
    ...(named.note ? { note: named.note } : {}),
  });
}

// aggregate constant-vocabulary containers per file (non-state, documented)
const constVocabByFile = new Map();
for (const s of constVocab) {
  if (!constVocabByFile.has(s.file)) constVocabByFile.set(s.file, []);
  constVocabByFile.get(s.file).push(s);
}

if (DUMP) {
  const dump = (label, arr) => {
    console.error(`--- ${label} (${arr.length}) ---`);
    for (const h of arr) console.error(`${h.file}:${h.line} ${h.api ?? h.shape ?? ''} ${h.name ?? ''}`);
  };
  dump('filesystem-write', fsHits);
  dump('process-control', procHits);
  dump('network-ipc', netHits);
  dump('singletons', singletonRows);
  dump('const-vocab-aggregate', constVocab);
  console.error(`--- env names (${envSiteRows.size}) ---`);
  for (const [name, e] of [...envSiteRows.entries()].sort()) console.error(`${name} [${[...e.kinds].join(',')}] x${e.sites.length}`);
  console.error(`--- unresolved dynamic env (${unresolvedDynamicEnv.length}) ---`);
  for (const u of unresolvedDynamicEnv) console.error(`${u.file}:${u.line} ${u.variable}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-validation: closed vocabulary + zero unclassified.
// ---------------------------------------------------------------------------
const errors = [];
const inEnum = (v, list, what) => { if (!list.includes(v)) errors.push(`${what}: '${v}' not in closed vocabulary`); };

for (const r of rows) {
  inEnum(r.classification, ENUMS.classification, `${r.surface} ${r.file}:${r.line}`);
  inEnum(r.disposition, ENUMS.disposition, `${r.surface} ${r.file}:${r.line}`);
  inEnum(r.scope, ENUMS.scope, `${r.surface} ${r.file}:${r.line}`);
}
for (const r of envOut) {
  inEnum(r.envRole, ENUMS.envRole, `env ${r.name}`);
  inEnum(r.classification, ENUMS.classification, `env ${r.name}`);
  inEnum(r.disposition, ENUMS.disposition, `env ${r.name}`);
}
for (const r of singletonOut) {
  inEnum(r.classification, ENUMS.classification, `singleton ${r.file}:${r.line}`);
  inEnum(r.disposition, ENUMS.disposition, `singleton ${r.file}:${r.line}`);
  inEnum(r.scope, ENUMS.scope, `singleton ${r.file}:${r.line}`);
}
if (unclassified.length) {
  errors.push(`UNCLASSIFIED non-SQL sites: ${unclassified.length}`);
  for (const u of unclassified.slice(0, 120)) errors.push(`  ${u.surface} ${u.api} @ ${u.file}:${u.line} (${u.reason})`);
}

// counts + assembly
const bySurface = {};
for (const r of [...rows, ...envOut, ...singletonOut]) bySurface[r.surface] = (bySurface[r.surface] ?? 0) + 1;

const census = {
  $schema: 'ek1/authority-census-nonsql/1',
  metadata: {
    workPackage: 'WP-01b (EK-1 stop-gate) — non-SQL authority surface census',
    baseSha: BASE_SHA,
    generatedBy: 'docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs + census-nonsql-overlays.mjs',
    method: 'comment-aware code-line extraction (char walk, string literals preserved, comments dropped) over src/**, tracker-view/**, scripts/**; five scripted sweeps (filesystem writes via node:fs import-binding attribution, child_process via import-binding attribution plus OS kill primitives, env reads in three forms plus helper-mediated reads and child-env writes, column-0 module-level mutable state, HTTP routers/clients/pipes/stdin); every hit classified by closed overlay rules; an unmatched hit fails the build',
    scopes: ['src/**/*.{ts,mts}', 'tracker-view/**/*.{mjs,js}', 'scripts/**/*.mjs'],
    filesScanned: files.length,
    relationshipToSqlCensus: 'addendum to authority-census.json (same base discipline): the SQL census enumerates every table read/write; this census enumerates the five non-SQL authority surface classes the SQL scanner cannot see',
  },
  enums: ENUMS,
  classificationSemantics: {
    classification: {
      'AUTHORITATIVE-WRITE': 'the surface performs or durably records a mutation of production authority (repo/worktree bytes, package store, engine/worker processes, settings, child env that decides child behavior)',
      'DECISION-INPUT': 'the surface content or state feeds a production decision (spawn binary selection, route/prompt budgets, liveness verdicts, lock admission, in-process resolution handles)',
      DIAGNOSTIC: 'presentation, telemetry or observation only; may explain authority, may never authorize',
    },
    disposition: {
      'retain-and-move': 'surface and its owning module survive into the new kernel package and protocol',
      'rewrite': 'surface re-expressed per the EK target mapping recorded per row',
      'delete': 'surface removed with the legacy composition at EK-8',
    },
    envRole: {
      'decision-altering': 'the value changes a production decision (executor, route, budget, identity, mode, keys)',
      operational: 'ports, host paths, log locations, tool discovery — no authority decision depends on the value',
      'exported-to-child': 'name is written into a spawned child environment; the child-side reader decides',
    },
  },
  counts: {
    filesystemWriteRows: rows.filter((r) => r.surface === 'filesystem-write').length,
    processControlRows: rows.filter((r) => r.surface === 'process-control').length,
    envVarRows: envOut.length,
    inMemorySingletonRows: singletonOut.length,
    networkIpcRows: rows.filter((r) => r.surface === 'network-ipc').length,
    rawSweepHits: { 'filesystem-write': fsHits.length, 'process-control': procHits.length, 'network-ipc': netHits.length },
    constVocabularyAggregateFiles: constVocabByFile.size,
    constVocabularyContainers: constVocab.length,
    unresolvedDynamicEnvReads: unresolvedDynamicEnv.length,
    unclassified: unclassified.length,
  },
  surfaces: {
    'filesystem-write': rows.filter((r) => r.surface === 'filesystem-write').sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
    'process-control': rows.filter((r) => r.surface === 'process-control').sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
    'env-var': envOut,
    'in-memory-singleton': singletonOut.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
    'network-ipc': rows.filter((r) => r.surface === 'network-ipc').sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
  },
  constVocabularyAggregate: [...constVocabByFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, sites]) => ({
    file,
    containers: sites.map((s) => `${s.line}:${s.name}`).sort(),
    note: 'module-level const Set/Map initialized from literals only — frozen vocabulary table, not mutable state; retained as constants, excluded from the singleton authority surface',
  })),
  unresolvedDynamicEnvReads: unresolvedDynamicEnv.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)).map((u) => ({
    file: u.file,
    line: u.line,
    variable: u.variable,
    note: 'process.env[variable] read whose name is not statically resolvable (CLI-supplied env indirection); classified as operator tooling input, not a machine-enumerable env authority row',
  })),
  exclusions: EXCLUSIONS,
  unclassified: unclassified,
};

if (errors.length) {
  console.error('FAIL:');
  for (const e of errors.slice(0, 140)) console.error('  - ' + e);
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(census, null, 1));
console.error(`non-SQL census written: ${OUT}`);
console.error(`counts: ${JSON.stringify(census.counts)}`);
