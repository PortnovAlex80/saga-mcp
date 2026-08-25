/**
 * static-site/verify/structure.mjs - the STRUCTURE verification of the
 * static product: every declared surface exists, the entry references the
 * asset, the asset renders into the declared target. No server is started
 * (a static product has no runtime) - this is the honest static analogue
 * of the loopback hook. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
const js = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
const css = await readFile(join(ROOT, 'assets', 'style.css'), 'utf8');
const manifest = JSON.parse(await readFile(join(ROOT, 'dist', 'build-manifest.json'), 'utf8'));

assert.match(html, /id="static-root"/, 'the entry declares its render target');
assert.match(html, /src="\/app\.js"/, 'the entry references the asset');
assert.match(js, /getElementById\('static-root'\)/, 'the asset renders into the target');
assert.match(js, /\/assets\/style\.css/, 'the asset loads the stylesheet');
assert.match(css, /#static-root/, 'the stylesheet styles the target');
assert.equal(manifest.kind, 'static-site.build-manifest.v1');
assert.equal(manifest.inputs.length, 3, 'the manifest covers every declared surface');
process.stdout.write('static-site structure ok: entry, asset, stylesheet, manifest\n');
