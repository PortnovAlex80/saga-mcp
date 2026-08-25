/**
 * simple-server/verify/loopback.mjs - the loopback HTTP verification hook:
 * starts the REAL server on an ephemeral port and exercises every contract
 * surface over an actual socket, including the frontend integration fetch.
 * Exit 0 = verified; any mismatch exits 1 with the failing surface.
 */
import assert from 'node:assert/strict';
import { createApp, deterministicMessage } from '../src/server.js';

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    process.stdout.write(`loopback ok: ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`loopback FAIL: ${name}: ${error?.message ?? error}\n`);
  }
};

try {
  await check('/healthz returns ok', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
  await check('/api/message returns the deterministic JSON', async () => {
    const response = await fetch(`${base}/api/message`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), deterministicMessage());
  });
  await check('browser entry is served and references the frontend asset', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="message"/);
    assert.match(html, /src="\/app\.js"/);
  });
  await check('the frontend asset is served and fetches the API into the render target', async () => {
    const response = await fetch(`${base}/app.js`);
    assert.equal(response.status, 200);
    const js = await response.text();
    assert.match(js, /fetch\('\/api\/message'\)/);
    assert.match(js, /getElementById\('message'\)/);
  });
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
}
// exitCode (never process.exit): the undici dispatcher tears down its async
// handles during natural exit; a forced exit trips a libuv assertion.
process.exitCode = failures === 0 ? 0 : 1;
