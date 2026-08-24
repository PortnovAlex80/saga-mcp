#!/usr/bin/env node
// tools/build-receipt.mjs
//
// ADR-096 Phase 7 / W4 — the IMMUTABLE BUILD RECEIPT (qualification gate
// item 3 infrastructure: "one immutable build, different deterministic
// perturbation seeds, no source/package/capsule/DB/dist mutation between
// runs").
//
// One receipt binds, into a single verifiable artefact, the identity of a
// build the qualification runs must share:
//
//   - git HEAD SHA + a clean working tree (no uncommitted source mutation);
//   - the full `dist/` tree: sorted per-file sha256 + an aggregate tree hash;
//   - `package.json` + `package-lock.json` digests;
//   - the installed module-package digests from the content-addressed
//     package store, recomputed THE WAY THE RUNTIME COMPUTES THEM — via
//     `computePackageDigest`/`computeResourceDigest` imported from the built
//     `dist/process-modules/installation/domain/package-store.js` (the same
//     frozen formula as RuntimePackageFingerprint, ADR-077).
//
// Commands:
//   node tools/build-receipt.mjs --freeze [--root <dir>] [--package-store <dir>] [--out <dir>]
//   node tools/build-receipt.mjs --check  [--root <dir>] [--package-store <dir>] [--receipt <path-or-id>]
//
//   --freeze  assert `git status --porcelain` clean (untracked receipts under
//             docs/verification/build-receipt-*.json are tolerated — they ARE
//             the receipts), hash everything, write
//             `docs/verification/build-receipt-<receiptId12>.json` and print
//             the receipt id. Freezing is IDEMPOTENT and IMMUTABLE: a second
//             freeze of the same build reuses the existing file untouched; a
//             same-id file with different content is a hard error.
//   --check   recompute everything and diff against the frozen receipt with a
//             typed, per-item drift report (which file drifted, expected vs
//             actual). Exit 0 ONLY on exact match.
//
// `--root` makes the tool testable against a sandbox copy (the self-test
// never mutates the real dist). `--package-store` overrides the store root
// (default `<root>/.saga/package-store`, the production-install default).
//
// Exit codes: 0 = frozen/matched; 1 = typed failure (dirty tree, drift,
// inconsistent package store, missing inputs).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_KIND = 'saga-mcp.build-receipt';
const RECEIPT_VERSION = 1;
const RECEIPT_FILENAME_RE = /^build-receipt-([0-9a-f]{12})\.json$/;
/** Untracked artefacts exempt from the clean-tree assertion: the receipts themselves. */
const IGNORABLE_UNTRACKED_RE = /^docs\/verification\/build-receipt-[0-9a-f]{12}\.json$/;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

/** Deterministic, machine-independent JSON serialization (sorted keys). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function fail(code, detail) {
  process.stderr.write(`${code}: ${detail}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// git identity.
// ---------------------------------------------------------------------------

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/**
 * HEAD SHA + the non-ignorable porcelain entries (source-mutation evidence).
 * Untracked build receipts under docs/verification are ignorable by design;
 * everything else — modified, staged, deleted, or any other untracked file —
 * counts as a dirty tree.
 */
function collectGit(root) {
  const head = git(root, 'rev-parse', 'HEAD').trim();
  // -uall: never let git collapse an untracked directory to "?? docs/" — the
  // ignorable-receipt rule must see the full file path to judge it.
  const porcelain = git(root, 'status', '--porcelain', '-uall')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const dirty = porcelain.filter((line) => {
    const status = line.slice(0, 2);
    const entryPath = line.slice(3).trim();
    return !(status === '??' && IGNORABLE_UNTRACKED_RE.test(entryPath));
  });
  return { head, dirty };
}

// ---------------------------------------------------------------------------
// dist/ tree walk (pattern from tools/capture-run-snapshot.mjs, extended to
// an aggregate tree hash over the sorted per-file digests).
// ---------------------------------------------------------------------------

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push({ rel, abs: path.join(dir, entry.name) });
    }
    // Symlinks and other specials are refused: a receipt must not have
    // resolution ambiguity.
    else {
      throw new Error(`BUILD_RECEIPT_DIST_ENTRY_UNSUPPORTED: ${rel} is neither file nor directory`);
    }
  }
  return out;
}

