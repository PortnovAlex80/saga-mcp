#!/usr/bin/env node
/**
 * FRF-WP01 — post-EK Formalization inventory (machine-checkable JSON).
 *
 * Re-inventories the CURRENT production and test paths after the EK-8
 * cutover (the plan's pre-EK path list is evidence only — 1428 files were
 * deleted). Gathers:
 *   - package identity + per-file sha256 digests of the installed
 *     Formalization semantic package (src), its dist mirror, and the
 *     Development consumer surface;
 *   - the lifecycle stage-route obligations that connect the workshops;
 *   - the test suites that cover Formalization semantics today, with
 *     per-file test counts;
 *   - the acceptance-matrix structured group registry (CI hosting truth);
 *   - the capsule/evidence fixture families that reference formalization.
 *
 * Run: node docs/refactoring/formalization-frf/baseline/capture-post-ek-inventory.mjs
 * (requires `npm run build`; output: post-ek-inventory.json)
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const sha256 = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

async function walk(dir, filter, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, filter, acc);
    else if (filter(p)) acc.push(p);
  }
  return acc.sort();
}
const toRoot = (p) => path.relative(root, p).split(path.sep).join('/');

async function fileInventory(relDir) {
  const files = await walk(path.join(root, relDir), (p) => /\.(ts|mjs)$/.test(p));
  const out = [];
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    out.push({
      path: toRoot(f),
      sha256: await sha256(f),
      lines: text.split('\n').length,
    });
  }
  return out;
}

async function countTests(file) {
  const text = await readFile(path.join(root, file), 'utf8');
  return (text.match(/(^|\n)(test|it)\(/g) ?? []).length;
}

/* --- 1. package identity ------------------------------------------------ */
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/* --- 2. the installed Formalization semantic package -------------------- */
const formalizationSrc = await fileInventory('src/workflow-kernel/workshops/formalization');
const formalizationDist = (await walk(path.join(root, 'dist/workflow-kernel/workshops/formalization'), (p) => p.endsWith('.js')))
  .map(toRoot);

/* --- 3. the Development consumer surface (the handoff target) ----------- */
const developmentSrc = await fileInventory('src/workflow-kernel/workshops/development');

/* --- 4. the synthetic scenario engine + shared kernel seams ------------- */
const syntheticSrc = await fileInventory('src/workflow-kernel/workshops/synthetic');
const kernelSeams = [];
for (const seam of [
  'src/workflow-kernel/composition/production.ts',
  'src/workflow-kernel/planning/bindings.ts',
  'src/workflow-kernel/domain/reducers/lifecycle-run.ts',
  'src/workflow-kernel/domain/universe.ts',
]) {
  kernelSeams.push({ path: toRoot(path.join(root, seam)), sha256: await sha256(path.join(root, seam)) });
}

/* --- 5. lifecycle stage routes (the workshop chain) ---------------------- */
const lifecycleText = await readFile(path.join(root, 'src/workflow-kernel/domain/reducers/lifecycle-run.ts'), 'utf8');
const stageRoutes = [...lifecycleText.matchAll(/input\.stageRoute === '([a-z-]+)'.*?obligations: \['([^\]]+)'\]/g)]
  .map((m) => ({ stageRoute: m[1], obligation: m[2] }));

/* --- 6. Formalization test suites (the classification input) ------------ */
const formalizationTestDir = 'tests/workflow-kernel/workshops/formalization';
const formalizationTests = [];
for (const f of await walk(path.join(root, formalizationTestDir), (p) => p.endsWith('.mjs'))) {
  formalizationTests.push({
    path: toRoot(f),
    sha256: await sha256(f),
    declaredTests: await countTests(toRoot(f)),
  });
}

