// Sandbox provisioning must drop an AGENTS.md workspace marker into the
// product repository (docs/factory-run/stage11/DISORIENTATION-INVESTIGATION.md,
// fix candidate 2). The product sandbox previously contained only .git + README,
// so backend workspace resolution had no local anchor and could climb to the
// factory root. The marker makes the product an explicit agent workspace for
// every future sandbox provisioned by `scripts/factory.mjs start`.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';

const provisionModulePath = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)), '../../scripts/lib/provision-sandbox-product.mjs');

test('provisionSandboxProduct: writes a committed AGENTS.md workspace marker', async () => {
  const { provisionSandboxProduct } = await import(url.pathToFileURL(provisionModulePath).href);
  const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-marker-'));
  try {
    provisionSandboxProduct(root, 'disorient-marker-check');
    const markerPath = path.join(root, 'product', 'AGENTS.md');
    assert.ok(existsSync(markerPath), 'product/AGENTS.md must exist after provisioning');
    const content = readFileSync(markerPath, 'utf8');
    assert.match(content, /product/i,
      'marker must state the repository purpose (one-line purpose statement)');
    // Committed, not dangling: the marker must survive `git clean` and be
    // visible to workspace resolution from a fresh clone.
    const { spawnSync } = await import('node:child_process');
    const ls = spawnSync('git', ['-C', path.join(root, 'product'), 'ls-files'], { encoding: 'utf8' });
    assert.equal(ls.status, 0, ls.stderr);
    assert.ok(ls.stdout.split('\n').includes('AGENTS.md'),
      'AGENTS.md must be tracked by git in the product repository');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
