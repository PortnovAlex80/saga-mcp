/**
 * webhook-receiver/verify/smoke.mjs - the API smoke: start the REAL server,
 * deliver valid + invalid webhooks over actual sockets, and verify the
 * receiver's persisted state and typed refusals. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const server = await startServer();
try {
  await check('healthz', async () => {
    assert.deepEqual(await (await fetch(`${server.base}/healthz`)).json(), { status: 'ok' });
  });
  await check('valid webhooks are accepted 202 and persisted in order', async () => {
    const first = await fetch(`${server.base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'build.finished', source: 'ci.local', seq: 1, payload: { ok: true } }) });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: 1 });
    const second = await fetch(`${server.base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'deploy.started', source: 'ops.local', seq: 2 }) });
    assert.equal((await second.json()).accepted, 2);
    const listed = await (await fetch(`${server.base}/hooks`)).json();
    assert.equal(listed.count, 2);
    assert.deepEqual(listed.hooks.map((hook) => hook.event), ['build.finished', 'deploy.started']);
  });
  await check('invalid webhooks are refused 422 with typed errors; malformed JSON is 400', async () => {
    const refused = await fetch(`${server.base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: '', source: 'bad source!', seq: 0 }) });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).errors.length, 3);
    const malformed = await fetch(`${server.base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(malformed.status, 400);
    const still = await (await fetch(`${server.base}/hooks`)).json();
    assert.equal(still.count, 2, 'refused deliveries are never persisted');
  });
} finally {
  await server.stop();
}
process.exitCode = failures === 0 ? 0 : 1;
