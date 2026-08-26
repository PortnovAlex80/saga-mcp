// WP-13C / EK-9 — REMOVAL GUARDS.
//
// POST-CUTOVER SHAPE (WP-12, 2026-08-26): the EK-8 hard cutover executed
// the deletion manifest; every guard here flipped to its post-cutover form
// with equal-or-stronger bite:
//
//   RG1 §H/§I cross-reference INVERSION — every concrete file §H (the
//       mandatory-DELETE map) names is ABSENT from the tracked tree (a
//       survivor is a failed deletion), and the surviving §I residual
//       (tools/cc-proof-hosting-registry.mjs) is PRESENT.
//   RG2 §A table inventory INVERSION — none of the §A table names is
//       creatable from current production SQL (the old DDL is gone).
//   RG3 EK8-DELETION-SET execution — every legacy surface the four
//       workshop docs enumerate is GONE, and each doc's preserved set is
//       PRESENT (the opencode shim, the kernel tree, the ADR-053 documents).
//   RG4 legacy-zero tool wiring — --check reports L1 === 0 and exits 0;
//       --strict exits 0 (ALL FIVE LAWS GREEN); the RESURRECTION mutation
//       (a manifest-DELETE path reappearing on disk) turns --strict red;
//       ci.yml hosts --strict BLOCKING (never --check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'LEGACY-DELETION-MANIFEST.md');
const EK8_PATHS = [
  path.join(ROOT, 'src', 'workflow-kernel', 'development', 'EK8-DELETION-SET.md'),
  path.join(ROOT, 'src', 'workflow-kernel', 'workshops', 'delivery', 'EK8-DELETION-SET.md'),
  path.join(ROOT, 'src', 'workflow-kernel', 'workshops', 'discovery', 'EK8-CUTOVER-NOTES.md'),
  path.join(ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'EK8-DELETION-SET.md'),
];
const manifest = readFileSync(MANIFEST_PATH, 'utf8');
const ek8Docs = EK8_PATHS.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

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
  !t.includes(' ') && !t.startsWith('http') && !t.startsWith('http') && !t.startsWith('node:')
  && !t.startsWith('~/')
  && (t.includes('*') || t.includes('{') || t.includes('/') || CODE_DOC_EXT.test(t));

// --- RG1: §H/§I cross-reference inversion ------------------------------------

