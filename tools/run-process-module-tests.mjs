#!/usr/bin/env node
// Runs the process-module test suite in two balanced groups (a/b) or all at
// once. File lists are NO LONGER hard-coded: the groups are derived from a
// directory scan of tests/process-modules/**/*.test.mjs so the runner never goes
// stale when a new test file is added.
//
// Usage:
//   node tools/run-process-module-tests.mjs [a|b|all]   # run a group (default: all)
//   node tools/run-process-module-tests.mjs --list      # print groups + coverage, run nothing
//
// Split policy: sort all *.test.mjs basenames lexicographically, then assign
// even-indexed files to group `a` and odd-indexed files to group `b`. This
// keeps the two groups balanced in count and interleaves heavy/light suites so
// neither group is unreasonably large. Sequential execution (--test-concurrency=1)
// and cwd: root are preserved from the original runner.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'tests', 'process-modules');

// Directory scan — the single source of truth for which files exist.
const allFiles = readdirSync(testDir)
  .filter(file => file.endsWith('.test.mjs'))
  .sort();

// Even/odd split by sorted index → two balanced groups.
const groups = {
  a: allFiles.filter((_, index) => index % 2 === 0),
  b: allFiles.filter((_, index) => index % 2 === 1),
};

// --list: print the derived groups and coverage, then exit without running.
if (process.argv.includes('--list')) {
  const total = allFiles.length;
  const sum = groups.a.length + groups.b.length;
  console.log(`tests/process-modules/*.test.mjs — ${total} file(s) discovered`);
  console.log(`group a: ${groups.a.length} file(s) (even-indexed)`);
  for (const file of groups.a) console.log(`  a  ${file}`);
  console.log(`group b: ${groups.b.length} file(s) (odd-indexed)`);
  for (const file of groups.b) console.log(`  b  ${file}`);
  console.log(`coverage: ${sum}/${total} (${sum === total ? '100%' : 'GAP'})`);
  if (sum !== total) {
    console.error('ERROR: group sum does not cover directory — fix the split.');
    process.exit(1);
  }
  process.exit(0);
}

const requested = process.argv[2]?.toLowerCase() ?? 'all';
if (requested !== 'all' && !Object.hasOwn(groups, requested)) {
  console.error('Usage: node tools/run-process-module-tests.mjs [a|b|all|--list]');
  process.exit(2);
}

const selected = requested === 'all' ? ['a', 'b'] : [requested];
for (const group of selected) {
  const files = groups[group].map(file => path.join(testDir, file));
  console.log(
    `\n[process-modules:${group}] ${files.length} files, sequential runner`,
  );
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
