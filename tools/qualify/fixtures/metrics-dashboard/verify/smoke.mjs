/**
 * metrics-dashboard/verify/smoke.mjs - the API + browser smoke: start the
 * REAL server, verify the deterministic metrics documents over sockets, the
 * read-only contract (writes refused 405), and the browser wiring.
 * Exit 0 = verified.
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
  await check('metrics documents are deterministic and consistent', async () => {
    const first = await (await fetch(`${server.base}/api/metrics`)).json();
    const second = await (await fetch(`${server.base}/api/metrics`)).json();
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.series.length, 31);
    const summary = await (await fetch(`${server.base}/api/metrics/summary`)).json();
    assert.equal(summary.totals.requests, first.totals.requests);
    assert.equal(summary.kind, 'metrics-dashboard.summary.v1');
  });
  await check('the read-only contract refuses writes', async () => {
    const post = await fetch(`${server.base}/api/metrics`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal((await post.json()).error, 'read-only');
  });
  await check('browser entry + dashboard wiring', async () => {
    const html = await (await fetch(`${server.base}/`)).text();
    assert.match(html, /id="summary"/);
    assert.match(html, /src="\/app\.js"/);
    const js = await (await fetch(`${server.base}/app.js`)).text();
    assert.match(js, /fetch\('\/api\/metrics\/summary'\)/);
    assert.match(js, /fetch\('\/api\/metrics'\)/);
  });
} finally {
  await server.stop();
}
process.exitCode = failures === 0 ? 0 : 1;
