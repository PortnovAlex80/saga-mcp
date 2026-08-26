#!/usr/bin/env node
// WP-13C / EK-9 — legacy-zero laws (the `npm run test:legacy-zero` successor
// the plan names for the post-cutover tree; package.json is coordinator-owned,
// so the canonical invocation is THIS tool, directly:
//
//   node tools/ek-legacy-zero.mjs --check    # pre-cutover: report counts, exit 0
//   node tools/ek-legacy-zero.mjs --strict   # post-cutover: any legacy ref -> exit 1
//   node tools/ek-legacy-zero.mjs --json     # machine surface for the guard suite
//
// The EK-1 stop-gate (docs/refactoring/event-kernel/tools/
// validate-deletion-manifests.mjs) proves the manifests cannot rot BEFORE the
// deletions (every classified path EXISTS). This tool proves the inverse AFTER
// them. Between the two eras it runs in --check: it honestly reports the
// pre-cutover state (how many legacy references remain) and exits 0, so CI can
// host it BLOCKING today without faking a green cutover. WP-12 (the hard
// cutover) flips the CI invocation to --strict; from that moment any survivor
// is a red build.
//
// THE FIVE LEGACY-ZERO LAWS (plan EK-8 "test:legacy-zero" checklist):
//
//   L1 deletion-manifest entries absent
//      every file the LEGACY-DELETION-MANIFEST classifies DELETE (minus the
//      §G RETAIN-AND-MOVE contracts and the explicit KEEP rows) is GONE from
//      the tracked tree.
//   L2 production imports resolve only to the new runtime
//      every surviving production file (src/** minus the DELETE set, plus the
//      KEEP tools of §D) has (a) no broken relative import and (b) no import
//      into a DELETE-classified file. Informational: the total number of
//      src imports still pointing into the DELETE set (the pre-cutover
//      headline — zero only after the cutover).
//   L3 forbidden old table/column names absent from production SQL
//      none of the §A table names (incl. the lazy §A.5 tables and the §A.6
//      rebuild tables) appears in a SQL statement of a surviving file.
//   L4 no migration / adoption / compatibility fallback
//      no surviving file contains ALTER TABLE, a CREATE TABLE IF NOT EXISTS
//      (the ADR-095 F2 lazy-regrowth pattern), the legacy migration-handshake
//      marker FACTORY_SCHEMA_MIGRATION_UNSUPPORTED, or an adoption/compat/
//      runtime-mode table name. The kernel's own exact-version SCHEMA_VERSION
//      constant and its read-only PRAGMA user_version handshake are the fresh
//      protocol, not a migration ladder, and are therefore legal.
//   L5 no workshop owns a private scheduler/state table
//      the ONLY surviving file tree that contains CREATE TABLE is
//      src/workflow-kernel/persistence/** (the one declarative schema owner);
//      any workshop package caught owning DDL is named.
//
// Parsing notes (deliberately a COMPACT re-derivation, not a copy of the EK-1
// validator): dispositions are read per row (RETAIN-AND-MOVE > KEEP > DELETE —
// an explicit survival marker wins over a section DELETE), replacement prose
// under `src/workflow-kernel/**` (the future namespace) never joins the DELETE
// set, and tokens that fail to resolve against git ls-files are reported as
// unresolved (informational — resolution truth is pinned by the EK-1 gate).
// Deterministic: sorted output, no timestamps, no randomness.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'LEGACY-DELETION-MANIFEST.md');
const FUTURE_NAMESPACE = 'src/workflow-kernel/';

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');
if (argv.some((a) => a !== '--check' && a !== '--strict' && a !== '--json')) {
  console.error('usage: ek-legacy-zero.mjs [--check (default)] | --strict [--json]');
  process.exit(2);
}

function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
// WP-12 post-cutover universe (2026-08-26): manifest tokens resolve against
// BASE UNION TRACKED. Before the purge, resolution against the live tree was
// enough (every classified file existed); after it, the DELETE rows would
// resolve to nothing and the laws would go VACUOUSLY green. The base SHA in
// the manifest header is the deletion record's anchor.
const baseShaMatch = readFileSync(MANIFEST, 'utf8').match(/- \*\*Base SHA:\*\* `([0-9a-f]{40})`/);
if (!baseShaMatch) throw new Error('LEGACY-ZERO: the manifest is missing its Base SHA header');
const baseTracked = new Set(git(['ls-tree', '-r', '--name-only', baseShaMatch[1]]).split('\n').filter(Boolean));
const universe = new Set([...tracked, ...baseTracked]);

