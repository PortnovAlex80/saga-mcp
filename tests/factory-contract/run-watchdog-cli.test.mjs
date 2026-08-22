// tests/factory-contract/run-watchdog-cli.test.mjs
//
// CC-GAP-5 — the run-watchdog CLI contract is drift-proof.
//
// WHY: the repo's two observation tools spell their interval flags
// differently — tools/run-watchdog.mjs takes `--interval-seconds <N>` while
// tools/saga-status.mjs `watch` takes `--interval=S`. An operator or agent
// switching between them naturally types `--interval 60`, and before this
// suite that died as a bare "unknown option" (or, worse, a NaN/0 value could
// silently hot-loop). The stage-20 incident (watchdog restarted with a
// truncated --settings-sha copied from an old note) already proved launch
// notes drift; the flag contract must fail loudly and SPECIFICALLY, and the
// contract must be locked by CI so a future rename or re-introduced `--interval`
// alias breaks the build.
//
// What this locks, by launching the REAL parser (no reimplementation):
//   1. --help prints the full contract and exits 0;
//   2. `--interval` / `--interval-ms` (saga-status-style drift) exit 2 with a
//      remediation naming `--interval-seconds` — drift is loud and actionable;
//   3. numeric flags reject non-integer/non-positive values instead of
//      hot-looping on NaN/0;
//   4. a mistyped --db fails fast instead of spinning sample_error forever;
//   5. an isolated live fixture (empty SQLite file in a temp dir, never a
//      factory DB) launches end-to-end: watchdog.start records the resolved
//      arguments and at least two samples arrive at --interval-seconds 1,
//      proving the flag name actually drives the sampling loop;
//   6. a value slot NEVER swallows the next flag: for EVERY option (string
//      options included) a next token beginning with `--` is rejected as a
//      missing value — the reviewed bug `--out --journal` used to accept the
//      literal "--journal" as the logs dir and START the watchdog.
//
// SCOPE CLASSIFICATION (explicitly preserved, not touched here): the BUILT-IN
// tracker supervisor — tracker-view/engine-supervisor.mjs (antifreeze layer C,
// env-configured via SAGA_ENGINE_SUPERVISOR_INTERVAL_MS/_STALE_MS, durable
// factory_engine_watchdog_events, may brake+restart a frozen engine) — is a
// DIFFERENT mechanism from this EXTERNAL observation-only CLI. Its coverage
// lives in tests/app/engine-supervisor.test.mjs,
// tests/app/engine-watchdog-migration.test.mjs,
// tests/app/operator-soft-stop-migration.test.mjs and the migration-smoke
// canonical suite, and must stay green independent of this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(repoRoot, 'tools', 'run-watchdog.mjs');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('--help prints the canonical argument contract and exits 0', () => {
  const result = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
  for (const flag of ['--db', '--out', '--journal', '--interval-seconds', '--stagnation-minutes', '--settings-sha', '--max-hours']) {
    assert.ok(result.stdout.includes(flag), `help names ${flag}`);
  }
  // The help must state the classification: external observer vs built-in
  // panel supervisor (engine-supervisor) — the two are routinely conflated.
  assert.match(result.stdout, /engine-supervisor\.mjs/u);
  assert.match(result.stdout, /observation-only/u);
});

test('drift regression: --interval (saga-status spelling) is rejected with a --interval-seconds remediation', () => {
  for (const drifted of ['--interval', '--interval-ms']) {
    const result = spawnSync(process.execPath, [TOOL, '--db', 'x', '--out', 'y', drifted, '60'], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0, `${drifted} must not be accepted`);
    assert.ok(result.stderr.includes(`unknown option ${drifted}`), `${drifted} named in stderr`);
    assert.match(result.stderr, /--interval-seconds/u, `${drifted} error names the real flag`);
  }
});

