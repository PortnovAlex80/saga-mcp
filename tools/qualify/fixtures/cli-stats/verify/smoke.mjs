/**
 * cli-stats/verify/smoke.mjs - the CLI smoke of the text-statistics tool:
 * run the REAL CLI over a fixture input file and assert the machine-readable
 * output document. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = 'the quick brown fox\njumps over the lazy dog\nthe fox is quick\n';

const dir = mkdtempSync(join(tmpdir(), 'cli-stats-smoke-'));
try {
  const input = join(dir, 'sample.txt');
  writeFileSync(input, SAMPLE, 'utf8');
  const run = spawnSync(process.execPath, ['src/stats.mjs', input], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `CLI exited ${String(run.status)}: ${String(run.stderr)}`);
  const report = JSON.parse(run.stdout);
  assert.equal(report.kind, 'cli-stats.report.v1');
  assert.equal(report.lines, 3);
  assert.equal(report.words, 13);
  assert.equal(report.uniqueWords, 9);
  assert.equal(report.topWords[0].word, 'the');
  assert.equal(report.topWords[0].count, 3);
  /* stdin path: identical output for identical input (the CLI is deterministic). */
  const stdin = spawnSync(process.execPath, ['src/stats.mjs'], { cwd: ROOT, encoding: 'utf8', input: SAMPLE });
  assert.equal(stdin.status, 0, `stdin CLI exited ${String(stdin.status)}: ${String(stdin.stderr)}`);
  assert.equal(stdin.stdout, run.stdout, 'file and stdin paths produce identical output');
  process.stdout.write('cli-stats smoke ok: file + stdin CLI runs deterministic\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
