// WP-13C / EK-9 — REMOVAL GUARDS (pre-staging WP-12's hard cutover).
//
// The EK-1 stop-gate (tests/infrastructure/deletion-manifest-guard.test.mjs,
// hosting docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs)
// proves the deletion manifests cannot rot on the classification sections
// (§A–§G): every classified path exists (V1), the scope is closed (V2) and
// consistent (V3/V4). This suite ADDS the guards that make the deletion
// itself safe to execute — all of them blocking NOW, while nothing is
// deleted yet:
//
//   RG1 §H/§I cross-reference existence — the mandatory-DELETE map (§H) and
//       the residuals register (§I) name concrete files that NO validator
//       covers today (the EK-1 gate explicitly skips §H/§I). A stale file
//       reference there is a bug NOW: WP-12 would delete around a phantom.
//   RG2 §A table inventory is REAL — every table name the manifest's §A
//       classifies is creatable from current production SQL (CREATE TABLE in
//       src/**). §A.5's lazily created tables are NOT covered by the EK-1
//       gate's schema.ts-only V4; a renamed lazy table would silently fall
//       out of the deletion target list.
//   RG3 EK8-DELETION-SET cross-check (WP-08's doc, never edited by this
//       suite): every legacy Development surface that doc enumerates (a)
//       exists today and (b) is covered by the LEGACY-DELETION-MANIFEST —
//       by exact row, by basename, or by the manifest's §B/§C directory
//       sweep — or is explicitly in the doc's preserved set. Mismatches are
//       surfaced as PINNED FINDINGS (never silent edits of WP-08's doc):
//       a new mismatch fails, and a resolved finding that stays pinned also
//       fails (the pin list cannot outlive its cause).
//   RG4 legacy-zero tool wiring — tools/ek-legacy-zero.mjs (the five
//       legacy-zero laws) runs in --check on the real tree: exits 0, reports
//       the pre-cutover counts honestly (L1 > 0 today — the WP-12 tripwire
//       pin), and the kernel-survivor laws (L3/L4/L5) are already green.
//       --strict exits nonzero pre-cutover. CI hosts --check BLOCKING; WP-12
//       flips the CI invocation to --strict (see ci.yml step comment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'LEGACY-DELETION-MANIFEST.md');
const EK8_PATH = path.join(ROOT, 'src', 'workflow-kernel', 'development', 'EK8-DELETION-SET.md');
const manifest = readFileSync(MANIFEST_PATH, 'utf8');
const ek8 = readFileSync(EK8_PATH, 'utf8');

const git = (args) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};
const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));