function collectDist(root) {
  const distDir = path.join(root, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`BUILD_RECEIPT_NO_DIST: ${distDir} does not exist — run npm run build first`);
  }
  const files = walkFiles(distDir)
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ rel, abs }) => {
      const buf = readFileSync(abs);
      return { path: rel, bytes: buf.length, sha256: sha256Buffer(buf) };
    });
  if (files.length === 0) {
    throw new Error('BUILD_RECEIPT_DIST_EMPTY: dist/ contains no files — refusing a vacuous receipt');
  }
  const treeHasher = createHash('sha256');
  for (const f of files) treeHasher.update(`${f.path}\0${f.sha256}\n`);
  return {
    fileCount: files.length,
    treeHash: treeHasher.digest('hex'),
    files,
  };
}

// ---------------------------------------------------------------------------
// Package store enumeration — recomputed the way the runtime computes it.
// ---------------------------------------------------------------------------

let packageStoreHelpers = null;
async function loadPackageStoreHelpers() {
  if (packageStoreHelpers) return packageStoreHelpers;
  const modulePath = path.join(
    TOOL_REPO_ROOT,
    'dist',
    'process-modules',
    'installation',
    'domain',
    'package-store.js',
  );
  if (!existsSync(modulePath)) {
    throw new Error(
      `BUILD_RECEIPT_NO_DIST_HELPERS: ${modulePath} not found — run npm run build before freezing a receipt that covers a package store`,
    );
  }
  packageStoreHelpers = await import(pathToFileURL(modulePath).href);
  return packageStoreHelpers;
}

/** Mirror of the adapter's slugify (filesystem-package-store.ts). */
function slugifyLogicalId(logicalId) {
  return logicalId.replace(/[\\/]+/g, '__');
}

/**
 * Enumerate one content-addressed package directory:
 *   <digest>/manifest.json + resources/<slug> — recompute every resource
 *   digest from raw bytes and the package digest via the RUNTIME formula
 *   (computePackageDigest over the loaded manifest + verified blobs).
 */
async function inspectPackage(pkgDir) {
  const { computePackageDigest, computeResourceDigest } = await loadPackageStoreHelpers();
  const manifestPath = path.join(pkgDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`PACKAGE_STORE_CORRUPT: ${pkgDir} has no manifest.json`);
  }
  const manifestBuf = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const resourceIndex = Array.isArray(manifest?.resourceIndex) ? manifest.resourceIndex : [];
  const resourcesDir = path.join(pkgDir, 'resources');
  const blobs = [];
  for (const entry of resourceIndex) {
    const blobPath = path.join(resourcesDir, slugifyLogicalId(entry.logicalId));
    if (!existsSync(blobPath)) {
      throw new Error(`PACKAGE_STORE_CORRUPT: resource '${entry.logicalId}' missing in ${pkgDir}`);
    }
    const bytes = readFileSync(blobPath);
    blobs.push({ logicalId: entry.logicalId, kind: entry.kind, digest: computeResourceDigest(bytes) });
  }
  const recomputedDigest = computePackageDigest(manifest, blobs);
  return {
    digest: path.basename(pkgDir),
    recomputedDigest,
    selfConsistent: recomputedDigest === path.basename(pkgDir),
    moduleRef: manifest?.definition?.identity
      ? `${manifest.definition.identity.name}@${manifest.definition.identity.version}`
      : null,
    manifestSha256: sha256Buffer(manifestBuf),
    resourceCount: blobs.length,
  };
}

async function collectPackageStore(root, storeOverride) {
  const storeRoot = storeOverride ?? path.join(root, '.saga', 'package-store');
  if (!existsSync(storeRoot)) {
    return {
      root: storeRoot,
      present: false,
      packageCount: 0,
      packagesHash: sha256Buffer(Buffer.alloc(0)),
      packages: [],
    };
  }
  // Layout: <store>/<2hex>/<4hex>/<64hex-digest>/ (filesystem-package-store.ts).
  const packages = [];
  const digestShape = /^[0-9a-f]{64}$/;
  const twoLevel = readdirSync(storeRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name));
  for (const lvl2 of twoLevel) {
    const lvl2Path = path.join(storeRoot, lvl2.name);
    for (const lvl4 of readdirSync(lvl2Path, { withFileTypes: true })) {
      if (!lvl4.isDirectory() || !/^[0-9a-f]{4}$/.test(lvl4.name)) continue;
      const lvl4Path = path.join(lvl2Path, lvl4.name);
      for (const leaf of readdirSync(lvl4Path, { withFileTypes: true })) {
        if (!leaf.isDirectory()) continue;
        if (!digestShape.test(leaf.name)) {
          throw new Error(
            `PACKAGE_STORE_CORRUPT: package dir name '${leaf.name}' is not a 64-hex digest (${lvl4Path})`,
          );
        }
        packages.push(await inspectPackage(path.join(lvl4Path, leaf.name)));
      }
    }
  }
  packages.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const hasher = createHash('sha256');
  for (const p of packages) hasher.update(`${p.digest}\n`);
  return {
    root: storeRoot,
    present: true,
    packageCount: packages.length,
    packagesHash: hasher.digest('hex'),
    packages,
  };
}

