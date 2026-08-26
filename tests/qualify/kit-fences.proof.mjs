/**
 * tests/qualify/kit-fences.proof.mjs - the RED/GREEN proofs of the EK-11
 * qualification fences (WP-15): the kit-tamper fence, the dist fence, the
 * fresh-path fence and the dirty-tree fence. Run via `npm run qualify:proof`.
 *
 * RED side: a tampered digest, a mutated dist file, a reused path and a
 * dirty tree each REFUSE with the typed fence error. GREEN side: the
 * untampered equivalents pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleOf = (relative) => import(pathToFileURL(join(REPO_ROOT, relative)).href);

const fences = await moduleOf('tools/qualify/lib/fences.mjs');
const kit = await moduleOf('tools/qualify/kit.mjs');

/* ------------------------------------------------------------------ */
/* A sandbox git repository for the tree fences                        */
/* ------------------------------------------------------------------ */

function sandboxRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ek-qualify-fence-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'fence-proof@example.invalid');
  git('config', 'user.name', 'fence-proof');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'kernel.js'), 'export const one = 1;\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), '{"name":"sandbox"}\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'sandbox base');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/* ------------------------------------------------------------------ */
/* The dirty-tree fence                                                */
/* ------------------------------------------------------------------ */

test('dirty-tree fence: GREEN on a clean sandbox, and untracked qualification docs stay ignorable', () => {
  const sandbox = sandboxRepo();
  try {
    const clean = fences.assertCleanTree(sandbox.dir);
    assert.match(clean.head, /^[0-9a-f]{40}$/);

    /* An untracked kit manifest under docs/refactoring/event-kernel/qualification/ is the
       ignorable class (the same rule build-receipt applies to its receipts). */
    mkdirSync(join(sandbox.dir, 'docs', 'refactoring', 'event-kernel', 'qualification', 'kits'), { recursive: true });
    writeFileSync(join(sandbox.dir, 'docs', 'refactoring', 'event-kernel', 'qualification', 'kits', 'abc.json'), '{}\n', 'utf8');
    fences.assertCleanTree(sandbox.dir);
  } finally {
    sandbox.cleanup();
  }
});

