/**
 * cli-packager/src/packager.mjs - the local release packager (plan EK-11
 * P16): assembles a versioned release bundle from the declared inputs and
 * writes an IDEMPOTENT effect receipt - running the packager twice over the
 * same tree produces the SAME receipt digest and never double-applies (the
 * second run is a no-op replay of the first effect).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INPUTS = ['src/packager.mjs', 'product.json', 'package.json'];

/** Package one tree; returns the effect receipt. */
export function packageRelease(root = ROOT) {
  const entries = INPUTS.map((rel) => {
    const bytes = readFileSync(join(root, rel));
    return { path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  const bundleDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const receiptFile = join(root, 'release', 'receipt.json');
  const receipt = {
    kind: 'cli-packager.effect-receipt.v1',
    inputs: entries,
    bundleDigest,
    externalPublication: false,
  };
  const canonical = (value) => JSON.stringify(value, null, 2) + '\n';

  /* The idempotency law: an existing receipt for the SAME bundle digest is
     replayed untouched (no second effect, no timestamp drift); a DIFFERENT
     digest for the same tree is refused (never silently re-packaged). */
  if (existsSync(receiptFile)) {
    const previous = JSON.parse(readFileSync(receiptFile, 'utf8'));
    if (previous.bundleDigest === receipt.bundleDigest) {
      return { effect: 'replayed', receipt: previous, unchanged: true };
    }
    return { effect: 'refused', reason: 'tree-changed-under-existing-receipt', previousDigest: previous.bundleDigest, digest: bundleDigest };
  }

  mkdirSync(join(root, 'release', 'bundle'), { recursive: true });
  for (const entry of entries) {
    copyFileSync(join(root, entry.path), join(root, 'release', 'bundle', entry.path.replaceAll('/', '__')));
  }
  writeFileSync(receiptFile, canonical(receipt), 'utf8');
  return { effect: 'packaged', receipt, unchanged: false };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = packageRelease(process.argv[2] !== undefined ? resolve(process.argv[2]) : ROOT);
  if (result.effect === 'refused') {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }
  process.stdout.write(`cli-packager ${result.effect}: ${result.receipt.bundleDigest}\n`);
}
