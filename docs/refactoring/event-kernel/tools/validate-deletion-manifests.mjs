#!/usr/bin/env node
// EK-1 / WP-04b — deletion-manifest stop-gate validator (operator review item 8).
//
// The two WP-04 manifests (LEGACY-DELETION-MANIFEST.md + DOCUMENT-DELETION-
// MANIFEST.md) classify the pre-cutover tree so EK-7/EK-8/EK-9/EK-10 can delete
// it deliberately. Until those phases execute, nothing machine-checks the
// manifests against the tree, so the classification can rot silently: a
// classified path can vanish, a new file can appear under a covered scope
// without ever being classified, and a row can contradict another row. This
// validator is that machine check — it is BLOCKING (exit 1 names every defect).
//
// What it proves (all four dimensions are derived from the manifest TEXT, not
// from a parallel list maintained here — so editing the manifest is the only
// way to change what is checked):
//
//   V1 EXISTENCE   every classified path exists in the tree today (git
//                  ls-files). The manifests classify CURRENT files; a vanished
//                  path is a stale row -> RED naming it. Globs must resolve
//                  against the manifest's declared Base SHA and every file
//                  they classified at base must still exist.
//   V2 NO-ROT      every tracked file under the manifest's scope appears in a
//                  manifest row: scope = src/**, tracker-view/**, scripts/**
//                  (legacy manifest) + every *.md and every doc artifact
//                  (document manifest). A NEW unclassified file under scope ->
//                  RED naming it (any new file forces conscious classification).
//                  Declared policy exceptions, auditable below: tools/
//                  reverse-coverage is off (the EK program itself adds tooling
//                  post-base; §D KEEP rows are re-pinned by their owners), and
//                  docs/refactoring/event-kernel/** is the live refactoring
//                  workspace (verified entirely post-base; EK-13 FINAL-RECEIPT
//                  owns its fate).
//   V3 CONSISTENCY DELETE / RETAIN-AND-MOVE / KEEP (and the document manifest's
//                  KEEP / REWRITE / DELETE) must be consistent with the tree
//                  and with each other: a file may never carry two different
//                  dispositions, never be covered by two different sections
//                  (the "row says DELETE while another row lists it as the
//                  replacement source" contradiction class), §G RETAIN-AND-MOVE
//                  files are subtracted from every DELETE group per the
//                  manifest's own convention, and partial overlaps inside one
//                  section are ambiguous -> RED.
//   V4 TABLES      every CREATE TABLE name in src/schema.ts appears in the
//                  legacy manifest §A classification rows exactly once (and no
//                  §A table row is itself a duplicate).
//
// MANIFEST GRAMMAR (declared; each rule encodes a convention the manifests
// actually use — a rule that cannot resolve a token is a RED, never a skip):
//   * Sections are `## X.` units; `### X.Y` subunits refine them and inherit
//     the section's base directory. Only classification sections are parsed
//     (legacy: A..G; document: A..S). Legacy §H/§I/§J and document §T are
//     cross-reference/count sections and contribute no coverage.
//   * Path tokens are backtick-quoted strings containing a `/`, a `*`, or a
//     known file extension; `:line` suffixes are stripped. Table cells split on
//     `|`; path columns are those whose header matches
//     Path|Table|File|Entry|Group|Files. In table units the heading is CONTEXT
//     (rows partition it), except when no row carries a path token — then the
//     heading and prose carry the coverage. §G is the declared exception: only
//     its table rows count (its prose analyzes files that fail the purity test
//     and stay classified by their §B groups).
//   * Heading tokens that are bare scope roots (`src/`, `docs/`, `scripts/`,
//     `tools/`, `tracker-view/`, `tests/`) are scope declarations, not coverage.
//     Tokens under `src/workflow-kernel/` are the FUTURE kernel namespace
//     (replacement prose) — diagnostics only until EK lands it.
//   * Relative tokens resolve against candidate bases in order: the unit's
//     base directory, the repo root, src/, scripts/, tools/, tracker-view/,
//     tests/, then directories established by resolved sibling tokens in the
//     same table cell. First candidate with a non-empty expansion wins. A token
//     that still resolves nowhere is retried as a BASENAME match under the
//     unit's heading globs (unique match required — the manifests enumerate
//     deep files by bare filename); 0 or ambiguous matches -> RED (stale).
//   * `{a,b}` braces expand. `.../x` inherits the line's previous absolute
//     token's prefix up to its first glob/brace (§B.12). A token containing
//     the ellipsis character `…` claims its whole directory recursively
//     (e.g. `decisions/024-…098-*.md`). A trailing `/` claims the subtree
//     recursively (declared exception: legacy §E `tests/` means the nine
//     root files — its row says "tests/ root (9)").
//   * DECLARED_TOKEN_BINDINGS pins the two workshop-resource shorthands the
//     manifests use without a resolvable base (`package/resources/**` and
//     `nodes/use-case/resources/**` mean the per-workshop package trees).
//   * Legacy §B.11 lists `modules/**` twice (code vs resources). The row whose
//     text mentions "resources" cross-references §B.12 and carries no
//     coverage; §B.12's own tokens classify the resources. The code row
//     covers `modules/**` MINUS the `**/resources/**` subtrees.
//   * Document-manifest sections whose heading names a directory AND a verdict
//     ("docs/handoff/ (25) — all DELETE") swallow their whole subtree with
//     that verdict; their inline tokens become existence diagnostics.
//   * Within one unit a token whose expansion is a subset of another token's
//     expansion is a refinement (heading glob + enumerated names), not a
//     duplicate. Across units any overlap is a duplicate (V3).
//
// Usage:
//   node docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs
//   node docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs --json
//   node docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs \
//        --manifest-dir <dir-with-both-manifests>   # test mutations
//   node docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs \
//        --extra-file src/some-new-file.ts          # simulate a new tracked file
//
// Determinism: no timestamps, no randomness, every list sorted. Two runs on
// the same tree print byte-identical output (the closing line carries a sha256
// of the canonical result so drift is visible even in the summary).
//
// Phase note: this is the PRE-DELETION stop-gate (EK-1..EK-7 era: every
// classified path must still exist). At EK-7/EK-8 the deletion phases append
// their executed deletions to DELETED_SINCE_BASE below — or the plan's
// `npm run test:legacy-zero` takes over, which proves the inverse: every
// manifest entry is ABSENT.
//
// KNOWN_GAPS lists REAL manifest defects this validator found on the current
// tree (WP-04b cannot edit the manifests — amendment is the coordinator's).
// Each entry is printed on EVERY run as a KNOWN-GAP line and carried in the
// JSON output; the gate stays green only while the debt is declared here, and
// each entry names the exact defect (matched by code + substring). Removing
// an entry without fixing its manifest row turns the gate red.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DEFAULT_MANIFEST_DIR = path.join(ROOT, 'docs', 'refactoring', 'event-kernel');
const LEGACY_NAME = 'LEGACY-DELETION-MANIFEST.md';
const DOC_NAME = 'DOCUMENT-DELETION-MANIFEST.md';
const SCHEMA_PATH = path.join(ROOT, 'src', 'schema.ts');

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}
const MANIFEST_DIR = argValue('--manifest-dir') ?? DEFAULT_MANIFEST_DIR;
const EXTRA_FILES = argv.filter((_, i) => argv[i - 1] === '--extra-file');
const JSON_OUT = argv.includes('--json');

