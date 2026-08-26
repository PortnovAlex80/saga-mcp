/**
 * tools/qualify/lib/fences.mjs - the qualification fences (WP-15, plan
 * EK-11): the dirty-tree fence, the dist fence, the fresh-path fence and the
 * build-addressed evidence writer. Every qualify:* driver refuses to start
 * unless every fence holds; failures are typed, never silent.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
export const EVIDENCE_ROOT_DEFAULT = 'D:/Development/ek-qual-evidence';

/** Untracked artefacts exempt from the clean-tree fence: the qualification
 *  documents themselves (kit manifests + series result manifests under
 *  docs/refactoring/event-kernel/qualification/) - the same rule
 *  tools/build-receipt.mjs applies to its receipts. */
export const IGNORABLE_UNTRACKED_RE = /^docs\/refactoring\/event-kernel\/qualification\/[A-Za-z0-9._\/-]+$/;

/* ------------------------------------------------------------------ */
/* Canonical JSON + digests                                            */
/* ------------------------------------------------------------------ */

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export const sha256Of = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/* ------------------------------------------------------------------ */
/* The dirty-tree fence                                                */
/* ------------------------------------------------------------------ */

export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

/** HEAD SHA + the non-ignorable porcelain entries of one root. */
export function collectTree(root = REPO_ROOT) {
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const porcelain = git(root, 'status', '--porcelain', '-uall').split(/\r?\n/).filter((line) => line.trim() !== '');
  const dirty = porcelain.filter((line) => {
    const status = line.slice(0, 2);
    const entryPath = line.slice(3).trim();
    return !(status === '??' && IGNORABLE_UNTRACKED_RE.test(entryPath));
  });
  return { head, dirty, clean: dirty.length === 0 };
}

/** The dirty-tree fence: refuse (typed) unless the tree is clean. */
export function assertCleanTree(root = REPO_ROOT) {
  const tree = collectTree(root);
  if (!tree.clean) {
    throw Object.assign(
      new Error(`QUALIFY_DIRTY_TREE: the working tree has ${tree.dirty.length} uncommitted entr${tree.dirty.length === 1 ? 'y' : 'ies'}: ${tree.dirty.map((line) => line.trim()).join(' | ')} - commit or stash before qualifying (the kit must freeze one immutable source)`),
      { code: 'QUALIFY_DIRTY_TREE', entries: tree.dirty },
    );
  }
  return tree;
}

/* ------------------------------------------------------------------ */
/* The dist fence                                                      */
/* ------------------------------------------------------------------ */

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push({ rel, abs: join(dir, entry.name) });
    else throw new Error(`QUALIFY_DIST_ENTRY_UNSUPPORTED: ${rel} is neither file nor directory`);
  }
  return out;
}

/** The deterministic dist tree hash (sorted per-file digests; same rule as
 *  tools/build-receipt.mjs). */
export function distTreeHash(root = REPO_ROOT) {
  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) {
    throw Object.assign(new Error('QUALIFY_NO_DIST: dist/ does not exist - run npm run build first'), { code: 'QUALIFY_NO_DIST' });
  }
  const files = walkFiles(distDir)
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
    .map(({ rel, abs }) => ({ path: rel, sha256: sha256File(abs) }));
  if (files.length === 0) {
    throw Object.assign(new Error('QUALIFY_DIST_EMPTY: dist/ contains no files'), { code: 'QUALIFY_DIST_EMPTY' });
  }
  const hasher = createHash('sha256');
  for (const file of files) hasher.update(`${file.path}\0${file.sha256}\n`);
  return { fileCount: files.length, treeHash: hasher.digest('hex'), files };
}