// --- compact manifest token/disposition parse --------------------------------
const md = readFileSync(MANIFEST, 'utf8');
const backticks = (line) => [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const stripLineRef = (t) => t.replace(/:\d+(-\d+)?(,\d+)*$/, '');
const CODE_DOC_EXT = /\.(mjs|cjs|js|mts|ts|d\.mts|md|json|jsonl|txt|sql|png|svg|html|css|ps1|py|sh)$/;
const isPathToken = (t) =>
  !t.includes(' ') && !t.startsWith('http') && !t.startsWith('node:')
  && (t.includes('*') || t.includes('{') || t.includes('/') || CODE_DOC_EXT.test(t));
const isTableName = (t) => /^[a-z_][a-z0-9_]*$/.test(t);

function dispositionOf(text) {
  if (/RETAIN-AND-MOVE/i.test(text)) return 'RETAIN-AND-MOVE';
  // DELETE before KEEP: a SPLIT row whose prose mentions KEEP for one
  // sub-tree (legacy §E "`tests/agent-proxy/**` (transport guard) KEEP")
  // still deletes its main tokens; the KEEP-qualified sub-tree is carved
  // back out by the keepMention pass below.
  if (/DELETE\b/.test(text) || /\bSPLIT\b/.test(text)) return 'DELETE';
  if (/\bKEEP\b/.test(text)) return 'KEEP';
  return null;
}

// glob engine (single '*', '**'), mirroring the EK-1 grammar
function globToRegex(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; if (pattern[i] === '/') i++; }
      else { re += '[^/]*'; i += 1; }
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(re + '$');
}
function expandGlob(pattern) {
  const re = globToRegex(pattern);
  const out = [];
  for (const f of universe) if (re.test(f)) out.push(f);
  return out.sort();
}
function expandBraces(token) {
  const m = token.match(/\{([^{}]*)\}/);
  if (!m) return [token];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
    .flatMap((p) => expandBraces(token.replace(/\{[^{}]*\}/, p)));
}

const DECLARED_TOKEN_BINDINGS = new Map([
  ['package/resources/**', 'src/process-modules/modules/*/package/resources/**'],
  ['nodes/use-case/resources/**', 'src/process-modules/modules/*/package/nodes/use-case/resources/**'],
]);

function resolveToken(rawToken, baseDir, rowText = '') {
  const token = stripLineRef(rawToken);
  if (DECLARED_TOKEN_BINDINGS.has(token)) return expandGlob(DECLARED_TOKEN_BINDINGS.get(token));
  const bases = [baseDir ? `${baseDir.replace(/\/$/, '')}/` : '', '', 'src/', 'scripts/', 'tools/', 'tracker-view/', 'tests/'];
  for (const base of bases) {
    for (const variant of expandBraces(token)) {
      if (variant.endsWith('/')) {
        // declared §E convention: a row saying "`tests/` root (9)" claims the
        // ROOT files (one level), not the whole tree.
        const oneLevel = /root\s*\(\d+\)/.test(rowText) && rowText.includes(`\`${token}\``);
        const dir = (base + variant).replace(/\/$/, '');
        const hit = expandGlob(oneLevel ? `${dir}/*` : `${dir}/**`);
        if (hit.length) return hit;
        continue;
      }
      if (variant.includes('*')) {
        const hit = expandGlob(base + variant);
        if (hit.length) return hit;
        continue;
      }
      if (universe.has(base + variant)) return [base + variant];
    }
  }
  return [];
}

