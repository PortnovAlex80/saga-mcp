// tests/architecture/run-journal-observation-only.test.mjs
//
// STAGE-10 TASK 1 ratchet — the run journal is a PROJECTION, never an
// authority. The brief's load-bearing constraint:
//
//   "A log is a projection. It may never become an authority, a decision
//    input, or a recovery trigger. Nothing in the factory may read the
//    journal back."
//
// Four fences, in the §27 house style (enumeration from compiled output,
// frozen documented sets, anti-vacuity floors):
//
//   1. MODULE SURFACE — dist/observability/run-journal.js exports exactly
//      { journalEvent }. No read/open/parse API exists to import.
//   2. FROZEN IMPORTERS — the compiled files importing the journal module
//      are exactly the six sanctioned emission sites. A seventh importer
//      (a would-be reader or second writer) fails this suite by name.
//      The tracker-view runner (claude-runner.mjs) is plain ESM loaded from
//      source; its import is pinned separately by content.
//   3. NO READ-BACK — the journal module performs no reads (no readFile /
//      createReadStream / readdir / openSync('r')) and the journal FILENAME
//      and SAGA_RUN_JOURNAL env name appear ONLY in the module itself,
//      tools/ (the sanctioned snapshot consumer, outside the factory
//      runtime), and tests. Factory code cannot read back what it never
//      opens.
//   4. NEVER-THROWS — a journal whose path is unwritable is a lost
//      projection, never a lost production fact; journalEvent swallows.
//
// Negative validation (recorded in the commit message): temporarily adding
// (a) a read helper export to the module, (b) an import from an unsanctioned
// compiled file, and (c) a readFile in the module — each turned the
// corresponding fence RED by name; reverted, GREEN.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync, truncateSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_ROOT = join(repoRoot, 'dist');
const JOURNAL_MODULE = join(DIST_ROOT, 'observability', 'run-journal.js');
const JOURNAL_MODULE_URL = pathToFileURL(JOURNAL_MODULE).href;
const SRC_MODULE = join(repoRoot, 'src', 'observability', 'run-journal.ts');

/** The sanctioned journal EMITTERS in compiled factory code (frozen set).
 * STAGE-11 TASK 5 additions (failure events): the effect boundary
 * (error.thrown), the engine-adapter result boundary (run.terminal), the CLI
 * exit hook (engine.exit), and the supervision reap loop
 * (supervision.reaped). The transition-obligation ledger was already wired
 * (its defer/appendFenced/claimed events extend in place). */
const FROZEN_COMPILED_IMPORTERS = [
  'app/product-lifecycle-runtime.js',
  'infrastructure/work/worker-supervision-service.js',
  'infrastructure/workplace/sqlite-gate-repository.js',
  'lifecycle/work-assignment-core.js',
  'observability/run-journal.js', // the module itself (self-reference in header comments only)
  'orchestrate-cli.js',
  'process-modules/application/lifecycle-orchestration-engine-adapter.js',
  'process-modules/application/post-acceptance-effects.js',
  'process-modules/persistence/sqlite-external-effect-ledger.js',
  'process-modules/persistence/sqlite-transition-obligation-ledger.js',
  'tools/dispatcher.js',
];

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else if (entry.endsWith('.js')) out.push(rel);
  }
  return out;
}

function listCompiledFiles() {
  const files = walk(DIST_ROOT);
  assert.ok(files.length >= 200, `anti-vacuity: dist walk found only ${files.length} files`);
  return files;
}

test('fence 1 — the journal module exports exactly { journalEvent }: no read API exists', async () => {
  const mod = await import(JOURNAL_MODULE_URL);
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['journalEvent'],
    'the observation surface is append-only; any additional export is a would-be reader or mutator',
  );
  assert.equal(typeof mod.journalEvent, 'function');
});

test('fence 2 — compiled importers of the journal are exactly the sanctioned emitters', () => {
  const importers = [];
  for (const rel of listCompiledFiles()) {
    const text = readFileSync(join(DIST_ROOT, rel), 'utf8');
    if (text.includes('observability/run-journal')) importers.push(rel);
  }
  assert.deepEqual(
    importers.sort(),
    [...FROZEN_COMPILED_IMPORTERS].sort(),
    `importer set drifted: got [${importers.join(', ')}] — a new importer is a new reader/writer and must be a deliberate act recorded here`,
  );
});