test('RG1: every concrete file §H names is ABSENT and the surviving §I residual is PRESENT', () => {
  const sections = manifest.split(/^## /m).filter((s) => /^[HI]\.\s/.test(s));
  assert.ok(sections.length === 2, 'manifest must carry exactly the §H and §I sections');
  const tokens = new Set();
  for (const s of sections) {
    for (const line of s.split(/\r?\n/)) {
      for (const raw of backticks(line)) {
        const t = stripLineRef(raw);
        if (t.startsWith('~/') || t.startsWith('http')) continue; // operator-machine paths, not repo files
        if (!t.includes('*') && t.includes('/') && !CODE_DOC_EXT.test(t) && t.split('/').every((seg) => /^[a-z_][a-z0-9_]*$/.test(seg))) continue; // table-group shorthand
        if (!t.includes('/') && !CODE_DOC_EXT.test(t)) continue;
        tokens.add(t);
      }
    }
  }
  assert.ok(tokens.size >= 15, `expected >=15 §H/§I path tokens, got ${tokens.size}`);
  const survivors = [];
  for (const t of [...tokens].sort()) {
    if (t.includes('*')) {
      const re = new RegExp('^' + t.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      for (const f of tracked) if (re.test(f)) survivors.push(`glob \`${t}\` still matches ${f}`);
      continue;
    }
    if (tracked.has(t)) survivors.push(`\`${t}\` is still tracked`);
  }
  // The §I residual that legitimately survived (manifest §I amendment):
  // the matrix-guarding registry tool. Everything else §H/§I names is dead.
  const allowed = new Set(['tools/cc-proof-hosting-registry.mjs', 'docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md']);
  const unallowed = survivors.filter((line) => ![...allowed].some((a) => line.includes(a)));
  assert.deepEqual(unallowed, [],
    '§H/§I name files that survived the cutover — the deletion map or the purge is wrong');
  // The residual itself must exist (its absence would be a silent drop).
  for (const allowedPath of allowed) {
    assert.ok(tracked.has(allowedPath), `the §I residual ${allowedPath} must still exist`);
  }
});

// --- RG2: §A table inventory inversion -----------------------------------------

test('RG2: NO §A table name (incl. §A.5 lazy tables and §A.6 rebuild tables) is creatable from production SQL', () => {
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
      if (t.startsWith('trg_')) continue;
      if (t === 'user_version') continue;
      if (t.startsWith('_') && prev) tableNames.add(prev.slice(0, prev.lastIndexOf('_') + 1) + t.slice(1));
      else { tableNames.add(t); prev = t; }
    }
  }
  assert.ok(tableNames.size >= 120, `expected >=120 §A table names, got ${tableNames.size}`);
  const srcFiles = [...tracked].filter((f) => f.startsWith('src/') && /\.(ts|mjs|js)$/.test(f));
  const srcText = srcFiles.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const creatable = [];
  for (const n of [...tableNames].sort()) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${n}\\b`, 'i');
    if (re.test(srcText)) creatable.push(n);
  }
  assert.deepEqual(creatable, [],
    '§A table names still creatable in src/** — the old DDL survived somewhere');
});

// --- RG3: EK8-DELETION-SET execution ------------------------------------------

const ROOTED = /^(src|tracker-view|tools|scripts|tests|docs)\//;
function globFiles(pattern) {
  const re = new RegExp('^'
    + pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
    + (pattern.endsWith('/**') ? '(?:/.*)?$' : '$'));
  return [...tracked].filter((f) => re.test(f));
}

test('RG3a: every legacy surface the four EK8 deletion-set docs enumerate is GONE (the cutover executed)', () => {
  let enumerated = 0;
  const survivors = [];
  for (const { text } of ek8Docs) {
    for (const raw of backticks(text)) {
      const t = stripLineRef(raw);
      if (!isPathToken(t) || t.startsWith('src/workflow-kernel/') || t.startsWith('tests/workflow-kernel/') || t.startsWith('tests/project-corpus/') || t.startsWith('tools/agent-proxy/') || t.startsWith('tools/project-corpus/') || t.startsWith('docs/')) continue;
      if (!ROOTED.test(t)) continue;
      const hits = t.includes('*') ? globFiles(t) : (tracked.has(t) ? [t] : []);
      if (t.includes('*')) {
        for (const hit of hits) survivors.push(hit);
        enumerated += 1;
      } else if (hits.length > 0) {
        survivors.push(t);
        enumerated += 1;
      } else {
        enumerated += 1;
      }
    }
  }
  assert.ok(enumerated >= 12, `expected >=12 enumerated surfaces, got ${enumerated}`);
  assert.deepEqual(survivors, [],
    'EK8-DELETION-SET surfaces still tracked — the cutover did not execute their deletion');
});

test('RG3b: each deletion-set doc\'s preserved set is PRESENT (the shim, the kernel, the ADR-053 documents)', () => {
  for (const { text } of ek8Docs) {
    assert.match(text, /src\/workflow-kernel\//, 'each doc pins the preserved kernel tree');
    assert.match(text, /tools\/agent-proxy\/claude-shim\.mjs/, 'each doc pins the preserved opencode shim');
  }
  assert.ok(tracked.has('tools/agent-proxy/claude-shim.mjs'), 'the preserved opencode shim must exist');
  assert.ok(existsSync(path.join(ROOT, 'docs', 'architecture', 'decisions')), 'the ADR tree must exist');
  const adr053 = [...tracked].filter((f) => f.includes('decisions/053-'));
  assert.ok(adr053.length >= 1, 'the ADR-053 decision document must exist');
});

test('RG3c: the partial-survival findings are RESOLVED (the files died whole at the cutover)', () => {
  // Pre-cutover PINNED_FINDINGS: composition-root.ts, engine-supervisor.mjs,
  // claude-runner.mjs carried manifest-DELETE vs doc-partial-survival
  // mismatches. The cutover resolved all three the only honest way: the
  // whole files died; the operational law was re-implemented in
  // src/workflow-kernel/composition/laws.ts (verified below).
  for (const resolved of ['src/app/composition-root.ts', 'tracker-view/engine-supervisor.mjs', 'tracker-view/claude-runner.mjs']) {
    assert.ok(!tracked.has(resolved), `${resolved} must be gone (the pinned finding resolved by deletion)`);
  }
  const laws = readFileSync(path.join(ROOT, 'src', 'workflow-kernel', 'composition', 'laws.ts'), 'utf8');
  assert.match(laws, /FACTORY_CLAUDE_BACKEND_FORBIDDEN/, 'the claude-CLI prohibition law is re-implemented in the composition');
  assert.match(laws, /SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS/, 'the settings-switch tripwire env law is re-implemented');
  assert.match(laws, /ClaudeSettingsTripwire/, 'the ~/.claude/settings.json sha256 tripwire is re-implemented');
});

test('RG3d: the §B.10 Development-module tree is EMPTY (the 29-file count claim executed)', () => {
  const actual = [...tracked].filter((f) => f.startsWith('src/modules/development/')).length;
  assert.equal(actual, 0,
    `src/modules/development has ${actual} tracked files; the manifest row claimed 29 and the cutover deleted them all`);
});

// --- RG4: legacy-zero tool wiring (the WP-12 flip) ------------------------------

function runLegacyZero(...flags) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'ek-legacy-zero.mjs'), ...flags], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('RG4a: legacy-zero --check exits 0 and reports the POST-CUTOVER state (all five laws green)', () => {
  const r = runLegacyZero('--check');
  assert.equal(r.status, 0, `--check must exit 0 post-cutover:\n${r.out}`);
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    assert.match(r.out, new RegExp(`\\[legacy-zero\\] ${id} GREEN \\(0\\)`), `law ${id} must be green post-cutover`);
  }
  assert.match(r.out, /ALL FIVE LAWS GREEN/);
});

test('RG4b: legacy-zero --strict exits 0 post-cutover (the flip target reached)', () => {
  const r = runLegacyZero('--strict');
  assert.equal(r.status, 0, `--strict must exit 0 post-cutover:\n${r.out}`);
  assert.match(r.out, /ALL FIVE LAWS GREEN — the tree is legacy-zero/);
});

test('RG4b-RED/GREEN: an old-path RESURRECTION turns --strict red (the cutover is irreversible)', () => {
  // RED demonstration: a manifest-DELETE path reappears on disk (untracked
  // but present — exactly how a resurrection first surfaces in a checkout).
  // L1 also scans the working tree, so the phantom file is caught before
  // anyone could `git add` it.
  const resurrected = path.join(ROOT, 'src', 'db.ts');
  writeFileSync(resurrected, '// resurrection probe: the old DB bootstrap must never return\n', 'utf8');
  try {
    const red = runLegacyZero('--strict');
    assert.notEqual(red.status, 0, 'a resurrected manifest-DELETE path must fail --strict');
    assert.match(red.out, /L1 RED \(1\)/);
    assert.match(red.out, /src\/db\.ts/);
  } finally {
    rmSync(resurrected, { force: true });
  }
  // GREEN: with the phantom removed, --strict is green again.
  const green = runLegacyZero('--strict');
  assert.equal(green.status, 0, '--strict must return to green once the resurrection is removed');
});

test('RG4c: ci.yml hosts legacy-zero --strict BLOCKING (the WP-12 flip; --check is gone)', () => {
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node tools\/ek-legacy-zero\.mjs --strict/,
    'ci.yml must run the legacy-zero laws in --strict (post-cutover blocking)');
  assert.doesNotMatch(ci, /node tools\/ek-legacy-zero\.mjs --check/,
    'ci.yml must not run legacy-zero in pre-cutover --check mode anymore');
});
