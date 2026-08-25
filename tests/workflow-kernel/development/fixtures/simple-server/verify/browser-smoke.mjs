/**
 * simple-server/verify/browser-smoke.mjs - the real-browser smoke hook.
 *
 * Layer 1 (always): serves the product and verifies over real HTTP that the
 * browser entry, assets and API satisfy the render contract a browser will
 * execute (entry references asset; asset fetches the API; deterministic
 * value shape; rendered target element present).
 *
 * Layer 2 (operator-driven REAL browser): when SMOKE_BASE_URL is set, a real
 * browser session drives the entry and asserts the rendered DOM text. The
 * main agent's browser-use capability runs this hook; the HTTP layer below
 * is the fallback verification, never a replacement.
 */
import assert from 'node:assert/strict';
import { createApp, deterministicMessage } from '../src/server.js';

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address();
const base = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${port}`;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    process.stdout.write(`smoke ok: ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`smoke FAIL: ${name}: ${error?.message ?? error}\n`);
  }
};

try {
  await check('browser entry served with render target', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /id="message"/);
  });
  await check('frontend asset served and wired to the API', async () => {
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.match(js, /fetch\('\/api\/message'\)/);
    assert.match(js, /getElementById\('message'\)/);
  });
  await check('the API value a real browser will render is deterministic', async () => {
    const payload = await (await fetch(`${base}/api/message`)).json();
    assert.deepEqual(payload, deterministicMessage());
  });
  await check('the expected rendered DOM text is derivable (operator real-browser oracle)', async () => {
    const payload = deterministicMessage();
    const expected = `${payload.message} (code ${payload.code})`;
    assert.equal(expected, 'hello from simple-server (code 7)');
  });
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
}
// exitCode (never process.exit): the undici dispatcher tears down its async
// handles during natural exit; a forced exit trips a libuv assertion.
process.exitCode = failures === 0 ? 0 : 1;
