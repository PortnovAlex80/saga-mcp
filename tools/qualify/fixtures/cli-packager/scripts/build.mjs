/**
 * cli-packager/scripts/build.mjs - the deterministic build step: digests the
 * declared inputs into dist/build-manifest.json. Pure node:crypto/fs - no
 * toolchain, no network, byte-identical on re-run.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ["src/packager.mjs"];

const entries = [];
for (const rel of INPUTS) {
  const bytes = await readFile(join(ROOT, rel));
  entries.push({ path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
}
entries.sort((a, b) => (a.path < b.path ? -1 : 1));
const buildDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const manifest = { kind: 'cli-packager.build-manifest.v1', inputs: entries, buildDigest };

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write('cli-packager build: ' + buildDigest + '\n');
