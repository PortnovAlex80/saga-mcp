/**
 * served-crud/verify/smoke.mjs - the full API + browser + persistence smoke:
 * starts the REAL server, exercises the CRUD contract over actual sockets
 * (create/list/update/delete, validation refusals), verifies the browser
 * entry/asset/frontend wiring, then RESTARTS the server and proves the data
 * survived (file-backed persistence). Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'served-crud-smoke-'));

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
  const first = await startServer();
  try {
    await check('healthz', async () => {
      const response = await fetch(`${first.base}/healthz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
    await check('create + list + update + delete round-trip', async () => {
      const created = await (await fetch(`${first.base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'first item' }) })).json();
      assert.equal(created.created.id, 1);
      await fetch(`${first.base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'second item', done: true }) });
      const listed = await (await fetch(`${first.base}/api/items`)).json();
      assert.deepEqual(listed.items.map((item) => item.title), ['first item', 'second item']);
      const updated = await (await fetch(`${first.base}/api/items/2`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: false }) })).json();
      assert.equal(updated.updated.done, false);
      const deleted = await (await fetch(`${first.base}/api/items/1`, { method: 'DELETE' })).json();
      assert.deepEqual(deleted, { deleted: 1 });
    });
    await check('validation refusals are typed (422) and malformed JSON is 400', async () => {
      const refused = await fetch(`${first.base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '' }) });
      assert.equal(refused.status, 422);
      assert.equal((await refused.json()).error, 'validation');
      const malformed = await fetch(`${first.base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
      assert.equal(malformed.status, 400);
      const missing = await fetch(`${first.base}/api/items/99`, { method: 'DELETE' });
      assert.equal(missing.status, 404);
    });
    await check('browser entry + asset + frontend wiring', async () => {
      const html = await (await fetch(`${first.base}/`)).text();
      assert.match(html, /id="item-list"/);
      assert.match(html, /src="\/app\.js"/);
      const js = await (await fetch(`${first.base}/app.js`)).text();
      assert.match(js, /fetch\('\/api\/items'\)/);
      assert.match(js, /getElementById\('item-list'\)/);
    });
  } finally {
    await first.stop();
  }
  const second = await startServer();
  try {
    await check('persistence across restart (file-backed)', async () => {
      const listed = await (await fetch(`${second.base}/api/items`)).json();
      assert.deepEqual(listed.items.map((item) => item.title), ['second item']);
    });
  } finally {
    await second.stop();
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exitCode = failures === 0 ? 0 : 1;
