/**
 * cli-packager/verify/smoke.mjs - the idempotent-effect smoke: run the REAL
 * packager twice over a scratch tree; the first run packages, the second
 * run REPLAYS the same receipt byte-identically (the idempotent effect
 * receipt law), and mutating the tree under the receipt is refused.
 * Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'cli-packager-smoke-'));
try {
  const tree = join(dir, 'tree');
  cpSync(ROOT, tree, { recursive: true, filter: (source) => !source.includes(join('release')) && !source.includes(join('dist')) && !source.includes(join('delivery')) });

  const first = spawnSync(process.execPath, ['src/packager.mjs', tree], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(first.status, 0, `first package run failed: ${String(first.stderr)}`);
  assert.match(first.stdout, /^cli-packager packaged: [0-9a-f]{64}/);
  const firstReceipt = readFileSync(join(tree, 'release', 'receipt.json'), 'utf8');

  const second = spawnSync(process.execPath, ['src/packager.mjs', tree], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(second.status, 0, `replay run failed: ${String(second.stderr)}`);
  assert.match(second.stdout, /^cli-packager replayed: [0-9a-f]{64}/);
  assert.equal(readFileSync(join(tree, 'release', 'receipt.json'), 'utf8'), firstReceipt, 'the replay left the receipt byte-identical');

  /* A tree mutation under an existing receipt is refused (fail-closed). */
  writeFileSync(join(tree, 'product.json'), '{}\n', 'utf8');
  const refused = spawnSync(process.execPath, ['src/packager.mjs', tree], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 1, 'a mutated tree under an existing receipt must be refused');
  const refusal = JSON.parse(refused.stderr);
  assert.equal(refusal.effect, 'refused');
  assert.equal(refusal.reason, 'tree-changed-under-existing-receipt');
  process.stdout.write('cli-packager smoke ok: package -> idempotent replay -> mutation refused\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
