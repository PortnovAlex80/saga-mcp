/**
 * md-site/verify/smoke.mjs - the generator + browser smoke: run the REAL
 * generator, then serve the generated site over loopback and verify the
 * browser entry contract (render target, headings, links, code blocks).
 * Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const generate = spawnSync(process.execPath, ['scripts/generate.mjs'], { cwd: ROOT, encoding: 'utf8' });
assert.equal(generate.status, 0, `generator failed: ${String(generate.stderr)}`);

const html = await readFile(join(ROOT, 'dist', 'index.html'), 'utf8');
assert.match(html, /id="md-root"/, 'the entry declares its render target');
assert.match(html, /<h1>md-site sample<\/h1>/);
assert.match(html, /<strong>deterministic<\/strong>/);
assert.match(html, /<a href="https:\/\/example\.com">links<\/a>/);
assert.match(html, /<pre><code>/);
assert.ok(!html.includes('<script'), 'the generated page is script-free static HTML');

/* Serve the generated site the way a static host would, over loopback. */
const server = createServer(async (request, response) => {
  if (request.url !== '/') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(await readFile(join(ROOT, 'dist', 'index.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const served = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  assert.equal(served, html, 'the served page equals the generated page');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
process.stdout.write('md-site smoke ok: generator + served static page render contract\n');
