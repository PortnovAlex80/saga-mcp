/**
 * cli-linter/verify/smoke.mjs - the CLI smoke: lint clean and violating
 * fixture configs through the REAL CLI and assert the machine-readable
 * verdict documents + exit codes. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'cli-linter-smoke-'));
try {
  const clean = join(dir, 'clean.json');
  writeFileSync(clean, JSON.stringify({ name: 'my-service', version: '1.2.3', settings: { retries: 3 } }), 'utf8');
  const cleanRun = spawnSync(process.execPath, ['src/lint.mjs', clean], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cleanRun.status, 0, `clean config must exit 0: ${String(cleanRun.stderr)}`);
  const cleanVerdict = JSON.parse(cleanRun.stdout);
  assert.equal(cleanVerdict.kind, 'cli-linter.verdict.v1');
  assert.equal(cleanVerdict.verdict, 'clean');
  assert.equal(cleanVerdict.violationCount, 0);

  const dirty = join(dir, 'dirty.json');
  writeFileSync(dirty, JSON.stringify({ Name: 'BadName', version: 'v1', settings: { nested: { deep: true } } }), 'utf8');
  const dirtyRun = spawnSync(process.execPath, ['src/lint.mjs', dirty], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(dirtyRun.status, 1, 'violations must exit 1');
  const dirtyVerdict = JSON.parse(dirtyRun.stdout);
  assert.equal(dirtyVerdict.verdict, 'violations');
  assert.deepEqual(
    dirtyVerdict.violations.map((violation) => violation.rule).sort(),
    ['required-keys', 'settings-shape', 'unknown-keys', 'version-semver'],
  );

  /* The name-shape rule on its own carrier. */
  const badName = join(dir, 'bad-name.json');
  writeFileSync(badName, JSON.stringify({ name: 'BadName', version: '1.0.0' }), 'utf8');
  const badNameRun = spawnSync(process.execPath, ['src/lint.mjs', badName], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(badNameRun.status, 1);
  assert.deepEqual(JSON.parse(badNameRun.stdout).violations, [
    { rule: 'name-shape', path: '$.name', message: 'name must match /^[a-z][a-z0-9-]*$/' },
  ]);

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope', 'utf8');
  const brokenRun = spawnSync(process.execPath, ['src/lint.mjs', broken], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(brokenRun.status, 2, 'unparseable config must exit 2');
  assert.equal(JSON.parse(brokenRun.stdout).verdict, 'unparseable');
  process.stdout.write('cli-linter smoke ok: clean/violations/unparseable verdicts with exit codes\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
