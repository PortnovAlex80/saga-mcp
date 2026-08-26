/**
 * canvas-game/verify/smoke.mjs - the browser smoke: serve the REAL game page
 * over loopback and verify the browser contract (canvas element, keyboard
 * wiring, deterministic core embedded in the asset), plus the game-core
 * oracle (src/game.mjs) driving the same chain the page drives.
 * Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, applyInput, tick, KEYS } from '../src/game.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

const server = createServer(async (request, response) => {
  const path = request.url === '/' ? 'public/index.html' : `public${request.url}`;
  try {
    const bytes = await readFile(join(ROOT, path));
    response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); process.stdout.write(`smoke ok: ${name}\n`); }
  catch (error) { failures += 1; process.stderr.write(`smoke FAIL: ${name}: ${error?.message ?? error}\n`); }
};

try {
  await check('the browser entry declares the canvas + score target', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<canvas id="board"/);
    assert.match(html, /id="score"/);
    assert.match(html, /src="\/game\.js"/);
  });
  await check('the game asset wires keyboard input + the deterministic core + the render loop', async () => {
    const js = await (await fetch(`${base}/game.js`)).text();
    assert.match(js, /addEventListener\('keydown'/);
    assert.match(js, /ArrowLeft/);
    assert.match(js, /requestAnimationFrame\(frame\)/);
    assert.match(js, /getElementById\('board'\)/);
    assert.match(js, /\* 37\) \+ 13\) % 100/, 'the asset embeds the deterministic respawn rule');
  });
  await check('the game-core oracle: collect -> score (the page renders this value)', async () => {
    let state = initialState();
    for (const key of [KEYS.left, KEYS.left, KEYS.left, KEYS.left, KEYS.up, KEYS.up, KEYS.up, KEYS.up]) state = applyInput(state, key);
    const collected = tick(state, 1);
    assert.equal(collected.score, 10);
    const again = tick(collected, 2);
    assert.equal(again.score, 10, 'no target reached on the second tick - no phantom score');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
process.exitCode = failures === 0 ? 0 : 1;