/** The dist fence: the live dist tree must equal the recorded one. */
export function assertDistMatches(expected, root = REPO_ROOT) {
  const observed = distTreeHash(root);
  if (observed.fileCount !== expected.fileCount || observed.treeHash !== expected.treeHash) {
    const expectedFiles = new Map(expected.files.map((file) => [file.path, file.sha256]));
    const observedFiles = new Map(observed.files.map((file) => [file.path, file.sha256]));
    const drift = [];
    for (const [path] of observedFiles) if (!expectedFiles.has(path)) drift.push(`dist/${path} added`);
    for (const [path] of expectedFiles) if (!observedFiles.has(path)) drift.push(`dist/${path} removed`);
    for (const [path, sha] of expectedFiles) if (observedFiles.get(path) !== undefined && observedFiles.get(path) !== sha) drift.push(`dist/${path} modified`);
    throw Object.assign(
      new Error(`QUALIFY_DIST_MISMATCH: the live dist tree does not match the kit build (${drift.length} drift item(s): ${drift.slice(0, 5).join('; ')}${drift.length > 5 ? '; …' : ''}) - rebuild from the kit's exact source`),
      { code: 'QUALIFY_DIST_MISMATCH', drift },
    );
  }
  return observed;
}

/* ------------------------------------------------------------------ */
/* The fresh-path fence                                                */
/* ------------------------------------------------------------------ */

/** A path that MUST NOT exist yet (a reused path refuses; the driver never
 *  resumes into a previous run's state). */
export function assertFreshPath(path, what = 'path') {
  if (existsSync(path)) {
    throw Object.assign(
      new Error(`QUALIFY_PATH_NOT_FRESH: ${what} ${path} already exists - qualification runs always start from fresh paths (never a reused database/repository); pass a new series id`),
      { code: 'QUALIFY_PATH_NOT_FRESH', path },
    );
  }
  return path;
}

/** Create a fresh directory (refuses an existing one). */
export function freshDir(path, what = 'directory') {
  assertFreshPath(path, what);
  mkdirSync(path, { recursive: true });
  return path;
}

/* ------------------------------------------------------------------ */
/* The build-addressed evidence writer                                 */
/* ------------------------------------------------------------------ */

/** Hash every file under a directory (sorted, POSIX-relative) into one
 *  manifest. Returns { files, treeHash } without writing. */
export function hashTree(dir) {
  const files = [];
  const walk = (current, prefix = '') => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push({ path: rel, bytes: statSync(abs).size, sha256: sha256File(abs) });
    }
  };
  walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const hasher = createHash('sha256');
  for (const file of files) hasher.update(`${file.path}\0${file.sha256}\n`);
  return { files, treeHash: hasher.digest('hex') };
}

/** Write one evidence file (JSON) under an evidence directory. */
export function writeEvidence(dir, name, value) {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/** Finalize one run/series evidence directory: hash the tree, write
 *  evidence-manifest.json, return the manifest digest. The manifest lists
 *  every file EXCEPT itself (the digest covers the evidence, never its own
 *  manifest bytes). */
export function sealEvidence(dir) {
  const { files, treeHash } = hashTree(dir);
  const manifest = {
    kind: 'ek-qualify.evidence-manifest.v1',
    dir: dir.replaceAll('\\', '/'),
    fileCount: files.length,
    treeHash,
    files,
  };
  writeFileSync(join(dir, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { treeHash, fileCount: files.length, manifestPath: join(dir, 'evidence-manifest.json') };
}

/** The evidence root of one series: <root>/<kitId>/<series>/ (fresh). */
export function seriesEvidenceRoot(kitId, seriesId, override) {
  const base = resolve(override ?? process.env.EK_QUALIFY_EVIDENCE_ROOT ?? EVIDENCE_ROOT_DEFAULT);
  return freshDir(join(base, kitId, seriesId), 'series evidence root');
}

/** Record the environment block every kit/series manifest carries. */
export async function environmentBlock() {
  const os = await import('node:os');
  let npmVersion = 'unknown';
  try { npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* keep unknown */ }
  const sagaEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('SAGA_') || key.startsWith('EK_QUALIFY'))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    node: process.version,
    npm: npmVersion,
    env: sagaEnv,
    cwd: process.cwd().replaceAll('\\', '/'),
  };
}

/** Relative-to-repo display helper. */
export const relToRepo = (path) => relative(REPO_ROOT, path).replaceAll('\\', '/');
