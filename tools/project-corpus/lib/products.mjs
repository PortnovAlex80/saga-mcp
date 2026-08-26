/**
 * tools/project-corpus/lib/products.mjs - the hermetic product verification
 * of the project corpus (WP-13D): the simple-server pattern (build +
 * loopback over 127.0.0.1 + smoke) executed on a TEMP COPY of the product
 * fixture - never docker, never an external network, never a model call.
 *
 * Fixture families:
 *   - simple-server (the WP-08 canonical served product, reused read-only):
 *       build -> loopback (real server on an ephemeral port) -> smoke;
 *   - static-site (the corpus static product): build -> structure check ->
 *       build again (byte-identical digest = determinism);
 *   - batch-report (the corpus batch product): deterministic generator,
 *       built twice, digests must match.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOLS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = join(TOOLS_ROOT, '..', '..');
const CORPUS_FIXTURES = join(REPO_ROOT, 'tests', 'project-corpus', 'fixtures');
const SIMPLE_SERVER = join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server');

export const FIXTURE_ROOTS = {
  'simple-server': SIMPLE_SERVER,
  'static-site': join(CORPUS_FIXTURES, 'static-site'),
  'batch-report': join(CORPUS_FIXTURES, 'batch-report'),
};

/** A temp copy of one fixture (Windows-safe unique dir; caller disposes). */
export function stageFixtureWorkspace(fixture, prefix = 'ek-corpus-product-') {
  const root = FIXTURE_ROOTS[fixture];
  if (root === undefined) throw new Error(`unknown product fixture "${fixture}"`);
  const workspace = mkdtempSync(join(tmpdir(), `${prefix}${fixture}-`));
  cpSync(root, workspace, { recursive: true, force: true });
  return { workspace, dispose: () => rmSync(workspace, { recursive: true, force: true }) };
}

const runNode = (workspace, script, label) => {
  const result = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  return { label, code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const digestOf = (stdout) => {
  const match = /build: ([0-9a-f]{64})/.exec(stdout);
  return match === null ? undefined : match[1];
};

/**
 * Verify one product against its staged workspace. Returns
 * { ok, results, buildDigests, failure }.
 */
export function verifyProduct(product) {
  if (product.verification === 'none' || product.class === 'none') {
    return { ok: true, results: [], buildDigests: [], skipped: true };
  }
  const staged = stageFixtureWorkspace(product.fixture);
  try {
    const results = [];
    const buildDigests = [];
    if (product.verification === 'build-loopback-smoke') {
      const build = runNode(staged.workspace, 'scripts/build.mjs', 'build');
      results.push(build);
      buildDigests.push(digestOf(build.stdout));
      results.push(runNode(staged.workspace, 'verify/loopback.mjs', 'loopback'));
      results.push(runNode(staged.workspace, 'verify/browser-smoke.mjs', 'browser-smoke'));
    } else if (product.verification === 'build-structure-determinism') {
      const build1 = runNode(staged.workspace, 'scripts/build.mjs', 'build#1');
      results.push(build1);
      buildDigests.push(digestOf(build1.stdout));
      results.push(runNode(staged.workspace, 'verify/structure.mjs', 'structure'));
      const build2 = runNode(staged.workspace, 'scripts/build.mjs', 'build#2');
      results.push(build2);
      buildDigests.push(digestOf(build2.stdout));
    } else if (product.verification === 'build-determinism-replay') {
      const build1 = runNode(staged.workspace, 'scripts/build.mjs', 'build#1');
      results.push(build1);
      buildDigests.push(digestOf(build1.stdout));
      const build2 = runNode(staged.workspace, 'scripts/build.mjs', 'build#2');
      results.push(build2);
      buildDigests.push(digestOf(build2.stdout));
    } else {
      return { ok: false, results: [], buildDigests: [], failure: `unknown verification profile "${product.verification}"` };
    }
    const failing = results.filter((result) => result.code !== 0);
    return {
      ok: failing.length === 0 && buildDigests.every((digest) => digest !== undefined),
      results,
      buildDigests,
      failure: failing.length > 0 ? failing.map((result) => `${result.label}: ${result.stderr.trim() || result.stdout.trim()}`).join('; ') : undefined,
    };
  } finally {
    staged.dispose();
  }
}