const stripLineRef = (t) => t.replace(/:\d+(-\d+)?(,\d+)*$/, '');
const backticks = (line) => [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const CODE_DOC_EXT = /\.(mjs|cjs|js|mts|ts|d\.mts|md|json|jsonl|txt|sql)$/;
const isPathToken = (t) =>
  !t.includes(' ') && !t.startsWith('http') && !t.startsWith('node:')
  && (t.includes('*') || t.includes('{') || t.includes('/') || CODE_DOC_EXT.test(t));

// --- RG1: §H/§I cross-reference existence ------------------------------------

test('RG1: every concrete file named by manifest §H (mandatory-DELETE map) and §I (residuals) exists today', () => {
  const sections = manifest.split(/^## /m).filter((s) => /^[HI]\.\s/.test(s));
  assert.ok(sections.length === 2, 'manifest must carry exactly the §H and §I sections');
  const tokens = new Set();
  for (const s of sections) {
    for (const line of s.split(/\r?\n/)) {
      for (const raw of backticks(line)) {
        const t = stripLineRef(raw);
        if (t.startsWith('~/')) continue; // operator-machine path (~/.claude/settings.json tripwire), not a repo file
        if (t.startsWith('http')) continue;
        // table-group shorthand (`factory_workplace_graphs/_items/_dependencies`):
        // not a file — verified structurally by RG2's table inventory instead.
        if (!t.includes('*') && t.includes('/') && !CODE_DOC_EXT.test(t) && t.split('/').every((seg) => /^[a-z_][a-z0-9_]*$/.test(seg))) continue;
        if (!t.includes('/') && !CODE_DOC_EXT.test(t)) continue;
        tokens.add(t);
      }
    }
  }
  assert.ok(tokens.size >= 15, `expected >=15 §H/§I path tokens, got ${tokens.size}`);
  const problems = [];
  const byBasename = new Map();
  for (const f of tracked) {
    const b = f.split('/').pop();
    if (!byBasename.has(b)) byBasename.set(b, []);
    byBasename.get(b).push(f);
  }
  for (const t of [...tokens].sort()) {
    if (t.includes('*')) {
      const re = new RegExp('^' + t.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      const hits = [...tracked].filter((f) => re.test(f));
      if (hits.length === 0) problems.push(`glob \`${t}\` matches no tracked file`);
      continue;
    }
    if (tracked.has(t)) continue;
    const hits = byBasename.get(t.split('/').pop()) ?? [];
    if (hits.length === 1) continue; // manifest enumerates deep files by bare filename
    problems.push(`\`${t}\` is neither a tracked path nor a unique basename (${hits.length} basename hits)`);
  }
  assert.deepEqual(problems, [],
    '§H/§I name stale paths — the deletion map / residual register references files that do not exist');
});

// --- RG2: §A table inventory is real ------------------------------------------

test('RG2: every §A table name (incl. §A.5 lazy tables and §A.6 rebuild tables) is creatable from current production SQL', () => {
  const aSection = manifest.split(/^## /m).find((s) => s.startsWith('A.'));
  assert.ok(aSection, 'manifest must carry the §A schema section');
  const tableNames = new Set();
  let prev = null;
  for (const line of aSection.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const raw of backticks(firstCell)) {
      const t = stripLineRef(raw);
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
      if (t.startsWith('trg_')) continue; // trigger guard — covered by the manifest's 115-trigger row
      if (t === 'user_version') continue; // pragma handshake, not a table
      if (t.startsWith('_') && prev) tableNames.add(prev.slice(0, prev.lastIndexOf('_') + 1) + t.slice(1));
      else { tableNames.add(t); prev = t; }
    }
  }
  // §H's table-group shorthand (`factory_workplace_graphs/_items/_dependencies`)
  // abbreviates the §A.3 row's actual names (`factory_workplace_graph_items`,
  // `factory_workplace_dependencies`): every member segment must correspond to
  // an §A table sharing the base's underscore prefix.
  {
    const group = 'factory_workplace_graphs/_items/_dependencies';
    const [base, ...rest] = group.split('/');
    assert.ok(tableNames.has(base), `§H table-group base \`${base}\` missing from §A inventory`);
    const prefix = base.slice(0, base.lastIndexOf('_') + 1);
    const members = [...tableNames].filter((n) => n.startsWith(prefix) && n !== base);
    assert.ok(members.length >= rest.length,
      `§H table-group \`${group}\` claims ${rest.length} members but §A carries only ${members.length} tables with prefix \`${prefix}\`: [${members.join(', ')}]`);
  }
  assert.ok(tableNames.size >= 120, `expected >=120 §A table names, got ${tableNames.size}`);
  const srcFiles = [...tracked].filter((f) => f.startsWith('src/') && /\.(ts|mjs|js)$/.test(f));
  const srcText = srcFiles.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const missing = [];
  for (const n of [...tableNames].sort()) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${n}\\b`, 'i');
    if (!re.test(srcText)) missing.push(n);
  }
  assert.deepEqual(missing, [],
    '§A table names with no CREATE TABLE in src/** — the deletion inventory names tables production can no longer create (renamed lazy table?)');
});

// --- RG3: EK8-DELETION-SET cross-check ----------------------------------------

// The manifest's §B/§C directory sweeps: a file under one of these anchors is
// covered by the manifest's own classification (headers `### B.x \`<dir>/**\``
// plus §C's tracker-view/ tree). Extracted from the manifest, never hardcoded.
function manifestSweepAnchors() {
  const anchors = [];
  for (const m of manifest.matchAll(/^### ([A-Z]\.\d+)\s+`([^`]+\/\*\*)`/gm)) anchors.push(m[2]);
  assert.ok(anchors.some((a) => a === 'src/modules/**'), 'manifest sweep anchors must include src/modules/**');
  return anchors;
}
const SWEEPS = manifestSweepAnchors();
const TRACKER_SWEEP = /^## C\.\s+`tracker-view\/`/.test(manifest)
  ? ['tracker-view/**']
  : [];

const ROOTED = /^(src|tracker-view|tools|scripts|tests|docs)\//;
function globFiles(pattern) {
  const re = new RegExp('^'
    + pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
    + (pattern.endsWith('/**') ? '(?:/.*)?$' : '$'));
  return [...tracked].filter((f) => re.test(f));
}

function ek8ListedSurfaces() {
  // Walk §1/§2 of WP-08's doc; a top-level bullet's ROOTED token sets the
  // base for its sub-bullets' relative tokens (application/…, domain/**,
  // infrastructure/…, package/**).
  const lines = ek8.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## 1\./.test(l));
  const end = lines.findIndex((l) => /^## 3\./.test(l));
  assert.ok(start >= 0 && end > start, 'EK8-DELETION-SET must carry §1..§2 before the §3 preserved set');
  const surfaces = [];
  let base = null;
  for (const line of lines.slice(start, end)) {
    const tokens = backticks(line).map(stripLineRef).filter(isPathToken);
    const rooted = tokens.find((t) => ROOTED.test(t));
    if (/^- /.test(line) && rooted) {
      base = rooted.endsWith('/**') ? rooted.replace(/\/\*\*$/, '') : rooted.split('/').slice(0, -1).join('/');
    }
    const partialSurvival = /the file itself survives|never deleted|ONLY the|sections that bypass|spawn path \+/.test(line);
    for (const t of tokens) {
      if (t.startsWith('...')) continue;
      const candidates = ROOTED.test(t) || !base ? [t] : [`${base}/${t}`, t];
      let resolved = [];
      for (const c of candidates) {
        if (c.includes('*')) resolved = globFiles(c);
        else if (tracked.has(c)) resolved = [c];
        if (resolved.length) break;
      }
      if (resolved.length === 0 && !t.includes('/')) {
        // deep files enumerated by bare filename
        resolved = [...tracked].filter((f) => f.split('/').pop() === t);
      }
      surfaces.push({ token: t, resolved, partialSurvival });
    }
  }
  return surfaces;
}

// PINNED FINDINGS — genuine manifest-vs-EK8-SET mismatches, surfaced for the
// coordinator (this suite NEVER edits WP-08's doc or the manifest). A finding
// leaves this list only when the mismatch itself is resolved.
const PINNED_FINDINGS = [
  {
    file: 'src/app/composition-root.ts',
    finding: 'manifest §B.2 classifies the whole file DELETE @ EK-8; EK8-DELETION-SET preserves the file beyond its Development registration blocks ("the file itself survives for other modules until their WPs cut over")',
  },
  {
    file: 'tracker-view/engine-supervisor.mjs',
    finding: 'manifest §C classifies the whole file DELETE @ EK-8; EK8-DELETION-Set deletes only its Development dispatch loop sections',
  },
  {
    file: 'tracker-view/claude-runner.mjs',
    finding: 'manifest §C classifies the whole file DELETE @ EK-8 (with the operational-law re-implementation note); EK8-DELETION-SET preserves the file — the FACTORY_CLAUDE_BACKEND_FORBIDDEN enforcement is "re-bound behind the real-actor channel at EK-8, never deleted"',
  },
];

test('RG3a: every legacy Development surface EK8-DELETION-SET enumerates exists on disk today (nothing deleted yet)', () => {
  const surfaces = ek8ListedSurfaces().filter((s) => !s.token.startsWith('src/workflow-kernel/'));
  assert.ok(surfaces.length >= 12, `expected >=12 enumerated surfaces, got ${surfaces.length}`);
  const missing = [];
  for (const s of surfaces) {
    if (s.resolved.length === 0) missing.push(s.token);
  }
  assert.deepEqual(missing, [],
    'EK8-DELETION-SET names surfaces that no longer exist — the doc rotted (or a deletion already ran)');
});

test('RG3b: every EK8-DELETION-SET surface is covered by the LEGACY-DELETION-MANIFEST or explicitly preserved', () => {
  const preserved = [
    /`src\/workflow-kernel\/\*\*`/, // §3: the new authority
    /`tools\/agent-proxy\/claude-shim\.mjs`/, // §3: the opencode shim
    /`docs\/architecture\/decisions\/053-\*`/, // §3: normative conveyor documents
  ];
  for (const re of preserved) assert.ok(re.test(ek8), `EK8-DELETION-SET §3 must pin the preserved surface ${re}`);
  assert.ok(existsSync(path.join(ROOT, 'tools', 'agent-proxy', 'claude-shim.mjs')), 'the preserved opencode shim must exist');

  const coveredByManifest = (file) =>
    manifest.includes(file) // exact path row
    || manifest.includes(file.split('/').pop()) // basename mention (§B.9 short names)
    || SWEEPS.some((sweep) => file.startsWith(sweep.replace(/\/\*\*$/, '/')))
    || TRACKER_SWEEP.some((sweep) => file.startsWith(sweep.replace(/\/\*\*$/, '/')));

  const uncovered = [];
  for (const s of ek8ListedSurfaces()) {
    if (s.token.startsWith('src/workflow-kernel/')) continue; // preserved by §3
    for (const file of s.resolved) {
      if (!coveredByManifest(file)) uncovered.push(file);
    }
  }
  assert.deepEqual(uncovered, [],
    'EK8-DELETION-SET surfaces covered by no manifest row/sweep — WP-12\'s deletion target list would miss them');
});

test('RG3c: partial-survival mismatches between the manifest and EK8-DELETION-SET are exactly the pinned findings', () => {
  // Lines where WP-08's doc says only PARTS of a file die ("the file itself
  // survives", "never deleted", "sections that bypass") name files the
  // manifest classifies whole-file DELETE. Every such file must be a pinned
  // finding; a new one (or a pinned one that stopped being partial-survival)
  // fails here so the mismatch is surfaced, never silently absorbed.
  const partial = new Set();
  for (const s of ek8ListedSurfaces()) {
    if (!s.partialSurvival) continue;
    if (s.token.startsWith('src/workflow-kernel/') || s.token.startsWith('tools/agent-proxy/')) continue;
    for (const file of s.resolved) partial.add(file);
  }
  const pinned = new Set(PINNED_FINDINGS.map((f) => f.file));
  assert.deepEqual([...partial].sort(), [...pinned].sort(),
    'the partial-survival set changed — update PINNED_FINDINGS in the same commit that resolves (or adds) a mismatch');
  // each pinned file is manifest-classified DELETE (that IS the mismatch).
  for (const f of PINNED_FINDINGS) {
    assert.ok(manifest.includes(f.file.split('/').pop()) || manifest.includes(f.file),
      `pinned finding ${f.file} no longer appears in the manifest — the mismatch is resolved, unpin it`);
    assert.ok(tracked.has(f.file), `pinned finding ${f.file} must still exist pre-cutover`);
  }
});

test('RG3d: the manifest §B.10 Development-module count matches the tracked tree (the deletion enumeration is not stale)', () => {
  // §B.10 claims `development/** (29)` under src/modules. WP-08's atomic
  // cutover deletes that tree via this manifest row — a drifted count means
  // files joined/left the tree without classification.
  const claim = manifest.match(/`development\/\*\*` \(29\)/);
  assert.ok(claim, 'manifest §B.10 must carry the development/** (29) count claim');
  const actual = [...tracked].filter((f) => f.startsWith('src/modules/development/')).length;
  assert.equal(actual, 29,
    `src/modules/development has ${actual} tracked files; the manifest row claims 29 — re-classify the drift`);
});

// --- RG4: legacy-zero tool wiring ---------------------------------------------

function runLegacyZero(...flags) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'ek-legacy-zero.mjs'), ...flags], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('RG4a: legacy-zero --check exits 0 and reports the pre-cutover state honestly (five laws)', () => {
  const r = runLegacyZero('--check');
  assert.equal(r.status, 0, `--check must exit 0 pre-cutover:\n${r.out}`);
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    assert.match(r.out, new RegExp(`\\[legacy-zero\\] ${id} (GREEN|PRE-CUTOVER) \\(\\d+\\)`), `law ${id} missing from the report`);
  }
  // The honest pre-cutover tripwire: L1 (deletion-manifest entries still
  // present) is large today. WP-12 repins this to === 0 in the same commit
  // that executes the deletions.
  const l1 = Number(r.out.match(/\[legacy-zero\] L1 PRE-CUTOVER \((\d+)\)/)?.[1] ?? '-1');
  assert.ok(l1 > 100, `L1 must report the pre-cutover backlog (>100 files), got ${l1}`);
  // The kernel-survivor laws are already green: the new runtime imports no
  // legacy SQL surface, no migration fallback and no private DDL.
  for (const id of ['L3', 'L4', 'L5']) {
    assert.match(r.out, new RegExp(`\\[legacy-zero\\] ${id} GREEN \\(0\\)`), `law ${id} must be green over the kernel survivors today`);
  }
});

test('RG4b: legacy-zero --strict exits nonzero pre-cutover (the WP-12 flip target)', () => {
  const r = runLegacyZero('--strict');
  assert.notEqual(r.status, 0, '--strict must be red while any deletion-manifest entry still exists (pre-cutover)');
  assert.match(r.out, /L1 (RED|PRE-CUTOVER) \(\d+\)/);
});

test('RG4c: ci.yml hosts legacy-zero --check BLOCKING today (WP-12 flips the same step to --strict)', () => {
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node tools\/ek-legacy-zero\.mjs --check/,
    'ci.yml must run the legacy-zero laws in --check (pre-cutover report, blocking)');
  assert.doesNotMatch(ci, /node tools\/ek-legacy-zero\.mjs --strict/,
    'ci.yml must not flip to --strict before WP-12 executes the deletions');
});
