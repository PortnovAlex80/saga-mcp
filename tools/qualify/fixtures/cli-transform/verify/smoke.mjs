/**
 * cli-transform/verify/smoke.mjs - the CLI smoke: transform a fixture CSV,
 * assert the JSON document (including quoted fields and a typed row error),
 * and prove the file-output path equals the stdout path. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = 'name,amount,note\nalpha,10,"hello, world"\nbeta,20,"say ""hi"""\ngamma,30,plain\nbroken-row,40,extra,field\n';

const dir = mkdtempSync(join(tmpdir(), 'cli-transform-smoke-'));
try {
  const input = join(dir, 'input.csv');
  writeFileSync(input, CSV, 'utf8');
  const run = spawnSync(process.execPath, ['src/transform.mjs', input], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 1, 'malformed rows make the CLI exit 1 (typed row errors)');
  const document = JSON.parse(run.stdout);
  assert.equal(document.kind, 'cli-transform.document.v1');
  assert.deepEqual(document.columns, ['name', 'amount', 'note']);
  assert.equal(document.rows.length, 3);
  assert.deepEqual(document.rows[0], { name: 'alpha', amount: '10', note: 'hello, world' });
  assert.equal(document.rows[1].note, 'say "hi"');
  assert.deepEqual(document.errors, [{ row: 5, error: 'field-count', expected: 3, actual: 4 }]);

  /* clean input exits 0; the file-output path writes identical bytes. */
  const clean = join(dir, 'clean.csv');
  writeFileSync(clean, 'a,b\n1,2\n', 'utf8');
  const cleanRun = spawnSync(process.execPath, ['src/transform.mjs', clean], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cleanRun.status, 0);
  const outFile = join(dir, 'out.json');
  const fileRun = spawnSync(process.execPath, ['src/transform.mjs', clean, outFile], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(fileRun.status, 0);
  assert.equal(readFileSync(outFile, 'utf8'), cleanRun.stdout, 'stdout and file outputs are identical');
  process.stdout.write('cli-transform smoke ok: quoted fields, typed row errors, dual output paths\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
