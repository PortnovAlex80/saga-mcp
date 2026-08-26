/**
 * import-export/verify/smoke.mjs - the API + recovery-path smoke: start the
 * REAL server, import/export round-trip over sockets, CORRUPT the store on
 * disk (the failure the product must survive), verify export refuses with
 * the typed corruption surface, then drive POST /recover and prove the
 * snapshot restored the dataset. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

async function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  child.stdout.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  let port = 0;
  for (let attempt = 0; attempt < 100 && port === 0; attempt += 1) {
    const match = /listening on (\d+)/.exec(buffer);
    if (match) port = Number.parseInt(match[1], 10);
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (port === 0) throw new Error('server never reported its port');
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise((resolve) => { child.kill(); child.once('exit', resolve); }) };
}

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); process.stdout.write(`smoke ok: ${name}\n`); }
  catch (error) { failures += 1; process.stderr.write(`smoke FAIL: ${name}: ${error?.message ?? error}\n`); }
};

try {
  mkdirSync(DATA, { recursive: true });
  const server = await startServer();
  try {
    await check('healthz', async () => {
      assert.deepEqual(await (await fetch(`${server.base}/healthz`)).json(), { status: 'ok' });
    });
    await check('import validation refusals are typed', async () => {
      const refused = await fetch(`${server.base}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: '' }) });
      assert.equal(refused.status, 422);
      assert.equal((await refused.json()).errors.length, 2);
    });
    await check('import -> export round-trip', async () => {
      const dataset = { dataset: 'qual-corpus', records: [{ id: 1, value: 'one' }, { id: 2, value: 'two' }] };
      const imported = await fetch(`${server.base}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dataset) });
      assert.deepEqual(await imported.json(), { imported: 2 });
      const exported = await (await fetch(`${server.base}/export`)).json();
      assert.deepEqual(exported, dataset);
    });
    await check('corruption is detected and export refuses with the recovery surface', async () => {
      writeFileSync(join(DATA, 'current.json'), '{corrupted by the smoke', 'utf8');
      const refused = await fetch(`${server.base}/export`);
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: 'corrupt-store', recovery: 'POST /recover' });
    });
    await check('the recovery path restores the last good snapshot', async () => {
      const recovered = await fetch(`${server.base}/recover`, { method: 'POST' });
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), { recovered: true, records: 2 });
      const exported = await (await fetch(`${server.base}/export`)).json();
      assert.equal(exported.dataset, 'qual-corpus');
    });
  } finally {
    await server.stop();
  }
} finally {
  rmSync(DATA, { recursive: true, force: true });
}
process.exitCode = failures === 0 ? 0 : 1;