// --- declared constants ------------------------------------------------------
// Workshop-resource shorthands used by legacy §B.12 heading and document §S
// (no candidate base can resolve them — the manifests mean the per-workshop
// package trees, per §B.12's own enumeration).
const DECLARED_TOKEN_BINDINGS = new Map([
  ['package/resources/**', 'src/process-modules/modules/*/package/resources/**'],
  ['nodes/use-case/resources/**', 'src/process-modules/modules/*/package/nodes/use-case/resources/**'],
]);

// Heading tokens that declare a SCOPE, not coverage.
const BARE_SCOPE_ROOTS = new Set(['src/', 'docs/', 'scripts/', 'tools/', 'tracker-view/', 'tests/']);

// The future kernel namespace (replacement prose) — pre-cutover diagnostics.
const FUTURE_NAMESPACE = 'src/workflow-kernel/';

// Document-manifest §S ("Documentation embedded outside `docs/`") names
// ROOT-relative trees (skills/**, ideas/**, …) — its heading's `docs/` mention
// is prose, not a base directory.
const SECTION_BASE_OVERRIDES = new Map([['S', '']]);

// Files legitimately deleted since the manifest base. FLIPPED at EK-8
// (2026-08-26, WP-12): the hard cutover executed the legacy deletion
// manifest, so V1 inverts for DELETE-classified entries — every file that
// existed at the manifest base and is classified DELETE MUST now be ABSENT
// (V1-SURVIVOR). KEEP/RETAIN-AND-MOVE entries must still exist. The
// per-file DELETED_SINCE_BASE allowlist is therefore obsolete: the
// classification itself is the deletion record.
const POST_CUTOVER = !argv.includes('--pre-cutover');

// Real manifest defects surfaced by this validator on the current tree —
// coordinator amendments pending. Each: { code, includes, detail }.
const KNOWN_GAPS = [
  // All gap entries resolved 2026-08-25 by the coordinator amendment commit
  // (manifest date/coverage/count fixes landed together with this deletion).
];

// --- git surfaces ------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const legacyMd = readFileSync(path.join(MANIFEST_DIR, LEGACY_NAME), 'utf8');
const docMd = readFileSync(path.join(MANIFEST_DIR, DOC_NAME), 'utf8');

const baseShaMatch = legacyMd.match(/- \*\*Base SHA:\*\* `([0-9a-f]{40})`/);
if (!baseShaMatch) {
  console.error('[manifest-guard] RED: LEGACY-DELETION-MANIFEST.md is missing its "- **Base SHA:** `<sha>`" header');
  process.exit(1);
}
const BASE_SHA = baseShaMatch[1];