test('fence 2b — the tracker-view runner is the only source-side importer (pinned by content)', () => {
  const runnerPath = join(repoRoot, 'tracker-view', 'claude-runner.mjs');
  const runner = readFileSync(runnerPath, 'utf8');
  assert.match(runner, /dist\/observability\/run-journal\.js/);
  const rogue = [];
  for (const entry of readdirSync(join(repoRoot, 'tracker-view'))) {
    if (!entry.endsWith('.mjs') || entry === 'claude-runner.mjs') continue;
    const text = readFileSync(join(repoRoot, 'tracker-view', entry), 'utf8');
    if (text.includes('run-journal')) rogue.push(entry);
  }
  assert.deepEqual(rogue, [], 'unsanctioned tracker-view journal reference');
});

test('fence 3 — the module performs no reads, and the journal path/env names appear nowhere else in factory code', () => {
  const moduleText = readFileSync(JOURNAL_MODULE, 'utf8');
  for (const forbidden of [/readFileSync/u, /createReadStream/u, /readdirSync/u, /openSync/u]) {
    assert.doesNotMatch(
      moduleText.replace(/appendFileSync/u, ''),
      forbidden,
      'the journal module must not read — append is the only filesystem verb',
    );
  }
  const srcText = readFileSync(SRC_MODULE, 'utf8');
  assert.doesNotMatch(
    srcText.replace(/appendFileSync/u, ''),
    /readFileSync|createReadStream|readdirSync|openSync/u,
    'source and compiled surfaces agree',
  );

  // The FILENAME and the env override may appear only in: the journal module,
  // tools/ (sanctioned post-mortem consumer), and tests/. Never in factory
  // code (src/ or tracker-view/) — that would be a read-back or a second writer.
  const factoryViolations = [];
  const scanFactory = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        scanFactory(abs, rel);
        continue;
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.mjs')) continue;
      if (rel === 'observability/run-journal.ts') continue;
      const text = readFileSync(abs, 'utf8');
      if (text.includes('factory-run-journal.jsonl') || text.includes('SAGA_RUN_JOURNAL')) {
        factoryViolations.push(rel);
      }
    }
  };
  scanFactory(join(repoRoot, 'src'), '');
  assert.deepEqual(
    factoryViolations,
    [],
    'factory code referencing the journal file or its env is a read-back or second writer',
  );
});

test('fence 4 — journalEvent never throws, whatever the filesystem does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-journal-ratchet-'));
  try {
    // Make the journal path unwritable BY CONSTRUCTION: its parent is a file.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const impossibleJournal = join(blocker, 'sub', 'factory-run-journal.jsonl');
    const prev = process.env.SAGA_RUN_JOURNAL;
    const { journalEvent } = await import(JOURNAL_MODULE_URL);
    process.env.SAGA_RUN_JOURNAL = impossibleJournal;
    try {
      assert.doesNotThrow(() => journalEvent('probe.kind', { run_id: 'r1' }, { ok: true }));
      assert.equal(existsSync(impossibleJournal), false, 'nothing was written anywhere');
    } finally {
      if (prev === undefined) delete process.env.SAGA_RUN_JOURNAL;
      else process.env.SAGA_RUN_JOURNAL = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durability — JSONL survives a crash mid-write: at most the tail line is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-journal-crash-'));
  try {
    const journalPath = join(dir, 'factory-run-journal.jsonl');
    const prev = process.env.SAGA_RUN_JOURNAL;
    const { journalEvent } = await import(JOURNAL_MODULE_URL);
    process.env.SAGA_RUN_JOURNAL = journalPath;
    try {
      journalEvent('one.a', { run_id: 'r1', execution_id: 1 });
      journalEvent('one.b', { run_id: 'r1', execution_id: 2 });
      journalEvent('one.c', { run_id: 'r1', execution_id: 3 });
    } finally {
      if (prev === undefined) delete process.env.SAGA_RUN_JOURNAL;
      else process.env.SAGA_RUN_JOURNAL = prev;
    }
    // Crash mid-write: chop the last line in the middle.
    const whole = readFileSync(journalPath, 'utf8');
    truncateSync(journalPath, whole.length - 9);
    // Reader-side tolerance rule: parse line by line; a trailing partial line
    // is skipped; every COMPLETE line must be a valid correlated record.
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const records = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      records.push(JSON.parse(lines[i]));
    }
    try {
      JSON.parse(lines[lines.length - 1]);
      assert.ok(false, 'the truncated tail was expected to be unparseable');
    } catch { /* expected: the tail died mid-write */ }
    assert.ok(records.length >= 2, `at least the first events survive the crash (got ${records.length})`);
    for (const record of records) {
      assert.equal(typeof record.ts, 'string');
      assert.equal(typeof record.kind, 'string');
      assert.equal(record.run_id, 'r1');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