test('numeric contract: --interval-seconds demands a positive integer (no NaN/0 hot loop)', () => {
  for (const bad of ['abc', '0', '-5', '1.5']) {
    const result = spawnSync(process.execPath, [TOOL, '--db', 'x', '--out', 'y', '--interval-seconds', bad], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 2, `"${bad}" rejected with exit 2`);
    assert.match(result.stderr, /requires a positive integer/u);
  }
  const maxHours = spawnSync(process.execPath, [TOOL, '--db', 'x', '--out', 'y', '--max-hours', '0'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(maxHours.status, 2);
  assert.match(maxHours.stderr, /requires a positive integer/u);
});

test('missing required flags and values fail with the usage contract on stderr', () => {
  const noDb = spawnSync(process.execPath, [TOOL, '--out', 'y'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(noDb.status, 2);
  assert.match(noDb.stderr, /--interval-seconds/u, 'usage text carries the full contract');

  const noValue = spawnSync(process.execPath, [TOOL, '--db', 'x', '--out', 'y', '--interval-seconds'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /requires a value/u);
});

// Every option in the contract takes a value, so every value slot must refuse
// a flag-shaped next token. Table-driven over ALL value-taking flags — the
// string-valued ones (--db/--out/--journal/--settings-sha) are the dangerous
// half: a numeric flag like `--interval-seconds --journal` already died (NaN
// check) with a misleading message, but a string flag ACCEPTED the literal
// "--journal" and kept parsing.
const EVERY_VALUE_FLAG = [
  '--db', '--out', '--journal', '--settings-sha',
  '--interval-seconds', '--stagnation-minutes', '--max-hours',
];

test('flag-shaped value tokens are rejected as missing values for every option', () => {
  for (const flag of EVERY_VALUE_FLAG) {
    for (const nextToken of ['--journal', '--interval-seconds']) {
      const args = [TOOL];
      if (flag !== '--db') args.push('--db', 'x');
      if (flag !== '--out') args.push('--out', 'y');
      args.push(flag, nextToken);
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 2, `${flag} ${nextToken} rejected with exit 2 (stderr: ${result.stderr})`);
      assert.ok(result.stderr.includes(`${flag} requires a value`), `${flag} ${nextToken}: named as the valueless flag`);
      assert.match(result.stderr, /looks like another flag/u, `${flag} ${nextToken}: the swallowed flag is called out`);
      assert.ok(!result.stderr.includes('unknown option'), `${flag} ${nextToken}: dies at the value check, not downstream`);
      assert.ok(!result.stderr.includes('requires a positive integer'), `${flag} ${nextToken}: not the misleading NaN message`);
    }
  }
});

test('regression: --out --journal never starts the watchdog on a garbage logs dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-watchdog-flag-'));
  try {
    const dbPath = join(dir, 'factory.sqlite');
    new Database(dbPath).close();
    // The exact reviewed invocation: the string option --out swallows the next
    // flag. Old behavior: mkdirSync("--journal") in cwd + watchdog.start.
    const result = spawnSync(process.execPath, [TOOL, '--db', dbPath, '--out', '--journal'], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 2, `must exit 2, not start sampling (stderr: ${result.stderr})`);
    assert.match(result.stderr, /--out requires a value/u);
    const created = readdirSync(dir);
    assert.ok(!created.includes('--journal'), `no literal "--journal" dir in cwd (created: ${created})`);
    assert.ok(!created.some((n) => n === 'watchdog.jsonl'), 'watchdog.jsonl was never written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legitimate string values still parse (only "--" prefix is refused)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-watchdog-legit-'));
  try {
    const absent = join(dir, 'absent.sqlite');
    // Real journal path, a sha256, and a single-dash out value: all accepted
    // by the parser. Acceptance is observed via the NEXT gate — the fail-fast
    // db check — proving parsing moved past every value slot.
    const result = spawnSync(process.execPath, [TOOL,
      '--db', absent, '--out', '-logs',
      '--journal', join(dir, 'run-journal.jsonl'),
      '--settings-sha', 'f'.repeat(64)],
    { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /database not found/u, 'values accepted — failure is the db gate, not the parser');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mistyped --db path fails fast instead of spinning sample_error forever', () => {
  const absent = join(tmpdir(), `definitely-absent-${Date.now()}.sqlite`);
  const result = spawnSync(process.execPath, [TOOL, '--db', absent, '--out', join(tmpdir(), `wd-out-${Date.now()}`)], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /database not found/u);
});

test('isolated fixture: real launch resolves the contract and samples at --interval-seconds 1', { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-watchdog-cli-'));
  const dbPath = join(dir, 'factory.sqlite');
  const outDir = join(dir, 'out');
  // A proper zero-table SQLite file: the sampler must tolerate lazily-created
  // (here: absent) tables by design. Never a live factory DB.
  new Database(dbPath).close();
  // Legitimate string value for --journal (file intentionally absent — the
  // sampler must tolerate a not-yet-created journal, lines: 0).
  const journalPath = join(dir, 'run-journal.jsonl');

  const child = spawn(process.execPath, [TOOL,
    '--db', dbPath, '--out', outDir, '--journal', journalPath,
    '--interval-seconds', '1', '--stagnation-minutes', '45', '--max-hours', '1'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const jsonl = join(outDir, 'watchdog.jsonl');
    const deadline = Date.now() + 30000;
    let records = [];
    for (;;) {
      try {
        records = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch { /* first record not written yet */ }
      const samples = records.filter((r) => r.kind === 'sample');
      if (records.some((r) => r.kind === 'watchdog.start') && samples.length >= 2) break;
      assert.ok(Date.now() < deadline, `timed out waiting for watchdog.start + 2 samples (records=${records.length}, stderr=${stderr})`);
      await sleep(200);
    }

    const start = records.find((r) => r.kind === 'watchdog.start');
    assert.ok(start, 'watchdog.start record written');
    assert.equal(start.interval_seconds, 1, 'the real flag drove the recorded interval');
    assert.equal(start.stagnation_minutes, 45);
    assert.equal(start.max_hours, 1);
    assert.equal(start.db, dbPath);
    assert.equal(start.journal, journalPath, 'the real --journal string value reached watchdog.start');

    const samples = records.filter((r) => r.kind === 'sample');
    assert.ok(samples.length >= 2, `interval honored — at least two samples, got ${samples.length}`);
    for (const s of samples) {
      assert.match(s.fingerprint, /^[0-9a-f]{64}$/u, 'sample carries the progress fingerprint');
      assert.equal(s.sample.lifecycle, null, 'absent lifecycle table → tolerated null, not a crash');
      assert.equal(s.sample.engine.pid, null, 'no launch/controls rows → no engine pid');
      assert.equal(s.sample.engine.alive, false);
      assert.equal(s.sample.journal.lines, 0, 'absent journal file → tolerated, not an error');
      assert.ok(Array.isArray(s.trips) === false && s.trips === undefined, 'clean empty DB must not trip');
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((res) => {
      if (child.exitCode !== null) res();
      else {
        child.once('exit', res);
        const t = setTimeout(res, 3000);
        t.unref();
      }
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