// ---------------------------------------------------------------------------
// Identity + receipt.
// ---------------------------------------------------------------------------

function sourceFileDigest(root, name) {
  const file = path.join(root, name);
  if (!existsSync(file)) {
    throw new Error(`BUILD_RECEIPT_MISSING_INPUT: ${file} not found — a receipt covers source identity too`);
  }
  const buf = readFileSync(file);
  return { bytes: buf.length, sha256: sha256Buffer(buf) };
}

/**
 * The machine-independent build identity. Paths inside `dist` are POSIX
 * relative; the package-store LOCATION is recorded in the receipt for
 * provenance but excluded from the identity hash (it varies per host/DB);
 * the package DIGESTS are what the receipt pins.
 */
async function collectIdentity(root, storeOverride) {
  const gitInfo = collectGit(root);
  const dist = collectDist(root);
  const packageJson = sourceFileDigest(root, 'package.json');
  const packageLock = sourceFileDigest(root, 'package-lock.json');
  const packageStore = await collectPackageStore(root, storeOverride);
  const identity = {
    git: { head: gitInfo.head },
    source: {
      packageJsonSha256: packageJson.sha256,
      packageLockSha256: packageLock.sha256,
    },
    dist: {
      fileCount: dist.fileCount,
      treeHash: dist.treeHash,
      files: dist.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    },
    packageStore: {
      present: packageStore.present,
      packageCount: packageStore.packageCount,
      packagesHash: packageStore.packagesHash,
      packages: packageStore.packages.map((p) => ({
        digest: p.digest,
        recomputedDigest: p.recomputedDigest,
        selfConsistent: p.selfConsistent,
        moduleRef: p.moduleRef,
        manifestSha256: p.manifestSha256,
        resourceCount: p.resourceCount,
      })),
    },
  };
  return { identity, dirty: gitInfo.dirty, packageStoreRoot: packageStore.root };
}

function receiptIdOf(identity) {
  return createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 12);
}

function receiptsDir(root, outOverride) {
  return path.resolve(outOverride ?? path.join(root, 'docs', 'verification'));
}

function findLatestReceipt(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => RECEIPT_FILENAME_RE.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      let frozenAt = '';
      try {
        frozenAt = JSON.parse(readFileSync(file, 'utf8')).frozenAt ?? '';
      } catch {
        frozenAt = '';
      }
      return { file, name, frozenAt };
    })
    .sort((a, b) => (a.frozenAt < b.frozenAt ? -1 : a.frozenAt > b.frozenAt ? 1 : a.name < b.name ? -1 : 1));
  return candidates.length > 0 ? candidates[candidates.length - 1].file : null;
}

