// FRF-WP11 — the Formalization removal guards (blocking).
//
// The FRF deletion manifest (docs/refactoring/formalization-frf/
// DELETION-MANIFEST.md) is VALIDATED here, in the direction the plan's
// FRF-10 exit demands: every listed old-flow artifact is ABSENT, the
// replaced old-flow desk implementations are gone (NO forwarding facade,
// NO dual path), the docs-tree WP03 contracts are byte-equal FROZEN
// SNAPSHOTS of the canonical in-package tree, and the dist mirrors are
// byte-equal to src (the installed package output).
//
// Registration:
//   matrix group : frf-removal-guard -> this file
//   plan law     : "Host every test and driver in blocking CI with
//                   removal guards" + "Run static legacy-zero searches for
//                   old nodes, schemas, trace rules, and compatibility
//                   paths" (FRF-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const importAbs = (absolute) => import(pathToFileURL(absolute).href);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = path.join(ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization');
const DIST_PKG = path.join(ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization');
const SNAPSHOT_CONTRACTS = path.join(ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts');
const CANONICAL_CONTRACTS = path.join(PKG, 'contracts');

const sha256OfBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function walk(dir, filter = () => true, base = dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) entries.push(...walk(p, filter, base));
    else if (filter(p)) entries.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* RG1: the deletion manifest's listed artifacts are ABSENT             */
/* ------------------------------------------------------------------ */

test('RG1a: the orphaned pre-EK harvest fixtures are gone (B1 + B2, executed 2026-08-27)', () => {
  assert.equal(existsSync(path.join(ROOT, 'tests', 'factory-evidence')), false, 'tests/factory-evidence must not exist (the old-flow evidence harvest; consumed by nothing since the EK-8 purge)');
});

test('RG1b: the replaced old-flow desk modules are gone (no forwarding facade, no dual path)', () => {
  for (const gone of [
    path.join(PKG, 'products.ts'),
    path.join(PKG, 'contribution.ts'),
    path.join(DIST_PKG, 'products.js'),
    path.join(DIST_PKG, 'contribution.js'),
    path.join(DIST_PKG, 'products.d.ts'),
    path.join(DIST_PKG, 'contribution.d.ts'),
  ]) {
    assert.equal(existsSync(gone), false, `${path.relative(ROOT, gone)} must not exist (the old desk validators and the folded accepted-material chain died at the cutover)`);
  }
});

test('RG1c: the old-flow product kinds and validators are unreachable on the installed surface', async () => {
  const installed = await importAbs(path.join(DIST_PKG, 'index.js'));
  for (const deadExport of [
    'validatePrdIntent', 'validateUseCaseScenarios', 'validateSystemRequirements',
    'validateAcceptanceContract', 'validateWhatReconciliation', 'validateWhatBaseline',
    'validateSrs', 'settleSolutionContract', 'validateSolutionContract',
    'acceptedMaterialAfter', 'acceptedMaterialOfHandoff', 'acceptedBaselineAfter',
    'acceptedScenarioRequiredAfter', 'PRD_INTENT_PRODUCT_KIND', 'UC_SCENARIOS_PRODUCT_KIND',
    'WHAT_BASELINE_PRODUCT_KIND', 'SOLUTION_CONTRACT_PRODUCT_KIND', 'AcceptedMaterial',
  ]) {
    assert.equal(installed[deadExport], undefined, `the old-flow export ${deadExport} must be gone from the installed package surface`);
  }
  // The manifest pins the NEW kinds (the folded legacy what-baseline kind is
  // refused on sight by the freeze cell, never declared).
  const manifest = await importAbs(path.join(DIST_PKG, 'manifest.js'));
  const kinds = manifest.FORMALIZATION_CHECK_PROVIDERS.map((provider) => provider.productKind).sort();
  assert.deepEqual(kinds, [
    'formalization.acceptance-bindings.v1',
    'formalization.srs.v1',
    'formalization.system-requirements.v1',
    'formalization.what-reconciliation.v1',
    'frf-cell.product-intent.v1',
    'frf-cell.uc-scenarios.v1',
    'frf-contracts.solution-contract.v1',
    'frf-contracts.what-baseline.v1',
  ]);
});

test('RG1d: no src module imports the docs tree (the pre-cutover seam import died)', () => {
  // Comments are stripped first (prose may DESCRIBE the docs snapshot; the
  // guard scans CODE - the same law as the package structure tests).
  const codeOf = (file) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'), (p) => /\.(ts|mjs)$/.test(p) && !p.endsWith('.d.mts'))) {
    const source = codeOf(path.join(ROOT, 'src', file));
    if (source.includes('docs/refactoring/formalization-frf')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a src module still imports the docs tree (the contracts canonical home is src/.../contracts since the cutover)');
});

/* ------------------------------------------------------------------ */
/* RG2: the docs contracts are FROZEN byte-equal snapshots             */
/* ------------------------------------------------------------------ */

test('RG2a: every validator + schema snapshot is byte-equal to the canonical in-package contract', () => {
  for (const group of ['validators', 'schemas']) {
    const canonicalDir = path.join(CANONICAL_CONTRACTS, group);
    const snapshotDir = path.join(SNAPSHOT_CONTRACTS, group);
    const canonicalFiles = walk(canonicalDir, (p) => /\.(mjs|json)$/.test(p));
    assert.ok(canonicalFiles.length >= 5, `the canonical ${group} tree exists`);
    for (const rel of canonicalFiles) {
      const canonical = readFileSync(path.join(canonicalDir, rel));
      const snapshotPath = path.join(snapshotDir, rel);
      assert.equal(existsSync(snapshotPath), true, `the docs snapshot of ${group}/${rel} is missing`);
      assert.equal(sha256OfBytes(readFileSync(snapshotPath)), sha256OfBytes(canonical), `${group}/${rel}: the docs snapshot drifted from the canonical in-package contract`);
    }
  }
});

test('RG2b: the pinned identity digests verify against the canonical validator bytes', async () => {
  const identity = await importAbs(path.join(DIST_PKG, 'contracts', 'identity.js'));
  const pinned = identity.FORMALIZATION_CONTRACT_DIGESTS;
  for (const [name, digest] of Object.entries(pinned)) {
    const canonical = readFileSync(path.join(CANONICAL_CONTRACTS, 'validators', `${name}.mjs`));
    assert.equal(sha256OfBytes(canonical), digest, `the pinned digest of validators/${name}.mjs does not verify (the identity table is stale or the contract drifted)`);
  }
});

/* ------------------------------------------------------------------ */
/* RG3: the dist mirrors are byte-equal to the src installed surfaces  */
/* ------------------------------------------------------------------ */

test('RG3: the dist-installed .mjs surfaces mirror src byte-for-byte', () => {
  const mirroredTrees = [
    ['src/workflow-kernel/workshops/formalization/contracts', 'dist/workflow-kernel/workshops/formalization/contracts'],
    ['src/workflow-kernel/workshops/formalization/cells/acceptance', 'dist/workflow-kernel/workshops/formalization/cells/acceptance'],
    ['src/workflow-kernel/workshops/formalization/cells/what-freeze', 'dist/workflow-kernel/workshops/formalization/cells/what-freeze'],
    ['src/workflow-kernel/workshops/development/handoff', 'dist/workflow-kernel/workshops/development/handoff'],
  ];
  for (const [srcTree, distTree] of mirroredTrees) {
    for (const rel of walk(path.join(ROOT, srcTree), (p) => /\.(mjs|json)$/.test(p))) {
      const srcBytes = readFileSync(path.join(ROOT, srcTree, rel));
      const distPath = path.join(ROOT, distTree, rel);
      assert.equal(existsSync(distPath), true, `${distTree}/${rel} is missing from the installed package output`);
      assert.equal(sha256OfBytes(readFileSync(distPath)), sha256OfBytes(srcBytes), `${distTree}/${rel} drifted from src (the build copy step is not a transformation)`);
    }
  }
  // The dispatch (the installed semantic dispatch) mirrors too.
  const dispatchSrc = readFileSync(path.join(PKG, 'cells', 'dispatch.mjs'));
  const dispatchDist = readFileSync(path.join(DIST_PKG, 'cells', 'dispatch.mjs'));
  assert.equal(sha256OfBytes(dispatchDist), sha256OfBytes(dispatchSrc), 'cells/dispatch.mjs drifted between src and dist');
});

/* ------------------------------------------------------------------ */
/* RG4: the installed graph stayed the plan's shape (no node drift)     */
/* ------------------------------------------------------------------ */

test('RG4: the installed graph is still the eleven-node/eighteen-transition plan shape (the SEMANTICS swapped, not the graph)', async () => {
  const manifest = await importAbs(path.join(DIST_PKG, 'manifest.js'));
  assert.equal(manifest.FORMALIZATION_FLOW_NODES.length, 11);
  assert.equal(manifest.FORMALIZATION_FLOW_EDGES.length, 18);
  assert.equal(manifest.FORMALIZATION_MODULE_VERSION, '3.0.0', 'the cutover bumps the semantic-contract identity (3.0.0)');
  // The old pre-EK node identities never return.
  for (const deadNode of ['define-product-contract', 'freeze-acceptance-baseline']) {
    assert.equal(
      manifest.FORMALIZATION_FLOW_NODES.some((node) => node.id === deadNode),
      false,
      `the old node ${deadNode} must never return to the installed graph`,
    );
  }
});