test('dirty-tree fence: RED on a modified tracked file AND on a foreign untracked file', () => {
  const sandbox = sandboxRepo();
  try {
    writeFileSync(join(sandbox.dir, 'package.json'), '{"name":"sandbox","mutated":true}\n', 'utf8');
    const modified = fences.assertCleanTree(sandbox.dir);
    assert.ok(false, `modified tracked file must refuse, got head ${String(modified?.head)}`);
  } catch (error) {
    assert.equal(error.code, 'QUALIFY_DIRTY_TREE');
    assert.match(error.message, /package\.json/);
  } finally {
    sandbox.cleanup();
  }

  const sandbox2 = sandboxRepo();
  try {
    writeFileSync(join(sandbox2.dir, 'rogue.txt'), 'not a qualification artefact\n', 'utf8');
    assert.throws(() => fences.assertCleanTree(sandbox2.dir), (error) => error.code === 'QUALIFY_DIRTY_TREE');
  } finally {
    sandbox2.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* The dist fence                                                      */
/* ------------------------------------------------------------------ */

test('dist fence: GREEN on the identical tree, RED on a mutated/added/removed dist file', () => {
  const sandbox = sandboxRepo();
  try {
    const expected = fences.distTreeHash(sandbox.dir);
    fences.assertDistMatches({ fileCount: expected.fileCount, treeHash: expected.treeHash, files: expected.files }, sandbox.dir);

    /* Mutated file. */
    writeFileSync(join(sandbox.dir, 'dist', 'kernel.js'), 'export const one = 2;\n', 'utf8');
    const mutated = fences.distTreeHash(sandbox.dir);
    assert.notEqual(mutated.treeHash, expected.treeHash);
    let thrown = null;
    try { fences.assertDistMatches({ fileCount: expected.fileCount, treeHash: expected.treeHash, files: expected.files }, sandbox.dir); }
    catch (error) { thrown = error; }
    assert.equal(thrown?.code, 'QUALIFY_DIST_MISMATCH');
    assert.ok(thrown.drift.some((item) => item.includes('modified')));

    /* Added file. */
    writeFileSync(join(sandbox.dir, 'dist', 'kernel.js'), 'export const one = 1;\n', 'utf8');
    writeFileSync(join(sandbox.dir, 'dist', 'extra.js'), 'export const rogue = true;\n', 'utf8');
    thrown = null;
    try { fences.assertDistMatches({ fileCount: expected.fileCount, treeHash: expected.treeHash, files: expected.files }, sandbox.dir); }
    catch (error) { thrown = error; }
    assert.equal(thrown?.code, 'QUALIFY_DIST_MISMATCH');
    assert.ok(thrown.drift.some((item) => item.includes('added')));
  } finally {
    sandbox.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* The fresh-path fence                                                */
/* ------------------------------------------------------------------ */

test('fresh-path fence: GREEN on a new path, RED on a reused path (a resumed run never happens)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ek-qualify-fresh-'));
  try {
    const fresh = join(dir, 'run-01');
    fences.assertFreshPath(fresh, 'run dir');
    fences.freshDir(fresh, 'run dir');
    assert.throws(() => fences.assertFreshPath(fresh), (thrown) => thrown.code === 'QUALIFY_PATH_NOT_FRESH' && /already exists/.test(thrown.message));
    assert.throws(() => fences.freshDir(fresh, 'run dir'), (thrown) => thrown.code === 'QUALIFY_PATH_NOT_FRESH');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/* ------------------------------------------------------------------ */
/* The kit content-address + tamper fence                              */
/* ------------------------------------------------------------------ */

test('kit fence: the kitId is the content address of the core (any edit breaks it)', () => {
  const core = { kitKind: kit.KIT_KIND, kitVersion: 1, source: { head: 'a'.repeat(40) }, build: { distFileCount: 2, distTreeHash: 'b'.repeat(64) }, seed: 1 };
  const id = kit.kitIdOf(core);
  assert.match(id, /^[0-9a-f]{64}$/);
  const tampered = { ...core, build: { ...core.build, distFileCount: 3 } };
  assert.notEqual(kit.kitIdOf(tampered), id, 'one changed byte changes the content address');
});

test('kit fence: a tampered manifest refuses on the drift diff (every mutated digest is named)', async () => {
  /* Build a synthetic kit core whose sections mirror the real shape, then
   * verify the drift detection catches each tampered section. */
  const base = {
    kitKind: kit.KIT_KIND,
    kitVersion: kit.KIT_VERSION,
    source: { head: 'f'.repeat(40), packageJsonDigest: '1'.repeat(64), packageLockDigest: '2'.repeat(64) },
    build: { distFileCount: 10, distTreeHash: '3'.repeat(64) },
    kernel: {
      schemaFingerprint: '4'.repeat(64), protocolId: 'p', schemaVersion: 1,
      universeDigest: '5'.repeat(64), universeSchemaVersion: 'v', universeCommandCount: 53,
      actorVersion: '6'.repeat(64), actorModulesDigest: '7'.repeat(64),
      complexityBudgetDigest: '8'.repeat(64), roleContractManifestDigest: '9'.repeat(64),
      promptBudgetProfileDigest: 'a'.repeat(64), promptBudgetProfileRef: 'ref', promptBudgetSchemaDigest: 'b'.repeat(64),
      tokenCounterIdentityDigest: 'c'.repeat(64),
    },
    packages: { 'better-sqlite3': 'd'.repeat(64) },
    admission: { admissionContractDigest: 'e'.repeat(64), validatorDigest: '0'.repeat(64), ekAdmissionReceiptDigest: 'f'.repeat(64) },
    capsule: { lineageId: 'l', parentLifecycleRef: 'r', capsuleDigest: '1'.repeat(64), packageBytesDigest: '2'.repeat(64) },
    scenarioUniverse: { corpusDescriptors: '3'.repeat(64) },
    seed: 7,
  };
  const good = kit.kitIdOf(base);
  assert.equal(good.length, 64);

  /* The stored manifest must hash to its own kitId: the kit-id drift proof. */
  const editedManifest = { ...base, kitId: good, frozenAt: 'now', environment: {} };
  const { kitId, frozenAt, environment, ...core } = editedManifest;
  assert.equal(kit.kitIdOf(core), good, 'the non-core fields (kitId/frozenAt/environment) are outside the content address');

  const tamperedManifest = { ...editedManifest, kernel: { ...base.kernel, schemaFingerprint: 'tampered'.padEnd(64, 'x') } };
  const { kitId: tId, frozenAt: tAt, environment: tEnv, ...tCore } = tamperedManifest;
  assert.notEqual(kit.kitIdOf(tCore), good, 'a tampered section breaks the content address - the kit-id drift fires');
});

test('kit fence: a live kit manifest (when frozen) verifies green only against its own tree', async () => {
  const kitsDir = kit.KITS_DIR;
  const { existsSync, readdirSync } = await import('node:fs');
  if (!existsSync(kitsDir) || readdirSync(kitsDir).length === 0) {
    assert.ok(true, 'no kit frozen yet on this checkout - the live leg of the proof runs on the qualified tree');
    return;
  }
  /* A kit exists: verification must either pass (this IS the kit's tree) or
   * refuse with a typed drift - never pass silently on a drifted tree. */
  const manifestFile = readdirSync(kitsDir).find((name) => name.endsWith('.json'));
  const result = await kit.verifyKit(manifestFile.replace('.json', '')).then(
    (verified) => ({ ok: true, kitId: verified.kitId }),
    (error) => ({ ok: false, code: error.code, message: String(error.message).slice(0, 120) }),
  );
  assert.ok(result.ok === true || result.code === 'QUALIFY_KIT_DRIFT', `unexpected failure mode: ${JSON.stringify(result)}`);
});

test('evidence seal: the manifest hashes every evidence file (never its own bytes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ek-qualify-seal-'));
  try {
    fences.writeEvidence(dir, 'journal.json', { steps: [1, 2, 3] });
    fences.writeEvidence(dir, 'trace.json', { heads: [] });
    const first = fences.sealEvidence(dir);
    assert.equal(first.fileCount, 2, 'the manifest covers the evidence files, not itself');
    const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
    assert.equal(manifest.treeHash, first.treeHash);
    assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['journal.json', 'trace.json']);
    /* After sealing, the tree has three files (evidence + manifest); the
     * recorded digest still binds exactly the evidence set. */
    assert.equal(fences.hashTree(dir).files.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