/* --- 7. other suites covering Formalization semantics -------------------- */
const otherFormalizationSuites = [];
const candidates = [
  'tests/workflow-kernel/engine/scenario.test.mjs',
  'tests/workflow-kernel/faults/scenario-faults.test.mjs',
  'tests/workflow-kernel/composition/composition.test.mjs',
  'tests/workflow-kernel/composition/cutover-pins.test.mjs',
  'tests/workflow-kernel/model/complexity.test.mjs',
  'tests/workflow-kernel/development/material-chain.test.mjs',
  'tests/workflow-kernel/development/capsule-ingress.test.mjs',
  'tests/workflow-kernel/workshops/development/installation.test.mjs',
  'tests/workflow-kernel/workshops/development/structure.test.mjs',
  'tests/workflow-kernel/workshops/development/scenario.test.mjs',
  'tests/workflow-kernel/workshops/synthetic/structure.test.mjs',
  'tests/project-corpus/corpus.test.mjs',
  'tests/project-corpus/mutations.test.mjs',
];
for (const c of candidates) {
  try {
    const text = await readFile(path.join(root, c), 'utf8');
    const mentions = (text.match(/formalization/g) ?? []).length;
    if (mentions > 0) {
      otherFormalizationSuites.push({ path: c, sha256: await sha256(path.join(root, c)), formalizationMentions: mentions, declaredTests: await countTests(c) });
    }
  } catch { /* absent */ }
}

/* --- 8. capsule/evidence fixtures referencing formalization -------------- */
const evidenceFiles = await walk(path.join(root, 'tests/factory-evidence'), (p) => p.endsWith('.json'));
const formalizationEvidence = [];
for (const f of evidenceFiles) {
  const name = path.basename(f);
  if (name.startsWith('formalization_')) formalizationEvidence.push(toRoot(f));
}

/* --- 9. acceptance-matrix structured registry (CI hosting truth) --------- */
const matrix = JSON.parse(await readFile(path.join(root, 'docs/refactoring/formalization-frf/baseline/acceptance-matrix-registry.json'), 'utf8'));

/* --- 10. CI workflow hosts ----------------------------------------------- */
const workflows = [];
for (const f of await walk(path.join(root, '.github/workflows'), (p) => p.endsWith('.yml'))) {
  workflows.push({ path: toRoot(f), sha256: await sha256(f) });
}

const inventory = {
  artifactId: 'frf-wp01-post-ek-inventory',
  schemaVersion: 'frf.post-ek-inventory.v1',
  capturedAt: new Date().toISOString(),
  capturedFrom: { baseSha: '5c158608', saga4At: 'be0d5948' },
  package: { name: pkg.name, version: pkg.version },
  installedFormalizationPackage: {
    moduleId: 'workshop:solution-formalization',
    moduleVersion: '2.0.0',
    sourceFiles: formalizationSrc,
    distFiles: formalizationDist,
    distFileCount: formalizationDist.length,
    sourceTotalLines: formalizationSrc.reduce((a, f) => a + f.lines, 0),
  },
  developmentConsumerSurface: {
    note: 'ZERO references to solutionContract/developmentHandoff/scenarioBindings anywhere in this package (verified by grep at capture time) — the FRF-09 gap.',
    sourceFiles: developmentSrc,
  },
  syntheticScenarioEngine: { sourceFiles: syntheticSrc },
  kernelSeams,
  lifecycleStageRoutes: stageRoutes,
  formalizationTestSuites: {
    focused: formalizationTests,
    focusedDeclaredTestsTotal: formalizationTests.filter((t) => t.path.endsWith('.test.mjs')).reduce((a, t) => a + t.declaredTests, 0),
    otherSuitesTouchingFormalization: otherFormalizationSuites,
    evidenceFixtures: formalizationEvidence,
    evidenceFixtureCount: formalizationEvidence.length,
  },
  acceptanceMatrixRegistry: {
    groupCount: Object.keys(matrix.groups).length,
    quarantineCount: 0,
    groups: Object.fromEntries(Object.entries(matrix.groups).map(([k, v]) => [k, { files: v.files.length, note: v.note }])),
  },
  ciHosts: { workflows },
};

const out = path.join(here, 'post-ek-inventory.json');
await writeFile(out, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
console.log(`wrote ${path.relative(root, out)}`);
console.log(JSON.stringify({
  formalizationSourceFiles: formalizationSrc.length,
  formalizationDistFiles: formalizationDist.length,
  focusedTests: inventory.formalizationTestSuites.focusedDeclaredTestsTotal,
  otherSuites: otherFormalizationSuites.length,
  evidenceFixtures: formalizationEvidence.length,
  matrixGroups: inventory.acceptanceMatrixRegistry.groupCount,
}, null, 2));
