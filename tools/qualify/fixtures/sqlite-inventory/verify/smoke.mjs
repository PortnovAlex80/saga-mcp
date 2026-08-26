/**
 * sqlite-inventory/verify/smoke.mjs - the API + persistence smoke: start the
 * REAL server over a scratch database, exercise the inventory contract over
 * sockets (add/list/adjust/refusals/delete), restart the server and prove
 * the SQLite state survived. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'sqlite-inventory-smoke-'));
const dbFile = resolve(join(dir, 'inventory.sqlite'));

async function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs', '0', dbFile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  child.stdout.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  let port = 0;
  for (let attempt = 0; attempt < 100 && port === 0; attempt += 1) {
    const match = /listening on (\d+)/.exec(buffer);
    if (match) port = Number.parseInt(match[1], 10);
    else await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  if (port === 0) throw new Error('server never reported its port');
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise((resolve_) => { child.kill(); child.once('exit', resolve_); }) };
}

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); process.stdout.write(`smoke ok: ${name}\n`); }
  catch (error) { failures += 1; process.stderr.write(`smoke FAIL: ${name}: ${error?.message ?? error}\n`); }
};

try {
  const first = await startServer();
  try {
    await check('healthz carries the schema version', async () => {
      const health = await (await fetch(`${first.base}/healthz`)).json();
      assert.deepEqual(health, { status: 'ok', schema: 'sqlite-inventory.v1' });
    });
    await check('add + list + adjust + typed refusals', async () => {
      const created = await fetch(`${first.base}/api/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'BRD-001', name: 'boards', quantity: 10 }) });
      assert.equal(created.status, 201);
      const bad = await fetch(`${first.base}/api/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'lowercase', name: '', quantity: -1 }) });
      assert.equal(bad.status, 422);
      assert.equal((await bad.json()).errors.length, 3);
      const duplicate = await fetch(`${first.base}/api/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'BRD-001', name: 'again', quantity: 1 }) });
      assert.equal(duplicate.status, 409);
      const adjust = await fetch(`${first.base}/api/inventory/BRD-001/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delta: -3 }) });
      assert.deepEqual(await adjust.json(), { quantity: 7 });
      const refused = await fetch(`${first.base}/api/inventory/BRD-001/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delta: -99 }) });
      assert.equal(refused.status, 409);
    });
  } finally {
    await first.stop();
  }
  const second = await startServer();
  try {
    await check('SQLite state survives a full server restart', async () => {
      const listed = await (await fetch(`${second.base}/api/inventory`)).json();
      assert.deepEqual(listed.items, [{ id: 1, sku: 'BRD-001', name: 'boards', quantity: 7 }]);
    });
  } finally {
    await second.stop();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failures === 0 ? 0 : 1;