const baseFiles = new Set(git(['ls-tree', '-r', '--name-only', BASE_SHA]).split('\n').filter(Boolean));
const currFiles = new Set(git(['ls-files']).split('\n').filter(Boolean));
for (const f of EXTRA_FILES) {
  const norm = f.replace(/\\/g, '/').replace(/^\.\//, '');
  currFiles.add(norm);
}
const universe = new Set([...baseFiles, ...currFiles]); // where globs may resolve

// --- findings ----------------------------------------------------------------
const findings = [];
const diagnostics = [];
const red = (code, detail) => findings.push({ code, detail });
const note = (code, detail) => diagnostics.push({ code, detail });

// --- token grammar -----------------------------------------------------------
const CODE_DOC_EXT = /\.(mjs|cjs|js|mts|ts|d\.mts|md|json|jsonl|txt|sql|png|svg|html|css|ps1|py|sh)$/;
const isTableName = (t) => /^[a-z_][a-z0-9_]*$/.test(t);
function isPathToken(t) {
  if (t.includes(' ') || t.startsWith('http') || t.startsWith('node:')) return false;
  if (t.includes('*') || t.includes('{')) return true;
  if (t.includes('/')) return true;
  return CODE_DOC_EXT.test(t);
}
const stripLineRef = (t) => t.replace(/:\d+(-\d+)?(,\d+)*$/, '');
const backticks = (line) => [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

// --- glob engine (single-level '*', '**' suffix) ------------------------------
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
function expandGlob(pattern, fileSet) {
  const re = globToRegex(pattern);
  const out = [];
  for (const f of fileSet) if (re.test(f)) out.push(f);
  return out.sort();
}

// --- markdown sectioning -----------------------------------------------------
function splitUnits(md, firstSection, lastSection) {
  const lines = md.split(/\r?\n/);
  const units = [];
  let current = null;
  let active = false;
  let sectionBase = '';
  for (const line of lines) {
    const h2 = line.match(/^## ([A-Z])\.\s*(.*)$/);
    const h3 = line.match(/^### ([A-Z])\.(\d+)\.?\s*(.*)$/);
    if (h2) {
      if (current && active) units.push(current);
      const id = h2[1];
      active = id >= firstSection && id <= lastSection;
      sectionBase = active ? (headingBase(h2[2]) ?? '') : '';
      current = active ? { id, title: h2[2], lines: [], baseDir: sectionBase } : null;
      continue;
    }
    if (h3) {
      if (current && active) units.push(current);
      current = active
        ? { id: `${h3[1]}.${h3[2]}`, title: h3[3], lines: [], baseDir: headingBase(h3[3]) ?? sectionBase }
        : null;
      continue;
    }
    if (active && current) current.lines.push(line);
  }
  if (current && active) units.push(current);
  // A `## X.` section that has `### X.Y` subunits is a CONTAINER: its heading
  // declares the subunits' shared scope, never coverage of its own.
  const parentIds = new Set(units.filter((u) => u.id.includes('.')).map((u) => u.id.split('.')[0]));
  for (const u of units) u.isContainer = parentIds.has(u.id);
  for (const u of units) {
    u.headingGlobs = headingPaths(u.title)
      .filter((t) => (t.includes('*') || t.includes('{') || t.endsWith('/')) && !BARE_SCOPE_ROOTS.has(t))
      .flatMap((t) => resolveTokenPaths(t, u, []));
  }
  return units;
}
function headingPaths(title) {
  return backticks(title).map(stripLineRef).filter(isPathToken);
}
function dirOfGlob(token) {
  if (token.endsWith('/**')) return token.slice(0, -3);
  if (token.endsWith('/')) return token.slice(0, -1);
  const i = token.lastIndexOf('/');
  return i >= 0 ? token.slice(0, i) : '';
}
function headingBase(title) {
  // bare scope roots DO establish the base directory (document §B "`docs/` root")
  // even though they never become coverage themselves.
  for (const t of headingPaths(title)) {
    if (t.includes('*') || t.includes('{') || t.endsWith('/')) {
      const d = dirOfGlob(t);
      if (d) return d;
    }
  }
  return null;
}

// --- token resolution --------------------------------------------------------
function expandBraces(token) {
  const m = token.match(/\{([^{}]*)\}/);
  if (!m) return [token];
  const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const variants = [];
  for (const p of parts) variants.push(token.replace(/\{[^{}]*\}/, p));
  return variants.flatMap(expandBraces);
}

function resolveTokenPaths(rawToken, unit, cellDirs) {
  const token = stripLineRef(rawToken);
  const candidates = [];
  const push = (base) => {
    const b = base ? `${base.replace(/\/$/, '')}/` : '';
    if (!candidates.includes(b)) candidates.push(b);
  };
  push(unit.baseDir || '');
  push('');
  push('src/');
  push('scripts/');
  push('tools/');
  push('tracker-view/');
  push('tests/');
  for (const d of cellDirs) push(d);

  if (DECLARED_TOKEN_BINDINGS.has(token)) {
    const bound = expandGlob(DECLARED_TOKEN_BINDINGS.get(token), universe);
    if (bound.length) return bound;
  }

  const hasEllipsisChar = token.includes('\u2026');
  if (token.startsWith('.../')) return []; // handled by resolveEllipsisPrefix

  for (const base of candidates) {
    if (hasEllipsisChar) {
      const dir = dirOfGlob(token);
      const claim = dir ? base + dir : base.replace(/\/$/, '');
      const paths = expandGlob(`${claim}/**`, universe);
      if (paths.length) return paths;
      continue;
    }
    for (const variant of expandBraces(token)) {
      if (variant.endsWith('/')) {
        const dir = (base + variant).replace(/\/$/, '');
        // declared exception: legacy §E `tests/` row says "tests/ root (9)"
        const pattern = unit.testsRootClaim ? `${dir}/*` : `${dir}/**`;
        const paths = expandGlob(pattern, universe);
        if (paths.length) return paths;
        continue;
      }
      if (variant.includes('*')) {
        const paths = expandGlob(base + variant, universe);
        if (paths.length) return paths;
        continue;
      }
      const exact = base + variant;
      if (universe.has(exact)) return [exact];
    }
  }
  return [];
}

// `.../x` — inherit the line's previous absolute token's prefix, cut at its
// first glob/brace (§B.12: `.../formalization/package/nodes/...` under the
// brace glob `src/process-modules/modules/{...}/package/resources/**`).
function resolveEllipsisPrefix(rawToken, lineTokens) {
  const tail = rawToken.slice(4);
  let last = null;
  for (const t of lineTokens) {
    const s = stripLineRef(t);
    if (s.startsWith('.../') || !s.includes('/')) continue;
    if (s.includes('*') || s.includes('{')) {
      const cut = s.split(/[*{]/)[0].replace(/\/$/, '');
      if (cut) last = cut;
    } else {
      last = dirOfGlob(s);
    }
  }
  if (!last) return [];
  const out = new Set();
  for (const v of expandBraces(tail)) {
    if (v.includes('*')) for (const p of expandGlob(`${last}/${v}`, universe)) out.add(p);
    else if (universe.has(`${last}/${v}`)) out.add(`${last}/${v}`);
  }
  return [...out].sort();
}

// Deep files the manifests enumerate by bare filename (or shallow relative
// path) under a heading glob: unique basename/suffix match required.
function basenameFallback(token, unit) {
  const tokenBase = token.split('/').pop();
  const matches = new Set();
  for (const p of unit.headingGlobs ?? []) {
    if (p === token || p.endsWith(`/${token}`) || p.split('/').pop() === tokenBase) matches.add(p);
  }
  if (matches.size === 1) return [...matches];
  return [];
}

// --- table parsing -----------------------------------------------------------
const PATH_COLUMN_HEADERS = /^(path s?|paths?|tables?|files?|entries?|groups?)\b/i;
function parseTable(lines) {
  const rows = [];
  let header = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!header) { header = cells; continue; }
    const pathCols = [];
    let dispositionCol = -1;
    let verdictCol = -1;
    header.forEach((h, i) => {
      if (PATH_COLUMN_HEADERS.test(h)) pathCols.push(i);
      if (/^disposition\b/i.test(h)) dispositionCol = i;
      if (/^verdict\b/i.test(h)) verdictCol = i;
    });
    rows.push({ cells, pathCols, dispositionCol, verdictCol });
  }
  return rows;
}

function dispositionOf(text) {
  if (/RETAIN-AND-MOVE/i.test(text)) return 'RETAIN-AND-MOVE';
  if (/\bDELETE\b/.test(text)) return 'DELETE';
  if (/\bKEEP\b/.test(text)) return 'KEEP';
  if (/\bREWRITE\b/.test(text)) return 'REWRITE';
  return null;
}

// Count annotation "token (N)" / "(N files)" / "(N md)" — cross-checked as a
// NON-blocking diagnostic (several manifest count notes are known-loose;
// coverage/existence are the blocking truth). Returns {n, md}.
function countAfter(token, text) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`${esc}\`?\\s*\\((\\d+)(?:\\s+(files?|md|json))?\\)`));
  return m ? { n: Number(m[1]), md: m[2] === 'md' } : null;
}

