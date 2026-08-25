// WP-13C / EK-9 — elite-evidence-kit extractor determinism smoke (CI-hosted).
//
// tools/elite-evidence-kit/extract.mjs (WP-13D) is the deterministic
// regression-corpus extractor for the event kernel. Its committed proof of
// determinism ran against operator-machine run roots under D:/Development
// (see docs/refactoring/event-kernel/elite-evidence-kit/README.md) — CI can
// never touch those. This smoke gives the extractor a TINY committed
// synthetic source fixture (tests/infrastructure/ek-fixtures/elite-smoke/,
// built by the committed build-elite-smoke-fixture.mjs) and proves on every
// run:
//
//   EK1 the extractor exits 0 on the fixture and emits the SPEC-v1 per-run
//       contract (source-manifest.json, input-capsule/index.json,
//       actor-program/program.json, expected-trace.json,
//       expected-invariants.json) with real content (capsules, events);
//   EK2 DETERMINISM — two fresh extractions from the same source produce
//       BYTE-IDENTICAL kits (sorted file list + per-file sha256);
//   EK3 READ-ONLY — every fixture file's sha256 is unchanged by both runs
//       (the extractor's core contract: sources are strictly read-only, the
//       SQLite DB is opened { readonly: true }).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTRACT = path.join(ROOT, 'tools', 'elite-evidence-kit', 'extract.mjs');
const FIXTURE = path.join(ROOT, 'tests', 'infrastructure', 'ek-fixtures', 'elite-smoke');

const sha256 = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, base));
    else out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function extract(source, out, runId) {
  const r = spawnSync(process.execPath, [EXTRACT,
    '--source', source,
    '--product', path.join(source, 'product'),
    '--run-id', runId,
    '--out', out,
    '--replace'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('EK fixture contract: the committed synthetic source carries every input the extractor reads', () => {
  // product/.git/HEAD is committed as the MIRROR file git-head-fixture.txt
  // (git refuses to track paths under .git/); the suite materializes the
  // real path in its temp source copy (see materializeSource below).
  for (const rel of ['factory.sqlite', 'factory-run-journal.jsonl', 'product/docs/srs.md', 'product/git-head-fixture.txt']) {
    assert.ok(existsSync(path.join(FIXTURE, rel)), `fixture file missing: ${rel}`);
  }
  // non-vacuity floor: the fixture really exercises tables + journal lines
  const journalLines = readFileSync(path.join(FIXTURE, 'factory-run-journal.jsonl'), 'utf8').trim().split('\n');
  assert.ok(journalLines.length >= 8, `expected >=8 journal lines, got ${journalLines.length}`);
});

/** Copy the committed fixture to a temp SOURCE and materialize product/.git/HEAD. */
function materializeSource(parent) {
  const source = path.join(parent, 'source');
  cpSync(FIXTURE, source, { recursive: true });
  const head = readFileSync(path.join(FIXTURE, 'product', 'git-head-fixture.txt'), 'utf8');
  mkdirSync(path.join(source, 'product', '.git'), { recursive: true });
  writeFileSync(path.join(source, 'product', '.git', 'HEAD'), head);
  return source;
}

test('EK1+EK2: the extractor is deterministic on the committed fixture (two runs, byte-identical kits)', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'ek-kit-smoke-'));
  try {
    // ONE fixed source copy for both runs (sourceRoot is recorded in the kit,
    // so both extractions must read the same absolute path).
    const source = materializeSource(work);
    const before = walkFiles(source).map((f) => `${f.rel}:${sha256(f.abs)}`);

    const run1 = extract(source, path.join(work, 'kit1'), 'elite-smoke');
    const run2 = extract(source, path.join(work, 'kit2'), 'elite-smoke');
    assert.equal(run1.status, 0, `extraction 1 failed:\n${run1.out}`);
    assert.equal(run2.status, 0, `extraction 2 failed:\n${run2.out}`);

    // SPEC-v1 per-run contract present and non-vacuous
    for (const rel of ['source-manifest.json', 'input-capsule/index.json', 'actor-program/program.json', 'expected-trace.json', 'expected-invariants.json']) {
      const abs = path.join(work, 'kit1', rel);
      assert.ok(existsSync(abs), `kit file missing: ${rel}`);
      assert.ok(statSync(abs).size > 10, `kit file suspiciously empty: ${rel}`);
    }
    const manifest = JSON.parse(readFileSync(path.join(work, 'kit1', 'source-manifest.json'), 'utf8'));
    assert.equal(manifest.runId, 'elite-smoke', 'runId must propagate from --run-id');
    assert.ok(manifest.kitStats.inputCapsules >= 10, `expected a non-vacuous capsule count, got ${manifest.kitStats.inputCapsules}`);
    assert.ok(manifest.kitStats.traceEvents >= 8, `expected the seeded journal events in the trace, got ${manifest.kitStats.traceEvents}`);

    // determinism: sorted (path, sha256) lists equal
    const files1 = walkFiles(path.join(work, 'kit1'));
    const files2 = walkFiles(path.join(work, 'kit2'));
    const hashes1 = files1.map((f) => `${f.rel}:${sha256(f.abs)}`);
    const hashes2 = files2.map((f) => `${f.rel}:${sha256(f.abs)}`);
    assert.deepEqual(hashes1, hashes2, 'two extractions from the same source differ — the extractor is not deterministic');
    assert.ok(files1.length >= 20, `expected a real kit tree (>=20 files), got ${files1.length}`);

    // read-only contract: the source is byte-identical after both runs
    const after = walkFiles(source).map((f) => `${f.rel}:${sha256(f.abs)}`);
    assert.deepEqual(after, before, 'the extractor MUTATED its source — the read-only contract is broken');
  } finally {
    rmSync(work, { recursive: true, force: true }); // best-effort
  }
});

test('EK3: the extractor refuses to overwrite a non-empty --out without --replace (no silent clobber)', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'ek-kit-smoke-refuse-'));
  try {
    const source = materializeSource(work);
    const out = path.join(work, 'kit');
    mkdirSync(path.join(out, 'existing'), { recursive: true });
    const r = extract(source, out, 'elite-smoke'); // extract() passes --replace; emulate a bare run
    // re-run without --replace explicitly:
    const bare = spawnSync(process.execPath, [EXTRACT,
      '--source', source, '--product', path.join(source, 'product'),
      '--run-id', 'elite-smoke', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(bare.status, 0, 'a non-empty --out must be refused without --replace');
    assert.match(`${bare.stdout}\n${bare.stderr}`, /REFUSING to overwrite/);
    assert.equal(r.status, 0); // sanity: the --replace path above still worked
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
