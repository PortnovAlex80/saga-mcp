/**
 * import-export/scripts/package.mjs - the LOCAL packaging/delivery input:
 * assembles delivery/package-input.json (the exact bytes + digests the
 * delivery stage consumes) into delivery/bundle/. No external deployment,
 * no registry, no network.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ["src/server.mjs"];

const entries = [];
for (const rel of INPUTS) {
  const bytes = await readFile(join(ROOT, rel));
  entries.push({ path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const bundleDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const input = { kind: 'import-export.delivery-input.v1', entries, bundleDigest, externalDeployment: false };

await mkdir(join(ROOT, 'delivery', 'bundle'), { recursive: true });
for (const entry of entries) {
  await copyFile(join(ROOT, entry.path), join(ROOT, 'delivery', 'bundle', entry.path.replaceAll('/', '__')));
}
await writeFile(join(ROOT, 'delivery', 'package-input.json'), JSON.stringify(input, null, 2) + '\n');
process.stdout.write('import-export package: ' + bundleDigest + '\n');