// resolve a cell's tokens: pass 1 resolves everything, collects the dirs of
// resolved ABSOLUTE paths; pass 2 retries unresolved tokens with those dirs as
// extra candidate bases (sibling-context resolution), then the basename
// fallback under the unit's heading globs.
function resolveCellTokens(cellTokens, unit) {
  const results = new Map();
  const cellDirs = [];
  for (const s of cellTokens) {
    if (!isPathToken(s)) continue;
    const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, cellTokens) : resolveTokenPaths(s, unit, []);
    results.set(s, paths);
    for (const p of paths) {
      const d = dirOfGlob(p);
      if (d && d !== '' && !cellDirs.includes(d)) cellDirs.push(d);
    }
  }
  for (const s of cellTokens) {
    if (!isPathToken(s) || results.get(s)?.length) continue;
    const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, cellTokens) : resolveTokenPaths(s, unit, cellDirs);
    results.set(s, paths.length ? paths : basenameFallback(s, unit));
  }
  return results;
}

// --- LEGACY manifest parse ---------------------------------------------------
function parseLegacy() {
  const units = splitUnits(legacyMd, 'A', 'G');
  for (const u of units) if (u.id === 'E') u.testsRootClaim = true;

  const tokens = [];
  const sectionATableTokens = [];

  for (const u of units) {
    const unitDisposition = dispositionOf(u.title);
    const tables = parseTable(u.lines);
    const rowTokens = [];
    for (const row of tables) {
      const rowText = row.cells.join(' | ');
      const rowDispositionCell =
        row.dispositionCol >= 0 ? row.cells[row.dispositionCol]
        : row.verdictCol >= 0 ? row.cells[row.verdictCol] : '';
      const rowDisposition = dispositionOf(rowDispositionCell) ?? dispositionOf(rowText) ?? unitDisposition;
      // KEEP carve (same convention as tools/ek-legacy-zero.mjs): a token
      // followed by "(qualifier) KEEP" inside an otherwise-DELETE row carves
      // that exact token back out (the §E post-cutover guard register).
      const keepMentions = new Set([...rowText.matchAll(/`([^`]+)`\s*\([^)]*\)\s*KEEP/g)].map((m) => stripLineRef(m[1])));
      const rowTokenKeep = (s) => keepMentions.has(s);
      for (const ci of row.pathCols) {
        const cell = row.cells[ci] ?? '';
        const cellTokens = backticks(cell).map(stripLineRef);
        for (const s of cellTokens) {
          if (!isPathToken(s)) {
            if (u.id.startsWith('A') && ci === row.pathCols[0] && isTableName(s)) {
              sectionATableTokens.push({ unit: u.id, name: s });
            }
            continue;
          }
          if (u.id.startsWith('A')) continue; // §A rows classify tables (V4), not paths
          if (s.startsWith(FUTURE_NAMESPACE) && rowDisposition !== 'KEEP') {
            // "Diagnostics only until EK lands it" — the kernel LANDED
            // (2026-08-24..26 waves). A future-namespace token in a PATH
            // column of a KEEP row is a CLASSIFICATION row (§B.15: the new
            // runtime classifies itself); inside Replacement/prose cells of
            // DELETE rows the token stays what it always was — replacement
            // prose, never classification.
            rowTokens.push({ raw: s, unit: u.id, paths: [], disposition: null, source: 'row', crossRef: true, count: null });
            continue;
          }
          let paths = resolveCellTokens(cellTokens, u).get(s) ?? [];
          // §B.11 `modules/**` appears twice; the resources row cross-references
          // §B.12 (no coverage); the code row excludes the resources subtrees.
          if (u.id === 'B.11' && s === 'modules/**' && !/resources/i.test(rowText)) {
            paths = paths.filter((p) => !/\/resources\//.test(p));
          }
          const crossRef = u.id === 'B.11' && s === 'modules/**' && /resources/i.test(rowText);
          rowTokens.push({
            raw: s, unit: u.id, paths, disposition: rowTokenKeep(s) ? 'KEEP' : rowDisposition,
            source: 'row', crossRef, count: countAfter(s, cell), carved: rowTokenKeep(s),
          });
        }
      }
    }
    const hasRowCoverage = rowTokens.some((t) => !t.crossRef && t.paths.length > 0);
    // legacy §A units classify TABLE names (V4) only; container sections'
    // headings declare scope, not coverage.
    if (!hasRowCoverage && !u.isContainer && !u.id.startsWith('A')) {
      // Table-less units state their disposition either in the heading or as a
      // "Disposition **X**" sentence in the prose (§B.12).
      const proseDisposition = u.lines
        .map((l) => l.match(/Disposition\s+\*\*([A-Z-]+)\*\*/i)?.[1])
        .find(Boolean);
      const effectiveDisposition = unitDisposition ?? (proseDisposition ? dispositionOf(proseDisposition) : null);
      const proseSources = [{ text: u.title, source: 'heading' }];
      for (const line of u.lines) {
        if (line.trim().startsWith('|')) continue;
        proseSources.push({ text: line, source: 'prose' });
      }
      const unitResolved = new Set();
      for (const { text } of proseSources) {
        const lineTokens = backticks(text).map(stripLineRef);
        const resolved = resolveCellTokens(lineTokens, u);
        for (const s of lineTokens) {
          if (!isPathToken(s) || BARE_SCOPE_ROOTS.has(s)) continue;
          const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, lineTokens) : resolved.get(s) ?? [];
          for (const p of paths) unitResolved.add(p);
        }
      }
      for (const { text, source } of proseSources) {
        // Delegation arrows ("`WORKSHOP.md` → §B.12") delegate ONLY the token
        // immediately preceding the arrow — not every token on the line.
        const arrowMatches = [...text.matchAll(/(?:→|see) §([A-Z](?:\.\d+)?)/g)];
        const tokenMatches = [...text.matchAll(/`([^`\n]+)`/g)];
        const delegatedIdx = new Set();
        for (const am of arrowMatches) {
          let best = -1;
          tokenMatches.forEach((tm, i) => { if (tm.index + tm[0].length <= am.index) best = i; });
          if (best >= 0) delegatedIdx.add(best);
        }
        const lineTokens = tokenMatches.map((m) => stripLineRef(m[1]));
        const resolved = resolveCellTokens(lineTokens, u);
        lineTokens.forEach((s, idx) => {
          if (!isPathToken(s) || BARE_SCOPE_ROOTS.has(s)) return;
          if (s.startsWith(FUTURE_NAMESPACE)) {
            rowTokens.push({ raw: s, unit: u.id, paths: [], disposition: null, source, crossRef: true, count: null });
            return;
          }
          let paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, lineTokens) : resolved.get(s) ?? [];
          let crossRef = false;
          let delegatesTo = null;
          if (delegatedIdx.has(idx) && source === 'prose') {
            const am = arrowMatches.find((m) => {
              let best = -1;
              tokenMatches.forEach((tm, i) => { if (tm.index + tm[0].length <= m.index) best = i; });
              return best === idx;
            });
            crossRef = true;
            delegatesTo = am?.[1] ?? null;
          }
          if (paths.length === 0 && source === 'prose') {
            // unresolvable prose token whose basename matches exactly one path
            // this unit already classified = a refinement mention, not coverage
            const base = s.split('/').pop();
            const hits = [...unitResolved].filter((p) => p === s || p.endsWith(`/${s}`) || p.split('/').pop() === base);
            if (hits.length > 0) crossRef = true;
          }
          rowTokens.push({
            raw: s, unit: u.id, paths, disposition: effectiveDisposition,
            source, crossRef, delegatesTo, count: countAfter(s, text),
          });
        });
      }
    }
    tokens.push(...rowTokens);
  }
  return { tokens, sectionATableTokens };
}

// --- DOCUMENT manifest parse -------------------------------------------------
function parseDocument() {
  const units = splitUnits(docMd, 'A', 'U');
  for (const u of units) {
    if (SECTION_BASE_OVERRIDES.has(u.id)) u.baseDir = SECTION_BASE_OVERRIDES.get(u.id);
  }
  const tokens = [];
  for (const u of units) {
    if (u.id === 'T') continue; // T is the counts section — bookkeeping prose, never classification
    const unitDisposition = dispositionOf(u.title);
    const headingDirs = headingPaths(u.title).filter((t) => t.includes('/') && !t.includes('*') && !t.includes('\u2026') && !BARE_SCOPE_ROOTS.has(t));
    const swallow = headingDirs.length > 0 && unitDisposition !== null;
    if (swallow) {
      for (const d of headingDirs) {
        const dir = d.replace(/\/$/, '');
        tokens.push({
          raw: d, unit: u.id, paths: expandGlob(`${dir}/**`, universe),
          disposition: unitDisposition, source: 'heading-swallow',
          crossRef: false, count: null,
        });
      }
      for (const line of u.lines) {
        const lineTokens = backticks(line).map(stripLineRef);
        const resolved = resolveCellTokens(lineTokens, u);
        for (const s of lineTokens) {
          if (!isPathToken(s) || BARE_SCOPE_ROOTS.has(s)) continue;
          const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, lineTokens) : resolved.get(s) ?? [];
          tokens.push({
            raw: s, unit: u.id, paths, disposition: unitDisposition,
            source: 'prose-diagnostic', crossRef: true, count: countAfter(s, line),
          });
        }
      }
      continue;
    }
    const tables = parseTable(u.lines);
    const rowTokens = [];
    for (const row of tables) {
      const rowText = row.cells.join(' | ');
      const rowDispositionCell =
        row.dispositionCol >= 0 ? row.cells[row.dispositionCol]
        : row.verdictCol >= 0 ? row.cells[row.verdictCol] : '';
      const rowDisposition = dispositionOf(rowDispositionCell) ?? dispositionOf(rowText) ?? unitDisposition;
      for (const ci of row.pathCols) {
        const cell = row.cells[ci] ?? '';
        const cellTokens = backticks(cell).map(stripLineRef);
        const resolved = resolveCellTokens(cellTokens, u);
        // rows whose text delegates to another section ("see §M") are
        // cross-references: the named owning section classifies the files
        // (only when the row carries exactly one path token — a delegation
        // arrow never reassigns a whole multi-token row)
        const rowPathTokens = row.pathCols
          .flatMap((c2) => backticks(row.cells[c2] ?? '').map(stripLineRef))
          .filter(isPathToken);
        const arrow = rowText.match(/(?:→|see) §([A-Z](?:\.\d+)?)/);
        const rowIsDelegation = Boolean(arrow) && rowPathTokens.length === 1;
        for (const s of cellTokens) {
          if (!isPathToken(s) || BARE_SCOPE_ROOTS.has(s)) continue;
          const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, cellTokens) : resolved.get(s) ?? [];
          rowTokens.push({
            raw: s, unit: u.id, paths, disposition: rowDisposition,
            source: 'row', crossRef: rowIsDelegation, delegatesTo: arrow?.[1] ?? null,
            count: countAfter(s, cell),
          });
        }
      }
    }
    if (rowTokens.length === 0 && !u.isContainer) {
      const proseSources = [{ text: u.title, source: 'heading' }];
      for (const line of u.lines) {
        if (line.trim().startsWith('|')) continue;
        proseSources.push({ text: line, source: 'prose' });
      }
      for (const { text, source } of proseSources) {
        const lineTokens = backticks(text).map(stripLineRef);
        const resolved = resolveCellTokens(lineTokens, u);
        for (const s of lineTokens) {
          if (!isPathToken(s) || BARE_SCOPE_ROOTS.has(s)) continue;
          const paths = s.startsWith('.../') ? resolveEllipsisPrefix(s, lineTokens) : resolved.get(s) ?? [];
          rowTokens.push({
            raw: s, unit: u.id, paths, disposition: unitDisposition,
            source, crossRef: false, count: countAfter(s, text),
          });
        }
      }
    }
    tokens.push(...rowTokens);
  }
  return { tokens };
}

const legacy = parseLegacy();
const document = parseDocument();

// --- V4: schema.ts CREATE TABLE coverage -------------------------------------
// POST-CUTOVER (EK-8): the old DDL owner itself is DELETE-classified; its
// presence on any tree is a red build (the fresh declarative schema lives
// at src/workflow-kernel/persistence/schema.ts).
if (POST_CUTOVER && (currFiles.has('src/schema.ts') || existsSync(SCHEMA_PATH))) {
  red('V4-OLD-SCHEMA', 'src/schema.ts (the 91-table legacy DDL owner) exists — it is classified DELETE at the manifest base and must never return');
}
const schemaTables = [];
if (existsSync(SCHEMA_PATH)) {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  for (const m of schema.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?[`"']?([a-z_][a-z0-9_]*)/gm)) {
    schemaTables.push(m[1]);
  }
}
const sectionAResolved = [];
{
  let prevBase = null;
  for (const t of legacy.sectionATableTokens) {
    if (t.name.startsWith('_') && prevBase) {
      const stem = prevBase.slice(0, prevBase.lastIndexOf('_') + 1);
      sectionAResolved.push({ unit: t.unit, name: t.name, resolved: stem + t.name.slice(1) });
    } else {
      sectionAResolved.push({ unit: t.unit, name: t.name, resolved: t.name });
      prevBase = t.name;
    }
  }
}
{
  const counts = new Map();
  for (const t of sectionAResolved) counts.set(t.resolved, (counts.get(t.resolved) ?? 0) + 1);
  for (const name of [...new Set(schemaTables)].sort()) {
    const c = counts.get(name) ?? 0;
    if (c === 0) red('V4-UNCLASSIFIED-TABLE', `src/schema.ts CREATE TABLE \`${name}\` is not classified in any legacy §A row`);
    else if (c > 1) red('V4-DUPLICATE-TABLE', `\`${name}\` is classified ${c} times in legacy §A rows`);
  }
  for (const [name, c] of [...counts].sort()) {
    if (c > 1 && !schemaTables.includes(name)) {
      red('V4-DUPLICATE-TABLE', `\`${name}\` is classified ${c} times in legacy §A rows`);
    }
  }
}

// --- shared coverage assembly ------------------------------------------------
// §G owns its files (the declared exception: only its table rows count).
// Pre-cutover §G carried RETAIN-AND-MOVE (subtracted from every DELETE
// group); post-cutover (2026-08-26 amendment) its rows record the landed
// kernel successors with verdict SUPERSEDED — DELETE @ EK-8. Either way a
// §G-covered file is classified ONLY by §G (no cross-unit duplicate).
const retainSet = new Set(
  legacy.tokens.filter((t) => t.unit === 'G' && t.disposition === 'RETAIN-AND-MOVE')
    .flatMap((t) => t.paths),
);
const gOwnedSet = new Set(
  legacy.tokens.filter((t) => t.unit === 'G' && t.paths.length > 0)
    .flatMap((t) => t.paths),
);
// KEEP-carve paths (the "(qualifier) KEEP" convention): subtracted from
// every DELETE classification of the same manifest, mirroring
// tools/ek-legacy-zero.mjs (`for (const p of keepSet) deleteSet.delete(p)`).
const keepCarveSet = new Set(
  legacy.tokens.filter((t) => t.carved && t.disposition === 'KEEP')
    .flatMap((t) => t.paths),
);

function assembleCoverage(tokens, subtractRetain) {
  const coverage = new Map(); // file -> [{unit, raw, disposition}]
  const stale = [];
  // Delegation arrows ("→ §B.12", "see §M"): the TARGET section owns the
  // classification; other sections' globs must not double-claim the files.
  const delegations = [];
  for (const t of tokens) {
    if (t.crossRef && t.delegatesTo && t.paths.length) {
      for (const p of t.paths) delegations.push({ path: p, owner: t.delegatesTo });
    }
  }
  const delegatedElsewhere = (p, unit) => delegations.some((d) => d.path === p && d.owner !== unit);
  for (const t of tokens) {
    if (t.crossRef) {
      // Swallowed-section diagnostics (document manifest) must still resolve;
      // refinement mentions (same-unit basename hits, §B.12 delegation arrows,
      // future-namespace replacement prose) are not classification rows.
      if (t.source === 'prose-diagnostic' && t.paths.length === 0) {
        stale.push(`[${t.unit}] cross-reference \`${t.raw}\` resolves to nothing`);
      }
      continue;
    }
    if (t.paths.length === 0) {
      stale.push(`[${t.unit}] \`${t.raw}\` (${t.source}) resolves to no tracked file — stale row or unresolvable reference`);
      continue;
    }
    for (const p of t.paths) {
      if (subtractRetain && retainSet.has(p) && t.unit !== 'G') continue;
      if (t.unit !== 'G' && gOwnedSet.has(p)) continue; // §G owns its files
      if (t.carved !== true && keepCarveSet.has(p) && t.disposition === 'DELETE') continue; // the carve wins over a section DELETE
      if (delegatedElsewhere(p, t.unit)) continue;
      if (!coverage.has(p)) coverage.set(p, []);
      coverage.get(p).push({ unit: t.unit, raw: t.raw, disposition: t.disposition });
    }
  }
  return { coverage, stale };
}
const legacyCov = assembleCoverage(legacy.tokens, true);
const docCov = assembleCoverage(document.tokens, false);

// --- V1: existence -----------------------------------------------------------
for (const msg of [...new Set(legacyCov.stale)].sort()) red('V1-STALE', `[legacy] ${msg}`);
for (const msg of [...new Set(docCov.stale)].sort()) red('V1-STALE', `[document] ${msg}`);
{
  const vanished = [];
  const survivors = [];
  for (const [p, entries] of [...legacyCov.coverage].sort()) {
    const isDelete = entries.some((e) => e.disposition === 'DELETE');
    if (POST_CUTOVER && isDelete && baseFiles.has(p)) {
      if (currFiles.has(p)) survivors.push(`[legacy] ${p}`);
      continue;
    }
    if (baseFiles.has(p) && !currFiles.has(p)) vanished.push(`[legacy] ${p}`);
  }
  for (const p of docCov.coverage.keys()) {
    // A document-classified DELETE file may legitimately vanish when its
    // deletion executes (the legacy-manifest §F overlap at EK-8, or EK-10);
    // only a vanished KEEP/REWRITE is a defect. No SURVIVOR check here: the
    // document purge itself is EK-10's exit, not EK-8's.
    const docDelete = (docCov.coverage.get(p) ?? []).some((e) => e.disposition === 'DELETE');
    if (docDelete) continue;
    if (baseFiles.has(p) && !currFiles.has(p)) vanished.push(`[document] ${p}`);
  }
  for (const v of vanished.sort()) red('V1-VANISHED', `${v} was classified at base ${BASE_SHA.slice(0, 8)} but is no longer tracked`);
  for (const s of survivors.sort()) red('V1-SURVIVOR', `${s} is classified DELETE and existed at the manifest base — the EK-8 cutover requires it gone (resurrection is a red build)`);
}

// --- V3: consistency (duplicates + disposition conflicts) --------------------
function checkConsistency(coverage, label) {
  for (const [file, entries] of [...coverage].sort()) {
    const units = new Set(entries.map((e) => e.unit));
    if (units.size > 1) {
      red('V3-DUPLICATE', `[${label}] ${file} is classified by ${units.size} sections: ${[...units].sort().join(', ')} (tokens: ${[...new Set(entries.map((e) => `\`${e.raw}\``))].sort().join(', ')})`);
      continue;
    }
    const dispositions = new Set(entries.map((e) => e.disposition).filter(Boolean));
    if (dispositions.size > 1) {
      red('V3-DISPOSITION-CONFLICT', `[${label}] ${file} carries conflicting dispositions ${[...dispositions].sort().join(' / ')} in §${entries[0].unit}`);
    } else if (dispositions.size === 0) {
      red('V3-NO-DISPOSITION', `[${label}] ${file} is covered by §${entries[0].unit} but no disposition could be read from its row or section`);
    }
  }
}
function checkWithinUnit(tokens, label) {
  const byUnit = new Map();
  for (const t of tokens) {
    if (t.crossRef || t.paths.length === 0) continue;
    if (!byUnit.has(t.unit)) byUnit.set(t.unit, []);
    byUnit.get(t.unit).push(t);
  }
  for (const [unit, toks] of [...byUnit].sort()) {
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        const a = new Set(toks[i].paths);
        const b = new Set(toks[j].paths);
        let inter = 0;
        for (const p of b) if (a.has(p)) inter++;
        if (inter === 0) continue;
        const aSubB = inter === b.size, bSubA = inter === a.size;
        if (aSubB || bSubA) continue; // subset refinement, allowed within a unit
        red('V3-PARTIAL-OVERLAP', `[${label}] §${unit}: \`${toks[i].raw}\` and \`${toks[j].raw}\` partially overlap (${inter} shared files) — ambiguous classification`);
      }
    }
  }
}
checkConsistency(legacyCov.coverage, 'legacy');
checkConsistency(docCov.coverage, 'document');
checkWithinUnit(legacy.tokens, 'legacy');
checkWithinUnit(document.tokens, 'document');
for (const p of [...retainSet].sort()) {
  const entries = legacyCov.coverage.get(p) ?? [];
  if (entries.some((e) => e.disposition === 'DELETE')) {
    red('V3-RETAIN-VS-DELETE', `[legacy] §G RETAIN-AND-MOVE file ${p} is also covered by a DELETE row`);
  }
}

// --- V2: no-rot scope ---------------------------------------------------------
// SCOPE POLICY (declared):
//  * src/**, tracker-view/**, scripts/** — full reverse coverage (new -> RED).
//  * tools/** — claimed-subset only: §D rows must resolve and exist (V1), but
//    the EK program itself adds tooling post-base, so new tools/ files do not
//    require manifest classification (§D KEEP rows are re-pinned by owners).
//  * document scope — every tracked *.md plus doc artifacts (non-Markdown
//    files under docs/ + the repo icons), EXCEPT docs/refactoring/event-kernel/**
//    (live refactoring workspace — audited: must be entirely post-base).
const DOC_CARVEOUT = 'docs/refactoring/event-kernel/';
{
  const preBase = [...currFiles].filter((f) => f.startsWith(DOC_CARVEOUT) && baseFiles.has(f));
  for (const f of preBase.sort()) {
    red('V2-CARVEOUT', `docs/refactoring/event-kernel/** is the declared live-workspace carve-out but ${f} existed at the manifest base ${BASE_SHA.slice(0, 8)} — classify it in DOCUMENT-DELETION-MANIFEST.md`);
  }
}
const legacyScopeRoots = ['src/', 'tracker-view/', 'scripts/'];
const legacyScope = [...currFiles].filter((f) => legacyScopeRoots.some((r) => f.startsWith(r))).sort();
const docScope = [
  ...[...currFiles].filter((f) => f.endsWith('.md') && !f.startsWith(DOC_CARVEOUT)),
  ...[...currFiles].filter((f) => (f.startsWith('docs/') && !f.endsWith('.md') && !f.startsWith(DOC_CARVEOUT)) || f === 'icon.png' || f === 'icon.svg'),
].sort();

for (const [scope, coverage, label] of [
  [legacyScope, legacyCov.coverage, 'legacy'],
  [docScope, docCov.coverage, 'document'],
]) {
  for (const f of scope) {
    if (!coverage.has(f)) {
      red('V2-UNCLASSIFIED', `[${label}] ${f} is under the manifest's scope but appears in no manifest row — classify it (a new file must never join the tree unclassified)`);
    }
  }
}

// --- diagnostics: count annotations ------------------------------------------
// Non-blocking. Filters: legacy §E counts suites (not fixture files — mixed
// conventions); ellipsis directory claims approximate; document "(N md)"
// annotations compare the Markdown subset (the manifest enumerates *.md).
for (const t of legacy.tokens) {
  if (!t.count || t.paths.length === 0) continue;
  if (t.unit === 'E' || t.raw.includes('\u2026')) continue;
  if (t.paths.length !== t.count.n) {
    note('COUNT-MISMATCH', `§${t.unit} \`${t.raw}\` says (${t.count.n}) but the tree has ${t.paths.length}`);
  }
}
for (const t of document.tokens) {
  if (!t.count || t.paths.length === 0) continue;
  if (t.raw.includes('\u2026')) continue;
  // §S enumerates `git ls-files '*.md'` — its counts are Markdown counts even
  // when the annotation omits the "md" unit.
  const mdScoped = t.count.md || t.unit === 'S';
  const relevant = mdScoped ? t.paths.filter((p) => p.endsWith('.md')) : t.paths;
  if (relevant.length !== t.count.n) {
    note('COUNT-MISMATCH', `§${t.unit} \`${t.raw}\` says (${t.count.n}${mdScoped ? ' md' : ''}) but the tree has ${relevant.length}${mdScoped ? ' md' : ''}`);
  }
}

// --- known gaps → surface loudly, keep the gate green only while declared ----
const remaining = findings.filter(
  (f) => !KNOWN_GAPS.some((g) => f.code === g.code && f.detail.includes(g.includes)),
);

// --- output -------------------------------------------------------------------
const result = {
  green: remaining.length === 0,
  baseSha: BASE_SHA,
  counts: {
    schemaTables: schemaTables.length,
    sectionATableTokens: sectionAResolved.length,
    legacyTokens: legacy.tokens.filter((t) => !t.crossRef && t.paths.length).length,
    legacyClassifiedFiles: legacyCov.coverage.size,
    legacyScopeFiles: legacyScope.length,
    legacyRetainAndMove: retainSet.size,
    docTokens: document.tokens.filter((t) => !t.crossRef && t.paths.length).length,
    docClassifiedFiles: docCov.coverage.size,
    docScopeFiles: docScope.length,
    findings: findings.length,
    knownGaps: KNOWN_GAPS.length,
    diagnostics: diagnostics.length,
  },
  findings: findings.sort((a, b) => (a.detail < b.detail ? -1 : 1)),
  knownGaps: KNOWN_GAPS,
  diagnostics: diagnostics.sort((a, b) => (a.detail < b.detail ? -1 : 1)),
};
const canonical = JSON.stringify(result, null, 2);
result.digest = createHash('sha256').update(canonical).digest('hex');

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const c = result.counts;
  console.log('[manifest-guard] EK-1 deletion-manifest stop-gate');
  console.log(`[manifest-guard] base SHA: ${BASE_SHA}`);
  console.log(`[manifest-guard] legacy: ${c.legacyTokens} coverage tokens -> ${c.legacyClassifiedFiles} classified files (scope ${c.legacyScopeFiles}; RETAIN-AND-MOVE ${c.legacyRetainAndMove})`);
  console.log(`[manifest-guard] document: ${c.docTokens} coverage tokens -> ${c.docClassifiedFiles} classified files (scope ${c.docScopeFiles})`);
  console.log(`[manifest-guard] schema.ts CREATE TABLE: ${c.schemaTables} classified across ${c.sectionATableTokens} §A table tokens`);
  for (const g of result.knownGaps) console.log(`[manifest-guard] KNOWN-GAP ${g.code}: ${g.detail}`);
  for (const d of result.diagnostics) console.log(`[manifest-guard] DIAG ${d.code}: ${d.detail}`);
  if (result.green) {
    console.log(`[manifest-guard] ALL GREEN — digest ${result.digest}`);
  } else {
    for (const f of remaining) console.error(`[manifest-guard] RED ${f.code}: ${f.detail}`);
    console.error(`[manifest-guard] ${remaining.length} blocking finding(s) — see above`);
  }
}
process.exit(result.green ? 0 : 1);
