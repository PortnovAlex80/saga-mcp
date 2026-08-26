/**
 * md-site/scripts/generate.mjs - the generator step: compiles content.md
 * into dist/index.html (the shippable static site). Deterministic.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../src/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = await readFile(join(ROOT, 'content.md'), 'utf8');
await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'index.html'), renderSite(markdown, 'md-site'), 'utf8');
process.stdout.write('md-site generated: dist/index.html\n');