function loadReceipt(ref, dir) {
  let file = null;
  if (ref) {
    file = existsSync(ref) ? path.resolve(ref) : path.join(dir, `build-receipt-${ref}.json`);
  } else {
    file = findLatestReceipt(dir);
  }
  if (!file || !existsSync(file)) {
    fail('BUILD_RECEIPT_NOT_FOUND', `no build receipt at ${file ?? `${dir}/build-receipt-<id>.json`} — freeze first (--freeze)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail('BUILD_RECEIPT_UNREADABLE', `${file}: ${e.message}`);
  }
  if (parsed.receiptKind !== RECEIPT_KIND || parsed.receiptVersion !== RECEIPT_VERSION) {
    fail('BUILD_RECEIPT_UNREADABLE', `${file}: not a ${RECEIPT_KIND} v${RECEIPT_VERSION} document`);
  }
  return { file, receipt: parsed };
}

// ---------------------------------------------------------------------------
// freeze.
// ---------------------------------------------------------------------------

async function cmdFreeze(root, storeOverride, outOverride) {
  const collected = await collectIdentity(root, storeOverride).catch((e) => {
    const code = /^[A-Z][A-Z_]+:$/.exec(`${e.message.split(':')[0]}:`)
      ? e.message.split(':')[0]
      : 'BUILD_RECEIPT_FREEZE_FAILED';
    fail(code, e.message);
    return null;
  });
  const { identity, dirty, packageStoreRoot } = collected;

  if (dirty.length > 0) {
    fail(
      'BUILD_RECEIPT_DIRTY_TREE',
      `working tree is not clean (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'}): `
        + dirty.map((l) => l.trim()).join(' | ')
        + ' — commit or stash before freezing an immutable receipt',
    );
  }
  const inconsistent = identity.packageStore.packages.filter((p) => !p.selfConsistent);
  if (inconsistent.length > 0) {
    fail(
      'BUILD_RECEIPT_PACKAGE_STORE_INCONSISTENT',
      `${inconsistent.length} package(s) fail the runtime digest recomputation: `
        + inconsistent.map((p) => `${p.digest} (recomputed ${p.recomputedDigest})`).join(', '),
    );
  }

  const receiptId = receiptIdOf(identity);
  const outDir = receiptsDir(root, outOverride);
  mkdirSync(outDir, { recursive: true });
  const receiptPath = path.join(outDir, `build-receipt-${receiptId}.json`);

  if (existsSync(receiptPath)) {
    // Immutability: the FIRST freeze of a build wins. A same-id file whose
    // recorded identity differs from what we just recomputed is tampering.
    const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (canonicalJson(existing.identity) !== canonicalJson(identity)) {
      fail(
        'BUILD_RECEIPT_IMMUTABLE_VIOLATION',
        `${receiptPath} already exists with the same id but a DIFFERENT recorded identity — the receipt is immutable; investigate, never edit it`,
      );
    }
    process.stdout.write(`BUILD RECEIPT ALREADY FROZEN ${receiptId} (immutable): ${receiptPath}\n`);
    return;
  }

  const receipt = {
    receiptKind: RECEIPT_KIND,
    receiptVersion: RECEIPT_VERSION,
    receiptId,
    frozenAt: new Date().toISOString(),
    root: path.resolve(root),
    packageStoreRoot: path.resolve(packageStoreRoot),
    identity,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `BUILD RECEIPT FROZEN ${receiptId}\n`
    + `  file: ${receiptPath}\n`
    + `  head: ${identity.git.head}\n`
    + `  dist: ${identity.dist.fileCount} files, tree ${identity.dist.treeHash.slice(0, 12)}\n`
    + `  package.json ${identity.source.packageJsonSha256.slice(0, 12)} / package-lock ${identity.source.packageLockSha256.slice(0, 12)}\n`
    + `  package-store: ${identity.packageStore.present ? `${identity.packageStore.packageCount} package(s), hash ${identity.packageStore.packagesHash.slice(0, 12)}` : 'absent (none at recorded root)'}\n`,
  );
}

// ---------------------------------------------------------------------------
// check — typed drift diff.
// ---------------------------------------------------------------------------

function diffIdentity(receiptIdentity, currentIdentity, dirty) {
  const drifts = [];

  if (receiptIdentity.git.head !== currentIdentity.git.head) {
    drifts.push({
      kind: 'git-head',
      detail: `expected HEAD ${receiptIdentity.git.head}, observed ${currentIdentity.git.head}`,
    });
  }
  for (const line of dirty) {
    drifts.push({ kind: 'tree-dirty', detail: `uncommitted working-tree change: ${line.trim()}` });
  }
  if (receiptIdentity.source.packageJsonSha256 !== currentIdentity.source.packageJsonSha256) {
    drifts.push({
      kind: 'package-json',
      detail: `package.json sha256 expected ${receiptIdentity.source.packageJsonSha256}, observed ${currentIdentity.source.packageJsonSha256}`,
    });
  }
  if (receiptIdentity.source.packageLockSha256 !== currentIdentity.source.packageLockSha256) {
    drifts.push({
      kind: 'package-lock',
      detail: `package-lock.json sha256 expected ${receiptIdentity.source.packageLockSha256}, observed ${currentIdentity.source.packageLockSha256}`,
    });
  }

  // dist tree diff — name exactly which file drifted.
  const expectedFiles = new Map(receiptIdentity.dist.files.map((f) => [f.path, f.sha256]));
  const observedFiles = new Map(currentIdentity.dist.files.map((f) => [f.path, f.sha256]));
  for (const [p] of observedFiles) {
    if (!expectedFiles.has(p)) drifts.push({ kind: 'dist-added', detail: `dist file added: dist/${p}` });
  }
  for (const [p] of expectedFiles) {
    if (!observedFiles.has(p)) drifts.push({ kind: 'dist-removed', detail: `dist file removed: dist/${p}` });
  }
  for (const [p, expectedSha] of expectedFiles) {
    const observedSha = observedFiles.get(p);
    if (observedSha !== undefined && observedSha !== expectedSha) {
      drifts.push({
        kind: 'dist-modified',
        detail: `dist file drifted: dist/${p} sha256 expected ${expectedSha}, observed ${observedSha}`,
      });
    }
  }

  // package store diff.
  const expectedPkgs = new Map(receiptIdentity.packageStore.packages.map((p) => [p.digest, p]));
  const observedPkgs = new Map(currentIdentity.packageStore.packages.map((p) => [p.digest, p]));
  if (receiptIdentity.packageStore.present && !currentIdentity.packageStore.present) {
    drifts.push({ kind: 'package-store-missing', detail: 'receipt covered a package store, none present now' });
  }
  if (!receiptIdentity.packageStore.present && currentIdentity.packageStore.present) {
    drifts.push({ kind: 'package-store-added', detail: 'a package store appeared where the receipt covered none' });
  }
  for (const [digest] of observedPkgs) {
    if (!expectedPkgs.has(digest)) drifts.push({ kind: 'package-store-added', detail: `package added: ${digest}` });
  }
  for (const [digest] of expectedPkgs) {
    if (!observedPkgs.has(digest)) drifts.push({ kind: 'package-store-removed', detail: `package removed: ${digest}` });
  }
  for (const [digest, observed] of observedPkgs) {
    const expected = expectedPkgs.get(digest);
    if (expected && (!observed.selfConsistent || canonicalJson(expected) !== canonicalJson(observed))) {
      drifts.push({
        kind: 'package-store-modified',
        detail: `package content drifted: ${digest}`
          + (observed.selfConsistent ? '' : ` (recomputed digest ${observed.recomputedDigest} ≠ address)`),
      });
    }
  }
  return drifts;
}

async function cmdCheck(root, storeOverride, receiptRef) {
  const { file, receipt } = loadReceipt(receiptRef, receiptsDir(root, undefined));
  let collected;
  try {
    collected = await collectIdentity(root, storeOverride);
  } catch (e) {
    fail('BUILD_RECEIPT_CHECK_FAILED', `${e.message} (receipt under check: ${file})`);
  }
  const { identity, dirty } = collected;
  const drifts = diffIdentity(receipt.identity, identity, dirty);
  if (receiptIdOf(identity) !== receipt.receiptId) {
    drifts.push({
      kind: 'receipt-id',
      detail: `recomputed receipt id ${receiptIdOf(identity)} ≠ frozen ${receipt.receiptId}`,
    });
  }

  if (drifts.length > 0) {
    process.stderr.write(`BUILD RECEIPT DRIFT: ${file} does NOT match the current build (${drifts.length} drift item(s))\n`);
    for (const d of drifts) {
      process.stderr.write(`BUILD_RECEIPT_DRIFT[${d.kind}] ${d.detail}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `BUILD RECEIPT MATCH ${receipt.receiptId}\n`
    + `  head ${identity.git.head} | dist ${identity.dist.fileCount} files (tree ${identity.dist.treeHash.slice(0, 12)}) | `
    + `package-store ${identity.packageStore.packageCount} package(s)\n`,
  );
}

// ---------------------------------------------------------------------------
// main.
// ---------------------------------------------------------------------------

async function main() {
  const freeze = hasFlag('freeze');
  const check = hasFlag('check');
  if (freeze === check) {
    process.stderr.write(
      'usage: node tools/build-receipt.mjs --freeze [--root <dir>] [--package-store <dir>] [--out <dir>]\n'
      + '       node tools/build-receipt.mjs --check  [--root <dir>] [--package-store <dir>] [--receipt <path-or-id>]\n',
    );
    process.exit(1);
  }
  const root = path.resolve(arg('root', TOOL_REPO_ROOT));
  if (!existsSync(root)) fail('BUILD_RECEIPT_ROOT_NOT_FOUND', root);
  if (freeze) {
    await cmdFreeze(root, arg('package-store'), arg('out'));
  } else {
    await cmdCheck(root, arg('package-store'), arg('receipt'));
  }
}

main().catch((e) => {
  process.stderr.write(`BUILD_RECEIPT_UNEXPECTED: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