// split into `## X.` / `### X.Y` units
function splitUnits() {
  const units = [];
  let current = null;
  for (const line of md.split(/\r?\n/)) {
    const h2 = line.match(/^## ([A-Z])\.\s*(.*)$/);
    const h3 = line.match(/^### ([A-Z])\.(\d+)\.?\s*(.*)$/);
    if (h2) { current = { id: h2[1], title: h2[2], lines: [], baseDir: headingBase(h2[2]) }; units.push(current); continue; }
    if (h3) { current = { id: `${h3[1]}.${h3[2]}`, title: h3[3], lines: [], baseDir: headingBase(h3[3]) ?? (units.at(-1)?.baseDir ?? '') }; units.push(current); continue; }
    current?.lines.push(line);
  }
  return units;
}
function headingBase(title) {
  for (const t of backticks(title).map(stripLineRef)) {
    if (t.includes('*') || t.includes('{') || t.endsWith('/')) {
      const cut = t.split(/[*{]/)[0].replace(/\/$/, '');
      if (cut) return cut;
    }
  }
  return null;
}

const deleteSet = new Set();
const retainSet = new Set();
const keepSet = new Set();
let unresolvedTokens = 0;
const tableNames = [];
{
  let prevATable = null;
  for (const unit of splitUnits()) {
    const unitDisposition = dispositionOf(unit.title);
    // §A rows classify TABLE names (used by L3), not file paths.
    if (/^A(\.\d+)?$/.test(unit.id)) {
      for (const line of [`| ${unit.title} |`, ...unit.lines]) {
        if (!line.trim().startsWith('|')) continue;
        const firstCell = line.split('|')[1] ?? '';
        for (const t of backticks(firstCell).map(stripLineRef)) {
          if (!isTableName(t)) continue;
          if (t.startsWith('_') && prevATable) {
            tableNames.push(prevATable.slice(0, prevATable.lastIndexOf('_') + 1) + t.slice(1));
          } else {
            tableNames.push(t);
            prevATable = t;
          }
        }
      }
      continue;
    }
    if (!/^[B-G](\.\d+)?$/.test(unit.id)) continue; // §H/I/J are prose cross-references
    // §G RETAIN-AND-MOVE contracts — ONLY the rows whose verdict IS
    // RETAIN-AND-MOVE (the "no pure predecessor" bullets say "not
    // RETAIN-AND-MOVE as a file" / "DELETE @ EK-8" and stay DELETE via §B).
    if (unit.id === 'G') {
      for (const line of [`| ${unit.title} |`, ...unit.lines]) {
        const qualifies = /RETAIN-AND-MOVE/.test(line) && !/not RETAIN-AND-MOVE|DELETE @ EK-8/.test(line);
        if (!qualifies) continue;
        for (const t of backticks(line).map(stripLineRef)) {
          if (!isPathToken(t) || t.startsWith(FUTURE_NAMESPACE)) continue;
          for (const p of resolveToken(t, 'src/', line)) retainSet.add(p);
        }
      }
      continue;
    }
    let inTable = false;
    let header = null;
    const rowLines = [unit.title]; // heading tokens classify too (§B.6/B.13 style)
    for (const line of unit.lines) {
      if (line.trim().startsWith('|')) {
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (!inTable) { inTable = true; header = cells; continue; }
        rowLines.push(cells.join(' | '));
      } else if (inTable && line.trim() === '') {
        inTable = false; header = null;
      } else if (!inTable) {
        rowLines.push(line); // prose lines carry dispositions too (§B.12 style)
      }
    }
    const proseDisposition = unit.lines
      .map((l) => l.match(/Disposition\s+\*\*([A-Z-]+)\*\*/i)?.[1])
      .find(Boolean);
    for (const rowText of rowLines) {
      const disposition = dispositionOf(rowText) ?? unitDisposition ?? (proseDisposition ? dispositionOf(proseDisposition) : null);
      // A KEEP mention qualifying ONE sub-tree inside an otherwise-DELETE row
      // (legacy §E "`tests/agent-proxy/**` (transport guard) KEEP") carves
      // that token back out of the row disposition.
      const keepMentions = new Set([...rowText.matchAll(/`([^`]+)`\s*\([^)]*\)\s*KEEP/g)].map((m) => m[1]));
      for (const t of backticks(rowText).map(stripLineRef)) {
        if (!isPathToken(t) || t.startsWith(FUTURE_NAMESPACE)) continue;
        // §B.11 declares `modules/**` twice: the resources row RETAIN-AND-MOVE
        // cross-references §B.12 (whose own enumerated resource globs carry
        // that coverage) and must NOT swallow the whole modules tree.
        if (t === 'modules/**' && /resources/i.test(rowText) && /§B\.12/.test(rowText)) continue;
        const effectiveDisposition = keepMentions.has(t) ? 'KEEP' : disposition;
        const paths = resolveToken(t, unit.baseDir ?? '', rowText);
        if (paths.length === 0) { unresolvedTokens += 1; continue; }
        if (effectiveDisposition === 'KEEP') { for (const p of paths) keepSet.add(p); }
        else if (effectiveDisposition === 'RETAIN-AND-MOVE') { for (const p of paths) retainSet.add(p); }
        else if (effectiveDisposition === 'DELETE') { for (const p of paths) deleteSet.add(p); }
      }
    }
  }
}
for (const p of retainSet) deleteSet.delete(p);
for (const p of keepSet) deleteSet.delete(p);

// --- survivor set (the post-cutover production surface) -----------------------
const survivors = [...tracked].filter((f) => f.startsWith('src/') && !deleteSet.has(f)).sort();
const survivorSet = new Set([...survivors, ...keepSet]);

// --- L1: deletion-manifest entries absent -------------------------------------
// WP-12 strengthening (2026-08-26): absence is checked against the tracked
// set AND the working tree — a resurrection first surfaces as an untracked
// phantom file, and L1 must catch it before anyone could `git add` it.
// (dist/ and node_modules are never in the manifest's path space, so the
// fs probe cannot produce false positives.)
const presentOnDisk = (f) => {
  try {
    statSync(path.join(ROOT, f));
    return true;
  } catch {
    return false;
  }
};
const stillPresent = [...deleteSet].filter((f) => tracked.has(f) || presentOnDisk(f)).sort();
const byTree = {};
for (const f of stillPresent) {
  const key = f.includes('/') ? `${f.split('/')[0]}/` : f;
  byTree[key] = (byTree[key] ?? 0) + 1;
}

// --- L2: production imports resolve only to the new runtime -------------------
const importRe = /(?:^|\n)\s*(?:import\s[\s\S]*?from\s*|import\s*|export\s[\s\S]*?from\s*)['\"](\.[^'\"]+)['\"]/g;
function resolveRelative(fromFile, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.ts`,
    `${base}.mjs`,
    base.replace(/\.js$/, '.ts'), // TypeScript convention: './schema.js' denotes schema.ts
    `${base}/index.js`,
    `${base}/index.ts`,
  ];
  return candidates.find((c) => tracked.has(c)) ?? null;
}
const brokenImports = [];
const survivorLegacyImports = [];
const allLegacyImports = [];
for (const file of [...tracked].filter((f) => f.startsWith('src/') && /\.(ts|mjs|js)$/.test(f)).sort()) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of text.matchAll(importRe)) {
    const spec = m[1];
    const resolved = resolveRelative(file, spec);
    if (deleteSet.has(file)) {
      if (resolved !== null && deleteSet.has(resolved)) allLegacyImports.push(`${file} -> ${resolved}`);
      continue;
    }
    if (!survivorSet.has(file)) continue;
    if (resolved === null) { brokenImports.push(`${file} -> ${spec}`); continue; }
    if (deleteSet.has(resolved)) survivorLegacyImports.push(`${file} -> ${resolved}`);
  }
}

// --- L3: forbidden old table names absent from production SQL ------------------
const forbiddenTables = [...new Set(tableNames)].sort();
// Scanner-pattern exemption (same convention as the architecture guard's
// BENIGN registers): files whose old-table references are DETECTION DATA —
// the literal forbidden SQL a fence scans production code FOR — not live
// queries. Every entry carries its justification; the register is asserted
// minimal by ek-removal-guard RG4a (unexempted hits fail L3).
const L3_SCANNER_PATTERN_FILES = new Set([
  // WP-10's F1 fence: its violation pattern IS the forbidden tasks-reading
  // SQL the fence exists to catch in production code.
  'src/workflow-kernel/projection/fences.ts',
]);
const tableHits = [];
for (const file of survivors) {
  if (!/\.(ts|mjs|js)$/.test(file)) continue;
  if (L3_SCANNER_PATTERN_FILES.has(file)) continue;
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  for (const name of forbiddenTables) {
    const re = new RegExp(
      `(?:CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+|UPDATE\\s+|ALTER\\s+TABLE\\s+|DELETE\\s+FROM\\s+|FROM\\s+|JOIN\\s+)[\`"']?${name}\\b`,
      'i',
    );
    if (re.test(text)) tableHits.push(`${file}: SQL references old table \`${name}\``);
  }
}

// --- L4: no migration / adoption / compatibility fallback ----------------------
const forbiddenTokens = [
  { token: 'ALTER TABLE', why: 'schema mutation' },
  { token: 'CREATE TABLE IF NOT EXISTS', why: 'lazy regrowth (ADR-095 F2)' },
  { token: 'FACTORY_SCHEMA_MIGRATION_UNSUPPORTED', why: 'legacy migration handshake' },
  ...['factory_adoptions', 'factory_production_adoption_decisions', 'factory_development_verification_adoptions',
    'factory_runtime_mode', 'factory_definition_compatibility_receipts',
    'factory_process_products__new', 'factory_process_products_new', 'factory_replay_capsule_invalidations_new']
    .map((t) => ({ token: t, why: 'adoption/compatibility/rebuild relation' })),
];
const fallbackHits = [];
for (const file of survivors) {
  if (!/\.(ts|mjs|js)$/.test(file)) continue;
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  for (const { token, why } of forbiddenTokens) {
    if (text.includes(token)) fallbackHits.push(`${file}: contains ${token} (${why})`);
  }
}

// --- L5: no workshop owns a private scheduler/state table ----------------------
const ddlOwners = [...new Set(
  survivors
    .filter((f) => /\.(ts|mjs|js)$/.test(f) && /CREATE\s+TABLE/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    .filter((f) => !f.startsWith('src/workflow-kernel/persistence/')),
)];

// --- report --------------------------------------------------------------------
const laws = [
  {
    id: 'L1', name: 'every deletion-manifest entry absent',
    count: stillPresent.length,
    detail: stillPresent.length
      ? { byTree, sample: stillPresent.slice(0, 12) }
      : { byTree: {}, sample: [] },
  },
  {
    id: 'L2', name: 'production imports resolve only to the new runtime',
    count: brokenImports.length + survivorLegacyImports.length,
    detail: { brokenImports, survivorLegacyImports, totalLegacyImportsInTree: allLegacyImports.length },
  },
  { id: 'L3', name: 'forbidden old table names absent from production SQL', count: tableHits.length, detail: tableHits },
  { id: 'L4', name: 'no migration/adoption/compatibility fallback', count: fallbackHits.length, detail: fallbackHits },
  { id: 'L5', name: 'no workshop owns a private scheduler/state table', count: ddlOwners.length, detail: ddlOwners },
];

const result = {
  mode: STRICT ? 'strict' : 'check',
  manifest: 'docs/refactoring/event-kernel/LEGACY-DELETION-MANIFEST.md',
  parse: {
    deleteClassified: deleteSet.size,
    retainAndMove: retainSet.size,
    keep: keepSet.size,
    unresolvedTokens,
    oldTableNames: forbiddenTables.length,
    survivors: survivors.length,
  },
  laws: laws.map(({ id, name, count }) => ({ id, name, count })),
  green: laws.every((l) => l.count === 0),
};

if (JSON_OUT) {
  console.log(JSON.stringify({ ...result, lawDetails: laws }, null, 2));
} else {
  console.log(`[legacy-zero] mode=${result.mode} (pre-cutover --check reports, WP-12 --strict blocks)`);
  console.log(`[legacy-zero] manifest parse: ${result.parse.deleteClassified} DELETE-classified, ${result.parse.retainAndMove} RETAIN-AND-MOVE, ${result.parse.keep} KEEP, ${result.parse.unresolvedTokens} unresolved tokens (EK-1 gate owns resolution), ${result.parse.oldTableNames} old table names, ${result.parse.survivors} survivor files`);
  for (const l of laws) {
    console.log(`[legacy-zero] ${l.id} ${l.count === 0 ? 'GREEN' : STRICT ? 'RED' : 'PRE-CUTOVER'} (${l.count}) — ${l.name}`);
    if (l.count > 0) {
      const d = l.detail;
      const lines = Array.isArray(d) ? d : [
        ...(d.byTree ? Object.entries(d.byTree).map(([k, v]) => `    ${k}: ${v} file(s)`) : []),
        ...(d.sample ? d.sample.map((s) => `    ${s}`) : []),
      ];
      for (const line of lines.slice(0, 12)) console.log(line);
      if (lines.length > 12) console.log(`    … ${lines.length - 12} more`);
    }
  }
  if (result.green) console.log('[legacy-zero] ALL FIVE LAWS GREEN — the tree is legacy-zero');
  else if (STRICT) console.error('[legacy-zero] RED — legacy references remain (see above); the cutover is incomplete');
  else console.log('[legacy-zero] pre-cutover state reported honestly; --strict stays red until WP-12 completes the deletions');
}

process.exit(result.green || !STRICT ? 0 : 1);
