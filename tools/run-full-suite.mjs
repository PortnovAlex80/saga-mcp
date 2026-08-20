// tools/run-full-suite.mjs
//
// STAGE-18 TASK 3: the canonical full-suite entry (package.json "test").
//
// WHY this exists: bare `node --test` discovers test files under EVERY
// directory — including tests/golden-runs/**, the byte-frozen corpus of a
// captured production run (fd5fdbd4). Those files are DATA, not this repo's
// suites: the golden product repo's tests are mocha-shaped (`describe`/
// `it`) and run inside the factory sandbox, never here. This Node build has
// no --test-ignore flag, so the exclusion is done by enumerating the files
// explicitly with the same name patterns the default discovery uses:
//
//   **/*.test.{js,mjs,cjs}, **/test-*.{js,mjs,cjs}, **/test.{js,mjs,cjs}
//
// minus node_modules and tests/golden-runs, then running them through the
// PROVEN CLI (`node --test <files>`) in batches (Windows argv limits). The
// programmatic node:test run() API was tried and resolved without executing
// anything — a vacuous green this tool must never produce: the totals are
// aggregated from each batch's real summary lines and a run with fewer than
// 4000 tests REFUSES to report green.

import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const EXCLUDED = ['node_modules', 'tests/golden-runs'];
const BATCH = 100;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function excluded(relPosix) {
  return EXCLUDED.some(root => relPosix === root || relPosix.startsWith(`${root}/`));
}

const patterns = [
  '**/*.test.js', '**/*.test.mjs', '**/*.test.cjs',
  '**/test-*.js', '**/test-*.mjs', '**/test-*.cjs',
  '**/test.js', '**/test.mjs', '**/test.cjs',
];

const files = new Set();
for (const pattern of patterns) {
  for (const abs of globSync(pattern, { cwd: repoRoot, exclude: entry => excluded(toPosix(entry)) })) {
    const rel = toPosix(path.relative(repoRoot, abs));
    if (excluded(rel)) continue;
    files.add(rel);
  }
}

const sorted = [...files].sort();
if (sorted.length < 100) {
  console.error(`FULL-SUITE ENUMERATION SUSPICIOUS: only ${sorted.length} files resolved — refusing to run green-by-vacuum`);
  process.exit(1);
}
process.stdout.write(`[full-suite] ${sorted.length} test files (${EXCLUDED.join(', ')} excluded), batches of ${BATCH}\n`);

const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
let anyFailed = false;
for (let i = 0; i < sorted.length; i += BATCH) {
  const batch = sorted.slice(i, i + BATCH).map(rel => path.join(repoRoot, rel));
  const r = spawnSync(process.execPath, ['--test', ...batch], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^ℹ (tests|pass|fail|skipped)\s+(\d+)$/);
    if (m) totals[m[1]] += Number(m[2]);
  }
  if (r.status !== 0) {
    anyFailed = true;
    process.stdout.write(out);
  } else {
    // Keep passing-batch noise minimal: one line per batch.
    process.stdout.write(`[full-suite] batch ${Math.floor(i / BATCH) + 1}: ok\n`);
  }
}

process.stdout.write(
  `[full-suite] TOTAL tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped}\n`,
);
if (totals.tests < 4000) {
  console.error(`FULL-SUITE VACUOUS: only ${totals.tests} tests ran (expected >4000) — summary aggregation failed; refusing green`);
  process.exit(1);
}
process.exit(anyFailed || totals.fail > 0 ? 1 : 0);
